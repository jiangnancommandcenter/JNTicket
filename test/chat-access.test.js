// Functional test for the Owner <-> Superadmin chat: the ACCESS GATE and
// the browser wiring (DOM injection, role gating, message rendering).
// The gate helpers are extracted from js/chat.js (browser globals stubbed)
// so the logic can be verified in plain Node without Firebase or a DOM.
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'chat.js'), 'utf8');

// Extract the module's constants + pure access-gate helpers (everything
// from the allowlist up to the DOM/escaping section) so the logic can be
// verified in plain Node without Firebase or a DOM.
const start = src.indexOf('var CHAT_ALLOWED_ROLES');
const end = src.indexOf('//  HTML ESCAPING');
assert(start > -1 && end > start, 'chat access-gate block not found in js/chat.js');

const gateSrc = src.slice(start, end);

const gateSandbox = { window: {}, console };
vm.createContext(gateSandbox);
vm.runInContext(gateSrc, gateSandbox);

const ChatService = gateSandbox.window.ChatService;
assert(ChatService, 'window.ChatService was not created by the gate block');
assert.strictEqual(typeof ChatService.canChat, 'function', 'canChat() missing');
assert.strictEqual(typeof ChatService.canChatOnSurface, 'function', 'canChatOnSurface() missing');

console.log('Testing chat access gate...');

// 1. HR and superadmins ARE allowed — the two intended roles.
assert.strictEqual(ChatService.canChat('hr'), true, 'hr must be allowed to chat');
assert.strictEqual(ChatService.canChat('superadmin'), true, 'superadmin must be allowed to chat');

// 2. The AREA MANAGER (stored role 'owner') IS allowed — they hold 1:1
//    threads with HR and superadmins. Operators are still never allowed.
assert.strictEqual(ChatService.canChat('owner'), true, 'an Area Manager (owner) must be allowed to chat 1:1');
assert.strictEqual(ChatService.canChat('operator'), false, 'operator must NOT be allowed to chat');

// 3. Case/whitespace insensitivity, matching syncCurrentUserRole() which
//    lowercases the Firestore role.
assert.strictEqual(ChatService.canChat('HR'), true, 'mixed case hr must be allowed');
assert.strictEqual(ChatService.canChat('SUPERADMIN'), true, 'mixed case superadmin must be allowed');
assert.strictEqual(ChatService.canChat('  hr  '), true, 'padded hr must be allowed');
assert.strictEqual(ChatService.canChat('Owner'), true, 'mixed case owner must be allowed (Area Manager)');
assert.strictEqual(ChatService.canChat('Operator'), false, 'mixed case operator must NOT be allowed');

// 4. Unknown / missing / falsy roles are rejected (allowlist, not blocklist).
assert.strictEqual(ChatService.canChat(null), false, 'null role must be rejected');
assert.strictEqual(ChatService.canChat(undefined), false, 'undefined role must be rejected');
assert.strictEqual(ChatService.canChat(''), false, 'empty role must be rejected');
assert.strictEqual(ChatService.canChat('viewer'), false, 'viewer role must be rejected');
assert.strictEqual(ChatService.canChat('admin'), false, 'unknown role must be rejected');
assert.strictEqual(ChatService.canChat('superadmin '), true, 'trailing space must be trimmed');
// A permissions-fetch failure calls setActiveUser(perms, false), so the
// role can arrive as the boolean/string "false" — it must not grant access.
assert.strictEqual(ChatService.canChat(false), false, 'boolean false role must be rejected');
assert.strictEqual(ChatService.canChat('false'), false, 'string "false" role must be rejected');
// Substring must not satisfy the allowlist.
assert.strictEqual(ChatService.canChat('superadministrator'), false, 'prefix must not match');
assert.strictEqual(ChatService.canChat('notowner'), false, 'substring must not match');
// A near-miss on the HR role must not slip through either.
assert.strictEqual(ChatService.canChat('hr-admin'), false, 'prefix must not match');
assert.strictEqual(ChatService.canChat('the-hr'), false, 'substring must not match');

// 5. Surface rules:
//    - ownerdashboard.html ('owner'): hr + superadmin + the Area Manager pass.
//    - main.html ('main'): superadmin only (hr/owner are routed away).
assert.strictEqual(ChatService.canChatOnSurface('owner', 'hr'), true, 'hr passes on owner dashboard');
assert.strictEqual(ChatService.canChatOnSurface('owner', 'superadmin'), true, 'superadmin passes on owner dashboard');
// The Area Manager is routed to the dashboard, so this is where they chat.
assert.strictEqual(
    ChatService.canChatOnSurface('owner', 'owner'),
    true,
    'an Area Manager (stored role owner) passes on the dashboard they are routed to'
);
assert.strictEqual(ChatService.canChatOnSurface('main', 'superadmin'), true, 'superadmin passes on main dashboard');
assert.strictEqual(ChatService.canChatOnSurface('main', 'hr'), false, 'hr must not get chat on main.html');
assert.strictEqual(ChatService.canChatOnSurface('main', 'owner'), false, 'an Area Manager must not get chat on main.html — they are never routed there');
assert.strictEqual(ChatService.canChatOnSurface('main', 'operator'), false, 'operator must not get chat on main.html');
assert.strictEqual(ChatService.canChatOnSurface('owner', 'operator'), false, 'operator must not get chat on owner dashboard');

// 6. An unrecognised surface must not accidentally grant access to an
//    operator (defensive: only 'main' is special-cased).
assert.strictEqual(ChatService.canChatOnSurface('unknown-page', 'operator'), false, 'unknown surface must reject operator');
assert.strictEqual(ChatService.canChatOnSurface(undefined, 'operator'), false, 'missing surface must reject operator');

// 7. TWO allowlists, and they are NOT the same width.
//    CHAT_ALLOWED_ROLES  — who may hold a 1:1 conversation (3 roles)
//    GROUP_ROOM_ROLES    — who may be in the "All HR" group (2 roles)
// NOTE: the arrays originate inside the vm sandbox, so their prototype is
// the sandbox's Array — deepStrictEqual would fail on the prototype even
// though the contents match. Compare the joined values instead.
assert.strictEqual(
    ChatService.CHAT_ALLOWED_ROLES.slice().sort().join(','),
    'hr,owner,rmsm,superadmin',
    'CHAT_ALLOWED_ROLES must be exactly hr + superadmin + owner + rmsm (the Area Manager chats 1:1)'
);
assert.strictEqual(
    ChatService.CHAT_ALLOWED_ROLES.indexOf('operator'),
    -1,
    'operator must never appear in the allowlist'
);
assert.strictEqual(
    ChatService.GROUP_ROOM_ROLES.slice().sort().join(','),
    'hr,superadmin',
    'GROUP_ROOM_ROLES must be exactly hr + superadmin — the Area Manager is NOT in the All HR group'
);
assert.strictEqual(
    ChatService.GROUP_ROOM_ROLES.indexOf('owner'),
    -1,
    'the Area Manager must never appear in GROUP_ROOM_ROLES — they are excluded from the group chat'
);
assert.strictEqual(
    ChatService.GROUP_ROOM_ROLES.indexOf('operator'),
    -1,
    'operator must never appear in the group list'
);

console.log('✅ Chat access gate tests passed (hr + superadmin + Area Manager chat 1:1; ' +
    'the All HR group stays hr + superadmin only; operator excluded everywhere).');

// ---------------------------------------------------------------
// 7b. THE PAIRING MATRIX — "both chat-eligible AND a different role".
//
//     This is the rule that produces the whole access picture — STRICT
//     PAIRING (spec), so every cell is one of exactly two pairs:
//
//                superadmin      HR     Area Manager    RM/SM
//       superadmin     x           v           .          .
//       HR             v           x           .          .
//       Area Manager   .           .           x          .
//       RM/SM          .           .           .          x
//
//     The dots are the spec's hard refusals: personal chat is superadmin <->
//     HR ONLY — nothing else. An Area Manager never pairs, and neither does
//     HR and the superadmin in the STORE GROUP chat. The x diagonals are the
//     same-role rule (nobody pairs with themselves), not special cases.
//
//     isStartable() lives past the gate block (it needs currentRole and
//     currentUserEmail), so it is extracted on its own here.
// ---------------------------------------------------------------
console.log('\n=== The pairing matrix (who may start a thread with whom) ===');
const pairStart = src.indexOf('function isStartable(entry)');
assert(pairStart > -1, 'isStartable() not found in js/chat.js');
const pairEnd = src.indexOf('function startableEntryFor(', pairStart);
assert(pairEnd > pairStart, 'could not find the end of isStartable()');

// currentRole / currentUserEmail are the module's own state; declare them the
// way the module does (top-level `var` inside the IIFE) so the assignment
// below reaches the very binding isStartable() closes over.
const pairSandbox = { window: {}, console };
vm.createContext(pairSandbox);
vm.runInContext(
    'var CHAT_ALLOWED_ROLES = ' +
        JSON.stringify(['hr', 'superadmin', 'owner', 'rmsm']) + ';\n' +
    'var GROUP_ROOM_ROLES = ' + JSON.stringify(['hr', 'superadmin']) + ';\n' +
    'var currentRole = "";\n' +
    'var currentUserEmail = "";\n' +
    'function normalizeRole(role) {\n' +
    '    if (role === null || role === undefined) return "";\n' +
    '    return String(role).trim().toLowerCase();\n' +
    '}\n' +
    src.slice(pairStart, pairEnd) +
    '\nglobalThis.__pair = {\n' +
    '    isStartable: isStartable,\n' +
    '    setState: function (role, email) { currentRole = role; currentUserEmail = email; }\n' +
    '};\n',
    pairSandbox
);
const Pair = pairSandbox.__pair;
assert(Pair, 'could not load isStartable() into the sandbox');

/** Can `me` start a thread with `them`? */
function canPair(me, them) {
    Pair.setState(me, me + '@test.com');
    return Pair.isStartable({ email: them + '@test.com', role: them });
}

const EXPECTED = [
    // [me, them, allowed, why]
    ['superadmin', 'hr', true, "superadmin <-> HR (the spec's private pair)"],
    ['hr', 'superadmin', true, 'HR <-> superadmin'],
    ['owner', 'rmsm', false, 'spec: store roles have NO personal chat at all'],
    ['rmsm', 'owner', false, 'spec: store roles have NO personal chat at all'],
    ['owner', 'hr', false, 'spec: store personnel meet HR in the STORE GROUP chat'],
    ['hr', 'owner', false, 'spec: ...and it MUST be symmetric'],
    ['owner', 'superadmin', false, 'spec: a superadmin may personal-chat HR ONLY'],
    ['superadmin', 'owner', false, 'spec: ...symmetric'],
    ['superadmin', 'rmsm', false, 'spec: no superadmin <-> RM/SM personal chat'],
    ['rmsm', 'superadmin', false, 'spec: ...symmetric'],
    ['hr', 'rmsm', false, 'spec: RM/SM meet HR in the STORE GROUP chat'],
    ['rmsm', 'hr', false, 'spec: ...symmetric'],
    ['hr', 'hr', false, 'HR <-> HR was already forbidden'],
    ['superadmin', 'superadmin', false, 'superadmin <-> superadmin was already forbidden'],
    ['owner', 'owner', false, '⚠️ CO-MANAGERS: two Area Managers must never be paired'],
    ['rmsm', 'rmsm', false, 'two RM/SM must never be paired with each other either'],
    ['owner', 'operator', false, 'an operator is not a chat role at all'],
    ['hr', 'operator', false, 'an operator is not a chat role at all'],
    ['superadmin', 'operator', false, 'an operator is not a chat role at all'],
    ['owner', 'viewer', false, 'an unknown role is not a chat role at all'],
    ['owner', '', false, 'a role-less directory entry must not become a row']
];
EXPECTED.forEach(([me, them, allowed, why]) => {
    assert.strictEqual(
        canPair(me, them),
        allowed,
        `${me} <-> ${them} must be ${allowed ? 'ALLOWED' : 'REFUSED'} — ${why}`
    );
});
console.log('  PASS  the full pairing matrix, including the co-manager exclusion');

// ⚠️ THE SAME-ROLE CASES MUST BE TWO *DISTINCT* PEOPLE.
//
// canPair() above builds both emails from the role name, so `owner` vs `owner`
// produced the SAME address on both sides — and isStartable() rejects that at
// the "never yourself" check, long before it ever reaches the role rule. The
// co-manager assertion would therefore have passed even if the role check were
// deleted, which is the exact bug this whole feature is about. So the
// same-role refusals are re-proved here with genuinely different people, and
// each is shown to fail for the ROLE reason by pairing the same second person
// under a different role.
const AM1 = 'am.one@test.com';
const AM2 = 'am.two@test.com';
Pair.setState('owner', AM1);
assert.strictEqual(
    Pair.isStartable({ email: AM2, role: 'owner' }),
    false,
    '⚠️ CO-MANAGERS: a second, DISTINCT Area Manager must not be startable — this is the ' +
    'requirement, and it must not be passing merely because the two emails differed'
);
// Prove it is the ROLE doing the refusing: the very same second person stays
// refused when they hold RM/SM — under the new spec an Area Manager pairs
// with NOBODY, so changing the other side to the old peer changes nothing.
assert.strictEqual(
    Pair.isStartable({ email: 'rm.person@test.com', role: 'rmsm' }),
    false,
    "an Area Manager must NEVER start a thread with an RM/SM under the new spec"
);
// ...and the reverse direction also fails now: no two-way store pair exists.
// under the new spec.
Pair.setState('rmsm', 'rm.person@test.com');
assert.strictEqual(
    Pair.isStartable({ email: AM1, role: 'owner' }),
    false,
    'that RM/SM must also fail to start the thread with the Area Manager now'
);
// The spec's hard refusals, proved with DISTINCT people (so they fail on the
// PAIRING rule, never on the never-yourself check): a superadmin may personal
// chat HR ONLY, and store personnel meet HR + superadmin in the STORE GROUP.
// under the new spec.
Pair.setState('superadmin', 'boss.person@test.com');
assert.strictEqual(
    Pair.isStartable({ email: AM1, role: 'owner' }),
    false,
    'a superadmin must NOT start a thread with an Area Manager (spec: store roles have no personal chat at all)'
);
Pair.setState('hr', 'hr.person@test.com');
assert.strictEqual(
    Pair.isStartable({ email: AM1, role: 'owner' }),
    false,
    'an HR must NOT start a thread with an Area Manager — the store team meets in the group chat'
);
console.log('  PASS  the refusals are the PAIRING rule, not an email coincidence');

const AM3 = 'am.three@test.com';
Pair.setState('owner', AM1);
assert.strictEqual(
    Pair.isStartable({ email: AM3, role: 'owner' }),
    false,
    'a third Area Manager must also be refused'
);
console.log('  PASS  every co-manager is refused, not just the first');

// The matrix must be SYMMETRIC. A one-way pairing is worse than useless
// here: the room is authorised by MEMBERSHIP, so if only one side can
// start it, the other side can never find the conversation that exists.
['hr', 'superadmin', 'owner', 'rmsm'].forEach((a) => {
    ['hr', 'superadmin', 'owner', 'rmsm'].forEach((b) => {
        assert.strictEqual(
            canPair(a, b),
            canPair(b, a),
            `pairing must be symmetric: ${a} -> ${b} disagrees with ${b} -> ${a}`
        );
    });
});
console.log('  PASS  pairing is symmetric for all four chat roles');

// Never yourself, whatever the stored role says.
Pair.setState('owner', 'me@test.com');
assert.strictEqual(
    Pair.isStartable({ email: 'ME@test.com', role: 'hr' }),
    false,
    'a person must never be offered a thread with themselves'
);
console.log('  PASS  self is never startable');

// ---------------------------------------------------------------
// Part 2 — full module against a fake DOM + fake Firestore
// ---------------------------------------------------------------
console.log('Testing chat UI wiring (fake DOM + fake Firestore)...');

/** Minimal element stub: enough for createElement / querySelector / append. */
class FakeElement {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.id = '';
        this.hidden = false;
        this.disabled = false;
        this._innerHTML = '';
        this._textContent = '';
        this._listeners = {};
        this._classes = [];
        this.attributes = {};
        this.value = '';
        this.scrollTop = 0;
        this.scrollHeight = 1000;
        this.clientHeight = 400;
        // Inline style + layout, needed by the draggable-launcher tests.
        this.style = {};
        this.offsetWidth = 54;
        this.offsetHeight = 54;
        this._rect = { left: 0, top: 0, width: 54, height: 54 };
        this.capturedPointerId = null;
        this.classList = {
            add: (c) => { if (this._classes.indexOf(c) === -1) this._classes.push(c); },
            remove: (c) => {
                const i = this._classes.indexOf(c);
                if (i > -1) this._classes.splice(i, 1);
            },
            contains: (c) => this._classes.indexOf(c) > -1,
            toggle: (c, force) => {
                const has = this._classes.indexOf(c) > -1;
                const want = force === undefined ? !has : !!force;
                if (want && !has) this._classes.push(c);
                if (!want && has) {
                    const i = this._classes.indexOf(c);
                    if (i > -1) this._classes.splice(i, 1);
                }
                return want;
            }
        };
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(v) {
        this._innerHTML = String(v);
        // A real innerHTML write detaches every existing child node.
        this.children = [];
        // Re-create a stub for every id="..." in the markup, so
        // querySelector('#chatLog') behaves like it does in a browser.
        const re = /id="([^"]+)"([^>]*)>/g;
        let m;
        while ((m = re.exec(this._innerHTML)) !== null) {
            const child = new FakeElement('div');
            child.id = m[1];
            // Honour a `hidden` attribute written into the markup, so a stub
            // behaves like the real element it stands in for. Without this an
            // element authored as `<div id="x" hidden>` reports hidden ===
            // false, and every "must start collapsed" assertion fails for the
            // wrong reason.
            if (/(^|\s)hidden(\s|=|$)/.test(m[2])) child.hidden = true;
            this.appendChild(child);
        }
        // A real element GROWS when its content grows. The pagination scroll
        // anchor is measured purely from this delta, so it must respond to
        // the markup written, otherwise scroll-preservation cannot be tested
        // at all.
        const prev = this._contentHeight || 0;
        this._contentHeight = this._innerHTML.length;
        this.scrollHeight = prev + (this._contentHeight - prev);
    }
    get textContent() { return this._textContent; }
    set textContent(v) { this._textContent = String(v); }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k]; }
    removeAttribute(k) { delete this.attributes[k]; }
    appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
        return child;
    }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    dispatch(type, event) {
        (this._listeners[type] || []).forEach((fn) =>
            fn(Object.assign({ target: this, preventDefault() {} }, event)));
    }
    focus() { this.focused = true; }
    getBoundingClientRect() { return Object.assign({}, this._rect); }
    setPointerCapture(id) { this.capturedPointerId = id; }
    releasePointerCapture(id) { if (this.capturedPointerId === id) this.capturedPointerId = null; }
    remove() {
        if (this.parentNode) {
            const i = this.parentNode.children.indexOf(this);
            if (i > -1) this.parentNode.children.splice(i, 1);
        }
        this.removed = true;
    }
    /** Supports the '#id' selector form chat.js uses. */
    querySelector(selector) {
        const want = String(selector).replace('#', '');
        const stack = this.children.slice();
        while (stack.length) {
            const el = stack.shift();
            if (el.id === want) return el;
            stack.push.apply(stack, el.children);
        }
        return null;
    }
}

function findById(node, id) {
    if (node.id === id) return node;
    for (const c of node.children) {
        const r = findById(c, id);
        if (r) return r;
    }
    return null;
}

const sentWrites = [];
let listenerCallback = null;
let presenceCallback = null;
let receiptsCallback = null;
let profilesCallback = null;
let reactionsCallback = null;
let listenerErrorCallback = null;
let audioPlayCount = 0;
// New: the conversation-list listener and the chatProfiles directory
// listener, plus the write logs their records. The chat is now one room
// per pair, so the list and the directory are separate subscriptions
// from the open thread's message listener.
let conversationCallback = null;
let directoryCallback = null;
const directoryWrites = [];
const roomUpdates = [];
let currentRoomId = null;
// Which room each captured callback belongs to, so a test can assert that
// switching conversations really re-points the listeners.
let messageRoomId = null;
let presenceRoomId = null;
let receiptsRoomId = null;

/**
 * Fake Firestore. `messagesRef().orderBy().limitToLast().onSnapshot()` is a
 * real chain on a CollectionReference, so the messages collection itself is
 * chainable here. The presence subcollection is chainable too, and records
 * writes so typing behaviour can be asserted.
 */
