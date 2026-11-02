// ==============================================================
//  DESKTOP NOTIFICATION SYSTEM
//  Real Windows/Action Center desktop notifications (like YouTube)
//  with notification sound on new tickets.
// ==============================================================

// ===== SOUND =====
// Local-first: the mixkit CDN URLs are the fallback, not the primary.
// An ad-blocker, a corporate firewall, or plain offline dev (Live Server
// has no internet guarantee) kills the CDN fetch SILENTLY — `new Audio()`
// never throws, `.play()` just never makes a sound, and every caller
// swallows the rejection. The local sounds/notify.mp3 + sounds/mention.mp3
// are byte-identical copies of the same two mixkit previews, so a blocked
// CDN changes nothing the user hears.
const NOTIFICATION_SOUND_URL = 'sounds/notify.mp3';
const NOTIFICATION_SOUND_FALLBACK_URL = 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3';
const NOTIFICATION_ICON_URL = 'tamang logo.png';
let notificationAudio = null;

function preloadNotificationSound() {
    try {
        if (!notificationAudio) {
            notificationAudio = new Audio(NOTIFICATION_SOUND_URL);
            notificationAudio.preload = 'auto';
            notificationAudio.load();
        }
    } catch (e) {
        console.warn('[Desktop Notifications] Sound preload failed:', e);
    }
}

function playNotificationSound() {
    try {
        if (!notificationAudio) {
            // Single `new Audio` construction: the CDN fallback swaps the SRC
            // on the same element instead of building a second object.
            notificationAudio = new Audio(NOTIFICATION_SOUND_URL);
            // If the local file 404s (e.g. an old hosting deploy that lacks
            // sounds/), fall back to the CDN copy instead of staying silent.
            notificationAudio.addEventListener('error', function handleSoundError() {
                notificationAudio.removeEventListener('error', handleSoundError);
                try {
                    notificationAudio.src = NOTIFICATION_SOUND_FALLBACK_URL;
                    notificationAudio.preload = 'auto';
                    notificationAudio.load();
                } catch (e) { /* fall through to the warn below */ }
            });
        }
        notificationAudio.pause();
        notificationAudio.currentTime = 0;
        // Always play at full volume: the silent autoplay-unlock (see
        // armAudioUnlockOnLogin) leaves the element at volume 0 for a moment,
        // and a real notification landing in that window must still be heard.
        notificationAudio.volume = 1;
        const p = notificationAudio.play();
        if (p && p.catch) p.catch(() => {});
    } catch (e) {
        console.warn('[Desktop Notifications] Sound play failed:', e);
    }
}

/**
 * Self-test: run `window.testNotificationSound()` in DevTools to prove the
 * whole path at once — file reachable, Audio decodable, autoplay allowed.
 * Logs exactly which step fails instead of staying silent.
 */
async function testNotificationSound() {
    const steps = [];
    try {
        const res = await fetch(NOTIFICATION_SOUND_URL, { method: 'HEAD' });
        steps.push('fetch ' + NOTIFICATION_SOUND_URL + ' → ' + res.status);
        if (!res.ok) throw new Error('sound file not reachable (HTTP ' + res.status + ')');
    } catch (e) {
        console.error('[Desktop Notifications] TEST FAILED at fetch:', e);
        return false;
    }
    try {
        const audio = new Audio(NOTIFICATION_SOUND_URL);
        await audio.play();
        audio.pause();
        steps.push('Audio.play() ok');
    } catch (e) {
        console.error('[Desktop Notifications] TEST FAILED at play (autoplay blocked? click the page first):', e);
        return false;
    }
    console.log('[Desktop Notifications] TEST OK —', steps.join(' | '), '| permission =', ('Notification' in window ? Notification.permission : 'unsupported'));
    return true;
}

// ===== TRACKING (prevents duplicate notifications) =====
const notifiedDocIds = new Set();

// ===== Store reference to the current window/tab =====
const NOTIFICATION_WINDOW = window;

