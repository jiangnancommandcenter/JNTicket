// ===========================================================================
//  RE-APPROVAL AFTER AN ADDITIONAL-FOOTAGE CYCLE RE-ARMS THE VIEWING WINDOW
//
//  THE BUG: approved → manager opens (accessOpenedAt stamped, window runs) →
//  manager requests footage (status 'Insufficient Footage', approval undone) →
//  operator re-resolves → superadmin approves again. The old accessOpenedAt
//  stamp survived all of that, so the deadline stayed `oldOpenedAt + window` —
//  already lapsed — and the ticket returned already-expired.
//
//  THE FIX (script.js → approveResolution): when the ticket carries a
//  footage_request comment, the approval also deletes accessOpenedAt /
//  accessOpenedBy / accessExpiresAt, putting the ticket back to
//  "approved, never opened". The manager's NEXT open stamps fresh and starts
//  a new window — exactly like a Resend re-arm. Scoped to footage cycles so
//  a plain duplicate approve cannot hand out extra time.
//
//  Run: npm test
// ===========================================================================
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const scriptSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const ownerHtml = fs.readFileSync(path.join(ROOT, 'ownerdashboard.html'), 'utf8');

console.log('Testing footage-cycle re-approval re-arms the viewing window...');

// 1. approveResolution must compute a footage-scoped re-arm flag.
assert(
  /needsFreshWindow/.test(scriptSrc) &&
  /hasFootageRequestComment\(approvedTicket\)/.test(scriptSrc),
  'approveResolution() must scope the re-arm to tickets with a footage_request comment'
);

// 2. The re-arm must delete the first-open stamp (+ legacy expiry) via delete().
assert(
  /accessOpenedAt:\s*firebase\.firestore\.FieldValue\.delete\(\)/.test(scriptSrc),
  're-approval must delete accessOpenedAt so the next open starts a fresh window'
);
assert(
  /accessOpenedBy:\s*firebase\.firestore\.FieldValue\.delete\(\)/.test(scriptSrc),
  're-approval must delete accessOpenedBy alongside the stamp'
);
assert(
  /accessExpiresAt:\s*firebase\.firestore\.FieldValue\.delete\(\)/.test(scriptSrc),
  're-approval must delete any stored accessExpiresAt or the old deadline wins'
);

// 3. The in-memory copy must mirror the delete, or badge/filter checks lag a beat.
assert(
  /delete allTickets\[syncIdx\]\.accessOpenedAt/.test(scriptSrc),
  'the in-memory ticket must mirror the stamp clear'
);

// 4. The approval email snapshot must not promise the old lapsed deadline.
assert(
  /delete snapshot\.accessOpenedAt/.test(scriptSrc),
  'the approval email snapshot must drop the cleared stamp'
);

// 5. First-time approvals (no footage history) must NOT touch the stamp fields —
//    delete() is conditional, so an unopened ticket stays unopened.
{
  const approveBlock = scriptSrc.slice(scriptSrc.indexOf('window.approveResolution ='));
  assert(
    /\.\.\.\(needsFreshWindow \? \{/.test(approveBlock),
    'the stamp deletes must be spread conditionally on needsFreshWindow, never unconditional'
  );
}

// 6. Owner header must not carry the removed subtitle span (phone-fit cleanup).
assert(
  ownerHtml.indexOf('id="ownerPageSubtitle"') === -1,
  'ownerdashboard.html must not contain the #ownerPageSubtitle span (removed for phone fit)'
);

console.log('OK: footage-cycle re-approval re-arms the viewing window');
