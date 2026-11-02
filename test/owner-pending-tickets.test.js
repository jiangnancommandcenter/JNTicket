// Functional test for the NOT-YET-APPROVED ("pending") tickets the Area Manager
// and RM/SM now see on their dashboard.
//
// THE RULE. Until now the owner dashboard showed a manager NOTHING until the
// superadmin approved a ticket — isApprovedTicket() and the force-locked
// `selectedStatus = 'Resolved'` both drop unapproved work. That is correct for
// the DEFAULT approved view, but it left a manager with no way to tell whether a
// ticket they filed was even in the system. This closes that gap:
//
//   * For the two manager roles ONLY (isAreaManager() === owner || rmsm), the
//     Tickets list ALSO appends every not-yet-approved ticket in their assigned
//     branches, badged with its honest pipeline label.
//   * Clicking one opens the report modal's PENDING branch: an amber
//     "Approval still Pending" notice + a metadata card showing the
//     SUBJECT — and NOTHING else sensitive (no description, findings, footage),
//     exactly the payload an expired window withholds.
//
// ⚠️ The approved-only gate is UNTOUCHED and still runs first; these tests pin
// both the new behaviour AND that the gate did not regress.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const ownerJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8');
const ownerHtml = fs.readFileSync(path.join(ROOT, 'ownerdashboard.html'), 'utf8');

/** Strip comments so prose that NAMES an identifier is not mistaken for code. */
const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

console.log('Testing the not-yet-approved ("pending") tickets on the Area Manager dashboard...');

/** Extract a named top-level function (brace-matched) from the source. */
function extractFn(name) {
    const start = ownerJs.indexOf('function ' + name + '(');
    assert(start > -1, name + '() not found in js/owner-dashboard.js');
    let depth = 0;
    for (let j = ownerJs.indexOf('{', start); j < ownerJs.length; j++) {
        if (ownerJs[j] === '{') depth++;
        else if (ownerJs[j] === '}') {
            depth--;
            if (depth === 0) return ownerJs.slice(start, j + 1);
        }
    }
    throw new Error('could not find the end of ' + name + '()');
}

// ============================================================================
// 1. THE TWO HELPERS — semantics, run for real in a sandbox.
// ============================================================================
// isPendingApprovalTicket() is the exact complement of isApprovedTicket(), so it
// must be true for EVERY not-yet-approved state and false only for 'approved'.
const helperSandbox = { console };
helperSandbox.window = helperSandbox;
vm.createContext(helperSandbox);
vm.runInContext([
    extractFn('isApprovedTicket'),
    extractFn('isPendingApprovalTicket'),
    extractFn('ticketDisplayStatus'),
    'globalThis.__h = { isApprovedTicket, isPendingApprovalTicket, ticketDisplayStatus };'
].join('\n'), helperSandbox);
const H = helperSandbox.__h;
assert(H, 'the pending helpers were not loaded into the sandbox');

// isPendingApprovalTicket() — true for every unapproved state.
[
    ['pending', 'a freshly-filed ticket'],
    ['pending_approval', 'a resolved ticket queued for the superadmin'],
    ['rejected', 'a ticket sent back for revision']
].forEach(([status, what]) => {
    assert.strictEqual(H.isPendingApprovalTicket({ approvalStatus: status }), true,
        `a ${what} ("${status}") must count as pending`);
});
assert.strictEqual(H.isPendingApprovalTicket({}), true,
    'a legacy ticket with no approvalStatus defaults to "pending", so it IS pending');
assert.strictEqual(H.isPendingApprovalTicket(null), true,
    'null is not approved, so it is pending (isApprovedTicket(null) is false)');
assert.strictEqual(H.isPendingApprovalTicket({ approvalStatus: 'approved' }), false,
    'an APPROVED ticket must NOT be pending — this is the one exclusion');
assert.strictEqual(H.isPendingApprovalTicket({ approvalStatus: '  APPROVED  ' }), false,
    'approval is case- and whitespace-insensitive, matching isApprovedTicket()');
// The two predicates are exact complements: for any input, exactly one is true.
[
    { approvalStatus: 'approved' }, { approvalStatus: 'pending_approval' },
    { approvalStatus: 'rejected' }, {}, null
].forEach((t) => {
    assert.strictEqual(H.isPendingApprovalTicket(t), !H.isApprovedTicket(t),
        'isPendingApprovalTicket() must be the exact complement of isApprovedTicket()');
});
console.log('  PASS  isPendingApprovalTicket() is the exact complement of the approved gate');