// ===== PERMISSION =====
let _permissionResolved = false;

/**
 * Check the notification permission state. IMPORTANT: this only REPORTS the
 * current state — it must NOT call requestPermission() on page load, because
 * modern browsers (Chrome 71+, Edge, Firefox) only allow the permission prompt
 * from a real user gesture (click/tap) and will AUTO-DENY (and permanently
 * lock) the site when it's requested without one. Permission is requested from
 * a real click on the track page (submit-ticket.html) instead.
 */
async function ensureNotificationPermission() {
    if (_permissionResolved) return Notification.permission;
    _permissionResolved = true;

    if (!('Notification' in window)) {
        console.warn('[Desktop Notifications] Not supported in this browser.');
        return 'unsupported';
    }

    return Notification.permission;
}

// ===== SHOW DESKTOP NOTIFICATION =====

/**
 * Shared click-handler factory for ALL desktop notifications: focus the app
 * window/tab, switch to the Tickets tab, then smooth-scroll to and highlight
 * the ticket row. Keeps every notification type behaving exactly like the
 * new-ticket notification.
 */
function makeViolationClickHandler(violationId) {
    return function (event) {
        event.preventDefault();
        NOTIFICATION_WINDOW.focus();
        requestAnimationFrame(() => {
            // Switch to Violations tab
            const violationsTab = NOTIFICATION_WINDOW.document.querySelector('.tab-content#tabViolations');
            if (violationsTab && !violationsTab.classList.contains('active')) {
                NOTIFICATION_WINDOW.document.querySelectorAll('.nav-item').forEach(item => {
                    item.classList.toggle('active', item.dataset.tab === 'violations');
                });
                NOTIFICATION_WINDOW.document.querySelectorAll('.tab-content').forEach(tab => {
                    tab.classList.toggle('active', tab.id === 'tabViolations');
                });
                const titleEl = NOTIFICATION_WINDOW.document.getElementById('pageTitle');
                const subEl = NOTIFICATION_WINDOW.document.getElementById('pageSubtitle');
                if (titleEl) titleEl.textContent = 'Violations';
                if (subEl) subEl.textContent = 'Violation Reports';
            }
            requestAnimationFrame(() => {
                const row = NOTIFICATION_WINDOW.document.querySelector(`tr[data-violation-id="${CSS.escape(violationId)}"]`);
                if (row) {
                    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    row.classList.add('violation-row-highlight');
                    setTimeout(() => row.classList.remove('violation-row-highlight'), 5000);
                }
            });
        });
        this.close();
    };
}

function makeTicketClickHandler(ticketId) {
    return function (event) {
        event.preventDefault();
        NOTIFICATION_WINDOW.focus();
        // Debounce to avoid Firestore race conditions
        requestAnimationFrame(() => {
            // Switch to Tickets tab using stored reference
            const ticketsTab = NOTIFICATION_WINDOW.document.querySelector('.tab-content#tabTickets');
            if (ticketsTab && !ticketsTab.classList.contains('active')) {
                // Direct DOM manipulation instead of switchTab to avoid Firestore re-renders
                NOTIFICATION_WINDOW.document.querySelectorAll('.nav-item').forEach(item => {
                    item.classList.toggle('active', item.dataset.tab === 'tickets');
                });
                NOTIFICATION_WINDOW.document.querySelectorAll('.tab-content').forEach(tab => {
                    tab.classList.toggle('active', tab.id === 'tabTickets');
                });
                const titles = { dashboard: 'Dashboard', branches: 'Branch Monitor', history: 'Status History', tickets: 'Tickets' };
                const subtitles = { dashboard: 'Overview & Analytics', branches: 'Real-time Branch Health Status', history: 'Status Change Logs', tickets: 'Incident Ticket Management' };
                const titleEl = NOTIFICATION_WINDOW.document.getElementById('pageTitle');
                const subEl = NOTIFICATION_WINDOW.document.getElementById('pageSubtitle');
                if (titleEl) titleEl.textContent = titles.tickets;
                if (subEl) subEl.textContent = subtitles.tickets;
            }
            // Scroll to ticket row
            requestAnimationFrame(() => {
                const row = NOTIFICATION_WINDOW.document.querySelector(`tr[data-ticket-id="${CSS.escape(ticketId)}"]`);
                if (row) {
                    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    row.classList.add('ticket-row-highlight');
                    setTimeout(() => row.classList.remove('ticket-row-highlight'), 5000);
                }
            });
        });
        this.close();
    };
}

