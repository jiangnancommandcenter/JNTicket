// Area Manager dashboard (ownerdashboard.html) - Firebase-connected and role-aware
//
// ⚠️ The role displayed as "Area Manager" is stored as 'owner'. The rename was
// DISPLAY-ONLY on purpose: no user document is migrated, and every check that
// authorises on the value (chat allowlist, firestore.rules, the login redirect,
// the operator redirect below) still compares 'owner'. Do not "tidy" the value.
const $owner = (id) => document.getElementById(id);

const ownerNavItems = Array.from(document.querySelectorAll('#ownerSidebarNav .nav-item'));
const ownerTabContents = Array.from(document.querySelectorAll('#ownerMainContent .tab-content'));
const ownerPageTitle = $owner('ownerPageTitle');
// ⚠️ #ownerPageSubtitle was removed from ownerdashboard.html (phone fit) — no
// const here on purpose. Re-adding a lookup would return null and any
// `.textContent` on it would throw on load.
const ownerUserEmail = $owner('ownerUserEmail');
const ownerUserRoleBadge = $owner('ownerUserRoleBadge');
const ownerBranchFilter = $owner('ownerBranchFilter');
const ownerBranchList = $owner('ownerBranchList');
const ownerPermSummary = $owner('ownerPermSummary');
const ownerLogoutBtn = $owner('ownerLogoutBtn');
// The "+Ticket" entry point. The Area Manager (stored role 'owner') is the one
// role that files tickets from this dashboard; it opens the public form.
const ownerNewTicketBtn = $owner('btnOwnerNewTicket');
const ownerReportModal = $owner('ownerReportModal');
const ownerReportModalBody = $owner('ownerReportModalBody');
const closeOwnerReportModal = $owner('closeOwnerReportModal');
const ownerReportDetailsStatus = $owner('ownerReportDetailsStatus');

const kpiMonthlyReports = $owner('totalMonthlyReports');
const kpiAssignedReports = $owner('totalAssignedReports');
const kpiActiveBranches = $owner('totalActiveBranches');
const kpiAccessLevel = $owner('accessLevelValue');
// New in the KPI overhaul: "Expiring Soon" (a live window closing within 24h)
// and "Access Expired" (lapsed windows). Both are viewer-aware, so HR and a
// superadmin correctly see 0 there - the same way their rows never show an
// expiry badge.
const kpiExpiringSoon = $owner('totalExpiringSoon');
const kpiExpiredAccess = $owner('totalExpiredAccess');

// Owner Tickets tab elements
const ownerTicketSearch = $owner('ownerTicketSearch');
// Replaces the old #ownerTicketStatusFilter, which listed seven statuses but
// was force-locked to "Resolved" and disabled for every role that can reach
// this page — ~170px of permanently dead control that read as a broken filter.
// The list is approved-only now, so the distinction that still matters is
// whether the viewing window is open.
const ownerTicketAccessFilter = $owner('ownerTicketAccessFilter');
// ⚠️ MANAGER-ONLY. Unlike Access/Priority/Branch/Period (which slice the
// approved list), this matches the DISPLAYED badge label —
// pendingApproval ? ticketDisplayStatus(t) : raw status — the exact expression
// the row renderer uses (see statusLabel below). Hidden for HR/superadmin in
// applyViewerExpiryChrome(): their rows are always approved, always
// "Resolved", so for them this would be a dead control.
const ownerTicketStatusFilter = $owner('ownerTicketStatusFilter');
const ownerTicketBranchFilter = $owner('ownerTicketBranchFilter');
const ownerTicketPeriodFilter = $owner('ticketPeriodFilter');
const ownerTicketsBody = $owner('ownerTicketsBody');
const ownerTicketPagination = $owner('ownerTicketPagination');
// The Tickets-tab sentence explaining the approved-only + expiring-window
// rules. Its text is filled in from formatTrackingAccessWindow() so it reads
// "1 minute" while the window is time-compressed and "2 days" in production.
const ownerWindowNote = $owner('ownerWindowNote');

let ownerAllBranches = [];
let ownerAssignedBranches = [];
let activeUserRole = 'viewer';
let activeUserPermissions = {
  branches: [],
  permissions: { viewOnly: false, canEdit: false, canDownload: false }
};
let activeUserIsSuperAdmin = false;
// The signed-in manager's display name, read from their `users` doc. Used as
// `requestedBy` on a re-access request, so the superadmin sees a person rather
// than a bare email in the Approvals chip and the confirm dialog.
let ownerActiveUserName = '';
// The ticket the open modal is showing, for the delegated re-access submit.
// Set by openOwnerReport(), cleared by closeOwnerReportModalFn() — never read
// from the DOM, so a re-render mid-flight cannot redirect a request.
let ownerReopenTicketId = '';
// The same contract for the "Request additional footage" form: the id is only
// valid while the modal is open, so a footage request can never be written to
// a ticket the manager is no longer looking at.
let ownerFootageTicketId = '';
// ⚠️ CLOSE MUST BE ABLE TO OUTRUN AN OPEN STILL IN FLIGHT.
//
// openOwnerReport() adds the `active` class only AFTER its Firestore read
// resolves, so a click on × can land while that read is still travelling. The
// close removes `active`, then the read resolves and puts it straight back —
// the modal visibly survives the first click and only the SECOND × sticks
// ("close twice to close").
//
// Every open captures the generation at CALL time; close (and any newer open)
// bumps it. When the read finally resolves, a stale generation paints nothing.
let ownerModalGen = 0;

// One-shot flag: owner refresh state (saved tab/modal) is restored exactly once
// per page load so a later auth callback (e.g. ID-token refresh) can never yank
// the user off the view they are currently using.
let ownerStateRestored = false;

// ===== Deep link from the approval email: ?ticket=BNW-TIX007 =====
// `ownerdashboard.html` is LOGIN-GATED, so an Area Manager who clicks the link
// while signed out is bounced to login.html and returned here. js/auth.js carries
// `?ticket=` across that bounce (see redirectToLogin / withTicketParam) - this is
// the half that finally opens the ticket.
//
// ONE-SHOT, consumed once, mirroring `deepLinkPrefillDone` on submit-ticket.html.
// Without that, the next auth callback (Firebase fires them freely, e.g. on
// ID-token refresh) would re-open the modal under the manager, trapping them in
// a report they already closed.
let ownerDeepLinkTicket = '';
let ownerDeepLinkDone = false;

/**
 * Read the ticket number out of the URL, once.
 *
 * ⚠️ SECURITY - this is a redirect target a stranger can edit, and the value is
 * used as a Firestore document id. The allowlist mirrors js/auth.js exactly: no
 * `/`, `?`, `#` or scheme characters can reach Firestore, so the id cannot be
 * walked out of the `tickets` collection, and it cannot smuggle anything into
 * the page URL. Same rule as the public `?track=` link, which also never carries
 * anything but the ticket number.
 */
function readOwnerDeepLink() {
    if (ownerDeepLinkDone) return '';
    ownerDeepLinkDone = true;
    try {
        const raw = new URLSearchParams(window.location.search || '').get('ticket');
        if (!raw) return '';
        const value = String(raw).trim();
        return /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : '';
    } catch (e) {
        return '';
    }
}

// Capture it as early as possible - the auth observer below decides when to act.
ownerDeepLinkTicket = readOwnerDeepLink();

/**
 * Open the deep-linked ticket, but ONLY if it is in the list this manager is
 * already allowed to see.
 *
 * ⚠️ THIS GATE IS THE WHOLE POINT. `openOwnerReport()` reads a ticket straight
 * from Firestore by id and renders it. The visible list, by contrast, is filtered
 * in renderOwnerTickets() to APPROVED tickets in the manager's assigned branches.
 * Calling openOwnerReport() on an unfiltered id would hand any signed-in user a
 * way to read ANY ticket document just by editing the URL - including other
 * branches' tickets and unapproved work. So this does NOT trust the URL: it looks
 * the id up in the SAME already-filtered list the UI itself renders.
 *
 * Must run after loadBranches()/loadActiveUserPermissions(), because the branch
 * allowlist is not known until then. Before that every ticket would look
 * out-of-scope and the deep link would always fail.
 */
function applyOwnerDeepLink(allTickets) {
    if (!ownerDeepLinkTicket) return;
    if (typeof window.openOwnerReport !== 'function') return;

    // ⚠️ Consume it HERE, before anything can return early. The ticket listener
    // fires on every snapshot (and this list re-renders often), so a deep link
    // left set would re-open the report modal over and over, trapping the
    // manager in a ticket they already closed. Consuming first also means the
    // "not available" toast can only ever appear once.
    const ticketId = ownerDeepLinkTicket;
    ownerDeepLinkTicket = '';

    const rows = (Array.isArray(allTickets) ? allTickets : []).map((doc) => normalizeTicketReport(doc));

    // ⚠️ WHY THIS GATE IS "APPROVED", NOT "IN MY BRANCH LIST".
    //
    // The original version required the ticket to appear in the manager's
    // branch-scoped LIST, and called that a security control. It was not one:
    // firestore.rules already reads
    //     allow read: if isSignedIn() || resource.data.approvalStatus == 'approved'
    // so ANY signed-in user can already read ANY approved ticket straight from
    // Firestore. Requiring it to pass a UI branch filter blocked nothing — it
    // just stopped the legitimate recipient of an approval email from opening
    // the ticket they had been emailed about, whenever their branch list was
    // empty (see the approveUser() branches:[] bug) or a name differed by case.
    //
    // So the gate is now exactly what the rules enforce: signed in + approved.
    // The branch list still scopes the visible TICKETS, which is where scoping
    // belongs; the deep link reports a branch mismatch as information.
    const match = rows.find((t) => String(t.id || '') === ticketId);
    if (!match) {
        ownerToast('Ticket ' + ticketId + ' could not be found.', 'error');
        return;
    }

    if (!isApprovedTicket(match)) {
        ownerToast('Ticket ' + ticketId + ' has not been approved yet.', 'error');
        return;
    }

    // Informational only — it opens regardless. Branch scoping lives in the list.
    const allowedBranches = activeUserIsSuperAdmin ? ownerAllBranches : ownerAssignedBranches;
    const ticketBranch = ownerBranchKey(match.branch || match.branchName || '');
    const inScope = activeUserIsSuperAdmin
        || allowedBranches.some((b) => ownerBranchKey(b) === ticketBranch);
    if (!inScope) {
        console.warn('[Deep link] ' + ticketId + ' is outside this manager\'s branch list (' +
            (match.branch || match.branchName || 'unknown') + '). Opening it anyway: firestore.rules '
            + 'already permits any signed-in user to read an approved ticket.');
    }

    // Land on the Tickets tab first - the report modal renders over whatever
    // tab is showing, so without this they get a popup over Overview.
    switchOwnerTab('tickets');
    window.openOwnerReport(ticketId);
}


// ===== Flash-free restore =====
// Runs synchronously during parsing — before the first paint — so a refresh
// re-opens the saved tab (Overview / Reports) with no visible default-then-jump.
// The async auth observer re-checks the actual role afterwards.
(function preRestoreOwnerTab() {
    try {
        if (!window.RefreshState) return;
        const saved = window.RefreshState.restore('owner') || {};
        const tabId = saved.tab;
        // 'violations' is the HR-only transferred-violations tab. It is restored
        // here like any other, but the section only becomes reachable once
        // js/hr-violations.js confirms the role is hr/superadmin — an owner who
        // was last on it is moved back to the overview by that module's
        // applyRole(), which is why this is safe to allow unconditionally.
        if (!['overview', 'tickets', 'violations'].includes(tabId)) return;

        ownerNavItems.forEach((btn) => { btn.classList.toggle('active', btn.dataset.tab === tabId); });
        ownerTabContents.forEach((section) => { section.classList.toggle('active', section.id === `tab${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`); });
    } catch (e) { /* ignore */ }
})();

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ⚠️ This is deliberately a PRIVATE `const`, not a top-level `function`.
//
// A top-level `function` in a classic script becomes a property of `window`.
// js/notifications.js (loaded EARLIER on this page) already defines the real
// `window.showToast`, so declaring a global `showToast` here silently
// OVERWROTE it — and because the old body delegated to `window.showToast`, the
// wrapper ended up calling ITSELF, throwing
// `RangeError: Maximum call stack size exceeded` on every toast on this page
// (HR violation report download, logout failure, chat, error reports).
//
// Keeping it private means this module can never clobber the real toast again.
// The `!== ownerToast` self-check is belt-and-braces: if a future edit
// reintroduces a same-named global, this degrades to console.log instead of
// hanging the tab. Mirrors the local `toast()` helper in js/hr-violations.js.
const ownerToast = (message, type = 'info') => {
  if (typeof window.showToast === 'function' && window.showToast !== ownerToast) {
    window.showToast(message, type);
  } else {
    console.log(message);
  }
};

/**
 * The signed-in user's normalised role, for other scripts on this page.
 *
 * ⚠️ `activeUserRole` is declared with `let` at the top level of a classic
 * script, which creates a SCRIPT-SCOPED binding, not a property on `window`.
 * Other <script> files therefore cannot read `window.activeUserRole` — it is
 * always undefined for them. This accessor is how js/hr-violations.js reads it.
 */
window.getOwnerRole = function () {
  return activeUserRole;
};

// ===== Flash-free Violations nav button =====
// The HR Violations nav item ships display:none and is only revealed once the
// role resolves ASYNCHRONOUSLY from Firestore (setActiveUser below). On a
// refresh that made the button blink in late, unlike Overview/Tickets which are
// static. We cache the resolved role in sessionStorage (keyed to the signed-in
// email) so js/hr-violations.js can reveal the button BEFORE first paint, then
// self-correct when the real role lands — the same optimistic-then-correct
// pattern preRestoreOwnerTab() already uses for the tab SECTION.
//
// SAFETY: this reveals the nav BUTTON only. The report DATA stays fully
// rules-gated (an owner cannot read violations at all), and applyRole() re-checks
// the authoritative role on every load, so a stale cache is corrected in the
// same async window. sessionStorage is per-tab and cleared on logout.
const OWNER_ROLE_CACHE_KEY = 'rcms_owner_role';

/** Persist the resolved role for a flash-free next paint. Fails closed. */
window.cacheOwnerRole = function (role, email) {
  try {
    const r = String(role || '').toLowerCase();
    const em = String(email || '').trim().toLowerCase();
    // Only cache a real, resolved role — never the 'viewer' placeholder or a
    // failed fetch (role === false). Anything else is removed so a stale value
    // can never outlive a demotion.
    if (!em || (r !== 'hr' && r !== 'superadmin' && r !== 'owner' && r !== 'rmsm')) {
      try { sessionStorage.removeItem(OWNER_ROLE_CACHE_KEY); } catch (e) { /* ignore */ }
      return;
    }
    sessionStorage.setItem(OWNER_ROLE_CACHE_KEY, JSON.stringify({ email: em, role: r }));
  } catch (e) { /* storage disabled — the button just flashes as before */ }
};

/**
 * The cached role, for a flash-free first paint.
 *
 * ⚠️ WHY THIS DOES NOT REQUIRE auth.currentUser. In Firebase v8, currentUser is
 * null at the FIRST synchronous paint (auth state restores asynchronously and
 * only then fires onAuthStateChanged). Gating on currentUser here would fail
 * closed at exactly the moment we need to reveal — so the flash would remain.
 * The cache is safe to trust optimistically because it is sessionStorage (per
 * tab), CLEARED on logout, reveals the nav BUTTON only (data stays rules-gated),
 * and applyRole() re-checks the authoritative role and corrects it the instant
 * the real one lands. When currentUser IS already restored we still verify the
 * email belongs to this user, so a cache from another account can never leak.
 *
 * Returns '' when there is no cache or a confirmed different user.
 */
window.getCachedOwnerRole = function () {
  try {
    const raw = sessionStorage.getItem(OWNER_ROLE_CACHE_KEY);
    if (!raw) return '';
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.role !== 'string') return '';
    // Defense-in-depth: if auth has already restored and it is a DIFFERENT user,
    // ignore the cache outright.
    const user = window.auth && window.auth.currentUser;
    if (user && user.email &&
        String(parsed.email || '').toLowerCase() !== String(user.email).toLowerCase()) {
      return '';
    }
    return String(parsed.role).toLowerCase();
  } catch (e) { return ''; }
};

/** Drop the cache on logout so the next account never inherits it. */
window.clearOwnerRoleCache = function () {
  try { sessionStorage.removeItem(OWNER_ROLE_CACHE_KEY); } catch (e) { /* ignore */ }
};

/**
 * True for the Area Manager.
 *
 * ⚠️ The stored role VALUE stays `'owner'` in Firestore (only the display label
 * became "Area Manager"), so this is a rename, NOT a new role. Everything that
 * authorises on the value — js/chat.js's CHAT_ALLOWED_ROLES, isHrOrSuperAdmin()
 * in firestore.rules, the operator redirect below — keeps comparing 'owner'.
 */
