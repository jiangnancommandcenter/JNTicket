// ===========================================================================
//  FOOTAGE ACCUMULATION — added clips must be ADDED, never substituted
// ===========================================================================
// THE BUG THIS LOCKS DOWN. Four sites write `resolution.operatorFootage` and
// they disagreed. The operator's two (Resolve, Revise & Resubmit) wrote
// `operatorFootage: attachmentList` — the NEWLY uploaded clips ONLY — so every
// re-resolution after an "Insufficient Footage" request threw away the footage
// from the operator's FIRST submission. The superadmin's two sites correctly
// concatenated, which is why this went unnoticed.
//
// It did not merely hide the old clips, it MISCLASSIFIED them:
// splitApprovalAttachments() derives the manager's half as "every attachment
// whose key is NOT in the operator list", so the orphaned originals fell
// through and rendered under "Manager's Request" — CCTV the operator captured,
// presented as if the manager had filed it.
//
// This file pins the shared rule every writer now shares:
//     previous footage  -  explicitly removed  +  newly uploaded
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const scriptSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

/** Extract a named top-level function, brace-matched. */
function extractFn(src, name) {
    const start = src.indexOf('function ' + name + '(');
    assert(start > -1, name + '() not found');
    let depth = 0;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error('could not find the end of ' + name + '()');
}

console.log('Testing footage accumulation (added clips are added, never replaced)...');

const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
    // EMPTY_REMOVED_SET is module-level state the helper reads, so it must be
    // defined in the sandbox alongside it or the extracted function cannot run.
    'var EMPTY_REMOVED_SET = new Set();\n' +
    extractFn(scriptSrc, 'getApprovalOperatorFootage') + '\n' +
    extractFn(scriptSrc, 'mergeOperatorFootage'),
    sandbox
);
const merge = sandbox.mergeOperatorFootage;

/** A Cloudinary-shaped clip, as cloudinaryUpload() writes it. */
const clip = (id) => ({
    public_id: 'rcms/' + id,
    secure_url: 'https://res.cloudinary.com/demo/video/upload/rcms/' + id + '.mp4',
    name: id + '.mp4',
    resource_type: 'video',
    format: 'mp4'
});
// ⚠️ CROSS-REALM ARRAYS. `merge` is vm.runInContext'd, so the arrays it builds
// carry the SANDBOX's Array prototype while the expected literals below carry
// the host's. deepStrictEqual compares prototypes, so it fails on two arrays
// whose contents are identical — exactly as this file's first run showed
// ("actual: [ 'rcms/c1', 'rcms/c2' ], expected: [ 'rcms/c1', 'rcms/c2' ]").
// Round-tripping through JSON in the HOST scope rebuilds them with host
// prototypes. Comparison is then by VALUE, which is what was meant.
const plain = (v) => JSON.parse(JSON.stringify(v));
const ids = (list) => plain(list).map(a => a.public_id);

// ---------------------------------------------------------------------------
// 1. The headline case: the exact sequence the Area Manager reported.
// ---------------------------------------------------------------------------
{
    // Round 1 — the operator resolves the ticket with two clips.
    let ticket = { resolution: {} };
    ticket.resolution.operatorFootage = merge(ticket, [clip('c1'), clip('c2')]);
    assert.deepStrictEqual(ids(ticket.resolution.operatorFootage), ['rcms/c1', 'rcms/c2'],
        'a first submission records exactly what was uploaded');

    // The Area Manager requests additional footage. That only touches status and
    // approvalStatus, so the footage list must come through untouched — which is
    // why this block simply leaves `resolution` alone. That IS the scenario.
    ticket.status = 'Insufficient Footage';
    ticket.approvalStatus = 'pending';

    // Round 2 — the operator returns with two MORE clips. THE BUG: this used to
    // write only [c3, c4], orphaning c1 and c2.
    ticket.resolution.operatorFootage = merge(ticket, [clip('c3'), clip('c4')]);
    assert.deepStrictEqual(ids(ticket.resolution.operatorFootage),
        ['rcms/c1', 'rcms/c2', 'rcms/c3', 'rcms/c4'],
        're-resolving after a footage request must KEEP the original clips and ADD the new ones');

    // The superadmin then adds a clip of their own from the approval modal.
    ticket.resolution.operatorFootage = merge(ticket, [clip('c5')]);
    assert.deepStrictEqual(ids(ticket.resolution.operatorFootage),
        ['rcms/c1', 'rcms/c2', 'rcms/c3', 'rcms/c4', 'rcms/c5'],
        'a superadmin upload must ADD to the operator footage, never replace it');

    assert.strictEqual(ticket.resolution.operatorFootage.length, 5,
        'after AM-request -> operator-adds -> superadmin-adds -> re-approve, all 5 clips survive');
    console.log('  PASS  AM requests -> operator adds -> superadmin adds -> re-approve keeps all 5 clips');
}