/**
 * Show a REAL desktop notification (Windows Action Center / macOS / Android).
 * Same as YouTube, Slack, Discord, etc.
 * Returns the Notification object or null on failure.
 */
function showDesktopNotification(ticket) {
    try {
        const ticketId = ticket.id || ticket.ticketNumber || 'unknown';
        const branch = ticket.branch || 'Unknown';
        const subject = ticket.incident || 'N/A';
        const reporter = ticket.name || 'Unknown';

        // Format the time
        let timeStr = '';
        try {
            const d = ticket.createdAt?.toDate ? ticket.createdAt.toDate() : new Date(ticket.createdAt || Date.now());
            timeStr = d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
        } catch { timeStr = ''; }

        const notification = new Notification('🚨 New CCTV Ticket — Jiangnan Command Center', {
            body: `Branch: ${branch}\nIncident: ${subject}\nReported by: ${reporter}${timeStr ? '\n' + timeStr : ''}`,
            icon: NOTIFICATION_ICON_URL,
            tag: `ticket-${ticketId}`,
            requireInteraction: true,  // Notification stays until user clicks/dismisses
            silent: true               // We handle sound ourselves
        });

        // Click handler — focus the existing tab and scroll to ticket
        notification.onclick = makeTicketClickHandler(ticketId);

        // Auto-close after 30 seconds (safety)
        setTimeout(() => { try { notification.close(); } catch {} }, 30000);

        return notification;
    } catch (e) {
        console.error('[Desktop Notifications] Failed to show:', e);
        return null;
    }
}

// ===== SHOW STATUS-CHANGE DESKTOP NOTIFICATIONS =====

/**
 * Show a desktop notification when additional footage is requested for a ticket
 * (the track-page "Request Additional" hand-off that moves the ticket to
 * "Insufficient Footage").
 * Returns the Notification object or null on failure.
 */
function showFootageRequestNotification(ticket) {
    try {
        const ticketId = ticket.id || ticket.ticketNumber || 'unknown';
        const branch = ticket.branch || 'Unknown';

        // Most recent footage_request note (appended by the track-page flow)
        let requester = 'Unknown';
        let details = '';
        const notes = Array.isArray(ticket.comments) ? ticket.comments : [];
        for (let i = notes.length - 1; i >= 0; i--) {
            const n = notes[i];
            if (n && n.type === 'footage_request') {
                requester = n.requestedBy || 'Unknown';
                details = n.text || '';
                break;
            }
        }

        const notification = new Notification('🎥 Additional Footage Requested — Jiangnan Command Center', {
            body: `Ticket: ${ticket.ticketNumber || ticketId}\nBranch: ${branch}\nRequested by: ${requester}` + (details ? `\nDetails: ${details}` : ''),
            icon: NOTIFICATION_ICON_URL,
            tag: `footage-ticket-${ticketId}`,
            requireInteraction: true,  // Notification stays until user clicks/dismisses
            silent: true               // We handle sound ourselves
        });

        // Click handler — focus the existing tab and scroll to ticket
        notification.onclick = makeTicketClickHandler(ticketId);

        // Auto-close after 30 seconds (safety)
        setTimeout(() => { try { notification.close(); } catch {} }, 30000);

        return notification;
    } catch (e) {
        console.error('[Desktop Notifications] Failed to show footage request:', e);
        return null;
    }
}

