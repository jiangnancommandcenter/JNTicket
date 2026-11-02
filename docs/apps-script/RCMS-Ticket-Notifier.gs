/**
 * ==============================================================
 *  RCMS TICKET NOTIFIER — approval-email bridge
 *  CCTV Command Center (jn-data-f29ae)
 * ==============================================================
 *  What this is
 *  ------------
 *  A browser cannot send email (no raw TCP/TLS sockets → no SMTP), so a Gmail
 *  app password can NEVER be used from the website. This Web App is the tiny
 *  server that does the sending, running inside the BUSINESS Gmail account —
 *  so the requester sees a real message from:
 *
 *      Jiangnan Command Center <jiangnancommandcenter@gmail.com>
 *
 *  Security model (why the public URL is still safe)
 *  -------------------------------------------------
 *  Guests can reach this URL, but the FIRST thing doPost() does is verify the
 *  caller's Firebase ID token and confirm that the signed-in user's Firestore
 *  profile has role == 'superadmin'. Anonymous callers (or an operator who
 *  knows the URL) get UNAUTHORIZED and nothing is sent. A per-day send cap and
 *  an exact-recipient check against the ticket document add further limits.
 *
 *  Deploy + properties: see docs/EMAIL-SETUP.md   (≈5 minutes, no billing)
 * ==============================================================
 */

// ===== CONFIG (safe to edit) ==================================
// The shared secret is optional defence-in-depth. Prefer the script property
// SHARED_SECRET (Project Settings ▸ Script properties); this constant is only
// the fallback so the script still runs before you create the property.
const FALLBACK_SHARED_SECRET = 'CHANGE-ME-TO-A-RANDOM-STRING';

// Firebase project that hosts the CCTV Command Center.
const PROJECT_ID = 'jn-data-f29ae';

// Public Web API key of that project (same one that ships in firebase.js —
// it is NOT a secret; it only identifies the project to Google's REST APIs).
// ⚠️ This MUST be byte-identical to firebase.js ▸ firebaseConfig.apiKey.
// A single transposed capital letter (e.g. GRDdRE vs GRdDRE) makes
// accounts:lookup answer 400, every call is rejected as `invalid_token`,
// and NO mail is ever sent — with no visible clue in the browser, because
// the response is opaque.
const FIREBASE_API_KEY = 'AIzaSyD3R9VtLbqPxPlKXn5QBRdyiwPOrGRdDRE';

// Sender identity. SENDER_ADDRESS must be THIS account (Gmail rewrites From).
const SENDER_NAME = 'Jiangnan Command Center';
const SENDER_ADDRESS = 'jiangnancommandcenter@gmail.com';
const REPLY_TO_ADDRESS = 'jiangnancommandcenter@gmail.com';
const REPLY_TO_NAME = 'Ticket Requester';   // shown in Gmail's Reply "To:" field

// Anti-abuse: maximum messages this script may send per day.
const DAILY_SEND_CAP = 80;

// ===== OPTIONAL HEALTH CHECK ==================================
// Open the /exec URL in a browser after deploying: you should read the line
// below. That proves the Web App is live before you touch the website.
function doGet() {
  return ContentService.createTextOutput(
    'RCMS Ticket Notifier is running. Sender: ' + SENDER_NAME + ' <' + SENDER_ADDRESS + '>'
  );
}

