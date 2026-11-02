// ===========================================================================
//  THE VIEWING WINDOW STARTS WHEN THE MANAGER OPENS THE TICKET
//
//  THE RULE (as specified): a ticket must not expire if its modal was never
//  opened. The countdown begins the first time the Area Manager opens it, then
//  runs continuously — closing the modal stops nothing — and once lapsed the
//  manager can still request access again.
//
//  ⚠️ THE TRAP THIS TEST EXISTS FOR. Firestore cannot distinguish an ABSENT
//  field from a null one. So "approval simply stops writing `accessExpiresAt`"
//  produces a document shaped EXACTLY like a pre-feature ticket — and the
//  legacy `approvedAt + window` fallback then restarts the countdown at approval
//  anyway, silently, for every new ticket. `accessWindowStartsOnOpen` is the
//  discriminator that makes "approved, never opened" a distinguishable state.
//  Most assertions below exist to keep that flag load-bearing.
//
//  Run: npm test
// ===========================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'firebase.js'), 'utf8');
const start = src.indexOf('//  2-DAY TRACKING ACCESS WINDOW');
const end = src.indexOf('// Make firestoreService globally accessible');
assert(start > -1 && end > start, 'helper block not found in firebase.js');
const helperSrc = src.slice(src.lastIndexOf('// ====', start), end);

