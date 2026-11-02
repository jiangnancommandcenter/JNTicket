// Functional test for the Approval Email Notification helpers (js/email.js).
// The module is executed inside a vm sandbox with the REAL tracking-access
// helpers extracted from firebase.js (same extraction as
// test/tracking-access.test.js) plus stubbed `fetch` / `auth`, so the message
// wording, recipient rules, portal link and duplicate-send guard can all be
// verified without Firebase, Gmail or a browser.
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const DAY = 24 * 60 * 60 * 1000;
const DASH = '\u2014';

// ---- 1. Real access-window helpers from firebase.js ------------------------
const fbSrc = fs.readFileSync(path.join(ROOT, 'firebase.js'), 'utf8');
const start = fbSrc.indexOf('//  2-DAY TRACKING ACCESS WINDOW');
const end = fbSrc.indexOf('// Make firestoreService globally accessible');
assert(start > -1 && end > start, 'access-window helper block not found in firebase.js');
const helperSrc = fbSrc.slice(fbSrc.lastIndexOf('// ====', start), end);

// ---- 2. Browser-ish sandbox with fetch / auth stubs ------------------------
const sends = [];          // every POST the module attempts
let fetchMode = 'ok';      // 'ok' | 'reject' | 'abort'

// A stand-in PUBLIC host. This suite must NEVER hardcode one real-looking domain
// as "the correct portal link": that is precisely how a dead subdomain
// (portal.jiangnanhotpot.com — NXDOMAIN for every real requester) came to be
// certified as correct. Every portal assertion below is derived from these two
// constants, and the non-routable hosts are covered by their own section.
const PUBLIC_PAGE = 'https://tickets.example.com/portal/main.html';
const PUBLIC_SUBMIT = 'https://tickets.example.com/portal/submit-ticket.html';
// The login-gated page the APPROVAL email now links. The Track portal
// (PUBLIC_SUBMIT) survives for the re-access email only.
const PUBLIC_DASHBOARD = 'https://tickets.example.com/portal/ownerdashboard.html';

const sandbox = {
    console: console,
    URL: URL,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    AbortController: AbortController,
    location: { href: PUBLIC_PAGE },
    fetch: async (url, init) => {
        sends.push({ url: url, init: init });
        if (fetchMode === 'reject') throw new TypeError('Failed to fetch');
        if (fetchMode === 'abort') {
            // What an ad-blocker/privacy extension does to the Apps Script
            // redirect: the request never settles and the abort signal fires.
            const err = new Error('signal is aborted without reason');
            err.name = 'AbortError';
            throw err;
        }
        // What a real `mode: 'no-cors'` request hands back: an opaque response.
        return { type: 'opaque', ok: false, status: 0 };
    },
    auth: {
        currentUser: {
            email: 'superadmin@jiangnanhotpot.com',
            getIdToken: async () => 'TEST_ID_TOKEN'
        }
    }
};
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(helperSrc, sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'email.js'), 'utf8'), sandbox);

const w = sandbox.window;
assert(w.EmailService && typeof w.EmailService.sendTicketApprovedEmail === 'function',
    'EmailService API missing — js/email.js did not expose window.EmailService');

function setConfig(overrides) {
    // window === sandbox here, so this is window.EMAIL_CONFIG.
    sandbox.EMAIL_CONFIG = Object.assign({
        endpoint: 'https://script.google.com/macros/s/AKfyTESTDEPLOY/exec',
        secret: 'test-secret',
        senderName: 'Jiangnan Command Center',
        senderEmail: 'jiangnancommandcenter@gmail.com',
        replyTo: 'jiangnancommandcenter@gmail.com',
        replyToName: 'Ticket Requester',
        portalUrl: '',
        ownerDashboardUrl: '',
        toDisplayName: '',
        enabled: true
    }, overrides || {});
}
setConfig();

function ticket(overrides) {
    return Object.assign({
        id: 'bnw-tix007',
        ticketNumber: 'BNW-TIX007',
        branch: 'Banawe',
        incident: 'Tip Pocketing',
        name: 'Juan Dela Cruz',
        contact: '09171234567',
        email: 'Juan.DelaCruz@Store.COM '
    }, overrides || {});
}

