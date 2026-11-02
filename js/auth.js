/**
 * Authentication Module
 * Handles login/logout using Firebase Auth
 */

// ==============================================================
// DOM REFERENCES
// ==============================================================

const loginForm = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('loginBtn');
const messageEl = document.getElementById('message');

// ==============================================================
// PAGE GATING
//
// The redirect to login.html was DISABLED (the body of the `if` was
// commented out to "allow public access to index"), which let anyone
// type main.html and land on the dashboard shell unauthenticated.
//
// Two rules this must respect, or real users get locked out:
//   * PROTECTED: main.html, ownerdashboard.html  -> require a login
//   * PUBLIC:    login.html, submit-ticket.html, pending-approval.html
//     submit-ticket.html is the PUBLIC complaint form and is never gated;
//     pending-approval.html is where a not-yet-approved user is sent, so
//     gating it would trap them in a redirect loop.
// ==============================================================

const PROTECTED_PAGES = ['main.html', 'ownerdashboard.html'];

/** Last path segment, e.g. '/a/b/main.html' -> 'main.html'. */
function currentPageName(pathname) {
    const raw = String(pathname == null ? '' : pathname);
    const last = raw.split('/').pop() || '';
    // Strip a query/hash if one somehow rode along, and case-normalise.
    return last.split('?')[0].split('#')[0].toLowerCase();
}

function isProtectedPage(pathname) {
    return PROTECTED_PAGES.indexOf(currentPageName(pathname)) > -1;
}

// ==============================================================
// ACCOUNT STATUS GATE
//
// Signing in and being ALLOWED INTO a dashboard are two different
// things. Firebase Auth will happily keep a session alive for an
// account a superadmin has already rejected, and BOTH checks below
// used to test only `status === 'pending'` — so a rejected account
// (`status: 'rejected'`, written by script.js on Reject) fell
// through to the role routing and landed on ownerdashboard.html as
// if nothing had happened.
//
// These are the statuses that must never reach a dashboard. The
// list mirrors pending-approval.html exactly, which already knows
// how to explain each one ("Still pending…" / "This account
// request was not approved…").
//
// ⚠️ DELIBERATELY NOT "anything that isn't approved": a user doc
// written before the status field existed (or an unrecognised
// value) still gets in, exactly as before. Failing closed here
// could lock out real accounts whose only crime is a missing
// field — a worse bug than the one this fixes.
// ==============================================================
const GATED_ACCOUNT_STATUSES = ['pending', 'rejected', 'denied'];

/**
 * 'pending-approval.html' when this account status must be kept out of
 * every dashboard, '' when the account may proceed.
 *
 * Normalised (trim + lowercase) because the value is compared, not
 * displayed, and a stray 'REJECTED ' would otherwise slip through.
 */
function gatedAccountPage(status) {
    const s = String(status == null ? '' : status).trim().toLowerCase();
    return GATED_ACCOUNT_STATUSES.indexOf(s) > -1 ? 'pending-approval.html' : '';
}

/**
 * A ticket number is `[A-Z]{3}-TIX\d+` in practice (BNW-TIX007), but this gate
 * is deliberately looser than that pattern on purpose: it exists to stop a
 * crafted `?ticket=` from smuggling anything into the URL we re-emit after
 * login (a second `?`, a `#`, a `/`, an encoded scheme), NOT to validate the
 * real numbering scheme. A pattern that rejected a legitimately-numbered future
 * ticket would be a worse bug than the one it prevents.
 */
const SAFE_TICKET_PARAM = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Read `?ticket=` from a search string, or '' when absent/unsafe.
 * NEVER returns anything that could alter the shape of the URL it is spliced
 * into — that is the whole point of the allowlist.
 */
function readSafeTicketParam(search) {
    try {
        const raw = new URLSearchParams(search || '').get('ticket');
        if (!raw) return '';
        const value = String(raw).trim();
        return SAFE_TICKET_PARAM.test(value) ? value : '';
    } catch (err) {
        return '';
    }
}

/**
 * Send the visitor to the login screen, remembering where they were
 * headed so login can return them there.
 *
 * `location.replace` (not `href`) so the BACK button cannot walk from the
 * login page straight back into the protected page.
 *
 * ⚠️ The `?ticket=` deep link (the approval email points at
 * `ownerdashboard.html?ticket=BNW-TIX007`) MUST ride along, otherwise a manager
 * who is not yet signed in clicks the link, signs in, and lands on a dashboard
 * with no indication of which ticket was approved — the deep link silently
 * becoming a no-op. It travels as its OWN parameter rather than being baked
 * into `next`, because `next` is validated against PROTECTED_PAGES and must
 * stay a bare page name.
 */