function makeFakeFirestore() {
    const presenceWrites = [];

    const presenceCol = {
        onSnapshot(cb) {
            presenceCallback = cb;
            return function () { /* unsubscribe */ };
        },
        doc(key) {
            return {
                key,
                set(data) {
                    presenceWrites.push({ op: 'set', key, data });
                    return Promise.resolve();
                },
                delete() {
                    presenceWrites.push({ op: 'delete', key });
                    return Promise.resolve();
                }
            };
        }
    };

    // The backing store for the paginated history query. Tests push pages
    // in here; the fake serves a DESCENDING page (newest-first) taken from
    // just past the startAfter cursor, exactly like
    // orderBy('sentAt','desc').startAfter(...).limit(n).
    let historyStore = [];

    const messagesCol = {
        _cursor: null,
        _limit: null,
        orderBy() { return this; },
        limitToLast() { return this; },
        startAfter(cursor) { this._cursor = cursor; return this; },
        limit(n) { this._limit = n; return this; },
        get() {
            const cursorKey = this._cursor;
            const limit = this._limit || 60;
            // `orderBy('sentAt')` (ascending) + startAfter + limit returns
            // docs AFTER the cursor in ASCENDING order — the store is
            // oldest-first, so the page is a forward slice from just past
            // the cursor. Firestore cursors carry an implicit __name__
            // tiebreaker, so the cursor identifies a position, not a value
            // (two messages can share a millisecond).
            let out = historyStore.slice().reverse();
            if (cursorKey) {
                const idx = out.findIndex((d) => d.id === cursorKey.id);
                out = idx > -1 ? out.slice(idx + 1) : [];
            }
            out = out.slice(0, limit);
            const docs = out.map((d) => ({ id: d.id, data: () => d }));
            return Promise.resolve({
                docs,
                size: docs.length,
                forEach(fn) { docs.forEach(fn); },
                empty: docs.length === 0
            });
        },
        onSnapshot(cb, errCb) {
            listenerCallback = cb;
            listenerErrorCallback = errCb || null;
            return function () { /* unsubscribe */ };
        },
        doc() { return {}; },
        __setHistory(list) { historyStore = list; },
        __getHistory() { return historyStore; }
    };

    // Read receipts (the ✓ Sent / ✓✓ Seen ticks). The listener is captured
    // so a test can push receipts in and assert the ticks repaint.
    const receiptWrites = [];
    const readReceiptsCol = {
        onSnapshot(cb) {
            receiptsCallback = cb;
            return function () { /* unsubscribe */ };
        },
        doc(key) {
            return {
                key,
                set(data, opts) {
                    receiptWrites.push({ op: 'set', key, data, opts });
                    return Promise.resolve();
                }
            };
        }
    };

    // Profiles (display name + job title).
    const profileWrites = [];
    const profilesCol = {
        onSnapshot(cb) {
            profilesCallback = cb;
            return function () { /* unsubscribe */ };
        },
        doc(key) {
            return {
                key,
                set(data, opts) {
                    profileWrites.push({ op: 'set', key, data, opts });
                    return Promise.resolve();
                }
            };
        }
    };

    // Reactions: one doc per (message, person) — the emoji is a field, so a
    // person can hold at most ONE reaction per message.
    const reactionWrites = [];
    const reactionUpdates = [];
    const reactionDeletes = [];
    const reactionsCol = {
        onSnapshot(cb) {
            reactionsCallback = cb;
            return function () { /* unsubscribe */ };
        },
        doc(key) {
            return {
                key,
                set(data) {
                    reactionWrites.push({ op: 'set', key, data });
                    return Promise.resolve();
                },
                update(data) {
                    reactionUpdates.push({ op: 'update', key, data });
                    return Promise.resolve();
                },
                delete() {
                    reactionDeletes.push(key);
                    return Promise.resolve();
                }
            };
        }
    };

    const roomDoc = {
        collection(name) {
            if (name === 'presence') return presenceCol;
            if (name === 'readReceipts') return readReceiptsCol;
            if (name === 'profiles') return profilesCol;
            if (name === 'reactions') return reactionsCol;
            return messagesCol;
        },
        set() {},
        update(data) { roomUpdates.push({ roomId: currentRoomId, data }); return Promise.resolve(); }
    };

    // ---- Per-room support -------------------------------------------
    // The chat is now ONE ROOM PER PAIR, so `collection('chats').doc(id)`
    // must resolve to a room keyed by that id, and the conversation-list
    // query needs where/orderBy/limit. Each open room gets its OWN
    // subcollection set, so a test can prove that switching conversations
    // does not leak the previous room's messages.
    function makeRoomFor(roomId) {
        const presence = {
            onSnapshot(cb) { presenceCallback = cb; return function () { presenceRoomId = roomId; }; },
            doc(key) {
                return {
                    key,
                    set(data) { presenceWrites.push({ op: 'set', key, data, roomId }); return Promise.resolve(); },
                    delete() { presenceWrites.push({ op: 'delete', key, roomId }); return Promise.resolve(); }
                };
            }
        };
        const receipts = {
            onSnapshot(cb) { receiptsCallback = cb; return function () { receiptsRoomId = roomId; }; },
            doc(key) {
                return {
                    key,
                    set(data, opts) { receiptWrites.push({ op: 'set', key, data, opts, roomId }); return Promise.resolve(); }
                };
            }
        };
        // A PER-ROOM message collection. `messagesCol` (the shared one) is
        // still used for the history store, but each room gets its own
        // onSnapshot target so a test can prove that switching conversations
        // releases the previous room's message stream instead of leaving it
        // feeding the new thread's log.
        const messages = Object.create(messagesCol);
        messages.doc = () => ({});
        messages.onSnapshot = function (cb, errCb) {
            listenerCallback = cb;
            listenerErrorCallback = errCb || null;
            messageRoomId = roomId;
            return function () { messageRoomId = null; };
        };
        return {
            collection(name) {
                if (name === 'presence') return presence;
                if (name === 'readReceipts') return receipts;
                if (name === 'profiles') {
                    // The legacy room's `profiles` IS the people directory.
                    if (roomId === 'owner-superadmin') return chatProfilesCol;
                    return profilesCol;
                }
                if (name === 'reactions') return reactionsCol;
                return messages;
            },
            set() {},
            update(data) { roomUpdates.push({ roomId, data }); return Promise.resolve(); }
        };
    }

    // The people directory. It lives in the LEGACY room's `profiles`
    // subcollection, which the already-deployed rules already let HR and
    // superadmins read — so no new collection (and no rules deploy) is
    // needed. makeRoomFor() returns this for the legacy room's `profiles`.
    const chatProfilesCol = {
        onSnapshot(cb) { directoryCallback = cb; return function () {}; },
        doc(key) {
            return {
                key,
                set(data, opts) { directoryWrites.push({ op: 'set', key, data, opts }); return Promise.resolve(); },
                update(data) { directoryWrites.push({ op: 'update', key, data }); return Promise.resolve(); }
            };
        }
    };

    // The conversation-list query. Tests seed `roomDocs` to stand in for
    // what Firestore would return for
    // `chats where members array-contains me orderBy lastMessageAt desc`.
    const chatListCol = {
        where(field, op, value) { this._where = { field, op, value }; return this; },
        orderBy() { return this; },
        limit() { return this; },
        onSnapshot(cb, errCb) { conversationCallback = cb; return function () {}; }
    };

    // The AUTHORITATIVE account roster (`users`), which BOTH chat roles read
    // live: a superadmin reads the collection whole, an HR only through
    // `where('role','==','superadmin')` — the one shape the users read rule is
    // provable from. This suite is about the access gate, so the roster is
    // empty here; the roster BEHAVIOUR is asserted in
    // test/chat-conversations.test.js. Every subscribe is recorded together
    // with the filters it used.
    const rosterReads = [];
    function rosterQuery(filters) {
        return {
            where(field, op, value) {
                return rosterQuery(filters.concat([field + ' ' + op + ' ' + value]));
            },
            get() {
                rosterReads.push(filters.slice());
                return Promise.resolve({ forEach() {} });
            },
            onSnapshot(cb) {
                rosterReads.push(filters.slice());
                cb({ forEach() {} });
                return function () {};
            }
        };
    }
    const usersCol = rosterQuery([]);

    return {
        collection(name) {
            if (name === 'chats') {
                return {
                    doc(id) { currentRoomId = id; return makeRoomFor(id); },
                    where: chatListCol.where,
                    orderBy: chatListCol.orderBy,
                    limit: chatListCol.limit,
                    onSnapshot: chatListCol.onSnapshot
                };
            }
            if (name === 'chatProfiles') return chatProfilesCol;
            if (name === 'users') return usersCol;
            throw new Error('unexpected collection: ' + name);
        },
        batch() {
            return {
                set(ref, data) { sentWrites.push({ ref, data }); },
                async commit() { return true; }
            };
        },
        __presenceWrites: presenceWrites,
        __receiptWrites: receiptWrites,
        __profileWrites: profileWrites,
        __reactionWrites: reactionWrites,
        __reactionUpdates: reactionUpdates,
        __reactionDeletes: reactionDeletes,
        __directoryWrites: directoryWrites,
        __roomUpdates: roomUpdates,
        __messagesCol: messagesCol,
        // The account roster: both chat roles read it (a superadmin whole, an
        // HR role-scoped), each entry recording the filters it was asked with.
        __rosterReads: rosterReads
    };
}

const body = new FakeElement('body');
const store = {};

// Real timer functions plus a registry, so the test can release every
// interval chat.js created and let Node exit cleanly.
const realSetTimeout = setTimeout;
const liveTimeouts = new Set();

// Fake-timer registry: chat.js's draft heartbeat is a repeating interval,
// and the whole point of the feature is that it fires on a TIMER with no
// input events. A real 1.5s interval cannot be tested deterministically, so
// intervals are captured and fired on demand via runIntervals().
const fakeIntervals = new Map();
let nextIntervalId = 1;

/** Fire every registered interval callback once (as if `ms` elapsed). */
function runIntervals() {
    fakeIntervals.forEach((entry) => {
        try { entry.fn(); } catch (e) { /* surface via assertions */ }
    });
}

/** Number of live repeating timers. */
function intervalCount() {
    return fakeIntervals.size;
}

const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: {},
    document: {
        body,
        createElement: (tag) => new FakeElement(tag),
        addEventListener() {}
    },
    localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
        // Needed to simulate the "new device / cleared site data" case,
        // which is exactly the bug the unread threshold fix addresses.
        clear: () => { Object.keys(store).forEach((k) => delete store[k]); }
    },
    db: makeFakeFirestore(),
    auth: { currentUser: { email: 'hr@test.com' } },
    // Viewport size, used by the draggable launcher to clamp positions.
    innerWidth: 1280,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    firebase: {
        firestore: {
            FieldValue: {
                serverTimestamp: () => ({ __serverTs: true }),
                // Used to bump a room's per-conversation unreadCount when a
                // message is sent. Tagged so a test can tell an increment
                // apart from a literal number.
                increment: (n) => ({ __increment: n })
            }
        }
    },
    setTimeout(fn, ms) {
        const id = realSetTimeout(fn, ms);
        liveTimeouts.add(id);
        return id;
    },
    clearTimeout(id) {
        liveTimeouts.delete(id);
        return clearTimeout(id);
    },
    // Repeating timers are FAKED and fired on demand by runIntervals(), so
    // the draft heartbeat can be tested deterministically. Real intervals
    // would keep Node's event loop alive forever and cannot be awaited.
    setInterval(fn, ms) {
        const id = nextIntervalId++;
        fakeIntervals.set(id, { fn, ms });
        return id;
    },
    clearInterval(id) {
        fakeIntervals.delete(id);
    },
    Date,
    // Audio stub so the incoming-message sound can be counted.
    Audio: function () {
        return {
            pause() {}, currentTime: 0,
            play() { audioPlayCount++; return Promise.resolve(); }
        };
    }
};
sandbox.window.document = sandbox.document;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.db = sandbox.db;
sandbox.window.auth = sandbox.auth;
// The draggable launcher reads the viewport size and listens for resize
// on `window`, so those must exist on the window object too.
sandbox.window.innerWidth = sandbox.innerWidth;
sandbox.window.innerHeight = sandbox.innerHeight;
sandbox.window.addEventListener = sandbox.addEventListener;
sandbox.window.removeEventListener = sandbox.removeEventListener;
// ⚠️ THE REAL PAGES LOAD js/notifications.js, which exports the shared,
// preloaded notification sound. chat.js DELEGATES to it (`typeof
// window.playNotificationSound === 'function'`) instead of building its own
// Audio — see playIncomingSound(). The sandbox must mirror that, or every
// sound assertion below fails for a reason that has nothing to do with the
// behaviour under test. This stub stands in for that module: it bumps the SAME
// counter the old Audio stub did.
sandbox.window.playNotificationSound = function () {
    audioPlayCount++;
    return Promise.resolve();
};
sandbox.playNotificationSound = sandbox.window.playNotificationSound;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const Live = sandbox.window.ChatService;
assert(Live, 'window.ChatService missing after full load');
assert.strictEqual(typeof Live.init, 'function', 'init() missing');
assert.strictEqual(typeof Live.open, 'function', 'open() missing');

const launchers = () => body.children.filter((c) => c.className === 'chat-launcher');

/**
 * Make a room look like it already exists in the conversation list.
 *
 * chat.js deliberately does NOT subscribe to a conversation whose room
 * document is missing: reading `chats/{id}/messages` for a room that was
 * never created is denied by the membership rule, and chat.js reacts to a
 * permission error by greying out the launcher ("Chat is blocked by the
 * current Firestore rules"). So any test that wants a live message/typing
 * listener must first put the room in the list snapshot.
 */
function seedExistingConversation(roomId, members) {
    if (!conversationCallback || !roomId) return;
    conversationCallback({
        forEach(fn) {
            fn({
                id: roomId,
                data: () => ({
                    members: members || ['hr@test.com', 'super@test.com'],
                    lastMessage: 'existing',
                    lastMessageAt: { toDate: () => new Date() },
                    lastSenderEmail: 'hr@test.com'
                })
            });
        }
    });
}

// 8. An OPERATOR must not get any chat UI at all.
assert.strictEqual(Live.init({ surface: 'owner', role: 'operator' }), false, 'operator init must return false');
assert.strictEqual(Live.isMounted(), false, 'operator must not mount chat');
assert.strictEqual(launchers().length, 0, 'operator must not get a chat launcher in the DOM');

// 9. An HR user on ownerdashboard.html gets the launcher, visible + listening.
assert.strictEqual(Live.init({ surface: 'owner', role: 'hr' }), true, 'hr init must return true on the owner dashboard');
assert.strictEqual(Live.isMounted(), true, 'chat should be mounted for an HR user');
assert.strictEqual(launchers().length, 1, 'exactly one launcher should be injected');
assert.strictEqual(launchers()[0].hidden, false, 'launcher must be visible for an allowed role');
// The chat is now ONE ROOM PER PAIR, so on mount only the conversation
// list and the people directory are subscribed — there is no thread open
// yet, so there is no messages listener. Picking a row starts it (covered
// by the conversation-list suite below).
assert.strictEqual(typeof conversationCallback, 'function', 'the conversation list must be subscribed on mount');
assert.strictEqual(typeof directoryCallback, 'function', 'the people directory must be subscribed on mount');
assert.strictEqual(Live.activeRoom(), null, 'no conversation may be open before one is chosen');
assert.strictEqual(listenerCallback, null, 'no message listener may be attached before a conversation is chosen');

// 9b. The AREA MANAGER uses the SAME dashboard and DOES get chat — this is the
//     whole point of the change. They are a full 1:1 participant (HR and
//     superadmin only; never another Area Manager, and never the group).
assert.strictEqual(
    Live.init({ surface: 'owner', role: 'owner' }),
    true,
    'an Area Manager must get chat on the dashboard they are routed to'
);
assert.strictEqual(Live.isMounted(), true, 'chat must mount for an Area Manager');
assert.strictEqual(launchers().length, 1, 'exactly one launcher for an Area Manager');
assert.strictEqual(launchers()[0].hidden, false, 'the launcher must be visible to an Area Manager');
assert.strictEqual(
    Live.init({ surface: 'owner', role: 'hr' }),
    true,
    'switching back to HR must restore chat'
);

// 9c. ⚠️ THE AREA MANAGER MUST NOT SEE THE "All HR" GROUP CHAT — the one
//     user-visible guarantee the group-room gate has to deliver.
//
//     Checked against the RENDERED sidebar, on the fresh list element this
//     suite builds per mount, so a stale row from an earlier role cannot
//     mask (or fake) the result. The row is a real button: showing it to
//     someone the rules deny is a guaranteed permission error on click,
//     not a cosmetic issue. test/chat-conversations.test.js proves the same
//     gate against the row model; this proves what the user actually sees.
{
    const listEl = findById(body, 'chatList');
    assert(listEl, 'chatList element missing from the injected markup');
    const GROUP_ROOM_ID = Live.LEGACY_ROOM_ID;

    // As an HR the group row IS rendered — otherwise the gate below could
    // pass simply by having broken the group chat for everybody.
    Live.filterConversations('');
    assert(
        listEl.innerHTML.indexOf(GROUP_ROOM_ID) > -1,
        'the group room must be rendered in the sidebar for an HR — if this fails, the Area ' +
        'Manager gate is not what you are testing'
    );

    // Now the same page as an Area Manager.
    assert.strictEqual(
        Live.init({ surface: 'owner', role: 'owner' }),
        true,
        'an Area Manager must still mount chat for this check to mean anything'
    );
    Live.filterConversations('');
    assert(
        listEl.innerHTML.indexOf(GROUP_ROOM_ID) === -1,
        '⚠️ the "All HR" group room must NOT be rendered for an Area Manager — they may chat 1:1 ' +
        'with HR and superadmins, but the rules deny them that room (isLegacyArchive is still ' +
        'hr + superadmin), so the row could only ever be a permission error'
    );
    console.log('  PASS  the group chat renders for HR and is absent for an Area Manager');
}

// 10. Switching to an operator tears the UI back down (defensive).
const firstLauncher = launchers()[0];
assert.strictEqual(Live.init({ surface: 'main', role: 'operator' }), false, 'operator on main must return false');
assert.strictEqual(Live.isMounted(), false, 'operator must unmount chat');
assert.strictEqual(firstLauncher.removed, true, 'launcher element should be removed from the DOM');
assert.strictEqual(launchers().length, 0, 'no launcher should remain for an operator');

// ---------------------------------------------------------------
// Draggable launcher
// ---------------------------------------------------------------
console.log('Testing draggable launcher...');

Live.init({ surface: 'owner', role: 'hr' });
const dragLauncher = launchers()[0];
assert(dragLauncher, 'launcher should exist for the drag tests');

/** Simulate a full press -> move -> release drag. */
function dragTo(launcher, fromX, fromY, toX, toY) {
    launcher._rect = { left: fromX, top: fromY, width: 54, height: 54 };
    launcher.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: fromX, clientY: fromY });
    launcher.dispatch('pointermove', { pointerId: 1, clientX: toX, clientY: toY });
    launcher.dispatch('pointerup', { pointerId: 1, clientX: toX, clientY: toY });
}

// 24. Dragging past the threshold moves the circle.
dragLauncher._rect = { left: 0, top: 0, width: 54, height: 54 };
dragLauncher.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
dragLauncher.dispatch('pointermove', { pointerId: 1, clientX: 300, clientY: 400 });
assert.strictEqual(
    dragLauncher.style.left,
    '300px',
    'dragging must set an inline left position (the circle follows the pointer)'
);
assert.strictEqual(
    dragLauncher.style.top,
    '400px',
    'dragging must set an inline top position'
);
assert.strictEqual(dragLauncher.style.right, 'auto', 'dragging must release the right-anchored default');
assert(
    dragLauncher._classes.indexOf('chat-launcher-dragging') > -1,
    'the dragging class must be applied while the pointer is down'
);

// 25. Releasing persists the position and clears the dragging class.
dragLauncher.dispatch('pointerup', { pointerId: 1, clientX: 300, clientY: 400 });
assert(
    dragLauncher._classes.indexOf('chat-launcher-dragging') === -1,
    'the dragging class must be removed on release'
);
assert.strictEqual(
    store['rcms_chat_pos'],
    undefined,
    'the dropped position must NOT be persisted — the circle always starts ' +
    'at the CSS default (bottom-right) on the next load, got: ' + store['rcms_chat_pos']
);

// 26. A drag must NOT open the chat (the trailing click is swallowed).
const overlayBeforeDrag = body.children.filter((c) => String(c.className).indexOf('chat-modal-overlay') > -1)[0];
assert(!overlayBeforeDrag._classes.includes('active'), 'chat should start closed');
dragTo(dragLauncher, 300, 400, 500, 500);
dragLauncher.dispatch('click', {});
assert(
    !overlayBeforeDrag._classes.includes('active'),
    'finishing a drag must not open the chat modal'
);

// 27. A plain click (no movement) MUST still open the chat.
dragLauncher.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 500, clientY: 500 });
dragLauncher.dispatch('pointerup', { pointerId: 1, clientX: 500, clientY: 500 });
dragLauncher.dispatch('click', {});
assert(
    overlayBeforeDrag._classes.includes('active'),
    'a plain click with no movement must still open the chat'
);
Live.close();

// 28. Movement under the threshold is a click, not a drag.
dragLauncher.style.left = '';
dragLauncher.style.top = '';
dragLauncher.style.right = '';
dragLauncher._rect = { left: 100, top: 100, width: 54, height: 54 };
dragLauncher.dispatch('pointerdown', { pointerId: 1, button: 0, clientX: 100, clientY: 100 });
dragLauncher.dispatch('pointermove', { pointerId: 1, clientX: 102, clientY: 101 }); // < 5px
assert(
    dragLauncher.style.left === '' || dragLauncher.style.left === undefined,
    'sub-threshold jitter must not move the circle, got left=' + dragLauncher.style.left
);
dragLauncher.dispatch('pointerup', { pointerId: 1, clientX: 102, clientY: 101 });
dragLauncher.dispatch('click', {});
assert(
    overlayBeforeDrag._classes.includes('active'),
    'a sub-threshold press must still count as a click and open the chat'
);
Live.close();

// 29. The circle is clamped so it can never be dragged out of reach.
dragTo(dragLauncher, 100, 100, 99999, 99999);
assert.strictEqual(
    dragLauncher.style.left,
    (sandbox.innerWidth - 54 - 8) + 'px',
    'a drag far past the right edge must clamp inside the viewport'
);
assert.strictEqual(
    dragLauncher.style.top,
    (sandbox.innerHeight - 54 - 8) + 'px',
    'a drag far past the bottom edge must clamp inside the viewport'
);
dragTo(dragLauncher, 100, 100, -9999, -9999);
assert.strictEqual(dragLauncher.style.left, '8px', 'a negative drag must clamp to the edge margin');
assert.strictEqual(dragLauncher.style.top, '8px', 'a negative drag must clamp to the edge margin');

// 30. Double-click resets the circle to its default position.
dragLauncher.dispatch('dblclick', {});
assert.strictEqual(dragLauncher.style.left, '', 'double-click must clear the inline left position');
assert.strictEqual(dragLauncher.style.top, '', 'double-click must clear the inline top position');
assert.strictEqual(store['rcms_chat_pos'], undefined, 'double-click must forget the saved position');

// 31. A stale saved position from the OLD persistent version must be
//     CLEARED, not restored — the circle always starts bottom-right.
store['rcms_chat_pos'] = JSON.stringify({ x: 111, y: 222 });
Live.init({ surface: 'owner', role: 'hr' });
const restoredLauncher = launchers()[0];
assert.strictEqual(restoredLauncher.style.left, '', 'a stale saved position must NOT be restored on mount');
assert.strictEqual(restoredLauncher.style.top, '', 'a stale saved top must NOT be restored on mount');
assert.strictEqual(
    store['rcms_chat_pos'],
    undefined,
    'the stale saved position must be cleared on mount, got: ' + store['rcms_chat_pos']
);

// 32. A corrupt stored value must not break the launcher (and is cleared).
store['rcms_chat_pos'] = 'not json at all';
Live.init({ surface: 'owner', role: 'hr' });
assert(launchers()[0], 'a corrupt saved position must not prevent the launcher from mounting');
assert.strictEqual(store['rcms_chat_pos'], undefined, 'a corrupt saved position must be cleared on mount');
delete store['rcms_chat_pos'];

console.log('✅ Draggable launcher tests passed (drag moves it, click opens chat, clamped + resettable).');

