// Guards against a class of Firestore-rules bug that silently breaks
// writes: on a `create`, `resource` does not exist yet, so `resource.data`
// is null. A rule that dereferences resource.data inside a CREATE (or
// lumps create and update together) evaluates to DENIED, so sending never
// works and retrying never helps.
//
// It also guards the ORDER of the two writes a first message needs. Room
// membership is resolved by READING the room (`get(chats/{chatId})`), so a
// message written in the same batch as the room it creates is evaluated while
// that room still does not exist and is denied. The room must be committed
// first, on its own, and section 9 asserts that it is.
//
// Also asserts that the RULES allowlist (isHrOrSuperAdmin) and the CLIENT
// allowlist (CHAT_ALLOWED_ROLES) list the same roles. If they ever drift,
// a user can see the chat button but be denied on send.
//
// Static check on firestore.rules + js/chat.js; no emulator needed.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

console.log('Testing chat Firestore rules...');

/** Return the body of the `match /chats/...` block (braces balanced). */
function chatsBlock() {
    const start = rules.indexOf('match /chats/');
    assert(start > -1, 'firestore.rules has no match /chats/ block');

    // Skip the path pattern's own braces, e.g. `/chats/{chatId}`, so we
    // start counting at the brace that opens the BLOCK body.
    const pathOpen = rules.indexOf('{', start);
    const pathClose = rules.indexOf('}', pathOpen);
    const open = rules.indexOf('{', pathClose);
    assert(open > -1, 'could not find the opening brace of the match /chats/ block');

    let depth = 0;
    for (let i = open; i < rules.length; i++) {
        if (rules[i] === '{') depth++;
        else if (rules[i] === '}') {
            depth--;
            if (depth === 0) return rules.slice(start, i + 1);
        }
    }
    throw new Error('unbalanced braces in the match /chats/ block');
}

const block = chatsBlock();

// 1. The chats match block must exist and be the one we expect.
assert(block.indexOf('/messages/{messageId}') > -1, 'chats block should contain the messages subcollection');
assert(
    block.indexOf('/readReceipts/{userKey}') > -1,
    'chats block should contain the readReceipts subcollection (the \u2713 Sent / \u2713\u2713 Seen ticks)'
);

// 2. CRITICAL: `allow create` and `allow update` must be SEPARATE rules.
//    A combined `allow create, update:` cannot reference resource.data.
assert(
    !/allow\s+create\s*,\s*update\s*:/.test(block),
    'chats rules must NOT combine `allow create, update:` — on a create, ' +
    'resource.data is null and the whole rule is denied, which rolls back ' +
    'the whole atomic batch (the message never saves). Split them.'
);

// 3. No CREATE rule anywhere may dereference resource.data.
const createRules = block.match(/allow\s+create[^\n]*(?:\n\s*&&[^\n]*)*/g) || [];
assert(createRules.length > 0, 'expected at least one `allow create` in the chats block');
createRules.forEach((rule) => {
    // Match a bare `resource.data` only. `request.resource.data` is the
    // NEW document and is perfectly valid inside a create rule, so a
    // naive substring check would flag it as a false positive.
    const bareResourceData = /(?<!request\.)\bresource\.data/.test(rule);
    assert(
        !bareResourceData,
        'a `allow create` rule references resource.data, which is null on ' +
        'create and causes a silent denial:\n' + rule.trim()
    );
});