/**
 * Show a desktop notification when a superadmin rejects a submitted
 * (Pending Approval) resolution, sending the ticket back "For Revision".
 * Returns the Notification object or null on failure.
 */
function showTicketRejectedNotification(ticket) {
    try {
        const ticketId = ticket.id || ticket.ticketNumber || 'unknown';
        const branch = ticket.branch || 'Unknown';
        const rejection = ticket.rejection || {};
        const rejectedBy = rejection.rejectedBy || ticket.rejectedBy || 'Unknown';
        const reason = rejection.reason || ticket.rejectionReason || ticket.approvalReason || '';

        const notification = new Notification('❌ Resolution Rejected — Jiangnan Command Center', {
            body: `Ticket: ${ticket.ticketNumber || ticketId}\nBranch: ${branch}\nRejected by: ${rejectedBy}` + (reason ? `\nReason: ${reason}` : ''),
            icon: NOTIFICATION_ICON_URL,
            tag: `rejected-ticket-${ticketId}`,
            requireInteraction: true,  // Notification stays until user clicks/dismisses
            silent: true               // We handle sound ourselves
        });

        // Click handler — focus the existing tab and scroll to ticket
        notification.onclick = makeTicketClickHandler(ticketId);

        // Auto-close after 30 seconds (safety)
        setTimeout(() => { try { notification.close(); } catch {} }, 30000);

        return notification;
    } catch (e) {
        console.error('[Desktop Notifications] Failed to show rejection:', e);
        return null;
    }
}

/**
 * Count how many footage_request notes exist on a ticket so repeat requests can
 * be detected even when the status is already "Insufficient Footage".
 */
function countFootageRequests(comments) {
    if (!Array.isArray(comments)) return 0;
    let count = 0;
    for (const n of comments) {
        if (n && n.type === 'footage_request') count++;
    }
    return count;
}

/**
 * Count how many re-access (reopen) requests exist on a ticket so repeat
 * requests from the expired track page still notify the dashboard.
 */
function countAccessReopenRequests(comments) {
    if (!Array.isArray(comments)) return 0;
    let count = 0;
    for (const n of comments) {
        if (n && n.type === 'access_reopen_request') count++;
    }
    return count;
}

/**
 * Show a desktop notification when the manager/store asks for viewing access to
 * be re-opened from the expired Track page (reason attached). The Superadmin is
 * still the one who restores access via Resend.
 * Returns the Notification object or null on failure.
 */
function showAccessReopenRequestNotification(ticket) {
    try {
        const ticketId = ticket.id || ticket.ticketNumber || 'unknown';
        const branch = ticket.branch || 'Unknown';

        // Most recent access_reopen_request note (appended by the track page)
        let requester = 'Unknown';
        let reason = '';
        const notes = Array.isArray(ticket.comments) ? ticket.comments : [];
        for (let i = notes.length - 1; i >= 0; i--) {
            const n = notes[i];
            if (n && n.type === 'access_reopen_request') {
                requester = n.requestedBy || 'Unknown';
                reason = n.text || '';
                break;
            }
        }

        const notification = new Notification('📩 Re-access Requested — Jiangnan Command Center', {
            body: `Ticket: ${ticket.ticketNumber || ticketId}\nBranch: ${branch}\nRequested by: ${requester}` + (reason ? `\nReason: ${reason}` : ''),
            icon: NOTIFICATION_ICON_URL,
            tag: `reopen-ticket-${ticketId}`,
            requireInteraction: true,  // Notification stays until user clicks/dismisses
            silent: true               // We handle sound ourselves
        });

        // Click handler — focus the existing tab and scroll to ticket
        notification.onclick = makeTicketClickHandler(ticketId);

        // Auto-close after 30 seconds (safety)
        setTimeout(() => { try { notification.close(); } catch {} }, 30000);

        return notification;
    } catch (e) {
        console.error('[Desktop Notifications] Failed to show re-access request:', e);
        return null;
    }
}

