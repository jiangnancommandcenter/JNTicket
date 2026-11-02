# Approval Email Notification — Setup Guide

When a **superadmin approves a resolution**, the requester automatically receives a
short email from the **business Gmail account** telling them to check the portal with
their ticket number.

```
Area Manager files a ticket (ownerdashboard.html, +Ticket modal)
                       →  tickets/bnw-tix007   (email: juan@store.com)
Operator resolves it      →  status: 'Resolved', approvalStatus: 'pending_approval'
Superadmin presses Approve →  approvalStatus: 'approved'
                              ↓
                     email from Jiangnan Command Center <jiangnancommandcenter@gmail.com>
                              ↓
                     "Ticket request was done, please check your request to the
                      portal with this Ticket number: BNW-TIX007"
```

| | |
|---|---|
| **Sender** | `Jiangnan Command Center` ‹`jiangnancommandcenter@gmail.com`› |
| **Reply-To** | `Ticket Requester` ‹`jiangnancommandcenter@gmail.com`› |
| **Cost** | **Not a single peso** — no billing account, no Blaze plan, no Firebase Functions |
| **App password** | **Not used and not needed** (a browser cannot speak SMTP at all) |
| **Setup time** | ≈5 minutes, one time only |

---

## Why a bridge is required (read once)

A web page **cannot** open an SMTP connection — browsers have no raw TCP/TLS socket
API, and Gmail's HTTPS API accepts only OAuth2, never an app password. Therefore:

* ❌ An **app password inside `script.js`** can never send anything *and* it would hand
  the whole mailbox to anyone who opens **View Source**.
* ❌ Storing the app password in Firestore and reading it client-side does not help
  either — it still cannot send, and the credential now leaks into the browser.
* ✅ A **Google Apps Script Web App** runs *inside the business Gmail account* and does
  the sending (`GmailApp` / Gmail API). The website only POSTs the message.

**Guest protection:** the deployed URL is reachable by anyone, but the script verifies
the caller's **Firebase ID token** and refuses to send unless that signed-in Firebase
user's profile has `role: 'superadmin'`. A per-day cap and an exact-recipient check
against the ticket document sit on top of that.

---

## Part A — Google side (once, ≈5 minutes)

> Do this **while signed in as `jiangnancommandcenter@gmail.com`** — that account
> becomes the sender. Gmail always rewrites `From:` to the authenticated mailbox.

**A1. Create the script**
1. Go to <https://script.google.com> → **New project**.
2. Rename it: **RCMS Ticket Notifier**.
3. Delete the sample `myFunction()` and paste the entire content of
   [`docs/apps-script/RCMS-Ticket-Notifier.gs`](apps-script/RCMS-Ticket-Notifier.gs).
4. *(Optional but recommended)* Left sidebar → **Services** → **+** → choose
   **Gmail API** → **Add**. This enables the hand-built MIME path — the only way to
   keep the `Reply-To: Ticket Requester` **display name**. Without it the email still
   sends; only the display name on the reply is dropped.
5. **Ctrl+S** (Save).

**A2. Set the shared secret**
1. Left sidebar → ⚙ **Project Settings**.
2. Scroll to **Script properties** → **Add script property**.
3. Property `SHARED_SECRET` → Value: a random string you invent (30+ characters).
4. **Save script properties**, then copy it — the same string goes into
   `js/email-config.js` in Part B.

**A3. Deploy as a Web App**
1. **Deploy ▸ New deployment**.
2. Gear ⚙ icon → choose type **Web app**.
3. **Description:** `Approval email bridge v1`
4. **Execute as:** **Me** (`jiangnancommandcenter@gmail.com`)
   ← *this is what makes the email come from your business address*
5. **Who has access:** **Anyone**
6. **Deploy**.
7. **Authorize access** → pick the account → *"Google hasn't verified this app"* →
   **Advanced** → **Go to RCMS Ticket Notifier (unsafe)** → **Allow**.
   *(It is your own script, so this warning is expected. The consent it asks for is
   permission to send email as you — which is exactly its job.)*
8. Copy the **Web app URL** — it ends with **`/exec`**.

**A4. Prove it works**
Open that `/exec` URL in a browser tab. You must read:

```
RCMS Ticket Notifier is running. Sender: Jiangnan Command Center <jiangnancommandcenter@gmail.com>
```