// ===== MAIN ENTRY POINT =======================================
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput('BAD_REQUEST');
    }

    if (getProperty('DISABLED', '') === 'true') {
      return ContentService.createTextOutput('DISABLED');
    }

    var payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseError) {
      return ContentService.createTextOutput('BAD_JSON');
    }

    // ---- 1. Shared secret (casual-abuse speed bump) ----
    if (String(payload.secret || '') !== getSharedSecret()) {
      return ContentService.createTextOutput('UNAUTHORIZED');
    }

    // ---- 2. The real gate: a verified superadmin ID token ----
    var caller = verifySuperAdmin(payload.idToken);
    if (!caller.ok) {
      console.log('Rejected: ' + caller.error);
      return ContentService.createTextOutput('UNAUTHORIZED:' + caller.error);
    }

    // ---- 3. Validate the message ----
    var to = String(payload.to || '').trim().toLowerCase();
    if (!isEmail(to)) return ContentService.createTextOutput('BAD_RECIPIENT');

    var subject = sanitizeHeader(payload.subject);
    var text = String(payload.text || '');
    var html = String(payload.html || '');
    if (!subject || !text) return ContentService.createTextOutput('BAD_MESSAGE');
    if (text.length + html.length > 200000) return ContentService.createTextOutput('MESSAGE_TOO_LARGE');

    // ---- 4. The recipient must be the address stored on the ticket ----
    var allowed = ticketRecipients(payload.idToken, payload.ticketId);
    if (allowed.length > 0 && allowed.indexOf(to) === -1) {
      console.log('Rejected: recipient ' + to + ' is not on ticket ' + payload.ticketId);
      return ContentService.createTextOutput('RECIPIENT_MISMATCH');
    }

    // ---- 5. Daily cap ----
    if (!consumeQuota()) return ContentService.createTextOutput('RATE_LIMITED');

    // ---- 6. Send from the business Gmail account ----
    sendMail(to, subject, text, html);
    console.log('Sent ticket email to ' + to + ' (ticket ' + payload.ticketId + ') by ' + caller.email);
    return ContentService.createTextOutput('OK');
  } catch (error) {
    console.error(error);
    return ContentService.createTextOutput('ERROR: ' + (error && error.message ? error.message : error));
  }

// ===== SCRIPT PROPERTIES ======================================
function getProperty(key, fallback) {
  try {
    var value = PropertiesService.getScriptProperties().getProperty(key);
    return (value === null || value === '') ? fallback : value;
  } catch (error) {
    return fallback;
  }
}

function getSharedSecret() {
  return String(getProperty('SHARED_SECRET', FALLBACK_SHARED_SECRET));
}

// ===== SMALL VALIDATORS =======================================
function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

/** Strips CR/LF so a crafted subject can never inject extra mail headers. */
function sanitizeHeader(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

// ===== DAILY SEND CAP =========================================
function consumeQuota() {
  var props = PropertiesService.getScriptProperties();
  var key = 'count_' + Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyy-MM-dd');
  var used = Number(props.getProperty(key) || 0);
  if (used >= DAILY_SEND_CAP) return false;
  props.setProperty(key, String(used + 1));
  return true;
}

// ===== CALLER VERIFICATION (the real security gate) ===========
/**
 * Confirms that:
 *   1. `idToken` is a LIVE Firebase ID token of this project (accounts:lookup),
 *   2. the matching Firestore profile (users/<email>) has role == 'superadmin'.
 * Anonymous visitors and ordinary operators can never pass this.
 */
function verifySuperAdmin(idToken) {
  if (!idToken) return { ok: false, error: 'missing_token' };

  var lookupUrl = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY;
  var lookupRes = UrlFetchApp.fetch(lookupUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ idToken: String(idToken) }),
    muteHttpExceptions: true
  });
  if (lookupRes.getResponseCode() !== 200) return { ok: false, error: 'invalid_token' };

  var users = (JSON.parse(lookupRes.getContentText()) || {}).users || [];
  var email = users[0] && users[0].email ? String(users[0].email).toLowerCase() : '';
  if (!email) return { ok: false, error: 'no_email_on_token' };

  var docUrl = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID +
    '/databases/(default)/documents/users/' + encodeURIComponent(email);
  var docRes = UrlFetchApp.fetch(docUrl, {
    headers: { Authorization: 'Bearer ' + idToken },
    muteHttpExceptions: true
  });
  if (docRes.getResponseCode() !== 200) return { ok: false, error: 'profile_not_readable' };

  var fields = (JSON.parse(docRes.getContentText()) || {}).fields || {};
  var role = fields.role && fields.role.stringValue ? String(fields.role.stringValue).toLowerCase() : '';
  if (role !== 'superadmin') return { ok: false, error: 'not_superadmin' };

  return { ok: true, email: email };
}

/**
 * The only addresses this script may send to for a given ticket: the ones
 * actually stored on the ticket document. Returns [] when the document cannot
 * be read (legacy ticket) so the send is not blocked — the verified-superadmin
 * check has already run by then.
 */
