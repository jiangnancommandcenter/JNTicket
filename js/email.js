// ==============================================================
//  APPROVAL EMAIL NOTIFICATION (requester notification)
//  When a superadmin approves a resolution, the requester gets an
//  automated email from the BUSINESS Gmail account telling them to
//  check the portal with their ticket number.
//
//  The browser cannot speak SMTP (no raw sockets), so the message is
//  handed to a Google Apps Script Web App bridge which sends it with
//  the business Gmail account and verifies — SERVER-SIDE — that the
//  caller is really a signed-in superadmin before sending anything.
//
//  Deploy: docs/apps-script/RCMS-Ticket-Notifier.gs
//  Setup : docs/EMAIL-SETUP.md
//
//  Everything here is best-effort: an approval must never be blocked,
//  cancelled or rolled back because an email could not be sent.
// ==============================================================

// Apps Script answers from script.googleusercontent.com without CORS headers,
// so the request is opaque — one fire-and-forget attempt, never a retry here
// (a retry could double-send). Delivery is verified from the business Gmail
// "Sent" folder plus the `approvalEmail` record kept on the ticket.
//
// 45s (not 15s): the FIRST call after a deployment is slow — Apps Script spins
// up the container, the redirect to script.googleusercontent.com has to be
// followed, and the very first Gmail send can trigger a one-time scope check.
// A 15s ceiling aborted those perfectly good requests ("signal is aborted
// without reason") and looked like a total failure.
const EMAIL_SEND_TIMEOUT_MS = 45000;

// The message the requester receives, verbatim per spec.
const EMAIL_HEADLINE_PREFIX =
    'Ticket request was done, please check your request to the portal with this Ticket number: ';

const EMAIL_SUBJECT_PREFIX = 'Ticket Request Completed \u2014 ';

// ===== Re-access approval ("Request Access" fulfilled) =====
// A second, separate message for when a superadmin approves a manager/store
// re-access request on an expired ticket. Same bridge, same sender, same
// security gate — only the wording and the recipient priority differ.
const ACCESS_EMAIL_SUBJECT_PREFIX = 'Ticket Access Approved \u2014 ';
const ACCESS_EMAIL_HEADLINE =
    'Your request to view this ticket again has been approved.';

/** Deep link that prefills the Ticket Number box on the Track page. */
function resolveTrackUrl(label) {
    const base = resolvePortalUrl();
    const number = String(label || '').trim();
    if (!base || !number) return base;
    try {
        const url = new URL(base);
        url.searchParams.set('track', number);
        return url.href;
    } catch (error) {
        return base + (base.indexOf('?') > -1 ? '&' : '?') + 'track=' + encodeURIComponent(number);
    }
}

// ===== OWNER DASHBOARD LINK (the destination of BOTH emails) =====
// `resolveTrackUrl()` above still builds the login-free Track link, which
// `submit-ticket.html` itself consumes via `?track=`. No email sends it any
// more: BOTH the approval email and the re-access email now point at the Area
// Manager's own dashboard, because that is the single place an approved ticket
// is read — one modal, one link, one set of instructions.
//
// The two resolvers are deliberately SEPARATE functions rather than one
// parameterised one. They are allowed to point at different hosts (the portal
// may stay public while the dashboard sits behind the same host), they are
// validated independently, and merging them would make a future change to one
// silently repoint the other.
function resolveOwnerDashboardUrl() {
    const override = String(emailConfigValue('ownerDashboardUrl', '') || '').trim();
    if (override) {
        // Honour an explicit setting, but never silently ship a broken one.
        const problem = publicHostProblem(override);
        if (!problem.ok) warnUnreachablePortalUrl(override, problem.reason, 'ownerDashboardUrl');
        return override;
    }

    let derived;
    try {
        derived = new URL('ownerdashboard.html', window.location.href).href;
    } catch (error) {
        derived = 'ownerdashboard.html';
    }
    const problem = publicHostProblem(derived);
    if (!problem.ok) warnUnreachablePortalUrl(derived, problem.reason, 'ownerDashboardUrl');
    return derived;
}

/**
 * Deep link straight to one ticket on the Owner Dashboard.
 *
 * ⚠️ SECURITY — same rule as resolveTrackUrl(): ONLY the ticket number travels
 * in the URL. The requester's email/contact is deliberately never appended; it
 * would sit in browser history and in any screenshot the manager shares.
 */
function resolveOwnerTicketUrl(label) {
    const base = resolveOwnerDashboardUrl();
    const number = String(label || '').trim();
    if (!base || !number) return base;
    try {
        const url = new URL(base);
        url.searchParams.set('ticket', number);
        return url.href;
    } catch (error) {
        return base + (base.indexOf('?') > -1 ? '&' : '?') + 'ticket=' + encodeURIComponent(number);
    }
}

function emailConfig() {
    return (typeof window !== 'undefined' && window.EMAIL_CONFIG) ? window.EMAIL_CONFIG : {};
}

function emailConfigValue(key, fallback) {
    const value = emailConfig()[key];
    return (value === undefined || value === null || value === '') ? fallback : value;
}

/**
 * True when the bridge is configured and switched on. Until the superadmin
 * pastes the Apps Script URL into js/email-config.js every send is skipped
 * gracefully (the approval itself is never affected).
 */