function isAreaManager() {
  return activeUserRole === 'owner' || activeUserRole === 'rmsm';
}

/**
 * HR or superadmin — the roles that may leave a coordination remark. Mirrors
 * isHrOrSuperAdmin() in firestore.rules, which gates the 
emarks collection
 * (see js/remarks.js). Used only to decide whether to DRAW the Remarks button;
 * the real gate is the rules, so a role that cannot write gets no button
 * rather than a button that fails.
 */
function isHrOrSuperAdmin() {
  return activeUserRole === 'hr' || activeUserIsSuperAdmin;
}

/**
 * The human-readable role name, used by BOTH the header role badge and the
 * "My Access Level" KPI tile.
 *
 * ⚠️ ONE definition on purpose: the badge and the tile previously carried two
 * byte-identical ternaries, which is precisely how a rename like this one ends
 * up applied to one and forgotten on the other. The badge text is also parsed
 * back out of the DOM as a role fallback by js/hr-violations.js and
 * js/owner-violations.js (see readRole there), so it must stay in step with
 * those modules' matchers — they map "Area Manager" → 'owner' and
 * "RM/SM" → 'rmsm' when re-deriving the stored value.
 */
function accessLevelLabel() {
  return activeUserRole === 'superadmin'
    ? 'Superadmin'
    : activeUserRole === 'hr'
      ? 'HR'
      // ⚠️ 'rmsm' must be checked BEFORE isAreaManager(): that gate returns
      // true for RM/SM too (shared +Ticket button, expiry window and
      // resolved-only scope), so the fall-through would keep labelling a
      // re-roled RM/SM account "Area Manager" — the bug where the badge
      // and the KPI tile never changed.
      : activeUserRole === 'rmsm'
        ? 'RM/SM'
        : isAreaManager()
          ? 'Area Manager'
          : (activeUserPermissions.permissions && activeUserPermissions.permissions.canEdit ? 'Editor' : 'Viewer');
}

/**
 * Show the "+Ticket" button to the Area Manager only.
 *
 * HR and superadmin keep the header as it was: this entry point was previously
 * removed for EVERY role precisely because tickets are filed from the public
 * submit-ticket.html, and it is coming back for one role only — the person who
 * raises tickets for their own branches instead of resolving someone else's.
 *
 * Called from setActiveUser() rather than only on first load, so a role change
 * made in another tab shows/hides the button immediately. An <a> with
 * `hidden` is removed from the tab order AND the accessibility tree, so
 * `hidden` (not a class) is what keeps it from being keyboard-reachable while
 * the role is still unknown.
 */
function syncNewTicketButton() {
  if (!ownerNewTicketBtn) return;
  const show = isAreaManager();
  ownerNewTicketBtn.hidden = !show;
  // The `u-hidden` class is the codebase's other hide idiom (main.html uses it
  // for #btnNewViolation). Set both so the button is hidden even if the
  // stylesheet and the `hidden` attribute ever disagree.
  ownerNewTicketBtn.classList.toggle('u-hidden', !show);
  ownerNewTicketBtn.setAttribute('aria-hidden', show ? 'false' : 'true');
  ownerNewTicketBtn.title = show ? 'Submit an incident ticket' : '';
}

// Open the full-screen submission modal. Guarded by the same isAreaManager()
// check as the button's visibility: `hidden` is a CSS/AT concern, not a
// security boundary, and a caller with a reference to the element can always
// set hidden = false. The real gate is the Firestore rules (see README).
if (ownerNewTicketBtn) {
  ownerNewTicketBtn.addEventListener('click', function () {
    if (!isAreaManager()) return;
    if (window.OwnerTicketForm && typeof window.OwnerTicketForm.open === 'function') {
      window.OwnerTicketForm.open();
    }
  });
}

// ==============================================================
//  CONTEXT BRIDGE FOR js/owner-ticket-form.js
//
//  ⚠️ WHY THIS EXISTS. The ticket form is a separate file and cannot see this
//  module's lexical `let` bindings — `ownerAssignedBranches` and
//  `ownerActiveUserName` are module-private, not properties of `window`. Two
//  files reading the same Firestore docs to get the same answers would be a
//  second source of truth that can drift.
//
//  Exposing a narrow READ-ONLY API is the smaller cost. It hands over copies,
//  so a consumer cannot mutate the dashboard's own state by accident. The email
//  is NOT bridged: the form reads `auth.currentUser.email` itself, which is the
//  same source the dashboard uses and needs no second copy.
//
//  Read by the form as: getOwnerAssignedBranches(), getOwnerDisplayName().
// ==============================================================
window.getOwnerAssignedBranches = function () {
  return ownerAssignedBranches.slice();
};
window.getOwnerDisplayName = function () {
  return activeUserDisplayName();
};

function setActiveUser(permissions, role = 'viewer') {
  activeUserPermissions = permissions || {
    branches: [],
    permissions: { viewOnly: false, canEdit: false, canDownload: false }
  };

  const normalizedRole = String(role || 'viewer').toLowerCase();
  activeUserRole = normalizedRole;
  activeUserIsSuperAdmin = normalizedRole === 'superadmin';

  // Cache the resolved role so the HR Violations nav button can appear on the
  // NEXT refresh without waiting for this async fetch (see cacheOwnerRole above).
  // Fails closed on an unresolved/failed role.
  if (typeof window.cacheOwnerRole === 'function') {
    const email = (window.auth && window.auth.currentUser && window.auth.currentUser.email) || '';
    try { window.cacheOwnerRole(normalizedRole, email); } catch (e) { /* ignore */ }
  }

  const accessLevel = accessLevelLabel();

  if (ownerUserRoleBadge) {
    ownerUserRoleBadge.textContent = accessLevel;
    ownerUserRoleBadge.className = 'role-badge ' + (
      normalizedRole === 'superadmin'
        ? 'superadmin'
        : normalizedRole === 'hr'
          ? 'hr'
          : (normalizedRole === 'owner' || normalizedRole === 'rmsm')
            ? 'owner'
            : (activeUserPermissions.permissions?.canEdit ? 'editor' : 'viewer')
    );
  }

  if (kpiAccessLevel) {
    kpiAccessLevel.textContent = accessLevel;
  }

  // The "+Ticket" shortcut is Area Manager only. This runs on every
  // setActiveUser() call, so it is correct on first load and after a re-role.
  syncNewTicketButton();

  // The approved-only + expiring-window sentence on the Tickets tab, plus the
  // Access column / access filter, which only exist for a role that actually
  // has a viewing window (the Area Manager).
  applyViewerExpiryChrome();

  // ===== HR <-> Superadmin chat =====
  // This page serves Area Managers, HR and superadmins, but chat is for HR and
  // superadmin ONLY — an Area Manager gets the same dashboard minus the chat.
  // canChat() rejects 'owner' (the stored value), operators and anything unknown.
  if (window.ChatService && typeof window.ChatService.init === 'function') {
    try {
      window.ChatService.init({ surface: 'owner', role: normalizedRole });
    } catch (e) {
      console.warn('Chat init failed:', e);
    }
  }

  applyAssignedBranches();

  // Tell the transferred-violations module who signed in, so it can show its
  // tab to HR and hide it again from owners. Called here (not only on first
  // load) so a role change made in another tab takes effect immediately.
  if (window.HrViolations && typeof window.HrViolations.applyRole === 'function') {
    try {
      window.HrViolations.applyRole(normalizedRole);
    } catch (e) {
      console.warn('HR violations role gate failed:', e);
    }
  }
}

function switchOwnerTab(tabId) {
  ownerNavItems.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  ownerTabContents.forEach((section) => {
    section.classList.toggle('active', section.id === `tab${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`);
  });
  try { if (window.RefreshState) window.RefreshState.captureTab('owner', tabId); } catch (e) { /* ignore */ }
}

function populateBranchDropdowns() {
  const assignedOptions = ownerAssignedBranches
    .map((branch) => `<option value="${escapeHTML(branch)}">${escapeHTML(branch)}</option>`)
    .join('');

  const html = `<option value="">All Branches</option>${assignedOptions}`;

  if (ownerBranchFilter) ownerBranchFilter.innerHTML = html;
  if (ownerTicketBranchFilter) ownerTicketBranchFilter.innerHTML = html;
}

function renderBranchAccessList() {
  if (!ownerBranchList) return;

  if (!ownerAssignedBranches.length) {
    ownerBranchList.innerHTML = '<div class="empty-state"><i class="fas fa-map-pin"></i><p>No branch access assigned yet.</p></div>';
    return;
  }

  ownerBranchList.innerHTML = ownerAssignedBranches
    .map((branch) => `
      <div class="quick-status-item">
        <span>${escapeHTML(branch)}</span>
        <span class="status-badge online">Assigned</span>
      </div>
    `)
    .join('');
}

function renderPermissionSummary() {
  if (!ownerPermSummary) return;

  const p = activeUserPermissions.permissions || {};
  const chips = [
    p.viewOnly ? '<span class="perm-chip">View Only</span>' : '',
    p.canEdit ? '<span class="perm-chip perm-chip-edit">Can Edit</span>' : '',
    p.canDownload ? '<span class="perm-chip perm-chip-download">Can Download</span>' : ''
  ].filter(Boolean);

  ownerPermSummary.innerHTML = chips.length ? chips.join('') : '<span class="perm-chip">No extra permissions</span>';
}

/**
 * Date accessor for a ticket's filing time. `submittedAt` is what the table
 * rows sort on; `createdAt` is the fallback written by older documents.
 * Returns null (never an Invalid Date) when nothing usable is stored.
 */
function ownerTicketDate(t) {
  const raw = (t && t.submittedAt) || (t && t.createdAt) || null;
  const d = raw && raw.toDate ? raw.toDate() : (raw ? new Date(raw) : null);
  return d && !isNaN(d.getTime()) ? d : null;
}

/**
 * The tickets this dashboard actually SHOWS - the approval gate and the
 * branch scope from renderOwnerTickets() extracted into ONE helper, so the
 * KPI tiles, the overview charts and the table can never disagree about what
 * is in scope. `allTickets` may be the raw cache; normalisation happens here.
 */
function ownerScopedTickets(allTickets) {
  const raw = Array.isArray(allTickets) ? allTickets : [];
  const ownerResolvedOnly = activeUserRole === 'owner' || activeUserRole === 'hr' || activeUserRole === 'rmsm' || activeUserIsSuperAdmin;
  const allowedBranches = activeUserIsSuperAdmin ? ownerAllBranches : ownerAssignedBranches;
  return raw
    .map((doc) => normalizeTicketReport(doc))
    .filter((t) => (ownerResolvedOnly ? isApprovedTicket(t) : true))
    .filter((t) => allowedBranches.includes(String(t.branch || t.branchName || '').trim()))
    // Hide HR-transferred tickets from Area Manager/RM/SM dashboard entirely.
    .filter((t) => !(isAreaManager() && t.ticketTransferTo === 'hr'));
}

