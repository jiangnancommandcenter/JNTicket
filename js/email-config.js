/**
 * ==============================================================
 *  APPROVAL EMAIL NOTIFICATION — CONFIGURATION
 * ==============================================================
 *  When a superadmin approves a resolution (script.js → approveResolution())
 *  the requester automatically receives a short "Ticket request was done…"
 *  email FROM THE BUSINESS GMAIL ACCOUNT.
 *
 *  ⚠️ HOW IT SENDS (read this once):
 *  A browser cannot speak SMTP (no raw TCP/TLS sockets), so a Gmail app
 *  password can never be used from this page — and hardcoding mailbox
 *  credentials into a client-side file would hand the whole mailbox to
 *  anyone who opens "View Source". The actual sending is done by a tiny
 *  Google Apps Script Web App ("the bridge") that runs inside the business
 *  Gmail account itself:
 *
 *      deploy → docs/apps-script/RCMS-Ticket-Notifier.gs
 *      setup  → docs/EMAIL-SETUP.md   (≈5 minutes, no billing required)
 *
 *  ⚠️ NOTHING IN THIS FILE IS A SECRET. Both values below end up in the
 *  browser by design:
 *    • `endpoint` — the public Apps Script /exec URL.
 *    • `secret`   — only a casual-abuse speed bump.
 *  The real gate is SERVER-SIDE: the bridge verifies the caller's Firebase
 *  ID token and refuses to send unless that user is a superadmin.
 * ==============================================================
 */

window.EMAIL_CONFIG = {
    // 1) Paste the Apps Script Web App URL (ends with /exec) after deploying.
    //    Leave '' and every send is skipped gracefully (approvals still work).
    endpoint: 'https://script.google.com/macros/s/AKfycbx5cW9sAQFvpL1sp2hD7ilM3K2x4ruHeVGRYRced5bdP3NFBXIMxU24mJxJQH-9UTgR/exec',

    // 2) Same random string you stored in the script's SHARED_SECRET property.
    secret: 'rcms_secret_9982xyz',

    // 3) Sender identity.
    //    `senderEmail` MUST be the Gmail account that deployed the Apps Script —
    //    Gmail always rewrites From: to the authenticated mailbox.
    senderName: 'Jiangnan Command Center',
    senderEmail: 'jiangnancommandcenter@gmail.com',
    replyTo: 'jiangnancommandcenter@gmail.com',
    // Display name Gmail shows in the "To:" field when someone hits Reply.
    // Needs the raw-MIME path (Gmail API service added). If the service is not
    // enabled the bridge falls back to GmailApp and only the address is sent.
    replyToName: 'Ticket Requester',

    // 4) ⚠️ THE PUBLIC PORTAL LINK — READ THIS BEFORE GOING LIVE.
    //
    //    This is the link that gets EMAILED to an external requester (a customer
    //    or a store manager, on their own phone data). It MUST be the public
    //    https:// address of submit-ticket.html.
    //
    //    ⚠️⚠️ TODO — FILL THIS IN BEFORE DEPLOYING ⚠️⚠️
    //    Left as '' the link is auto-derived from whatever page the superadmin
    //    happens to be on when they click Approve (see resolvePortalUrl() in
    //    js/email.js). That is fine on localhost, but if that page is on an
    //    intranet name, a file:// path or a 192.168.x.x dev server, every
    //    customer receives a link that only opens on the superadmin's PC —
    //    they see "This site can't be reached / DNS_PROBE_FINISHED_NXDOMAIN".
    //
    //    Put the PUBLIC address of the deployed submit-ticket.html here, e.g.:
    //        portalUrl: 'https://<public-host>/<folder>/submit-ticket.html',
    //
    //    Then verify from the browser console on the deployed page:
    //        await verifyPortalLink()
    //    and, on a phone using mobile data, click the link in a real test email.
    portalUrl: '',

    // 4b) THE OWNER DASHBOARD LINK — THIS IS THE ONE THE APPROVAL EMAIL SENDS.
    //
    //    ⚠️ AS OF THE "clickable Owner Dashboard link" CHANGE, `ownerdashboard.html`
    //    REPLACED `submit-ticket.html` as the target of the approval email. An Area
    //    Manager who gets "your request was done" now expects to land on their own
    //    dashboard, not on a public status portal they have no account for.
    //
    //    NOTE THIS IS A LOGIN-GATED PAGE (js/auth.js → PROTECTED_PAGES), so the
    //    manager is bounced to login.html and returned here after signing in. The
    //    `?ticket=` number survives that round trip (see redirectToLogin).
    //
    //    Same rule as portalUrl: leave '' while developing and the link auto-derives
    //    from the superadmin's current page. Pin it to the PUBLIC https:// address
    //    before go-live, or every manager receives a localhost link.
    //
    // ⚠️⚠️ THIS IS THE ONE LINE YOU MUST EDIT BEFORE THE LINK WORKS FOR ANYONE
    //⚠️⚠️ ELSE. It is deliberately left EMPTY rather than filled with a guessed
    // host: a hardcoded wrong domain is far worse than an empty value, because
    // it looks configured and silently emails a dead link to every manager
    // (that is exactly how `portal.jiangnanhotpot.com` shipped once). Leave it
    // '' ONLY if you are testing on your own machine.
    //
    //        ownerDashboardUrl: 'https://<public-host>/<folder>/ownerdashboard.html',
    //
    //    Then verify from the console on the DEPLOYED page:
    //        await verifyOwnerDashboardLink()
    ownerDashboardUrl: '',

    // 5) OPTIONAL display name for the To: line ('' = plain email address).
    toDisplayName: '',

    // 6) LOCAL DEVELOPMENT ONLY.
    //    true  = you are testing on your own machine (`npm run serve`, so the
    //            site is at http://localhost:5500). The portal link that gets
    //            emailed is a localhost link — clickable on THIS PC, useless to
    //            everyone else. The reachability guard then speaks with
    //            console.warn instead of console.error, and verifyPortalLink()
    //            reports stage 'local-dev' instead of failing.
    //    false = production. Any link that cannot work for a real requester is
    //            reported loudly. LEAVE THIS false WHEN YOU GO LIVE.
    localDev: true,

    // Master switch. false = never send (the Approve button is unaffected).
    enabled: true
};