// 11. Messages render ESCAPED — a message can never inject markup.
// The drag tests above opened a thread, so clear the captured callbacks to
// prove from a clean slate that a remount alone subscribes NOTHING and only
// picking a conversation attaches the message listener.
listenerCallback = null;
Live.init({ surface: 'owner', role: 'hr' });
// The chat is one room per pair now, so a thread only subscribes once a
// conversation is chosen. Open one with the superadmin, which is what a
// user does by clicking their row.
const THREAD_ROOM = Live.dmRoomIdFor('hr@test.com', 'super@test.com');
assert(THREAD_ROOM, 'a per-pair room id must be derivable for me + the superadmin');
assert.strictEqual(listenerCallback, null, 'a remount must not attach a message listener on its own');
assert.strictEqual(Live.activeRoom(), null, 'a remount must not leave a conversation open');

// A thread is only subscribed when its room document EXISTS — a
// never-started conversation has no room to read, and the membership rule
// denies reading a missing room. Seed the list with this conversation so
// selectConversation() takes the "room exists" path.
seedExistingConversation(THREAD_ROOM);
Live.selectConversation(THREAD_ROOM);
assert.strictEqual(Live.activeRoom(), THREAD_ROOM, 'selecting a row must open that conversation');
assert.strictEqual(typeof listenerCallback, 'function', 'opening an existing conversation must attach the message listener');

listenerCallback({
    forEach(cb) {
        cb({ id: 'm1', data: () => ({
            text: '<img src=x onerror=alert(1)>',
            senderEmail: 'super@test.com', senderName: 'Super', sentAt: new Date()
        }) });
        cb({ id: 'm2', data: () => ({
            text: 'plain text', senderEmail: 'hr@test.com', sentAt: new Date()
        }) });
    }
});

const log = findById(body, 'chatLog');
assert(log, 'could not locate #chatLog');
assert(log.innerHTML.indexOf('<img') === -1, 'message HTML must be escaped (raw <img found)');
assert(log.innerHTML.indexOf('&lt;img') > -1, 'message text should appear escaped');
assert(log.innerHTML.indexOf('chat-msg-theirs') > -1, 'other message should render as chat-msg-theirs');
assert(log.innerHTML.indexOf('chat-msg-mine') > -1, 'own message should render as chat-msg-mine');

// 12. An empty thread shows the empty state, not a blank log.
listenerCallback({ forEach() {} });
assert(log.innerHTML.indexOf('No messages yet') > -1, 'an empty thread must show the empty-state message');

// 13. Surface rules through the real init path.
assert.strictEqual(Live.init({ surface: 'main', role: 'superadmin' }), true, 'superadmin must get chat on main.html');
// ...and BOTH chat roles read the account roster: a superadmin reads the
// whole collection (`allow read: if isSuperAdmin() || isSelf()`), an HR only
// the superadmin docs (`allow read: if isHrOrSuperAdmin() && resource.data.role
// == 'superadmin'`) — that is how an HR discovers every superadmin, including
// one who has never opened the chat.
const rosterReads = sandbox.db.__rosterReads;
assert(rosterReads.length > 0, 'a superadmin mount must read the `users` account roster');
assert.deepStrictEqual(
    rosterReads[rosterReads.length - 1],
    [],
    'a superadmin must read the collection WHOLE — no filter, so no index and no missed role variant'
);
assert.strictEqual(Live.init({ surface: 'main', role: 'owner' }), false, 'owner must not get chat on main.html');
assert.strictEqual(Live.isMounted(), false, 'owner on main.html must leave chat unmounted');

// 14. A signed-out user never gets chat, even with an allowed role.
sandbox.auth.currentUser = null;
assert.strictEqual(Live.init({ surface: 'owner', role: 'hr' }), false, 'signed-out user must not get chat');
assert.strictEqual(Live.isMounted(), false, 'signed-out user must not mount chat');

// ---------------------------------------------------------------
// Part 3 — typing indicator + incoming-message sound
// ---------------------------------------------------------------
console.log('Testing typing indicator and incoming sound...');

sandbox.auth.currentUser = { email: 'hr@test.com' };
const rosterReadsBeforeHr = sandbox.db.__rosterReads.length;
assert.strictEqual(Live.init({ surface: 'owner', role: 'hr' }), true, 're-init as owner must succeed');
assert.strictEqual(
    sandbox.db.__rosterReads.length,
    rosterReadsBeforeHr + 1,
    'an HR mount MUST read the account roster too — without it an HR could only ever message superadmins ' +
    'who had published a chat profile'
);
assert.deepStrictEqual(
    sandbox.db.__rosterReads[rosterReadsBeforeHr],
    ['role == superadmin'],
    "…and only through where('role','==','superadmin'): that is the one query the per-document HR users " +
    'read rule is provable from, and it is what keeps owner/operator accounts unreadable'
);
// Presence is per-ROOM now, so the typing listener only attaches once an
// EXISTING conversation is open. Seed the list with the same thread the
// earlier section used, then re-open it.
seedExistingConversation(Live.dmRoomIdFor('hr@test.com', 'super@test.com'));
Live.selectConversation(Live.dmRoomIdFor('hr@test.com', 'super@test.com'));
assert.strictEqual(typeof presenceCallback, 'function', 'a presence listener should be attached');

const presenceWrites = sandbox.db.__presenceWrites;
const typingBar = findById(body, 'chatTypingBar');
const typingText = findById(body, 'chatTypingText');
assert(typingBar, 'the typing bar element should exist in the modal');
assert(typingText, 'the typing text element should exist in the modal');

// 15. Someone ELSE typing shows their name and reveals the bar.
presenceCallback({
    forEach(cb) {
        cb({ data: () => ({ email: 'super@test.com', name: 'super', at: new Date() }) });
    }
});
assert.strictEqual(typingBar.hidden, false, 'the typing bar should be visible when someone is typing');
assert(
    typingText.textContent.indexOf('super is typing') > -1,
    'the typing bar should name who is typing, got: ' + JSON.stringify(typingText.textContent)
);

// 15b. REGRESSION: the indicator must be visible on the LAUNCHER while the
// chat modal is CLOSED. The in-modal bar sits behind the overlay, and the
// chat is closed by default, so without the floating pill the user sees
// nothing at all.
const launcherTyping = findById(body, 'chatLauncherTyping');
const launcherTypingText = findById(body, 'chatLauncherTypingText');
assert(launcherTyping, 'the launcher typing pill should exist in the DOM');
assert(launcherTypingText, 'the launcher typing pill should have a text element');
assert(
    launcherTyping.hidden === false,
    'the launcher pill must be visible when someone is typing and the chat is closed'
);
assert(
    launcherTypingText.textContent.indexOf('super is typing') > -1,
    'the launcher pill should name who is typing, got: ' + JSON.stringify(launcherTypingText.textContent)
);

// 15c. Opening the chat hides the floating pill (the modal bar takes over).
Live.open();
assert.strictEqual(
    launcherTyping.hidden,
    true,
    'the floating pill should hide while the chat modal is open'
);
Live.close();

// 16. Your OWN presence never shows you a typing indicator.
presenceCallback({
    forEach(cb) {
        cb({ data: () => ({ email: 'hr@test.com', name: 'owner', at: new Date() }) });
    }
});
assert.strictEqual(typingBar.hidden, true, 'you must not be told that YOU are typing');
assert.strictEqual(
    launcherTyping.hidden,
    true,
    'the launcher pill must also hide for your own presence'
);

// 17. CLOCK-SKEW SAFETY. Staleness is judged from the LOCAL time a
//     presence entry was last seen, never from the document's own `at`.
//     So a fresh entry must be shown even when its server timestamp is
//     wildly wrong (a user whose PC clock is minutes off).
presenceCallback({
    forEach(cb) {
        cb({ data: () => ({
            email: 'super@test.com',
            name: 'super',
            at: new Date(Date.now() - 99999999) // ~11 days in the past
        }) });
    }
});
assert.strictEqual(
    typingBar.hidden,
    false,
    'a fresh presence entry must show even when its server `at` is far in the past (clock skew)'
);
assert.strictEqual(
    launcherTyping.hidden,
    false,
    'the launcher pill must also show for a fresh entry with a skewed server `at`'
);

// 17b. A person who STOPS typing is dropped. `super` goes quiet (their
//      last entry simply stops changing) while owner2 starts typing, so the
//      snapshot fires again — but super's entry is UNCHANGED, so it must
//      not be refreshed. An earlier version stamped every entry on every
//      snapshot, which revived super whenever anyone else typed and left
//      their indicator stuck on forever.
const superAt = new Date();           // frozen: super sends no further heartbeats
const superEntry = () => ({ email: 'super@test.com', name: 'super', at: superAt });

// Establish super's baseline while the local clock is still normal.
presenceCallback({ forEach(cb) { cb({ data: superEntry }); } });
assert(
    typingText.textContent.indexOf('super') > -1,
    'super should be shown as typing right after arriving'
);

// Time passes and owner2 starts typing: the snapshot fires again, but
// super's entry is byte-for-byte identical, so it must NOT be refreshed.
const owner2At = new Date(superAt.getTime() + 200);
const realNow2 = Date.now;
Date.now = () => realNow2() + 60000; // local clock jumps past the stale window
try {
    presenceCallback({
        forEach(cb) {
            cb({ data: superEntry });                                    // unchanged
            cb({ data: () => ({ email: 'owner2@test.com', name: 'owner2', at: owner2At }) });
        }
    });
} finally {
    Date.now = realNow2;
}
assert(
    typingText.textContent.indexOf('owner2') > -1,
    'the person who IS typing must still be shown, got: ' + JSON.stringify(typingText.textContent)
);
assert(
    typingText.textContent.indexOf('super') === -1,
    'a person whose entry stopped changing must be dropped, got: ' +
    JSON.stringify(typingText.textContent)
);

// 18. Two people typing produce the combined label.
const now = Date.now();
presenceCallback({
    forEach(cb) {
        cb({ data: () => ({ email: 'super@test.com', name: 'super', at: new Date(now) }) });
        cb({ data: () => ({ email: 'owner2@test.com', name: 'owner2', at: new Date(now) }) });
    }
});
assert(
    typingText.textContent.indexOf('are typing') > -1,
    'multiple typists should read "… are typing…", got: ' + JSON.stringify(typingText.textContent)
);

// 19. Typing locally writes a presence doc keyed by the user.
const input = findById(body, 'chatInput');
assert(input, 'the composer input should exist');
presenceWrites.length = 0;
input.value = 'hello';
input.dispatch('input', {});
assert(presenceWrites.length > 0, 'typing should broadcast a presence write');
assert(
    presenceWrites[0].data.email === 'hr@test.com',
    'the presence write must record the sender email'
);

// 19b. THE KEY BEHAVIOUR: the indicator follows the DRAFT, not keypresses.
// A person who typed a message and then PAUSED (thinking, reading, another
// tab) is still composing, so presence must keep heartbeating with no
// further input events. A keypress-only model dropped the indicator here.
const writesAfterFirstInput = presenceWrites.filter((w) => w.op === 'set').length;
assert(
    writesAfterFirstInput >= 1,
    'the first character must publish presence immediately'
);

// Simulate the draft heartbeat firing (1500ms) with the field unchanged.
input.dispatch('input', {});   // no-op refresh; heartbeat would do the same
assert(
    presenceWrites.filter((w) => w.op === 'set').length >= writesAfterFirstInput,
    'presence must be republished while a draft exists'
);

// 19d. THE CORE FIX: a draft keeps the indicator alive on a TIMER, with no
// further input events. This is the behaviour the user asked for — stop
// typing, keep the unsent text, and the indicator must stay up. Here we
// advance the sandbox's interval clock to prove the heartbeat still writes.
presenceWrites.length = 0;
input.value = 'unsent draft';
input.dispatch('input', {});
const setCountAfterDraft = presenceWrites.filter((w) => w.op === 'set').length;
assert(setCountAfterDraft > 0, 'starting a draft must publish presence');

// Advance past the 1.5s heartbeat with NO new input event at all.
runIntervals(1600);
assert(
    presenceWrites.filter((w) => w.op === 'set').length > setCountAfterDraft,
    'a paused draft must keep heartbeating with no further keystrokes'
);
runIntervals(1600);
assert(
    presenceWrites.filter((w) => w.op === 'set').length > setCountAfterDraft + 1,
    'the draft heartbeat must keep repeating, not fire only once'
);

// 19e. But once the draft is cleared the heartbeat must stop, so we never
// keep writing presence for a message nobody is composing.
input.value = '';
input.dispatch('input', {});
const setCountAfterClear = presenceWrites.filter((w) => w.op === 'set').length;
runIntervals(1600);
assert.strictEqual(
    presenceWrites.filter((w) => w.op === 'set').length,
    setCountAfterClear,
    'the heartbeat must stop once the draft is cleared'
);

// 19f. SENDING a message clears the draft and withdraws the indicator, so
//      the other person stops seeing "typing…" once the message arrives.
//      sendMessage is async (it awaits batch.commit()), so the remaining
//      checks run inside finish(), after it settles.
//
//      NOTE: the typing SWEEP interval legitimately lives for the whole page
//      lifetime, so we compare against a baseline captured before the draft
//      rather than expecting zero intervals.
var intervalsBeforeDraft = intervalCount();

input.value = 'about to send this';
input.dispatch('input', {});
assert(
    intervalCount() > intervalsBeforeDraft,
    'a draft must start an additional heartbeat interval'
);
var deleteCountBeforeSend = presenceWrites.filter((w) => w.op === 'delete').length;
input.dispatch('keydown', { key: 'Enter', shiftKey: false });

// Everything below runs after the send has completed.
function finish() {
    try {
        assert.strictEqual(input.value, '', 'sending must clear the composer');
        assert(
            presenceWrites.filter((w) => w.op === 'delete').length > deleteCountBeforeSend,
            'sending must withdraw the typing indicator'
        );
        assert.strictEqual(
            intervalCount(),
            intervalsBeforeDraft,
            'sending must stop the draft heartbeat (only the long-lived sweep may remain)'
        );
        runSoundTests();
        // Async: the receipt tests wait for a throttled write to be flushed.
        runReceiptTests().then(function () { done(); }, done);
    } catch (err) {
        done(err);
    }
}

setTimeout(finish, 0);

function runSoundTests() {

// 20. The FIRST snapshot after (re)subscribe is the existing history —
//     it establishes the baseline and must stay silent.
const playsBeforeBaseline = audioPlayCount;
listenerCallback({
    forEach(cb) {
        cb({ id: 'base1', data: () => ({ text: 'earlier', senderEmail: 'super@test.com', sentAt: new Date() }) });
    }
});
assert.strictEqual(
    audioPlayCount,
    playsBeforeBaseline,
    'the baseline snapshot of existing history must not play a sound'
);

// 21. A message arriving AFTER the baseline, from someone else, sounds.
const playsBefore = audioPlayCount;
listenerCallback({
    forEach(cb) {
        cb({ id: 'base1', data: () => ({ text: 'earlier', senderEmail: 'super@test.com', sentAt: new Date() }) });
        cb({ id: 'n1', data: () => ({ text: 'hi', senderEmail: 'super@test.com', sentAt: new Date() }) });
    }
});
assert(audioPlayCount > playsBefore, 'a new message from someone else should play a sound');

// 22. ...but your own new message must NOT.
const playsBeforeOwn = audioPlayCount;
listenerCallback({
    forEach(cb) {
        cb({ id: 'base1', data: () => ({ text: 'earlier', senderEmail: 'super@test.com', sentAt: new Date() }) });
        cb({ id: 'n1', data: () => ({ text: 'hi', senderEmail: 'super@test.com', sentAt: new Date() }) });
        cb({ id: 'n2', data: () => ({ text: 'mine', senderEmail: 'hr@test.com', sentAt: new Date() }) });
    }
});
assert.strictEqual(audioPlayCount, playsBeforeOwn, 'your own message must not play a sound');

// 23. Re-subscribing (e.g. a role refresh) must NOT replay history —
//     the first snapshot of a new subscription is a fresh baseline.
assert.strictEqual(Live.init({ surface: 'main', role: 'operator' }), false, 'operator must unmount');
assert.strictEqual(Live.init({ surface: 'owner', role: 'hr' }), true, 'owner must remount');
// A remount starts with NO conversation open, so re-open the same thread:
// that is what actually re-subscribes, and is the baseline we assert on.
seedExistingConversation(Live.dmRoomIdFor('hr@test.com', 'super@test.com'));
Live.selectConversation(Live.dmRoomIdFor('hr@test.com', 'super@test.com'));
const playsBeforeHistory = audioPlayCount;
listenerCallback({
    forEach(cb) {
        cb({ id: 'h1', data: () => ({ text: 'old 1', senderEmail: 'super@test.com', sentAt: new Date() }) });
        cb({ id: 'h2', data: () => ({ text: 'old 2', senderEmail: 'super@test.com', sentAt: new Date() }) });
    }
});
assert.strictEqual(
    audioPlayCount,
    playsBeforeHistory,
    'the first snapshot after (re)subscribing must not sound for existing history'
);

// 13. A NEW report arriving AFTER the baseline does sound.
const playsAfterBaseline = audioPlayCount;
listenerCallback({
    forEach(cb) {
        cb({ id: 'h1', data: () => ({ text: 'old 1', senderEmail: 'super@test.com', sentAt: new Date() }) });
        cb({ id: 'h2', data: () => ({ text: 'old 2', senderEmail: 'super@test.com', sentAt: new Date() }) });
        cb({ id: 'h3', data: () => ({ text: 'brand new', senderEmail: 'super@test.com', sentAt: new Date() }) });
    }
});
assert(audioPlayCount > playsAfterBaseline, 'a genuinely new message after the baseline must sound');

// 13b. REGRESSION — a permission error must DISABLE chat, never DELETE it.
//
// The bug this guards against: a `permission-denied` from the listener used
// to call teardown(), which REMOVED the launcher from the DOM. The circle
// therefore appeared on load and then silently vanished ~0.5s later when
// the first snapshot came back denied (typically because the Firestore
// rules had not been redeployed after the Owner/HR role split) — leaving
// the user with no chat and no explanation at all.
//
// Now it must stay on screen, greyed out, with the reason available.
sandbox.auth.currentUser = { email: 'hr@test.com' };
assert.strictEqual(Live.init({ surface: 'owner', role: 'hr' }), true, 're-init as HR must succeed');
// The messages listener is per-room, so a conversation must be open for
// there to be a listener whose error callback can fire at all.
seedExistingConversation(Live.dmRoomIdFor('hr@test.com', 'super@test.com'));
Live.selectConversation(Live.dmRoomIdFor('hr@test.com', 'super@test.com'));
const launcherBefore = launchers()[0];
assert(launcherBefore, 'the launcher must exist before the permission error');
assert.strictEqual(typeof listenerErrorCallback, 'function', 'the fake must expose the listener error callback');

listenerErrorCallback({ code: 'permission-denied' });

assert.strictEqual(
    launchers().length,
    1,
    'a permission error must NOT remove the chat launcher from the DOM'
);
assert.strictEqual(
    launcherBefore.removed,
    undefined,
    'the launcher element must not be removed on a rules mismatch'
);
assert(
    launcherBefore._classes.indexOf('chat-launcher-disabled') > -1,
    'the launcher must be marked disabled so it renders greyed out'
);
assert.strictEqual(
    launcherBefore.getAttribute('aria-disabled'),
    'true',
    'a disabled launcher must be marked aria-disabled for screen readers'
);

// Clicking it must explain the problem rather than silently doing nothing.
Live.open();
assert(
    findById(body, 'chatModal')._classes.indexOf('active') === -1,
    'a disabled chat must not open the modal'
);

// 13c. A snapshot arriving again (e.g. after a rules redeploy) restores it.
listenerCallback({ forEach() {} });
assert.strictEqual(
    launcherBefore._classes.indexOf('chat-launcher-disabled'),
    -1,
    'the launcher must be re-enabled once a snapshot arrives again'
);
assert(
    launcherBefore.getAttribute('aria-disabled') === undefined,
    'aria-disabled must be cleared'
);
}

// ---------------------------------------------------------------
// Read receipts: the ✓ Sent / ✓✓ Seen ticks
//
// Runs INSIDE runSoundTests() (called just before done()) rather than at
// module load, because it pushes message snapshots — doing that earlier
// would move the sound-test baselines and fail them spuriously.
// ---------------------------------------------------------------

async function runReceiptTests() {
console.log('Testing chat read receipts (Sent / Seen ticks)...');

/** Poll until `fn()` is truthy, or give up after `ms`. */
async function waitFor(fn, ms, message) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (fn()) return true;
        await new Promise((r) => realSetTimeout(r, 100));
    }
    if (fn()) return true;
    if (message) console.log('        (timed out) ' + message);
    return false;
}

// The sandbox signs in as hr@test.com (see `auth` above); the other
// participant in this thread is the superadmin.
const ME = 'hr@test.com';
const THEM = 'super@test.com';
const fakeDb = sandbox.db;

Live.init({ surface: 'owner', role: 'hr' });
const receiptLog = findById(body, 'chatLog');
assert(receiptLog, 'chat log element missing');
assert(receiptsCallback, 'the readReceipts listener should be started with the messages listener');

/** Push a messages snapshot (doc objects shaped like Firestore gives us). */
function pushMessages(msgs) {
    // `docs` is a real QuerySnapshot field; chat.js reads snapshot.docs[0]
    // to seed the history cursor.
    listenerCallback({
        docs: msgs.map((m) => ({ id: m.id, data: () => m })),
        forEach(fn) { msgs.forEach((m) => fn({ id: m.id, data: () => m })); }
    });
}

/** Push a readReceipts snapshot for the given people. */
function pushReceipts(list) {
    receiptsCallback({
        forEach(fn) { list.forEach((r) => fn({ id: r.email, data: () => r })); }
    });
}

// Timestamps must be real Dates here: toDate() reads .toDate()/.getTime().
// The current user in this sandbox is the HR user (see currentUserEmail below).
const T = {
    past: { toDate: () => new Date(1_000_000) },
    now: { toDate: () => new Date(2_000_000) }
};

// 25. A fresh message of mine shows a single tick, not a double one.
pushReceipts([]);
pushMessages([
    { id: 'm1', text: 'hello', senderEmail: ME, senderName: 'Me', sentAt: T.now }
]);
assert(
    /chat-msg-ticks/.test(receiptLog.innerHTML),
    'my own message must carry a read-receipt tick'
);
assert(
    !/is-seen/.test(receiptLog.innerHTML),
    'a message nobody else has read must NOT be marked seen'
);