/**
 * Detect ticket status transitions that deserve a desktop notification and fire
 * one:
 *  1. Additional footage requested  -> status becomes "Insufficient Footage",
 *                                      OR a new footage_request note is added
 *                                      (repeat requests still notify).
 *  2. Resolution rejected           -> status becomes "For Revision" /
 *                                      approvalStatus becomes "rejected"
 *  3. Re-access requested           -> a new access_reopen_request note is
 *                                      added from the expired Track page
 *                                      (reason attached; superadmin resends).
 * Called from script.js whenever the real-time listener reports a 'modified'
 * change. Returns a short in-app notification-bar message ('' if nothing fired)
 * so the dashboard can keep the in-page toast in sync.
 *
 * NOTE: notifications are intentionally NOT suppressed for the requesting /
 * rejecting user. The "Request Additional Footage" action happens on the track
 * page (different window/tab), so the dashboard user who initiated it still
 * wants to see the confirmation on their own screen.
 */
function notifyTicketStatusChange(prev, ticket) {
    if (!prev || !ticket || !ticket.id) return '';
    if (!('Notification' in window)) return '';   // Not supported in this browser

    const docId = ticket.id;
    const prevStatus = prev.status || '';
    const newStatus = ticket.status || '';
    const prevApproval = prev.approvalStatus || 'pending';
    const newApproval = ticket.approvalStatus || 'pending';
    const ticketLabel = ticket.ticketNumber || docId;
    const branch = ticket.branch || 'Unknown';

    // 1. Additional footage request (track-page hand-off).
    const prevFootageCount = countFootageRequests(prev.comments);
    const newFootageCount = countFootageRequests(ticket.comments);
    const footageFreshlyRequested =
        newFootageCount > prevFootageCount ||
        (newStatus === 'Insufficient Footage' && prevStatus !== 'Insufficient Footage');

    if (footageFreshlyRequested) {
        playNotificationSound();
        // Show the desktop notification only if permission is granted (no UI nag otherwise).
        if (Notification.permission === 'granted') {
            showFootageRequestNotification(ticket);
        }
        return `Additional footage requested for ${ticketLabel} from ${branch}`;
    }

    // 2. Resolution rejected by a superadmin
    const becameRejected =
        (newStatus === 'For Revision' || newApproval === 'rejected') &&
        !(prevStatus === 'For Revision' || prevApproval === 'rejected');
    if (becameRejected) {
        playNotificationSound();
        // Show the desktop notification only if permission is granted (no UI nag otherwise).
        if (Notification.permission === 'granted') {
            showTicketRejectedNotification(ticket);
        }
        return `Resolution for ${ticketLabel} was rejected (${branch})`;
    }

    // 3. Re-access requested (expired track page: manager asks for viewing
    //    access to be re-opened; a reason is attached). Count-based so repeat
    //    requests still notify, while a fulfilment (Resend) never re-fires.
    const prevReopenCount = countAccessReopenRequests(prev.comments);
    const newReopenCount = countAccessReopenRequests(ticket.comments);
    if (newReopenCount > prevReopenCount) {
        playNotificationSound();
        if (Notification.permission === 'granted') {
            showAccessReopenRequestNotification(ticket);
        }
        return `Re-access requested for ${ticketLabel} (${branch}) — resend to restore viewing`;
    }

    // 4. Ticket transferred to HR by superadmin
    const prevTransferTo = prev.ticketTransferTo || '';
    const newTransferTo = ticket.ticketTransferTo || '';
    if (newTransferTo === 'hr' && prevTransferTo !== 'hr') {
        playNotificationSound();
        if (Notification.permission === 'granted') {
            showTicketTransferredNotification(ticket);
        }
        return `Ticket ${ticketLabel} transferred to HR (${branch})`;
    }

    return '';
}

/**
 * Show a desktop notification when a superadmin transfers a ticket to HR.
 * Returns the Notification object or null on failure.
 */