// ticketDisplayStatus() — PIPELINE-HONEST. "Resolved" only when the
// superadmin has approved it; otherwise the live pipeline state, so a manager
// tracking their own ticket sees it move (Pending → In Progress →
// Pending Approval → Resolved). The one word it must never emit for an
// unapproved ticket is "Resolved" — that would promise readable content that
// is still withheld.
assert.strictEqual(H.ticketDisplayStatus({ status: 'Resolved', approvalStatus: 'approved' }),
    'Resolved', 'an APPROVED ticket reads "Resolved"');
assert.strictEqual(H.ticketDisplayStatus({ status: 'Resolved', approvalStatus: 'pending_approval' }),
    'Pending Approval', 'a resolved-but-unapproved ticket reads "Pending Approval", NOT "Resolved"');
assert.strictEqual(H.ticketDisplayStatus({ status: 'Resolved', approvalStatus: 'rejected' }),
    'Pending Approval', 'a rejected (For-Revision) resolution is still not approved, so "Pending Approval"');
assert.strictEqual(H.ticketDisplayStatus({ status: 'In Progress', approvalStatus: 'pending' }),
    'In Progress', 'an in-work ticket reads "In Progress" — this is the live tracking the manager asked for');
assert.strictEqual(H.ticketDisplayStatus({ status: 'Pending', approvalStatus: 'pending' }),
    'Pending', 'a freshly-filed ticket reads "Pending"');
assert.strictEqual(H.ticketDisplayStatus({ status: 'For Revision' }),
    'Pending Approval', '"For Revision" is an operator word — the manager reads "Pending Approval"');
assert.strictEqual(H.ticketDisplayStatus({ status: 'Insufficient Footage' }),
    'Pending Approval', '"Insufficient Footage" collapses too — the ticket is back awaiting sign-off');
assert.strictEqual(H.ticketDisplayStatus({ status: 'In Progress' }),
    'In Progress', 'any in-work state reads "In Progress"');
assert.strictEqual(H.ticketDisplayStatus({}), 'Pending', 'a ticket with no status defaults to "Pending"');
// "Resolved" is reserved for approved tickets ONLY — the one hard rule. An
// unapproved ticket must never emit it, whatever its raw status.
[
    { status: 'In Progress', approvalStatus: 'pending' },
    { status: 'For Revision' }, { status: 'Insufficient Footage' }, {}, null
].forEach((t) => {
    const label = H.ticketDisplayStatus(t);
    assert.ok(
        label && label !== 'Resolved',
        'an UNAPPROVED ticket must never read "Resolved" — that word promises readable content'
    );
});
assert.strictEqual(H.ticketDisplayStatus({ status: 'Resolved', approvalStatus: 'approved' }),
    'Resolved', '...while an APPROVED ticket still reads "Resolved"');
// The manager side speaks exactly four labels — "For Revision" and
// "Insufficient Footage" are operator words that must never surface here.
[
    {}, { status: 'Pending' }, { status: 'In Progress' },
    { status: 'Resolved', approvalStatus: 'pending_approval' },
    { status: 'Resolved', approvalStatus: 'rejected' },
    { status: 'For Revision' }, { status: 'Insufficient Footage' },
    { status: 'Resolved', approvalStatus: 'approved' }
].forEach((t) => {
    assert.ok(
        ['Pending', 'In Progress', 'Pending Approval', 'Resolved'].indexOf(H.ticketDisplayStatus(t)) > -1,
        'ticketDisplayStatus() must only ever return Pending / In Progress / Pending Approval / Resolved'
    );
});
console.log('  PASS  ticketDisplayStatus() is pipeline-honest ("Resolved" reserved for approved)');

// ============================================================================
// 2. THE LIST — the approved gate is untouched, and pending is appended for the
//    manager roles only.
// ============================================================================
const listSrc = extractFn('renderOwnerTickets');