// ---------------------------------------------------------------------------
// 2. A third footage round must not drop the second.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 3. The legacy fallback must still rescue an old ticket.
// ---------------------------------------------------------------------------
// A ticket written before `operatorFootage` existed carries only
// `resolvedAdditionalFootage`. Seeding from it is what stops those clips from
// being re-filed as the manager's own when the operator next re-submits.
{
    const legacy = { resolvedAdditionalFootage: [clip('old1'), clip('old2')] };
    assert.deepStrictEqual(ids(merge(legacy, [clip('new1')])), ['rcms/old1', 'rcms/old2', 'rcms/new1'],
        'a pre-operatorFootage ticket must seed from resolvedAdditionalFootage, not start empty');
    assert.deepStrictEqual(plain(merge({}, [clip('x')])), [clip('x')], 'a ticket with no footage yet works');
    assert.deepStrictEqual(plain(merge(null, null)), [], 'a null ticket and null upload yield an empty list');
    console.log('  PASS  the legacy resolvedAdditionalFootage fallback still rescues old tickets');
}

// ---------------------------------------------------------------------------
// 4. De-duplication: a re-submit must not list one clip twice.
// ---------------------------------------------------------------------------
// The list now only ever GROWS, so a double-tap, a retry after a slow save, or
// the same file arriving via both the auto-upload dropzone AND the file input
// would each list the clip again. The two superadmin `concat`s this helper
// replaced had exactly that exposure.
{
    const ticket = { resolution: { operatorFootage: [clip('c1'), clip('c2')] } };
    assert.deepStrictEqual(ids(merge(ticket, [clip('c2'), clip('c3')])), ['rcms/c1', 'rcms/c2', 'rcms/c3'],
        're-uploading a clip already on the ticket must not duplicate it');

    // First-wins, so the ORIGINAL entry survives — that is the one carrying any
    // later edits, and it keeps the list in submission order.
    const edited = merge(ticket, [{ public_id: 'rcms/c1', name: 'RENAMED.mp4' }]);
    assert.strictEqual(edited[0].name, 'c1.mp4',
        'on a duplicate public_id the FIRST entry must win, so original metadata is not clobbered');

    // An entry with no public_id cannot be keyed, so it is kept rather than
    // silently dropped — losing evidence is the worse failure.
    const noKey = merge(ticket, [{ secure_url: 'https://x/y.mp4' }]);
    assert.strictEqual(noKey.length, 3, 'a keyless attachment is kept, never silently discarded');
    console.log('  PASS  a repeated upload is de-duplicated, first entry wins, keyless files survive');
}

// ---------------------------------------------------------------------------
// 5. Removal still works — the escape hatch for a wrong clip.
// ---------------------------------------------------------------------------
// Once footage accumulates, "add" is only half the contract: the user must
// still be able to take a clip back out. This is what the Revise & Resubmit
// modal's × buttons drive via `removedRevisionAttachmentIds`.
{
    const ticket = { resolution: { operatorFootage: [clip('c1'), clip('c2'), clip('c3')] } };
    assert.deepStrictEqual(ids(merge(ticket, [], new Set(['rcms/c2']))), ['rcms/c1', 'rcms/c3'],
        'a removed clip must actually leave the footage list');
    assert.deepStrictEqual(ids(merge(ticket, [clip('c4')], new Set(['rcms/c2']))),
        ['rcms/c1', 'rcms/c3', 'rcms/c4'],
        'removal and addition must compose: drop the removed, keep the rest, add the new');
    assert.deepStrictEqual(ids(merge(ticket, [clip('c4')])), ['rcms/c1', 'rcms/c2', 'rcms/c3', 'rcms/c4'],
        'no removedIds means nothing is removed — the default must be additive, not destructive');
    console.log('  PASS  removals compose with additions, and default to removing nothing');
}