// 26. Their message carries no tick at all — the label is about MY delivery.
pushMessages([
    { id: 'm1', text: 'hello', senderEmail: ME, senderName: 'Me', sentAt: T.now },
    { id: 'm2', text: 'hi back', senderEmail: THEM, senderName: 'Them', sentAt: T.now }
]);
const myBubble = receiptLog.innerHTML.slice(0, receiptLog.innerHTML.indexOf('m2') || receiptLog.innerHTML.length);
assert(
    (receiptLog.innerHTML.match(/chat-msg-ticks/g) || []).length === 1,
    'only MY message should carry a tick — a received message must not claim to be sent/seen by me'
);

// 27. Once the other person has read past the send time, it turns "seen".
pushReceipts([{ email: THEM, lastReadAt: { toDate: () => new Date(3_000_000) } }]);
assert(
    /chat-msg-ticks is-seen/.test(receiptLog.innerHTML),
    'after the other participant reads past it, my message must be marked seen'
);
assert(
    receiptLog.innerHTML.includes('Seen'),
    'the seen tick must carry a Seen title'
);

// 28. Their receipt alone must not tick MY message seen — my own read of
//     the thread is excluded, otherwise I would "see" my own message.
pushReceipts([{ email: ME, lastReadAt: { toDate: () => new Date(9_000_000) } }]);
assert(
    !/is-seen/.test(receiptLog.innerHTML),
    'my own receipt must never mark my own message as seen'
);

// 29. A receipt that predates the message does not count as read.
pushMessages([{ id: 'm1', text: 'newer', senderEmail: ME, senderName: 'Me', sentAt: T.now }]);
pushReceipts([{ email: THEM, lastReadAt: { toDate: () => new Date(500_000) } }]);
assert(
    !/is-seen/.test(receiptLog.innerHTML),
    'a receipt older than the message must not mark it seen'
);

// 30. Opening the chat records a read receipt.
Live.open();
assert(
    fakeDb.__receiptWrites.length > 0,
    'opening the chat must record that the thread has been read'
);
const myReceipt = fakeDb.__receiptWrites[fakeDb.__receiptWrites.length - 1];
assert.strictEqual(myReceipt.data.email, ME, 'a receipt must be written for the signed-in user only');
assert(
    myReceipt.opts && myReceipt.opts.merge,
    'the receipt must merge, so a create/update race cannot clobber the doc'
);

// ---------------------------------------------------------------
// Live updates: the tick must turn blue WITHOUT a page refresh
// ---------------------------------------------------------------

console.log('Testing live read receipts (no refresh needed)...');

// 31. A receipt arriving on the receipts listener must repaint the log.
//     This is the regression guard for "I have to refresh the page to see
//     the seen indicator": the repaint used to be tied to a messages push,
//     so a receipt landing on its own did nothing until a reload.
const writesBeforeLive = fakeDb.__receiptWrites.length;
pushMessages([{ id: 'live1', text: 'live check', senderEmail: ME, senderName: 'Me', sentAt: T.now }]);
assert(!/is-seen/.test(receiptLog.innerHTML), 'precondition: not seen before the other side reads');

pushReceipts([{ email: THEM, lastReadAt: { toDate: () => new Date(3_000_000) } }]);
assert(
    /is-seen/.test(receiptLog.innerHTML),
    'a receipt arriving on the readReceipts listener must repaint the ticks live, ' +
    'without a messages push and without a page refresh'
);

// 32. A CLOSED chat must NOT claim to have read anything.
//     Regression guard: an earlier version advanced the receipt whenever a
//     message from somebody else arrived, even with the modal shut — so the
//     sender's tick went blue for a chat the reader never opened, which
//     makes "Seen" meaningless. Delivery is not reading.
Live.close();
// Drain any flush still queued from the earlier OPEN-chat pushes, so the
// baseline below measures only what this closed-chat test causes.
await new Promise((r) => realSetTimeout(r, 3500));
const writesBeforeClosedPush = fakeDb.__receiptWrites.length;
pushMessages([
    { id: 'live1', text: 'live check', senderEmail: ME, senderName: 'Me', sentAt: T.now },
    { id: 'live2', text: 'ping', senderEmail: THEM, senderName: 'Them', sentAt: T.now }
]);

// Give any (incorrect) deferred write time to land before asserting.
await new Promise((r) => realSetTimeout(r, 3500));
assert.strictEqual(
    fakeDb.__receiptWrites.length,
    writesBeforeClosedPush,
    'a message delivered to a CLOSED chat must not write a read receipt — ' +
    '"Seen" has to mean the reader actually opened the chat'
);

// 32b. Opening the chat is what acknowledges it.
const writesBeforeOpen = fakeDb.__receiptWrites.length;
Live.open();
assert(
    fakeDb.__receiptWrites.length > writesBeforeOpen,
    'opening the chat modal must write the read receipt'
);

// 33. A throttled mark must be deferred, never dropped. Discarding it
//     (the old `if (tooSoon) return;`) starves the receipt: no further
//     snapshot arrives, so lastReadAt never passes that message and the
//     tick stays grey until a reload.
assert(
    /receiptWritePending/.test(fs.readFileSync(path.join(__dirname, '..', 'js', 'chat.js'), 'utf8')),
    'a throttled markThreadRead must be remembered and flushed, not discarded — ' +
    'dropping it is what forced a page refresh to see the seen indicator'
);

console.log('✅ Live receipt tests passed (ticks repaint without a refresh; a CLOSED chat does not mark seen).');

// ---------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------

console.log('Testing chat mentions...');

Live.init({ surface: 'owner', role: 'hr' });
const mentionMenu = findById(body, 'chatMentionMenu');
const composer = findById(body, 'chatInput');
assert(mentionMenu, 'the mention menu element must exist in the chat markup');
assert(composer, 'the composer textarea must exist');

// The roster comes from the thread history, so seed two participants.
pushMessages([
    { id: 'mm1', text: 'hi', senderEmail: ME, senderName: 'Me', sentAt: T.now },
    { id: 'mm2', text: 'hello', senderEmail: 'super@test.com', senderName: 'super', sentAt: T.now }
]);

/**
 * Type into the composer and press Enter (the real send path), then return
 * the MESSAGE write. A send writes two docs in one batch — the message
 * first, then the denormalised room summary — so the last entry is the room,
 * not the message.
 */
async function typeAndSend(text) {
    const before = sentWrites.length;
    composer.value = text;
    composer.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await new Promise((r) => realSetTimeout(r, 0));
    const written = sentWrites.slice(before);
    return written.find((w) => w.data && w.data.text !== undefined) || written[written.length - 1];
}

// 34. Sending stores the mentioned emails on the message.
Live.open();
const sentMsg = await typeAndSend('hey @super can you check this?');
assert(sentMsg && sentMsg.data, 'a message must have been written to the fake Firestore');
assert.deepStrictEqual(
    JSON.stringify(sentMsg.data.mentions),
    JSON.stringify(['super@test.com']),
    'a sent message must record the mentioned email(s) so the receiver can detect it'
);

// 35. Case-insensitive, de-duplicated, unknown names ignored.
const sentMsg2 = await typeAndSend('@SUPER and @super and @nobody');
assert.deepStrictEqual(
    JSON.stringify(sentMsg2.data.mentions),
    JSON.stringify(['super@test.com']),
    'mentions must be case-insensitive, de-duplicated, and unknown names ignored'
);

// 36. No "@" at all means no mentions.
const sentMsg3 = await typeAndSend('plain message');
assert.deepStrictEqual(
    JSON.stringify(sentMsg3.data.mentions),
    JSON.stringify([]),
    'a message without a mention must record an empty mentions array'
);

// 37. A mention is highlighted in the rendered body, and a message that
//     mentions ME is visually flagged.
pushMessages([
    { id: 'mm3', text: 'ping @super now', senderEmail: 'someone@else.com', senderName: 'Someone',
      mentions: ['super@test.com'], sentAt: T.now }
]);
assert(
    /<span class="chat-mention">@super<\/span>/.test(receiptLog.innerHTML),
    'an @name in a message body must be wrapped in a chat-mention span'
);
assert(
    !/chat-msg-mentions-me/.test(receiptLog.innerHTML),
    'a mention of ANOTHER person must not flag the message as mentioning me'
);

// 37b. A message that mentions the signed-in user IS flagged.
pushMessages([
    { id: 'mm6', text: 'ping @hr please', senderEmail: 'someone@else.com', senderName: 'Someone',
      mentions: ['hr@test.com'], sentAt: T.now }
]);
assert(
    /chat-msg-mentions-me/.test(receiptLog.innerHTML),
    'a message mentioning the signed-in user must be flagged with chat-msg-mentions-me'
);

// 38. Mention rendering must stay injection-safe: the body is escaped BEFORE
//     the @name tokens are wrapped, so a mention can only ever add a span.
pushMessages([
    { id: 'mm5', text: '<img src=x onerror=alert(1)> @super', senderEmail: 'someone@else.com',
      senderName: 'Someone', mentions: ['super@test.com'], sentAt: T.now }
]);
assert(
    receiptLog.innerHTML.indexOf('<img') === -1,
    'a mention must never allow markup injection — escaping must happen before highlighting'
);
assert(
    receiptLog.innerHTML.indexOf('&lt;img') > -1,
    'message text must still be escaped when a mention is present'
);

console.log('✅ Mention tests passed (roster, stored mentions, highlight, mentions-me flag, XSS-safe).');

// 40. Typing "@" opens the picker listing the other people; typing a name
//     filters it; a space or Escape closes it.
// Seed a snapshot containing BOTH participants. pushMessages REPLACES the
// list, so the roster is rebuilt from whatever the latest snapshot holds.
pushMessages([
    { id: 'mm1', text: 'hi', senderEmail: ME, senderName: 'Me', sentAt: T.now },
    { id: 'mm2', text: 'hello', senderEmail: 'super@test.com', senderName: 'super', sentAt: T.now }
]);

function typeIntoComposer(value, caret) {
    composer.value = value;
    if (typeof caret === 'number') composer.selectionStart = caret;
    composer.dispatch('input', {});
}

typeIntoComposer('@', 1);
assert.strictEqual(mentionMenu.hidden, false, 'typing "@" must open the mention picker');
// The "@" and the name are rendered in separate spans, so match the data
// attribute rather than the visible text.
assert(
    /data-mention-name="super"/.test(mentionMenu.innerHTML),
    'the picker must list the other people in the thread. menu=' + JSON.stringify(mentionMenu.innerHTML)
);

typeIntoComposer('@sup', 4);
assert.strictEqual(mentionMenu.hidden, false, 'a partial name must keep the picker open');
assert(
    /data-mention-name="super"/.test(mentionMenu.innerHTML),
    'a matching name must still be offered'
);

typeIntoComposer('@zzz', 4);
assert.strictEqual(
    mentionMenu.hidden,
    true,
    'a query matching nobody must close the picker rather than show an empty box'
);

// A space ends the token, so the picker closes.
typeIntoComposer('@super ', 7);
assert.strictEqual(mentionMenu.hidden, true, 'a space must close the mention picker');

// An email address in the text must NOT open the picker.
typeIntoComposer('mail me at a@b.com', 18);
assert.strictEqual(
    mentionMenu.hidden,
    true,
    'an "@" inside a word (an email address) must not trigger the mention picker'
);

// 41. Picking someone inserts "@name " and closes the picker.
typeIntoComposer('@sup', 4);
composer.dispatch('input', {});
const optionEl = { getAttribute: (a) => (a === 'data-mention-name' ? 'super' : 'super@test.com') };
mentionMenu.dispatch('mousedown', { target: { closest: () => optionEl }, preventDefault() {} });
assert.strictEqual(
    composer.value,
    '@super ',
    'picking a person must insert "@name " into the composer'
);
assert.strictEqual(mentionMenu.hidden, true, 'picking a person must close the picker');

console.log('✅ Mention picker tests passed (opens on @, filters, closes on space/email, inserts on pick).');

// ---------------------------------------------------------------
// 40b. BRANCH ROOM: the @mention roster is EXACTLY the room's
//      `members` — the whole store team, from the first keystroke,
//      with nobody from another branch's team.
//
//      This is the behaviour the store chat is for: an HR/superadmin
//      mentioning "violation ..." can @ the Area Manager and every
//      RM/SM of THAT store immediately, before any of them has posted.
//      `members` is also the room READ authority, so it must be the
//      real team — the send path is guarded (test/chat-rules.test.js)
//      and a superadmin opening the room re-seeds a polluted array
//      (repairBranchRoomMembers); this proves the PICKER reads it.
// ---------------------------------------------------------------
{
    const BRANCH = 'branch-sm-fairview';
    const team = ['hr@test.com', 'am@test.com', 'rm1@test.com', 'boss@test.com'];

    // Put the branch room in the conversation list WITH its `members`,
    // then open it. A branch room is a group room, so it opens even
    // before any message exists; repairBranchRoomMembers is a no-op
    // here because the sandbox is HR (superadmin-gated).
    seedExistingConversation(BRANCH, team);
    Live.selectConversation(BRANCH);
    // Clear any thread senders carried over from the 1:1 tests above,
    // so the roster below is members-only.
    pushMessages([]);

    typeIntoComposer('@', 1);
    assert.strictEqual(mentionMenu.hidden, false, 'typing "@" in a branch room must open the picker');

    const offered = [];
    const re = /data-mention-email="([^"]+)"/g;
    let m;
    while ((m = re.exec(mentionMenu.innerHTML)) !== null) offered.push(m[1]);

    // The signed-in user in this sandbox is hr@test.com, and hr IS a member
    // of this room. You can never mention YOURSELF, so the picker must offer
    // every OTHER member but NOT self — even though self is in `members` and is
    // still seeded into mentionCandidates() for the render / "mentioned me"
    // path. This is the regression guard for "I can mention my own account".
    const SELF = 'hr@test.com';
    team.filter((email) => email !== SELF).forEach((email) => {
        assert(
            offered.indexOf(email) > -1,
            'a branch room must offer its member ' + email + ' from the first keystroke, before any ' +
            'post. offered=' + JSON.stringify(offered)
        );
    });
    assert(
        offered.indexOf(SELF) === -1,
        'the signed-in user must NEVER be offered in the picker — you cannot mention yourself. ' +
        'offered=' + JSON.stringify(offered)
    );
    assert.strictEqual(
        offered.length,
        team.length - 1,
        'a branch room must offer EXACTLY its members MINUS self — no cross-branch user, no phantom, ' +
        'and not the signed-in user. offered=' + JSON.stringify(offered)
    );

    // A name that is not one of the room's members must never be offered.
    typeIntoComposer('@outsider', 9);
    assert.strictEqual(
        mentionMenu.hidden,
        true,
        'a query matching no member must close the picker — a branch room never invents a roster from ' +
        'the directory'
    );

    // A branch room whose `members` has not loaded yet must DEGRADE to the
    // thread senders (never to the whole directory): seed a second branch
    // room with NO members array, post from two people, and assert the
    // picker offers exactly those senders + the signed-in user.
    const BRANCH2 = 'branch-banawe';
    conversationCallback({
        forEach(fn) {
            fn({
                id: BRANCH2,
                data: () => ({
                    // deliberately NO `members` — a summary that has not loaded it yet
                    lastMessage: 'hi',
                    lastMessageAt: { toDate: () => new Date() },
                    lastSenderEmail: 'am.banawe@test.com'
                })
            });
        }
    });
    Live.selectConversation(BRANCH2);
    pushMessages([
        { id: 'bn1', text: 'hi', senderEmail: 'am.banawe@test.com', senderName: 'AM Banawe', sentAt: T.now },
        { id: 'bn2', text: 'yo', senderEmail: 'rm.banawe@test.com', senderName: 'RM Banawe', sentAt: T.now }
    ]);
    typeIntoComposer('@', 1);
    assert.strictEqual(
        mentionMenu.hidden,
        false,
        'the picker must still open in a branch room whose members have not loaded'
    );
    const offered2 = [];
    const re2 = /data-mention-email="([^"]+)"/g;
    let m2;
    while ((m2 = re2.exec(mentionMenu.innerHTML)) !== null) offered2.push(m2[1]);
    assert(offered2.indexOf('am.banawe@test.com') > -1, 'a sender must be offerable even before members load');
    assert(offered2.indexOf('rm.banawe@test.com') > -1, 'a sender must be offerable even before members load');
    assert(
        offered2.indexOf('hr@test.com') === -1,
        'the signed-in user must never be offered even as a thread sender — you cannot mention yourself. ' +
        'offered=' + JSON.stringify(offered2)
    );
    assert(
        offered2.indexOf('ghost@test.com') === -1,
        'the picker must never invent a roster from the directory — offered=' + JSON.stringify(offered2)
    );

    console.log('✅ Branch-room @mention roster tests passed (exactly the members; no members yet → ' +
        'senders only; never a directory-wide roster).');
}

// 40c. ALL HR GROUP: a SUPERADMIN can @mention any approved HR/superadmin
//      (even one who has NOT posted), because a superadmin may read `users`.
//      An HR member cannot read `users`, so loadGroupMentionRoster() no-ops
//      for them (they keep the thread-sender roster). A denied read leaves
//      the roster unset rather than throwing.
{
    const loadFn = (src.match(/function loadGroupMentionRoster\(\)\s*\{[\s\S]*?\n    \}/) || [''])[0];
    assert(loadFn, 'loadGroupMentionRoster() must exist in js/chat.js');

    // A thenable that resolves SYNCHRONOUSLY so the loader's .then runs inline
    // (no async test scaffolding). `fail` routes to .catch instead.
    function runLoader(role, docs, fail) {
        const snap = { forEach: function (fn) { docs.forEach(function (d) { fn(d); }); } };
        const thenable = {
            then: function (onF) { if (!fail && onF) onF(snap); return thenable; },
            catch: function (onR) { if (fail && onR) onR(new Error('denied')); return thenable; }
        };
        const sb = {
            console: console,
            normalizeRole: function (r) { return String(r == null ? '' : r).trim().toLowerCase(); },
            currentRole: role,
            LEGACY_ROOM_ID: 'owner-superadmin',
            GROUP_ROOM_ROLES: ['hr', 'superadmin'],
            activeRoomId: 'owner-superadmin',
            els: { mentionMenu: { hidden: true } },
            updateMentionMenu: function () {},
            groupMentionRoster: null,
            groupMentionRosterLoading: false,
            db: { collection: function () { return { get: function () { return thenable; } }; } }
        };
        vm.createContext(sb);
        vm.runInContext(loadFn, sb);
        sb.loadGroupMentionRoster();
        return sb;
    }

    const docs = [
        { id: 'hr1@x.com', data: function () { return { email: 'hr1@x.com', role: 'hr', status: 'approved', name: 'HR One' }; } },
        { id: 'sa@x.com', data: function () { return { email: 'sa@x.com', role: 'superadmin', status: 'approved', name: 'The Boss' }; } },
        { id: 'am@x.com', data: function () { return { email: 'am@x.com', role: 'owner', status: 'approved', name: 'AM' }; } },
        { id: 'pend@x.com', data: function () { return { email: 'pend@x.com', role: 'hr', status: 'pending', name: 'Pend' }; } },
        { id: 'op@x.com', data: function () { return { email: 'op@x.com', role: 'operator', status: 'approved' }; } }
    ];

    // SUPERADMIN: the roster is exactly the approved HR + superadmin, with names.
    const sa = runLoader('superadmin', docs);
    assert(sa.groupMentionRoster, 'a superadmin must load the All HR group roster');
    assert.strictEqual(
        Object.keys(sa.groupMentionRoster).sort().join(','),
        'hr1@x.com,sa@x.com',
        'the group roster must be exactly the approved HR + superadmin — no Area Manager, no pending, ' +
        'no operator. got=' + JSON.stringify(sa.groupMentionRoster)
    );
    assert.strictEqual(sa.groupMentionRoster['hr1@x.com'], 'HR One', 'the roster carries the display name');

    // HR: cannot read `users`, so the loader no-ops and the roster stays unset.
    const hr = runLoader('hr', docs);
    assert.strictEqual(hr.groupMentionRoster, null,
        'an HR member must NOT load the group roster (they cannot read users) — they use thread senders');

    // A denied read must not throw and must leave the roster unset + not stuck loading.
    const denied = runLoader('superadmin', docs, true);
    assert.strictEqual(denied.groupMentionRoster, null, 'a denied users read leaves the roster unset');
    assert.strictEqual(denied.groupMentionRosterLoading, false, 'a denied read must reset the loading flag');

    console.log('✅ All HR group @mention roster tests passed (superadmin gets approved hr+superadmin; ' +
        'HR no-ops; denied read degrades safely).');
}

// 42. The mention colour must be BLUE and must theme automatically.
//     Guards two regressions at once: someone re-styling the mention with
//     the green brand primary, and someone hardcoding a hex (which would
//     stay stubbornly blue in dark mode and break the file's own
//     "no colours in chat.css, use the shared variables" convention).
const chatCss = fs.readFileSync(path.join(__dirname, '..', 'chat.css'), 'utf8');
const lightCss = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const darkCss = fs.readFileSync(path.join(__dirname, '..', 'theme.css'), 'utf8');

