// Functional test for AUTO-TRANSFER ON MENTION.
//
// When HR or a superadmin mentions a violation in a BRANCH chat, the report is
// handed to the Area Manager automatically (managerStatus: 'transferred').
// Locked down here:
//   1. only hr/superadmin trigger it, and only in branch-* rooms (not DMs);
//   2. a report already transferred with a running (or not-yet-started) window
//      is left untouched — no duplicate / reset timer;
//   3. a never-transferred, reverted, or lapsed report IS (re-)transferred;
//   4. a mention NEVER starts the 8-hour timer (no markViolationOpenedForAreaManager);
//   5. it is called from finishSentMessage, i.e. after every successful send;
//   6. a report from another store is never transferred from a branch room.
//
// Run: node --test test/chat-violation-auto-transfer.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
// CRLF-normalised: the repo is edited on Windows.
const src = fs.readFileSync(path.join(ROOT, 'js', 'chat.js'), 'utf8').replace(/\r\n/g, '\n');

console.log('Testing auto-transfer of mentioned violations to the Area Manager...');

const fnMatch = src.match(/    async function autoTransferMentionedViolations\(text, roomId\) \{[\s\S]*?\n    \}\n/);
assert(fnMatch, 'autoTransferMentionedViolations() must exist in js/chat.js');
const fnSrc = fnMatch[0];

// ---- static guarantees ----
const finish = (src.match(/function finishSentMessage\(text, me\) \{[\s\S]*?\n    \}\n/) || [''])[0];
assert(/autoTransferMentionedViolations\(text, activeRoomId\)/.test(finish),
    'finishSentMessage() must call autoTransferMentionedViolations(text, activeRoomId)');
assert(!/markViolationOpenedForAreaManager/.test(fnSrc),
    'a mention must NEVER start the 8-hour timer (no markViolationOpenedForAreaManager)');
assert(/canMentionViolations\(\)/.test(fnSrc) && /isBranchRoom\(roomId\)/.test(fnSrc),
    'must be gated on canMentionViolations() and isBranchRoom(roomId)');
console.log('  PASS  static gates (role, branch room, no timer start, hooked into finishSentMessage)');

// ---- functional harness ----
function makeHarness(opts) {
    const docs = opts.docs || {};
    const transfers = [];
    const toasts = [];
    const sandbox = {
        console: { warn() {}, log() {} },
        Date,
        Number,
        String,
        Set,
        role: opts.role || 'hr',
        activeRoomId: opts.roomId,
        canMentionViolations() { return sandbox.role === 'hr' || sandbox.role === 'superadmin'; },
        isBranchRoom(id) { return String(id || '').indexOf('branch-') === 0; },
        activeRoomBranch() { return opts.branch || ''; },
        extractViolationRefs(text) {
            const out = [];
            const re = /VIO-\d+/gi; let m;
            while ((m = re.exec(text)) !== null) { const k = m[0].toLowerCase(); if (out.indexOf(k) === -1) out.push(k); }
            return out;
        },
        async resolveViolationRef(ref) {
            const id = Object.keys(docs).find(k => String(docs[k].violationNumber).toLowerCase() === ref);
            return id ? Object.assign({ id }, docs[id]) : null;
        },
        db: {
            collection() {
                return { doc(id) { return { async get() { return { exists: !!docs[id], data() { return docs[id]; } }; } }; } };
            }
        },
        auth: { currentUser: { email: 'hr@x.com', displayName: 'HR One' } },
        currentUserEmail: 'hr@x.com',
        showToast(msg, kind) { toasts.push([msg, kind]); },
        autoTransferInFlight: new Set(),
        window: {
            firestoreService: {
                async transferViolationToAreaManager(id, by, name) { transfers.push([id, by, name]); }
            }
        }
    };
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + '\nthis.run = autoTransferMentionedViolations;', sandbox);
    return { run: (t) => sandbox.run(t, opts.roomId), transfers, toasts };
}