Seeing that line means Part A is done. ✅

---

## Part B — Website side

Open [`js/email-config.js`](../js/email-config.js) and fill in the first two values:

```js
window.EMAIL_CONFIG = {
    endpoint: 'https://script.google.com/macros/s/AKfycb.../exec',   // ← from A3-8
    secret:   'the-same-random-string-from-A2',
    senderName: 'Jiangnan Command Center',
    senderEmail: 'jiangnancommandcenter@gmail.com',
    replyTo: 'jiangnancommandcenter@gmail.com',
    replyToName: 'Ticket Requester',
    portalUrl: '',           // Track page — used by the RE-ACCESS email
    ownerDashboardUrl: '',   // ⚠️ REQUIRED IN PRODUCTION — see "Part B-bis" below
    toDisplayName: '',  // set to 'Ticket Requester' to label the To: line too
    enabled: true
};
```

Then hard-refresh `main.html` (**Ctrl+F5**).

Those two values are **not secrets** — they are visible in View Source, and that is
fine because the Apps Script checks the caller's superadmin ID token server-side.
`js/email-config.js` is meant to be committed and deployed with the site

---

## Part B-bis — Set the PUBLIC links (required before going live)

**This is the one setting people skip, and it is why requesters get a dead link.**

> ⚠️ **There are now TWO links, and they are not the same page.**
>
> | Setting | Page | Which email sends it |
> |---|---|---|
> | `ownerDashboardUrl` | `ownerdashboard.html` (**login-gated**) | **BOTH** the approval mail and the re-access mail |
> | `portalUrl` | `submit-ticket.html` (**login-free**) | nothing — kept only because `submit-ticket.html` itself uses `?track=` |
>
> The approval email is the one most people notice, so **`ownerDashboardUrl` is
> the setting that matters**. Both keys are still checked by
> `test/email-config-deploy.test.js`, and leaving either empty is fine locally.

Neither link is for a colleague. It is emailed to an **Area Manager on their own
phone data**. Leaving a value `''` makes that link auto-derive from whatever page
the superadmin happens to be on when they click **Approve** — so approving from an
intranet name, a `file://` path, `localhost` or a `192.168.x.x` dev server
silently puts *that* address into every email. The recipient then sees:

> This site can't be reached … **DNS_PROBE_FINISHED_NXDOMAIN**

Set the **public** addresses of the deployed pages:

```js
ownerDashboardUrl: 'https://<public-host>/<folder>/ownerdashboard.html',
portalUrl:         'https://<public-host>/<folder>/submit-ticket.html',
```

Then prove them, on the **deployed** page (F12 → Console):

```js
await verifyOwnerDashboardLink()   // the link the approval email sends
await verifyPortalLink()           // the link the re-access email sends
```

- `{ ok: true, … }` — the host resolved and answered. **Still open it in an
  Incognito window, ideally on a phone using mobile data**, to confirm the
  right page is deployed there. A reachable host is not proof the right
  page is deployed there.
- `{ ok: false, stage: 'address' }` — the link is `file://`, `localhost`, a
  private LAN address or an internal-only name. It can never work.
- `{ ok: false, stage: 'request' }` — the host has **no public DNS record**, or
  nothing is deployed there. This is the exact cause of the NXDOMAIN report.

`js/email.js` also validates the link automatically and writes a loud
`console.error` naming the symptom, the setting and the fix whenever the link
could not work — so this can no longer pass unnoticed.

---

## Part C — Test

### C-0. Run it locally (fastest way to see the whole flow work)

The link in the email is derived from the page you approve **from**, so to get a
clickable link on your own machine, serve the folder and approve from it.

```powershell
npm run serve
```

Then open **http://localhost:5500/submit-ticket.html** (and
`http://localhost:5500/main.html` to approve as superadmin).

With `EMAIL_CONFIG.localDev: true` (the current default) this is the intended
setup, and:

- `portalUrl` stays `''` — the link auto-derives to
  `http://localhost:5500/submit-ticket.html?track=<TICKET>`, which is clickable
  **on this PC** and prefills the Track modal.
- The reachability guard speaks with `console.warn` instead of `console.error`,
  so a localhost link no longer looks like a defect.