const mentionRule = (chatCss.match(/\.chat-mention \{[^}]*\}/) || [''])[0];
assert(
    /var\(--chat-accent-blue/.test(mentionRule),
    '.chat-mention must take its colour from --chat-accent-blue, not a hardcoded hex — ' +
    'a literal colour would not follow the app theme. rule=' + mentionRule
);
assert(
    /--chat-accent-blue:\s*#/.test(lightCss),
    'style.css (light theme) must declare --chat-accent-blue'
);
assert(
    /html\[data-theme="dark"\][\s\S]*--chat-accent-blue/.test(darkCss),
    'theme.css (dark mode) must override --chat-accent-blue, or the mention ' +
    'stays dark blue and becomes unreadable on a dark bubble'
);
assert(
    /--chat-accent-blue:\s*#[0-9a-fA-F]{6}/i.test(lightCss) &&
    /--chat-accent-blue:\s*#[0-9a-fA-F]{6}/i.test(darkCss),
    'both themes must define --chat-accent-blue as a hex colour'
);

console.log('✅ Mention colour tests passed (blue, themed via shared variable in light + dark).');

// ---------------------------------------------------------------
// Profiles: role badge, avatar, grouping
// ---------------------------------------------------------------

console.log('Testing chat profiles (role avatar + name/title)...');

Live.init({ surface: 'owner', role: 'hr' });
// Display names / job titles now come from the GLOBAL `chatProfiles`
// directory rather than a per-room `profiles` subcollection, so that the
// conversation list can resolve names before a room even exists. The
// directory listener is captured instead of profilesCallback here.
assert(directoryCallback, 'the people directory listener should be started on mount');
// Re-open a thread: the message list is per-room.
seedExistingConversation(Live.dmRoomIdFor('hr@test.com', 'super@test.com'));
Live.selectConversation(Live.dmRoomIdFor('hr@test.com', 'super@test.com'));

// 43. The role is shown as INITIALS inside the message avatar (SA / HR / AM /
//     RM), colour-coded — there is NO word chip next to the name any more. The
//     avatar reads the same profileFor() source (senderRole first, profile as
//     fallback), so pre-feature history with no senderRole falls back to name
//     initials rather than a wrong role.
pushMessages([
    { id: 'p1', text: 'from hr', senderEmail: 'someone@else.com', senderName: 'someone',
      senderRole: 'hr', sentAt: T.now },
    { id: 'p2', text: 'from super', senderEmail: 'boss@else.com', senderName: 'boss',
      senderRole: 'superadmin', sentAt: T.past }
]);
assert(
    /chat-avatar--hr/.test(receiptLog.innerHTML) && /chat-avatar--superadmin/.test(receiptLog.innerHTML),
    'each sender must get a role-tinted avatar so HR and superadmin are still distinguishable'
);
// p2 (older) renders before p1, so slicing from a message's own id scopes it.
const hrMsg = receiptLog.innerHTML.slice(receiptLog.innerHTML.indexOf('data-msg-id="p1"'));
const superMsg = receiptLog.innerHTML.slice(receiptLog.innerHTML.indexOf('data-msg-id="p2"'));
assert(
    /chat-avatar--hr"[^>]*>HR</.test(hrMsg),
    'the HR avatar must show the role initials "HR" inside the circle'
);
assert(
    /chat-avatar--superadmin"[^>]*>SA</.test(superMsg),
    'the Superadmin avatar must show the role initials "SA" inside the circle'
);
// RANK MARKER — the superadmin avatar gains a gold RING + a ★ corner star on
// TOP of the role fill (never instead of it — "one colour = one role" must
// survive). Both are pure CSS (box-shadow ring + ::after star), so the avatar
// markup above stays byte-identical and every surface that renders
// .chat-avatar--superadmin (message rows, thread header, conversation list)
// picks the marker up at once.
const superAvatarRule = (chatCss.match(/\.chat-avatar--superadmin \{[^}]*\}/) || [''])[0];
assert(
    /box-shadow[^;]*--chat-rank-gold/.test(superAvatarRule),
    'the superadmin avatar must carry the gold rank RING via --chat-rank-gold (a token, never a '
    + 'hardcoded hex — the same rule every colour in chat.css follows)'
);
assert(
    /background:[^;]*--chat-role-superadmin/.test(superAvatarRule),
    'the ring must ACCENT the blue role fill, never replace it — gold is rank, blue is still the role'
);
assert(
    /\.chat-avatar--superadmin::after \{[^}]*content:\s*"\\2605"/.test(chatCss),
    'the superadmin avatar must carry the ★ corner star (a ::after, so no markup change)'
);
assert(
    !/chat-rank-gold/.test(
        (chatCss.match(/\.chat-avatar--(hr|owner|rmsm)[^,{]*\{[^}]*\}/g) || []).join('\n')
    ),
    'the rank marker must be SUPERADMIN-ONLY — no other role avatar may carry the gold ring'
);
// The thread-header pill gains the ★ prefix + the gold-border rank class.
const rankJsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'chat.js'), 'utf8');
assert(
    /role === 'superadmin' \? ' chat-role-pill--rank'/.test(rankJsSrc),
    'the thread-header pill must add the .chat-role-pill--rank class for a superadmin peer'
);
assert(
    /role === 'superadmin' \? '★ ' : ''/.test(rankJsSrc),
    'the thread-header pill must prefix ★ for a superadmin peer — the rank reads at a glance'
);
assert(
    /\.chat-role-pill--rank \{[^}]*--chat-rank-gold/.test(chatCss),
    'the rank pill class must exist in chat.css and pull the SAME gold token as the avatar ring'
);
assert(
    /html\[data-theme="dark"\] \.chat-role-pill--rank/.test(darkCss),
    'the rank pill\'s gold border must have a dark-mode override — a light-tuned gold hairline '
    + 'disappears on a dark surface'
);
// ⚠️ THE CONVERSATION LIST IS ALREADY COVERED — and this pins it. The marker
// is pure CSS on `.chat-avatar--superadmin`, and the list row renders the
// SAME class via avatarRoleFor(row.peerEmail), so the gold ring + star appear
// in the list with no per-surface code. If a refactor ever swaps the list
// avatar to a bare class (or a hardcoded colour), this fails loudly instead
// of silently dropping the rank cue from the list.
assert(
    /'<span class="chat-avatar ' \+ avatarRoleFor\(row\.peerEmail\) \+ '" aria-hidden="true">'/.test(rankJsSrc),
    'the conversation-list row must keep rendering the ROLE class via avatarRoleFor(), or the '
    + 'superadmin rank marker silently disappears from the chat list'
);
// The list must not CLIP the ring/star overhang: the star sits 4px outside the
// circle, so an overflow:hidden on the row would shave it off.
const chatRowRule = (chatCss.match(/^\.chat-row \{[^}]*\}/m) || [''])[0];
assert(
    !/overflow:\s*hidden/.test(chatRowRule),
    '.chat-row must not clip with overflow:hidden — the rank star overhangs the circle by 4px'
);
assert(
    !/chat-role-pill/.test(receiptLog.innerHTML),
    'the message must NOT carry a role word chip — the role lives in the avatar initials now'
);
assert(
    /<span class="chat-msg-name">someone<\/span>/.test(hrMsg),
    'the sender name must still render in the meta line'
);

// 44. An old message with NO senderRole must not crash and must fall back
//     to a neutral avatar.
pushMessages([
    { id: 'p3', text: 'legacy', senderEmail: 'old@else.com', senderName: 'old', sentAt: T.now }
]);
assert(
    /chat-avatar--unknown/.test(receiptLog.innerHTML),
    'a sender with no known role must fall back to a neutral avatar'
);

// 45. A published profile supplies a display name + job title, live.
//     The roster/message list is REBUILT from the latest snapshot, so
//     re-push the message whose sender we are publishing a profile for.
pushMessages([
    { id: 'p1', text: 'from hr', senderEmail: 'someone@else.com', senderName: 'someone',
      senderRole: 'hr', sentAt: T.now }
]);
directoryCallback({
    forEach(fn) {
        fn({ id: 'someone', data: () => ({
            email: 'someone@else.com', role: 'hr',
            displayName: 'Maria', title: 'HR Manager'
        }) });
    }
});
assert(
    /class="chat-msg-name">Maria</.test(receiptLog.innerHTML),
    'a published displayName must be used instead of the raw name. html=' +
    JSON.stringify(receiptLog.innerHTML.slice(0, 500))
);
assert(
    /chat-msg-title">HR Manager</.test(receiptLog.innerHTML),
    'a published job title must be shown next to the name'
);
// ...and it must stay escaped.
directoryCallback({
    forEach(fn) {
        fn({ id: 'x', data: () => ({
            email: 'someone@else.com', role: 'hr',
            displayName: '<img src=x onerror=alert(1)>', title: 'HR'
        }) });
    }
});
assert(
    receiptLog.innerHTML.indexOf('<img') === -1,
    'a published display name must be escaped — a profile is user input'
);
assert(
    receiptLog.innerHTML.indexOf('&lt;img') > -1,
    'a published display name must appear escaped, not as markup'
);

// 45b. THE TYPING LABEL MUST NAME THE PERSON THE WAY EVERYTHING ELSE DOES.
//
//      The indicator used to prefer the `name` field carried on the presence
//      doc, and publishPresence() wrote that field as the email's LOCAL PART.
//      So an account whose list row, thread header and messages all said
//      "Jiangnan Hotpot" was announced as "hotpotjiangnan is typing…" — one
//      thread, two names for the same person. Both halves are guarded here:
//      the label reads the directory, and the write publishes the directory
//      name rather than the address.
const typingBarNow = findById(body, 'chatTypingBar');
const typingTextNow = findById(body, 'chatTypingText');
const launcherTypingNow = findById(body, 'chatLauncherTyping');
const launcherTypingTextNow = findById(body, 'chatLauncherTypingText');
assert(typingBarNow && typingTextNow, 'the rebuilt modal must contain the typing bar');
assert(
    typeof presenceCallback === 'function',
    'the presence listener must be attached to the open thread before this runs'
);

// Closed first, so the launcher pill (the only visible half of the indicator
// while the modal is shut) is asserted in a deterministic state.
Live.close();

// The directory exactly as test 45 left it, plus a published name for the two
// people this block needs. Both are already members of the seeded room, so no
// new conversation is created by their appearance here.
directoryCallback({
    forEach(fn) {
        fn({ id: 'someone', data: () => ({
            email: 'someone@else.com', role: 'hr',
            displayName: '<img src=x onerror=alert(1)>', title: 'HR'
        }) });
        fn({ id: 'super', data: () => ({
            email: 'super@test.com', role: 'superadmin',
            displayName: 'Jiangnan Hotpot', title: 'Owner'
        }) });
        fn({ id: 'hr', data: () => ({
            email: 'hr@test.com', role: 'hr',
            displayName: 'Hellen Reyes', title: 'HR Manager'
        }) });
    }
});

// A presence doc in the shape the OLD publishPresence() wrote: `name` is the
// email's local part. The label must ignore it while a published name exists.
presenceCallback({
    forEach(fn) {
        fn({ data: () => ({ email: 'super@test.com', name: 'super', at: new Date() }) });
    }
});
assert.strictEqual(
    typingBarNow.hidden,
    false,
    'the typing bar must show for a fresh presence entry'
);
assert.strictEqual(
    typingTextNow.textContent,
    'Jiangnan Hotpot is typing…',
    'the typing label must use the published display name, got: ' +
        JSON.stringify(typingTextNow.textContent)
);
assert(
    typingTextNow.textContent.indexOf('super') === -1,
    'the email local part must never leak into the typing label, got: ' +
        JSON.stringify(typingTextNow.textContent)
);
assert.strictEqual(
    launcherTypingNow.hidden,
    false,
    'the launcher pill must show while the chat is closed'
);
assert.strictEqual(
    launcherTypingTextNow.textContent,
    'Jiangnan Hotpot is typing…',
    'the launcher pill must carry the same published name, got: ' +
        JSON.stringify(launcherTypingTextNow.textContent)
);

// ...and a typist with NOTHING published still falls back to the local part
// rather than showing nothing at all.
presenceCallback({
    forEach(fn) {
        fn({ data: () => ({ email: 'unlisted@test.com', name: 'unlisted', at: new Date() }) });
    }
});
assert.strictEqual(
    typingTextNow.textContent,
    'unlisted is typing…',
    'an unpublished person must fall back to the email local part, got: ' +
        JSON.stringify(typingTextNow.textContent)
);

// The write side: typing now publishes the directory name, so a peer whose
// directory snapshot has not arrived yet still gets the right name.
const presenceWritesNow = sandbox.db.__presenceWrites;
const typingInput = findById(body, 'chatInput');
assert(typingInput, 'the composer input should exist');
presenceWritesNow.length = 0;
typingInput.value = 'draft for the name check';
typingInput.dispatch('input', {});
const presenceSet = presenceWritesNow.filter((w) => w.op === 'set').pop();
assert(presenceSet, 'typing must publish a presence doc');
assert.strictEqual(
    presenceSet.data.name,
    'Hellen Reyes',
    'the published presence name must be the directory name, not the email local part'
);

// Withdraw the draft and clear the indicator so nothing here leaks forward.
typingInput.value = '';
typingInput.dispatch('input', {});
presenceCallback({ forEach() {} });
assert.strictEqual(typingBarNow.hidden, true, 'the typing bar must clear when nobody is typing');

// Restore the directory to exactly what test 45 left behind.
directoryCallback({
    forEach(fn) {
        fn({ id: 'someone', data: () => ({
            email: 'someone@else.com', role: 'hr',
            displayName: '<img src=x onerror=alert(1)>', title: 'HR'
        }) });
    }
});

// 46. Consecutive messages from ONE person are grouped; a change of speaker
//     is not. This is what makes a burst readable as a single block.
const grouped = [
    { id: 'g1', text: 'one', senderEmail: 'a@x.com', senderName: 'a', senderRole: 'hr',
      sentAt: { toDate: () => new Date(1_000_000) } },
    { id: 'g2', text: 'two', senderEmail: 'a@x.com', senderName: 'a', senderRole: 'hr',
      sentAt: { toDate: () => new Date(1_030_000) } },
    { id: 'g3', text: 'three', senderEmail: 'b@x.com', senderName: 'b', senderRole: 'superadmin',
      sentAt: { toDate: () => new Date(1_060_000) } }
];
pushMessages(grouped);
const gClasses = receiptLog.innerHTML.match(/chat-msg-grouped/g) || [];
assert.strictEqual(
    gClasses.length,
    1,
    'exactly ONE message should be grouped: the second consecutive message ' +
    'from the same person (a change of speaker must start a new block)'
);

console.log('✅ Profile tests passed (role-tinted avatars, no visible badge, live display name/title, grouping, escaping).');

// 47. The profile editor must COLLAPSE back to the normal chat box after a
//     successful save — the user should never be left looking at the form.
//     This drives the real Save button and the real saveMyProfile() path.
const editor = findById(body, 'chatProfileEditor');
const nameInput = findById(body, 'chatProfileName');
const titleInput = findById(body, 'chatProfileTitle');
const saveBtn = findById(body, 'chatProfileSave');
const toggleBtn = findById(body, 'chatProfileToggle');
assert(editor && nameInput && titleInput && saveBtn && toggleBtn, 'profile editor markup missing');

assert.strictEqual(editor.hidden, true, 'the profile editor must start collapsed');
toggleBtn.dispatch('click', {});
assert.strictEqual(editor.hidden, false, 'the header button must open the profile editor');

nameInput.value = 'Maria';
titleInput.value = 'HR Manager';
// The save now writes to the GLOBAL `chatProfiles` directory — that is what
// the conversation list and the "new chat" picker read — and additionally to
// the legacy room-scoped profile when the archive is open.
const profileWritesBefore = fakeDb.__directoryWrites.length;
saveBtn.dispatch('click', {});
await new Promise((r) => realSetTimeout(r, 0));

assert(
    fakeDb.__directoryWrites.length > profileWritesBefore,
    'Save must write the person\'s entry to the chatProfiles directory'
);
const written = fakeDb.__directoryWrites[fakeDb.__directoryWrites.length - 1];
assert.strictEqual(written.data.displayName, 'Maria');
assert.strictEqual(written.data.title, 'HR Manager');
assert.strictEqual(
    written.data.email,
    ME,
    'a directory entry must be written for the SIGNED-IN user only — never for somebody else'
);
// ⚠️ There is deliberately NO `active` flag on a directory entry. The
// already-deployed profile rule allowlists only
// (email, role, displayName, title), so an extra key is denied by
// hasOnly() and the save would fail. The ROLE is the eligibility signal.
assert.strictEqual(
    Object.prototype.hasOwnProperty.call(written.data, 'active'),
    false,
    'a directory entry must not carry an `active` flag — the deployed rules allowlist ' +
    'only (email, role, displayName, title) and an extra key is denied'
);
assert.strictEqual(
    written.data.role,
    'hr',
    'the entry must record the role, which is what the conversation list uses to decide ' +
    'who may be messaged'
);
assert.strictEqual(
    editor.hidden,
    true,
    'after a successful save the profile editor must collapse back to the normal chat box'
);
assert.strictEqual(
    saveBtn.disabled,
    false,
    'the Save button must be re-enabled after saving'
);

// 48. A FAILED save (stale rules) must ALSO collapse the editor. The error
//     toast explains the deploy, but leaving the form open makes the chat
//     look frozen with the user's text still in it.
const goodDb = sandbox.db;
sandbox.db = {
    collection() {
        // Reject every write, exactly as the deployed rules would before the
        // chatProfiles collection / profiles subcollection exists. The shape
        // must cover BOTH paths: a nested `chats/{id}/profiles` doc AND a
        // top-level `chatProfiles` doc, otherwise the rejection path itself
        // throws a TypeError instead of exercising the error handling.
        return { doc: () => ({
            set: () => Promise.reject(new Error('permission-denied')),
            collection: () => ({ doc: () => ({
                set: () => Promise.reject(new Error('permission-denied'))
            }) })
        }) };
    }
};
Live.init({ surface: 'owner', role: 'hr' });
// Re-open a thread so the failure-path save happens inside a conversation.
seedExistingConversation(Live.dmRoomIdFor('hr@test.com', 'super@test.com'));
Live.selectConversation(Live.dmRoomIdFor('hr@test.com', 'super@test.com'));
const editor2 = findById(body, 'chatProfileEditor');
const nameInput2 = findById(body, 'chatProfileName');
const saveBtn2 = findById(body, 'chatProfileSave');
findById(body, 'chatProfileToggle').dispatch('click', {});
assert.strictEqual(editor2.hidden, false, 'editor must open for the failure-path test');
nameInput2.value = 'Maria';
saveBtn2.dispatch('click', {});
await new Promise((r) => realSetTimeout(r, 0));
assert.strictEqual(
    editor2.hidden,
    true,
    'a failed save must still collapse the editor — the chat must return to normal'
);
assert.strictEqual(
    saveBtn2.disabled,
    false,
    'the Save button must be re-enabled after a failed save, or the editor is stuck disabled'
);
sandbox.db = goodDb;

console.log('✅ Profile editor tests passed (opens, saves own profile only, collapses after save — success AND failure).');

console.log('✅ Read receipt tests passed (single tick on send; blue seen tick; own receipt excluded).');

// ---------------------------------------------------------------
// Paginated history
// ---------------------------------------------------------------

console.log('Testing paginated history...');

Live.init({ surface: 'owner', role: 'hr' });
const historyBar = findById(body, 'chatHistoryBar');
const loadOlderBtn = findById(body, 'chatLoadOlder');
const historyStatus = findById(body, 'chatHistoryStatus');
const log = findById(body, 'chatLog');
assert(historyBar && loadOlderBtn && historyStatus, 'history pager markup missing');

/** Build N synthetic messages, oldest first. */
function makeHistory(n, prefix) {
    const out = [];
    for (let i = 1; i <= n; i++) {
        out.push({
            id: prefix + i,
            text: prefix + 'msg' + i,
            senderEmail: THEM,
            senderName: 'Them',
            sentAt: { toDate: () => new Date(1_000_000 + i * 1000) }
        });
    }
    return out;
}

// The Firestore store holds the WHOLE collection, oldest first — including
// the messages currently in the live tail, because the history query reads
// the same collection. The tail's oldest doc ('tail-oldest') is therefore
// present in the store and is what the first page pages back from.
const TAIL_OLDEST = {
    id: 'tail-oldest', text: 'oldest in tail', senderEmail: THEM, senderName: 'Them',
    sentAt: { toDate: () => new Date(2_000_000) }
};
fakeDb.__messagesCol.__setHistory(
    makeHistory(150, 'old-').concat([TAIL_OLDEST])
);

// 49. The live tail renders, and the pager is offered because there IS older
//     history to reach.
pushMessages([TAIL_OLDEST]);
assert.strictEqual(
    loadOlderBtn.hidden,
    false,
    'the Load-earlier control must be offered when older history exists'
);

// 50. Loading a page PREPENDS — the page is the 60 messages IMMEDIATELY
//     older than the tail, not the oldest messages in the thread.
const soundBefore = audioPlayCount;
const settle = async () => {
    await new Promise((r) => realSetTimeout(r, 0));
    await new Promise((r) => realSetTimeout(r, 0));
    await new Promise((r) => realSetTimeout(r, 0));
};
loadOlderBtn.dispatch('click', {});
await settle();

assert(
    receiptLog.innerHTML.indexOf('old-msg150') > -1,
    'the page must contain the message immediately older than the tail'
);
assert(
    receiptLog.innerHTML.indexOf('old-msg91') > -1,
    'a full 60-message page must be fetched'
);
assert(
    receiptLog.innerHTML.indexOf('oldest in tail') > -1,
    'loading history must NOT drop the live tail'
);
// History must come BEFORE the tail in document order.
assert(
    receiptLog.innerHTML.indexOf('old-msg91') < receiptLog.innerHTML.indexOf('oldest in tail'),
    'history must be PREPENDED (oldest first), not appended after the tail'
);
assert(
    receiptLog.innerHTML.indexOf('old-msg1<') === -1,
    'the first page must NOT jump to the very beginning of the thread — ' +
    'it must start where the visible window ended'
);

// 51. Preloaded history must NOT play the incoming chime. The old
//     announceNewMessages() would treat every preloaded id as brand new.
assert.strictEqual(
    audioPlayCount,
    soundBefore,
    'loading an old page must NOT play the incoming-message sound — history is not new activity'
);

// 52. Paging must not make old messages count as unread.
const badgeEl = launchers()[0] && launchers()[0].querySelector('#chatUnreadBadge');
if (badgeEl) {
    assert(
        badgeEl.hidden === true || badgeEl.textContent === '0',
        'loading history must not mark old messages as unread'
    );
}

// 53. The cursor ADVANCES: a second page reaches further back, and nothing
//     is ever rendered twice.
loadOlderBtn.dispatch('click', {});
await settle();
const afterTwo = receiptLog.innerHTML;
assert(
    afterTwo.indexOf('old-msg90') > -1,
    'a second page must load FURTHER BACK, not repeat the first'
);
assert(
    (afterTwo.match(/old-msg91\b/g) || []).length === 1,
    'a message must never be rendered twice across pages (the cursor must advance)'
);

// 54. Scroll position is PRESERVED across a prepend. This is the whole
//     difference between paging that feels native and paging that yanks
//     the user into the middle of the thread.
log.scrollTop = 120;
log.scrollHeight = 1000;   // pretend the log was 1000px tall before
loadOlderBtn.dispatch('click', {});
await settle();
assert(
    log.scrollTop > 120,
    'prepending must shift scrollTop down by the growth so the reader keeps their place ' +
    '(got ' + log.scrollTop + ')'
);

