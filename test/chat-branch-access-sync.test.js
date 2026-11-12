// Branch group chats follow the account's CURRENT role + branches.
//
// Locked down here:
//   1. firestore.rules: isChatMember() also requires hasCurrentBranchAccess()
//      for branch rooms (superadmin/hr: all; owner/rmsm: only their current
//      users/<email>.branches) — so a stale `members` entry no longer grants
//      message access. The conversation LIST clause stays membership-only
//      (Firestore cannot prove a title condition for a collection query).
//   2. js/chat.js canAccessBranchRoom(): the role matrix, Branch 1 -> Branch 2,
//      superadmin -> Area Manager, and fail-closed before the profile loads.
//   3. js/chat.js wires it in: own-profile listener started in init() and
//      stopped in teardown(), reload on a later change, selectConversation()
//      refuses a disallowed room, the list/per-room/rows paths all filter.
//   4. script.js: saving permissions sweeps EVERY branch room, and the sweep
//      includes every existing branch plus the caller's extra branches.
//
// Run: node test/chat-branch-access-sync.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const rules = read('firestore.rules');
const chat = read('js/chat.js');
const script = read('script.js');

console.log('Testing branch chat access follows the current role + branches...');

// ---------- 1. rules ----------
const memberFn = (rules.match(/function isChatMember\(chatId\) \{[\s\S]*?\n    \}/) || [''])[0];
assert(/selfEmail\(\) in chatRoom\(chatId\)\.data\.members/.test(memberFn), 'isChatMember keeps the membership check');
assert(/\(!isBranchRoom\(chatId\) \|\| hasCurrentBranchAccess\(chatId\)\)/.test(memberFn),
    'isChatMember must also require CURRENT branch access for branch rooms');
const accessFn = (rules.match(/function hasCurrentBranchAccess\(chatId\) \{[\s\S]*?\n    \}/) || [''])[0];
assert(/role in \['superadmin', 'hr'\]/.test(accessFn), 'superadmin + hr keep every branch room');
assert(/role in \['owner', 'rmsm'\]/.test(accessFn) && /title in myBranches\(\)/.test(accessFn),
    'owner/rmsm only for a room whose title is in their CURRENT branches');
assert(/\.data\.get\('branches', \[\]\)/.test(rules), 'myBranches() must read the caller\'s own users doc');
assert(/\|\| \(isChatRole\(\) && 'members' in resource\.data\s*\n\s*&& selfEmail\(\) in resource\.data\.members\)/.test(rules),
    'the room LIST clause must stay membership-only, or the conversation list query is refused');
console.log('  PASS  rules: message/presence/receipt access needs CURRENT role + branches');

// ---------- 2. canAccessBranchRoom (pure) ----------
const grab = (name) => {
    const m = chat.match(new RegExp('    function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}'));
    assert(m, name + '() not found in js/chat.js');
    return m[0];
};
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext([grab('normalizeRole'), grab('branchKey'), grab('canAccessBranchRoom')].join('\n')
    + '\nthis.can = canAccessBranchRoom; this.key = branchKey;', sandbox);
const can = sandbox.can;
const b1 = sandbox.key('Branch 1');
const b2 = sandbox.key('Branch 2');

assert.strictEqual(can('dm_a__b', '', 'owner', []), true, 'a 1:1 room is not gated here');
assert.strictEqual(can(b1, 'Branch 1', 'superadmin', []), true, 'superadmin sees every branch');
assert.strictEqual(can(b2, 'Branch 2', 'hr', []), true, 'hr sees every branch');
assert.strictEqual(can(b1, 'Branch 1', 'owner', ['Branch 1']), true, 'Area Manager sees an assigned branch');
assert.strictEqual(can(b2, 'Branch 2', 'owner', ['Branch 1']), false, 'Area Manager does NOT see another branch');
assert.strictEqual(can(b1, 'Branch 1', 'rmsm', ['branch 1']), true, 'case-insensitive match');
assert.strictEqual(can(b1, '', 'rmsm', ['Branch 1']), true, 'slug match when the title has not arrived');
// Branch 1 -> Branch 2
assert.strictEqual(can(b1, 'Branch 1', 'owner', ['Branch 2']), false, 'moved to Branch 2: Branch 1 is gone');
assert.strictEqual(can(b2, 'Branch 2', 'owner', ['Branch 2']), true, 'moved to Branch 2: Branch 2 appears');
// superadmin -> Area Manager
assert.strictEqual(can(b2, 'Branch 2', 'owner', ['Branch 1']), false, 'ex-superadmin keeps only assigned branches');
// fail closed
assert.strictEqual(can(b1, 'Branch 1', 'owner', null), false, 'profile not loaded yet: fail closed');
assert.strictEqual(can(b1, 'Branch 1', 'operator', ['Branch 1']), false, 'non-chat roles never');
console.log('  PASS  canAccessBranchRoom: role matrix, branch move, role change, fail-closed');

// ---------- 3. chat.js wiring ----------
const initFn = (chat.match(/    function init\(options\) \{[\s\S]*?\n    \}/) || [''])[0];
assert(/startSelfAccessListener\(\);/.test(initFn), 'init() must start the own-profile listener');
const teardownFn = (chat.match(/    function teardown\(\) \{[\s\S]*?\n    \}/) || [''])[0];
assert(/stopSelfAccessListener\(\);/.test(teardownFn), 'teardown() must stop it');
const selfFn = grab('startSelfAccessListener');
assert(/collection\('users'\)\.doc\(/.test(selfFn) && /location\.reload\(\)/.test(selfFn),
    'a later role/branch change must reload the page');
assert(/pruneDisallowedRooms\(\)/.test(selfFn), 'the first snapshot must prune rooms no longer allowed');
const selectFn = grab('selectConversation');
assert(/isBranchRoomAllowed\(roomId/.test(selectFn), 'selectConversation must refuse a disallowed branch room (old links)');
assert(/isBranchRoomDenied\(roomId, data\.title\)/.test(chat), 'list + per-room paths must drop denied branch rooms');
assert(/isBranchRoom\(id\) && isBranchRoomAllowed\(id/.test(chat), 'collectConversationRows must filter branch rows');
assert(/canAccessBranchRoom: canAccessBranchRoom/.test(chat), 'ChatService exports the gate');
console.log('  PASS  chat.js: live own-profile listener, reload on change, open/list gated');

// ---------- 4. script.js resync ----------
const saveFn = (script.match(/async function updateUserPermissions\(email\) \{[\s\S]*?\n\}/) || [''])[0];
assert(/await backfillBranchGroupChats\(prevBranches\.concat\(/.test(saveFn),
    'saving permissions must sweep EVERY branch room (role changes affect rooms outside the diff)');
const sweepFn = (script.match(/async function backfillBranchGroupChats\(extraBranches\) \{[\s\S]*?\n\}/) || [''])[0];
assert(/b\.branchName/.test(sweepFn), 'the sweep must include every existing branch');
assert(/extraBranches/.test(sweepFn), 'the sweep must include the caller\'s extra branches');
console.log('  PASS  script.js: full member resync on every permissions save');

console.log('\n✅ Branch chat access sync tests passed.');