function showTicketTransferredNotification(ticket) {
    try {
        const ticketId = ticket.id || ticket.ticketNumber || 'unknown';
        const branch = ticket.branch || 'Unknown';
        const transferredBy = ticket.transferredByName || ticket.transferredBy || 'Superadmin';
        const notification = new Notification('Ticket Transferred to HR — Jiangnan Command Center', {
            body: `Ticket: ${ticket.ticketNumber || ticketId}
Branch: ${branch}
Transferred by: ${transferredBy}`,
            icon: NOTIFICATION_ICON_URL,
            tag: `transfer-ticket-${ticketId}`,
            requireInteraction: true,
            silent: true
        });
        notification.onclick = makeTicketClickHandler(ticketId);
        setTimeout(() => { try { notification.close(); } catch {} }, 30000);
        return notification;
    } catch (e) {
        console.error('[Desktop Notifications] Failed to show ticket transfer:', e);
        return null;
    }
}

/**
 * Show a desktop notification when a superadmin transfers a violation to HR.
 * Returns the Notification object or null on failure.
 */
function showViolationTransferredNotification(violation) {
    try {
        const violationId = violation.id || violation.violationNumber || 'unknown';
        const store = violation.store || 'Unknown';
        const transferredBy = violation.transferredByName || violation.transferredBy || 'Superadmin';
        const notification = new Notification('Violation Transferred to HR — Jiangnan Command Center', {
            body: `Report: ${violation.violationNumber || violationId}
Store: ${store}
Transferred by: ${transferredBy}`,
            icon: NOTIFICATION_ICON_URL,
            tag: `transfer-violation-${violationId}`,
            requireInteraction: true,
            silent: true
        });
        notification.onclick = makeViolationClickHandler(violationId);
        setTimeout(() => { try { notification.close(); } catch {} }, 30000);
        return notification;
    } catch (e) {
        console.error('[Desktop Notifications] Failed to show violation transfer:', e);
        return null;
    }
}

/**
 * Notify that a violation was transferred to HR. Plays sound + desktop notification.
 */
function notifyViolationTransferred(violation) {
    if (!violation || !violation.id) return '';
    if (!('Notification' in window)) return '';
    playNotificationSound();
    if (Notification.permission === 'granted') {
        showViolationTransferredNotification(violation);
    }
    return `Violation ${violation.violationNumber || violation.id} transferred to HR`;
}

function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// A small checkmark that DRAWS itself (stroke-dashoffset) inside a success
// toast. Deliberately restrained: this is an operations console, and confetti
// in a CCTV tool would read as unserious. The animation is CSS-only and is
// disabled under prefers-reduced-motion, where the tick simply appears.
//
// The path is returned rather than set here so the markup stays in one place.
const TOAST_CHECK_SVG =
    '<svg class="toast-draw-check" viewBox="0 0 24 24" aria-hidden="true">' +
        '<circle class="toast-check-ring" cx="12" cy="12" r="10" />' +
        '<path class="toast-check-tick" d="M7 12.5l3.2 3.2L17 9" />' +
    '</svg>';