function redirectToLogin() {
    const here = currentPageName(window.location.pathname);
    let target = 'login.html?next=' + encodeURIComponent(here);
    const ticket = readSafeTicketParam(window.location.search);
    if (ticket) target += '&ticket=' + encodeURIComponent(ticket);
    window.location.replace(target);
}

// Exposed for the unit test (test/auth-guard.test.js), which runs this
// block in a vm sandbox where a bare `const` would not reach the global.
window.__authGuardInternals = {
    PROTECTED_PAGES: PROTECTED_PAGES,
    currentPageName: currentPageName,
    isProtectedPage: isProtectedPage,
    readSafeTicketParam: readSafeTicketParam,
    GATED_ACCOUNT_STATUSES: GATED_ACCOUNT_STATUSES,
    gatedAccountPage: gatedAccountPage
};

// ==============================================================
// LOGIN
// ==============================================================

/**
 * Re-attach a validated `?ticket=` to the page we are about to send the user to.
 *
 * ⚠️ SECURITY — the value is passed through `readSafeTicketParam()` again, NOT
 * forwarded blind. This page is reachable by anyone editing a URL, and the value
 * is spliced into a `location.href`; one carrying `?`, `#`, `/` or a scheme
 * could otherwise redirect the login off-site. The allowlist is applied at BOTH
 * ends of the round trip on purpose — once on the way in (redirectToLogin) and
 * once on the way out (here) — so neither end has to trust the other.
 *
 * Returns the page name unchanged when there is nothing safe to carry.
 */
function withTicketParam(page) {
    const ticket = readSafeTicketParam(window.location.search);
    return ticket ? page + '?ticket=' + encodeURIComponent(ticket) : page;
}

// Roles are managed in Firebase user documents, not in hardcoded app code.
async function resolveLoginDestination(user) {
    // `?next=` is set by redirectToLogin() so a user bounced off a protected
    // page lands back on it. Only ever honoured for a page in the known
    // PROTECTED_PAGES list — accepting an arbitrary value would be an open
    // redirect (someone could send you to an external phishing page).
    let next = null;
    try {
        const raw = new URLSearchParams(window.location.search || '').get('next');
        if (raw) {
            const candidate = currentPageName(String(raw).trim());
            if (PROTECTED_PAGES.indexOf(candidate) > -1) next = candidate;
        }
    } catch (err) {
        console.warn('Could not read ?next= from the URL:', err && err.message ? err.message : err);
    }

    try {
        const email = user && user.email ? user.email : '';
        const profile = await window.getUserProfile(email);
        const data = profile || null;

        // NOT just `=== 'pending'`: a rejected account must be stopped here too,
        // or the role routing below happily hands a rejected Area Manager the
        // ownerdashboard.html it was rejecting them from.
        const gated = gatedAccountPage(data && data.status);
        if (gated) return gated;

        const role = (data && data.role) || 'operator';
        if (role === 'superadmin') return withTicketParam(next || 'main.html');
        // 'hr' and 'rmsm' use the SAME dashboard as an owner — the only differences
        // are the profile label and chat access — so both route here.
        if (role === 'owner' || role === 'hr' || role === 'rmsm') return withTicketParam('ownerdashboard.html');
        return withTicketParam(next || 'main.html');
    } catch (err) {
        console.warn('Role lookup failed, defaulting to main.html:', err && err.message ? err.message : err);
        return withTicketParam('main.html');
    }
}

if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const email = emailInput.value.trim();
        const password = passwordInput.value;

        if (!email || !password) {
            if (messageEl) messageEl.textContent = 'Please enter email and password.';
            return;
        }

        loginBtn.disabled = true;
        loginBtn.textContent = 'LOGGING IN...';

        try {
            await auth.signInWithEmailAndPassword(email, password);
            if (messageEl) messageEl.textContent = '';
            // Route to the correct dashboard based on role.
            const destination = await resolveLoginDestination(auth.currentUser);
            window.location.href = destination;
        } catch (error) {
            console.error('Login error:', error);
            if (messageEl) messageEl.textContent = error.message;
            loginBtn.disabled = false;
            loginBtn.textContent = 'LOGIN';
        }
    });
}

// ==============================================================
// AUTH STATE OBSERVER
// ==============================================================