// The write helper touches db/auth/firebase, so they are stubbed and the
// WRITES ARE COUNTED. Asserting "it stamps on open" without also asserting
// "it does NOT stamp for HR" needs both a positive and a negative case.
let writes = [];
const sandbox = {
    window: {},
    console,
    firebase: { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TS', delete: () => 'DELETE' } } },
    db: { collection: () => ({ doc: () => ({ update: async (payload) => { writes.push(payload); } }) }) },
    auth: { currentUser: { email: 'manager@example.com' } }
};
vm.createContext(sandbox);
vm.runInContext(helperSrc, sandbox);

const w = sandbox.window;
const WIN = w.TRACKING_ACCESS_WINDOW_MS;
const TICKET_ID = 'bnw-tix001';

function ticket(fields) {
    return Object.assign({ id: TICKET_ID, approvalStatus: 'approved' }, fields);
}

console.log('Testing that the viewing window starts on first open...');

(async function run() {
    // ===========================================================================
    console.log('\n=== an approved but UNOPENED ticket never expires ===');
    // ===========================================================================
    {
        // The headline requirement, stated as the exact document shape approval
        // now writes: the marker, and NO expiresAt / NO openedAt.
        const unopened = ticket({
            accessWindowStartsOnOpen: true,
            approvedAt: new Date(Date.now() - 500 * WIN)
        });
        assert.strictEqual(w.getTrackingAccessExpiry(unopened), null,
            'an approved ticket nobody has opened must have NO expiry at all');
        assert.strictEqual(w.isTrackingAccessExpired(unopened), false,
            'an approved ticket nobody has opened must not be expired — not after a minute, ' +
            'not after a year. This is the whole point of the change.');

        // A real timestamp, not just absent, and one far enough in the past to
        // expire under the OLD rule. If the marker were ignored, approvedAt +
        // window would be long gone and this would read as expired.
        assert.strictEqual(w.isTrackingAccessExpired(unopened, new Date(Date.now() + 1000 * WIN)), false,
            'even evaluated a thousand windows from now, an unopened ticket does not expire');
    }

// ===========================================================================
    console.log('\n=== opening it starts the clock ===');
    // ===========================================================================
    {
        const unopened = ticket({ accessWindowStartsOnOpen: true });
        assert.strictEqual(w.getTrackingAccessOpenedAt(unopened), null,
            'nothing has been opened yet');

        const at = new Date();
        const written = await w.markTrackingAccessOpened(unopened, at);
        assert(written && written.stamped === true,
            'opening an approved, unopened ticket must write a stamp. It now returns a ' +
            'RESULT OBJECT rather than a bare Date/null, so that "declined for reason X" is ' +
            'distinguishable from "wrote it" — four different declines used to all return null.');
        assert(written.at instanceof Date || written.at && typeof written.at.getTime === 'function',
            'a successful stamp must carry back the Date it wrote');
        assert.strictEqual(writes.length, 1, 'exactly one write, not two');
        assert('accessOpenedAt' in writes[0], 'the stamp must be persisted');
        assert.strictEqual(writes[0].accessOpenedAt, 'SERVER_TS',
            'the stamp must be a SERVER timestamp, not the client clock — the manager can ' +
            'set their own device time');

        // The local copy is mirrored so the modal rendering right now sees its own
        // write. Without this the first open would compute an expiry from a missing
        // stamp and flash the withheld state at a manager whose access is open.
        assert(w.getTrackingAccessOpenedAt(unopened),
            'the ticket object passed in must be updated in place after the write');

        // Now the deadline exists, anchored to the OPEN, not the approval.
        const expiry = w.getTrackingAccessExpiry(unopened);
        assert(expiry, 'once opened, the ticket must have a deadline');
        assert.strictEqual(expiry.getTime(), at.getTime() + WIN,
            'the deadline must be firstOpen + window');
        assert.strictEqual(w.isTrackingAccessExpired(unopened), false, 'just opened, so not expired');
    }

    // ===========================================================================
    console.log('\n=== the clock KEEPS RUNNING after the modal closes ===');
    // ===========================================================================
    {
        const opened = ticket({ accessWindowStartsOnOpen: true });
        const at = new Date(Date.now() - 3 * WIN);
        await w.markTrackingAccessOpened(opened, at);

        // Closing does not clear the stamp. It is written ONCE — re-opening must
        // not slide the deadline along, or the window could be renewed forever.
        writes = [];
        const again = await w.markTrackingAccessOpened(opened, new Date());
        assert.strictEqual(again.reason, 'already-stamped',
            'a second open must NOT re-stamp the ticket — and must say WHY it declined');
        assert.strictEqual(again.stamped, false);
        assert.strictEqual(writes.length, 0, 'a second open must not write at all');

        // Three windows after the first open, the ticket is lapsed. Nothing done
        // to the modal changes this.
        assert.strictEqual(w.isTrackingAccessExpired(opened, new Date(Date.now() + 3 * WIN)), true,
            'the window runs continuously from the first open, so an old open has expired');
        assert.strictEqual(w.getTrackingAccessExpiry(opened).getTime(), at.getTime() + WIN,
            'the deadline is still anchored to the FIRST open');
    }

// ===========================================================================
    console.log('\n=== only the AREA MANAGER stamps it ===');
    // ===========================================================================
    {
        // ⚠️ The role gate lives in the CALLER (openOwnerReport checks
        // expiryAppliesToViewer before calling this), so it is asserted on the
        // source rather than assumed. HR and superadmins read these tickets for a
        // living; stamping on their behalf would start — and burn — the manager's
        // window during someone else's review.
        const ownerJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8');
        const opener = ownerJs.slice(ownerJs.indexOf('window.openOwnerReport = function'));
        assert(opener.length > 0, 'openOwnerReport() must exist');
        assert(/expiryAppliesToViewer\(\)[\s\S]{0,140}markTrackingAccessOpened/.test(opener),
            'the stamp MUST be gated on expiryAppliesToViewer(). Ungated, an HR or superadmin ' +
            'reading an approved ticket would start the manager\'s countdown for them.');
    }

    // ===========================================================================
    console.log('\n=== unapproved and LEGACY tickets are untouched ===');
    // ===========================================================================
    {
        // Nothing to view yet, so no clock and no write.
        writes = [];
        const pending = { id: TICKET_ID, approvalStatus: 'pending_approval', accessWindowStartsOnOpen: true };
        const pendingResult = await w.markTrackingAccessOpened(pending, new Date());
        assert.strictEqual(pendingResult.reason, 'not-approved',
            'an unapproved ticket must never be stamped, and must report that reason');
        assert.strictEqual(writes.length, 0);
        assert.strictEqual(w.getTrackingAccessExpiry(pending), null);

        // LEGACY — approved before the feature, so it carries no marker. It must
        // keep the old approvedAt + window behaviour. If this regressed, every
        // ticket already in the database would silently become permanent.
        const legacyFresh = { approvalStatus: 'approved', approvedAt: new Date(Date.now() - WIN / 2) };
        const legacyOld = { id: TICKET_ID, approvalStatus: 'approved', approvedAt: new Date(Date.now() - 2 * WIN) };
        assert.strictEqual(w.getTrackingAccessExpiry(legacyFresh).getTime(),
            legacyFresh.approvedAt.getTime() + WIN,
            'a pre-feature ticket must still expire on approvedAt + window');
        assert.strictEqual(w.isTrackingAccessExpired(legacyOld), true,
            'a pre-feature ticket whose window has passed must still read as expired');
        writes = [];
        assert.strictEqual((await w.markTrackingAccessOpened(legacyOld, new Date())).reason,
            'legacy-no-marker',
            'a legacy ticket must not be stamped — its deadline is already running — and must ' +
            'report that distinct reason rather than a bare null');
        assert.strictEqual(writes.length, 0);

        // A stored accessExpiresAt still wins: the only value written by a clock
        // that was genuinely running.
        const stored = ticket({
            accessWindowStartsOnOpen: true,
            accessOpenedAt: new Date(Date.now() - 10 * WIN),
            accessExpiresAt: new Date(Date.now() + WIN / 2)
        });
        assert.strictEqual(w.isTrackingAccessExpired(stored), false,
            'a stored expiry must win over a stale accessOpenedAt');
    }

// ===========================================================================
    console.log('\n=== a failed write must not break the report ===');
    // ===========================================================================
    {
        const sandbox2 = {
            window: {},
            console: { warn: () => {} },
            firebase: { firestore: { FieldValue: { serverTimestamp: () => 'SERVER_TS' } } },
            db: { collection: () => ({ doc: () => ({ update: async () => { throw new Error('offline'); } }) }) },
            auth: { currentUser: { email: 'm@e.com' } }
        };
        vm.createContext(sandbox2);
        vm.runInContext(helperSrc, sandbox2);
        const t = ticket({ accessWindowStartsOnOpen: true });
        const failed = await sandbox2.window.markTrackingAccessOpened(t, new Date());
        assert.strictEqual(failed.stamped, false,
            'a rejected write must not report success');
        assert.strictEqual(failed.reason, 'write-failed',
            'a rejected write must be reported as write-failed and NOT throw — an offline ' +
            'manager must still be able to read the report they opened it from');
        assert(failed.error, 'a write failure must carry the underlying error for the console');
        assert.strictEqual(sandbox2.window.getTrackingAccessOpenedAt(t), null,
            'a failed write must not leave a local stamp behind — the ticket keeps its ' +
            'no-expiry state');
    }

    /**
 * ⚠️ STRIP COMMENTS BEFORE ANY STRUCTURAL ASSERTION.
 *
 * These checks look for code patterns — "is the stamp gated on this typeof
 * guard?" — and the source's own comments QUOTE the old code verbatim to explain
 * why it was removed. So a naive regex matches the explanation and reports the
 * bug as still present, on code that is correct. That is not hypothetical: it
 * happened here, and to the "seeder" word in the no-demo-reseed suite.
 *
 * Only lines whose FIRST non-space characters are `//` are stripped. An inline
 * `//` mid-line is left alone, which is what keeps URL strings intact — a naive
 * `//.*$` would truncate `const u = 'https://…'` mid-literal.
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map(line => (/^\s*\/\//.test(line) ? '' : line))
        .join('\n');
}

// ===========================================================================
console.log('\n=== ⚠️ a missing helper must be LOUD, never a silent skip ===');
// ===========================================================================
{
    // ⚠️ THE BUG. openOwnerReport() used to read:
    //     if (expiryAppliesToViewer()
    //         && typeof window.markTrackingAccessOpened === 'function') { … }
    // That `typeof` guard turned "the expiry code is not loaded" — which a stale
    // CACHED firebase.js causes, and which is the single most likely reason a
    // manager's window never starts — into a silent no-op. No error, no toast,
    // nothing in the console. The ticket simply never expires, which is
    // indistinguishable from the feature working exactly as specified.
    const ownerJs = stripComments(
        fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8')
    );
    const opener = ownerJs.slice(ownerJs.indexOf('window.openOwnerReport = function'));

    assert(opener.length > 0, 'openOwnerReport() must exist');
    assert(!/expiryAppliesToViewer\(\)\s*&&[\s\S]{0,40}typeof window\.markTrackingAccessOpened\s*===\s*'function'/.test(opener),
        'the stamp must NOT be gated on `typeof window.markTrackingAccessOpened === ' +
        "'function'`. That short-circuits to a silent no-op when firebase.js is stale, and a " +
        'ticket that never expires is precisely what that looks like from the outside.');

    // The helper itself must be announced when absent, because until it is fixed
    // NO approved ticket on that page can ever expire.
    assert(/markTrackingAccessOpened !== 'function'/.test(opener) && /console\.error/.test(opener),
        'when window.markTrackingAccessOpened is missing, openOwnerReport() must log an error ' +
        'naming the stale-cache cause. Silence here is what made this undiagnosable.');

    // And a genuine write failure must reach the manager, not just the console.
    assert(/write-failed/.test(opener),
        'a write failure must be handled explicitly. Every OTHER reason (already-stamped, ' +
        'legacy-no-marker, not-approved) is correct behaviour and must stay quiet — but a ' +
        'rejected write means the window will not run, and the manager should be told.');
}

// ===========================================================================
console.log('\n=== ⚠️ the ticket must carry its DOCUMENT ID, not just its fields ===');
// ===========================================================================
{
    // ⚠️ THE BUG THAT STOPPED EVERY WINDOW FROM EVER STARTING.
    //
    // Firestore's `DocumentSnapshot.data()` returns the document's FIELDS only.
    // The id is a property of the SNAPSHOT. So this line:
    //
    //     db.collection('tickets').doc(reportId).get().then(snap => {
    //         const rawData = snap.data();        // <-- rawData.id is UNDEFINED
    //         await markTrackingAccessOpened(rawData);
    //     })
    //
    // handed a ticket object with no id to a helper that does
    // `db.collection('tickets').doc(ticket.id).update(...)`. `doc(undefined)`
    // throws inside the SDK before any network call; the helper's own catch
    // swallowed it and reported a bare `null`, which read as "declined for some
    // reason" — indistinguishable from a normal second open. The visible result
    // was that a ticket NEVER expired for ANY manager, ever, with nothing in the
    // console.
    //
    // The rest of the codebase already gets this right — loadOwnerTickets() uses
    // `snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))` — which is
    // exactly why this slipped through: the correct idiom was right there.
    const ownerJs = stripComments(
        fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8')
    );
    const opener = ownerJs.slice(ownerJs.indexOf('window.openOwnerReport = function'));
    const readIdx = opener.indexOf('.data()');
    const graftIdx = opener.search(/rawData\.id\s*=/);

    assert(readIdx > -1, 'openOwnerReport() must read the ticket');
    assert(graftIdx > -1,
        'openOwnerReport() must graft the document id onto the object it keeps: ' +
        '`rawData.id = reportId`. Without it `rawData.id` is undefined, `doc(undefined)` ' +
        'throws, and NO viewing window can ever start.');
    assert(graftIdx > readIdx,
        'the id must be grafted AFTER the `.data()` read that strips it — grafting it ' +
        'earlier would be overwritten by the assignment of rawData itself.');

    // And the helper must refuse an id-less object by name rather than letting the
    // SDK throw an opaque error.
    const helper = src.slice(src.indexOf('window.markTrackingAccessOpened ='));
    assert(/if\s*\(\s*!ticket\.id\s*\)\s*return\s*\{\s*stamped:\s*false,\s*reason:\s*'no-id'\s*\}/.test(helper),
        'markTrackingAccessOpened() must check for a missing id and report it as ' +
        "'no-id'. Otherwise `doc(undefined)` throws inside the SDK and is caught as a " +
        "generic 'write-failed' — which is precisely how this hid for so long.");

    // Behavioural proof, not just text: an id-less ticket must be refused, and it
    // must be refused WITHOUT any Firestore call being attempted.
    let attempts = 0;
    const sandbox3 = {
        window: {}, console: { warn: () => {} },
        firebase: { firestore: { FieldValue: { serverTimestamp: () => 'TS' } } },
        db: { collection: () => ({ doc: () => ({ update: async () => { attempts++; } }) }) },
        auth: { currentUser: { email: 'm@e.com' } }
    };
    vm.createContext(sandbox3);
    vm.runInContext(helperSrc, sandbox3);
    const idless = { approvalStatus: 'approved', accessWindowStartsOnOpen: true };
    const refused = await sandbox3.window.markTrackingAccessOpened(idless, new Date());
    assert.strictEqual(refused.reason, 'no-id',
        'an approved ticket with no id must be refused as no-id');
    assert.strictEqual(attempts, 0,
        'an id-less ticket must be refused BEFORE any Firestore write is attempted');
}

console.log('\n× First-open tests passed (an approved ticket with no first-open stamp has a ' +
        'NULL expiry and never expires, however far in the past it was approved; opening it ' +
        'writes ONE server-timestamped accessOpenedAt that is mirrored onto the local copy so ' +
        'the first render does not flash the withheld state; the deadline is anchored to the ' +
        'FIRST open and a second open neither rewrites the stamp nor writes anything, so closing ' +
        'the modal does not extend anything; the stamp is gated on expiryAppliesToViewer so an ' +
        'HR or superadmin reading the ticket cannot burn the manager\'s window; unapproved and ' +
        'pre-feature legacy tickets are neither stamped nor expired, so existing tickets keep the ' +
        'approvedAt + window rule they were created under; a stored expiry still wins over a ' +
        'stale stamp; and a failed write reports write-failed with the underlying error instead of ' +
        'throwing, leaving the report readable). Every refusal returns a DISTINGUISHABLE reason ' +
        '— no-id, not-approved, legacy-no-marker, already-stamped, write-failed — because they used to ' +
        'all return a bare null. That is how a ticket read with snap.data() and handed to the ' +
        'helper WITHOUT its document id stopped EVERY viewing window from ever starting, ' +
        'silently: doc(undefined) throws inside the SDK, the catch reported null, and null ' +
        'looked identical to a normal second open. openOwnerReport() now grafts the id on from ' +
        'the argument it already had, the helper refuses an id-less object by name before ' +
        'attempting any write, and an id-less ticket is proven never to reach Firestore).');
})();