function isEmailConfigured() {
    const config = emailConfig();
    if (config.enabled === false) return false;
    const endpoint = String(config.endpoint || '').trim();
    if (!/^https:\/\//i.test(endpoint)) return false;
    if (endpoint.toUpperCase().indexOf('PASTE') > -1) return false;
    return true;
}

/** Lightweight format check — the bridge re-validates before sending. */
function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

/**
 * Where the approval email goes. Order of preference:
 *   1. the requester's own `email` field (public submit form),
 *   2. `contact` when it is actually an email (that box accepts phone OR email),
 *   3. the address captured by a re-access request.
 * Returns null when the ticket carries no usable address.
 */
function resolveRecipient(ticket) {
    if (!ticket) return null;
    const candidates = [
        ticket.email,
        ticket.contact,
        ticket.accessReopenRequest && ticket.accessReopenRequest.requestedByEmail
    ];
    for (let i = 0; i < candidates.length; i++) {
        const value = String(candidates[i] || '').trim().toLowerCase();
        if (isValidEmail(value)) return value;
    }
    return null;
}

/**
 * Recipient for the RE-ACCESS approval email. This is deliberately NOT
 * resolveRecipient(): the person who asked for access again is the store /
 * manager who used the Track page, which is frequently a different person
 * (and a different address) from whoever originally reported the ticket.
 *   1. accessReopenRequest.requestedByEmail  (the store/manager who asked)
 *   2. ticket.email                         (original reporter — fallback)
 *   3. ticket.contact                       (when it is actually an email)
 * Returns null when the ticket carries no usable address at all.
 */
function resolveReopenRecipient(ticket) {
    if (!ticket) return null;
    const reopen = ticket.accessReopenRequest || null;
    const candidates = [
        reopen && reopen.requestedByEmail,
        ticket.email,
        ticket.contact
    ];
    for (let i = 0; i < candidates.length; i++) {
        const value = String(candidates[i] || '').trim().toLowerCase();
        if (isValidEmail(value)) return value;
    }
    return null;
}

/** Ticket label used in the subject line and the body. */
function ticketEmailLabel(ticket) {
    if (!ticket) return 'Unknown';
    return String(ticket.ticketNumber || ticket.id || 'Unknown').trim();
}

// ===== PUBLIC-REACHABILITY GUARD =====
// The portal link does NOT go to a colleague: it is emailed to an EXTERNAL
// requester (a customer, a store manager) on their own phone data. A link that
// resolves on the superadmin's machine — an intranet hostname, a split-horizon
// DNS name, localhost, a file:// path, a 192.168.x.x dev server — is worthless
// to them and surfaces as "DNS_PROBE_FINISHED_NXDOMAIN" / "site can't be
// reached". So every candidate link is classified BEFORE it is emailed.
//
// A syntactically valid host name cannot be proven reachable from a browser
// (there is no DNS API), so this catches the structural cases; the
// verifyPortalLink() helper below does the live reachability check.
//
// Two SEPARATE rules, and the distinction matters:
//   • name rules  — always apply, the whole name is meaningless to the internet
//   • address rules — apply ONLY to a real IP literal. "192.168.example.com"
//     is a perfectly good public domain; "192.168.1.50" is a LAN address.
//     A single /^192\.168\./ regex conflates them and would block real hosts.
const NON_ROUTABLE_NAME_RE = /^(localhost$|.*\.(localhost|local|test|invalid|internal)$)/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** True only for a dotted-quad IPv4 literal with every octet <= 255. */
function isIpv4Literal(host) {
    if (!IPV4_RE.test(host)) return false;
    return host.split('.').every(function (octet) { return Number(octet) <= 255; });
}

/**
 * Classify a link for public reachability.
 * @returns {{ok: true, host: string, href: string}|{ok: false, reason: string}}
 */
function publicHostProblem(url) {
    const raw = String(url === undefined || url === null ? '' : url).trim();
    if (!raw) return { ok: false, reason: 'the link is empty' };

    let parsed;
    try {
        parsed = new URL(raw);
    } catch (error) {
        return { ok: false, reason: 'it is not an absolute http(s) URL (' + raw + ')' };
    }

    const protocol = String(parsed.protocol || '').toLowerCase();
    if (protocol === 'file:') {
        return { ok: false, reason: 'it is a local file:// path, which only opens on the superadmin\'s own PC' };
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
        return { ok: false, reason: 'it uses the ' + protocol + '// scheme, which a browser cannot open from an email' };
    }

    // Strip the [] that URL keeps around IPv6 literals.
    const host = String(parsed.hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    if (!host) return { ok: false, reason: 'it has no host name' };

    if (NON_ROUTABLE_NAME_RE.test(host)) {
        return { ok: false, reason: '"' + host + '" is an internal-only host name that does not '
            + 'exist on the public internet (localhost, or a .local / .internal / .test domain)' };
    }

    if (isIpv4Literal(host)) {
        const octets = host.split('.').map(Number);
        const blocked = (octets[0] === 127)
            ? 'the 127.0.0.0/8 loopback address'
            : (octets[0] === 10)
                ? 'the 10.0.0.0/8 private range'
                : (octets[0] === 192 && octets[1] === 168)
                    ? 'the 192.168.0.0/16 private range'
                    : (octets[0] === 169 && octets[1] === 254)
                        ? 'the 169.254.0.0/16 link-local range'
                        : (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
                            ? 'the 172.16.0.0/12 private range'
                            : (octets[0] === 0 && octets[1] === 0 && octets[2] === 0)
                                ? 'the 0.0.0.0 bind address'
                                : '';
        if (blocked) {
            return { ok: false, reason: '"' + host + '" is ' + blocked
                + ' — reachable only from the superadmin\'s own machine or network' };
        }
    }

    // IPv6 loopback and unique/local ranges.
    if (host === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)) {
        return { ok: false, reason: '"' + host + '" is a local IPv6 address (loopback, unique-local '
            + 'or link-local) and is unreachable from the public internet' };
    }

    return { ok: true, host: host, href: parsed.href };
}

// Warn once per distinct bad link — resolvePortalUrl() runs on every render and
// a console flood would hide the one line that matters. The mode is part of the
// key on purpose: flipping localDev off while the link is still a localhost one
// is precisely the moment the operator must be told again.
let lastWarnedPortalUrl = '';

/**
 * Portal link.
 *
 * EMAIL_CONFIG.portalUrl (the public address of submit-ticket.html) WINS when
 * set — that is the production setting and the only one a requester can open.
 * Otherwise the link auto-derives from <current page folder>/submit-ticket.html,
 * which is convenient while developing, but the result is validated and a
 * warning is raised whenever it could never work for an external recipient.
 */
function resolvePortalUrl() {
    const override = String(emailConfigValue('portalUrl', '') || '').trim();
    if (override) {
        // Honour an explicit setting, but never silently ship a broken one.
        const problem = publicHostProblem(override);
        if (!problem.ok) warnUnreachablePortalUrl(override, problem.reason);
        return override;
    }

    let derived;
    try {
        derived = new URL('submit-ticket.html', window.location.href).href;
    } catch (error) {
        derived = 'submit-ticket.html';
    }
    const problem = publicHostProblem(derived);
    if (!problem.ok) warnUnreachablePortalUrl(derived, problem.reason);
    return derived;
}

/** True only when the operator has explicitly declared "I am testing locally". */
function isLocalDevMode() {
    return emailConfig().localDev === true;
}

/** Console error (not warn) — this silently breaks every customer email. */
function warnUnreachablePortalUrl(url, reason, configKey) {
    const localDev = isLocalDevMode();
    // `configKey` is part of the dedupe key: the portal link and the dashboard
    // link can be broken for DIFFERENT reasons at the same time, and warning
    // only about the first one would hide the second.
    const setting = configKey || 'portalUrl';
    const warnKey = (localDev ? 'dev' : 'prod') + '|' + setting + '|' + url;
    if (lastWarnedPortalUrl === warnKey) return;
    lastWarnedPortalUrl = warnKey;

    if (localDev) {
        // Local testing is a legitimate reason for a non-routable link, so this
        // is guidance, not a defect. console.warn keeps it visible without
        // screaming at someone who is deliberately clicking through locally.
        console.warn(
            '[Approval Email] localDev is ON, so the link below is only usable on THIS '
            + 'machine:\n'
            + '  link  : ' + url + '\n'
            + '  why ok: ' + reason + ' — expected while developing.\n'
            + '  ⚠️ BEFORE GOING LIVE: set EMAIL_CONFIG.' + setting + ' to the public https:// '
            + 'address and set localDev: false.');
        return;
    }

    console.error(
        '[Approval Email] The link that will be emailed to requesters is NOT reachable '
        + 'from the public internet.\n'
        + '  link  : ' + url + '\n'
        + '  reason: ' + reason + '\n'
        + '  effect: the requester clicks the link and sees "This site can\'t be reached / '
        + 'DNS_PROBE_FINISHED_NXDOMAIN" (or a connection error).\n'
        + '  fix   : set EMAIL_CONFIG.' + setting + ' in js/email-config.js to the public '
        + 'https:// address, then hard-refresh (Ctrl+F5).\n'
        + '  check : run  await verifyPortalLink()  in the console.');
}

/**
 * Live check that the portal link really opens.
 *
 *     await verifyPortalLink()
 *
 * A cross-origin `mode: 'no-cors'` GET resolves with an OPAQUE response when the
 * host resolved, connected and answered — and REJECTS when it did not. That is
 * the same code path a requester takes from their phone, so it catches a typo'd
 * host, a subdomain that was never created in DNS (the exact cause of
 * "DNS_PROBE_FINISHED_NXDOMAIN"), or a folder that was never deployed. Never
 * throws.
 */
async function verifyPortalLink() {
    const url = resolvePortalUrl();
    const problem = publicHostProblem(url);
    const localDev = isLocalDevMode();

    if (!problem.ok && !localDev) {
        return {
            ok: false,
            url: url,
            stage: 'address',
            error: 'The portal link cannot work for a requester — ' + problem.reason + '. '
                + 'Set EMAIL_CONFIG.portalUrl in js/email-config.js to the public address of '
                + 'submit-ticket.html.'
        };
    }

    const controller = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 15000) : null;
    try {
        await fetch(url, {
            method: 'GET',
            mode: 'no-cors',
            cache: 'no-store',
            redirect: 'follow',
            signal: controller ? controller.signal : undefined
        });
        if (localDev) {
            return {
                ok: true,
                url: url,
                stage: 'local-dev',
                note: 'The local server answered. Click the link to open the Track Ticket Status '
                    + 'modal with the ticket number prefilled — it only works on THIS machine, '
                    + 'which is correct while you are developing. Before going live, set '
                    + 'EMAIL_CONFIG.portalUrl to the public address and localDev: false, then '
                    + 're-test from a phone on mobile data.'
            };
        }
        return {
            ok: true,
            url: url,
            host: problem.host,
            note: 'The host resolved and answered. Now open it in an Incognito window — ideally on a '
                + 'phone using mobile data — to confirm the Track Ticket Status modal loads. A '
                + 'reachable host is not proof the right page is deployed there.'
        };
    } catch (error) {
        const aborted = (error && error.name) === 'AbortError';
        if (localDev) {
            return {
                ok: false,
                url: url,
                stage: 'local-dev',
                error: 'Nothing is serving ' + url + '. Start it with  npm run serve  (from the '
                    + 'project folder) and try again.'
            };
        }
        return {
            ok: false,
            url: url,
            host: problem.host,
            stage: 'request',
            error: aborted
                ? 'The portal host did not answer within 15s.'
                : 'The portal host could not be reached ('
                  + ((error && error.message) || 'network error') + '). If the name looks right it '
                  + 'has no public DNS record yet, and requesters will see '
                  + '"DNS_PROBE_FINISHED_NXDOMAIN" when they click the link.'
        };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * The "viewing access until …" line is only useful in production. While
 * Tier-2 time-compression is on (window.TRACKING_ACCESS_WINDOW_MS = 1 minute)
 * promising "1 minute" to a store manager would be wrong, and an ALREADY
 * EXPIRED ticket must never advertise a past date — so the line is skipped.
 */
function shouldMentionViewingWindow(ticket) {
    const ms = Number(window.TRACKING_ACCESS_WINDOW_MS);
    if (!Number.isFinite(ms) || ms < 24 * 60 * 60 * 1000) return false;
    if (typeof window.getTrackingAccessExpiry !== 'function') return false;
    const expiry = window.getTrackingAccessExpiry(ticket);
    return !!expiry && expiry.getTime() > Date.now();
}

function formatEmailDateTime(value) {
    const date = (value && typeof value.toDate === 'function') ? value.toDate() : value;
    const d = date instanceof Date ? date : new Date(date);
    if (!d || isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true
    });
}

// Local escapers (mirrors the escapers in script.js / js/notifications.js) so
// this module stays self-contained even though it loads before script.js.
function escapeEmailHtml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Build the exact message the requester receives.
 * Plain text first (spam-filter friendly) with a very light HTML twin.
 *
 * ⚠️ THE LINK GOES TO THE OWNER DASHBOARD, not the public Track portal. The
 * requester here is an Area Manager with an account; they read their approved
 * ticket on `ownerdashboard.html`. It is a login-gated page, so they are bounced
 * to login.html and returned — `?ticket=` survives that round trip (js/auth.js),
 * which is why this is a DEEP LINK and not a bare dashboard address.
 */
function buildTicketApprovedEmail(ticket) {
    const label = ticketEmailLabel(ticket);
    const dashboardUrl = resolveOwnerDashboardUrl();
    // The deep link actually used as the href. Falls back to the bare dashboard
    // when there is no usable ticket number, so href is NEVER empty — an empty
    // href renders as un-clickable text, which is the bug being fixed here.
    const ticketUrl = resolveOwnerTicketUrl(label);
    const senderName = String(emailConfigValue('senderName', 'Jiangnan Command Center'));

    // ⚠️ Keep this sentence verbatim — it is the automated text requested by
    // the business ("Ticket request was done, please check …").
    const headline = EMAIL_HEADLINE_PREFIX + label;

    // ⚠️ NO DATE, NO COUNTDOWN. The window starts when the requester FIRST OPENS the
    // ticket, so at the moment this email is sent there is no expiry to put a
    // date on. The old copy read "Viewing access is available until <date>",
    // derived from `accessExpiresAt` written at APPROVAL — which is exactly the
    // deadline this feature removed. Promising a date here would be promising
    // something the system no longer decides at approval time.
    const windowMs = window.TRACKING_ACCESS_WINDOW_MS;
    const windowLabel = (typeof window.formatTrackingAccessWindow === 'function')
        ? window.formatTrackingAccessWindow(windowMs)
        : '2 days';
    // Same time-compression guard as shouldMentionViewingWindow(): while the
    // window is compressed for testing, promising "1 minute" to a store manager
    // is nonsense, so the sentence is dropped rather than reworded.
    const windowStartsOnOpen = Number.isFinite(Number(windowMs))
        && Number(windowMs) >= 24 * 60 * 60 * 1000;
    const windowLine = windowStartsOnOpen
        ? 'Viewing access starts when you first open the ticket, and stays available for '
            + windowLabel + '.'
        : '';

    // The URL sits on its OWN LINE in the plain-text part. That is what lets
    // Gmail/Outlook auto-detect and linkify it — a URL glued to the end of a
    // sentence is often left as inert text, which is exactly the "the link is
    // not clickable" report this change fixes.
    const lines = [
        headline,
        '',
        '   Ticket Number:  ' + label,
        '',
        'View it on your Owner Dashboard:',
        ticketUrl,
        '',
        '  -> sign in with your account',
        '  -> ticket ' + label + ' will open automatically.'
    ];
    if (windowLine) lines.push('', windowLine);
    lines.push('', senderName);
    const text = lines.join('\n');

    // ⚠️ WHY A BUTTON AND NOT A PLAIN TEXT LINK. The reported symptom was that
    // the link "is not clickable". A thin coloured line of text is easy to read
    // past, is easy for a client to strip, and on a phone is a small tap target.
    // A padded, high-contrast block is unmistakably tappable. Gmail strips
    // <style> blocks and many CSS properties, so everything is inline-styled.
    // The raw URL is repeated underneath as a fallback for clients that render
    // the button but somehow refuse to linkify it.
    const html = [
        '<div style="font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:15px;color:#0f172a;line-height:1.6">',
        '<p style="margin:0 0 16px">' + escapeEmailHtml(headline) + '</p>',
        '<p style="margin:0 0 18px"><span style="display:inline-block;padding:10px 16px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;font-size:18px;font-weight:700;letter-spacing:0.4px">',
        escapeEmailHtml(label),
        '</span></p>',
        '<p style="margin:0 0 18px">',
        '<a href="' + escapeEmailHtml(ticketUrl) + '" style="display:inline-block;background:#15803d;color:#ffffff;font-weight:700;font-size:16px;text-decoration:none;padding:14px 28px;border-radius:8px">',
        'Open my Owner Dashboard &rarr;</a>',
        '</p>',
        '<p style="margin:0 0 6px;color:#475569">Sign in with your account and ticket <strong>'
            + escapeEmailHtml(label) + '</strong> opens automatically.</p>',
        // Fallback link, deliberately plain so no client can style it away.
        '<p style="margin:0 0 6px;font-size:12px;color:#64748b">If the button does not work, paste this '
            + 'into your browser:<br><a href="' + escapeEmailHtml(ticketUrl) + '" style="color:#15803d;word-break:break-all">'
            + escapeEmailHtml(ticketUrl) + '</a></p>',
        windowLine ? '<p style="margin:0 0 6px;color:#475569">' + escapeEmailHtml(windowLine) + '</p>' : '',
        '<p style="margin:20px 0 0;color:#475569">' + escapeEmailHtml(senderName) + '</p>',
        '</div>'
    ].join('');

    return {
        to: resolveRecipient(ticket) || '',
        subject: EMAIL_SUBJECT_PREFIX + label,
        text: text,
        html: html,
        ticketId: String((ticket && (ticket.id || ticket.ticketNumber)) || ''),
        ticketNumber: label,
        // `portalUrl` is kept in the returned shape (alongside the new
        // `dashboardUrl`) because script.js and the tests read it, and because a
        // bare dashboard address is still the meaningful "where did this go".
        portalUrl: ticketUrl,
        dashboardUrl: dashboardUrl,
        senderName: senderName
    };
}

/**
 * Dev helper — proves the OWNER DASHBOARD deep link (the one the approval email
 * actually sends) opens from the internet.
 *
 *     await verifyOwnerDashboardLink()
 *
 * ⚠️ This is a SEPARATE function from verifyPortalLink() rather than a
 * repointing of it. verifyPortalLink() checks the login-free Track link, which
 * the RE-ACCESS email still uses, and its return shape is asserted by
 * test/ticket-email.test.js. Collapsing the two would either break that contract
 * or stop checking the Track page at all.
 *
 * Note this only proves the ADDRESS resolves. The dashboard is behind a login,
 * so this is not "the recipient is signed in" — it still redirects to
 * login.html, which is expected and correct.
 */
async function verifyOwnerDashboardLink() {
    const url = resolveOwnerTicketUrl('BNW-TIX007');
    const problem = publicHostProblem(url);
    if (!problem.ok) {
        return {
            ok: false,
            stage: 'address',
            url: url,
            error: 'The Owner Dashboard link is not reachable from the public internet ('
                + problem.reason + ').\n  Set EMAIL_CONFIG.ownerDashboardUrl in js/email-config.js '
                + 'to the public https:// address of ownerdashboard.html.'
        };
    }

    if (isLocalDevMode()) {
        try {
            await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
        } catch (error) {
            return {
                ok: false,
                stage: 'local-dev',
                url: url,
                error: 'Nothing is serving the folder. Start it with: npm run serve'
            };
        }
        return { ok: true, stage: 'local-dev', url: url };
    }

    try {
        await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' });
        return { ok: true, stage: 'request', url: url };
    } catch (error) {
        return {
            ok: false,
            stage: 'request',
            url: url,
            error: 'The request failed (' + (error && error.message ? error.message : 'unknown error')
                + '). The host has no public DNS record, or nothing is deployed at that path.'
        };
    }
}

/**
 * Build the "re-access approved" message for the store/manager.
 *
 * ⚠️ NO EXPIRY DATE IS QUOTED. A Resend RE-ARMS the window rather than starting
 * it — it clears `accessOpenedAt` and the manager's next open begins a fresh
 * one — so at the moment this email is sent there is no deadline that exists.
 * The old copy read "Viewing access is available until <date>"; that date was
 * computed at Resend time and has no equivalent under the first-open rule.
 */
function buildAccessApprovedEmail(ticket, accessExpiresAt) {
    const label = ticketEmailLabel(ticket);
    // ⚠️ SAME LINK AS THE APPROVAL EMAIL, ON PURPOSE.
    // This used to point at the login-free Track portal (submit-ticket.html?track=)
    // with "click Track Ticket Status". But an approved ticket is read in ONE
    // place — the Owner Dashboard report modal — and the approval email already
    // deep-links there. Sending a second email to a different page for the same
    // ticket was simply inconsistent: the recipient had to learn two mechanisms
    // for one modal. Both emails now resolve the identical deep link.
    const ticketUrl = resolveOwnerTicketUrl(label);
    const dashboardUrl = resolveOwnerDashboardUrl();
    const senderName = String(emailConfigValue('senderName', 'Jiangnan Command Center'));

    // ⚠️ NO DATE HERE EITHER — same reason as the approval email. Kept as a
    // fallback for callers that DO pass a real deadline (scripts/seed.js's
    // preview helper does); the live flow passes nothing and gets the
    // "starts when you open it" line below.
    const expiry = accessExpiresAt
        || (typeof window.getTrackingAccessExpiry === 'function'
            ? window.getTrackingAccessExpiry(ticket)
            : null);
    const expiryDate = expiry ? (expiry instanceof Date ? expiry : new Date(expiry)) : null;
    const hasRealExpiry = expiryDate
        && !isNaN(expiryDate.getTime())
        && expiryDate.getTime() > Date.now();
    const windowMs = window.TRACKING_ACCESS_WINDOW_MS;
    const windowLabel = (typeof window.formatTrackingAccessWindow === 'function')
        ? window.formatTrackingAccessWindow(windowMs)
        : '2 days';
    // Dropped entirely while the window is time-compressed for testing.
    const windowInProduction = Number.isFinite(Number(windowMs))
        && Number(windowMs) >= 24 * 60 * 60 * 1000;
    const windowLine = hasRealExpiry
        ? 'Viewing access is available until ' + formatEmailDateTime(expiryDate) + '.'
        : (windowInProduction
            ? 'Viewing access starts when you first open the ticket, and stays available for '
                + windowLabel + '.'
            : '');

    const lines = [
        ACCESS_EMAIL_HEADLINE,
        '',
        '   Ticket Number:  ' + label,
        '',
        'View it on your Owner Dashboard:',
        ticketUrl,
        '',
        '  -> sign in with your account',
        '  -> ticket ' + label + ' will open automatically.'
    ];
    if (windowLine) lines.push('', windowLine);
    lines.push('', senderName);
    const text = lines.join('\n');

    // Same padded green button as the approval email — see buildTicketApprovedEmail()
    // for why a thin text link reads as "not clickable". The raw URL is repeated
    // as a fallback anchor and, in the plain-text part above, on its own line so
    // mail clients auto-linkify it.
    const html = [
        '<div style="font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:15px;color:#0f172a;line-height:1.6">',
        '<p style="margin:0 0 16px">' + escapeEmailHtml(ACCESS_EMAIL_HEADLINE) + '</p>',
        '<p style="margin:0 0 18px"><span style="display:inline-block;padding:10px 16px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;font-size:18px;font-weight:700;letter-spacing:0.4px">',
        escapeEmailHtml(label),
        '</span></p>',
        '<p style="margin:0 0 18px">',
        '<a href="' + escapeEmailHtml(ticketUrl) + '" style="display:inline-block;background:#15803d;color:#ffffff;font-weight:700;font-size:16px;text-decoration:none;padding:14px 28px;border-radius:8px">',
        'Open my Owner Dashboard &rarr;</a>',
        '</p>',
        '<p style="margin:0 0 6px;color:#475569">Sign in with your account and ticket <strong>'
            + escapeEmailHtml(label) + '</strong> opens automatically.</p>',
        '<p style="margin:0 0 6px;font-size:12px;color:#64748b">If the button does not work, paste this '
            + 'into your browser:<br><a href="' + escapeEmailHtml(ticketUrl) + '" style="color:#15803d;word-break:break-all">'
            + escapeEmailHtml(ticketUrl) + '</a></p>',
        windowLine ? '<p style="margin:0 0 6px;color:#475569">' + escapeEmailHtml(windowLine) + '</p>' : '',
        '<p style="margin:20px 0 0;color:#475569">' + escapeEmailHtml(senderName) + '</p>',
        '</div>'
    ].join('');

    return {
        to: resolveReopenRecipient(ticket) || '',
        subject: ACCESS_EMAIL_SUBJECT_PREFIX + label,
        text: text,
        html: html,
        ticketId: String((ticket && (ticket.id || ticket.ticketNumber)) || ''),
        ticketNumber: label,
        portalUrl: ticketUrl,
        dashboardUrl: dashboardUrl,
        senderName: senderName
    };
}

/**
 * Idempotency guard for the Approve button.
 * `prevApprovalStatus` is the status the ticket had BEFORE this click: a
 * repeat/replayed approve click on an already-approved ticket must never send a
 * second email. A rejection cycle flips approvalStatus back to
 * 'pending_approval', so the NEXT approval is allowed to send again — and the
 * ✉ row action passes { force: true } to bypass every guard on purpose.
 */
function shouldSkipApprovalEmail(prevApprovalStatus, opts) {
    if (opts && opts.force) return false;
    return String(prevApprovalStatus || '').trim().toLowerCase() === 'approved';
}

/** Firebase ID token of the signed-in superadmin — verified by the bridge. */
async function getEmailCallerToken() {
    try {
        if (typeof auth === 'undefined' || !auth || !auth.currentUser) return '';
        if (typeof auth.currentUser.getIdToken !== 'function') return '';
        return (await auth.currentUser.getIdToken()) || '';
    } catch (error) {
        console.warn('[Approval Email] Could not read the Firebase ID token:', error && error.message ? error.message : error);
        return '';
    }
}

/**
 * POST the message to the Apps Script bridge.
 *
 * `mode: 'no-cors'` is required, which means the browser hands back an OPAQUE
 * response — "OK" cannot be read. Hence a single fire-and-forget attempt:
 * NEVER retry here, a retry could send the same email twice.
 */
async function postEmailToBridge(payload) {
    const endpoint = String(emailConfig().endpoint || '');
    const controller = (typeof AbortController === 'function') ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), EMAIL_SEND_TIMEOUT_MS) : null;
    try {
        await fetch(endpoint, {
            method: 'POST',
            mode: 'no-cors',
            // text/plain keeps this a "simple request" → no CORS preflight.
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload),
            signal: controller ? controller.signal : undefined
        });
        return { ok: true, status: 'dispatched' };
    } catch (error) {
        // An abort/timeout lands here too — the message may still have been sent,
        // so the caller records `failed` and the superadmin can retry with ✉.
        // The wording below is what the superadmin reads in the toast, so it has
        // to say WHAT happened, not just "aborted".
        const name = (error && error.name) || '';
        if (name === 'AbortError') {
            return {
                ok: false,
                status: 'failed',
                timeout: true,
                error: 'The email bridge did not answer in ' +
                    Math.round(EMAIL_SEND_TIMEOUT_MS / 1000) + 's. ' +
                    'Check Apps Script > Executions for a new doPost, and try ' +
                    'again in an Incognito window (ad-blockers/privacy ' +
                    'extensions often block the script.googleusercontent.com redirect).'
            };
        }
        return {
            ok: false,
            status: 'failed',
            error: (error && error.message)
                ? error.message
                : 'Could not reach the email bridge.'
        };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Send the "your access request was approved" notification.
 * Identical transport to sendTicketApprovedEmail — only the built message
 * differs. NEVER throws.
 */
async function sendAccessApprovedEmail(ticket, accessExpiresAt) {
    try {
        if (!ticket) return { ok: false, status: 'no_ticket' };
        if (!isEmailConfigured()) return { ok: false, status: 'not_configured' };

        const message = buildAccessApprovedEmail(ticket, accessExpiresAt);
        if (!message.to || !isValidEmail(message.to)) {
            return { ok: false, status: 'no_recipient', to: '' };
        }

        const idToken = await getEmailCallerToken();
        if (!idToken) {
            return { ok: false, status: 'no_auth', to: message.to, error: 'missing_firebase_token' };
        }

        const result = await postEmailToBridge({
            secret: String(emailConfig().secret || ''),
            idToken: idToken,
            ticketId: message.ticketId,
            ticketNumber: message.ticketNumber,
            to: message.to,
            subject: message.subject,
            text: message.text,
            html: message.html,
            sentBy: (typeof auth !== 'undefined' && auth && auth.currentUser && auth.currentUser.email) || ''
        });
        return Object.assign({ to: message.to }, result);
    } catch (error) {
        return {
            ok: false,
            status: 'failed',
            error: (error && error.message) ? error.message : 'unknown_error'
        };
    }
}

/**
 * Send the approval notification for one ticket.
 * NEVER throws — always resolves with a small result object so the caller can
 * carry on regardless of email trouble.
 */
async function sendTicketApprovedEmail(ticket, opts) {
    try {
        if (!ticket) return { ok: false, status: 'no_ticket' };
        if (!isEmailConfigured()) return { ok: false, status: 'not_configured' };

        const message = buildTicketApprovedEmail(ticket);
        if (!message.to || !isValidEmail(message.to)) {
            return { ok: false, status: 'no_recipient', to: '' };
        }

        const idToken = await getEmailCallerToken();
        if (!idToken) {
            return { ok: false, status: 'no_auth', to: message.to, error: 'missing_firebase_token' };
        }

        const result = await postEmailToBridge({
            secret: String(emailConfig().secret || ''),
            idToken: idToken,
            ticketId: message.ticketId,
            ticketNumber: message.ticketNumber,
            to: message.to,
            subject: message.subject,
            text: message.text,
            html: message.html,
            sentBy: (typeof auth !== 'undefined' && auth && auth.currentUser && auth.currentUser.email) || ''
        });
        return Object.assign({ to: message.to }, result);
    } catch (error) {
        return {
            ok: false,
            status: 'failed',
            error: (error && error.message) ? error.message : 'unknown_error'
        };
    }
}
/**
 * Build the "ticket under investigation" notification for the requester
 * when a superadmin transfers a ticket to HR (sensitive case). No viewing
 * access is granted — the ticket is NOT resolved.
 */
function buildTicketHrTransferEmail(ticket) {
  const label = ticketEmailLabel(ticket);
  const dashboardUrl = resolveOwnerDashboardUrl();
  const ticketUrl = resolveOwnerTicketUrl(label);
  const senderName = String(emailConfigValue('senderName', 'Jiangnan Command Center'));

  const headline = 'Ticket ' + label + ' is Under Investigation';

  const lines = [
    headline,
    '',
    '   Ticket Number:  ' + label,
    '',
    'Your ticket request has been received and is currently under investigation.',
    'This case is being handled privately by our HR team.',
    '',
    'No viewing access is required at this time. You will be notified if',
    'further information or action is needed from your side.',
    '',
    'If you have any questions, please contact HR directly.',
    '',
    senderName
  ];
  const text = lines.join('\n');

  const html = [
    '<div style="font-family:Segoe UI,Arial,Helvetica,sans-serif;font-size:15px;color:#0f172a;line-height:1.6">',
    '<p style="margin:0 0 16px">' + escapeEmailHtml(headline) + '</p>',
    '<p style="margin:0 0 18px"><span style="display:inline-block;padding:10px 16px;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;font-size:18px;font-weight:700;letter-spacing:0.4px">',
    escapeEmailHtml(label),
    '</span></p>',
    '<p style="margin:0 0 12px">Your ticket request has been received and is currently under investigation.</p>',
    '<p style="margin:0 0 12px">This case is being handled privately by our HR team.</p>',
    '<p style="margin:0 0 12px">No viewing access is required at this time. You will be notified if further information or action is needed from your side.</p>',
    '<p style="margin:0 0 12px">If you have any questions, please contact HR directly.</p>',
    '<p style="margin:20px 0 0;color:#475569">' + escapeEmailHtml(senderName) + '</p>',
    '</div>'
  ].join('');

  return {
    to: resolveRecipient(ticket) || '',
    subject: 'Ticket Under Investigation \u2014 ' + label,
    text: text,
    html: html,
    ticketId: String((ticket && (ticket.id || ticket.ticketNumber)) || ''),
    ticketNumber: label,
    portalUrl: ticketUrl,
    dashboardUrl: dashboardUrl,
    senderName: senderName
  };
}

/**
 * Send the "ticket under investigation" notification for HR-transferred tickets.
 * NEVER throws — always resolves with a small result object.
 */
async function sendTicketHrTransferEmail(ticket, opts) {
  try {
    if (!ticket) return { ok: false, status: 'no_ticket' };
    if (!isEmailConfigured()) return { ok: false, status: 'not_configured' };

    const message = buildTicketHrTransferEmail(ticket);
    if (!message.to || !isValidEmail(message.to)) {
      return { ok: false, status: 'no_recipient', to: '' };
    }

    const idToken = await getEmailCallerToken();
    if (!idToken) {
      return { ok: false, status: 'no_auth', to: message.to, error: 'missing_firebase_token' };
    }

    const result = await postEmailToBridge({
      secret: String(emailConfig().secret || ''),
      idToken: idToken,
      ticketId: message.ticketId,
      ticketNumber: message.ticketNumber,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      sentBy: (typeof auth !== 'undefined' && auth && auth.currentUser && auth.currentUser.email) || ''
    });
    return Object.assign({ to: message.to }, result);
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      error: (error && error.message) ? error.message : 'unknown_error'
    };
  }
}