- `await verifyPortalLink()` returns `{ ok: true, stage: 'local-dev' }` when the
  server is up, or `{ ok: false, … }` telling you to run `npm run serve` if not.

Press **Ctrl+C** in the terminal to stop the server.

> Do **not** hardcode `portalUrl: 'http://localhost:5500/…'`. It works on your
> machine, it is easy to forget, and a forgotten localhost link is a dead link
> for every customer. Leaving `portalUrl` empty keeps that mistake impossible.

> Opening the `.html` file directly (`file:///C:/…`) mostly works — this site
> uses classic scripts, not ES modules — but `file://` gives a null origin that
> breaks Firebase Auth popups. Prefer `npm run serve`.

**C0. Check the link (no ticket, no email).** On the page you are testing from:

```js
await verifyPortalLink()
```

Do this before anything else. Every later step assumes the link is good; if the
host is unreachable, C1 will "pass" locally and still deliver a dead link to the
requester.

**C1. Console test (no ticket needed).** Open `main.html`, press **F12** → Console:

```js
sendTestTicketEmail('jiangnancommandcenter@gmail.com')
```

Expected: resolves with `{ ok: true, status: 'dispatched', to: '…' }`, and the message
lands in the Gmail **Inbox** and **Sent**.

⚠️ Run this **from the same host the superadmin really uses**, and **open the
resulting email on your phone using mobile data** before clicking the link. That
is the only end-to-end proof — your machine may resolve an internal hostname
that a requester never can.

**C1-bis. Test the re-access ("Request Access approved") mail.**

```js
await sendTestAccessEmail('jiangnancommandcenter@gmail.com')
```

Same expectations, but the mail reads *"Your request to view this ticket again has been
approved."* ⚠️ It sends the **same Owner Dashboard deep link** as the approval mail
(`ownerdashboard.html?ticket=TIX-TEST`), not the old Track page — clicking it must
take you to the same report modal.

**C2. Real approval test.**
1. Sign in as an **Area Manager**, open `ownerdashboard.html` and press **+Ticket**. Fill
   the modal in and submit it — that is now the only way to file a ticket.
2. As an operator, resolve it (status becomes *Pending Approval*).
3. As superadmin → **Ticket Reviews** tab → **✓ Approve**.
4. A toast confirms *"Approved — notification email sent to …"* and the email arrives
   within seconds.
5. ⚠️ Click the green **"Open my Owner Dashboard"** button in that email **while
   signed out**. This is the real test of the change, and it exercises the whole
   chain at once:
   - it must bounce to `login.html` and **carry the ticket number with it**;
   - signing in must return you to `ownerdashboard.html?ticket=…`;
   - the **Tickets** tab must open with that ticket's report already up.
   If the number is lost on the way through login, `?ticket=` is not surviving the
   bounce in `js/auth.js` (`redirectToLogin` / `withTicketParam`). If the ticket
   does not open, or you get *"That ticket is not available on your dashboard"*, the
   gate in `applyOwnerDeepLink()` is refusing it — check the ticket is **approved**
   and in **your** branch, because those are the same two rules the visible list
   uses.
6. ⚠️ **Also check a manager who does NOT own that ticket** — a different branch, or
   an unapproved ticket. The link must refuse to open it, not render it.

