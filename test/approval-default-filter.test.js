// ===========================================================================
//  TICKET REVIEWS MUST OPEN UNFILTERED ("All"), not on "Pending Approval"
// ===========================================================================
// THE REQUEST. A superadmin clicking the Ticket Reviews tab wanted the status
// filter to default to "All" instead of "Pending Approval", so the tab shows
// the whole review history — pending, approved, expired and returned — rather
// than only the queue waiting for a decision.
//
// WHY IT IS ONLY AN HTML CHANGE. The default lived entirely in the `selected`
// attribute on the <option>, and nothing in the app ever fights it:
//   * script.js only READS `approvalStatusFilter.value` (applyApprovalFilters);
//     no code path writes to the select.
//   * js/refresh-state.js restores the current TAB and modal, not filter values.
//   * switchTab('approvals') calls filterApprovalTickets(), which re-reads that
//     same select — so whatever the markup says IS what the tab opens on.
//
// The guards below exist because "selected" is a one-token change that silently
// regresses: putting it back on "Pending Approval" looks like a harmless edit,
// and the only symptom is a superadmin quietly not seeing returned or expired
// tickets. These assertions fail loudly instead.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const mainHtml = fs.readFileSync(path.join(ROOT, 'main.html'), 'utf8');
const scriptSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

console.log('Testing the Ticket Reviews default filter...');

/** The #approvalStatusFilter <select> block, braces of markup not needed. */
function approvalFilterSelect() {
    const at = mainHtml.indexOf('id="approvalStatusFilter"');
    assert(at > -1, '#approvalStatusFilter not found in main.html');
    const open = mainHtml.lastIndexOf('<select', at);
    const close = mainHtml.indexOf('</select>', at);
    assert(open > -1 && close > at, 'could not delimit #approvalStatusFilter');
    return mainHtml.slice(open, close + '</select>'.length);
}

const sel = approvalFilterSelect();

// --- the default itself ---
assert(/<option value="all" selected>All<\/option>/.test(sel),
    'the "All" option must carry `selected` — this is what makes Ticket Reviews ' +
    'open unfiltered instead of on "Pending Approval"');

assert(!/selected/.test(sel.replace(/<option value="all" selected>/, '')),
    'exactly ONE option may be `selected`. A second one is undefined behaviour ' +
    'and the browser picks whichever it likes, which is how this silently ' +
    'reverts to the wrong default.');

// The specific regression: `selected` back on Pending Approval.
assert(!/<option value="Pending Approval" selected>/.test(sel),
    '"Pending Approval" must NOT be selected — that was the original default ' +
    'this change removes');

// --- every option the filter can produce must still exist ---
for (const value of ['all', 'Pending Approval', 'Approved', 'Expired', 'For Revision']) {
    assert(sel.includes('value="' + value + '"'),
        'the "' + value + '" option must remain selectable');
}

// --- the JS must not override the markup default ---
assert(/const selectedStatus = approvalStatusFilter \? approvalStatusFilter\.value : 'all';/
    .test(scriptSrc),
    'applyApprovalFilters() must read the select\'s value — that read is the ' +
    'only thing the markup default feeds, so if it is removed the filter is ' +
    'hard-coded and this markup change stops having any effect');

assert(/selectedStatus === 'all'/.test(scriptSrc),
    'the "all" value must still mean "no status filter"; without that branch ' +
    'every ticket would match a status literally named "all" and the tab ' +
    'would render EMPTY with "All" selected');

assert(!/approvalStatusFilter\.value\s*=/.test(scriptSrc),
    'nothing may WRITE to approvalStatusFilter.value — a write would stomp the ' +
    'markup default on load and put the filter back to something else');

// Switching to the tab must re-run the filter from that same select.
const tabAnchor = scriptSrc.indexOf("if (tabId === 'approvals')");
assert(tabAnchor > -1, "switchTab()'s approvals branch not found");
const switchTab = scriptSrc.slice(tabAnchor,
    scriptSrc.indexOf('captureMainState', tabAnchor));
assert(/filterApprovalTickets\(\)/.test(switchTab),
    "switchTab('approvals') must re-apply the filters, otherwise the list can " +
    'show a stale result from the last time the tab was opened');

console.log('  \u2713 Ticket Reviews opens on "All"');
console.log('\n\u2705 Ticket Reviews default-filter tests passed (the "All" option carries `selected` and ' +
    'is the only selected one; "Pending Approval" no longer is; every status option survives; ' +
    'applyApprovalFilters() reads the select and still treats "all" as no status filter; ' +
    'nothing overwrites the select\'s value; and opening the tab re-runs the filter).');