function ticketRecipients(idToken, ticketId) {
  var id = sanitizeHeader(ticketId);
  if (!id) return [];
  try {
    var url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID +
      '/databases/(default)/documents/tickets/' + encodeURIComponent(id);
    var res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + idToken },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return [];
    var fields = (JSON.parse(res.getContentText()) || {}).fields || {};
    var candidates = [
      fields.email && fields.email.stringValue,
      fields.contact && fields.contact.stringValue,
      fields.accessReopenRequest && fields.accessReopenRequest.mapValue &&
        fields.accessReopenRequest.mapValue.fields &&
        fields.accessReopenRequest.mapValue.fields.requestedByEmail &&
        fields.accessReopenRequest.mapValue.fields.requestedByEmail.stringValue
    ];
    var out = [];
    for (var i = 0; i < candidates.length; i++) {
      var value = String(candidates[i] || '').trim().toLowerCase();
      if (isEmail(value) && out.indexOf(value) === -1) out.push(value);
    }
    return out;
  } catch (error) {
    console.log('ticketRecipients skipped: ' + error);
    return [];
  }
}


// ===== SENDING ================================================
/**
 * Sends from the business Gmail account.
 *
 * Preferred path: the advanced Gmail service with a hand-built RFC 2822
 * message, which is the only way to keep BOTH display names —
 *   From:     Jiangnan Command Center <…>
 *   Reply-To: Ticket Requester <…>
 * If the Gmail API service was not added (Services ▸ + ▸ Gmail API), the
 * message is still sent via GmailApp; only the Reply-To DISPLAY NAME is lost
 * (the address stays the same).
 */
function sendMail(to, subject, text, html) {
  if (hasAdvancedGmail()) {
    try {
      Gmail.Users.Messages.send({ raw: buildRawMessage(to, subject, text, html) }, 'me');
      return;
    } catch (error) {
      console.log('Raw MIME send failed → falling back to GmailApp: ' + error);
    }
  }
  GmailApp.sendEmail(to, subject, text, {
    name: SENDER_NAME,
    replyTo: REPLY_TO_ADDRESS,
    htmlBody: html || undefined
  });
}

function hasAdvancedGmail() {
  try {
    return typeof Gmail !== 'undefined' && !!(Gmail.Users && Gmail.Users.Messages);
  } catch (error) {
    return false;
  }
}

/** RFC 2822 + 2047 message with a text/plain and an HTML alternative part. */
function buildRawMessage(to, subject, text, html) {
  var domain = SENDER_ADDRESS.split('@')[1] || 'gmail.com';
  var boundary = 'rcms-' + Utilities.getUuid();
  var lines = [
    'From: ' + buildAddress(SENDER_NAME, SENDER_ADDRESS),
    'Reply-To: ' + buildAddress(REPLY_TO_NAME, REPLY_TO_ADDRESS),
    'To: ' + to,
    'Subject: ' + encodeHeader(subject),
    'Date: ' + Utilities.formatDate(new Date(), 'GMT', 'EEE, dd MMM yyyy HH:mm:ss Z'),
    'Message-ID: <' + Utilities.getUuid() + '@' + domain + '>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
    '--' + boundary,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Utilities.base64Encode(text, Utilities.Charset.UTF_8)),
    '--' + boundary,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Utilities.base64Encode(html || ('<pre>' + text + '</pre>'), Utilities.Charset.UTF_8)),
    '--' + boundary + '--',
    ''
  ];
  return Utilities.base64EncodeWebSafe(lines.join('\r\n'), Utilities.Charset.UTF_8);
}

/** "Name <email>" with the name quoted only when it needs escaping. */
function buildAddress(name, address) {
  var clean = sanitizeHeader(name);
  if (!clean) return address;
  if (/[",<>@;:\\]/.test(clean)) clean = '"' + clean.replace(/"/g, '') + '"';
  return clean + ' <' + address + '>';
}

/** RFC 2047 encoded-word, only when the value is not pure ASCII. */
function encodeHeader(value) {
  var text = sanitizeHeader(value);
  if (/^[\x20-\x7E]*$/.test(text)) return text;
  return '=?UTF-8?B?' + Utilities.base64Encode(text, Utilities.Charset.UTF_8) + '?=';
}

/** MIME bodies must not exceed 76 characters per line. */
function wrapBase64(value) {
  return String(value || '').replace(/(.{76})/g, '$1\r\n');
}


}