const HOUR = 60 * 60 * 1000;

(async () => {
    // 1. Fresh report, HR, branch chat -> transferred.
    let h = makeHarness({ roomId: 'branch-sm-fairview', branch: 'sm fairview',
        docs: { a1: { violationNumber: 'VIO-0007', store: 'SM Fairview', hrStatus: 'transferred' } } });
    await h.run('please check VIO-0007');
    assert.deepStrictEqual(h.transfers, [['a1', 'hr@x.com', 'HR One']], 'a fresh report must be transferred');
    assert(h.toasts.some(t => /shared with the Area Manager/.test(t[0])), 'sender is told it was shared');
    console.log('  PASS  HR mention in a branch chat transfers a never-transferred report');

    // 2. Superadmin triggers too.
    h = makeHarness({ role: 'superadmin', roomId: 'branch-sm-fairview', branch: 'sm fairview',
        docs: { a1: { violationNumber: 'VIO-0007', store: 'SM Fairview' } } });
    await h.run('VIO-0007');
    assert.strictEqual(h.transfers.length, 1, 'superadmin mention must also transfer');
    console.log('  PASS  superadmin mention also transfers');

    // 3. Area Manager / DM / no mention -> nothing.
    h = makeHarness({ role: 'owner', roomId: 'branch-sm-fairview', branch: 'sm fairview',
        docs: { a1: { violationNumber: 'VIO-0007', store: 'SM Fairview' } } });
    await h.run('VIO-0007');
    assert.strictEqual(h.transfers.length, 0, 'an Area Manager message must never transfer');
    h = makeHarness({ roomId: 'dm-hr@x.com-sa@x.com', docs: { a1: { violationNumber: 'VIO-0007', store: 'SM Fairview' } } });
    await h.run('VIO-0007');
    assert.strictEqual(h.transfers.length, 0, 'a DM mention must never transfer');
    console.log('  PASS  non-HR roles and direct messages never transfer');

    // 4. Already transferred, not opened yet / window running -> untouched.
    h = makeHarness({ roomId: 'branch-sm-fairview', branch: 'sm fairview', docs: {
        a1: { violationNumber: 'VIO-0001', store: 'SM Fairview', managerStatus: 'transferred' },
        a2: { violationNumber: 'VIO-0002', store: 'SM Fairview', managerStatus: 'transferred', managerExpiresAtMs: Date.now() + 2 * HOUR }
    } });
    await h.run('VIO-0001 and VIO-0002');
    assert.strictEqual(h.transfers.length, 0, 'an active transfer must not be re-written (no duplicate timer)');
    console.log('  PASS  an active / not-yet-opened transfer is left alone');

    // 5. Lapsed window or reverted -> re-transferred (fresh window on next open).
    h = makeHarness({ roomId: 'branch-sm-fairview', branch: 'sm fairview', docs: {
        a1: { violationNumber: 'VIO-0001', store: 'SM Fairview', managerStatus: 'transferred', managerExpiresAtMs: Date.now() - 1000 },
        a2: { violationNumber: 'VIO-0002', store: 'SM Fairview', managerRevertedAt: {} }
    } });
    await h.run('VIO-0001 VIO-0002');
    assert.deepStrictEqual(h.transfers.map(t => t[0]).sort(), ['a1', 'a2'], 'lapsed and reverted reports are re-transferred');
    console.log('  PASS  lapsed / reverted reports are re-transferred');

    // 6. Another store's report is never transferred from this branch room.
    h = makeHarness({ roomId: 'branch-sm-fairview', branch: 'sm fairview',
        docs: { a1: { violationNumber: 'VIO-0009', store: 'SM North' } } });
    await h.run('VIO-0009');
    assert.strictEqual(h.transfers.length, 0, 'a report from another store must not be transferred');
    console.log('  PASS  another store\'s report is never transferred');

    console.log('\n✅ Auto-transfer-on-mention tests passed.');
})().catch((e) => { console.error(e); process.exit(1); });
