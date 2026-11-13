/**
 * CCTV Command Center - Unified Application Script
 * Combines Branch Monitoring + Incident Ticketing System
 */

// ==============================================================
//  STATE
// ==============================================================

let branches = [];
let allLogs = [];
let allTickets = [];
let filteredTickets = [];
let allViolations = [];
let filteredViolations = [];
let violationPage = 1;
// True once branches + tickets have loaded; gates the dashboard render inside
// the violations snapshot handler so an early violation snapshot cannot paint a
// stale empty dashboard before the other sources arrive.
let dashboardDataReady = false;
let statusChart = null;
let trendChart = null;
let currentViewBranch = null;
let currentPage = 1;
const ITEMS_PER_PAGE = 20;
let isInitialTicketLoad = true;

// ===== Pagination state for Branches & History tables =====
let branchPage = 1;
let filteredBranches = [];

// ==============================================================
//  CLOUDINARY CONFIG (Ticket Attachments)
//  ⚠️ Replace with your own values after creating your Cloudinary
//     account + unsigned Upload Preset (Settings → Upload → Presets).
// ==============================================================
const CLOUDINARY_CLOUD_NAME = 'jlux07ne';
const CLOUDINARY_UPLOAD_PRESET = 'jiangnan';
const MAX_ATTACHMENT_SIZE_MB = 100;

// ==============================================================
//  CLOUDINARY CONFIG — VIOLATIONS STORAGE (2nd account)
//  Separate Cloudinary account dedicated to CCTV violation
//  footage so ticket uploads never consume its quota.
//  Evidence files are stored using the "Data base" folder
//  structure (see violationReportFolderPath below) with the
//  original filename preserved.
// ==============================================================
const VIOLATION_CLOUDINARY_CLOUD_NAME = 'gbd9cguj';//2ND CLOUDINARY VIOLATION
const VIOLATION_CLOUDINARY_UPLOAD_PRESET = 'jnviolation';

// Generate a Cloudinary-safe public_id from a filename that guarantees
// uniqueness even when two files share the same base name but have
// different extensions (e.g. "0109.mp4" + "0109.png"). Cloudinary identifies
// assets by public_id, and same-public_id uploads replace each other by
// default — so "0109" would collide. We append a short random suffix so
// every file gets its own asset while keeping the name readable.
// Returns e.g. "0109-a1b2c3d4" (extension stripped, Cloudinary adds the
// detected format automatically).
function makeUniquePublicId(fileName) {
    const dotIdx = String(fileName || '').lastIndexOf('.');
    const base = dotIdx > 0 ? String(fileName).slice(0, dotIdx) : String(fileName);
    const safeBase = base.replace(/[^A-Za-z0-9 _.\-]/g, ' ').replace(/\s+/g, ' ').trim() || 'file';
    const suffix = Math.random().toString(36).slice(2, 10);
    return safeBase + '-' + suffix;
}

// The report letterhead banner (URL + aspect) now lives in
// js/violation-report.js, which owns the whole "COMMAND CENTER REPORT"
// layout for both the command center and the HR dashboard.

const ALLOWED_ATTACHMENT_TYPES = [
    'image/jpeg','image/png','image/gif','image/webp','image/bmp',
    'video/mp4','video/webm','video/ogg',
    'application/pdf','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain','application/zip'
];
let currentTicketId = null;

// ==============================================================
//  SUPERADMIN CONFIG (Ticket Approval Workflow)
//  Role is loaded from the Firebase user document and not hardcoded.
// ==============================================================
let currentUserRole = 'operator';

async function syncCurrentUserRole() {
    if (!auth || !auth.currentUser || !auth.currentUser.email) {
        currentUserRole = 'operator';
        return currentUserRole;
    }

    try {
        const profile = await window.getUserProfile(auth.currentUser.email);
        currentUserRole = (profile && profile.role) ? String(profile.role).toLowerCase() : 'operator';
        // Phone header avatar initial: the pasted mobile block shipped a
        // hardcoded "N" for every user. First letter of the profile name,
        // falling back to the login email.
        const avatarEl = document.getElementById('jn2AvatarInitial');
        if (avatarEl) {
            const who = ((profile && profile.name) || auth.currentUser.email || '').trim();
            avatarEl.textContent = (who[0] || '?').toUpperCase();
        }
    } catch (error) {
        console.warn('Failed to sync current user role from Firebase:', error && error.message ? error.message : error);
        currentUserRole = 'operator';
    }

    return currentUserRole;
}

function currentUserIsSuperAdmin() {
    return currentUserRole === 'superadmin';
}

// Show/hide admin-only UI controls and re-render action buttons based on role.
// Operators keep workflow actions (Start / Resolve / Reopen / Add Status) but
// lose Edit / Delete on tickets, branches, and history records.
function refreshPermissionUI() {
    const isAdmin = currentUserIsSuperAdmin();

    // Ticket Approvals tab + Pending Approvals (superadmin only)
    const approvalsNav = document.getElementById('approvalsNavItem');
    if (approvalsNav) approvalsNav.style.display = isAdmin ? 'flex' : 'none';

    // Users / Pending Approvals management tab (superadmin only)
    if (usersNavItem) usersNavItem.style.display = isAdmin ? 'flex' : 'none';
    const adminNavLabel = document.getElementById('adminNavLabel');
    if (adminNavLabel) adminNavLabel.style.display = isAdmin ? 'block' : 'none';

    // Violations Report tab: operators + superadmin only — never owners.
    // (Owners are redirected to ownerdashboard.html anyway; this is a
    //  defensive guard for transient auth states.)
    if (violationsNavItem) violationsNavItem.style.display = (currentUserRole === 'operator' || currentUserRole === 'superadmin') ? 'flex' : 'none';

    // Manage Branches button (superadmin only)
    if (btnManageBranches) btnManageBranches.style.display = isAdmin ? 'inline-flex' : 'none';

    // Bulk Delete button (superadmin only)
    const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
    if (bulkDeleteBtn) bulkDeleteBtn.style.display = isAdmin ? 'inline-flex' : 'none';

    // "New" branch button inside the Add Status modal (superadmin only)
    if (btnAddBranch) btnAddBranch.style.display = isAdmin ? 'inline-flex' : 'none';

    // ===== HR <-> Superadmin chat =====
    // main.html is the Command Center, so chat is offered to
    // SUPERADMINS ONLY here (HR and owners are routed to
    // ownerdashboard.html). Everyone else is rejected by
    // canChatOnSurface(), which tears the launcher down rather than
    // merely hiding it.
    if (window.ChatService && typeof window.ChatService.init === 'function') {
        try {
            window.ChatService.init({ surface: 'main', role: currentUserRole });
        } catch (e) {
            console.warn('Chat init failed:', e);
        }
    }

    // Re-render tables so Edit/Delete action buttons appear for superadmins only
    if (typeof renderBranchesTable === 'function') renderBranchesTable();
    if (typeof renderHistory === 'function') renderHistory();
    if (typeof filterTickets === 'function') filterTickets();
    updateApprovalsBadge();
}

// ==============================================================
//  Deep link from the approval email: main.html?ticket=BNW-TIX007
// ==============================================================
// A superadmin is redirected OFF the Owner Dashboard (see the role guard in
// js/owner-dashboard.js) and arrives here carrying `?ticket=`. Without a
// handler on this side the redirect would silently throw away the reason the
// user followed the link, so this page has to honour it too.
//
// The two deep links are deliberately MIRRORS, not one shared helper: they run
// in separate classic scripts that each load their own copy of the page state,
// and a cross-file dependency for four lines of parsing would buy nothing.
let mainDeepLinkTicket = '';
let mainDeepLinkDone = false;

/**
 * Read `?ticket=` from the URL, once.
 *
 * ⚠️ SECURITY — the value is used as a Firestore document id and this page is
 * reachable by anyone editing a URL. The allowlist is IDENTICAL to the one in
 * js/auth.js and js/owner-dashboard.js (`^[A-Za-z0-9._-]{1,64}$`), so no `/`,
 * `?`, `#` or scheme character can walk out of the `tickets` collection.
 *
 * It is NOT consumed here, only captured: the caller may not be able to act yet
 * (no session, tickets still loading), and consuming on the first attempt would
 * lose the link.
 */
function captureMainDeepLink() {
    if (mainDeepLinkDone) return mainDeepLinkTicket;
    mainDeepLinkDone = true;
    try {
        const raw = new URLSearchParams(window.location.search || '').get('ticket');
        if (!raw) return '';
        const value = String(raw).trim();
        mainDeepLinkTicket = /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : '';
    } catch (e) { /* ignore */ }
    return mainDeepLinkTicket;
}

/**
 * Open the deep-linked ticket on the Command Center.
 *
 * ⚠️ ONE-SHOT, consumed before any await. The ticket list re-renders on every
 * Firestore snapshot; a link left pending would re-open the modal over and over
 * and trap the superadmin in a ticket they had closed.
 *
 * Unlike the Owner Dashboard there is no branch/approval gate to apply: this
 * page is the superadmin/operator Command Center, and `firestore.rules` gates
 * ticket reads on `isSignedIn()` for everyone who can reach it. The id is still
 * allowlisted above, so it can only ever name a single document.
 */
async function applyMainDeepLink() {
    const ticketId = captureMainDeepLink();
    if (!ticketId) return;
    if (!auth || !auth.currentUser) return;          // not ready yet — keep it pending
    if (typeof window.openTicketModal !== 'function') return;
    if (!db || typeof db.collection !== 'function') return;

    mainDeepLinkTicket = '';                          // consume before awaiting

    try {
        const snap = await db.collection('tickets').doc(ticketId).get();
        if (!snap || !snap.exists) {
            if (typeof showToast === 'function') showToast('That ticket could not be found.', 'error');
            return;
        }
        // Land on Tickets first: the modal renders over whatever tab is
        // showing, so without this it would pop up over the Dashboard.
        await switchTab('tickets');
        window.openTicketModal(ticketId);
    } catch (error) {
        console.error('Deep-link ticket could not be opened:', error && error.message ? error.message : error);
        if (typeof showToast === 'function') showToast('Could not open that ticket.', 'error');
    }
}

async function maybeOpenPendingApprovals() {
    if (!auth || !auth.currentUser || currentUserRole !== 'superadmin') return;
    try {
        if (!db || typeof db.collection !== 'function') return;
        const snapshot = await db.collection('users').where('status', '==', 'pending').limit(1).get();
        if (!snapshot.empty) {
            await switchTab('users');
        }
    } catch (error) {
        console.warn('Could not auto-open pending approvals:', error && error.message ? error.message : error);
    }
}

/**
 * Resolve the display status for a ticket given its `status` +
 * `approvalStatus` fields under the superadmin approval workflow:
 *  - Resolved + pending_approval  -> "Pending Approval"
 *  - Resolved + approved          -> "Resolved"
 *  - Resolved + rejected / "For Revision" -> "For Revision"
 */
function getDisplayStatus(ticket) {
    const status = ticket.status || 'Pending';
    const approval = ticket.approvalStatus || 'pending';
    if (status === 'Resolved') {
        return approval === 'approved' ? 'Resolved' : 'Pending Approval';
    }
    if (status === 'For Revision') return 'For Revision';
    return status;
}

function isPendingApproval(ticket) {
    return (ticket.status || 'Pending') === 'Resolved' && (ticket.approvalStatus || 'pending') === 'pending_approval';
}

function isApprovedTicket(ticket) {
    return (ticket.status || 'Pending') === 'Resolved' && (ticket.approvalStatus || 'pending') === 'approved';
}

function isRejectedTicket(ticket) {
    return (ticket.approvalStatus || 'pending') === 'rejected' || (ticket.status || '') === 'For Revision';
}

// ==============================================================
//  2-DAY TRACKING ACCESS (approved tickets)
//  Shared expiry helpers live in firebase.js so the public Track page
//  and both dashboards all compute the exact same window.
// ==============================================================

/**
 * Expiry summary for an approved ticket:
 *   { tracked: false }                     — not approved / no window
 *   { tracked: true, expired: false, date } — still viewable
 *   { tracked: true, expired: true,  date } — viewing blocked, awaiting Resend
 */
function getTrackingExpiryInfo(ticket) {
    if (!ticket || !isApprovedTicket(ticket)) return { tracked: false, expired: false, date: null };
    if (typeof window.getTrackingAccessExpiry !== 'function') return { tracked: false, expired: false, date: null };
    const date = window.getTrackingAccessExpiry(ticket);
    if (!date) return { tracked: false, expired: false, date: null };
    const expired = typeof window.isTrackingAccessExpired === 'function'
        ? window.isTrackingAccessExpired(ticket)
        : date.getTime() <= Date.now();
    return { tracked: true, expired, date };
}

/**
 * Human-readable length of the current access window ("1 minute" / "2 days").
 * Keeps every Resend label, tooltip and toast truthful when the window is
 * time-compressed for testing (Tier 2).
 */
function trackingWindowLabel() {
    if (typeof window.formatTrackingAccessWindow === 'function') {
        return window.formatTrackingAccessWindow(window.TRACKING_ACCESS_WINDOW_MS);
    }
    return '2 days';
}

/**
 * Markup for the "Manager Re-access Request" card in the approval details
 * modal. Returns '' when the ticket has never asked for access again.
 * (Filed from the expired Track page; only a superadmin Resend restores it.)
 */
function buildReopenRequestCard(ticket) {
    const req = ticket && ticket.accessReopenRequest;
    if (!req) return '';
    const pending = req.status === 'pending';
    const when = (v) => (v ? (v.toDate ? formatDateTime(v.toDate()) : formatDateTime(v)) : '');
    const requester = [req.requestedBy, req.requestedByEmail, req.requestedByContact]
        .filter((v, i, arr) => v && arr.indexOf(v) === i)
        .join(' \u00b7 ') || '\u2014';
    const count = Number(req.requestCount) || 1;
    const statusLine = pending
        ? 'Awaiting Superadmin \u2014 press "Approve Request & Resend" below to restore viewing.'
        : 'Fulfilled' + (when(req.resolvedAt) ? ' \u2014 access resent on ' + when(req.resolvedAt) : '')
            + (req.resolvedBy ? ' by ' + req.resolvedBy : '');

    return `
            <div class="review-card reopen ${pending ? '' : 'review-fulfilled'}">
                <div class="review-card-header">
                    <h3><i class="fas fa-envelope-open-text"></i> Manager Re-access Request</h3>
                    <span class="review-card-sub">${pending ? 'Pending action' : 'Fulfilled'}</span>
                </div>
                <div class="review-meta-grid">
                    <div class="review-meta full"><label>Reason</label><p class="review-note">${escapeHTML(req.reason || 'No reason provided.')}</p></div>
                    ${req.attachment && (req.attachment.url || req.attachment.secure_url) ? `<div class="review-meta full"><label>Police Report</label><a class="police-report-chip" href="${escapeHTML(req.attachment.url || req.attachment.secure_url)}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;padding:7px 12px;border:2px solid #ef4444;background:rgba(239,68,68,0.18);border-radius:8px;color:#7f1d1d;text-decoration:none;font-size:0.87rem;font-weight:700;"><i class="fas fa-file" style="color:#ef4444;font-size:1rem;"></i> Police Report</a></div>` : ""}
                    <div class="review-meta"><label>Requested By</label><span>${escapeHTML(requester)}</span></div>
                    <div class="review-meta"><label>Requested At</label><span>${escapeHTML(when(req.requestedAt) || '\u2014')}</span></div>
                    <div class="review-meta"><label>Times Requested</label><span>${count}&times;</span></div>
                    <div class="review-meta full"><label>Status</label><span style="color:var(--color-${pending ? 'warning' : 'resolved'});">${escapeHTML(statusLine)}</span></div>
                </div>
            </div>
        `;
}

/**
 * One-line context for a pending re-access request, used as the meta line of
 * the highlighted reason block in the confirm dialog (who asked, when, and how
 * many times) — mirrors the Manager Re-access Request card in the details modal.
 * Returns '' when there is nothing useful to show.
 */
function reopenRequestMeta(req) {
    if (!req) return '';
    const parts = [];
    if (req.requestedBy) parts.push('Requested by ' + req.requestedBy);
    const raw = req.requestedAt || null;
    const at = raw ? (raw.toDate ? raw.toDate() : new Date(raw)) : null;
    if (at && !isNaN(at.getTime())) parts.push('on ' + formatDateTime(at));
    const count = Number(req.requestCount) || 1;
    if (count > 1) parts.push('asked ' + count + '\u00d7');
    return parts.join(' \u00b7 ');
}

// ==============================================================
//  DOM REFERENCES
// ==============================================================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ==============================================================
//  ANIMATED COUNTERS (dashboard KPI numbers)
// ==============================================================
// Why this exists: the KPI tiles previously snapped straight from 0 to their
// final value, which reads as a page that loaded stale data. Easing the
// number up makes the tile feel live.
//
// Three deliberate constraints:
//
//  1. NEVER used on the chat log. That log's innerHTML is rebuilt on every
//     Firestore snapshot, so a JS-driven animation there would restart on
//     each update and strobe (see the note in README-interface.md and the
//     assertion in test/chat-access.test.js).
//  2. Skipped entirely under prefers-reduced-motion. The final value is
//     written synchronously, so the number is never left mid-count.
//  3. A running animation for the same element is CANCELLED and restarted
//     from the current value, so a burst of Firestore updates does not
//     queue dozens of timers fighting over one tile.

const countUpTimers = new WeakMap();

function prefersReducedMotion() {
    try {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
        return false;
    }
}

/**
 * Ease an element's number to `target`.
 * @param {HTMLElement} el
 * @param {number} target          final value
 * @param {object}  [opts]
 * @param {number}  [opts.duration] ms, default 600
 * @param {function} [opts.format]  value -> string, default String()
 * @param {string}  [opts.suffix]   appended after the formatted number
 */
function animateValue(el, target, opts) {
    if (!el || target === null || target === undefined || isNaN(target)) return;
    opts = opts || {};
    const format = opts.format || String;
    const suffix = opts.suffix || '';
    const duration = typeof opts.duration === 'number' ? opts.duration : 600;

    // Respect the OS setting: write the final value and stop.
    if (prefersReducedMotion() || duration <= 0) {
        cancelCountUp(el);
        el.textContent = format(target) + suffix;
        return;
    }

    // Start from whatever is already on screen, so an update mid-flight is
    // smooth rather than a jump back to 0.
    const currentRaw = parseFloat(String(el.textContent || '').replace(/[^0-9.-]/g, ''));
    const from = isNaN(currentRaw) ? 0 : currentRaw;
    if (from === target) return;

    // Cancel any in-flight animation on this element.
    cancelCountUp(el);

    const start = performance.now();
    function step(now) {
        const elapsed = now - start;
        // easeOutCubic: fast start, gentle settle. Linear reads as a machine.
        const t = Math.min(1, elapsed / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = format(Math.round(from + (target - from) * eased)) + suffix;
        if (t < 1) {
            countUpTimers.set(el, requestAnimationFrame(step));
        } else {
            // Land exactly on the target — never on a rounded intermediate.
            el.textContent = format(target) + suffix;
            countUpTimers.delete(el);
        }
    }
    countUpTimers.set(el, requestAnimationFrame(step));
}

function cancelCountUp(el) {
    if (!el) return;
    const frame = countUpTimers.get(el);
    if (frame !== undefined) {
        cancelAnimationFrame(frame);
        countUpTimers.delete(el);
    }
}

window.animateValue = animateValue;

// Sidebar
const navItems = $$('.nav-item');
const tabContents = $$('.tab-content');
const pageTitle = $('#pageTitle');
const pageSubtitle = $('#pageSubtitle');
const offlineBadge = $('#offlineBadge');
const pendingBadge = $('#pendingBadge');
const logoutBtn = $('#logoutBtn');
const loginBtnSidebar = $('#loginBtn');
const authStatus = $('#authStatus');
const authStatusText = $('#authStatusText');

// Dashboard
const onlineCount = $('#onlineCount');
const offlineCount = $('#offlineCount');
const activeOutages = $('#activeOutages');
const totalDowntime = $('#totalDowntime');
const quickStatusList = $('#quickStatusList');
const quickStatusListBranchTab = $('#quickStatusListBranchTab');
const totalTickets = $('#totalTickets');
const pendingTickets = $('#pendingTickets');
const progressTickets = $('#progressTickets');
const resolvedTickets = $('#resolvedTickets');
// Dashboard redo: alert strip, action KPIs, attention queue, activity, filters, leaders.
const dashAlert = $('#dashAlert');
const readinessPct = $('#readinessPct');
const readinessDelta = $('#readinessDelta');
const longestOutage = $('#longestOutage');
const ticketsAction = $('#ticketsAction');
const ticketsOverdue = $('#ticketsOverdue');
const ticketsDelta = $('#ticketsDelta');
const violationsWeek = $('#violationsWeek');
const violationsDelta = $('#violationsDelta');
const attentionBody = $('#attentionBody');
const attentionCount = $('#attentionCount');
const activityFeed = $('#activityFeed');
const dashBranchFilter = $('#dashBranchFilter');
const dashRangeGroup = $('#dashRangeGroup');
const downtimeLeaders = $('#downtimeLeaders');
let dashBranch = 'all';
let dashRange = 'month';

// Branches
const searchInput = $('#searchInput');
const filterBtns = $$('.filter-btn[data-filter]');
const groupFilter = $('#groupFilter');
const downtimeFilter = $('#downtimeFilter');
const sortSelect = $('#sortSelect');
const branchesTableBody = $('#branchesTableBody');

// History
const historySearch = $('#historySearch');
const historyBranchFilter = $('#historyBranchFilter');
const historyDateFrom = $('#historyDateFrom');
const historyDateTo = $('#historyDateTo');
const historyFilterBtns = $$('.filter-btn[data-history-filter]');
const historyTableBody = $('#historyTableBody');
const btnPrintReport = $('#btnPrintReport');
const reportMonthInput = $('#reportMonth');

// Tickets
const ticketSearch = $('#ticketSearch');
const ticketStatusFilter = $('#ticketStatusFilter');
const ticketPriorityFilter = $('#ticketPriorityFilter');
const ticketBranchFilter = $('#ticketBranchFilter');
const ticketSearchBtn = $('#ticketSearchBtn');
const ticketList = $('#ticketList');
const paginationControls = $('#paginationControls');
const bulkBar = $('#bulkBar');
const bulkCount = $('#bulkCount');
const selectAll = $('#selectAll');

// Violations Report
const violationsNavItem = $('#violationsNavItem');
const violationsBadge = $('#violationsBadge');
const violationSearch = $('#violationSearch');
const violationStoreFilter = $('#violationStoreFilter');
const violationUploadsFilter = $('#violationUploadsFilter');
const violationList = $('#violationList');
const violationModal = $('#violationModal');
const closeViolationModalBtn = $('#closeViolationModal');
const violationModalTitle = $('#violationModalTitle');
const violationModalBody = $('#violationModalBody');
const violationAttachmentsGrid = $('#violationAttachmentsGrid');
const violationModalFooter = $('#violationModalFooter');
const btnEditViolation = $('#btnEditViolation');
const btnDeleteViolation = $('#btnDeleteViolation');
const btnTransferViolation = $('#btnTransferViolation');
const btnTransferViolationLabel = $('#btnTransferViolationLabel');
const btnTransferViolationIcon = $('#btnTransferViolationIcon');
// The Area Manager handoff is a SECOND, independent transfer — its own button,
// label and icon, stamping `managerStatus` instead of `hrStatus`.
const btnTransferViolationToManager = $('#btnTransferViolationToManager');
const btnTransferViolationToManagerLabel = $('#btnTransferViolationToManagerLabel');
const btnTransferViolationToManagerIcon = $('#btnTransferViolationToManagerIcon');
const btnGenerateViolationReport = $('#btnGenerateViolationReport');
const violationFormModal = $('#violationFormModal');
const closeViolationFormModalBtn = $('#closeViolationFormModal');
const violationForm = $('#violationForm');
const violationFormTitle = $('#violationFormTitle');
const violationFormId = $('#violationFormId');
const violationStoreInput = $('#violationStore');
const violationSubjectInput = $('#violationSubject');
const violationIncidentDateInput = $('#violationIncidentDate');
const violationIncidentTimeInput = $('#violationIncidentTime');
const violationLocationInput = $('#violationLocation');
const violationDetailsInput = $('#violationDetails');
const violationUploadWidget = $('#violationUploadWidget');
const violationAttachmentInput = $('#violationAttachmentInput');
const violationFormWarning = $('#violationFormWarning');
const violationFormWarningMsg = $('#violationFormWarningMsg');
const violationUploadStatus = $('#violationUploadStatus');
const btnSubmitViolation = $('#btnSubmitViolation');
const btnNewViolation = $('#btnNewViolation');
const violationBreadcrumb = $('#violationBreadcrumb');
const violationFolderBrowser = $('#violationFolderBrowser');
const violationTreePanel = $('#violationTreePanel');
const btnViolationBack = $('#btnViolationBack');
const btnViolationHome = $('#btnViolationHome');
const violationPeriodFilter = $('#violationPeriodFilter');
const violationPeriodNote = $('#violationPeriodNote');
const violationPeriodNoteText = $('#violationPeriodNoteText');
const violationTreeCount = $('#violationTreeCount');
const btnToggleViolationTree = $('#btnToggleViolationTree');
const violationPagination = $('#violationPagination');

// The in-app attachment viewer's elements are created and cached by
// js/attachment-viewer.js, not here -- it is shared with ownerdashboard.html.

// Approvals tab
const approvalSearch = $('#approvalSearch');
const approvalStatusFilter = $('#approvalStatusFilter');
const approvalBranchFilter = $('#approvalBranchFilter');
const approvalListBody = $('#approvalListBody');
const approvalPagination = $('#approvalPagination');
const approvalTotalCount = $('#approvalTotalCount');
const approvalPendingCount = $('#approvalPendingCount');
const approvalApprovedCount = $('#approvalApprovedCount');
const approvalRejectedCount = $('#approvalRejectedCount');
const approvalsBadge = $('#approvalsBadge');
const approvalDetailsModal = $('#approvalDetailsModal');
const closeApprovalDetails = $('#closeApprovalDetails');
const approvalDetailsTitle = $('#approvalDetailsTitle');
const approvalDetailsBody = $('#approvalDetailsBody');
const approvalDetailsStatus = $('#approvalDetailsStatus');
const approvalModalFooter = $('#approvalModalFooter');
const btnTransferToHr = $('#btnTransferToHr');
const btnTransferToStore = $('#btnTransferToStore');
const btnRevertTicketTransfer = $('#btnRevertTicketTransfer');
const btnRejectApproval = $('#btnRejectApproval');
// 2-Day tracking access: superadmin-only "Approve Request & Resend", shown on
// an expired approved ticket ONLY when somebody has asked to reopen it.
const btnResendAccess = $('#btnResendAccess');
if (btnResendAccess) {
    btnResendAccess.innerHTML =
        `<i class="fas fa-check-double"></i> Approve Request &amp; Resend (${trackingWindowLabel()})`;
}
const approvalAttachmentsGrid = $('#approvalAttachmentsGrid');
const approvalAttachmentInput = $('#approvalAttachmentInput');
const btnUploadApprovalAttachment = $('#btnUploadApprovalAttachment');
const approvalUploadStatus = $('#approvalUploadStatus');

// User Management (Superadmin)
const usersNavItem = $('#usersNavItem');
const usersListBody = $('#usersListBody');
const userStatusFilter = $('#userStatusFilter');
let usersBadgeUnsub = null;
const usersBadge = $('#usersBadge');

// Edit Approval Information Modal (Superadmin)
const editApprovalModal = $('#editApprovalModal');
const closeEditApprovalModal = $('#closeEditApprovalModal');
const cancelEditApproval = $('#cancelEditApproval');
const editApprovalTitle = $('#editApprovalTitle');
const editApprovalTicketId = $('#editApprovalTicketId');
const editApprovalNotes = $('#editApprovalNotes');
const editApprovalAttachmentInput = $('#editApprovalAttachmentInput');
const btnUploadEditApprovalAttachment = $('#btnUploadEditApprovalAttachment');
const editApprovalUploadStatus = $('#editApprovalUploadStatus');
const editApprovalError = $('#editApprovalError');
const saveApprovalInfoBtn = $('#saveApprovalInfoBtn');

// Resolve / Reject Modals
const resolveModal = $('#resolveModal');
const closeResolveModal = $('#closeResolveModal');
const cancelResolve = $('#cancelResolve');
const resolveModalTitle = $('#resolveModalTitle');
const resolutionNotesEl = $('#resolutionNotes');
const resolveAttachmentInput = $('#resolveAttachmentInput');
// ⚠️ THIS MUST BE DECLARED. It used to be used at the submit handler without ever
// being declared, and it only resolved because `<span id="resolveUploadStatus">`
// creates an implicit `window` property (named element access). Rename that id --
// or wrap this file as a module, where `window` is not reachable -- and every
// reference throws a ReferenceError that kills the whole Resolve submit handler
// BEFORE its try/catch, so the ticket silently never gets resolved.
const resolveUploadStatus = $('#resolveUploadStatus');
const submitResolutionBtn = $('#submitResolutionBtn');
const rejectModal = $('#rejectModal');
const closeRejectModal = $('#closeRejectModal');
const cancelReject = $('#cancelReject');
const rejectReasonInput = $('#rejectReasonInput');
const submitRejectionBtn = $('#submitRejectionBtn');
const rejectError = $('#rejectError');

// Revise & Resubmit Modal (For Revision tickets)
const revisionModal = $('#revisionModal');
const closeRevisionModal = $('#closeRevisionModal');
const cancelRevision = $('#cancelRevision');
const revisionModalTitle = $('#revisionModalTitle');
const revisionRejectionReason = $('#revisionRejectionReason');
const revisionNotesEl = $('#revisionNotes');
const revisionAttachmentInput = $('#revisionAttachmentInput');
const revisionUploadStatus = $('#revisionUploadStatus');
const revisionError = $('#revisionError');
const submitRevisionBtn = $('#submitRevisionBtn');

// Approval workflow state
let currentResolveTicketId = null;
let currentRejectTicketId = null;
let currentApprovalTicketId = null;
let approvalPage = 1;
let filteredApprovalTickets = [];
let approvalPendingFiles = [];
let editApprovalPendingFiles = [];

// Add Status Modal
const addModal = $('#addModal');
const btnAddStatus = $('#btnAddStatus');
const closeAddModal = $('#closeAddModal');
const cancelAdd = $('#cancelAdd');
const addForm = $('#addStatusForm');
const branchSelect = $('#branchSelect');
const statusSelect = $('#statusSelect');
const dateInput = $('#dateInput');
const timeInput = $('#timeInput');
const remarksInput = $('#remarksInput');
const validationWarning = $('#validationWarning');
const validationMessage = $('#validationMessage');
const btnAddBranch = $('#btnAddBranch');
const newBranchGroup = $('#newBranchGroup');
const newBranchInput = $('#newBranchInput');
const statusSegmentedGroup = $('#statusSegmentedGroup');

// View Branch Modal
const viewModal = $('#viewModal');
const closeViewModal = $('#closeViewModal');
const viewBranchName = $('#viewBranchName');
const viewCurrentStatus = $('#viewCurrentStatus');
const viewLastUpdated = $('#viewLastUpdated');
const viewRemarks = $('#viewRemarks');
const viewDowntime = $('#viewDowntime');
const statOutages = $('#statOutages');
const statTotalDowntime = $('#statTotalDowntime');
const statLongestOutage = $('#statLongestOutage');
const statAvgOutage = $('#statAvgOutage');
const statAvailability = $('#statAvailability');
const viewHistoryBody = $('#viewHistoryBody');

// Ticket Modals
const ticketModal = $('#ticketModal');
const closeTicketModal = $('#closeTicketModal');
const editTicketModal = $('#editTicketModal');
const closeEditModal = $('#closeEditModal');
const modalTicketTitle = $('#modalTicketTitle');
const ticketModalBody = $('#ticketModalBody');
const editModalTitle = $('#editModalTitle');

const datetimeDisplay = $('#datetimeDisplay');

// Submit Ticket Form
const ticketForm = $('#ticketForm');
const branchSelectTicket = $('#branch');

// Branch Management
const branchListModal = $('#branchListModal');
const btnManageBranches = $('#btnManageBranches');
const closeBranchListModal = $('#closeBranchListModal');
const closeBranchListBtn = $('#closeBranchListBtn');
const newBranchNameInput = $('#newBranchNameInput');
const btnAddNewBranch = $('#btnAddNewBranch');
const branchListBody = $('#branchListBody');

// ==============================================================
//  UTILITY FUNCTIONS
// ==============================================================

function formatDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDateTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function toISODate(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function toISOTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function formatDuration(minutes) {
    if (minutes === null || minutes === undefined || minutes < 0) return '\u2014';
    if (minutes < 1) return '< 1m';
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h 0m`;
    return `${mins}m`;
}

function getDurationMinutes(startDate, endDate) {
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();
    return Math.max(0, (end - start) / (1000 * 60));
}

function getCurrentDowntimeText(branch) {
    if (!branch || branch.currentStatus !== 'Offline' || !branch.currentDowntimeStart) return '\u2014';
    const start = branch.currentDowntimeStart.toDate ? branch.currentDowntimeStart.toDate() : new Date(branch.currentDowntimeStart);
    return formatDuration(getDurationMinutes(start, new Date()));
}

function getCurrentDowntimeMinutes(branch) {
    if (!branch || branch.currentStatus !== 'Offline' || !branch.currentDowntimeStart) return 0;
    const start = branch.currentDowntimeStart.toDate ? branch.currentDowntimeStart.toDate() : new Date(branch.currentDowntimeStart);
    return getDurationMinutes(start, new Date());
}

function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

/**
 * Escape a value for use inside a double-quoted HTML attribute. escapeHTML()
 * leaves quotes untouched (it is built for element text), so values coming from
 * free text (e.g. a ticket's re-access reason inside title="…") must be run
 * through this first. Mirrors the escapers in js/notifications.js & js/owner-dashboard.js.
 */
function escapeAttr(value) {
    return escapeHTML(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function debounce(fn, delay = 300) {
    let timer;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

// ==============================================================
//  CONFIRM DIALOG (Styled replacement for native confirm())
//  Optional `reason` / `reasonLabel` / `reasonMeta` options render a
//  highlighted reason block under the message (e.g. WHY the manager is
//  asking for viewing access to be re-opened).
// ==============================================================

let confirmResolveCallback = null;

/**
 * Create / refresh the highlighted reason block inside the confirm modal.
 * The block is built on demand and hidden again whenever a later dialog has no
 * reason, so the shared #confirmModal can be reused safely. All text is escaped.
 * @param {HTMLElement} messageEl #confirmModalMessage (the <p> in the body)
 * @param {object} opts {reason, reasonLabel, reasonMeta}
 */
function renderConfirmReason(messageEl, opts = {}) {
    const { reason = '', reasonLabel = 'Reason', reasonMeta = '' } = opts;
    let box = document.getElementById('confirmModalReason');
    const text = String(reason === null || reason === undefined ? '' : reason).trim();

    if (!text) {
        if (box) {
            box.innerHTML = '';
            box.style.display = 'none';
        }
        return;
    }

    if (!box) {
        box = document.createElement('div');
        box.id = 'confirmModalReason';
        box.className = 'confirm-reason';
        messageEl.insertAdjacentElement('afterend', box);
    }
    box.innerHTML =
        `<span class="confirm-reason-label"><i class="fas fa-comment-dots"></i> ${escapeHTML(reasonLabel)}</span>` +
        `<p class="confirm-reason-text">${escapeHTML(text)}</p>` +
        (reasonMeta ? `<span class="confirm-reason-meta">${escapeHTML(reasonMeta)}</span>` : '');
    box.style.display = '';
}

function showConfirmDialog(options = {}) {
    const {
        title = 'Confirm',
        message = 'Are you sure?',
        confirmText = 'Confirm',
        cancelText = 'Cancel',
        danger = false,
        icon = 'fa-question-circle',
        reason = '',
        reasonLabel = 'Reason',
        reasonMeta = '',
        confirmByTyping = null
    } = options;

    return new Promise((resolve) => {
        confirmResolveCallback = resolve;

        const modal = document.getElementById('confirmModal');
        const titleEl = document.getElementById('confirmModalTitle');
        const messageEl = document.getElementById('confirmModalMessage');
        const acceptBtn = document.getElementById('acceptConfirmBtn');
        const cancelBtn = document.getElementById('cancelConfirmBtn');
        const iconEl = document.getElementById('confirmModalIcon');

        // Type-to-confirm elements (ticket deletion only)
        const typingSection = document.getElementById('confirmTypingSection');
        const typingInput = document.getElementById('confirmTypingInput');
        const typingError = document.getElementById('confirmTypingError');
        const ticketNumberEl = document.getElementById('confirmTicketNumber');
        const copyTicketBtn = document.getElementById('copyTicketNumberBtn');

        if (titleEl) titleEl.textContent = title;
        if (messageEl) {
            messageEl.innerHTML = message;
            // Highlighted reason block (e.g. why the manager needs access again).
            renderConfirmReason(messageEl, { reason, reasonLabel, reasonMeta });
        }
        if (cancelBtn) cancelBtn.textContent = cancelText;
        if (iconEl) {
            iconEl.className = 'fas ' + icon + ' confirm-modal-icon';
            iconEl.style.color = danger ? 'var(--color-danger)' : 'var(--color-warning)';
        }

        // ---- Type-to-confirm setup ----
        const isTypingConfirm = confirmByTyping !== null;
        if (typingSection) {
            if (isTypingConfirm) {
                typingSection.classList.remove('u-hidden');
                if (ticketNumberEl) ticketNumberEl.textContent = confirmByTyping;
                if (typingInput) typingInput.value = '';
                if (typingError) typingError.classList.add('u-hidden');
                if (acceptBtn) acceptBtn.disabled = true;

                // Copy ticket number button
                if (copyTicketBtn) {
                    copyTicketBtn.onclick = async function () {
                        try {
                            await navigator.clipboard.writeText(String(confirmByTyping));
                            var orig = copyTicketBtn.innerHTML;
                            copyTicketBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
                            setTimeout(function () { copyTicketBtn.innerHTML = orig; }, 1500);
                        } catch (e) {
                            // Clipboard unavailable — user can still type manually
                        }
                    };
                }

                // Validate input on every keystroke
                if (typingInput) {
                    typingInput.oninput = function () {
                        var match = String(typingInput.value || '').trim() === String(confirmByTyping);
                        if (acceptBtn) acceptBtn.disabled = !match;
                        if (typingError) typingError.classList.toggle('u-hidden', match);
                    };
                    typingInput.focus();
                }
            } else {
                typingSection.classList.add('u-hidden');
                if (acceptBtn) acceptBtn.disabled = false;
            }
        }

        if (acceptBtn) {
            acceptBtn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
            acceptBtn.innerHTML = '<i class="fas ' + (danger ? 'fa-trash-alt' : 'fa-check') + '"></i> ' + confirmText;
        }
        if (modal) modal.classList.add('active');
        if (acceptBtn) acceptBtn.focus();
    });
}

function closeConfirmDialog(result) {
    const modal = document.getElementById('confirmModal');
    if (modal) modal.classList.remove('active');
    if (confirmResolveCallback) {
        const cb = confirmResolveCallback;
        confirmResolveCallback = null;
        cb(result);
    }
}

(function initConfirmModal() {
    const modal = document.getElementById('confirmModal');
    const acceptBtn = document.getElementById('acceptConfirmBtn');
    const cancelBtn = document.getElementById('cancelConfirmBtn');
    const closeBtn = document.getElementById('closeConfirmModal');

    if (acceptBtn) acceptBtn.addEventListener('click', () => closeConfirmDialog(true));
    if (cancelBtn) cancelBtn.addEventListener('click', () => closeConfirmDialog(false));
    if (closeBtn) closeBtn.addEventListener('click', () => closeConfirmDialog(false));
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeConfirmDialog(false); });
})();

// ==============================================================
//  RENAME DIALOG (Styled replacement for native prompt())
// ==============================================================

let renameResolveCallback = null;

/**
 * Show the styled rename dialog and resolve with the entered name, or null
 * when the user cancels/closes it. Mirrors showConfirmDialog().
 * @param {object} options {title, label, value, hint, icon}
 */
function showRenameDialog(options = {}) {
    const {
        title = 'Rename',
        label = 'New name',
        value = '',
        hint = '',
        icon = 'fa-pen'
    } = options;

    return new Promise((resolve) => {
        renameResolveCallback = resolve;

        const modal = document.getElementById('renameModal');
        const titleEl = document.getElementById('renameModalTitle');
        const labelEl = document.getElementById('renameModalLabel');
        const input = document.getElementById('renameModalInput');
        const hintEl = document.getElementById('renameModalHint');
        const iconEl = document.getElementById('renameModalIcon');

        if (titleEl) titleEl.textContent = title;
        if (labelEl) labelEl.textContent = label;
        if (input) input.value = value;
        if (hintEl) {
            hintEl.textContent = hint;
            hintEl.style.display = hint ? '' : 'none';
        }
        if (iconEl) iconEl.className = 'fas ' + icon + ' rename-modal-icon';
        if (modal) modal.classList.add('active');
        if (input) {
            input.focus();
            if (input.select) input.select();
        }
    });
}

function closeRenameDialog(result) {
    const modal = document.getElementById('renameModal');
    if (modal) modal.classList.remove('active');
    if (renameResolveCallback) {
        const cb = renameResolveCallback;
        renameResolveCallback = null;
        cb(result);
    }
}

(function initRenameModal() {
    const modal = document.getElementById('renameModal');
    const input = document.getElementById('renameModalInput');
    const acceptBtn = document.getElementById('acceptRenameBtn');
    const cancelBtn = document.getElementById('cancelRenameBtn');
    const closeBtn = document.getElementById('closeRenameModal');

    const accept = () => {
        const value = input ? String(input.value) : '';
        closeRenameDialog(value);
    };
    if (acceptBtn) acceptBtn.addEventListener('click', accept);
    if (input) input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); accept(); }
    });
    if (cancelBtn) cancelBtn.addEventListener('click', () => closeRenameDialog(null));
    if (closeBtn) closeBtn.addEventListener('click', () => closeRenameDialog(null));
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeRenameDialog(null); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal && modal.classList.contains('active')) closeRenameDialog(null);
    });
})();

// ==============================================================
//  AUTH STATE
// ==============================================================

auth.onAuthStateChanged(async (user) => {
    if (!authStatusText) return;
    if (user) {
        authStatusText.textContent = user.email || 'Logged In';
        if (logoutBtn) logoutBtn.style.display = 'flex';
        if (loginBtnSidebar) loginBtnSidebar.style.display = 'none';
        await syncCurrentUserRole();

        // ===== Role guard: owners belong in the Owner Dashboard =====
        if (currentUserRole === 'owner' || currentUserRole === 'hr' || currentUserRole === 'rmsm') {
            window.location.href = 'ownerdashboard.html';
            return;
        }

        // ===== Role-based UI gating (operators vs superadmin) =====
        refreshPermissionUI();

        // ===== Violations "seen" list — reload now that the real email is known =====
        // setupViolationListener() calls loadViolationsSeen() during initApp(),
        // which runs on DOMContentLoaded BEFORE Firebase restores the session.
        // At that point auth.currentUser is still null, so violationsSeenKey()
        // resolved to `rcms_violations_seen_anon` and the user's real seen list
        // (saved under `rcms_violations_seen_<email>` when they opened reports)
        // was never read — so the badge jumped back to the full count on refresh.
        // Re-read now, with the email resolved, and refresh the badge. Idempotent.
        loadViolationsSeen();
        updateViolationsBadge();

        // ===== Ensure tickets load once real auth is available =====
        // On phones the Firebase session token can bind to Firestore a moment
        // after the screen's initial (unauthenticated) load already ran. The
        // /tickets collection is protected by `allow read: if isSignedIn()`, so
        // that first query can be rejected and the list left empty while public
        // data (branch status) still shows. This idempotently re-runs the ticket
        // loader now that we are authenticated. It no-ops on desktop where the
        // initial load already succeeded.
        // ⚡ PERF: only re-read when the live listener was actually rejected.
        // A healthy listener already delivers the full list (and keeps it live),
        // so the old unconditional full download here was a duplicate read.
        // A rejected listener is restarted (not replaced by a one-off read) so
        // the list also stays live afterwards.
        if (ticketListenerFailed) {
            await setupTicketListener();
        } else if (!ticketListenerActive && (isInitialTicketLoad || allTickets.length === 0)) {
            await loadTicketsDirect();
        }

        // ===== Refresh resilience: land back on the tab/modal the user was on =====
        // This runs ONCE per page load and only once we have a REAL signed-in user.
        // Firebase can fire a transient `null` callback while the persisted session
        // is still being restored; restoring then would route restricted tabs to the
        // dashboard and finalize the restore too early.
        if (!mainStateRestored) {
            // Snapshot what was open *before* maybeOpenPendingApprovals can change it.
            const savedMainState = (window.RefreshState && window.RefreshState.restore(MAIN_STATE_KEY)) || {};

            // Auto-open the Pending Approvals tab only when there is no saved tab to
            // return to; otherwise the saved view always wins (no mid-load tab jump).
            if (currentUserRole === 'superadmin' && !savedMainState.tab) {
                await maybeOpenPendingApprovals();
            }

            await restoreLastMainState(savedMainState);
            mainStateRestored = true;
        }

        // ===== Branch group chat backfill (superadmin, once per page load) =====
        // Seed chats/branch-<slug> for EVERY distinct branch in ANY approved
        // account's `branches` — existing users predate the approve/save
        // hooks, and a deleted or drifted room would never heal on its own.
        // Fire-and-forget with its own catch: dashboard load must never wait
        // on — or break because of — chat bookkeeping; the next full page
        // load retries anything that failed here.
        if (currentUserRole === 'superadmin' && !branchBackfillAttempted) {
            branchBackfillAttempted = true;
            backfillBranchGroupChats().catch(err => console.warn('[Chat] branch chat backfill failed:', err));
        }

        // ===== Approval-email deep link: main.html?ticket=BNW-TIX007 =====
        // Runs AFTER the ticket load and the state restore, because both can
        // move the user; opening the modal before either would land it over the
        // wrong tab. `captureMainDeepLink()` does not consume, so an early
        // "not ready" return (no session yet) leaves the link pending for the
        // next auth callback rather than losing it.
        await applyMainDeepLink();
    } else {
        currentUserRole = 'operator';
        authStatusText.textContent = 'Not logged in';
        if (logoutBtn) logoutBtn.style.display = 'none';
        if (loginBtnSidebar) loginBtnSidebar.style.display = 'flex';

        // Defer the role-based UI hiding: a transient `null` auth callback can
        // arrive while the persisted session is still restoring, and hiding the
        // superadmin nav items then would flicker them off and back on.
        clearTimeout(window.__guestUIRefreshTimer);
        window.__guestUIRefreshTimer = setTimeout(() => {
            if (!auth.currentUser) refreshPermissionUI();
        }, 600);
    }
});

if (loginBtnSidebar) {
    loginBtnSidebar.addEventListener('click', () => {
        window.location.href = 'login.html';
    });
}

if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
        // ===== Refresh-state: wipe saved tab/modal on logout so the next
        //       session never starts on a stale page/modal. =====
        if (window.RefreshState) window.RefreshState.clearPage('main');
        window.handleLogout();
    });
}

// =============================================================
//  REFRESH STATE — stay on the current tab/modal after F5 instead of
//  always bouncing back to the default dashboard.
// =============================================================

const MAIN_STATE_KEY = 'main';
const MAIN_VALID_TABS = ['dashboard', 'branches', 'history', 'tickets', 'violations', 'users', 'approvals'];

// One-shot flag: the refresh state (saved tab/modal) is restored exactly once
// after each page load so a later auth callback can never snap the user away
// from the view they are currently using.
let mainStateRestored = false;
// The branch-chat backfill (auth callback above) runs at most once per page
// load — auth can fire repeatedly within a session, the union sweep only
// needs one pass; the next full page load re-checks for drift/deletions.
let branchBackfillAttempted = false;

function getActiveMainTab() {
    // The sidebar nav item for the active tab carries the .active class.
    try {
        const el = document.querySelector('#sidebar .nav-item.active');
        return (el && el.dataset && el.dataset.tab) ? el.dataset.tab : 'dashboard';
    } catch (e) { return 'dashboard'; }
}

function clearMainModalCtx() {
    try { if (window.RefreshState) window.RefreshState.clearModal(MAIN_STATE_KEY); } catch (e) { /* ignore */ }
}

// Central capture for the main dashboard view. Always records the active tab and
// the current user's role so the *synchronous* pre-restore (below) can decide
// whether a superadmin-only tab may be shown before the async role check lands.
function captureMainState(extra) {
    try {
        if (window.RefreshState) {
            window.RefreshState.capture(MAIN_STATE_KEY, Object.assign(
                { role: currentUserIsSuperAdmin() ? 'superadmin' : 'operator' },
                extra || {}
            ));
        }
    } catch (e) { /* ignore */ }
}

// Re-opens a details modal that was open when the user refreshed. Ticket data
// loads asynchronously (realtime listener), so poll briefly until the ticket is
// in memory, then open the modal exactly as if the user had clicked it.
function tryReopenMainModal(modal, id, attempts) {
    if (!modal || !id) { clearMainModalCtx(); return; }
    attempts = (typeof attempts === 'number') ? attempts : 12;

    let opened = false;
    if (modal === 'ticket' && allTickets.some(t => t.id === id)) {
        if (typeof window.openTicketModal === 'function') { window.openTicketModal(id); opened = true; }
    } else if (modal === 'approval' && allTickets.some(t => t.id === id)) {
        if (typeof window.openApprovalDetails === 'function') { window.openApprovalDetails(id); opened = true; }
    } else if (modal === 'violation' && allViolations.some(v => v.id === id)) {
        if (typeof window.openViolationModal === 'function') { window.openViolationModal(id); opened = true; }
    } else if (modal === 'branch' && branches.some(b => b.branchName === id)) {
        openViewModal(id); opened = true;          // openViewModal is a hoisted declaration
    }

    if (opened) {
        clearMainModalCtx();                        // modal opened — drop the pending flag
    } else if (attempts > 0) {
        setTimeout(() => tryReopenMainModal(modal, id, attempts - 1), 400);
    } else {
        clearMainModalCtx();                        // stale record (deleted ticket) — clean up
    }
}

async function restoreLastMainState(savedTab) {
    if (!savedTab) savedTab = (window.RefreshState && window.RefreshState.restore(MAIN_STATE_KEY)) || {};

    // Restore the tab. switchTab already re-routes superadmin-only tabs for
    // non-superadmins, so stale state can never surface a forbidden page.
    if (savedTab.tab && MAIN_VALID_TABS.includes(savedTab.tab)) {
        await switchTab(savedTab.tab);
    }

    // Re-open whichever details modal was open (deferred until data is ready).
    if (savedTab.modal && savedTab.id) {
        tryReopenMainModal(savedTab.modal, savedTab.id, 12);
    }
}

// ===== Flash-free restore =====
// This runs synchronously while the page is still being parsed, i.e. BEFORE the
// first paint. It activates the saved tab immediately so a refresh re-opens the
// exact view with no visible "Dashboard then Ticket Approvals" jump. The async
// auth observer re-checks everything afterwards (role guard, data rendering).
(function preRestoreActiveMainTab() {
    try {
        if (!window.RefreshState) return;
        const saved = window.RefreshState.restore(MAIN_STATE_KEY) || {};
        const tabId = saved.tab;
        if (!tabId || !MAIN_VALID_TABS.includes(tabId)) return;

        // Superadmin-only tabs may only be pre-activated when the role recorded
        // at capture time was superadmin (or empty/legacy — only a superadmin could
        // ever have captured these tabs, and the async role check re-verifies).
        // Anything recorded as a plain operator waits for the async check, which
        // routes stale/forbidden tabs back to the dashboard.
        if ((tabId === 'users' || tabId === 'approvals') && saved.role === 'operator') return;

        navItems.forEach(item => { item.classList.toggle('active', item.dataset.tab === tabId); });
        tabContents.forEach(tab => { tab.classList.toggle('active', tab.id === `tab${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`); });

        // Reveal the superadmin-only nav links synchronously as well, so the
        // "Pending Approvals" / "Ticket Approvals" items don't disappear on
        // refresh and then pop back once the async role check finishes.
        // (Any stale/forbidden case is re-hidden by the auth observer.)
        if (saved.role === 'superadmin' || tabId === 'users' || tabId === 'approvals') {
            if (usersNavItem) usersNavItem.style.display = 'flex';
            const approvalsNavEl = document.getElementById('approvalsNavItem');
            if (approvalsNavEl) approvalsNavEl.style.display = 'flex';
            const adminLabelEl = document.getElementById('adminNavLabel');
            if (adminLabelEl) adminLabelEl.style.display = 'block';
        }

        const titles = { dashboard: 'Dashboard', branches: 'Branch Monitor', history: 'Status History', tickets: 'Tickets', users: 'Pending Approvals', approvals: 'Ticket Reviews' };
        const subtitles = { dashboard: 'Overview & Analytics', branches: 'Real-time Branch Health Status', history: 'Status Change Logs', tickets: 'Incident Ticket Management', users: 'Review new owner sign-ups', approvals: 'Superadmin Approval Workflow' };
        if (pageTitle) pageTitle.textContent = titles[tabId] || 'Dashboard';
        if (pageSubtitle) pageSubtitle.textContent = subtitles[tabId] || '';
    } catch (e) { /* ignore */ }
})();

// ==============================================================
//  INITIALIZATION
// ==============================================================

function initDateTime() {
    if (!datetimeDisplay) return;
    function update() {
        const now = new Date();
        datetimeDisplay.textContent = `${formatDate(now)} ${formatTime(now)}`;
    }
    update();
    setInterval(update, 1000);
}

function setDefaultDateTime() {
    if (!dateInput || !timeInput) return;
    const now = new Date();
    dateInput.value = toISODate(now);
    timeInput.value = toISOTime(now);
}

function setDefaultReportMonth() {
    if (!reportMonthInput) return;
    const now = new Date();
    reportMonthInput.value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

/**
 * Resolve the report month from the `#reportMonth` picker. Returns the first
 * day of the selected month (or the current month when no value is set).
 */
function getSelectedReportMonth() {
    let value = reportMonthInput ? reportMonthInput.value : '';
    if (!value) {
        const now = new Date();
        value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    }
    const parts = value.split('-');
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1; // JS months are 0-based
    return new Date(year, month, 1);
}

async function initApp() {
    try {
        initDateTime();
        setDefaultDateTime();
        setDefaultReportMonth();

        // ===== Violations + tickets go live immediately =====
        // Their onSnapshot listeners fire from Firestore's OFFLINE CACHE first
        // (persistence is enabled in firebase.js), so both tables paint instantly
        // with no network wait, then update live from the server. The ticket
        // listener is started directly (not chained after getTickets) so it does
        // not wait on the direct server read.
        const violationsReady = setupViolationListener();
        // Auto-revert runs on its own 5-second timer, independent of snapshots.
        startAutoRevertTimer();
        // ⚡ PERF: the live listener is now the ONLY initial ticket read. It used
        // to be paired with loadTicketsDirect(), a second full server download
        // of the whole tickets collection on every page load. The listener
        // resumes from the offline cache and only fetches changes, so
        // `ticketsReady` resolves from its first usable snapshot instead.
        const ticketsReady = setupTicketListener();

        // ===== Instant branch paint from cache, then reconcile from server =====
        await paintBranchesFromCache();
        const branchesReady = loadBranchData();

        await branchesReady;
        
        if (branchesTableBody) {
            populateHistoryBranchFilter();
            populateGroupFilter();
            populateTicketBranchFilter();
        }
        
        populateSubmitBranchSelect();
        await ticketsReady;
        await violationsReady;
        
        // ===== Render dashboard AFTER all data sources are loaded =====
        // Branches: loaded via loadBranchData()
        // Tickets: loaded via loadTicketsDirect()
        // Violations: loaded via setupViolationListener (first snapshot)
        // This ensures the attention queue shows real data, not stale "empty" state.
        dashboardDataReady = true;
        if (branchesTableBody) {
            renderDashboard();
            renderBranchesTable();
            renderHistory();
            populateTicketBranchFilter();
            // Re-run attention queue in case violations loaded after initial render
            renderAttentionQueue();
        }
        
        // ===== Keep the sidebar Approvals badge in sync on initial load =====
        updateApprovalsBadge();
        startUsersBadgeListener();
    } catch (e) {
        console.error('initApp error:', e);
    }
}

/**
 * Instant first paint of the Branch Monitor + dashboard from Firestore's
 * OFFLINE CACHE (persistence is enabled in firebase.js). Reads the last-seen
 * branches + status logs straight from IndexedDB — no network wait — so a
 * refresh shows real data immediately. Silently no-ops on a first-ever visit
 * (empty cache), an unsupported browser, or any read/render error; the server
 * load in initApp() then paints normally. It only touches the branch surfaces;
 * tickets and violations get the same cache-first effect from their live
 * listeners. Best-effort by design: it never throws into initApp().
 */
async function paintBranchesFromCache() {
    if (!branchesTableBody) return;
    try {
        let cachedBranches;
        try {
            cachedBranches = await firestoreService.getBranches({ source: 'cache' });
        } catch (e) {
            return; // no cached branches yet (first visit / no IndexedDB) — skip
        }
        if (!cachedBranches || !cachedBranches.length) return;

        branches = cachedBranches;
        try {
            allLogs = await firestoreService.getAllLogs({ source: 'cache' });
        } catch (e) {
            allLogs = [];
        }

        // Populate the branch-dependent dropdowns too, so the filters are usable
        // before the server round-trips land.
        populateHistoryBranchFilter();
        populateGroupFilter();
        populateTicketBranchFilter();
        populateSubmitBranchSelect();

        renderDashboard();
        renderBranchesTable();
        renderHistory();
    } catch (e) {
        // Best-effort instant paint: never let a cache-render hiccup abort the
        // rest of initApp()'s server load.
        console.warn('Cache first-paint skipped:', e);
    }
}

async function loadTicketsDirect() {
    // ⚠️ NO SEEDING HERE, AND THAT IS THE POINT.
    // This used to read: if the list came back empty, call the sample-ticket
    // seeder further down this file and write two hardcoded demo tickets. Two
    // consequences, both bad once the app is in real use:
    //   1. DELETED TICKETS CAME BACK. Delete the last real ticket, the
    //      collection is empty, and the next page load re-created them — so a
    //      superadmin could not clear the list, and a project reset looked like
    //      it had failed even though every document really was deleted.
    //   2. The catch branch did the same on ANY transient read error, so a
    //      network blip wrote two tickets into production.
    // Demo data belongs in a seed script (scripts/seed.js), not in the boot
    // sequence of the app that serves real staff. An empty list is a legitimate
    // state, and displayTickets() already renders "No tickets found." for it.
    try {
        const tickets = await firestoreService.getTickets();
        allTickets = tickets;
        filterTickets();
        updateTicketDashboard();
        updatePendingBadge();
        // ⚠️ UNCONDITIONAL. It used to be set only inside the branches that found
        // at least one ticket, so an empty collection left it `true` — and the
        // `isInitialTicketLoad || allTickets.length === 0` check further up then
        // takes a different branch precisely when there is nothing to show.
        isInitialTicketLoad = false;
    } catch (error) {
        // A failed read is NOT an empty database. Say so instead of writing
        // documents as a side effect of a network error.
        console.error('Error loading tickets directly:', error);
        if (typeof showToast === 'function') {
            showToast('Could not load tickets. Check your connection and refresh.', 'error');
        }
    }
}

// ==============================================================
//  BRANCH DATA LOADING
// ==============================================================

async function loadBranchData() {
    try {
        branches = await firestoreService.getBranches();
        allLogs = await firestoreService.getAllLogs();

        if (branches.length === 0) {
            // ⚠️ THE AUTO-SEED CAN FAIL SILENTLY, AND IT DID.
            // seedDefaultBranches() writes through the web SDK, and `branches`
            // create is `allow create: if isSuperAdmin()`. A denied write threw,
            // the one broad catch below swallowed it, and `branches` stayed []
            // — so the Branch Monitor was empty AND every Branch Access checkbox
            // in User Approvals rendered "No branches loaded.", which then let
            // approveUser() write `branches: []` onto real accounts.
            //
            // It is separated out here so the failure is reported and the branch
            // dropdowns still get rebuilt, instead of the whole page believing
            // the database genuinely has no branches.
            try {
                await seedDefaultBranches();
            } catch (seedError) {
                console.error('Default branch seeding failed:', seedError);
                if (typeof showToast === 'function') {
                    showToast('Could not create the default branches. Seed the database (npm run seed), '
                        + 'or a branch must be added manually.', 'error');
                }
            }
            branches = await firestoreService.getBranches();
        }

        await syncBranchStatusesFromLogs();
    } catch (error) {
        console.error('Error loading branch data:', error);
        console.log('Failed to load branch data.');
    }
}

/**
 * Derive each branch's current status from its newest status log and persist
 * it onto the branch document.
 *
 * ⚡ PERF: this used to call getBranchLogs() once PER BRANCH — re-downloading
 * every status log a second time (allLogs already holds the whole collection,
 * sorted newest-first, in the same document order), plus an unconditional
 * setBranch() write per branch on every page load. It now reads the newest log
 * per branch from allLogs in memory (identical result, zero extra reads) and
 * only writes a branch document when its stored status actually differs.
 */
async function syncBranchStatusesFromLogs() {
    const latestByBranch = new Map();
    for (const log of allLogs) {
        if (log && log.branchName && !latestByBranch.has(log.branchName)) {
            latestByBranch.set(log.branchName, log);
        }
    }
    const tsMillis = (v) => (v && typeof v.toMillis === 'function') ? v.toMillis()
        : (v && typeof v.toDate === 'function') ? v.toDate().getTime() : (v == null ? null : v);

    await Promise.all(branches.map(async (branch) => {
        const latest = latestByBranch.get(branch.branchName);
        if (!latest) return;
        const updateData = {
            currentStatus: latest.status,
            lastUpdated: latest.dateTime,
            remarks: latest.remarks || branch.remarks || '',
            currentDowntimeStart: latest.status === 'Offline' ? latest.dateTime : null
        };
        const unchanged = branch.currentStatus === updateData.currentStatus
            && tsMillis(branch.lastUpdated) === tsMillis(updateData.lastUpdated)
            && (branch.remarks || '') === updateData.remarks
            && tsMillis(branch.currentDowntimeStart == null ? null : branch.currentDowntimeStart)
                === tsMillis(updateData.currentDowntimeStart);
        if (!unchanged) {
            await firestoreService.setBranch(branch.branchName, updateData);
        }
        branch.currentStatus = updateData.currentStatus;
        branch.lastUpdated = updateData.lastUpdated;
        branch.currentDowntimeStart = updateData.currentDowntimeStart;
        branch.remarks = updateData.remarks;
    }));
}

/**
 * After a successful status-log edit/delete: keep allLogs newest-first (an edit
 * can move a log in time), re-derive branch statuses, and repaint — the same
 * end state the old full loadBranchData() reload produced, without the reads.
 */
function refreshBranchStatusesLocally() {
    const t = (l) => l?.dateTime?.toDate?.()?.getTime() || 0;
    allLogs.sort((a, b) => t(b) - t(a));
    return syncBranchStatusesFromLogs()
        .catch((e) => console.error('Branch status sync error:', e))
        .then(() => {
            renderDashboard();
            renderBranchesTable();
        });
}

async function loadSuperadminUsers() {
    if (!usersListBody) return;
    // Superadmin-only data (all user accounts) — block operators even via console.
    if (!currentUserIsSuperAdmin()) return;

    const statusFilter = userStatusFilter ? userStatusFilter.value : 'all';

    try {
        const snapshot = await db.collection('users').get();
        let users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        users = users.filter(user => {
            const email = (user.email || user.id || '').toString().trim();
            return email.length > 0;
        });

        if (statusFilter !== 'all') {
            users = users.filter(u => (u.status || 'approved') === statusFilter);
        } else {
            users = users.filter(u => (u.status || '').toLowerCase() !== 'approved' && (u.status || '').toLowerCase() !== 'rejected');
            if (!users.length) {
                users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(user => {
                    const email = (user.email || user.id || '').toString().trim();
                    return email.length > 0;
                });
            }
        }

        // ⚠️ A superadmin (the approver) and an operator (created directly in
        // Firestore) are NEVER approval candidates, so they must not appear in
        // this queue at any status or under any filter. This runs AFTER every
        // branch above — including the "empty → show all" fallback, which
        // re-derives from snapshot.docs — so a self-registered account that was
        // later re-roled to superadmin in Firestore drops out of the list the
        // moment its role says so, instead of lingering as a phantom "Area
        // Manager" approval. See isApprovalQueueRole().
        users = users.filter(isApprovalQueueRole);

        users.sort((a, b) => {
            const aKey = String((a.email || a.id || '')).toLowerCase();
            const bKey = String((b.email || b.id || '')).toLowerCase();
            return aKey.localeCompare(bKey);
        });

        if (!users.length) {
            usersListBody.innerHTML = '<tr><td colspan="7" class="empty-state"><em>No pending approvals.</em></td></tr>';
            return;
        }

        let html = '';
        users.forEach(user => {
            const safeEmail = sanitizeUserId(user.email || user.id);
            const status = user.status || 'approved';
            const statusClass = status === 'pending' ? 'pending'
                : (status === 'rejected' ? 'rejected' : 'approved');
            const branchText = (user.branches || []).join(', ') || 'None';

            // Main (collapsed) row - clicking toggles the details panel.
            html += `
                <tr class="user-row" data-email="${escapeHTML(user.email || '')}" style="cursor:pointer;">
                    <td>${escapeHTML(user.email || user.id)}</td>
                    <td>${escapeHTML(user.name || '—')}</td>
                    <td><span class="role-badge ${roleBadgeClass(user)}">${roleDisplayName(user)}</span></td>
                    <td>${escapeHTML(branchText)}</td>
                    <td><span class="status-badge ${statusClass}">${escapeHTML(status[0].toUpperCase() + status.slice(1))}</span></td>
                    <td>
                        <div class="approval-action-stack">
                            <button type="button" class="btn btn-icon btn-danger" data-delete-user="${escapeHTML(user.email || '')}" title="Delete user"><i class="fas fa-trash"></i></button>
                            <button type="button" class="btn btn-icon action-btn view" data-tooltip="Review / Configure" data-toggle-user="${escapeHTML(user.email || '')}"><i class="fas fa-chevron-down"></i></button>
                        </div>
                    </td>
                    <td class="approval-card-cell" data-label="Card">
                        <div class="approval-card">
                            <div class="approval-card-head">
                                <span class="approval-card-branch"><i class="fas fa-user"></i>${escapeHTML(user.name || user.email || user.id)}</span>
                                <span class="approval-card-pill approval-card-pill--${statusClass}">${escapeHTML(status[0].toUpperCase() + status.slice(1))}</span>
                            </div>
                            <div class="approval-card-grid">
                                <div class="approval-card-field"><span class="approval-card-label">User</span><span class="approval-card-value">${escapeHTML(user.email || user.id)}</span></div>
                                <div class="approval-card-field"><span class="approval-card-label">Name</span><span class="approval-card-value">${escapeHTML(user.name || '—')}</span></div>
                                <div class="approval-card-field"><span class="approval-card-label">Role</span><span class="approval-card-value">${roleDisplayName(user)}</span></div>
                                <div class="approval-card-field"><span class="approval-card-label">Requested Branches</span><span class="approval-card-value">${escapeHTML(branchText)}</span></div>
                            </div>
                            <div class="approval-card-foot">
                                <div class="approval-card-actions">
                                    <div class="approval-action-stack">
                                        <button type="button" class="btn btn-icon btn-danger" data-delete-user="${escapeHTML(user.email || '')}" title="Delete user"><i class="fas fa-trash"></i></button>
                                        <button type="button" class="btn btn-icon action-btn view" data-tooltip="Review / Configure" data-toggle-user="${escapeHTML(user.email || '')}"><i class="fas fa-chevron-down"></i></button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </td>
                </tr>

                <!-- Expandable details row: branch + permission checkboxes (hidden by default) -->
                <tr class="user-detail-row" id="userDetail-${safeEmail}" style="display:none;">
                    <td colspan="7" style="padding:0;background:var(--bg-hover);">
                        <div class="user-detail-panel">
                            <div class="detail-head">
                                <strong>${escapeHTML(user.name || user.email)}</strong>
                                <span style="color:var(--text-muted);font-size:0.85rem;">${escapeHTML(user.email || '')}</span>
                            </div>

                            <div class="form-group full-width">
                                <label>Role</label>
                                <div class="role-select-wrap">
                                    ${roleIsAssignable(user) ? `
                                    <select id="roleSelect-${safeEmail}" class="role-select" data-role-select="${escapeHTML(user.email || '')}">
                                        <option value="owner" ${storedRole(user) === 'owner' ? 'selected' : ''}>Area Manager</option>
                                        <option value="hr" ${storedRole(user) === 'hr' ? 'selected' : ''}>HR</option>
                                        <option value="rmsm" ${storedRole(user) === 'rmsm' ? 'selected' : ''}>RM/SM</option>
                                    </select>
                                    <p class="role-select-hint" id="roleHint-${safeEmail}">${roleHintHtml(user)}</p>
                                    ` : `
                                    <div class="role-locked" id="roleLocked-${safeEmail}">
                                        <span class="role-badge ${roleBadgeClass(user)}">${roleDisplayName(user)}</span>
                                        <p class="role-select-hint">This role is managed outside this screen and cannot be changed here.</p>
                                    </div>
                                    `}
                                </div>
                            </div>
                            <div class="form-group full-width">
                                <label>Branch Access</label>
                                <div class="branch-checkbox-grid" id="db-${safeEmail}">
                                    ${renderDetailBranchCheckboxes(userEmailKey(user), user.branches || [])}
                                </div>
                            </div>
                            <div class="divider" style="margin:14px 0;"></div>
                            <div class="form-group full-width">
                                <label>Feature Permissions</label>
                                <div class="permission-grid">
                                    <label class="checkbox-label"><input type="checkbox" id="dp-view-${safeEmail}" ${(user.permissions && user.permissions.viewOnly) ? 'checked' : ''}> View Only</label>
                                    <label class="checkbox-label"><input type="checkbox" id="dp-edit-${safeEmail}" ${(user.permissions && user.permissions.canEdit) ? 'checked' : ''}> Can Edit</label>
                                    <label class="checkbox-label"><input type="checkbox" id="dp-download-${safeEmail}" ${(user.permissions && user.permissions.canDownload) ? 'checked' : ''}> Can Download Files</label>
                                </div>
                            </div>
                            <div class="detail-actions">
                                <button type="button" class="btn btn-sm btn-success" data-approve-user="${escapeHTML(user.email || '')}"><i class="fas fa-check"></i> Approve</button>
                                <button type="button" class="btn btn-sm btn-danger" data-reject-user="${escapeHTML(user.email || '')}"><i class="fas fa-times"></i> Reject</button>
                            </div>
                        </div>
                    </td>
                </tr>

                <tr class="user-detail-gap" style="height:0;"></tr>
            `;
        });

        usersListBody.innerHTML = html;

        // Toggle expand/collapse on the chevron and on the row click.
        usersListBody.querySelectorAll('[data-toggle-user]').forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation(); toggleUserDetails(btn.dataset.toggleUser); });
        });
        usersListBody.querySelectorAll('.user-row').forEach(row => {
            row.addEventListener('click', () => toggleUserDetails(row.dataset.email));
        });
        usersListBody.querySelectorAll('[data-approve-user]').forEach(btn => {
            btn.addEventListener('click', () => approveUser(btn.dataset.approveUser));
        });
        // Update the "what does this role mean" hint live as the dropdown
        // changes, so the superadmin sees the consequence before saving.
        usersListBody.querySelectorAll('[data-role-select]').forEach(sel => {
            sel.addEventListener('change', () => {
                const safeEmail = sanitizeUserId(sel.dataset.roleSelect);
                const hint = document.getElementById('roleHint-' + safeEmail);
                if (hint) hint.innerHTML = roleHintHtml({ role: sel.value });
            });
        });
        usersListBody.querySelectorAll('[data-delete-user]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteUser(btn.dataset.deleteUser);
            });
        });
        usersListBody.querySelectorAll('[data-save-user]').forEach(btn => {
            btn.addEventListener('click', () => updateUserPermissions(btn.dataset.saveUser));
        });
        usersListBody.querySelectorAll('[data-reject-user]').forEach(btn => {
            btn.addEventListener('click', () => rejectUser(btn.dataset.rejectUser));
        });
    } catch (error) {
        console.error('Failed to load users:', error);
        usersListBody.innerHTML = '<tr><td colspan="7" class="empty-state"><em>Unable to load approvals.</em></td></tr>';
    }
}

// Build a safe DOM id/container key from an email.
// ==== USERS BADGE
//  USERS BADGE
function countPendingApprovals(users) {
    return (users || []).filter(function (u) {
        return u && u.status === 'pending' && isApprovalQueueRole(u);
    }).length;
}

function setUsersBadge(count) {
    if (!usersBadge) return;
    const n = Number(count) || 0;
    usersBadge.textContent = n > 99 ? '99+' : String(n);
    usersBadge.style.display = n > 0 ? 'inline' : 'none';
}

function startUsersBadgeListener() {
    if (usersBadgeUnsub) return;
    if (!currentUserIsSuperAdmin()) return;
    try {
        usersBadgeUnsub = db.collection('users')
            .where('status', '==', 'pending')
            .onSnapshot(function (snap) {
                const pending = [];
                snap.forEach(function (doc) {
                    pending.push(Object.assign({ id: doc.id }, doc.data()));
                });
                setUsersBadge(countPendingApprovals(pending));
            }, function (err) {
                console.warn('[Users] pending-count listener error:', err);
            });
    } catch (e) {
        console.warn('[Users] could not start pending-count listener:', e);
    }
}
function sanitizeUserId(email) {
    return String(email || 'u').toLowerCase().replace(/[^a-z0-9]/g, '_');
}
function userEmailKey(user) { return user.email || user.id || ''; }

/**
 * The assignable roles a superadmin can assign from this screen.
 * `owner` (Area Manager) and `hr` (HR) share the same dashboard but differ
 * only in profile label and chat access. `rmsm` (RM/SM) mirrors the Area
 * Manager role exactly — same dashboard, same branch/feature permissions,
 * same ticket filing — with no chat access.
 *
 * ⚠️ `owner` is the STORED value and is deliberately unchanged for the
 * Area Manager role. The role was renamed "Area Manager" for display only,
 * so every existing user document — and the rules, the chat allowlist and
 * the login redirect that all compare the value — keeps working untouched.
 * Do not "tidy" the value to 'area_manager'.
 */
const ASSIGNABLE_ROLES = ['owner', 'hr', 'rmsm'];

/**
 * Read a user's role, normalised and clamped to an assignable role.
 * Anything missing/legacy/unknown falls back to 'owner', which is the
 * safe default: no chat access, and the status quo for existing accounts.
 */
function currentUserRoleLabel(user) {
    const role = String((user && user.role) || 'owner').trim().toLowerCase();
    return ASSIGNABLE_ROLES.indexOf(role) > -1 ? role : 'owner';
}

/**
 * The account's role EXACTLY as stored — normalised (trim + lowercase) but NOT
 * clamped to ASSIGNABLE_ROLES.
 *
 * ⚠️ WHY THIS IS SEPARATE FROM currentUserRoleLabel(). That one CLAMPS, and it
 * is what the WRITE path must use so a hand-edited dropdown can never write a
 * privileged role. But it is the wrong thing to DISPLAY: a real 'superadmin' is
 * not assignable, so it clamps to 'owner' and the User Approvals row showed a
 * superadmin as "Area Manager". This reads the truth — for the badge, the card,
 * and the "can this role be edited here?" check — so a superadmin shows as a
 * superadmin and is never silently demoted by an Approve/Save.
 */
function storedRole(user) {
    return String((user && user.role) || 'owner').trim().toLowerCase();
}

/**
 * Human-readable label for a role, used in the UI (badge, card, hints).
 *
 * ⚠️ Built on storedRole(), NOT currentUserRoleLabel(): the clamp would render a
 * real 'superadmin' as "Area Manager". Reading the stored role means the row
 * shows what the account actually is. Unknown/legacy values still fall back to
 * the safe "Area Manager" default.
 */
function roleDisplayName(user) {
    const role = storedRole(user);
    if (role === 'hr') return 'HR';
    if (role === 'rmsm') return 'RM/SM';
    if (role === 'superadmin') return 'Superadmin';
    if (role === 'operator') return 'Operator';
    // 'owner' (Area Manager) and any unknown fallback are all shown as Area Manager.
    return 'Area Manager';
}

/**
 * CSS class for the role badge, so the colour matches roleDisplayName():
 * superadmin (amber) and HR (teal) get their own class; RM/SM and unknown roles
 * keep the Area Manager violet. `.role-badge.superadmin` and its dark-mode
 * override already exist (style.css / theme.css).
 */
function roleBadgeClass(user) {
    const role = storedRole(user);
    if (role === 'hr' || role === 'superadmin') return role;
    return 'owner';
}

/** True when the account's stored role is one the dropdown may change here. */
function roleIsAssignable(user) {
    return ASSIGNABLE_ROLES.indexOf(storedRole(user)) > -1;
}

/**
 * True when the account belongs in the User Approvals QUEUE at all.
 *
 * ⚠️ A superadmin is the APPROVER, and an operator is created directly in
 * Firestore (see docs/reset.html) — neither is ever approved through this
 * screen, so neither should ever be listed here. This is what stops a
 * self-registered account (created role:'owner' + status:'pending') that was
 * later re-roled to superadmin from lingering in the queue as a phantom
 * "Area Manager" approval. Everything else (owner/hr/rmsm, and a role-less
 * account that still defaults to owner) remains an approval candidate.
 */
function isApprovalQueueRole(user) {
    const role = storedRole(user);
    return role !== 'superadmin' && role !== 'operator';
}

/** One-line explanation of what the currently selected role means. */
function roleHintHtml(user) {
    const label = currentUserRoleLabel(user);
    if (label === 'hr') {
        return '<i class="fas fa-comments"></i> HR can use the HR &amp; Superadmin chat. Branches and feature permissions are the same as an Area Manager.';
    }
    if (label === 'rmsm') {
        return '<i class="fas fa-user-cog"></i> RM/SM has the same dashboard, branches and ticket access as an Area Manager, but no extra messaging.';
    }
    return 'Area Manager has no chat access, and is the one role that can file a new ticket from the dashboard. Branches and feature permissions are the same as an HR member.';
}

// Exposed for the unit test (test/set-role.test.js), which runs this block
// in a vm sandbox where a bare `const` would not reach the global object.
window.__setRoleInternals = {
    ASSIGNABLE_ROLES: ASSIGNABLE_ROLES,
    currentUserRoleLabel: currentUserRoleLabel,
    storedRole: storedRole,
    roleDisplayName: roleDisplayName,
    roleBadgeClass: roleBadgeClass,
    roleIsAssignable: roleIsAssignable,
    isApprovalQueueRole: isApprovalQueueRole,
    roleHintHtml: roleHintHtml,
    clampRoleSelection: function (value) {
        const selected = String(value || 'owner').trim().toLowerCase();
        return ASSIGNABLE_ROLES.indexOf(selected) > -1 ? selected : 'owner';
    }
};

// Render the branch checkboxes for a user's detail panel (pre-checking current).
function renderDetailBranchCheckboxes(email, selectedBranches) {
    if (!branches || !branches.length) return '<p style="color:var(--text-muted);font-size:0.85rem;">No branches loaded.</p>';
    const safeEmail = sanitizeUserId(email);
    return branches.map(branch => {
        const bname = branch.branchName || branch.id || '';
        const checked = (selectedBranches || []).includes(bname) ? 'checked' : '';
        return `
            <label class="quick-access-item">
                <span class="quick-access-name">${escapeHTML(bname)}</span>
                <input type="checkbox" name="detailBranch_${safeEmail}" value="${escapeHTML(bname)}" ${checked}>
            </label>
        `;
    }).join('');
}

function toggleUserDetails(email) {
    if (!email) return;
    const safeEmail = sanitizeUserId(email);
    const row = document.getElementById('userDetail-' + safeEmail);
    if (!row) return;
    const show = row.style.display === 'none';
    row.style.display = show ? '' : 'none';
    const btn = document.querySelector(`[data-toggle-user="${CSS.escape(email)}"]`);
    if (btn) {
        const icon = btn.querySelector('i');
        if (icon) icon.className = show ? 'fas fa-chevron-up' : 'fas fa-chevron-down';
    }
}

function getUserDetailData(email) {
    const safeEmail = sanitizeUserId(email);
    const branchesSelected = Array.from(document.querySelectorAll(`input[name="detailBranch_${safeEmail}"]:checked`)).map(i => i.value);

    // Read the selected role from the dropdown and clamp it through the
    // same allowlist, so a tampered DOM value can never write an arbitrary
    // role (e.g. 'superadmin') into a user document.
    //
    // ⚠️ A LOCKED role (superadmin/operator) renders NO <select> — only a
    // read-only badge — so a missing element means "leave the role alone", NOT
    // "owner". Returning null here is what stops approveUser()/
    // updateUserPermissions() from silently DEMOTING a superadmin to Area
    // Manager by writing role:'owner' over it.
    const roleEl = document.getElementById('roleSelect-' + safeEmail);
    const role = roleEl ? window.__setRoleInternals.clampRoleSelection(roleEl.value) : null;

    return {
        role: role,
        branches: branchesSelected,
        permissions: {
            viewOnly: !!(document.getElementById('dp-view-' + safeEmail) && document.getElementById('dp-view-' + safeEmail).checked),
            canEdit: !!(document.getElementById('dp-edit-' + safeEmail) && document.getElementById('dp-edit-' + safeEmail).checked),
            canDownload: !!(document.getElementById('dp-download-' + safeEmail) && document.getElementById('dp-download-' + safeEmail).checked)
        }
    };
}

function getUserEmailLower(email) { return String(email || '').trim().toLowerCase(); }

/**
 * Nudge the chat people directory after a role change.
 *
 * The conversation list and the "new chat" picker read the chat directory
 * (the legacy room's `profiles`), NOT `users` — an HR member cannot read
 * `users`, so the directory is the only roster they can see.
 *
 * The rules only let a person write their OWN directory entry, so a
 * superadmin cannot edit a colleague's name or role here, and the entry
 * carries no `active` flag (the deployed allowlist is
 * email/role/displayName/title). Eligibility is therefore derived from the
 * stored `role`, which the person publishes themselves. All this can do is
 * re-read the directory so the change shows up immediately on this page.
 */
function refreshChatDirectory() {
    if (window.ChatService && typeof window.ChatService.refreshDirectory === 'function') {
        try {
            window.ChatService.refreshDirectory();
        } catch (e) { /* the chat is optional; never block a role change */ }
    }
}

async function approveUser(email) {
    const lower = getUserEmailLower(email);
    const detail = getUserDetailData(email);

    // ⚠️ REFUSE TO APPROVE WITH NO BRANCHES. This used to write `branches: []`
    // silently and report success. The consequence was invisible until much
    // later: the approved manager saw an empty dashboard, "No branch access
    // assigned yet", and every ticket link emailed to them was refused — with
    // no record of who removed their access or when.
    //
    // It happens whenever the Branch Access checkboxes render empty — see
    // renderDetailBranchCheckboxes(), which shows "No branches loaded." when the
    // `branches` collection read returns nothing — and there is then nothing to
    // tick. So this guard is the last line of defence, and it must LOUDLY fail
    // rather than silently strip access.
    if (!Array.isArray(detail.branches) || detail.branches.length === 0) {
        showToast(
            'Cannot approve: assign at least one branch first. '
            + 'If none are listed, the branch list has not loaded — reload this page.',
            'error'
        );
        return;
    }

    try {
        // ⚠️ A locked role (superadmin/operator) must NOT be overwritten.
        // getUserDetailData() returns role:null for those, so the `role` key is
        // omitted entirely and the stored role is preserved. Writing the clamped
        // 'owner' here is exactly what used to silently demote a superadmin to
        // Area Manager the moment anyone approved them.
        const update = {
            branches: detail.branches,
            permissions: detail.permissions,
            status: 'approved',
            approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (detail.role) update.role = detail.role;
        await db.collection('users').doc(lower).update(update);
        showToast('User approved as ' + (detail.role === 'hr' ? 'HR' : (detail.role === 'rmsm' ? 'RM/SM' : 'Owner')) + '.', 'success');
        refreshChatDirectory();
        await loadSuperadminUsers();
    } catch (error) {
        console.error('Failed to approve user:', error);
        showToast('Unable to approve user.', 'error');
        return;
    }

    // The account IS approved at this point, so the per-branch group chat is
    // best-effort: it runs AFTER the try/catch and never throws, so a chat
    // failure can only log — it can never be reported as "Unable to approve".
    // For every branch the member was just assigned, chats/branch-<slug> is
    // created if missing (or its `members` reseeded if the team changed) with
    // Superadmin + the assigned Area Manager/HR/RM/SM — the store group the
    // approval screen is for.
    await ensureBranchGroupChats(lower, Array.isArray(detail.branches) ? detail.branches : []);
}

/**
 * Ensure chats/branch-<slug> exists for every branch in `branches`, seeded
 * with that store's team — Superadmin + the Area Manager/HR/RM/SM assigned
 * to THIS branch (see ChatService.branchGroupMembers in js/chat.js).
 *
 * This is what makes "approve a member → the store group chat is already
 * there" automatic: approveUser() and updateUserPermissions() both call it
 * after the account write succeeds — and backfillBranchGroupChats() reuses
 * it for the dashboard-load sweep over ALL existing accounts. The room id
 * comes from ChatService.branchKey so client, rules and approval agree on
 * the slug.
 *
 * `approvedEmail` is optional: the approve/save paths pass the account they
 * just wrote — force-added ONLY while the store has a real team (see the gate
 * in branchGroupMembers(); it can never seed or keep a teamless room);
 * the backfill passes null because nobody is being approved — the
 * roster alone decides membership. `allUsers` is an optional pre-loaded
 * roster: given it, NO users read happens, so the backfill's N branches
 * cost one `users` read in total.
 *
 * Idempotent, and deliberately never throws (it runs after the approval
 * succeeded, so it must not be able to report the approval as failed):
 *   - the room doc is written with `{ merge: true }`, so a re-run can only
 *     ever converge — it never duplicates or resets anything;
 *   - if the room exists and `members` is ALREADY the computed team, the
 *     write is skipped outright (re-approving the same branch is a no-op);
 *   - if the team CHANGED (another RM/SM assigned since), `members` is
 *     reseeded — the room's `members` is the superadmin-managed list the
 *     rules read, and canManageBranchRoom() is what permits this write.
 * Only `type`, `title` and `members` are written, so the update stays inside
 * the branch-room rule's hasOnly() allowlist and never touches the preview.
 */
async function ensureBranchGroupChats(approvedEmail, branches, allUsers) {
    if (!Array.isArray(branches) || branches.length === 0) return;

    const chat = window.ChatService;
    if (!chat || typeof chat.branchGroupMembers !== 'function' || typeof chat.branchKey !== 'function') {
        // Chat is optional: never block (or fail) an approval on it.
        console.warn('[Chat] ChatService unavailable — branch group chats skipped.');
        return;
    }

    if (!Array.isArray(allUsers)) {
        let usersSnap;
        try {
            usersSnap = await db.collection('users').get();
        } catch (error) {
            console.warn('[Chat] could not load users for branch group chat:', error);
            return;
        }
        allUsers = usersSnap.docs.map(function (d) { return { id: d.id, ...d.data() }; });
    }

    for (const branch of branches) {
        // Which step denied the write shows up in the catch log, so a
        // "Missing or insufficient permissions" is debuggable without
        // guessing: 'read room' = the roomRef.get() below (the READ rule),
        // 'seed room' = the roomRef.set() (the CREATE/UPDATE rule).
        let op = 'read room';
        try {
            const roomId = chat.branchKey(branch);
            const members = chat.branchGroupMembers(branch, allUsers, approvedEmail);

            const roomRef = db.collection('chats').doc(roomId);
            // The pre-read is a duplicate-skip optimisation, NOT a gate: a
            // denied get() must never abort the seed — the set() below has
            // its own CREATE/UPDATE rule and is the operation that matters.
            let existing = null;
            try {
                existing = await roomRef.get();
            } catch (readError) {
                console.warn('[Chat] branch room pre-read denied for', branch, '— proceeding to seed anyway:', readError);
                existing = null;
            }
            const roomExists = !!(existing && existing.exists);

            // PHANTOM CLEANUP - a Store chat must only exist when the branch has
            // a real team (an approved Area Manager / RM/SM). HR and the
            // Superadmin are company-wide by spec and must NOT, on their own,
            // keep a store room alive. If the branch has no store team we DELETE
            // the room instead of leaving an empty shell the superadmin's
            // remembered-rooms fallback would keep resurrecting.
            //
            // ⚠️ THIS RUNS ON EVERY PATH — approve/save included. The approvedEmail
            // gate that used to exempt them is gone: every call path reads `users`
            // FRESH, after the account write, so the old "the roster may not have
            // caught up with the approval" fear could not hold — and the exemption
            // did real damage. Re-saving an Area Manager as HR force-added the
            // account back into `members` (branchGroupMembers) and SKIPPED this
            // delete, so the teamless store's room survived as a 1-member ghost
            // and its branches never left that person's chat list. The superadmin
            // `allow delete` rule (already present for the reset tool) authorises
            // this.
            if (roomExists && chat.branchHasStoreTeam
                && !chat.branchHasStoreTeam(branch, allUsers)) {
                op = 'delete room';
                await roomRef.delete();
                if (chat.forgetBranchRoom) chat.forgetBranchRoom(roomId);
                console.log('[Chat] deleted phantom branch chat (no store team):', roomId);
                continue;
            }
            // `members.length < 2` blocks only CREATING a near-empty room (an
            // approved person + at least one superadmin). An EXISTING room is
            // still compared and RESEEDED when the team shrank — e.g. the last
            // assigned member was just unticked and only superadmins remain —
            // because that reseed is exactly what drops the removed account
            // from `members`, the list both the rules and the sidebar query
            // read.
            if (!roomExists && members.length < 2) continue;
            if (roomExists) {
                const current = ((existing.data() || {}).members || [])
                    .map(function (e) { return String(e || '').toLowerCase(); })
                    .sort()
                    .join('\n');
                if (current === members.slice().sort().join('\n')) {
                    // Duplicate-skip: the room already holds this exact team.
                    if (chat.noteBranchRoom) chat.noteBranchRoom(roomId);
                    continue;
                }
            }
            // Missing room, or a team that changed since — (re)seed it. `title`
            // is the bare branch name ("SM Fairview"): the (Store name) the
            // member sees in the sidebar and the open header.
            op = 'seed room';
            await roomRef.set({
                type: 'group',
                title: String(branch),
                members: members
            }, { merge: true });
            if (chat.noteBranchRoom) chat.noteBranchRoom(roomId);
            console.log('[Chat] branch group chat ready:', roomId, '(' + members.length + ' members)');
        } catch (error) {
            // One branch failing must never break the approval or the others.
            console.error('[Chat] could not seed branch group chat for', branch, 'op=' + op, error);
        }
    }
}

// ==============================================================
//  DASHBOARD-LOAD BACKFILL
//  approveUser()/updateUserPermissions() only seed branches you actively
//  touch. Accounts created BEFORE those hooks existed — and any room
//  deleted or team-drifted since — would otherwise never get their store
//  group chat. So a superadmin's Command Center load sweeps the UNION of
//  every approved account's branch access: one `users` read, then
//  ensureBranchGroupChats() per distinct branch, with the duplicate-skip
//  making a converged pass a pure no-op. Never throws; the auth callback
//  fires it once per page load (see branchBackfillAttempted).
// ==============================================================
/** Every branch document the Command Center has loaded (`let branches`). */
function getAllBranchDocs() {
    return Array.isArray(branches) ? branches : [];
}

async function backfillBranchGroupChats(extraBranches) {
    if (!currentUserIsSuperAdmin()) return;   // operators never write rooms
    // The module-level branch DOCUMENTS (script.js `let branches`), captured
    // before the local `branches` list below shadows the name.
    const branchDocs = getAllBranchDocs();

    const chat = window.ChatService;
    if (!chat || typeof chat.branchGroupMembers !== 'function' || typeof chat.branchKey !== 'function') return;

    let usersSnap;
    try {
        usersSnap = await db.collection('users').get();
    } catch (error) {
        console.warn('[Chat] could not load users for branch chat backfill:', error);
        return;
    }
    const allUsers = usersSnap.docs.map(function (d) { return { id: d.id, ...d.data() }; });

    // The union of all branch access: every distinct branch named in an
    // APPROVED account's `branches` (trimmed, case-insensitively deduped —
    // "SM Fairview" and "sm fairview" are one store, one room).
    const seen = {};
    const branches = [];
    const addBranch = function (b) {
        const raw = String(b || '').trim();
        if (!raw) return;
        const key = raw.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        branches.push(raw);
    };
    allUsers.forEach(function (u) {
        if (!u) return;
        const status = String(u.status || 'approved').trim().toLowerCase();
        if (status !== 'approved') return;
        if (!Array.isArray(u.branches)) return;
        u.branches.forEach(addBranch);
    });
    // ⚠️ ALSO every branch that EXISTS, and every branch the caller names
    // (e.g. the ones a user was just moved OUT of). The roster union above
    // only contains branches somebody is assigned to RIGHT NOW — so when a
    // store's last Area Manager moved to another branch, that store dropped out
    // of the sweep and its room kept the moved person in `members` forever.
    // HR and superadmins are members of EVERY room, so a role change of one of
    // them (HR -> Area Manager, or a superadmin re-roled in the Firebase
    // console) needs every room revisited, not just their own branches.
    branchDocs.forEach(function (b) {
        addBranch(b && (b.branchName || b.name));
    });
    (Array.isArray(extraBranches) ? extraBranches : []).forEach(addBranch);

    // In parallel: each branch is an independent room, and ensureBranchGroupChats
    // never throws (one failing branch logs and the rest carry on).
    await Promise.all(branches.map(function (branch) {
        // approvedEmail is deliberately null — nobody is being approved
        // here; the roster alone decides membership (branchGroupMembers
        // still adds every assigned account plus the superadmins).
        return ensureBranchGroupChats(null, [branch], allUsers).catch(function (error) {
            // One branch failing must never break the backfill or the others.
            console.error('[Chat] branch chat backfill failed for', branch, error);
        });
    }));
}

async function updateUserPermissions(email) {
    const lower = getUserEmailLower(email);
    const detail = getUserDetailData(email);

    // Same reasoning as approveUser(): saving with an empty branch list silently
    // strips the user's access. Refuse rather than write it.
    // An empty branch list is allowed: the user is removing ALL branch access
    // (e.g. converting HR → RM/SM with no store assigned). The diff logic below
    // will prune every previous branch room, dropping the user from all branch
    // group chat lists. Do NOT refuse an empty list.
    if (!Array.isArray(detail.branches)) {
        showToast(
            'Cannot save: the branch list has not loaded — reload this page.',
            'error'
        );
        return;
    }

    // Read the branches this account HOLDS right now, BEFORE the update
    // overwrites them. The diff against the saved list is what tells us which
    // branch rooms must be reseeded WITHOUT this account later — without the
    // prior value there is no way to know which rooms to prune. Best-effort:
    // an unreadable doc skips only the removal reseed, never the save itself.
    let prevBranches = [];
    try {
        const prevSnap = await db.collection('users').doc(lower).get();
        if (prevSnap.exists) {
            const prevData = prevSnap.data() || {};
            if (Array.isArray(prevData.branches)) prevBranches = prevData.branches;
        }
    } catch (readError) {
        console.warn('[Chat] could not read prior branches for', lower, '— removal reseed skipped:', readError);
    }

    try {
        // ⚠️ Same locked-role protection as approveUser(): omit `role` for a
        // superadmin/operator so saving their branches/permissions never demotes
        // them. An assignable account writes the dropdown value as before.
        const update = {
            branches: detail.branches,
            permissions: detail.permissions,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (detail.role) update.role = detail.role;
        await db.collection('users').doc(lower).update(update);
        showToast('Saved as ' + (detail.role === 'hr' ? 'HR' : (detail.role === 'rmsm' ? 'RM/SM' : 'Owner')) + '.', 'success');
        refreshChatDirectory();
        await loadSuperadminUsers();
    } catch (error) {
        console.error('Failed to save user permissions:', error);
        showToast('Unable to save permissions.', 'error');
        return;
    }

    // Saving is how branches get CHANGED on an existing account, so the same
    // auto-generation runs here (see ensureBranchGroupChats): a newly ticked
    // branch gets its store group chat with everyone currently assigned to it.
    await ensureBranchGroupChats(lower, Array.isArray(detail.branches) ? detail.branches : []);

    // AND an UNTICKED branch must be pruned from its room. Recompute those
    // rooms from the FRESH roster (approvedEmail = null — nobody is being
    // approved here, the roster alone decides) so this account drops out of
    // `members`. That is what makes the store chat disappear from their
    // sidebar live — and stay gone on a hard refresh, because the sidebar
    // query is `chats where members array-contains me`.
    const keptBranches = {};
    (Array.isArray(detail.branches) ? detail.branches : []).forEach(function (b) {
        keptBranches[String(b || '').trim().toLowerCase()] = true;
    });
    const removedBranches = prevBranches.filter(function (b) {
        const key = String(b || '').trim().toLowerCase();
        return key && !keptBranches[key];
    });
    if (removedBranches.length) {
        await ensureBranchGroupChats(null, removedBranches);
    }

    // ⚠️ THEN EVERY BRANCH ROOM, not only the ticked/unticked ones. HR and
    // superadmins sit in EVERY branch room without holding those branches, so
    // a ROLE change (HR -> Area Manager / RM/SM, or back) changes rooms the
    // diff above never visits — the person stayed a member of every store
    // chat. The full sweep recomputes each room's `members` from the FRESH
    // roster. Idempotent: a room already holding the right team is skipped.
    //
    // The edited person's OWN browser follows on its own: js/chat.js watches
    // users/<their email>, reloads on a role/branch change and prunes their
    // remembered rooms there. (The localStorage cleanup that used to sit here
    // ran in THIS admin's browser, so it never reached the edited user.)
    await backfillBranchGroupChats(prevBranches.concat(Array.isArray(detail.branches) ? detail.branches : []));
}

async function rejectUser(email) {
    const lower = getUserEmailLower(email);
    if (!confirm('Reject this user registration? They will not be able to access the dashboard.')) return;
    try {
        await db.collection('users').doc(lower).update({
            status: 'rejected',
            rejectedAt: firebase.firestore.FieldValue.serverTimestamp(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        showToast('User registration rejected.', 'info');
        await loadSuperadminUsers();
    } catch (error) {
        console.error('Failed to reject user:', error);
        showToast('Unable to reject user.', 'error');
    }
}

async function deleteUser(email) {
    const lower = getUserEmailLower(email);
    if (!confirm('Delete this user permanently from the system? This action cannot be undone.')) return;

    // Read the account's branch access BEFORE the delete, so every store room
    // it sits in can be reseeded without it afterwards — `members` is the list
    // both the rules and the sidebar query read, so a stale entry would keep
    // the deleted account visible in the store chat on every refresh.
    // Best-effort: an unreadable doc skips only the reseed, never the delete.
    let prevBranches = [];
    try {
        const prevSnap = await db.collection('users').doc(lower).get();
        if (prevSnap.exists) {
            const prevData = prevSnap.data() || {};
            if (Array.isArray(prevData.branches)) prevBranches = prevData.branches;
        }
    } catch (readError) {
        console.warn('[Chat] could not read branches before delete for', lower, '— room reseed skipped:', readError);
    }

    try {
        await db.collection('users').doc(lower).delete();
        showToast('User deleted.', 'success');
        await loadSuperadminUsers();
    } catch (error) {
        console.error('Failed to delete user:', error);
        showToast('Unable to delete user.', 'error');
        return;
    }

    // Recompute every room the deleted account was assigned to: the roster no
    // longer contains them, so the reseed drops them from `members`.
    if (prevBranches.length) {
        await ensureBranchGroupChats(null, prevBranches);
    }
}

const DEFAULT_BRANCH_NAMES = [
    'Banawe', 'BF Homes', 'Eastwood', 'Fame', 'Gil Fernando',
    'Hemady', 'Holy Spirit', 'MOA', 'Ortigas Center', 'Paseo',
    'Promenade', 'SM Clark', 'SM Fairview', 'SM Marikina', 'SM Marilao',
    'SM South Mall', 'SMDC Wind', 'SM East Ortigas', 'Sta. Rosa', 'SM Sucat', 'Tagaytay'
];

async function seedDefaultBranches() {
    const now = new Date();
    const offlineBranches = ['Banawe', 'BF Homes', 'Holy Spirit', 'SM Clark', 'Sta. Rosa', 'Tagaytay'];
    const hadOutageBranches = ['Banawe', 'Hemady', 'MOA', 'SM Fairview', 'Paseo'];

    for (const name of DEFAULT_BRANCH_NAMES) {
        const isOffline = offlineBranches.includes(name);
        await firestoreService.setBranch(name, {
            branchName: name,
            currentStatus: isOffline ? 'Offline' : 'Online',
            lastUpdated: firebase.firestore.Timestamp.fromDate(now),
            currentDowntimeStart: isOffline ? firebase.firestore.Timestamp.fromDate(now) : null,
            remarks: ''
        });

        if (hadOutageBranches.includes(name)) {
            const d1 = new Date(now); d1.setDate(d1.getDate() - 3); d1.setHours(9, 0, 0, 0);
            const d2 = new Date(d1); d2.setHours(d2.getHours() + 2);
            const d3 = new Date(now); d3.setDate(d3.getDate() - 1); d3.setHours(14, 30, 0, 0);
            const d4 = new Date(d3); d4.setHours(d4.getHours() + 1, 15);

            await firestoreService.addStatusLog({ branchName: name, status: 'Offline', dateTime: d1.toISOString(), remarks: '' });
            await firestoreService.addStatusLog({ branchName: name, status: 'Online', dateTime: d2.toISOString(), remarks: '' });
            await firestoreService.addStatusLog({ branchName: name, status: 'Offline', dateTime: d3.toISOString(), remarks: '' });
            await firestoreService.addStatusLog({ branchName: name, status: 'Online', dateTime: d4.toISOString(), remarks: '' });
        }
    }
}

// ==============================================================
//  DASHBOARD
// ==============================================================

// ==============================================================
//  BRANCH UPTIME / SLA STATISTICS
//  Derives monthly uptime % per branch from the same status logs
//  that generateMonthlyIncidents() uses. Pure compute — no new
//  Firestore collections or rules.
//
//  TWO SOURCES, TWO JOBS:
//    status_logs  -> the historical record of status changes.
//    branches doc -> the AUTHORITATIVE current state (currentStatus,
//                    currentDowntimeStart, lastUpdated).
//  A still-open outage has no closing "Online" log, so logs alone
//  cannot describe it — and an outage that began before the window
//  has its "Offline" log filtered out entirely. Any panel that reads
//  only the logs therefore reports a down branch as 100% healthy.
//  resolveOngoingOutageStart() reconciles the two; every downtime
//  panel must go through it.
// ==============================================================

/** Latest timestamp of any log, or null. Shared by the carry-in scan. */
function logTimeMs(log) {
    const t = log.dateTime?.toDate?.()?.getTime() || new Date(log.dateTime).getTime();
    return isNaN(t) ? null : t;
}

/**
 * CARRY-IN: was the branch already offline when the window opened?
 *
 * An outage that begins before the reporting window has its opening
 * "Offline" log filtered out by the in-window scan, so the window would
 * otherwise start mid-outage and attribute none of it. This looks at the
 * most recent log BEFORE the window and, if it says Offline, returns the
 * window start as the outage start (clamped, so a 3-week-old outage is only
 * charged for the days actually inside the window).
 *
 * @returns {Date|null}
 */
function resolveCarryInOutageStart(branchName, windowStart) {
    if (!windowStart) return null;
    const wMs = new Date(windowStart).getTime();
    let latest = null;
    let latestMs = -Infinity;
    for (const log of allLogs) {
        if (log.branchName !== branchName || log.status !== 'Offline') continue;
        const t = logTimeMs(log);
        if (t === null || t >= wMs || t <= latestMs) continue;
        latest = log;
        latestMs = t;
    }
    if (!latest) return null;
    // Only counts as a carry-in if no later log restored it before the window.
    let restored = false;
    for (const log of allLogs) {
        if (log.branchName !== branchName || log.status !== 'Online') continue;
        const t = logTimeMs(log);
        if (t !== null && t > latestMs && t < wMs) { restored = true; break; }
    }
    return restored ? null : new Date(wMs);
}

/**
 * Resolve the start of an outage that is STILL OPEN (branch is offline now).
 *
 * @param {string} branchName
 * @param {Date|null} logOpenStart  Offline start already derived from the
 *        in-window logs, or null when the log-derived state says "online".
 * @param {Date|number|null} windowStart  Clamp: an outage older than the
 *        reporting window still counts, but only from the window start.
 * @returns {Date|null} The outage start, or null when the branch is not offline.
 *
 * Prefers the earliest of the log-derived start and the branches-doc
 * timestamps so a single outage is never counted twice, and falls back to
 * `lastUpdated` when `currentDowntimeStart` was never written.
 */
function resolveOngoingOutageStart(branchName, logOpenStart, windowStart) {
    const branch = branches.find(b => b.branchName === branchName);
    const liveOffline = !!(branch && branch.currentStatus === 'Offline');
    if (!liveOffline && logOpenStart === null) return null;

    const candidates = [];
    if (logOpenStart) {
        const d = new Date(logOpenStart);
        if (!isNaN(d.getTime())) candidates.push(d.getTime());
    }
    if (liveOffline) {
        // currentDowntimeStart is the real outage start; lastUpdated is the
        // best available proxy on legacy docs written before it existed.
        const fallback = branch.currentDowntimeStart || branch.lastUpdated;
        if (fallback) {
            const d = fallback.toDate ? fallback.toDate() : new Date(fallback);
            if (!isNaN(d.getTime())) candidates.push(d.getTime());
        }
    }
    if (!candidates.length) return null;

    let startMs = Math.min.apply(null, candidates);
    if (windowStart) startMs = Math.max(startMs, new Date(windowStart).getTime());
    return new Date(startMs);
}

/**
 * Compute per-branch uptime for a month.
 * @returns {{ perBranch: Object.<string, {uptimePct:number, offlineMinutes:number, incidents:number}>, windowMs:number }}
 */
function computeBranchUptime(targetMonth) {
    const baseDate = targetMonth || new Date();
    const som = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
    const eom = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0, 23, 59, 59);
    const startMs = som.getTime();
    const now = Date.now();
    const isCurrentMonth = baseDate.getFullYear() === new Date().getFullYear() && baseDate.getMonth() === new Date().getMonth();
    // The uptime window runs from month start to "now" for the current month
    // (a partial month must not be penalized), or to month end for past months.
    const endMs = isCurrentMonth ? Math.min(now, eom.getTime()) : eom.getTime();
    const windowMs = Math.max(endMs - startMs, 60000);

    const out = {};
    branches.forEach(b => {
        out[b.branchName] = { uptimePct: 100, offlineMinutes: 0, incidents: 0 };
    });

    const monthLogs = allLogs.filter(log => {
        const t = log.dateTime?.toDate?.()?.getTime() || new Date(log.dateTime).getTime();
        return t >= startMs && t <= endMs;
    });

    const grouped = {};
    for (const log of monthLogs) {
        if (!grouped[log.branchName]) grouped[log.branchName] = [];
        grouped[log.branchName].push(log);
    }

    // Iterate every KNOWN branch, not just the ones with in-window logs.
    // A branch that is offline with no log inside the window (outage began
    // last month) is exactly the case that used to render as 100%.
    const names = Object.keys(out);
    for (const logName of Object.keys(grouped)) {
        if (names.indexOf(logName) === -1) names.push(logName);
    }

    for (const branchName of names) {
        const logs = grouped[branchName] || [];
        const sorted = [...logs].sort((a, b) => {
            const aT = a.dateTime?.toDate?.()?.getTime() || new Date(a.dateTime).getTime();
            const bT = b.dateTime?.toDate?.()?.getTime() || new Date(b.dateTime).getTime();
            return aT - bT;
        });

        let offlineStart = resolveCarryInOutageStart(branchName, startMs);
        let offlineMin = 0;
        let incidents = 0;

        for (const log of sorted) {
            const d = log.dateTime?.toDate ? log.dateTime.toDate() : new Date(log.dateTime);
            if (log.status === 'Offline' && offlineStart === null) {
                offlineStart = d;
            } else if (log.status === 'Online' && offlineStart !== null) {
                offlineMin += Math.max(0, getDurationMinutes(offlineStart, d));
                incidents++;
                offlineStart = null;
            }
        }

        // Ongoing outage: reconcile the log-derived start with the live
        // branches doc, then count it to the end of the measurement window.
        // resolveOngoingOutageStart() returns the EARLIEST valid start, so a
        // branch matched by both sources is counted once, not twice.
        const openStart = resolveOngoingOutageStart(branchName, offlineStart, startMs);
        if (openStart !== null) {
            offlineMin += Math.max(0, getDurationMinutes(openStart, new Date(endMs)));
            incidents++;
        }

        if (!out[branchName]) out[branchName] = { uptimePct: 100, offlineMinutes: 0, incidents: 0 };
        out[branchName].offlineMinutes = Math.round(offlineMin);
        out[branchName].incidents = incidents;
        const ratio = Math.max(0, 1 - (offlineMin * 60000) / windowMs);
        out[branchName].uptimePct = Math.round(ratio * 1000) / 10;
    }

    return { perBranch: out, windowMs };
}

/** True when the branches doc says this branch is offline right now. */
function isBranchOfflineNow(branchName) {
    const b = branches.find(x => x.branchName === branchName);
    return !!(b && b.currentStatus === 'Offline');
}

function uptimeClass(pct) {
    return pct >= 99 ? 'good' : (pct >= 95 ? 'warn' : 'bad');
}

/** Dashboard "Branch Uptime — This Month" panel: ranked worst-first with bars. */
function renderUptimePanel() {
    const listEl = document.getElementById('uptimePanelList');
    const pillEl = document.getElementById('uptimeNetworkPill');
    if (!listEl) return;

    if (!branches.length) {
        listEl.innerHTML = '<div class="activity-empty"><i class="fas fa-heart-pulse"></i> No branches yet — add status updates to track uptime.</div>';
        if (pillEl) pillEl.textContent = '—';
        return;
    }

    const { perBranch } = computeBranchUptime(new Date());
    const rows = branches
        .map(b => {
            const u = perBranch[b.branchName] || { uptimePct: 100, offlineMinutes: 0, incidents: 0 };
            return { name: b.branchName, offline: isBranchOfflineNow(b.branchName), ...u };
        })
        // Currently-offline branches float to the top: a branch that is down
        // right now must never be buried under healthy history.
        .sort((a, b) => (b.offline - a.offline) || (a.uptimePct - b.uptimePct) || (b.offlineMinutes - a.offlineMinutes));

    const avg = rows.reduce((s, r) => s + r.uptimePct, 0) / rows.length;
    const offCount = rows.filter(r => r.offline).length;
    if (pillEl) {
        pillEl.textContent = 'Network avg ' + avg.toFixed(1) + '%'
            + (offCount ? ' · ' + offCount + ' offline' : '');
        pillEl.classList.toggle('danger', offCount > 0);
    }

    listEl.innerHTML = rows.map(r => {
        const cls = r.offline ? 'bad' : uptimeClass(r.uptimePct);
        const barW = Math.max(2, Math.min(100, r.uptimePct));
        return `<div class="uptime-row${r.offline ? ' uptime-row-offline' : ''}">
            <span class="uptime-name" title="${escapeHTML(r.name)}">${escapeHTML(r.name)}${r.offline ? '<span class="uptime-offline-badge" title="Currently offline">● Offline</span>' : ''}</span>
            <span class="uptime-bar"><span class="uptime-fill ${cls}" style="width:${barW}%"></span></span>
            <span class="uptime-pct ${cls}">${r.uptimePct.toFixed(1)}%</span>
            <span class="uptime-meta">${r.incidents} incident${r.incidents === 1 ? '' : 's'} &middot; ${formatDuration(r.offlineMinutes)} down</span>
        </div>`;
    }).join('');
}

function renderDashboard() {
    renderSummaryCards();
    renderDashboardAlert();
    renderDashboardFilters();
    renderAttentionQueue();
    renderActivityFeed();
    renderDowntimeLeaders();
    renderUptimePanel();
    renderCharts();
    renderDashHero();
    updateOfflineBadge();
}

/** Hero clock + contextual subtitle (pure render, no timers). */
function renderDashHero() {
    const now = new Date();
    const timeEl = document.getElementById('dashHeroTime');
    const dateEl = document.getElementById('dashHeroDate');
    if (timeEl) timeEl.textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    if (dateEl) dateEl.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const sub = document.getElementById('dashHeroSub');
    if (!sub) return;
    const total = branches.length;
    const off = branches.filter(b => b.currentStatus === 'Offline').length;
    let action = 0;
    try { action = ticketsNeedingAction().length; } catch (e) { action = 0; }
    if (!total) sub.textContent = 'Connect your branches to start live monitoring.';
    else if (off > 0) sub.textContent = off + ' of ' + total + ' branches offline · ' + action + ' tickets need action.';
    else sub.textContent = 'All ' + total + ' branches online · ' + action + ' tickets need action.';
    // The pasted phone-only banner carries hardcoded mockup text ("7:49 AM",
    // "TUESDAY, OCT 6", "3 of 9 branches offline..."). Reflect the SAME live
    // data the desktop hero shows, so phones never see the stale values.
    const jn2Time = document.getElementById('jn2BannerTime');
    if (jn2Time) jn2Time.textContent = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    const jn2Date = document.getElementById('jn2BannerDate');
    if (jn2Date) jn2Date.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const jn2Sub = document.getElementById('jn2BannerSub');
    if (jn2Sub) jn2Sub.textContent = sub.textContent;
}

/** Elapsed minutes for a ticket's createdAt; -1 when unknown. */
function ticketAgeMinutes(t) {
    const raw = t && t.createdAt;
    const d = raw && raw.toDate ? raw.toDate() : (raw ? new Date(raw) : null);
    if (!d || isNaN(d.getTime())) return -1;
    return Math.max(0, (Date.now() - d.getTime()) / (1000 * 60));
}

/** v1 SLA: a ticket needs action when Pending/For Revision, overdue past 48h. */
function isTicketOverdue(t) {
    const s = (t && t.status) || 'Pending';
    if (s !== 'Pending' && s !== 'For Revision') return false;
    const age = ticketAgeMinutes(t);
    return age >= 48 * 60;
}

function ticketsNeedingAction() {
    return allTickets.filter(t => {
        const s = (t && t.status) || 'Pending';
        return s === 'Pending' || s === 'For Revision' || s === 'In Progress' || isPendingApproval(t);
    });
}

/** Start-of-day / 7-day / month window used by the dashboard range filter. */
function dashRangeStart(range, now) {
    const n = now instanceof Date ? now : new Date();
    if (range === 'today') return new Date(n.getFullYear(), n.getMonth(), n.getDate());
    if (range === '7d') { const d = new Date(n); d.setDate(d.getDate() - 6); d.setHours(0, 0, 0, 0); return d; }
    return new Date(n.getFullYear(), n.getMonth(), 1);
}

/** Offline branches sorted longest-downtime first (for strip + queue). */
function offlineBranchesByDowntime() {
    return branches
        .filter(b => b.currentStatus === 'Offline')
        .map(b => ({ branch: b, minutes: getCurrentDowntimeMinutes(b) }))
        .sort((a, b) => b.minutes - a.minutes);
}

function renderDashboardAlert() {
    if (!dashAlert) return;
    const total = branches.length;
    const off = offlineBranchesByDowntime();
    dashAlert.className = 'dash-alert';
    if (!total) { dashAlert.style.display = 'none'; dashAlert.innerHTML = ''; return; }
    if (!off.length) {
        dashAlert.classList.add('ok');
        dashAlert.style.display = '';
        dashAlert.innerHTML = '<i class="fas fa-check-circle"></i><span>All ' + total + ' branches operational</span>';
        return;
    }
    dashAlert.classList.add('critical');
    dashAlert.style.display = '';
    const names = off.slice(0, 4).map(o => escapeHTML(o.branch.branchName) + ' (' + formatDuration(o.minutes) + ')').join(' · ');
    const extra = off.length > 4 ? ' +' + (off.length - 4) + ' more' : '';
    dashAlert.innerHTML = '<i class="fas fa-exclamation-triangle"></i><span><strong>' + off.length + ' OFFLINE</strong> — '
        + names + extra + '</span><button type="button" class="dash-alert-btn" onclick="switchTab(\'branches\')">View</button>';
}

/** Severity-sorted "Needs Attention" queue: offline branches, overdue tickets,
// recent violations. Top 8 rows; static elapsed at render (no timer leaks). */
function renderAttentionQueue() {
    if (!attentionBody) return;
    const rows = [];
    offlineBranchesByDowntime().forEach(o => {
        rows.push({
            sev: 0, sevClass: 'sev-critical',
            branch: o.branch.branchName, issue: 'Branch offline',
            minutes: o.minutes, tab: 'branches', icon: 'fa-times-circle'
        });
    });
    allTickets.filter(isTicketOverdue).forEach(t => {
        rows.push({
            sev: 1, sevClass: 'sev-warning',
            branch: t.branch || '—',
            issue: 'Ticket overdue 48h+ (' + (t.ticketNumber || t.id || 'ticket') + ')',
            minutes: ticketAgeMinutes(t), tab: 'tickets', icon: 'fa-hourglass-half'
        });
    });
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    allViolations
        .filter(v => { const d = violationReportDate(v); return d && d.getTime() >= weekAgo; })
        .slice(0, 3)
        .forEach(v => {
            const d = violationReportDate(v);
            rows.push({
                sev: 2, sevClass: 'sev-info',
                branch: v.store || '—', issue: 'New violation: ' + (v.subject || 'report'),
                minutes: Math.max(0, (Date.now() - d.getTime()) / (1000 * 60)),
                tab: 'violations', icon: 'fa-video'
            });
        });
    rows.sort((a, b) => (a.sev - b.sev) || (b.minutes - a.minutes));
    const top = rows.slice(0, 8);
    if (attentionCount) attentionCount.textContent = rows.length ? (rows.length + ' open') : '';
    if (!top.length) {
        attentionBody.innerHTML = '<tr><td colspan="5" class="empty-state">'
            + '<i class="fas fa-check-circle"></i><p>All clear — nothing needs attention.</p></td></tr>';
        return;
    }
    attentionBody.innerHTML = top.map(r => '<tr>'
        + '<td><span class="sev-dot ' + r.sevClass + '"></span></td>'
        + '<td>' + escapeHTML(r.branch) + '</td>'
        + '<td><i class="fas ' + r.icon + '" style="margin-right:6px;color:var(--text-muted);"></i>' + escapeHTML(r.issue) + '</td>'
        + '<td>' + (r.minutes >= 0 ? escapeHTML(formatDuration(r.minutes)) : '—') + '</td>'
        + '<td><button type="button" class="btn btn-sm btn-secondary" onclick="switchTab(\'' + r.tab + '\')">Open</button></td>'
        + '</tr>').join('');
}

/** Last 8 events merged from status logs + tickets + violations. */
function renderActivityFeed() {
    if (!activityFeed) return;
    const events = [];
    allLogs.slice(0, 40).forEach(l => {
        const d = l.dateTime && l.dateTime.toDate ? l.dateTime.toDate() : new Date(l.dateTime);
        if (!d || isNaN(d.getTime())) return;
        events.push({
            time: d.getTime(),
            icon: l.status === 'Online' ? 'fa-check-circle' : 'fa-times-circle',
            cls: l.status === 'Online' ? 'act-online' : 'act-offline',
            text: (l.branchName || 'Branch') + ' went ' + (l.status || '—')
        });
    });
    allTickets.slice(0, 40).forEach(t => {
        const raw = t && t.createdAt;
        const d = raw && raw.toDate ? raw.toDate() : (raw ? new Date(raw) : null);
        if (!d || isNaN(d.getTime())) return;
        events.push({
            time: d.getTime(), icon: 'fa-ticket-alt', cls: 'act-ticket',
            text: 'Ticket ' + (t.ticketNumber || t.id || '') + ' · ' + (t.status || 'Pending') + ' · ' + (t.branch || '')
        });
    });
    allViolations.slice(0, 40).forEach(v => {
        const d = violationReportDate(v);
        if (!d) return;
        events.push({
            time: d.getTime(), icon: 'fa-video', cls: 'act-violation',
            text: 'Violation: ' + (v.subject || 'report') + ' · ' + (v.store || '')
        });
    });
    events.sort((a, b) => b.time - a.time);
    const top = events.slice(0, 8);
    if (!top.length) { activityFeed.innerHTML = '<li class="activity-empty">No activity yet.</li>'; return; }
    activityFeed.innerHTML = top.map(e => {
        const agoMin = Math.max(1, Math.round((Date.now() - e.time) / (1000 * 60)));
        return '<li class="activity-item">'
            + '<span class="activity-icon ' + e.cls + '"><i class="fas ' + e.icon + '"></i></span>'
            + '<span class="activity-text">' + escapeHTML(e.text) + '</span>'
            + '<span class="activity-time">' + escapeHTML(formatDuration(agoMin)) + ' ago</span>'
            + '</li>';
    }).join('');
}

function renderSummaryCards() {
    const online = branches.filter(b => b.currentStatus === 'Online').length;
    const offline = branches.filter(b => b.currentStatus === 'Offline').length;
    if (onlineCount) animateValue(onlineCount, online);
    if (offlineCount) animateValue(offlineCount, offline);
    if (activeOutages) animateValue(activeOutages, offline);
    calculateTotalMonthlyDowntime().then(total => {
        if (totalDowntime) totalDowntime.textContent = formatDuration(total);
    });
    const total = branches.length;
    const readiness = total ? Math.round((online / total) * 100) : null;
    // "—" when there is nothing to measure, so the tile never counts to a
    // fake 0% on an empty network.
    if (readinessPct) {
        if (readiness === null) readinessPct.textContent = '—';
        else animateValue(readinessPct, readiness, { suffix: '%' });
    }
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yLogs = allLogs.filter(l => {
        const t = l.dateTime && l.dateTime.toDate ? l.dateTime.toDate() : new Date(l.dateTime);
        return t && !isNaN(t.getTime()) && t >= dayAgo;
    });
    const yOff = yLogs.filter(l => l.status === 'Offline').length;
    const yOn = yLogs.filter(l => l.status === 'Online').length;
    if (readinessDelta) {
        if (!yOff && !yOn) { readinessDelta.textContent = 'No activity'; readinessDelta.className = 'dash-kpi-trend'; }
        else {
            const dir = yOff > yOn ? 'down' : (yOn > yOff ? 'up' : 'flat');
            readinessDelta.className = 'dash-kpi-trend delta-' + dir;
            readinessDelta.textContent = dir === 'flat' ? 'Steady'
                : (dir === 'down' ? '▼ ' + yOff + ' outages' : '▲ ' + yOn + ' back online');
        }
    }
    const off = offlineBranchesByDowntime();
    if (longestOutage) { longestOutage.textContent = off.length ? ('longest ' + formatDuration(off[0].minutes)) : 'All clear'; }
    const action = ticketsNeedingAction();
    const overdue = allTickets.filter(isTicketOverdue).length;
    if (ticketsAction) ticketsAction.textContent = action.length;
    if (ticketsOverdue) { ticketsOverdue.textContent = overdue ? (overdue + ' overdue') : 'On track'; }
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    const weekCount = allViolations.filter(v => { const d = violationReportDate(v); return d && d >= weekAgo; }).length;
    const prevCount = allViolations.filter(v => { const d = violationReportDate(v); return d && d >= twoWeeksAgo && d < weekAgo; }).length;
    if (violationsWeek) violationsWeek.textContent = weekCount;
    if (violationsDelta) {
        const diff = weekCount - prevCount;
        violationsDelta.className = 'card-delta ' + (diff > 0 ? 'delta-up' : (diff < 0 ? 'delta-down' : ''));
        violationsDelta.textContent = diff === 0 ? 'same as last week' : ((diff > 0 ? '▲ +' : '▼ ') + diff + ' vs last week');
    }
    const pending = allTickets.filter(t => ((t.status || 'Pending') === 'Pending')).length;
    const yTickets = allTickets.filter(t => {
        const raw = t && t.createdAt;
        const d = raw && raw.toDate ? raw.toDate() : (raw ? new Date(raw) : null);
        return d && !isNaN(d.getTime()) && d >= dayAgo;
    }).length;
    if (ticketsDelta) {
        ticketsDelta.className = 'card-delta' + (yTickets ? ' delta-up' : '');
        ticketsDelta.textContent = yTickets ? ('+' + yTickets + ' in last 24h · ' + pending + ' pending') : (pending + ' pending');
    }
}

async function calculateTotalMonthlyDowntime() {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    const startMs = startOfMonth.getTime();
    const endMs = endOfMonth.getTime();

    const monthLogs = allLogs.filter(log => {
        const t = log.dateTime?.toDate?.()?.getTime() || new Date(log.dateTime).getTime();
        return t >= startMs && t <= endMs;
    });

    const branchLogMap = {};
    for (const log of monthLogs) {
        const name = log.branchName;
        if (!branchLogMap[name]) branchLogMap[name] = [];
        branchLogMap[name].push(log);
    }

    // Include branches with NO in-window logs: a branch that went offline
    // before the 1st still contributes its ongoing downtime to the total.
    const names = new Set([...Object.keys(branchLogMap), ...branches.map(b => b.branchName).filter(Boolean)]);

    let totalMinutes = 0;
    for (const branchName of names) {
        totalMinutes += calculateDowntimeFromLogs(branchLogMap[branchName] || [], branchName, startMs);
    }
    return totalMinutes;
}

/**
 * Total downtime (minutes) for one branch from a set of status logs.
 *
 * @param {Array} logs
 * @param {string} [branchName]  Enables the live-outage reconciliation.
 * @param {Date|number} [windowStart]  Clamp for outages older than the window.
 *
 * A single "Offline" log is a REAL ongoing outage, not zero downtime — the
 * old `length < 2` early return reported 0m for a branch that was down.
 */
function calculateDowntimeFromLogs(logs, branchName, windowStart) {
    if (!logs || !logs.length) {
        // No logs at all: the live branches doc is the only evidence we have.
        if (!branchName) return 0;
        const openStart = resolveOngoingOutageStart(branchName, null, windowStart);
        return openStart === null ? 0 : Math.max(0, getDurationMinutes(openStart, new Date()));
    }
    const sorted = [...logs].sort((a, b) => {
        const aT = a.dateTime?.toDate?.()?.getTime() || new Date(a.dateTime).getTime();
        const bT = b.dateTime?.toDate?.()?.getTime() || new Date(b.dateTime).getTime();
        return aT - bT;
    });
    let total = 0, offlineStart = branchName ? resolveCarryInOutageStart(branchName, windowStart) : null;
    for (const log of sorted) {
        const d = log.dateTime?.toDate ? log.dateTime.toDate() : new Date(log.dateTime);
        if (log.status === 'Offline' && offlineStart === null) offlineStart = d;
        else if (log.status === 'Online' && offlineStart !== null) {
            total += getDurationMinutes(offlineStart, d);
            offlineStart = null;
        }
    }
    if (branchName) {
        const openStart = resolveOngoingOutageStart(branchName, offlineStart, windowStart);
        if (openStart !== null) total += Math.max(0, getDurationMinutes(openStart, new Date()));
    } else if (offlineStart !== null) {
        total += Math.max(0, getDurationMinutes(offlineStart, new Date()));
    }
    return total;
}

function renderQuickStatus() {
    const html = branches.length === 0
        ? '<div class="loading-spinner"><i class="fas fa-info-circle"></i> No branches.</div>'
        : branches.map(b => `
        <div class="quick-status-item">
            <span class="quick-status-name">${escapeHTML(b.branchName)}</span>
            <span class="quick-status-dot ${b.currentStatus === 'Online' ? 'online' : 'offline'}"></span>
        </div>
    `).join('');
    // Dashboard copy removed; the grid now lives on the Branch Monitor tab.
    // Both refs are kept so either host element renders (whichever exists).
    if (quickStatusList) quickStatusList.innerHTML = html;
    if (quickStatusListBranchTab) quickStatusListBranchTab.innerHTML = html;
}

function renderCharts() {
    renderDashboardFilters();
    renderStatusChart();
    renderTrendChart();
    renderDowntimeLeaders();
}

/** Populate + sync the dashboard branch/range filter controls. */
function renderDashboardFilters() {
    if (dashBranchFilter && !dashBranchFilter.dataset.populated) {
        const names = Array.from(new Set(branches.map(b => b.branchName).filter(Boolean)))
            .sort((a, b) => a.localeCompare(b));
        dashBranchFilter.innerHTML = '<option value="all">All Branches</option>'
            + names.map(n => '<option value="' + escapeHTML(n) + '">' + escapeHTML(n) + '</option>').join('');
        dashBranchFilter.dataset.populated = '1';
    }
    if (dashBranchFilter && dashBranchFilter.value !== dashBranch) {
        const has = dashBranch === 'all' || dashBranchFilter.querySelector('option[value="' + dashBranch + '"]');
        if (has) dashBranchFilter.value = dashBranch;
    }
    if (dashRangeGroup) {
        dashRangeGroup.querySelectorAll('[data-dash-range]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.dashRange === dashRange);
        });
    }
}

/** Top-5 branches by downtime in the selected range (respects filters). */
function renderDowntimeLeaders() {
    if (!downtimeLeaders) return;
    const now = new Date();
    const start = dashRangeStart(dashRange, now);
    const map = {};
    allLogs.forEach(l => {
        if (dashBranch !== 'all' && l.branchName !== dashBranch) return;
        const t = l.dateTime && l.dateTime.toDate ? l.dateTime.toDate() : new Date(l.dateTime);
        if (!t || isNaN(t.getTime()) || t < start) return;
        (map[l.branchName] = map[l.branchName] || []).push(l);
    });
    const rangeRows = Object.keys(map)
        // Pass branchName + window start so an in-range branch that is still
        // offline counts its OPEN outage too, not just its closed pairs.
        .map(name => ({ name, minutes: calculateDowntimeFromLogs(map[name], name, start), offline: false }))
        .filter(r => r.minutes > 0);

    // Offline-now branches: use getCurrentDowntimeMinutes so the leaderboard
    // matches the alert strip (e.g. Holy Spirit 850h 50m) exactly, even when
    // they have no new logs inside the selected range.
    const offlineNowMap = {};
    branches.filter(b => b.currentStatus === 'Offline').forEach(b => {
        const minutes = getCurrentDowntimeMinutes(b);
        if (minutes > 0) offlineNowMap[b.branchName] = minutes;
    });

    // Merge range-scoped rows with offline-now branches. When a branch appears in
    // both, keep the larger (true accumulated) downtime and mark it offline. This is
    // what surfaces Holy Spirit / SM Clark (850h 50m) on top of the leaderboard even
    // when they have no new status-change logs inside the selected range.
    const mergedRows = [];
    const seen = new Set();
    rangeRows.forEach(r => {
        const trueMinutes = offlineNowMap[r.name];
        if (trueMinutes !== undefined && trueMinutes > r.minutes) {
            mergedRows.push({ name: r.name, minutes: trueMinutes, offline: true });
        } else {
            mergedRows.push(r);
        }
        seen.add(r.name);
    });
    Object.keys(offlineNowMap).forEach(name => {
        if (!seen.has(name)) {
            mergedRows.push({ name, minutes: offlineNowMap[name], offline: true });
        }
    });

    const combined = mergedRows.sort((a, b) => b.minutes - a.minutes).slice(0, 5);

    if (!combined.length) { downtimeLeaders.innerHTML = '<li class="activity-empty">No downtime in this range.</li>'; return; }
    downtimeLeaders.innerHTML = combined.map((r, i) => '<li class="leader-row"><span class="leader-rank">' + (i + 1) + '</span>'
        + '<span class="leader-name' + (r.offline ? ' leader-offline' : '') + '">' + escapeHTML(r.name) + (r.offline ? '<span class="leader-offline-badge">● Offline</span>' : '') + '</span>'
        + '<span class="leader-time">' + escapeHTML(formatDuration(r.minutes)) + '</span></li>').join('');
}

function renderStatusChart() {
    const ctx = document.getElementById('statusChart').getContext('2d');
    const list = dashBranch === 'all' ? branches : branches.filter(b => b.branchName === dashBranch);
    const online = list.filter(b => b.currentStatus === 'Online').length;
    const offline = list.filter(b => b.currentStatus === 'Offline').length;
    if (statusChart) { statusChart.data.datasets[0].data = [online, offline]; statusChart.update(); return; }
    statusChart = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: ['Online', 'Offline'], datasets: [{ data: [online, offline], backgroundColor: ['#22c55e', '#ef4444'], borderColor: ['#FFFFFF', '#FFFFFF'], borderWidth: 3, hoverOffset: 8 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '65%', plugins: { legend: { position: 'bottom', labels: { color: '#64748B', padding: 14, font: { family: 'Inter', size: 12 } } } } }
    });
}

async function renderTrendChart() {
    const ctx = document.getElementById('trendChart').getContext('2d');
    const now = new Date();
    const rangeStart = dashRangeStart(dashRange, now);
    const endOfRange = dashRange === 'month'
        ? new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59)
        : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    // Day buckets from range start → end of range (inclusive).
    const dayMs = 24 * 60 * 60 * 1000;
    const dayCount = Math.max(1, Math.round((endOfRange - rangeStart) / dayMs) + 1);
    const dd = new Array(dayCount).fill(0);
    const labels = Array.from({ length: dayCount }, (_, i) => {
        const d = new Date(rangeStart.getTime() + i * dayMs);
        return (d.getMonth() + 1) + '/' + d.getDate();
    });
    const startMs = rangeStart.getTime();
    const endMs = endOfRange.getTime();

    const monthLogs = allLogs.filter(log => {
        if (dashBranch !== 'all' && log.branchName !== dashBranch) return false;
        const t = log.dateTime?.toDate?.()?.getTime() || new Date(log.dateTime).getTime();
        return t >= startMs && t <= endMs;
    });

    const branchLogMap = {};
    for (const log of monthLogs) {
        const name = log.branchName;
        if (!branchLogMap[name]) branchLogMap[name] = [];
        branchLogMap[name].push(log);
    }

    // Include offline branches with no log in range, so a long-running outage
    // that predates the range still plots across the days it covers.
    const chartNames = new Set(Object.keys(branchLogMap));
    branches.forEach(b => {
        if (!b.branchName) return;
        if (dashBranch !== 'all' && b.branchName !== dashBranch) return;
        if (isBranchOfflineNow(b.branchName)) chartNames.add(b.branchName);
    });

    for (const branchName of chartNames) {
        const logs = branchLogMap[branchName] || [];
        if (logs.length) {
            const sorted = [...logs].sort((a, b) => {
                const aT = a.dateTime?.toDate?.()?.getTime() || new Date(a.dateTime).getTime();
                const bT = b.dateTime?.toDate?.()?.getTime() || new Date(b.dateTime).getTime();
                return aT - bT;
            });
            // Carry-in: an outage already open when the range began still
            // contributes the days it covers inside this range.
            let os = resolveCarryInOutageStart(branchName, rangeStart);
            for (const log of sorted) {
                const d = log.dateTime?.toDate ? log.dateTime.toDate() : new Date(log.dateTime);
                if (log.status === 'Offline' && os === null) os = d;
                else if (log.status === 'Online' && os !== null) { distributeDowntimeFrom(os, d, dd, rangeStart); os = null; }
            }
            // Ongoing outage: reconcile with the live branches doc. The window
            // end (not Date.now()) is used so a past range is not extended.
            const openStart = resolveOngoingOutageStart(branchName, os, rangeStart);
            if (openStart !== null) distributeDowntimeFrom(openStart, new Date(endMs), dd, rangeStart);
        } else {
            const openStart = resolveOngoingOutageStart(branchName, null, rangeStart);
            if (openStart !== null) distributeDowntimeFrom(openStart, new Date(endMs), dd, rangeStart);
        }
    }
    if (trendChart) { trendChart.data.labels = labels; trendChart.data.datasets[0].data = dd; trendChart.update(); return; }
    trendChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets: [{ label: 'Downtime (min)', data: dd, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', fill: true, tension: 0.3, pointBackgroundColor: '#ef4444', pointRadius: 3, borderWidth: 2 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#64748B', font: { family: 'Inter', size: 11 } } } }, scales: { x: { grid: { color: 'rgba(148,163,184,0.25)' }, ticks: { color: '#64748B', font: { family: 'Inter', size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: window.innerWidth <= 640 ? 7 : undefined }, title: { display: true, text: 'Day', color: '#64748B' } }, y: { grid: { color: 'rgba(148,163,184,0.25)' }, ticks: { color: '#64748B', font: { family: 'Inter', size: 10 } }, title: { display: true, text: 'Minutes', color: '#64748B' }, beginAtZero: true } } }
    });
}

function distributeDowntimeFrom(startDate, endDate, dailyArray, rangeStart) {
    let start = new Date(startDate);
    const end = new Date(endDate);
    const anchor = rangeStart ? new Date(rangeStart) : null;
    if (anchor) anchor.setHours(0, 0, 0, 0);
    // An outage that began before the range still covers the whole range, so
    // clamp the START forward instead of bailing out on the first iteration
    // (the old `idx < 0 -> break` dropped that downtime entirely).
    if (anchor && start < anchor) start = new Date(anchor);
    while (start < end) {
        let idx;
        if (anchor) idx = Math.floor((new Date(start.getFullYear(), start.getMonth(), start.getDate()) - anchor) / (24 * 60 * 60 * 1000));
        else idx = start.getDate() - 1;
        if (idx < 0) idx = 0;
        if (idx >= dailyArray.length) break;
        const dayEnd = new Date(start); dayEnd.setHours(23, 59, 59, 999);
        if (end <= dayEnd) { dailyArray[idx] += getDurationMinutes(start, end); }
        else { dailyArray[idx] += getDurationMinutes(start, dayEnd); }
        start.setDate(start.getDate() + 1); start.setHours(0, 0, 0, 0);
    }
}

function updateOfflineBadge() {
    const offline = branches.filter(b => b.currentStatus === 'Offline').length;
    if (offline > 0) {
        offlineBadge.style.display = 'inline';
        offlineBadge.textContent = offline;
    } else {
        offlineBadge.style.display = 'none';
    }
}

// ==============================================================
//  BRANCH GROUPING & TABLES
// ==============================================================

function getBranchGroup(branchName) {
    const name = branchName.toLowerCase();
    if (name.startsWith('sm ')) return 'SM';
    if (name.startsWith('smdc')) return 'SMDC';
    if (name.startsWith('tagaytay')) return 'Tagaytay';
    if (name.includes('ortigas')) return 'Ortigas';
    return branchName;
}

let expandedGroups = {};

function renderBranchesTable() {
    const isAdmin = currentUserIsSuperAdmin();
    const searchTerm = searchInput.value.toLowerCase().trim();
    const filter = document.querySelector('.filter-btn[data-filter].active')?.dataset?.filter || 'all';
    const sortBy = sortSelect.value;
    const downtimeVal = downtimeFilter.value;
    const groupVal = groupFilter.value;

    // Monthly uptime per branch — chip in the Branch Monitor table + details
    const uptimeMap = computeBranchUptime(new Date()).perBranch;
    const uptimeChipFor = (name) => {
        const u = uptimeMap[name] || { uptimePct: 100 };
        return `<span class="uptime-chip ${uptimeClass(u.uptimePct)}" title="This month's uptime">${u.uptimePct.toFixed(1)}%</span>`;
    };

    // The row's action buttons, built once and used by BOTH the desktop
    // Actions cell and the trailing card cell: below 900px the desktop cells
    // hide and only the card shows (ROW CARD SWAP in style.css), so each row
    // needs its controls in both places. Both copies are wired by the
    // querySelectorAll('.btn-view'/'.btn-remove') passes at the end of this
    // function, so whichever cell is visible has working buttons.
    const branchActionsHtml = (name) => `
                    <button class="btn-view" data-tooltip="Details" data-branch="${escapeHTML(name)}"><i class="fas fa-eye"></i></button>
                    ${isAdmin ? `<button class="btn-remove" data-tooltip="Remove" data-branch="${escapeHTML(name)}"><i class="fas fa-trash-alt"></i></button>` : ''}`;

    // The trailing card cell — the same facts as the row, laid out in the
    // shared mockup-style card (head = branch + status pill, grid = the four
    // data columns, foot = actions). Emitted by BOTH row shapes, so a phone
    // sees identical cards whether the table is sorted flat or grouped.
    const branchCardCell = (b, sc, lu, dt, upChip) => `
                <td class="approval-card-cell" data-label="Card">
                    <div class="approval-card">
                        <div class="approval-card-head">
                            <span class="approval-card-branch"><i class="fas fa-store"></i>${escapeHTML(b.branchName)}</span>
                            <span class="approval-card-pill approval-card-pill--${sc === 'online' ? 'online' : 'offline'}">${escapeHTML(b.currentStatus)}</span>
                        </div>
                        <div class="approval-card-grid">
                            <div class="approval-card-field"><span class="approval-card-label">Group</span><span class="approval-card-value">${escapeHTML(getBranchGroup(b.branchName))}</span></div>
                            <div class="approval-card-field"><span class="approval-card-label">Uptime</span><span class="approval-card-value">${upChip}</span></div>
                            <div class="approval-card-field"><span class="approval-card-label">Last Updated</span><span class="approval-card-value">${lu}</span></div>
                            <div class="approval-card-field"><span class="approval-card-label">Current Downtime</span><span class="approval-card-value">${dt}</span></div>
                        </div>
                        <div class="approval-card-foot">
                            <div class="approval-card-actions">${branchActionsHtml(b.branchName)}</div>
                        </div>
                    </div>
                </td>`;

    let filtered = [...branches];
    if (searchTerm) filtered = filtered.filter(b => b.branchName.toLowerCase().includes(searchTerm));
    if (filter !== 'all') filtered = filtered.filter(b => b.currentStatus === filter);

    if (downtimeVal === 'has') filtered = filtered.filter(b => b.currentStatus === 'Offline' && b.currentDowntimeStart);
    else if (downtimeVal === 'none') filtered = filtered.filter(b => b.currentStatus !== 'Offline' || !b.currentDowntimeStart);
    else if (downtimeVal === 'gt1h') filtered = filtered.filter(b => getCurrentDowntimeMinutes(b) >= 60);
    else if (downtimeVal === 'gt6h') filtered = filtered.filter(b => getCurrentDowntimeMinutes(b) >= 360);
    else if (downtimeVal === 'gt24h') filtered = filtered.filter(b => getCurrentDowntimeMinutes(b) >= 1440);

    filtered.forEach(b => { b._group = getBranchGroup(b.branchName); });
    if (groupVal) filtered = filtered.filter(b => b._group === groupVal);

    filtered.sort((a, b) => {
        if (sortBy === 'group') { const g = a._group.localeCompare(b._group); if (g !== 0) return g; return a.branchName.localeCompare(b.branchName); }
        if (sortBy === 'branchName') return a.branchName.localeCompare(b.branchName);
        if (sortBy === 'currentStatus') return a.currentStatus.localeCompare(b.currentStatus);
        if (sortBy === 'lastUpdated') { const aT = a.lastUpdated?.toDate?.()?.getTime() || 0; const bT = b.lastUpdated?.toDate?.()?.getTime() || 0; return bT - aT; }
        if (sortBy === 'downtime') return getCurrentDowntimeMinutes(b) - getCurrentDowntimeMinutes(a);
        return 0;
    });

// ===== Pagination for the Branches table =====
    filteredBranches = filtered;
    const branchTotalPages = Math.ceil(filteredBranches.length / ITEMS_PER_PAGE) || 1;
    if (branchPage > branchTotalPages) branchPage = branchTotalPages;
    if (branchPage < 1) branchPage = 1;
    const branchStart = (branchPage - 1) * ITEMS_PER_PAGE;
    const branchEnd = Math.min(branchStart + ITEMS_PER_PAGE, filteredBranches.length);
    filtered = filteredBranches.slice(branchStart, branchEnd);

    if (filtered.length === 0) {
        branchesTableBody.innerHTML = `<tr><td colspan="7" class="empty-state"><i class="fas fa-search"></i><p>No branches match.</p></td></tr>`;
        renderBranchPagination();
        return;
    }

    if (sortBy === 'group') {
        const groups = {};
        filtered.forEach(b => { if (!groups[b._group]) groups[b._group] = []; groups[b._group].push(b); });
        let html = '';
        const groupKeys = Object.keys(groups).sort();
        groupKeys.forEach(groupName => {
            const members = groups[groupName];
            const online = members.filter(m => m.currentStatus === 'Online').length;
            const offline = members.filter(m => m.currentStatus === 'Offline').length;
            const isExpanded = expandedGroups[groupName] !== false;
            const arrowIcon = isExpanded ? 'fa-chevron-down' : 'fa-chevron-right';
            const displayStyle = isExpanded ? '' : 'style="display:none;"';
            const totalDT = members.reduce((sum, m) => sum + getCurrentDowntimeMinutes(m), 0);

            html += `<tr class="group-header-row" data-group="${escapeHTML(groupName)}">
                <td colspan="7">
                    <span class="group-toggle"><i class="fas ${arrowIcon}"></i></span>
                    <strong class="group-name">${escapeHTML(groupName)}</strong>
                    <span class="group-stats">
                        <span class="group-count">${members.length}</span>
                        <span class="group-online">${online} Online</span>
                        <span class="group-offline">${offline} Offline</span>
                        ${totalDT > 0 ? `<span class="group-downtime">${formatDuration(totalDT)}</span>` : ''}
                    </span>
                </td>
            </tr>`;

            members.forEach(b => {
                const sc = b.currentStatus === 'Online' ? 'online' : 'offline';
                const lu = b.lastUpdated?.toDate ? formatTime(b.lastUpdated.toDate()) : '\u2014';
                const dt = getCurrentDowntimeText(b);
                const rc = b.currentStatus === 'Offline' ? 'row-offline' : 'row-online';
                const upChip = uptimeChipFor(b.branchName);
                html += `<tr class="child-row ${rc}" data-group="${escapeHTML(groupName)}" ${displayStyle}>
                    <td><span class="child-indent"></span><strong>${escapeHTML(b.branchName)}</strong></td>
                    <td><span class="status-badge ${sc}">${escapeHTML(b.currentStatus)}</span></td>
                    <td>${upChip}</td>
                    <td>${lu}</td>
                    <td>${dt}</td>
                    <td class="actions-cell">
                        ${branchActionsHtml(b.branchName)}
                    </td>
                    ${branchCardCell(b, sc, lu, dt, upChip)}
                </tr>`;
            });
        });
        branchesTableBody.innerHTML = html;

        branchesTableBody.querySelectorAll('.group-header-row').forEach(row => {
            row.addEventListener('click', () => {
                expandedGroups[row.dataset.group] = expandedGroups[row.dataset.group] === false ? true : false;
                renderBranchesTable();
            });
        });
    } else {
        branchesTableBody.innerHTML = filtered.map(b => {
            const sc = b.currentStatus === 'Online' ? 'online' : 'offline';
            const lu = b.lastUpdated?.toDate ? formatTime(b.lastUpdated.toDate()) : '\u2014';
            const dt = getCurrentDowntimeText(b);
            const rc = b.currentStatus === 'Offline' ? 'row-offline' : 'row-online';
            const upChip = uptimeChipFor(b.branchName);
            return `<tr class="${rc}">
                <td><strong>${escapeHTML(b.branchName)}</strong></td>
                <td><span class="status-badge ${sc}">${escapeHTML(b.currentStatus)}</span></td>
                <td>${upChip}</td>
                <td>${lu}</td>
                <td>${dt}</td>
                <td class="actions-cell">
                    ${branchActionsHtml(b.branchName)}
                </td>
                ${branchCardCell(b, sc, lu, dt, upChip)}
            </tr>`;
        }).join('');
    }

    branchesTableBody.querySelectorAll('.btn-view').forEach(btn => {
        btn.addEventListener('click', () => openViewModal(btn.dataset.branch));
    });

// Use event delegation for remove buttons to avoid inline onclick issues
    branchesTableBody.querySelectorAll('.btn-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const name = btn.dataset.branch;
            if (name) window.confirmRemoveBranch(name);
        });
    });

    // ===== Render the Branches-table pagination controls =====
    renderBranchPagination();
    renderQuickStatus();
}

// ===== Pagination controls for the Branches table =====
function renderBranchPagination() {
    const el = document.getElementById('branchPagination');
    if (!el) return;
    const totalItems = filteredBranches.length;
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;

    if (totalPages <= 1) {
        el.innerHTML = `<span class="page-info">Showing ${totalItems} branches</span>`;
        return;
    }

    let html = `<button onclick="goToBranchPage(${branchPage - 1})" ${branchPage <= 1 ? 'disabled' : ''}>\u00AB Prev</button>`;
    const maxVisiblePages = 5;
    let startPage = Math.max(1, branchPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
    if (endPage - startPage + 1 < maxVisiblePages) startPage = Math.max(1, endPage - maxVisiblePages + 1);

    for (let i = startPage; i <= endPage; i++) {
        html += `<button class="${i === branchPage ? 'active' : ''}" onclick="goToBranchPage(${i})">${i}</button>`;
    }

    html += `<button onclick="goToBranchPage(${branchPage + 1})" ${branchPage >= totalPages ? 'disabled' : ''}>Next \u00BB</button>`;
    html += `<span class="page-info">Page ${branchPage} of ${totalPages} (${totalItems} branches)</span>`;
    el.innerHTML = html;
}

window.goToBranchPage = function(page) {
    branchPage = page;
    renderBranchesTable();
};

// ==============================================================
//  EDIT / DELETE HISTORY & REMOVE BRANCH (FAST OPTIMISTIC UPDATES)
// ==============================================================

const editHistoryModal = $('#editHistoryModal');
const closeEditHistoryModal = $('#closeEditHistoryModal');
const cancelEditHistory = $('#cancelEditHistory');
const editHistoryForm = $('#editHistoryForm');
const editHistoryId = $('#editHistoryId');
const editHistoryBranch = $('#editHistoryBranch');
const editHistoryStatus = $('#editHistoryStatus');
const editHistoryDate = $('#editHistoryDate');
const editHistoryTime = $('#editHistoryTime');
const editHistoryRemarks = $('#editHistoryRemarks');

window.openEditHistoryModal = function(logId) {
    if (!currentUserIsSuperAdmin()) { console.log('Permission denied.'); return; }
    const log = allLogs.find(l => l.id === logId);
    if (!log) { console.log('History record not found.'); return; }

    editHistoryId.value = logId;
    const d = log.dateTime?.toDate ? log.dateTime.toDate() : new Date(log.dateTime);

    editHistoryBranch.innerHTML = '<option value="">\u2014 Select Branch \u2014</option>' +
        branches.map(b => `<option value="${escapeHTML(b.branchName)}">${escapeHTML(b.branchName)}</option>`).join('');
    editHistoryBranch.value = log.branchName || '';

    editHistoryStatus.value = log.status || '';
    editHistoryDate.value = toISODate(d);
    editHistoryTime.value = toISOTime(d);
    editHistoryRemarks.value = log.remarks || '';
    
    if (editHistoryModal) editHistoryModal.classList.add('active');
};

if (closeEditHistoryModal) closeEditHistoryModal.addEventListener('click', () => editHistoryModal.classList.remove('active'));
if (cancelEditHistory) cancelEditHistory.addEventListener('click', () => editHistoryModal.classList.remove('active'));

if (editHistoryForm) {
    editHistoryForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const logId = editHistoryId.value;
        const branchName = editHistoryBranch.value;
        const status = editHistoryStatus.value;
        const dateVal = editHistoryDate.value;
        const timeVal = editHistoryTime.value;
        const remarks = editHistoryRemarks.value.trim();

        if (!branchName || !status || !dateVal || !timeVal) {
            console.log('Please fill out all required fields.');
            return;
        }

        const dateTime = new Date(`${dateVal}T${timeVal}:00`);
        
        const index = allLogs.findIndex(l => l.id === logId);
        let previousLogState = index !== -1 ? { ...allLogs[index] } : null;
        if (index !== -1) {
            allLogs[index] = {
                ...allLogs[index],
                branchName,
                status,
                dateTime: firebase.firestore.Timestamp.fromDate(dateTime),
                remarks
            };
        }

        console.log('History record updated successfully.');
        if (editHistoryModal) editHistoryModal.classList.remove('active');
        renderHistory();
        renderDashboard();

        try {
            await firestoreService.updateStatusLog(logId, {
                branchName,
                status,
                dateTime: dateTime.toISOString(),
                remarks
            });
            // ⚡ PERF: re-derive branch status from the patched in-memory logs
            // instead of re-downloading every branch + every status log.
            refreshBranchStatusesLocally();
        } catch (error) {
            console.error('Edit history error:', error);
            console.log('Failed to update record on server.');
            if (index !== -1 && previousLogState) {
                allLogs[index] = previousLogState;
            }
            loadBranchData().then(() => reRenderAll());
        }
    });
}

window.deleteHistoryLog = async function(logId) {
    if (!currentUserIsSuperAdmin()) { console.log('Permission denied.'); return; }
    const confirmed = await showConfirmDialog({
        title: 'Delete History Record',
        message: 'Are you sure you want to delete this history record?',
        confirmText: 'Delete',
        danger: true,
        icon: 'fa-trash-alt'
    });
    if (!confirmed) return;
    
    const logIndex = allLogs.findIndex(l => l.id === logId);
    const deletedLog = logIndex !== -1 ? allLogs[logIndex] : null;
    allLogs = allLogs.filter(l => l.id !== logId);
    
    console.log('History record deleted.');
    renderHistory();
    renderDashboard();

    try {
        await firestoreService.deleteStatusLog(logId);
        // ⚡ PERF: same as edit — no full reload after a successful delete.
        refreshBranchStatusesLocally();
    } catch (error) {
        console.error('Delete history error:', error);
        console.log('Failed to delete record on server.');
        if (deletedLog) {
            allLogs.push(deletedLog);
        }
        loadBranchData().then(() => reRenderAll());
    }
};

window.confirmRemoveBranch = async function(name) {
    const confirmed = await showConfirmDialog({
        title: 'Remove Branch',
        message: `Remove <strong>${escapeHTML(name)}</strong>?<br>History logs will be kept.`,
        confirmText: 'Remove',
        danger: true,
        icon: 'fa-trash-alt'
    });
    if (!confirmed) return;

    const removedBranchIndex = branches.findIndex(b => b.branchName === name);
    const removedBranch = removedBranchIndex !== -1 ? branches[removedBranchIndex] : null;
    const affectedLogs = allLogs.filter(l => l.branchName === name);
    
    // Immediate state slice update
    branches = branches.filter(b => b.branchName !== name);
    allLogs = allLogs.filter(l => l.branchName !== name);

    renderDashboard();
    renderBranchesTable();
    renderHistory();
    populateHistoryBranchFilter();
    populateGroupFilter();
    populateTicketBranchFilter();
    populateSubmitBranchSelect();

    try {
        await firestoreService.deleteBranch(name);
    } catch (e) {
        console.error('Remove branch error:', e);
        console.log('Failed to remove on server.');
        if (removedBranch) branches.push(removedBranch);
        allLogs = allLogs.concat(affectedLogs);
        loadBranchData().then(() => reRenderAll());
    }
};

// ==============================================================
//  HISTORY
// ==============================================================

function renderHistory() {
    const searchTerm = historySearch.value.toLowerCase().trim();
    const filter = document.querySelector('.filter-btn[data-history-filter].active')?.dataset?.historyFilter || 'all';
    const branchF = historyBranchFilter.value;
    const dateFrom = historyDateFrom.value;
    const dateTo = historyDateTo.value;

    let filtered = [...allLogs];
    if (searchTerm) filtered = filtered.filter(log => log.branchName.toLowerCase().includes(searchTerm) || (log.remarks || '').toLowerCase().includes(searchTerm));
    if (filter !== 'all') filtered = filtered.filter(log => log.status === filter);
    if (branchF) filtered = filtered.filter(log => log.branchName === branchF);
    if (dateFrom) { const from = new Date(dateFrom + 'T00:00:00'); filtered = filtered.filter(log => { const d = log.dateTime?.toDate ? log.dateTime.toDate() : new Date(log.dateTime); return d >= from; }); }
    if (dateTo) { const to = new Date(dateTo + 'T23:59:59'); filtered = filtered.filter(log => { const d = log.dateTime?.toDate ? log.dateTime.toDate() : new Date(log.dateTime); return d <= to; }); }

    if (filtered.length === 0) {
        historyTableBody.innerHTML = `<tr><td colspan="7" class="empty-state"><i class="fas fa-history"></i><p>No records found.</p></td></tr>`;
        return;
    }

    // ===== Superadmin-only Edit/Delete buttons =====
    const isAdmin = currentUserIsSuperAdmin();
    historyTableBody.innerHTML = filtered.map(log => {
        const d = log.dateTime?.toDate ? log.dateTime.toDate() : new Date(log.dateTime);
        const sc = log.status === 'Online' ? 'online' : 'offline';
        const logId = log.id || '';
        const actionsHTML = isAdmin ? `
                <div class="action-group">
                    <button class="history-action-btn edit-hist" data-logid="${escapeHTML(logId)}" data-tooltip="Edit" onclick="window.openEditHistoryModal('${escapeHTML(logId)}')"><i class="fas fa-pen"></i></button>
                    <button class="history-action-btn delete-hist" data-logid="${escapeHTML(logId)}" data-tooltip="Delete" onclick="window.deleteHistoryLog('${escapeHTML(logId)}')"><i class="fas fa-trash"></i></button>
                </div>
            ` : '\u2014';
        // The card's foot only carries the action stack when there is one —
        // a non-superadmin has no actions, so an empty footer would be a
        // border with nothing above it.
        const cardFoot = isAdmin
            ? `<div class="approval-card-foot"><div class="approval-card-actions">${actionsHTML}</div></div>`
            : '';
        return `<tr>
            <td>${formatDate(d)}</td>
            <td>${formatTime(d)}</td>
            <td><strong>${escapeHTML(log.branchName)}</strong></td>
            <td><span class="status-badge ${sc}">${escapeHTML(log.status)}</span></td>
            <td>${escapeHTML(log.remarks || '\u2014')}</td>
            <td>${actionsHTML}</td>
            <td class="approval-card-cell" data-label="Card">
                <div class="approval-card">
                    <div class="approval-card-head">
                        <span class="approval-card-branch"><i class="fas fa-code-branch"></i>${escapeHTML(log.branchName)}</span>
                        <span class="approval-card-pill approval-card-pill--${sc === 'online' ? 'online' : 'offline'}">${escapeHTML(log.status)}</span>
                    </div>
                    <div class="approval-card-grid">
                        <div class="approval-card-field"><span class="approval-card-label">Date</span><span class="approval-card-value">${formatDate(d)}</span></div>
                        <div class="approval-card-field"><span class="approval-card-label">Time</span><span class="approval-card-value">${formatTime(d)}</span></div>
                        <div class="approval-card-field"><span class="approval-card-label">Branch</span><span class="approval-card-value">${escapeHTML(log.branchName)}</span></div>
                        <div class="approval-card-field"><span class="approval-card-label">Remarks</span><span class="approval-card-value">${escapeHTML(log.remarks || '\u2014')}</span></div>
                    </div>
                    ${cardFoot}
                </div>
            </td>
        </tr>`;
    }).join('');
}

// ==============================================================
//  POPULATE DROPDOWNS
// ==============================================================

function populateHistoryBranchFilter() {
    historyBranchFilter.innerHTML = '<option value="">All Branches</option>' +
        branches.map(b => `<option value="${escapeHTML(b.branchName)}">${escapeHTML(b.branchName)}</option>`).join('');
}

function populateGroupFilter() {
    const groupSet = new Set();
    branches.forEach(b => groupSet.add(getBranchGroup(b.branchName)));
    const groups = Array.from(groupSet).sort();
    groupFilter.innerHTML = '<option value="">All Groups</option>' + groups.map(g => `<option value="${escapeHTML(g)}">${escapeHTML(g)}</option>`).join('');
}

function populateTicketBranchFilter() {
    ticketBranchFilter.innerHTML = '<option value="all">All Branches</option>' +
        branches.map(b => `<option value="${escapeHTML(b.branchName)}">${escapeHTML(b.branchName)}</option>`).join('');
}

function populateSubmitBranchSelect() {
    if (!branchSelectTicket) return;
    branchSelectTicket.innerHTML = '<option value="">Select Branch</option>' +
        branches.map(b => `<option value="${escapeHTML(b.branchName)}">${escapeHTML(b.branchName)}</option>`).join('');
}

function populateBranchSelect() {
    branchSelect.innerHTML = '<option value="">\u2014 Select Branch \u2014</option>' +
        branches.map(b => `<option value="${escapeHTML(b.branchName)}">${escapeHTML(b.branchName)}</option>`).join('');
}

// ==============================================================
//  ADD STATUS MODAL
// ==============================================================

function openAddModal() {
    populateBranchSelect();
    setDefaultDateTime();
    statusSelect.value = '';
    remarksInput.value = '';
    validationWarning.style.display = 'none';
    resetBranchField();
    // Reset segmented buttons
    const segBtns = statusSegmentedGroup.querySelectorAll('.segmented-btn');
    segBtns.forEach(btn => btn.classList.remove('active'));
    addModal.classList.add('active');
}

/**
 * Restore the Branch field (label + select + New button) to its default state.
 *
 * Defensive reset for the Add Status modal. An earlier version of the "New"
 * toggle hid this row and stripped the select's 'required' flag, and nothing
 * ever undid it: closing and re-opening the modal left the Branch row
 * display:none FOREVER until a full page refresh. The toggle no longer hides
 * anything (it only shows #newBranchGroup), but the display restores stay
 * here so ANY future hide path is undone on both open and close - X, Cancel,
 * backdrop click or successful save.
 */
function resetBranchField() {
    const branchGroup = branchSelect.closest('.form-group');
    if (branchGroup) branchGroup.style.display = '';
    const branchLabel = branchGroup ? branchGroup.querySelector('label[for="branchSelect"]') : null;
    if (branchLabel) branchLabel.style.display = '';
    branchSelect.style.display = '';
    branchSelect.setAttribute('required', '');
    newBranchInput.removeAttribute('required');
    newBranchGroup.style.display = 'none';
    newBranchInput.value = '';
}

function closeAddModalFn() { resetBranchField(); addModal.classList.remove('active'); }

btnAddStatus.addEventListener('click', openAddModal);
closeAddModal.addEventListener('click', closeAddModalFn);
cancelAdd.addEventListener('click', closeAddModalFn);
addModal.addEventListener('click', (e) => { if (e.target === addModal) closeAddModalFn(); });

// Segmented button status selection
if (statusSegmentedGroup) {
    statusSegmentedGroup.addEventListener('click', (e) => {
        const btn = e.target.closest('.segmented-btn');
        if (!btn) return;
        // Deactivate all
        statusSegmentedGroup.querySelectorAll('.segmented-btn').forEach(b => b.classList.remove('active'));
        // Activate clicked
        btn.classList.add('active');
        // Update hidden input
        statusSelect.value = btn.dataset.status;
        // Hide validation warning if shown
        if (validationWarning) validationWarning.style.display = 'none';
    });
}

btnAddBranch.addEventListener('click', () => {
    const isNowVisible = newBranchGroup.style.display === 'none';
    newBranchGroup.style.display = isNowVisible ? 'block' : 'none';
    // The Branch row (label + select + this button) NEVER moves or hides.
    // Hiding the label/select shifted the whole form upward on every click
    // (the reported "pumupunta sa taas" jump). New mode only swaps which
    // field owns the 'required' flag - so native validation still blocks
    // an empty submit either way - and preventScroll keeps the modal
    // exactly where the user had it.
    if (isNowVisible) {
        branchSelect.value = '';
        branchSelect.removeAttribute('required');
        newBranchInput.setAttribute('required', '');
        newBranchInput.focus({ preventScroll: true });
    } else {
        newBranchInput.removeAttribute('required');
        newBranchInput.value = '';
        branchSelect.setAttribute('required', '');
    }
});


newBranchInput.addEventListener('input', () => {
    const val = newBranchInput.value.trim();
    if (val) {
        const existing = branches.find(b => b.branchName.toLowerCase() === val.toLowerCase());
        if (existing) branchSelect.value = existing.branchName;
    }
});

function reRenderAll() {
    renderDashboard();
    renderBranchesTable();
    renderHistory();
    populateHistoryBranchFilter();
    populateGroupFilter();
    populateTicketBranchFilter();
    populateSubmitBranchSelect();
    populateBranchSelect();
}

async function handleAddStatus(e) {
    e.preventDefault();
    let branchName = branchSelect.value;
    const newName = newBranchInput.value.trim();
    if (!branchName && newName) branchName = newName;
    const status = statusSelect.value;
    const dateVal = dateInput.value;
    const timeVal = timeInput.value;
    const remarks = remarksInput.value.trim();

    if (!branchName || !status || !dateVal || !timeVal) {
        console.log('Please fill in all required fields.');
        return;
    }

    const dateTime = new Date(`${dateVal}T${timeVal}:00`);
    try {
        await firestoreService.addStatusLog({ branchName, status, dateTime: dateTime.toISOString(), remarks });
        const ts = firebase.firestore.Timestamp.fromDate(dateTime);
        await firestoreService.setBranch(branchName, {
            currentStatus: status,
            lastUpdated: ts,
            currentDowntimeStart: status === 'Offline' ? ts : null,
            remarks
        });

        // Optimistic local update \u2014 no full reload
        const newLog = {
            id: 'local-' + Date.now(),
            branchName, status,
            dateTime: ts,
            remarks: remarks || ''
        };
        allLogs.unshift(newLog);

        const branch = branches.find(b => b.branchName === branchName);
        if (branch) {
            branch.currentStatus = status;
            branch.lastUpdated = ts;
            branch.remarks = remarks || '';
            branch.currentDowntimeStart = status === 'Offline' ? ts : null;
        } else {
            branches.push({
                branchName, currentStatus: status, lastUpdated: ts,
                currentDowntimeStart: status === 'Offline' ? ts : null,
                remarks: remarks || ''
            });
            branches.sort((a, b) => (a.branchName || '').localeCompare(b.branchName || ''));
        }

        reRenderAll();
        closeAddModalFn();
    } catch (error) {
        console.error(error);
        console.log('Failed to save. Please try again.');
    }
}

addForm.addEventListener('submit', handleAddStatus);

// ==============================================================
//  VIEW BRANCH MODAL
// ==============================================================

async function openViewModal(branchName) {
    const branch = branches.find(b => b.branchName === branchName);
    if (!branch) { console.log('Branch not found.'); return; }

    currentViewBranch = branchName;
    captureMainState({ tab: getActiveMainTab() || 'branches', modal: 'branch', id: branchName });
    viewBranchName.textContent = branchName;

    const sc = branch.currentStatus === 'Online' ? 'online' : 'offline';
    viewCurrentStatus.innerHTML = `<span class="status-badge ${sc}">${escapeHTML(branch.currentStatus)}</span>`;
    viewLastUpdated.textContent = branch.lastUpdated?.toDate ? `${formatDate(branch.lastUpdated.toDate())} ${formatTime(branch.lastUpdated.toDate())}` : '\u2014';
    viewRemarks.textContent = branch.remarks || '\u2014';
    viewDowntime.textContent = getCurrentDowntimeText(branch);

    await loadMonthlyStats(branchName);
    await loadViewHistory(branchName);
    viewModal.classList.add('active');
}

function closeViewModalFn() { viewModal.classList.remove('active'); currentViewBranch = null; try { clearMainModalCtx(); } catch (e) { /* ignore */ } }

closeViewModal.addEventListener('click', closeViewModalFn);
viewModal.addEventListener('click', (e) => { if (e.target === viewModal) closeViewModalFn(); });

async function loadMonthlyStats(branchName) {
    try {
        const now = new Date();
        const som = new Date(now.getFullYear(), now.getMonth(), 1);
        const eom = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
        const logs = await firestoreService.getBranchLogsInRange(branchName, som, eom);

        let total = 0, outages = 0, longest = 0, os = null;
        for (const log of logs) {
            const d = log.dateTime?.toDate ? log.dateTime.toDate() : new Date(log.dateTime);
            if (log.status === 'Offline' && os === null) os = d;
            else if (log.status === 'Online' && os !== null) {
                const dur = getDurationMinutes(os, d); total += dur; outages++; if (dur > longest) longest = dur; os = null;
            }
        }
        if (os !== null) { const dur = getDurationMinutes(os, new Date()); total += dur; outages++; if (dur > longest) longest = dur; }

        const tmm = (eom - som) / (1000 * 60);
        const avail = tmm > 0 ? ((tmm - total) / tmm) * 100 : 100;

        statOutages.textContent = outages;
        statTotalDowntime.textContent = formatDuration(total);
        statLongestOutage.textContent = formatDuration(longest);
        statAvgOutage.textContent = outages > 0 ? formatDuration(total / outages) : '0m';
        statAvailability.textContent = `${Math.round(avail * 100) / 100}%`;
    } catch (e) {
        statOutages.textContent = statTotalDowntime.textContent = statLongestOutage.textContent = statAvgOutage.textContent = statAvailability.textContent = '\u2014';
    }
}

async function loadViewHistory(branchName) {
    try {
        const logs = await firestoreService.getBranchLogs(branchName);
        if (logs.length === 0) { viewHistoryBody.innerHTML = `<tr><td colspan="4" class="empty-state">No history.</td></tr>`; return; }
        viewHistoryBody.innerHTML = logs.map(log => {
            const d = log.dateTime?.toDate ? log.dateTime.toDate() : new Date(log.dateTime);
            const sc = log.status === 'Online' ? 'online' : 'offline';
            return `<tr><td>${formatDate(d)}</td><td>${formatTime(d)}</td><td><span class="status-badge ${sc}">${escapeHTML(log.status)}</span></td><td>${escapeHTML(log.remarks || '\u2014')}</td></tr>`;
        }).join('');
    } catch (e) { viewHistoryBody.innerHTML = `<tr><td colspan="4" class="empty-state">Failed to load.</td></tr>`; }
}

// ==============================================================
//  TICKET SYSTEM - REAL-TIME LISTENER
// ==============================================================

// ⚡ PERF state for the single ticket read path (see setupTicketListener).
let ticketListenerActive = false;   // a listener is subscribed and has not errored
let ticketListenerFailed = false;   // the last listener was rejected (e.g. pre-auth)
let ticketDesktopNotificationsInit = false;
let unsubscribeTickets = null;

/**
 * Live ticket listener — the ONLY initial ticket read on page load.
 *
 * Returns a promise that resolves once the list is usable: the first snapshot
 * that came from the server, a non-empty snapshot from the offline cache (instant
 * paint), an error, or a 10s safety timeout (offline first visit) — so initApp()
 * never hangs waiting on it.
 *
 * Initial-sync rule (replaces the old duplicate getTickets() race): every
 * snapshot up to and including the FIRST SERVER snapshot replaces the list
 * wholesale and raises NO "new ticket" / status notifications — exactly what
 * the old direct read achieved by pre-filling allTickets. `includeMetadataChanges`
 * lets us see the cache→server transition even when nothing changed.
 */
function setupTicketListener() {
    let initialSyncDone = false;
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const markReady = () => { if (resolveReady) { resolveReady(); resolveReady = null; } };
    setTimeout(markReady, 10000);

    // ===== Real Desktop Notifications (like YouTube/Slack) =====
    if (!ticketDesktopNotificationsInit && typeof window.initDesktopNotifications === 'function') {
        ticketDesktopNotificationsInit = true;
        window.initDesktopNotifications();
    }

    if (typeof unsubscribeTickets === 'function') {
        try { unsubscribeTickets(); } catch (e) { /* ignore */ }
    }
    ticketListenerActive = true;
    ticketListenerFailed = false;

    unsubscribeTickets = firestoreService.listenTickets((tickets, changes, metadata) => {
        if (!initialSyncDone) {
            const fromCache = !!(metadata && metadata.fromCache);
            // An empty CACHE snapshot means "nothing cached yet", not "no tickets":
            // keep whatever is shown and wait for the server.
            if (fromCache && tickets.length === 0) return;
            allTickets = tickets;
            filterTickets();
            updateTicketDashboard();
            updatePendingBadge();
            updateApprovalsBadge();
            // ===== Live approval queue: render from initial snapshot =====
            applyApprovalFilters(false);
            if (!fromCache) {
                initialSyncDone = true;
                isInitialTicketLoad = false;
                if (dashboardDataReady) renderDashboard();
            }
            markReady();
            return;
        }

        const changeArray = changes || [];
        if (changeArray.length === 0) return;
        
        let hasChanges = false;
        changeArray.forEach(change => {
            if (change.type === 'added') {
                const ticket = { id: change.doc.id, ...change.doc.data() };
                const exists = allTickets.some(t => t.id === ticket.id);
                if (!exists) {
                    allTickets.push(ticket);
                    hasChanges = true;
                    const msg = `New ticket: ${ticket.ticketNumber || change.doc.id} from ${ticket.branch || 'Unknown'}`;
                    showNotificationBar(msg);

                    // ===== Real Desktop Notification (Windows Action Center, like YouTube) =====
                    if (typeof window.notifyNewTicket === 'function') {
                        window.notifyNewTicket(ticket);
                    }
                }
            } else if (change.type === 'modified') {
                const ticket = { id: change.doc.id, ...change.doc.data() };
                const idx = allTickets.findIndex(t => t.id === ticket.id);
                if (idx !== -1) {
                    const prev = allTickets[idx];
                    allTickets[idx] = ticket;
                    hasChanges = true;

                    // ===== Desktop Notifications for status transitions =====
                    // Fires for additional-footage requests and superadmin
                    // rejections; also shows the in-app notification bar.
                    if (typeof window.notifyTicketStatusChange === 'function') {
                        const barMsg = window.notifyTicketStatusChange(prev, ticket);
                        if (barMsg) showNotificationBar(barMsg);
                    }
                }
            } else if (change.type === 'removed') {
                allTickets = allTickets.filter(t => t.id !== change.doc.id);
                hasChanges = true;
            }
        });
        
        if (hasChanges) {
            filterTickets();
            updateTicketDashboard();
            updatePendingBadge();
            updateApprovalsBadge();
            renderDashboard();
            // ===== LIVE APPROVAL QUEUE: re-filter + re-render the Approvals tab
            //       using the updated ticket state. When the superadmin is on the
            //       Approvals tab, new submissions appear instantly; if they are on
            //       another tab, the badge updates and the list is ready when they
            //       switch over. =====
            applyApprovalFilters(false);
        }
    }, (error) => {
        console.error('Ticket listener error:', error);
        ticketListenerActive = false;
        ticketListenerFailed = true;
        markReady();
    }, { includeMetadataChanges: true });

    return ready;
}

// ==============================================================
//  SEED SAMPLE TICKETS — REMOVED 2026-03-10
// ==============================================================
// The two hardcoded demo tickets that used to live here (a tip-pocketing report
// and an overcharge report) were deleted along with the auto-seed call in
// loadTicketsDirect(). They were dev scaffolding: the boot sequence called the
// seeder whenever the tickets collection came back empty, which meant that
// deleting your last ticket simply re-created them on the next page load, and a
// project reset could never look clean.
//
// If you want demo data for local development, use scripts/seed.js — an
// explicit, separate command — rather than hiding it in the app's load path.

// ==============================================================
//  NOTIFICATION BAR & DASHBOARD
// ==============================================================

function showNotificationBar(message) {
    const bar = document.getElementById('notificationBar');
    const msg = document.getElementById('notificationMsg');
    // New-ticket alerts are delivered by the Desktop Notification feature
    // (js/notifications.js) + this on-screen bar only.
    if (bar && msg) {
        msg.innerHTML = '<i class="fas fa-ticket-alt"></i> ' + escapeHTML(message);
        bar.classList.add('visible');
        setTimeout(() => { bar.classList.remove('visible'); }, 10000);
    }
}

window.dismissNotification = function() {
    const bar = document.getElementById('notificationBar');
    if (bar) bar.classList.remove('visible');
};

function updateTicketDashboard() {
    const total = allTickets.length;
    const pending = allTickets.filter(t => (t.status || 'Pending') === 'Pending').length;
    const progress = allTickets.filter(t => t.status === 'In Progress').length;
    // Only fully approved resolutions count as "Resolved" on the dashboard;
    // pending-approval tickets are NOT resolved yet, and For Revision is its own state.
    const resolved = allTickets.filter(t => isApprovedTicket(t)).length;

    if (totalTickets) animateValue(totalTickets, total);
    if (pendingTickets) animateValue(pendingTickets, pending);
    if (progressTickets) animateValue(progressTickets, progress);
    if (resolvedTickets) animateValue(resolvedTickets, resolved);
}

function updatePendingBadge() {
    // Pending badge covers new tickets AND tickets sent back for revision
    const pending = allTickets.filter(t => {
        const s = t.status || 'Pending';
        return s === 'Pending' || s === 'For Revision';
    }).length;
    if (pending > 0) {
        pendingBadge.style.display = 'inline';
        pendingBadge.textContent = pending;
    } else {
        pendingBadge.style.display = 'none';
    }
}

function updateApprovalsBadge() {
    if (!approvalsBadge) return;
    const count = allTickets.filter(t => isPendingApproval(t)).length;
    if (count > 0) {
        approvalsBadge.style.display = 'inline';
        approvalsBadge.textContent = count;
    } else {
        approvalsBadge.style.display = 'none';
    }
}

// ==============================================================
//  TICKET FILTERS & DISPLAY
// ==============================================================

// Searchable date strings for a stored ticket timestamp, so the Tickets search
// bar matches the "Date Created" column the way THIS dashboard shows it —
// formatDateTime() → "Oct 10, 2026, 10:53 AM". We seed several representations
// so a date is findable however it is typed:
//   "Oct 10, 2026"  (the column's date part, month-short — matches "oct 10"),
//   "10/10/2026"    (numeric),
//   "2026-10-10"    (ISO).
// Returns [] for a missing/unparseable date.
function dateSearchTokens(value) {
    if (!value) return [];
    const d = value.toDate ? value.toDate() : new Date(value);
    if (isNaN(d.getTime())) return [];
    const pad = (n) => String(n).padStart(2, '0');
    const monthShort = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const numeric = d.toLocaleDateString('en-US');
    const iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    return [monthShort, numeric, iso];
}

function filterTickets() {
    const keyword = ticketSearch ? ticketSearch.value.trim().toLowerCase() : '';
    const selectedStatus = ticketStatusFilter ? ticketStatusFilter.value : 'all';
    const selectedPriority = ticketPriorityFilter ? ticketPriorityFilter.value : 'all';
    const selectedBranch = ticketBranchFilter ? ticketBranchFilter.value : 'all';

    filteredTickets = allTickets.filter(ticket => {
        // ⚡ PERF: the haystack (3 locale date formats per ticket) is only built
        // when there IS a keyword — this runs over every ticket on every live
        // snapshot, and with an empty search box it was pure overhead.
        const keywordMatch = !keyword || [
            ticket.ticketNumber, ticket.branch, ticket.name, ticket.incident, ticket.description,
            // Date Created, in the formats users type ("Oct 10, 2026", "10/10/2026",
            // "2026-10-10"), matching this dashboard's formatDateTime column.
            ...dateSearchTokens(ticket.createdAt)
        ].filter(Boolean).join(' ').toLowerCase().includes(keyword);
        const statusMatch = selectedStatus === 'all' || getDisplayStatus(ticket) === selectedStatus;
        const priorityMatch = selectedPriority === 'all' || (ticket.priority || 'Low') === selectedPriority;
        const branchMatch = selectedBranch === 'all' || ticket.branch === selectedBranch;

        // ===== Approved/resolved tickets =====
        // Fully approved "Resolved" tickets are hidden from the default active
        // ticket list, but operators can still audit them by selecting the
        // "Resolved" status filter in the Tickets tab.
        if (isApprovedTicket(ticket)) {
            return selectedStatus === 'Resolved' && keywordMatch && priorityMatch && branchMatch;
        }

        return keywordMatch && statusMatch && priorityMatch && branchMatch;
    });

    currentPage = 1;
    renderPagination();
}

function displayTickets(tickets) {
    if (!ticketList) return;
    ticketList.innerHTML = '';

    if (tickets.length === 0) {
        ticketList.innerHTML = `<tr><td colspan="9" class="empty-state"><i class="fas fa-ticket-alt"></i><p>No tickets found.</p></td></tr>`;
        return;
    }

    // ===== Role-based permissions: Edit/Delete buttons are superadmin-only =====
    const isAdmin = currentUserIsSuperAdmin();

    const statusOrder = { "Pending": 1, "In Progress": 2, "Resolved": 3 };
    const sortedTickets = [...tickets].sort((a, b) => {
        const orderA = statusOrder[a.status || 'Pending'] || 3;
        const orderB = statusOrder[b.status || 'Pending'] || 3;
        if (orderA !== orderB) return orderA - orderB;
        const dateA = a.createdAt?.toDate ? a.createdAt.toDate() : new Date(a.createdAt || 0);
        const dateB = b.createdAt?.toDate ? b.createdAt.toDate() : new Date(b.createdAt || 0);
        return dateB - dateA;
    });

    sortedTickets.forEach(ticket => {
        const status = ticket.status || 'Pending';
        const priority = ticket.priority || 'Low';
        const dotClass = priority.toLowerCase();

        let actionHTML = '';
        // ===== Superadmin-only Edit/Delete buttons (operators keep workflow actions) =====
        const adminEditBtn = isAdmin
            ? `<button class="action-btn edit" data-tooltip="Edit" onclick="window.openEditTicket('${ticket.id}')">\u270E</button>`
            : '';
        const adminDeleteBtn = isAdmin
            ? `<button class="action-btn delete-action" data-tooltip="Delete" onclick="window.deleteTicket('${ticket.id}')">\uD83D\uDDD1</button>`
            : '';
        if (status === 'Pending') {
            actionHTML = `<div class="action-group">
                <button class="action-btn start" data-tooltip="Start" onclick="window.startTicket('${ticket.id}')">\u25B6</button>
                ${adminEditBtn}
                ${adminDeleteBtn}
            </div>`;
        } else if (status === 'In Progress') {
            actionHTML = `<div class="action-group">
                <button class="action-btn resolve" data-tooltip="Resolve" onclick="window.resolveTicket('${ticket.id}')">\u2713</button>
                ${adminEditBtn}
                ${adminDeleteBtn}
            </div>`;
        } else if (status === 'For Revision') {
            // ===== For Revision: agent must review the rejection reason and
            //       resubmit a new resolution through the revise modal =====
            actionHTML = `<div class="action-group">
                <button class="action-btn resolve" data-tooltip="Revise & Resubmit Resolution" onclick="window.reviseTicket('${ticket.id}')"><i class="fas fa-redo-alt"></i></button>
                ${adminEditBtn}
                ${adminDeleteBtn}
            </div>`;
        } else if (status === 'Resolved') {
            // Ticket is already resolved — no action needed
            actionHTML = '';
        } else {
            actionHTML = `<div class="action-group">
                <button class="action-btn resolve" data-tooltip="Resolve" onclick="window.resolveTicket('${ticket.id}')">✓</button>
                ${adminEditBtn}
                ${adminDeleteBtn}
            </div>`;
        }

        const displayStatus = getDisplayStatus(ticket);
        const createdDate = ticket.createdAt?.toDate ? formatDateTime(ticket.createdAt.toDate()) : (ticket.createdAt || '-');
        const statusClass = displayStatus.toLowerCase().replace(/\s+/g, '-');

        // The card's foot carries the workflow buttons (which exist ONLY
        // there on a phone — the desktop Actions cell is hidden below 900px)
        // plus the priority as text, since the desktop table shows priority
        // as a dot with no word. Resolved tickets have no actions at all, so
        // the foot — and with it the border around nothing — is left out.
        const cardFoot = actionHTML ? `
            <div class="approval-card-foot">
                <div class="approval-card-expiry">
                    <span class="approval-card-label">Priority</span>
                    <span class="approval-card-value">${escapeHTML(priority)}</span>
                </div>
                <div class="approval-card-actions">${actionHTML}</div>
            </div>` : '';

        const row = document.createElement('tr');
        // ===== Desktop Notification Feature: Add data-ticket-id for scroll targeting =====
        row.setAttribute('data-ticket-id', ticket.id);
        if (isAdmin && dotClass === 'high') row.classList.add('ticket-high-priority');
        row.innerHTML = `
            <td class="checkbox-cell"><input type="checkbox" class="ticket-checkbox" value="${ticket.id}" onchange="updateBulkBar()"></td>
            <td><span class="priority-dot"><span class="dot ${dotClass}"></span><span class="ticket-link" onclick="window.openTicketModal('${ticket.id}')">${escapeHTML(ticket.ticketNumber || ticket.id)}</span></span></td>
            <td>${createdDate}</td>
            <td>${escapeHTML(ticket.branch || '')}</td>
            <td>${escapeHTML(ticket.name || '')}</td>
            <td>${escapeHTML(ticket.incident || '')}</td>
            <td><span class="status-badge ${statusClass}">${escapeHTML(displayStatus)}</span></td>
            <td>${actionHTML}</td>
            <td class="approval-card-cell" data-label="Card">
                <div class="approval-card">
                    <div class="approval-card-head">
                        <span class="approval-card-branch"><span class="priority-dot"><span class="dot ${dotClass}"></span></span><i class="fas fa-ticket-alt"></i>${escapeHTML(ticket.ticketNumber || ticket.id)}</span>
                        <span class="approval-card-pill approval-card-pill--${statusClass}">${escapeHTML(displayStatus)}</span>
                    </div>
                    <div class="approval-card-grid">
                        <div class="approval-card-field"><span class="approval-card-label">Branch</span><span class="approval-card-value">${escapeHTML(ticket.branch || '\u2014')}</span></div>
                        <div class="approval-card-field"><span class="approval-card-label">Reporter</span><span class="approval-card-value">${escapeHTML(ticket.name || '\u2014')}</span></div>
                        <div class="approval-card-field"><span class="approval-card-label">Date Created</span><span class="approval-card-value approval-card-muted">${createdDate}</span></div>
                        <div class="approval-card-field"><span class="approval-card-label">Incident</span><span class="approval-card-value">${escapeHTML(ticket.incident || '\u2014')}</span></div>
                    </div>
                    ${cardFoot}
                </div>
            </td>
        `;
        ticketList.appendChild(row);
        // ===== Click anywhere on the row (except buttons/checkboxes/links) opens the ticket =====
        row.addEventListener('click', function(e) {
            if (e.target.closest('button, input, a, .action-group, .checkbox-cell, .priority-dot')) return;
            window.openTicketModal(ticket.id);
        });
    });
}

function getApprovalStatusText(ticket) {
    if (isPendingApproval(ticket)) return 'Pending Approval';
    if (isApprovedTicket(ticket)) return 'Approved';
    if (isRejectedTicket(ticket)) return 'For Revision';
    const s = ticket.status || 'Pending';
    if (s === 'Pending') return 'Not Submitted';
    if (s === 'In Progress') return 'In Progress';
    return s;
}

function populateApprovalBranchFilter() {
    if (!approvalBranchFilter) return;
    approvalBranchFilter.innerHTML = '<option value="all">All Branches</option>' +
        branches.map(b => `<option value="${escapeHTML(b.branchName)}">${escapeHTML(b.branchName)}</option>`).join('');
}

/**
 * Only tickets that have actually been submitted for approval appear in the
 * Approvals tab. Tickets still sitting as "Pending" or "In Progress" (i.e. the
 * operator has not submitted a resolution) are hidden entirely.
 */
function isSubmittedForApproval(ticket) {
    return isPendingApproval(ticket) || isApprovedTicket(ticket) || isRejectedTicket(ticket);
}

/**
 * Re-run the approval tab filters over the current `allTickets` state.
 * When `resetPage` is true (manual filter change / tab open) pagination resets
 * to page 1. When false (real-time listener refresh) the current page is kept
 * so live updates don't jump the superadmin around.
 */
function applyApprovalFilters(resetPage = true) {
    const keyword = approvalSearch ? approvalSearch.value.trim().toLowerCase() : '';
    const selectedStatus = approvalStatusFilter ? approvalStatusFilter.value : 'all';
    const selectedBranch = approvalBranchFilter ? approvalBranchFilter.value : 'all';

    // ===== Exclude tickets that were never submitted for approval =====
    filteredApprovalTickets = allTickets.filter(ticket => {
        if (!isSubmittedForApproval(ticket)) return false;

        const searchable = `${ticket.ticketNumber || ''} ${ticket.branch || ''} ${ticket.name || ''} ${ticket.incident || ''}`.toLowerCase();
        const keywordMatch = !keyword || searchable.includes(keyword);
        // "Expired" matches approved tickets whose 2-day viewing window lapsed;
        // every other option matches the textual approval status.
        const statusMatch = selectedStatus === 'all'
            || (selectedStatus === 'Expired'
                ? (isApprovedTicket(ticket) && getTrackingExpiryInfo(ticket).expired)
                : getApprovalStatusText(ticket) === selectedStatus);
        const branchMatch = selectedBranch === 'all' || ticket.branch === selectedBranch;
        return keywordMatch && statusMatch && branchMatch;
    });

    if (resetPage) approvalPage = 1;
    renderApprovalList();
}

function filterApprovalTickets() {
    applyApprovalFilters(true);
}

function renderApprovalAttachments(ticket) {
    const managerGrid = document.getElementById('approvalManagerAttachments');
    const operatorGrid = document.getElementById('approvalOperatorAttachments');
    if (!managerGrid || !operatorGrid) {
        // Legacy fallback: render into the flat grid if it still exists.
        const oldGrid = approvalAttachmentsGrid;
        if (oldGrid) oldGrid.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">No attachments.</p>';
        return;
    }
    const split = splitApprovalAttachments(ticket);
    const isAdmin = currentUserIsSuperAdmin();
    const ticketId = ticket ? ticket.id : '';
    const renderGroup = (atts, markAdded) => atts.map((att, index) => {
        // ⚠️ Both writers' shapes - see normalizeAttachment(). Without this the
        // approval modal showed the file SIZE but no link for anything uploaded
        // through the Area Manager form.
        const norm = normalizeAttachment(att);
        const url = norm ? norm.url : '';
        const name = (norm && norm.name) || ('Attachment ' + (index + 1));
        const sizeText = (norm && norm.bytes) ? formatFileSize(norm.bytes) : '';
        const isImage = !!(norm && norm.resourceType === 'image');
        const icon = norm ? getAttachmentIcon(norm.resourceType, norm.format) : 'fa-file';
        const color = norm ? getAttachmentColor(norm.format) : '#64748b';
        const isBroken = !url;

        // ⚠️ THIS GRID BUILDS ITS OWN CARD and does not go through the shared
        // buildAttachmentCard(), because only a superadmin's cards carry the
        // Remove button. So the "added footage" marking has to be applied HERE as
        // well, or the same clip would be ringed on the Area Manager's dashboard
        // and plain on the superadmin's — the exact drift the shared builder
        // exists to prevent. Same class names, same top-left banner, on purpose.
        const isAdded = !!(markAdded && norm && split.addedKeys && split.addedKeys.has(norm.publicId));
        const addedBadge = isAdded
            ? '<span class="attachment-added-badge" role="img" aria-label="Added footage" title="Added footage — uploaded in response to a request">NEW</span>'
            : '';

        // One shared tile builder, so this grid matches every other grid.
        // See buildAttachmentPreview() for what used to differ here.
        const preview = buildAttachmentPreview(norm, index);

        const removeBtn = (isAdmin && norm && norm.publicId) ? `
            <button type="button" class="attachment-remove" data-tooltip="Remove"
                onclick="removeApprovalAttachment('${escapeHTML(ticketId)}', '${escapeHTML(norm.publicId)}')">
                <i class="fas fa-times"></i>
            </button>
        ` : '';

        // No URL -> a div, never an empty anchor. See renderTicketAttachments().
        const body = isBroken
            ? `<div class="attachment-preview" title="Link unavailable">${preview}</div>`
            : `<a href="${url}" target="_blank" rel="noopener noreferrer" class="attachment-preview" title="${escapeHTML(name)}">${preview}</a>`;

        return `
            <div class="attachment-item${isAdded ? ' attachment-item--added' : ''}" data-public-id="${escapeHTML(norm ? norm.publicId : '')}">
                ${addedBadge}
                ${body}
                <div class="attachment-meta">
                    <span class="attachment-name" title="${escapeHTML(name)}">${escapeHTML(name)}</span>
                    ${sizeText ? `<span class="attachment-size">${escapeHTML(sizeText)}</span>` : ''}
                </div>
                ${removeBtn}
            </div>
        `;
    }).join('');

    const emptyHtml = '<p class="review-empty-files">No files available.</p>';
    // ⚠️ markAdded is passed ONLY for the operator group. The manager's own
    // uploads can never be "added footage" — they are the original request — and
    // ringing them would invent a distinction that does not exist.
    managerGrid.innerHTML = split.manager.length > 0 ? renderGroup(split.manager, false) : emptyHtml;
    operatorGrid.innerHTML = split.operator.length > 0 ? renderGroup(split.operator, true) : emptyHtml;

    const managerCount = document.getElementById('approvalManagerAttCount');
    const operatorCount = document.getElementById('approvalOperatorAttCount');
    if (managerCount) managerCount.textContent = '(' + split.manager.length + ')';
    if (operatorCount) operatorCount.textContent = '(' + split.operator.length + ')';
}

/**
 * Resolve the full attachment list for a ticket, falling back across the nested
 * `resolution.attachments`, top-level `attachments`, and the single
 * `resolutionAttachmentUrl` string written by older/other flows.
 */
function getApprovalAllAttachments(ticket) {
    const resolution = (ticket && ticket.resolution) || {};
    let atts = Array.isArray(resolution.attachments) ? resolution.attachments : [];
    if (atts.length === 0 && ticket && Array.isArray(ticket.attachments)) atts = ticket.attachments;
    if (atts.length === 0 && ticket && ticket.resolutionAttachmentUrl) {
        atts = [{ secure_url: ticket.resolutionAttachmentUrl, name: 'Resolution attachment', resource_type: 'raw', format: '' }];
    }
    return atts;
}

/**
 * Operator-submitted footage.
 *  - New data model: `resolution.operatorFootage` (written when the operator
 *    submits a resolution / revision).
 *  - Legacy fallback: `resolvedAdditionalFootage` (footage-request flow).
 */
function getApprovalOperatorFootage(ticket) {
    const resolution = (ticket && ticket.resolution) || {};
    if (Array.isArray(resolution.operatorFootage) && resolution.operatorFootage.length > 0) return resolution.operatorFootage;
    if (ticket && Array.isArray(ticket.resolvedAdditionalFootage)) return ticket.resolvedAdditionalFootage;
    return [];
}

// A shared "nothing was removed" set. Module-level so the common path allocates
// nothing on every write — mergeOperatorFootage() is called on every resolve,
// revision and superadmin upload.
const EMPTY_REMOVED_SET = new Set();

/**
 * Has anyone asked for more footage on this ticket?
 *
 * The marker for "added footage". Read from the ticket's `comments` notes
 * (type: 'footage_request'), which is what both the public Track page and the
 * Area Manager's own form append. Shared so the operator's Resolve and the
 * superadmin's two upload paths cannot disagree about whether a ticket is in a
 * footage-request cycle.
 */
function hasFootageRequestComment(ticket) {
    const comments = (ticket && Array.isArray(ticket.comments)) ? ticket.comments : [];
    return comments.some(c => c && c.type === 'footage_request');
}

/**
 * ⚠️ THE ONE PLACE operatorFootage IS BUILT. Every writer goes through here.
 *
 * THE BUG THIS LOCKS DOWN. Four sites used to write this field and they
 * disagreed. The operator's two sites (Resolve, Revise & Resubmit) wrote
 * `operatorFootage: attachmentList` — the NEWLY uploaded clips ONLY — so every
 * time an operator re-resolved after an "Insufficient Footage" request, the
 * footage from their FIRST submission was thrown out of the field. The
 * superadmin's two sites (approval-modal upload, edit-modal upload) correctly
 * did `oldFootage.concat(uploaded)`, which is why a superadmin's own uploads
 * survived and this went unnoticed.
 *
 * It did not merely HIDE the old clips, it MISCLASSIFIED them.
 * splitApprovalAttachments() below computes the manager's half as "every
 * attachment whose key is NOT in the operator list" — so the orphaned original
 * clips fell through and were rendered under "Manager's Request". CCTV the
 * operator captured appeared as if the manager had filed it.
 *
 * The rule, for every writer:
 *     previous footage  -  explicitly removed  +  newly uploaded
 *
 * @param {object}  ticket       the ticket being written (may be a cache entry)
 * @param {Array}   uploaded     clips uploaded in THIS submission
 * @param {Set}     removedIds   optional public_ids the user deleted this round
 * @returns {Array} the complete footage list, oldest first, de-duplicated
 */
function mergeOperatorFootage(ticket, uploaded, removedIds) {
    // The legacy `resolvedAdditionalFootage` is a genuine FALLBACK, not a second
    // source to merge: a pre-`operatorFootage` ticket may only have it, and
    // seeding from it is what rescues those clips instead of starting empty.
    const prior = getApprovalOperatorFootage(ticket);

    // ⚠️ DUCK-TYPED, NOT `instanceof Set`. `instanceof` compares against THIS
    // realm's Set constructor, so a Set built anywhere else — a test sandbox, an
    // iframe, a vendored bundle — fails the check and silently degrades to
    // "remove nothing", which is the destructive-looking half of the contract
    // quietly not happening. Asking for the one method actually used is both
    // realm-independent and tolerant of any Set-alike.
    const removed = (removedIds && typeof removedIds.has === 'function') ? removedIds : EMPTY_REMOVED_SET;

    const kept = prior.filter((a) => !(a && removed.has(a.public_id)));
    const added = Array.isArray(uploaded) ? uploaded : [];
    const merged = kept.concat(added);

    // ⚠️ DE-DUPE BY public_id, KEEPING THE FIRST OCCURRENCE. Now that the list
    // only ever grows, a repeated submission — a double-tap, a retry after a
    // slow save, or the same file arriving via both the auto-upload dropzone and
    // the file input — would otherwise list one clip twice, and the two
    // superadmin concats this helper replaced had exactly that exposure.
    // First-wins so the ORIGINAL entry (with its original ordering and any
    // later edits) is the one that survives.
    const seen = new Set();
    const out = [];
    for (const att of merged) {
        const key = att && att.public_id;
        if (key) {
            if (seen.has(key)) continue;
            seen.add(key);
        }
        out.push(att);
    }
    return out;
}

/**
 * Split a ticket's attachments into the manager's original request files and
 * the operator's resolution footage.
 *
 * ⚠️ THE MANAGER'S LIST IS AUTHORITATIVE, AND THAT IS THE WHOLE POINT.
 * `requesterAttachments` is written once, at ticket creation, from the
 * manager's own upload array (js/owner-ticket-form.js writes it and
 * `attachments` from the SAME array). It is therefore an exact record of what
 * the manager attached and nothing else.
 *
 * This used to prioritise `operatorFootage` and DERIVE the manager's half by
 * subtracting it from the merged list — "everything not in the operator list".
 * That inverts the trust: any clip missing from `operatorFootage` was silently
 * re-attributed to the manager. On a ticket whose operatorFootage had been
 * truncated (the replacement bug), the operator's own CCTV appeared under
 * "Manager's Attachments" as though they had filed it.
 *
 * Using the manager's list directly makes that unrepresentable, AND it repairs
 * the already-damaged tickets for free: an orphaned clip is simply "not the
 * manager's", so it lands back under the operator where it belongs.
 *
 * `addedKeys` is returned so the caller can mark the clips that arrived in
 * response to a footage request — see resolvedAdditionalFootage.
 */
/**
 * The clips that get the "NEW" badge: those added in the LATEST footage round
 * (`latestAdditionalFootage`). `resolvedAdditionalFootage` is cumulative across
 * rounds, so badging from it marked every clip from every round as new. Tickets
 * resolved before `latestAdditionalFootage` existed fall back to it unchanged.
 */
function footageAddedList(ticket) {
    // An EMPTY array is meaningful ("this round added nothing", e.g. a
    // notes-only resubmit) — writers store [] rather than deleting the field
    // during a footage cycle, so it never falls back to the cumulative list.
    if (ticket && Array.isArray(ticket.latestAdditionalFootage)) return ticket.latestAdditionalFootage;
    if (ticket && Array.isArray(ticket.resolvedAdditionalFootage)) return ticket.resolvedAdditionalFootage;
    return [];
}

function splitApprovalAttachments(ticket) {
    const all = getApprovalAllAttachments(ticket);
    const footage = getApprovalOperatorFootage(ticket);
    const requester = (ticket && Array.isArray(ticket.requesterAttachments)) ? ticket.requesterAttachments : null;

    // ⚠️ Must understand BOTH writers' keys, or the two halves of a split list
    // are seen as disjoint and the same file appears twice (or not at all).
    const keyOf = (a) => String((a && (a.public_id || a.publicId || a.secure_url || a.url)) || '');
    const keySet = (list) => new Set((list || []).map(keyOf).filter(Boolean));

    // The clips added in response to a footage request. Deliberately read
    // straight off the ticket, NOT off `footage`: this is a SUBSET, and it is
    // the only thing that distinguishes an added clip from an original one.
    const addedKeys = keySet(footageAddedList(ticket));

    if (requester && requester.length > 0) {
        const keys = keySet(requester);
        return {
            manager: requester.slice(),
            operator: all.filter(a => !keys.has(keyOf(a))),
            addedKeys: addedKeys
        };
    }
    if (footage.length > 0) {
        const keys = keySet(footage);
        return {
            manager: all.filter(a => !keys.has(keyOf(a))),
            operator: footage.slice(),
            addedKeys: addedKeys
        };
    }
    return { manager: all.slice(), operator: [], addedKeys: addedKeys };
}

/**
 * Superadmin: remove a single attachment from a ticket in the Approvals tab.
 * Keeps both top-level `attachments` and `resolution.attachments` in sync.
 */
window.removeApprovalAttachment = async function(ticketId, publicId) {
    if (!ticketId || !publicId) return;
    if (!currentUserIsSuperAdmin()) { console.log('Permission denied.'); return; }
    const confirmed = await showConfirmDialog({
        title: 'Remove Attachment',
        message: 'Remove this attachment from the ticket?',
        confirmText: 'Remove',
        danger: true,
        icon: 'fa-trash-alt'
    });
    if (!confirmed) return;

    try {
        const ticketDoc = await db.collection('tickets').doc(ticketId).get();
        if (!ticketDoc.exists) return;
        const data = ticketDoc.data();
        const existing = Array.isArray(data.attachments) ? data.attachments : [];
        const oldResolution = data.resolution || {};
        const oldResAtts = Array.isArray(oldResolution.attachments) ? oldResolution.attachments : [];
        const oldReqAtts = Array.isArray(data.requesterAttachments) ? data.requesterAttachments : [];
        const oldResFootage = Array.isArray(oldResolution.operatorFootage) ? oldResolution.operatorFootage : [];

        const remaining = existing.filter(a => a.public_id !== publicId);
        const remainingRes = oldResAtts.filter(a => a.public_id !== publicId);
        const remainingReq = oldReqAtts.filter(a => a.public_id !== publicId);
        const remainingFootage = oldResFootage.filter(a => a.public_id !== publicId);

        await db.collection('tickets').doc(ticketId).update({
            attachments: remaining,
            ...(oldReqAtts.length > 0 ? { requesterAttachments: remainingReq } : {}),
            resolutionAttachmentUrl: attachmentUrl(remaining[0]),
            resolution: {
                ...oldResolution,
                attachments: remainingRes,
                ...(oldResFootage.length > 0 ? { operatorFootage: remainingFootage } : {})
            }
        });

        const idx = allTickets.findIndex(t => t.id === ticketId);
        if (idx !== -1) {
            allTickets[idx].attachments = remaining;
            if (allTickets[idx].resolution) {
                allTickets[idx].resolution.attachments = remainingRes;
                if (Array.isArray(allTickets[idx].resolution.operatorFootage)) {
                    allTickets[idx].resolution.operatorFootage = remainingFootage;
                }
            }
            if (Array.isArray(allTickets[idx].requesterAttachments)) {
                allTickets[idx].requesterAttachments = remainingReq;
            }
            renderApprovalAttachments(allTickets[idx]);
        }

        if (approvalUploadStatus) approvalUploadStatus.textContent = 'Attachment removed.';
        setTimeout(() => { if (approvalUploadStatus) approvalUploadStatus.textContent = ''; }, 3000);
    } catch (error) {
        console.error('Remove approval attachment error:', error);
        if (approvalUploadStatus) approvalUploadStatus.textContent = 'Failed to remove attachment.';
    }
};

window.openApprovalDetails = function(id) {
    const ticket = allTickets.find(t => t.id === id);
    if (!ticket) return;

    currentApprovalTicketId = id;
    if (approvalDetailsTitle) approvalDetailsTitle.textContent = `Approval: ${ticket.ticketNumber || id}`;
    captureMainState({ tab: getActiveMainTab() || 'approvals', modal: 'approval', id });

    // Status badge in the modal header
    const statusText = getApprovalStatusText(ticket);
    const statusClass = statusText.toLowerCase().replace(/\s+/g, '-');
    if (approvalDetailsStatus) {
        approvalDetailsStatus.textContent = statusText;
        approvalDetailsStatus.className = 'status-badge ' + statusClass;
        approvalDetailsStatus.style.display = 'inline-flex';
    }

    const resolution = ticket.resolution || {};
    const resolvedBy = resolution.resolvedBy || '—';
    const resolvedAt = resolution.resolvedAt?.toDate ? formatDateTime(resolution.resolvedAt.toDate()) : (resolution.resolvedAt || '—');
    const notes = resolution.notes || ticket.resolutionNotes || 'No notes provided.';
    const requestedBy = ticket.name || '—';
    const rejection = ticket.rejection || {};
    const rejectedReason = rejection.reason || ticket.rejectionReason || ticket.approvalReason || '';

    // ===== 2-day tracking access window (superadmin visibility) =====
    const expiryInfo = getTrackingExpiryInfo(ticket);
    let accessValue = '\u2014';
    let accessValueStyle = '';
    if (expiryInfo.tracked && expiryInfo.expired) {
        accessValue = 'Expired ' + formatDateTime(expiryInfo.date) + ' \u2014 resend to re-open for ' + trackingWindowLabel();
        accessValueStyle = ' style="color:var(--color-danger);"';
    } else if (expiryInfo.tracked) {
        accessValue = 'Until ' + formatDateTime(expiryInfo.date);
    }
    const resendCount = Number(ticket.accessResentCount) || 0;
    const accessRow = expiryInfo.tracked
        ? `<div class="review-meta"><label>Manager Access Expires</label><span${accessValueStyle}>${escapeHTML(accessValue)}</span></div>
                   ${resendCount > 0 ? `<div class="review-meta"><label>Resent</label><span>${resendCount}&times;</span></div>` : ''}`
        : '';
    // Re-access request raised from the expired Track page (if any)
    const reopenCard = buildReopenRequestCard(ticket);
    const reopenPending = !!(ticket.accessReopenRequest && ticket.accessReopenRequest.status === 'pending');

    if (approvalDetailsBody) {
        approvalDetailsBody.innerHTML = `
            <!-- ===== SECTION 1: MANAGER'S ORIGINAL REQUEST (collapsible, on top) ===== -->
            <details class="review-collapse">
                <summary>
                    <span class="review-collapse-title"><i class="fas fa-user-tie"></i> Manager's Original Request</span>
                    <span class="review-collapse-sub"><i class="fas fa-user-circle"></i> Submitted by ${escapeHTML(requestedBy)}</span>
                    <i class="fas fa-chevron-down review-collapse-caret"></i>
                </summary>
                <div class="review-collapse-body">
                    <div class="review-meta-grid">
                        <div class="review-meta"><label>Ticket Number</label><span>${escapeHTML(ticket.ticketNumber || id)}</span></div>
                        <div class="review-meta"><label>Branch</label><span>${escapeHTML(ticket.branch || '-')}</span></div>
                        <div class="review-meta"><label>Incident</label><span>${escapeHTML(ticket.incident || '-')}</span></div>
                        <div class="review-meta"><label>Incident Date</label><span>${escapeHTML(ticket.datetime || '-')}</span></div>
                        <div class="review-meta"><label>Location</label><span>${escapeHTML(ticket.location || '-')}</span></div>
                        <div class="review-meta"><label>Priority</label><span>${escapeHTML(ticket.priority || 'Low')}</span></div>
                        <div class="review-meta"><label>Position</label><span>${escapeHTML(ticket.position || '-')}</span></div>
                        <div class="review-meta"><label>Contact</label><span>${escapeHTML(ticket.contact || '-')}</span></div>
                        <div class="review-meta full"><label>Email</label><span>${escapeHTML(ticket.email || '-')}</span></div>
                        <div class="review-meta full"><label>Issue Description</label><p class="review-note">${escapeHTML(ticket.description || 'No description.')}</p></div>
                    </div>
                    <div class="review-attachments-label"><i class="fas fa-paperclip"></i> Manager's Attachments <span id="approvalManagerAttCount">(0)</span></div>
                    <div class="attachments-grid" id="approvalManagerAttachments"></div>
                </div>
            </details>

            <!-- ===== SECTION 2: OPERATOR'S RESOLUTION (visible below) ===== -->
            <div class="review-card operator">
                <div class="review-card-header">
                    <h3><i class="fas fa-video"></i> Operator's Resolution Report</h3>
                    <span class="review-card-sub"><i class="fas fa-user-cog"></i> Resolved by ${escapeHTML(resolvedBy)}</span>
                </div>
                <div class="review-meta-grid">
                    <div class="review-meta"><label>Resolved By</label><span>${escapeHTML(resolvedBy)}</span></div>
                    <div class="review-meta"><label>Resolved At</label><span>${escapeHTML(resolvedAt)}</span></div>
                    ${accessRow}
                    <div class="review-meta full"><label>Action Taken / Findings</label><p class="review-note">${escapeHTML(notes)}</p></div>
                    ${rejectedReason ? `<div class="review-meta full"><label>Rejection Reason</label><p class="review-note review-rejection">${escapeHTML(rejectedReason)}</p></div>` : ''}
                </div>
                <!-- ⚠️ WAS "Operator's Added Footage". Now that clips added in response to
                     a footage request carry their own ring + badge, calling the WHOLE
                     list "added" would contradict the marking inside it — the original
                     clips are not added. The manager's own heading is untouched. -->
                <div class="review-attachments-label"><i class="fas fa-film"></i> Operator's Resolution Footage <span id="approvalOperatorAttCount">(0)</span></div>
                <div class="attachments-grid" id="approvalOperatorAttachments"></div>
            </div>
            ${reopenCard}
        `;
    }

    renderApprovalAttachments(ticket);
    if (approvalUploadStatus) approvalUploadStatus.textContent = '';
    if (approvalAttachmentInput) {
        approvalAttachmentInput.value = '';
        approvalPendingFiles = [];
        renderUploadFileList(approvalAttachmentInput.closest('.upload-widget'), []);
    }

    // Footer actions only appear for tickets still awaiting final approval,
    // or for approved tickets whose window lapsed AND that somebody actually
    // asked to reopen.
    //
    // ⚠️ A PENDING RE-ACCESS REQUEST IS REQUIRED. Resend is a RESPONSE to a
    // request, not a proactive grant: an expired ticket nobody asked about shows
    // NO button, so access is only ever extended after a manager or store
    // actually asked for it. A visible "Resend" on every expired ticket also
    // invited an accidental click that silently handed out a fresh window (and
    // incremented accessResentCount) to a ticket that was closed on purpose.
    const showApproveActions = isPendingApproval(ticket) && currentUserIsSuperAdmin();
    const showResendAction = expiryInfo.expired && reopenPending && currentUserIsSuperAdmin();
    // Undo a mistaken Transfer to Store / HR. Only tickets that went through
    // the HR/Store handoff carry ticketTransferTo, so legacy approvals get none.
    const showRevertAction = currentUserIsSuperAdmin() && isApprovedTicket(ticket)
        && (ticket.ticketTransferTo === 'store' || ticket.ticketTransferTo === 'hr');
    const showFooter = showApproveActions || showResendAction || showRevertAction;
    if (approvalModalFooter) approvalModalFooter.style.display = showFooter ? 'flex' : 'none';
    if (btnRevertTicketTransfer) {
        // Real display value — the button ships with .u-hidden (see btnResendAccess).
        btnRevertTicketTransfer.style.display = showRevertAction ? 'inline-flex' : 'none';
        btnRevertTicketTransfer.onclick = () => window.revertTicketTransfer(id);
    }
    if (btnTransferToHr) {
        btnTransferToHr.style.display = showApproveActions ? '' : 'none';
        btnTransferToHr.onclick = () => window.transferTicketToHr(id);
    }
    if (btnTransferToStore) {
        btnTransferToStore.style.display = showApproveActions ? '' : 'none';
        btnTransferToStore.onclick = () => window.transferTicketToStore(id);
    }
    if (btnRejectApproval) {
        btnRejectApproval.style.display = showApproveActions ? '' : 'none';
        btnRejectApproval.onclick = () => window.rejectTicket(id);
    }
    if (btnResendAccess) {
        // ⚠️ A REAL display value, never ''. #btnResendAccess ships with
        // `class="u-hidden"` (main.html), and .u-hidden is `display: none`.
        // Assigning '' only REMOVES the inline style and hands control back to
        // the class — so the footer became visible (line above assigns 'flex')
        // with an EMPTY button bar and the Resend button was unreachable. The
        // same trap .u-hidden's own comment describes, and the one
        // test/command-palette.test.js guards for #btnNewViolation.
        // '.btn' is display:inline-flex, so that is the value to assign.
        btnResendAccess.style.display = showResendAction ? 'inline-flex' : 'none';
        // The label is now unconditional: showResendAction above already
        // requires reopenPending, so the old "Resend Access" wording could never
        // render. Leaving the ternary in place would be a branch that always
        // takes the same arm, and would quietly start lying if the gate were
        // ever loosened back.
        btnResendAccess.innerHTML =
            `<i class="fas fa-check-double"></i> Approve Request &amp; Resend (${trackingWindowLabel()})`;
        btnResendAccess.onclick = () => window.resendTrackingAccess(id);
    }

    if (approvalDetailsModal) approvalDetailsModal.classList.add('active');
};

if (closeApprovalDetails) closeApprovalDetails.addEventListener('click', () => {
    if (approvalDetailsModal) approvalDetailsModal.classList.remove('active');
    currentApprovalTicketId = null;
    try { clearMainModalCtx(); } catch (e) { /* ignore */ }
});
if (approvalDetailsModal) approvalDetailsModal.addEventListener('click', (e) => {
    if (e.target === approvalDetailsModal) {
        approvalDetailsModal.classList.remove('active');
        currentApprovalTicketId = null;
        try { clearMainModalCtx(); } catch (e) { /* ignore */ }
    }
});

// ===== Superadmin: upload additional attachments from the approval details modal =====
if (btnUploadApprovalAttachment) {
    btnUploadApprovalAttachment.addEventListener('click', async () => {
        const id = currentApprovalTicketId;
        if (!id) {
            if (approvalUploadStatus) approvalUploadStatus.textContent = 'No ticket selected.';
            return;
        }
if (!isCloudinaryConfigured()) {
            if (approvalUploadStatus) approvalUploadStatus.textContent = '⚠️ Cloudinary not configured.';
            return;
        }
        const input = approvalAttachmentInput;
        if (!input || !input.files || input.files.length === 0) {
            if (approvalUploadStatus) approvalUploadStatus.textContent = 'Choose a file first.';
            return;
        }

        const files = Array.from(input.files);
        const v = validateUploadFiles(files);
        if (!v.ok) { if (approvalUploadStatus) { approvalUploadStatus.textContent = v.message; approvalUploadStatus.classList.add('error'); } return; }

        const widget = input.closest('.upload-widget');
        if (widget) resetUploadProgress(widget);

        const uploadBtn = btnUploadApprovalAttachment;
        if (uploadBtn) uploadBtn.disabled = true;
        if (approvalUploadStatus) approvalUploadStatus.textContent = 'Uploading...';

        try {
            const uploaded = [];
            for (const file of files) {
                const att = await cloudinaryUpload(file, id, (pct) => {
                    if (widget) setUploadProgress(widget, pct);
                });
                uploaded.push(att);
            }
            if (widget) finishUploadProgress(widget, true);

            const ticketDoc = await db.collection('tickets').doc(id).get();
            const data = ticketDoc.exists ? ticketDoc.data() : {};
            const existing = Array.isArray(data.attachments) ? data.attachments : [];
            const oldResolution = data.resolution || {};
            const oldResAtts = Array.isArray(oldResolution.attachments) ? oldResolution.attachments : [];
            const merged = existing.concat(uploaded);
            const mergedRes = oldResAtts.concat(uploaded);
            // One shared rule for footage, so this superadmin upload and the
            // operator's Resolve/Revise can never disagree about what "add a clip"
            // means (see mergeOperatorFootage).
            const mergedFootage = mergeOperatorFootage(data, uploaded);
            // ⚠️ A SUPERADMIN'S OWN CLIP IS "ADDED FOOTAGE" TOO. The ring/badge
            // marks clips that arrived in response to a footage request, and a
            // superadmin adding a clip on a ticket that is in that cycle is
            // exactly that. Without this the marking would be half-true: the
            // operator's response would be ringed and the superadmin's not.
            const mergedAdditional = hasFootageRequestComment(data)
                ? mergeOperatorFootage(
                    { resolvedAdditionalFootage: data.resolvedAdditionalFootage }, uploaded)
                : null;
            // The superadmin's clip belongs to the CURRENT round as well, so it
            // joins the "NEW" set alongside the operator's (see footageAddedKeys).
            const mergedLatest = mergedAdditional
                ? mergeOperatorFootage(
                    { resolvedAdditionalFootage: data.latestAdditionalFootage || [] }, uploaded)
                : null;
            await db.collection('tickets').doc(id).update({
                attachments: merged,
                resolutionAttachmentUrl: attachmentUrl(merged[0]),
                // Only written when there is a request in play, so a ticket that
                // never had one keeps NO resolvedAdditionalFootage field at all —
                // the same shape the operator's Resolve produces.
                ...(mergedAdditional ? { resolvedAdditionalFootage: mergedAdditional } : {}),
                ...(mergedLatest ? { latestAdditionalFootage: mergedLatest } : {}),
                resolution: {
                    ...oldResolution,
                    attachments: mergedRes,
                    operatorFootage: mergedFootage
                }
            });

            const idx = allTickets.findIndex(t => t.id === id);
            if (idx !== -1) {
                allTickets[idx].attachments = merged;
                if (allTickets[idx].resolution) {
                    allTickets[idx].resolution.attachments = mergedRes;
                    allTickets[idx].resolution.operatorFootage = mergedFootage;
                }
                renderApprovalAttachments(allTickets[idx]);
            }

            if (approvalUploadStatus) approvalUploadStatus.textContent = `Uploaded ${uploaded.length} file(s).`;
            if (input) input.value = '';
            approvalPendingFiles = [];
            renderUploadFileList(widget, []);
            setTimeout(() => { if (approvalUploadStatus) approvalUploadStatus.textContent = ''; }, 4000);
        } catch (error) {
            console.error('Approval attachment upload error:', error);
            if (approvalUploadStatus) approvalUploadStatus.textContent = 'Upload failed: ' + error.message;
        } finally {
            if (uploadBtn) uploadBtn.disabled = false;
        }
    });
}

// ===== "Edit Approval Information" modal (Superadmin) =====
// Opens from the approval details modal so the superadmin can revise the
// resolution notes and attach additional evidence without leaving the tab.
window.openEditApprovalModal = function(id) {
    const ticket = allTickets.find(t => t.id === id);
    if (!ticket) return;

    currentApprovalTicketId = id;
    if (editApprovalTitle) editApprovalTitle.textContent = `Edit Approval Info: ${ticket.ticketNumber || id}`;
    captureMainState({ tab: getActiveMainTab() || 'approvals', modal: 'approval', id });
    if (editApprovalTicketId) editApprovalTicketId.textContent = ticket.ticketNumber || id;

    const resolution = ticket.resolution || {};
    if (editApprovalNotes) editApprovalNotes.value = resolution.notes || ticket.resolutionNotes || '';
    if (editApprovalAttachmentInput) {
        editApprovalAttachmentInput.value = '';
        editApprovalPendingFiles = [];
        renderUploadFileList(editApprovalAttachmentInput.closest('.upload-widget'), []);
    }
    if (editApprovalUploadStatus) editApprovalUploadStatus.textContent = '';
    if (editApprovalError) editApprovalError.style.display = 'none';

    if (editApprovalModal) editApprovalModal.classList.add('active');
};

if (closeEditApprovalModal) closeEditApprovalModal.addEventListener('click', () => {
    if (editApprovalModal) editApprovalModal.classList.remove('active');
});
if (cancelEditApproval) cancelEditApproval.addEventListener('click', () => {
    if (editApprovalModal) editApprovalModal.classList.remove('active');
});
if (editApprovalModal) editApprovalModal.addEventListener('click', (e) => {
    if (e.target === editApprovalModal) editApprovalModal.classList.remove('active');
});

// Upload additional attachment from the edit-approval modal
if (btnUploadEditApprovalAttachment) {
    btnUploadEditApprovalAttachment.addEventListener('click', async () => {
        const id = currentApprovalTicketId;
        if (!id) {
            if (editApprovalUploadStatus) editApprovalUploadStatus.textContent = 'No ticket selected.';
            return;
        }
        if (!isCloudinaryConfigured()) {
            if (editApprovalUploadStatus) editApprovalUploadStatus.textContent = '\u26A0\uFE0F Cloudinary not configured.';
            return;
        }
const input = editApprovalAttachmentInput;
        if (!input || !input.files || input.files.length === 0) {
            if (editApprovalUploadStatus) editApprovalUploadStatus.textContent = 'Choose a file first.';
            return;
        }

        const files = Array.from(input.files);
        const v = validateUploadFiles(files);
        if (!v.ok) { if (editApprovalUploadStatus) { editApprovalUploadStatus.textContent = v.message; editApprovalUploadStatus.classList.add('error'); } return; }

        const widget = input.closest('.upload-widget');
        if (widget) resetUploadProgress(widget);

        const btn = btnUploadEditApprovalAttachment;
        if (btn) btn.disabled = true;
        if (editApprovalUploadStatus) { editApprovalUploadStatus.textContent = 'Uploading...'; editApprovalUploadStatus.classList.remove('success', 'error'); }

        try {
            const uploaded = [];
            for (const file of files) {
                const att = await cloudinaryUpload(file, id, (pct) => {
                    if (widget) setUploadProgress(widget, pct);
                });
                uploaded.push(att);
            }
            if (widget) finishUploadProgress(widget, true);

            const ticketDoc = await db.collection('tickets').doc(id).get();
            const data = ticketDoc.exists ? ticketDoc.data() : {};
            const existing = Array.isArray(data.attachments) ? data.attachments : [];
            const oldResolution = data.resolution || {};
            const oldResAtts = Array.isArray(oldResolution.attachments) ? oldResolution.attachments : [];
            const merged = existing.concat(uploaded);
            const mergedRes = oldResAtts.concat(uploaded);
            // Same shared rule as the approval-modal upload above — one helper for
            // every writer of this field (see mergeOperatorFootage).
            const mergedFootage = mergeOperatorFootage(data, uploaded);
            // Same rule as the approval-modal upload above: on a ticket in a
            // footage-request cycle, the superadmin's own clip is added footage and
            // must carry the marker too (see hasFootageRequestComment).
            const mergedAdditional = hasFootageRequestComment(data)
                ? mergeOperatorFootage(
                    { resolvedAdditionalFootage: data.resolvedAdditionalFootage }, uploaded)
                : null;
            // Current round, same as the approval-modal upload above.
            const mergedLatest = mergedAdditional
                ? mergeOperatorFootage(
                    { resolvedAdditionalFootage: data.latestAdditionalFootage || [] }, uploaded)
                : null;
            await db.collection('tickets').doc(id).update({
                attachments: merged,
                resolutionAttachmentUrl: attachmentUrl(merged[0]),
                ...(mergedAdditional ? { resolvedAdditionalFootage: mergedAdditional } : {}),
                ...(mergedLatest ? { latestAdditionalFootage: mergedLatest } : {}),
                resolution: {
                    ...oldResolution,
                    attachments: mergedRes,
                    operatorFootage: mergedFootage
                }
            });

            const idx = allTickets.findIndex(t => t.id === id);
            if (idx !== -1) {
                allTickets[idx].attachments = merged;
                if (allTickets[idx].resolution) {
                    allTickets[idx].resolution.attachments = mergedRes;
                    allTickets[idx].resolution.operatorFootage = mergedFootage;
                }
            }

            if (editApprovalUploadStatus) editApprovalUploadStatus.textContent = `Uploaded ${uploaded.length} file(s).`;
            if (input) input.value = '';
            editApprovalPendingFiles = [];
            renderUploadFileList(widget, []);
            setTimeout(() => { if (editApprovalUploadStatus) editApprovalUploadStatus.textContent = ''; }, 4000);
        } catch (error) {
            console.error('Edit approval attachment upload error:', error);
            if (editApprovalUploadStatus) editApprovalUploadStatus.textContent = 'Upload failed: ' + error.message;
        } finally {
            if (btn) btn.disabled = false;
        }
    });
}

// Save edited approval information
if (saveApprovalInfoBtn) {
    saveApprovalInfoBtn.addEventListener('click', async () => {
        const id = currentApprovalTicketId;
        if (!id) return;

        const notes = editApprovalNotes ? editApprovalNotes.value.trim() : '';
        if (!notes) {
            if (editApprovalError) {
                editApprovalError.textContent = 'Please enter resolution notes.';
                editApprovalError.style.display = 'block';
            }
            return;
        }

        const btn = saveApprovalInfoBtn;
        if (btn) btn.disabled = true;

        try {
            const ticketDoc = await db.collection('tickets').doc(id).get();
            const existingAtt = (ticketDoc.exists && Array.isArray(ticketDoc.data().attachments)) ? ticketDoc.data().attachments : [];
            const oldResolution = (ticketDoc.exists && ticketDoc.data().resolution) || {};

            await firestoreService.updateTicket(id, {
                resolutionNotes: notes,
                resolutionAttachmentUrl: attachmentUrl(existingAtt[0]),
                resolution: {
                    notes,
                    attachments: existingAtt,
                    operatorFootage: Array.isArray(oldResolution.operatorFootage) ? oldResolution.operatorFootage : [],
                    resolvedAt: oldResolution.resolvedAt || firebase.firestore.FieldValue.serverTimestamp(),
                    resolvedBy: oldResolution.resolvedBy || (auth.currentUser && auth.currentUser.email) || 'unknown'
                }
            });

            if (editApprovalModal) editApprovalModal.classList.remove('active');
            if (approvalDetailsModal) approvalDetailsModal.classList.remove('active');
            currentApprovalTicketId = null;
            console.log('Approval information updated');
            // ===== Immediate UI refresh (real-time listener is a backup) =====
            updateApprovalsBadge();
            applyApprovalFilters(false);
        } catch (error) {
            console.error('Failed to update approval info:', error);
            if (editApprovalError) {
                editApprovalError.textContent = 'Failed to save changes. Please try again.';
                editApprovalError.style.display = 'block';
            }
        } finally {
            if (btn) btn.disabled = false;
        }
    });
}

// ===== Open footage request (answered by the next approval) =====

/** Milliseconds from a Firestore Timestamp / Date / ISO string, or 0. */
function footageTimeMs(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : 0;
}

/** The newest footage_request note, or null. */
function latestFootageNote(ticket) {
    const notes = (ticket && Array.isArray(ticket.comments) ? ticket.comments : [])
        .filter(c => c && c.type === 'footage_request');
    return notes.length ? notes[notes.length - 1] : null;
}

/**
 * True when a footage request is still waiting for its answer, i.e. the
 * approval about to happen is that answer. Uses the `footageRequest` marker;
 * a ticket requested before the marker existed falls back to "the latest
 * footage note is newer than the last approval" (a request is only ever filed
 * on an approved ticket, so the next approval is its answer).
 */
function isOpenFootageRequest(ticket) {
    if (!ticket) return false;
    const marker = ticket.footageRequest;
    if (marker && typeof marker === 'object') return marker.status === 'pending';
    const note = latestFootageNote(ticket);
    if (!note) return false;
    return footageTimeMs(note.requestedAt) > footageTimeMs(ticket.approvedAt);
}

/** Who asked for the footage, as an email (may be ''). */
function footageRequesterEmail(ticket) {
    const marker = (ticket && ticket.footageRequest) || {};
    const fromMarker = String(marker.requestedByEmail || '').trim().toLowerCase();
    if (fromMarker) return fromMarker;
    const note = latestFootageNote(ticket) || {};
    const fromNote = String(note.requestedByEmail || note.requestedBy || '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(fromNote) ? fromNote : '';
}

/** Firestore update fields that close the open request. */
function footageAnsweredUpdate(ticket) {
    const update = {
        'footageRequest.status': 'answered',
        'footageRequest.answeredAt': firebase.firestore.FieldValue.serverTimestamp()
    };
    if (!(ticket && ticket.footageRequest && typeof ticket.footageRequest === 'object')) {
        const note = latestFootageNote(ticket) || {};
        update['footageRequest.requestedBy'] = note.requestedBy || '';
        update['footageRequest.requestedByEmail'] = footageRequesterEmail(ticket);
        if (note.requestedAt) update['footageRequest.requestedAt'] = note.requestedAt;
    }
    return update;
}

window.approveResolution = async function(id) {
    const confirmed = await showConfirmDialog({
        title: 'Approve Resolution',
        message: 'Approve this resolution? The ticket will be marked as <strong>Resolved</strong> and the requester will be emailed automatically.',
        confirmText: 'Approve',
        danger: false,
        icon: 'fa-check-circle'
    });
    if (!confirmed) return;
    const approvedTicket = allTickets.find(t => t.id === id) || null;
    // Status BEFORE this click — drives the duplicate-email guard (a repeat
    // approve of an already-approved ticket must never email twice).
    const prevApprovalStatus = approvedTicket ? (approvedTicket.approvalStatus || 'pending_approval') : '';
    const approvedByEmail = (auth.currentUser && auth.currentUser.email) || 'unknown';
    // ⚠️ THE CLOCK STARTS WHEN THE MANAGER OPENS THE TICKET, NOT NOW.
    //
    // This used to compute `now + window` and write `accessExpiresAt` here, so
    // the countdown ran from APPROVAL whether or not anyone ever looked at the
    // ticket. An approved report nobody opened still expired.
    //
    // Approval now writes the MARKER only. `accessWindowStartsOnOpen` is what
    // tells getTrackingAccessExpiry() that this ticket's deadline is derived
    // from `accessOpenedAt`, which the Area Manager's browser stamps the first
    // time the modal opens (window.markTrackingAccessOpened in firebase.js).
    // Until then the expiry is null and the ticket does not expire.
    //
    // ⚠️ The marker is mandatory, not tidying. Firestore cannot tell an absent
    // field from a null one, so an approval that merely stopped writing
    // `accessExpiresAt` would produce a document shaped exactly like a
    // pre-feature ticket — and the legacy `approvedAt + window` fallback would
    // restart the countdown at approval anyway.
    const accessStartsOnOpen = true;
    // ⚠️ RE-APPROVAL AFTER AN ADDITIONAL-FOOTAGE CYCLE MUST RE-ARM THE CLOCK.
    // Flow: approved → manager opens (accessOpenedAt stamped, window runs) →
    // manager requests footage (status 'Insufficient Footage', approval undone)
    // → operator re-resolves → superadmin approves again HERE. The old stamp
    // survives all of that, so without a clear the deadline stays
    // `oldOpenedAt + window` — already lapsed — and the ticket returns
    // already-expired. Clearing the stamp puts the ticket back to
    // "approved, never opened": the manager's next open starts a fresh window,
    // exactly like a Resend re-arm. Scoped to footage cycles only
    // (hasFootageRequestComment) so a plain duplicate approve of an
    // already-approved ticket cannot silently hand out extra time.
    const needsFreshWindow = typeof hasFootageRequestComment === 'function'
        && hasFootageRequestComment(approvedTicket);
    // Is THIS approval the answer to an open footage request? Then the
    // manager who asked is told (owner-dashboard listener + email).
    const footageAnswered = isOpenFootageRequest(approvedTicket);

    try {
        await firestoreService.updateTicket(id, {
            approvalStatus: 'approved',
            approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
            approvedBy: (auth.currentUser && auth.currentUser.email) || 'unknown',
            // ⚠️ NO `accessExpiresAt` HERE. The window has not started — it starts
            // when the Area Manager first opens the ticket, so writing a
            // deadline now would expire a report nobody has read yet.
            accessWindowStartsOnOpen: accessStartsOnOpen,
            // Re-arm only: delete() is a no-op when the fields are absent, so a
            // first-time approval is unaffected.
            ...(needsFreshWindow ? {
                accessOpenedAt: firebase.firestore.FieldValue.delete(),
                accessOpenedBy: firebase.firestore.FieldValue.delete(),
                accessExpiresAt: firebase.firestore.FieldValue.delete()
            } : {}),
            // Close the open request. Dot paths so the requester fields written
            // with the request are kept; for an in-flight ticket that predates
            // the marker, they are filled from the latest footage note.
            ...(footageAnswered ? footageAnsweredUpdate(approvedTicket) : {})
        });
        // Keep the in-memory copy in sync (listener is only a backup): mirror
        // the re-arm so badge/filter/expiry checks see the fresh state at once.
        if (needsFreshWindow) {
            const syncIdx = allTickets.findIndex(t => t && t.id === id);
            if (syncIdx > -1) {
                delete allTickets[syncIdx].accessOpenedAt;
                delete allTickets[syncIdx].accessOpenedBy;
                delete allTickets[syncIdx].accessExpiresAt;
                allTickets[syncIdx].accessWindowStartsOnOpen = true;
            }
        }
        console.log('Resolution approved');
        if (approvalDetailsModal) approvalDetailsModal.classList.remove('active');
        currentApprovalTicketId = null;
        // ===== Immediate UI refresh (real-time listener is a backup) =====
        updateApprovalsBadge();
        applyApprovalFilters(false);

        // ===== Automated approval email to the requester (best-effort) =====
        // Runs only AFTER the approval is safely in Firestore, and can never
        // block, cancel or roll back the approval itself.
        await notifyRequesterOfApproval(approvedTicket, {
            id: id,
            // No expiry is passed: at approval the window has not started, so
            // there is no date to promise. The email says so in words instead
            // (see buildTicketApprovedEmail in js/email.js).
            approvedBy: approvedByEmail,
            prevApprovalStatus: prevApprovalStatus,
            footageAnswered: footageAnswered,
            footageRequesterEmail: footageAnswered ? footageRequesterEmail(approvedTicket) : ''
        });

    } catch (error) {
        console.error('Approval error:', error);
        console.log('Failed to approve resolution.');
    }
};
// ==============================================================
//  TICKET HANDOFF — Transfer to HR / Transfer to Store
//  (replaces the old single "Approve Report" button)
// ==============================================================

window.transferTicketToHr = async function(id) {
    const confirmed = await showConfirmDialog({
        title: 'Transfer to HR',
        message: 'Transfer this ticket to HR only? It will be <strong>hidden</strong> from the Area Manager/RM/SM dashboard and sent to HR for investigation. The requester will be notified that the ticket is under investigation.',
        confirmText: 'Transfer to HR',
        danger: false,
        icon: 'fa-user-shield'
    });
    if (!confirmed) return;
    const approvedTicket = allTickets.find(t => t.id === id) || null;
    const approvedByEmail = (auth.currentUser && auth.currentUser.email) || 'unknown';
    try {
        await firestoreService.transferTicketToHr(id, approvedByEmail, (auth.currentUser && auth.currentUser.displayName) || approvedByEmail);
        if (approvalDetailsModal) approvalDetailsModal.classList.remove('active');
        currentApprovalTicketId = null;
        updateApprovalsBadge();
        applyApprovalFilters(false);
        if (typeof showToast === 'function') showToast('Ticket transferred to HR. It is now hidden from the Area Manager/RM/SM dashboard.', 'success');

        // ===== Email the REQUESTER (not HR) =====
        await notifyRequesterOfHrTransfer(approvedTicket, { id: id, approvedBy: approvedByEmail });
    } catch (error) {
        console.error('Transfer to HR error:', error);
        if (typeof showToast === 'function') showToast('Failed to transfer to HR. Please try again.', 'error');
    }
};

window.transferTicketToStore = async function(id) {
    const confirmed = await showConfirmDialog({
        title: 'Transfer to Store',
        message: 'Transfer this ticket to Store? HR and the Area Manager/RM/SM will both be able to view it. The requester will be notified that the ticket was completed.',
        confirmText: 'Transfer to Store',
        danger: false,
        icon: 'fa-store'
    });
    if (!confirmed) return;
    const approvedTicket = allTickets.find(t => t.id === id) || null;
    const prevApprovalStatus = approvedTicket ? (approvedTicket.approvalStatus || 'pending_approval') : '';
    const approvedByEmail = (auth.currentUser && auth.currentUser.email) || 'unknown';
    const accessStartsOnOpen = true;
    // ⚠️ THIS is the button that approves a resolution (approveResolution has
    // no button), so a footage request is answered HERE. Two extra writes when
    // it is:
    //   - close the open request (footageRequest.status → 'answered'), which
    //     triggers the manager's in-app notice and the footage email;
    //   - re-arm the viewing window, exactly as approveResolution does: the
    //     manager's old accessOpenedAt survives the footage cycle, so without
    //     clearing it the ticket comes back already expired.
    const footageAnswered = isOpenFootageRequest(approvedTicket);
    const storeExtraFields = footageAnswered ? Object.assign({
        accessOpenedAt: firebase.firestore.FieldValue.delete(),
        accessOpenedBy: firebase.firestore.FieldValue.delete(),
        accessExpiresAt: firebase.firestore.FieldValue.delete()
    }, footageAnsweredUpdate(approvedTicket)) : null;
    try {
        await firestoreService.transferTicketToStore(id, approvedByEmail,
            (auth.currentUser && auth.currentUser.displayName) || approvedByEmail, storeExtraFields);
        if (footageAnswered) {
            // Mirror the re-arm in memory, same as approveResolution.
            const syncIdx = allTickets.findIndex(t => t && t.id === id);
            if (syncIdx > -1) {
                delete allTickets[syncIdx].accessOpenedAt;
                delete allTickets[syncIdx].accessOpenedBy;
                delete allTickets[syncIdx].accessExpiresAt;
                allTickets[syncIdx].accessWindowStartsOnOpen = true;
            }
        }
        if (approvalDetailsModal) approvalDetailsModal.classList.remove('active');
        currentApprovalTicketId = null;
        updateApprovalsBadge();
        applyApprovalFilters(false);
        if (typeof showToast === 'function') showToast('Ticket transferred to Store. HR and Area Manager/RM/SM can now view it.', 'success');

        // ===== Email the requester (normal approval email) =====
        // On a footage answer it goes to the manager who asked, with the
        // footage line (see notifyRequesterOfApproval).
        await notifyRequesterOfApproval(approvedTicket, {
            id: id,
            approvedBy: approvedByEmail,
            prevApprovalStatus: prevApprovalStatus,
            footageAnswered: footageAnswered,
            footageRequesterEmail: footageAnswered ? footageRequesterEmail(approvedTicket) : ''
        });
    } catch (error) {
        console.error('Transfer to Store error:', error);
        if (typeof showToast === 'function') showToast('Failed to transfer to Store. Please try again.', 'error');
    }
};

/**
 * Undo a mistaken Transfer to Store / Transfer to HR: the ticket returns to
 * Pending Approval (and off the Area Manager/RM/SM dashboard) so the
 * superadmin can choose again. A reverted STORE transfer emails the requester
 * a correction; a reverted HR transfer is silent.
 */
window.revertTicketTransfer = async function(id) {
    if (!currentUserIsSuperAdmin()) return;
    const ticket = allTickets.find(t => t.id === id) || null;
    if (!ticket) return;
    const from = ticket.ticketTransferTo === 'hr' ? 'hr' : 'store';
    const label = ticket.ticketNumber || id;
    const confirmed = await showConfirmDialog({
        title: 'Revert Transfer',
        message: 'Revert the transfer of ticket <strong>' + escapeHTML(label) + '</strong> to '
            + (from === 'hr' ? 'HR' : 'Store') + '? It will go back to <strong>Pending Approval</strong>'
            + (from === 'store' ? ' and be removed from the Area Manager/RM/SM dashboard. The requester will be emailed a correction.' : '.'),
        confirmText: 'Revert Transfer',
        danger: true,
        icon: 'fa-undo'
    });
    if (!confirmed) return;
    const me = auth.currentUser || {};
    const byEmail = me.email || 'unknown';
    try {
        if (btnRevertTicketTransfer) btnRevertTicketTransfer.disabled = true;
        await firestoreService.revertTicketTransfer(id, byEmail, me.displayName || byEmail, from);
        if (approvalDetailsModal) approvalDetailsModal.classList.remove('active');
        currentApprovalTicketId = null;
        updateApprovalsBadge();
        applyApprovalFilters(false);
        if (typeof showToast === 'function') showToast('Transfer reverted. Ticket ' + label + ' is back to Pending Approval.', 'success');
        if (from === 'store') await notifyRequesterOfTransferRevert(ticket);
    } catch (error) {
        console.error('Revert transfer error:', error);
        if (typeof showToast === 'function') showToast('Failed to revert transfer. Please try again.', 'error');
    } finally {
        if (btnRevertTicketTransfer) btnRevertTicketTransfer.disabled = false;
    }
};

/** Best-effort correction email after reverting a Store transfer. Never throws. */
async function notifyRequesterOfTransferRevert(ticket) {
    try {
        if (!ticket) return;
        if (!window.EmailService || typeof window.EmailService.sendTicketTransferRevertEmail !== 'function') {
            console.warn('Revert Email: js/email.js is not loaded — notification skipped.');
            return;
        }
        if (!window.EmailService.isEmailConfigured()) {
            if (typeof showToast === 'function') showToast('Transfer reverted — emails are not configured, so no correction was sent.', 'info');
            return;
        }
        if (!window.EmailService.resolveRecipient(ticket)) {
            if (typeof showToast === 'function') showToast('Transfer reverted — this ticket has no email address, so no correction was sent.', 'info');
            return;
        }
        const result = await window.EmailService.sendTicketTransferRevertEmail(ticket);
        if (typeof showToast === 'function') {
            if (result.ok) showToast('Requester notified that the earlier notice was a mistake.', 'success');
            else if (result.timeout) showToast('Transfer reverted, but the email bridge timed out.', 'error');
            else showToast('Transfer reverted, but the correction email failed (' + (result.error || result.status) + ').', 'error');
        }
    } catch (error) {
        console.error('Revert correction email failed (the revert itself is unaffected):', error);
    }
}

/**
 * Notify the requester that their ticket has been transferred to HR for
 * investigation. The ticket is NOT resolved — viewing access is not granted.
 */
async function notifyRequesterOfHrTransfer(ticket, ctx) {
    try {
        if (!ticket || !ctx || !ctx.id) return;
        if (!window.EmailService || typeof window.EmailService.sendTicketApprovedEmail !== 'function') {
            console.warn('Approval Email: js/email.js is not loaded — notification skipped.');
            return;
        }
        if (!window.EmailService.isEmailConfigured()) {
            if (typeof showToast === 'function') showToast('Transferred to HR — approval emails are not configured yet.', 'info');
            return;
        }
        const recipient = window.EmailService.resolveRecipient(ticket);
        if (!recipient) {
            if (typeof showToast === 'function') showToast('Transferred to HR — this ticket has no email address, so no notification was sent.', 'info');
            return;
        }
        const result = await window.EmailService.sendTicketHrTransferEmail(ticket, { force: true });
        if (typeof showToast === 'function') {
            if (result.ok) showToast('Requester notified that the ticket is under investigation.', 'success');
            else if (result.timeout) showToast('Transferred to HR, but the email bridge timed out.', 'error');
            else showToast('Transferred to HR, but the email failed (' + (result.error || result.status) + ').', 'error');
        }
        applyApprovalFilters(false);
    } catch (error) {
        console.error('HR transfer email failed (the transfer itself is unaffected):', error);
    }
}


// ==============================================================
//  APPROVAL EMAIL NOTIFICATION (requester notification)
//  A superadmin approving a resolution automatically emails the requester from
//  the BUSINESS Gmail account: "Ticket request was done, please check your
//  request to the portal with this Ticket number: <TICKET>".
//
//  The message + the Apps Script bridge live in js/email.js / js/email-config.js
//  (browser cannot send SMTP); docs/EMAIL-SETUP.md is the 5-minute deploy guide.
//
//  ⚠️ EVERYTHING BELOW IS BEST-EFFORT: a failing email can never block, cancel
//  or roll back an approval. Failures are recorded on the ticket
//  (`approvalEmail`) and retried from the ✉ row action in the Approvals tab.
// ==============================================================

// Stops a double-click on Approve from starting a second send.
// (The real duplicate guard is EmailService.shouldSkipApprovalEmail().)
const approvalEmailInFlight = new Set();

/**
 * Persist the outcome of a notification attempt on the ticket so the Approvals
 * tab can show it (tooltip) and the superadmin can retry. Never throws.
 */
async function recordApprovalEmail(ticketId, info) {
    try {
        if (!ticketId) return;
        const idx = allTickets.findIndex(t => t.id === ticketId);
        const previous = (idx > -1 && allTickets[idx].approvalEmail) ? allTickets[idx].approvalEmail : {};
        const record = {
            status: info.status || 'unknown',
            to: info.to || '',
            error: info.error || '',
            sentAt: new Date(),
            sentBy: (auth.currentUser && auth.currentUser.email) || 'unknown',
            attempts: (Number(previous.attempts) || 0) + 1
        };
        if (idx > -1) allTickets[idx].approvalEmail = record;
        await firestoreService.updateTicket(ticketId, { approvalEmail: record });
    } catch (error) {
        console.warn('Could not record the approval-email status:', error && error.message ? error.message : error);
    }
}

/**
 * Fire the requester notification right after a superadmin approves.
 * `ctx` = { id, approvedBy, prevApprovalStatus }.
 * ⚠️ No `accessExpiresAt`: the window has not started at approval, so there is
 * no deadline to mirror into the snapshot or to promise in the email.
 * Never throws — see the banner above.
 */
async function notifyRequesterOfApproval(ticket, ctx) {
    try {
        if (!ticket || !ctx || !ctx.id) return;
        if (!window.EmailService || typeof window.EmailService.sendTicketApprovedEmail !== 'function') {
            console.warn('Approval Email: js/email.js is not loaded — notification skipped.');
            return;
        }
        if (window.EmailService.shouldSkipApprovalEmail(ctx.prevApprovalStatus)) {
            console.log('Approval Email: this ticket was already approved — no duplicate email sent.');
            return;
        }
        if (!window.EmailService.isEmailConfigured()) {
            if (typeof showToast === 'function') {
                showToast('Approved. Approval emails are not configured yet — see docs/EMAIL-SETUP.md.', 'info');
            }
            return;
        }
        if (approvalEmailInFlight.has(ctx.id)) return;
        approvalEmailInFlight.add(ctx.id);

        // Mirror the values just written to Firestore so the message reflects
        // THIS approval rather than the stale in-memory copy. The ticket is
        // mirrored as APPROVED-AND-NOT-YET-OPENED, which is what it now is.
        // (On a footage-cycle re-approval the accessOpenedAt stamp was just
        // cleared above, so the snapshot drops it too — otherwise the email
        // would promise the OLD, already-lapsed deadline.)
        const snapshot = Object.assign({}, ticket, {
            approvalStatus: 'approved',
            approvedAt: new Date(),
            approvedBy: ctx.approvedBy,
            accessWindowStartsOnOpen: true
        });
        if (typeof hasFootageRequestComment === 'function' && hasFootageRequestComment(ticket)) {
            delete snapshot.accessOpenedAt;
            delete snapshot.accessOpenedBy;
            delete snapshot.accessExpiresAt;
        }

        // A footage answer goes to the manager who ASKED for the footage, who
        // is often not the original filer. The email bridge allows that address
        // because it is stored on the ticket as footageRequest.requestedByEmail
        // (see docs/apps-script/RCMS-Ticket-Notifier.gs ticketRecipients).
        const emailOpts = ctx.footageAnswered
            ? { footageAnswered: true, recipient: ctx.footageRequesterEmail || '' }
            : {};
        if (ctx.footageAnswered) {
            snapshot.footageRequest = Object.assign({}, snapshot.footageRequest || {}, {
                status: 'answered',
                requestedByEmail: ctx.footageRequesterEmail || ''
            });
        }
        const recipient = (emailOpts.recipient && window.EmailService.isValidEmail
                && window.EmailService.isValidEmail(emailOpts.recipient))
            ? emailOpts.recipient
            : window.EmailService.resolveRecipient(snapshot);
        if (!recipient) {
            await recordApprovalEmail(ctx.id, { status: 'skipped_no_recipient', to: '' });
            if (typeof showToast === 'function') {
                showToast('Approved — this ticket has no email address, so no notification was sent.', 'info');
            }
            applyApprovalFilters(false);
            return;
        }

        const result = await window.EmailService.sendTicketApprovedEmail(snapshot,
            Object.assign({}, emailOpts, { recipient: recipient }));
        await recordApprovalEmail(ctx.id, {
            status: result.ok ? 'dispatched' : (result.status || 'failed'),
            to: recipient,
            error: result.error || ''
        });
        if (typeof showToast === 'function') {
            if (result.ok) {
                showToast('Approved — notification email sent to ' + recipient + '.', 'success');
            } else if (result.timeout) {
                // Keep the toast short — the full explanation lives in the console.
                showToast('Approved, but the email bridge did not answer (timed out).', 'error');
            } else {
                showToast('Approved, but the email to ' + recipient + ' failed ('
                    + (result.error || result.status) + ').', 'error');
            }
        }
        applyApprovalFilters(false);
    } catch (error) {
        console.error('Approval email failed (the approval itself is unaffected):', error);
    } finally {
        if (ctx && ctx.id) approvalEmailInFlight.delete(ctx.id);
    }
}

/**
 * ===== Manual approval email (send / resend) — superadmin only =====
 * The ✉ action in the Approvals tab: sends the requester notification again,
 * e.g. when the automatic attempt failed, when the ticket had no email address
 * at approval time, or for a legacy ticket approved before this feature
 * existed. It bypasses the duplicate guard on purpose (explicit click).
 */
window.resendApprovalEmail = async function(id) {
    if (!currentUserIsSuperAdmin()) { console.log('Permission denied.'); return; }
    const ticket = allTickets.find(t => t.id === id);
    if (!ticket) return;

    if (!window.EmailService || typeof window.EmailService.sendTicketApprovedEmail !== 'function') {
        if (typeof showToast === 'function') showToast('Approval emails are unavailable — js/email.js did not load.', 'error');
        return;
    }
    if (!window.EmailService.isEmailConfigured()) {
        if (typeof showToast === 'function') showToast('Approval emails are not configured yet — see docs/EMAIL-SETUP.md.', 'error');
        return;
    }

    const recipient = window.EmailService.resolveRecipient(ticket);
    if (!recipient) {
        await recordApprovalEmail(id, { status: 'skipped_no_recipient', to: '' });
        if (typeof showToast === 'function') showToast('This ticket has no email address to send to. Add one with Edit Approval Info first.', 'error');
        applyApprovalFilters(false);
        return;
    }

    const previousSend = (ticket.approvalEmail && ticket.approvalEmail.status === 'dispatched')
        ? ' The last successful send was ' + formatDateTime(ticket.approvalEmail.sentAt && ticket.approvalEmail.sentAt.toDate ? ticket.approvalEmail.sentAt.toDate() : ticket.approvalEmail.sentAt) + '.'
        : '';

    const confirmed = await showConfirmDialog({
        title: ticket.approvalEmail ? 'Resend Approval Email' : 'Send Approval Email',
        message: 'Send the approval notification for <strong>' + escapeHTML(ticket.ticketNumber || id)
            + '</strong> to <strong>' + escapeHTML(recipient) + '</strong>?' + escapeHTML(previousSend),
        confirmText: 'Send Email',
        danger: false,
        icon: 'fa-envelope'
    });
    if (!confirmed) return;

    try {
        const result = await window.EmailService.sendTicketApprovedEmail(ticket, { force: true });
        await recordApprovalEmail(id, {
            status: result.ok ? 'dispatched' : (result.status || 'failed'),
            to: recipient,
            error: result.error || ''
        });
        if (typeof showToast === 'function') {
            if (result.ok) {
                showToast('Notification email sent to ' + recipient + '.', 'success');
            } else if (result.timeout) {
                showToast('The email bridge did not answer (timed out). Close any ad-blocker '
                    + 'for this page and press ✉ again.', 'error');
            } else {
                showToast('Email to ' + recipient + ' failed (' + (result.error || result.status) + ').', 'error');
            }
        }
        applyApprovalFilters(false);
    } catch (error) {
        console.error('Resend approval email error:', error);
        if (typeof showToast === 'function') showToast('Failed to send the approval email.', 'error');
    }
};



/**
 * ===== 2-Day Tracking Access: RESEND (Superadmin only) =====
 * Expired approved tickets stop showing the report/footage on the public
 * "Track Ticket Status" lookup. Resending re-opens viewing for a fresh
 * 2-day window and records who/when resent it. No data is ever deleted.
 */

// ===== RE-ACCESS APPROVAL EMAIL ===========================================
//  When a superadmin approves a manager/store "Request Access" on an expired
//  ticket, the store gets an automated email confirming the access was granted
//  and pointing them back to the portal (prefilled with their ticket number).
//
//  ⚠️ BEST-EFFORT: same rule as the approval email — a failing email can
//  never roll back or block the access grant itself. The grant is already
//  committed to Firestore before this runs.
// ========================================================================

// Stops a double-click from starting a second send.
const accessEmailInFlight = new Set();

/**
 * Record the outcome of a re-access approval email on the ticket, so the
 * Approvals row can show it in the ✉ tooltip. Never throws.
 */
async function recordAccessEmail(ticketId, info) {
    try {
        if (!ticketId) return;
        const idx = allTickets.findIndex(t => t.id === ticketId);
        const previous = (idx > -1 && allTickets[idx].accessApprovedEmail) ? allTickets[idx].accessApprovedEmail : {};
        const record = {
            status: info.status || 'unknown',
            to: info.to || '',
            error: info.error || '',
            sentAt: new Date(),
            sentBy: (auth.currentUser && auth.currentUser.email) || 'unknown',
            attempts: (Number(previous.attempts) || 0) + 1
        };
        if (idx > -1) allTickets[idx].accessApprovedEmail = record;
        await firestoreService.updateTicket(ticketId, { accessApprovedEmail: record });
    } catch (error) {
        console.warn('Could not record the access-approved email status:', error && error.message ? error.message : error);
    }
}

/**
 * Fire the re-access approval notification AFTER the fresh window is safely in
 * Firestore. `ctx` = { id, ticket } — no expiry: a Resend re-arms the
 * window rather than starting it, so there is no date to promise.
 * Never throws — see the banner above.
 */
async function notifyRequesterOfAccessApproval(ctx) {
    try {
        if (!ctx || !ctx.id) return;
        if (!window.EmailService || typeof window.EmailService.sendAccessApprovedEmail !== 'function') {
            console.warn('Access Email: js/email.js is not loaded — notification skipped.');
            return;
        }
        if (!window.EmailService.isEmailConfigured()) {
            if (typeof showToast === 'function') {
                showToast('Access granted, but approval emails are not configured — see docs/EMAIL-SETUP.md.', 'info');
            }
            return;
        }
        if (accessEmailInFlight.has(ctx.id)) return;
        accessEmailInFlight.add(ctx.id);

        // ⚠️ THE SNAPSHOT IS "APPROVED, NOT YET OPENED". Reading the in-memory
        // ticket would carry whatever stamp it had BEFORE the Resend deleted
        // it, and passing the old expiry through would promise a deadline the
        // Resend just deliberately removed.
        const snapshot = Object.assign({}, ctx.ticket || {}, {
            accessWindowStartsOnOpen: true
        });
        delete snapshot.accessOpenedAt;
        delete snapshot.accessOpenedBy;

        const recipient = window.EmailService.resolveReopenRecipient(snapshot);
        if (!recipient) {
            await recordAccessEmail(ctx.id, { status: 'skipped_no_recipient', to: '' });
            if (typeof showToast === 'function') {
                showToast('Access granted — no email address on this ticket, so no notification was sent.', 'info');
            }
            return;
        }

        const result = await window.EmailService.sendAccessApprovedEmail(snapshot, ctx.accessExpiresAt);
        await recordAccessEmail(ctx.id, {
            status: result.ok ? 'dispatched' : (result.status || 'failed'),
            to: recipient,
            error: result.error || ''
        });
        if (typeof showToast === 'function') {
            if (result.ok) {
                showToast('Request approved — notification email sent to ' + recipient + '.', 'success');
            } else if (result.timeout) {
                showToast('Access granted, but the email bridge did not answer (timed out).', 'error');
            } else {
                showToast('Access granted, but the email to ' + recipient + ' failed ('
                    + (result.error || result.status) + ').', 'error');
            }
        }
    } catch (error) {
        console.error('Access approval email failed (the access grant is unaffected):', error);
    } finally {
        if (ctx && ctx.id) accessEmailInFlight.delete(ctx.id);
    }
}

/**
 * ===== 2-Day Tracking Access: RESEND (Superadmin only) =====
 * Expired approved tickets stop showing the report/footage on the public
 * "Track Ticket Status" lookup. Resending re-opens viewing for a fresh
 * 2-day window and records who/when resent it. No data is ever deleted.
 */
window.resendTrackingAccess = async function(id) {
    if (!currentUserIsSuperAdmin()) { console.log('Permission denied.'); return; }
    const ticket = allTickets.find(t => t.id === id);
    if (!ticket || !isApprovedTicket(ticket)) return;

    const pendingReopen = !!(ticket.accessReopenRequest && ticket.accessReopenRequest.status === 'pending');
    // A pending request carries the manager's own words — highlight them in the
    // dialog instead of burying the reason inside the sentence.
    const reopenReason = pendingReopen ? String(ticket.accessReopenRequest.reason || '') : '';
    const confirmed = await showConfirmDialog({
        title: pendingReopen ? 'Approve Re-access Request' : 'Resend Expired Ticket',
        message: (pendingReopen
            ? 'Approve the manager\'s re-access request? '
            : 'Resend this ticket to the manager/store? ')
            + `Viewing access to the report and footage will be re-opened for <strong>${trackingWindowLabel()}</strong>.`,
        reason: reopenReason,
        reasonLabel: 'Why they need access again',
        reasonMeta: pendingReopen ? reopenRequestMeta(ticket.accessReopenRequest) : '',
        confirmText: pendingReopen ? 'Approve & Resend' : 'Resend',
        danger: false,
        icon: 'fa-paper-plane'
    });
    if (!confirmed) return;

    try {
        // ⚠️ A RESEND DOES NOT START THE CLOCK. It RE-ARMS it.
        //
        // This used to compute `now + window` and write `accessExpiresAt`, which
        // started the deadline at the moment of the Resend — even for a ticket
        // the manager had not opened yet, and even for one that was merely
        // unopened and never needed re-access at all.
        //
        // Instead the first-open stamp is CLEARED. The ticket keeps
        // `accessWindowStartsOnOpen`, so the manager's next open starts a fresh
        // window. Consequence worth stating plainly: a ticket that was approved
        // but never opened stays unopened after a Resend and does not expire —
        // which is the intended behaviour, not a leak.
        const resendByEmail = (auth.currentUser && auth.currentUser.email) || 'unknown';
        const updateData = {
            // FieldValue.delete() clears the stamp; a plain `null` would be
            // indistinguishable from "never stamped" only by accident, and
            // delete() is explicit about intent in the document.
            accessOpenedAt: firebase.firestore.FieldValue.delete(),
            accessOpenedBy: firebase.firestore.FieldValue.delete(),
            accessLastResentAt: firebase.firestore.FieldValue.serverTimestamp(),
            accessLastResentBy: resendByEmail,
            accessResentCount: firebase.firestore.FieldValue.increment(1)
        };
        // ===== Option 1: a pending re-access request is FULFILLED by this resend =====
        // The requester's reason/history is kept — only the status flips.
        const reopenReq = ticket.accessReopenRequest || null;
        if (reopenReq) {
            updateData.accessReopenRequest = Object.assign({}, reopenReq, {
                status: 'fulfilled',
                resolvedAt: new Date(),
                resolvedBy: resendByEmail
            });
        }
        await firestoreService.updateTicket(id, updateData);
        console.log('Tracking access resent');

        // Keep the in-memory copy in sync so the badge/column refresh instantly
        // (the real-time listener is only a backup).
        const idx = allTickets.findIndex(t => t.id === id);
        if (idx > -1) {
            // Mirrors the delete() above: the ticket is back to "not opened".
            delete allTickets[idx].accessOpenedAt;
            delete allTickets[idx].accessOpenedBy;
            allTickets[idx].accessLastResentAt = new Date();
            allTickets[idx].accessLastResentBy = resendByEmail;
            allTickets[idx].accessResentCount = (Number(allTickets[idx].accessResentCount) || 0) + 1;
            if (updateData.accessReopenRequest) {
                allTickets[idx].accessReopenRequest = updateData.accessReopenRequest;
            }
        }

        if (approvalDetailsModal) approvalDetailsModal.classList.remove('active');
        currentApprovalTicketId = null;
        if (typeof showToast === 'function') {
            // "can view" would be wrong — the window starts when they open it.
            showToast(reopenReq
                ? 'Request fulfilled — their viewing window starts when they open the ticket.'
                : 'Access re-armed — their viewing window starts when they open the ticket.', 'success');
        }

        // ===== Email the store/manager that their re-access request was approved =====
        // Only when a REQUEST was actually approved (pendingReopen) — a plain
        // "Resend" nobody asked for does not notify anyone, matching the approval
        // email's rule. The grant is already committed above, so a failure here
        // cannot affect it, and the notification resolves on its own.
        if (pendingReopen) {
            await notifyRequesterOfAccessApproval({
                id: id,
                // No expiry: the Resend re-armed the window, it did not start
                // it. The manager's next open is when the clock begins.
                ticket: (idx > -1) ? allTickets[idx] : ticket
            });
        }

        // ===== Immediate UI refresh (real-time listener is a backup) =====
        updateApprovalsBadge();
        applyApprovalFilters(false);
    } catch (error) {
        console.error('Resend access error:', error);
        if (typeof showToast === 'function') showToast('Failed to resend access. Please try again.', 'error');
    }
};

function renderApprovalList() {
    if (!approvalListBody) return;

    const totalItems = filteredApprovalTickets.length;
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;
    if (approvalPage > totalPages) approvalPage = totalPages;
    if (approvalPage < 1) approvalPage = 1;

    const start = (approvalPage - 1) * ITEMS_PER_PAGE;
    const end = Math.min(start + ITEMS_PER_PAGE, totalItems);
    const pageItems = filteredApprovalTickets.slice(start, end);

    if (pageItems.length === 0) {
        approvalListBody.innerHTML = `<tr><td colspan="10" class="empty-state"><i class="fas fa-check-circle"></i><p>No approval records found.</p></td></tr>`;
    } else {
        approvalListBody.innerHTML = pageItems.map(ticket => {
            const statusText = getApprovalStatusText(ticket);
            const statusClass = statusText.toLowerCase().replace(/\s+/g, '-');
            const created = ticket.createdAt?.toDate ? formatDate(ticket.createdAt.toDate()) : (ticket.createdAt || '\u2014');
            const approvedAt = ticket.approvedAt?.toDate ? formatDate(ticket.approvedAt.toDate()) : (ticket.approvedAt || '\u2014');

            // ===== 2-day tracking access window (viewing by manager/store) =====
            const expiryInfo = getTrackingExpiryInfo(ticket);
            // A pending re-access request REPLACES the red "Expired" pill so the
            // cell stays a single line (the expiry is still spelled out in the
            // tooltip) — the chip keeps a red dot, so it still reads "closed".
            const reopenReq = (ticket.accessReopenRequest && ticket.accessReopenRequest.status === 'pending')
                ? ticket.accessReopenRequest
                : null;
            // ⚠️ The row action requires a PENDING REQUEST, exactly like the modal
            // footer button. Resend is the superadmin's RESPONSE to somebody
            // asking, so an expired ticket nobody asked about offers no way to
            // extend it from this table — otherwise a stray click hands out a
            // fresh window (and bumps accessResentCount) on a ticket that was
            // closed deliberately.
            const canResend = expiryInfo.expired && !!reopenReq && currentUserIsSuperAdmin();
            const expiryNote = expiryInfo.tracked
                ? (expiryInfo.expired ? 'Access expired ' : 'Viewing access until ') + formatDateTime(expiryInfo.date)
                : '';
            let expiryCell;
            if (reopenReq) {
                const reopenCount = Number(reopenReq.requestCount) || 1;
                const reopenTitle = 'Reopen requested' + (reopenCount > 1 ? ' \u00d7' + reopenCount : '') +
                    ' \u2014 Reason: ' + (reopenReq.reason || '\u2014') +
                    (reopenReq.requestedBy ? ' \u2014 ' + reopenReq.requestedBy : '') +
                    (expiryNote ? ' \u00b7 ' + expiryNote : '') +
                    ' \u00b7 Press Approve Request & Resend to approve';
                expiryCell = `<span class="access-reopen-badge" title="${escapeAttr(reopenTitle)}">`
                    + `<i class="fas fa-envelope-open-text"></i> Reopen requested`
                    + (reopenCount > 1 ? ` \u00d7${reopenCount}` : '')
                    + `</span>`;
            } else if (expiryInfo.tracked && expiryInfo.expired) {
                expiryCell = `<span class="status-badge expired" title="Expired ${escapeHTML(formatDateTime(expiryInfo.date))}">Expired</span>`;
            } else if (expiryInfo.tracked) {
                expiryCell = `<span class="access-until" title="Viewing access ends at this time">${escapeHTML(formatDateTime(expiryInfo.date))}</span>`;
            } else {
                expiryCell = '<span style="color:var(--text-muted);">\u2014</span>';
            }
            const resendBtn = canResend
                ? `<button class="action-btn resend" data-tooltip="Approve Request &amp; Resend (${trackingWindowLabel()})" onclick="event.stopPropagation(); window.resendTrackingAccess('${ticket.id}')"><i class="fas fa-check-double"></i></button>`
                : '';

            // ===== Delete ticket (replaces old ✉ email retry) =====
            // Same slot in the row — now calls window.deleteTicket() with confirm.
            // Superadmin-only, for APPROVED and FOR REVISION tickets alike.
            const emailBtn = ((isApprovedTicket(ticket) || isRejectedTicket(ticket)) && currentUserIsSuperAdmin())
                ? `<button class="action-btn delete-action" data-tooltip="Delete" onclick="event.stopPropagation(); window.deleteTicket('${ticket.id}')"><i class="fas fa-trash"></i></button>`
                : '';


            // One shared button set feeds BOTH interfaces: the desktop Actions
            // cell wraps it in .action-group, the phone card footer drops the
            // same buttons straight into .approval-card-actions. The old
            // card-only envelope "Open chat" button is gone — chat lives in the
            // header's #openChatModal, and every action a phone needs is now
            // exactly the desktop row's action (Approve/Reject included).
            // HR uploads indicator (replaces the eye button): amber when HR has
            // attached NOV files to this ticket, grey when none. The row's own
            // onclick still opens the approval details, so the eye was redundant.
            const hasHrFiles = window.HrUploads && typeof window.HrUploads.hasUploads === 'function'
                ? window.HrUploads.hasUploads('tickets/' + ticket.id) : false;
            const hrUploadBtn = `<span class="action-btn upload-indicator${hasHrFiles ? ' has-uploads' : ''}" data-upload-key="tickets/${ticket.id}" data-upload-label="${escapeHTML(ticket.ticketNumber || ticket.id)}" title="HR NOV files${hasHrFiles ? ' — files attached' : ' — no files'}" onclick="event.stopPropagation(); window.HrUploads && window.HrUploads.openFromButton(this);"><i class="fas fa-file-contract"></i><span class="upload-indicator-label">NOV</span></span>`;

            let actionBtns = '';
            if (isPendingApproval(ticket)) {
                actionBtns = `${resendBtn}${emailBtn}<button class="action-btn approve" data-tooltip="Transfer to HR" onclick="event.stopPropagation(); window.transferTicketToHr('${ticket.id}')"><i class="fas fa-user-shield"></i></button>
                    <button class="action-btn approve" data-tooltip="Transfer to Store" onclick="event.stopPropagation(); window.transferTicketToStore('${ticket.id}')"><i class="fas fa-store"></i></button>
                    <button class="action-btn reject" data-tooltip="Reject" onclick="event.stopPropagation(); window.rejectTicket('${ticket.id}')"><i class="fas fa-times"></i></button>
                    <button class="action-btn edit" data-tooltip="Edit Approval Info" onclick="event.stopPropagation(); window.openEditApprovalModal('${ticket.id}')"><i class="fas fa-edit"></i></button>
                    ${hrUploadBtn}`;
            } else {
                actionBtns = `${resendBtn}${emailBtn}<button class="action-btn edit" data-tooltip="Edit Approval Info" onclick="event.stopPropagation(); window.openEditApprovalModal('${ticket.id}')"><i class="fas fa-edit"></i></button>
                    ${hrUploadBtn}`;
            }
            const actions = `<div class="action-group">
                    ${actionBtns}
                </div>`;
            const cardStatusDot = statusClass === 'approved'
                ? '<i class="fas fa-circle approval-card-dot approval-card-dot--ok"></i>'
                : '<i class="fas fa-circle approval-card-dot"></i>';
            const cardExpiry = reopenReq
                ? `<span class="access-reopen-badge"><i class="fas fa-envelope-open-text"></i> Reopen requested`
                    + (Number(reopenReq.requestCount) > 1 ? ` \u00d7${reopenReq.requestCount}` : '') + `</span>`
                : expiryCell;

            return `<tr class="approval-row" onclick="window.openApprovalDetails('${ticket.id}')">
                <td data-label="Ticket No."><span class="ticket-link">${escapeHTML(ticket.ticketNumber || ticket.id)}</span></td>
                <td data-label="Branch">${escapeHTML(ticket.branch || '\u2014')}</td>
                <td data-label="Incident">${escapeHTML(ticket.incident || '\u2014')}</td>
                <td data-label="Reporter">${escapeHTML(ticket.name || '\u2014')}</td>
                <td data-label="Date Created">${created}</td>
                <td data-label="Status"><span class="status-badge ${statusClass}">${escapeHTML(statusText)}</span></td>
                <td data-label="Approved Date">${approvedAt}</td>
                <td data-label="Access Expires">${expiryCell}</td>
                <td>${actions}</td>
                <td class="approval-card-cell" data-label="Card">
                    <div class="approval-card">
                        <div class="approval-card-head">
                            <span class="approval-card-branch"><i class="fas fa-store"></i>${escapeHTML(ticket.branch || '\u2014')}</span>
                            <span class="approval-card-pill approval-card-pill--${statusClass}">${cardStatusDot}${escapeHTML(statusText)}</span>
                        </div>
                        <div class="approval-card-grid">
                            <div class="approval-card-field"><span class="approval-card-label">Incident</span><span class="approval-card-value">${escapeHTML(ticket.incident || '\u2014')}</span></div>
                            <div class="approval-card-field"><span class="approval-card-label">Reporter</span><span class="approval-card-value">${escapeHTML(ticket.name || '\u2014')}</span></div>
                            <div class="approval-card-field"><span class="approval-card-label">Date Created</span><span class="approval-card-value approval-card-muted">${created}</span></div>
                            <div class="approval-card-field"><span class="approval-card-label">Approved Date</span><span class="approval-card-value approval-card-muted">${approvedAt}</span></div>
                        </div>
                        <div class="approval-card-foot">
                            <div class="approval-card-expiry"><span class="approval-card-label">Access Expires</span>${cardExpiry}</div>
                            <div class="approval-card-actions">
                                ${actionBtns}
                            </div>
                        </div>
                    </div>
                </td>
            </tr>`;
        }).join('');
    }

    // Re-flag the HR upload indicators for the rows just drawn (amber = HR has files).
    try { if (window.HrUploads && window.HrUploads.paintPresence) window.HrUploads.paintPresence(); } catch (e) { /* ignore */ }

    // Stats summary — only count tickets that were actually submitted for approval
    // (Pending / In Progress tickets never entered the approval workflow)
    const submitted = allTickets.filter(t => isSubmittedForApproval(t)).length;
    const pendingApproval = allTickets.filter(t => isPendingApproval(t)).length;
    const approved = allTickets.filter(t => isApprovedTicket(t)).length;
    const rejected = allTickets.filter(t => isRejectedTicket(t)).length;
    if (approvalTotalCount) approvalTotalCount.textContent = submitted;
    if (approvalPendingCount) approvalPendingCount.textContent = pendingApproval;
    if (approvalApprovedCount) approvalApprovedCount.textContent = approved;
    if (approvalRejectedCount) approvalRejectedCount.textContent = rejected;

    // Pagination controls
    if (approvalPagination) {
        if (totalPages <= 1) {
            approvalPagination.innerHTML = `<span class="page-info">Showing all ${totalItems} record(s)</span>`;
        } else {
            let html = `<button onclick="window.goToApprovalPage(${approvalPage - 1})" ${approvalPage <= 1 ? 'disabled' : ''}>\u00AB Prev</button>`;
            const maxVisiblePages = 5;
            let startPage = Math.max(1, approvalPage - Math.floor(maxVisiblePages / 2));
            let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
            if (endPage - startPage + 1 < maxVisiblePages) startPage = Math.max(1, endPage - maxVisiblePages + 1);
            for (let i = startPage; i <= endPage; i++) {
                html += `<button class="${i === approvalPage ? 'active' : ''}" onclick="window.goToApprovalPage(${i})">${i}</button>`;
            }
            html += `<button onclick="window.goToApprovalPage(${approvalPage + 1})" ${approvalPage >= totalPages ? 'disabled' : ''}>Next \u00BB</button>`;
            html += `<span class="page-info">Page ${approvalPage} of ${totalPages}</span>`;
            approvalPagination.innerHTML = html;
        }
    }
}

window.goToApprovalPage = function(page) {
    approvalPage = page;
    renderApprovalList();
};

if (approvalSearch) approvalSearch.addEventListener('input', debounce(filterApprovalTickets, 300));
if (approvalStatusFilter) approvalStatusFilter.addEventListener('change', filterApprovalTickets);
if (approvalBranchFilter) approvalBranchFilter.addEventListener('change', filterApprovalTickets);

function renderPagination() {
    if (!paginationControls) return;
    const totalItems = filteredTickets.length;
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;

    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    const end = Math.min(start + ITEMS_PER_PAGE, totalItems);
    const pageItems = filteredTickets.slice(start, end);

    displayTickets(pageItems);

    if (totalPages <= 1) {
        paginationControls.innerHTML = `<span class="page-info">Showing all ${totalItems} tickets</span>`;
        return;
    }

    let html = `<button onclick="goToPage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>\u00AB Prev</button>`;
    const maxVisiblePages = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
    if (endPage - startPage + 1 < maxVisiblePages) startPage = Math.max(1, endPage - maxVisiblePages + 1);

    for (let i = startPage; i <= endPage; i++) {
        html += `<button class="${i === currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`;
    }

    html += `<button onclick="goToPage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>Next \u00BB</button>`;
    html += `<span class="page-info">Page ${currentPage} of ${totalPages} (${totalItems} tickets)</span>`;

    paginationControls.innerHTML = html;
}

window.goToPage = function(page) {
    currentPage = page;
    renderPagination();
};

window.startTicket = async function(id) {
    try {
        await firestoreService.updateTicket(id, { status: 'In Progress' });
        console.log('Ticket moved to In Progress');
    } catch (error) {
        console.log('Failed to start ticket');
    }
};

window.resolveTicket = function(id) {
    const ticket = allTickets.find(t => t.id === id);
    if (!ticket) return;
    // A ticket sent back by an "additional footage" request is an EDIT of the
    // previous resolution, not a new one: the operator needs the old notes and
    // the old pictures/videos/files in front of them. The Revise & Resubmit
    // modal already is that form, so hand over to it (in footage mode).
    if (isFootageReworkTicket(ticket)) {
        return window.reviseTicket(id);
    }
currentResolveTicketId = id;
    // Map the resolve widget to this ticket id so auto-uploads go to the right folder
    const resolveWidget = document.getElementById('resolveDropzone') ? document.getElementById('resolveDropzone').closest('.upload-widget') : null;
    if (resolveWidget) {
        autoUploadTicketId.set(resolveWidget, id);
        resetAutoUpload(resolveWidget);
        resetUploadProgress(resolveWidget);
    }
    if (resolveModalTitle) resolveModalTitle.textContent = `Resolve Ticket: ${ticket.ticketNumber || id}`;
    if (resolutionNotesEl) resolutionNotesEl.value = '';
    if (resolveAttachmentInput) resolveAttachmentInput.value = '';
    if (resolveModal) resolveModal.classList.add('active');
};

if (closeResolveModal) closeResolveModal.addEventListener('click', () => { if (resolveModal) resolveModal.classList.remove('active'); currentResolveTicketId = null; });
if (cancelResolve) cancelResolve.addEventListener('click', () => { if (resolveModal) resolveModal.classList.remove('active'); currentResolveTicketId = null; });
if (resolveModal) resolveModal.addEventListener('click', (e) => { if (e.target === resolveModal) { resolveModal.classList.remove('active'); currentResolveTicketId = null; } });

if (submitResolutionBtn) {
    submitResolutionBtn.addEventListener('click', async () => {
        const id = currentResolveTicketId;
        if (!id) return;
        const notes = resolutionNotesEl ? resolutionNotesEl.value.trim() : '';
        const fileInput = resolveAttachmentInput;
        const files = fileInput && fileInput.files ? Array.from(fileInput.files) : [];

        if (!notes) {
            if (resolutionNotesEl) {
                resolutionNotesEl.style.borderColor = 'var(--color-danger)';
                resolutionNotesEl.focus();
            }
            return;
        }

const btn = submitResolutionBtn;
        // Double-tap guard. `btn.disabled` already blocks a second click on a
        // real button, but the click could still land from a queued event before
        // the flag was read, and a second run would resolve the ticket twice.
        if (btn && btn.disabled) return;
        setSubmitBusy(btn, true);

        const resolveWidget = fileInput ? fileInput.closest('.upload-widget') : null;
        // ⚠️ NO resetUploadProgress() HERE, ON PURPOSE. It removes `.visible`,
        // so calling it on submit HID the progress bar at the exact moment the
        // operator clicked Submit -- the indicator they needed most. The bar is
        // only cleared when the modal is opened (resolveTicket/reviseTicket).
        if (resolveUploadStatus) { resolveUploadStatus.textContent = ''; resolveUploadStatus.classList.remove('success', 'error'); }

try {
            // 1) Upload any attachments (optional) to Cloudinary
            // Start with files already uploaded via the auto-upload dropzone
            const resolveWidgetRoot = document.getElementById('resolveDropzone') ? document.getElementById('resolveDropzone').closest('.upload-widget') : null;
            const autoKey = document.getElementById('resolveDropzone') ? document.getElementById('resolveDropzone').id : 'auto';
            let attachmentList = (autoUploadedAttachments[autoKey] || []).slice();
            if (files.length > 0) {
                if (!isCloudinaryConfigured()) {
                    console.log('Cloudinary not configured. Attachments skipped.');
                } else {
                    const v = validateUploadFiles(files);
                    if (!v.ok) {
                        if (resolveUploadStatus) { resolveUploadStatus.textContent = v.message; resolveUploadStatus.classList.add('error'); }
                        // Show the error state on the progress bar too
                        if (resolveWidget) finishUploadProgress(resolveWidget, false);
                        return;
                    }
                    for (let i = 0; i < files.length; i++) {
                        try {
                            const att = await cloudinaryUpload(files[i], id, (pct) => {
                                // Monotonic across the batch, not per-file 0->100.
                                if (resolveWidget) setUploadProgress(resolveWidget, aggregateUploadPercent(i, pct, files.length));
                                if (resolveUploadStatus) resolveUploadStatus.textContent = `Uploading ${i + 1} of ${files.length}…`;
                            });
                            attachmentList.push(att);
                        } catch (e) { console.error('Attachment upload error:', e); }
                    }
                }
            }

            // 2) Indeterminate "Submitting for approval…" state. Deliberately
            // BEFORE the Firestore write rather than a flat 100% after the
            // uploads: XHR reports nothing once the body is sent, so a bar
            // pinned at 100% during the write tells the operator nothing is
            // happening -- and this write can sit behind a slow connection for
            // several seconds with the modal apparently frozen.
            if (resolveWidget) setUploadProgressIndeterminate(resolveWidget);
            if (resolveUploadStatus) resolveUploadStatus.textContent = 'Submitting for approval…';

            // 3) Merge with existing ticket attachments
            const ticket = allTickets.find(t => t.id === id);
            const existingAtt = (ticket && Array.isArray(ticket.attachments)) ? ticket.attachments : [];
            const mergedAtt = existingAtt.concat(attachmentList);

            // Check if this ticket had additional footage requested
            // (re-resolution after an "Insufficient Footage" footage request).
            // If so, store only the *newly uploaded* attachments separately so
            // the Track Ticket page can show them in a distinct section.
            const comments = (ticket && Array.isArray(ticket.comments)) ? ticket.comments : [];
            const hasFootageRequest = comments.some(c => c && c.type === 'footage_request');

            // ⚠️ FOOTAGE ACCUMULATES — it is never replaced. `operatorFootage` must
            // hold EVERY clip the operator has ever submitted for this ticket, not
            // just this round's: splitApprovalAttachments() derives the manager's
            // half as "everything not in the operator list", so a short list does
            // not merely hide old footage, it re-files it as the manager's own.
            const operatorFootage = mergeOperatorFootage(ticket, attachmentList);
            // The Track page's separate "Resolved Additional Footage" section is
            // also cumulative — on a SECOND footage request the previous round's
            // clips must still be listed there, so it carries the same rule.
            const prevAdditional = Array.isArray(ticket && ticket.resolvedAdditionalFootage)
                ? ticket.resolvedAdditionalFootage : [];
            const additionalFootage = mergeOperatorFootage(
                { resolvedAdditionalFootage: prevAdditional }, attachmentList);

            // 3) Mark Resolved + pending superadmin approval
            const updateData = {
                status: 'Resolved',
                approvalStatus: 'pending_approval',
                // Top-level fields (per spec) kept in sync with the nested object
                resolutionNotes: notes,
                resolutionAttachmentUrl: attachmentUrl(mergedAtt[0]),
                attachments: mergedAtt,
                // Store newly uploaded attachments as "resolved additional footage"
                // when the ticket was previously marked Insufficient Footage
                resolvedAdditionalFootage: hasFootageRequest && attachmentList.length > 0
                    ? additionalFootage
                    : firebase.firestore.FieldValue.delete(),
                // THIS round's clips only — drives the "NEW" badge (see
                // footageAddedKeys). Same condition as the cumulative field.
                latestAdditionalFootage: hasFootageRequest
                    ? attachmentList.slice()
                    : firebase.firestore.FieldValue.delete(),
                // Clear any previous rejection data when resubmitting a For Revision ticket
                rejectionReason: firebase.firestore.FieldValue.delete(),
                rejection: firebase.firestore.FieldValue.delete(),
                resolution: {
                    notes,
                    attachments: mergedAtt,
                    operatorFootage: operatorFootage,
                    resolvedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    resolvedBy: (auth.currentUser && auth.currentUser.email) || 'unknown'
                }
            };
            await firestoreService.updateTicket(id, updateData);

            console.log('Resolution submitted for approval');
            if (resolveModal) resolveModal.classList.remove('active');
            currentResolveTicketId = null;
            // Clear the auto-uploaded attachments for this widget
            if (resolveWidgetRoot) resetAutoUpload(resolveWidgetRoot);
        } catch (error) {
            console.error('Failed to submit resolution:', error);
            // The operator must be able to tell "sent" from "failed" without
            // reading the console. This branch only used to console.log, so a
            // failed submit silently closed over the same greyed-out button the
            // success path used -- the ticket just never moved.
            if (resolveWidget) finishUploadProgress(resolveWidget, false);
            if (resolveUploadStatus) {
                resolveUploadStatus.textContent = 'Could not submit. Please try again.';
                resolveUploadStatus.classList.add('error');
            }
            if (typeof showToast === 'function') {
                showToast('Failed to submit resolution. Please try again.', 'error');
            }
        } finally {
            // Restore the button label from the stashed idle markup. Assigning
            // `disabled = false` alone would leave the spinner on a button the
            // operator can now click again.
            setSubmitBusy(btn, false);
            if (resolutionNotesEl) resolutionNotesEl.style.borderColor = '';
            if (fileInput) fileInput.value = '';
        }
    });
}

// ==============================================================
//  REVISE & RESUBMIT MODAL (For Revision tickets)
//  When a superadmin rejects a resolution, the ticket is sent back
//  with the status "For Revision". The operator opens this modal to
//  review the rejection reason, update the resolution notes /
//  attachments, and resubmit for approval.
// ==============================================================

/**
 * True for a ticket the operator is re-working because an Area Manager /
 * RM/SM (or the Track page) asked for additional footage. Both halves are
 * needed: the note alone stays on the ticket forever, so without the status
 * check a ticket in a LATER, unrelated cycle would still match.
 */
function isFootageReworkTicket(ticket) {
    return !!ticket
        && String(ticket.status || '') === 'Insufficient Footage'
        && hasFootageRequestComment(ticket);
}

// Set by reviseTicket() each time the modal opens, read by its submit handler.
let revisionFootageMode = false;

const REVISION_INTRO_REJECTED = 'This resolution was sent back for revision. Review the reason below, update the '
    + 'resolution notes, and resubmit for <strong>Superadmin approval</strong>.';
const REVISION_INTRO_FOOTAGE = 'Additional footage was requested for this ticket. Review the request below, edit your '
    + 'resolution notes, remove or add files as needed, and resubmit for <strong>Superadmin approval</strong>.';

window.reviseTicket = function(id) {
    const ticket = allTickets.find(t => t.id === id);
    if (!ticket) return;

    revisionFootageMode = isFootageReworkTicket(ticket);

currentResolveTicketId = id;

    // Reset the set of existing attachments the operator removes during this
    // revision session (fresh state each time the modal opens).
    removedRevisionAttachmentIds = new Set();

    // Map the revision widget to this ticket id so auto-uploads go to the right folder
    const revisionWidget = document.getElementById('revisionDropzone') ? document.getElementById('revisionDropzone').closest('.upload-widget') : null;
    if (revisionWidget) {
        autoUploadTicketId.set(revisionWidget, id);
        resetAutoUpload(revisionWidget);
        resetUploadProgress(revisionWidget);
    }

    if (revisionModalTitle) {
        revisionModalTitle.textContent = `${revisionFootageMode ? 'Update Resolution' : 'Revise & Resubmit'}: ${ticket.ticketNumber || id}`;
    }
    // The intro and the reason-box label are swapped per mode and ALWAYS set,
    // so a footage-mode open can never leave its wording behind for the next
    // For Revision ticket.
    const revisionIntroText = document.getElementById('revisionIntroText');
    if (revisionIntroText) {
        revisionIntroText.innerHTML = revisionFootageMode ? REVISION_INTRO_FOOTAGE : REVISION_INTRO_REJECTED;
    }
    const revisionReasonLabel = document.getElementById('revisionReasonLabel');
    if (revisionReasonLabel) {
        revisionReasonLabel.textContent = revisionFootageMode ? 'Additional Footage Requested' : 'Rejection Reason';
    }

    let reason;
    if (revisionFootageMode) {
        // The manager's own words — the LATEST request is the one being answered.
        const requests = (Array.isArray(ticket.comments) ? ticket.comments : [])
            .filter(c => c && c.type === 'footage_request');
        const latest = requests[requests.length - 1] || {};
        reason = String(latest.text || '').trim() || 'No details provided.';
        if (latest.requestedBy) reason += ` — ${latest.requestedBy}`;
    } else {
        // Show the superadmin's rejection reason so the operator knows what to fix
        const rejection = ticket.rejection || {};
        reason = rejection.reason || ticket.rejectionReason || 'No rejection reason provided.';
    }
    if (revisionRejectionReason) {
        revisionRejectionReason.textContent = reason;
    }

    // Pre-fill the notes with the previous resolution so the operator can amend them
    const resolution = ticket.resolution || {};
    const prevNotes = resolution.notes || ticket.resolutionNotes || '';
    if (revisionNotesEl) revisionNotesEl.value = prevNotes;

if (revisionAttachmentInput) revisionAttachmentInput.value = '';
    if (revisionUploadStatus) revisionUploadStatus.textContent = '';
if (revisionError) revisionError.style.display = 'none';
    // Show existing ticket attachments with remove (×) buttons so the operator
    // can delete prior evidence before resubmitting.
    renderRevisionAttachments(document.getElementById('revisionAttachmentsGrid'), ticket);
    if (revisionModal) revisionModal.classList.add('active');
};

if (closeRevisionModal) closeRevisionModal.addEventListener('click', () => { if (revisionModal) revisionModal.classList.remove('active'); currentResolveTicketId = null; });
if (cancelRevision) cancelRevision.addEventListener('click', () => { if (revisionModal) revisionModal.classList.remove('active'); currentResolveTicketId = null; });
if (revisionModal) revisionModal.addEventListener('click', (e) => { if (e.target === revisionModal) { revisionModal.classList.remove('active'); currentResolveTicketId = null; } });

if (submitRevisionBtn) {
    submitRevisionBtn.addEventListener('click', async () => {
        const id = currentResolveTicketId;
        if (!id) return;
        const notes = revisionNotesEl ? revisionNotesEl.value.trim() : '';
        const fileInput = revisionAttachmentInput;
        const files = fileInput && fileInput.files ? Array.from(fileInput.files) : [];

        if (!notes) {
            if (revisionError) {
                revisionError.textContent = 'Please enter updated resolution notes.';
                revisionError.style.display = 'block';
            }
            if (revisionNotesEl) {
                revisionNotesEl.style.borderColor = 'var(--color-danger)';
                revisionNotesEl.focus();
            }
            return;
        }

const btn = submitRevisionBtn;
        // Double-tap guard -- same reason as the Resolve handler: a queued second
        // click would resubmit (and re-resolve) the ticket.
        if (btn && btn.disabled) return;
        setSubmitBusy(btn, true);
        if (revisionUploadStatus) { revisionUploadStatus.textContent = ''; revisionUploadStatus.classList.remove('success', 'error'); }

const revisionWidget = fileInput ? fileInput.closest('.upload-widget') : null;
        // NO resetUploadProgress() here — it removes `.visible` and would hide
        // the bar the instant Submit is pressed. Same reason as Resolve.

try {
            // 1) Upload any new attachments (optional) to Cloudinary
            // Start with files already uploaded via the auto-upload dropzone
            const revisionWidgetRoot = document.getElementById('revisionDropzone') ? document.getElementById('revisionDropzone').closest('.upload-widget') : null;
            const autoKey = document.getElementById('revisionDropzone') ? document.getElementById('revisionDropzone').id : 'auto';
            let attachmentList = (autoUploadedAttachments[autoKey] || []).slice();
            if (files.length > 0) {
                if (!isCloudinaryConfigured()) {
                    console.log('Cloudinary not configured. Attachments skipped.');
                } else {
                    const v = validateUploadFiles(files);
                    if (!v.ok) {
                        if (revisionUploadStatus) { revisionUploadStatus.textContent = v.message; revisionUploadStatus.classList.add('error'); }
                        // Show the error state on the progress bar too
                        if (revisionWidget) finishUploadProgress(revisionWidget, false);
                        return;
                    }
                    for (let i = 0; i < files.length; i++) {
                        try {
                            const att = await cloudinaryUpload(files[i], id, (pct) => {
                                // Monotonic across the batch, not per-file 0->100.
                                if (revisionWidget) setUploadProgress(revisionWidget, aggregateUploadPercent(i, pct, files.length));
                                if (revisionUploadStatus) revisionUploadStatus.textContent = `Uploading ${i + 1} of ${files.length}…`;
                            });
                            attachmentList.push(att);
                        } catch (e) { console.error('Attachment upload error:', e); }
                    }
                }
            }

            // Indeterminate "Resubmitting…" state before the Firestore write --
            // a bar pinned at 100% during the write is indistinguishable from
            // "already done". Same reasoning as the Resolve handler.
            if (revisionWidget) setUploadProgressIndeterminate(revisionWidget);
            if (revisionUploadStatus) revisionUploadStatus.textContent = 'Resubmitting for approval…';

            // 2) Merge with existing ticket attachments (keep prior evidence)
            const ticket = allTickets.find(t => t.id === id);
            // ⚠️ THE × BUTTONS IN THIS MODAL ARE ONLY HONOURED HERE. They record
            // public_ids into `removedRevisionAttachmentIds` (see
            // renderRevisionAttachments) and NOTHING between the click and this
            // line ever read that set — so before this the operator could delete a
            // wrong clip, watch it vanish from the grid, and have it written back
            // anyway. Filtering here is what makes the removal real, and it is
            // required now that footage accumulates rather than being replaced.
            //
            // Duck-typed for the same reason as inside mergeOperatorFootage():
            // `instanceof Set` is realm-bound and would silently degrade to
            // "remove nothing" for a Set from any other realm.
            const removedIds = (removedRevisionAttachmentIds
                && typeof removedRevisionAttachmentIds.has === 'function')
                ? removedRevisionAttachmentIds : EMPTY_REMOVED_SET;
            const priorAtt = (ticket && Array.isArray(ticket.attachments)) ? ticket.attachments : [];
            const existingAtt = priorAtt.filter(a => !(a && removedIds.has(a.public_id)));
            const mergedAtt = existingAtt.concat(attachmentList);

            // 3) Mark Resolved + pending superadmin approval (re-enter the queue)
            const operatorFootage = mergeOperatorFootage(ticket, attachmentList, removedIds);
            // FOOTAGE MODE ONLY: keep the Track page's "Resolved Additional
            // Footage" marker, which the plain Resolve handler used to write for
            // these tickets. Cumulative and removal-aware (previous rounds -
            // removed + this round), so a notes-only resubmit keeps earlier
            // marked clips; an empty result clears the field rather than
            // storing []. A For Revision resubmit does not touch the field.
            let additionalFootageField = {};
            if (revisionFootageMode) {
                const prevAdditional = Array.isArray(ticket && ticket.resolvedAdditionalFootage)
                    ? ticket.resolvedAdditionalFootage : [];
                const additional = mergeOperatorFootage(
                    { resolvedAdditionalFootage: prevAdditional }, attachmentList, removedIds);
                // THIS round only (drives the "NEW" badge): previous rounds'
                // clips are deliberately not carried over, so a notes-only
                // resubmit marks nothing as new.
                const latest = attachmentList.filter(a => !(a && removedIds.has(a.public_id)));
                additionalFootageField = {
                    resolvedAdditionalFootage: additional.length
                        ? additional
                        : firebase.firestore.FieldValue.delete(),
                    // [] (not delete) so "nothing new this round" is recorded
                    // and the badge does not fall back to the cumulative list.
                    latestAdditionalFootage: latest
                };
            }
            const updateData = {
                status: 'Resolved',
                approvalStatus: 'pending_approval',
                resolutionNotes: notes,
                resolutionAttachmentUrl: attachmentUrl(mergedAtt[0]),
                attachments: mergedAtt,
                ...additionalFootageField,
                // Clear the previous rejection data since the resolution was revised
                rejectionReason: firebase.firestore.FieldValue.delete(),
                rejection: firebase.firestore.FieldValue.delete(),
                resolution: {
                    notes,
                    attachments: mergedAtt,
                    operatorFootage: operatorFootage,
                    resolvedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    resolvedBy: (auth.currentUser && auth.currentUser.email) || 'unknown'
                }
            };
            await firestoreService.updateTicket(id, updateData);

            console.log('Revised resolution submitted for approval');
            if (revisionModal) revisionModal.classList.remove('active');
            currentResolveTicketId = null;
            // Clear the auto-uploaded attachments for this widget
            if (revisionWidgetRoot) resetAutoUpload(revisionWidgetRoot);
            // ===== Immediate UI refresh (real-time listener is a backup) =====
            updateApprovalsBadge();
            applyApprovalFilters(false);
        } catch (error) {
            console.error('Failed to submit revised resolution:', error);
            if (revisionError) {
                revisionError.textContent = 'Failed to submit revised resolution. Please try again.';
                revisionError.style.display = 'block';
            }
            // Mirror the error onto the upload row too: #revisionError is a
            // validation box styled for missing notes, and the validation passed
            // here, so without this the failure had no indicator at all.
            if (revisionWidget) finishUploadProgress(revisionWidget, false);
            if (revisionUploadStatus) {
                revisionUploadStatus.textContent = 'Could not resubmit. Please try again.';
                revisionUploadStatus.classList.add('error');
            }
            if (typeof showToast === 'function') {
                showToast('Failed to submit revised resolution. Please try again.', 'error');
            }
        } finally {
            // Restores the stashed idle label as well as re-enabling the button.
            setSubmitBusy(btn, false);
            if (revisionNotesEl) revisionNotesEl.style.borderColor = '';
            if (fileInput) fileInput.value = '';
        }
    });
}

window.rejectTicket = function(id) {
    const ticket = allTickets.find(t => t.id === id);
    if (!ticket) return;
    currentRejectTicketId = id;
    if (rejectReasonInput) rejectReasonInput.value = '';
    if (rejectError) rejectError.style.display = 'none';
    if (rejectModal) rejectModal.classList.add('active');
};

if (closeRejectModal) closeRejectModal.addEventListener('click', () => { if (rejectModal) rejectModal.classList.remove('active'); currentRejectTicketId = null; });
if (cancelReject) cancelReject.addEventListener('click', () => { if (rejectModal) rejectModal.classList.remove('active'); currentRejectTicketId = null; });
if (rejectModal) rejectModal.addEventListener('click', (e) => { if (e.target === rejectModal) { rejectModal.classList.remove('active'); currentRejectTicketId = null; } });

if (submitRejectionBtn) {
    submitRejectionBtn.addEventListener('click', async () => {
        const id = currentRejectTicketId;
        if (!id) return;
        const reason = rejectReasonInput ? rejectReasonInput.value.trim() : '';

        if (!reason) {
            if (rejectError) rejectError.style.display = 'block';
            return;
        }

        const btn = submitRejectionBtn;
        if (btn) btn.disabled = true;

        try {
            await firestoreService.updateTicket(id, {
                status: 'For Revision',
                approvalStatus: 'rejected',
                // Top-level field (per spec) kept in sync with the nested object
                rejectionReason: reason,
                rejection: {
                    reason,
                    rejectedAt: firebase.firestore.FieldValue.serverTimestamp(),
                    rejectedBy: (auth.currentUser && auth.currentUser.email) || 'unknown'
                }
            });
            console.log('Resolution sent back for revision');
            if (rejectModal) rejectModal.classList.remove('active');
            if (approvalDetailsModal) approvalDetailsModal.classList.remove('active');
            currentRejectTicketId = null;
            // ===== Immediate UI refresh (real-time listener is a backup) =====
            updateApprovalsBadge();
            applyApprovalFilters(false);
        } catch (error) {
            console.error('Failed to reject resolution:', error);
            console.log('Failed to reject resolution. Please try again.');
        } finally {
            if (btn) btn.disabled = false;
        }
    });
}

window.reopenTicket = async function(id) {
    const confirmed = await showConfirmDialog({
        title: 'Reopen Ticket',
        message: 'Reopen this ticket as <strong>In Progress</strong>?',
        confirmText: 'Reopen',
        danger: false,
        icon: 'fa-redo-alt'
    });
    if (!confirmed) return;
    try {
        await firestoreService.updateTicket(id, { status: 'In Progress' });
        console.log('Ticket reopened as In Progress');
    } catch (error) {
        console.log('Failed to reopen ticket');
    }
};

window.deleteTicket = async function(id) {
    const confirmed = await showConfirmDialog({
        title: 'Delete Ticket',
        message: 'Type the ticket number below to confirm permanent deletion.',
        confirmText: 'Delete',
        danger: true,
        icon: 'fa-trash-alt',
        confirmByTyping: id
    });
    if (!confirmed) return;
    try {
        await firestoreService.deleteTicket(id);
        console.log('Ticket deleted');
    } catch (error) {
        console.log('Failed to delete ticket');
    }
};

// ==============================================================
//  TICKET ATTACHMENTS (Cloudinary)
// ==============================================================

function isCloudinaryConfigured() {
    return CLOUDINARY_CLOUD_NAME && CLOUDINARY_CLOUD_NAME !== 'YOUR_CLOUD_NAME'
        && CLOUDINARY_UPLOAD_PRESET && CLOUDINARY_UPLOAD_PRESET !== 'YOUR_UPLOAD_PRESET';
}

function setAttachmentStatus(message, isError, statusElId) {
    const el = statusElId ? document.getElementById(statusElId) : document.getElementById('attachmentUploadStatus');
    if (!el) return;
    el.textContent = message || '';
    el.classList.remove('success', 'error');
    if (isError) el.classList.add('error');
    else if (message) el.classList.add('success');
}

function formatFileSize(bytes) { return attachmentHelpers().formatFileSize(bytes); }

function getCloudinaryThumbUrl(secureUrl, width, height) { return attachmentHelpers().getCloudinaryThumbUrl(secureUrl, width, height); }
/**
 * THE ONE attachment-tile builder. Every attachment grid in the app calls this,
 * so an identical file looks identical everywhere it appears.
 *
 * WHY IT IS SHARED. The five renderers each grew their own inline if/else and
 * drifted apart, which is why previews were inconsistent:
 *   - renderTicketAttachments() put the RAW url in the <img>, so a ticket tile
 *     downloaded the full-size file while every other grid asked Cloudinary for
 *     a 200x200 transform.
 *   - A video was a real inline <video> element in the ticket grid, a bare play
 *     icon in three other grids, and a plain file icon in the approval grid,
 *     which had no video branch at all. The same clip looked like three
 *     different things.
 *   - Only four of the five guarded a missing URL.
 *
 * getCloudinaryThumbUrl() ALREADY knows how to ask Cloudinary for a still frame
 * from a video (it rewrites /video/upload/ to a w_,h_,c_fill,f_jpg transform
 * ending in .jpg), so a video gets a real poster frame here for free. The
 * per-renderer copy-paste simply never called it.
 *
 * @param {object} norm  a record from normalizeAttachment()
 * @param {number} index position, used only for the fallback name
 * @returns {string} HTML for the tile body (NOT the anchor)
 */
function buildAttachmentPreview(norm, index) { return window.AttachmentViewer.buildAttachmentPreview(norm, index); }

/**
 * ⚠️ NORMALISE AN ATTACHMENT — the two writers in this app save DIFFERENT shapes.
 *
 *   js/owner-ticket-form.js (the Area Manager form) writes
 *       { url, publicId, fileName, mimeType, bytes }
 *   the original Cloudinary payload (and older tickets) carries
 *       { secure_url, public_id, name, resource_type, format, bytes }
 *
 * They share exactly ONE key: `bytes`. So a reader that only understands the
 * Cloudinary shape found the file size but no URL — which is how a ticket ended
 * up rendering an attachment card with `href=""`, a 1.22 MB label and
 * "Attachment 1" as its name. The data was never lost; the reader was looking
 * for keys this writer never produced.
 *
 * This one helper is the single place that knows both shapes. Every renderer
 * calls it, so a third writer cannot silently reintroduce the drift.
 */
function normalizeAttachment(att) { return attachmentHelpers().normalizeAttachment(att); }

/**
 * ⚠️ The URL of an attachment, ALWAYS as a string — never `undefined`.
 *
 * Every write of `resolutionAttachmentUrl` used to be
 *     attachments[0] ? attachments[0].secure_url : ''
 * which looks safe but is not: the FALSE branch yields '' while the TRUE branch
 * yields `undefined` for anything uploaded through the Area Manager form (which
 * stores `url`, not `secure_url`). Firestore REJECTS undefined outright —
 * "Unsupported field value: undefined" — so the whole update() threw and a
 * Submit-for-Approval was lost with no field written at all.
 *
 * Routing every one of those through here means the value is a string whatever
 * shape the record happens to be, so a missing key can never break a write.
 */
function attachmentUrl(att) {
    const norm = normalizeAttachment(att);
    return (norm && norm.url) || '';
}

function getAttachmentIcon(resourceType, format) { return attachmentHelpers().getAttachmentIcon(resourceType, format); }

function getAttachmentColor(format) { return attachmentHelpers().getAttachmentColor(format); }

/**
 * Whether a ticket is allowed to display attachments in the Ticket Details modal.
 * Attachments are shown only for fully resolved tickets and for-revision tickets.
 */
/**
 * Track existing attachments the operator chooses to delete while revising a
 * ticket. These public_ids are excluded when the revised resolution is merged
 * and submitted for approval.
 */
let removedRevisionAttachmentIds = new Set();

/**
 * Render the existing attachments in the Revise & Resubmit modal with a remove
 * (×) button so the operator can delete prior evidence before resubmitting.
 * Deleted files are tracked in `removedRevisionAttachmentIds` and excluded from
 * the merged attachment list on submit. They are removed from the TICKET only —
 * the file itself stays in Cloudinary (an unsigned client cannot delete it).
 * @param {HTMLElement} grid    the `#revisionAttachmentsGrid` container
 * @param {object} ticket       the ticket holding `attachments`
 */
function renderRevisionAttachments(grid, ticket) {
    if (!grid) return;
    // OPERATOR FILES ONLY. `ticket.attachments` also carries what the requester
    // attached when filing the ticket; those are not part of the resolution the
    // operator is revising, so they are neither shown nor removable here. They
    // stay on the ticket untouched (the submit handler only drops ids recorded
    // in removedRevisionAttachmentIds, which can now only be operator files).
    // splitApprovalAttachments() is the shared requester/operator split, with
    // `requesterAttachments` as the authoritative requester list.
    const attachments = splitApprovalAttachments(ticket).operator;
    const deletedSet = new Set(removedRevisionAttachmentIds || []);
    const visible = attachments.filter(a => !deletedSet.has(a.public_id));
    if (visible.length === 0) {
        grid.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">No existing attachments.</p>';
        return;
    }
    grid.innerHTML = visible.map((att, index) => {
        const norm = normalizeAttachment(att);   // both writers' shapes
        const url = norm ? norm.url : '';
        const name = (norm && norm.name) || ('Attachment ' + (index + 1));
        const sizeText = (norm && norm.bytes) ? formatFileSize(norm.bytes) : '';
        const isImage = !!(norm && norm.resourceType === 'image');
        const isVideo = !!(norm && norm.resourceType === 'video');
        const icon = norm ? getAttachmentIcon(norm.resourceType, norm.format) : 'fa-file';
        const color = norm ? getAttachmentColor(norm.format) : '#64748b';
        const isBroken = !url;

        // One shared tile builder, so this grid matches every other grid.
        // See buildAttachmentPreview() for what used to differ here.
        const preview = buildAttachmentPreview(norm, index);

        // No URL -> a div, never an empty anchor. See renderTicketAttachments().
        const body = isBroken
            ? `<div class="attachment-preview" title="Link unavailable">${preview}</div>`
            : `<a href="${url}" target="_blank" rel="noopener noreferrer" class="attachment-preview" title="${escapeHTML(name)}">${preview}</a>`;

        return `
            <div class="attachment-item" data-public-id="${escapeHTML(norm ? norm.publicId : '')}">
                ${body}
                <div class="attachment-meta">
                    <span class="attachment-name" title="${escapeHTML(name)}">${escapeHTML(name)}</span>
                    ${sizeText ? `<span class="attachment-size">${escapeHTML(sizeText)}</span>` : ''}
                </div>
                <button type="button" class="attachment-remove" data-tooltip="Remove" data-public-id="${escapeHTML(att.public_id || '')}">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;
    }).join('');

    // Bind remove buttons to the existing attachments in the revision modal
    grid.querySelectorAll('.attachment-remove').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const publicId = btn.dataset.publicId;
            if (!publicId) return;
            const confirmed = await showConfirmDialog({
                title: 'Remove Attachment',
                message: 'Remove this attachment before resubmitting? It will be removed from the ticket.',
                confirmText: 'Remove',
                danger: true,
                icon: 'fa-trash-alt'
            });
            if (!confirmed) return;

            removedRevisionAttachmentIds = removedRevisionAttachmentIds || new Set();
            removedRevisionAttachmentIds.add(publicId);
            renderRevisionAttachments(grid, ticket);
        });
    });
}

function renderTicketAttachments(ticket) {
    // Two grids, mirroring the Ticket Reviews modal: the requester's own files
    // (inside the collapsible section) and the operator's resolution files.
    // The operator grid only exists when the operator card was rendered.
    const requesterGrid = document.getElementById('ticketRequesterAttachments');
    const operatorGrid = document.getElementById('ticketAttachmentsGrid');
    if (!requesterGrid && !operatorGrid) return;
    const ticketId = ticket ? ticket.id : '';
    const split = splitApprovalAttachments(ticket);
    const emptyHtml = '<p class="review-empty-files">No files available.</p>';

    if (requesterGrid) requesterGrid.innerHTML = split.manager.length > 0 ? renderTiles(split.manager) : emptyHtml;
    if (operatorGrid) operatorGrid.innerHTML = split.operator.length > 0 ? renderTiles(split.operator) : emptyHtml;

    const requesterCount = document.getElementById('ticketRequesterAttCount');
    const operatorCount = document.getElementById('ticketOperatorAttCount');
    if (requesterCount) requesterCount.textContent = '(' + split.manager.length + ')';
    if (operatorCount) operatorCount.textContent = '(' + split.operator.length + ')';

    function renderTiles(attachments) {
    return attachments.map((att, index) => {
        // ⚠️ Both writers' shapes are understood here. See normalizeAttachment().
        const norm = normalizeAttachment(att);
        const url = norm ? norm.url : '';
        const name = (norm && norm.name) || ('Attachment ' + (index + 1));
        const sizeText = (norm && norm.bytes) ? formatFileSize(norm.bytes) : '';
        const isImage = !!(norm && norm.resourceType === 'image');
        const isVideo = !!(norm && norm.resourceType === 'video');
        const icon = norm ? getAttachmentIcon(norm.resourceType, norm.format) : 'fa-file';
        const color = norm ? getAttachmentColor(norm.format) : '#64748b';
        const publicId = norm ? norm.publicId : '';

        // ⚠️ WITHOUT A URL THERE IS NO ANCHOR AT ALL.
        // `href=""` is a real link to the CURRENT PAGE: clicking it navigated the
        // whole app to its own URL instead of opening the viewer. A record with no
        // URL now renders an unclickable card that says so — un-clickable by
        // construction, rather than by a click guard that ran too late.
        const isBroken = !url;

        const removeBtn = publicId ? `
            <button type="button" class="attachment-remove" data-tooltip="Remove"
                onclick="removeTicketAttachment('${escapeHTML(ticketId)}', '${escapeHTML(publicId)}')">
                <i class="fas fa-times"></i>
            </button>
        ` : '';

        // NOTE: this renderer used to carry its own video branch that emitted an
        // inline <video> element inside a <div> that was not an anchor — so it could
        // never open the viewer — while the other four grids showed a bare play icon
        // and the approval grid showed a plain file icon. All of that is gone. A video
        // is now a normal tile with a real Cloudinary poster frame from the shared
        // builder below, so it looks the same here as everywhere else. Clicking it
        // opens the same viewer; the "Open full video" card link went with it, since
        // the viewer's own Open button and ctrl-click still cover 'new tab'.


        // One shared tile builder, so this grid matches every other grid.
        // See buildAttachmentPreview() for what used to differ here.
        const preview = buildAttachmentPreview(norm, index);

        // A broken record renders a div, NOT an anchor - see the isBroken note.
        const body = isBroken
            ? `<div class="attachment-preview" title="Link unavailable">${preview}</div>`
            : `<a href="${url}" target="_blank" rel="noopener noreferrer" class="attachment-preview" title="${escapeHTML(name)}">${preview}</a>`;

        return `
            <div class="attachment-item" data-public-id="${escapeHTML(publicId)}">
                ${body}
                <div class="attachment-meta">
                    <span class="attachment-name" title="${escapeHTML(name)}">${escapeHTML(name)}</span>
                    ${sizeText ? `<span class="attachment-size">${escapeHTML(sizeText)}</span>` : ''}
                    ${isBroken ? '<span class="attachment-size" style="color:#dc2626;">link unavailable</span>' : ''}
                </div>
                ${removeBtn}
            </div>
        `;
    }).join('');
    }
}

window.removeTicketAttachment = async function(ticketId, publicId) {
    if (!ticketId || !publicId) return;
    const confirmed = await showConfirmDialog({
        title: 'Remove Attachment',
        message: 'Remove this attachment from the ticket?',
        confirmText: 'Remove',
        danger: true,
        icon: 'fa-trash-alt'
    });
    if (!confirmed) return;
    try {
        const ticketDoc = await db.collection('tickets').doc(ticketId).get();
        if (!ticketDoc.exists) return;
        const data = ticketDoc.data();
        const existing = Array.isArray(data.attachments) ? data.attachments : [];
        const oldRes = data.resolution || {};
        const oldResAtts = Array.isArray(oldRes.attachments) ? oldRes.attachments : [];
        const oldReqAtts = Array.isArray(data.requesterAttachments) ? data.requesterAttachments : [];
        const remaining = existing.filter(a => a.public_id !== publicId);
        const remainingRes = oldResAtts.filter(a => a.public_id !== publicId);
        // The requester grid reads `requesterAttachments` directly (see
        // splitApprovalAttachments), so it must be filtered too or a removed
        // requester file would keep showing.
        const remainingReq = oldReqAtts.filter(a => a.public_id !== publicId);

        await db.collection('tickets').doc(ticketId).update({
            attachments: remaining,
            ...(oldReqAtts.length > 0 ? { requesterAttachments: remainingReq } : {}),
            resolutionAttachmentUrl: attachmentUrl(remaining[0]),
            resolution: { ...oldRes, attachments: remainingRes }
        });

        const idx = allTickets.findIndex(t => t.id === ticketId);
        if (idx >= 0) {
            allTickets[idx] = { ...allTickets[idx], attachments: remaining, resolution: { ...oldRes, attachments: remainingRes } };
            if (oldReqAtts.length > 0) allTickets[idx].requesterAttachments = remainingReq;
        }
        renderTicketAttachments(allTickets[idx] || { id: ticketId, attachments: remaining });
        setAttachmentStatus('Attachment removed.', false);
    } catch (e) {
        console.error('Remove attachment error:', e);
        setAttachmentStatus('Failed to remove attachment.', true);
    }
};

async function cloudinaryUpload(file, ticketId, onProgress) {
    // Use XMLHttpRequest when a progress callback is supplied so we can report
    // real upload percentage (fetch does not expose upload progress).
    if (typeof onProgress === 'function') {
        return new Promise((resolve, reject) => {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
            formData.append('folder', 'tickets/' + ticketId);
            formData.append('public_id', makeUniquePublicId(file.name));

            const xhr = new XMLHttpRequest();
            xhr.open('POST', `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`);
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                    const pct = Math.round((e.loaded / e.total) * 100);
                    onProgress(pct);
                }
            };
            xhr.onload = () => {
                let data = null;
                try { data = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
                if (xhr.status >= 200 && xhr.status < 300 && data) {
                    resolve({
                        public_id: data.public_id,
                        secure_url: data.secure_url,
                        format: data.format,
                        resource_type: data.resource_type,
                        width: data.width || null,
                        height: data.height || null,
                        bytes: data.bytes,
                        name: file.name,
                        uploadedAt: new Date().toISOString()
                    });
                } else {
                    let errMsg = 'Upload failed (' + xhr.status + ')';
                    if (data && data.error && data.error.message) errMsg = data.error.message;
                    reject(new Error(errMsg));
                }
            };
            xhr.onerror = () => reject(new Error('Network error during upload.'));
            xhr.send(formData);
        });
    }

    // Fallback: original fetch-based upload (no progress).
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
    formData.append('folder', 'tickets/' + ticketId);
    formData.append('public_id', makeUniquePublicId(file.name));
    const res = await fetch(
        `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/auto/upload`,
        { method: 'POST', body: formData }
    );
    if (!res.ok) {
        let errMsg = 'Upload failed (' + res.status + ')';
        try {
            const errData = await res.json();
            if (errData && errData.error && errData.error.message) errMsg = errData.error.message;
        } catch (e) { /* ignore parse error */ }
        throw new Error(errMsg);
    }
    const data = await res.json();
    return {
        public_id: data.public_id,
        secure_url: data.secure_url,
        format: data.format,
        resource_type: data.resource_type,
        width: data.width || null,
        height: data.height || null,
        bytes: data.bytes,
        name: file.name,
        uploadedAt: new Date().toISOString()
    };
}

// ==============================================================
//  UPLOAD WIDGET HELPERS (Dropzone + file list + progress bar)
//  Shared by the Ticket Details, Approvals, Edit Approval,
//  Resolve, and Revision modals for a consistent upload UX.
// ==============================================================

/**
 * Build/refresh the selected-file list inside an upload widget.
 * @param {HTMLElement} widget  root `.upload-widget` element
 * @param {FileList|Array} files selected files
 * @param {Function} onRemove callback(name) when a file is removed
 */
function renderUploadFileList(widget, files, onRemove) {
    const listEl = widget.querySelector('.upload-file-list');
    if (!listEl) return;
    const arr = Array.from(files || []);
    if (arr.length === 0) { listEl.innerHTML = ''; return; }
    listEl.innerHTML = arr.map((f, i) => `
        <div class="upload-file-item" data-index="${i}">
            <i class="fas fa-file-alt"></i>
            <span class="upload-file-name" title="${escapeHTML(f.name)}">${escapeHTML(f.name)}</span>
            <span class="upload-file-size">${formatFileSize(f.size)}</span>
            <button type="button" class="upload-file-remove" data-file="${escapeHTML(f.name)}" title="Remove">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `).join('');

    listEl.querySelectorAll('.upload-file-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const name = btn.dataset.file;
            if (onRemove) onRemove(name);
        });
    });
}

/**
 * Validate a set of files against allowed types + max size.
 * @returns {{ok:boolean, message:string}}
 */
function validateUploadFiles(files) {
    const arr = Array.from(files || []);
    for (const file of arr) {
        const typeOk = ALLOWED_ATTACHMENT_TYPES.includes(file.type);
        const sizeOk = file.size <= MAX_ATTACHMENT_SIZE_MB * 1024 * 1024;
        if (!typeOk) return { ok: false, message: `"${file.name}" type is not allowed.` };
        if (!sizeOk) return { ok: false, message: `"${file.name}" exceeds ${MAX_ATTACHMENT_SIZE_MB}MB.` };
    }
    return { ok: true, message: '' };
}

/**
 * Stage files for an approval dropzone, accumulating across multiple
 * drag-drops / picker selections instead of replacing the previous set.
 * Newly added files are appended (deduped by name+size), the widget's
 * <input type="file"> is synced to the full pending array via DataTransfer so
 * the Upload button uploads everything staged, and the file list is rendered
 * with remove buttons. Removing a file deletes it from the pending array and
 * re-syncs the input.
 * @param {Array} pending   the pending-file array this widget owns
 * @param {HTMLElement} widget  root `.upload-widget` element
 * @param {HTMLInputElement} input  the widget's <input type="file">
 * @param {FileList} files  newly selected/dropped files
 */
function addPendingFiles(pending, widget, input, files) {
    const validation = validateUploadFiles(files);
    if (!validation.ok) {
        const statusEl = widget.querySelector('.attachment-upload-status');
        if (statusEl) { statusEl.textContent = validation.message; statusEl.classList.add('error'); }
        return;
    }
    const incoming = Array.from(files || []);
    incoming.forEach(f => {
        if (!pending.some(x => x.name === f.name && x.size === f.size)) {
            pending.push(f);
        }
    });
    // Sync the hidden input so the Upload button uploads everything staged.
    const dt = new DataTransfer();
    pending.forEach(f => dt.items.add(f));
    input.files = dt.files;
    renderUploadFileList(widget, pending, (name) => {
        pending.splice(pending.findIndex(f => f.name === name), 1);
        const dt2 = new DataTransfer();
        pending.forEach(f => dt2.items.add(f));
        input.files = dt2.files;
        renderUploadFileList(widget, pending);
        updateUploadWidgetButton(widget);
    });
    updateUploadWidgetButton(widget);
}

/**
 * Reset a widget's progress UI back to its idle state.
 */
function resetUploadProgress(widget) {
    const wrap = widget.querySelector('.upload-progress-wrap');
    const bar = widget.querySelector('.upload-progress-bar');
    const text = widget.querySelector('.upload-progress-text');
    const status = widget.querySelector('.attachment-upload-status');
    if (wrap) { wrap.classList.remove('visible', 'success', 'error', 'indeterminate'); }
    if (bar) bar.style.width = '0%';
    if (text) text.textContent = '0%';
    if (status) { status.textContent = ''; status.classList.remove('success', 'error'); }
}

/**
 * Show the progress bar and update its percentage.
 */
function setUploadProgress(widget, pct) {
    const wrap = widget.querySelector('.upload-progress-wrap');
    const bar = widget.querySelector('.upload-progress-bar');
    const text = widget.querySelector('.upload-progress-text');
    if (wrap) wrap.classList.add('visible');
    if (bar) bar.style.width = pct + '%';
    if (text) text.textContent = pct + '%';
}

/**
 * Mark the widget's progress as complete (success) or failed (error).
 */
function finishUploadProgress(widget, ok) {
    const wrap = widget.querySelector('.upload-progress-wrap');
    const bar = widget.querySelector('.upload-progress-bar');
    const text = widget.querySelector('.upload-progress-text');
    const status = widget.querySelector('.attachment-upload-status');
    if (wrap) {
        wrap.classList.add('visible');
        // Drop the indeterminate sweep: it animates the bar indefinitely, so
        // leaving it on would keep a finished 100% bar crawling.
        wrap.classList.remove('success', 'error', 'indeterminate');
        wrap.classList.add(ok ? 'success' : 'error');
    }
    if (bar) bar.style.width = ok ? '100%' : '0%';
    if (text) text.textContent = ok ? '100%' : '0%';
    if (status) {
        status.classList.remove('success', 'error');
        status.classList.add(ok ? 'success' : 'error');
    }
}

/**
 * Switch a widget's progress bar into the indeterminate "working, no real
 * percentage known" state, used for the Firestore write after the files have
 * finished uploading. `XHR.upload.onprogress` reports nothing once the request
 * body is sent, so a bar frozen at 100% reads as "done" while the ticket is
 * still being written -- this keeps the row visibly alive instead.
 * @param {HTMLElement} widget root `.upload-widget` element
 */
function setUploadProgressIndeterminate(widget) {
    const wrap = widget.querySelector('.upload-progress-wrap');
    const bar = widget.querySelector('.upload-progress-bar');
    if (!wrap) return;
    wrap.classList.add('visible', 'indeterminate');
    wrap.classList.remove('success', 'error');
    // Reset the width too: the animation only reads as motion if the fill is
    // part-grown, and coming from a 100% bar it would look stuck.
    if (bar) bar.style.width = '100%';
}

/**
 * Fold one file's own 0-100 progress into a single monotonic bar across the
 * whole batch. Without this the `for (const file of files)` loops fed each
 * file's raw percentage into the same bar, so three files produced 0->100,
 * 0->100, 0->100 -- the indicator appeared to restart three times and the
 * operator could not tell whether it was making progress.
 * @param {number} done   files already finished (0-based count)
 * @param {number} pct    the current file's own progress, 0-100
 * @param {number} total  how many files are being uploaded
 * @returns {number} the batch percentage, 0-100
 */
function aggregateUploadPercent(done, pct, total) {
    if (!total || total <= 0) return 0;
    const own = Math.min(100, Math.max(0, Number(pct) || 0));
    return Math.min(100, ((done + own / 100) / total) * 100);
}

/**
 * Show the spinner + "Submitting…" state on a submit button, and put the
 * original label back afterwards. The operator's Resolve / Revise modals only
 * ever did `btn.disabled = true`, which greys the button out and says nothing
 * -- for the whole of a slow Cloudinary upload AND a Firestore write, with no
 * way to tell a working button from a broken one. Mirrors setBusy() in
 * js/owner-ticket-form.js so both dashboards behave the same.
 *
 * The original markup is stashed in `data-idle-html` rather than rebuilt as a
 * string, so the two buttons keep their own icon and wording and a future edit
 * to the markup cannot drift out of sync with a hard-coded copy here.
 * @param {HTMLElement} btn
 * @param {boolean} busy
 */
function setSubmitBusy(btn, busy) {
    if (!btn) return;
    if (busy) {
        // Capture the idle label ONCE. Re-running this on an already-busy button
        // would overwrite the stashed copy with the spinner markup, so the
        // button could never be restored.
        if (!btn.dataset.idleHtml) btn.dataset.idleHtml = btn.innerHTML;
        btn.disabled = true;
        btn.classList.add('is-busy');
        btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> <span>Submitting…</span>';
    } else {
        btn.disabled = false;
        btn.classList.remove('is-busy');
        if (btn.dataset.idleHtml) {
            btn.innerHTML = btn.dataset.idleHtml;
            delete btn.dataset.idleHtml;
        }
    }
}

/**
 * Wire up a `.upload-widget` element: dropzone click/over + file selection list.
 * When the dropzone has `data-auto-upload="true"` (Resolve / Revise modals),
 * the selected files are uploaded to Cloudinary immediately instead of waiting
 * for a separate Upload button. Uploaded files are tracked in
 * `autoUploadedAttachments` so the submit handler can attach them to the ticket.
 * @param {HTMLElement} widget  root `.upload-widget` element
 */
function bindUploadDropzone(widget) {
    const dropzone = widget.querySelector('.upload-dropzone');
    const input = widget.querySelector('input[type="file"]');
    if (!dropzone || !input) return;

    // Auto-upload only for widgets marked with data-auto-upload="true"
    const autoUpload = dropzone.dataset.autoUpload === 'true';

    dropzone.addEventListener('click', () => input.click());

    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
            input.files = e.dataTransfer.files;
            input.dispatchEvent(new Event('change'));
        }
    });

    input.addEventListener('change', () => {
        if (autoUpload) {
            // Auto-upload the newly selected files right away
            autoUploadSelectedFiles(widget, input.files);
        } else {
            renderUploadFileList(widget, input.files, (name) => {
                // Remove the named file from the current selection
                const dt = new DataTransfer();
                Array.from(input.files).forEach(f => { if (f.name !== name) dt.items.add(f); });
                input.files = dt.files;
                renderUploadFileList(widget, input.files);
                updateUploadWidgetButton(widget);
            });
            updateUploadWidgetButton(widget);
        }
    });
}

/**
 * Wire up an approval dropzone so files accumulate across multiple
 * drag-drops / picker selections instead of replacing the previous set.
 * @param {HTMLElement} widget  root `.upload-widget` element
 */
function bindApprovalDropzone(widget) {
    const dropzone = widget.querySelector('.upload-dropzone');
    const input = widget.querySelector('input[type="file"]');
    if (!dropzone || !input) return;

    const isEdit = input.id === 'editApprovalAttachmentInput';
    const pending = isEdit ? editApprovalPendingFiles : approvalPendingFiles;

    dropzone.addEventListener('click', () => input.click());

    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
            addPendingFiles(pending, widget, input, e.dataTransfer.files);
        }
    });

    input.addEventListener('change', () => {
        if (!input.files) return;
        addPendingFiles(pending, widget, input, input.files);
    });
}

// Track attachments uploaded via auto-upload widgets, keyed by widget dropzone id.
// Each entry is an array of Cloudinary attachment objects ready to attach on submit.
const autoUploadedAttachments = {};

/**
 * Upload the given files immediately for an auto-upload widget and render them
 * with a "remove" button so the operator can drop files before submitting.
 * @param {HTMLElement} widget  root `.upload-widget` element
 * @param {FileList} files      the files selected in the dropzone input
 */
async function autoUploadSelectedFiles(widget, files) {
    const dropzone = widget.querySelector('.upload-dropzone');
    const input = widget.querySelector('input[type="file"]');
    const statusEl = widget.querySelector('.attachment-upload-status');
    const arr = Array.from(files || []);
    if (arr.length === 0) return;

    const key = dropzone.id || 'auto';
    if (!autoUploadedAttachments[key]) autoUploadedAttachments[key] = [];

    if (!isCloudinaryConfigured()) {
        if (statusEl) { statusEl.textContent = '⚠️ Cloudinary not configured.'; statusEl.classList.add('error'); }
        return;
    }

    const v = validateUploadFiles(arr);
    if (!v.ok) {
        if (statusEl) { statusEl.textContent = v.message; statusEl.classList.add('error'); }
        if (widget) finishUploadProgress(widget, false);
        return;
    }

    const btn = widget.querySelector('.btn-upload-now');
    if (btn) btn.disabled = true;
    // ⚠️ ORDER MATTERS. resetUploadProgress() clears `.attachment-upload-status`
    // too, so calling it AFTER the "Uploading…" line below deleted that text on
    // the very next line -- the operator selected a file and saw NOTHING at all,
    // which is the "no indicator" this indicator work was asked to fix. Reset
    // first, then announce.
    if (widget) resetUploadProgress(widget);
    if (statusEl) { statusEl.textContent = 'Uploading…'; statusEl.classList.remove('success', 'error'); }

    try {
        const ticketId = autoUploadTicketId.get(widget) || 'resolve';
        for (let i = 0; i < arr.length; i++) {
            const file = arr[i];
            const att = await cloudinaryUpload(file, ticketId, (pct) => {
                // Aggregate across the batch so the bar climbs monotonically
                // instead of restarting at 0% for every file.
                if (widget) setUploadProgress(widget, aggregateUploadPercent(i, pct, arr.length));
                if (statusEl) statusEl.textContent = `Uploading ${i + 1} of ${arr.length}…`;
            });
            autoUploadedAttachments[key].push(att);
        }
        if (widget) finishUploadProgress(widget, true);
        if (statusEl) {
            statusEl.textContent = `${autoUploadedAttachments[key].length} file(s) ready.`;
            statusEl.classList.add('success');
        }
        // Clear the input so the same file can be re-selected later
        if (input) input.value = '';
        renderAutoUploadFileList(widget);
    } catch (error) {
        console.error('Auto-upload error:', error);
        if (statusEl) { statusEl.textContent = 'Upload failed: ' + error.message; statusEl.classList.add('error'); }
        if (widget) finishUploadProgress(widget, false);
    } finally {
        if (btn) btn.disabled = false;
    }
}

// Map widget -> ticket id used for the Cloudinary folder path during auto-upload
const autoUploadTicketId = new WeakMap();

/**
 * Render the list of already-uploaded attachments for an auto-upload widget,
 * each with a remove (×) button so the operator can deselect a file before
 * submitting the resolution.
 * @param {HTMLElement} widget  root `.upload-widget` element
 */
            // ⚠️ NO loading="lazy" HERE, ON PURPOSE.
            // Every one of these tiles is rendered into a modal that is display:none at
            // render time, and Chrome defers a lazy image whose ancestor has no layout --
            // then frequently never loads it at all. No error fires either, so the
            // onerror fallback below cannot rescue it, and the result is a permanently
            // BLANK tile that still opens the file correctly when clicked. That is exactly
            // the "blank image icon, but the video plays on Cloudinary" report.
            // These grids hold a handful of tiles, so lazy loading saved nothing anyway.
            // decoding="async" keeps the decode off the main thread with none of that risk.
            // (The REPORTS DATABASE tree in script.js DOES keep loading="lazy": it is a long
            // scrollable list in a permanently visible panel, which is the case lazy is for.)
function renderAutoUploadFileList(widget) {
    const dropzone = widget.querySelector('.upload-dropzone');
    const listEl = widget.querySelector('.upload-file-list');
    if (!listEl || !dropzone) return;
    const key = dropzone.id || 'auto';
    const atts = autoUploadedAttachments[key] || [];
    if (atts.length === 0) { listEl.innerHTML = ''; return; }
    listEl.innerHTML = atts.map((att, i) => {
        const url = att.secure_url || '';
        const name = att.name || 'Attachment ' + (i + 1);
        const sizeText = att.bytes ? formatFileSize(att.bytes) : '';
        const isImage = att.resource_type === 'image';
        const isVideo = att.resource_type === 'video';
        const icon = getAttachmentIcon(att.resource_type, att.format);
        const color = getAttachmentColor(att.format);

        let preview;
        if (isImage) {
            preview = `<img class="upload-file-thumb" src="${url}" alt="${escapeHTML(name)}" decoding="async"
                onerror="this.onerror=null;this.style.display='none';this.nextElementSibling.style.display='flex';">`;
            preview += `<span class="upload-file-icon" style="display:none;"><i class="fas ${icon}" style="color:${color}"></i></span>`;
        } else if (isVideo) {
            preview = `<video class="upload-file-thumb" src="${url}" muted preload="metadata"></video>`;
            preview += `<span class="upload-file-play"><i class="fas fa-play"></i></span>`;
        } else {
            preview = `<span class="upload-file-icon"><i class="fas ${icon}" style="color:${color}"></i></span>`;
        }

        return `
            <div class="upload-file-item" data-index="${i}">
                <a class="upload-file-preview" href="${url}" target="_blank" rel="noopener noreferrer" title="${escapeHTML(name)}">
                    ${preview}
                </a>
                <div class="upload-file-info">
                    <span class="upload-file-name" title="${escapeHTML(name)}">${escapeHTML(name)}</span>
                    ${sizeText ? `<span class="upload-file-size">${sizeText}</span>` : ''}
                </div>
                <button type="button" class="upload-file-remove" data-index="${i}" title="Remove file">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;
    }).join('');

    listEl.querySelectorAll('.upload-file-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const idx = parseInt(btn.dataset.index, 10);
            autoUploadedAttachments[key] = (autoUploadedAttachments[key] || []).filter((_, i) => i !== idx);
            renderAutoUploadFileList(widget);
        });
    });
}

/**
 * Clear the auto-uploaded attachments list for a widget (used when the modal
 * is closed or a resolution is submitted).
 * @param {HTMLElement} widget  root `.upload-widget` element
 */
function resetAutoUpload(widget) {
    const dropzone = widget.querySelector('.upload-dropzone');
    const listEl = widget.querySelector('.upload-file-list');
    if (dropzone) {
        const key = dropzone.id || 'auto';
        autoUploadedAttachments[key] = [];
    }
    if (listEl) listEl.innerHTML = '';
}

function updateUploadWidgetButton(widget) {
    const input = widget.querySelector('input[type="file"]');
    const btn = widget.querySelector('.btn-upload-now');
    if (btn && input) btn.disabled = !(input.files && input.files.length > 0);
}

/**
 * Initialize all `.upload-widget` elements on the page with dropzone behavior.
 * Call once on DOMContentLoaded.
 */
function initAllUploadWidgets() {
    document.querySelectorAll('.upload-widget').forEach(widget => {
        // The Violations form widget manages its own files (uploads happen on
        // submit to the dedicated Violations Cloudinary account) — skip it
        // here to avoid double-binding its dropzone events.
        if (widget.querySelector('#violationAttachmentInput')) return;
        // Approval dropzones accumulate files across multiple picks instead of
        // replacing the previous selection — wire them separately.
        if (widget.querySelector('#approvalAttachmentInput') || widget.querySelector('#editApprovalAttachmentInput')) {
            bindApprovalDropzone(widget);
            updateUploadWidgetButton(widget);
            return;
        }
        bindUploadDropzone(widget);
        updateUploadWidgetButton(widget);
    });
}

async function removeTicketAttachment(publicId) {
    if (!currentTicketId || !publicId) return;
    const confirmed = await showConfirmDialog({
        title: 'Remove Attachment',
        message: 'Remove this attachment from the ticket?',
        confirmText: 'Remove',
        danger: true,
        icon: 'fa-trash-alt'
    });
    if (!confirmed) return;

    try {
        const ticketDoc = await db.collection('tickets').doc(currentTicketId).get();
        if (!ticketDoc.exists) return;
        const data = ticketDoc.data();
        const existing = Array.isArray(data.attachments) ? data.attachments : [];
        const oldResolution = data.resolution || {};
        const oldResAtts = Array.isArray(oldResolution.attachments) ? oldResolution.attachments : [];
        const remaining = existing.filter(a => a.public_id !== publicId);
        const remainingRes = oldResAtts.filter(a => a.public_id !== publicId);
        await db.collection('tickets').doc(currentTicketId).update({
            attachments: remaining,
            resolutionAttachmentUrl: attachmentUrl(remaining[0]),
            resolution: {
                ...oldResolution,
                attachments: remainingRes
            }
        });

        const idx = allTickets.findIndex(t => t.id === currentTicketId);
        if (idx !== -1) {
            allTickets[idx].attachments = remaining;
            if (allTickets[idx].resolution) {
                allTickets[idx].resolution.attachments = remainingRes;
            }
            renderTicketAttachments(allTickets[idx]);
        }
        setAttachmentStatus('Attachment removed.', false);
        setTimeout(() => setAttachmentStatus(''), 3000);
    } catch (error) {
        console.error('Remove attachment error:', error);
        setAttachmentStatus('Failed to remove attachment.', true);
    }
}

window.openTicketModal = function(id) {
    const ticket = allTickets.find(t => t.id === id);
    if (!ticket) return;

    currentTicketId = id;
    captureMainState({ tab: getActiveMainTab() || 'tickets', modal: 'ticket', id });
    modalTicketTitle.textContent = `Ticket: ${ticket.ticketNumber || ticket.id}`;

    // ===== Rejection reason (For Revision tickets) — operators can see why the
    //       superadmin sent the resolution back before clicking "Revise & Resubmit" =====
    const rejectionObj = ticket.rejection || {};
    const rejectionReason = rejectionObj.reason || ticket.rejectionReason || '';
    const rejectedBy = rejectionObj.rejectedBy || ticket.rejectedBy || '';
    const rejectedAt = rejectionObj.rejectedAt?.toDate ? formatDateTime(rejectionObj.rejectedAt.toDate()) : (rejectionObj.rejectedAt || '');
    const isForRevision = (ticket.status || '') === 'For Revision' || (ticket.approvalStatus || '') === 'rejected';
    const rejectionHTML = (isForRevision && rejectionReason) ? `
        <div class="rejection-reason-box" style="grid-column:span 2;margin-bottom:6px;">
            <i class="fas fa-exclamation-circle"></i>
            <div>
                <strong>Rejection Reason</strong>
                <p>${escapeHTML(rejectionReason)}</p>
                ${(rejectedBy || rejectedAt) ? `<p style="font-size:0.75rem;color:var(--text-muted);margin-top:6px;">${rejectedBy ? 'Rejected by ' + escapeHTML(rejectedBy) : ''}${rejectedAt ? (rejectedBy ? ' on ' : '') + escapeHTML(rejectedAt) : ''}</p>` : ''}
            </div>
        </div>
    ` : '';

    // ===== Resolution details (approved / submitted resolutions) =====
    const resolution = ticket.resolution || {};
    const resNotes = resolution.notes || ticket.resolutionNotes || '';
    const resBy = resolution.resolvedBy || '';
    const resAt = resolution.resolvedAt?.toDate ? formatDateTime(resolution.resolvedAt.toDate()) : (resolution.resolvedAt || '');
    const hasResolution = !!(resNotes || resBy || resAt);
    // ===== Additional Footage Requests (from "Request Additional" on the track page) =====
    const footageNotes = (ticket.comments || []).filter(function(c) { return c && c.type === 'footage_request'; });
    const footageHTML = footageNotes.length ? `
        <div class="modal-field full-width"><label>Additional Footage Requests</label>
            ${footageNotes.map(function(n) {
                const reqAt = (n.requestedAt && typeof n.requestedAt.toDate === 'function') ? formatDate(n.requestedAt.toDate()) : '';
                return `<div class="rejection-reason-box" style="margin-top:6px;">
                    <i class="fas fa-video"></i>
                    <div>
                        <p>${escapeHTML(n.text || '')}</p>
                        ${(n.requestedBy || reqAt) ? `<p style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;">Requested by ${escapeHTML(n.requestedBy || 'Unknown')}${reqAt ? ' on ' + escapeHTML(reqAt) : ''}</p>` : ''}
                    </div>
                </div>`;
            }).join('')}
        </div>
    ` : '';

    // Same split the Ticket Reviews modal uses, so the requester's files and
    // the operator's resolution files land in their own sections.
    const split = splitApprovalAttachments(ticket);
    const showOperatorCard = hasResolution || split.operator.length > 0 || !!rejectionHTML || !!footageHTML;

    ticketModalBody.innerHTML = `
        <!-- ===== SECTION 1: REQUESTER'S INFORMATION (collapsible, on top) =====
             Open by default only while there is no resolution yet, so a pending
             ticket is readable without a click. -->
        <details class="review-collapse"${hasResolution ? '' : ' open'}>
            <summary>
                <span class="review-collapse-title"><i class="fas fa-user-tie"></i> Requester's Information</span>
                <span class="review-collapse-sub"><i class="fas fa-user-circle"></i> Submitted by ${escapeHTML(ticket.name || '—')}</span>
                <i class="fas fa-chevron-down review-collapse-caret"></i>
            </summary>
            <div class="review-collapse-body">
                <div class="review-meta-grid">
                    <div class="review-meta"><label>Ticket Number</label><span>${escapeHTML(ticket.ticketNumber || ticket.id)}</span></div>
                    <div class="review-meta"><label>Branch</label><span>${escapeHTML(ticket.branch || '-')}</span></div>
                    <div class="review-meta"><label>Reporter Name</label><span>${escapeHTML(ticket.name || '-')}</span></div>
                    <div class="review-meta"><label>Position</label><span>${escapeHTML(ticket.position || '-')}</span></div>
                    <div class="review-meta"><label>Contact Number</label><span>${escapeHTML(ticket.contact || '-')}</span></div>
                    <div class="review-meta"><label>Email</label><span>${escapeHTML(ticket.email || '-')}</span></div>
                    <div class="review-meta"><label>Incident Type</label><span>${escapeHTML(ticket.incident || '-')}</span></div>
                    <div class="review-meta"><label>Incident Date</label><span>${escapeHTML(ticket.datetime || '-')}</span></div>
                    <div class="review-meta"><label>Location</label><span>${escapeHTML(ticket.location || '-')}</span></div>
                    <div class="review-meta"><label>Priority</label><span>${escapeHTML(ticket.priority || 'Low')}</span></div>
                    <div class="review-meta full"><label>Full Description</label><p class="review-note">${escapeHTML(ticket.description || 'No description.')}</p></div>
                </div>
                <div class="review-attachments-label"><i class="fas fa-paperclip"></i> Requester's Attachments <span id="ticketRequesterAttCount">(0)</span></div>
                <div class="attachments-grid" id="ticketRequesterAttachments"></div>
            </div>
        </details>

        ${showOperatorCard ? `
        <!-- ===== SECTION 2: OPERATOR'S RESOLUTION ===== -->
        <div class="review-card operator">
            <div class="review-card-header">
                <h3><i class="fas fa-video"></i> Operator's Resolution</h3>
                ${resBy ? `<span class="review-card-sub"><i class="fas fa-user-cog"></i> Resolved by ${escapeHTML(resBy)}</span>` : ''}
            </div>
            ${rejectionHTML}
            <div class="review-meta-grid">
                <div class="review-meta"><label>Resolved By</label><span>${escapeHTML(resBy || '—')}</span></div>
                <div class="review-meta"><label>Resolved At</label><span>${escapeHTML(resAt || '—')}</span></div>
                <div class="review-meta full"><label>Resolution Notes</label><p class="review-note">${escapeHTML(resNotes || '—')}</p></div>
            </div>
            ${footageHTML}
            <div class="review-attachments-label"><i class="fas fa-film"></i> Operator's Resolution Attachments <span id="ticketOperatorAttCount">(0)</span></div>
            <div class="attachments-grid" id="ticketAttachmentsGrid"></div>
        </div>` : ''}
    `;

    renderTicketAttachments(ticket);
    ticketModal.classList.add('active');
};

if (closeTicketModal) closeTicketModal.addEventListener('click', () => { ticketModal.classList.remove('active'); try { clearMainModalCtx(); } catch (e) { /* ignore */ } });

window.openEditTicket = function(id) {
    const ticket = allTickets.find(t => t.id === id);
    if (!ticket) return;

    // ===== Populate the branch dropdown (used by the Tickets tab AND the
    //       "Edit Ticket Info" button inside the approval details modal) =====
    const editBranchSel = document.getElementById('editBranch');
    if (editBranchSel) {
        editBranchSel.innerHTML = branches.map(b =>
            `<option value="${escapeHTML(b.branchName)}">${escapeHTML(b.branchName)}</option>`
        ).join('');
    }

    document.getElementById('editTicketId').value = id;
    if (editBranchSel) editBranchSel.value = ticket.branch || '';
    document.getElementById('editPriority').value = ticket.priority || 'Low';
    document.getElementById('editName').value = ticket.name || '';
    document.getElementById('editPosition').value = ticket.position || '';
    document.getElementById('editContact').value = ticket.contact || '';
    document.getElementById('editEmail').value = ticket.email || '';
    document.getElementById('editDatetime').value = ticket.datetime || '';
    document.getElementById('editLocation').value = ticket.location || '';
    document.getElementById('editIncident').value = ticket.incident || '';
    document.getElementById('editDescription').value = ticket.description || '';
    document.getElementById('editStatus').value = ticket.status || 'Pending';

    editModalTitle.textContent = `Edit Ticket: ${ticket.ticketNumber || ticket.id}`;
    editTicketModal.classList.add('active');
};

if (closeEditModal) closeEditModal.addEventListener('click', () => editTicketModal.classList.remove('active'));

window.closeTicketModals = function() {
    if (ticketModal) ticketModal.classList.remove('active');
    if (editTicketModal) editTicketModal.classList.remove('active');
    try { clearMainModalCtx(); } catch (e) { /* ignore */ }
};

window.saveEditTicket = async function() {
    const id = document.getElementById('editTicketId').value;
    const updatedData = {
        branch: document.getElementById('editBranch').value,
        priority: document.getElementById('editPriority').value,
        name: document.getElementById('editName').value,
        position: document.getElementById('editPosition').value,
        contact: document.getElementById('editContact').value,
        email: document.getElementById('editEmail').value,
        datetime: document.getElementById('editDatetime').value,
        location: document.getElementById('editLocation').value,
        incident: document.getElementById('editIncident').value,
        description: document.getElementById('editDescription').value,
        status: document.getElementById('editStatus').value
    };

    // ===== If an edit sets a ticket to Resolved, route it through the approval queue =====
    if (updatedData.status === 'Resolved') {
        // Preserve existing attachments instead of wiping them out
        const existingTicket = allTickets.find(t => t.id === id) || {};
        const existingAtt = Array.isArray(existingTicket.attachments) ? existingTicket.attachments : [];
        const oldResolution = existingTicket.resolution || {};
        const existingResAtt = Array.isArray(oldResolution.attachments) ? oldResolution.attachments : [];

        updatedData.approvalStatus = 'pending_approval';
        updatedData.resolutionNotes = updatedData.resolutionNotes || 'Edited to Resolved.';
        updatedData.resolutionAttachmentUrl = attachmentUrl(existingAtt[0]);
        updatedData.attachments = existingAtt;
        // Clear any previous rejection data when resubmitting
        updatedData.rejectionReason = firebase.firestore.FieldValue.delete();
        updatedData.rejection = firebase.firestore.FieldValue.delete();
        updatedData.resolution = {
            // ⚠️ SPREAD THE OLD RESOLUTION. This object used to be built from
            // scratch with only notes/attachments/resolvedAt/resolvedBy, so every
            // other key was DROPPED — `operatorFootage` above all. Re-submitting a
            // ticket this way therefore erased the record of which clips the
            // operator had actually captured, and splitApprovalAttachments() then
            // fell back to re-filing all of that CCTV as the manager's own uploads.
            ...oldResolution,
            notes: updatedData.resolutionNotes,
            attachments: existingResAtt.length > 0 ? existingResAtt : existingAtt,
            // Carried forward explicitly, and through the shared helper, so the
            // field survives this write with exactly the same content it had.
            operatorFootage: mergeOperatorFootage(existingTicket, []),
            resolvedAt: firebase.firestore.FieldValue.serverTimestamp(),
            resolvedBy: (auth.currentUser && auth.currentUser.email) || 'unknown'
        };
    }

    try {
        await firestoreService.updateTicket(id, updatedData);
        console.log('Ticket updated successfully');
        editTicketModal.classList.remove('active');
    } catch (error) {
        console.log('Failed to save changes');
    }
};

window.updateBulkBar = function() {
    const checked = document.querySelectorAll('.ticket-checkbox:checked');
    if (checked.length > 0) {
        bulkBar.classList.add('visible');
        bulkCount.textContent = checked.length;
    } else {
        bulkBar.classList.remove('visible');
    }
};

window.selectAllTickets = function() {
    const checkboxes = document.querySelectorAll('.ticket-checkbox');
    checkboxes.forEach(cb => cb.checked = selectAll.checked);
    updateBulkBar();
};

window.bulkAction = async function(action) {
    const checked = document.querySelectorAll('.ticket-checkbox:checked');
    if (checked.length === 0) { console.log('No tickets selected'); return; }

    let label = '', newStatus = null, isDelete = false;
    if (action === 'progress') { label = 'Mark In Progress'; newStatus = 'In Progress'; }
    else if (action === 'resolve') { label = 'Mark Resolved'; newStatus = 'Resolved'; }
    else if (action === 'delete') { label = 'Delete'; isDelete = true; }

    const confirmed = await showConfirmDialog({
        title: 'Confirm Bulk Action',
        message: `Are you sure you want to <strong>${escapeHTML(label)}</strong> ${checked.length} ticket(s)?`,
        confirmText: 'Continue',
        danger: isDelete,
        icon: isDelete ? 'fa-trash-alt' : 'fa-check-circle'
    });
    if (!confirmed) return;

    try {
        for (const cb of checked) {
            const id = cb.value;
            if (isDelete) { await firestoreService.deleteTicket(id); } 
            else if (action === 'resolve') {
                // ===== Bulk Resolve: route through superadmin approval queue =====
                const ticket = allTickets.find(t => t.id === id);
                const resolvedBy = (auth.currentUser && auth.currentUser.email) || 'unknown';
                await firestoreService.updateTicket(id, {
                    status: 'Resolved',
                    approvalStatus: 'pending_approval',
                    // Clear any previous rejection data when resubmitting
                    rejectionReason: firebase.firestore.FieldValue.delete(),
                    rejection: firebase.firestore.FieldValue.delete(),
                    resolution: {
                        notes: 'Bulk resolved.',
                        attachments: [],
                        resolvedAt: firebase.firestore.FieldValue.serverTimestamp(),
                        resolvedBy
                    },
                    resolutionNotes: 'Bulk resolved.',
                    resolutionAttachmentUrl: ''
                });
            }
            else { await firestoreService.updateTicket(id, { status: newStatus }); }
        }
        console.log(`${checked.length} ticket(s) ${isDelete ? 'deleted' : 'updated'}`);
        document.querySelectorAll('.ticket-checkbox').forEach(cb => cb.checked = false);
        if (selectAll) selectAll.checked = false;
        updateBulkBar();
    } catch (error) {
        console.log('Failed to perform bulk action');
    }
};

if (ticketSearchBtn) ticketSearchBtn.addEventListener('click', filterTickets);
if (ticketSearch) ticketSearch.addEventListener('keypress', (e) => { if (e.key === 'Enter') filterTickets(); });
if (ticketStatusFilter) ticketStatusFilter.addEventListener('change', filterTickets);
if (ticketBranchFilter) ticketBranchFilter.addEventListener('change', filterTickets);
if (ticketPriorityFilter) ticketPriorityFilter.addEventListener('change', filterTickets);

if (ticketForm) {
    ticketForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const branch = document.getElementById('branch').value;
        const priority = document.getElementById('priority').value;

        if (!branch) { console.log('Please select a branch.'); return; }

        try {
            const ticketID = await firestoreService.generateTicketNumber(branch);
            const attachmentsData = document.getElementById('submitAttachmentsData').value;
            const ticketData = {
                ticketNumber: ticketID,
                branch: branch,
                name: document.getElementById('name').value,
                position: document.getElementById('position').value,
                contact: document.getElementById('contact').value,
                email: document.getElementById('email').value,
                datetime: document.getElementById('datetime').value,
                location: document.getElementById('location').value,
                incident: document.getElementById('incident').value,
                description: document.getElementById('description').value,
                attachments: attachmentsData ? JSON.parse(attachmentsData) : [],
                priority: priority || 'Low',
                status: 'Pending',
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            };

            await firestoreService.setTicket(ticketID, ticketData);
            console.log(`Ticket submitted! No: ${ticketID}`);
            ticketForm.reset();
            document.getElementById('submitAttachmentsGrid').innerHTML = '';
            document.getElementById('submitAttachmentsGrid').style.display = 'none';
            document.getElementById('submitAttachmentsData').value = '[]';
            switchTab('tickets');
        } catch (error) {
            console.log('Failed to submit ticket.');
        }
    });
}

// ==============================================================
//  PRINTABLE MONTHLY REPORT & NAVIGATION
// ==============================================================

async function generateMonthlyIncidents(targetMonth) {
    // `targetMonth` is the first day of the month to report on. Falls back to
    // the current month when omitted.
    const baseDate = targetMonth || new Date();
    const startOfMonth = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
    const endOfMonth = new Date(baseDate.getFullYear(), baseDate.getMonth() + 1, 0, 23, 59, 59);

    const startMs = startOfMonth.getTime();
    const endMs = endOfMonth.getTime();

    const monthLogs = allLogs.filter(log => {
        const t = log.dateTime?.toDate?.()?.getTime() || new Date(log.dateTime).getTime();
        return t >= startMs && t <= endMs;
    });

    const grouped = {};
    for (const log of monthLogs) {
        const name = log.branchName;
        if (!grouped[name]) grouped[name] = [];
        grouped[name].push(log);
    }

    const branchIncidents = {};
    for (const [branchName, logs] of Object.entries(grouped)) {
        const sorted = [...logs].sort((a, b) => {
            const aT = a.dateTime?.toDate?.()?.getTime() || new Date(a.dateTime).getTime();
            const bT = b.dateTime?.toDate?.()?.getTime() || new Date(b.dateTime).getTime();
            return aT - bT;
        });

        const incidents = [];
        let incidentCount = 0;
        let offlineStart = null;
        let offlineRemarks = '';

        for (const log of sorted) {
            const d = log.dateTime?.toDate ? log.dateTime.toDate() : new Date(log.dateTime);
            if (log.status === 'Offline' && offlineStart === null) {
                offlineStart = d;
                offlineRemarks = (log.remarks || '').trim();
            } else if (log.status === 'Online' && offlineStart !== null) {
                incidentCount++;
                const durationMinutes = getDurationMinutes(offlineStart, d);
                const onlineRemarks = (log.remarks || '').trim();
                const incidentRemarks = [];
                if (offlineRemarks) incidentRemarks.push(offlineRemarks);
                if (onlineRemarks) incidentRemarks.push(onlineRemarks);
                incidents.push({
                    incidentNumber: incidentCount,
                    dateTimeOffline: offlineStart,
                    dateTimeRestored: d,
                    duration: formatDuration(durationMinutes),
                    durationMinutes: durationMinutes,
                    remarks: incidentRemarks
                });
                offlineStart = null;
                offlineRemarks = '';
            }
        }

        if (offlineStart !== null) {
            const branch = branches.find(b => b.branchName === branchName);
            const now = new Date();
            const isCurrentMonth = baseDate.getFullYear() === now.getFullYear() && baseDate.getMonth() === now.getMonth();

            if (branch && branch.currentStatus === 'Offline' && isCurrentMonth) {
                // ===== Current month + still offline right now: mark as ongoing =====
                incidentCount++;
                const durMinutes = getDurationMinutes(offlineStart, now);
                incidents.push({
                    incidentNumber: incidentCount,
                    dateTimeOffline: offlineStart,
                    dateTimeRestored: null,
                    duration: formatDuration(durMinutes) + ' (ongoing)',
                    durationMinutes: durMinutes,
                    remarks: offlineRemarks ? [offlineRemarks] : []
                });
            } else if (!isCurrentMonth) {
                // ===== Past month: a not-yet-restored outage is capped at month-end =====
                incidentCount++;
                const durMinutes = getDurationMinutes(offlineStart, endOfMonth);
                incidents.push({
                    incidentNumber: incidentCount,
                    dateTimeOffline: offlineStart,
                    dateTimeRestored: endOfMonth,
                    duration: formatDuration(durMinutes),
                    durationMinutes: durMinutes,
                    remarks: offlineRemarks ? [offlineRemarks] : []
                });
            }
        }

        if (incidents.length > 0) branchIncidents[branchName] = incidents;
    }

    return branchIncidents;
}

async function printMonthlyReport() {
    const now = new Date();
    // ===== Honor the report month selected in the History tab =====
    const reportMonth = getSelectedReportMonth();
    const monthName = reportMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const som = new Date(reportMonth.getFullYear(), reportMonth.getMonth(), 1);
    const eom = new Date(reportMonth.getFullYear(), reportMonth.getMonth() + 1, 0, 23, 59, 59);

    const periodEl = document.getElementById('printReportPeriod');
    const genDateEl = document.getElementById('printGeneratedDate');
    if (periodEl) periodEl.textContent = `${monthName} (${formatDate(som)} \u2014 ${formatDate(eom)})`;
    if (genDateEl) genDateEl.textContent = `${formatDate(now)} at ${formatTime(now)}`;

    const reportBody = document.getElementById('printReportBody');
    if (!reportBody) return;
    
    const branchIncidents = await generateMonthlyIncidents(reportMonth);

    if (Object.keys(branchIncidents).length === 0) {
        reportBody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:40px;color:#666;"><em>No incidents recorded for ${monthName}.</em></td></tr>`;
    } else {
        const branchNames = Object.keys(branchIncidents).sort();
        // Uptime measurement window: full month for past months, month-to-date
        // for the current month so a partial month is never penalized.
        const isCurrentMonth = reportMonth.getFullYear() === now.getFullYear() && reportMonth.getMonth() === now.getMonth();
        const winEnd = isCurrentMonth ? now : eom;
        const winMin = Math.max(1, Math.round((winEnd - som) / 60000));
        let html = '';
        for (const branchName of branchNames) {
            const incidents = branchIncidents[branchName];
            const totalIncidents = incidents.length;

            const offMin = incidents.reduce((sum, inc) => {
                if (typeof inc.durationMinutes === 'number') return sum + Math.max(0, inc.durationMinutes);
                return sum + Math.max(0, getDurationMinutes(inc.dateTimeOffline, inc.dateTimeRestored || winEnd));
            }, 0);
            const uptimePct = Math.round(Math.max(0, 1 - offMin / winMin) * 1000) / 10;

            const incidentNumbers = incidents.map(inc => inc.incidentNumber).join('<br>');
            const offlineTimes = incidents.map(inc => formatDate(inc.dateTimeOffline) + ', ' + formatTime(inc.dateTimeOffline)).join('<br>');
            const restoredTimes = incidents.map(inc => inc.dateTimeRestored ? formatDate(inc.dateTimeRestored) + ', ' + formatTime(inc.dateTimeRestored) : '\u2014 (ongoing)').join('<br>');
            const durations = incidents.map(inc => inc.duration).join('<br>');
            const remarksCol = incidents.map(inc => {
                if (inc.remarks && inc.remarks.length > 0) {
                    return inc.remarks.map(r => escapeHTML(r)).join(' | ');
                }
                return '';
            }).join('<br>');

            html += `
                <tr>
                    <td class="print-branch-name"><strong>${escapeHTML(branchName)}</strong></td>
                    <td class="print-total-incidents">${totalIncidents}</td>
                    <td class="print-incident-no">${incidentNumbers}</td>
                    <td class="print-offline-time">${offlineTimes}</td>
                    <td class="print-restored-time">${restoredTimes}</td>
                    <td class="print-duration">${durations}</td>
                    <td class="print-uptime">${uptimePct.toFixed(1)}%</td>
                    <td class="print-remarks">${remarksCol}</td>
                </tr>
            `;
        }
        reportBody.innerHTML = html;
    }
    window.print();
}

async function switchTab(tabId) {
    // Switching tabs dismisses any pending "re-open modal on refresh" flag.
    clearMainModalCtx();

    // ===== Superadmin-only tabs guard: operators cannot access approvals/user management =====
    if ((tabId === 'users' || tabId === 'approvals') && !currentUserIsSuperAdmin()) {
        tabId = 'dashboard';
    }

    navItems.forEach(item => { item.classList.toggle('active', item.dataset.tab === tabId); });
    tabContents.forEach(tab => { tab.classList.toggle('active', tab.id === `tab${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`); });

    const titles = { dashboard: 'Dashboard', branches: 'Branch Monitor', history: 'Status History', tickets: 'Tickets', violations: 'Violations Report', users: 'User Approvals', approvals: 'Ticket Reviews', errors: 'Error Log' };
    const subtitles = { dashboard: 'Overview & Analytics', branches: 'Real-time Branch Health Status', history: 'Status Change Logs', tickets: 'Incident Ticket Management', violations: 'CCTV Violations — Reported Without a Request', users: 'Review new owner sign-ups', approvals: 'Superadmin Approval Workflow', errors: 'Automatic Crash Reports' };
    if (pageTitle) pageTitle.textContent = titles[tabId] || 'Dashboard';
    if (pageSubtitle) pageSubtitle.textContent = subtitles[tabId] || '';

    // ===== Header quick-action: "Add Status" everywhere, but the Violations
    // tab swaps it for "+ Report Violation" =====
    // ⚠️ The button ships with class="u-hidden" (main.html). Revealing it with
    // `style.display = ''` would just REMOVE the inline style and hand control
    // back to `.u-hidden { display: none }`, leaving it invisible on the one
    // tab that needs it. Every other .u-hidden element in the app is revealed
    // with a real value ('flex' / 'block' / 'inline'); .btn is inline-flex.
    const onViolations = tabId === 'violations';
    if (btnAddStatus) btnAddStatus.style.display = onViolations ? 'none' : '';
    if (btnNewViolation) btnNewViolation.style.display = onViolations ? 'inline-flex' : 'none';

    if (tabId === 'users' && typeof loadSuperadminUsers === 'function') {
        await loadSuperadminUsers();
    }

    // ===== Render violation list + filters when the Violations tab opens =====
    if (tabId === 'violations') {
        populateViolationStoreFilter();
        filterViolations();
        // NOTE: the sidebar badge is deliberately NOT cleared here. Operators
        // and superadmins share this tab, so opening it does not mean the
        // reports have been read. A report is only marked seen when it is
        // actually opened (see markViolationSeen in openViolationModal).
    }

    if (tabId === 'approvals') {
        populateApprovalBranchFilter();
                if (typeof filterApprovalTickets === 'function') {
            filterApprovalTickets();
        }
        if (typeof renderApprovalList === 'function') {
            renderApprovalList();
        }
    }

    // ===== Remember this tab so a refresh keeps the user here, not on Dashboard =====
    captureMainState({ tab: tabId });
}

window.switchTab = switchTab;

navItems.forEach(item => {
    item.addEventListener('click', async (e) => {
        e.preventDefault();
        await switchTab(item.dataset.tab);
        // Close the mobile drawer after choosing a tab.
        document.body.classList.remove('mobile-nav-open');
    });
});

// ==============================================================
//  MOBILE NAVIGATION DRAWER  (hamburger + backdrop)
// ==============================================================
(function initMobileMainNav() {
    const toggle = document.getElementById('sidebarToggle');
    const backdrop = document.getElementById('sidebarBackdrop');

    const open = () => document.body.classList.add('mobile-nav-open');
    const close = () => document.body.classList.remove('mobile-nav-open');

    if (toggle) toggle.addEventListener('click', () => document.body.classList.toggle('mobile-nav-open'));
    if (backdrop) backdrop.addEventListener('click', close);
})();

// ==============================================================
//  OPTION-2 MOBILE HEADER + COMMAND BANNER (phone only)
//  main.html carries two pasted "Option 2" blocks that ship as
//  markup ONLY (their original modals/scripts were not copied):
//    - header.jn2-mobile-only
//    - section.jn2-mobile-only (Command Center banner)
//  This wires their buttons to the features this app already has
//  so none of them is an inert tap target. Every lookup is guarded:
//  the blocks are hidden on desktop (but still in the DOM) and are
//  absent from every other page.
// ==============================================================
(function initOption2MobileHeader() {
    const byId = (id) => document.getElementById(id);
    const clickFirst = (selector) => {
        const el = document.querySelector(selector);
        if (el) el.click();
    };
    const on = (id, handler) => {
        const el = byId(id);
        if (el) el.addEventListener('click', handler);
    };

    // Hamburger → the app's off-canvas sidebar (initMobileMainNav above).
    on('openDrawer', () => clickFirst('#sidebarToggle'));

    // Moon / sun → the real theme toggle. theme.js owns data-theme; the pasted
    // icons follow it on their own via Tailwind's `dark:` variant (kept in sync
    // by the small head script in main.html), so no icon swapping is needed here.
    on('toggleDark', () => clickFirst('[data-theme-toggle]'));

    // Chat bubble → the HR chat launcher (js/chat.js opens its modal on click).
    on('openChatModal', () => clickFirst('#chatLauncher'));

    // Profile avatar → open the sidebar, where account + logout live.
    on('openProfile', () => clickFirst('#sidebarToggle'));

    // Search → Branch Monitor, whose search box is #searchInput.
    // (The pasted expandable search bar itself was deliberately not copied.)
    on('toggleSearch', () => {
        if (typeof switchTab === 'function') switchTab('branches');
        setTimeout(() => { const s = byId('searchInput'); if (s) s.focus(); }, 0);
    });

    // Banner actions: Monitor → Branch Monitor; Add Status → the REAL Add
    // Status modal, whose trigger (#btnAddStatus) lives in .top-header, which
    // is display:none on phones — a programmatic click still opens it.
    on('openBranchMonitor', () => { if (typeof switchTab === 'function') switchTab('branches'); });
    on('openStatusModal', () => clickFirst('#btnAddStatus'));

    // ===== Title mirroring =====
    // The pasted phone header shows on EVERY tab now, so its heading
    // must follow #pageTitle instead of staying hardcoded to Dashboard.
    // switchTab keeps writing to #pageTitle even while .top-header is
    // hidden, so observing it is enough; switchTab itself is untouched
    // because the test suite pins the shape of its lines.
    const jn2Title = byId('jn2HeaderTitle');
    const appPageTitle = byId('pageTitle');
    const syncJn2Title = () => {
        if (jn2Title && appPageTitle) jn2Title.textContent = appPageTitle.textContent;
    };
    syncJn2Title();
    if (window.MutationObserver && appPageTitle) {
        new MutationObserver(syncJn2Title).observe(appPageTitle, { childList: true, characterData: true, subtree: true });
    };

    // ===== Hanging plus -> Report Violation (phone only) =====
    // The real #btnNewViolation lives in the classic header, which is
    // hidden on phones - a programmatic click still opens the form.
    // No Add Status equivalent is added: that action stays Dashboard-only,
    // on the pasted banner, by design.
    on('jn2ReportFab', () => {
        const btn = byId('btnNewViolation');
        if (btn) { btn.click(); return; }
        if (typeof openViolationFormModal === 'function') openViolationFormModal(null);
    });

    // Gate the hanging button on Violations access instead of a role list:
    // applyRole hides #violationsNavItem for roles that must never file a
    // report (it ships visible for everyone else), so mirror that state.
    const fab = byId('jn2ReportFab');
    const violationsNav = byId('violationsNavItem');
    const syncFabVisibility = () => {
        if (!fab) return;
        const allowed = !violationsNav || getComputedStyle(violationsNav).display !== 'none';
        // Empty string hands control back to the stylesheet (phone-only
        // media query); 'none' wins outright for a role without access.
        fab.style.display = allowed ? '' : 'none';
    };
    syncFabVisibility();
    if (window.MutationObserver && violationsNav) {
        new MutationObserver(syncFabVisibility).observe(violationsNav, { attributes: true, attributeFilter: ['style'] });
    };
})();

if (userStatusFilter) {
    userStatusFilter.addEventListener('change', loadSuperadminUsers);
}

if (searchInput) searchInput.addEventListener('input', debounce(renderBranchesTable));
if (historySearch) historySearch.addEventListener('input', debounce(renderHistory));

filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderBranchesTable();
    });
});

historyFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        historyFilterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderHistory();
    });
});

if (sortSelect) sortSelect.addEventListener('change', renderBranchesTable);
if (groupFilter) groupFilter.addEventListener('change', renderBranchesTable);
if (downtimeFilter) downtimeFilter.addEventListener('change', renderBranchesTable);

// Dashboard redo: branch + range filters re-render the dashboard panels.
if (dashBranchFilter) dashBranchFilter.addEventListener('change', () => {
    dashBranch = dashBranchFilter.value || 'all';
    renderDashboard();
});
if (dashRangeGroup) dashRangeGroup.querySelectorAll('[data-dash-range]').forEach(btn => {
    btn.addEventListener('click', () => {
        dashRange = btn.dataset.dashRange || 'month';
        renderDashboard();
    });
});

if (historyBranchFilter) historyBranchFilter.addEventListener('change', renderHistory);
if (historyDateFrom) historyDateFrom.addEventListener('input', renderHistory);
if (historyDateTo) historyDateTo.addEventListener('input', renderHistory);
if (btnPrintReport) btnPrintReport.addEventListener('click', printMonthlyReport);

// ==============================================================
//  BRANCH LIST MANAGEMENT MODAL
// ==============================================================

function renderBranchList() {
    if (!branchListBody) return;
    if (branches.length === 0) {
        branchListBody.innerHTML = '<tr><td colspan="3" class="empty-state"><i class="fas fa-database"></i><p>No branches.</p></td></tr>';
        return;
    }
    const isAdmin = currentUserIsSuperAdmin();
    branchListBody.innerHTML = branches.map(b => {
        const sc = b.currentStatus === 'Online' ? 'online' : 'offline';
        return `<tr>
            <td><strong>${escapeHTML(b.branchName)}</strong></td>
            <td><span class="status-badge ${sc}">${escapeHTML(b.currentStatus)}</span></td>
            <td>
                ${isAdmin ? `<button class="action-btn delete-action btn-remove-branch" data-branch="${escapeHTML(b.branchName)}" data-tooltip="Remove"><i class="fas fa-trash"></i></button>` : '\u2014'}
            </td>
        </tr>`;
    }).join('');
    
    // Use event delegation instead of inline onclick to avoid escapeHTML issues in JS strings
    branchListBody.querySelectorAll('.btn-remove-branch').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const name = btn.dataset.branch;
            if (name) window.confirmRemoveBranch(name);
        });
    });
}

if (btnManageBranches) {
    btnManageBranches.addEventListener('click', () => {
        renderBranchList();
        if (branchListModal) branchListModal.classList.add('active');
    });
}

if (closeBranchListModal) {
    closeBranchListModal.addEventListener('click', () => {
        if (branchListModal) branchListModal.classList.remove('active');
    });
}

if (closeBranchListBtn) {
    closeBranchListBtn.addEventListener('click', () => {
        if (branchListModal) branchListModal.classList.remove('active');
    });
}

if (branchListModal) {
    branchListModal.addEventListener('click', (e) => {
        if (e.target === branchListModal) branchListModal.classList.remove('active');
    });
}

if (btnAddNewBranch) {
    btnAddNewBranch.addEventListener('click', async () => {
        const name = newBranchNameInput.value.trim();
        if (!name) {
            console.log('Please enter a branch name.');
            return;
        }
        const existing = branches.find(b => b.branchName.toLowerCase() === name.toLowerCase());
        if (existing) {
            console.log(`Branch "${name}" already exists.`);
            return;
        }
        try {
            await firestoreService.setBranch(name, {
                branchName: name,
                currentStatus: 'Online',
                lastUpdated: firebase.firestore.Timestamp.fromDate(new Date()),
                currentDowntimeStart: null,
                remarks: ''
            });
            branches.push({
                branchName: name,
                currentStatus: 'Online',
                lastUpdated: firebase.firestore.Timestamp.fromDate(new Date()),
                currentDowntimeStart: null,
                remarks: ''
            });
            branches.sort((a, b) => (a.branchName || '').localeCompare(b.branchName || ''));
            newBranchNameInput.value = '';
            renderBranchList();
            reRenderAll();
        } catch (error) {
            console.error('Add branch error:', error);
            console.log('Failed to add branch.');
        }
    });
}

// ==============================================================
//  VIOLATIONS REPORT (CCTV Monitoring — Operator + Superadmin)
//  Reports filed WITHOUT a ticket/request. Never shown on the
//  Owner Dashboard (separate collection + role guards here and
//  in firestore.rules). Attachments go to the SEPARATE Violations
//  Cloudinary account so the ticket storage quota is preserved.
// ==============================================================

let currentViolationId = null;
let violationPendingFiles = [];     // New files chosen in the form dropzone
let violationEditAttachments = [];  // Existing attachments kept while editing
let violationListenerStarted = false;
let previousViolations = [];

function isViolationCloudinaryConfigured() {
    return VIOLATION_CLOUDINARY_CLOUD_NAME && VIOLATION_CLOUDINARY_CLOUD_NAME !== 'YOUR_VIOLATION_CLOUD_NAME'
        && VIOLATION_CLOUDINARY_UPLOAD_PRESET && VIOLATION_CLOUDINARY_UPLOAD_PRESET !== 'YOUR_VIOLATION_UPLOAD_PRESET';
}

/**
 * Normalize a file URL so it always opens (folder browser + attachments modal).
 *
 * Cloudinary's `secure_url` ALREADY percent-encodes reserved characters, so a
 * folder/file name with spaces comes back as ".../Data%20base/binalot.jpg".
 * Passing such a URL through `encodeURI()` again double-encodes it
 * ("%20" -> "%2520") and the link then 404s ("This site can't be reached").
 *
 * Here any previously applied encoding round is undone first (so both raw
 * spaces and already-encoded URLs are handled, including "%2520" leftovers),
 * then the value is encoded exactly once. Cloudinary transformation commas and
 * "/" separators are left untouched by encodeURI.
 *
 * @param {string} rawUrl stored `secure_url`
 * @returns {string} a clickable URL ('' when no URL is available)
 */
// The attachment helpers now live in js/attachment-viewer.js, which BOTH
// main.html and ownerdashboard.html load. The Owner Dashboard used to keep its
// own copies (a third getAttachmentColor, a second formatFileSize, and a
// thumbnail-less icon row), so the same file rendered differently per page.
// These are thin delegates: every existing call site keeps working by name,
// but there is now exactly ONE implementation.
function attachmentHelpers() {
    const v = window.AttachmentViewer;
    if (!v || !v.helpers) {
        throw new Error('js/attachment-viewer.js must load before script.js — check the script tag order in main.html');
    }
    return v.helpers;
}

function normalizeFileUrl(rawUrl) { return attachmentHelpers().normalizeFileUrl(rawUrl); }

/**
 * Sanitize a single folder / public-id path segment for Cloudinary.
 *
 * Cloudinary public_id rules: only letters, digits, spaces, `-`, `_`, `.`
 * (plus `/` as folder separators) are allowed. `&`, `#`, `%`, `?`, etc.
 * make the whole public_id INVALID, so:
 *   - "&" is mapped to "-" (e.g. "Lala & September 15 2026" -> "Lala - September 15 2026")
 *   - every other disallowed character becomes a space
 *   - whitespace is collapsed and trimmed
 */
function violationSanitizeSegment(value) {
    return String(value || 'Unnamed')
        .replace(/&/g, '-')
        .replace(/[^A-Za-z0-9 _.\-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || 'Unnamed';
}

/**
 * Build the "Data base" folder path for a violation report's evidence:
 *   Data base/Branches/<Store>/<Month Year>/<Reporter>/<Subject> - <Date>/attachments
 *
 * Example:
 *   Data base/Branches/FAME/September 2026/Nicolai Li/Not Using Strainer - September 12 2026/attachments
 *
 * The Month Year and Date parts come from the INCIDENT date/time.
 * NOTE: Cloudinary rejects "&" in public_id/folder names, so the Subject
 * and Date are joined with " - " instead.
 * @param {object} p {store, reporterName, subject, incident: Date}
 */
function violationReportFolderPath(p) {
    const incident = (p.incident instanceof Date && !isNaN(p.incident.getTime())) ? p.incident : new Date();
    const monthYear = incident.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const datePart = `${incident.toLocaleDateString('en-US', { month: 'long' })} ${incident.getDate()} ${incident.getFullYear()}`;

    return [
        'Data base',
        'Branches',
        violationSanitizeSegment(p.store),
        monthYear,
        violationSanitizeSegment(p.reporterName),
        violationSanitizeSegment(`${p.subject} - ${datePart}`),
        'attachments'
    ].join('/');
}

/**
 * Upload one evidence file to the dedicated Violations Cloudinary account
 * (2nd account only — the 1st account used by tickets is never touched).
 *
 * The file is placed inside the "Data base" folder structure with its
 * ORIGINAL filename preserved:
 *   Data base/Branches/FAME/September 2026/Nicolai Li/Not Using Strainer - September 12 2026/attachments/binalot.jpg
 *
 * ⚠️ UNSIGNED UPLOAD PRESET RESTRICTIONS — Cloudinary only allows these params
 *    with an unsigned preset:
 *      upload_preset, callback, public_id, folder, asset_folder, tags, context
 *    So we send BOTH folder parameters to cover both account modes:
 *      - `asset_folder` : dynamic folder mode — controls where the asset
 *                         appears in the Media Library
 *      - `folder`       : fixed (legacy) folder mode — prepended to public_id
 *    And `public_id` is sent as the bare filename (no slashes).
 *
 *    ⚠️ `overwrite`/`invalidate` are SIGNED-only params — sending them here
 *       makes the whole request fail with "Overwrite parameter is not
 *       allowed...". We do not need them anyway: `overwrite` defaults to
 *       TRUE, so uploading the same public_id (e.g. the regenerated
 *       "<Subject> report" PDF) replaces the asset with a new version, and
 *       the response's versioned `secure_url` always points at that fresh
 *       version. So the behaviour every other call site (evidence uploads)
 *       relies on is untouched.
 *
 * ⚠️ In the unsigned preset (jnviolation), "Unique filename" must be OFF
 *    so Cloudinary keeps the original filename instead of a random one,
 *    and any default "Asset folder" set in the preset should be cleared.
 *
 * @param {File} file          the file to upload
 * @param {string} folderPath  full "Data base/.../attachments" path
 * @param {Function} onProgress percent callback (0-100)
 */
async function violationCloudinaryUpload(file, folderPath, onProgress) {
    if (!isViolationCloudinaryConfigured()) {
        throw new Error('Violations Cloudinary storage is not configured.');
    }

    // Keep the original filename as a readable base, but add a short random
    // suffix so same-named files with different extensions (e.g. "0109.mp4" +
    // "0109.png") each get their own Cloudinary asset instead of overwriting
    // each other. Cloudinary appends the detected format automatically.
    const uniquePublicId = makeUniquePublicId(file.name);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', VIOLATION_CLOUDINARY_UPLOAD_PRESET);
    formData.append('asset_folder', folderPath);
    formData.append('folder', folderPath);
    formData.append('public_id', uniquePublicId);

    // ⚠️ XHR, NOT fetch: fetch cannot report UPLOAD progress, so a large video
    // (tens of MB) showed a bar that never moved for the whole upload and
    // looked frozen. XHR's upload.onprogress feeds the real byte count to the
    // caller's onProgress (0-100).
    const data = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://api.cloudinary.com/v1_1/' + VIOLATION_CLOUDINARY_CLOUD_NAME + '/auto/upload');
        if (xhr.upload && typeof onProgress === 'function') {
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable && e.total > 0) {
                    try { onProgress(Math.round((e.loaded / e.total) * 100)); } catch (err) { /* UI only */ }
                }
            };
        }
        xhr.onload = () => {
            let body = null;
            try { body = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
            if (xhr.status >= 200 && xhr.status < 300 && body) {
                resolve(body);
                return;
            }
            const msg = (body && body.error && body.error.message)
                || ('Upload failed (HTTP ' + xhr.status + ').');
            reject(new Error(msg));
        };
        xhr.onerror = () => reject(new Error('Upload failed — check your internet connection and try again.'));
        xhr.onabort = () => reject(new Error('Upload was cancelled.'));
        xhr.send(formData);
    });
    return {
        public_id: data.public_id,
        secure_url: data.secure_url,
        format: data.format,
        resource_type: data.resource_type,
        width: data.width || null,
        height: data.height || null,
        bytes: file.size,
        name: file.name,
        uploadedAt: new Date().toISOString()
    };
}

/** Real-time listener for the violations collection (operator + superadmin). */
function setupViolationListener() {
    if (violationListenerStarted) return Promise.resolve();
    violationListenerStarted = true;
    let firstSnapshotResolved = false;

    // Load the persisted "seen" report ids BEFORE the first snapshot arrives,
    // otherwise the very first render would treat every existing report as
    // unseen and flash a bogus badge.
    // ⚠️ ONLY when auth is already resolved. Before that auth.currentUser is
    // null, so violationsSeenKey() would read the `_anon` key and WIPE this
    // user's real seen list (saved under `_<email>`) — the exact "badge jumps
    // back after refresh" bug. When auth is not yet ready we skip here; the
    // onAuthStateChanged handler loads it with the correct email key a moment
    // later and re-renders the badge.
    if (auth && auth.currentUser) loadViolationsSeen();

    return new Promise((resolve) => {
        const snapshotHandler = async (violations) => {
            // Detect violations newly transferred to HR by superadmin
            if (previousViolations.length > 0 && Array.isArray(violations)) {
                const prevMap = new Map(previousViolations.map(v => [v.id, v]));
                for (const v of violations) {
                    const prev = prevMap.get(v.id);
                    if (prev && v.hrStatus === 'transferred' && prev.hrStatus !== 'transferred') {
                        // Newly transferred to HR — notify if on HR/superadmin side
                        if (typeof window.notifyViolationTransferred === 'function') {
                            window.notifyViolationTransferred(v);
                        }
                    }
                }
            }
            previousViolations = Array.isArray(violations) ? violations.map(v => ({...v})) : [];
            allViolations = violations;
            // The violations TABLE renders immediately — this is the thing the
            // operator waits for after a refresh.
            filterViolations();
            updateViolationsBadge();
            renderViolationDetailsIfOpen();
            // Only draw the dashboard once branches + tickets have loaded: the
            // listener is registered first, so its snapshot can land before them,
            // and rendering now would flash zeroed KPIs / an empty attention queue.
            // initApp() re-renders it after every source is in; on any later
            // real-time violation change this guard is already true.
            if (dashboardDataReady) renderDashboard();
            // The REPORTS DATABASE panel is independent of the table filters, so it is
            // refreshed straight from the live data (always showing every report).
            renderViolationFolderTree();
            // Auto-revert is handled by startAutoRevertTimer() — a standalone
            // interval timer, not here.
            if (!firstSnapshotResolved) {
                firstSnapshotResolved = true;
                resolve(allViolations);
            }
        };

        firestoreService.listenViolations(snapshotHandler, (error) => {
            console.error('Violations listener error:', error);
        });
    });
}

// ==============================================================
//  AUTO-REVERT expired Area Manager transfers
//
//  Runs on a standalone interval timer — NOT inside the snapshot handler.
//  The snapshot handler only renders UI; this timer checks for expirations
//  independently so it fires even when no document changes for a full minute.
//  Superadmin-only: only superadmin can delete managerStatus from violations.
// ==============================================================
let autoRevertTimer = null;

function autoRevertExpiredTransfers() {
    if (!currentUserIsSuperAdmin()) return;
    if (!auth || !auth.currentUser) return;
    if (!allViolations || !Array.isArray(allViolations)) return;

    const now = Date.now();
    for (const v of allViolations) {
        if (v.managerStatus !== 'transferred') continue;
        // Expiry time when the Area Manager opened the report.
        // Prefer managerExpiresAtMs (client-computed: open + 24 hours).
        // Fall back to managerOpenedAt + 24 * 60 * 60 * 1000 if ms stamp missing.
        let expiresAt = v.managerExpiresAtMs || 0;
        if (expiresAt === 0 && v.managerOpenedAt) {
            const openedAt = v.managerOpenedAt.toDate?.()?.getTime() || 0;
            if (openedAt > 0) expiresAt = openedAt + 24 * 60 * 60 * 1000;
        }
        if (expiresAt > 0 && now >= expiresAt) {
            firestoreService.revertViolationTransferFromAreaManager(
                v.id,
                auth.currentUser.email || null,
                auth.currentUser.displayName || null
            ).then(() => {
                console.log('Auto-reverted expired manager transfer for ' + (v.violationNumber || v.id));
            }).catch((e) => {
                console.warn('Auto-revert failed:', e);
            });
        }
    }
}

function startAutoRevertTimer() {
    if (autoRevertTimer) return;
    autoRevertTimer = setInterval(autoRevertExpiredTransfers, 5000);
    // Also run once immediately so a already-expired report reverts without waiting.
    autoRevertExpiredTransfers();
}

// ==============================================================
//  VIOLATIONS SIDEBAR BADGE  (unseen reports)
//
//  The badge means "reports THIS user has not opened yet".
//
//  It must NOT clear merely because the Violations tab was opened:
//  operators and superadmins SHARE that tab, so someone could open it,
//  glance at the list and walk away while the actual report stayed
//  unread. Acknowledgement is therefore per-REPORT, recorded when
//  `openViolationModal(id)` shows the report — not per-tab.
//
//  (It previously used a rolling 24-hour window, so it never cleared
//  at all; the intermediate fix cleared it on tab-open, which was
//  wrong for a shared tab. This is the correct behaviour.)
// ==============================================================

// Set of violation document ids this user has actually opened.
let violationsSeenIds = new Set();

// How many ids we keep. Reports are few, but cap it so a long-lived
// localStorage entry can never grow without bound.
const VIOLATIONS_SEEN_MAX = 500;

function violationsSeenKey() {
    const email = window.normalizeUserEmail
        ? window.normalizeUserEmail(auth?.currentUser?.email || '')
        : '';
    return 'rcms_violations_seen_' + (email || 'anon');
}

/** Load the persisted "seen" id list for this user. */
function loadViolationsSeen() {
    let ids = [];
    try {
        const raw = localStorage.getItem(violationsSeenKey());
        if (raw) {
            const parsed = JSON.parse(raw);
            // Guard the format: an older build stored a plain timestamp
            // here, and anything unexpected must be discarded rather
            // than crashing the badge.
            if (Array.isArray(parsed)) {
                ids = parsed.filter(id => typeof id === 'string' && id);
            }
        }
    } catch (e) {
        ids = []; // private mode / corrupt value — everything counts as unseen
    }
    violationsSeenIds = new Set(ids);
}

/** Record that this user has now actually read one report. */
function markViolationSeen(id) {
    if (!id || violationsSeenIds.has(id)) {
        // Already seen — still refresh the badge in case it is stale.
        updateViolationsBadge();
        return;
    }

    violationsSeenIds.add(id);

    // Trim the oldest ids if the list somehow grew too large.
    if (violationsSeenIds.size > VIOLATIONS_SEEN_MAX) {
        const trimmed = Array.from(violationsSeenIds).slice(-VIOLATIONS_SEEN_MAX);
        violationsSeenIds = new Set(trimmed);
    }

    try {
        localStorage.setItem(violationsSeenKey(), JSON.stringify(Array.from(violationsSeenIds)));
    } catch (e) { /* ignore */ }

    updateViolationsBadge();
}

/** True when this report has not been opened by this user yet. */
function isViolationUnseen(v) {
    return !violationsSeenIds.has(String(v.id));
}

/**
 * Sidebar badge: how many violation reports THIS user has not opened yet.
 * Deliberately NOT hidden while the Violations tab is on screen — being on
 * the tab does not mean the reports have been read, because the tab is
 * shared by operators and superadmins.
 */
function updateViolationsBadge() {
    if (!violationsBadge) return;

    const unseen = allViolations.filter(isViolationUnseen).length;

    violationsBadge.textContent = unseen > 99 ? '99+' : String(unseen);
    violationsBadge.style.display = unseen > 0 ? 'inline' : 'none';
}

/** Store filter options come from the branch list + existing reports. */
function populateViolationStoreFilter() {
    if (!violationStoreFilter) return;
    const current = violationStoreFilter.value;
    const storeNames = Array.from(new Set([
        ...branches.map(b => b.branchName).filter(Boolean),
        ...allViolations.map(v => v.store).filter(Boolean)
    ])).sort((a, b) => a.localeCompare(b));

    violationStoreFilter.innerHTML = '<option value="all">All Stores</option>' +
        storeNames.map(name => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('');
    if (current && (current === 'all' || storeNames.includes(current))) {
        violationStoreFilter.value = current;
    }
}

/**
 * Store dropdown for the violation report form — a plain <select> populated
 * from the branches collection, exactly like the Add Status branch dropdown.
 * @param {string} [currentValue] — when editing an older report whose store is
 *   no longer (or never was) in the branches list, it is appended as an extra
 *   option so the edit form never loses the stored value.
 */
function populateViolationStoreSelect(currentValue) {
    if (!violationStoreInput) return;
    const names = branches
        .map(b => b.branchName).filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    violationStoreInput.innerHTML = '<option value="">&mdash; Select Store &mdash;</option>'
        + names.map(name => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('');

    // Legacy guard: keep a stored store name that is not in the branches list.
    const current = String(currentValue || '').trim();
    if (current && !names.some(name => name === current)) {
        const opt = document.createElement('option');
        opt.value = current;
        opt.textContent = current;
        violationStoreInput.appendChild(opt);
    }
}

// ===== PERIOD FILTER (list view window) =====
// Purely a view filter — nothing is ever deleted. Reports outside the selected
// period stay untouched in Firestore + Cloudinary and come back with "All reports".
// Default is "Today" so the list stays short and easy to scan.
const VIOLATION_PERIODS = {
    daily:   { label: 'Today' },
    weekly:  { label: 'Last 7 days' },
    monthly: { label: 'This month' },
    all:     { label: 'All reports' }
};

let violationHiddenByPeriod = 0;

/** Selected period key (falls back to 'daily' if the select is missing/unknown). */
function violationPeriodValue() {
    const value = (violationPeriodFilter && violationPeriodFilter.value) || 'daily';
    return VIOLATION_PERIODS[value] ? value : 'daily';
}

/** Midnight (local) at the start of the selected period; null for "all". */
function violationPeriodStart(period, now) {
    if (period === 'all') return null;
    const start = now ? new Date(now) : new Date();
    start.setHours(0, 0, 0, 0);
    if (period === 'daily') return start;                                          // today 00:00
    if (period === 'weekly') { start.setDate(start.getDate() - 6); return start; } // today + previous 6 days
    start.setDate(1);                                                              // 'monthly' → 1st of this month, 00:00
    return start;
}

/**
 * True when a report falls inside the selected period.
 * Age is measured from when the report was FILED (reportDateTime/createdAt), so a
 * CCTV review of an older incident is not filtered out the moment it is saved.
 * Reports without a usable date are always kept (safer than hiding them).
 */
function isViolationInPeriod(v, period, now) {
    const start = violationPeriodStart(period, now);
    if (!start) return true;
    const filed = violationReportDate(v);
    if (!filed) return true;
    return filed.getTime() >= start.getTime();
}

/** Notice under the toolbar: how many reports the current period view is hiding. */
function updateViolationPeriodNote(period) {
    if (!violationPeriodNote) return;
    const showNote = violationHiddenByPeriod > 0 && period !== 'all';
    violationPeriodNote.hidden = !showNote;
    if (!showNote) return;

    const info = VIOLATION_PERIODS[period] || VIOLATION_PERIODS.daily;
    if (violationPeriodNoteText) {
        const n = violationHiddenByPeriod;
        violationPeriodNoteText.textContent =
            n + ' older report' + (n === 1 ? '' : 's') + ' outside this view (' +
            info.label.toLowerCase() + ') — still stored in the database. ' +
            'Choose “All reports” to see everything.';
    }
}

function filterViolations() {
    const term = (violationSearch && violationSearch.value || '').trim().toLowerCase();
    const store = (violationStoreFilter && violationStoreFilter.value) || 'all';

    const matched = allViolations.filter(v => {
        if (store !== 'all' && (v.store || '') !== store) return false;
        if (!term) return true;
        const haystack = [
            v.violationNumber, v.subject, v.store, v.location,
            v.details, v.reportedByName, v.reportedBy
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(term);
    });

    // Period window: only reports filed inside the selected period are listed.
    // Nothing is deleted — the rest stay in Firestore and return with "All reports".
    const period = violationPeriodValue();
    const now = Date.now();
    const shown = matched.filter(v => isViolationInPeriod(v, period, now));
    violationHiddenByPeriod = matched.length - shown.length;

    // Uploads filter: only show violations that have HR-uploaded NOV files.
    const uploadsOnly = violationUploadsFilter && violationUploadsFilter.value === 'with-uploads';
    filteredViolations = uploadsOnly && window.HrUploads && typeof window.HrUploads.hasUploads === 'function'
        ? shown.filter(v => window.HrUploads.hasUploads('violations/' + v.id))
        : shown;

    updateViolationPeriodNote(period);
    // Reset to the first page whenever the filters change, then render the
    // current page of rows plus the pagination controls.
    violationPage = 1;
    renderViolationPagination();
    // NOTE: the REPORTS DATABASE panel is intentionally NOT refreshed here — it is
    // decoupled from the table filters (search / store / period) and always shows
    // every report. It refreshes from the data listener instead (see
    // setupViolationListener).
}

function violationIncidentDate(v) {
    if (!v.incidentDateTime) return null;
    if (v.incidentDateTime.toDate) return v.incidentDateTime.toDate();
    const d = new Date(v.incidentDateTime);
    return isNaN(d.getTime()) ? null : d;
}

function violationReportDate(v) {
    const raw = v.reportDateTime || v.createdAt;
    if (!raw) return null;
    if (raw.toDate) return raw.toDate();
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
}

function formatViolationDateTime(d) {
    if (!d) return '—';
    return `${formatDate(d)} · ${formatTime(d)}`;
}

/** Operators may only edit/delete their own reports; superadmins may touch any. */
function canModifyViolation(v) {
    if (currentUserIsSuperAdmin()) return true;
    const me = (auth.currentUser && auth.currentUser.email || '').toLowerCase();
    return !!me && String(v.reportedBy || '').toLowerCase() === me;
}

// ==============================================================
//  HR HANDOFF — "Transfer to HR"
//
//  Workflow: an operator files a CCTV violation -> it lands here in the
//  command center -> the superadmin reviews it and decides whether it is
//  worth an incident report. If it is, they press "Transfer to HR" and the
//  report becomes visible (read-only) on the HR dashboard, where HR writes
//  the incident report and prints the PDF. If it is NOT worth one, the
//  superadmin simply does nothing and the report stays here only.
//
//  The report is NOT moved or copied: `hrStatus` is stamped on the same
//  document, so it remains in this list (with a "Transferred to HR" pill)
//  and HR reads the very same record — including the same attachments and
//  the same generated PDF.
//
//  Only a superadmin may transfer: firestore.rules lets HR read a
//  transferred report but never write one, and an operator editing their own
//  report must not be able to push it onto HR's desk.
// ==============================================================

/** True once a superadmin has handed this report to HR. */
function isViolationTransferred(v) {
    return !!v && v.hrStatus === 'transferred';
}

/** The pill shown in the violations table and inside the details modal. */
function violationTransferBadgeHtml(v) {
    if (!isViolationTransferred(v)) return '';
    return '<span class="violation-hr-pill" title="This report was transferred to HR">'
        + '<i class="fas fa-share-nodes"></i> Transferred to HR</span>';
}

/**
 * The "HR Status" line inside the details modal. Spelling out WHO transferred
 * it and WHEN is the audit trail that makes the handoff trustworthy — a
 * superadmin can always see at a glance whether HR actually has the report.
 */
function violationTransferStatusHtml(v) {
    if (isViolationTransferred(v)) {
        // transferredAt is a server Timestamp; reuse the same tolerant
        // conversion the report dates already go through.
        const when = v.transferredAt
            ? formatViolationDateTime(violationReportDate({ reportDateTime: v.transferredAt }))
            : null;
        const who = v.transferredByName || v.transferredBy;
        return violationTransferBadgeHtml(v)
            + (who ? ` <span style="color:var(--text-muted);font-size:0.85rem;">by ${escapeHTML(who)}</span>` : '')
            + (when ? ` <span style="color:var(--text-muted);font-size:0.85rem;">on ${escapeHTML(when)}</span>` : '');
    }
    return '<span style="color:var(--text-muted);">Not transferred — this report is only visible to operators and superadmins.</span>';
}

/**
 * Show the "Transfer to HR" / "Revert Transfer" button in the right state.
 * Hidden entirely for anyone who is not a superadmin, and for operators the
 * whole modal footer stays hidden anyway (see canModifyViolation).
 */
function refreshTransferButtonState(v) {
    if (!btnTransferViolation) return;
    if (!currentUserIsSuperAdmin()) {
        btnTransferViolation.style.display = 'none';
        return;
    }

    const transferred = isViolationTransferred(v);
    btnTransferViolation.style.display = 'inline-flex';
    btnTransferViolation.classList.toggle('btn-success', !transferred);
    btnTransferViolation.classList.toggle('btn-secondary', transferred);
    if (btnTransferViolationLabel) {
        btnTransferViolationLabel.textContent = transferred ? 'Revert Transfer' : 'Transfer to HR';
    }
    if (btnTransferViolationIcon) {
        btnTransferViolationIcon.className = transferred ? 'fas fa-undo' : 'fas fa-share-nodes';
    }
    btnTransferViolation.title = transferred
        ? 'Take this report back off the HR dashboard'
        : 'Send this report to HR so they can write the incident report';
}

/** Hand the open report to HR, or take it back. */
async function toggleViolationTransfer(id) {
    const v = allViolations.find(x => x.id === id);
    if (!v) return;
    if (!currentUserIsSuperAdmin()) {
        showToast('Only a superadmin can transfer reports to HR.', 'error');
        return;
    }

    const label = v.violationNumber || v.id;
    const wasTransferred = isViolationTransferred(v);
    const question = wasTransferred
        ? `Take report ${label} back off the HR dashboard?\n\nHR will no longer see it.`
        : `Transfer report ${label} to HR?\n\nHR will be able to view the details, the CCTV evidence and print the report. They cannot edit it.`;

    if (!confirm(question)) return;

    const me = auth.currentUser || {};
    try {
        if (btnTransferViolation) btnTransferViolation.disabled = true;
        if (wasTransferred) {
            await firestoreService.revertViolationTransfer(id, me.email, me.displayName);
            showToast(`Report ${label} removed from the HR dashboard.`, 'success');
        } else {
            await firestoreService.transferViolationToHr(id, me.email, me.displayName);
            showToast(`Report ${label} transferred to HR.`, 'success');
        }
        // The real-time listener re-renders the table, the details modal and
        // this button, so there is nothing to update by hand here.
    } catch (error) {
        console.error('Failed to update the HR transfer state:', error);
        showToast('Could not update the transfer: ' + ((error && error.message) || 'unknown error'), 'error');
    } finally {
        if (btnTransferViolation) btnTransferViolation.disabled = false;
    }
}
// ==============================================================
//  VIOLATION → AREA MANAGER TRANSFER
// ==============================================================
//  A SECOND, INDEPENDENT handoff. Pressing it stamps
//  `managerStatus: 'transferred'` on the same document, which makes the report
//  readable in the Area Manager's own Violations tab (js/owner-violations.js).
//
//  INDEPENDENT OF THE HR TRANSFER, ON PURPOSE. The two write disjoint field
//  groups — `hrStatus`/`transferred*` vs `managerStatus`/`managerTransferred*` —
//  so a report can be on HR's list, the manager's list, or both, and reverting
//  one never disturbs the other. Reusing the single `hrStatus` field would make
//  this button silently revoke an existing HR handoff, which is exactly the kind
//  of cross-wiring that stays invisible until someone needs both.
//
//  Like the HR transfer, nothing is copied or deleted: the report stays in this
//  list (with a "Transferred to Area Manager" pill) and the manager reads the
//  very same record, attachments and generated PDF included.
//
//  Only a superadmin may transfer. firestore.rules grants the `owner` role read
//  access and NO write access to `violations` at all, so an Area Manager can
//  never push a report onto anyone's desk — including their own.
// ==============================================================

/** True once a superadmin has handed this report to an Area Manager. */
function isViolationTransferredToManager(v) {
    return !!v && v.managerStatus === 'transferred';
}

/** The pill shown in the violations table and inside the details modal. */
function violationManagerTransferBadgeHtml(v) {
    if (!isViolationTransferredToManager(v)) return '';
    return '<span class="violation-hr-pill" title="This report was transferred to an Area Manager">'
        + '<i class="fas fa-share-nodes"></i> Transferred to Area Manager</span>';
}

/**
 * The manager-handoff audit line inside the details modal: WHO transferred it
 * and WHEN, so a superadmin can tell at a glance whether the Area Manager
 * actually has it — the same assurance the HR status line gives.
*/
function violationManagerTransferStatusHtml(v) {
    if (isViolationTransferredToManager(v)) {
        const when = v.managerTransferredAt
            ? formatViolationDateTime(violationReportDate({ reportDateTime: v.managerTransferredAt }))
            : null;
        const who = v.managerTransferredByName || v.managerTransferredBy;
        return violationManagerTransferBadgeHtml(v)
            + (who ? ` <span style="color:var(--text-muted);font-size:0.85rem;">by ${escapeHTML(who)}</span>` : '')
            + (when ? ` <span style="color:var(--text-muted);font-size:0.85rem;">on ${escapeHTML(when)}</span>` : '');
    }
    return '<span style="color:var(--text-muted);">Not transferred — this report is only visible to operators and superadmins.</span>';
}
/**
 * Show the "Transfer to Area Manager" / "Revert Transfer" button in the right
 * state. Hidden entirely for anyone who is not a superadmin.
 *
 * ⚠️ MUST BE CALLED ALONGSIDE refreshTransferButtonState(), NEVER INSTEAD OF
 * IT. The two write different fields and read different keys off the report, so
 * each needs its own call; folding them together is how one button's state ends
 * up driving the other's.
 */
function refreshManagerTransferButtonState(v) {
    if (!btnTransferViolationToManager) return;
    if (!currentUserIsSuperAdmin()) {
        btnTransferViolationToManager.style.display = 'none';
        return;
    }

    const transferred = isViolationTransferredToManager(v);
    btnTransferViolationToManager.style.display = 'inline-flex';
    btnTransferViolationToManager.classList.toggle('btn-success', !transferred);
    btnTransferViolationToManager.classList.toggle('btn-secondary', transferred);
    if (btnTransferViolationToManagerLabel) {
        btnTransferViolationToManagerLabel.textContent = transferred
            ? 'Revert Transfer'
            : 'Transfer to Area Manager';
    }
    if (btnTransferViolationToManagerIcon) {
        btnTransferViolationToManagerIcon.className = transferred ? 'fas fa-undo' : 'fas fa-share-nodes';
    }
    btnTransferViolationToManager.title = transferred
        ? 'Take this report back off the Area Manager dashboard'
        : 'Send this report to the Area Manager so they can review it for their branches';
}

/** Hand the open report to an Area Manager, or take it back. */
async function toggleViolationTransferToManager(id) {
    const v = allViolations.find(x => x.id === id);
    if (!v) return;
    if (!currentUserIsSuperAdmin()) {
        showToast('Only a superadmin can transfer reports to an Area Manager.', 'error');
        return;
    }

    const label = v.violationNumber || v.id;
    const wasTransferred = isViolationTransferredToManager(v);
    const question = wasTransferred
        ? `Take report ${label} back off the Area Manager dashboard?\n\nThey will no longer see it.`
        : `Transfer report ${label} to the Area Manager?\n\nThe Area Manager responsible for this branch will be able to view the details, the CCTV evidence and print the report. They cannot edit it.`;

    if (!confirm(question)) return;

    const me = auth.currentUser || {};
    try {
        if (btnTransferViolationToManager) btnTransferViolationToManager.disabled = true;
        if (wasTransferred) {
            await firestoreService.revertViolationTransferFromAreaManager(id, me.email, me.displayName);
            showToast(`Report ${label} removed from the Area Manager dashboard.`, 'success');
            // Reflect locally so the button updates immediately (not just on listener)
            v.managerStatus = undefined;
            delete v.managerExpiresAt;
            delete v.managerExpiresAtMs;
            delete v.managerOpenedAt;
            delete v.managerOpenedBy;
            delete v.managerOpenedByName;
        } else {
            await firestoreService.transferViolationToAreaManager(id, me.email, me.displayName);
            showToast(`Report ${label} transferred to the Area Manager.`, 'success');
            // Reflect locally so the button updates immediately
            v.managerStatus = 'transferred';
        }
        refreshManagerTransferButtonState(v);
    } catch (error) {
        console.error('Failed to update the Area Manager transfer state:', error);
        showToast('Could not update the transfer: ' + ((error && error.message) || 'unknown error'), 'error');
    } finally {
        if (btnTransferViolationToManager) btnTransferViolationToManager.disabled = false;
    }
}

// Exposed for the inline handlers / tests.
window.toggleViolationTransferToManager = toggleViolationTransferToManager;

// Exposed for the inline handlers / tests.
window.toggleViolationTransfer = toggleViolationTransfer;

// ==============================================================
//  VIOLATION REPORT EXPORT ("COMMAND CENTER REPORT")
//  Auto-filled PDF built from the stored report, downloaded, then
//  auto-saved into the report's OWN Cloudinary folder as
//  "<Subject> report.pdf". Nothing is ever deleted: re-generating
//  replaces the previous report file.
//
//  The layout itself now lives in js/violation-report.js, because the
//  HR dashboard (ownerdashboard.html) prints the same report and does
//  not load script.js. These are thin delegating wrappers kept so the
//  existing call sites below read exactly as they did before.
// ==============================================================

/** The shared builder. Absent only if the <script> tag was removed. */
function violationReportLib() {
    return window.ViolationReport || null;
}

function formatViolationStamp(d) {
    const lib = violationReportLib();
    return lib ? lib.formatStamp(d) : '—';
}

function violationStoreLabel(store) {
    const lib = violationReportLib();
    return lib ? lib.storeLabel(store) : (String(store || '').trim() || '—');
}

function violationReportPdfName(v) {
    const lib = violationReportLib();
    return lib ? lib.fileName(v) : 'report';
}

function downloadBlobFile(blob, fileName) {
    const lib = violationReportLib();
    if (lib) { lib.download(blob, fileName); return; }
    showToast('Report utilities failed to load — use "Generate Report" to try again.', 'error');
}

/** @returns {Promise<Blob|null>} the PDF blob, or null when jsPDF is unavailable. */
async function buildViolationReportPdf(v) {
    const lib = violationReportLib();
    return lib ? lib.buildPdf(v) : null;
}

/**
 * Cloudinary folder the generated report is stored in — deliberately the SAME
 * "Data base/.../<Subject> - <Date>/attachments" folder the evidence uses, so it
 * lands beside the CCTV files and shows up in the browser tree unchanged.
 * The reporter name comes from the REPORT itself (never the current user), so a
 * superadmin generating someone else's report never moves it into their folder.
 */
function violationReportFolderPathForReport(v) {
    return violationReportFolderPath({
        store: v.store,
        reporterName: v.reportedByName || v.reportedBy || 'Unknown',
        subject: v.subject,
        incident: violationIncidentDate(v) || violationReportDate(v) || new Date()
    });
}

function printViolationReport(v) {
    const lib = violationReportLib();
    if (lib) { lib.print(v); return; }
    showToast('Report utilities failed to load.', 'error');
}


/** Toggle the "Generate Report" button into / out of its busy state. */
function setViolationReportBusy(btn, label, busy) {
    if (!btn) return;
    btn.disabled = !!busy;
    btn.classList.toggle('is-busy', !!busy);
    if (label) label.textContent = busy ? 'Generating…' : 'Generate Report';
}

/**
 * AUTO-SAVE: generate the report PDF and store it in the report's own
 * Cloudinary attachments folder the moment a NEW report is submitted —
 * no button press needed. Downloading to the PC stays a manual choice
 * (the "Generate Report" button). Failures NEVER block the saved report:
 * they degrade to an info toast and the PDF can still be regenerated
 * manually afterwards.
 * @returns {Promise<object|null>} the linked attachment, or null.
 */
async function autoSaveViolationReportPdf(reportId, v) {
    try {
        if (!window.jspdf || !window.jspdf.jsPDF) return null;   // no lib — stay silent
        if (!isViolationCloudinaryConfigured()) return null;     // no storage — stay silent

        const blob = await buildViolationReportPdf(v);
        if (!blob) return null;

        const fileName = violationReportPdfName(v) + '.pdf';
        // Same folder the evidence uses, built from the REPORT's own reporter
        // name. No overwrite param: unsigned presets reject it, and uploading
        // the same public_id replaces the asset with a new version by default.
        const att = await violationCloudinaryUpload(
            new File([blob], fileName, { type: 'application/pdf' }),
            violationReportFolderPathForReport(v)
        );

        // Drop any previous generated report (same public_id), then append the
        // fresh one, so the record always carries exactly one PDF report.
        const reportPublicId = String(att.public_id || '');
        const kept = (Array.isArray(v.attachments) ? v.attachments : [])
            .filter(a => String(a.public_id || '') !== reportPublicId);
        await firestoreService.updateViolation(reportId, {
            attachments: kept.concat([att])
        });
        return att;
    } catch (error) {
        console.error('Auto-saving the report PDF failed:', error);
        showToast('Report PDF could not be auto-saved — use "Generate Report" to create it manually.', 'info');
        return null;
    }
}

/**
 * Generate the COMMAND CENTER REPORT for one violation report:
 *   1. build the PDF, 2. download it, 3. auto-save it into the report's OWN
 *   "Data base/.../attachments" Cloudinary folder as "<Subject> report.pdf",
 *   4. link it to the report so it shows up in the browser like any other file.
 * Re-generating REPLACES the previous report file — it never stacks duplicates
 * and never deletes an evidence asset.
 */
async function generateViolationReport(id) {
    const v = allViolations.find(x => x.id === id);
    if (!v) return;

    const btn = btnGenerateViolationReport;
    const label = btn ? btn.querySelector('span') : null;
    setViolationReportBusy(btn, label, true);

    try {
        const fileName = violationReportPdfName(v) + '.pdf';
        const blob = await buildViolationReportPdf(v);

        if (!blob) {
            showToast('PDF library unavailable — opening the print view instead.', 'info');
            printViolationReport(v);
            return;
        }

        downloadBlobFile(blob, fileName);

        if (!isViolationCloudinaryConfigured()) {
            showToast('Report downloaded. Cloudinary storage is not configured, so it was not saved online.', 'error');
            return;
        }

        // Same folder the evidence uses, built from the REPORT's own reporter name.
        // No overwrite param: unsigned presets reject it, and same-public_id
        // uploads replace the asset with a new version by default anyway.
        const att = await violationCloudinaryUpload(
            new File([blob], fileName, { type: 'application/pdf' }),
            violationReportFolderPathForReport(v)
        );

        if (!canModifyViolation(v)) {
            // firestore.rules: an operator may only update their OWN reports.
            showToast('Report downloaded and saved to Cloudinary. A superadmin must link it to this report.', 'info');
            return;
        }

        // Drop the previous generated report (same public_id), then append the fresh
        // one, so re-generating keeps exactly one report attached to the record.
        const reportPublicId = String(att.public_id || '');
        const kept = (Array.isArray(v.attachments) ? v.attachments : [])
            .filter(a => String(a.public_id || '') !== reportPublicId);
        await firestoreService.updateViolation(id, {
            attachments: kept.concat([att]),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        showToast('Report generated and saved to the report folder.', 'success');
    } catch (error) {
        console.error('Failed to generate the violation report:', error);
        showToast('Report generation failed: ' + ((error && error.message) || 'unknown error'), 'error');
    } finally {
        setViolationReportBusy(btn, label, false);
    }
}

/** Render the violations table. */
function displayViolations(violations) {
    if (!violationList) return;
    violationList.innerHTML = '';

    if (!violations.length) {
        const periodHint = (violationHiddenByPeriod > 0)
            ? `<p class="empty-state-hint"><i class="fas fa-calendar-day"></i> ${violationHiddenByPeriod} report${violationHiddenByPeriod === 1 ? '' : 's'} outside the selected period &mdash; still in the database. Choose &ldquo;All reports&rdquo; to view ${violationHiddenByPeriod === 1 ? 'it' : 'them'}.</p>`
            : '';
        violationList.innerHTML = `
            <tr><td colspan="10" class="empty-state"><i class="fas fa-video"></i><p>No violation reports found.</p>${periodHint}</td></tr>`;
        return;
    }

    violations.forEach(v => {
        const incident = violationIncidentDate(v);
        const report = violationReportDate(v);
        const attCount = Array.isArray(v.attachments) ? v.attachments.length : 0;
        const canModify = canModifyViolation(v);

        // The action stack, built once and used by BOTH the desktop Actions
        // cell and the card's footer — below 900px the desktop cells hide and
        // only the card is on screen (ROW CARD SWAP in style.css).
        const hasUp = window.HrUploads && typeof window.HrUploads.hasUploads === 'function'
            ? window.HrUploads.hasUploads('violations/' + v.id) : false;
        const actionsGroup = `
                <div class="action-group">
                    <span class="action-btn upload-indicator${hasUp ? ' has-uploads' : ''}" data-upload-key="violations/${v.id}" data-upload-label="${v.violationNumber || v.id}" title="HR NOV files${hasUp ? ' — files attached' : ' — no files'}" onclick="event.stopPropagation(); window.HrUploads && window.HrUploads.openFromButton(this);"><i class="fas fa-file-contract"></i><span class="upload-indicator-label">NOV</span></span>
                    ${canModify ? `
                        <button class="action-btn edit" title="Edit" onclick="window.openViolationFormModal('${v.id}')"><i class="fas fa-edit"></i></button>
                        <button class="action-btn delete-action" title="Delete" onclick="window.deleteViolationById('${v.id}')"><i class="fas fa-trash"></i></button>
                    ` : ''}
                </div>`;

        const row = document.createElement('tr');
        // Highlight reports THIS user has not opened yet. The tab is shared
        // by operators and superadmins, so without a per-row cue nobody can
        // tell at a glance which reports are actually still unread.
        const unseen = isViolationUnseen(v);
        if (unseen) row.classList.add('violation-row-unseen');
        row.innerHTML = `
            <td><span class="ticket-link" onclick="window.openViolationModal('${v.id}')">${escapeHTML(v.violationNumber || v.id)}${unseen ? '<span class="violation-new-dot" title="Not opened yet" aria-label="Not opened yet"></span>' : ''}</span></td>
            <td>${report ? formatDate(report) : '—'}</td>
            <td>${incident ? formatDate(incident) + ', ' + formatTime(incident) : '—'}</td>
            <td>${escapeHTML(v.store || '—')}</td>
            <td>${escapeHTML(v.subject || '—')}</td>
            <td>${escapeHTML(v.location || '—')}</td>
            <td>${escapeHTML(v.reportedByName || v.reportedBy || '—')}</td>
            <td>${attCount > 0 ? `<i class="fas fa-paperclip"></i> ${attCount}` : '—'}</td>
            <td>${actionsGroup}</td>
            <td class="approval-card-cell" data-label="Card">
                <div class="approval-card">
                    <div class="approval-card-head">
                        <span class="approval-card-branch"><i class="fas fa-store"></i>${escapeHTML(v.store || '—')}</span>
                        <span class="approval-card-pill approval-card-pill--neutral">${escapeHTML(v.violationNumber || v.id)}${unseen ? '<span class="violation-new-dot" title="Not opened yet" aria-label="Not opened yet"></span>' : ''}</span>
                    </div>
                    <div class="approval-card-grid">
                        <div class="approval-card-field"><span class="approval-card-label">Report Date</span><span class="approval-card-value">${report ? formatDate(report) : '—'}</span></div>
                        <div class="approval-card-field"><span class="approval-card-label">Incident Date/Time</span><span class="approval-card-value">${incident ? formatDate(incident) + ', ' + formatTime(incident) : '—'}</span></div>
                        <div class="approval-card-field"><span class="approval-card-label">Subject</span><span class="approval-card-value">${escapeHTML(v.subject || '—')}</span></div>
                        <div class="approval-card-field"><span class="approval-card-label">Location</span><span class="approval-card-value">${escapeHTML(v.location || '—')}</span></div>
                    </div>
                    <div class="approval-card-foot">
                        <div class="approval-card-expiry">
                            <span class="approval-card-label">Reporter</span>
                            <span class="approval-card-value">${escapeHTML(v.reportedByName || v.reportedBy || '—')}</span>
                            <span class="approval-card-note">${attCount > 0 ? `<i class="fas fa-paperclip"></i> ${attCount} file${attCount === 1 ? '' : 's'}` : 'No attachments'}</span>
                        </div>
                        <div class="approval-card-actions">${actionsGroup}</div>
                    </div>
                </div>
            </td>
        `;
        row.addEventListener('click', function (e) {
            if (e.target.closest('button, input, a, .action-group')) return;
            window.openViolationModal(v.id);
        });
        violationList.appendChild(row);
    });
}

/**
 * Slice the filtered violation reports to the current page, render the rows,
 * then draw the shared .pagination controls (same pattern as the Branches table).
 */
function renderViolationPagination() {
    const totalItems = filteredViolations.length;
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;

    if (violationPage > totalPages) violationPage = totalPages;
    if (violationPage < 1) violationPage = 1;

    const start = (violationPage - 1) * ITEMS_PER_PAGE;
    const end = Math.min(start + ITEMS_PER_PAGE, totalItems);

    // Rows always render, even if the controls element is missing from the page.
    displayViolations(filteredViolations.slice(start, end));
    // Re-flag the Upload indicators for the rows just drawn (amber = already has files).
    try { if (window.HrUploads && window.HrUploads.paintPresence) window.HrUploads.paintPresence(); } catch (e) { /* ignore */ }

    if (!violationPagination) return;

    if (totalPages <= 1) {
        violationPagination.innerHTML = `<span class="page-info">Showing all ${totalItems} reports</span>`;
        return;
    }

    let html = `<button onclick="goToViolationPage(${violationPage - 1})" ${violationPage <= 1 ? 'disabled' : ''}>\u00AB Prev</button>`;
    const maxVisiblePages = 5;
    let startPage = Math.max(1, violationPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);
    if (endPage - startPage + 1 < maxVisiblePages) startPage = Math.max(1, endPage - maxVisiblePages + 1);

    for (let i = startPage; i <= endPage; i++) {
        html += `<button class="${i === violationPage ? 'active' : ''}" onclick="goToViolationPage(${i})">${i}</button>`;
    }

    html += `<button onclick="goToViolationPage(${violationPage + 1})" ${violationPage >= totalPages ? 'disabled' : ''}>Next \u00BB</button>`;
    html += `<span class="page-info">Page ${violationPage} of ${totalPages} (${totalItems} reports)</span>`;

    violationPagination.innerHTML = html;
}

window.goToViolationPage = function(page) {
    violationPage = page;
    renderViolationPagination();
};

// ===== VIOLATION DETAILS MODAL =====

/** True for evidence uploaded through Edit Violation after first submission.
 *  Delegates to the shared helper so all three dashboards agree. */
function isViolationAddedAttachment(att) {
    const h = window.AttachmentViewer && window.AttachmentViewer.helpers;
    if (h && typeof h.isAddedAttachment === 'function') return h.isAddedAttachment(att);
    return !!(att && att.addedAfterSubmit);
}

function renderViolationAttachments(grid, attachments, editable) {
    if (!grid) return;
    const list = Array.isArray(attachments) ? attachments : [];
    if (list.length === 0) {
        grid.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;">No attachments yet.</p>';
        return;
    }
    grid.innerHTML = list.map((att, index) => {
        // ⚠️ normalizeAttachment() here too. This renderer used to read
        // att.secure_url directly, so it understood ONE writer's shape only: an
        // attachment stored as `url` / `fileName` / `mimeType` (the Area Manager
        // form's shape) rendered as a dead card here, while the same file rendered
        // correctly in the four ticket grids. Normalising is what makes the same
        // file look the same in every grid.
        const norm = normalizeAttachment(att);
        const url = norm ? norm.url : '';
        const name = (norm && norm.name) || ('Attachment ' + (index + 1));
        const sizeText = (norm && norm.bytes) ? formatFileSize(norm.bytes) : '';

        // ⚠️ WITHOUT A URL THERE IS NO ANCHOR AT ALL. This renderer had no such
        // guard and emitted href="" unconditionally — `href=""` is a real link
        // to the CURRENT PAGE, so clicking a URL-less violation attachment
        // navigated the whole app to its own URL. That bug was already fixed in
        // the other four grids; this one was simply missed.
        const isBroken = !url;

        // One shared tile builder, so this grid matches every other grid.
        // See buildAttachmentPreview() for what used to differ here.
        const preview = buildAttachmentPreview(norm, index);

        const publicId = (norm && norm.publicId) || '';
        const removeBtn = editable
            ? `<button type="button" class="violation-att-remove" title="Remove attachment" data-public-id="${escapeHTML(publicId)}"><i class="fas fa-times"></i></button>`
            : '';

        // A broken record renders a div, NOT an anchor - see the isBroken note.
        const body = isBroken
            ? `<div class="attachment-preview" title="Link unavailable">${preview}</div>`
            : `<a href="${url}" target="_blank" rel="noopener noreferrer" class="attachment-preview" title="${escapeHTML(name)}">${preview}</a>`;

        // Evidence added after the first submission (Edit Violation) gets the
        // same green outline + NEW banner as ticket "added footage". Badge is
        // top-left, the remove (×) button top-right, so both can show at once.
        const isAdded = isViolationAddedAttachment(att);
        const addedBadge = isAdded
            ? '<span class="attachment-added-badge" role="img" aria-label="Added footage" title="Added after the report was submitted">NEW</span>'
            : '';

        return `
            <div class="attachment-item${isAdded ? ' attachment-item--added' : ''}" data-public-id="${escapeHTML(publicId)}">
                ${addedBadge}
                ${removeBtn}
                ${body}
                <div class="attachment-meta">
                    <span class="attachment-name" title="${escapeHTML(name)}">${escapeHTML(name)}</span>
                    ${sizeText ? `<span class="attachment-size">${escapeHTML(sizeText)}</span>` : ''}
                </div>
            </div>
        `;
    }).join('');

    grid.querySelectorAll('.violation-att-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            removeViolationEditAttachment(btn.dataset.publicId);
        });
    });
}

function violationDetailsHtml(v) {
    const incident = violationIncidentDate(v);
    const report = violationReportDate(v);
    return `
        <div class="modal-field"><label>Report No.</label><p>${escapeHTML(v.violationNumber || v.id)}</p></div>
        <div class="modal-field"><label>Store</label><p>${escapeHTML(v.store || '—')}</p></div>
        <div class="modal-field"><label>Location</label><p>${escapeHTML(v.location || '—')}</p></div>
        <div class="modal-field"><label>Incident Date/Time</label><p>${incident ? formatViolationDateTime(incident) : '—'}</p></div>
        <div class="modal-field"><label>Report Date/Time</label><p>${report ? formatViolationDateTime(report) : '—'}</p></div>
        <div class="modal-field"><label>Reported By</label><p>${escapeHTML(v.reportedByName || v.reportedBy || '—')}</p></div>
        <div class="modal-field" style="grid-column:1 / -1;"><label>HR Status</label><p>${violationTransferStatusHtml(v)}</p></div>
        <div class="modal-field" style="grid-column:1 / -1;"><label>Area Manager Status</label><p>${violationManagerTransferStatusHtml(v)}</p></div>
        <div class="modal-field" style="grid-column:1 / -1;"><label>Subject</label><p style="font-weight:600;">${escapeHTML(v.subject || '—')}</p></div>
        <div class="modal-field" style="grid-column:1 / -1;"><label>Details of Observation</label><p style="white-space:pre-wrap;line-height:1.6;">${escapeHTML(v.details || '—')}</p></div>
    `;
}

function openViolationModal(id) {
    const v = allViolations.find(x => x.id === id);
    if (!v) return;
    currentViolationId = id;

    // Opening the report IS the acknowledgement: the sidebar badge counts
    // reports this user has not opened yet, so reaching this point means
    // this one has been read. (The tab itself is shared with other roles,
    // so merely opening the tab must not clear the badge.)
    markViolationSeen(id);
    // Re-render the table behind the modal so this row loses its
    // "unseen" highlight and dot immediately.
    if (typeof filterViolations === 'function') filterViolations();

    if (violationModalTitle) violationModalTitle.textContent = v.violationNumber || 'Violation Report';
    if (violationModalBody) violationModalBody.innerHTML = violationDetailsHtml(v);
    renderViolationAttachments(violationAttachmentsGrid, v.attachments, false);

    // Edit/Delete buttons only for the reporter (operator) or a superadmin.
    if (violationModalFooter) {
        violationModalFooter.style.display = canModifyViolation(v) ? 'flex' : 'none';
    }
    // The HR handoff button is superadmin-only and reflects the current state
    // (Transfer to HR <-> Revert Transfer).
    refreshTransferButtonState(v);
    // ⚠️ BOTH transfer buttons, never one or the other. They are independent
    // handoffs reading different fields, so a report can sit on HR's list, the
    // manager's list, or both — and each button must reflect only its own.
    refreshManagerTransferButtonState(v);

    if (violationModal) violationModal.classList.add('active');
    captureMainState({ tab: 'violations', modal: 'violation', id });
}

function closeViolationModal() {
    if (violationModal) violationModal.classList.remove('active');
    currentViolationId = null;
    clearMainModalCtx();
}

/** Keep an open details modal in sync when the real-time listener fires. */
function renderViolationDetailsIfOpen() {
    if (!violationModal || !violationModal.classList.contains('active') || !currentViolationId) return;
    const v = allViolations.find(x => x.id === currentViolationId);
    if (!v) { closeViolationModal(); return; }
    if (violationModalBody) violationModalBody.innerHTML = violationDetailsHtml(v);
    renderViolationAttachments(violationAttachmentsGrid, v.attachments, false);
    if (violationModalFooter) {
        violationModalFooter.style.display = canModifyViolation(v) ? 'flex' : 'none';
    }
    // Keep the transfer button in sync too: a transfer made from another tab (or
    // by a second superadmin) arrives here through this same listener.
    refreshTransferButtonState(v);
    // Both handoffs can arrive this way independently — see the note above the
    // call in openViolationDetails().
    refreshManagerTransferButtonState(v);
}

// ===== VIOLATION FORM MODAL (Add / Edit) =====

function resetViolationFormUI() {
    if (violationForm) violationForm.reset();
    violationPendingFiles = [];
    violationEditAttachments = [];
    if (violationUploadWidget) renderUploadFileList(violationUploadWidget, []);
    resetUploadProgress(violationUploadWidget);
    if (violationUploadStatus) { violationUploadStatus.textContent = ''; violationUploadStatus.classList.remove('success', 'error'); }
    if (violationFormWarning) violationFormWarning.style.display = 'none';
    // setSubmitBusy(false), not a bare `disabled = false`: a submit that was
    // interrupted (modal closed mid-upload) leaves the button showing the
    // spinner. Re-enabling it alone would leave a live-looking button whose
    // label still reads "Submitting…". Resetting here guarantees the modal
    // always opens in its clean, idle, green state.
    setSubmitBusy(btnSubmitViolation, false);
}

/**
 * Open the violation report form. Pass a report id to edit an existing
 * report, or null/undefined to file a new one.
 */
function openViolationFormModal(id) {
    resetViolationFormUI();
    populateViolationStoreSelect();

    if (id) {
        const v = allViolations.find(x => x.id === id);
        if (!v) return;
        // Operators may only edit their own reports.
        if (!canModifyViolation(v)) {
            showToast('You can only edit your own reports.', 'error');
            return;
        }
        currentViolationId = id;
        if (violationFormTitle) violationFormTitle.textContent = 'Edit Violation Report';
        if (violationFormId) violationFormId.value = v.id;
        // Re-populate with the stored store name so legacy values that are not
        // in the branches list still appear as a selectable option.
        populateViolationStoreSelect(v.store);
        if (violationStoreInput) violationStoreInput.value = v.store || '';
        if (violationSubjectInput) violationSubjectInput.value = v.subject || '';
        const incident = violationIncidentDate(v);
        if (violationIncidentDateInput || violationIncidentTimeInput) {
            // Use LOCAL date/time parts (toISOString is UTC and shifts the
            // day for UTC+8 users).
            const pad = (n) => String(n).padStart(2, '0');
            if (violationIncidentDateInput && incident) {
                violationIncidentDateInput.value = `${incident.getFullYear()}-${pad(incident.getMonth() + 1)}-${pad(incident.getDate())}`;
            }
            if (violationIncidentTimeInput && incident) {
                violationIncidentTimeInput.value = `${pad(incident.getHours())}:${pad(incident.getMinutes())}`;
            }
        }
        if (violationLocationInput) violationLocationInput.value = v.location || '';
        if (violationDetailsInput) violationDetailsInput.value = v.details || '';
        violationEditAttachments = Array.isArray(v.attachments) ? v.attachments.slice() : [];
        // Show the existing evidence files in the edit form's file list, each
        // with a remove (x) button, so the superadmin can see what is on file
        // and drop individual attachments before saving.
        renderViolationEditFileList();
    } else {
        currentViolationId = null;
        if (violationFormTitle) violationFormTitle.textContent = 'Report Violation';
        if (violationFormId) violationFormId.value = '';
    }

    if (violationFormModal) violationFormModal.classList.add('active');
}

function closeViolationFormModal() {
    if (violationFormModal) violationFormModal.classList.remove('active');
    currentViolationId = null;
    resetViolationFormUI();
}

/** Remove an existing attachment while editing a violation report. */
function removeViolationEditAttachment(publicId) {
    violationEditAttachments = violationEditAttachments.filter(a => (a.public_id || '') !== publicId);
    renderViolationAttachments(violationAttachmentsGrid, violationEditAttachments, true);
    renderViolationEditFileList();
}

/** Render the existing (pre-uploaded) attachments of the violation being edited
 * into the form's file list, each with a remove (x) button on top. */
function renderViolationEditFileList() {
    const widget = violationUploadWidget;
    if (!widget) return;
    const listEl = widget.querySelector('.upload-file-list');
    if (!listEl) return;
    const arr = violationEditAttachments.map((att, i) => {
        const n = normalizeAttachment(att);
        return { name: (n && n.name) || 'Attachment', size: (n && n.bytes) || 0, added: isViolationAddedAttachment(att) };
    });
    if (arr.length === 0) { listEl.innerHTML = ''; return; }
    listEl.innerHTML = arr.map((f, i) => `
        <div class="upload-file-item${f.added ? ' upload-file-item--added' : ''}" data-index="${i}">
            <i class="fas fa-file-alt"></i>
            <span class="upload-file-name" title="${escapeHTML(f.name)}">${escapeHTML(f.name)}</span>
            ${f.added ? '<span class="upload-file-new-tag" title="Added after the report was submitted">NEW</span>' : ''}
            <span class="upload-file-size">${formatFileSize(f.size)}</span>
            <button type="button" class="upload-file-remove" data-index="${i}" title="Remove">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `).join('');
    listEl.querySelectorAll('.upload-file-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const index = parseInt(btn.dataset.index, 10);
            if (!Number.isNaN(index)) {
                violationEditAttachments.splice(index, 1);
                renderViolationEditFileList();
            }
        });
    });
}

function showViolationFormWarning(message) {
    if (!violationFormWarning || !violationFormWarningMsg) return;
    violationFormWarningMsg.textContent = message || '';
    violationFormWarning.style.display = message ? 'flex' : 'none';
}

/**
 * Submit the violation report. On create, the document is written first so the
 * new report is immediately visible to the admin dashboard, then any selected
 * evidence files are uploaded to the dedicated Violations Cloudinary account
 * and merged into the document.
 */
async function saveViolationForm(e) {
    if (e) e.preventDefault();

    const store = (violationStoreInput && violationStoreInput.value || '').trim();
    const subject = (violationSubjectInput && violationSubjectInput.value || '').trim();
    const incidentDate = (violationIncidentDateInput && violationIncidentDateInput.value || '').trim();
    const incidentTime = (violationIncidentTimeInput && violationIncidentTimeInput.value || '').trim();
    const location = (violationLocationInput && violationLocationInput.value || '').trim();
    const details = (violationDetailsInput && violationDetailsInput.value || '').trim();

    if (!store || !subject || !incidentDate || !incidentTime || !location || !details) {
        showViolationFormWarning('Please fill in all required fields.');
        return;
    }

    const editId = (violationFormId && violationFormId.value) || '';
    const me = auth.currentUser;
    if (!me || !me.email) {
        showViolationFormWarning('You must be signed in to submit a violation report.');
        return;
    }

    const files = violationPendingFiles.slice();
    if (files.length > 0 && !isViolationCloudinaryConfigured()) {
        showViolationFormWarning('Violations Cloudinary storage is not configured. Remove the files or set up the second Cloudinary account first.');
        return;
    }

    const incidentDateTime = firebase.firestore.Timestamp.fromDate(new Date(`${incidentDate}T${incidentTime}`));
    const reportedByName = me.displayName || me.email.split('@')[0];

    try {
        // ⚠️ MUST BE THE FIRST THING IN THE TRY, BEFORE ANY `await`. Every await
        // below (the number generator, the two Firestore writes, the PDF build)
        // yields to the event loop, so a queued second click could otherwise
        // re-enter and save the same report twice. setSubmitBusy also greys the
        // button and shows the spinner — that is the indicator the operator
        // asked for, and it makes the greyed state self-explanatory.
        setSubmitBusy(btnSubmitViolation, true);
        showViolationFormWarning('');

        let reportId = editId;
        let createdViolationNumber = null;
        if (editId) {
            // Edit: keep the original report number/report date, update editable fields.
            await firestoreService.updateViolation(editId, {
                store,
                subject,
                incidentDateTime,
                location,
                details,
                attachments: violationEditAttachments.slice(),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        } else {
            // New report — visible to the admin dashboard immediately (no approval).
            const violationNumber = await firestoreService.generateViolationNumber();
            createdViolationNumber = violationNumber;
            reportId = await firestoreService.addViolation({
                violationNumber,
                store,
                subject,
                incidentDateTime,
                reportDateTime: firebase.firestore.FieldValue.serverTimestamp(),
                location,
                details,
                reportedBy: me.email,
                reportedByName,
                attachments: []
            });
        }

        // Upload any selected evidence to the 2nd Cloudinary account using the
        // "Data base" folder structure built from the report's own fields.
        // The reporter name always comes from the ORIGINAL report, so a
        // superadmin editing someone's report never moves files into their
        // own folder.
        const uploaded = [];
        if (files.length > 0) {
            const existingReport = editId ? allViolations.find(x => x.id === editId) : null;
            const incidentForPath = new Date(`${incidentDate}T${incidentTime}`);
            const folderPath = violationReportFolderPath({
                store,
                reporterName: (existingReport && existingReport.reportedByName) || reportedByName,
                subject,
                incident: incidentForPath
            });
            const widget = violationUploadWidget;
            for (let i = 0; i < files.length; i++) {
                // ⚠️ VIDEOS ABOVE 15 MB ARE COMPRESSED FIRST (js/video-compressor.js)
                // to save Violations Cloudinary storage (25 GB total). Same
                // resolution, H.264 MP4, medium quality. Anything else — and any
                // video the browser cannot compress — uploads exactly as before:
                // compress() always resolves with a file to upload, never throws.
                //
                // Progress: a compressed file's slice of the bar is split 50/50
                // (compressing, then uploading), so the bar only ever climbs.
                let fileToUpload = files[i];
                let compression = null;
                const compressing = !!(window.VideoCompressor && window.VideoCompressor.shouldCompress(fileToUpload));
                if (compressing) {
                    if (violationUploadStatus) {
                        violationUploadStatus.textContent = `Compressing video ${i + 1} of ${files.length}… 0%`;
                    }
                    setUploadProgress(widget, Math.round(aggregateUploadPercent(i, 0, files.length)));
                    compression = await window.VideoCompressor.compress(fileToUpload, {
                        onProgress: (p) => {
                            const own = Math.round(p * 100);
                            setUploadProgress(widget, Math.round(aggregateUploadPercent(i, own / 2, files.length)));
                            if (violationUploadStatus) {
                                violationUploadStatus.textContent = `Compressing video ${i + 1} of ${files.length}… ${own}%`;
                            }
                        }
                    });
                    fileToUpload = (compression && compression.file) || files[i];
                    if (compression && compression.compressed) {
                        console.log('[Violation] compressed', files[i].name, formatFileSize(compression.originalBytes),
                            '->', formatFileSize(compression.outputBytes));
                    } else {
                        console.info('[Violation] uploading original', files[i].name, '(' + (compression && compression.reason) + ')');
                    }
                }
                const uploadBase = compressing ? 50 : 0;
                const uploadShare = compressing ? 0.5 : 1;
                let att = await violationCloudinaryUpload(fileToUpload, folderPath, (pct) => {
                    // Aggregated, not raw: feeding each file's own 0-100 straight
                    // into the bar made three files produce 0->100, 0->100, 0->100,
                    // so the bar visibly restarted and read as a stuck upload.
                    setUploadProgress(widget, Math.round(aggregateUploadPercent(i, uploadBase + pct * uploadShare, files.length)));
                    if (violationUploadStatus) {
                        violationUploadStatus.textContent = `Uploading ${i + 1} of ${files.length}…`;
                    }
                });
                // Remember the original size of a compressed video (for the
                // record and the storage report); bytes/name are the stored file.
                if (compression && compression.compressed) {
                    att = Object.assign({}, att, {
                        compressed: true,
                        originalBytes: compression.originalBytes,
                        originalName: files[i].name
                    });
                }
                // ⚠️ STAMP FILES ADDED THROUGH EDIT VIOLATION. An edit-time upload
                // is additional evidence (typically footage / another angle the
                // Area Manager asked for), so it is flagged on the record itself.
                // Every viewer (operator, Area Manager, HR) reads this flag via
                // AttachmentViewer.helpers.isAddedAttachment() and draws the green
                // outline + NEW banner. Original uploads (new report) stay unflagged.
                uploaded.push(editId
                    ? Object.assign({}, att, { addedAfterSubmit: true, addedAt: new Date().toISOString() })
                    : att);
            }
            const existing = editId ? violationEditAttachments.slice() : [];
            await firestoreService.updateViolation(reportId, {
                attachments: existing.concat(uploaded),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }

        // Auto-save the generated PDF report into the same Cloudinary folder
        // (new reports only) — no button press needed. Downloading to the PC
        // stays a manual choice via the "Generate Report" button.
        if (!editId) {
            const vForPdf = {
                id: reportId,
                violationNumber: createdViolationNumber,
                store,
                subject,
                incidentDateTime,
                reportDateTime: new Date(),
                location,
                details,
                reportedBy: me.email,
                reportedByName,
                attachments: uploaded.slice()
            };
            // Indeterminate for the PDF build + upload. This is the LONGEST silent
            // step in the whole submit and it used to show nothing at all — the
            // bar sat finished at 100% from the evidence upload while jsPDF built
            // the document and Cloudinary took the file. No percentage is knowable
            // here, so the sweeping bar keeps the row visibly alive instead.
            setUploadProgressIndeterminate(violationUploadWidget);
            if (violationUploadStatus) violationUploadStatus.textContent = 'Generating PDF report…';
            await autoSaveViolationReportPdf(reportId, vForPdf);
        } else if (files.length === 0) {
            // No evidence and no PDF to build: still say the write is in flight,
            // because evidence is optional and the operator otherwise cannot
            // tell "nothing attached" from "still saving".
            setUploadProgressIndeterminate(violationUploadWidget);
            if (violationUploadStatus) violationUploadStatus.textContent = 'Saving report…';
        }

        closeViolationFormModal();
        showToast(editId ? 'Violation report updated.' : 'Violation report submitted.', 'success');
    } catch (error) {
        console.error('Failed to save violation report:', error);
        showViolationFormWarning(error && error.message ? error.message : 'Failed to save the violation report.');
        // Mirror the failure onto the upload row too. showViolationFormWarning
        // IS visible, but it sits at the BOTTOM of the form while the operator's
        // eyes are on the progress bar they just watched, so the error has to
        // land there as well. finishUploadProgress also drops the indeterminate
        // class — a sweeping animation on a failed submit reads as "still going".
        finishUploadProgress(violationUploadWidget, false);
        if (violationUploadStatus) {
            violationUploadStatus.textContent = 'Upload failed. Please try again.';
            violationUploadStatus.classList.add('error');
        }
        if (typeof showToast === 'function') {
            showToast('Failed to save the violation report.', 'error');
        }
    } finally {
        // Restores the stashed idle markup as well as re-enabling the button, so
        // the spinner is never left on a button the operator can click again.
        // On success this runs after closeViolationFormModal(), which is
        // harmless — the button is hidden anyway, and the next open resets it.
        setSubmitBusy(btnSubmitViolation, false);
    }
}

/** Delete a violation report (reporter or superadmin only). */
async function deleteViolationById(id) {
    const v = allViolations.find(x => x.id === id);
    if (!v) return;
    if (!canModifyViolation(v)) {
        showToast('You can only delete your own reports.', 'error');
        return;
    }
    if (!confirm(`Delete violation report ${v.violationNumber || v.id}? This cannot be undone.`)) return;

    try {
        await firestoreService.deleteViolation(id);
        showToast('Violation report deleted.', 'success');
        if (currentViolationId === id) closeViolationModal();
    } catch (error) {
        console.error('Failed to delete violation report:', error);
        showToast('Failed to delete the violation report.', 'error');
    }
}

// ===== VIOLATION UPLOAD WIDGET (form dropzone) =====

function addViolationPendingFiles(fileList) {
    const validation = validateUploadFiles(fileList);
    if (!validation.ok) {
        if (violationUploadStatus) {
            violationUploadStatus.textContent = validation.message;
            violationUploadStatus.classList.add('error');
        }
        return;
    }
    const incoming = Array.from(fileList || []);
    incoming.forEach(f => {
        if (!violationPendingFiles.some(x => x.name === f.name && x.size === f.size)) {
            violationPendingFiles.push(f);
        }
    });
    renderUploadFileList(violationUploadWidget, violationPendingFiles, (name) => {
        violationPendingFiles = violationPendingFiles.filter(f => f.name !== name);
        renderUploadFileList(violationUploadWidget, violationPendingFiles);
        // Re-state the count after a removal, otherwise the line below would
        // keep claiming a file that is no longer attached.
        updateViolationAttachStatus();
    });
    updateViolationAttachStatus();
}

/**
 * Confirm how many files are attached.
 *
 * ⚠️ THIS IS NOT A PROGRESS BAR, DELIBERATELY. Nothing uploads when a file is
 * attached here — `violationPendingFiles` only STAGES them and the real
 * `violationCloudinaryUpload()` calls happen in saveViolationForm(). The report's
 * Cloudinary folder is built from store/subject/incident-date, none of which are
 * guaranteed to be filled in yet at attach time, so there is no honest byte
 * count to show. The real per-file progress bar is driven at submit time; this
 * line only reports what is staged.
 *
 * The count matters because evidence is OPTIONAL: with no files attached the
 * operator needs to see that "nothing attached" is a valid state, not a
 * half-finished form.
 */
function updateViolationAttachStatus() {
    if (!violationUploadStatus) return;
    if (violationPendingFiles.length === 0) {
        violationUploadStatus.textContent = '';
        violationUploadStatus.classList.remove('success', 'error');
        return;
    }
    const totalBytes = violationPendingFiles.reduce((sum, f) => sum + (f.size || 0), 0);
    const sizeText = totalBytes > 0 ? ' · ' + formatFileSize(totalBytes) : '';
    violationUploadStatus.textContent = '✓ ' + violationPendingFiles.length +
        ' file(s) attached' + sizeText + ' — uploads on submit';
    violationUploadStatus.classList.remove('error');
    violationUploadStatus.classList.add('success');
}

function bindViolationUploadWidget() {
    if (!violationUploadWidget) return;
    const dropzone = violationUploadWidget.querySelector('.upload-dropzone');
    const input = violationUploadWidget.querySelector('input[type="file"]');
    if (!dropzone || !input) return;

    // ⚠️ DELIBERATELY NO `click` HANDLER. The dropzone is a <label> that WRAPS
    // the <input type="file"> (main.html), so the browser already forwards a
    // click on it to the input natively — no JS required.
    //
    // There used to be `dropzone.addEventListener('click', e => { e.preventDefault();
    // input.click(); })`, and that is exactly why clicking did nothing while
    // drag-and-drop worked. preventDefault() cancelled the label's own native
    // forwarding, leaving only a synthetic `input.click()` — and the input is
    // visually hidden with `clip: rect(0 0 0 0)` (style.css), which several
    // browsers refuse to open a file dialog for. Drag-and-drop kept working
    // because that path never touches the input; it reads e.dataTransfer.files
    // directly, which is why only one of the two paths was broken.
    //
    // Do not "restore" this handler to make the zone clickable — deleting it is
    // the fix. If a future change makes the input a sibling of the label rather
    // than a child, the native forwarding is gone and this must come back.

    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
            addViolationPendingFiles(e.dataTransfer.files);
        }
    });
    input.addEventListener('change', () => {
        addViolationPendingFiles(input.files);
        input.value = '';
    });
}

// ===== VIOLATION FOLDER TREE PANEL =====
// Explorer-style nested tree mirroring the Cloudinary "Data base" storage
// structure, built from the same path logic used by the uploader
// (violationReportFolderPath) so the tree always matches reality.
// The browser always opens inside "Data base/Branches" (see
// violationDefaultBrowserPath) — the one-row "Data base" root stays unreachable.

// All violation evidence is stored under "Data base/Branches/..." — the browser
// therefore lands inside Branches and never exposes the one-row "Data base" root.
const VIOLATION_BROWSER_DEFAULT_FOLDER = 'Branches';

/** Tree most recently built by renderViolationFolderTree() (used by the nav helpers). */
let lastViolationTreeRoot = null;

/** Landing folder of the browser: "Branches" when the tree has it, else the root. */
function violationDefaultBrowserPath(root) {
    const r = root || lastViolationTreeRoot;
    return r && r.children && r.children[VIOLATION_BROWSER_DEFAULT_FOLDER]
        ? [VIOLATION_BROWSER_DEFAULT_FOLDER]
        : [];
}

function violationTreeFileIcon(att) {
    if (att.resource_type === 'image') return 'fa-file-image';
    if (att.resource_type === 'video') return 'fa-file-video';
    return getAttachmentIcon(att.resource_type, att.format);
}

/**
 * Build a nested folder tree from violation reports.
 * @param {Array} violations  the (filtered) violation reports
 * @returns {{root: object, fileCount: number}}
 */
function buildViolationFolderTree(violations) {
    const root = { name: 'Data base', children: {} };
    let fileCount = 0;

    for (const v of violations) {
        const reporterName = v.reportedByName || v.reportedBy || 'Unknown';
        const incident = violationIncidentDate(v) || violationReportDate(v) || new Date();
        // Full Cloudinary path, e.g.
        // ['Data base','Branches','Fame','September 2026','nicoooli224','Lala - September 15 2026','attachments']
        const segments = violationReportFolderPath({
            store: v.store,
            reporterName,
            subject: v.subject,
            incident
        }).split('/').slice(1); // drop the leading 'Data base' — it is the root node

        let node = root;
        for (const seg of segments) {
            if (!node.children[seg]) node.children[seg] = { children: {} };
            node = node.children[seg];
            // Track the report(s) living under each node: the leaf
            // "<Subject> - <Date>" folder maps 1:1 to a report, while every
            // ancestor aggregates several — which is why only the leaf is
            // renameable (see violationRenameTarget).
            node.reportIds = (node.reportIds || []).concat(v.id);
        }

        const atts = Array.isArray(v.attachments) ? v.attachments : [];
        // Tag each file with its owning report so a rename can write back to the
        // right document (files live inside the report record, not in a
        // Cloudinary listing).
        node.files = (node.files || []).concat(atts.map(a => Object.assign({}, a, { _violationId: v.id })));
        if (atts.length === 0) node.empty = true;
        fileCount += atts.length;
    }

    return { root, fileCount };
}

let violationBrowserPath = [];   // current location, segments below the 'Data base' root
let violationNavDirection = 'fwd'; // 'fwd' (entered a folder) | 'back' (went up / jumped)

/** Render the Drive-style breadcrumb bar ( Branches › <Store> › ... ). */
function renderViolationBreadcrumb() {
    if (!violationBreadcrumb) return;
    // The leading crumb IS the landing folder (Branches): the "Data base" root
    // sits above it and is unreachable, so it never gets a jumpable crumb.
    const base = violationDefaultBrowserPath();
    const parts = [{ name: base.length ? base[0] : 'Home', path: base.join('/'), home: true }];
    let acc = base.join('/');
    for (const seg of violationBrowserPath.slice(base.length)) {
        acc = acc ? acc + '/' + seg : seg;
        parts.push({ name: seg, path: acc });
    }
    violationBreadcrumb.innerHTML = parts.map((p, i) => {
        const isLast = i === parts.length - 1;
        const icon = p.home ? '<i class="fas fa-house"></i> ' : '';
        const label = escapeHTML(p.name);
        return isLast
            ? `<span class="vb-crumb current" aria-current="location">${icon}${label}</span>`
            : `<span class="vb-crumb" data-path="${escapeHTML(p.path)}" role="button" tabindex="0" title="Go to ${label}">${icon}${label}</span>`;
    }).join('<span class="vb-sep" aria-hidden="true"><i class="fas fa-chevron-right"></i></span>');

    // Back / Home are unavailable at the landing folder — nothing exists above it.
    const atBase = violationBrowserPath.length <= base.length;
    if (btnViolationBack) btnViolationBack.disabled = atBase;
    if (btnViolationHome) btnViolationHome.disabled = atBase;
}

/** Change location inside the folder browser, animating in the direction of travel. */
function navigateViolationBrowser(path, direction) {
    const base = violationDefaultBrowserPath();
    let target = Array.isArray(path) ? path.slice() : [];
    // "Data base" sits above the landing folder and stays unreachable: any
    // request for a shallower level is clamped back to Branches.
    if (target.length < base.length) target = base.slice();
    const same = target.length === violationBrowserPath.length
        && target.every((seg, i) => seg === violationBrowserPath[i]);
    if (same && !direction) return;

    violationNavDirection = direction || (target.length >= violationBrowserPath.length ? 'fwd' : 'back');
    violationBrowserPath = target;
    renderViolationFolderTree({ animate: true });
}

/** Render one browser level: folder rows, then file rows (Drive style). */
function renderViolationBrowserLevel(node) {
    const childNames = Object.keys(node.children || {}).sort((a, b) => a.localeCompare(b));
    const files = Array.isArray(node.files) ? node.files : [];

    if (childNames.length === 0 && files.length === 0 && violationBrowserPath.length === 0) {
        return '<p class="violation-tree-empty"><i class="far fa-folder-open"></i> No violation reports to show.</p>';
    }

    let html = '';
    let index = 0;

    for (const name of childNames) {
        const child = node.children[name];
        const childFolders = Object.keys(child.children || {}).length;
        const childFiles = (child.files || []).length;
        const bits = [];
        if (childFolders) bits.push(childFolders + ' folder' + (childFolders === 1 ? '' : 's'));
        if (childFiles) bits.push(childFiles + ' file' + (childFiles === 1 ? '' : 's'));
        // Only the leaf "<Subject> - <Date>" folder maps to a single report, so
        // only it offers rename — its name IS that report's subject.
        const ownerId = (child.reportIds && child.reportIds.length === 1) ? child.reportIds[0] : '';
        const canRename = violationRowCanRenameById(ownerId);
        const renameBtn = canRename
            ? '<button type="button" class="vdrive-rename-btn" data-action="rename-folder"'
            + ' title="Rename report folder" aria-label="Rename ' + escapeHTML(name) + '">'
            + '<i class="fas fa-pen" aria-hidden="true"></i></button>'
            : '';
        html += '<div class="vdrive-row folder" data-action="open-folder" data-path="' + escapeHTML(violationBrowserPath.concat(name).join('/')) + '"'
            + (ownerId ? ' data-report-id="' + escapeHTML(ownerId) + '"' : '')
            + ' role="button" tabindex="0" style="--i:' + index + '" title="Open ' + escapeHTML(name) + '">'
            + '<span class="vdrive-icon folder" aria-hidden="true"><i class="fas fa-folder"></i></span>'
            + renameBtn
            + '<span class="vdrive-name">' + escapeHTML(name) + '</span>'
            + '<span class="vdrive-meta">' + (bits.join(' · ') || 'empty') + '</span>'
            + '<span class="vdrive-chevron" aria-hidden="true"><i class="fas fa-chevron-right"></i></span></div>';
        index++;
    }

    for (const att of files) {
        const name = att.name || 'file';
        const size = att.bytes ? formatFileSize(att.bytes) : '';
        const url = normalizeFileUrl(att.secure_url);
        // Pictures and videos get a real preview (a Cloudinary poster frame for
        // clips); every other type keeps the large file-type icon as its preview.
        const previewable = (att.resource_type === 'image' || att.resource_type === 'video') && url;
        const thumbUrl = previewable ? getCloudinaryThumbUrl(url, 400, 300) : '';
        const thumb = thumbUrl
            ? '<img class="vdrive-thumb-img" src="' + escapeHTML(thumbUrl) + '" alt="" loading="lazy" decoding="async">'
            : '';
        const playBadge = att.resource_type === 'video' && thumbUrl
            ? '<span class="vdrive-play" aria-hidden="true"><i class="fas fa-play"></i></span>'
            : '';
        const canRename = violationRowCanRenameById(att._violationId || '');
        const renameBtn = canRename
            ? '<button type="button" class="vdrive-rename-btn" data-action="rename-file"'
            + ' title="Rename (display name — the original extension is kept)" aria-label="Rename ' + escapeHTML(name) + '">'
            + '<i class="fas fa-pen" aria-hidden="true"></i></button>'
            : '';
        html += '<div class="vdrive-row file ' + violationTreeFileTypeClass(att) + '" data-action="open-file" data-url="' + escapeHTML(url) + '"'
            + ' data-report-id="' + escapeHTML(att._violationId || '') + '"'
            + ' data-public-id="' + escapeHTML(att.public_id || '') + '"'
            + ' data-file-name="' + escapeHTML(name) + '"'
            + ' role="button" tabindex="0" style="--i:' + index + '" title="Open ' + escapeHTML(name) + ' in a new tab">'
            + '<span class="vdrive-icon" aria-hidden="true"><i class="fas ' + violationTreeFileIcon(att) + '"></i>' + thumb + playBadge + '</span>'
            + renameBtn
            + '<span class="vdrive-name">' + escapeHTML(name) + '</span>'
            + '<span class="vdrive-meta">' + escapeHTML(size || 'file') + '</span>'
            + '<span class="vdrive-chevron" aria-hidden="true"><i class="fas fa-external-link-alt"></i></span></div>';
        index++;
    }

    if (childNames.length === 0 && files.length === 0) {
        html += '<div class="vdrive-empty"><i class="far fa-folder-open"></i> This folder is empty</div>';
    }
    return html;
}

/** CSS hook name for the file row (drives the icon color per file type). */
function violationTreeFileTypeClass(att) {
    if (att.resource_type === 'image') return 'type-image';
    if (att.resource_type === 'video') return 'type-video';
    const n = (att.name || att.secure_url || '').toLowerCase();
    if (n.endsWith('.pdf')) return 'type-pdf';
    if (/\.(doc|docx|xls|xlsx|ppt|pptx|txt|csv)$/.test(n)) return 'type-doc';
    return 'type-file';
}

// ===== REPORTS DATABASE — RENAME =====
// Folders in this browser are DERIVED from the report's own fields (see
// violationReportFolderPath), so renaming a folder really means "edit the report
// and let the tree rebuild itself". Only the leaf "<Subject> - <Date>" folder maps
// 1:1 to a single report; every ancestor aggregates several reports, so renaming
// those would be a multi-document bulk write that can half-succeed (an operator
// may own only some of the reports underneath). "Branches" and "attachments" are
// structural constants the uploader and the PDF auto-save both depend on, so all
// of the above are hard-blocked.
//
// FILES are renamed by changing the display name stored in Firestore
// (attachments[].name) — that single field feeds every name the user sees: the
// tree row, the modal grid, the viewer title, the image alt text and the file-type
// icon. Cloudinary's rename endpoint is AUTHENTICATED-only (api_key + api_secret),
// and this app is a client-side, unsigned-upload-only client, so the api_secret
// must never be shipped here. The stored secure_url keeps working untouched.
//
// WHO may rename: EVERY signed-in operator or superadmin, on ANY report — the
// Firestore rules allow a rename-only update (attachments / subject / updatedAt)
// on any violations document. Editing and deleting reports stay ownership-gated
// (canModifyViolation).

/** Segments that are structural constants — renaming them breaks uploads/the tree. */
const VIOLATION_TREE_CONSTANT_SEGMENTS = ['attachments'];
/** "<Month> <Year>" buckets (e.g. "September 2026") are dates, not names. */
const VIOLATION_MONTH_YEAR_RE = /^[A-Z][a-z]+ \d{4}$/;

/**
 * Permission probe for the browser renderer, keyed by report id. Deliberately
 * defensive: the renderer also runs in stripped-down contexts (test harnesses)
 * where auth or the permission helper may be absent, and a failed probe simply
 * means the rename button is not rendered for that row. Rename is open to every
 * signed-in operator or superadmin — files and report folders alike — while
 * editing/deleting a report stays ownership-gated (canModifyViolation).
 */
function violationRowCanRenameById(reportId) {
    try {
        if (!reportId) return false;
        if (typeof allViolations === 'undefined') return false;
        return allViolations.some(x => x && x.id === reportId);
    } catch (error) {
        return false;
    }
}

/**
 * Classify a breadcrumb path for renaming.
 * @param {Array<string>} path      segments below the "Data base" root
 * @param {Array<string>} [base]    landing folder (defaults to "Branches")
 * @returns {{kind: 'report'|'blocked', reason?: string, name?: string}}
 */
function violationRenameTarget(path, base) {
    const p = Array.isArray(path) ? path : [];
    const b = Array.isArray(base) ? base : violationDefaultBrowserPath();
    if (p.length <= b.length) return { kind: 'blocked', reason: 'root' };
    const leaf = p[p.length - 1];
    if (VIOLATION_TREE_CONSTANT_SEGMENTS.indexOf(leaf) !== -1) return { kind: 'blocked', reason: 'constant' };
    if (VIOLATION_MONTH_YEAR_RE.test(leaf)) return { kind: 'blocked', reason: 'date-bucket' };
    // Branches / <Store> / <Month Year> / <Reporter> / <Subject> - <Date>
    if (p.length === b.length + 4) return { kind: 'report', name: leaf };
    return { kind: 'blocked', reason: 'aggregate' };
}

/**
 * Build the new display name for a file. The ORIGINAL extension is authoritative,
 * so the file-type icon/colour (.vdrive-row.type-*) never changes on rename even
 * if the user types a different extension — or none at all.
 */
function violationRenameFileName(oldName, input) {
    const old = String(oldName || '');
    const dot = old.lastIndexOf('.');
    const ext = dot > 0 ? old.slice(dot) : '';
    const typed = String(input == null ? '' : input).replace(/\.[^./\\]+$/, '');
    // An empty (or whitespace-only) input means "cancel", not "call it Unnamed".
    if (!typed.trim()) return { base: '', ext: '', full: '' };
    const base = violationSanitizeSegment(typed);
    return { base: base, ext: ext, full: base + ext };
}

/**
 * Rename one attachment's display name. Firestore-only: the Cloudinary asset is
 * deliberately left in place (unsigned clients cannot rename or destroy it), so
 * the stored secure_url and public_id stay valid.
 */
async function renameViolationAttachment(violationId, fileKey, newName) {
    const v = allViolations.find(x => x.id === violationId);
    if (!v) return;
    // Rename is open to every signed-in operator/superadmin (rename-only
    // permission in firestore.rules); it is NOT the ownership-gated edit.
    if (!currentUserIsSuperAdmin() && !(auth.currentUser && auth.currentUser.email)) {
        showToast('Sign in to rename files.', 'error');
        return;
    }

    const atts = Array.isArray(v.attachments) ? v.attachments : [];
    const keyOf = (a) => String((a && (a.public_id || a.publicId || a.secure_url || a.url)) || '');
    const idx = atts.findIndex(a => keyOf(a) === String(fileKey || ''));
    if (idx === -1) {
        showToast('That file is no longer attached to this report.', 'error');
        return;
    }

    const next = violationRenameFileName(atts[idx].name, newName);
    if (!next.full || next.full === atts[idx].name) return;   // nothing changed

    const updated = atts.slice();
    updated[idx] = Object.assign({}, atts[idx], { name: next.full });

    try {
        await firestoreService.updateViolation(violationId, { attachments: updated });
        v.attachments = updated;                              // keep the local cache in step
        showToast('Renamed to "' + next.full + '".', 'success');
        renderViolationFolderTree();
        renderViolationDetailsIfOpen();
    } catch (error) {
        console.error('Failed to rename attachment:', error);
        showToast('Could not rename the file.', 'error');
    }
}

/**
 * Ask for a file's new display name, then rename it. Uses the native prompt, the
 * same lightweight approach the delete confirmations already use.
 */
async function renameViolationAttachmentFromRow(row) {
    // The click may land on the nested rename <button>, which carries only
    // data-action — the file's data lives on the enclosing .vdrive-row.
    const gridRow = (row && row.closest && row.closest('.vdrive-row')) || row;
    if (!gridRow || !gridRow.dataset) return;
    const id = gridRow.dataset.reportId || '';
    const v = allViolations.find(x => x.id === id);
    if (!v) return;
    // Rename is not the ownership-gated edit: any signed-in user may rename.
    if (!currentUserIsSuperAdmin() && !(auth.currentUser && auth.currentUser.email)) {
        showToast('Sign in to rename files.', 'error');
        return;
    }
    const current = gridRow.dataset.fileName || '';
    const input = await showRenameDialog({
        title: 'Rename File',
        label: 'New file name',
        value: current,
        hint: 'The original extension is kept automatically.'
    });
    if (input === null) return;                               // cancelled
    await renameViolationAttachment(id, gridRow.dataset.publicId || '', input);
}

/**
 * Rename the leaf report folder with a single prompt. That folder's name is
 * derived from the report's subject ("<Subject> - <Date>"), so renaming means
 * updating ONLY the subject field — the Edit Violation form stays closed.
 * The incident date part of the folder name is untouched.
 */
async function renameViolationReportFolder(row) {
    // Same as the file case: the click target may be the nested <button>, whose
    // data lives on the enclosing .vdrive-row.
    const gridRow = (row && row.closest && row.closest('.vdrive-row')) || row;
    if (!gridRow || !gridRow.dataset) return;
    const id = gridRow.dataset.reportId || '';
    const v = allViolations.find(x => x.id === id);
    if (!v) return;
    // Rename is not the ownership-gated edit: any signed-in user may rename.
    if (!currentUserIsSuperAdmin() && !(auth.currentUser && auth.currentUser.email)) {
        showToast('Sign in to rename folders.', 'error');
        return;
    }

    const current = String(v.subject || '');
    const input = await showRenameDialog({
        title: 'Rename Folder',
        label: 'Folder name',
        value: current,
        hint: 'The incident date is added to the folder name automatically and stays unchanged.'
    });
    if (input === null) return;                               // cancelled
    const next = String(input).trim();
    if (!next) return;                                        // empty input = cancel
    if (next === current) return;                             // nothing changed

    try {
        await firestoreService.updateViolation(id, { subject: next });
        v.subject = next;                                     // keep the local cache in step
        showToast('Folder renamed to "' + violationSanitizeSegment(next) + '".', 'success');
        renderViolationFolderTree();
        renderViolationDetailsIfOpen();
    } catch (error) {
        console.error('Failed to rename report folder:', error);
        showToast('Could not rename the folder.', 'error');
    }
}

/** Refresh the Drive-style folder browser from ALL reports (independent of the table filter). */
function renderViolationFolderTree(options) {
    if (!violationFolderBrowser) return;
    const animate = !!(options && options.animate);

    if (!allViolations.length) {
        violationBrowserPath = [];
        lastViolationTreeRoot = null;
        renderViolationBreadcrumb();
        violationFolderBrowser.innerHTML = '<p class="violation-tree-empty"><i class="far fa-folder-open"></i> No violation reports to show.</p>';
        if (violationTreeCount) violationTreeCount.textContent = '(0 reports · 0 files)';
        violationFolderBrowser.classList.remove('nav-fwd', 'nav-back');
        return;
    }

    const { root, fileCount } = buildViolationFolderTree(allViolations);
    lastViolationTreeRoot = root;

    // First render (or any reset): open straight inside "Branches" so the
    // single-row "Data base" root level is never shown.
    if (!violationBrowserPath.length) violationBrowserPath = violationDefaultBrowserPath(root);

    // Keep the current location only if it still exists in the fresh tree.
    let node = root;
    const validPath = [];
    for (const seg of violationBrowserPath) {
        if (node.children && node.children[seg]) {
            node = node.children[seg];
            validPath.push(seg);
        } else break;
    }
    violationBrowserPath = validPath;

    if (violationTreeCount) {
        violationTreeCount.textContent =
            `(${allViolations.length} report${allViolations.length === 1 ? '' : 's'} · ${fileCount} file${fileCount === 1 ? '' : 's'})`;
    }

    renderViolationBreadcrumb();
    violationFolderBrowser.classList.remove('nav-fwd', 'nav-back');
    violationFolderBrowser.innerHTML = renderViolationBrowserLevel(node);

    // Direction-aware entrance animation for the new level (rows stagger via --i).
    if (animate) {
        void violationFolderBrowser.offsetWidth; // flush styles so the animation restarts
        violationFolderBrowser.classList.add(violationNavDirection === 'back' ? 'nav-back' : 'nav-fwd');
    }
    violationFolderBrowser.scrollTop = 0;
}

/** Enter a folder: brief press feedback on the row, then animate the next level in. */
function openViolationFolderRow(row) {
    if (!row || !violationFolderBrowser) return;
    if (violationFolderBrowser.classList.contains('is-navigating')) return;
    violationFolderBrowser.classList.add('is-navigating');
    row.classList.add('is-opening');
    const path = row.dataset.path ? row.dataset.path.split('/') : [];
    setTimeout(() => {
        if (violationFolderBrowser) violationFolderBrowser.classList.remove('is-navigating');
        navigateViolationBrowser(path, 'fwd');
    }, 120);
}

/** Go one level up (used by the Back button and the Backspace key). */
function violationGoUp() {
    // Never above the landing folder — Branches is the top of the browser.
    if (violationBrowserPath.length <= violationDefaultBrowserPath().length) return;
    navigateViolationBrowser(violationBrowserPath.slice(0, -1), 'back');
}

function bindViolationTreePanel() {
    if (btnToggleViolationTree && violationTreePanel) {
        btnToggleViolationTree.addEventListener('click', () => {
            const collapsed = violationTreePanel.classList.toggle('collapsed');
            // The chevron flip itself is done in CSS (smooth rotate), only the label changes here.
            const label = btnToggleViolationTree.querySelector('span');
            if (label) label.textContent = collapsed ? 'Show' : 'Hide';
            btnToggleViolationTree.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            btnToggleViolationTree.title = collapsed ? 'Show reports database' : 'Hide reports database';
        });
    }

    if (btnViolationBack) btnViolationBack.addEventListener('click', violationGoUp);
    if (btnViolationHome) btnViolationHome.addEventListener('click', () => navigateViolationBrowser(violationDefaultBrowserPath(), 'back'));

    // Breadcrumb: click a crumb to jump back to that level.
    if (violationBreadcrumb) {
        const jumpFromCrumb = (crumb) => {
            if (!crumb || crumb.classList.contains('current')) return;
            const path = crumb.dataset.path ? crumb.dataset.path.split('/') : [];
            navigateViolationBrowser(path, path.length < violationBrowserPath.length ? 'back' : 'fwd');
        };
        violationBreadcrumb.addEventListener('click', (e) => jumpFromCrumb(e.target.closest('.vb-crumb')));
        violationBreadcrumb.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const crumb = e.target.closest('.vb-crumb');
            if (!crumb) return;
            e.preventDefault();
            jumpFromCrumb(crumb);
        });
    }

    // Browser rows: the whole row is clickable (event delegation — quote-safe).
    if (violationFolderBrowser) {
        violationFolderBrowser.addEventListener('click', (e) => {
            const row = e.target.closest('[data-action]');
            if (!row) return;
            const action = row.dataset.action;
            if (action === 'open-folder') {
                openViolationFolderRow(row);
            } else if (action === 'open-file') {
                openAttachmentViewerForRow(row);
            } else if (action === 'rename-file') {
                renameViolationAttachmentFromRow(row);
            } else if (action === 'rename-folder') {
                renameViolationReportFolder(row);
            }
        });

        // A preview that fails to load (offline, private asset, transform refused) is
        // flagged so CSS drops the image and the large file-type icon shows instead.
        violationFolderBrowser.addEventListener('error', (e) => {
            const img = e.target;
            if (!img || !img.classList || !img.classList.contains('vdrive-thumb-img')) return;
            const row = img.closest('.vdrive-row');
            if (row) row.classList.add('thumb-missing');
        }, true);

        // Keyboard support: Enter / Space open, Backspace goes up one level.
        violationFolderBrowser.addEventListener('keydown', (e) => {
            const row = e.target.closest('[data-action]');
            if (!row) {
                if (e.key === 'Backspace') {
                    e.preventDefault();
                    violationGoUp();
                }
                return;
            }
            if (e.key !== 'Enter' && e.key !== ' ') return;
            // The nested rename <button> activates natively (Enter/Space fire a
            // click) — bail out so preventDefault doesn't swallow that click.
            if (row.dataset.action === 'rename-file' || row.dataset.action === 'rename-folder') return;
            e.preventDefault();
            if (row.dataset.action === 'open-folder') {
                openViolationFolderRow(row);
            } else if (row.dataset.action === 'open-file') {
                openAttachmentViewerForRow(row);
            }
        });
    }
}

// ===== IN-APP ATTACHMENT VIEWER (lightbox) =====
// The viewer itself now lives in js/attachment-viewer.js, so main.html and
// ownerdashboard.html share ONE implementation and ONE injected dialog. See
// that file's header for why duplicating it here was not an option.
//
// Two thin shims remain on this page:
//
//  * openAttachmentViewerForRow() feeds the viewer the violations folder-browser
//    rows. Those are divs carrying `data-url`, not anchors, so the shared
//    delegated click handler cannot see them. It passes #violationFolderBrowser
//    explicitly because the module takes the root as a PARAMETER -- that is
//    precisely so it never depends on a script.js-only global, which would be
//    undefined on the Owner Dashboard.
//  * bindAttachmentViewer() is now a no-op. It is kept so the call in initApp()
//    (and any future caller) stays valid; the module self-binds on
//    DOMContentLoaded. Calling init() twice is safe -- the module guards it.

function openAttachmentViewerForRow(row) {
    const viewer = window.AttachmentViewer;
    if (viewer) viewer.openForRows(violationFolderBrowser || document, row);
}

function bindAttachmentViewer() {
    const viewer = window.AttachmentViewer;
    if (viewer) viewer.init();
}

// ===== VIOLATIONS: EVENT BINDINGS + GLOBAL EXPORTS =====

function bindViolationEvents() {
    const cancelBtn = document.getElementById('cancelViolationForm');
    if (btnNewViolation) btnNewViolation.addEventListener('click', () => openViolationFormModal(null));
    if (closeViolationModalBtn) closeViolationModalBtn.addEventListener('click', closeViolationModal);
    if (closeViolationFormModalBtn) closeViolationFormModalBtn.addEventListener('click', closeViolationFormModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeViolationFormModal);
    if (violationModal) violationModal.addEventListener('click', (e) => { if (e.target === violationModal) closeViolationModal(); });
    // violationFormModal: backdrop click intentionally does NOT close — only the X button
    // (closeViolationFormModalBtn) and Cancel button close it, plus auto-close on submit.
    if (violationForm) violationForm.addEventListener('submit', saveViolationForm);
    if (violationSearch) violationSearch.addEventListener('input', debounce(filterViolations));
    if (violationStoreFilter) violationStoreFilter.addEventListener('change', filterViolations);
    if (violationUploadsFilter) violationUploadsFilter.addEventListener('change', filterViolations);
    if (violationPeriodFilter) {
        // Purely a view filter — no report is ever removed or deleted by this.
        violationPeriodFilter.addEventListener('change', filterViolations);
    }

    if (btnGenerateViolationReport) {
        // Generating the report is a VIEW action, so it stays available to everyone
        // who can open the report (unlike Edit/Delete in the hidden footer).
        btnGenerateViolationReport.addEventListener('click', () => {
            if (currentViolationId) generateViolationReport(currentViolationId);
        });
    }

    if (btnEditViolation) {
        btnEditViolation.addEventListener('click', () => {
            if (!currentViolationId) return;
            const id = currentViolationId;
            closeViolationModal();
            openViolationFormModal(id);
        });
    }
    if (btnDeleteViolation) {
        btnDeleteViolation.addEventListener('click', () => {
            if (currentViolationId) deleteViolationById(currentViolationId);
        });
    }
    if (btnTransferViolation) {
        // The button is a toggle: it transfers the open report to HR, or takes
        // it back if it is already there. toggleViolationTransfer() re-reads the
        // record, so the listener can stay in sync without any extra state.
        btnTransferViolation.addEventListener('click', () => {
            if (currentViolationId) toggleViolationTransfer(currentViolationId);
        });
    }
    if (btnTransferViolationToManager) {
        // The SECOND, independent toggle. Same shape as the HR one, but it
        // stamps managerStatus and leaves any HR transfer alone.
        btnTransferViolationToManager.addEventListener('click', () => {
            if (currentViolationId) toggleViolationTransferToManager(currentViolationId);
        });
    }

    bindViolationUploadWidget();
    bindViolationTreePanel();
}

// Expose handlers used by inline onclick attributes in the table rows.
window.openViolationModal = openViolationModal;
window.openViolationFormModal = openViolationFormModal;
window.deleteViolationById = deleteViolationById;
window.generateViolationReport = generateViolationReport;

document.addEventListener('DOMContentLoaded', () => {


    initAllUploadWidgets();
    bindViolationEvents();
    bindAttachmentViewer();
    initApp();
});