// ⚠️ THE APPROVED GATE MUST STILL RUN FIRST, UNCHANGED. These are the exact lines
// test/owner-ticket-approval.test.js and test/chat-ticket-mentions.test.js pin;
// the pending feature must sit AFTER them, never replace them.
assert(
    /if \(ownerResolvedOnly\) \{\s*tickets = tickets\.filter\(\(t\) => isApprovedTicket\(t\)\);/.test(listSrc),
    'the approved-only gate must still filter through isApprovedTicket() — the pending feature is ' +
    'an ADDITION, not a replacement'
);
assert(
    /if \(ownerResolvedOnly\) selectedStatus = 'Resolved';/.test(listSrc),
    'the Resolved-only scope must still be explicit — js/chat.js\'s @ticket picker mirrors it'
);

// The pending append must exist, be gated on isAreaManager(), and use concat
// (never a mutation of the already-filtered approved list).
assert(
    /if \(isAreaManager\(\)\) \{[\s\S]*?isPendingApprovalTicket\(t\)[\s\S]*?tickets = tickets\.concat\(pending\);/.test(listSrc),
    'renderOwnerTickets() must, for isAreaManager() only, collect not-yet-approved tickets and ' +
    'CONCAT them onto the approved list'
);
// It must re-scan the RAW list (allRaw), not the already-filtered `tickets` —
// otherwise the approved gate above would have already removed every pending row.
assert(
    /const pending = allRaw[\s\S]*?isPendingApprovalTicket\(t\)/.test(listSrc),
    'the pending scan must read the RAW list (allRaw) — the approved gate already removed pending ' +
    'rows from `tickets`, so scanning that would find nothing'
);
// Every manager control (branch / access / search / period / status)
// must be re-applied to the pending rows, or a filter would silently ignore them.
['selectedBranch', 'accessMatches(t)', 'searchText', 'periodStart', 'statusLabelMatches'].forEach((token) => {
    // Slice only the pending block so a token used by the approved path above
    // does not satisfy this.
    const pendingBlock = listSrc.slice(listSrc.indexOf('const pending = allRaw'));
    assert(pendingBlock.indexOf(token) > -1,
        `the pending append must re-apply the ${token} predicate so the filters keep working`);
});
// The period filter defaults to TODAY on load (triage today's work first),
// with "All" kept as the recovery option for older tickets.
const periodSelect = ownerHtml.slice(ownerHtml.indexOf('id="ticketPeriodFilter"'), ownerHtml.indexOf('id="ticketPeriodFilter"') + 600);
assert(
    /<option value="daily" selected>Today<\/option>/.test(periodSelect),
    'the period filter must default to "Today" — the manager triages today\'s work first'
);
assert(
    /<option value="all">All<\/option>/.test(periodSelect),
    'the period filter must KEEP the "All" option — without it older tickets are stranded'
);
assert(
    /const periodValue = \(ownerTicketPeriodFilter && ownerTicketPeriodFilter\.value\) \|\| 'daily';/.test(listSrc),
    'a missing/unreadable period select must fall back to Today, matching the markup default'
);
console.log('  PASS  the approved gate is untouched; pending is appended for isAreaManager() and respects every filter');

// ============================================================================
// 3. THE ROW — a pending row is relabelled, an approved row is unchanged.
// ============================================================================
// The row must compute pendingApproval and render the label/class from it.
assert(
    /const pendingApproval = isAreaManager\(\) && isPendingApprovalTicket\(t\);/.test(listSrc),
    'the row must decide its label from isAreaManager() && isPendingApprovalTicket(t)'
);
assert(
    /const statusLabel = pendingApproval \? ticketDisplayStatus\(t\) : status;/.test(listSrc),
    'the row must show ticketDisplayStatus(t) for a pending ticket and the raw status otherwise'
);
// ⚠️ The Status and Access cells must STAY separate and in order (a pinned
// structural assertion in owner-ticket-approval.test.js) — the relabel must not
// merge them back into one cell.
assert(
    /<td data-label="Status">[\s\S]*?<\/td>\s*<td data-label="Access">/.test(listSrc),
    'Status and Access must remain two SEPARATE cells, in that order'
);
console.log('  PASS  the row relabels a pending ticket without disturbing the approved row or the cell layout');

// ============================================================================
// 4. THE MODAL — a pending ticket shows the subject and withholds the payload.
// ============================================================================
const modalSrc = ownerJs.slice(
    ownerJs.indexOf('window.openOwnerReport = function'),
    ownerJs.indexOf('function closeOwnerReportModalFn')
);

// The 3-way branch. `const html = expired ?` MUST stay the literal first branch
// (owner-ticket-approval.test.js pins it), with pending inserted as the middle.
assert(
    /const html = expired \? `/.test(modalSrc),
    'the modal must still branch on expiry FIRST — the pending branch is inserted after it'
);
assert(
    /` : pendingApproval \? `/.test(modalSrc),
    'the modal must add a pendingApproval branch between the expired and the full-report branches'
);

// Isolate the PENDING template: from `: pendingApproval ? \`` to the next \` : \`.
const pendStart = modalSrc.indexOf('` : pendingApproval ? `');
const pendEnd = modalSrc.indexOf('` : `', pendStart);
assert(pendStart > -1 && pendEnd > pendStart, 'could not isolate the pending template');
const pendingTemplate = modalSrc.slice(pendStart, pendEnd);

// The subject MUST be shown — that is the whole indicator the manager asked for.
assert(
    /Approval still Pending/.test(pendingTemplate),
    'the pending modal must say "Approval still Pending" (the pipeline badge carries the live state)'
);
assert(
    /data\.title/.test(pendingTemplate),
    'the pending modal MUST render the subject (data.title) so the manager can tell which ticket it is'
);
assert(
    /owner-access-pending/.test(pendingTemplate),
    'the pending modal must render the amber .owner-access-pending notice'
);

// ⚠️ THE PAYLOAD MUST BE WITHHELD — the same rule the expired branch enforces.
// This is the assertion that catches a future edit that renders the evidence on
// a not-yet-approved ticket.
[
    ['data.description', 'the issue description'],
    ['resNotes', 'the operator findings'],
    ['requesterAttHtml', "the requester's attachments"],
    ['operatorAttHtml', "the operator's footage"],
    ['buildAttachmentRow', 'any attachment link']
].forEach(([token, what]) => {
    assert(
        pendingTemplate.indexOf(token) === -1,
        `the PENDING branch must not render ${what} ("${token}") — that payload is withheld until approval`
    );
});
console.log('  PASS  the pending modal shows the subject and withholds description, findings and ALL attachments');

// The header status badge must use the honest label too, so header and row agree.
assert(
    /pendingApproval \? ticketDisplayStatus\(rawData\) : String\(data\.status/.test(modalSrc),
    'the modal header badge must show ticketDisplayStatus() for a pending ticket'
);
// A pending ticket has no viewing window, so the first-open stamp must be skipped
// (there is no clock to start) — otherwise it would attempt a pointless write.
assert(
    /if \(expiryAppliesToViewer\(\) && !pendingApproval\) \{/.test(modalSrc),
    'the first-open stamp must be skipped for a pending ticket — there is no window to start'
);
console.log('  PASS  the header badge agrees with the row, and no viewing window is started for a pending ticket');

// ============================================================================
// 5. THE STYLES — token-only, so dark mode works (owner-dark-mode.test.js rule).
// ============================================================================
const pendingStyles = ownerHtml.slice(
    ownerHtml.indexOf('PENDING-APPROVAL TICKET'),
    ownerHtml.indexOf('.owner-window-note')
);
assert(pendingStyles.length > 0, 'could not find the pending-approval styles in ownerdashboard.html');
assert(/#[0-9a-f]{3,8}\b/i.test(pendingStyles) === false,
    'the pending styles must not hardcode a hex colour — use theme tokens so dark mode works');
assert(!/rgba\(\s*255\s*,\s*255\s*,\s*255/.test(pendingStyles),
    'the pending styles must not use a hardcoded white surface (the original dark-mode bug)');
['--color-warning', '--text-secondary', '--border-color'].forEach((token) => {
    assert(pendingStyles.indexOf(token) > -1,
        `the pending styles should use ${token} so they follow the active theme`);
});
// The classes the modal actually emits must exist in the stylesheet.
['.owner-access-pending {', '.owner-access-pending-title {', '.owner-access-pending-body {'].forEach((sel) => {
    assert(ownerHtml.indexOf(sel) > -1, `ownerdashboard.html must define ${sel}`);
});
console.log('  PASS  the pending styles are token-based, not hardcoded light values');

// ============================================================================
// 6. NO DEAD / ORPHANED CODE — the removed statusClass is not referenced bare.
// ============================================================================
assert(
    stripComments(listSrc).indexOf('const statusClass =') === -1,
    'the row renderer must not keep a now-unused `statusClass` — it was replaced by statusBadgeClass'
);
console.log('  PASS  no dead statusClass left behind in the row renderer');

console.log('\n✅ Not-yet-approved ("pending") ticket tests passed (complement helpers; approved gate ' +
    'untouched and still first; pending appended for isAreaManager() through every filter; row labelled ' +
    'with the live pipeline state without disturbing the approved row or the two-cell layout; the modal shows ' +
    'the subject and withholds the description, findings and ALL footage; no viewing window is started; ' +
    'token-only styles).');