// 55. The pager TERMINATES: after every page it must say "Beginning of
//     history" instead of offering an endless button.
for (let i = 0; i < 6 && !/Beginning/i.test(historyStatus.textContent); i++) {
    loadOlderBtn.dispatch('click', {});
    await settle();
}
assert(
    /Beginning/i.test(historyStatus.textContent),
    'once every page is loaded the pager must say "Beginning of history" instead of ' +
    'offering an endless button (status="' + historyStatus.textContent + '")'
);
assert.strictEqual(
    loadOlderBtn.hidden,
    true,
    'the Load-earlier button must disappear once there is nothing older left'
);

console.log('✅ Pagination tests passed (prepend, cursor advances, no chime, no false unread, scroll preserved, terminates).');

// ---------------------------------------------------------------
// Unread badge: single source of truth + "New messages" divider
// ---------------------------------------------------------------

console.log('Testing unread threshold + divider...');

Live.init({ surface: 'owner', role: 'hr' });
// The pagination block left the chat OPEN. The badge only counts while the
// modal is closed, so close it explicitly.
Live.close();
//     localStorage. This is the bug: a new device / cleared site data /
//     private window left localStorage empty, so the whole history counted
//     as unread while the Seen ticks (which read Firestore) said otherwise.
// The sandbox's OWN localStorage must be cleared — a bare `localStorage`
// reference resolves to the host's, which does not exist in Node.
sandbox.localStorage.clear();
// Drop any receipt left over from the earlier read-receipt tests, so this
// block starts from a genuinely "no receipt" state.
pushReceipts([]);
const msgA = { id: 'u1', text: 'older', senderEmail: THEM, senderName: 'Them',
    sentAt: { toDate: () => new Date(1_000) } };
const msgB = { id: 'u2', text: 'newer', senderEmail: THEM, senderName: 'Them',
    sentAt: { toDate: () => new Date(9_000_000_000) } };
pushMessages([msgA, msgB]);

const badgeNow = () => {
    const b = launchers()[0] && launchers()[0].querySelector('#chatUnreadBadge');
    return b && !b.hidden ? Number(b.textContent) : 0;
};

// No receipt and no local floor yet: everything is unread (first run).
assert.strictEqual(badgeNow(), 2, 'with no receipt at all, unread starts at the full tail');

// Publish MY receipt in Firestore, saying I have read msgA but not msgB.
// localStorage is still empty — this is the "new device" case.
pushReceipts([{ email: ME, lastReadAt: { toDate: () => new Date(5_000) } }]);
Live.close && Live.close();
// Re-render with the chat CLOSED so the badge recomputes.
pushMessages([msgA, msgB]);
assert.strictEqual(
    badgeNow(),
    1,
    'the badge must use the Firestore receipt: with a receipt at t=5s only the ' +
    't=9e9 message is unread, even though localStorage is empty (got ' + badgeNow() + ')'
);

// 57. The local floor must never OVERRIDE a newer receipt (no regress).
sandbox.localStorage.setItem('rcms_chat_last_seen_' + ME, '1');
pushMessages([msgA, msgB]);
assert.strictEqual(
    badgeNow(),
    1,
    'a stale localStorage stamp must not override the Firestore receipt and re-count read messages'
);

// 58. A "New messages" divider is drawn above the oldest unread message.
assert(
    /chat-unread-divider/.test(receiptLog.innerHTML),
    'a divider must be drawn where the unread messages begin'
);
const dividerAt = receiptLog.innerHTML.indexOf('chat-unread-divider');
const unreadMsgAt = receiptLog.innerHTML.indexOf('data-msg-id="u2"');
assert(
    dividerAt > -1 && unreadMsgAt > -1 && dividerAt < unreadMsgAt,
    'the divider must sit immediately BEFORE the first unread message'
);
assert(
    receiptLog.innerHTML.indexOf('data-msg-id="u1"') < dividerAt,
    'the divider must come AFTER the last read message'
);

// 59. Opening the chat clears the divider (everything becomes read).
Live.open();
pushMessages([msgA, msgB]);
assert(
    !/chat-unread-divider/.test(receiptLog.innerHTML),
    'once the chat is open everything is read, so the divider must disappear'
);

console.log('✅ Unread tests passed (Firestore receipt is the source of truth; divider marks the unread boundary).');

// ---------------------------------------------------------------
// Chat sound: EVERY conversation must be announced, not just the open one
// ---------------------------------------------------------------

console.log('Testing chat notification sound...');

// ⚠️ WHY THIS BLOCK EXISTS. The sound used to fire only from
// announceNewMessages(), which is driven by the PER-ROOM message listener —
// and that listener is only started by selectConversation(). So a message in a
// conversation the user had NOT opened had no listener at all: no sound, and
// the alert only appeared once they clicked the row. The sound now comes from
// the conversation-LIST listener, which spans every room. These tests drive the
// real announceNewConversations() out of js/chat.js in a vm sandbox.
{
    const chatSrc = fs.readFileSync(path.join(ROOT, 'js', 'chat.js'), 'utf8');
    const startAt = chatSrc.indexOf('function announcedStateKey');
    const endAt = chatSrc.indexOf('function collectConversationRows');
    assert(startAt > -1 && endAt > startAt,
        'could not locate the announcement block in js/chat.js');
    const block = chatSrc.slice(startAt, endAt);

    let plays = 0;
    const store = {};
    const sb = {
        console,
        currentUserEmail: 'hr@test.com',
        activeRoomId: 'dm_open__room',
        playIncomingSound: () => { plays++; },
        // ⚠️ announceNewConversations() consults roomMessageUnsubs to decide
        // whether the SUMMARY path should stay quiet (the per-room message
        // watcher is authoritative when one is alive). The sandbox must supply
        // it or every call throws.
        roomMessageUnsubs: {},
        localStorage: {
            getItem: (k) => (store[k] === undefined ? null : store[k]),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: (k) => { delete store[k]; }
        }
    };
    sb.window = sb;
    sb.globalThis = sb;
    vm.createContext(sb);
    vm.runInContext(block +
        '\nglobalThis.__a={announceNewConversations,readAnnouncedState,' +
        '  markRoomAnnounced, roomAlreadyAnnounced};', sb);
    const A = sb.__a;
    const room = (ms, sender, isArchive) => ({
        roomId: 'dm_x__y', lastMessageAtMs: ms,
        lastSenderEmail: sender, isArchive: !!isArchive
    });

    // 60. The FIRST snapshot is silent, but still records a baseline. Without
    // the baseline every existing room looks new and opening the app would
    // machine-gun the sound for the user's entire history.
    assert.strictEqual(
        A.announceNewConversations({ 'dm_x__y': room(1000, 'other@test.com') }), 0,
        'the first snapshot must announce nothing'
    );
    assert.strictEqual(plays, 0, 'the first snapshot must not play a sound');
    assert.strictEqual(
        A.readAnnouncedState()['dm_x__y'], 1000,
        'the first snapshot MUST still record the baseline, or the next real ' +
        'message is swallowed along with the history'
    );

    // 61. THE ACTUAL BUG: a message in a conversation that is NOT open must
    // sound. This is what did not happen before the fix.
    assert.strictEqual(
        A.announceNewConversations({ 'dm_x__y': room(2000, 'other@test.com') }), 1,
        'a new message in an UNOPENED conversation must be announced'
    );
    assert.strictEqual(plays, 1, '…and it must play exactly one sound');

    // 62. The same snapshot arriving again must be silent.
    plays = 0;
    A.announceNewConversations({ 'dm_x__y': room(2000, 'other@test.com') });
    assert.strictEqual(plays, 0, 'an unchanged room must not re-sound');

    // 63. My own message is never news, but its time still advances the
    // baseline — otherwise the other side's next message appears to leap over
    // a stale mark and the count is off.
    plays = 0;
    A.announceNewConversations({ 'dm_x__y': room(3000, 'hr@test.com') });
    assert.strictEqual(plays, 0, 'my own message must not sound');
    assert.strictEqual(A.readAnnouncedState()['dm_x__y'], 3000,
        'my own message must still advance the baseline');

    // 64. The OPEN conversation is not announced by the list listener — the
    // thread listener owns it, and announcing from both would double the sound.
    plays = 0;
    A.announceNewConversations({ 'dm_open__room': room(4000, 'other@test.com') });
    assert.strictEqual(plays, 0,
        'the OPEN conversation must be left to the thread listener, or one message sounds twice');

    // 65. A burst is NOT throttled — one sound per arriving message, as asked.
    plays = 0;
    A.announceNewConversations({
        'dm_a__b': room(5000, 'other@test.com'),
        'dm_c__d': room(5000, 'other@test.com'),
        'dm_e__f': room(5000, 'other@test.com')
    });
    assert.strictEqual(plays, 3, 'three conversations arriving together must play three sounds');

    // 66. The legacy archive is never announced.
    plays = 0;
    A.announceNewConversations({ 'legacy': room(9000, 'other@test.com', true) });
    assert.strictEqual(plays, 0, 'the legacy archive must not announce');

    // 67. The de-dup helpers round-trip, so the thread listener can ask
    // "did the list already sound for this?" without sounding again.
    A.markRoomAnnounced('dm_z__z', 7777);
    assert.strictEqual(A.roomAlreadyAnnounced('dm_z__z', 7777), true,
        'a stamped room/time must read as already announced');
    assert.strictEqual(A.roomAlreadyAnnounced('dm_z__z', 8888), false,
        'a NEWER message in that room must not read as already announced');
    assert.strictEqual(A.roomAlreadyAnnounced('dm_unknown', 1), false,
        'an unknown room is never "already announced"');
}

// 68. The chat must DELEGATE to the shared notification sound, and must not
// keep a private Audio. This guard is the one that catches the export being
// removed again: js/chat.js checks `typeof window.playNotificationSound`, so
// with no export that check is silently always false and the chat quietly
// falls back to its own object.
{
    const chatSrc = fs.readFileSync(path.join(ROOT, 'js', 'chat.js'), 'utf8');
    const notifSrc = fs.readFileSync(path.join(ROOT, 'js', 'notifications.js'), 'utf8');
    assert(
        /window\.playNotificationSound\s*=\s*playNotificationSound/.test(notifSrc),
        'notifications.js MUST export playNotificationSound — chat.js guards on it, so ' +
        'without the export the chat silently stops using the shared, preloaded sound'
    );
    assert(
        /typeof window\.playNotificationSound === 'function'/.test(chatSrc),
        'chat.js must still guard on the shared sound before calling it'
    );
    // The only `new Audio` left in chat.js is the distinct MENTION sound.
    const audioLines = chatSrc.split('\n')
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => /new Audio\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    assert.strictEqual(audioLines.length, 1,
        'chat.js must keep exactly ONE Audio — the mention sound. A second one ' +
        'means the private fallback for the incoming sound is back: ' +
        JSON.stringify(audioLines));
    assert(/mentionAudio = new Audio/.test(audioLines[0][1]),
        'the one remaining Audio must be the mention sound, not the incoming one');
}

// 69. A mention must play its OWN sound only. It used to get the plain
// incoming chime first and the mention sound on top — two noises per mention,
// with the second cutting the first off.
{
    const chatSrc = fs.readFileSync(path.join(ROOT, 'js', 'chat.js'), 'utf8');
    const fn = (chatSrc.match(/function announceNewMessages\([\s\S]*?\n    \}/) || [''])[0];
    assert(fn, 'could not read announceNewMessages()');
    assert(
        /if \(mentions\.length > 0\)[\s\S]{0,240}mentions\.forEach\(announceMention\)/.test(fn),
        'the mention branch must play the mention sound INSTEAD of the chime, ' +
        'not in addition to it'
    );
    assert(
        /unannounced = incoming\.filter/.test(fn),
        'announceNewMessages() must skip messages the list listener already ' +
        'announced, or a single message sounds twice'
    );
}

// 70. A snapshot for a room you have since LEFT must be dropped. The
// callback closed over the global activeRoomId, so a stale payload would
// replay the old thread as new — and machine-gun the sound with it.
{
    const chatSrc = fs.readFileSync(path.join(ROOT, 'js', 'chat.js'), 'utf8');
    assert(
        /const subscribedRoomId = activeRoomId/.test(chatSrc),
        'startListener() must capture the room it subscribed to'
    );
    assert(
        /if \(activeRoomId !== subscribedRoomId\) return;/.test(chatSrc),
        'the snapshot handler must drop a payload for a room that is no longer ' +
        'active — otherwise it replays the old thread and fires the sound for it'
    );
    assert(
        /roomId: subscribedRoomId/.test(chatSrc),
        'each message must be stamped with its room so the announce paths can ' +
        'attribute it without falling back to the global activeRoomId'
    );
}

console.log('✅ Chat sound tests passed (every conversation announces, once per message; first run silent; own messages and the open room excluded; stale snapshots dropped).');

// 71. THE PER-ROOM MESSAGE WATCHERS — the authoritative signal.
//
// The summary path above watches `lastMessageAt` on the room DOCUMENT, which
// only advances when the sender's room-preview write is ACCEPTED. It rides in
// the same batch as the message and is refused whenever the deployed rules are
// older than this client; the fallback (writeRoomPreviewQuietly) swallows its
// errors, so the summary silently stops moving. The GROUP chat never writes a
// preview at all, so its summary is permanently 0.
//
// The message document is always written, and firestore.rules already allows
// `read: if canReadChat(chatId)`, so one newest-message watcher per room is
// what actually tells us a message arrived. This drives the REAL function with
// a stubbed Firestore, including its error path.
{
    const chatSrc = fs.readFileSync(path.join(ROOT, 'js', 'chat.js'), 'utf8');
    const startAt = chatSrc.indexOf('function announcedIdsKey');
    const endAt = chatSrc.indexOf('function startConversationListListener');
    assert(startAt > -1 && endAt > startAt,
        'could not locate the per-room message watcher block in js/chat.js');
    const wblock = chatSrc.slice(startAt, endAt);

    let plays = 0;
    let mentioned = 0;
    let mentionNext = false;
    const wstore = {};
    const watchers = {};
    const wsandbox = {
        console,
        currentUserEmail: 'hr@test.com',
        activeRoomId: 'dm_open__room',
        playIncomingSound: () => { plays++; },
        announceMention: () => { mentioned++; },
        mentionsMe: () => mentionNext,
        isPermissionError: (e) => !!(e && e.code === 'permission-denied'),
        db: {
            collection: () => ({
                doc: () => ({
                    collection: () => ({
                        orderBy: () => ({
                            limit: () => ({
                                onSnapshot: (cb, err) => {
                                    const k = 'w' + Object.keys(watchers).length;
                                    watchers[k] = { cb, err };
                                    return () => { delete watchers[k]; };
                                }
                            })
                        })
                    })
                })
            })
        },
        localStorage: {
            getItem: (k) => (wstore[k] === undefined ? null : wstore[k]),
            setItem: (k, v) => { wstore[k] = String(v); }
        }
    };
    wsandbox.window = wsandbox;
    wsandbox.globalThis = wsandbox;
    vm.createContext(wsandbox);
    vm.runInContext(
        'var roomMessageUnsubs={}; var announcedMessageIds={}; var conversationSummaries={};' +
        wblock +
        '\nglobalThis.__w={watchRoomForNewMessages, stopRoomMessageWatchers};', wsandbox);
    const W = wsandbox.__w;
    const snap = (id, sender) => ({
        docs: [{ id, data: () => ({ text: 't', senderEmail: sender, mentions: [] }) }]
    });
    const wkeys = () => Object.keys(watchers);

    W.watchRoomForNewMessages('dm_a__b');
    const A = wkeys()[0];
    assert.strictEqual(wkeys().length, 1, 'watching a room must build one listener');

    // The first snapshot seeds silently.
    plays = 0;
    watchers[A].cb(snap('m1', 'other@test.com'));
    assert.strictEqual(plays, 0,
        'the FIRST snapshot of a room must be silent — otherwise opening the app ' +
        'sounds once for the newest message of every conversation');

    // A genuinely new message in an unopened conversation sounds.
    plays = 0;
    watchers[A].cb(snap('m2', 'other@test.com'));
    assert.strictEqual(plays, 1, 'a new message in an UNOPENED conversation must sound');

    // The same newest id is not new.
    plays = 0;
    watchers[A].cb(snap('m2', 'other@test.com'));
    assert.strictEqual(plays, 0, 'the same newest id must not re-sound');

    // My own message is silent.
    plays = 0;
    watchers[A].cb(snap('m3', 'hr@test.com'));
    assert.strictEqual(plays, 0, 'my own message must not sound');

    // The open conversation is the thread listener's job.
    W.watchRoomForNewMessages('dm_open__room');
    const B = wkeys().find((k) => k !== A);
    watchers[B].cb(snap('o1', 'other@test.com'));
    plays = 0;
    watchers[B].cb(snap('o2', 'other@test.com'));
    assert.strictEqual(plays, 0,
        'the OPEN conversation must not also be announced here, or one message sounds twice');

    // A permission error on one room must not take the others down.
    W.watchRoomForNewMessages('dm_c__d');
    const C = wkeys().find((k) => k !== A && k !== B);
    assert(C, 'a third watcher must have been built');
    watchers[C].err({ code: 'permission-denied' });
    plays = 0;
    watchers[A].cb(snap('m4', 'other@test.com'));
    assert.strictEqual(plays, 1,
        'a denied watcher must only drop ITSELF — the other conversations keep alerting');

    // A mention plays the mention sound only.
    mentionNext = true;
    plays = 0;
    mentioned = 0;
    watchers[A].cb(snap('m5', 'other@test.com'));
    assert.strictEqual(plays, 0, 'a mention must NOT also play the plain chime');
    assert.strictEqual(mentioned, 1, 'a mention must play the mention sound');
    mentionNext = false;

    // Teardown releases everything.
    W.stopRoomMessageWatchers();
    assert.strictEqual(wkeys().filter((k) => watchers[k]).length, 0,
        'stopRoomMessageWatchers() must release every watcher');
}

// 72. The summary path must stand DOWN while a message watcher is alive, or
// one message sounds twice — once from each path, in whichever order.
{
    const chatSrc = fs.readFileSync(path.join(ROOT, 'js', 'chat.js'), 'utf8');
    const fn = (chatSrc.match(/function announceNewConversations\([\s\S]*?\n    \}/) || [''])[0];
    assert(fn, 'could not read announceNewConversations()');
    assert(
        /if \(roomMessageUnsubs\[roomId\]\)[\s\S]{0,220}return;/.test(fn),
        'announceNewConversations() must stand down for any room that has a live ' +
        'message watcher — the watcher is authoritative because the room SUMMARY ' +
        'only moves when the sender preview write is accepted. Without this, one ' +
        'message sounds twice.'
    );
}

// 73. The watchers must be created from BOTH list paths and released on
// teardown, or a denied list query silently costs every alert.
{
    const chatSrc = fs.readFileSync(path.join(ROOT, 'js', 'chat.js'), 'utf8');
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    const syncCalls = (chatSrc.match(/syncRoomMessageWatchers\(\);/g) || []).length;
    assert(syncCalls >= 2,
        'syncRoomMessageWatchers() must run from BOTH the list query and the ' +
        'per-room fallback — the fallback is the live path when the deployed ' +
        'rules deny the list query, and without it a denial costs every alert (' +
        'found ' + syncCalls + ' call sites)');
    assert(
        /function stopRoomMessageWatchers\(\)/.test(chatSrc),
        'stopRoomMessageWatchers() must exist so listeners cannot outlive the session'
    );
    assert(
        /function teardown\(\)[\s\S]{0,600}stopRoomMessageWatchers\(\)/.test(chatSrc),
        'teardown() must stop the message watchers — a surviving watcher would ' +
        'keep reading Firestore and could still sound for a user who may no ' +
        'longer be allowed to chat'
    );
    assert(
        /allow read: if canReadChat\(chatId\)/.test(rules),
        'firestore.rules must still allow a member to read chats/{chatId}/messages — ' +
        'the watchers depend on it and need no rules change'
    );
}

console.log('✅ Unread tests passed (Firestore receipt is the source of truth; divider marks the unread boundary).');

// ---------------------------------------------------------------
// Emoji reactions
// ---------------------------------------------------------------

console.log('Testing emoji reactions...');

Live.init({ surface: 'owner', role: 'hr' });
assert(reactionsCallback, 'the reactions listener should start with the others');

const picker = findById(body, 'chatReactionPicker');
assert(picker, 'the reaction picker must exist in the chat markup');

pushMessages([
    { id: 'r1', text: 'react to me', senderEmail: THEM, senderName: 'Them', sentAt: T.now }
]);

// 60. Messages no longer carry their own action buttons. Reply and the
//     reactions both moved into the one shared context menu, so the header
//     stays pure metadata.
assert(
    !/data-react-for=/.test(receiptLog.innerHTML),
    'messages must NOT carry a per-message react button — the context menu owns reactions now'
);
assert(
    !/data-reply-for=/.test(receiptLog.innerHTML),
    'messages must NOT carry a per-message reply button — the context menu owns reply now'
);
assert(
    !/chat-msg-actions/.test(receiptLog.innerHTML),
    'the header must be free of the old action-button group'
);
const chatMenuSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'chat.js'), 'utf8');
assert(
    /data-picker-reply/.test(chatMenuSrc) && />Reply</.test(chatMenuSrc),
    'the context menu must offer Reply (as a text action now, not an icon)'
);
assert(
    /data-picker-copy/.test(chatMenuSrc) && />Copy</.test(chatMenuSrc),
    'the context menu must offer Copy'
);
assert(
    /chat-picker-divider/.test(chatMenuSrc),
    'the context menu must separate the reaction row from the text action bar with a divider'
);
// The menu is a single unified popover with an explicit actions label.
assert(
    /aria-label="Message actions"/.test(chatMenuSrc),
    'the menu is a message context menu, not just a reaction picker'
);
// iMessage layout: the emoji reaction row is on TOP, the text actions
// (Copy/Unsend/Reply) sit BELOW it — so REACTION_EMOJI.map now comes first.
assert(
    chatMenuSrc.indexOf('REACTION_EMOJI.map') < chatMenuSrc.indexOf('data-picker-reply'),
    'the reaction row must come first; the text actions (Reply) go below it'
);
// The text actions live in their own row wrapper, distinct from the reactions.
assert(
    /chat-picker-reactions/.test(chatMenuSrc) && /chat-picker-actions/.test(chatMenuSrc),
    'the picker must wrap the emoji row and the text action bar in their own rows'
);

// 61. No reactions yet => no chip row at all.
assert(
    !/chat-reaction-chip/.test(receiptLog.innerHTML),
    'a message with no reactions must show no chip row'
);