// ===== 1. Configuration gating =====
assert.strictEqual(w.EmailService.isEmailConfigured(), true);
setConfig({ endpoint: '' });
assert.strictEqual(w.EmailService.isEmailConfigured(), false);
setConfig({ endpoint: 'https://script.google.com/macros/s/PASTE_YOUR_URL/exec' });
assert.strictEqual(w.EmailService.isEmailConfigured(), false, 'placeholder endpoint must not count as configured');
setConfig({ enabled: false });
assert.strictEqual(w.EmailService.isEmailConfigured(), false, 'enabled:false must disable every send');
setConfig();

// ===== 2. Recipient resolution =====
assert.strictEqual(w.EmailService.isValidEmail('a@b.co'), true);
assert.strictEqual(w.EmailService.isValidEmail('09171234567'), false);
assert.strictEqual(w.EmailService.isValidEmail('a@b'), false);

assert.strictEqual(w.EmailService.resolveRecipient(ticket()), 'juan.delacruz@store.com');
assert.strictEqual(w.EmailService.resolveRecipient(ticket({ email: '', contact: 'juan@store.com' })), 'juan@store.com');
assert.strictEqual(w.EmailService.resolveRecipient(ticket({ email: '', contact: '09171234567' })), null,
    'a phone number in the contact box must NOT be treated as an email');
assert.strictEqual(
    w.EmailService.resolveRecipient({ accessReopenRequest: { requestedByEmail: 'MGR@Store.com' } }),
    'mgr@store.com');
assert.strictEqual(w.EmailService.resolveRecipient({}), null);
assert.strictEqual(w.EmailService.resolveRecipient(null), null);

// ===== 2b. RE-ACCESS recipient: the STORE/MANAGER wins, not the reporter =====
const reopenTicket = ticket({
    email: 'reporter@jiangnanhotpot.com',
    accessReopenRequest: { status: 'pending', requestedByEmail: 'Store.Manager@BHW.com ' }
});
assert.strictEqual(w.EmailService.resolveReopenRecipient(reopenTicket), 'store.manager@bhw.com',
    'the manager who asked for access must win over the original reporter');
assert.strictEqual(
    w.EmailService.resolveReopenRecipient(ticket({ email: 'reporter@jiangnanhotpot.com' })),
    'reporter@jiangnanhotpot.com',
    'no reopen request -> fall back to the original reporter');
assert.strictEqual(
    w.EmailService.resolveReopenRecipient(ticket({
        email: '',
        contact: 'mgr@store.com',
        accessReopenRequest: { status: 'pending' }
    })),
    'mgr@store.com',
    'an empty requestedByEmail must fall through to ticket.email/contact');
assert.strictEqual(w.EmailService.resolveReopenRecipient(ticket({ email: '', contact: '09171234567' })), null,
    'a phone number must NOT be treated as an email');
assert.strictEqual(w.EmailService.resolveReopenRecipient({}), null);
assert.strictEqual(w.EmailService.resolveReopenRecipient(null), null);

// ===== 2c. Deep link: only the ticket number, never the contact/email =====
assert.strictEqual(w.EmailService.resolveTrackUrl('BNW-TIX007'),
    PUBLIC_SUBMIT + '?track=BNW-TIX007');
const trackUrl = new URL(w.EmailService.resolveTrackUrl('BNW-TIX007'));
assert.strictEqual(trackUrl.searchParams.get('track'), 'BNW-TIX007');
assert.strictEqual(trackUrl.searchParams.get('email'), null,
    'the deep link must NEVER carry the store email in the URL');
assert.strictEqual(trackUrl.searchParams.get('contact'), null,
    'the deep link must NEVER carry contact details in the URL');
assert.strictEqual(new URL(w.EmailService.resolveTrackUrl('bnw tix 001')).searchParams.get('track'),
    'bnw tix 001', 'spaces must be encoded, not dropped');
assert.strictEqual(w.EmailService.resolveTrackUrl(''),
    PUBLIC_SUBMIT,
    'no ticket number -> plain portal link, no empty ?track=');

// ===== 2d. The re-access approval message itself =====
const freshWindow = new Date(Date.now() + (2 * DAY));
const accessMail = w.EmailService.buildAccessApprovedEmail(reopenTicket, freshWindow);
assert.strictEqual(accessMail.to, 'store.manager@bhw.com');
assert.strictEqual(accessMail.subject, 'Ticket Access Approved ' + DASH + ' BNW-TIX007');
assert(accessMail.text.indexOf('Your request to view this ticket again has been approved.') > -1,
    'the headline must say the access request was approved');
assert(accessMail.text.indexOf('BNW-TIX007') > -1);
assert(accessMail.text.indexOf('?ticket=BNW-TIX007') > -1,
    'the RE-ACCESS email must send the SAME Owner Dashboard deep link as the approval email');