function showToast(message, type = 'info', duration = 4000) {
    if (!message) return;
    let container = document.getElementById('toastNotificationContainer');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toastNotificationContainer';
        document.body.appendChild(container);
    }

    // Only the three types the app actually uses get a modifier class; anything
    // else falls back to the neutral 'info' styling rather than rendering an
    // unstyled toast.
    const variant = (type === 'error' || type === 'success' || type === 'info') ? type : 'info';

    const toast = document.createElement('div');
    // Styling lives in style.css (`.toast-notification--*`) rather than in an
    // inline cssText block. The old inline version hardcoded #dc2626 / #15803d /
    // #1e293b, which is the same class of bug README-interface.md documents for
    // ownerdashboard.html: a fixed light-only colour that cannot follow the theme.
    toast.className = 'toast-notification toast-notification--' + variant;
    toast.setAttribute('role', variant === 'error' ? 'alert' : 'status');
    // The message is escaped: it routinely carries branch names, ticket
    // subjects and reporter emails.
    toast.innerHTML =
        (variant === 'success' ? TOAST_CHECK_SVG : '') +
        '<span class="toast-text">' + escapeHTML(message) + '</span>';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'toast-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute('aria-label', 'Dismiss notification');
    closeBtn.addEventListener('click', () => dismissToast(toast));
    toast.appendChild(closeBtn);

    container.appendChild(toast);
    // A single frame after insertion so the entry transition has an initial
    // state to animate FROM (same trick the chat reaction picker uses).
    requestAnimationFrame(() => toast.classList.add('is-visible'));

    let removed = false;
    function dismissToast(el) {
        // Guard against a double dismiss: the close button and the timeout can
        // both fire, and removing twice would throw on a detached node.
        if (removed) return;
        removed = true;
        el.classList.remove('is-visible');
        el.classList.add('is-leaving');
        setTimeout(() => el.remove(), 250);
    }

    setTimeout(() => dismissToast(toast), duration);
}

window.showToast = showToast;

// ===== PUBLIC API =====

/**
 * Handle a new ticket — show desktop notification + play sound.
 * Called from script.js when a new ticket arrives via Firestore.
 */
function notifyNewTicket(ticket) {
    if (!('Notification' in window)) return;
    const docId = ticket.id;
    if (!docId || notifiedDocIds.has(docId)) return;
    notifiedDocIds.add(docId);

    // 1. Play notification sound
    playNotificationSound();

    // 2. Show desktop notification if permitted (no UI nag if not granted)
    if (Notification.permission === 'granted') {
        showDesktopNotification(ticket);
    }
}

/**
 * Initialize the desktop notification system.
 * Call once on page load.
 *
 * We deliberately do NOT call Notification.requestPermission() here: on page
 * load there is no user gesture, and Chrome/Edge auto-deny such requests and
 * permanently lock the site. Permission is requested from a real click on the
 * track page (submit-ticket.html) when the user submits a footage request.
 */
/**
 * Autoplay-policy unlock: browsers refuse Audio.play() until the user has
 * interacted with the page, and the first successful play unlocks sound for
 * the rest of the session. The dashboard has a single entry gesture (the
 * password login button) every session — hooking the FIRST click anywhere
 * unlocks sound without any extra UI.
 *
 * ⚠️ THE UNLOCK IS SILENT. It used to call playNotificationSound() outright,
 * so the first click after EVERY refresh played the full notification chime —
 * an unnecessary "ding" users heard whenever they reloaded. play() still runs
 * (inside the real click gesture, which is what satisfies the autoplay
 * policy), just at volume 0, and the volume is restored right after the
 * element is paused. Real alerts (new ticket, mention, rejection) still play
 * at full volume — playNotificationSound() resets volume to 1 before playing.
 *
 * Idempotent: safe to call from every login form on every page.
 */
function armAudioUnlockOnLogin() {
    if (window.__rcmsAudioUnlockArmed) return;
    window.__rcmsAudioUnlockArmed = true;
    document.addEventListener('click', function unlockOnce() {
        document.removeEventListener('click', unlockOnce);
        try {
            preloadNotificationSound();
            if (!notificationAudio) return;
            const prevVolume = notificationAudio.volume;
            notificationAudio.volume = 0;
            const restore = function () {
                try {
                    notificationAudio.pause();
                    notificationAudio.currentTime = 0;
                    notificationAudio.volume = prevVolume;
                } catch (e) { /* ignore */ }
            };
            const p = notificationAudio.play();
            if (p && p.then) p.then(restore, restore);
            else restore();
        } catch (e) { /* ignore */ }
    });
}