function renderKpiCards() {
  // Same helper the header badge uses, so the two can never disagree.
  const accessLabel = accessLevelLabel();

  // REAL COUNTS. This tile row used to hardcode `textContent = '0'` for
  // "Total Monthly Reports" and show the BRANCH count twice for "Total
  // Assigned Reports" - two of the four numbers on the card were decorative.
  // Everything now derives from the same scoped list the table renders, via
  // the viewer-aware expiry helpers so the tiles and the badges agree.
  const scoped = ownerScopedTickets(ownerAllTicketsCache);
  const now = new Date();

  const monthly = scoped.filter((t) => {
    const d = ownerTicketDate(t);
    return !!d && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;

  const expiredCount = scoped.filter((t) => isOwnerTicketExpiredForViewer(t)).length;

  // "Expiring Soon": a LIVE viewer window closing within the next 24 hours.
  // ownerTicketExpiry() returns the deadline for an approved ticket with a
  // stored window (null otherwise), and HR/superadmin get 0 here because the
  // window is a requester condition that never applies to them.
  const expiringSoon = scoped.filter((t) => {
    if (isOwnerTicketExpiredForViewer(t)) return false;
    const at = ownerTicketExpiry(t);
    if (!at) return false;
    const ms = at.getTime() - Date.now();
    return ms > 0 && ms <= 24 * 60 * 60 * 1000;
  }).length;

  if (kpiMonthlyReports) kpiMonthlyReports.textContent = String(monthly);
  if (kpiAssignedReports) kpiAssignedReports.textContent = String(scoped.length);
  if (kpiExpiringSoon) kpiExpiringSoon.textContent = String(expiringSoon);
  if (kpiExpiredAccess) kpiExpiredAccess.textContent = String(expiredCount);
  if (kpiActiveBranches) kpiActiveBranches.textContent = String(ownerAssignedBranches.length);
  if (kpiAccessLevel) kpiAccessLevel.textContent = accessLabel;

  try { renderOwnerOverviewCharts(); } catch (e) { /* charts must never break the KPIs */ }
}

// ==============================================================
//  OVERVIEW CHARTS (tickets-filed trend + status breakdown)
//
//  Same scoped list the table renders, same theme tokens as main.html.
// ==============================================================
let ownerChartInstances = [];
function ownerChartToken(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  } catch (e) { return fallback; }
}

function ownerTicketMonthKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function renderOwnerOverviewCharts() {
  const trendEl = document.getElementById('ownerTrendChart');
  const statusEl = document.getElementById('ownerStatusChart');
  if (!trendEl || !statusEl) return;
  if (typeof window.Chart !== 'function') return;

  const scoped = ownerScopedTickets(ownerAllTicketsCache);

  const now = new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  const trendCounts = months.map((m) => {
    const key = ownerTicketMonthKey(m);
    return scoped.filter((t) => {
      const d = ownerTicketDate(t);
      return !!d && ownerTicketMonthKey(d) === key;
    }).length;
  });
  const monthLabels = months.map((m) => m.toLocaleString('en-US', { month: 'short' }));
  const trendPill = document.getElementById('ownerTrendPill');
  if (trendPill) {
    const total = trendCounts.reduce((x, y) => x + y, 0);
    trendPill.textContent = total + (total === 1 ? ' ticket' : ' tickets');
  }

  const statusBuckets = { Resolved: 0, 'In Progress': 0, Pending: 0, 'For Revision': 0, Other: 0 };
  scoped.forEach((t) => {
    const s = String(t.status || 'Pending').trim();
    if (Object.prototype.hasOwnProperty.call(statusBuckets, s)) statusBuckets[s] += 1;
    else statusBuckets.Other += 1;
  });
  const statusLabels = Object.keys(statusBuckets);
  const statusCounts = statusLabels.map((k) => statusBuckets[k]);
  const statusPill = document.getElementById('ownerStatusPill');
  if (statusPill) {
    statusPill.textContent = scoped.length + (scoped.length === 1 ? ' ticket' : ' tickets');
  }
  ownerChartInstances.forEach((c) => { try { c.destroy(); } catch (e) { /* ignore */ } });
  ownerChartInstances = [];

  const reduceMotion = (typeof window.matchMedia === 'function')
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const brand = ownerChartToken('--color-primary', '#72bf6a');
  const brandBg = ownerChartToken('--color-primary-bg', 'rgba(114,191,106,0.15)');
  const tick = ownerChartToken('--text-secondary', '#94A3B8');
  const grid = ownerChartToken('--border-color', '#24334D');
  const card = ownerChartToken('--bg-card', '#FFFFFF');

  ownerChartInstances.push(new window.Chart(trendEl.getContext('2d'), {
    type: 'line',
    data: { labels: monthLabels, datasets: [{ label: 'Tickets filed', data: trendCounts, borderColor: brand, backgroundColor: brandBg, fill: true, tension: 0.3, pointRadius: 3, borderWidth: 2 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: reduceMotion ? false : undefined,
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: tick }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0, color: tick }, grid: { color: grid } } } }
  }));

  ownerChartInstances.push(new window.Chart(statusEl.getContext('2d'), {
    type: 'doughnut',
    data: { labels: statusLabels, datasets: [{ data: statusCounts,
      backgroundColor: [ownerChartToken('--color-resolved', '#22c55e'), ownerChartToken('--color-progress', '#3b82f6'), ownerChartToken('--color-pending', '#f59e0b'), ownerChartToken('--color-danger', '#ef4444'), ownerChartToken('--text-muted', '#94a3b8')],
      borderColor: card, borderWidth: 3, hoverOffset: 8 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: reduceMotion ? false : undefined, cutout: '62%',
      plugins: { legend: { position: 'bottom', labels: { color: tick, boxWidth: 10, padding: 12 } } } }
  }));
}

/**
 * ⚠️ THE COMPARISON KEY FOR A BRANCH NAME.
 *
 * Branch names are written in several places by several people: picked from a
 * dropdown, typed into the Manage Branches form, seeded by scripts/seed.js, and
 * entered by hand in the Firestore console. Comparing them with `===` means a
 * single stray space or a lowercase 'banawe' against 'Banawe' silently yields
 * an EMPTY branch list — and the dashboard then shows "No branch access
 * assigned yet" and refuses every ticket deep link, with no error anywhere.
 *
 * Both sides now go through this, so the name that is displayed is still the
 * name that is matched; only the comparison is normalised.
 */
const ownerBranchKey = (name) => String(name === null || name === undefined ? '' : name).trim().toLowerCase();

function applyAssignedBranches() {
  if (!ownerAllBranches.length) {
    ownerAssignedBranches = [];
  } else if (activeUserIsSuperAdmin) {
    ownerAssignedBranches = [...ownerAllBranches];
  } else {
    // Compare on the normalised key, not the raw string.
    const granted = new Set((activeUserPermissions.branches || []).map(ownerBranchKey).filter(Boolean));
    ownerAssignedBranches = ownerAllBranches.filter((branch) => granted.has(ownerBranchKey(branch)));
  }

  populateBranchDropdowns();
  renderBranchAccessList();
  renderPermissionSummary();
  renderKpiCards();
  loadOwnerTickets();
}

async function loadBranches() {
  try {
    if (!window.firestoreService || typeof window.firestoreService.getBranches !== 'function') {
      throw new Error('firestoreService.getBranches is not available');
    }

    const branches = await window.firestoreService.getBranches();
    ownerAllBranches = branches
      .map((b) => b.branchName || b.id || '')
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    applyAssignedBranches();
  } catch (error) {
    // ⚠️ WAS SILENT. An empty branch list makes every ticket deep link fail and
    // the "+Ticket" form show no branch dropdown, but nothing said why — so a
    // permission error looked identical to "this manager has no branches".
    console.error('Failed to load branches:', error);
    ownerAllBranches = [];
    ownerAssignedBranches = [];
    populateBranchDropdowns();
    renderBranchAccessList();
    renderPermissionSummary();
    ownerToast('Could not load branches — ticket links and branch filters may not work.', 'error');
  }
}

async function loadActiveUserPermissions(user) {
  if (!user || !user.email) return;

  if (ownerUserEmail) ownerUserEmail.textContent = user.email;

  try {
    const emailKey = window.normalizeUserEmail(user.email);
    const userDoc = await db.collection('users').doc(emailKey).get();
    const userData = userDoc.exists ? userDoc.data() : null;
    const role = String((userData && userData.role) || 'owner').toLowerCase();
    // Remember the name for a re-access request. `users.name` is the name given
    // at registration, so it is the best "who is asking" the dashboard has; the
    // chat profile name is a separate, opt-in thing we deliberately do not read.
    ownerActiveUserName = String((userData && userData.name) || '').trim();
    const permissions = userData ? {
      branches: Array.isArray(userData.branches) ? userData.branches : [],
      permissions: userData.permissions || { viewOnly: false, canEdit: false, canDownload: false }
    } : {
      branches: [],
      permissions: { viewOnly: false, canEdit: false, canDownload: false }
    };

    setActiveUser(permissions, role);
  } catch (error) {
    console.error('Failed to load user permissions:', error);
    setActiveUser(activeUserPermissions, false);
  }
}

function formatDate(dateValue) {
  if (!dateValue) return '—';
  if (dateValue.toDate) {
    return dateValue.toDate().toLocaleString();
  }
  return new Date(dateValue).toLocaleString();
}


// Searchable date strings for a stored timestamp (Timestamp | Date | ISO), so
// the Tickets search bar matches a date the way it is SHOWN in the table
// ("10/10/2026") plus an ISO fallback ("2026-10-10"). Minimal set — exactly the
// two formats users type. Returns [] for a missing/unparseable date.
function dateSearchTokens(value) {
  if (!value) return [];
  const d = value.toDate ? value.toDate() : new Date(value);
  if (isNaN(d.getTime())) return [];
  const pad = (n) => String(n).padStart(2, '0');
  const iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  return [d.toLocaleDateString(), iso];
}

function normalizeTicketReport(ticket) {
  const report = ticket || {};
  const branchName = String(report.branch || report.branchName || '—').trim() || '—';
  const authorName = String(report.author || report.reporter || report.name || 'Unknown').trim() || 'Unknown';
  const title = String(report.title || report.reportName || report.incident || 'Untitled Report').trim() || 'Untitled Report';
  const submittedAt = report.createdAt || report.dateCreated || report.submittedAt || report.datetime || report.dateTime || null;

  return {
    ...report,
    branchName,
    authorName,
    title,
    submittedAt,
    ticketNumber: report.ticketNumber || report.id || 'N/A'
  };
}

// ==============================================================
//  APPROVAL + EXPIRY GATE
//
//  A ticket reaches the Area Manager's list only once the SUPERADMIN has
//  APPROVED it — not merely when the operator resolved it. The lifecycle is
//  (script.js):
//
//    operator resolves  → status 'Resolved', approvalStatus 'pending_approval'
//    superadmin approves → approvalStatus 'approved'   (+ accessWindowStartsOnOpen)
//
//  So `status === 'Resolved'` alone is NOT enough: it also matches work that
//  is still queued for review, and work the superadmin SENT BACK. The list
//  must gate on `approvalStatus === 'approved'`.
//
//  Once approved, the same viewing window the public "Track Ticket Status"
//  page uses applies here (see the 2-day window in firebase.js — currently
//  time-compressed to 1 minute for testing). An APPROVED but LAPSED ticket
//  stays in the list, badged, but its sensitive payload (description,
//  resolution notes, all footage) is withheld.
//
//  ⚠️ CLIENT-SIDE ONLY. firestore.rules lets any signed-in user read all
//  tickets, so this is a display gate, not an authorisation one — the same
//  trade-off the public track page already makes (see the `TODO (security)`
//  note there). Enforcing it server-side is a separate, larger change.
// ==============================================================

/**
 * True when the superadmin has signed this ticket off.
 *
 * Case-insensitive, and a MISSING field is treated as NOT approved
 * (`'pending'`), which is the same default script.js uses — a legacy ticket
 * that predates the approval workflow must not be assumed approved.
 */
function isApprovedTicket(ticket) {
  if (!ticket) return false;
  return String(ticket.approvalStatus || 'pending').trim().toLowerCase() === 'approved';
}

/**
 * True when a ticket has NOT yet been signed off by the superadmin.
 *
 * The exact complement of isApprovedTicket(), so it covers EVERY not-yet-approved
 * state the lifecycle can be in — freshly filed ('pending'), resolved and queued
 * for the superadmin ('pending_approval'), and sent back for revision ('rejected')
 * — plus a legacy ticket with no field at all (which defaults to 'pending', i.e.
 * not approved).
 *
 * ⚠️ This is a DISPLAY signal only, never an authorisation one. firestore.rules
 * already lets any signed-in user read every ticket, so surfacing a pending
 * ticket to the manager who filed it grants no new read. The sensitive payload
 * (description, findings, footage) is still withheld until approval — see the
 * pending branch of openOwnerReport(), which mirrors the expired branch.
 */
function isPendingApprovalTicket(ticket) {
  return !isApprovedTicket(ticket);
}

/**
 * The label the Status column / badge shows.
 *
 * ⚠️ PIPELINE-HONEST, NOT COLLAPSED — with ONE hard rule. The manager must be
 * able to track their own ticket live: when the superadmin starts work the
 * row has to move to "In Progress", while the operator resolves it moves to
 * "Pending Approval", and so on — the raw status arrives on every Firestore
 * snapshot already (setupOwnerTicketListener re-renders per snapshot), so
 * hiding it here is what made the RM/SM list look frozen on "Pending".
 *
 * The one thing this must NEVER do is promise content the manager cannot
 * open yet: a ticket reads "Resolved" ONLY once the superadmin has approved
 * it. So a resolved-but-unapproved ticket (status 'Resolved', queued for
 * review) still reads "Pending Approval", never "Resolved".
 *
 * ⚠️ "For Revision" is an OPERATOR word and never reaches this side. When the
 * superadmin sends a resolution back (status 'For Revision', approvalStatus
 * 'rejected') or the manager's own footage request sends it back
 * (status 'Insufficient Footage'), the manager reads "Pending Approval" —
 * the ticket is back in the queue awaiting sign-off, which is all the
 * manager needs to know. The visible labels are therefore exactly four:
 * Pending / In Progress / Pending Approval / Resolved.
 *
 * Those four words map 1:1 onto badge classes already defined in
 * ownerdashboard.html (.status-badge.pending / .in-progress /
 * .pending-approval / .resolved), so the badge colours follow with no CSS
 * change.
 */
function ticketDisplayStatus(t) {
  if (isApprovedTicket(t)) return 'Resolved';
  const raw = String((t && t.status) || 'Pending').trim();
  const key = raw.toLowerCase();
  // The queued-for-review state: operator resolved, superadmin not signed off.
  // Never "Resolved" — that word promises readable content that is withheld.
  if (key === 'resolved') return 'Pending Approval';
  // Send-back states are operator business: the resolution was rejected or
  // more footage was requested, so the ticket is back awaiting sign-off.
  if (key === 'for revision' || key === 'insufficient footage') return 'Pending Approval';
  return raw || 'Pending';
}

/**
 * ⚠️ DOES THE EXPIRING VIEWING WINDOW APPLY TO WHO IS LOOKING?
 *
 * The 2-day window is the REQUESTER's condition, not an employee's: it exists
 * so a store manager reads a CCTV incident while it is fresh and then asks a
 * superadmin to reopen it if they still need it. HR are staff who review these
 * for a living, and a superadmin has permanent command-centre access anyway, so
 * for both roles the window is enforced nowhere useful — it only withheld the
 * report from someone whose job is to read it.
 *
 * ⚠️ IT IS DELIBERATELY NOT FOLDED INTO isOwnerTicketExpired(). That function
 * answers a factual question about a TICKET ("has its window closed?") and is
 * used by the row badges and the modal alike; mixing in "…and does the current
 * person care" would make it untestable in isolation and would silently change
 * what the pure-function tests assert. Keep the fact and the policy apart:
 *   isOwnerTicketExpired(ticket)  → the fact
 *   expiryAppliesToViewer()       → the policy
 */
function expiryAppliesToViewer() {
  return activeUserRole === 'owner' || activeUserRole === 'rmsm';
}

/**
 * True when a approved ticket's viewing window has already lapsed FOR THE
 * CURRENT VIEWER. This is the predicate every UI decision uses, so HR and
 * superadmins never see an expiry — they simply get `false` here.
 */
function isOwnerTicketExpiredForViewer(ticket) {
  if (!expiryAppliesToViewer()) return false;
  return isOwnerTicketExpired(ticket);
}

/**
 * True when a approved ticket's viewing window has already lapsed.
 *
 * Delegates to the single source of truth in firebase.js rather than
 * re-deriving the arithmetic here, so the Area Manager and the public track
 * page can never disagree about when a ticket expires.
 */
function isOwnerTicketExpired(ticket) {
  if (typeof window.isTrackingAccessExpired !== 'function') return false;
  try {
    return !!window.isTrackingAccessExpired(ticket);
  } catch (e) {
    return false;
  }
}

/** The moment an approved ticket's window closes, or null when untracked. */
function ownerTicketExpiry(ticket) {
  if (typeof window.getTrackingAccessExpiry !== 'function') return null;
  try {
    return window.getTrackingAccessExpiry(ticket) || null;
  } catch (e) {
    return null;
  }
}

// ==============================================================
//  LIVE EXPIRY COUNTDOWN (the Access column + the open modal)
//
//  The window runs from the moment the manager FIRST OPENS the ticket, so the
//  badge has to count DOWN and, above all, has to be VISIBLE while they read.
//  Before this, an open ticket's Access cell was a muted dash: the report simply
//  appeared and the window silently began draining. Nobody could tell that any
//  clock existed, let alone how long was left.
//
//  ⚠️ ONE INTERVAL FOR THE WHOLE PAGE, AND IT EDITS TEXT IN PLACE. This is not
//  `renderOwnerTickets()` on a timer: that rebuilds every row, which would
//  restart the interval, blow away focus and any open dropdown, and re-sort
//  under the manager's cursor. The ticker instead finds the already-rendered
//  nodes and writes only their textContent, so the table is never rebuilt
//  except when something genuinely expires.
// ==============================================================

/**
 * Compact human countdown, largest two units: "45s", "2m 10s", "3h 4m", "2d 3h".
 *
 * ⚠️ DELIBERATELY ADAPTIVE. With the window time-compressed to 1 minute for
 * testing the useful resolution is seconds; at the real 2-day value "47:59:59"
 * would be unreadable. Whole seconds only below an hour keeps the test window
 * legible without making production worse.
 */
function formatAccessCountdown(msLeft) {
    if (msLeft <= 0) return 'expired';
    var s = Math.floor(msLeft / 1000);
    var d = Math.floor(s / 86400); s -= d * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); s -= m * 60;
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
}

/**
 * Markup for one live countdown.
 *
 * Both moments are carried on the node as data attributes: `data-expires-at`
 * (epoch ms) so the ticker can compute what is left without re-deriving the
 * deadline, and `data-window-ms` so urgency can be judged as a FRACTION of the
 * window rather than in absolute seconds. The fraction matters — a fixed
 * "under 10 minutes" rule would be every single second of a time-compressed
 * test window (so permanently red while testing) and would never fire once
 * on a real 2-day window.
 */
function accessCountdownHtml(untilMs, title) {
    var until = Number(untilMs);
    var total = Number(window.TRACKING_ACCESS_WINDOW_MS) || 0;
    return '<span class="owner-access-timer" data-owner-countdown="1"'
        + ' data-expires-at="' + until + '"'
        + ' data-window-ms="' + total + '"'
        + ' title="' + escapeHTML(title || 'Viewing access closes') + '">'
        + escapeHTML(formatAccessCountdown(until - Date.now()))
        + '</span>';
}

let ownerCountdownTicker = null;

/**
 * Tick every live countdown on the page. Cheap enough to run once a second: it
 * touches only the countdown spans and does nothing at all when the Area
 * Manager has no window (HR and superadmins render none).
 */
function tickOwnerCountdowns() {
    var nodes = document.querySelectorAll('[data-owner-countdown]');
    if (!nodes.length) return;

    var now = Date.now();
    var lapsed = false;

    for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var until = Number(el.getAttribute('data-expires-at'));
        if (!until) continue;
        var left = until - now;

        if (left <= 0) {
            lapsed = true;
            el.textContent = 'expired';
            el.classList.add('urgent');
            // ⚠️ MARK THE LAPSED NODE AS HANDLED. The rebuild below ends in
            // startOwnerCountdownTicker(), which runs its FIRST tick
            // synchronously — and the modal's countdown node is still in the
            // DOM with a past deadline (the list rebuild does not touch the
            // modal, and openOwnerReport() re-derives it asynchronously). That
            // nested tick would find this same node, rebuild again, and loop
            // render → tick → render until the stack overflows — which is the
            // "Maximum call stack size exceeded" renderOwnerTickets' own catch
            // reports at its console.error line. Dropping the hook here makes a
            // lapsed countdown a one-shot: the text still reads "expired", but
            // the ticker can never trip on this node twice.
            el.removeAttribute('data-owner-countdown');
            continue;
        }
        el.textContent = formatAccessCountdown(left);
        var total = Number(el.getAttribute('data-window-ms')) || 0;
        el.classList.toggle('urgent', total > 0 && left < total * 0.1);
    }

    // ⚠️ ONCE THE CLOCK RUNS OUT, RE-DERIVE THE UI. The badge must flip to
    // "Access closed" and — the part that actually matters — an OPEN MODAL must
    // begin withholding the report. A manager can sit reading while the window
    // drains, and the evidence is taken away the moment it hits zero.
    if (!lapsed) return;

    // ⚠️ RE-ENTRANCY GUARD. The rebuild calls renderOwnerTickets(), whose tail
    // calls startOwnerCountdownTicker() — and the starter deliberately runs one
    // tick immediately. If that nested tick still sees anything lapsed it would
    // rebuild again from inside its own rebuild: unbounded synchronous
    // recursion that blows the stack (surfacing only as the RangeError caught
    // by renderOwnerTickets' own try/catch). With the flag set, the nested tick
    // returns here; the interval tick once a second is unaffected.
    if (window.__ownerRebuildInFlight) return;
    window.__ownerRebuildInFlight = true;
    try {
        if (ownerCountdownTicker) { clearInterval(ownerCountdownTicker); ownerCountdownTicker = null; }
        try { renderOwnerTickets(ownerAllTicketsCache); } catch (e) { /* the tab still works */ }
        // Re-open the report in place so it re-reads and re-renders the expired
        // notice. markTrackingAccessOpened() is a no-op now the stamp exists, so
        // this cannot restart the clock it just ended.
        if (ownerReopenTicketId) {
            try { window.openOwnerReport(ownerReopenTicketId); } catch (e) { /* ignore */ }
        }
    } finally {
        window.__ownerRebuildInFlight = false;
    }
}