// 4. A create rule for the room must constrain the writable field set.
assert(
    /allow\s+create\s*:[\s\S]*?hasOnly\(/.test(block),
    'the room create rule should restrict the writable fields with hasOnly()'
);

// 5. Messages: create must be gated on the sender being the authenticated
//    account, and messages must be immutable afterwards.
assert(
    /allow\s+create\s*:[\s\S]*?senderEmail\s*==\s*selfEmail\(\)/.test(block),
    'message create must require senderEmail == selfEmail() so nobody can post as someone else'
);
assert(
    /allow\s+update,\s*delete\s*:\s*if\s+false/.test(block),
    'sent messages must be immutable (update/delete denied)'
);

// 6. Typing presence: everyone in the ROOM may READ presence, but may only
//    ever write or delete their OWN record. create must not touch
//    resource.data (the doc does not exist yet on the first write).
assert(
    /match\s+\/presence\/\{userKey\}/.test(block),
    'a match /presence/{userKey} block is required for typing indicators'
);
assert(
    /match\s+\/presence\/[\s\S]*?allow\s+read\s*:\s*if\s+canReadChat\(chatId\)/.test(block),
    'presence must be readable by the room (canReadChat), not by role alone'
);
const presenceCreate = (block.match(/match\s+\/presence\/[\s\S]*?allow\s+create\s*:[\s\S]*?;/g) || [])[0];
assert(presenceCreate, 'presence must have an `allow create` rule');
assert(
    /canPublishPresence\(chatId\)/.test(presenceCreate),
    'presence create must be gated by canPublishPresence(chatId) — otherwise any HR could broadcast ' +
    'typing into another HR\'s private thread'
);
// ⚠️ The helper replaced a bare `isChatMember(chatId)` so the ROLE-gated group
// room works too. That is only safe because `isLegacyArchive(chatId)` is false
// for every PRIVATE room, so membership still has to hold for 1:1. Assert that
// property of the HELPER directly — otherwise widening it would silently open
// every private thread to typing broadcasts, which is what this rule prevents.
const presenceHelper = (rules.match(/function canPublishPresence\([\s\S]*?\n    \}/) || [])[0];
assert(presenceHelper, 'a canPublishPresence(chatId) helper is required');
assert(
    /isChatMember\(chatId\)\s*\|\|\s*isLegacyArchive\(chatId\)/.test(presenceHelper),
    'canPublishPresence must be isChatMember OR isLegacyArchive: the membership half is what keeps ' +
    'private 1:1 threads private, and isLegacyArchive is scoped to the single group room id'
);
assert(
    /isLegacyArchive/.test(rules) && /chatId\s*==\s*'owner-superadmin'/.test(rules),
    'isLegacyArchive must stay scoped to exactly one room id, or canPublishPresence would grant ' +
    'presence writes across every conversation'
);
assert(
    /request\.resource\.data\.email\s*==\s*selfEmail\(\)/.test(presenceCreate),
    'presence create must require email == selfEmail() so you can only broadcast YOUR OWN typing'
);
assert(
    !/(?<!request\.)\bresource\.data/.test(presenceCreate),
    'presence create must not reference resource.data — it is null on create'
);
assert(
    /allow\s+delete\s*:[\s\S]*?resource\.data\.email\s*==\s*selfEmail\(\)/.test(block),
    'presence delete must be limited to the owner of that presence record'
);

// 6b. ⚠️ THE 1:1 PRIVACY RULE — the reason this whole file changed.
//     Conversations are one room per PAIR now, so a bare
//     `isHrOrSuperAdmin()` on a read would let ANY HR read ANY OTHER HR's
//     private conversation. Read access must be MEMBERSHIP, and every
//     subcollection must resolve membership through the room document.
assert(
    /function\s+isChatMember\(chatId\)/.test(rules),
    'isChatMember() helper is missing from firestore.rules'
);
const memberHelper = rules.match(/function\s+isChatMember\(chatId\)\s*\{[\s\S]*?\n\s*\}/);
assert(memberHelper, 'could not read the isChatMember() helper body');
assert(
    /isChatRole\(\)/.test(memberHelper[0]),
    'isChatMember() must still require a chat-role gate (isChatRole — hr, superadmin and the ' +
    'Area Manager). Widening the set is safe ONLY because membership is still tested below: an ' +
    'Area Manager gains the rooms they are listed in and nothing else'
);
assert(
    /isHrOrSuperAdmin\(\)/.test(memberHelper[0]) === false,
    'isChatMember() must NOT fall back to isHrOrSuperAdmin() for 1:1 rooms — that narrower ' +
    'helper is the GROUP chat only, and using it here would leave the Area Manager unable to ' +
    'open the private thread this role is for'
);
assert(
    /selfEmail\(\)\s+in\s+chatRoom\(chatId\)\.data\.members/.test(memberHelper[0]),
    'isChatMember() must test selfEmail() against the room\'s members array'
);
assert(
    /function\s+chatRoom\(chatId\)/.test(rules),
    'the chatRoom() accessor is required — resource.data is the SUBDOC on a nested path, never the room'
);
// The room doc itself.
// The room doc itself. Read access is MEMBERSHIP, not role. The rule also
// restates that same membership test through `resource` so the conversation
// LIST QUERY can be authorised (asserted in section 12) — the get()-based
// check alone cannot be proven for a query.
const roomRead = (block.match(/match \/chats\/\{chatId\}[\s\S]*?allow read:[\s\S]*?;/) || [''])[0];
assert(
    /allow read: if canReadChat\(chatId\)/.test(roomRead),
    'a room must be readable by its MEMBERS (canReadChat), not by role alone'
);
// Every subcollection must be membership-scoped, so a non-member cannot
// read messages, receipts, presence or reactions.
//
// ⚠️ `profiles` is the ONE deliberate exception: it doubles as the people
// directory for the conversation list, which has to be readable BEFORE any
// room exists (otherwise nobody could ever start a first conversation). It
// therefore stays on the role gate, and it holds only presentation data —
// a display name, a job title and a role. It cannot expose a conversation,
// because no message or room data lives there.
['messages', 'presence', 'readReceipts', 'reactions'].forEach((sub) => {
    const at = block.indexOf('match /' + sub + '/');
    assert(at > -1, 'the chats block must contain the ' + sub + ' subcollection');
    // The sub-block runs from THIS match to the NEXT one after it. Searching
    // from `at` would find the current match again and yield an empty body.
    const nextAt = block.indexOf('match /', at + 1);
    const body = nextAt > -1 ? block.slice(at, nextAt) : block.slice(at);
    assert(
        /isChatMember\(chatId\)|canReadChat\(chatId\)/.test(body),
        `${sub} must be scoped to room membership (isChatMember/canReadChat) — a role-only ` +
        'check would expose another person\'s private conversation'
    );
});
// ...and profiles must NOT be membership-scoped, or the list would be empty.
const profilesAt = block.indexOf('match /profiles/');
const profilesNext = block.indexOf('match /', profilesAt + 1);
const profilesSlice = profilesNext > -1 ? block.slice(profilesAt, profilesNext) : block.slice(profilesAt);
assert(
    /allow read: if isChatRole\(\);/.test(profilesSlice),
    'profiles must stay on the ROLE gate (isChatRole), not a membership one — it is the people ' +
    'directory, and must be readable before any conversation room exists, or no first ' +
    'conversation could ever be started'
);
// A message create is the strongest case: it needs membership AND self.
const msgsAt = block.indexOf('match /messages/');
const msgsNext = block.indexOf('match /', msgsAt + 1);
const msgsBody = msgsNext > -1 ? block.slice(msgsAt, msgsNext) : block.slice(msgsAt);
const msgCreate = (msgsBody.match(/allow create:[\s\S]*?;/g) || [])[0];
assert(
    /isChatMember\(chatId\)/.test(msgCreate || ''),
    'a message create must require room membership'
);
assert(
    /senderEmail\s*==\s*selfEmail\(\)/.test(msgCreate || ''),
    'a message create must still require senderEmail == selfEmail()'
);
// The ALL HR GROUP chat lives in the legacy room, which has no member list —
// so it needs a message write of its own, gated on the SAME "is an HR or a
// superadmin" test. Without it, deploying these rules would leave the pinned
// group row in place while refusing every message in it.
assert(
    /allow create: if isLegacyArchive\(chatId\)[\s\S]{0,120}?request\.resource\.data\.senderEmail == selfEmail\(\);/.test(msgsBody),
    'the messages block must allow a create in the legacy (group) room, gated on isLegacyArchive + ' +
    'senderEmail == selfEmail() — otherwise a deploy silently breaks the All HR group chat'
);
assert(
    /allow delete: if false;/.test(msgsBody),
    'a message must still never be hard-deleted in the group room — the tombstone stays'
);
// Unsend reaches the group room too (the rule carries isLegacyArchive), so you
// can retire your OWN message there — but it is the same narrow author-only,
// text-wiped, one-way tombstone, never a general edit.
assert(
    /allow update: if \(isChatMember\(chatId\) \|\| isLegacyArchive\(chatId\)\)[\s\S]*?resource\.data\.senderEmail == selfEmail\(\)/.test(msgsBody),
    'the group-room message update (unsend) must still be author-only — the isLegacyArchive arm grants the ' +
    'same narrow tombstone, nothing wider'
);

// 7. ⚠️⚠️ TWO ROLE SETS, AND THIS TEST IS WHAT KEEPS THEM HONEST.
//
//     isChatRole()        — 1:1 conversations: hr, superadmin, owner
//     isHrOrSuperAdmin()  — the "All HR" GROUP chat: hr, superadmin ONLY
//
//     They used to be one helper. They must NOT be merged again: the group
//     room is gated on ROLE (it has no members list), so adding 'owner' to
//     isHrOrSuperAdmin() would silently hand every Area Manager read AND
//     write on the All HR group chat. The client mirrors the split with
//     CHAT_ALLOWED_ROLES and GROUP_ROOM_ROLES.
const helper = rules.match(/function\s+isHrOrSuperAdmin\(\)\s*\{[\s\S]*?\n\s*\}/);
assert(helper, 'could not read the isHrOrSuperAdmin() helper body');
assert(
    /role\s+in\s*\[\s*'hr'\s*,\s*'superadmin'\s*\]/.test(helper[0]),
    "isHrOrSuperAdmin() must be an allowlist of exactly ['hr', 'superadmin']"
);
assert(!/operator/.test(helper[0]), 'isHrOrSuperAdmin() must never include the operator role');
assert(
    !/'owner'/.test(helper[0]),
    'isHrOrSuperAdmin() must NEVER include the owner role — this helper IS the group chat ' +
    'membership, and an Area Manager in that set means every Area Manager can read and write ' +
    'the All HR group room'
);

const chatHelper = rules.match(/function\s+isChatRole\(\)\s*\{[\s\S]*?\n\s*\}/);
assert(chatHelper, 'isChatRole() helper is missing from firestore.rules — it is what lets an Area Manager hold a 1:1 thread');
assert(
    /role\s+in\s*\[\s*'hr'\s*,\s*'superadmin'\s*,\s*'owner'\s*,\s*'rmsm'\s*\]/.test(chatHelper[0]),
    "isChatRole() must be an allowlist of exactly ['hr', 'superadmin', 'owner', 'rmsm']"
);
assert(!/operator/.test(chatHelper[0]), 'isChatRole() must never include the operator role');

// The group room must keep naming the NARROW helper. This is the single line
// that keeps Area Managers out of the All HR chat.
assert(
    /function\s+isLegacyArchive\(chatId\)\s*\{\s*return\s+isHrOrSuperAdmin\(\)\s*&&\s*chatId\s*==\s*'owner-superadmin';/.test(rules),
    'isLegacyArchive() (the All HR group room) must gate on isHrOrSuperAdmin() — switching it ' +
    'to isChatRole() would expose the whole group chat to every Area Manager'
);
// ...and isChatMember() must gate on the WIDE one, or the Area Manager can
// never open the 1:1 thread the feature is for.
assert(
    /function\s+isChatMember\(chatId\)\s*\{\s*return\s+isChatRole\(\)/.test(rules),
    'isChatMember() (1:1 rooms) must gate on isChatRole() — it is what lets an Area Manager ' +
    'open and read a private thread'
);

// 7b. The RULES and CLIENT allowlists MUST agree — on BOTH sets. If they
//     drift, a user either sees chat and is denied on send (1:1 too narrow),
//     or sees no chat they should have (too wide), or an Area Manager ends up
//     in the group room.
const clientSrc = fs.readFileSync(path.join(ROOT, 'js', 'chat.js'), 'utf8');
const clientList = clientSrc.match(/CHAT_ALLOWED_ROLES\s*=\s*\[([^\]]+)\]/);
assert(clientList, 'could not find CHAT_ALLOWED_ROLES in js/chat.js');
const groupList = clientSrc.match(/GROUP_ROOM_ROLES\s*=\s*\[([^\]]+)\]/);
assert(groupList, 'could not find GROUP_ROOM_ROLES in js/chat.js');
const clean = (s) => s.split(',').map((r) => r.trim().replace(/^['"]|['"]$/g, '')).sort().join(',');
const clientRoles = clean(clientList[1]);
const clientGroupRoles = clean(groupList[1]);
const rulesRoles = clean(chatHelper[0].match(/role\s+in\s*\[([^\]]+)\]/)[1]);
const rulesGroupRoles = clean(helper[0].match(/role\s+in\s*\[([^\]]+)\]/)[1]);
assert.strictEqual(
    clientRoles,
    rulesRoles,
    'chat.js CHAT_ALLOWED_ROLES and firestore.rules isChatRole() must list the SAME roles for ' +
    `1:1 conversations, or a user can see chat but be denied on send (client=${clientRoles}, ` +
    `rules=${rulesRoles})`
);
assert.strictEqual(
    clientGroupRoles,
    rulesGroupRoles,
    'chat.js GROUP_ROOM_ROLES and firestore.rules isHrOrSuperAdmin() must list the SAME roles ' +
    `for the All HR group, or the row is shown to someone the rules deny (client=${clientGroupRoles}, ` +
    `rules=${rulesGroupRoles})`
);
assert.notStrictEqual(
    clientRoles,
    clientGroupRoles,
    'the 1:1 and group allowlists must NOT be the same width — that is exactly the merge that ' +
    'would put Area Managers in the All HR group chat'
);

// 7c. No rule may still reference the removed isOwnerOrSuperAdmin() helper,
//     which would silently deny every chat read/write.
assert(
    !/isOwnerOrSuperAdmin/.test(rules),
    'firestore.rules still references isOwnerOrSuperAdmin(); chat is now gated by isHrOrSuperAdmin()'
);

// 7d. Messages stay immutable EXCEPT for the author's own UNSEND, which is a
//     one-way tombstone — never an edit. The read receipts still live in their
//     own subcollection so ticking ✓/✓✓ never has to touch a message; the ONLY
//     write a message now accepts is the author retiring their own text.
const messagesBlock = block.slice(block.indexOf('match /messages/'));
assert(
    /allow update: if \(isChatMember\(chatId\) \|\| isLegacyArchive\(chatId\)\)[\s\S]*?resource\.data\.senderEmail == selfEmail\(\)[\s\S]*?affectedKeys\(\)\s*\n?\s*\.hasOnly\(\['unsent', 'unsentAt', 'text'\]\)[\s\S]*?request\.resource\.data\.unsent == true[\s\S]*?request\.resource\.data\.text == '';/.test(messagesBlock),
    'the message update rule must be the narrow UNSEND tombstone only — author (senderEmail == selfEmail()), ' +
    'field-locked to {unsent, unsentAt, text}, one-way (unsent == true) and text wiped (== \'\'). Anything wider ' +
    'would let a sent message be edited.'
);
assert(
    /allow delete: if false;/.test(messagesBlock),
    'a message must still never be hard-deleted — the tombstone stays so the thread keeps its shape'
);
// The tombstone must NOT be reversible: the rule requires unsent == true on the
// incoming doc, so there is no path back to a live message.
assert(
    !/request\.resource\.data\.unsent == false/.test(messagesBlock),
    'there must be no rule path that sets unsent back to false — un-unsending is impossible by design'
);

// 7e. Receipts: readable by the chat, but writable ONLY by their owner.
//     Without the owner check anyone could mark everybody else's messages read.
const receiptsBlock = block.slice(block.indexOf('match /readReceipts/'));
assert(
    /match \/readReceipts\/\{userKey\}[\s\S]*?allow read: if canReadChat\(chatId\);/.test(receiptsBlock),
    'readReceipts must be readable by the room so ticks can turn blue'
);
assert(
    /allow create: if isChatMember\(chatId\)[\s\S]*?request\.resource\.data\.email == selfEmail\(\);/.test(receiptsBlock),
    'a receipt create must require room membership AND email == selfEmail(), or anyone could forge one'
);
assert(
    /allow update: if isChatMember\(chatId\)[\s\S]*?resource\.data\.email == selfEmail\(\)/.test(receiptsBlock),
    'a receipt update must be restricted to its owner (resource.data.email)'
);
assert(
    /allow update, delete: if true;/.test(receiptsBlock) === false,
    'readReceipts must never be world-writable'
);

// 7f. Profiles: readable by the thread, writable ONLY by their owner, and
//     restricted to presentation fields. A profile must never be able to
//     smuggle in a role/permission field, and one person must never be able
//     to rewrite another person's identity in the thread.
const profilesBlock = block.slice(block.indexOf('match /profiles/'));
assert(
    /match \/profiles\/\{userKey\}[\s\S]*?allow read: if isChatRole\(\);/.test(profilesBlock),
    'profiles must be readable by the chat team (isChatRole) — this subcollection is also the ' +
    'people directory, and it must resolve names before any conversation exists. It was widened ' +
    'from isHrOrSuperAdmin() so an Area Manager can see the names they are allowed to message'
);
assert(
    /allow create: if isChatRole\(\)[\s\S]*?request\.resource\.data\.email == selfEmail\(\);/.test(profilesBlock),
    'a profile create must require email == selfEmail(), or anyone could forge a colleague'
);
assert(
    /allow update: if isChatRole\(\)[\s\S]*?resource\.data\.email == selfEmail\(\)/.test(profilesBlock),
    'a profile update must be restricted to its owner (resource.data.email)'
);
assert(
    /hasOnly\(\['email', 'role', 'displayName', 'title'\]\)/.test(profilesBlock),
    'a profile must be limited to the four already-deployed presentation fields — an extra ' +
    'key (e.g. an `active` flag) would be denied by hasOnly() and the write would fail'
);
assert(
    /allow (create|update)[^:]*:\s*if true/.test(profilesBlock) === false,
    'profiles must never be world-writable'
);

// 7g. Reactions: readable by the thread, writable only as yourself, and
//     carrying ONLY presentation fields. A reaction is one doc per
//     {messageId, person}, so "one reaction each" is structural; switching
//     emoji is an update of the `emoji` field alone, with `messageId` and
//     `email` frozen so a reaction can never be repointed.
const reactionsBlock = block.slice(block.indexOf('match /reactions/'));
assert(
    /match \/reactions\/\{reactionId\}[\s\S]*?allow read: if canReadChat\(chatId\);/.test(reactionsBlock),
    'reactions must be readable by the room so counts resolve'
);
assert(
    /allow create: if isChatMember\(chatId\)[\s\S]*?request\.resource\.data\.email == selfEmail\(\)/.test(reactionsBlock),
    'a reaction create must require room membership AND email == selfEmail(), or anyone could react as a colleague'
);
assert(
    /allow delete: if isChatMember\(chatId\)\s*\r?\n\s*&& resource\.data\.email == selfEmail\(\);/.test(reactionsBlock),
    'a reaction delete must be restricted to its owner (resource.data.email)'
);
assert(
    /hasOnly\(\['messageId', 'emoji', 'email'\]\)/.test(reactionsBlock),
    'a reaction must carry only messageId/emoji/email — it must never be able to ' +
    'smuggle in a field something else might trust'
);
// Switching emoji is the ONLY permitted update: messageId and email are
// frozen, so a reaction cannot be moved to another message or handed to
// another person after the fact.
assert(
    /allow update: if isChatMember\(chatId\)[\s\S]*?affectedKeys\(\)\.hasOnly\(\['emoji'\]\)/.test(reactionsBlock),
    'a reaction update must be restricted to the `emoji` field — messageId and email must be frozen'
);
assert(
    /allow update: if isChatMember\(chatId\)[\s\S]*?resource\.data\.email == selfEmail\(\)/.test(reactionsBlock),
    'a reaction update must be restricted to its owner (resource.data.email)'
);
assert(
    /allow update: if true;/.test(reactionsBlock) === false,
    'reactions must never be world-writable'
);

// 7h. The legacy shared room must be READABLE (its mixed history is the
//     only copy of the old messages) but never WRITABLE — that is what stops
//     it quietly becoming a second shared room and leaking across people.
assert(
    /function\s+isLegacyArchive\(chatId\)/.test(rules),
    'isLegacyArchive() helper is missing from firestore.rules'
);
const legacyRoomCreate = (block.match(/allow create:[\s\S]*?;/g) || [])[0];
assert(
    /!isLegacyArchive\(chatId\)/.test(legacyRoomCreate || ''),
    'the legacy archive room must be excluded from create, or it can be re-created as a shared room'
);
const roomUpdateRule = (block.match(/allow update:[\s\S]*?hasOnly\([^)]*\);/g) || [])[0];
assert(
    /!isLegacyArchive\(chatId\)/.test(roomUpdateRule || ''),
    'the legacy archive room must be excluded from update — it is read-only'
);
assert(
    /canReadChat\(chatId\)/.test(rules.match(/function\s+canReadChat\(chatId\)[\s\S]*?\n\s*\}/)[0]),
    'canReadChat() must combine membership with the legacy archive'
);