assert(accessMail.text.indexOf('submit-ticket.html') === -1,
    'the re-access email must no longer point at the login-free Track portal');
assert(accessMail.text.indexOf('Track Ticket Status') === -1,
    'the old "click Track Ticket Status" instruction must be gone from the re-access email');
assert(accessMail.html.indexOf('?ticket=BNW-TIX007') > -1);
// Same clickable button as the approval email, not a thin text link.
assert(/<a href="[^"]*ownerdashboard\.html\?ticket=BNW-TIX007"[^>]*>/.test(accessMail.html),
    'the re-access email must use the dashboard deep link as its anchor');
assert(/padding:\s*14px 28px/.test(accessMail.html),
    'the re-access link must be the same padded button as the approval email');
assert.strictEqual(accessMail.dashboardUrl, PUBLIC_DASHBOARD,
    'the built message must expose dashboardUrl like the approval email does');
assert(accessMail.text.indexOf('Viewing access is available until') > -1,
    'a fresh future window must be advertised');
assert(accessMail.text.indexOf('reporter@jiangnanhotpot.com') === -1,
    'the reporter address must never leak into the manager\'s mail');

// A past/stale window must NOT be advertised — the caller passes the fresh one
// precisely because the in-memory ticket still holds the expired date.
const staleMail = w.EmailService.buildAccessApprovedEmail(reopenTicket, new Date(Date.now() - DAY));
assert(staleMail.text.indexOf('Viewing access is available until') === -1,
    'an already-expired window must not be promised to the manager');

// ===== 3. Portal link =====
assert.strictEqual(w.EmailService.resolvePortalUrl(), PUBLIC_SUBMIT,
    'with no override the portal URL auto-derives from the page the superadmin is on');
setConfig({ portalUrl: 'https://tickets.example.com/track' });
assert.strictEqual(w.EmailService.resolvePortalUrl(), 'https://tickets.example.com/track');
setConfig();

// ===== 3b. PUBLIC-REACHABILITY GUARD =====
// The regression that matters: a link that only opens on the superadmin's own
// machine must never be the one handed to an external requester. Each host
// below previously flowed silently into the customer's inbox.
const UNROUTABLE_PAGES = [
    ['a file:// path', 'file:///C:/Users/Admin/Desktop/portal/main.html'],
    ['a bare local file', 'file:///C:/portal/main.html'],
    ['localhost', 'http://localhost:5500/main.html'],
    ['localhost by name', 'http://localhost/main.html'],
    ['an .internal host', 'http://portal.jiangnanhotpot.internal/main.html'],
    ['a 192.168.x.x dev server', 'http://192.168.1.50:5000/main.html'],
    ['a 10.x.x.x dev server', 'http://10.0.0.7:8080/main.html'],
    ['a 172.16.x.x dev server', 'http://172.16.4.9/main.html'],
    ['a 169.254.x.x link-local host', 'http://169.254.10.1/main.html'],
    ['the 127.0.0.1 loopback', 'http://127.0.0.1:5000/main.html'],
    ['a 0.0.0.0 bind address', 'http://0.0.0.0:5000/main.html']
];

// 3b-i. The classifier must reject every one of them…
UNROUTABLE_PAGES.forEach(function (entry) {
    const label = entry[0];
    const pageUrl = entry[1];
    const derived = new URL('submit-ticket.html', pageUrl).href;
    const verdict = w.EmailService.publicHostProblem(derived);
    assert.strictEqual(verdict.ok, false, label + ' must be rejected (' + derived + ')');
    assert(typeof verdict.reason === 'string' && verdict.reason.length > 0,
        label + ' must come with a human-readable reason');
});

// …and must NOT reject a genuine public host, including one that merely looks
// suspicious. This is the half a naive "block anything with a dot" fix gets wrong.
[
    'https://tickets.example.com/submit-ticket.html',
    'https://jiangnanhotpot.com/tickets/submit-ticket.html',
    'https://portal.jiangnanhotpot.com/submit-ticket.html',
    'http://172.32.0.1/main.html',          // just OUTSIDE 172.16-31 private range
    'https://11.0.0.1.example.com/main.html',
    'https://192.168.example.com/main.html' // "192.168" as a NAME, not an address
].forEach(function (publicUrl) {
    assert.strictEqual(w.EmailService.publicHostProblem(publicUrl).ok, true,
        'a public host must be accepted: ' + publicUrl);
});