The **✉** action on an approved row retries any time and its tooltip reports the last
outcome (`Email sent Sep 25, 3:45 PM — press to resend`, `Email failed: …`, or
`No email address on this ticket`).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| **Requester: "This site can't be reached / DNS_PROBE_FINISHED_NXDOMAIN"** | The emailed link was auto-derived from the superadmin's own page, so it points at an internal host or a subdomain with no public DNS record | Run `await verifyPortalLink()`, then set `portalUrl` to the public address (Part B-bis). **Test the link on a phone using mobile data** — your machine may resolve internal names a requester cannot |
| `verifyPortalLink()` → `stage: 'local-dev'`, `ok: false` | `localDev` is on but nothing is serving the folder | Start it: `npm run serve` |
| `verifyPortalLink()` → `stage: 'local-dev'`, `ok: true` | Expected while developing — the local server answered | Fine locally. Pin a public `portalUrl` and set `localDev: false` before go-live |
| `verifyPortalLink()` → `stage: 'address'` | The link is `file://`, `localhost`, a `10.x` / `192.168.x` / `172.16-31.x` private address, or a `.internal` / `.local` name, and `localDev` is off | Set `portalUrl` to the public `https://` address (Part B-bis) |
| `verifyPortalLink()` → `stage: 'request'` | The host has no public DNS record, or nothing is deployed at that path | Create the DNS record / deploy the page, then re-run `verifyPortalLink()` |
| Toast: *"Approval emails are not configured yet"* | `endpoint` is empty in `js/email-config.js` | Paste the `/exec` URL (Part B) |
| Toast: *"…failed (Failed to fetch)"* | The `/exec` URL is wrong, or the deployment is not *Who has access: Anyone* | Re-check A3 |
| Toast: *"The email bridge did not answer in 45s…"* / Console shows `signal is aborted without reason` | The request to `script.googleusercontent.com` never settled — almost always an **ad-blocker or privacy extension**, or a very slow first Apps Script start | **Test in an Incognito window** (no extensions). If it works there, allow-list `script.google.com` and `script.googleusercontent.com` in the blocker |
| No new `doPost` in **Executions** at all | The browser never reached Apps Script (blocked before leaving the page) | Same as above — Incognito / allow-list. A reachable bridge always produces a `doPost` row |
| A `doPost` row appears as *Completed* but no email | It returned an error string as its body (`UNAUTHORIZED…`, `BAD_…`, `ERROR: …`) | Open that execution and read the result; match it against the rows below |
| Toast: *"…failed (missing_firebase_token)"* | The superadmin session expired | Log out / log in again |
| Email missing, script log says `UNAUTHORIZED:not_superadmin` | The approving account's `users/<email>` profile role isn't `superadmin` | Fix the role in Firestore |
| Script log `UNAUTHORIZED:invalid_token` | The Firebase ID token expired before sending | Retry (the ✉ action) |
| Script log `RECIPIENT_MISMATCH` | The ticket's stored `email`/`contact` differs from the address in the payload | Edit the ticket's email, then press ✉ |
| Script log `RATE_LIMITED` | More than 80 sends in one day | Raise `DAILY_SEND_CAP` in the script |
| Nothing in the Inbox | It was delivered but filtered | Check **Spam** and **Gmail ▸ Sent** (a Sent copy always exists) |
| `Reply-To` shows a plain address | The Gmail API service was not added in A1-4 | Add the service and redeploy |
| Email goes out twice | Two approvals happened (reject → resubmit → approve) | Expected: each approval notifies once |

---

## Quota & limits (Google, free tier)

| Resource | Consumer Gmail | Google Workspace |
|---|---|---|
| `GmailApp` / Gmail API recipients per day | **100** | 1,500 |
| `UrlFetch` calls per day | 20,000 | 100,000 |
| Script runtime per day | 90 min | 90 min |

100 messages/day is plenty for the current ticket volume; if the business moves to
Google Workspace the ceiling rises automatically with no code change.

---

## Rotation & disabling

* **Change the shared secret:** edit the `SHARED_SECRET` script property, then paste the
  new value into `js/email-config.js`. Old browsers with the previous secret stop working.
* **Stop all sending instantly:** Project Settings → Script properties → add
  `DISABLED` = `true`. Approvals keep working; only the email is skipped. Set it back to
  `false` (or delete the property) to resume — no redeploy needed.
* **Change the sender mailbox:** deploy the script from the new Gmail account and update
  `senderEmail` / `replyTo` in `js/email-config.js` (the display name comes from
  `SENDER_NAME` in the script).
* **Revoke everything:** Extensions ▸ Apps Script → ⋮ → *Remove* on the project, or
  Google Account → Security → *Third-party apps with account access* → remove access.

---

## Security rules of thumb

1. **Never** put a Gmail app password (or any mailbox credential) in this website. If
   someone ever asks you to, the answer is no — see "Why a bridge is required".
2. Treat the `/exec` URL as **private-ish**: it is public, but obfuscation + secret +
   server-side superadmin verification is what actually protects it.
3. Keep the Apps Script project **shared with nobody** — it can send mail as the business.
4. The email contains only the ticket number and a portal link, never footage, customer
   data or resolution details.

(**do not** add it to `.gitignore`) so every superadmin's browser can reach the bridge.