/**
 * Dev helper — run this once from the browser console on main.html (or from
 * the Approvals tab) to prove the bridge works before approving a real ticket:
 *
 *     sendTestTicketEmail('jiangnancommandcenter@gmail.com')
 */
function sendTestTicketEmail(to, opts) {
    const sample = {
        id: 'TIX-TEST',
        ticketNumber: 'TIX-TEST',
        email: to,
        branch: 'Test branch',
        incident: 'Notification test',
        approvalStatus: 'approved',
        approvedAt: new Date(),
        accessExpiresAt: new Date(Date.now() + (48 * 60 * 60 * 1000))
    };
    return sendTicketApprovedEmail(sample, Object.assign({ force: true }, opts || {}));
}

/**
 * Dev helper for the RE-ACCESS approval mail (mirrors sendTestTicketEmail):
 *
 *     sendTestAccessEmail('jiangnancommandcenter@gmail.com')
 */
function sendTestAccessEmail(to, opts) {
    const sample = {
        id: 'TIX-TEST',
        ticketNumber: 'TIX-TEST',
        email: '',
        accessReopenRequest: { status: 'pending', requestedByEmail: to },
        approvalStatus: 'approved',
        approvedAt: new Date()
    };
    return sendAccessApprovedEmail(sample, new Date(Date.now() + (48 * 60 * 60 * 1000)));
}