// 3b-ii. Relative / malformed input is rejected too.
['', '   ', 'submit-ticket.html', '/tickets/submit-ticket.html', 'javascript:alert(1)',
    'mailto:a@b.co'].forEach(function (bad) {
    assert.strictEqual(w.EmailService.publicHostProblem(bad).ok, false,
        'a non-absolute or non-web link must be rejected: "' + bad + '"');
});

// 3b-iii. THE REGRESSION: deriving from an unroutable page must raise a loud
// console error naming the symptom the requester will actually see. This is the
// check that would have caught the reported bug before it shipped.
const realLocation = sandbox.location.href;
const consoleErrors = [];
const realConsole = sandbox.console;
// Swap the sandbox console so the run stays quiet and we can assert on it.
sandbox.console = {
    log: function () {},
    info: function () {},
    warn: function () {},
    error: function () { consoleErrors.push(Array.prototype.join.call(arguments, ' ')); }
};

sandbox.location.href = 'http://192.168.1.50:5000/main.html';
assert.strictEqual(w.EmailService.resolvePortalUrl(), 'http://192.168.1.50:5000/submit-ticket.html',
    'with no override the derived link is still returned (dev convenience)');
assert.strictEqual(consoleErrors.length, 1, 'an unroutable derived link must raise one console error');
assert(consoleErrors[0].indexOf('DNS_PROBE_FINISHED_NXDOMAIN') > -1,
    'the warning must name the symptom the requester will actually see');
assert(consoleErrors[0].indexOf('EMAIL_CONFIG.portalUrl') > -1,
    'the warning must say exactly which setting to change');

w.EmailService.resolvePortalUrl();
w.EmailService.resolvePortalUrl();
assert.strictEqual(consoleErrors.length, 1,
    'the same bad link must not spam the console on every render');

// An unroutable CONFIGURED url is reported too — an explicit setting is still
// honoured (the operator may be mid-migration), but never silently shipped.
sandbox.location.href = realLocation;
setConfig({ portalUrl: 'http://10.0.0.7:8080/submit-ticket.html' });
assert.strictEqual(w.EmailService.resolvePortalUrl(), 'http://10.0.0.7:8080/submit-ticket.html',
    'an explicit setting is honoured even when it is unreachable');
assert.strictEqual(consoleErrors.length, 2, 'a bad configured URL must also be reported');
setConfig();
sandbox.console = realConsole;

// 3b-iv. A configured public URL must win even when the superadmin is standing
// on localhost — this is the production fix for the reported bug.
// ⚠️ ownerDashboardUrl, NOT portalUrl: the approval email links the dashboard.
setConfig({ portalUrl: 'https://tickets.example.com/portal/submit-ticket.html', ownerDashboardUrl: 'https://tickets.example.com/portal/ownerdashboard.html' });
sandbox.location.href = 'http://192.168.1.50:5000/main.html';
assert.strictEqual(w.EmailService.resolvePortalUrl(), 'https://tickets.example.com/portal/submit-ticket.html',
    'the configured public URL must override an unroutable current page');
assert.strictEqual(w.EmailService.resolveOwnerDashboardUrl(), 'https://tickets.example.com/portal/ownerdashboard.html',
    'the configured dashboard URL must override an unroutable current page');
const pinned = w.EmailService.buildTicketApprovedEmail(ticket());
assert(pinned.text.indexOf('192.168.1.50') === -1,
    'the LAN address of the superadmin must NEVER reach the requester');
assert(pinned.text.indexOf('tickets.example.com/portal/ownerdashboard.html') > -1,
    'the configured public DASHBOARD link must be the one in the body');
// ⚠️ And the old portal must not have leaked back in.
assert(pinned.text.indexOf('submit-ticket.html') === -1,
    'the approval email must NOT point at the login-free Track portal any more');
sandbox.location.href = realLocation;
setConfig();

// ===== 4. Duplicate-send guard (idempotency) =====
assert.strictEqual(w.EmailService.shouldSkipApprovalEmail('approved'), true);
assert.strictEqual(w.EmailService.shouldSkipApprovalEmail('pending_approval'), false);
assert.strictEqual(w.EmailService.shouldSkipApprovalEmail(''), false);
assert.strictEqual(w.EmailService.shouldSkipApprovalEmail('approved', { force: true }), false,
    'the explicit ✉ action must bypass the guard');