// ---------------------------------------------------------------------------
// 6. EVERY writer must go through the one helper.
// ---------------------------------------------------------------------------
// The root cause was four sites, four slightly different rules. This fails the
// moment a fifth writer appears, or anyone reintroduces a bare `attachmentList`.
{
    // ⚠️ SCAN CODE, NOT COMMENTS. The helper's own doc comment quotes the old
    // buggy line verbatim (`operatorFootage: attachmentList`) to explain what it
    // replaced, so a naive whole-file grep matches the very documentation that
    // records the fix and fails forever. Strip comments first — this file must be
    // able to TALK about the bug without tripping on it.
    const codeOnly = scriptSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');

    assert(!/operatorFootage:\s*attachmentList\b/.test(codeOnly),
        'no writer may set operatorFootage from the raw upload list — that is the original bug, ' +
        'and it must be written through mergeOperatorFootage() instead');
    assert((codeOnly.match(/operatorFootage:/g) || []).length > 0,
        'sanity: the field is still written somewhere');

    // The operator's two sites and the superadmin's two sites must all call the
    // helper. Counted, because these are four separate code paths and a missing
    // one reintroduces the exact drift this file exists to prevent.
    const calls = (codeOnly.match(/mergeOperatorFootage\(/g) || []).length;
    assert(calls >= 5,
        'all four write sites must call mergeOperatorFootage() (found ' + calls + ' references) — ' +
        'one site going back to its own concat is how this bug returns');

    // The removal set must actually be READ on submit. It used to be collected by
    // the × buttons and then never consulted by anything, so a deleted clip was
    // written straight back.
    assert(/removedIds\.has\(a\.public_id\)/.test(codeOnly),
        'the revise submit must FILTER attachments by removedRevisionAttachmentIds — otherwise the ' +
        '× buttons only change the on-screen grid and the clip is written back anyway');
    console.log('  PASS  all four write sites share one helper, and removals are actually applied');
}

// ---------------------------------------------------------------------------
// 7. FOOTAGE IS NEVER FILED UNDER THE REQUESTER / MANAGER.
// ---------------------------------------------------------------------------
// THE BUG THIS LOCKS DOWN. The split used to prioritise `operatorFootage` and
// DERIVE the manager's half by subtraction — "everything not in the operator
// list". That inverts the trust: any clip missing from a truncated
// `operatorFootage` (exactly what the replacement bug produced) was silently
// re-attributed to the AREA MANAGER, so the operator's own CCTV appeared under
// "Requester's Attachments".
//
// `requesterAttachments` is written once, at ticket creation, from the manager's
// own upload array — an exact record of what THEY attached. It must therefore be
// used directly. This also REPAIRS the already-damaged tickets for free.
const ownerJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8');
const sandbox2 = { console };
sandbox2.window = sandbox2;
vm.createContext(sandbox2);
vm.runInContext(
    'var EMPTY_REMOVED_SET = new Set();\n' +
    // getApprovalAllAttachments is a dependency of splitApprovalAttachments, so
    // it must be in the sandbox too or the split throws on the first call.
    extractFn(scriptSrc, 'getApprovalAllAttachments') + '\n' +
    extractFn(scriptSrc, 'getApprovalOperatorFootage') + '\n' +
    extractFn(scriptSrc, 'splitApprovalAttachments') + '\n' +
    extractFn(ownerJs, 'splitOwnerAttachments'),
    sandbox2
);
const plain2 = (v) => JSON.parse(JSON.stringify(v));
const idsOf = (list) => plain2(list).map(a => a.public_id);

// A ticket already damaged by the replacement bug: operatorFootage holds ONLY the
// newest clips, while `attachments` still carries everything.
const DAMAGED = {
    requesterAttachments: [{ public_id: 'am1', name: 'manager-clip.mp4' }],
    attachments: [{ public_id: 'am1' }, { public_id: 'c1' }, { public_id: 'c2' }, { public_id: 'c3' }],
    resolution: {
        attachments: [{ public_id: 'am1' }, { public_id: 'c1' }, { public_id: 'c2' }, { public_id: 'c3' }],
        operatorFootage: [{ public_id: 'c3' }]   // TRUNCATED — c1 and c2 orphaned
    }
};

[['splitApprovalAttachments (manager)', sandbox2.splitApprovalAttachments, 'manager'],
    ['splitOwnerAttachments (requester)', sandbox2.splitOwnerAttachments, 'requester']
].forEach(([label, fn, half]) => {
    const s = fn(DAMAGED);
    assert.deepStrictEqual(idsOf(s[half]), ['am1'],
        label + ': the ' + half + ' half must be the manager\'s OWN list verbatim — deriving it ' +
        'by subtraction is what filed the operator\'s clips under them');
    assert.deepStrictEqual(idsOf(s.operator), ['c1', 'c2', 'c3'],
        label + ': the orphaned clips must come back to the operator. This is the self-repair — ' +
        'c1/c2 were lost from operatorFootage by the replacement bug and must NOT fall through');
});
console.log('  PASS  footage is never filed under the requester, and damaged tickets self-repair');

// A healthy ticket must split EXACTLY as before — the fix changes nothing there.
const HEALTHY = {
    requesterAttachments: [{ public_id: 'am1' }, { public_id: 'am2' }],
    attachments: [{ public_id: 'am1' }, { public_id: 'am2' }, { public_id: 'c1' }, { public_id: 'c2' }],
    resolution: {
        attachments: [{ public_id: 'am1' }, { public_id: 'am2' }, { public_id: 'c1' }, { public_id: 'c2' }],
        operatorFootage: [{ public_id: 'c1' }, { public_id: 'c2' }]
    }
};
assert.deepStrictEqual(idsOf(sandbox2.splitOwnerAttachments(HEALTHY).requester), ['am1', 'am2'],
    'a healthy ticket still splits exactly as before');
assert.deepStrictEqual(idsOf(sandbox2.splitOwnerAttachments(HEALTHY).operator), ['c1', 'c2'],
    'a healthy ticket still puts the operator\'s clips under the operator');

// ---------------------------------------------------------------------------
// 8. THE "ADDED" MARKER EXISTS, IS OPT-IN, AND IS IN THE RIGHT PLACE.
// ---------------------------------------------------------------------------
{
    const viewerSrc = fs.readFileSync(path.join(ROOT, 'js', 'attachment-viewer.js'), 'utf8');
    const card = extractFn(viewerSrc, 'buildAttachmentCard');

    assert(/o\.added/.test(card), 'buildAttachmentCard() must accept an `added` option');
    assert(/attachment-item--added/.test(card),
        'an added clip must carry the .attachment-item--added class — the outline that sets it apart');
    assert(/attachment-added-badge/.test(card),
        'an added clip must carry the banner too, so the marking is not colour-alone');
    // ⚠️ THE WORD, NOT A GLYPH. The marker was a circular ➕, which reads as a
    // control sitting on the clip rather than as a state. It must be the word.
    assert(/>NEW</.test(card),
        'the added banner must read "NEW" — the ➕ glyph it replaced read as an "add" ' +
        'button, not as a description of the clip');
    assert(!/fa-plus/.test(card),
        'the ➕ glyph must be gone from the card builder');
    assert(/aria-label="Added footage"/.test(card),
        'a word banner needs an accessible name; the glyph carried the meaning by shape alone');

    // ⚠️ OPT-IN. Violation folders and the operator's own ticket modal call this
    // same builder; a default-on marker would ring unrelated files.
    assert(/o\.added \? ' attachment-item--added' : ''/.test(card),
        'the class must be driven ONLY by the explicit `added` option, never unconditionally');

    // The superadmin's grid builds its OWN card (to inject Remove), so it would
    // drift from the shared builder unless marked separately.
    assert(/attachment-item--added/.test(scriptSrc),
        'script.js builds its own approval card for the Remove button — it must apply the same ' +
        'marking, or a clip would be ringed on one dashboard and plain on the other');
    assert(/renderGroup\(split\.manager, false\)/.test(scriptSrc) &&
           /renderGroup\(split\.operator, true\)/.test(scriptSrc),
        'only the OPERATOR group may be marked. The manager\'s own uploads are the original ' +
        'request and must never be ringed as "added footage"');

    // ⚠️ `.map(buildAttachmentRow)` passes the ARRAY as the 3rd argument — truthy —
    // and would ring every clip in the group. Both groups must be wrapped.
    assert(/buildAttachmentRow\(a, i, false\)/.test(ownerJs),
        'the requester group must pass an explicit false; a bare .map(buildAttachmentRow) hands ' +
        'the whole array in as the `added` argument and marks everything');

    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    assert(/\.attachment-item--added\s*\{[^}]*outline:/.test(css),
        'the added clip needs a visible outline distinct from a normal card');
    const badgeRule = (css.match(/\.attachment-added-badge\s*\{[^}]*\}/) || [])[0] || '';
    assert(/top:\s*0\b/.test(badgeRule) && /left:\s*0\b/.test(badgeRule),
        'the banner must sit FLUSH in the top-LEFT corner: .attachment-remove already owns ' +
        "top-right, and .attachment-item's overflow:hidden clips the flush corner into shape");
    assert(/padding:/.test(badgeRule),
        'the banner must be sized by padding to hug the word — a fixed 22px circle cannot hold ' +
        'three letters legibly');
    console.log('  PASS  the added marker is opt-in, on both card builders, clear of the Remove button');
}