// ===== EXPOSE GLOBALLY =====
window.EmailService = {
    isEmailConfigured: isEmailConfigured,
    isValidEmail: isValidEmail,
    resolveRecipient: resolveRecipient,
    resolveReopenRecipient: resolveReopenRecipient,
    resolvePortalUrl: resolvePortalUrl,
    resolveTrackUrl: resolveTrackUrl,
    resolveOwnerDashboardUrl: resolveOwnerDashboardUrl,
    resolveOwnerTicketUrl: resolveOwnerTicketUrl,
    publicHostProblem: publicHostProblem,
    isLocalDevMode: isLocalDevMode,
    verifyPortalLink: verifyPortalLink,
    verifyOwnerDashboardLink: verifyOwnerDashboardLink,
    ticketEmailLabel: ticketEmailLabel,
    buildTicketApprovedEmail: buildTicketApprovedEmail,
    buildTicketHrTransferEmail: buildTicketHrTransferEmail,
    buildAccessApprovedEmail: buildAccessApprovedEmail,
    shouldMentionViewingWindow: shouldMentionViewingWindow,
    shouldSkipApprovalEmail: shouldSkipApprovalEmail,
    getEmailCallerToken: getEmailCallerToken,
    sendTicketApprovedEmail: sendTicketApprovedEmail,
    sendTicketHrTransferEmail: sendTicketHrTransferEmail,
    sendAccessApprovedEmail: sendAccessApprovedEmail
};
window.sendTestTicketEmail = sendTestTicketEmail;
window.sendTestAccessEmail = sendTestAccessEmail;
// Run this from the console on ANY page before approving: it proves the link
// that is about to be emailed to a requester actually opens from the internet.
window.verifyPortalLink = verifyPortalLink;
// Same idea for the Owner Dashboard deep link that the approval email sends.
window.verifyOwnerDashboardLink = verifyOwnerDashboardLink;