async function initDesktopNotifications() {
    preloadNotificationSound();
    armAudioUnlockOnLogin();
    const perm = await ensureNotificationPermission();

    if (perm === 'granted') {
        console.log('[Desktop Notifications] ✅ Active — you will receive desktop notifications for new tickets, footage requests, and rejections.');
    } else if (perm === 'default') {
        console.log('[Desktop Notifications] ℹ️ Permission not granted. Notifications are requested from a real click on the track page.');
    } else if (perm === 'denied') {
        console.log('[Desktop Notifications] ❌ Permission denied in the browser.');
    } else {
        console.log('[Desktop Notifications] ℹ️ Unsupported or unknown permission state.');
    }
}

// ===== PERMISSION REQUEST (from a user gesture only) =====
//
// Desktop notifications on the dashboards never fired: every `show...` call
// is wrapped in `Notification.permission === 'granted'`, but the permission
// was only ever requested on the public track page (submit-ticket.html),
// where operators and superadmins do not go. The bell button wired below is
// how staff finally opt in — requestPermission() runs INSIDE the click, so it
// has the user activation browsers demand. Calling it on page load would be
// auto-denied and PERMANENTLY lock the site.
//
// Returns the resulting permission ('granted' / 'denied' / 'default' /
// 'unsupported'). Calling again after a decision is a cheap no-op.
async function requestNotificationPermissionFromGesture() {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission !== 'default') return Notification.permission;
    try {
        return await Notification.requestPermission();
    } catch (e) {
        return Notification.permission;
    }
}

function notificationPermissionState() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
}

/**
 * Wire a bell button (`<button class="icon-btn">` with an <i> inside) to the
 * permission request and keep its look in sync with the permission state.
 * Null-guarded: calling it for a button the page does not have is safe.
 */
function bindNotificationBell(btn) {
    if (!btn) return;
    const paint = () => {
        const perm = notificationPermissionState();
        const granted = perm === 'granted';
        const icon = btn.querySelector('i');
        if (icon) icon.className = granted ? 'fas fa-bell' : 'fas fa-bell-slash';
        if (granted) btn.classList.add('notif-on'); else btn.classList.remove('notif-on');
        const label = perm === 'granted' ? 'Desktop notifications: ON'
            : perm === 'denied' ? 'Desktop notifications blocked - allow them in your browser settings'
            : 'Enable desktop notifications';
        btn.title = label;
        btn.setAttribute('aria-label', label);
    };
    btn.addEventListener('click', async () => {
        const result = await requestNotificationPermissionFromGesture();
        paint();
        try {
            if (result === 'granted') {
                playNotificationSound();
                showToast('Desktop notifications are on', 'success');
            } else if (result === 'denied') {
                showToast('Notifications are blocked - allow them in your browser settings.', 'error');
            } else if (result === 'unsupported') {
                showToast('This browser does not support desktop notifications.', 'error');
            }
        } catch (e) { /* bell feedback is best-effort */ }
    });
    paint();
}

// ===== EXPOSE GLOBALLY =====
window.initDesktopNotifications = initDesktopNotifications;
window.bindNotificationBell = bindNotificationBell;
window.requestNotificationPermissionFromGesture = requestNotificationPermissionFromGesture;
window.notifyNewTicket = notifyNewTicket;
window.notifyTicketStatusChange = notifyTicketStatusChange;
window.notifyViolationTransferred = notifyViolationTransferred;
// ⚠️ EXPORTED FOR THE CHAT, AND THE EXPORT IS LOAD-BEARING.
// js/chat.js guards on `typeof window.playNotificationSound === 'function'`
// to reuse this preloaded sound rather than constructing its own. Without this
// line the guard is ALWAYS false, the chat silently falls through to a private
// Audio object, and the "reuse the shared, preloaded notification sound" path
// in playIncomingSound() is dead code that can never run.
window.playNotificationSound = playNotificationSound;
window.testNotificationSound = testNotificationSound;
window.armAudioUnlockOnLogin = armAudioUnlockOnLogin;