// ===== 5. Message content =====
const message = w.EmailService.buildTicketApprovedEmail(ticket());
assert.strictEqual(message.to, 'juan.delacruz@store.com');
assert.strictEqual(message.subject, 'Ticket Request Completed ' + DASH + ' BNW-TIX007');
assert.strictEqual(
    message.text.indexOf('Ticket request was done, please check your request to the portal with this Ticket number: BNW-TIX007'),
    0,
    'the automated sentence must lead the email body, verbatim');
assert(message.text.indexOf('BNW-TIX007') > -1, 'ticket number must appear in the body');
// ⚠️ The approval email links the OWNER DASHBOARD, not the login-free Track
// portal. This is the behaviour change being locked down: an Area Manager has
// an account and reads the ticket on their own dashboard.
assert(message.text.indexOf(PUBLIC_DASHBOARD) > -1,
    'the Owner Dashboard link must be in the body');
assert(message.text.indexOf('submit-ticket.html') === -1,
    'the approval email must no longer point at the login-free Track portal');
assert(message.text.indexOf('Track Ticket Status') === -1,
    'the old "click Track Ticket Status" instruction must be gone');
assert(message.text.indexOf('Owner Dashboard') > -1,
    'recipients must be told which page to open');
assert(message.text.indexOf('Jiangnan Command Center') > -1, 'the business signature must be present');
assert(message.html.indexOf('BNW-TIX007') > -1 && message.html.indexOf('<') === 0,
    'a light HTML twin must be produced for mail clients');

// ===== 5b. THE LINK MUST ACTUALLY BE CLICKABLE =====
// THE BUG THIS LOCKS DOWN: the reported symptom was "the link is not clickable".
// A link is only clickable if it is a real anchor with a NON-EMPTY absolute
// href. An empty href renders as inert, un-clickable text - so the emptiness
// check matters as much as the presence check.
const anchors = message.html.match(/<a\s[^>]*href="([^"]*)"/g) || [];
assert(anchors.length >= 1, 'the HTML body must contain a real anchor');
anchors.forEach(function (tag) {
    const href = (tag.match(/href="([^"]*)"/) || [])[1] || '';
    assert(href.length > 0, 'no anchor may have an empty href (it renders un-clickable)');
    assert(/^https?:\/\//.test(href), 'the href must be absolute, got: ' + href);
});
// The button itself - a padded, high-contrast block, not thin body text. This
// is what a manager actually taps on a phone.
assert(/<a href="[^"]*ownerdashboard\.html\?ticket=BNW-TIX007"[^>]*>/.test(message.html),
    'the dashboard deep link must be the anchor href');
assert(/padding:\s*14px 28px/.test(message.html),
    'the link must be a padded button, not a thin line of text');
// The URL is repeated as plain text so clients that refuse to linkify a
// styled anchor still have something tappable.
assert(message.html.split(PUBLIC_DASHBOARD + '?ticket=BNW-TIX007').length - 1 >= 2,
    'the raw URL must appear at least twice (button + fallback)');
// The plain-text part must have the URL on its OWN LINE, otherwise mail
// clients frequently leave it as inert text instead of linkifying it.
assert(/^https?:\/\/\S*ownerdashboard\.html\?ticket=/m.test(message.text),
    'the plain-text URL must sit on its own line so it gets auto-linkified');
assert.strictEqual(message.ticketId, 'bnw-tix007');

// Production window (24 hours). The approval email now advertises the viewing
// window ("starts when you first open … stays available for 24 hours") because
// the time-compression guard no longer suppresses it.
assert.strictEqual(w.TRACKING_ACCESS_WINDOW_MS, 24 * 60 * 60 * 1000,
    'expected the 24-hour production window from firebase.js');
assert.strictEqual(w.EmailService.shouldMentionViewingWindow(
    ticket({ approvalStatus: 'approved', accessExpiresAt: new Date(Date.now() - 30 * 1000) })), false,
    'an expired ticket must never mention a viewing window in a real email');
assert(message.text.indexOf('Viewing access') > -1,
    'the production approval email must advertise the viewing window');

// Production window (24 hours). THE SENTENCE NO LONGER CARRIES A DATE.
// The window starts when the requester FIRST OPENS the ticket, so at the moment
// this email is built there is no deadline to quote. Promising "available until
// <date>" here would promise a value the system no longer computes at approval
// time — the exact bug this change fixed.
const DAY_WINDOW = 2 * DAY;
w.TRACKING_ACCESS_WINDOW_MS = DAY_WINDOW;
const liveWindow = ticket({ approvalStatus: 'approved', accessWindowStartsOnOpen: true });
const liveText = w.EmailService.buildTicketApprovedEmail(liveWindow).text;
assert(liveText.indexOf('starts when you first open the ticket') > -1,
    'the approval email must say the window starts on first open');