// 7i. `members` must be FROZEN on update. Otherwise either participant could
//     add a third person to a 1:1 thread (or drop themselves) and take over
//     its history — the one field that defines who may read it.
const roomAffected = (roomUpdateRule || '').match(/hasOnly\(([^)]*)\)/);
assert(roomAffected, 'the room update rule must constrain the writable fields');
assert(
    roomAffected[1].indexOf("'members'") === -1,
    '`members` must NOT be updatable — it defines who can read the room, so freezing it ' +
    'is what stops a participant adding a third person to a 1:1 conversation'
);

// 7j. The people directory is the `profiles` subcollection of the legacy
//     room (asserted as readable above). It must stay owner-writable and
//     presentation-only, and must never become world-readable — it is a
//     list of internal staff. The CLIENT-side half of this (reusing the
//     deployed path rather than a new collection) is asserted in section 9.
const dirBlock = rules.slice(rules.indexOf('match /profiles/'));
assert(
    /hasOnly\(\['email', 'role', 'displayName', 'title'\]\)/.test(dirBlock),
    'a directory entry must be limited to presentation fields — no permissions, no account data'
);
assert(
    /request\.resource\.data\.email == selfEmail\(\)/.test(dirBlock),
    'a directory entry must be writable only by its owner'
);
assert(
    /allow read: if true;/.test(dirBlock) === false,
    'the directory must never be publicly readable — it is a list of internal staff'
);

console.log('✅ Chat rules tests passed (create/update split; HR+superadmin only; membership-scoped ' +
    'reads and writes; the room written BEFORE the message; legacy archive read-only; members frozen; ' +
    'messages immutable; receipts ' +
    'owner-only; directory reuses the DEPLOYED profiles path; reactions owner-only + immutable; ' +
    'both sides of the roster read from `users` (superadmin whole, HR role-scoped; the HR half needs a deploy); ' +
    'a denied list query rebuilt from per-room document reads; ' +
    'the room read rule also provable for the list query; ' +
    'the group chat is role-gated so new accounts join automatically; the modal has a fixed height; ' +
    'client/rules allowlists agree).');

