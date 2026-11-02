// Functional test for the User Approvals sidebar badge (pending approval count).
// The badge must show how many accounts are waiting for approval AND belong in
// the approval queue, and it must hide entirely when the count is 0.
//
// The helper block is extracted from script.js (browser globals stubbed) so the
// logic runs in plain Node. Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

const start = src.indexOf('//  USERS BADGE');
assert(start > -1, 'users badge block not found in script.js');
const blockStart = src.lastIndexOf('// ====', start);
const end = src.indexOf('function sanitizeUserId', start);
assert(end > blockStart, 'end of users badge block not found in script.js');
const blockSrc = src.slice(blockStart, end);

console.log('Testing User Approvals badge (pending count)...');

// Users mirror the shape loadSuperadminUsers() emits (id + document data).
const U = (over) => Object.assign({
    id: 'u-' + Math.random().toString(36).slice(2),
    role: 'owner',
    status: 'pending'
}, over);

// Minimal DOM/globals the extracted block touches.
const badge = { textContent: '', style: { display: 'inline' } };
const sandbox = {
    console,
    $: (sel) => badge,
    usersBadge: badge,
    db: { collection: () => ({ onSnapshot: () => {} }) },
    auth: { currentUser: { email: 'admin@example.com' } },
    localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {}
    },
    document: {
        querySelector: () => badge,
        getElementById: () => null
    },
    window: { normalizeUserEmail: (v) => String(v || '').trim().toLowerCase() },
    isApprovalQueueRole: function (user) {
        const role = user.role || 'owner';
        return role !== 'superadmin' && role !== 'operator';
    }
};
vm.createContext(sandbox);
vm.runInContext(blockSrc, sandbox);

const { countPendingApprovals, setUsersBadge, startUsersBadgeListener } = sandbox;

// -- countPendingApprovals() ------------------------------------------------
assert.strictEqual(countPendingApprovals([]), 0, 'empty list is zero');
assert.strictEqual(countPendingApprovals(undefined), 0, 'missing list is zero');

// A superadmin is the APPROVER and an operator is created out-of-band. Neither
// is an approval candidate, so neither counts toward the badge.
assert.strictEqual(countPendingApprovals([U({ role: 'superadmin' })]), 0, 'superadmin does not count');
assert.strictEqual(countPendingApprovals([U({ role: 'operator' })]), 0, 'operator does not count');

// Any pending, non-superadmin/non-operator account counts.
const pending = [U({ role: 'owner' }), U({ role: 'hr' }), U({ role: 'rmsm' })];
assert.strictEqual(countPendingApprovals(pending), 3, 'each pending assignable role counts');

// Non-pending statuses never count, even for queue roles.
assert.strictEqual(countPendingApprovals([U({ role: 'owner', status: 'approved' })]), 0, 'approved user does not count');
assert.strictEqual(countPendingApprovals([U({ role: 'owner', status: 'rejected' })]), 0, 'rejected user does not count');
assert.strictEqual(countPendingApprovals([U({ role: 'owner', status: 'pending', role: 'superadmin' })]), 0, 'pending superadmin does not count');

// -- setUsersBadge() --------------------------------------------------------
badge.textContent = '';
badge.style.display = 'inline';
setUsersBadge(0);
assert.strictEqual(badge.textContent, '0', 'zero shows as 0');
assert.strictEqual(badge.style.display, 'none', 'zero hides the badge');

badge.textContent = '';
badge.style.display = 'inline';
setUsersBadge(4);
assert.strictEqual(badge.textContent, '4', 'four shows as 4');
assert.strictEqual(badge.style.display, 'inline', 'four shows the badge');
setUsersBadge(99);
assert.strictEqual(badge.textContent, '99', '99 shows as 99');
setUsersBadge(100);
assert.strictEqual(badge.textContent, '99+', 'over 99 caps at 99+');
setUsersBadge(-3);
assert.strictEqual(badge.style.display, 'none', 'negative hides the badge');

console.log('All users badge tests passed.');