function startOwnerCountdownTicker() {
    if (ownerCountdownTicker) return;
    ownerCountdownTicker = setInterval(tickOwnerCountdowns, 1000);
    tickOwnerCountdowns();
}

/**
 * The window's length as words — "1 minute" while time-compressed, "2 days"
 * in production. Read from firebase.js so reverting
 * TRACKING_ACCESS_WINDOW_MS rewords the UI automatically; never hardcoded.
 */
function ownerAccessWindowLabel() {
  if (typeof window.formatTrackingAccessWindow === 'function') {
    try {
      return window.formatTrackingAccessWindow(window.TRACKING_ACCESS_WINDOW_MS);
    } catch (e) { /* fall through */ }
  }
  return 'the approved window';
}

// ==============================================================
//  RE-ACCESS REQUEST (the Area Manager's "Request Access")
//
//  ⚠️ THE SUPERADMIN SIDE ALREADY EXISTS. `submit-ticket.html` files the same
//  request from the public Track page, and `script.js` renders it in Approvals
//  as the amber "Reopen requested" chip plus an **Approve Request & Resend**
//  button that opens a fresh window and flips status → 'fulfilled'. So this
//  does NOT invent a second workflow: it writes the identical two fields, and
//  the whole superadmin half — the desktop notification, the chip, the confirm
//  dialog that quotes the reason, the "Access Approved" email to
//  requestedByEmail — works unchanged.
//
//  The two fields, and why both are needed:
//    comments[]            a { type: 'access_reopen_request' } note
//                          → countAccessReopenRequests() in js/notifications.js
//                            counts these, so REPEATED asks still notify, while
//                            a Resend (which adds no note) never re-fires.
//    accessReopenRequest   the current state: status / reason / requester /
//                          requestCount — this is what the Approvals chip and
//                          the detail card read.
//
//  ⚠️ The email recipient is `requestedByEmail` FIRST (resolveReopenRecipient),
//  not the ticket's original reporter — a manager asking to re-open their own
//  branch's ticket is a different person from whoever filed it. That is exactly
//  why the account email is stored rather than reusing ticket.email.
// ==============================================================

/** This ticket's latest re-access request state, or null when there is none. */
function ownerReopenState(ticket) {
  if (!ticket) return null;
  const state = ticket.accessReopenRequest;
  return (state && typeof state === 'object') ? state : null;
}

/** True while a request is awaiting the superadmin's approval. */
function ownerReopenPending(ticket) {
  const state = ownerReopenState(ticket);
  return !!state && String(state.status || 'pending') === 'pending';
}

/** Every access_reopen_request note on a ticket, oldest first. */
function ownerReopenNotes(ticket) {
  const comments = (ticket && Array.isArray(ticket.comments)) ? ticket.comments : [];
  return comments.filter((c) => c && c.type === 'access_reopen_request');
}

/**
 * Every footage_request note on a ticket, oldest first.
 *
 * The SAME note type the public Track page appends (submitFootageRequest in
 * submit-ticket.html). js/notifications.js counts and announces exactly this
 * string, so a request filed here joins the existing operator-notification
 * pipeline instead of inventing a second one.
 */
function ownerFootageNotes(ticket) {
  const comments = (ticket && Array.isArray(ticket.comments)) ? ticket.comments : [];
  return comments.filter((c) => c && c.type === 'footage_request');
}

/**
 * True while the latest footage request is still in flight.
 *
 * A filed request moves the ticket to "Insufficient Footage" and back to
 * approvalStatus 'pending', so it leaves this dashboard's approved-only list
 * the moment it is written. It can therefore only be observed as pending when
 * the modal is re-rendered straight after the submit — which is exactly what
 * handleOwnerFootageSubmit does. Once the operator re-resolves and a
 * superadmin re-approves, the ticket returns to the list carrying the note in
 * its history as fulfilled.
 */
function ownerFootagePending(ticket) {
  if (!ownerFootageNotes(ticket).length) return false;
  return String(ticket.status || '') === 'Insufficient Footage';
}

/** The signed-in manager's display name, for `requestedBy`. */
function activeUserDisplayName() {
  if (ownerActiveUserName) return ownerActiveUserName;
  // Fall back to the account email, never a blank "Requester" — the superadmin
  // sees this string in the Approvals chip tooltip and the email recipient line.
  if (typeof auth !== 'undefined' && auth && auth.currentUser && auth.currentUser.email) {
    return String(auth.currentUser.email);
  }
  return 'Area Manager';
}

/**
 * File a re-access request for an expired ticket. Shared by the modal form and
 * anything that wants to ask on the manager's behalf.
 *
 * Returns the promise so a caller can chain, and never throws: the UI reports a
 * failure through `ownerToast` and the inline error, not an unhandled rejection.
 */
