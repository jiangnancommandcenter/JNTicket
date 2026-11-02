// Functional test for the AREA MANAGER ticket list: superadmin-APPROVED only,
// and an expiring viewing window on the approved ticket.
//
// THE RULE BEING TESTED. The ticket lifecycle (script.js) is:
//
//    operator resolves   → status 'Resolved', approvalStatus 'pending_approval'
//    superadmin approves → approvalStatus 'approved'  (+ accessExpiresAt)
//
// So `status === 'Resolved'` is NOT the approval signal: it also matches work
// still queued for review and work sent back for revision. The list must gate
// on `approvalStatus === 'approved'`, and an approved-but-LAPSED ticket stays
// in the list, badged, with its report + CCTV evidence withheld.
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

console.log('Testing the Area Manager ticket approval + expiry gate...');

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

const HOUR = 60 * 60 * 1000;

// The expiry helpers are DELEGATED to firebase.js in the browser, so the
// sandbox supplies stand-ins with the same semantics. Mirroring them here is
// deliberate: these assertions are about owner-dashboard.js's decisions, and
// firebase.js's own arithmetic is covered by test/tracking-access.test.js.
const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(`
  var TRACKING_ACCESS_WINDOW_MS = ${HOUR};
  function toDate(v) {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate();
    var d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function getTrackingAccessExpiry(t) {
    if (!t) return null;
    if ((t.approvalStatus || 'pending') !== 'approved') return null;
    var stored = toDate(t.accessExpiresAt);
    if (stored) return stored;
    var approved = toDate(t.approvedAt);
    if (!approved) return null;
    return new Date(approved.getTime() + TRACKING_ACCESS_WINDOW_MS);
  }
  function isTrackingAccessExpired(t, now) {
    var e = getTrackingAccessExpiry(t);
    if (!e) return false;
    var ref = now ? toDate(now) : new Date();
    return e.getTime() <= (ref ? ref.getTime() : Date.now());
  }
  function formatTrackingAccessWindow(ms) {
    var v = Number(ms) > 0 ? Number(ms) : TRACKING_ACCESS_WINDOW_MS;
    var minutes = Math.round(v / 60000);
    if (minutes < 60) return minutes === 1 ? '1 minute' : minutes + ' minutes';
    var hours = Math.round(v / 3600000);
    if (hours < 48) return hours === 1 ? '1 hour' : hours + ' hours';
    var days = Math.round(v / 86400000);
    return days === 1 ? '1 day' : days + ' days';
  }

  ${extractFn('isApprovedTicket')}
  ${extractFn('isOwnerTicketExpired')}
  ${extractFn('ownerTicketExpiry')}
  ${extractFn('ownerAccessWindowLabel')}

  globalThis.__api = {
    isApprovedTicket: isApprovedTicket,
    isOwnerTicketExpired: isOwnerTicketExpired,
    ownerTicketExpiry: ownerTicketExpiry,
    ownerAccessWindowLabel: ownerAccessWindowLabel
  };
`, sandbox);

const api = sandbox.__api;
assert(api, 'the approval/expiry helpers were not loaded into the sandbox');

// ---------------------------------------------------------------------------
// 1. isApprovedTicket() — the approval gate itself.
// ---------------------------------------------------------------------------
assert.strictEqual(api.isApprovedTicket({ approvalStatus: 'approved' }), true,
    'an approved ticket must pass the gate');
assert.strictEqual(api.isApprovedTicket({ approvalStatus: 'APPROVED' }), true,
    'approval must be case-insensitive');
assert.strictEqual(api.isApprovedTicket({ approvalStatus: '  approved  ' }), true,
    'a padded approval must pass');
assert.strictEqual(api.isApprovedTicket({ approvalStatus: 'pending_approval' }), false,
    'a ticket still QUEUED for the superadmin must NOT pass — this is the whole point');
assert.strictEqual(api.isApprovedTicket({ approvalStatus: 'rejected' }), false,
    'a ticket sent back for revision must NOT pass');
assert.strictEqual(api.isApprovedTicket({ approvalStatus: 'pending' }), false, 'a pending ticket must NOT pass');
// A legacy ticket that predates the approval workflow has NO field. It must
// default to NOT approved — assuming otherwise would leak unapproved work.
assert.strictEqual(api.isApprovedTicket({}), false,
    'a ticket with no approvalStatus must NOT be treated as approved');
assert.strictEqual(api.isApprovedTicket(null), false, 'null must be rejected');
assert.strictEqual(api.isApprovedTicket(undefined), false, 'undefined must be rejected');
assert.strictEqual(api.isApprovedTicket({ approvalStatus: 'approved-ish' }), false,
    'a near-miss value must NOT pass');
console.log('  PASS  the approval gate: approved only, legacy/unknown defaults to NOT approved');

// ---------------------------------------------------------------------------
// 2. The helpers DELEGATE to firebase.js rather than re-deriving the
//    arithmetic, so the manager and the public track page cannot disagree.
// ---------------------------------------------------------------------------
assert(
    /window\.isTrackingAccessExpired\(ticket\)/.test(extractFn('isOwnerTicketExpired')),
    'isOwnerTicketExpired() must delegate to window.isTrackingAccessExpired() — re-deriving the ' +
    'arithmetic here is how the two surfaces would drift apart'
);

// ============================================================================
// 8. ONLY THE AREA MANAGER HAS A VIEWING WINDOW
// ============================================================================
// THE REQUIREMENT: "modify the tickets without expiration — only area manager
// has expirations". HR shares this dashboard and was being held to the
// REQUESTER's 2-day window, which only ever withheld a report from someone whose
// job is to read it.
//
// The policy is deliberately SEPARATE from the fact: isOwnerTicketExpired()
// answers "has this ticket's window closed?", expiryAppliesToViewer() answers
// "does that window apply to the person looking?". Folding the two together
// would make the arithmetic untestable on its own.
const policySandbox = { console: { log() {}, warn() {}, error() {}, info() {} } };
policySandbox.window = policySandbox;
vm.createContext(policySandbox);
vm.runInContext("var activeUserRole = 'viewer';", policySandbox);
// The expiry helpers DELEGATE to window.isTrackingAccessExpired /
// getTrackingAccessExpiry, so the same stand-ins the rest of this suite uses
// are supplied here. Without them isOwnerTicketExpired() returns false for
// everything and the test would pass for the wrong reason.
vm.runInContext([
    'var TRACKING_ACCESS_WINDOW_MS = ' + HOUR + ';',
    'function toDate(v){ if(!v) return null; if(typeof v.toDate==="function") return v.toDate();',
    '  var d = v instanceof Date ? v : new Date(v); return isNaN(d.getTime()) ? null : d; }',
    'function getTrackingAccessExpiry(t){',
    '  if(!t) return null;',
    '  if((t.approvalStatus || "pending") !== "approved") return null;',
    '  var stored = toDate(t.accessExpiresAt); if(stored) return stored;',
    '  var approved = toDate(t.approvedAt); if(!approved) return null;',
    '  return new Date(approved.getTime() + TRACKING_ACCESS_WINDOW_MS); }',
    'function isTrackingAccessExpired(t){',
    '  var e = getTrackingAccessExpiry(t); if(!e) return false;',
    '  return e.getTime() <= Date.now(); }',
    'window.isTrackingAccessExpired = isTrackingAccessExpired;',
    'window.getTrackingAccessExpiry = getTrackingAccessExpiry;'
].join('\n'), policySandbox);
vm.runInContext(extractFn('expiryAppliesToViewer'), policySandbox);
vm.runInContext(extractFn('isOwnerTicketExpired'), policySandbox);
vm.runInContext(extractFn('isOwnerTicketExpiredForViewer'), policySandbox);

const EXPIRED_TICKET = {
    approvalStatus: 'approved',
    approvedAt: new Date(Date.now() - 5 * HOUR),      // long past the window
    accessExpiresAt: new Date(Date.now() - 1 * HOUR)
};

function viewerAs(role) {
    policySandbox.activeUserRole = role;
    return {
        applies: policySandbox.expiryAppliesToViewer(),
        expired: policySandbox.isOwnerTicketExpiredForViewer(EXPIRED_TICKET)
    };
}

// The FACT is unchanged for every role — the ticket really did lapse.
assert.strictEqual(viewerAs('owner').expired, true,
    'the FACT must still hold: this ticket window closed an hour ago');
// The raw, unwrapped predicate stays role-independent — that is the whole
// reason the policy was split out of it rather than folded in.
policySandbox.activeUserRole = 'hr';
assert.strictEqual(policySandbox.isOwnerTicketExpired(EXPIRED_TICKET), true,
    'the raw fact is role-independent — the ticket window really is closed, whatever the viewer is');