// ---------------------------------------------------------------
// 8. NO COMPOSITE INDEX — THE APP MUST STAY ON THE FREE (SPARK) PLAN.
//
//    The conversation list is `chats` where members array-contains <me>.
//    Firestore CANNOT serve an array-contains filter combined with an
//    orderBy on a DIFFERENT field from its automatic single-field
//    indexes — that needs a composite index, and COMPOSITE INDEXES ARE A
//    PAID (BLAZE) PLAN FEATURE. On the free plan the query is rejected
//    with FAILED_PRECONDITION and the sidebar is permanently empty.
//
//    So the client must NOT orderBy, and no indexes file may be declared.
//    Sorting happens client-side instead.
// ---------------------------------------------------------------
assert(
    !fs.existsSync(path.join(ROOT, 'firestore.indexes.json')),
    'firestore.indexes.json must not exist — composite indexes are a PAID (Blaze) plan ' +
    'feature and this app runs on the free plan'
);
const fbConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
assert.strictEqual(
    fbConfig.firestore && fbConfig.firestore.indexes,
    undefined,
    'firebase.json must not declare an indexes file — the conversation list must run on ' +
    'automatic single-field indexes only, so the free plan keeps working'
);
assert.strictEqual(
    fbConfig.firestore && fbConfig.firestore.rules,
    'firestore.rules',
    'firebase.json must still declare the rules file'
);
assert(
    !/\.where\('members',\s*'array-contains',\s*currentUserEmail\)[\s\S]{0,200}?\.orderBy\(/.test(clientSrc),
    'the conversation-list query must NOT chain orderBy after the array-contains filter — ' +
    'that combination requires a paid composite index and breaks the sidebar on the free plan'
);

// 9. The client must send `members` as a LIST of exactly the two participants
//    — that array is the authorisation, so writing 1 or 3 entries breaks it.
//
//    ⚠️ The room doc must also write ONLY the keys the ALREADY-DEPLOYED
//    rules allow. An unknown key denies the room write, and since the first
//    message of a new conversation depends on that room existing, an extra
//    key means that conversation can never be started at all. Unread is
//    therefore localStorage, not a room field.
assert(
    /where\('members',\s*'array-contains',\s*currentUserEmail\)/.test(clientSrc),
    'chat.js must query the conversation list by `members array-contains`'
);
assert(
    /members: isGroupRoom\(\) \? everyoneKnownForGroup\(\) : \[me, them\],/.test(clientSrc),
    'a new 1:1 room must record exactly the two participants in `members` — that array is what the ' +
    'rules authorise. The group room is the single exception: it is gated on the ROLE, so its list is ' +
    'only a fallback for the case where it has to be created at all (see everyoneKnownForGroup).'
);
assert(
    !/FieldValue\.increment/.test(clientSrc),
    'no increment() on the room doc — an unreadCount field would need a rules deploy before ' +
    'messages could save at all, and unread is tracked in localStorage instead'
);

// The room payload must be defined ONCE (`const roomSummary = { ... }`) and
// contain exactly the keys the deployed rules allowlist. It is written TWICE
// — once on its own, to make the room EXIST, and once in the batch that
// carries the message — which is exactly why it is not an inline literal at
// each call site: two copies would drift, and a drifted key is a denied
// write, not a warning.
const roomSummaryBlock = (clientSrc.match(/\broomSummary\s*=\s*\{([\s\S]*?)\n\s*\};/) || [''])[1] || '';
assert(roomSummaryBlock, 'chat.js must define the room payload once (`roomSummary = { ... }`)');
assert.strictEqual(
    (clientSrc.match(/\broomSummary\s*=\s*\{/g) || []).length,
    1,
    'the room payload must be defined in exactly ONE place — the standalone room write and the message ' +
    'batch both use it, and two copies would drift (a drifted key is a denied write, not a warning)'
);
['type', 'members', 'lastMessage', 'lastMessageAt', 'lastSenderEmail'].forEach((key) => {
    assert(
        roomSummaryBlock.indexOf(key + ':') > -1,
        `the room payload must include \`${key}\` — the deployed rules allowlist it`
    );
});
const roomKeys = (roomSummaryBlock.match(/^\s+([a-zA-Z]+):/gm) || []).map((m) => m.trim().replace(':', ''));
const allowedRoomKeys = ['type', 'title', 'lastMessage', 'lastMessageAt', 'lastSenderEmail', 'members'];
const extraKeys = roomKeys.filter((k) => allowedRoomKeys.indexOf(k) === -1);
assert.strictEqual(
    extraKeys.length,
    0,
    'the room payload must contain ONLY keys the already-deployed rules allow (' +
    `found unexpected: ${extraKeys.join(', ')}). An unknown key denies the room write, and the ` +
    'first message of a new conversation cannot be sent without that room.'
);
assert.strictEqual(
    new Set(roomKeys).size,
    roomKeys.length,
    'the room payload must not repeat a key (' + roomKeys.join(', ') + ')'
);

// ⚠️ THE ROOM MUST BE COMMITTED *BEFORE* THE MESSAGE. Every rule on a
// subcollection resolves membership by READING THE ROOM
// (`isChatMember(chatId)` = `get(chats/{chatId}).data.members`), so a message
// written in the SAME batch as the room it belongs to is evaluated while that
// room still does not exist: the get() finds nothing and the write is DENIED.
// That is the "Chat cannot read or write this conversation" failure on the
// first message to a new contact — and it is invisible to every other test in
// this suite, so the ORDER is asserted here.
const preRoomWrite = clientSrc.indexOf('await roomRef().set(roomSummary');
// The message write is its own function now (writeMessageBatch), so the
// ordering that matters is: the standalone room write, THEN that call.
const messageWrite = clientSrc.search(/await writeMessageBatch\([\s\S]{0,240}?messageWritesMinimal,[\s\S]{0,120}?isGroupRoom\(\)/);
assert(
    preRoomWrite > -1,
    'the room must be written by its OWN awaited call — await roomRef().set(roomSummary, ...) — ' +
    'or a first message can never be sent'
);
assert(
    preRoomWrite > -1 && messageWrite > -1 && preRoomWrite < messageWrite,
    'the room write must come BEFORE the write that carries the message: the membership rule ' +
    'reads the room, so a message sent in the same batch as its room is denied'
);
assert(
    /if\s*\(!roomIsStarted\s*&&\s*!isGroupRoom\(\)\)\s*\{[\s\S]{0,240}?await roomRef\(\)\.set\(roomSummary/.test(clientSrc),
    'the standalone room write must be conditional on the conversation not being started yet, so an ' +
    'existing conversation keeps its message + summary in ONE atomic batch'
);
// ⚠️⚠️ AND IT MUST BE SKIPPED FOR THE GROUP ROOM — THE REGRESSION THIS GUARDS.
// `chats/owner-superadmin` is FROZEN BY DESIGN: firestore.rules denies BOTH
// `allow create` and `allow update` on it via `&& !isLegacyArchive(chatId)`.
// It also has no `members` array, so `conversationSummaries` can never hold it
// (the list query filters on `members`) and `roomIsStarted` was therefore ALWAYS
// false there. On a FRESH Firestore, where that document does not exist, this
// line attempted a CREATE the rules refuse on purpose; it threw at
// `stage === 'room'`, which also skipped the payload ladder (gated on
// `stage === 'message'`), and the failure was misreported as "run
// `firebase deploy --only firestore:rules`" — which cannot fix it, because this
// repo's own rules refuse the write too. No parent document is needed: the
// group's message rule is ROLE-gated and never checks `exists()`.
assert(
    /if\s*\(!roomIsStarted\s*&&\s*!isGroupRoom\(\)\)\s*\{/.test(clientSrc),
    'the standalone room write must NEVER run in the group chat: that room document is frozen by ' +
    'design (firestore.rules denies create AND update on it with `!isLegacyArchive(chatId)`), so ' +
    'writing it is refused forever — which made the FIRST group message on a fresh Firestore fail ' +
    'with a permission error misreported as a stale-rules problem'
);
assert(
    /const\s+roomIsStarted\s*=\s*Boolean\(conversationSummaries\[activeRoomId\]\)/.test(clientSrc),
    'roomIsStarted must come from the conversation list — the only place that knows whether the ' +
    'room document exists on the server'
);
assert(
    /batch\.set\(roomRef\(\), roomSummary, \{ merge: true \}\)/.test(clientSrc),
    'the room summary must STILL ride in the batch with the message, so an existing conversation ' +
    'updates its preview atomically'
);

// The failure must name WHICH write was refused. "cannot create the
// conversation" and "cannot write into it" are different bugs with different
// fixes, and reporting the second one when the first one failed sends people
// looking in the wrong place.
assert(
    /stage\s*=\s*'message'/.test(clientSrc) && /stage === 'room'/.test(clientSrc),
    'sendMessage must track which write failed (room vs message) and report that one'
);
assert(
    /roomId === LEGACY_ROOM_ID/.test(clientSrc) && /isLegacyArchive/.test(rules),
    'the legacy shared room must be handled read-only on both sides'
);
// The people directory reuses the DEPLOYED profiles subcollection rather
// than a new collection that would need its own rule to be readable.
assert(
    /doc\(LEGACY_ROOM_ID\)\.collection\('profiles'\)/.test(clientSrc),
    'the people directory must read the legacy room\'s profiles subcollection, which the ' +
    'already-deployed rules already permit — a NEW collection would be denied until deployed'
);
assert(
    !/match \/chatProfiles\//.test(rules),
    'no chatProfiles collection: it would need a new rule before the conversation list could ' +
    'read it, and this app must work with nothing deployed'
);
assert(
    !/'active'/.test(clientSrc.slice(clientSrc.indexOf('function saveMyDirectoryEntry'), clientSrc.indexOf('function startDirectoryListener'))),
    'the directory write must not include an `active` flag — the deployed profile allowlist ' +
    'is (email, role, displayName, title) and an extra key is denied'
);

// ---------------------------------------------------------------
// 10. BOTH SIDES MUST SEE EVERY ACCOUNT THEY MAY MESSAGE — NOT ONLY THE
//     PEOPLE WHO HAVE PUBLISHED A PROFILE.
//
//     `chats/owner-superadmin/profiles` is the people directory, but it is
//     SELF-PUBLISHED: a person appears in it only after they have opened the
//     chat and saved a profile, and the `role` in it is whatever was current
//     at that moment. A brand-new HR is therefore invisible to a superadmin
//     ("the superadmin cannot see all the HR accounts"), and an entry
//     published with an empty or stale role is filtered out by isStartable().
//     The other direction is the same story: a SUPERADMIN who has never
//     opened the chat has no profile entry either, so an HR could not find
//     them — which is "an HR cannot message the new superadmin".
//
//     The authoritative role is `users/{email}.role` — the field the rules
//     and the dashboard both authorise on — so BOTH sides read `users`: a
//     superadmin WHOLE (`allow read: if isSuperAdmin() || isSelf()`, the
//     statement script.js already exercises through loadSuperadminUsers(), so
//     NO rules deploy needed for that direction), and an HR only the
//     superadmin docs, through the SECOND read statement the rules carry for
//     it — which DOES need `firebase deploy --only firestore:rules`, and
//     until that happens degrades to the directory instead of breaking chat.
// ---------------------------------------------------------------
assert(
    /match \/users\/\{userId\}[\s\S]*?allow read: if isSuperAdmin\(\) \|\| isSelf\(\);/.test(rules),
    'the account roster only works while the deployed users rule lets a superadmin read every user doc'
);
// ...and the SECOND half of that rule: an HR must be able to discover the
// SUPERADMIN accounts, which is exactly what the self-published directory
// cannot do on its own (a brand-new superadmin has no profile entry).
const usersBlock = rules.slice(rules.indexOf('match /users/'));
assert(
    /allow read: if isHrOrSuperAdmin\(\)\s*&&\s*resource\.data\.role == 'superadmin';/.test(usersBlock),
    'firestore.rules must let an HR read the SUPERADMIN accounts — without it "an HR can message every ' +
    'superadmin" is impossible — and it must stay scoped to role == superadmin so owner/operator ' +
    'accounts, their statuses and their permissions stay unreadable'
);
// The SECOND read statement — an HR must be able to discover the
// SUPERADMIN accounts, which is exactly what the self-published directory
// cannot do on its own (a brand-new superadmin has no profile entry).
// Personal chat is now a single pair (superadmin <-> HR), so there are no
// third/fourth statements and no store-role discovery slice of `users`.
assert(
    !/allow read: if isAreaManager\(\)/.test(usersBlock),
    'the OLD Area Manager discovery statements must be GONE — store roles never start a private thread'
);
assert.strictEqual(
    (usersBlock.match(/allow read:/g) || []).length,
    2,
    'the users read rules must now be TWO (a superadmin whole-collection read + the HR slice)'
);
const rosterFn = (clientSrc.match(/function\s+loadHrRoster\(\)\s*\{[\s\S]*?\n\s{4}\}/) || [''])[0];
assert(rosterFn, 'chat.js must define loadHrRoster() — the authoritative roster behind BOTH sides of the list');
// LIVE, not one-shot: a `.get()` only ever answered for the device that asked,
// at mount, so an account approved on somebody else's machine stayed invisible
// until a reload. The snapshot is what makes "a new registrant appears" true on
// every screen.
assert(
    /rosterUnsub = source\.onSnapshot\(apply, failed\);/.test(rosterFn),
    'the roster must be a LIVE onSnapshot listener — a one-shot .get() would show new accounts only on ' +
    'the device that happened to reload'
);
// The three sides read differently because the rules do.
assert(
    /if \(currentRole === 'owner'\s*\|\|\s*currentRole === 'rmsm'\) \{\s*source = source\.where\('role', 'in', rosterWantedRoles\(\)\);/s.test(rosterFn),
    "the store-side read must carry `where('role','in',[...])` — that is the " +
    'is denied). Store roles like Area Manager / RM/SM have no paired peer, so rosterWantedRecords() ' +
    'returns [] for them and their read resolves empty'
);
assert(
    /else if \(currentRole !== 'superadmin'\) \{\s*source = source\.where\('role', '==', 'superadmin'\);/.test(rosterFn),
    "the HR's read must carry `where('role','==','superadmin')` — that is the filter the users read " +
    "rule is provable from (an unfiltered HR read of `users` is denied), and it must live in the " +
    'HR-only branch so a superadmin keeps the whole-collection read (no index, and it survives a ' +
    "role stored as 'HR ')"
);
assert(
    /function\s+rosterWantedRoles\(\)\s*\{[\s\S]*?CHAT_ALLOWED_ROLES\.filter/.test(clientSrc),
    'rosterWantedRoles() must DERIVE the wanted roles from CHAT_ALLOWED_ROLES rather than spelling ' +
    'them out again — otherwise adding a chat role leaves the roster silently behind, and the ' +
    "manager's `in` filter would stop matching its own rules clause"
);
assert(
    /if \(!canChat\(currentRole\)\) return;/.test(rosterFn),
    'only the chat roles may read the roster: an operator has no chat at all, so asking would be a ' +
    'refused read that proves nothing (the Area Manager IS a chat role and must pass this gate)'
);
assert(
    /const wanted = rosterWantedRoles\(\);/.test(rosterFn) &&
        /wanted\.indexOf\(normalizeRole\(data\.role\)\) === -1/.test(rosterFn),
    'the roster must keep ONLY the roles isStartable() would accept — derived by ' +
    'rosterWantedRoles() — so the pairing rule and the roster can never disagree about who may be ' +
    'messaged. It is a SET test, not an equality, because the wanted list is derived from the ' +
    'pairing map (one peer role per role); in particular a manager never sees a co-manager OR an HR'
);
assert(
    /console\.warn\('\[Chat\] HR roster unavailable:', error && error\.message\)/.test(rosterFn) &&
        /catch \(error\)/.test(rosterFn),
    'a failed/denied roster read must be caught and reported — it is a convenience, not a permission, and ' +
    'it must never take the chat down (an HR on a ruleset without the clause simply falls back to the ' +
    'directory)'
);
// ONE listener at a time: this runs at mount AND from refreshDirectory().
assert(
    /if \(rosterUnsub\) \{[\s\S]{0,160}?rosterUnsub\(\);[\s\S]{0,80}?rosterUnsub = null;/.test(rosterFn),
    'the previous roster listener must be released before the next subscribe, or a permissions refresh ' +
    'would leave two listeners writing the same state'
);
assert(
    /stopConversationListListener\(\);[\s\S]{0,300}?if \(rosterUnsub\) \{[\s\S]{0,160}?rosterUnsub\(\);/.test(clientSrc),
    'teardown must release the roster listener too — it is live now, and a stale one would keep rebuilding ' +
    'the list for whoever signs in next'
);
// ...and it must be WIRED IN: at mount, and again whenever a role changes.
assert.strictEqual(
    (clientSrc.match(/^\s+loadHrRoster\(\);/gm) || []).length,
    2,
    'loadHrRoster() must be called exactly twice: at mount, and from ChatService.refreshDirectory(), which ' +
    'script.js calls after an account is approved or re-roled'
);
const refreshFn = (clientSrc.match(/ChatService\.refreshDirectory = function \(\) \{[\s\S]*?\n\s{4}\};/) || [''])[0];
assert(
    /loadHrRoster\(\)/.test(refreshFn),
    'refreshDirectory() must re-read the roster, or a newly approved HR stays invisible until a page reload'
);

// The two sources must be UNIONED, not swapped: a person only the roster
// knows about must be offered, and a directory entry whose stored role is
// stale or empty must not hide an HR the roster knows about.
assert(
    /function\s+personProfileFor\(email\)/.test(clientSrc),
    'personProfileFor() is the one place the directory and the roster are merged'
);
const mergeFn = (clientSrc.match(/function\s+personProfileFor\(email\)\s*\{[\s\S]*?\n\s{4}\}/) || [''])[0];
assert(mergeFn, 'could not read the personProfileFor() body');
assert(
    /Object\.assign\(\{\},\s*entry,\s*\{\s*email:[^}]*role:\s*roster\.role/.test(mergeFn),
    'the ROSTER role must override a stale directory role — `users` is what the rules authorise on, so a ' +
    "profile published with `role: ''` must not hide an HR"
);
assert(
    /const entry = directory\[key\]/.test(mergeFn) && /const roster = rosterEntries\[key\]/.test(mergeFn),
    'the merge must consult BOTH the directory and the roster'
);
assert(
    // ⚠️ The ＋ "new conversation" BUTTON and its floating picker are GONE. The
    // conversation list already offers every person a thread may be started
    // with as a "tap to start" row, so the picker was a SECOND control over the
    // same set of people — a duplicate entry point into one list, and the one
    // most people never found. Guard the removal, or a quiet edit can put two
    // controls back over the same list.
    !/chatNewBtn|chatNewMenu|newMenu|chat-newmenu|chat-icon-btn/.test(clientSrc),
    'js/chat.js must not resurrect the ＋ button or its picker — the list rows are how a conversation is started'
);
assert(
    /startableEmails\(\)\.forEach\(/.test(clientSrc),
    'the conversation list must list the UNION of the directory and the roster — it is the ONLY entry point now'
);
assert(
    /function\s+startableEmails\(\)\s*\{[\s\S]*?Object\.keys\(directory\)[\s\S]*?Object\.keys\(rosterEntries\)/.test(clientSrc),
    'startableEmails() must merge the directory keys with the roster keys'
);
assert(
    /directory = \{\};\s*\n\s*rosterEntries = \{\};/.test(clientSrc),
    'a teardown must clear BOTH the directory and the roster, or the next account would inherit them'
);

// ---------------------------------------------------------------
// 11. THE CONVERSATION LIST MUST SURVIVE A DENIED LIST QUERY.
//
//     The list is normally ONE query (`chats where members array-contains
//     me`), which needs no index and no paid plan. But a query is authorised
//     as a SINGLE rules evaluation over the whole collection, and the
//     membership rule resolves every room with exists()/get(), which cannot
//     be proven that way — so the deployed ruleset can refuse the query even
//     though every room DOCUMENT is individually readable.
//
//     That is not cosmetic. selectConversation() opens a thread only when the
//     room is in the summaries, so an empty list means no conversation ever
//     shows its history and no unread badge ever lights up. The client must
//     therefore rebuild the list from one document listener per room.
// ---------------------------------------------------------------
assert(
    /conversationListDenied = true;/.test(clientSrc),
    'a permission error on the list query must be recorded, or nothing knows to fall back'
);
assert(
    /conversationListDenied = true;[\s\S]{0,900}?startPerRoomConversationListeners\(\);/.test(clientSrc),
    'the permission-error branch of the list query must start the per-room fallback: a denied query ' +
    'otherwise empties the sidebar AND makes every conversation open blank, because ' +
    'selectConversation() only subscribes to a thread the summaries know about'
);
const perRoomFn = (clientSrc.match(/function startPerRoomConversationListeners\(\)\s*\{[\s\S]*?\n\s{4}\}/) || [''])[0];
assert(perRoomFn, 'chat.js must define startPerRoomConversationListeners() — the denied-query fallback');
assert(
    /if \(!conversationListDenied\) return;/.test(perRoomFn),
    'the fallback must only run when the query was actually denied — otherwise it would multiply the ' +
    'listeners for nothing on a working ruleset'
);
assert(
    /startableEmails\(\)\.forEach/.test(perRoomFn) && /myRoomIdWith\(email\)/.test(perRoomFn),
    'the fallback must derive one room per KNOWN person (myRoomIdWith), because the people it can enumerate ' +
    'are the directory plus the account roster — not the collection'
);
assert(
    /if \(inGroupRoom\(\)\) roomIds\[LEGACY_ROOM_ID\] = true;/.test(perRoomFn),
    'the legacy archive must be watched by the fallback too, but ONLY for a role that may read it ' +
    '(inGroupRoom()) — isLegacyArchive() makes it readable by every HR and superadmin, so the ' +
    'archive row must survive a denied list query. Gating it matters for an Area Manager: they may ' +
    'NOT read this room, and an unconditional subscription would re-attempt a permanently denied ' +
    'room every retry interval for the whole session'
);
assert(
    perRoomFn.indexOf("collection('chats')") === -1 && perRoomFn.indexOf('.where(') === -1,
    'the fallback must never issue another collection QUERY — the query is exactly what gets denied'
);
const subRoomFn = (clientSrc.match(/function subscribeRoomForList\(roomId\)\s*\{[\s\S]*?\n\s{4}\}/) || [''])[0];
assert(subRoomFn, 'could not read the subscribeRoomForList() body');
assert(
    /collection\('chats'\)\.doc\(roomId\)\.onSnapshot/.test(subRoomFn),
    'each room must be watched as a DOCUMENT — that read is the one the membership rule can allow'
);
assert(
    /isPermissionError\(error\)/.test(subRoomFn) && /conversationRoomsDenied\[roomId\] = true;/.test(subRoomFn),
    'a room that does not exist yet is DENIED (isChatMember() starts with exists()), which is the normal ' +
    'state for somebody never messaged — it must be remembered as missing, never reported as an error'
);
assert(
    /function scheduleDeniedRoomRetry\(\)/.test(clientSrc),
    'the denied rooms must be re-attempted, or a conversation started by the OTHER person would stay ' +
    'invisible in the sidebar until a page reload'
);
assert(
    /if \(timer && typeof timer\.unref === 'function'\) timer\.unref\(\);/.test(clientSrc),
    'the retry timer must be unref()ed where that API exists, or a pending 60s timer keeps the test ' +
    'process alive; browsers return a plain number and have no unref'
);
assert(
    /Object\.keys\(conversationRoomUnsubs\)\.forEach/.test(clientSrc) &&
    /clearTimeout\(deniedRoomRetryTimer\)/.test(clientSrc),
    'stopConversationListListener() must release the per-room listeners AND the retry timer, or a re-init ' +
    'leaves a second set of listeners writing the same summaries'
);
assert(
    /if \(roomId === activeRoomId && !messagesUnsub\)/.test(clientSrc),
    'a room document that reports AFTER the conversation was opened must attach the thread — otherwise a ' +
    'conversation with history opens blank until a page reload'
);
assert(
    /rememberRoom\(activeRoomId\);[\s\S]{0,120}?subscribeRoomForList\(activeRoomId\);/.test(clientSrc),
    'after the first message creates the room, it must be remembered AND its listener (re)attached, or ' +
    'the sidebar keeps calling a live conversation "tap to start" and never hears about later messages'
);
assert(
    /syncSummaryFromMessage\(activeRoomId, \{[\s\S]{0,40}?text: text,/.test(clientSrc),
    'a sent message must refresh the sidebar line locally — the deployed rules may refuse the room ' +
    'preview, which would otherwise freeze it on the server'
);
assert(
    /Object\.keys\(knownRooms\)\.forEach/.test(clientSrc),
    'the fallback must re-check every room this device has seen — with the query denied, a conversation ' +
    'whose other side left the directory and the roster would otherwise disappear with its history'
);
assert(
    /function loadKnownRooms\(\)/.test(clientSrc) && /loadKnownRooms\(\);/.test(clientSrc),
    'remembered rooms are per account, so they must be (re)loaded when init() resolves the signed-in user'
);
assert(
    /KNOWN_ROOMS_MAX = 200/.test(clientSrc) && /forgetRoom\(roomId\);/.test(clientSrc),
    'the remembered list must be capped and must drop a room that can never be found again, or it would ' +
    'grow without bound and keep re-reading rooms that are permanently gone'
);
assert(
    /if \(peopleSettled && peer && startableEmails\(\)\.indexOf\(peer\) === -1\)/.test(clientSrc),
    'a room is only forgotten once the people sources have settled (peopleSettled) AND its peer is in ' +
    'neither source — forgetting on an early refusal would lose a real conversation'
);
assert(
    /conversationRoomsDenied\[roomId\] = true;/.test(clientSrc) &&
    /forgetRoom\(roomId\);[\s\S]{0,120}?\} else \{/.test(clientSrc),
    'a forgotten room must also leave the RETRY set, or it would be re-read every minute for the rest ' +
    'of the session — which is the leak the forget rule exists to prevent'
);

// ---------------------------------------------------------------
// 12. THE ROOM READ RULE MUST ALSO BE PROVABLE FOR THE LIST QUERY.
//
//     chat.js lists conversations with `chats where members array-contains
//     <me>`. A query is authorised as ONE rules evaluation over the whole
//     collection, so a rule that resolves every room with exists()/get()
//     cannot be proven for it and the entire query is denied — which empties
//     the sidebar AND stops every conversation from opening its history
//     (selectConversation() only subscribes to a room the list knows about).
//
//     So the read rule restates the SAME membership test through `resource`,
//     which Firestore can prove from the query's own filter. It must stay
//     exactly that: role-gated, membership-scoped, and never a blanket read.
// ---------------------------------------------------------------
assert(
    /allow read: if canReadChat\(chatId\)[\s\S]{0,200}?\|\| \(isChatRole\(\) && 'members' in resource\.data[\s\S]{0,200}?selfEmail\(\) in resource\.data\.members\)/.test(block),
    "the room read rule must restate membership through resource.data ('members' in resource.data " +
    "&& selfEmail() in resource.data.members), or the conversation-list query is denied while every " +
    'room document is individually readable. It must gate on isChatRole() so the list query is also ' +
    'provable for an Area Manager — with the narrower isHrOrSuperAdmin() they could open a single ' +
    'thread but never find their conversations'
);
assert(
    /'members' in resource\.data/.test(block),
    "the restated clause must be guarded by 'members' in resource.data — a room with no member list " +
    '(the legacy archive) would otherwise raise an error inside the rules engine, which evaluates the ' +
    'whole rule to DENIED'
);
assert(
    /allow read: if canReadChat\(chatId\)\s*\|\|/.test(block),
    'the get()-based membership check must STAY: the query clause is an addition, not a replacement, and a ' +
    'direct read of a room is still authorised by the same test'
);
assert(
    /allow read: if (true|isSignedIn\(\)|isHrOrSuperAdmin\(\)|isSuperAdmin\(\))\s*;/.test(roomRead) === false,
    'the ROOM read must never be role-only or unconditional — that would expose every HR\'s private thread ' +
    'to every other HR. (The profiles subcollection IS role-readable on purpose: it is the people ' +
    'directory, asserted separately in 7f, and it carries presentation data only.)'
);
assert(
    /where\('members', 'array-contains', currentUserEmail\)/.test(clientSrc) &&
    /isChatMember\(chatId\)|canReadChat\(chatId\)/.test(block),
    'the client query and the membership-scoped rules must both stay: the `array-contains` filter is what ' +
    'authorises the query, and the rules are what authorise every subcollection read inside a room'
);

// ---------------------------------------------------------------
// 13. THE MESSAGE WRITE MUST SURVIVE A DEPLOYED RULE THAT IS OLDER
//     THAN THIS CLIENT, AND MUST NEVER LOCK THE USER OUT.
//
//     The room write can succeed while the MESSAGE write is refused — a room
//     and a message in one atomic batch fail TOGETHER, so one passing and one
//     failing means the refusal is specific to the message document. In the
//     field that is almost always a deployed `hasOnly()` allowlist from before
//     `mentions`/`replyTo` existed, or an address compared in the wrong case.
// ---------------------------------------------------------------
assert(
    /const nextEmail = String\(user\.email\)\.toLowerCase\(\);/.test(clientSrc) &&
    /senderEmail: (me|currentUserEmail),/.test(clientSrc),
    'the message payload must carry the address the module already stores LOWERCASED (init() does ' +
    '`String(user.email).toLowerCase()`), because the create rule compares it against ' +
    '`request.auth.token.email.lower()` — the two must be in the same case'
);
const payloadFn = (clientSrc.match(/function writeMessageBatch\(text, me, roomSummary, minimal, withPreview\)\s*\{[\s\S]*?\r?\n    \}/) || [''])[0];
assert(payloadFn, 'chat.js must define writeMessageBatch() — the message + room-preview batch');
['text', 'senderEmail', 'senderName', 'senderRole', 'sentAt'].forEach((key) => {
    assert(
        new RegExp(key + ':').test(payloadFn),
        `the message payload must always include \`${key}\` — it is one of the five fields this app has ` +
        'always documented, so it is what an OLD deployed allowlist will accept'
    );
});
assert(
    /if \(!minimal\)\s*\{[\s\S]*?payload\.mentions = extractMentions\(text\);[\s\S]*?payload\.replyTo = replyingToId \|\| null;/.test(payloadFn),
    'the fields that did NOT exist in the old schema (mentions, replyTo) must be the ONLY ones the short ' +
    'payload drops — a field the rules have never heard of is a refused write'
);
assert(
    /stage === 'message' && isPermissionError\(error\)[\s\S]{0,80}?\) \{[\s\S]{0,1200}?if \(!messageWritesMinimal\)[\s\S]{0,1200}?if \(!groupRoom && roomPreviewInBatch\)[\s\S]{0,1200}?for \(const step of ladder\)[\s\S]{0,900}?writeMessageBatch\(text, me, roomSummary, step\.minimal, step\.preview\)/.test(clientSrc),
    'a message refused for permissions must be retried in THREE shapes — the short payload, and then the ' +
    'message with NO room preview in the batch — or a deployed rule that refuses the room update (while ' +
    'accepting the room create) keeps every message from being saved'
);
assert(
    /roomPreviewInBatch = false;/.test(clientSrc) &&
    /if \(!roomPreviewInBatch && !isGroupRoom\(\)\) writeRoomPreviewQuietly\(roomSummary\);/.test(clientSrc),
    'once the room preview is known to be refused inside a batch it must stay OUT of the batch, and the ' +
    'preview must still be attempted on its own (except in the group chat, whose row is pinned and needs ' +
    'none) — otherwise the sidebar would freeze forever'
);
assert(
    /function writeRoomPreviewQuietly\(roomSummary\)/.test(clientSrc) &&
    /done\.catch\(function \(\) \{ \/\* the thread is fine without it \*\/ \}\)/.test(clientSrc),
    'the standalone preview write must swallow its own failure: the message is already saved, and a stale ' +
    'sidebar line is not worth an error dialog'
);
assert(
    /messageWritesMinimal = true;/.test(clientSrc),
    'once the short payload is known to work, later messages must use it straight away instead of failing ' +
    'and retrying on every single send'
);
// NOTE: js/chat.js has CRLF line endings, so every `\n` in a multi-line
// pattern has to tolerate a preceding `\r`.
const sendFn = (clientSrc.match(/async function sendMessage\(\)\s*\{[\s\S]*?\r?\n    \}\r?\n/) || [''])[0];
const sendCatch = (sendFn.match(/\} catch \(error\) \{[\s\S]*?\r?\n\s{8}\} finally \{/) || [''])[0];
assert(sendCatch, 'could not read the catch block of sendMessage()');
assert(
    /disableChatWithReason/.test(sendCatch) === false,
    'a failed SEND must never grey the chat out: one refused write would lock the user out of reading ' +
    'their own history, with nothing they can do about it'
);
// The discovery is a cost, so it must be paid ONCE: remembered per account, so
// a reload does not re-run two refused writes and the same console warning.
assert(
    /function saveSendShape\(\)/.test(clientSrc) && /function loadSendShape\(\)/.test(clientSrc) &&
    /saveSendShape\(\);/.test(sendCatch),
    'the write shape the deployed rules accept must be REMEMBERED per account — otherwise every page ' +
    'load pays two refused writes and another console warning to rediscover it'
);
// ...and because the room-summary write is refused, the server-side `lastMessage`
// is frozen: the sidebar line has to come from the message stream instead.
assert(
    /function syncSummaryFromMessage\(roomId, msg\)/.test(clientSrc) &&
    /if \(current && Number\(current\.lastMessageAtMs \|\| 0\) >= at\) return;/.test(clientSrc),
    'the sidebar line must be derived from the newest message the device has seen, and an OLDER message ' +
    'must never overwrite a newer line — the deployed rules freeze the server-side room summary'
);
assert(
    /syncSummaryFromMessage\(activeRoomId, newest\);/.test(clientSrc) &&
    /syncSummaryFromMessage\(activeRoomId, \{[\s\S]{0,40}?text: text,/.test(clientSrc),
    'both directions must repaint the row: an incoming message (the message stream) and one just sent'
);

// ---------------------------------------------------------------
// 14. THE ALL HR GROUP CHAT.
//
//     `chats/owner-superadmin` is gated on the ROLE (`isLegacyArchive` =
//     `isHrOrSuperAdmin() && chatId == 'owner-superadmin'`), NOT on a members
//     array. That is what makes "a group chat that new accounts join
//     automatically" possible at all: a membership list can only ever hold the
//     people present when it was created, and the deployed rules refuse a room
//     UPDATE, so nobody could ever be added afterwards.
// ---------------------------------------------------------------
assert(
    /var GROUP_ROOM_NAME = 'All HR — group chat';/.test(clientSrc) &&
    /function isGroupRoom\(roomId\)/.test(clientSrc),
    'the group chat must be named for what it is, and isGroupRoom() must be the ONE place that ' +
    'recognises it — a feature scattered over `activeRoomId === LEGACY_ROOM_ID` checks drifts'
);
assert(
    /if \(inGroupRoom\(\)\) \{[\s\S]{0,400}?const group = conversationSummaries\[LEGACY_ROOM_ID\];[\s\S]{0,400}?rows\.push\(\{[\s\S]{0,400}?name: GROUP_ROOM_NAME/.test(clientSrc),
    'the group row must be pushed straight after reading the (possibly absent) summary, with NO ' +
    'dependency on one: a new account is in the conversation before any summary has arrived, so ' +
    'the row cannot wait for it. It must sit INSIDE the inGroupRoom() guard, though — an Area ' +
    'Manager is a chat participant but the rules deny them this room, so showing the row would be ' +
    'a guaranteed permission-denied the moment they clicked it'
);
assert(
    /function inGroupRoom\(\)\s*\{\s*return GROUP_ROOM_ROLES\.indexOf\(normalizeRole\(currentRole\)\) !== -1;/.test(clientSrc),
    'inGroupRoom() must be the ONE place that decides group membership, mirroring isLegacyArchive() ' +
    'in firestore.rules. Scattering `currentRole === "hr" || currentRole === "superadmin"` checks is ' +
    'how an Area Manager ends up in the All HR chat in one place but not another'
);
assert(
    /if \(isGroupRoom\(\)\) \{[\s\S]{0,1200}?setComposerEnabled\(true\);/.test(clientSrc),
    'the group chat must have a WORKING composer — it is a live channel, not an archive'
);
assert(
    /!activePeerEmail && !isGroupRoom\(\)/.test(clientSrc),
    'only the group chat may be opened with no peer: every other conversation is with one person'
);
assert(
    /function writeReceipt\(\)[\s\S]{0,700}?if \(isGroupRoom\(\)\) return;/.test(clientSrc),
    'read receipts REMAIN skipped in the group chat: they are still a per-room membership write the ' +
    'rules refuse, and grey ticks beat a permanent console warning'
);
assert(
    /function publishPresence\(\)/.test(clientSrc) &&
    !/function publishPresence\(\)[\s\S]{0,700}?if \(isGroupRoom\(\)\) return;/.test(clientSrc),
    '⚠️ typing presence must NO LONGER be skipped in the group chat. canPublishPresence() now allows ' +
    'it there on the role, so the client-side opt-out would keep typing indicators silently missing ' +
    'for everyone in the All HR group — the exact regression this assertion now guards'
);
assert(
    /function startTypingListener\(\)[\s\S]{0,400}?if \(isGroupRoom\(\)\)/.test(clientSrc) === false,
    'the group room must SUBSCRIBE to presence like every other thread, or an indicator raised there ' +
    'would never be seen'
);
assert(
    /function startTypingListener\(\)[\s\S]{0,700}?if \(isGroupRoom\(\)\) \{[\s\S]{0,200}?els\.typingBar\.hidden = true;/.test(clientSrc) === false,
    '⚠️ the typing bar must NO LONGER be force-hidden in the group chat. Presence is now published ' +
    'there on the role (canPublishPresence), so hiding it would keep typing invisible for every ' +
    'member of the All HR group — the regression this now guards'
);
// The NAME in "X is typing…" has to be resolved the way every other name in
// the chat is resolved: the published directory/roster name first. It used to
// prefer `entry.name`, which publishPresence() wrote as the email's LOCAL
// PART, so a person whose row and messages said "Jiangnan Hotpot" was
// announced as "hotpotjiangnan is typing…" — one thread, two names for one
// person. Both halves (the write and the label) are guarded.
assert(
    /function publishPresence\(\)[\s\S]*?name:\s*nameFor\(currentUserEmail\)/.test(clientSrc),
    'publishPresence() must publish the DIRECTORY name, not the email local part'
);
// ⚠️ It used to also require `if (isGroupRoom()) return;` inside
// publishPresence(), because the group room could not publish presence at all.
// That is no longer true — canPublishPresence() allows it on the role — and
// keeping the assertion would have re-pinned the client-side opt-out that made
// typing invisible for the whole group. The replacement assertion is above.
assert(
    /function publishPresence\(\)[\s\S]*?if \(isGroupRoom\(\)\) return;/.test(clientSrc) === false,
    'publishPresence() must not opt out of the group room — that opt-out is what made typing ' +
    'indicators disappear for every member of the All HR group'
);
// ⚠️ THE ROOM-EXISTENCE GUARD MUST ALSO EXEMPT THE GROUP ROOM. publishPresence()
// used to stay silent until `conversationSummaries[activeRoomId]` existed, which
// is right for a 1:1 (the presence create rule resolves membership by READING
// the room) but is PERMANENTLY false for the group: that room has no `members`
// array, so the `where('members','array-contains', me)` list query can never
// return it and no summary is ever produced. On a FRESH Firestore that meant
// typing indicators were silently dead for every member of the All HR group.
// `canPublishPresence()` resolves on the ROLE with no exists() check.
assert(
    /if \(!conversationSummaries\[activeRoomId\] && !isGroupRoom\(\)\) return;/.test(clientSrc),
    'publishPresence() must not require a room summary in the GROUP chat: that room is role-gated ' +
    'with no `members` array, so the summary it waits for can never arrive and typing was dead there'
);
assert(
    /function typingNameFor\(entry\)[\s\S]{0,400}?personProfileFor\(key\)\.displayName/.test(clientSrc) &&
    /\)\.map\(typingNameFor\);/.test(clientSrc),
    'renderTypingIndicator() must resolve the typist through typingNameFor() — the directory name ' +
    'first, so the label matches the row, the header and the messages'
);
assert(
    /function toggleReaction\([\s\S]{0,700}?if \(isGroupRoom\(\)\) \{[\s\S]{0,300}?only available in 1:1/.test(clientSrc),
    'a reaction is a per-room membership write too: it must be refused in the client with a plain ' +
    'explanation, not by letting the rules reject it'
);
assert(
    /roomPreviewInBatch && !isGroupRoom\(\)/.test(clientSrc),
    'the group send must not attempt a room-preview write (the row is pinned and the update would be ' +
    'refused)'
);
// ⚠️ THE MESSAGE-SHAPE RUNG IS NOT 1:1-SPECIFIC. The payload written in the
// group room is the same one a 1:1 send writes, so a deployed `hasOnly()` that
// predates mentions/replyTo refuses a GROUP message exactly as it refuses a 1:1
// one — while the ladder was guarded with `&& !isGroupRoom()`, the first message
// on a fresh browser (which is very often the group one) was the one message in
// the app with no fallback at all. Only the ROOM-PREVIEW rung belongs to 1:1.
assert(
    /if \(stage === 'message' && isPermissionError\(error\)\) \{/.test(clientSrc) &&
    !/isPermissionError\(error\) && !isGroupRoom\(\)/.test(clientSrc) &&
    /const groupRoom = isGroupRoom\(\);/.test(clientSrc) &&
    /preview: !groupRoom && roomPreviewInBatch,/.test(clientSrc),
    'the short-payload retry must run for the GROUP chat too — the payload rung varies the message, ' +
    'and only the room-preview rung (which the group never attempts) is 1:1-specific'
);
// The one thing a group message needs that a 1:1 one does not is its own
// `allow create` clause, and when a group send is refused the console and the
// toast must say THAT instead of leaving a bare "Missing or insufficient
// permissions" to diagnose. (`firebase deploy --only firestore:rules` is the
// fix; `firestore.rules` in this repo already carries the clause — asserted in
// test/chat-rules.test.js §1 above.)
assert(
    /if \(isGroupRoom\(\)\) \{\s*console\.warn\('\[Chat\] The GROUP chat \(chats\/owner-superadmin\) needs its own /.test(clientSrc) &&
    /allow create: if isLegacyArchive\(chatId\) && request\.resource\.data\.senderEmail /.test(clientSrc) &&
    /firebase deploy --only firestore:rules'\);/.test(clientSrc) &&
    /'Fix: run firebase deploy --only firestore:rules\.'/.test(clientSrc),
    'a refused GROUP send must name the missing rules clause and the deploy command, in the console and ' +
    'on screen — the payload is not the difference between the group and a working 1:1 thread'
);
assert(
    /The group chat is empty — send the first message\./.test(clientSrc),
    'a group room that does not exist yet must show an empty thread, NOT grey out the whole chat'
);

// ---------------------------------------------------------------
// 15b. BRANCH GROUP CHATS — auto-created when a member is assigned.
//
//  The feature: a superadmin approves (or re-saves) a member with one or
//  more branches → script.js ensureBranchGroupChats() seeds
//  chats/branch-<slug> with that store's team — Superadmin + the Area
//  Manager, HR and RM/SM assigned to THIS branch — so the group chat is
//  already in the member's sidebar instead of needing manual creation.
//
//  Static checks on firestore.rules + script.js + js/chat.js, plus the
//  REAL branchGroupMembers() executed against fixtures at the bottom.
//  String checks use indexOf on purpose: these blocks live or die by
//  escaping, and a regex literal here silently matches nothing when a
//  backslash goes stale (that is exactly how this section first failed).
// ---------------------------------------------------------------
const approvalSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
function sliceBetween(src, startMarker, endMarker, what) {
    const start = src.indexOf(startMarker);
    assert(start > -1, 'could not locate ' + startMarker + ' for ' + what);
    const end = src.indexOf(endMarker, start + startMarker.length);
    assert(end > -1, 'could not locate ' + endMarker + ' after ' + startMarker + ' for ' + what);
    return src.slice(start, end);
}

// ---- firestore.rules ----

// 1. The room id is the `branch-` prefix; slugging stays client-side.
// ⚠️ matches() is a FULL-STRING match in the rules language, so this MUST
// carry the trailing '.*' — '^branch-' alone matches nothing and denies
// every branch-room read and write (that is exactly what production showed
// before the fix: op=read room AND op=seed room both denied).
assert(
    rules.indexOf("chatId.matches('^branch-.*')") > -1,
    'isBranchRoom() must recognise branch rooms by their `branch-` prefix with a full-string match'
);

// 2. Only a superadmin may WRITE a branch room — create it, and change the
//    `members` list the rules read for membership.
assert(
    rules.indexOf('return isSuperAdmin() && isBranchRoom(chatId);') > -1,
    'canManageBranchRoom() must be exactly (isSuperAdmin && isBranchRoom)'
);
assert(
    block.indexOf('allow create: if canManageBranchRoom(chatId)') > -1,
    'the room `allow create` must be gated by canManageBranchRoom() — that is what ' +
    'lets the approval generate the room and nothing else'
);
const createAt = block.indexOf('allow create: if canManageBranchRoom(chatId)');
const roomCreateStmt = block.slice(createAt, block.indexOf(';', createAt) + 1);
assert(
    roomCreateStmt.indexOf('request.resource.data.keys().hasOnly(') > -1,
    'the create rule must keep its hasOnly() field allowlist — the branch clause is an OR, ' +
    'and it must not widen what a 1:1 room may write'
);
assert(
    roomCreateStmt.indexOf('request.resource.data.members.size() == 2') > -1,
    'a 1:1 room must still require exactly 2 members'
);
const updateAt = block.indexOf('allow update: if canManageBranchRoom(chatId)');
assert(updateAt > -1, 'the branch-room `allow update` must be gated by canManageBranchRoom()');
const branchUpdateStmt = block.slice(updateAt, block.indexOf(';', updateAt) + 1);
assert(
    branchUpdateStmt.indexOf("'members'") > -1,
    'the branch-room update must allow changing `members` — that is how a re-approval ' +
    'reseeds the team; the 1:1 update rule must keep it frozen'
);

// 3. ⚠️ SECURITY: reading a branch room is membership OR superadmin, never
//    blanket. The clause used to be a bare `|| isBranchRoom(chatId)` with no
//    isSignedIn() anywhere in it — any caller, logged out included, could read
//    chats/branch-*/messages. Members pass through isChatMember() (the
//    approval seeds `members`), so the branch clause only has to cover
//    superadmin management. This fails if the blanket form ever returns.
const canReadAt = rules.indexOf('function canReadChat(chatId)');
assert(canReadAt > -1, 'canReadChat() helper is missing from firestore.rules');
const readFn = rules.slice(canReadAt, rules.indexOf('\n    }', canReadAt));
assert(
    readFn.indexOf('isChatMember(chatId)') > -1 && readFn.indexOf('isLegacyArchive(chatId)') > -1,
    'canReadChat() must keep its membership and legacy-archive halves'
);
assert(
    readFn.indexOf('isSuperAdmin() && isBranchRoom(chatId)') > -1,
    'a branch-room read must be superadmin-gated — members are covered by isChatMember()'
);
assert(
    readFn.indexOf('|| isBranchRoom(chatId)') === -1,
    'canReadChat() must NEVER blanket-grant branch rooms: that handed chats/branch-* to ' +
    'every caller, including logged-out ones'
);

// ---- script.js: the approval hook ----
assert(
    approvalSrc.indexOf('async function ensureBranchGroupChats(') > -1,
    'script.js must define ensureBranchGroupChats()'
);
const approveFn = sliceBetween(approvalSrc, 'async function approveUser(', 'async function ensureBranchGroupChats(', 'approveUser');
assert(
    approveFn.indexOf('ensureBranchGroupChats(') > -1,
    'approveUser() must auto-create the branch group chats — approving a member for a store ' +
    'must leave that store group already in the chat'
);
{
    const at = approveFn.indexOf('catch (error)');
    assert(
        at > -1 && approveFn.indexOf('return;', at) > -1,
        'approveUser() must bail on approval failure so the chat seed never runs for a failed approval'
    );
}
const ensureFn = sliceBetween(approvalSrc, 'async function ensureBranchGroupChats(', 'async function updateUserPermissions(', 'ensureBranchGroupChats');
assert(
    ensureFn.indexOf('chat.branchKey(branch)') > -1,
    'the room id must come from ChatService.branchKey — one slug rule for client, rules and approval'
);
assert(
    ensureFn.indexOf('chat.branchGroupMembers(') > -1,
    'membership must come from ChatService.branchGroupMembers — ONE tested implementation, ' +
    'not a second copy in the approval path'
);
assert(
    ensureFn.indexOf('merge: true') > -1,
    'the room write must be merge:true — re-running an approval can only converge, ' +
    'never duplicate a room or clobber its message preview'
);
assert(
    ensureFn.indexOf('existing.data()') > -1 && ensureFn.indexOf('continue') > -1,
    'an existing room whose members already match must be SKIPPED (duplicate-skip), not rewritten'
);
assert(
    ensureFn.indexOf('title: String(branch)') > -1,
    "the room's `title` must be the bare branch name — that is the store name the user sees"
);
assert(
    ensureFn.indexOf('members: members') > -1,
    'the computed team must be written into `members` — that array is what the rules read'
);
assert(
    ensureFn.indexOf('noteBranchRoom') > -1,
    "a seeded room must be noted locally (ChatService.noteBranchRoom) so it appears in the " +
    "approver's sidebar immediately, denied list query or not"
);
const saveFn = sliceBetween(approvalSrc, 'async function updateUserPermissions(', 'async function rejectUser(', 'updateUserPermissions');
assert(
    saveFn.indexOf('ensureBranchGroupChats(') > -1,
    'saving permissions must seed too — ticking another branch onto an existing account is ' +
    'the same assignment flow'
);

// ---- the REMOVAL path: unticking a branch must PRUNE the person from the room ----
//  The sidebar is `chats where members array-contains me`, so as long as a
//  removed account is still in a room's `members`, hard-refreshing their
//  dashboard keeps returning that store chat — which is exactly the bug users
//  hit. The save must diff the branches the account HELD (read BEFORE the
//  update overwrites them) against the ones it KEPT, and reseed the removed
//  rooms from the FRESH roster with approvedEmail = null: the roster alone
//  then decides membership, and the person drops out of `members`. Passing
//  their email would re-ADD them, which is why it must be null.
assert(
    saveFn.indexOf('let prevBranches = [];') > -1,
    'updateUserPermissions() must read the branches the account HOLDS before the update overwrites ' +
    'them — without the prior value there is no diff, so a removed branch room is never reseeded ' +
    'and the store chat stays in their sidebar for ever'
);
assert(
    saveFn.indexOf('ensureBranchGroupChats(null, removedBranches)') > -1,
    'the removed branches must go back through ensureBranchGroupChats(null, ...) — null approvedEmail ' +
    'so the FRESH roster (which no longer lists this account there) decides membership and drops them ' +
    'from `members`; the list query is `members array-contains me`, so THAT array is the access list'
);
assert(
    ensureFn.indexOf('!roomExists && members.length < 2') > -1,
    'the < 2 guard must block only CREATING a near-empty room — an EXISTING room whose team shrank ' +
    '(the last assigned member was unticked, only superadmins remain) must still be reseeded, or the ' +
    'removed account stays in `members` for ever despite the removal path above'
);
{
    const deleteFn = sliceBetween(approvalSrc, 'async function deleteUser(', 'const DEFAULT_BRANCH_NAMES', 'deleteUser');
    assert(
        deleteFn.indexOf('ensureBranchGroupChats(null, prevBranches)') > -1,
        'deleting an account must also reseed every room it was assigned to — a deleted account left ' +
        'in `members` still occupies the store chat after every refresh'
    );
}

// ---- script.js: dashboard-load auto-backfill (the UNION of all branch access) ----
//  Existing accounts predate the approve/save hooks: without this sweep their
//  store group chat would only appear if someone re-saved the account. A
//  superadmin's dashboard load seeds EVERY distinct branch found in ANY
//  approved account's `branches` — same seeder, one users read, no-op when
//  converged.
assert(
    approvalSrc.indexOf('async function backfillBranchGroupChats(') > -1,
    'script.js must define backfillBranchGroupChats() — existing users need their branch ' +
    'rooms without anyone re-saving them'
);
{
    const backfillFn = sliceBetween(
        approvalSrc,
        'async function backfillBranchGroupChats(',
        'async function updateUserPermissions(',
        'backfillBranchGroupChats'
    );
    assert(
        backfillFn.indexOf('currentUserIsSuperAdmin()') > -1,
        'the backfill must be superadmin-only — an operator session must never write rooms'
    );
    assert(
        backfillFn.indexOf('ensureBranchGroupChats(null, [branch], allUsers)') > -1,
        'the backfill must seed through the SAME ensureBranchGroupChats path with the shared ' +
        'users snapshot — a second seeder would drift from the approval flow'
    );
    assert(
        backfillFn.indexOf('u.branches') > -1
            && backfillFn.indexOf('branches.push(') > -1
            && backfillFn.indexOf('seen[key]') > -1,
        'the backfill must sweep the union of branches across ALL approved accounts, deduped — ' +
        'one chats/branch-<slug> room per distinct branch'
    );
}
assert(
    approvalSrc.indexOf('backfillBranchGroupChats().catch') > -1,
    'the auth callback must fire-and-forget the backfill with a catch — chat bookkeeping ' +
    'must never delay or break dashboard load'
);
assert(
    approvalSrc.indexOf("currentUserRole === 'superadmin' && !branchBackfillAttempted") > -1,
    'the backfill must run once per page load, behind a superadmin check'
);

// ---- js/chat.js: visibility, display, membership helper ----
assert(
    clientSrc.indexOf('function branchGroupMembers(') > -1,
    'chat.js must define branchGroupMembers(branch, users, approvedEmail)'
);
assert(
    /branchGroupMembers:\s*branchGroupMembers/.test(clientSrc),
    'branchGroupMembers must be exported on ChatService — the approval path and this test ' +
    'both go through it'
);
assert(
    /branchKey:\s*branchKey/.test(clientSrc),
    'branchKey must be exported on ChatService so the approval uses the SAME slug rule'
);
assert(
    clientSrc.indexOf('group && group.title') > -1,
    'the sidebar row must name a branch room from its seeded `title` (the store name), ' +
    'falling back to branchGroupName()'
);

const headerSlice = sliceBetween(clientSrc, 'function applyActiveRoomToHeader()', 'function setComposerEnabled(', 'applyActiveRoomToHeader');
assert(
    headerSlice.indexOf('branchSummary.title') > -1,
    'the open header must show the seeded branch title, not the raw room id'
);
const listSlice = sliceBetween(clientSrc, 'function startConversationListListener()', 'function stopConversationListListener()', 'startConversationListListener');
assert(
    listSlice.indexOf('next[roomId].title') > -1 && listSlice.indexOf('next[roomId].members') > -1,
    'the list-query path must carry `title`/`members` into branch summaries — it REPLACES the ' +
    'whole map, so without this the row name and @mentions break the moment the query answers'
);
const fallbackSlice = sliceBetween(clientSrc, 'function applyRoomSummaryToList(', 'function subscribeRoomForList(', 'applyRoomSummaryToList');
assert(
    fallbackSlice.indexOf('summary.title = data.title') > -1 && fallbackSlice.indexOf('summary.members = data.members') > -1,
    'the per-room fallback path must carry `title`/`members` too'
);
const syncSlice = sliceBetween(clientSrc, 'function syncSummaryFromMessage(', 'function everyoneKnownForGroup(', 'syncSummaryFromMessage');
assert(
    syncSlice.indexOf('summary.members = current.members') > -1,
    'sending a message rebuilds the summary object — it must carry `title`/`members` forward or ' +
    'the first message in a branch room would rename the row and empty the @mention picker'
);
const styleLine = clientSrc.split('\n').find(function (l) {
    return l.indexOf('GROUP_STYLE_ROOM_ROLES =') !== -1;
}) || '';
assert(
    styleLine.indexOf("'owner'") !== -1 && styleLine.indexOf("'rmsm'") !== -1,
    'GROUP_STYLE_ROOM_ROLES must include owner + rmsm — the store team is Superadmin + Area ' +
    'Manager + HR + the assigned RM/SM; a member who cannot even see the row is not in the group'
);
assert(
    clientSrc.indexOf('ChatService.noteBranchRoom =') > -1,
    'chat.js must expose noteBranchRoom() so a just-seeded room shows up live'
);
assert(
    clientSrc.indexOf('if (activeRoomId === LEGACY_ROOM_ID && groupMentionRoster)') > -1,
    'mentionCandidates() must fold the superadmin group roster into the All HR picker — otherwise a ' +
    'superadmin (often the only poster) can mention nobody in the group'
);
assert(
    clientSrc.indexOf('if (roomId === LEGACY_ROOM_ID) loadGroupMentionRoster();') > -1,
    'selectConversation() must trigger loadGroupMentionRoster() when the All HR group opens'
);
assert(
    /normalizeRole\(currentRole\) !== 'superadmin'/.test(clientSrc),
    'loadGroupMentionRoster() must be superadmin-gated — an HR member cannot read the users collection, ' +
    'so they must keep the thread-sender roster'
);

// ---- FUNCTIONAL: the REAL seeder against fixtures ----
//  Presence checks cannot catch seeding the WRONG people — this runs the
//  actual branchGroupMembers() out of js/chat.js against a fixture roster.
{
    function extractFnSrc(name) {
        const m = clientSrc.match(new RegExp('function\\s+' + name + '\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\s{4}\\}'));
        assert(m, 'could not extract function ' + name + ' from js/chat.js');
        return m[0];
    }
    const rolesMatch = clientSrc.match(/CHAT_ALLOWED_ROLES\s*=\s*\[([^\]]+)\]/);
    assert(rolesMatch, 'CHAT_ALLOWED_ROLES not found for the branchGroupMembers harness');
    const harness = new Function(
        'var CHAT_ALLOWED_ROLES = [' + rolesMatch[1] + '];\n'
        + extractFnSrc('normalizeRole') + '\n'
        + extractFnSrc('branchHasStoreTeam') + '\n'
        + extractFnSrc('branchGroupMembers') + '\n'
        + 'return { branchGroupMembers: branchGroupMembers, branchHasStoreTeam: branchHasStoreTeam };'
    );
    const seeded = harness();
    const branchGroupMembers = seeded.branchGroupMembers;
    const branchHasStoreTeam = seeded.branchHasStoreTeam;

    const users = [
        { email: 'sa@x.com', role: 'superadmin', status: 'approved', branches: [] },
        { email: 'am@x.com', role: 'owner', status: 'approved', branches: ['SM Fairview'] },
        { email: 'hr@x.com', role: 'hr', status: 'approved', branches: ['SM Fairview'] },
        { email: 'rm1@x.com', role: 'rmsm', status: 'approved', branches: ['SM Fairview'] },
        { email: 'rm2@x.com', role: 'rmsm', status: 'approved', branches: ['Banawe'] },
        { email: 'new@x.com', role: 'owner', status: 'pending', branches: ['SM Fairview'] },
        { email: 'rej@x.com', role: 'hr', status: 'rejected', branches: ['SM Fairview'] },
        { email: 'op@x.com', role: 'operator', status: 'approved', branches: ['SM Fairview'] }
    ];

    const team = branchGroupMembers('SM Fairview', users, 'fresh@x.com');
    assert.deepStrictEqual(
        team,
        ['am@x.com', 'fresh@x.com', 'hr@x.com', 'rm1@x.com', 'sa@x.com'].sort(),
        'the store team must be exactly: the approved person + superadmins + the owner/HR/rmsm ' +
        'ASSIGNED TO THIS BRANCH — no one else'
    );
    assert(
        team.indexOf('rm2@x.com') === -1,
        'an RM/SM assigned to ANOTHER branch must not leak into this store group'
    );
    assert(
        team.indexOf('new@x.com') === -1 && team.indexOf('rej@x.com') === -1 && team.indexOf('op@x.com') === -1,
        'pending, rejected and operator accounts must never be seeded into a branch room'
    );
    assert.deepStrictEqual(
        branchGroupMembers('SM Fairview', users, 'fresh@x.com'),
        team,
        'identical inputs must always produce the identical team (re-approvals are idempotent)'
    );
    assert.deepStrictEqual(
        branchGroupMembers('  sm FAIRview  ', users, 'fresh@x.com'),
        team,
        'branch comparison must trim + ignore case, like every other branch check in the app'
    );
    const noSa = branchGroupMembers('Banawe', users.filter(function (u) { return u.role !== 'superadmin'; }));
    assert.deepStrictEqual(
        noSa,
        ['hr@x.com', 'rm2@x.com'],
        'without any superadmin, the branch-assigned RM/SM AND the company-wide HR still seed — ' +
        "HR is in EVERY branch room by the spec, even one they hold no assignment for (hr@x.com's " +
        "branches are ['SM Fairview'])"
    );
    assert.deepStrictEqual(
        branchGroupMembers('Nowhere', users),
        [],
        'a branch with NO approved Area Manager / RM / SM assigned yields NO room ' +
        '(Super Admin and HR are NOT auto-seeded into empty branches — the chat ' +
        'appears only once a store user is assigned)'
    );
    assert.deepStrictEqual(
        branchGroupMembers('Nowhere', users, 'ex-am@x.com'),
        [],
        "a saved/approved account's OWN access must never seed or keep a TEAMLESS room — " +
        're-saving an Area Manager as HR for a store whose team has gone must drop them ' +
        'from `members` (the "Banawe/Sucat never leave the chat list" bug)'
    );

    // branchHasStoreTeam is the single source of truth the phantom-cleanup
    // delete keys off - HR/superadmin alone must NOT count as a store team.
    assert.strictEqual(branchHasStoreTeam('SM Fairview', users), true,
        'a branch with an approved owner/rmsm HAS a store team');
    assert.strictEqual(branchHasStoreTeam('Banawe', users), true,
        'Banawe has an approved rmsm (rm2) assigned');
    assert.strictEqual(branchHasStoreTeam('Nowhere', users), false,
        'a branch nobody is assigned to has NO store team');
    assert.strictEqual(
        branchHasStoreTeam('SM Fairview', users.filter(function (u) { return u.role !== 'owner' && u.role !== 'rmsm'; })),
        false,
        'HR + superadmin alone do NOT make a store team - that is the phantom-room rule'
    );
}

// ---- PHANTOM CLEANUP: a branch with no store team is DELETED, not left empty ----
{
    const ensureFn = sliceBetween(approvalSrc, 'async function ensureBranchGroupChats(', 'async function backfillBranchGroupChats(', 'ensureBranchGroupChats');
    assert(
        ensureFn.indexOf('chat.branchHasStoreTeam(branch, allUsers)') > -1,
        'ensureBranchGroupChats() must consult branchHasStoreTeam() to decide whether the room should exist'
    );
    assert(
        /roomExists\s*&&\s*chat\.branchHasStoreTeam[\s\S]{0,300}?roomRef\.delete\(\)/.test(ensureFn),
        'a branch with no store team must DELETE the room on EVERY path — approve/save ' +
        '(approvedEmail set) included — or re-saving an Area Manager as HR leaves a ' +
        '1-member ghost that never leaves that person\'s chat list'
    );
    assert(
        !/!approvedEmail\s*&&\s*roomExists/.test(ensureFn),
        'the phantom delete must NOT be gated to roster-only paths (approvedEmail null) — ' +
        'every call path reads the roster fresh, after the account write'
    );
    assert(
        ensureFn.indexOf('chat.forgetBranchRoom') > -1,
        'the delete must also forget the room on this device so it leaves the sidebar immediately'
    );
    assert(
        rules.indexOf('allow delete: if isSuperAdmin();') > -1,
        'the room delete leans on the EXISTING superadmin delete rule in firestore.rules (no rules change needed)'
    );
}

// ---- FUNCTIONAL + GUARD: the send path must NEVER write everyoneKnownForGroup
//      into a `branch-` room (the polluted-members / cross-branch-leak fix) ----
//  `members` is BOTH the @mention roster AND the authority the room READ rule
//  checks (`selfEmail() in resource.data.members`). An older client wrote
//  everyoneKnownForGroup() — EVERY account this device knows — into group rooms,
//  and isGroupRoom() is true for branch rooms too, so a store chat's `members`
//  got polluted with every user: the picker offered everyone AND the thread
//  leaked to other branches. The fix is that EVERY room-summary write in
//  sendMessage() is guarded with `!isGroupRoom()`. This proves both halves:
//  (a) isGroupRoom() really does treat a branch room as a group room, and
//  (b) each room-summary write site carries the guard, so the polluted array
//  can never reach a branch room's document.
{
    function extractFnSrc(name) {
        const m = clientSrc.match(new RegExp('function\\s+' + name + '\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\s{4}\\}'));
        assert(m, 'could not extract function ' + name + ' from js/chat.js');
        return m[0];
    }
    // (a) FUNCTIONAL: isGroupRoom() must treat a `branch-` room as a group room.
    const isGroupRoomFn = new Function(
        'var LEGACY_ROOM_ID = "owner-superadmin";\n'
        + extractFnSrc('isGroupRoom') + '\n'
        + 'return isGroupRoom;'
    )();
    assert.strictEqual(
        isGroupRoomFn('branch-sm-fairview'), true,
        'isGroupRoom() must treat a branch room as a group room — that is what keeps ' +
        'everyoneKnownForGroup() out of its `members` (the polluted-array / cross-branch-leak bug)'
    );
    assert.strictEqual(
        isGroupRoomFn('dm_abc__def'), false,
        'isGroupRoom() must NOT treat a 1:1 room as a group room, or a DM could never record its ' +
        'two participants'
    );
    assert.strictEqual(
        isGroupRoomFn('owner-superadmin'), true,
        'the legacy All-HR room is still a group room'
    );

    // (b) GUARD: the room payload carries everyoneKnownForGroup() ONLY under
    //     isGroupRoom(), and EVERY write of that payload is gated on
    //     !isGroupRoom()/!groupRoom — so a branch room can never be handed the
    //     array. (The individual write-site guards are also asserted above; this
    //     is the single statement naming what they collectively prevent.)
    assert(
        /members:\s*isGroupRoom\(\)\s*\?\s*everyoneKnownForGroup\(\)\s*:\s*\[me,\s*them\],/.test(clientSrc),
        'the room payload must build `members` from everyoneKnownForGroup() only when isGroupRoom()'
    );
    assert(
        /if\s*\(!roomIsStarted\s*&&\s*!isGroupRoom\(\)\)\s*\{[\s\S]{0,240}?await roomRef\(\)\.set\(roomSummary/.test(clientSrc)
        && /roomPreviewInBatch\s*&&\s*!isGroupRoom\(\)/.test(clientSrc)
        && /if\s*\(!roomPreviewInBatch\s*&&\s*!isGroupRoom\(\)\)\s*writeRoomPreviewQuietly\(roomSummary\);/.test(clientSrc)
        && /preview:\s*!groupRoom\s*&&\s*roomPreviewInBatch,/.test(clientSrc),
        'every room-summary write in sendMessage (standalone create, both batch preview sites, the ' +
        'best-effort preview, and the retry ladder) must be gated on !isGroupRoom()/!groupRoom, so the ' +
        'everyoneKnownForGroup() array can never be written into a branch room'
    );
}

console.log('  \u2713 Branch group chat tests passed (approval hook, seeded membership, rules).');

// ---------------------------------------------------------------
// 15. THE MODAL MUST NOT RESIZE ITSELF (chat.css).
//
//     With only a `max-height`, the modal was CONTENT-DRIVEN: it grew and
//     shrank as messages loaded, as the typing bar came and went, and as the
//     reply banner opened — the window visibly "breathed" and the thread
//     jumped under the cursor. A fixed height plus panes that scroll
//     internally is the fix, and both halves of it can silently regress.
// ---------------------------------------------------------------
const cssRaw = fs.readFileSync(path.join(ROOT, 'chat.css'), 'utf8');
// Comments are stripped before any assertion: they EXPLAIN the rules (and
// quote the old broken values), so matching against them would make a guard
// pass or fail on prose instead of on behaviour.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
/** The declaration block of a top-level selector (brace-balanced). */
function cssBlock(selector) {
    const at = css.indexOf(selector);
    assert(at > -1, 'chat.css has no ' + selector);
    const open = css.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') {
            depth--;
            if (depth === 0) return css.slice(open + 1, i);
        }
    }
    throw new Error('unbalanced braces in ' + selector);
}
const modalBlock = cssBlock('.chat-modal-container {');
assert(
    /height:\s*min\(720px,\s*82vh\);/.test(modalBlock),
    'the chat modal must have a FIXED height, not only a max-height — otherwise its size follows ' +
    'the content and the window resizes as messages load and the typing bar appears'
);
assert(
    /max-height:\s*82vh;/.test(modalBlock) && /overflow:\s*hidden;/.test(modalBlock),
    'the fixed height must still be capped for short windows, and the container must clip so the ' +
    'panes scroll internally instead of stretching it'
);
assert(
    /min-height:\s*0;/.test(cssBlock('.chat-modal-body {')),
    '.chat-modal-body must have min-height: 0 — a floor would beat the fixed height on a short ' +
    'window and push the modal off-screen'
);
// ⚠️ THE HIDDEN TYPING BAR MUST TAKE NO SPACE.
//
// It used to RESERVE its row (`display: flex; visibility: hidden`) because,
// back when the modal was content-driven, `display: none` made the bar
// appearing and vanishing resize the composer and shift the thread. That
// reason is gone: the modal now has a FIXED height and the panes scroll
// internally, so nothing can resize. The reservation survived as a permanent
// dead band above the composer — `.chat-thread` is `flex: 1 1 auto`, so the
// reserved 32px came out of the message area.
const typingHidden = cssBlock('.chat-typing-bar[hidden]');
assert(
    /display:\s*none/.test(typingHidden),
    'the hidden typing bar must take no space (display: none) — reserving the row left a ' +
    'permanent dead band between the last message and the composer'
);
// ⚠️ AND THE REAL PROTECTION IS ASSERTED HERE, not restored as a band. If the
// bar ever needs its space back, it is because the modal stopped being a fixed
// height — so that is the thing a test must hold, rather than the cosmetic
// reservation that was masking it.
assert(
    /height:\s*min\(720px,\s*82vh\)/.test(cssBlock('.chat-modal-container {')) &&
    /overflow:\s*hidden/.test(cssBlock('.chat-modal-container {')),
    '.chat-modal-container must keep a FIXED height with overflow hidden — that, not a ' +
    'reserved typing row, is what stops the thread jumping when the bar shows and hides'
);
assert(
    /min-height:\s*0/.test(cssBlock('.chat-log {')),
    '.chat-log must keep min-height: 0 or it stops being the scroll container and every ' +
    'els.log.scrollTop write in chat.js becomes a silent no-op'
);
const mobile = css.slice(css.indexOf('@media (max-width: 640px)'));
assert(
    /height:\s*min\(720px,\s*88vh\);/.test(mobile),
    'the phone breakpoint must keep the same FIXED height, or the modal resizes on mobile only'
);

// ⚠️ The ＋ "new conversation" button is GONE (see the js/chat.js guard
// above), so its styles must be gone too. `.chat-icon-btn` is the button,
// `.chat-newmenu*` the floating picker, `.chat-sidebar-head` the row that
// existed only to hold that one button — all three would otherwise sit in the
// stylesheet styling nothing, and the head would read as an intentional gap
// above the search box if it ever came back alone.
assert(
    !/chat-icon-btn|chat-newmenu|chat-sidebar-head/.test(css),
    'chat.css must not keep rules for the removed ＋ button, its picker, or the header row that held it'
);
assert(
    /margin:\s*12px 12px 10px;/.test(cssBlock('.chat-search {')),
    'with the header row gone the search box is the first thing in the sidebar and needs its own top margin'
);

console.log('\n\u2705 All chat-rules tests passed (rules, roster, branch group chats, modal CSS).');