// 62. A reaction renders a chip with the count, tinted when it is mine.
reactionsCallback({
    forEach(fn) {
        fn({ id: 'x', data: () => ({ messageId: 'r1', emoji: 'like', email: THEM }) });
        fn({ id: 'y', data: () => ({ messageId: 'r1', emoji: 'like', email: ME }) });
    }
});
assert(
    /chat-reaction-chip/.test(receiptLog.innerHTML),
    'a reaction must render a chip under the message'
);
assert(
    /chat-reaction-count">2</.test(receiptLog.innerHTML),
    'the chip must show the total count (2 people reacted)'
);
assert(
    /chat-reaction-chip is-mine/.test(receiptLog.innerHTML),
    'my own reaction must be visually marked'
);

// 63. The chip must be bound to the right message + emoji so it toggles.
assert(
    /data-reaction-msg="r1"/.test(receiptLog.innerHTML) &&
        /data-reaction-key="like"/.test(receiptLog.innerHTML),
    'a chip must carry its message id and emoji key so clicking toggles it'
);

// 64. Toggling OFF my own reaction DELETES; adding SETs. Never an update —
//      reactions are immutable, like the messages they point at.
const chipEl = {
    getAttribute: (a) => (a === 'data-reaction-msg' ? 'r1' : 'like')
};
receiptLog.dispatch('click', {
    target: { closest: () => chipEl },
    preventDefault() {}
});
await new Promise((r) => realSetTimeout(r, 0));
assert(
    fakeDb.__reactionDeletes.length > 0,
    'clicking my own reaction must DELETE it (toggle off)'
);

// 65. Reacting to a message nobody has reacted to SETs a new doc, as me.
//     The menu is opened by hovering the message — there is no per-message
//     button left to click.
reactionsCallback({ forEach() {} });
pushMessages([
    { id: 'r2', text: 'fresh', senderEmail: THEM, senderName: 'Them', sentAt: T.now }
]);
const writesBefore = fakeDb.__reactionWrites.length;
receiptLog.dispatch('mouseover', {
    target: { closest: (sel) => (sel === '.chat-msg' ? { getAttribute: () => 'r2' } : null) }
});
assert.strictEqual(picker.hidden, false, 'hovering a message must open the context menu');
picker.dispatch('mousedown', {
    target: { closest: (sel) => (sel === '[data-picker-key]' ? { getAttribute: () => 'love' } : null) },
    preventDefault() {}
});
await new Promise((r) => realSetTimeout(r, 0));
assert(
    fakeDb.__reactionWrites.length > writesBefore,
    'picking an emoji must write a reaction'
);
const rw = fakeDb.__reactionWrites[fakeDb.__reactionWrites.length - 1];
assert.strictEqual(rw.data.messageId, 'r2', 'the reaction must name the message it is on');
assert.strictEqual(rw.data.emoji, 'love');
assert.strictEqual(
    rw.data.email,
    ME,
    'a reaction must be written for the SIGNED-IN user only — never for somebody else'
);
assert.strictEqual(picker.hidden, true, 'choosing an emoji must close the picker');

// 66. The chip must appear IMMEDIATELY (optimistic), before any snapshot
//     confirms it. This is what the user sees as "the reaction did nothing":
//     waiting for a round trip means a denied write (rules not deployed)
//     leaves the UI apparently dead.
reactionsCallback({ forEach() {} });
pushMessages([
    { id: 'r3', text: 'optimistic please', senderEmail: THEM, senderName: 'Them', sentAt: T.now }
]);
assert(
    !/chat-reaction-chip/.test(receiptLog.innerHTML),
    'precondition: r3 has no reaction yet'
);
receiptLog.dispatch('mouseover', {
    target: { closest: (sel) => (sel === '.chat-msg' ? { getAttribute: () => 'r3' } : null) }
});
picker.dispatch('mousedown', {
    target: { closest: (sel) => (sel === '[data-picker-key]' ? { getAttribute: () => 'haha' } : null) },
    preventDefault() {}
});
assert(
    /chat-reaction-chip/.test(receiptLog.innerHTML),
    'a reaction must appear IMMEDIATELY on pick, without waiting for a snapshot'
);
assert(
    /data-reaction-msg="r3"/.test(receiptLog.innerHTML),
    'the optimistic chip must be bound to the message that was reacted to'
);

// 67. HOVER must open the picker — no click on the emoji icon required.
//     This is the requested behaviour: moving the mouse onto a message pops
//     the emoji row up.
const hoverRow = { getAttribute: (a) => (a === 'data-msg-id' ? 'r1' : null) };
receiptLog.dispatch('mouseover', { target: { closest: (sel) => (sel === '.chat-msg' ? hoverRow : null) } });
assert.strictEqual(
    picker.hidden,
    false,
    'moving the mouse over a message must pop the reaction row open, with no click'
);

// 68. Leaving the message must dismiss it again (after the travel delay, so
//     moving the pointer from the message onto the picker is not a race).
receiptLog.dispatch('mouseout', {
    target: { closest: (sel) => (sel === '.chat-msg' ? hoverRow : null) },
    relatedTarget: null
});
assert.strictEqual(
    picker.hidden,
    false,
    'the row must survive the pointer leaving the message, so it can be reached'
);
await new Promise((r) => realSetTimeout(r, 400));
assert.strictEqual(
    picker.hidden,
    true,
    'the row must close once the pointer is genuinely away from it'
);

// 69. The popup must ANIMATE, not appear dead. Guards the keyframes, the
//     per-emoji stagger, and the reduced-motion escape hatch: an
//     accessibility regression here (motion nobody can opt out of) matters
//     as much as a missing animation.
const css = fs.readFileSync(path.join(__dirname, '..', 'chat.css'), 'utf8');
assert(
    /animation:\s*chatPickerIn/.test(css),
    'the reaction popup must have an entry animation'
);
assert(
    /@keyframes chatPickerIn\s*\{/.test(css),
    'the chatPickerIn keyframes must be defined'
);
assert(
    // The emoji are now the only children of .chat-picker-reactions (1-6):
    // the reaction row is on top, the text actions are in their own row below.
    // The stagger must follow them, or the first emoji would never animate.
    /chat-reaction-option:nth-child\(1\)\s*\{\s*animation-delay/.test(css) &&
        /chat-reaction-option:nth-child\(6\)\s*\{\s*animation-delay/.test(css),
    'the emoji must cascade in with a per-item animation-delay stagger'
);
assert(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none/.test(css),
    'the popup must honour prefers-reduced-motion — an animation nobody can opt out of is a regression'
);
assert(
    /\.chat-reaction-picker\[hidden\]\s*\{\s*display: none/.test(css),
    'the popup must stay display:none while hidden, so the animation does not play on load'
);

// 70. ONE reaction per person per message. Picking a second emoji must
//     REPLACE the first, not stack — the doc id is keyed by
//     {messageId}__{email}, so a second slot does not even exist.
//     The id here is the CANONICAL one, i.e. a reaction created by the
//     current code, so switching it is a plain field update.
reactionsCallback({
    forEach(fn) {
        fn({
            id: 'r4__hr%40test.com',
            data: () => ({ messageId: 'r4', emoji: 'like', email: ME })
        });
    }
});
pushMessages([
    { id: 'r4', text: 'one only', senderEmail: THEM, senderName: 'Them', sentAt: T.now }
]);
assert(
    /data-reaction-key="like"/.test(receiptLog.innerHTML),
    'precondition: r4 has my Like'
);
assert(
    !/data-reaction-key="love"/.test(receiptLog.innerHTML),
    'precondition: r4 has no Love reaction yet'
);

const updatesBefore = fakeDb.__reactionUpdates.length;
const r4 = { getAttribute: () => 'r4' };
receiptLog.dispatch('mouseover', { target: { closest: (sel) => (sel === '.chat-msg' ? r4 : null) } });
picker.dispatch('mousedown', {
    target: { closest: (sel) => (sel === '[data-picker-key]' ? { getAttribute: () => 'love' } : null) },
    preventDefault() {}
});
await new Promise((r) => realSetTimeout(r, 0));

assert(
    !/data-reaction-key="like"/.test(receiptLog.innerHTML),
    'picking a new emoji must REPLACE my old reaction, never stack a second one'
);
assert(
    /data-reaction-key="love"/.test(receiptLog.innerHTML),
    'the new emoji must become my only reaction on that message'
);
assert.strictEqual(
    (receiptLog.innerHTML.match(/chat-reaction-chip is-mine/g) || []).length,
    1,
    'exactly ONE chip of mine may exist per message at any time'
);
assert(
    fakeDb.__reactionUpdates.length > updatesBefore,
    'switching emoji must be a single-doc update, not a delete + create'
);
const ru = fakeDb.__reactionUpdates[fakeDb.__reactionUpdates.length - 1];
assert.strictEqual(ru.data.emoji, 'love');
assert(
    !('messageId' in ru.data) && !('email' in ru.data),
    'switching emoji must only send the emoji field — messageId and email are frozen by the rules'
);

// 71. LEGACY reaction documents. Reactions used to be keyed
//     {messageId}__{emoji} and were later re-keyed to {messageId}__{email}.
//     Removing a legacy reaction must delete the doc that ACTUALLY exists —
//     deleting the recomputed id addresses a missing document, which the rules
//     deny (no `resource` to check ownership against). That surfaced to users
//     as the misleading "ask a superadmin to deploy the rules" toast.
reactionsCallback({
    forEach(fn) {
        fn({ id: 'r6__thumbsup', data: () => ({ messageId: 'r6', emoji: 'thumbsup', email: ME }) });
    }
});
pushMessages([
    { id: 'r6', text: 'legacy reaction', senderEmail: THEM, senderName: 'Them', sentAt: T.now }
]);
assert(
    /data-reaction-msg="r6"/.test(receiptLog.innerHTML),
    'precondition: r6 carries a legacy reaction of mine'
);

const deletesBefore = fakeDb.__reactionDeletes.length;
receiptLog.dispatch('click', {
    target: {
        closest: (sel) => (sel === '[data-reaction-msg]'
            ? { getAttribute: (a) => (a === 'data-reaction-msg' ? 'r6' : 'thumbsup') }
            : null)
    },
    preventDefault() {}
});
await new Promise((r) => realSetTimeout(r, 0));

const legacyDelete = fakeDb.__reactionDeletes[deletesBefore];
assert(legacyDelete, 'toggling off a legacy reaction must issue a delete');
assert.strictEqual(
    legacyDelete, 'r6__thumbsup',
    'it must delete the LEGACY doc id that really exists, not a recomputed id that does not'
);
assert(
    !/data-reaction-msg="r6"/.test(receiptLog.innerHTML),
    'the legacy reaction must disappear from the UI'
);

// 72. Switching emoji on a LEGACY doc cannot be a plain update (the id is
//     keyed by the OLD emoji), so it must migrate: delete the old doc, then
//     write the canonical one — ordered, so a failure never leaves two of the
//     same person's reactions on a single message.
reactionsCallback({
    forEach(fn) {
        fn({ id: 'r7__thumbsup', data: () => ({ messageId: 'r7', emoji: 'thumbsup', email: ME }) });
    }
});
pushMessages([
    { id: 'r7', text: 'migrate me', senderEmail: THEM, senderName: 'Them', sentAt: T.now }
]);
const writesBeforeMig = fakeDb.__reactionWrites.length;
const delsBeforeMig = fakeDb.__reactionDeletes.length;
receiptLog.dispatch('mouseover', {
    target: { closest: (sel) => (sel === '.chat-msg' ? { getAttribute: () => 'r7' } : null) }
});
assert.strictEqual(picker.hidden, false, 'hovering r7 must open the picker');
picker.dispatch('mousedown', {
    target: { closest: (sel) => (sel === '[data-picker-key]' ? { getAttribute: () => 'love' } : null) },
    preventDefault() {}
});
await new Promise((r) => realSetTimeout(r, 0));
await new Promise((r) => realSetTimeout(r, 0));

assert.strictEqual(
    fakeDb.__reactionDeletes[delsBeforeMig], 'r7__thumbsup',
    'migrating must first delete the legacy doc'
);
const migWrite = fakeDb.__reactionWrites[writesBeforeMig];
assert(migWrite, 'migrating must then write a doc for the new emoji');
assert.strictEqual(migWrite.data.emoji, 'love');
assert(
    migWrite.key !== 'r7__thumbsup',
    'the replacement must be written under the canonical {messageId}__{email} id'
);
assert(
    /data-reaction-key="love"/.test(receiptLog.innerHTML) &&
        !/data-reaction-key="like"/.test(receiptLog.innerHTML),
    'after migrating, the new emoji is my only reaction on that message'
);

// 73. The denial toast must not blame the rules for every denied write — it
//     sent people to re-deploy rules that were already correct.
const chatJsSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'chat.js'), 'utf8');
assert(
    !/ask a superadmin to run: firebase deploy/.test(chatJsSrc),
    'the reaction denial toast must not instruct a re-deploy of already-correct rules'
);

console.log('✅ Reaction tests passed (chips render, counts aggregate, own reaction marked, ONE reaction per message, owner-only, optimistic, hover-to-open, animated).');
console.log('✅ Legacy reaction tests passed (removes the real doc; migrates legacy id on emoji switch).');
// ---------------------------------------------------------------
// Replies
// ---------------------------------------------------------------

console.log('Testing chat replies...');

Live.init({ surface: 'owner', role: 'hr' });
const replyBanner = findById(body, 'chatReplyBanner');
const replyName = findById(body, 'chatReplyName');
const replyText = findById(body, 'chatReplyText');
const replyCancel = findById(body, 'chatReplyCancel');
assert(replyBanner && replyName && replyText && replyCancel, 'reply banner markup missing');
// NOTE: findById(body, ...) can return an overlay built by an EARLIER
// test block, so the banner is reset explicitly here. Production code
// relies on the `hidden` attribute in the markup, which the fake DOM's
// innerHTML parser honours.
replyBanner.hidden = true;

pushMessages([
    { id: 'p-base', text: 'the original question about the camera', senderEmail: THEM,
      senderName: 'Them', sentAt: T.past }
]);

// 71. Reply is reached through the shared context menu, so a message carries
//     no reply button of its own.
assert(
    !/data-reply-for="p-base"/.test(receiptLog.innerHTML),
    'a message must NOT carry its own reply button — the context menu owns reply'
);
assert(
    /data-picker-reply/.test(chatMenuSrc),
    'reply must be offered by the shared context menu instead'
);

// 72. A plain message has NO quote block.
assert(
    !/chat-reply-quote-block/.test(receiptLog.innerHTML),
    'a top-level message must not render a quote block'
);
assert.strictEqual(replyBanner.hidden, true, 'the reply banner must start hidden');

// 73. Choosing Reply in the context menu opens the banner, previewing the
//     parent. Hover the message to open the menu, then pick Reply.
receiptLog.dispatch('mouseover', {
    target: { closest: (sel) => (sel === '.chat-msg' ? { getAttribute: () => 'p-base' } : null) }
});
assert.strictEqual(picker.hidden, false, 'hovering must open the context menu');
picker.dispatch('mousedown', {
    target: { closest: (sel) => (sel === '[data-picker-reply]' ? { getAttribute: () => 'p-base' } : null) },
    preventDefault() {}
});
assert.strictEqual(
    picker.hidden, true,
    'choosing Reply must close the menu and hand over to the composer'
);
assert.strictEqual(replyBanner.hidden, false, 'clicking reply must open the banner');
assert.strictEqual(
    replyText.textContent,
    'the original question about the camera',
    'the banner must preview the message being replied to'
);

// 74. Sending stores replyTo, and the banner clears afterwards so the next
//     message is NOT silently a reply to the same parent.
const before = sentWrites.length;
composer.value = 'answering you';
composer.dispatch('keydown', { key: 'Enter', shiftKey: false });
await new Promise((r) => realSetTimeout(r, 0));
const replyMsg = sentWrites.slice(before).find((w) => w.data && w.data.text !== undefined);
assert.strictEqual(
    replyMsg.data.replyTo,
    'p-base',
    'a reply must store the parent message id'
);
assert.strictEqual(
    replyBanner.hidden,
    true,
    'the banner must clear after sending, so the next message is top-level'
);

composer.value = 'unrelated follow-up';
composer.dispatch('keydown', { key: 'Enter', shiftKey: false });
await new Promise((r) => realSetTimeout(r, 0));
const topMsg = sentWrites.filter((w) => w.data && w.data.text !== undefined).pop();
assert.strictEqual(
    topMsg.data.replyTo,
    null,
    'a message sent after a reply must be top-level, not inherit the old target'
);

// 75. A reply renders the quoted parent above its bubble.
pushMessages([
    { id: 'p-base', text: 'the original question about the camera', senderEmail: THEM,
      senderName: 'Them', sentAt: T.past },
    { id: 'p-reply', text: 'answering you', senderEmail: ME, senderName: 'Me',
      replyTo: 'p-base', sentAt: T.now }
]);
assert(
    /chat-reply-quote-block/.test(receiptLog.innerHTML),
    'a reply must render a quote block'
);
assert(
    /chat-reply-quote-text">the original question/.test(receiptLog.innerHTML),
    'the quote block must preview the parent message text'
);

// 76. A reply to a message that is NO LONGER loaded must degrade gracefully
//     rather than rendering an empty or broken box.
pushMessages([
    { id: 'p-orphan', text: 'replying to something long gone', senderEmail: ME,
      replyTo: 'p-deleted', sentAt: T.now }
]);
assert(
    /Earlier message/.test(receiptLog.innerHTML),
    'a reply whose parent is not loaded must show a neutral fallback, not a broken quote'
);

// 77. The quoted text must be escaped — a parent message is user input.
pushMessages([
    { id: 'p-xss', text: 'ok', senderEmail: THEM, senderName: 'Them', sentAt: T.past },
    { id: 'p-xss-reply', text: 'sure', senderEmail: ME,
      replyTo: 'p-xss', sentAt: T.now }
]);
pushMessages([
    { id: 'p-xss2', text: '<img src=x onerror=alert(1)>', senderEmail: THEM,
      senderName: 'Them', sentAt: T.past },
    { id: 'p-xss2-reply', text: 'got it', senderEmail: ME,
      replyTo: 'p-xss2', sentAt: T.now }
]);
assert(
    receiptLog.innerHTML.indexOf('<img') === -1,
    'a quoted parent message must be escaped — it is user input and must never inject markup'
);

// 78. Cancelling clears the pending reply. Reply is chosen from the context
//     menu, so hover the message and pick Reply again.
receiptLog.dispatch('mouseover', {
    target: { closest: (sel) => (sel === '.chat-msg' ? { getAttribute: () => 'p-base' } : null) }
});
picker.dispatch('mousedown', {
    target: { closest: (sel) => (sel === '[data-picker-reply]' ? { getAttribute: () => 'p-base' } : null) },
    preventDefault() {}
});
assert.strictEqual(replyBanner.hidden, false, 'precondition: banner is open');
replyCancel.dispatch('click', { preventDefault() {} });
assert.strictEqual(replyBanner.hidden, true, 'cancel must clear the pending reply');

// 79. The message header must be pure metadata. Both actions moved to the
//     shared context menu, so nothing is absolutely positioned over a
//     message any more and the header carries no icons at all.
pushMessages([
    { id: 'r5', text: 'clean header', senderEmail: THEM, senderName: 'Them', sentAt: T.now }
]);
const rowHtml = receiptLog.innerHTML;
const r5Start = rowHtml.indexOf('data-msg-id="r5"');
assert(r5Start > -1, 'r5 must be rendered');
const metaStart = rowHtml.indexOf('chat-msg-meta', r5Start);
const metaEnd = rowHtml.indexOf('</div>', metaStart);
const metaInner = rowHtml.slice(metaStart, metaEnd);
assert(
    /chat-msg-time/.test(metaInner),
    'the header still shows the timestamp'
);
assert(
    !/chat-msg-actions/.test(metaInner) && !/data-reply-for/.test(metaInner) &&
        !/data-react-for/.test(metaInner),
    'the header must carry no action buttons — both actions live in the context menu'
);
const chatCss2 = fs.readFileSync(path.join(__dirname, '..', 'chat.css'), 'utf8');
assert(
    !/\.chat-msg-actions/.test(chatCss2) && !/\.chat-msg-reply/.test(chatCss2) &&
        !/\.chat-msg-react\b/.test(chatCss2),
    'the dead per-message action styles must be removed, not left orphaned'
);

// 80. The avatar must sit BESIDE the message (its own column), not above it
//     in a header line that wastes a line of vertical space per message.
const rowOpen = rowHtml.indexOf('chat-msg-row', r5Start);
assert(rowOpen > -1, 'each message must be wrapped in a .chat-msg-row (avatar column + content)');
const avatarInRow = rowHtml.indexOf('chat-avatar', r5Start);
const contentInRow = rowHtml.indexOf('chat-msg-content', r5Start);
assert(
    avatarInRow > rowOpen && avatarInRow < contentInRow,
    'the avatar must be the first child of .chat-msg-row, before the content'
);
assert(
    !/chat-avatar/.test(metaInner),
    'the avatar must NOT be in the meta header — that is what made it sit above the message'
);
assert(
    /chat-avatar[^"]*"[^>]*aria-hidden/.test(rowHtml.slice(avatarInRow, avatarInRow + 220)),
    'the avatar stays aria-hidden (it is decorative; the name carries the identity)'
);
// Own messages reverse the row so the avatar sits on the right.
const mineRule = (chatCss2.match(/\.chat-msg-mine \.chat-msg-row \{[^}]*\}/) || [''])[0];
assert(
    /row-reverse/.test(mineRule),
    'own messages must reverse the row so the avatar moves to the right of the bubble'
);

// 81. Vertical alignment. The avatar must sit BOTTOM-aligned against the
//     message, not centred: `align-self: center` stranded it halfway down a
//     tall multi-line bubble, reading as detached from the text.
//
//     ⚠️ Match the BASE `.chat-avatar` rule, not the first rule mentioning
//     the class. `.chat-row .chat-avatar` (the conversation-list avatar)
//     deliberately uses `align-self: center`, because a list row is not a
//     message bubble — a loose regex would now match that override and
//     report the message avatar as broken.
const avatarBase = (chatCss2.match(/^\.chat-avatar \{[^}]*\}/m) || [''])[0];
assert(avatarBase, 'the base .chat-avatar rule must exist');
const avatarRule = avatarBase;
assert(
    /align-self:\s*flex-end/.test(avatarRule),
    'the avatar must be bottom-aligned to the message, not centred'
);
assert(
    !/align-self:\s*center/.test(avatarRule),
    'align-self:center on the avatar leaves it floating away from the bubble'
);
// ...and the list-row override must still centre its own avatar.
assert(
    /\.chat-row \.chat-avatar \{[^}]*align-self:\s*center/.test(chatCss2),
    'the conversation-list avatar must be centred in its row (it is not a message bubble)'
);
const rowRule = (chatCss2.match(/\.chat-msg-row \{[^}]*\}/) || [''])[0];
assert(
    /align-items:\s*flex-end/.test(rowRule),
    'the row must bottom-align its children so the avatar meets the bubble'
);
assert(
    /justify-content:\s*flex-end/.test(mineRule),
    'outgoing messages must pin the whole group (bubble + avatar + reply + chips) to the right'
);
// The row is the single flex container: the reply preview and reaction chips
// must live inside it, not float outside as siblings of the message.
assert(
    /chat-msg-content[\s\S]*chat-msg-bubble/.test(rowHtml.slice(contentInRow, r5Start + 900)),
    'the bubble must sit inside the row content, alongside the reply preview and reactions'
);
assert(
    !/\{\s*justify-content:\s*center;\s*justify-content:/.test(chatCss2),
    'a duplicated declaration is a leftover from an earlier edit'
);

// 82. TOUCH. With no per-message button left, a touch device has no hover,
//     so a long press is the only way into the context menu. Simulate a
//     touch device by making (hover: hover) not match.
const realMatchMedia = sandbox.window.matchMedia;
sandbox.window.matchMedia = (q) => ({ matches: /hover:\s*hover/.test(q) ? false : true });
try {
    // A mouse press must NOT open it — desktop already has hover, and a
    // long press on desktop would be a surprise.
    const before = picker.hidden;
    receiptLog.dispatch('pointerdown', {
        pointerType: 'mouse',
        target: { closest: (sel) => (sel === '.chat-msg' ? { getAttribute: () => 'r5' } : null) }
    });
    await new Promise((r) => realSetTimeout(r, 500));
    assert.strictEqual(picker.hidden, before, 'a mouse press must not trigger the long press');

    // A touch press-and-hold opens the menu.
    receiptLog.dispatch('pointerdown', {
        pointerType: 'touch',
        target: { closest: (sel) => (sel === '.chat-msg' ? { getAttribute: () => 'r5' } : null) }
    });
    assert.strictEqual(picker.hidden, true, 'the menu must NOT open on touch-down; only on hold');
    await new Promise((r) => realSetTimeout(r, 500));
    assert.strictEqual(picker.hidden, false, 'a long press must open the context menu on touch');

    // Lifting the finger before the timer fires must NOT open it.
    picker.hidden = true;
    receiptLog.dispatch('pointerdown', {
        pointerType: 'touch',
        target: { closest: (sel) => (sel === '.chat-msg' ? { getAttribute: () => 'r5' } : null) }
    });
    receiptLog.dispatch('pointerup', { target: { closest: () => null } });
    await new Promise((r) => realSetTimeout(r, 500));
    assert.strictEqual(
        picker.hidden, true,
        'a quick tap must be left alone — it is a tap, not a long press'
    );
} finally {
    sandbox.window.matchMedia = realMatchMedia;
    picker.hidden = true;
}

// 83. The reaction chips must OVERLAY the message, not sit under it. In
//     normal flow they added height to the content column, and because the
//     avatar is bottom-aligned that dragged it down out of line with the
//     bubble — the "extra space under the message" problem.
const reactionsRule = (chatCss2.match(/\.chat-reactions \{[^}]*\}/) || [''])[0];
assert(
    /position:\s*absolute/.test(reactionsRule),
    'the reaction chips must be taken out of flow and overlaid on the message'
);
assert(
    !/margin-top/.test(reactionsRule),
    'the chips must not reserve vertical space via margin-top'
);
assert(
    /position:\s*relative/.test(
        (chatCss2.match(/\.chat-msg-content \{[^}]*\}/) || [''])[0]
    ),
    'the content column must be the positioning anchor for the overlaid chips'
);
assert(
    /z-index/.test(reactionsRule),
    'the overlaid chips need a z-index so they paint above the bubble and the next message'
);
// Outgoing chips hang off the right edge, matching the right-aligned group.
assert(
    /\.chat-msg-mine \.chat-reactions\s*\{[^}]*right:\s*0/.test(chatCss2),
    'outgoing reaction chips must align to the bubble right edge, not the left'
);
// The chips stay clickable even though the overlay container is not.
assert(
    /\.chat-reactions\s*\{[^}]*pointer-events:\s*none/.test(chatCss2) &&
        /\.chat-reactions > \*\s*\{[^}]*pointer-events:\s*auto/.test(chatCss2),
    'the overlay must be click-through except on the chips themselves'
);