// Set while someone is parked on pending-approval.html with a LIVE watch on
// their user doc (see the AUTOMATIC ADVANCE branch below). Kept out of the
// PAGE GATING block on purpose — that block is sliced out and run standalone
// by test/auth-guard.test.js, which has no Firestore to subscribe with.
let pendingStatusUnsub = null;

/** Detach the pending-page watcher. Safe to call when nothing is attached. */
function unwatchPendingStatus() {
    if (!pendingStatusUnsub) return;
    try { pendingStatusUnsub(); } catch (err) { /* already detached */ }
    pendingStatusUnsub = null;
}

auth.onAuthStateChanged(async (user) => {
    // On pages that require auth, redirect to login.
    // NOTE: this is a UX gate, not a security boundary. The authoritative
    // check is firestore.rules — a determined user can always skip a JS
    // redirect, which is why the sensitive collections are gated there.
    const page = currentPageName(window.location.pathname);
    const isLoginPage = page === 'login.html';
    const isPendingPage = page === 'pending-approval.html';
    const onProtectedPage = isProtectedPage(window.location.pathname);

    if (onProtectedPage && !user) {
        redirectToLogin();
        return;
    }

    // Already signed in? Do not leave someone sitting on the login screen.
    // Routes through resolveLoginDestination so this lands on the SAME page as
    // the login form's own submit handler — a plain `main.html` here would race
    // that handler and briefly load the wrong dashboard for owners/HR.
    if (isLoginPage && user) {
        window.location.replace(await resolveLoginDestination(user));
        return;
    }

    // Route NOT-APPROVED users (pending AND rejected/denied) away from the
    // dashboard. This is the safety net for someone who is already signed in
    // and types the dashboard URL directly — the login handler alone never
    // runs for them. Checking only 'pending' here is how a rejected account
    // ended up using ownerdashboard.html.
    if (onProtectedPage && user && !isLoginPage && !isPendingPage && db) {
        const email = user && user.email ? user.email : '';
        db.collection('users').doc(window.normalizeUserEmail(email)).get()
            .then(snap => {
                const gated = snap.exists ? gatedAccountPage(snap.data().status) : '';
                if (gated) {
                    window.location.replace(gated);
                }
            })
            .catch(err => console.warn('Approval status check skipped:', err && err.message ? err.message : err));
    }

    // ===== AUTOMATIC ADVANCE FROM pending-approval.html =====
    // Waiting for the person to press "Check Status" felt broken: the
    // superadmin approves the account and the page just sits there. This
    // watches the user doc LIVE, and the instant the status leaves the gated
    // set (i.e. approved) it sends the account to ITS designated dashboard
    // through the SAME resolveLoginDestination() the login form uses — an
    // owner/HR/RM-SM to ownerdashboard.html, everyone else to main.html — with
    // no login detour and no click needed.
    //
    // Still-gated snapshots (pending/rejected/denied) are ignored, so a
    // rejected account parked here stays parked; and a MISSING doc never
    // advances — absence of data is not approval. The Check Status button
    // stays as the fallback for when this listener could not attach.
    if (isPendingPage && user && db && !pendingStatusUnsub) {
        const pendingEmail = user.email ? user.email : '';
        const pendingKey = window.normalizeUserEmail ? window.normalizeUserEmail(pendingEmail) : pendingEmail;
        if (pendingKey) {
            try {
                pendingStatusUnsub = db.collection('users').doc(pendingKey).onSnapshot(snap => {
                    if (!snap || !snap.exists) return;              // no data yet — stay put
                    if (gatedAccountPage(snap.data().status)) return; // still gated — stay put
                    unwatchPendingStatus();
                    resolveLoginDestination(user)
                        .then(dest => window.location.replace(dest))
                        .catch(err => console.warn('Auto-advance routing failed:', err && err.message ? err.message : err));
                }, err => console.warn('Approval watch failed (use Check Status):', err && err.message ? err.message : err));
            } catch (err) {
                console.warn('Approval watch could not start (use Check Status):', err && err.message ? err.message : err);
                pendingStatusUnsub = null;
            }
        }
    }
});

// ==============================================================
// LOGOUT
// ==============================================================

window.handleLogout = async function() {
    if (!confirm('Are you sure you want to log out?')) return;
    try {
        await auth.signOut();
        showToast('Logged out successfully', 'success');
        // Send the user back to the login page (reload kept them on main.html).
        window.location.href = 'login.html';
    } catch (error) {
        console.error('Logout error:', error);
        showToast('Failed to log out', 'error');
    }
};