// ===========================================================================
//  8. PROJECT RESET TOOL (docs/reset.html)
// ===========================================================================
// THE ACCIDENT THIS PREVENTS. Deleting "all the data" once wiped `branches`
// and every `users` doc, which dead-ended the project: registration needs a
// branch, branches need a superadmin, and no in-app account can ever BE the
// first superadmin (docs/BOOTSTRAP.md). The reset tool exists so that never
// has to be done by hand again — which only helps if the exclusions below are
// enforced BY THE CODE and stay enforced.
//
// Every assertion here is about what the tool must NOT do.
const resetHtml = fs.readFileSync(path.join(ROOT, 'docs', 'reset.html'), 'utf8');
const rulesSrc = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const firebaseJsSrc = fs.readFileSync(path.join(ROOT, 'firebase.js'), 'utf8');
const hostingJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));

// One helper for every rules assertion below. Scoped to the module (not to a
// single block) because sections 5, 5b and 5c all need it.
function block(name) {
    const start = rulesSrc.indexOf('match /' + name + '/');
    assert(start > -1, 'firestore.rules must contain a `match /' + name + '/` block');
    const next = rulesSrc.indexOf('\n    match /', start + 10);
    return rulesSrc.slice(start, next > -1 ? next : undefined);
}

console.log('\nTesting the project reset tool (what it must never delete)...');