function requestOwnerAccess(ticketId, reason, attachment) {
  const clean = String(reason || '').trim();
  if (!ticketId) return Promise.resolve(false);
  if (clean.replace(/\s+/g, '').length < 5) {
    ownerToast('Please tell us why you need access again (at least 5 characters).', 'error');
    return Promise.resolve(false);
  }
  if (!db || typeof db.collection !== 'function') {
    ownerToast('Could not send your request — try again.', 'error');
    return Promise.resolve(false);
  }

  const requestedByEmail = (typeof auth !== 'undefined' && auth && auth.currentUser && auth.currentUser.email)
    ? String(auth.currentUser.email)
    : '';
  const requestedBy = activeUserDisplayName();
  const when = new Date();

  return db.collection('tickets').doc(ticketId).get().then((snap) => {
    if (!snap || !snap.exists) throw new Error('ticket not found');
    const data = snap.data() || {};
    // Re-check the gate on the FRESH document. The button was rendered from a
    // read that may be a minute old, and a ticket that was just resent must
    // not accept a stale request (or one for a ticket that is not approved).
    if (!isOwnerTicketExpiredForViewer(data)) {
      throw new Error('not expired');
    }
    const note = {
      type: 'access_reopen_request',
      text: clean,
      requestedBy: requestedBy,
      requestedByEmail: requestedByEmail,
      requestedByContact: '',
      requestedAt: when,
      attachment: attachment || null
    };
    const prev = ownerReopenState(data);
    const prevCount = (prev && Number(prev.requestCount)) || 0;
    const reopenState = {
      status: 'pending',
      reason: clean,
      requestedBy: requestedBy,
      requestedByEmail: requestedByEmail,
      requestedByContact: '',
      requestedAt: when,
      attachment: attachment || null,
      // Monotonic, so the Approvals chip's ×N is the true number of asks even
      // if two requests are filed in quick succession.
      requestCount: prevCount + 1
    };
    return db.collection('tickets').doc(ticketId).update({
      comments: firebase.firestore.FieldValue.arrayUnion(note),
      accessReopenRequest: reopenState,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }).then(() => {
    ownerToast('Request sent — a superadmin will review it.', 'success');
    return true;
  }).catch((error) => {
    // A ticket that was reopened between render and click is not an error the
    // manager can act on, so it gets its own message.
    if (error && error.message === 'not expired') {
      ownerToast('Access was already reopened for this ticket.', 'info');
    } else {
      console.error('Re-access request error:', error);
      ownerToast('Failed to send your request. Please try again.', 'error');
    }
    return false;
  });
}

/**
 * File an "insufficient footage" request for an approved ticket, sending it
 * back into the resolution pipeline. RESTORED FEATURE — this is the hand-off
 * the public Track page (submit-ticket.html submitFootageRequest) performs,
 * brought back to the Area Manager / RM/SM dashboard for exactly the moment
 * it was removed for: the manager has watched the APPROVED resolution footage
 * and judged it insufficient.
 *
 * The write matches the Track page field-for-field, because every downstream
 * consumer is keyed on those fields:
 *   - `type: 'footage_request'` — js/notifications.js counts and announces
 *     exactly this string, so the operator gets the desktop notification with
 *     no new plumbing;
 *   - `status: 'Insufficient Footage'` — the operator's ticket list surfaces
 *     it for re-work;
 *   - `approvalStatus: 'pending'` — the ticket leaves this approved-only list
 *     and re-enters the pipeline; the operator's next resolve KEEPS the old
 *     clips and adds the new ones (mergeOperatorFootage), and the superadmin's
 *     re-approval re-arms the viewing window (approveResolution +
 *     hasFootageRequestComment). That is the whole documented cycle
 *     (test/footage-accumulation.test.js).
 *
 * Returns the promise so a caller can chain, and never throws: the UI reports
 * failure through `ownerToast`, not an unhandled rejection.
 */
function requestOwnerFootage(ticketId, details) {
  const clean = String(details || '').trim();
  if (!ticketId) return Promise.resolve(false);
  // Same >=5 character rule as both the Track page and requestOwnerAccess(),
  // so the three forms cannot disagree about what counts as a real request.
  if (clean.replace(/\s+/g, '').length < 5) {
    ownerToast('Please describe what footage you need (at least 5 characters).', 'error');
    return Promise.resolve(false);
  }
  if (!db || typeof db.collection !== 'function') {
    ownerToast('Could not send your request — try again.', 'error');
    return Promise.resolve(false);
  }

  const requestedByEmail = (typeof auth !== 'undefined' && auth && auth.currentUser && auth.currentUser.email)
    ? String(auth.currentUser.email)
    : '';
  const requestedBy = activeUserDisplayName();
  const when = new Date();

  return db.collection('tickets').doc(ticketId).get().then((snap) => {
    if (!snap || !snap.exists) throw new Error('ticket not found');
    const data = snap.data() || {};
    // Re-check the gate on the FRESH document: the button was rendered from a
    // read that may be a minute old. Only an APPROVED ticket that is not
    // already in a footage-request cycle may accept a request.
    if (!isApprovedTicket(data)) {
      throw new Error('not approved');
    }
    if (ownerFootagePending(data)) {
      throw new Error('already requested');
    }
    const note = {
      type: 'footage_request',
      text: clean,
      requestedBy: requestedBy,
      requestedByEmail: requestedByEmail,
      requestedAt: when
    };
    return db.collection('tickets').doc(ticketId).update({
      status: 'Insufficient Footage',
      approvalStatus: 'pending',
      comments: firebase.firestore.FieldValue.arrayUnion(note),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }).then(() => {
    ownerToast('Footage request sent — the operator has been notified.', 'success');
    return true;
  }).catch((error) => {
    if (error && error.message === 'not approved') {
      ownerToast('This ticket is no longer approved, so footage cannot be requested.', 'info');
    } else if (error && error.message === 'already requested') {
      ownerToast('Additional footage was already requested for this ticket.', 'info');
    } else {
      console.error('Footage request error:', error);
      ownerToast('Failed to send the request. Please try again.', 'error');
    }
    return false;
  });
}

/**
 * Fill in the Tickets-tab sentence.
 *
 * Uses the same ownerAccessWindowLabel() the expiry notice uses, so the tab
 * blurb and the modal can never quote different windows. Runs from
 * setActiveUser() rather than at load, so it is correct on first paint and
 * after the page's scripts finish wiring.
 */
/**
 * ⚠️ The "Access" column and its filter are about the VIEWING WINDOW, so for
 * HR (and a superadmin) both are meaningless: nothing expires, so the column
 * would be a permanent dash and the filter would match nothing.
 *
 * The column is hidden with CSS rather than by omitting the <th>/<td>, because
 * test/owner-mobile.test.js requires the <th> count in the markup to equal the
 * <td data-label> count in the renderer — and both are STATIC. Dropping a cell
 * in one place and not the other renders an empty cell on a phone
 * (`content: attr(data-label)` on a cell with no attribute is an empty string).
 * "Access" is the 7th of 8 columns; see style in ownerdashboard.html.
 */
function applyViewerExpiryChrome() {
  const showsWindow = expiryAppliesToViewer();

  // The filter dropdown. Hidden rather than emptied: an <option> that can never
  // match is a control that lies about what it does.
  const accessFilterWrap = ownerTicketAccessFilter ? ownerTicketAccessFilter.closest('.filter-group') : null;
  if (ownerTicketAccessFilter) ownerTicketAccessFilter.style.display = showsWindow ? '' : 'none';
  if (accessFilterWrap) accessFilterWrap.style.display = showsWindow ? '' : 'none';

  const table = document.getElementById('ownerTicketsTable');
  if (table) table.classList.toggle('owner-hides-access', !showsWindow);

  renderOwnerWindowNote();

  // The Status filter is manager-only too: HR/superadmin rows are always
  // approved (always "Resolved"), so for them it would be a dead control.
  const statusFilterWrap = ownerTicketStatusFilter ? ownerTicketStatusFilter.closest('.filter-group') : null;
  if (ownerTicketStatusFilter) ownerTicketStatusFilter.style.display = showsWindow ? '' : 'none';
  if (statusFilterWrap) statusFilterWrap.style.display = showsWindow ? '' : 'none';
}

function renderOwnerWindowNote() {
  if (!ownerWindowNote) return;
  try {
    // ⚠️ Only the Area Manager has a window. Telling HR "each stays readable for
    // 2 days" on a page where nothing expires would be a false statement, so the
    // note is withheld rather than reworded.
    if (!expiryAppliesToViewer()) {
      ownerWindowNote.textContent = '';
      return;
    }
    // ⚠️ "AFTER YOU FIRST OPEN IT", NOT "after approval". The window starts
    // when the manager opens the ticket; before that there is no deadline at
    // all, so the old wording described a countdown that is not running yet.
    ownerWindowNote.textContent =
      'Once you open a ticket it stays readable for ' + ownerAccessWindowLabel() +
      '; after that the row remains but the report and evidence are withheld.';
  } catch (e) { /* the tab still works without the note */ }
}

/**
 * Split a ticket's files into the requester's original attachments and the
 * operator's added footage so the two never blend into one list:
 *  - requester files: `requesterAttachments` (written when the ticket is created)
 *  - operator footage: everything else (`resolution.operatorFootage`,
 *    `resolvedAdditionalFootage`)
 *  - legacy tickets that only carry a single merged list show it under the
 *    requester so nothing is hidden from the viewer.
 *
 * ⚠️ THE REQUESTER'S LIST IS AUTHORITATIVE. `requesterAttachments` is written
 * once at ticket creation from the manager's own upload array, so it is an exact
 * record of what THEY attached. This used to instead subtract `operatorFootage`
 * out of the merged list and call the remainder the manager's — which silently
 * re-attributed any clip missing from a truncated `operatorFootage` to the
 * manager. A manager then saw the operator's CCTV filed under "Requester's
 * Attachments". Reading the manager's list directly makes that unrepresentable,
 * and repairs the already-damaged tickets for free.
 *
 * `addedKeys` marks the clips that arrived in response to a footage request, so
 * the caller can ring them without splitting the list into two sections.
 */
function splitOwnerAttachments(rawData) {
  const resolution = (rawData && rawData.resolution) || {};
  let merged = Array.isArray(resolution.attachments) ? resolution.attachments.slice() : [];
  if (merged.length === 0 && rawData && Array.isArray(rawData.attachments)) {
    merged = rawData.attachments.slice();
  }
  if (merged.length === 0 && rawData && rawData.resolutionAttachmentUrl) {
    merged = [{
      secure_url: rawData.resolutionAttachmentUrl,
      name: rawData.resolutionAttachmentName || 'Resolution attachment',
      resource_type: 'raw',
      format: ''
    }];
  }

  let footage = Array.isArray(resolution.operatorFootage) ? resolution.operatorFootage.slice() : [];
  if (footage.length === 0 && rawData && Array.isArray(rawData.resolvedAdditionalFootage)) {
    footage = rawData.resolvedAdditionalFootage.slice();
  }

  const requester = (rawData && Array.isArray(rawData.requesterAttachments)) ? rawData.requesterAttachments.slice() : null;
  const keyOf = (a) => (a && (a.public_id || a.secure_url)) || '';
  const excludeKeys = (list) => new Set((list || []).map(keyOf).filter(Boolean));
  // The clips added in response to a footage request — a SUBSET of the operator's
  // footage, and the only thing that tells an added clip from an original one.
  const addedKeys = excludeKeys(Array.isArray(rawData && rawData.resolvedAdditionalFootage)
    ? rawData.resolvedAdditionalFootage : []);

  if (requester && requester.length > 0) {
    const requesterKeys = excludeKeys(requester);
    return {
      requester: requester,
      operator: merged.filter(a => !requesterKeys.has(keyOf(a))),
      addedKeys: addedKeys
    };
  }
  if (footage.length > 0) {
    const footageKeys = excludeKeys(footage);
    return {
      requester: merged.filter(a => !footageKeys.has(keyOf(a))),
      operator: footage,
      addedKeys: addedKeys
    };
  }
  return { requester: merged, operator: [], addedKeys: addedKeys };
}

window.openOwnerReport = function(reportId) {
  if (!reportId || !db) return;
  // Claim the render BEFORE the async read: if the manager hits × (or a newer
  // ticket is opened) while this read is in flight, the check before the paint
  // discards this render instead of resurrecting a closed modal.
  const gen = ++ownerModalGen;
  // Remembered for the delegated submit handler, which has no access to the
  // rendered form's markup. Cleared when the modal closes so a stale id can
  // never be written to after a different ticket is opened.
  ownerReopenTicketId = reportId;
  // Same for the footage-request form, so the delegated submit always knows
  // which ticket it is filing against.
  ownerFootageTicketId = reportId;
  try { if (window.RefreshState) window.RefreshState.capture('owner', { tab: 'reports', modal: 'report', id: reportId }); } catch (e) { /* ignore */ }

  db.collection('tickets').doc(reportId).get().then(async (snap) => {
    if (!snap.exists) return;

    // Get full ticket data including attachments
    const rawData = snap.data();
    // ⚠️ THE ID MUST BE GRAFTED ON BY HAND. `snap.data()` returns ONLY the
    // document's fields — the id is a property of the SNAPSHOT, not of the
    // data, so `rawData.id` is `undefined` here.
    //
    // That broke the first-open stamp completely: markTrackingAccessOpened() does
    // `db.collection('tickets').doc(ticket.id).update(...)`, which threw on the
    // undefined path before any network call, was swallowed by its own catch, and
    // surfaced as "Could not start the viewing-access timer" — i.e. the viewing
    // window never started for ANY manager, on any ticket, ever.
    //
    // loadOwnerTickets() already gets this right with
    // `snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))`. This line
    // is that same graft, applied to the single-document read.
    rawData.id = reportId;
    const data = normalizeTicketReport(rawData);

    // ⚠️ IS THIS TICKET STILL AWAITING THE SUPERADMIN? Computed from the freshly
    // read document (not a cached list row) and gated to the manager roles, for
    // the same reason the list append is: HR and superadmins have their own
    // review flow and must not be shown a manager's "still pending" shell. When
    // true, the modal renders the pending branch (subject + notice, no payload)
    // instead of the full report — see the `const html = …` assembly below.
    const pendingApproval = isAreaManager() && isPendingApprovalTicket(rawData);

    // ⚠️ FIRST OPEN STARTS THE CLOCK.
    //
    // An approved ticket nobody has opened has NO expiry at all — it does not
    // lapse. This is where that clock begins: the first time THIS manager opens
    // the modal, `accessOpenedAt` is stamped and the window runs from that
    // moment onwards, continuously. Closing the modal stops nothing.
    //
    // ⚠️ ROLE-GATED. Only the Area Manager has a window (expiryAppliesToViewer()
    // is `activeUserRole === 'owner'`). HR and superadmins read these tickets for
    // a living; stamping on THEIR behalf would silently start — and burn — the
    // manager's window during someone else's review, which is the exact failure
    // this feature exists to prevent.
    // ⚠️ NO SILENT SKIP. This block used to read
    //     `expiryAppliesToViewer() && typeof window.markTrackingAccessOpened === 'function'`
    // and simply do nothing when the helper was missing. That guard turned "the
    // expiry code is not loaded" — a stale cached firebase.js, the most likely
    // cause — into "this ticket never expires", with no error, no toast and
    // nothing in the console. The symptom was indistinguishable from the
    // feature working as designed.
    //
    // Both halves now report. A missing helper is a DEPLOYMENT problem and says
    // so loudly, because until it is fixed no approved ticket on this page can
    // ever expire. An expected decline (already stamped, legacy ticket) stays
    // quiet — those are correct behaviour, not failures.
    //
    // ⚠️ SKIPPED FOR A PENDING TICKET. A not-yet-approved ticket has no viewing
    // window at all, so there is no clock to start — markTrackingAccessOpened()
    // would decline with 'not-approved' anyway. Skipping it here keeps the intent
    // explicit (and avoids a pointless write attempt) rather than relying on the
    // helper's own guard.
    if (expiryAppliesToViewer() && !pendingApproval) {
        if (typeof window.markTrackingAccessOpened !== 'function') {
            // ⚠️ LOUD ON PURPOSE. This is the stale-cache case, and it silently
            // disables the entire viewing window for every manager on this page.
            console.error(
                '[expiry] window.markTrackingAccessOpened is not defined — this page is ' +
                'running a STALE firebase.js. Approved tickets will NEVER expire. Hard-refresh ' +
                '(Ctrl+Shift+R) and confirm firebase.js has been re-fetched.'
            );
            if (typeof ownerToast === 'function') {
                ownerToast('Viewing-access expiry is not active on this page — reload with Ctrl+Shift+R.', 'error');
            }
        } else {
            const result = await window.markTrackingAccessOpened(rawData);
            // ⚠️ TWO FAILURE CLASSES, HANDLED DIFFERENTLY.
            //
            // 'no-id' is a BUG in this page, not a condition the manager
            // caused — the ticket was read without its document id attached. It
            // gets the same loud treatment as a missing helper, because until it
            // is fixed no window on this page can ever start.
            //
            // 'write-failed' is an environment problem (offline, rules). The
            // report itself still renders, so the manager gets a toast.
            //
            // Everything else — already-stamped (a normal second open),
            // legacy-no-marker (predates the feature), not-approved — is correct
            // behaviour and stays QUIET. Toasting on those would train people to
            // dismiss toasts without reading them, and the one time it matters
            // is the time they would have learned to ignore it.
            if (result && result.stamped === false && result.reason === 'no-id') {
                console.error(
                    '[expiry] the ticket object passed to markTrackingAccessOpened has no id. ' +
                    'Firestore snap.data() returns fields only — the id must be grafted on ' +
                    'from snap.id. No viewing window can start until this is fixed.'
                );
                if (typeof ownerToast === 'function') {
                    ownerToast('Viewing-access timer cannot start on this page — a code fix is needed.', 'error');
                }
            } else if (result && result.stamped === false && result.reason === 'write-failed') {
                console.error('[expiry] could not record the first-open moment:', result.error);
                if (typeof ownerToast === 'function') {
                    ownerToast('Could not start the viewing-access timer for this ticket.', 'error');
                }
            }
        }
    }

    // Attachment cards come from the SHARED builder in js/attachment-viewer.js —
    // the same .attachment-item card the five grids in script.js render. This
    // used to be a local buildAttachmentRow() that emitted a bare icon chip
    // (owner-attachment-row) with NO thumbnail, plus a third getAttachmentColor
    // that disagreed with script.js's, so the same CCTV clip looked like a
    // thumbnail card on one dashboard and a grey icon row on the other.
    // Clicking a card opens the shared viewer.
    function buildAttachmentRow(att, index, added) {
        const v = window.AttachmentViewer;
        if (!v) return '';
        // `added` rings the clip as footage that arrived in response to a
        // request. The shared builder takes it as an OPT, so every other grid
        // that calls this same function is unaffected.
        return v.buildAttachmentCard(att, { index: index || 0, added: !!added });
    }
    // Split the ticket's files into requester attachments vs operator footage
    const attachments = splitOwnerAttachments(rawData);

    // Status badge in the modal header. A pending ticket shows its live pipeline
    // label via the same ticketDisplayStatus() the list row uses, so the header
    // and the row never disagree about the same ticket.
    const statusText = pendingApproval ? ticketDisplayStatus(rawData) : String(data.status || 'Resolved');
    const statusClass = statusText.toLowerCase().replace(/\s+/g, '-');
    if (ownerReportDetailsStatus) {
      ownerReportDetailsStatus.textContent = statusText;
      ownerReportDetailsStatus.className = 'status-badge ' + statusClass;
      ownerReportDetailsStatus.style.display = 'inline-flex';
    }

    const resolution = (rawData && rawData.resolution) || {};
    // NOTE: the operator's identity (resolvedBy) is intentionally NOT shown to
    // owners here — their name/email is private. Only the timestamp + notes are
    // displayed in the Operator's Resolution card.
    const resolvedAt = formatDate(resolution.resolvedAt || rawData.resolvedAt || null);
    const resNotes = resolution.notes || rawData.resolutionNotes || 'No resolution notes provided.';

    // Render the file lists, skipping any broken entries (no link)
    const requesterFiles = attachments.requester.filter(a => a && (a.secure_url || a.url));
    const operatorFiles = attachments.operator.filter(a => a && (a.secure_url || a.url));
    const addedKeys = attachments.addedKeys || new Set();
    // ⚠️ `.map(fn)` would call fn(value, INDEX, THE WHOLE ARRAY) — and that third
    // argument is a truthy Array, so passing buildAttachmentRow straight to map
    // would ring EVERY clip as "added". Both groups are wrapped so the flag is
    // a real decision. Only the operator group is ever marked: the manager's own
    // uploads are the original request, never "added footage".
    const requesterAttHtml = requesterFiles.length > 0
      ? requesterFiles.map((a, i) => buildAttachmentRow(a, i, false)).join('')
      : '<p class="review-empty-files">No files available.</p>';
    const operatorAttHtml = operatorFiles.length > 0
      ? operatorFiles.map((a, i) => buildAttachmentRow(a, i, addedKeys.has(a.public_id || a.secure_url))).join('')
      : '<p class="review-empty-files">No files available.</p>';

    // ⚠️ THE EXPIRY GATE — the sensitive payload is withheld, not the row.
    //
    // An approved ticket whose viewing window has lapsed keeps its METADATA
    // (who, where, when, which incident) so the manager can still see that it
    // exists and chase it, but the issue description, the operator's findings
    // and EVERY attachment — the CCTV evidence — are the things the window
    // exists to protect, and none of them are rendered.
    //
    // It is checked HERE, at the point of rendering, not in the list: the list
    // is a live listener, so a ticket that expires while the page is open
    // would still be clickable, and a check on the row alone would then open
    // the full report for a ticket whose window closed a second ago.
    //
    // ⚠️ The withheld text must not leak through any other field: `resNotes`
    // and `data.description` are the two that carry findings, and both are only
    // interpolated inside the sections that this branch replaces wholesale.
    const expired = isOwnerTicketExpiredForViewer(rawData);
    const expiresAt = ownerTicketExpiry(rawData);
    const windowLabel = ownerAccessWindowLabel();

    // ===== The re-access request UI, shown inside the expired notice =====
    //
    // THREE states, so a manager is never asked to re-request something already
    // in flight (the Approvals chip would just show ×2 for the same ask):
    //   no request      → the reason form
    //   pending         → "Awaiting approval" (and the form is gone)
    //   fulfilled       → "Fulfilled — access resent on <date>"
    // A request already pending also means the ticket is ABOUT to be reopened,
    // so the form is hidden rather than disabled: a greyed button invites
    // people to click it twice.
    const reopen = ownerReopenState(rawData);
    const reopenPending = ownerReopenPending(rawData);
    const reopenNotes = ownerReopenNotes(rawData);
    const reopenFormHtml = reopenPending
      ? `<div class="owner-reopen-status pending">
           <i class="fas fa-hourglass-half"></i>
           Awaiting approval — a superadmin has your request and will reopen access if they approve it.
           ${reopen && reopen.requestedAt ? `<span class="owner-reopen-when">Requested ${escapeHTML(formatDate(reopen.requestedAt))}</span>` : ''}
         </div>`
      : `<form class="owner-reopen-form" id="ownerReopenForm">
           <label for="ownerReopenReason"><i class="fas fa-key"></i> Request to open this ticket again</label>
           <textarea id="ownerReopenReason" rows="3" maxlength="500"
                     placeholder="Why do you need this again? e.g. dispute follow-up, audit, insurance claim"></textarea>
            <label for="ownerReopenAttachment" style="font-size:0.85rem;font-weight:600;display:block;margin:6px 0 2px;"><i class="fas fa-paperclip"></i> Police report (optional)</label>
            <label for="ownerReopenAttachment" class="btn btn-outline btn-sm" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;margin-bottom:6px;cursor:pointer;"><i class="fas fa-upload"></i> Choose file</label>
            <input type="file" id="ownerReopenAttachment" accept="image/*,application/pdf" style="display:none;">
           <div class="owner-reopen-actions">
             <span class="owner-reopen-hint">A superadmin reviews every request. Nothing is reopened automatically.</span>
             <button type="submit" class="btn btn-primary btn-sm" id="ownerReopenSubmit">
               <i class="fas fa-paper-plane"></i> Send request
             </button>
           </div>
         </form>`;

    // ===== Request additional footage (Area Manager / RM/SM only) =====
    //
    // RESTORED FEATURE — the form removed from this dashboard is back, and it
    // belongs exactly here: the manager has just watched the APPROVED
    // resolution footage and decided it is not enough. The write is the same
    // hand-off the public Track page performs (see requestOwnerFootage), so
    // the ticket re-enters the pipeline with the operator notified and the
    // existing clips preserved for the next round.
    //
    // ROLE-GATED to isAreaManager() ('owner' + 'rmsm'): HR and superadmins
    // have their own review flow and must not re-open a manager's decision.
    // Shown only while access is OPEN — asking for more evidence on a ticket
    // whose footage is already withheld makes no sense; the re-access form
    // above is the right tool there.
    const footageNotes = ownerFootageNotes(rawData);
    const footagePending = ownerFootagePending(rawData);
    const latestFootageNote = footageNotes.length ? footageNotes[footageNotes.length - 1] : null;
    const footageFormHtml = footagePending
      ? `<div class="owner-footage-status pending">
           <i class="fas fa-hourglass-half"></i>
           Additional footage requested — the operator has been notified.
           ${latestFootageNote && latestFootageNote.requestedAt ? `<span class="owner-footage-when">Requested ${escapeHTML(formatDate(latestFootageNote.requestedAt))}</span>` : ''}
         </div>`
      : `<form class="owner-footage-form" id="ownerFootageForm">
           <label for="ownerFootageDetails"><i class="fas fa-video"></i> Request additional footage</label>
           <textarea id="ownerFootageDetails" rows="3" maxlength="500"
                     placeholder="What else do you need? e.g. a wider angle covering the exit, a clearer view of the suspect"></textarea>
           <div class="owner-footage-actions">
             <span class="owner-footage-hint">The operator is notified and the ticket goes back for re-work. Nothing is approved automatically.</span>
             <button type="submit" class="btn btn-primary btn-sm" id="ownerFootageSubmit">
               <i class="fas fa-paper-plane"></i> Request footage
             </button>
           </div>
         </form>`;
    // The history of previous asks, mirroring the public Track page.
    const footageHistoryHtml = footageNotes.length
      ? `<div class="owner-footage-history">
           <h4>Footage request history</h4>
           ${footageNotes.map((n, i) => {
             const isLatest = i === footageNotes.length - 1;
             const fulfilled = !isLatest || !footagePending;
             return `<div class="owner-footage-item">
               <div class="owner-footage-item-text">${escapeHTML(n.text || '—')}</div>
               <div class="owner-footage-item-meta">
                 ${escapeHTML(n.requestedBy || 'Area Manager')}${n.requestedAt ? ' · ' + escapeHTML(formatDate(n.requestedAt)) : ''}
               </div>
               <div class="owner-footage-status ${fulfilled ? 'fulfilled' : 'pending'}">
                 ${fulfilled ? 'Fulfilled' : 'Awaiting re-work'}
               </div>
             </div>`;
           }).join('')}
         </div>`
      : '';
    const footageHtml = isAreaManager() && !expired
      ? `<div class="review-card footage${footageNotes.length && !footagePending ? ' review-fulfilled' : ''}">
           <div class="review-card-header">
             <h3><i class="fas fa-video"></i> Additional Footage</h3>
           </div>
           ${footageFormHtml}
           ${footageHistoryHtml}
         </div>`
      : '';

    const html = expired ? `
      <!-- ===== EXPIRED: metadata only, no payload ===== -->
      <div class="owner-access-expired">
        <p class="owner-access-expired-title"><i class="fas fa-lock"></i> Viewing access expired</p>
        <p class="owner-access-expired-body">
          The ${escapeHTML(windowLabel)} viewing window for this approved ticket has closed,
          so the report and its CCTV evidence are no longer available here.
          You can ask a superadmin to open it again.
        </p>
        ${expiresAt ? `<p class="owner-access-expired-when">Access closed ${escapeHTML(formatDate(expiresAt))}</p>` : ''}
        ${reopenFormHtml}
      </div>

      <div class="review-card">
        <div class="review-card-header">
          <h3><i class="fas fa-ticket-alt"></i> Ticket Details</h3>
        </div>
        <div class="review-meta-grid">
          <div class="review-meta"><label>Ticket Number</label><span>${escapeHTML(data.ticketNumber || data.id || 'N/A')}</span></div>
          <div class="review-meta"><label>Branch</label><span>${escapeHTML(data.branchName)}</span></div>
          <div class="review-meta"><label>Reporter</label><span>${escapeHTML(data.authorName)}</span></div>
          <div class="review-meta"><label>Reported Date</label><span>${escapeHTML(formatDate(data.submittedAt))}</span></div>
          <div class="review-meta"><label>Incident</label><span>${escapeHTML(data.title)}</span></div>
          <div class="review-meta"><label>Priority</label><span>${escapeHTML(data.priority || '—')}</span></div>
          <div class="review-meta"><label>Status</label><span>${escapeHTML(data.status || 'Resolved')}</span></div>
          <div class="review-meta"><label>Resolved At</label><span>${escapeHTML(resolvedAt)}</span></div>
        </div>
        <div class="owner-withheld-note">
          <i class="fas fa-eye-slash"></i>
          Issue description, operator findings and all attachments are withheld while access is closed.
        </div>
      </div>
    ` : pendingApproval ? `
      <!-- ===== PENDING APPROVAL: subject + notice, NO payload ===== -->
      <!-- ⚠️ Mirrors the expired branch above on purpose: the row stays and the
           manager sees WHICH ticket this is, but the issue description, the
           operator's findings and every attachment stay withheld until the
           superadmin approves it. There is no viewing window yet, so — unlike
           the expired case — there is nothing to count down and nothing to
           request re-access to. -->
      <div class="owner-access-pending">
        <p class="owner-access-pending-title"><i class="fas fa-hourglass-half"></i> Approval still Pending</p>
        <p class="owner-access-pending-body">
          This ticket has not been approved by the admin yet, so the report and its
          CCTV evidence are not available here. It will open in full once the
          superadmin approves it. The subject is shown below so you can tell which
          ticket this is.
        </p>
      </div>

      <div class="review-card">
        <div class="review-card-header">
          <h3><i class="fas fa-ticket-alt"></i> Ticket Details</h3>
        </div>
        <div class="review-meta-grid">
          <div class="review-meta"><label>Ticket Number</label><span>${escapeHTML(data.ticketNumber || data.id || 'N/A')}</span></div>
          <div class="review-meta"><label>Branch</label><span>${escapeHTML(data.branchName)}</span></div>
          <div class="review-meta"><label>Reporter</label><span>${escapeHTML(data.authorName)}</span></div>
          <div class="review-meta"><label>Reported Date</label><span>${escapeHTML(formatDate(data.submittedAt))}</span></div>
          <div class="review-meta"><label>Subject</label><span>${escapeHTML(data.title || '—')}</span></div>
          <div class="review-meta"><label>Priority</label><span>${escapeHTML(data.priority || '—')}</span></div>
          <div class="review-meta"><label>Status</label><span>${escapeHTML(ticketDisplayStatus(rawData))}</span></div>
        </div>
        <div class="owner-withheld-note">
          <i class="fas fa-eye-slash"></i>
          Issue description, operator findings and all attachments are withheld until this ticket is approved.
        </div>
      </div>
    ` : `
      <div class="data-privacy-warning" role="alert" style="margin:0 0 12px;padding:10px 12px;border:1px solid #f59e0b;background:rgba(245,158,11,0.12);border-radius:8px;color:var(--text-primary);display:flex;gap:10px;align-items:flex-start;">
        <i class="fas fa-exclamation-triangle" style="color:#f59e0b;margin-top:2px;"></i>
        <div>
          <strong>Warning:</strong> Confidential information. Do not share this to anyone. Unauthorized disclosure may result in penalties or may kaparusahan sa batas under Republic Act No. 10173 (Data Privacy Act of 2012) of the Philippines.
        </div>
      </div>
      <!-- ===== SECTION 1: REQUESTER'S ORIGINAL REQUEST (collapsible, on top) ===== -->
      <details class="review-collapse">
        <summary>
          <span class="review-collapse-title"><i class="fas fa-user-tie"></i> Requester's Original Request</span>
          <span class="review-collapse-sub"><i class="fas fa-user-circle"></i> Submitted by ${escapeHTML(data.authorName)}</span>
          <i class="fas fa-chevron-down review-collapse-caret"></i>
        </summary>
        <div class="review-collapse-body">
          <div class="review-meta-grid">
            <div class="review-meta"><label>Ticket Number</label><span>${escapeHTML(data.ticketNumber || data.id || 'N/A')}</span></div>
            <div class="review-meta"><label>Branch</label><span>${escapeHTML(data.branchName)}</span></div>
            <div class="review-meta"><label>Reporter</label><span>${escapeHTML(data.authorName)}</span></div>
            <div class="review-meta"><label>Reported Date</label><span>${escapeHTML(formatDate(data.submittedAt))}</span></div>
            <div class="review-meta"><label>Incident</label><span>${escapeHTML(data.title)}</span></div>
            <div class="review-meta"><label>Incident Date</label><span>${escapeHTML(data.datetime || data.dateTime || '—')}</span></div>
            <div class="review-meta"><label>Location</label><span>${escapeHTML(data.location || '—')}</span></div>
            <div class="review-meta"><label>Priority</label><span>${escapeHTML(data.priority || '—')}</span></div>
            <div class="review-meta"><label>Position</label><span>${escapeHTML(data.position || '—')}</span></div>
            <div class="review-meta"><label>Contact</label><span>${escapeHTML(data.contact || '—')}</span></div>
            <div class="review-meta full"><label>Email</label><span>${escapeHTML(data.email || '—')}</span></div>
            <div class="review-meta full"><label>Issue Description</label><p class="review-note">${escapeHTML(data.description || 'No description provided.')}</p></div>
          </div>
          <div class="review-attachments-label"><i class="fas fa-paperclip"></i> Requester's Attachments <span>(${requesterFiles.length})</span></div>
          <div class="owner-attachment-list">${requesterAttHtml}</div>
        </div>
      </details>

      <!-- ===== SECTION 2: OPERATOR'S RESOLUTION ===== -->
      <div class="review-card operator">
        <div class="review-card-header">
          <h3><i class="fas fa-video"></i> Operator's Resolution Report</h3>
        </div>
        <div class="review-meta-grid">
          <div class="review-meta"><label>Resolved At</label><span>${escapeHTML(resolvedAt)}</span></div>
          <div class="review-meta"><label>Status</label><span>${escapeHTML(data.status || 'Resolved')}</span></div>
          <div class="review-meta full"><label>Action Taken / Findings</label><p class="review-note">${escapeHTML(resNotes)}</p></div>
        </div>
        <!-- ⚠️ WAS "Operator's Added Footage". Now that clips added in response to
             a footage request carry their own ring + badge, calling the WHOLE list
             "added" would contradict the marking inside it — the original clips
             are not added. The manager's own heading is untouched. -->
        <div class="review-attachments-label"><i class="fas fa-film"></i> Operator's Resolution Footage <span>(${operatorFiles.length})</span></div>
        <div class="owner-attachment-list">${operatorAttHtml}</div>
      </div>

      <!-- ===== SECTION 3: REQUEST ADDITIONAL FOOTAGE (Area Manager / RM/SM only) ===== -->
      ${footageHtml}
    `;

    // ⚠️ A LIVE CLOCK INSIDE THE MODAL, not just in the list. The manager reads the
    // report HERE, with the footage on screen, and that is exactly when the
    // window is draining. A countdown they can only see by closing the modal and
    // looking at the table would be useless. When it reaches zero the ticker
    // re-opens this same modal, which swaps in the expired notice and withholds
    // the payload.
    // ⚠️ THE VIEWER, NOT JUST THE TICKET. `expiresAt` above is the FACT — this
    // approved ticket carries a deadline (stamped on first open, or derived from
    // approval). Whether that deadline means anything to the person looking is
    // the POLICY in expiryAppliesToViewer(): HR and superadmins have no window.
    // Without this gate the banner renders for HR anyway — expired is false and
    // expiresAt is a real Date — and lands reading "expired" (the stamp is in
    // the past) on a report they can read in full, which looks like access was
    // refused. Mirrors the Access column's windowAccessExpiry in
    // renderOwnerTickets(), which is gated the same way.
    const bannerExpiry = expiryAppliesToViewer() ? expiresAt : null;
    const modalBanner = (expired || !bannerExpiry)
      ? ''
      : '<div class="owner-access-live">'
        + '<i class="fas fa-hourglass-half"></i> Viewing access closes in '
        + accessCountdownHtml(bannerExpiry.getTime(),
            'Viewing access closes ' + formatDate(bannerExpiry))
        + '</div>';

    // ⚠️ PAINT ONLY IF THIS RENDER IS STILL THE LATEST INTENT. The read above is
    // async: a × click (closeOwnerReportModalFn bumps the generation) or a newer
    // open can land first, and painting here would re-show a modal the manager
    // just dismissed — the "close it twice" bug. The data stamps above still ran
    // because they describe the READ, not the display.
    if (gen !== ownerModalGen) return;

    if (ownerReportModalBody) ownerReportModalBody.innerHTML = modalBanner + html;
    if (ownerReportModal) ownerReportModal.classList.add('active');

    // ⚠️ START ONLY FOR A VIEWER WITH A REAL, RUNNING WINDOW. HR and superadmins
    // get no countdown (nothing expires for them), so spinning an interval that
    // would find zero nodes every second would be pure waste. `bannerExpiry` is
    // the gate, NOT `expiresAt`: the fact exists for every viewer, the window
    // does not — and with a past stamp the ticker would otherwise "expire" a
    // banner HR should never have been shown, rebuilding the list and re-opening
    // the modal under them for no reason.
    if (!expired && bannerExpiry) startOwnerCountdownTicker();
  }).catch((error) => {
    console.error('Failed to open report:', error);
  });
};

/**
 * Submit handler for the "Request to open this ticket again" form.
 *
 * DELEGATED from the modal body, and bound ONCE, because the body is
 * re-rendered on every open: a listener attached to the form itself would be
 * discarded each time, and one attached inside the render would stack up.
 *
 * Re-reads the ticket and re-renders afterwards so the row flips to the amber
 * "Reopen requested" chip immediately — the manager should not have to close
 * and reopen the modal to see that their request landed.
 */
function handleOwnerReopenSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (!form || form.id !== 'ownerReopenForm') return;

  const reasonEl = $owner('ownerReopenReason');
  const reason = reasonEl ? reasonEl.value : '';
  const ticketId = ownerReopenTicketId;
  if (!ticketId) {
    ownerToast('Could not tell which ticket this is. Close and reopen it.', 'error');
    return;
  }

  const btn = $owner('ownerReopenSubmit');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
  }

  // Optional police-report attachment (uploaded before the request is filed).
  const fileInput = $owner('ownerReopenAttachment');
  const file = fileInput && fileInput.files && fileInput.files.length ? fileInput.files[0] : null;
  const uploadAndSend = async () => {
    let attachment = null;
    if (file) {
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...'; }
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('upload_preset', 'jiangnan');
        formData.append('folder', 'tickets/' + ticketId + '/reopen');
        const res = await fetch('https://api.cloudinary.com/v1_1/jlux07ne/auto/upload', { method: 'POST', body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error((data && data.error && data.error.message) || 'upload failed');
        attachment = { url: data.secure_url, publicId: data.public_id, fileName: data.original_filename || file.name, mimeType: file.type, bytes: data.bytes || file.size };
      } catch (e) {
        console.error('Police report upload failed:', e);
        ownerToast('Could not upload the police report. Please try again.', 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
        return false;
      }
    }
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...'; }
    const ok = await requestOwnerAccess(ticketId, reason, attachment);
    if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    if (ok) {
      // Re-render from the fresh document so the pending state is real data,
      // not an optimistic guess — a request that was recorded server-side is
      // what must be shown.
      window.openOwnerReport(ticketId);
    }
    return ok;
  };
  uploadAndSend();
}

/**
 * Submit handler for the "Request additional footage" form.
 *
 * DELEGATED from the modal body and bound ONCE, for the same reason as the
 * re-access submit: the body is re-rendered on every open, so a per-render
 * listener would stack up and fire one request per open.
 *
 * Re-reads the ticket and re-renders afterwards so the pending state is real
 * data from the write that landed, not an optimistic guess.
 */
function handleOwnerFootageSubmit(event) {
  event.preventDefault();
  const form = event.target;
  if (!form || form.id !== 'ownerFootageForm') return;

  const detailsEl = $owner('ownerFootageDetails');
  const details = detailsEl ? detailsEl.value : '';
  const ticketId = ownerFootageTicketId;
  if (!ticketId) {
    ownerToast('Could not tell which ticket this is. Close and reopen it.', 'error');
    return;
  }

  const btn = $owner('ownerFootageSubmit');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
  }

  requestOwnerFootage(ticketId, details).then((ok) => {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
    if (ok) {
      // Re-render from the fresh document so the pending state reflects the
      // write that actually landed.
      window.openOwnerReport(ticketId);
    }
  });
}


function closeOwnerReportModalFn() {
  // The X only HIDES the modal — "close" here means dismiss the dialog, never
  // resolve the ticket. Ownership of a close/write belongs to the operator +
  // superadmin approval flow, not the manager's read-only viewer.
  if (ownerReportModal) ownerReportModal.classList.remove('active');
  // Invalidate any open still waiting on its Firestore read: without this its
  // resolve re-adds `active` and the modal needs a SECOND × click to stay shut.
  ownerModalGen++;
  // The re-access form's ticket id is only valid while the modal is open.
  ownerReopenTicketId = '';
  // Same for the footage-request form.
  ownerFootageTicketId = '';
  // ⚠️ THE CLOCK IS NOT STOPPED BY CLOSING THE MODAL — the expiry keeps running,
  // which is the whole rule. Only the DISPLAY is torn down: the interval would
  // otherwise tick against hidden nodes, costing a document sweep every second
  // for nothing. The list rows carry their own countdowns, so anything still on
  // screen keeps ticking.
  if (ownerCountdownTicker && !document.querySelector('[data-owner-countdown]')) {
    clearInterval(ownerCountdownTicker);
    ownerCountdownTicker = null;
  }

  try { if (window.RefreshState) window.RefreshState.clearModal('owner'); } catch (e) { /* ignore */ }
}

/**
 * Load the tickets scoped to the branches this owner owns / has access to.
 * Superadmins see tickets for every branch; owners/editors/viewers only see
 * tickets from their assigned (owned) branches.
 */
function renderOwnerTickets(allTickets) {
  // Tickets date-period filter (Today / Last 7 days / This month / All).
  // Defaults to TODAY on load (the markup's `selected` option) — the manager
  // triages today's work first, and "All" stays one click away for older
  // tickets. Purely a VIEW filter — nothing is deleted; a ticket outside the
  // selected period stays in Firestore and returns with "All". Age is measured
  // from when the ticket was FILED (`submittedAt`, which normalizeTicketReport()
  // resolves from createdAt/dateCreated/submittedAt/...). Tickets without a
  // usable date are always KEPT — safer than hiding a real ticket with a
  // missing timestamp.
  const OWNER_TICKET_PERIODS = { daily: 1, weekly: 7, monthly: 'month', all: 0 };
  const periodValue = (ownerTicketPeriodFilter && ownerTicketPeriodFilter.value) || 'daily';
  const selectedPeriod = OWNER_TICKET_PERIODS[periodValue] !== undefined ? periodValue : 'daily';
  let periodStart = null;
  if (selectedPeriod !== 'all') {
    periodStart = new Date();
    periodStart.setHours(0, 0, 0, 0);
    if (selectedPeriod === 'weekly') periodStart.setDate(periodStart.getDate() - 6);
    else if (selectedPeriod === 'monthly') periodStart.setDate(1);
    // 'daily' → today 00:00
  }
  try {
    if (!ownerTicketsBody) return;

    if (!db || typeof db.collection !== 'function') {
      ownerTicketsBody.innerHTML = '<tr><td colspan="9" class="empty-state"><em>Firebase is unavailable.</em></td></tr>';
      return;
    }

    // Branch owners, HR and superadmins may only view APPROVED tickets.
    // HR is deliberately included: it is an owner in every respect except
    // chat access, so it must not gain a wider ticket scope by accident.
    const ownerResolvedOnly = activeUserRole === 'owner' || activeUserRole === 'hr' || activeUserRole === 'rmsm' || activeUserIsSuperAdmin;

    // ⚠️ THE ACCESS SPLIT — expired vs not expired. Plain labels, no counts.
    // 'all' is the default so nothing disappears on load, and an unrecognised
    // value falls through to "show everything" so an <option> added to the
    // markup before this script is updated cannot blank the list.
    const selectedAccess = ownerTicketAccessFilter ? ownerTicketAccessFilter.value : 'all';
    // ⚠️ THE STATUS FILTER matches the badge, not the raw field. The row renders
    // pendingApproval ? ticketDisplayStatus(t) : raw status (see statusLabel
    // below); filtering on anything else would let the dropdown and the badge
    // disagree about the same row. 'all' is the default so nothing hides on
    // load, and an unrecognised value falls through to "show everything".
    const selectedTicketStatus = ownerTicketStatusFilter ? ownerTicketStatusFilter.value : 'all';
    const statusLabelMatches = (t, status) => {
      if (selectedTicketStatus === 'all') return true;
      const pendingApproval = isAreaManager() && isPendingApprovalTicket(t);
      const label = pendingApproval ? ticketDisplayStatus(t) : String(status || 'Pending').trim();
      return label === selectedTicketStatus;
    };
    const selectedBranch = ownerTicketBranchFilter ? ownerTicketBranchFilter.value : '';
    const searchText = ownerTicketSearch ? ownerTicketSearch.value.trim().toLowerCase() : '';

    const allRaw = Array.isArray(allTickets) ? allTickets : [];
    let tickets = allRaw.map((doc) => normalizeTicketReport(doc));

    // ⚠️ THE APPROVAL GATE. A ticket is only shown once the SUPERADMIN has
    // approved it. `status === 'Resolved'` alone is NOT that signal — it also
    // matches work still queued for review ('pending_approval') and work sent
    // back for revision ('rejected'), neither of which the manager should be
    // reading. An expired-but-approved ticket is deliberately NOT filtered out
    // here: it stays listed, badged, with its content withheld (openOwnerReport).
    if (ownerResolvedOnly) {
      tickets = tickets.filter((t) => isApprovedTicket(t));
    }
    // Hide HR-transferred tickets from Area Manager/RM/SM dashboard entirely.
    if (isAreaManager()) {
      tickets = tickets.filter((t) => t.ticketTransferTo !== 'hr');
    }

    // The Resolved-only scope, kept EXPLICIT rather than left implicit in the
    // approval gate above. test/chat-ticket-mentions.test.js asserts this exact
    // line, because js/chat.js's @ticket picker mirrors the same scope.
    let selectedStatus = 'all';
    if (ownerResolvedOnly) selectedStatus = 'Resolved';

    // Restrict to the owner's assigned branches (superadmin sees all branches).
    const allowedBranches = activeUserIsSuperAdmin ? ownerAllBranches : ownerAssignedBranches;
    tickets = tickets.filter((t) => {
      const branch = String(t.branch || t.branchName || '').trim();
      return allowedBranches.includes(branch);
    });

    if (selectedBranch) {
      tickets = tickets.filter((t) => String(t.branch || t.branchName || '').trim() === selectedBranch);
    }

    if (selectedStatus !== 'all') {
      tickets = tickets.filter((t) => String(t.status || 'Pending').trim() === selectedStatus);
    }

    // (No priority filter on this dashboard — the priority dot on each row
    // already carries that signal, so a separate dropdown added noise, not value.)

    // ⚠️ THE STATUS FILTER applies to the badge label, not the raw field — via
    // statusLabelMatches(), which reuses the row's own label expression. For an
    // approved row the label IS the raw status, so 'Resolved' keeps matching
    // exactly as the force-locked `selectedStatus` above already required.
    tickets = tickets.filter((t) => statusLabelMatches(t, t.status));

    if (searchText) {
      tickets = tickets.filter((t) => {
        const haystack = [
          t.ticketNumber, t.title, t.incident, t.authorName, t.author,
          t.reporter, t.name, t.branch, t.branchName, t.description, t.location
        ]
          // The Date Created column, in the formats users type ("10/10/2026"
          // and ISO "2026-10-10"), so a date is searchable.
          .concat(dateSearchTokens(t.submittedAt))
          .filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(searchText);
      });
    }

    // ⚠️ The EXPIRED predicate is the SAME helper the row badges use, so the
    // filter and the badge can never disagree about which rows are expired.
    const accessMatches = (t) => {
      if (selectedAccess === 'active') return !isOwnerTicketExpiredForViewer(t);
      if (selectedAccess === 'expired') return isOwnerTicketExpiredForViewer(t);
      return true;
    };
    tickets = tickets.filter(accessMatches);

    // Period window (Today / Last 7 days / This month / All) on the filed date.
    // Same "keep dateless rows" rule as the violations list, so a ticket whose
    // timestamp is missing is never silently dropped from the manager's view.
    if (periodStart) {
      tickets = tickets.filter((t) => {
        const raw = t.submittedAt;
        const d = raw && raw.toDate ? raw.toDate() : (raw ? new Date(raw) : null);
        if (!d || isNaN(d.getTime())) return true;
        return d.getTime() >= periodStart.getTime();
      });
    }

    // ⚠️ NOT-YET-APPROVED TICKETS — the manager's own indicator.
    //
    // The gates above deliberately hide unapproved work: isApprovedTicket() and
    // the force-locked `selectedStatus = 'Resolved'` both drop it, and a pending
    // ticket has no viewing window for the access filter to match. That is correct
    // for the DEFAULT view, but it also means a ticket the manager filed is
    // invisible until a superadmin signs it off — the exact "where is my ticket?"
    // gap this closes.
    //
    // So for the two manager roles ONLY, re-scan the same raw list for tickets
    // that are NOT approved, run them through the SAME branch / access / search /
    // period / priority / status predicates (so every control keeps working),
    // and append.
    // The two test-pinned gate lines are untouched and still run first.
    //
    // ⚠️ DISPLAY ONLY. Clicking a pending ticket opens a modal that shows the
    // subject and an "Approval still Pending" notice and withholds the
    // description, findings and footage — the same payload an expired window
    // protects. It
    // grants no new read: firestore.rules already lets any signed-in user read
    // every ticket, so nothing here widens access.
    if (isAreaManager()) {
      const pending = allRaw
        .map((doc) => normalizeTicketReport(doc))
        .filter((t) => isPendingApprovalTicket(t))
        .filter((t) => t.ticketTransferTo !== 'hr')
        .filter((t) => {
          const branch = String(t.branch || t.branchName || '').trim();
          return allowedBranches.includes(branch);
        })
        .filter((t) => {
          if (selectedBranch && String(t.branch || t.branchName || '').trim() !== selectedBranch) return false;
          // A pending ticket has no viewing window, so it is never "expired";
          // accessMatches() therefore keeps it under "All"/"Not expired" and
          // hides it under "Expired" — exactly right.
          if (!accessMatches(t)) return false;
          // The badge label, same as the row renders it — so e.g. "In Progress"
          // keeps a started ticket visible under that option.
          if (!statusLabelMatches(t, t.status)) return false;
          if (searchText) {
            const haystack = [
              t.ticketNumber, t.title, t.incident, t.authorName, t.author,
              t.reporter, t.name, t.branch, t.branchName, t.description, t.location
            ]
              .concat(dateSearchTokens(t.submittedAt))
              .filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(searchText)) return false;
          }
          if (periodStart) {
            const raw = t.submittedAt;
            const d = raw && raw.toDate ? raw.toDate() : (raw ? new Date(raw) : null);
            if (d && !isNaN(d.getTime()) && d.getTime() < periodStart.getTime()) return false;
          }
          return true;
        });
      // Concat, not push: `tickets` is a fresh array from the filters above, but
      // this keeps the two lists independent so a future change to one cannot
      // mutate the other. The sort below then re-orders the combined list, with
      // pending rows above resolved ones.
      tickets = tickets.concat(pending);
    }

    // ⚠️ ORDERING: pending rows FLOAT TO THE TOP, resolved rows sit BELOW them,
    // each group still newest-first. "Pending" here means exactly what the row's
    // Status badge means — isAreaManager() && isPendingApprovalTicket(t) — so the
    // visual order and the badge can never disagree about which rows are pending.
    // For a role that has no pending rows at all (HR / superadmin, whose list is
    // approved-only) both sides of the first test are always false, so this block
    // collapses to a pure newest-first date sort and their order is unchanged.
    tickets.sort((a, b) => {
      const aPending = isAreaManager() && isPendingApprovalTicket(a);
      const bPending = isAreaManager() && isPendingApprovalTicket(b);
      if (aPending !== bPending) return aPending ? -1 : 1;
      const aTime = a.submittedAt && a.submittedAt.toDate ? a.submittedAt.toDate().getTime() : new Date(a.submittedAt || 0).getTime();
      const bTime = b.submittedAt && b.submittedAt.toDate ? b.submittedAt.toDate().getTime() : new Date(b.submittedAt || 0).getTime();
      return bTime - aTime;
    });

    if (!tickets.length) {
      // The copy names the gate, because "no tickets found" while tickets
      // plainly exist in the system (just not approved yet) reads as a bug.
      const emptyText = ownerResolvedOnly
        ? 'No approved tickets yet. A ticket appears here once the superadmin approves it.'
        : 'No tickets found for your branches.';
      ownerTicketsBody.innerHTML = `<tr><td colspan="9" class="empty-state"><i class="fas fa-ticket-alt"></i><p>${escapeHTML(emptyText)}</p></td></tr>`;
      return;
    }
    ownerTicketsBody.innerHTML = tickets.map((t) => {
      const status = String(t.status || 'Pending');
      // ⚠️ HONEST PIPELINE STATE, never a bare "Resolved" for an unapproved row.
      // `status` below is the raw stored value, which for a resolved-but-unqueued
      // ticket is literally 'Resolved' even though the superadmin has not signed
      // it off — showing a green Resolved badge promises content the manager
      // cannot open yet. So a pending row is labelled via ticketDisplayStatus():
      // it shows the live pipeline state ('Pending' freshly filed, 'In Progress'
      // when work starts, 'Pending Approval' when queued for review — including
      // the send-back states 'For Revision' / 'Insufficient Footage', which are
      // operator words and never surface here) and only an approved ticket
      // keeps the raw status (always "Resolved"). The four labels collapse onto
      // the existing .status-badge.* classes, so approved rows are byte-for-byte
      // unchanged.
      const pendingApproval = isAreaManager() && isPendingApprovalTicket(t);
      const statusLabel = pendingApproval ? ticketDisplayStatus(t) : status;
      const statusBadgeClass = statusLabel.toLowerCase().replace(/\s+/g, '-');
      const priority = String(t.priority || 'Low').toLowerCase();
      const dotClass = priority === 'high' ? 'high' : 'low';
      const createdDate = t.submittedAt?.toDate ? formatDate(t.submittedAt.toDate()) : formatDate(t.submittedAt);
      // The approved-but-lapsed case. The row STAYS (so the manager can see
      // that a ticket exists and that its window closed) and is badged, rather
      // than vanishing and looking like data loss. `.status-badge.expired`
      // already exists in style.css for the Approvals table, so this reuses
      // that exact treatment instead of inventing a second one.
      const expired = isOwnerTicketExpiredForViewer(t);
      const expiresAt = expired ? ownerTicketExpiry(t) : null;
      const expiryTitle = expired && expiresAt
        ? 'Viewing access closed ' + formatDate(expiresAt)
        : 'Approved — viewing access closed';

      // ⚠️ COMPUTED SEPARATELY FROM `expiresAt` ON PURPOSE. `expiresAt` is the
      // CLOSED moment, used only by the expired branches below, and is null while
      // the ticket is still readable. The countdown needs the deadline in the
      // OPEN case too — that is the only time there is anything left to count
      // down — so it takes the same helper without the `expired` gate. Null here
      // covers "no window at all" and "not opened yet", which correctly render
      // no countdown.
      const windowAccessExpiry = expiryAppliesToViewer() && !expired
        ? ownerTicketExpiry(t)
        : null;

      // ⚠️ APPROVED BUT NOT YET OPENED. Not expired, and there is no date to
      // show: the window has not started. It gets its own quiet label because
      // the neighbouring states are misleading without it — a muted dash reads
      // as "nothing to report", when in fact this ticket's clock is simply
      // waiting on the manager. Anything that rendered an "Until <date>" here
      // would be inventing a deadline out of nothing.
      const awaitingFirstOpen = !expired
        && expiryAppliesToViewer()
        && typeof window.trackingAccessStartsOnOpen === 'function'
        && window.trackingAccessStartsOnOpen(t)
        && !(typeof window.getTrackingAccessOpenedAt === 'function'
             && window.getTrackingAccessOpenedAt(t));

      // A PENDING re-access request swaps the red "Expired" badge for the amber
      // "Reopen requested" chip — the exact treatment script.js already uses in
      // the Approvals table, including the ×N count. The manager's own list and
      // the superadmin's list then say the same thing about the same ticket, and
      // the chip replaces the badge rather than sitting beside it so the row
      // stays one line tall.
      const reopen = ownerReopenState(t);
      const reopenPending = ownerReopenPending(t);
      const reopenCount = (reopen && Number(reopen.requestCount)) || 0;
      const reopenTitle = 'Reopen requested'
        + (reopenCount > 1 ? ' ×' + reopenCount : '')
        + (reopen && reopen.reason ? ' — Reason: ' + reopen.reason : '')
        + (expiresAt ? ' · Access closed ' + formatDate(expiresAt) : '')
        + ' · Awaiting superadmin approval';

      // ⚠️ TWO CELLS, NOT ONE. "Status" (where is this in the resolution
      // pipeline) and "Access" (can this person still OPEN it) are orthogonal
      // questions, and they were sharing a single cell under one heading. Two
      // badges side by side under the label "Status" is why this read as
      // cluttered: the LABEL was doing the damage, not the badges.
      //
      // `.status-badge.expired` is kept as the CLASS and the visible word is now
      // "Expired" to match it: that class is shared with the superadmin
      // Approvals table, and test/owner-ticket-approval.test.js pins it by name.
      // Word and class now agree, so nothing here is a machine-readable hook the
      // page does not own.
      let accessCell;
      if (reopenPending && expiryAppliesToViewer()) {
        // The amber chip REPLACES the red one, as before — the manager asked,
        // so "expired" alone would be a downgrade in meaning.
        accessCell = `<span class="access-reopen-badge" title="${escapeHTML(reopenTitle)}">`
          + `<i class="fas fa-envelope-open-text"></i> Reopen requested`
          + (reopenCount > 1 ? ` ×${reopenCount}` : '')
          + `</span>`;
      } else if (expired) {
        // ⚠️ THE ROW STAYS — this cell just changes what it SAYS. The ticket
        // number, branch, reporter and incident all remain visible so the
        // manager can still see the ticket exists and chase it; only the report,
        // the findings and the CCTV are withheld. Removing the row instead was
        // considered and rejected: a ticket vanishing from a list reads as data
        // loss, and the manager has no way to tell it apart from a mistake.
        //
        // The word is "Expired", which is the viewing window's own state in the
        // manager's terms. It names the WINDOW (not the ticket): the ticket is
        // still listed with its metadata, only its report and evidence are
        // withheld.
        accessCell = `<span class="status-badge expired" title="${escapeHTML(expiryTitle)}">`
          + `Expired</span>`;
      // ⚠️ THE LIVE COUNTDOWN IS THE `else` — the genuinely OPEN case. Only here is
      // there a deadline to count down to, so it is the only branch that gets a
      // ticking element. Everything above it is a static state.
      } else if (windowAccessExpiry) {
        accessCell = accessCountdownHtml(
          windowAccessExpiry.getTime(),
          'Viewing access closes ' + formatDate(windowAccessExpiry)
        );
      } else if (awaitingFirstOpen) {
        // Sits between "expired" and the neutral dash. It is NOT a green "Open"
        // badge: opening is what starts the clock, so calling it open would be
        // a promise the ticket is not yet making.
        accessCell = '<span class="owner-access-none" title="'
          + escapeHTML('Approved — your viewing window starts when you first open it')
          + '">Not yet opened</span>';
      } else {
        // A muted dash rather than a green "Open" badge. Most rows ARE open, so
        // a badge on every row is noise that says nothing — the Access column
        // should light up only when it has something to report. This matches
        // the Approvals table's own "no tracking window" convention.
        accessCell = '<span class="owner-access-none">&mdash;</span>';
      }

      // ⚠️ THE NOTE IS WHY A `title` ATTRIBUTE IS NOT ENOUGH. Everything that
      // explains the access state — when it closed, and the reason the manager
      // gave for asking again — lives in `title`, and a PHONE HAS NO HOVER. So
      // on a phone the badge was a bare unexplained word. The card layout has
      // vertical room, so the detail is rendered as real text there. It stays
      // `display: none` on the desktop table, which must keep one line per row.
      let accessNote = '';
      if (reopenPending && reopen && reopen.reason && expiryAppliesToViewer()) {
        accessNote = '<div class="owner-access-note">' + escapeHTML(reopen.reason) + '</div>';
      } else if (expired && expiresAt) {
        accessNote = '<div class="owner-access-note">Viewing closed '
          + escapeHTML(formatDate(expiresAt)) + '</div>';
      }

      const statusCell = `<span class="status-badge ${expired ? 'resolved' : statusBadgeClass}">`
        + escapeHTML(statusLabel) + '</span>';

      // ⚠️ THE ACCESS FOOT IS GATED ON `expiryAppliesToViewer()` — the SAME
      // predicate applyViewerExpiryChrome() uses to hide the Access column
      // (7th of 8) for HR and a superadmin. That class hides the desktop
      // cell by position; the card has no position to hide, so the gate has
      // to be here, in the renderer, or a role with no viewing window would
      // be shown an Access section that means nothing to them.
      const cardAccessBlock = expiryAppliesToViewer()
        ? `<div class="approval-card-expiry">
             <span class="approval-card-label">Access</span>
             ${accessCell}${accessNote}
           </div>`
        : '';
      // Same eye button as the desktop Actions cell. The whole card is
      // already tappable (the tr carries the onclick), so this is a pointer
      // hint for the footer's right edge, exactly like the Approvals card.
      // The Remarks button (shared "has an NOV been issued?" log) is HR and
      // superadmin only — the roles the `remarks` rules authorise (see
      // js/remarks.js). Built ONCE and used by BOTH the desktop Actions cell
      // and the phone card footer, like actionsGroup in hr-violations.js, so the
      // two copies cannot drift. stopPropagation() keeps the click off the row
      // onclick, which would otherwise open the report modal on top of remarks.
      const remarksBtn = isHrOrSuperAdmin()
        ? `<button type="button" class="btn btn-icon action-btn remarks" data-tooltip="Remarks / NOV status"
             data-remarks-key="tickets/${escapeHTML(t.id)}"
             data-remarks-label="${escapeHTML(t.ticketNumber)}"
             onclick="event.stopPropagation(); window.Remarks.openFromButton(this);">
             <i class="fas fa-sticky-note"></i>
           </button>`
        : '';

      const uploadBtn = isHrOrSuperAdmin()
        ? `<span class="btn btn-icon action-btn upload-indicator" data-tooltip="Upload NOV files"
             data-upload-key="tickets/${escapeHTML(t.id)}"
             data-upload-label="${escapeHTML(t.ticketNumber)}"
             onclick="event.stopPropagation(); window.HrUploads.openFromButton(this);">
             <i class="fas fa-file-contract"></i><span class="upload-indicator-label">NOV</span>
           </span>`
        : '';

      const cardFoot = `<div class="approval-card-foot">
             ${cardAccessBlock}
             <div class="approval-card-actions">
               <button type="button" class="btn btn-icon action-btn view" data-tooltip="${expired ? 'View details (access closed)' : 'View'}">
                 <i class="fas fa-eye"></i>
               </button>
               ${remarksBtn}
               ${uploadBtn}
             </div>
           </div>`;

      return `
      <tr onclick="window.openOwnerReport('${escapeHTML(t.id)}')"${activeUserIsSuperAdmin && dotClass === 'high' ? ' class="ticket-high-priority"' : ''}>
        <td data-label="Ticket"><span class="priority-dot"><span class="dot ${dotClass}"></span><span class="ticket-link">${escapeHTML(t.ticketNumber)}</span></span></td>
        <td data-label="Created">${escapeHTML(createdDate)}</td>
        <td data-label="Branch">${escapeHTML(t.branchName)}</td>
        <td data-label="Reporter">${escapeHTML(t.authorName)}</td>
        <td data-label="Incident">${escapeHTML(t.title)}</td>
        <td data-label="Status">${statusCell}</td>
        <td data-label="Access">${accessCell}${accessNote}</td>
        <td>
          <div class="action-group">
            <button type="button" class="btn btn-icon action-btn view" data-tooltip="${expired ? 'View details (access closed)' : 'View'}">
              <i class="fas fa-eye"></i>
            </button>
            ${remarksBtn}
            ${uploadBtn}
          </div>
        </td>
        <td class="approval-card-cell" data-label="Card">
          <div class="approval-card">
            <div class="approval-card-head">
              <span class="approval-card-branch"><i class="fas fa-ticket-alt"></i>${escapeHTML(t.ticketNumber)}</span>
              <span class="approval-card-pill approval-card-pill--${expired ? 'resolved' : statusBadgeClass}">${escapeHTML(statusLabel)}</span>
            </div>
            <div class="approval-card-grid">
              <div class="approval-card-field"><span class="approval-card-label">Branch</span><span class="approval-card-value">${escapeHTML(t.branchName)}</span></div>
              <div class="approval-card-field"><span class="approval-card-label">Reporter</span><span class="approval-card-value">${escapeHTML(t.authorName)}</span></div>
              <div class="approval-card-field"><span class="approval-card-label">Date Created</span><span class="approval-card-value approval-card-muted">${escapeHTML(createdDate)}</span></div>
              <div class="approval-card-field"><span class="approval-card-label">Incident</span><span class="approval-card-value">${escapeHTML(t.title)}</span></div>
            </div>
            ${cardFoot}
          </div>
        </td>
      </tr>
    `;
    }).join('');

    if (ownerTicketPagination) {
      ownerTicketPagination.innerHTML = `<span class="page-info">${tickets.length} ticket(s)</span>`;
      // Re-flag the Remarks buttons for the rows just drawn (red = already has a note).
      try { if (window.Remarks && window.Remarks.paintPresence) window.Remarks.paintPresence(); } catch (e) { /* ignore */ }
      // Re-flag the Upload buttons for the rows just drawn (amber = already has files).
      try { if (window.HrUploads && window.HrUploads.paintPresence) window.HrUploads.paintPresence(); } catch (e) { /* ignore */ }
    }
    // ⚠️ THE ROW COUNTDOWNS NEED THE TICKER TOO, not just the modal's. Started
    // here as well as on open because the LIST is where a manager triages
    // several tickets at once — a countdown that only exists inside a modal
    // gives no way to compare them. `startOwnerCountdownTicker()` is idempotent
    // (it returns early when the interval is already live), so re-rendering on
    // every snapshot does not stack intervals.
    startOwnerCountdownTicker();
  } catch (error) {
    console.error('Failed to render owner tickets:', error);
    if (ownerTicketsBody) {
      ownerTicketsBody.innerHTML = '<tr><td colspan="9" class="empty-state"><em>Unable to load tickets.</em></td></tr>';
    }
  }
}

let ownerTicketListenerStarted = false;
let ownerAllTicketsCache = [];
let previousOwnerTickets = [];

/**
 * Initial load used only as a fallback when the realtime listener is unavailable.
 */
async function loadOwnerTickets() {
  try {
    if (!ownerTicketsBody) return;

    if (!db || typeof db.collection !== 'function') {
      ownerTicketsBody.innerHTML = '<tr><td colspan="9" class="empty-state"><em>Firebase is unavailable.</em></td></tr>';
      return;
    }

    const snapshot = await db.collection('tickets').get();
    const allTickets = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    ownerAllTicketsCache = allTickets;
    renderOwnerTickets(allTickets);
    renderKpiCards();
    // Same deep link as the listener path: this is the fallback when
    // firestoreService.listenTickets is unavailable, and a manager who arrived
    // from the approval email must not be silently ignored just because the
    // realtime listener was not available.
    applyOwnerDeepLink(allTickets);
  } catch (error) {
    console.error('Failed to load owner tickets:', error);
    if (ownerTicketsBody) {
      ownerTicketsBody.innerHTML = '<tr><td colspan="9" class="empty-state"><em>Unable to load tickets.</em></td></tr>';
    }
  }
}

/**
 * Real-time listener: every time a ticket is added, modified, or removed, the
 * ticket list re-renders automatically — so new tickets appear instantly
 * without any Refresh button.
 */
function setupOwnerTicketListener() {
  if (ownerTicketListenerStarted) return;
  ownerTicketListenerStarted = true;

  if (!window.firestoreService || typeof window.firestoreService.listenTickets !== 'function') {
    loadOwnerTickets();
    return;
  }

  window.firestoreService.listenTickets(
    (allTickets) => {
      const list = allTickets || [];
      if (previousOwnerTickets.length > 0) {
        const prevMap = new Map(previousOwnerTickets.map(t => [t.id, t]));
        for (const t of list) {
          const prev = prevMap.get(t.id);
          if (prev &&
              (prev.ticketTransferTo || '') !== 'hr' &&
              (t.ticketTransferTo || '') === 'hr' &&
              typeof window.notifyTicketStatusChange === 'function') {
            window.notifyTicketStatusChange(prev, t);
          }
        }
      }
      previousOwnerTickets = list.map(t => ({ ...t }));
      ownerAllTicketsCache = list;
      renderOwnerTickets(list);
      renderKpiCards();
      // The approval-email deep link can only be resolved once the real ticket
      // list has arrived - the branch allowlist AND the approved-only filter
      // both live off this data, so there is nothing to check before this.
      // applyOwnerDeepLink() consumes the link, so later snapshots no-op.
      applyOwnerDeepLink(allTickets);
    },
    (error) => {
      console.error('Owner ticket listener error:', error);
    }
  );
}

function bindOwnerEvents() {
  ownerNavItems.forEach((item) => {
    item.addEventListener('click', () => {
      switchOwnerTab(item.dataset.tab);
      // Close the mobile drawer after choosing a tab.
      document.body.classList.remove('mobile-nav-open');
    });
  });

  ownerTicketSearch?.addEventListener('input', () => renderOwnerTickets(ownerAllTicketsCache));
  ownerTicketAccessFilter?.addEventListener('change', () => renderOwnerTickets(ownerAllTicketsCache));
  ownerTicketStatusFilter?.addEventListener('change', () => renderOwnerTickets(ownerAllTicketsCache));
  ownerTicketBranchFilter?.addEventListener('change', () => renderOwnerTickets(ownerAllTicketsCache));
  ownerTicketPeriodFilter?.addEventListener('change', () => renderOwnerTickets(ownerAllTicketsCache));
  closeOwnerReportModal?.addEventListener('click', closeOwnerReportModalFn);

  // The re-access form is re-created on every modal open, so its submit is
  // DELEGATED from the body and bound exactly once here. Binding it inside the
  // render would attach a second listener each time the modal opened, firing
  // the request N times for N opens.
  ownerReportModalBody?.addEventListener('submit', handleOwnerReopenSubmit);
  // Same delegation for the footage-request form: both handlers guard on
  // their own form id, so one body-level listener each cannot cross-fire.
  ownerReportModalBody?.addEventListener('submit', handleOwnerFootageSubmit);

  ownerReportModal?.addEventListener('click', (e) => {
    if (e.target === ownerReportModal) closeOwnerReportModalFn();
  });

  ownerLogoutBtn?.addEventListener('click', async () => {
    try {
      if (window.RefreshState) window.RefreshState.clearPage('owner');
      if (window.clearOwnerRoleCache) window.clearOwnerRoleCache();
      await auth.signOut();
      window.location.href = 'login.html';
    } catch (error) {
      console.error('Logout error:', error);
      ownerToast('Failed to log out.', 'error');
    }
  });
}

bindOwnerEvents();

// ===== Mobile navigation drawer (hamburger + backdrop) =====
(function initMobileOwnerNav() {
  const toggle = document.getElementById('ownerSidebarToggle');
  const backdrop = document.getElementById('ownerSidebarBackdrop');
  const close = () => document.body.classList.remove('mobile-nav-open');

  if (toggle) toggle.addEventListener('click', () => document.body.classList.toggle('mobile-nav-open'));
  if (backdrop) backdrop.addEventListener('click', close);
})();

// ===== Mockup identity strip: auth row placement (PHONE ONLY) =====
// The emerald .owner-subhead strip only exists at <=899px (the same
// breakpoint as the mobile drawer above; the CSS default is display:none).
// The DOM is original-desktop-first: #ownerAuthStatus STARTS in
// .header-right — exactly where it lived before the strip existed — so at
// >=900px, and on any page where this script does not run, the header is
// unchanged. On phones the auth row (dot + EMAIL only) moves into the strip's
// slot, which is where the pasted mockup puts it. It is ONE node with ONE set
// of ids (never cloned), so setActiveUser()'s writes to #ownerUserEmail keep
// working across the move — element references are not invalidated by
// relocating the node. ⚠️ #ownerUserRoleBadge is NOT in this node any more: it
// lives BESIDE THE PAGE TITLE (see ownerdashboard.html .header-left) as the
// big role indicator, and deliberately stays there on phones too — it never
// moves, so its id/text reads (setActiveUser + the readRole fallbacks in
// js/hr-violations.js / js/owner-violations.js) are simpler than ever.
(function placeOwnerAuthStatus() {
  const auth = document.getElementById('ownerAuthStatus');
  const headerRight = document.querySelector('#ownerMainContent .header-right');
  const stripSlot = document.getElementById('ownerSubheadAuth');
  if (!auth || !headerRight || !stripSlot) return;
  const phone = window.matchMedia('(max-width: 899px)');
  const apply = () => {
    const target = phone.matches ? stripSlot : headerRight;
    if (auth.parentElement !== target) target.appendChild(auth);
  };
  apply();
  if (typeof phone.addEventListener === 'function') phone.addEventListener('change', apply);
  else if (typeof phone.addListener === 'function') phone.addListener(apply);
})();

auth.onAuthStateChanged(async (user) => {
  if (user) {
    clearTimeout(window.__ownerLoginTimer);

    // Restore the open report modal right away — its content loads directly from
    // Firestore and does not depend on the branch/user lookups below, so it
    // reappears immediately instead of popping in only after the page finishes
    // loading (part of the "refresh trail" on this screen).
    if (!ownerStateRestored) {
      try {
        const early = (window.RefreshState && window.RefreshState.restore('owner')) || {};
        if (early.modal === 'report' && early.id && typeof window.openOwnerReport === 'function') {
          window.openOwnerReport(early.id);
        }
      } catch (e) { /* ignore */ }
    }

    if (ownerUserEmail) ownerUserEmail.textContent = user.email;

    try {
      await loadBranches();
      await loadActiveUserPermissions(user);

      // ===== Role guard: this page is NOT the superadmin's dashboard =====
      // ⚠️ Operators AND superadmins both belong in the main Command Center.
      //
      // This used to bounce OPERATORS ONLY, which stranded superadmins here.
      // That was reachable because the approval email links to
      // `ownerdashboard.html?ticket=…`, and `js/auth.js` honours `?next=` before
      // a superadmin's `main.html` default — so a superadmin who followed an
      // approval link landed here and could never get back: this page only has
      // Overview / Tickets / Violations, while Ticket Reviews and User Approvals
      // live on main.html. The symptom was "my superadmin dashboard is missing a
      // tab".
      //
      // HR is deliberately NOT redirected — HR belongs here (same page as an
      // owner; only the profile label and chat access differ).
      if (activeUserRole === 'operator' || activeUserRole === 'superadmin') {
        // Carry `?ticket=` across so the Command Center can open the SAME ticket
        // this link was pointing at. Without it the redirect silently discards
        // the whole reason the user followed the link. Consume it first so the
        // listener below can never also fire it on this page.
        const deepTicket = ownerDeepLinkTicket;
        ownerDeepLinkTicket = '';
        window.location.href = deepTicket
          ? 'main.html?ticket=' + encodeURIComponent(deepTicket)
          : 'main.html';
        return;
      }
    } catch (error) {
      console.error('Owner dashboard Firebase init failed:', error);
    }

    // ===== Real-time tickets: re-render automatically when a new ticket arrives =====
    setupOwnerTicketListener();

    // ===== Refresh resilience: stay on the current owner tab/filter after refresh =====
    // Only runs on the first auth callback of a page load (see ownerStateRestored).
    if (!ownerStateRestored) {
      try {
        const savedOwner = (window.RefreshState && window.RefreshState.restore('owner')) || {};
        // 'violations' is the HR-only transferred-violations tab.
        const OWNER_VALID_TABS = ['overview', 'tickets', 'violations'];
        if (savedOwner.tab && OWNER_VALID_TABS.includes(savedOwner.tab)) {
          switchOwnerTab(savedOwner.tab);
        }
        ownerStateRestored = true;
      } catch (e) {
        console.error('Owner restore-state error:', e);
      }
    }
  } else {
    // Never bounce to login.html instantly on a transient `null` auth callback —
    // Firebase can fire it while the persisted session is still being restored,
    // which would show a refresh trail to the login page and straight back.
    // Only redirect when no session actually materialises.
    clearTimeout(window.__ownerLoginTimer);
    window.__ownerLoginTimer = setTimeout(() => {
      if (!auth.currentUser) window.location.href = 'login.html';
    }, 1500);
  }
});