// The POLICY is what differs.
assert.strictEqual(viewerAs('owner').applies, true, 'the AREA MANAGER keeps the viewing window');
assert.strictEqual(viewerAs('hr').applies, false, '⚠️ HR must NOT have a viewing window');
assert.strictEqual(viewerAs('superadmin').applies, false,
    '⚠️ a superadmin must NOT have one either — they have permanent access on main.html');
assert.strictEqual(viewerAs('owner').expired, true, 'an Area Manager still sees it as expired');
assert.strictEqual(viewerAs('hr').expired, false,
    '⚠️ HR must never see a lapsed ticket as expired — that is what restored their full report');
assert.strictEqual(viewerAs('superadmin').expired, false,
    'a superadmin on this page must never see the withheld shell either');
console.log('  PASS  only the Area Manager has a viewing window; HR and superadmin always get the full report');

// The Access column + filter must be hidden for a role without a window, and
// the hiding must be by CSS POSITION — the <th>/<td> counts are static and
// test/owner-mobile.test.js requires them to match.
assert(
    /#ownerTicketsTable\.owner-hides-access th:nth-child\(7\)/.test(ownerHtml) &&
    /#ownerTicketsTable\.owner-hides-access td:nth-child\(7\)/.test(ownerHtml),
    'ownerdashboard.html must hide the 7th (Access) column via CSS for a role with no window'
);
assert(
    /classList\.toggle\('owner-hides-access'/.test(ownerJs),
    'the class must be toggled from JS when the role resolves'
);
assert(
    /ownerTicketAccessFilter\.style\.display = showsWindow/.test(ownerJs),
    'the Access FILTER must be hidden too — an <option> that can never match is a control that lies'
);
assert(
    /ownerTicketStatusFilter\.style\.display = showsWindow/.test(ownerJs),
    'the Status FILTER must be hidden too — HR/superadmin rows are always "Resolved", so for them it is dead'
);
// And the explanatory sentence must not claim a 2-day window to someone without one.
assert(
    /if \(!expiryAppliesToViewer\(\)\) \{\s*ownerWindowNote\.textContent = '';/.test(ownerJs),
    'the "readable for 2 days" sentence must be withheld for a role with no window — telling HR a '
    + 'window exists when none does is simply false'
);
console.log('  PASS  the Access column, its filter and the window sentence all follow the role');
assert(
    /window\.getTrackingAccessExpiry\(ticket\)/.test(extractFn('ownerTicketExpiry')),
    'ownerTicketExpiry() must delegate to window.getTrackingAccessExpiry()'
);
assert(
    /window\.formatTrackingAccessWindow\(window\.TRACKING_ACCESS_WINDOW_MS\)/.test(extractFn('ownerAccessWindowLabel')),
    'ownerAccessWindowLabel() must read the window from firebase.js, never hardcode "2 days" — the ' +
    'window is time-compressed to 1 minute for testing and the copy must follow it'
);

// ---------------------------------------------------------------------------
// 3. Expiry semantics: approved + lapsed => expired; everything else not.
//    Dates are relative to the REAL clock, because the helper takes no "now".
// ---------------------------------------------------------------------------
const realNow = Date.now();
const lapsed = new Date(realNow - HOUR);
const live = new Date(realNow + HOUR);

assert.strictEqual(api.isOwnerTicketExpired({ approvalStatus: 'approved', accessExpiresAt: lapsed }), true,
    'an APPROVED ticket whose window has closed must be expired');
assert.strictEqual(api.isOwnerTicketExpired({ approvalStatus: 'approved', accessExpiresAt: live }), false,
    'an approved ticket still inside its window must NOT be expired');
assert.strictEqual(
    api.isOwnerTicketExpired({ status: 'Resolved', approvalStatus: 'pending_approval', accessExpiresAt: lapsed }),
    false,
    'a ticket that was never approved must never report expired — there was no window to lapse'
);
assert.strictEqual(
    api.isOwnerTicketExpired({ approvalStatus: 'approved' }),
    false,
    'an approved ticket with no derivable window (no accessExpiresAt, no approvedAt) must not be expired'
);
assert.strictEqual(api.isOwnerTicketExpired({}), false, 'an empty ticket must not be expired');
assert.strictEqual(api.isOwnerTicketExpired(null), false, 'null must not be expired');
assert.strictEqual(
    api.isOwnerTicketExpired({ approvalStatus: 'approved', approvedAt: new Date(realNow - 2 * HOUR) }),
    true,
    'a legacy approved ticket (no accessExpiresAt) must fall back to approvedAt + window and expire'
);
assert.strictEqual(api.ownerAccessWindowLabel(), '1 hour',
    'the label must describe the CONFIGURED window (the sandbox uses 1 hour)');
assert.strictEqual(api.ownerTicketExpiry({ approvalStatus: 'approved', accessExpiresAt: live }).getTime(),
    live.getTime(), 'ownerTicketExpiry() must return the stored expiry');
console.log('  PASS  expiry semantics, including the legacy approvedAt fallback and the unapproved case');

// ---------------------------------------------------------------------------
// 4. STATIC GUARDS — the gates must be wired where the browser runs them.
// ---------------------------------------------------------------------------
const listSrc = extractFn('renderOwnerTickets');
assert(
    /if \(ownerResolvedOnly\) \{\s*tickets = tickets\.filter\(\(t\) => isApprovedTicket\(t\)\);/.test(listSrc),
    'renderOwnerTickets() must filter the Area Manager list through isApprovedTicket()'
);
assert(
    /isOwnerTicketExpiredForViewer\(t\)/.test(listSrc),
    'renderOwnerTickets() must compute the expiry per row so the badge can be rendered — and it '
    + 'must go through the VIEWER-AWARE predicate, so HR and a superadmin (who have no viewing '
    + 'window) never see an Access-closed badge'
);
// ⚠️ It must NOT reach for the raw fact directly. isOwnerTicketExpired() answers
// "has this ticket's window closed?"; isOwnerTicketExpiredForViewer() answers
// "…for the person looking". Only the latter belongs in a UI decision, and
// bypassing it is exactly how the badge came back for HR after the exemption.
assert(
    !/[^A-Za-z]isOwnerTicketExpired\(/.test(listSrc),
    'the list renderer must not call the raw isOwnerTicketExpired() — use the viewer-aware variant'
);
assert(
    /expiryAppliesToViewer\(\)/.test(listSrc),
    'the "Reopen requested" chip must be gated on expiryAppliesToViewer(): it means nothing to a '
    + 'role whose tickets never expire'
);
assert(
    /status-badge expired/.test(listSrc),
    'an expired approved row must carry the Access-closed badge — the row STAYS (badged), it is not hidden'
);
// The visible WORD is now "Expired" (changed on request), and it matches the
// CLASS: `.status-badge.expired` is shared with the superadmin Approvals table
// in script.js, so the class name is pinned and reused here. Word and class now
// agree — the row STAYS (badged), it is not hidden.
assert(
    /Expired<\/span>/.test(listSrc) && /status-badge expired/.test(listSrc),
    'the expired row must say "Expired" while still using the shared .status-badge.expired class'
);

// ⚠️ THE ROW MUST NOT BE FILTERED AWAY WHEN IT EXPIRES. The requirement is that
// the ticket stays visible with its metadata — number, branch, reporter,
// incident — and only the report and footage are withheld. A ticket silently
// disappearing from the list reads as data loss and gives the manager no way to
// know it exists or to ask for it back.
//
// The default filter value must therefore be "all". This assertion exists
// because "all" is the first <option>, which is the default ONLY by position —
// reorder the options and expired tickets start vanishing, with nothing in the
// renderer to explain it.
const filterMarkup = fs.readFileSync(path.join(ROOT, 'ownerdashboard.html'), 'utf8');
const accessFilter = filterMarkup.slice(filterMarkup.indexOf('id="ownerTicketAccessFilter"'));
assert(
    /<option value="all"[^>]*>\s*All\s*<\/option>/.test(accessFilter.slice(0, accessFilter.indexOf('</select>'))),
    'the FIRST option of the Access filter must be value="all". The expired predicate returns '
    + 'false for it, so any other default silently hides every expired ticket from the list — '
    + 'the exact "ticket disappears" behaviour this row is supposed to avoid.'
);

// ⚠️ STATUS AND ACCESS MUST BE SEPARATE CELLS. They answer different questions
// ("where is this in the pipeline" vs "can this person still open it") and were
// sharing one cell under one heading, which is what made the column read as
// cluttered. Asserted structurally so it cannot silently merge back.
assert(
    /<td data-label="Status">[\s\S]*?<\/td>\s*<td data-label="Access">/.test(listSrc),
    'the owner row must render Status and Access as two SEPARATE cells, in that order — ' +
    'one heading cannot honestly name two different facts'
);
assert(
    !/data-label="Status">\$\{statusCell\}[^<]*\$\{?accessBadge/.test(listSrc),
    'the access badge must not be concatenated back into the Status cell'
);

const modalSrc = ownerJs.slice(
    ownerJs.indexOf('window.openOwnerReport = function'),
    ownerJs.indexOf('function closeOwnerReportModalFn')
);
assert(
    /const html = expired \? `/.test(modalSrc),
    'openOwnerReport() must branch on expiry when building the modal — the check belongs at RENDER ' +
    'time, not only in the list, because a ticket can lapse while the page is open'
);
assert(
    /isOwnerTicketExpiredForViewer\(rawData\)/.test(modalSrc),
    'openOwnerReport() must test the freshly-read document, not a cached list row — and through the '
    + 'VIEWER-AWARE predicate, so HR always gets the full report instead of the withheld shell'
);
// The expired branch must NOT interpolate the withheld fields. This is the
// assertion that catches a future edit that renders the evidence anyway.
const expiredStart = modalSrc.indexOf('const html = expired ? `');
const expiredEnd = modalSrc.indexOf('` : `', expiredStart);
assert(expiredStart > -1 && expiredEnd > expiredStart, 'could not isolate the expired branch');
const expiredBranch = modalSrc.slice(expiredStart, expiredEnd);
[
    ['data.description', 'the issue description'],
    ['resNotes', 'the operator findings'],
    ['requesterAttHtml', "the requester's attachments"],
    ['operatorAttHtml', "the operator's footage"],
    ['buildAttachmentRow', 'any attachment link']
].forEach(([token, what]) => {
    assert(
        expiredBranch.indexOf(token) === -1,
        `the EXPIRED branch must not render ${what} ("${token}") — that is the payload the ` +
        'viewing window exists to protect'
    );
});
assert(
    /data\.ticketNumber/.test(expiredBranch) && /data\.branchName/.test(expiredBranch),
    'the expired branch must still render the metadata (ticket number, branch) so the manager can ' +
    'see the ticket exists and chase it'
);
assert(/owner-access-expired/.test(expiredBranch),
    'the expired branch must show the expiry notice');
assert(/escapeHTML\(windowLabel\)/.test(modalSrc),
    'the expiry notice must use ownerAccessWindowLabel(), not a literal "2 days"');
console.log('  PASS  both gates are wired: the list filters, the modal withholds');

// ---------------------------------------------------------------------------
// 5. The orphaned Reports tab is gone. Its filter used to be the only place
//    `approvalStatus === 'approved'` appeared, rendering into elements the page
//    no longer has — dead code that hid this rule.
// ---------------------------------------------------------------------------
assert(/loadOwnerReports/.test(stripComments(ownerJs)) === false,
    'loadOwnerReports() is dead: the Reports tab was removed from ownerdashboard.html, so it ' +
    'returned early on a null element. Its approval filter now lives in renderOwnerTickets()');
assert(/ownerReportsBody/.test(ownerJs) === false,
    'the #ownerReportsBody element reference is dead with the tab');
assert(/id="tabReports"/.test(ownerHtml) === false,
    'ownerdashboard.html must not reintroduce a Reports tab — the Tickets tab is the approved list');
assert(/id="ownerWindowNote"/.test(ownerHtml),
    'ownerdashboard.html must carry the #ownerWindowNote element the window sentence is written into');
// Isolate the Tickets section's own heading paragraph, so the assertion below
// cannot be satisfied by the same words appearing anywhere else on the page.
const ticketsIntro = (() => {
    const at = ownerHtml.indexOf('id="tabTickets"');
    assert(at > -1, 'could not find the #tabTickets section');
    const h2 = ownerHtml.indexOf('<h2>Tickets</h2>', at);
    const p = ownerHtml.indexOf('<p>', h2);
    const end = ownerHtml.indexOf('</p>', p);
    return h2 > -1 && p > -1 && end > p ? ownerHtml.slice(p, end) : '';
})();
assert(/<p>Approved tickets/.test(ticketsIntro),
    'the Tickets tab must state that only superadmin-APPROVED tickets appear. Its heading copy was ' +
    'shortened (the old sentence pushed the h2 to three lines and crowded the toolbar), so this ' +
    'asserts the meaning, not the old wording. Found: ' + ticketsIntro);
assert(
    /applyViewerExpiryChrome\(\);/.test(ownerJs.slice(
        ownerJs.indexOf('function setActiveUser('),
        ownerJs.indexOf('function switchOwnerTab(')
    )),
    'applyViewerExpiryChrome() must be called from setActiveUser() so the window sentence AND the '
    + 'Access column / access filter are settled the moment the role resolves'
);
// applyViewerExpiryChrome() is what calls renderOwnerWindowNote(), so the note
// still runs on load — through the wrapper that also hides the Access chrome for
// any role without a viewing window (HR, superadmin).
assert(
    /applyViewerExpiryChrome[\s\S]{0,900}?renderOwnerWindowNote\(\)/.test(ownerJs),
    'applyViewerExpiryChrome() must still call renderOwnerWindowNote() so the Area Manager keeps '
    + 'the explanatory sentence'
);
console.log('  PASS  the dead Reports code is gone and the rule is documented in the UI');

// ---------------------------------------------------------------------------
// 6. The new styles must use THEME TOKENS. This page's inline <style> is the
//    one place in the app that shipped hardcoded light values, and
//    test/owner-dark-mode.test.js fails the build on exactly that.
// ---------------------------------------------------------------------------
const newStyles = ownerHtml.slice(
    ownerHtml.indexOf('EXPIRED APPROVED TICKET'),
    ownerHtml.indexOf('.owner-window-note')
);
assert(newStyles.length > 0, 'could not find the new expiry styles');
assert(/#[0-9a-f]{3,8}\b/i.test(newStyles) === false,
    'the new expiry styles must not hardcode a hex colour — use theme tokens so dark mode works');
assert(!/rgba\(\s*255\s*,\s*255\s*,\s*255/.test(newStyles),
    'the new expiry styles must not use a hardcoded white surface (the original dark-mode bug)');
['--color-danger', '--text-secondary', '--text-muted', '--bg-tertiary', '--border-color']
    .forEach((token) => {
        assert(newStyles.indexOf(token) > -1,
            `the new expiry styles should use ${token} so they follow the active theme`);
    });
const styleCss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
assert(/\.status-badge\.expired\s*\{/.test(styleCss),
    '.status-badge.expired must exist in style.css (the Tickets list reuses the Approvals badge)');
console.log('  PASS  the new styles are token-based, not hardcoded light values');

// ---------------------------------------------------------------------------
// 8. THE TICKETS HEADER — LAYOUT, and the expired / not-expired split.
//
//    (a) POSITIONS. `.section-header` is a flex ROW (style.css), so the heading
//        and the whole control toolbar shared one line. The toolbar needs
//        ~1,250px and the content column only ~1,020-1,180px, so `flex-wrap`
//        broke the controls into an unpredictable 3-then-1 / 2-then-2 block with
//        the heading still vertically centred beside it.
//    (b) SEPARATION. The old #ownerTicketStatusFilter listed seven statuses but
//        was force-locked to "Resolved" and disabled for EVERY role that can
//        reach this page — ~170px of permanently dead control.
// ---------------------------------------------------------------------------
console.log('\n=== The tickets header: stacked layout + the access split ===');

const listFn = extractFn('renderOwnerTickets');
const ticketsBlock = ownerHtml.slice(
    ownerHtml.indexOf('id="tabTickets"'),
    ownerHtml.indexOf('id="tabViolations"')
);

// --- (a) LAYOUT ----------------------------------------------------------------
assert(
    /owner-section-header--stacked/.test(ticketsBlock),
    'the Tickets section header must carry .owner-section-header--stacked — the base .section-header ' +
    'is a flex ROW, and without the modifier the heading and the toolbar still fight for one line'
);
assert(
    /\.owner-section-header--stacked\s*\{[\s\S]{0,200}?flex-direction:\s*column/.test(ownerHtml),
    'the stacked modifier must set flex-direction: column — that IS the fix; a comment alone does nothing'
);
assert(
    /\.owner-section-header--stacked \.owner-toolbar\s*\{\s*width:\s*100%/.test(ownerHtml),
    'the stacked modifier must give the toolbar the full content width, so a wrap is deliberate ' +
    'rather than an accident of available space'
);
// ...and it must be a MODIFIER, not a rewrite of the shared base: Overview keeps
// its side-by-side layout because it only ever carries one filter.
assert(
    /\.owner-section-header--stacked\s*\{/.test(ownerHtml) &&
    /\.owner-section-header\s*\{\s*margin-bottom/.test(ownerHtml),
    'the stacking must be a MODIFIER on the Tickets section, not a rewrite of .owner-section-header — ' +
    'the Overview tab has a single filter and was never crowded'
);

// --- (b) SEPARATION -------------------------------------------------------------
// ⚠️ THE ID IS BACK — deliberately. The removed #ownerTicketStatusFilter was a
// DEAD control (seven statuses, force-locked to "Resolved", disabled for every
// role). The new one with the same id is a LIVE, MANAGER-ONLY filter over the
// four badge labels, hidden for HR/superadmin. Reusing the id keeps the
// codebase's filter naming (`ownerTicket<Thing>Filter`) — and these two
// assertions pin the difference, so the dead version can never creep back.
assert(
    /id="ownerTicketStatusFilter"[^>]*aria-label="Filter by ticket status"/.test(ownerHtml),
    'the STATUS filter must exist — and it must be the new live one (badge-labelled, aria-labelled), ' +
    'not the dead force-locked dropdown'
);
assert(
    !/ownerTicketStatusFilter[^;]*\.disabled\s*=\s*true/.test(ownerJs.replace(/\/\/.*$/gm, '')),
    'the new #ownerTicketStatusFilter must never be force-locked/disabled the way the dead one was'
);

const accessSelect = (ticketsBlock.match(/<select[^>]*id="ownerTicketAccessFilter"[\s\S]*?<\/select>/) || [])[0];
assert(accessSelect, 'ownerdashboard.html must contain the #ownerTicketAccessFilter select');
// The status filter's four buckets: the exact badge words, plain labels.
const statusSelect = (ticketsBlock.match(/<select[^>]*id="ownerTicketStatusFilter"[\s\S]*?<\/select>/) || [])[0];
assert(statusSelect, 'ownerdashboard.html must contain the #ownerTicketStatusFilter select');
['all', 'Pending', 'In Progress', 'Pending Approval', 'Resolved'].forEach((value) => {
    assert(new RegExp('<option value="' + value + '"').test(statusSelect),
        `the status filter must offer the "${value}" bucket — it matches the row badges 1:1`);
});
assert(
    statusSelect.indexOf('<option value="all"') < statusSelect.indexOf('<option value="Pending"'),
    '"All Statuses" must be the first option, so the default view hides nothing on load'
);
assert(
    !/\(\d+\)/.test(statusSelect),
    'the status filter must use PLAIN labels — no counts, like the access filter'
);

// It must match the BADGE label, not the raw field — via a helper that reuses
// the row's own label expression (pending ? ticketDisplayStatus : raw).
assert(
    /const statusLabelMatches = \(t, status\) => \{/.test(listFn),
    'renderOwnerTickets() must match the status filter against the badge label via statusLabelMatches()'
);
assert(
    /pendingApproval \? ticketDisplayStatus\(t\) : String\(status \|\| 'Pending'\)\.trim\(\)/.test(listFn),
    'statusLabelMatches() must reuse the row\'s own label expression, or filter and badge disagree'
);
assert(
    /tickets = tickets\.filter\(\(t\) => statusLabelMatches\(t, t\.status\)\);/.test(listFn),
    'the status filter must run on the approved list (after the pinned Resolved-only scope, which is untouched)'
);
assert(
    /if \(!statusLabelMatches\(t, t\.status\)\) return false;/.test(listFn),
    'the status filter must also run inside the pending append, or it would silently ignore pending rows'
);

assert(accessSelect, 'ownerdashboard.html must contain the #ownerTicketAccessFilter select');
// Exactly the three buckets that were asked for.
['all', 'active', 'expired'].forEach((value) => {
    assert(new RegExp('<option value="' + value + '"').test(accessSelect),
        `the access filter must offer the "${value}" bucket`);
});
assert(
    (accessSelect.match(/<option/g) || []).length === 3,
    'the access filter must offer exactly three buckets (All / Not expired / Expired) — Found: ' +
    accessSelect.replace(/\s+/g, ' ').slice(0, 160)
);
assert(
    accessSelect.indexOf('<option value="all"') < accessSelect.indexOf('<option value="active"'),
    '"All" must be the first option, so the default view hides nothing on load'
);
assert(
    !/\(\d+\)/.test(accessSelect),
    'the access filter must use PLAIN labels — the per-bucket counts were explicitly declined'
);

// Each bucket filters on the RIGHT thing, via the SAME helper the row badges
// use, so the filter and the badge can never disagree about what is expired.
[
    ["if (selectedAccess === 'active') return !isOwnerTicketExpiredForViewer(t);",
        'the "Not expired" bucket must exclude expired rows (via the viewer-aware predicate, so it is '
        + 'meaningless for a role with no viewing window)'],
    ["if (selectedAccess === 'expired') return isOwnerTicketExpiredForViewer(t);",
        'the "Expired" bucket must include ONLY expired rows — likewise viewer-aware']
].forEach(([token, why]) => {
    assert(listFn.indexOf(token) > -1, `renderOwnerTickets() must implement ${why} — missing: ${token}`);
});
// ...and an unknown value must fall through to "show everything" rather than
// silently emptying the list.
assert(
    /if \(selectedAccess === 'expired'\) return isOwnerTicketExpiredForViewer\(t\);\s*return true;/.test(listFn),
    'an unrecognised access value must fall through to showing everything — an <option> added to the ' +
    'markup before the JS is updated must not blank the list'
);

// The Resolved-only scope must SURVIVE the rework: js/chat.js's @ticket picker
// mirrors it, and test/chat-ticket-mentions.test.js asserts that exact line.
assert(
    /if \(ownerResolvedOnly\) selectedStatus = 'Resolved';/.test(listFn),
    'the Resolved-only scope must still be explicit — js/chat.js\'s @ticket picker mirrors it'
);

// Wired: resolved once, and re-rendering on change.
assert(
    /const ownerTicketAccessFilter = \$owner\('ownerTicketAccessFilter'\);/.test(ownerJs),
    'the access filter element must be resolved once at the top, with the other list controls'
);
assert(
    /const ownerTicketStatusFilter = \$owner\('ownerTicketStatusFilter'\);/.test(ownerJs),
    'the status filter element must be resolved once at the top, with the other list controls'
);
assert(
    /ownerTicketAccessFilter\?\.addEventListener\('change', \(\) => renderOwnerTickets\(ownerAllTicketsCache\)\)/.test(ownerJs),
    'the access filter must re-render the list on change — nothing repaints without this'
);
assert(
    /ownerTicketStatusFilter\?\.addEventListener\('change', \(\) => renderOwnerTickets\(ownerAllTicketsCache\)\)/.test(ownerJs),
    'the status filter must re-render the list on change — nothing repaints without this'
);
console.log('  PASS  stacked header; dead dropdown gone; three plain-label buckets; same expiry predicate as the badges');

// ---------------------------------------------------------------------------
// 7. THE RE-ACCESS REQUEST ("Request to open this ticket again").
//
//    The whole superadmin half ALREADY EXISTS (the amber "Reopen requested"
//    chip, the desktop notification, the Approve Request & Resend button, the
//    "Access Approved" email). So these assertions are about the CONTRACT with
//    it: the Area Manager must write the same two fields with the same shapes,
//    or the request lands and the superadmin never sees it.
// ---------------------------------------------------------------------------
const reopenHelpers = ['ownerReopenState', 'ownerReopenPending', 'ownerReopenNotes']
    .map(extractFn).join('\n');

// Load the three pure readers into the same sandbox as the gate helpers.
vm.runInContext(reopenHelpers + '\nglobalThis.__reopen = {' +
    ' ownerReopenState: ownerReopenState, ownerReopenPending: ownerReopenPending,' +
    ' ownerReopenNotes: ownerReopenNotes };', sandbox);
const R = sandbox.__reopen;
assert(R, 'the re-access readers were not loaded into the sandbox');

assert.strictEqual(R.ownerReopenState({ accessReopenRequest: { status: 'pending' } }).status, 'pending',
    'ownerReopenState() must return the stored state');
assert.strictEqual(R.ownerReopenState({}), null, 'a ticket with no request must report null');
assert.strictEqual(R.ownerReopenState(null), null, 'null must report null');
assert.strictEqual(R.ownerReopenPending({ accessReopenRequest: { status: 'pending' } }), true,
    'a pending request must be pending');
assert.strictEqual(R.ownerReopenPending({ accessReopenRequest: { status: 'fulfilled' } }), false,
    'a fulfilled request is no longer pending');
assert.strictEqual(R.ownerReopenPending({ accessReopenRequest: {} }), true,
    'a request with no status defaults to pending (same default the public page uses)');
assert.strictEqual(R.ownerReopenPending({}), false, 'no request at all is not pending');
// NB: the arrays come from inside the vm sandbox, so their prototype is the
// sandbox's Array — deepStrictEqual fails on the prototype even when the
// contents match. Compare joined values, as the other suites in this repo do.
const notesOf = (ticket) => R.ownerReopenNotes(ticket).map((c) => c.text).join('|');
assert.strictEqual(
    notesOf({ comments: [
        { type: 'footage_request', text: 'need the clip' },
        { type: 'access_reopen_request', text: 'audit' },
        { type: 'access_reopen_request', text: 'insurance' }
    ] }),
    'audit|insurance',
    'only access_reopen_request notes count — a footage request must not appear in the history'
);
assert.strictEqual(notesOf({}), '', 'a ticket with no comments has no history');
assert.strictEqual(notesOf({ comments: 'not-an-array' }), '',
    'a non-array comments field must not throw');
console.log('  PASS  the re-access state readers, including a non-array comments field');

// The WRITE contract. Both fields, with the exact `type` value the
// superadmin half filters on.
const requestSrc = extractFn('requestOwnerAccess');
[
    ["type: 'access_reopen_request'", "the note's `type` must be exactly 'access_reopen_request' — " +
        'countAccessReopenRequests() in js/notifications.js filters on that string, and a typo ' +
        'means the superadmin is never notified'],
    ['comments: firebase.firestore.FieldValue.arrayUnion(note)',
        'the request must APPEND a comments note via arrayUnion, so repeat asks accumulate'],
    ['accessReopenRequest: reopenState',
        'the request must set the top-level accessReopenRequest the Approvals chip reads'],
    ['requestCount: prevCount + 1',
        'requestCount must increment from the previous value, or the ×N chip is always ×1'],
    ["status: 'pending'",
        "a new request must be written with status 'pending' — the superadmin half switches on it"],
    ['requestedByEmail: requestedByEmail',
        'requestedByEmail must be the ACCOUNT email: resolveReopenRecipient() emails the ' +
        'requester first, and a manager is usually not the original reporter'],
    ['isOwnerTicketExpiredForViewer(data)',
        'the request must RE-CHECK expiry on the freshly-read document — a ticket resent a ' +
        'second ago must not accept a stale request, and the check is viewer-aware so a role ' +
        'without a viewing window never raises one'],
].forEach(([token, why]) => {
    assert(requestSrc.indexOf(token) > -1, `requestOwnerAccess() must include ${token} — ${why}`);
});
// The >=5 character rule, matching the public Track page exactly.
assert(/length < 5/.test(requestSrc),
    'the reason must be at least 5 characters — same rule as submit-ticket.html, so the two ' +
    'forms cannot disagree about what counts as a real request');
console.log('  PASS  the write contract matches the existing superadmin workflow');

// The three UI states, so a manager is never asked to re-request a pending one.
// These are declared immediately BEFORE `const html = expired ? ...`, so the
// slice runs from the first of them up to the template.
const expiredUi = modalSrc.slice(
    modalSrc.indexOf('const reopen = ownerReopenState(rawData)'),
    modalSrc.indexOf('const html = expired')
);
assert(expiredUi.length > 0, 'could not isolate the re-access UI block in openOwnerReport()');
[
    ['const reopenPending = ownerReopenPending(rawData)',
        'the modal must read the pending state off the document'],
    ['reopenFormHtml = reopenPending',
        'the form must be REPLACED by the pending message, not merely disabled — a greyed ' +
        'button invites a manager to click it twice and the chip then reads ×2 for one ask'],
    ['id="ownerReopenForm"', 'the form must be rendered when there is no pending request'],
    ['id="ownerReopenReason"', 'the reason textarea must exist'],
    ['id="ownerReopenSubmit"', 'the submit button must exist'],
    ['ownerReopenNotes(rawData)', 'the request history must be rendered from the notes'],
    ['fulfilled', 'the history must distinguish Fulfilled from Awaiting approval']
].forEach(([token, why]) => {
    assert(expiredUi.indexOf(token) > -1, `the expired modal must include ${token} — ${why}`);
});
// The form only ever appears inside the EXPIRED branch. Slice ONLY the
// non-expired TEMPLATE (up to the innerHTML assignment) — the delegated submit
// handler that follows legitimately mentions #ownerReopenForm, so scanning the
// rest of openOwnerReport() would report a false leak.
const nonExpiredTemplate = modalSrc.slice(
    modalSrc.indexOf('` : `'),
    // ⚠️ ANCHOR ON THE LEFT-HAND SIDE ONLY. This used to search for the whole
    // statement `ownerReportModalBody.innerHTML = html;`, so adding the countdown
    // banner (now `= modalBanner + html`) made indexOf return -1 — and
    // `slice(start, -1)` then ran to the END of the function, swallowing the
    // delegated submit handler that legitimately names #ownerReopenForm. The
    // failure was real but the CAUSE was not: nothing had leaked into the open
    // template. Matching the assignment target keeps the slice correct no matter
    // what is prepended to `html`.
    modalSrc.indexOf('ownerReportModalBody.innerHTML =')
);
assert(nonExpiredTemplate.length > 0, 'could not isolate the non-expired template');
assert(nonExpiredTemplate.indexOf('ownerReopenForm') === -1,
    'the re-access form must NEVER render for a ticket whose access is still open');
assert(nonExpiredTemplate.indexOf('owner-access-expired') === -1,
    'the expiry notice must never render while access is still open');

// The list row swaps to the SAME amber chip the Approvals table uses, so both
// surfaces describe the same ticket identically.
assert(/access-reopen-badge/.test(listSrc),
    'a pending request must swap the red Expired badge for the shared .access-reopen-badge — ' +
    'the manager and the superadmin then read the same row');
assert(/reopenCount > 1/.test(listSrc),
    'the chip must carry the ×N count, exactly as script.js renders it in Approvals');
console.log('  PASS  the three request states, and the shared amber chip in the list');

// The submit must be DELEGATED and bound once — the modal body is re-rendered
// on every open, so a per-render listener would stack up and fire N times.
assert(/ownerReportModalBody\?\.addEventListener\('submit', handleOwnerReopenSubmit\)/.test(ownerJs),
    'the re-access submit must be DELEGATED from the modal body and bound once — the body is ' +
    're-rendered on every open, so binding inside the render fires one request per open');
assert(/event\.target/.test(extractFn('handleOwnerReopenSubmit')) &&
    /ownerReopenForm/.test(extractFn('handleOwnerReopenSubmit')),
    'the delegated handler must ignore submits from anything but #ownerReopenForm');
assert(/ownerReopenTicketId = reportId/.test(ownerJs) && /ownerReopenTicketId = ''/.test(ownerJs),
    'the open ticket id must be SET on open and CLEARED on close, so a stale id can never be ' +
    'written to after a different ticket is opened');

// The user's name is captured for requestedBy, with the email as a fallback.
assert(/ownerActiveUserName = String\(\(userData && userData\.name\)/.test(ownerJs),
    "the manager's name must be read from their users doc — the superadmin sees it in the " +
    'Approvals tooltip and the confirm dialog');
assert(/return String\(auth\.currentUser\.email\)/.test(extractFn('activeUserDisplayName')),
    'activeUserDisplayName() must fall back to the account email, never to a blank string');
console.log('  PASS  the submit is delegated once, and the requester is identified');

// ============================================================================
// 6b. "REQUEST ADDITIONAL FOOTAGE" IS BACK ON THIS DASHBOARD
// ============================================================================
// The form was removed once ("every ticket here is already approved, so there
// is nothing left to find insufficient") and has now been RESTORED for the
// Area Manager / RM/SM: watching the APPROVED resolution footage and judging
// it insufficient is exactly the moment the form exists for. The write is the
// SAME hand-off the public Track page performs (submit-ticket.html
// submitFootageRequest), so the ticket re-enters the pipeline with the
// operator notified (js/notifications.js already counts footage_request
// notes), the existing clips preserved (mergeOperatorFootage) and the viewing
// window re-armed on re-approval (approveResolution + hasFootageRequestComment).
//
// These assertions lock the restoration in the same way section 6 locks the
// re-access flow: readers, write contract, UI states, delegation, and the
// open/close id contract. The Track page keeps its own untouched flow.
const footageHelpers = ['ownerFootageNotes', 'ownerFootagePending']
    .map(extractFn).join('\n');

// Load the two pure readers into the same sandbox as the gate helpers.
vm.runInContext(footageHelpers + '\nglobalThis.__footage = {' +
    ' ownerFootageNotes: ownerFootageNotes, ownerFootagePending: ownerFootagePending };', sandbox);
const F = sandbox.__footage;
assert(F, 'the footage readers were not loaded into the sandbox');

// Only footage_request notes count — an access_reopen_request must never leak
// into the footage history (the reopen reader filters the same list the other
// way, and section 6 asserts that from its side).
const footageNotesOf = (ticket) => F.ownerFootageNotes(ticket).map((c) => c.text).join('|');
assert.strictEqual(
    footageNotesOf({ comments: [
        { type: 'footage_request', text: 'need the exit cam' },
        { type: 'access_reopen_request', text: 'audit' }
    ] }),
    'need the exit cam',
    'only footage_request notes count — the two note types must never cross lists'
);
assert.strictEqual(footageNotesOf({}), '', 'a ticket with no comments has no footage history');
assert.strictEqual(footageNotesOf({ comments: 'not-an-array' }), '',
    'a non-array comments field must not throw');

// Pending means the write landed and the operator has not re-worked yet: the
// status stays "Insufficient Footage" until the next resolve.
assert.strictEqual(F.ownerFootagePending({ comments: [{ type: 'footage_request' }], status: 'Insufficient Footage' }), true,
    'a filed request is pending while the status is still Insufficient Footage');
assert.strictEqual(F.ownerFootagePending({ comments: [{ type: 'footage_request' }], status: 'Resolved' }), false,
    'once the operator re-resolves the request is no longer pending');
assert.strictEqual(F.ownerFootagePending({ status: 'Insufficient Footage' }), false,
    'the status alone is not a request — a footage_request note must exist');
assert.strictEqual(F.ownerFootagePending({}), false, 'no notes is not pending');
console.log('  PASS  the footage state readers, including a non-array comments field');

// The WRITE contract — the same fields submitFootageRequest() writes on the
// Track page, because every downstream consumer is keyed on them.
const footageSrc = extractFn('requestOwnerFootage');
[
    ["type: 'footage_request'", "the note's `type` must be exactly 'footage_request' — " +
        'countFootageRequests() in js/notifications.js filters on that string, and a typo ' +
        'means the operator is never notified'],
    ["status: 'Insufficient Footage'", 'the ticket must go back to Insufficient Footage so the ' +
        'operator ticket list surfaces it for re-work'],
    ["approvalStatus: 'pending'", 'the ticket must leave this approved-only list and re-enter the ' +
        'pipeline — the documented cycle in test/footage-accumulation.test.js'],
    ['comments: firebase.firestore.FieldValue.arrayUnion(note)',
        'the request must APPEND a comments note via arrayUnion, so repeat asks accumulate'],
    ['isApprovedTicket(data)',
        'the request must RE-CHECK approval on the freshly-read document — a ticket that was ' +
        'un-approved a second ago must not accept a stale request'],
    ['length < 5',
        'the details must be at least 5 characters — same rule as the Track page and the ' +
        're-access form, so the three forms cannot disagree'],
].forEach(([token, why]) => {
    assert(footageSrc.indexOf(token) > -1, `requestOwnerFootage() must include ${token} — ${why}`);
});
assert(/ownerFootagePending\(data\)/.test(footageSrc),
    'a ticket already in a footage-request cycle must be refused, not double-requested');
console.log('  PASS  the write contract matches the Track page hand-off');

// The UI. The card renders ONLY in the non-expired branch (the re-access form
// is the right tool for a ticket whose footage is withheld), and only for the
// Area Manager / RM/SM.
[
    ['id="ownerFootageForm"', 'the form must be rendered when nothing is pending'],
    ['id="ownerFootageDetails"', 'the details textarea must exist'],
    ['id="ownerFootageSubmit"', 'the submit button must exist'],
    ['ownerFootageNotes(rawData)', 'the history must be rendered from the notes'],
].forEach(([token, why]) => {
    assert(modalSrc.indexOf(token) > -1, `the report modal must include ${token} — ${why}`);
});
assert(/const footageHtml = isAreaManager\(\) && !expired/.test(modalSrc),
    'the footage card must be ROLE-GATED to isAreaManager() (owner + rmsm) and only render ' +
    'while access is open — HR and superadmins have their own review flow');
assert(nonExpiredTemplate.indexOf('${footageHtml}') > -1,
    'the footage card must be injected into the NON-expired template');
assert(nonExpiredTemplate.indexOf('ownerFootageForm') === -1,
    'the footage form must never render for a ticket whose access is closed — the ' +
    're-access form above is the right tool there');
console.log('  PASS  the footage UI states, role gate and expiry gate');

// The submit must be DELEGATED and bound once, exactly like the re-access one.
assert(/ownerReportModalBody\?\.addEventListener\('submit', handleOwnerFootageSubmit\)/.test(ownerJs),
    'the footage submit must be DELEGATED from the modal body and bound once — the body is ' +
    're-rendered on every open, so binding inside the render fires one request per open');
assert(/event\.target/.test(extractFn('handleOwnerFootageSubmit')) &&
    /ownerFootageForm/.test(extractFn('handleOwnerFootageSubmit')),
    'the delegated handler must ignore submits from anything but #ownerFootageForm');
assert(/ownerFootageTicketId = reportId/.test(ownerJs) && /ownerFootageTicketId = ''/.test(ownerJs),
    'the open ticket id must be SET on open and CLEARED on close, so a stale id can never be ' +
    'written to after a different ticket is opened');
console.log('  PASS  the submit is delegated once, and the ticket id is set/cleared with the modal');

// ============================================================================
// 7. THE ?ticket= DEEP LINK FROM THE APPROVAL EMAIL
// ============================================================================
// THE BUG THIS LOCKS DOWN: the approval email now links
// `ownerdashboard.html?ticket=BNW-TIX007`. openOwnerReport() reads a ticket
// STRAIGHT FROM FIRESTORE by id and renders it — while the visible list is
// filtered to approved tickets in the manager's assigned branches. So calling
// it on an id taken from the URL would hand any signed-in user a way to read
// ANY ticket document by editing the URL: another branch's tickets, and
// unapproved work. The deep link must resolve through the SAME filtered list.
//
// These run the real function in a sandbox so the gate is verified
// behaviourally, not by grepping for a string that could be commented out.
const deepSandbox = {
    console: { log() {}, warn() {}, error() {}, info() {} },
    URLSearchParams,
    window: { location: { search: '?ticket=BNW-TIX007' } }
};
deepSandbox.window.location = deepSandbox.window.location;
deepSandbox.self = deepSandbox;
vm.createContext(deepSandbox);

// Minimal stand-ins for the surrounding page state, plus the two REAL
// predicates the gate must reuse.
vm.runInContext(`
  var activeUserRole = 'owner';
  var activeUserIsSuperAdmin = false;
  var ownerAllBranches = ['Banawe', 'Mabini'];
  var ownerAssignedBranches = ['Banawe'];
  var opened = [];
  var toasts = [];
  var tabs = [];

  function isApprovedTicket(t) {
    return !!(t && String(t.approvalStatus || '').trim().toLowerCase() === 'approved');
  }
  function normalizeTicketReport(doc) { return Object.assign({ id: doc.id }, doc); }
  function switchOwnerTab(t) { tabs.push(t); }
  function ownerToast(m) { toasts.push(m); }

  // ⚠️ applyOwnerDeepLink() calls \`window.openOwnerReport()\`, so the spy MUST
  // be on \`window\`. But the probe functions below are read off the SANDBOX
  // (the real global object), so they are published there. Assigning the probe
  // to \`window\` would attach it to the inner stub, where the test cannot see it.
  window.openOwnerReport = function (id) { opened.push(id); };
  __reset = function () { opened = []; toasts = []; tabs = []; };
  __probe = function () { return { opened: opened, toasts: toasts, tabs: tabs }; };
`, deepSandbox);

vm.runInContext(extractFn('readOwnerDeepLink'), deepSandbox);
vm.runInContext(extractFn('applyOwnerDeepLink'), deepSandbox);

// ⚠️ Use the SANDBOX, not sandbox.window. Inside the context `window` was
// reassigned to its own stub, so `deepSandbox.window` is a detached object
// with no `__reset`, no `opened` and no `applyOwnerDeepLink`. The sandbox IS
// the global object the vm script actually wrote to.
const deep = deepSandbox;

// 7a. A hostile ?ticket= must be dropped before it can reach Firestore as a
//     document id. `openOwnerReport()` interpolates it into a .doc() call.
[
    'https://evil.example.com',
    '../../tickets/other',
    'BNW-TIX007#frag',
    'a'.repeat(65)
].forEach(function (hostile) {
    const s = { console: { log() {}, warn() {}, error() {}, info() {} }, URLSearchParams,
        window: { location: { search: '?ticket=' + encodeURIComponent(hostile) } } };
    s.window.location = s.window.location;
    s.self = s;
    vm.createContext(s);
    // The module-scope state the function reads/writes. `var` (not `let`) on
    // purpose: a top-level `let` in a vm script is a lexical binding that never
    // lands on the context's global object, so the assertion below would read
    // `undefined` no matter what the function did.
    vm.runInContext("var ownerDeepLinkTicket = ''; var ownerDeepLinkDone = false;", s);
    vm.runInContext(extractFn('readOwnerDeepLink'), s);
    assert.strictEqual(s.ownerDeepLinkTicket, '',
        'a hostile ?ticket= must be dropped, not forwarded to Firestore: ' + hostile);
});
console.log('  PASS  a hostile ?ticket= cannot reach openOwnerReport()');

// 7b. The gate itself.
// ⚠️ CORRECTED 2026-02: this used to require the ticket to be in the manager's
// branch-scoped LIST and called that a security control. It was not one —
// firestore.rules already reads
//     allow read: if isSignedIn() || resource.data.approvalStatus == 'approved'
// so any signed-in user can already read any APPROVED ticket. Requiring it to
// also pass a UI branch filter blocked nothing; it only stopped the legitimate
// recipient of an approval email from opening their own ticket whenever their
// branch list was empty (the approveUser branches:[] bug) or a name differed by
// case. The gate is now exactly what the rules enforce.
const ROWS = [
    { id: 'BNW-TIX007', branch: 'Banawe', approvalStatus: 'approved' },   // mine, approved
    { id: 'MAB-TIX002', branch: 'Mabini', approvalStatus: 'approved' },   // other branch, approved
    { id: 'BNW-TIX009', branch: 'Banawe', approvalStatus: 'pending_approval' } // not approved
];

// ⚠️ Arrays built INSIDE the vm context have that context's Array prototype, so
// assert.deepStrictEqual() fails on them even when the contents match. Copying
// them into a host array first is what makes the comparison meaningful.
function hostArray(value) {
    return Array.from(value || []);
}

function tryOpen(ticketId, rows) {
    deep.__reset();
    deep.ownerDeepLinkTicket = ticketId;
    deep.applyOwnerDeepLink(rows);
    const seen = deep.__probe();
    return {
        opened: hostArray(seen.opened),
        toasts: hostArray(seen.toasts),
        tabs: hostArray(seen.tabs)
    };
}

// 7b assertions.
// ⚠️ ownerBranchKey is an ARROW const, not a `function` declaration, so the
// extractFn() helper cannot reach it — it is loaded from source directly.
const branchKeySrc = ownerJs.slice(
    ownerJs.indexOf('const ownerBranchKey ='),
    ownerJs.indexOf('\n', ownerJs.indexOf('const ownerBranchKey ='))
);
vm.runInContext(branchKeySrc, deepSandbox);

let r = tryOpen('BNW-TIX007', ROWS);
assert.deepStrictEqual(r.opened, ['BNW-TIX007'],
    'an approved ticket must open — this is the whole point of the email link');
assert.deepStrictEqual(r.tabs, ['tickets'],
    'the manager must land on the Tickets tab, not a popup over Overview');
assert.deepStrictEqual(r.toasts, [], 'a successful deep link must not warn');

r = tryOpen('MAB-TIX002', ROWS);
assert.deepStrictEqual(r.opened, ['MAB-TIX002'],
    'an APPROVED ticket opens even from another branch: firestore.rules already permits any '
    + 'signed-in user to read it, so a branch veto here blocked the email link without '
    + 'protecting anything');
assert.deepStrictEqual(r.toasts, [],
    'opening out-of-scope is informational (console.warn), never a user-facing error');

r = tryOpen('BNW-TIX009', ROWS);
assert.deepStrictEqual(r.opened, [],
    'an UNAPPROVED ticket must NOT open — the approval gate is the one the rules do enforce, '
    + 'and a link must never be what reveals unapproved work');
assert.strictEqual(r.toasts.length, 1, 'a refused deep link must say so, not fail silently');
assert(/not been approved yet/i.test(r.toasts[0]),
    'the refusal must name the REAL reason ("not approved yet"), not a generic message: the '
    + 'old single toast covered three different causes and cost hours of debugging. Got: '
    + r.toasts[0]);

r = tryOpen('BNW-TIX999', ROWS);
assert.deepStrictEqual(r.opened, [], 'a ticket id that does not exist must not open');
assert(/could not be found/i.test(r.toasts[0]),
    'a missing ticket must say so distinctly from an unapproved one. Got: ' + r.toasts[0]);
console.log('  PASS  the deep link gates on APPROVAL (as firestore.rules does) and names the real reason');

// 7c. ONE-SHOT. The ticket listener fires on every snapshot, so a link left
//     pending would re-open the report modal over and over, trapping the
//     manager in a ticket they already closed.
// 7e. BRANCH NAMES MUST COMPARE NORMALLY, NOT BY RAW STRING.
// THE BUG: `activeUserPermissions.branches.includes(branchName)` is an exact,
// case- and whitespace-sensitive match. A user document holding 'banawe' against
// a branch named 'Banawe' silently produced an EMPTY assigned list — the
// dashboard said "No branch access assigned yet" and every ticket link was
// refused, with nothing in any log. Branch names are typed by hand in several
// places, so this had to stop being load-bearing.
const branchSandbox = { console: { log() {}, warn() {}, error() {}, info() {} } };
branchSandbox.window = branchSandbox;
vm.createContext(branchSandbox);
vm.runInContext(branchKeySrc.replace('const ', 'var '), branchSandbox);
vm.runInContext('var activeUserIsSuperAdmin = false; var ownerAllBranches = [];', branchSandbox);
vm.runInContext(extractFn('applyAssignedBranches'), branchSandbox);
// Stub the six renderers applyAssignedBranches() calls after assigning.
vm.runInContext([
    'var ownerAssignedBranches = [];',
    'var activeUserPermissions = { branches: [], permissions: {} };',
    'function populateBranchDropdowns() {} function renderBranchAccessList() {}',
    'function renderPermissionSummary() {} function renderKpiCards() {}',
    'function loadOwnerTickets() {}',
    'var tabs = []; function switchOwnerTab(t){ tabs.push(t); }'
].join('\n'), branchSandbox);

function assignedFor(userBranches, allBranches) {
    branchSandbox.activeUserPermissions = { branches: userBranches, permissions: {} };
    branchSandbox.ownerAllBranches = allBranches;
    branchSandbox.applyAssignedBranches();
    return Array.from(branchSandbox.ownerAssignedBranches);
}

assert.deepStrictEqual(assignedFor(['Banawe'], ['Banawe', 'Mabini']), ['Banawe'],
    'an exact match must still work');
assert.deepStrictEqual(assignedFor(['banawe'], ['Banawe']), ['Banawe'],
    '⚠️ a LOWERCASE grant must still match the cased branch name — this case mismatch silently '
    + 'emptied the branch list and refused every ticket link');
assert.deepStrictEqual(assignedFor(['  Banawe  '], ['Banawe']), ['Banawe'],
    'surrounding whitespace must not change the match');
assert.deepStrictEqual(assignedFor(['Mabini'], ['Banawe']), [],
    'a genuinely different branch must still NOT match');
console.log('  PASS  branch matching is case- and whitespace-insensitive');

// 7f. approveUser() must REFUSE to write an empty branch list. It used to write
//     `branches: []` silently and report success, which is how real accounts lost
//     every branch at once.
// ⚠️ approveUser/updateUserPermissions live in SCRIPT.JS (the Command Center),
// not in owner-dashboard.js — the superadmin acts from main.html.
function extractFrom(src, name) {
    const start = src.indexOf('async function ' + name + '(');
    assert(start > -1, name + '() not found');
    let depth = 0;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error('could not find the end of ' + name + '()');
}
const scriptJsSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const approveFn = extractFrom(scriptJsSrc, 'approveUser');
assert(/detail\.branches\.length === 0/.test(approveFn) || /!Array\.isArray\(detail\.branches\)/.test(approveFn),
    'approveUser() must refuse to approve with zero branches');
assert(/return;/.test(approveFn.slice(approveFn.indexOf('detail.branches'))),
    'approveUser() must RETURN rather than fall through to the write');
assert(/Cannot approve/.test(approveFn),
    'approveUser() must tell the operator WHY it refused, naming the real cause');
// Same for the "save permissions" path.
const updateFn = extractFrom(scriptJsSrc, 'updateUserPermissions');
assert(/detail\.branches\.length === 0/.test(updateFn) || /!Array\.isArray\(detail\.branches\)/.test(updateFn),
    'updateUserPermissions() must refuse to save an empty branch list too');
console.log('  PASS  approve/save refuse to strip a user\'s branch access silently');
r = tryOpen('BNW-TIX007', ROWS);
assert.deepStrictEqual(r.opened, ['BNW-TIX007'], 'the first call opens');
deep.applyOwnerDeepLink(ROWS);
assert.deepStrictEqual(hostArray(deep.__probe().opened), ['BNW-TIX007'],
    'a second snapshot must NOT re-open the modal — the link is one-shot');
console.log('  PASS  the deep link fires once and is consumed');

// 7d. It must be wired into BOTH data paths, or a manager is silently ignored
//     whenever the realtime listener is unavailable.
assert(/applyOwnerDeepLink\(allTickets\)/.test(extractFn('loadOwnerTickets')),
    'the non-listener fallback load must also apply the deep link');
const listenerSrc = ownerJs.slice(ownerJs.indexOf('function setupOwnerTicketListener'));
assert(/applyOwnerDeepLink\(allTickets\)/.test(listenerSrc),
    'the realtime listener must apply the deep link once real tickets arrive');
console.log('  PASS  both the listener and the fallback load apply the deep link');

console.log('\n✅ Area Manager approval + expiry tests passed (approved-only list; pending_approval/' +
    'rejected/legacy hidden; expiry delegated to firebase.js; expired rows stay listed but badged; the ' +
    'modal withholds description, findings and ALL attachments; dead Reports code removed; themed styles; ' +
    'and a re-access request that writes the SAME two fields the existing superadmin workflow reads; ' +
    'the dashboard Request-additional-footage form is RESTORED for the Area Manager / RM/SM ' +
    '(same footage_request hand-off the public Track page performs).');

// 8. TICKET REVIEWS PHONE CARD (matches the mobile mockup): Branch + status
//    pill on top, Incident/Reporter and the two dates in a 2-column grid,
//    expiry + actions in a footer. The footer STAYS — approve/reject exist
//    only there, unlike the owner card whose buttons duplicate the row tap.
console.log('\n=== Ticket Reviews phone card ===');
{
    const mainHtml = fs.readFileSync(path.join(ROOT, 'main.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    const listAt = scriptJsSrc.indexOf('function renderApprovalList()');
    assert(listAt > -1, 'renderApprovalList() not found in script.js');
    const listFn = scriptJsSrc.slice(listAt, scriptJsSrc.indexOf('window.goToApprovalPage', listAt));
    const headAt = mainHtml.indexOf('id="approvalTable"');
    const headHtml = mainHtml.slice(headAt, mainHtml.indexOf('</thead>', headAt));
    const thCount = (headHtml.match(/<th[\s>]/g) || []).length;
    assert.strictEqual(thCount, 10, 'the approvals table must have 10 header cells (9 + hidden card, found ' + thCount + ')');
    assert(/<th class="approval-card-th"/.test(headHtml),
        'the card header cell must exist and stay hidden on desktop');
    for (const label of ['Ticket No.', 'Branch', 'Incident', 'Reporter', 'Date Created',
        'Status', 'Approved Date', 'Access Expires']) {
        assert(listFn.indexOf('data-label="' + label + '"') > -1,
            'renderApprovalList() must emit data-label="' + label + '" — the phone card prints ' +
            'attr(data-label), so without it the value is unlabelled');
    }
    const phoneAt = css.indexOf('Ticket Reviews phone card swap');
    assert(phoneAt > -1, 'the phone card swap block must exist in style.css');
    const phoneCss = css.slice(phoneAt, css.indexOf('Extra-small phones', phoneAt));
    // Desktop: card cell hidden (rule lives with the card styles, BEFORE the
    // swap block). Phones: table cells hide, card shows.
    assert(/#approvalTable \.approval-card-th,\s*#approvalTable \.approval-card-cell\s*\{\s*display:\s*none/.test(css),
        'the card cell must stay hidden on desktop');
    assert(/#approvalTable tbody tr\.approval-row > td:not\(\.approval-card-cell\)\s*\{\s*display:\s*none/.test(phoneCss),
        'on phones the table cells must hide so only the card shows');
    assert(/#tabApprovals \.table-container\s*\{[^}]*overflow-x:\s*visible/.test(phoneCss),
        'the card container must not invite a dead horizontal swipe');
    // The card structure itself: branch + pill header, 2x2 grid, footer.
    // (Card styles live BEFORE the swap block, so assert against full css.)
    assert(/\.approval-card-head\s*\{[^}]*justify-content:\s*space-between/.test(css),
        'the card header must put branch left and the status pill right');
    assert(/\.approval-card-grid\s*\{[^}]*grid-template-columns:\s*1fr 1fr/.test(css),
        'the card body must be a 2-column grid like the mockup');
    assert(/\.approval-card-foot\s*\{[^}]*justify-content:\s*space-between/.test(css),
        'the card footer must put expiry left and actions right');
    assert(/\.approval-card-pill--approved\s*\{[^}]*var\(--color-resolved-bg\)/.test(css),
        'the approved pill must use the resolved token');
    assert(listFn.indexOf('approval-card-cell') > -1,
        'renderApprovalList() must emit the card cell mirroring the desktop cells');
    // THE OLD CARD-ONLY ENVELOPE "OPEN CHAT" BUTTON IS GONE. It duplicated the
    // header chat entry, existed only on the card (so the desktop row never had
    // it), and was the one action on the card that did NOT match the desktop
    // row. The card now interpolates the very same ${actionBtns} the desktop
    // Actions cell wraps in .action-group — one source of truth, two surfaces.
    assert(listFn.indexOf('action-btn msg') === -1 && listFn.indexOf('msgBtn') === -1,
        'the card must no longer render the outdated envelope "Open chat" button');
    assert(listFn.indexOf('window.ChatService && window.ChatService.open') === -1,
        'the card must not open the chat modal — chat stays in the header launcher');
    assert(/approval-card-actions">\s*\$\{actionBtns\}/.test(listFn),
        'the card footer must interpolate the SAME ${actionBtns} set the desktop Actions cell uses');
    assert(/action-group">\s*\$\{actionBtns\}/.test(listFn),
        'the desktop Actions cell must wrap the shared ${actionBtns} in .action-group — parity ' +
        'means one button set, not two hand-maintained copies');
    assert(!/sendMessageToReporter|messageReporter|openChatWith/.test(listFn),
        'the card must NOT call a per-reporter chat API — none exists');
    // THE ACTIONS FOOTER STAYS: approve/reject have no other surface on a
    // phone (the row tap only opens details), so hiding it would remove
    // capability, not height. Fails if the owner-card hiding rule is copied here.
    assert(!/#approvalTable tbody td(?::last-child|:not\(\[data-label\]\))[^,{]*\{[^}]*display:\s*none/.test(phoneCss),
        'the approvals Actions footer must NOT be hidden on a phone');
    assert(/\.approval-card-actions \.action-btn\s*\{[^}]*width:\s*32px[^}]*height:\s*32px/.test(css),
        'the card buttons must be 32px rounded squares like the mockup');
    // The old message-blue .msg rule must be GONE with the button — a rule
    // for a button that no longer renders is dead CSS that re-advertises
    // the removed chat shortcut to whoever reads the stylesheet next.
    assert(!/\.approval-card-actions \.action-btn\.msg\s*\{/.test(css),
        'the removed message button must have no leftover .msg styling rule');
    assert(/\.approval-card-actions \.action-btn::after\s*\{\s*display:\s*none/.test(css),
        'hover tooltips must be suppressed on touch — they stick open and cover the card');
    // ⚠️ THE TOOLTIP IS RIGHT-ANCHORED — the fix for the phantom horizontal
    // scrollbar under the Ticket Reviews table. The tooltip is `white-space:
    // nowrap` and `opacity: 0`: invisible, but STILL IN LAYOUT, so its box
    // counts toward `.table-container`'s scrollable overflow (`overflow-x:
    // auto`). The Actions column is the LAST column, and this table's buttons
    // carry the longest tooltips in the app ("…press to resend to
    // someone@example.com", "Approve Request & Resend (2-Day Access)") on
    // buttons in the LEFT half of that column. Centered (`left: 50%` +
    // `translateX(-50%)`), half of each tooltip stuck out past the table's
    // right edge and produced a scrollbar under a table whose columns all
    // fit. Right-anchoring pins the tooltip's right edge to the button's, so
    // no amount of tooltip text can extend the scroll area to the right
    // (leftward overflow creates no scrollbar in LTR).
    const tipRule = (css.match(/\.action-btn::after\s*\{[^}]*\}/) || [''])[0];
    assert(/right:\s*0/.test(tipRule),
        'the action tooltip must be right-anchored (`right: 0`) — a nowrap tooltip centered ' +
        'on a button in the last column extends past the table edge and shows a scrollbar ' +
        'under a table that fits. Rule: ' + tipRule);
    assert(!/left:\s*50%|translateX\(-50%\)/.test(tipRule),
        'the action tooltip must NOT be centered — the centered form is exactly what let the ' +
        'invisible tooltip overflow the scroll container. Rule: ' + tipRule);
    // The Status History and Branch Monitor tooltips are copy-paste siblings
    // of the same pattern and were only a few px from the same bug; they must
    // stay in step with the rule above.
    const histTipRule = (css.match(/\.history-action-btn::after\s*\{[^}]*\}/) || [''])[0];
    assert(/right:\s*0/.test(histTipRule) && !/left:\s*50%/.test(histTipRule),
        'the history action tooltip must stay right-anchored with its sibling. Rule: ' + histTipRule);
    const viewTipRule = (css.match(/\.btn-view::after\s*,\s*\.btn-remove::after\s*\{[^}]*\}/) || [''])[0];
    assert(/right:\s*0/.test(viewTipRule) && !/left:\s*50%/.test(viewTipRule),
        'the branch action tooltips must stay right-anchored with their sibling. Rule: ' + viewTipRule);
    assert(/#approvalTable tbody td\.empty-state\s*\{[^}]*border-radius:\s*16px/.test(phoneCss),
        'the empty state must render as its own rounded card, not the footer style');
    assert(!/background:\s*rgba\(\s*255\s*,\s*255\s*,\s*255/.test(phoneCss),
        'the phone card must not hardcode a white surface — use var(--bg-card)');
    console.log('  PASS  the approvals table becomes a mockup-style card on phones');
}