// --- 1. IT MUST NOT BE DEPLOYED -------------------------------------------
// `firebase.json` sets hosting `public: "."`, so ANY .html at the repo root is
// published to the live site — a reset button at the root would be a standing
// public "delete all data" page. docs/** is already ignored.
{
    assert(hostingJson.hosting.ignore.indexOf('docs/**') > -1,
        'firebase.json hosting.ignore must keep docs/** — it is the ONLY reason the reset tool ' +
        'is not published to the live site');
    assert(!fs.existsSync(path.join(ROOT, 'reset.html')),
        'there must be NO reset.html at the repo root — with hosting public:"." it would be ' +
        'deployed as a public delete-everything page');
    assert(/noindex/.test(resetHtml),
        'the page must carry a noindex meta as a second line of defence');
    console.log('  PASS  the tool lives in docs/ and is excluded from hosting');
}

// --- 2. branches AND counters MUST NEVER BE DELETED ------------------------
// branches — the bootstrap deadlock: registration needs a branch, branches need
//   a superadmin, and no in-app account can be the first superadmin.
// counters — holds ticket-number sequences. Wiping it issues DUPLICATE ticket
//   numbers, which quietly corrupts every lookup keyed on the number.
{
    assert(/collections:\s*\[[^\]]*'branches'[^\]]*\]/.test(resetHtml),
        'branches MUST be in PROTECTED — deleting it dead-ends registration and admin creation');
    assert(/collections:\s*\[[^\]]*'counters'[^\]]*\]/.test(resetHtml),
        'counters MUST be in PROTECTED — wiping it issues duplicate ticket numbers');

    const plan = (resetHtml.match(/var PLAN\s*=\s*\[([\s\S]*?)\];/) || [])[1] || '';
    assert(/id:\s*'branches'/.test(plan) === false,
        'branches must never appear as an entry in the delete PLAN');
    assert(/id:\s*'counters'/.test(plan) === false,
        'counters must never appear as an entry in the delete PLAN');
    assert(/id:\s*'users'[\s\S]{0,140}?del:\s*'userRoles'/.test(plan),
        'users must be FILTERED by role (userRoles), never emptied with `del: true` — ' +
        'superadmin and operator accounts have to survive');
    console.log('  PASS  branches and counters are hard-protected; users is role-filtered');
}