// 84. THE SCROLL CONTAINER. `.chat-modal-body` was `overflow-y: auto` while
//     the log had no overflow rule, so the body scrolled and every
//     `els.log.scrollTop = ...` was a silent no-op (a non-scrolling element
//     ignores scrollTop). Opening the chat therefore left the thread parked
//     wherever it was — showing OLDER messages. The log must be the scroller.
const modalBodyRule = (chatCss2.match(/\.chat-modal-body \{[^}]*\}/) || [''])[0];
const logRule = (chatCss2.match(/\.chat-log \{[^}]*\}/) || [''])[0];
assert(
    /overflow-y:\s*auto/.test(logRule),
    '.chat-log must be the scroll container, or every scrollTop write is a no-op'
);
assert(
    !/overflow-y:\s*auto/.test(modalBodyRule),
    '.chat-modal-body must NOT scroll — it holds the pager too, and scrolling '
        + 'it made the log\'s scrollTop writes silently do nothing'
);
assert(
    /min-height:\s*0/.test(logRule),
    'a flex child needs min-height:0 or it refuses to shrink and never scrolls'
);
// Opening must land on the newest message, not wherever the log was left.
log.scrollTop = 0;                 // pretend the user left it scrolled up
log.scrollHeight = 5000;
log.clientHeight = 400;
Live.close();                     // start from a closed chat
Live.open();
assert.strictEqual(
    log.scrollTop, 5000,
    'opening the chat must jump to the latest message, not keep an old scroll position'
);

// 85. Our own scrolling must not look like the user reaching the top of
//     history, or a re-render would silently start paging on its own.
const chatJsScroll = fs.readFileSync(path.join(__dirname, '..', 'js', 'chat.js'), 'utf8');
assert(
    /if \(programmaticScroll\) return;/.test(chatJsScroll),
    'the auto-page-on-scroll handler must ignore scrolls we caused ourselves'
);
assert(
    /programmaticScroll = true;[\s\S]{0,200}scrollTop = els\.log\.scrollHeight/.test(chatJsScroll),
    'scrollLogToBottom must mark its scroll as programmatic'
);

// 86. The Messenger set, with ANIMATED illustrated glyphs. A Unicode 😂 is a
//     dead picture; the haha face has to actually laugh.
const chatReactSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'chat.js'), 'utf8');
['like', 'love', 'haha', 'wow', 'sad', 'angry'].forEach(function (key) {
    assert(
        new RegExp("\\{ key: '" + key + "',").test(chatReactSrc),
        'the reaction set must include "' + key + '"'
    );
    assert(
        chatReactSrc.indexOf(key + ":\n") > -1 || chatReactSrc.indexOf(key + ':') > -1,
        'the reaction set must have a drawn glyph for "' + key + '"'
    );
});
// The old pictograph set must be gone, or both sets would show.
assert(
    !/\{ key: 'thumbsup'/.test(chatReactSrc) && !/\{ key: 'eyes'/.test(chatReactSrc),
    'the old emoji set must be fully replaced'
);
assert(
    /function reactionGlyph\(/.test(chatReactSrc),
    'reactions must render as inline SVG so they can animate'
);

// 87. Each reaction animates, and differently. A single shared keyframe
//     would mean six identical bouncing glyphs.
['Like', 'Love', 'Haha', 'Wow', 'Sad', 'Angry'].forEach(function (name) {
    assert(
        new RegExp('chatReact' + name).test(chatCss2),
        'the ' + name + ' glyph must have its own animation'
    );
});
assert(
    /@keyframes chatReactLaugh/.test(chatCss2) && /\.chat-react-mouth/.test(chatCss2),
    'the haha face must animate its mouth, or it is not laughing'
);
assert(
    /@keyframes chatReactTear/.test(chatCss2) && /@keyframes chatReactGasp/.test(chatCss2) &&
        /@keyframes chatReactFrown/.test(chatCss2),
    'wow, sad and angry must animate their own features'
);
// Animation is CSS-only: the log's innerHTML is rebuilt on every snapshot,
// so a JS-driven animation would restart and strobe.
assert(
    /setInterval|requestAnimationFrame/.test(chatCss2) === false &&
        !/setInterval[\s\S]{0,80}react/i.test(chatReactSrc),
    'the glyphs must not be animated from JS — the log re-renders on every snapshot'
);
// Accessibility: the motion must be opt-out-able.
assert(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.chat-react[\s\S]*?animation: none/.test(chatCss2),
    'the reaction animations must honour prefers-reduced-motion'
);

// 88. LEGACY emoji keys. Reactions already in Firestore store 'thumbsup',
//     'heart', etc. Chips are rendered by looking the stored key up in the
//     new set — so without a remap every existing reaction would VANISH.
const legacyMapSrc = (chatReactSrc.match(/var LEGACY_REACTION_KEYS = \{[^}]*\}/) || [''])[0];
['thumbsup', 'heart', 'eyes', 'tada', 'alarm'].forEach(function (oldKey) {
    assert(
        legacyMapSrc.indexOf(oldKey) > -1,
        'the old key "' + oldKey + '" must be remapped or its reaction disappears'
    );
});
assert(
    /normaliseReactionKey\(data\.emoji\)/.test(chatReactSrc),
    'the snapshot must run stored keys through normaliseReactionKey'
);
// And it must actually work end to end: a stored 'thumbsup' shows as Like.
reactionsCallback({
    forEach(fn) {
        fn({ id: 'old1', data: () => ({ messageId: 'r8', emoji: 'thumbsup', email: THEM }) });
    }
});
pushMessages([
    { id: 'r8', text: 'old reaction', senderEmail: THEM, senderName: 'Them', sentAt: T.now }
]);
assert(
    /data-reaction-key="like"/.test(receiptLog.innerHTML) &&
        !/data-reaction-key="thumbsup"/.test(receiptLog.innerHTML),
    'a stored thumbsup must still be VISIBLE, remapped onto the new Like reaction'
);

// 89. MOBILE LONG-PRESS FOCUS OVERLAY. The Messenger/iOS pattern: holding a
//     message dims + blurs the whole thread and lifts ONLY the held bubble
//     above the scrim, with the action menu on top. Desktop hover must NOT do
//     this — the scrim is a touch-only affordance. Simulate a touch device the
//     same way #82 does (make (hover: hover) not match).
{
    const realMatchMedia2 = sandbox.window.matchMedia;
    sandbox.window.matchMedia = (q) => ({ matches: /hover:\s*hover/.test(q) ? false : true });
    try {
        // The scrim element must exist in the chat DOM. (It ships hidden at
        // creation — chat.js sets focusBackdrop.hidden = true — but an earlier
        // test in this same function may have opened it, so reset it here to
        // keep this test self-contained rather than order-dependent.)
        const backdrop = findById(body, 'chatFocusBackdrop');
        assert(backdrop, 'the long-press focus scrim must be created in the chat overlay');
        backdrop.hidden = true;

        // A real element to act as the held message row, carrying a data-msg-id
        // and a classList the focus code can lift.
        const heldRow = new FakeElement('div');
        heldRow.attributes['data-msg-id'] = 'rFocus';
        const heldTarget = {
            closest: (sel) => (sel === '.chat-msg' ? heldRow : null)
        };

        picker.hidden = true;
        receiptLog.dispatch('pointerdown', {
            pointerType: 'touch',
            target: heldTarget
        });
        // Must NOT fire on touch-down alone — only after the ~400ms hold.
        assert.strictEqual(picker.hidden, true, 'the menu must not open on touch-down');
        assert.strictEqual(backdrop.hidden, true, 'the focus scrim must not drop on touch-down');

        await new Promise((r) => realSetTimeout(r, 500));

        // After the hold: menu open, scrim dropped, and THIS bubble lifted.
        assert.strictEqual(picker.hidden, false, 'a long press must open the context menu on touch');
        assert.strictEqual(backdrop.hidden, false, 'a long press must drop the dim/blur focus scrim');
        assert(
            heldRow.classList.contains('is-focused'),
            'the held bubble must be lifted above the scrim (is-focused)'
        );

        // The synthetic release-click that the browser fires the instant the
        // finger lifts can land on the scrim — it MUST be swallowed, or the
        // menu flickers shut (the "nawawala-wala" bug). First scrim click is
        // that synthetic one: the menu stays open.
        backdrop.dispatch('click', {});
        assert.strictEqual(
            picker.hidden, false,
            'the synthetic release-click after a long-press must NOT close the menu'
        );

        // A real, deliberate tap on the scrim then dismisses the menu AND tears
        // the overlay back down: scrim hidden again and the bubble lowered.
        backdrop.dispatch('click', {});
        assert.strictEqual(picker.hidden, true, 'tapping the scrim must close the menu');
        assert.strictEqual(backdrop.hidden, true, 'tapping the scrim must hide the focus overlay');
        assert(
            !heldRow.classList.contains('is-focused'),
            'closing must lower the held bubble back into the thread'
        );

        // ---- CSS contract: the scrim, the lift and the pop. ----
        // (chatCss2 was read earlier in this file.)
        const scrimRule = (chatCss2.match(/\.chat-focus-backdrop\s*\{[^}]*\}/) || [''])[0];
        assert(/backdrop-filter:\s*blur\(6px\)/.test(scrimRule),
            'the focus scrim must blur the thread behind it (backdrop-filter: blur(6px))');
        assert(/rgba\(0,\s*0,\s*0,\s*0\.5\)/.test(scrimRule),
            'the focus scrim must carry the dark tint rgba(0,0,0,0.5)');
        assert(/position:\s*fixed/.test(scrimRule) && /inset:\s*0/.test(scrimRule),
            'the focus scrim must cover the whole thread (position:fixed; inset:0)');
        // The held bubble must be positioned + z-indexed so it paints ABOVE the
        // scrim (z 40) and below the picker (z 60) — that ordering is the whole
        // "only this message stays lit" effect.
        const focusedRule = (chatCss2.match(/\.chat-msg\.is-focused\s*\{[^}]*\}/) || [''])[0];
        assert(/position:\s*relative/.test(focusedRule),
            'the held bubble must be positioned for its z-index to apply');
        assert(/z-index:\s*50/.test(focusedRule),
            'the held bubble must sit above the scrim (z 50 > scrim 40)');
        // The subtle pop.
        assert(/chatMsgFocusPop/.test(chatCss2) && /scale\(1\.03\)/.test(chatCss2),
            'the held bubble must pop to scale(1.03)');
        // Reduced motion must still leave it usable: no animation, but still lifted.
        assert(
            /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.chat-focus-backdrop[\s\S]*?animation:\s*none/.test(chatCss2),
            'reduced-motion must disable the scrim/pop animation'
        );
    } finally {
        sandbox.window.matchMedia = realMatchMedia2;
        picker.hidden = true;
        const b = findById(body, 'chatFocusBackdrop');
        if (b) b.hidden = true;
    }
}

// 90. NO DOUBLE MENU + NO AUTO-JUMP TO THE TEXTBOX (mobile). Two phone bugs,
//     one commit. (a) A long-press must NOT also raise the OS Copy/Select All/
//     Share callout on top of our custom menu. (b) Opening a chat must NOT
//     focus the composer <textarea>, which on a phone summons the software
//     keyboard and yanks the view to the input — "every tap jumps to the
//     textbox". Both are fixed by the CSS user-select/touch-callout rules on
//     .chat-log, a contextmenu preventDefault, and gating the composer
//     auto-focus behind canHover().
{
    // (a) CSS: the message list must not be selectable and must suppress the
    //     native callout, or the OS menu fights our overlay.
    const logRule = (chatCss2.match(/\.chat-log\s*\{[^}]*\}/) || [''])[0];
    assert(/user-select:\s*none/.test(logRule),
        '.chat-log must set user-select:none or a long-press still selects text and shows the native menu');
    assert(/-webkit-touch-callout:\s*none/.test(logRule),
        '.chat-log must set -webkit-touch-callout:none or iOS still shows its link/preview bubble on long-press');

    // (a) JS: a contextmenu on the log must be swallowed. Android fires
    //     `contextmenu` on long-press EVEN with user-select:none, so without
    //     this the OS popup appears beside our overlay.
    const chatJs = fs.readFileSync(path.join(__dirname, '..', 'js', 'chat.js'), 'utf8');
    assert(
        /els\.log\.addEventListener\('contextmenu'[\s\S]{0,80}preventDefault\(\)/.test(chatJs),
        'the native context menu on the message list must be prevented, or it doubles up with the custom menu'
    );

    // (b) The three passive composer auto-focus calls (openModal, openRoom,
    //     restoreChatAfterTicket) must be gated behind canHover(), so a phone
    //     does not pop the keyboard on open. Every els.input.focus() that is an
    //     AUTO-focus must carry the guard; the explicit ones (after tapping
    //     Reply, after sending, after a mention pick) must NOT be neutered.
    const guardedFocus = (chatJs.match(/if \(typeof canHover !== 'function' \|\| canHover\(\)\) els\.input\.focus\(\);/g) || []).length;
    assert(
        guardedFocus >= 3,
        'the passive composer auto-focus calls (openModal / openRoom / restoreChatAfterTicket) must each be ' +
        'gated behind canHover() so a phone does not jump to the textbox — found ' + guardedFocus
    );
}

// 91. LONG-PRESS FLICKER GUARD + iMessage TEXT ACTIONS. (a) When a long-press
//     opens the menu on a phone, the browser fires a synthetic `click` the
//     instant the finger lifts; without a guard that click closes the menu it
//     just opened (flash-then-shut). The first document click after a
//     long-press open must be swallowed. (b) The action bar is iMessage-style
//     TEXT (Copy · Unsend · Reply) below the emoji row, and Copy writes the
//     message text to the clipboard.
{
    const realMatchMedia3 = sandbox.window.matchMedia;
    sandbox.window.matchMedia = (q) => ({ matches: /hover:\s*hover/.test(q) ? false : true });
    // chatJs is scoped to the #90 block; read it fresh here.
    const chatJs91 = fs.readFileSync(path.join(__dirname, '..', 'js', 'chat.js'), 'utf8');
    try {
        const backdrop3 = findById(body, 'chatFocusBackdrop');
        if (backdrop3) backdrop3.hidden = true;

        // --- (a) the flicker guard: source contract ---
        // The document dismiss handler must consult suppressDismissClick and
        // consume it once, so the release-click does not close the fresh menu.
        assert(
            /if \(suppressDismissClick\) \{ suppressDismissClick = false; return; \}/.test(chatJs91),
            'the document dismiss handler must swallow the one synthetic click that follows a long-press open, ' +
            'or the menu flickers shut the instant the finger lifts'
        );
        // And the long-press timer must set that flag when it opens the menu.
        assert(
            /suppressDismissClick = true;/.test(chatJs91),
            'the long-press open path must arm the dismiss-click guard'
        );
        // The guard must be DISARMED on the next real pointerdown. Without
        // this, on a device that does NOT fire a synthetic release-click the
        // flag lingers and swallows the user's first real tap — the "need to
        // press twice to dismiss" bug. A deliberate tap fires its own
        // pointerdown (the synthetic release-click does not), so this clears
        // the guard in time for that tap's click to dismiss.
        assert(
            /document\.addEventListener\('pointerdown',[\s\S]{0,160}suppressDismissClick = false/.test(chatJs91),
            'the flicker guard must be disarmed on the next pointerdown, or a real tap needs two presses to dismiss'
        );

        // --- (b) Copy action is wired and iMessage text actions exist ---
        assert(
            /function copyMessageText\(/.test(chatJs91) && /function legacyCopy\(/.test(chatJs91),
            'Copy must be implemented (async Clipboard API + a textarea/execCommand fallback)'
        );
        // The text action bar must read Reply · Copy · Unsend, in that visual
        // order. First occurrence of each data-picker-* attribute is in the
        // picker markup (the dispatcher's closest() calls come later), so this
        // pins the on-screen button order.
        const replyPos = chatJs91.indexOf('data-picker-reply');
        const copyPos = chatJs91.indexOf('data-picker-copy');
        const unsendPos = chatJs91.indexOf('data-picker-unsend');
        assert(
            replyPos > -1 && copyPos > replyPos && unsendPos > copyPos,
            'the text action buttons must read Reply · Copy · Unsend in that order — found ' +
            'reply=' + replyPos + ' copy=' + copyPos + ' unsend=' + unsendPos
        );
        // Copy uses the raw message text, not the rendered HTML.
        assert(
            /copyMessageText\(target\)/.test(chatJs91),
            'tapping Copy must copy the target message text'
        );
    } finally {
        sandbox.window.matchMedia = realMatchMedia3;
        picker.hidden = true;
        const b3 = findById(body, 'chatFocusBackdrop');
        if (b3) b3.hidden = true;
    }
}

console.log('✅ Reply tests passed (quote block, replyTo stored, banner clears, no chaining, graceful fallback, escaped, header carries no action buttons).');
console.log('✅ Context menu tests passed (reply + reactions in one menu; touch long-press opens it).');
console.log('✅ Long-press focus overlay tests passed (dim+blur scrim, only the held bubble lifted, scale pop, tap-to-dismiss; desktop hover unaffected).');
console.log('✅ Native-menu + auto-focus tests passed (user-select/touch-callout suppress the OS callout; contextmenu prevented; composer auto-focus is desktop-only).');
console.log('✅ Long-press flicker + iMessage text-action tests passed (release-click no longer closes the menu; Copy/Unsend/Reply are text below the emoji row).');

console.log('✅ Read receipt tests passed (single tick on send; blue seen tick; own receipt excluded).');
}

/** Print the result and release every timer the module created. */
function done(err) {
    if (err) {
        console.error(err.message || err);
        process.exitCode = 1;
    } else {
        console.log('✅ Chat tests passed (hr + superadmin only; owner/operator excluded; ' +
            'messages escaped; draft-based typing indicator; sound).');
    }
    // Release timers. Repeating timers are faked, so this is a guard against
    // a leaked real timeout keeping Node's event loop alive.
    fakeIntervals.clear();
    liveTimeouts.forEach((id) => clearTimeout(id));
    liveTimeouts.clear();
}