assert(liveText.indexOf('available until') === -1,
    'the approval email must NOT quote an expiry date — the window has not started yet');
assert(liveText.indexOf('2 days') > -1,
    'the email must still state the LENGTH of the window, which is known up front');

// An ALREADY expired window is irrelevant to the approval email now — it never
// quotes a date at all. Pinned so that reintroducing a date cannot slip back in.
const staleWindow = ticket({ approvalStatus: 'approved', accessWindowStartsOnOpen: true });
assert(w.EmailService.buildTicketApprovedEmail(staleWindow).text.indexOf('available until') === -1,
    'no ticket shape may make the approval email promise a date again');

// Legacy ticket (no marker): still uses the approvedAt + window fallback, and
// still must not be advertised with a date by THIS email.
assert.strictEqual(w.EmailService.shouldMentionViewingWindow(
    ticket({ approvalStatus: 'approved', approvedAt: new Date(Date.now() - 1000) })), true);
assert(w.EmailService.buildTicketApprovedEmail(
    ticket({ approvalStatus: 'approved', approvedAt: new Date(Date.now() - 1000) })).text
    .indexOf('available until') === -1,
    'a legacy ticket must not be advertised with a date either');

// ===== 6. Bridge delivery =====
(async function () {
    // 6a. Happy path — one POST, no-cors, text/plain (no CORS preflight).
    sends.length = 0;
    const sent = await w.EmailService.sendTicketApprovedEmail(ticket());
    assert.strictEqual(sent.ok, true);
    assert.strictEqual(sent.status, 'dispatched');
    assert.strictEqual(sent.to, 'juan.delacruz@store.com');
    assert.strictEqual(sends.length, 1, 'exactly ONE attempt — never retry (a retry would double-send)');
    assert.strictEqual(sends[0].url, sandbox.EMAIL_CONFIG.endpoint);
    assert.strictEqual(sends[0].init.method, 'POST');
    assert.strictEqual(sends[0].init.mode, 'no-cors');
    assert.strictEqual(sends[0].init.headers['Content-Type'], 'text/plain;charset=utf-8');
    const payload = JSON.parse(sends[0].init.body);
    assert.strictEqual(payload.to, 'juan.delacruz@store.com');
    assert.strictEqual(payload.secret, 'test-secret');
    assert.strictEqual(payload.idToken, 'TEST_ID_TOKEN', 'the superadmin ID token is what the bridge verifies');
    assert.strictEqual(payload.ticketId, 'bnw-tix007');
    assert.strictEqual(payload.ticketNumber, 'BNW-TIX007');
    assert.strictEqual(payload.subject, 'Ticket Request Completed ' + DASH + ' BNW-TIX007');
    assert(payload.text.indexOf('Ticket request was done') > -1);
    assert(payload.html.indexOf('BNW-TIX007') > -1);

    // 6b. No Firebase session → refused BEFORE any network call.
    sends.length = 0;
    const realUser = sandbox.auth.currentUser;
    sandbox.auth.currentUser = null;
    const noAuth = await w.EmailService.sendTicketApprovedEmail(ticket());
    sandbox.auth.currentUser = realUser;
    assert.strictEqual(noAuth.ok, false);
    assert.strictEqual(noAuth.status, 'no_auth');
    assert.strictEqual(sends.length, 0, 'no POST may leave the browser without a verified session');

    // 6c. Ticket without a usable address → skipped, nothing sent.
    sends.length = 0;
    const noRecipient = await w.EmailService.sendTicketApprovedEmail(ticket({ email: '', contact: '09171234567' }));
    assert.strictEqual(noRecipient.status, 'no_recipient');
    assert.strictEqual(sends.length, 0);

    // 6d. Unconfigured bridge → skipped, nothing sent (approvals keep working).
    sends.length = 0;
    setConfig({ endpoint: '' });
    const notConfigured = await w.EmailService.sendTicketApprovedEmail(ticket());
    setConfig();
    assert.strictEqual(notConfigured.status, 'not_configured');
    assert.strictEqual(sends.length, 0);

    // 6e. Network/CORS/tunnel failure → reported, never thrown at the caller.
    sends.length = 0;
    fetchMode = 'reject';
    const failed = await w.EmailService.sendTicketApprovedEmail(ticket());
    fetchMode = 'ok';
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.status, 'failed');
    assert.strictEqual(failed.timeout, undefined, 'a plain network error is not a timeout');
    assert.strictEqual(sends.length, 1, 'still a single attempt');

    // 6e-bis. Timeout / aborted by an extension → flagged so the superadmin
    //       gets an actionable message instead of "signal is aborted without reason".
    sends.length = 0;
    fetchMode = 'abort';
    const timedOut = await w.EmailService.sendTicketApprovedEmail(ticket());
    fetchMode = 'ok';
    assert.strictEqual(timedOut.ok, false);
    assert.strictEqual(timedOut.status, 'failed');
    assert.strictEqual(timedOut.timeout, true, 'AbortError must be reported as a timeout');
    assert(timedOut.error.indexOf('Incognito') > -1,
        'the timeout message must tell the superadmin what to do next');
    assert.strictEqual(sends.length, 1, 'still a single attempt — no retry after an abort');

    // 6f. The console helper that proves the bridge before a real approval.
    sends.length = 0;
    const test = await w.sendTestTicketEmail('superadmin@jiangnanhotpot.com');
    assert.strictEqual(test.ok, true);
    assert.strictEqual(JSON.parse(sends[0].init.body).to, 'superadmin@jiangnanhotpot.com');

    // 6g. The re-access approval mail: same transport, DIFFERENT recipient rule.
    //     The store manager (who asked for access) is emailed, not the reporter.
    sends.length = 0;
    const accessSent = await w.EmailService.sendAccessApprovedEmail(
        reopenTicket, new Date(Date.now() + (2 * DAY)));
    assert.strictEqual(accessSent.ok, true);
    assert.strictEqual(accessSent.status, 'dispatched');
    assert.strictEqual(accessSent.to, 'store.manager@bhw.com',
        'the re-access email must go to the manager, not the original reporter');
    assert.strictEqual(sends.length, 1, 'exactly ONE attempt — never retry');
    const accessPayload = JSON.parse(sends[0].init.body);
    assert.strictEqual(accessPayload.to, 'store.manager@bhw.com');
    assert.strictEqual(accessPayload.subject, 'Ticket Access Approved ' + DASH + ' BNW-TIX007');
    assert.strictEqual(accessPayload.secret, 'test-secret',
        'it reuses the SAME bridge/secret as the approval email — no new deploy');
    assert.strictEqual(accessPayload.ticketId, 'bnw-tix007');
    assert(accessPayload.text.indexOf('?ticket=BNW-TIX007') > -1,
        'the SENT re-access email carries the Owner Dashboard deep link, like the approval one');

    // 6h. Re-access mail with no usable address anywhere → nothing leaves.
    sends.length = 0;
    const noAccessRecipient = await w.EmailService.sendAccessApprovedEmail(
        ticket({ email: '', contact: '09171234567' }), new Date());
    assert.strictEqual(noAccessRecipient.status, 'no_recipient');
    assert.strictEqual(sends.length, 0);

    // 6i. Console helper for the re-access mail.
    sends.length = 0;
    const accessTest = await w.sendTestAccessEmail('store.manager@bhw.com');
    assert.strictEqual(accessTest.ok, true);
    assert.strictEqual(JSON.parse(sends[0].init.body).to, 'store.manager@bhw.com');

    // ===== 7. verifyPortalLink() — the helper that proves the emailed link opens.
    // A requester is never on the office network, so "it works on my machine" is
    // exactly the assumption that produced the reported NXDOMAIN report.

    // 7a. A public host that answers → reachable (opaque response, no body needed).
    sends.length = 0;
    setConfig();
    sandbox.location.href = PUBLIC_PAGE;
    const reachable = await w.verifyPortalLink();
    assert.strictEqual(reachable.ok, true, 'a reachable public host must report ok');
    assert.strictEqual(reachable.url, PUBLIC_SUBMIT);
    assert.strictEqual(reachable.host, 'tickets.example.com');
    assert(sends.length === 1 && sends[0].init.method === 'GET' && sends[0].init.mode === 'no-cors',
        'the check must be a single cross-origin no-cors GET');

    // 7b. A public host that does NOT answer → reported, never thrown.
    sends.length = 0;
    fetchMode = 'reject';
    const deadHost = await w.verifyPortalLink();
    fetchMode = 'ok';
    assert.strictEqual(deadHost.ok, false);
    assert.strictEqual(deadHost.stage, 'request');
    assert(deadHost.error.indexOf('DNS_PROBE_FINISHED_NXDOMAIN') > -1,
        'an unresolvable host must be explained in terms the superadmin can act on');
    assert(deadHost.error.indexOf('DNS') > -1);

    // 7c. An unroutable address is rejected WITHOUT a pointless network call.
    sends.length = 0;
    sandbox.location.href = 'http://192.168.1.50:5000/main.html';
    const quietConsole = sandbox.console;
    sandbox.console = { log: function () {}, info: function () {}, warn: function () {}, error: function () {} };
    const unroutable = await w.verifyPortalLink();
    sandbox.console = quietConsole;
    sandbox.location.href = PUBLIC_PAGE;
    assert.strictEqual(unroutable.ok, false);
    assert.strictEqual(unroutable.stage, 'address',
        'a private/LAN address must be caught by inspection, not by a doomed fetch');
    assert.strictEqual(sends.length, 0, 'no request may be attempted against an unroutable host');
    assert(unroutable.error.indexOf('EMAIL_CONFIG.portalUrl') > -1,
        'the error must point at the setting that fixes it');

    // 7d. It is exposed on window so it can be run from the console by hand.
    assert.strictEqual(typeof w.verifyPortalLink, 'function',
        'verifyPortalLink must be callable straight from the browser console');

    // ===== 8. localDev mode ================================================
    // Testing on your own machine is a legitimate reason for a localhost link,
    // so the guard must stop shouting — but ONLY when the operator asked for it.

    // 8a. localDev:true + a localhost page → the guard speaks with console.warn,
    //     and never with console.error.
    const devErrors = [];
    const devWarns = [];
    const realConsole2 = sandbox.console;
    sandbox.console = {
        log: function () {},
        info: function () {},
        error: function () { devErrors.push(Array.prototype.join.call(arguments, ' ')); },
        warn: function () { devWarns.push(Array.prototype.join.call(arguments, ' ')); }
    };
    setConfig({ localDev: true });
    sandbox.location.href = 'http://localhost:5500/main.html';
    assert.strictEqual(w.EmailService.isLocalDevMode(), true);
    assert.strictEqual(w.EmailService.resolvePortalUrl(), 'http://localhost:5500/submit-ticket.html',
        'on localhost the derived link is exactly the one the local server serves');
    assert.strictEqual(devErrors.length, 0, 'localDev must NOT raise console.error');
    assert.strictEqual(devWarns.length, 1, 'localDev must still explain itself once');
    assert(devWarns[0].indexOf('localDev: false') > -1,
        'the dev warning must tell the operator what to change before go-live');
    assert(devWarns[0].indexOf('EMAIL_CONFIG.portalUrl') > -1);

    // 8b. …and the local server answering is reported as local-dev, not failure.
    sends.length = 0;
    const devUp = await w.verifyPortalLink();
    assert.strictEqual(devUp.ok, true, 'a running local server is a pass, not a failure');
    assert.strictEqual(devUp.stage, 'local-dev');
    assert.strictEqual(devUp.url, 'http://localhost:5500/submit-ticket.html');
    assert(sends.length === 1, 'it must still actually request the page');

    // 8c. …but a local server that is NOT running is still an error, with the
    //     one command that fixes it.
    sends.length = 0;
    fetchMode = 'reject';
    const devDown = await w.verifyPortalLink();
    fetchMode = 'ok';
    assert.strictEqual(devDown.ok, false, 'a dead local server must not report success');
    assert.strictEqual(devDown.stage, 'local-dev');
    assert(devDown.error.indexOf('npm run serve') > -1,
        'the dev failure must name the command that starts the server');
    assert.strictEqual(sends.length, 1, 'it really did try');

    // 8d. localDev:false restores strict behaviour on the very same page.
    setConfig({ localDev: false });
    sandbox.console = {
        log: function () {},
        info: function () {},
        warn: function () { devWarns.push('UNEXPECTED-WARN'); },
        error: function () { devErrors.push(Array.prototype.join.call(arguments, ' ')); }
    };
    assert.strictEqual(w.EmailService.isLocalDevMode(), false);
    w.EmailService.resolvePortalUrl();
    assert.strictEqual(devErrors.length, 1, 'with localDev off a localhost link is an ERROR again');
    assert.strictEqual(devWarns.length, 1, 'and it must not be downgraded to a warning');

    sandbox.console = realConsole2;
    sandbox.location.href = PUBLIC_PAGE;
    setConfig();

    console.log('OK: all approval-email assertions passed');
})().catch(function (error) {
    console.error('FAILED:', error && error.message ? error.message : error);
    process.exitCode = 1;
});