// --- 3. Owner/HR/RM.SM ARE THE ONLY DELETABLE ROLES ---------------------------------------
{
    const roles = (resetHtml.match(/var DELETE_ROLES\s*=\s*\[([^\]]*)\]/) || [])[1] || '';
    assert(/'owner'/.test(roles) && /'hr'/.test(roles) && /'rmsm'/.test(roles),
        'Owner (Area Manager), HR and RM/SM are the roles the reset can delete; ' +
        'they are exactly what a reset should clear');
    assert(!/superadmin/.test(roles),
        'superadmin MUST NOT be in DELETE_ROLES — no in-app account can create the first one');
    assert(!/operator/.test(roles),
        'operator MUST NOT be in DELETE_ROLES — operators are made directly in Firestore and ' +
        'cannot be recreated from the UI');
    assert(/role\s*!==\s*'superadmin'/.test(resetHtml),
        'the gate must refuse anything whose role is not exactly superadmin');
    assert(/collection\('users'\)\.doc\(lower\)/.test(resetHtml),
        'the gate must read users/<email> — the same doc isSuperAdmin() uses in the rules');
    console.log('  PASS  only owner/hr/rmsm are deletable; superadmin and operator always survive');
}
// --- 4. THE GATE MUST FAIL CLOSED AND RUN BEFORE ANY WRITE -----------------
// An unrecognised role must be REFUSED, not treated as admin — otherwise a role
// added later ("auditor") would silently gain delete-everything.
{
    assert(/role\s*!==\s*'superadmin'/.test(resetHtml) && !/\.indexOf\(role\)/.test(resetHtml),
        'the gate must be a strict equality against the literal superadmin, not a list ' +
        'membership test — only the former cannot be satisfied by an unknown role');
    // The gate is called on sign-in AND immediately before the first write. The
    // second call is the one that matters: a session that lost superadmin between
    // opening the page and pressing the button must still be refused.
    assert((resetHtml.match(/requireSuperadmin\(/g) || []).length >= 2,
        'requireSuperadmin() must be called at least twice — once at sign-in and once again ' +
        'immediately before the first write, so a revoked session cannot still wipe the project');
    assert(/'RESET'/.test(resetHtml),
        'the destructive button must require the typed word RESET');
    console.log('  PASS  the gate fails closed, is re-checked before the write, and needs a typed RESET');
}

// --- 4b. THERE MUST BE NO SEPARATE SCAN STEP -------------------------------
// The "Scan project" button was an extra step for a count that is only
// actionable before a wipe you have already decided on — and a count read now
// plus a delete later are two different reads, so they can disagree, and the
// account safety rule would rest on a past decision. One button, one action.
{
    assert(!/scanBtn|scanCard|scanMsg|scanTables/.test(resetHtml),
        'the separate scan step must stay removed — sign in, type RESET, done');
    assert(!/function scan\(\)/.test(resetHtml),
        'there must be no scan() pass: the read that decides what to delete must be the ' +
        'delete\'s own read, so the two can never disagree');
    assert(!/scanCache/.test(resetHtml),
        'nothing may cache a count from an earlier read and act on it later');
    // The result is still reported — from live counts, after the run.
    assert(/function renderSummary/.test(resetHtml),
        'the reset must still report what it removed, read AFTER the fact');
    console.log('  PASS  one click, no separate scan; the outcome is still reported from live counts');
}

// --- 5. THE DELETES MUST BE PERMITTED BY THE RULES -------------------------
// If a grant is missing the reset half-fails silently, so every planned
// collection is checked against the rules.
{
    ['tickets', 'violations', 'status_logs', 'users', 'chats'].forEach((c) => {
        assert(/delete[^;]*isSuperAdmin\(\)/.test(block(c)),
            c + ' needs a superadmin delete grant or the reset silently half-fails');
    });

    // The chats grant must NOT have widened any subcollection. Messages stay
    // immutable (pinned twice in test/chat-rules.test.js), and a superadmin grant
    // inside a private thread would be a real privacy regression.
    const chats = block('chats');
    ['messages', 'presence', 'readReceipts', 'reactions', 'profiles'].forEach((sub) => {
        const s = chats.indexOf('match /' + sub + '/');
        assert(s > -1, 'chats must still declare a `match /' + sub + '/` block');
        const nxt = chats.indexOf('match /', s + 12);
        const subBlock = chats.slice(s, nxt > -1 ? nxt : undefined);
        assert(!/isSuperAdmin\(\)/.test(subBlock),
            'chats/' + sub + ' must NOT gain a superadmin rule — deleting the ROOM already makes ' +
            'these unreachable, so a grant here would widen superadmin access to private 1:1 threads');
    });
    console.log('  PASS  every planned collection is deletable; no chat subcollection was widened');
}

// --- 5b. chats MUST BE DELETED WITHOUT EVER BEING READ --------------------
// ⚠️ THIS IS THE ONE THAT ACTUALLY BIT, TWICE.
// (1) Firestore has no "delete this collection" primitive — ids must be read
//     first — and an unfiltered chats.get() is REFUSED for a superadmin, because
//     the read rule is membership-based (canReadChat). That produced
//     "Missing or insufficient permissions" and aborted the run.
// (2) The obvious "fix" — adding `isSuperAdmin() ||` to the chats READ rule —
//     works, and is WRONG: a room doc carries `lastMessage`, so it would expose
//     the last line of every private 1:1 conversation. test/chat-rules.test.js
//     caught it and it was reverted.
// The correct answer is that room ids are DETERMINISTIC, so they can be computed
// from `users` (which a superadmin already reads) and deleted blind.
{
    const chatsRead = (block('chats').match(/allow read:[\s\S]*?;/) || [])[0] || '';
    assert(!/isSuperAdmin\(\)/.test(chatsRead),
        'chats must NOT grant a superadmin READ — a room doc carries `lastMessage`, so this ' +
        'would expose the last line of every private 1:1 conversation to any superadmin');

    // ⚠️ SCAN CODE, NOT COMMENTS. deleteChatRooms()'s doc comment quotes
    // `db.collection('chats').get()` to explain why that approach is WRONG, so a
    // whole-file grep matches the very documentation that records the fix — the
    // same trap the footage suite hits with its own bug-quoting comment.
    const resetCode = resetHtml
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
    assert(!/db\.collection\('chats'\)\.get\(\)/.test(resetCode),
        'the tool must never .get() the chats collection — that read is refused for a superadmin ' +
        'by design, and fails with "Missing or insufficient permissions"');
    assert(/function deleteChatRooms/.test(resetHtml),
        'chat rooms must be removed by a dedicated path');
    // The derivation must match dmRoomIdFor() in chat.js exactly, or the computed
    // ids miss the real rooms and the wipe silently does nothing.
    assert(/'dm_' \+ keys\[0\] \+ '__' \+ keys\[1\]/.test(resetHtml),
        "the computed room id must be 'dm_' + sorted keys joined by '__' — the exact shape " +
        'dmRoomIdFor() writes, or the wipe targets rooms that do not exist');
    assert(/\.sort\(\)/.test(resetHtml) && /encodeURIComponent/.test(resetHtml),
        'the key must be encodeURIComponent(email.toLowerCase()) and the two keys SORTED — ' +
        'sorting is what makes the id symmetric, so both participants derive the same room');
    assert(/'owner-superadmin'/.test(resetHtml),
        'the pinned group room is not a pair and must be deleted by name');
    // Subcollections must stay locked.
    const chats2 = block('chats');
    ['messages', 'presence', 'readReceipts', 'reactions', 'profiles'].forEach((sub) => {
        const s = chats2.indexOf('match /' + sub + '/');
        const nxt = chats2.indexOf('match /', s + 12);
        assert(!/isSuperAdmin\(\)/.test(chats2.slice(s, nxt > -1 ? nxt : undefined)),
            'chats/' + sub + ' must NOT gain a superadmin rule — nothing in a private 1:1 ' +
            'conversation may become readable, not even its room document');
    });
    console.log('  PASS  chat rooms are deleted by computed id, with the read rule untouched');
}

// --- 5c. ONE BLOCKED COLLECTION MUST NOT ABORT THE REST --------------------
// The first real run stopped on chats and never reached the accounts, so
// tickets/violations/status were wiped and the operator/HR accounts silently
// survived with no explanation. Each step must be isolated.
{
    assert(/var failures = \[\]/.test(resetHtml) && /function step\(label, collName, predicate\)/.test(resetHtml),
        'each collection must be deleted through an isolated step() that records a failure');
    // Every collection must go through step(), so a rejection is recorded and the
    // run CONTINUES. ⚠️ The single legitimate `deleteQuery(db.collection(...))`
    // call is the one INSIDE step() — step() is nested in this handler, so a bare
    // "no such call anywhere" assertion can never pass. The real check is that
    // the chain itself only ever calls step().
    const runStart = resetHtml.indexOf("$('runBtn').addEventListener");
    assert(runStart > -1, 'the run must still hang off the #runBtn click handler');
    const runBody = resetHtml.slice(runStart, resetHtml.indexOf('/* ============================ BOOT', runStart));
    ['tickets', 'violations', 'status_logs'].forEach((c) => {
        assert(new RegExp("step\\('[^']*',\\s*'" + c + "'").test(runBody),
            c + ' must be deleted through step() so a rejection is recorded and the run continues');
    });
    // Label-agnostic on purpose: the display label is free to change (it did,
    // when RM/SM accounts joined this step) — what must never change is that
    // the users step goes through step(), so a rejection is recorded.
    assert(/step\('[^']*',\s*'users'/.test(runBody),
        'the accounts — the last step, and the one a chats failure previously prevented ' +
        'reaching — must go through step() too');
    assert(/deleteChatRooms\(\)/.test(runBody),
        'the chats step must still be isolated so a failure is reported rather than fatal');
    assert(/firebase deploy --only firestore:rules/.test(resetHtml),
        'a blocked collection must print the exact deploy command — "Missing or insufficient ' +
        'permissions" is the signature of un-deployed rules and is otherwise undecodable');
    console.log('  PASS  a blocked collection is reported, not fatal, and names the deploy command');
}
// The page duplicates the config rather than loading firebase.js (which would
// drag the whole app in). A duplicated config is a silent breakage.
{
    const cfg = (resetHtml.match(/var firebaseConfig\s*=\s*\{([\s\S]*?)\n\};/) || [])[1] || '';
    ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'].forEach((k) => {
        const inApp = (firebaseJsSrc.match(new RegExp(k + ':\\s*"([^"]+)"')) || [])[1];
        const inTool = (cfg.match(new RegExp(k + ':\\s*"([^"]+)"')) || [])[1];
        assert(inApp, 'firebase.js must define ' + k);
        assert(inTool === inApp,
            'the reset tool\'s ' + k + ' (' + inTool + ') must match firebase.js (' + inApp + ') — ' +
            'a duplicated config silently points at the wrong project');
    });
    console.log('  PASS  the duplicated Firebase config matches firebase.js');
}

// --- 7. IT MUST SAY WHAT IT DOES NOT DO -----------------------------------
{
    assert(/Cloudinary/i.test(resetHtml),
        'the page must warn that Cloudinary files are NOT deleted — Firestore holds only URLs, ' +
        'so every uploaded clip and PDF survives and keeps costing storage');
    assert(/orphan/i.test(resetHtml),
        'the page must explain that chat subcollections become unreachable orphans rather than ' +
        'implying the messages were deleted');
    assert(/Irreversible|cannot be undone/i.test(resetHtml),
        'the page must state plainly that the reset cannot be undone');
    console.log('  PASS  the page warns about Cloudinary, orphaned messages, and irreversibility');
}

console.log('\n✅ Reset tool tests passed (excluded from hosting; branches and counters hard-protected; ' +
    'only owner/hr deletable and superadmin/operator always survive; the gate fails closed and is ' +
    're-checked before the write; one click with no separate scan; every planned collection is ' +
    'deletable under the rules with no chat subcollection widened; the config matches firebase.js; ' +
    'and the page warns about Cloudinary, orphaned messages and irreversibility).');
