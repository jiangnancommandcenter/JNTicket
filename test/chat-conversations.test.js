// Functional test for the CONVERSATION LIST: per-pair room identity, who may
// be messaged (strict 1:1 superadmin <-> HR), the legacy archive row, search,
// listener re-pointing when switching threads, per-room unread, and starting a
// conversation by clicking a "tap to start" row (the ＋ button and its picker
// are gone — the list is the only entry point, and these tests say so).
//
// Runs js/chat.js in a vm sandbox against a fake DOM + fake Firestore, in the
// same style as chat-access.test.js. Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'chat.js'), 'utf8');

console.log('Testing the conversation list...');

/** Minimal element stub: enough for createElement / querySelector / append. */
class FakeElement {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this._classes = [];
        this._attrs = {};
        this._listeners = {};
        this.style = {};
        this.hidden = false;
        this.disabled = false;
        this.id = '';
        this.type = '';
        this.value = '';
        this.innerHTML = '';
        this.textContent = '';
        this.title = '';
    }
    get classList() {
        const self = this;
        return {
            add(...c) { c.forEach((x) => { if (self._classes.indexOf(x) === -1) self._classes.push(x); }); },
            remove(...c) { self._classes = self._classes.filter((x) => c.indexOf(x) === -1); },
            contains(c) { return self._classes.indexOf(c) > -1; },
            toggle(c, force) {
                if (force === undefined) { if (self._classes.indexOf(c) > -1) self.remove(c); else self.add(c); }
                else if (force) self.add(c); else self.remove(c);
            }
        };
    }
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return this._attrs[k] !== undefined ? this._attrs[k] : null; }
    removeAttribute(k) { delete this._attrs[k]; }

    get innerHTML() { return this._innerHTML; }
    /**
     * A real innerHTML write detaches every child and builds new nodes from
     * the markup. chat.js injects the whole modal as one HTML string, so the
     * harness must too — otherwise querySelector('#chatInput') finds nothing
     * and every binding throws.
     */
    set innerHTML(v) {
        this._innerHTML = String(v);
        this.children = [];
        const re = /id="([^"]+)"([^>]*)>/g;
        let m;
        while ((m = re.exec(this._innerHTML)) !== null) {
            const child = new FakeElement('div');
            child.id = m[1];
            if (/(^|\s)hidden(\s|=|$)/.test(m[2])) child.hidden = true;
            this.appendChild(child);
        }
    }

    get textContent() { return this._textContent; }
    set textContent(v) { this._textContent = String(v); }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    remove() {
        if (this.parentNode) {
            this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
            this.parentNode = null;
        }
    }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
        if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
    }
    dispatch(type, event) {
        // Always hand the listener a full event shape. chat.js calls
        // preventDefault()/stopPropagation() unconditionally in its key and
        // click handlers, so a bare {} would throw instead of exercising them.
        const e = Object.assign({
            type,
            target: this,
            key: '',
            shiftKey: false,
            preventDefault() {},
            stopPropagation() {}
        }, event || {});
        (this._listeners[type] || []).forEach((fn) => fn(e));
        // ⚠️ The `onclick = fn` property form is NOT honoured any more: the only
        // thing in chat.js that used it was the removed ＋ picker. Nothing in
        // the module sets it, so supporting it here would be harness code no
        // test can reach.
    }
    focus() {}
    querySelector(sel) { return findBySelector(this, sel); }
    querySelectorAll(sel) { return findAllBySelector(this, sel); }
    closest() { return null; }
    contains(node) {
        if (node === this) return true;
        return this.children.some((c) => (c.contains ? c.contains(node) : false));
    }
}

/**
 * A deliberately forgiving querySelector: it walks the tree for an id match,
 * a class match or a tag name, so the injected markup resolves without a real
 * CSS engine.
 */
function findBySelector(root, sel) {
    const s = String(sel);
    return walk(root).find((el) =>
        el.id === s.replace('#', '') ||
        String(el.className).split(/\s+/).indexOf(s.replace('.', '')) > -1 ||
        el.tagName === s.toUpperCase()
    ) || null;
}

function findAllBySelector(root, sel) {
    const cls = String(sel).replace('.', '');
    return walk(root).filter((el) => String(el.className).split(/\s+/).indexOf(cls) > -1);
}

function walk(node, out) {
    out = out || [];
    (node.children || []).forEach((c) => { out.push(c); walk(c, out); });
    return out;
}

function findById(node, id) {
    return walk(node).find((el) => el.id === id) || null;
}

const sentWrites = [];
const roomUpdates = [];
const presenceWrites = [];
// The room document's OWN writes, recorded separately from sentWrites. The
// room must exist on the server BEFORE the message is written (every message
// rule resolves membership with get(chats/{chatId}), and a get() cannot see a
// room created in the same batch), so a test has to be able to prove the
// room write happened on its own — and first.
const roomSets = [];
// One ordered log of every write the client performs, so a test can assert
// the ORDER (room, then message) rather than merely that both happened.
const writeOrder = [];
let listenerCallback = null;
let presenceCallback = null;
let receiptsCallback = null;
let conversationCallback = null;
let directoryCallback = null;
// ---- The DENIED-list-query fallback -------------------------------------
// A query is authorised as ONE rules evaluation over the whole collection, so
// the deployed rules can refuse `chats where members array-contains me` while
// every room DOCUMENT is still readable. chat.js then rebuilds the list from
// one document listener per room; these record what it subscribed to and let a
// test make a room read succeed, fail, or report "no document".
let conversationErrorCallback = null;
const roomListens = [];
const roomListenCallbacks = {};   // roomId -> { cb, errCb }
// Which room each captured callback belongs to, so a test can assert that
// switching conversations really re-points the listeners.
let messageRoomId = null;
let presenceRoomId = null;
let receiptsRoomId = null;

function makeFakeFirestore() {
    function makeRoomFor(roomId) {
        const presence = {
            onSnapshot(cb) {
                presenceCallback = cb;
                presenceRoomId = roomId;
                return function () { presenceRoomId = null; };
            },
            doc(key) {
                return {
                    key,
                    set(data) { presenceWrites.push({ op: 'set', key, data, roomId }); return Promise.resolve(); },
                    delete() { presenceWrites.push({ op: 'delete', key, roomId }); return Promise.resolve(); }
                };
            }
        };
        const receipts = {
            onSnapshot(cb) {
                receiptsCallback = cb;
                receiptsRoomId = roomId;
                return function () { receiptsRoomId = null; };
            },
            doc(key) { return { key, set() { return Promise.resolve(); } }; }
        };
        const messages = {
            doc: () => ({}),
            orderBy() { return this; },
            limitToLast() { return this; },
            onSnapshot(cb) {
                listenerCallback = cb;
                messageRoomId = roomId;
                return function () { messageRoomId = null; };
            }
        };
        return {
            collection(name) {
                if (name === 'presence') return presence;
                if (name === 'readReceipts') return receipts;
                if (name === 'profiles') {
                    // The people directory lives in the LEGACY room's
                    // `profiles` subcollection, so THIS is the collection
                    // the directory listener subscribes to.
                    if (roomId === 'owner-superadmin') return directoryCol;
                    return { onSnapshot() { return function () {}; }, doc: () => ({ set: () => Promise.resolve() }) };
                }
                if (name === 'reactions') {
                    return {
                        onSnapshot() { return function () {}; },
                        doc: () => ({
                            set: () => Promise.resolve(),
                            update: () => Promise.resolve(),
                            delete: () => Promise.resolve()
                        })
                    };
                }
                return messages;
            },
            set(data, opts) {
                roomSets.push({ roomId, data, opts });
                writeOrder.push('room:' + roomId);
                return Promise.resolve();
            },
            update(data) { roomUpdates.push({ roomId, data }); return Promise.resolve(); },
            // The room DOCUMENT listener, used by the denied-query fallback
            // to rebuild the conversation list one room at a time.
            onSnapshot(cb, errCb) {
                roomListens.push(roomId);
                roomListenCallbacks[roomId] = { cb, errCb };
                return function () { delete roomListenCallbacks[roomId]; };
            }
        };
    }

    // The people directory: the legacy room's `profiles` subcollection,
    // which the ALREADY-DEPLOYED rules let HR and superadmins read. No new
    // collection, so no rules deploy is required for it to work.
    const directoryCol = {
        onSnapshot(cb) { directoryCallback = cb; return function () {}; },
        doc(key) { return { key, set: () => Promise.resolve(), update: () => Promise.resolve() }; }
    };

    // ---- The AUTHORITATIVE account roster: `users` ----------------------
    // BOTH chat roles read it, and both read it LIVE:
    //   * a superadmin reads the collection WHOLE — the deployed rule is
    //     `allow read: if isSuperAdmin() || isSelf()`, and script.js's
    //     loadSuperadminUsers() already does exactly that in production;
    //   * an HR reads only `where('role','==','superadmin')`, which is the
    //     filter the rules' per-document HR clause is provable from (an
    //     unfiltered HR read of `users` is denied, which is what keeps owner
    //     accounts out of reach).
    // Every subscribe is recorded in `usersReads` together with its filters,
    // so a test can assert WHICH query each role asked for.
    //
    // The fixtures are the awkward cases on purpose:
    //   * newhr@  — an HR account with NO directory entry at all (they have
    //               never opened the chat). This is the account that used to
    //               be invisible to the superadmin.
    //   * stale@  — an HR whose directory entry exists but was published with
    //               an empty role, so only the roster can tell who they are.
    //   * 'HR '   — a role stored with stray case AND whitespace, which a
    //               where('role','==','hr') query would silently miss.
    //   * someowner@ / a superadmin — must never be offered.
    const usersReads = [];
    let usersDocs = [
        { id: 'newhr@test.com', data: () => ({ email: 'newhr@test.com', name: 'New HR', role: 'hr', status: 'approved' }) },
        { id: 'stale@test.com', data: () => ({ email: 'stale@test.com', role: 'HR ' }) },
        { id: 'someowner@test.com', data: () => ({ email: 'someowner@test.com', name: 'An Owner', role: 'owner' }) },
        { id: 'boss@test.com', data: () => ({ email: 'boss@test.com', name: 'Boss', role: 'superadmin' }) }
    ];
    let usersReadDelivers = true;
    // The DEPLOYED message create rule can be OLDER than this client, in which
    // case it carries a `hasOnly()` allowlist from that era. `null` means "no
    // allowlist" (what the rules in this repository say); a list of keys makes
    // the fake refuse any MESSAGE document with a key outside it, exactly as
    // Firestore does — including rolling the whole batch back.
    let messageKeyAllowlist = null;
    // A deployed rule can refuse the room UPDATE for anything but the legacy
    // room while accepting the message. The room write inside the batch is then
    // what kills the send (a batch is atomic), and the client reports it as a
    // failed message. This models that.
    let previewWritesDenied = false;
    // How many batch commits the rules REFUSED. A discovered write shape that is
    // remembered must cost ZERO of these on the next page load.
    let deniedCommits = 0;
    const usersListeners = [];
    /** One query over `users`, filterable exactly the way Firestore requires. */
    function usersQuery(filters) {
        return {
            where(field, op, value) {
                return usersQuery(filters.concat([field + ' ' + op + ' ' + value]));
            },
            get() {
                usersReads.push(filters.slice());
                if (!usersReadDelivers) return Promise.reject(new Error('permission-denied'));
                return Promise.resolve({ forEach(fn) { usersDocs.forEach(fn); } });
            },
            onSnapshot(cb, errCb) {
                usersReads.push(filters.slice());
                if (!usersReadDelivers) {
                    const err = new Error('permission-denied');
                    err.code = 'permission-denied';
                    if (errCb) errCb(err);
                    return function () {};
                }
                const listener = { cb, filters: filters.slice() };
                usersListeners.push(listener);
                cb({ forEach(fn) { usersDocs.forEach(fn); } });
                return function () {
                    const i = usersListeners.indexOf(listener);
                    if (i > -1) usersListeners.splice(i, 1);
                };
            }
        };
    }
    const usersCol = usersQuery([]);

    // The conversation-list query: chats where members array-contains me,
    // The conversation-list query. NO orderBy is called by the client: an
    // `array-contains` + `orderBy` combination needs a paid composite index,
    // so sorting is done client-side. `orderBy` is kept on the stub only so a
    // regression that reintroduces it fails loudly here.
    const chatListCol = {
        orderByCalled: false,
        where() { return this; },
        orderBy() { this.orderByCalled = true; return this; },
        limit() { return this; },
        onSnapshot(cb, errCb) {
            conversationCallback = cb;
            conversationErrorCallback = errCb || null;
            return function () { conversationCallback = null; conversationErrorCallback = null; };
        }
    };

    return {
        collection(name) {
            if (name === 'chats') {
                return {
                    doc: (id) => makeRoomFor(id),
                    where: chatListCol.where,
                    orderBy: chatListCol.orderBy,
                    limit: chatListCol.limit,
                    onSnapshot: chatListCol.onSnapshot
                };
            }
            // The authoritative account roster (superadmin only).
            if (name === 'users') return usersCol;
            throw new Error('unexpected collection: ' + name);
        },
        batch() {
            // Writes are held PENDING until commit(), because a Firestore batch
            // is ATOMIC: a refused write rolls the whole batch back, and the
            // client must never believe a message was saved when it was not.
            const pending = [];
            return {
                set(ref, data) { pending.push({ ref, data }); },
                async commit() {
                    if (previewWritesDenied && pending.some((w) => w.data && w.data.members)) {
                        deniedCommits++;
                        const err = new Error('Missing or insufficient permissions.');
                        err.code = 'permission-denied';
                        throw err;
                    }
                    if (messageKeyAllowlist) {
                        for (const w of pending) {
                            // Only MESSAGE documents are allowlisted here; the
                            // room summary has its own (and matching) one.
                            if (!w.data || w.data.text === undefined) continue;
                            const extra = Object.keys(w.data).filter(
                                (k) => messageKeyAllowlist.indexOf(k) === -1
                            );
                            if (extra.length) {
                                deniedCommits++;
                                const err = new Error('Missing or insufficient permissions.');
                                err.code = 'permission-denied';
                                throw err;
                            }
                        }
                    }
                    pending.forEach((w) => {
                        sentWrites.push({ ref: w.ref, data: w.data });
                        // The batch carries the message and the room summary.
                        // Tag them so the ordered log is readable.
                        writeOrder.push(w.data && w.data.text !== undefined ? 'message' : 'room-summary');
                    });
                    writeOrder.push('commit');
                    return true;
                }
            };
        },
        __roomUpdates: roomUpdates,
        __roomSets: roomSets,
        __writeOrder: writeOrder,
        __listQuery: chatListCol,
        // ---- Denied-list-query fallback, driven from the test ----
        __roomListens: roomListens,
        /** Make the `chats` list QUERY fail, as the deployed rules do. */
        __denyList(error) {
            if (!conversationErrorCallback) {
                throw new Error('the conversation-list query has no error callback registered');
            }
            conversationErrorCallback(error || {
                code: 'permission-denied',
                message: 'Missing or insufficient permissions.'
            });
        },
        /** A room document reports (or, with null, reports as non-existent). */
        __emitRoom(roomId, data) {
            const entry = roomListenCallbacks[roomId];
            if (!entry) throw new Error('no room listener subscribed for ' + roomId);
            entry.cb({ id: roomId, exists: data !== null, data: () => data || {} });
        },
        /** A room document read is REFUSED — the state of a room that does not
         *  exist yet, because the membership rule starts with exists(). */
        __denyRoom(roomId) {
            const entry = roomListenCallbacks[roomId];
            if (!entry) throw new Error('no room listener subscribed for ' + roomId);
            delete roomListenCallbacks[roomId];
            if (entry.errCb) {
                entry.errCb({ code: 'permission-denied', message: 'Missing or insufficient permissions.' });
            }
        },
        // The account roster: how many times it was read, and a switch to
        // simulate a denial (an older ruleset), because a failed roster read
        // must degrade to the directory rather than break the chat.
        __usersReads: usersReads,
        __setUsersReadDelivers(delivers) { usersReadDelivers = delivers; },
        /** How many roster listeners are LIVE right now (leak guard). */
        __usersListeners() { return usersListeners.length; },
        /** Replace the account roster, e.g. to model somebody being re-roled. */
        __setUsersDocs(docs) { usersDocs = docs; },
        /**
         * A roster snapshot arriving from the SERVER — i.e. an account
         * registered or approved on some other device while this chat is
         * open. `live` is the auto-update: it must appear with no
         * refreshDirectory() and no reload.
         */
        __emitUsers(docs) {
            usersDocs = docs;
            usersListeners.slice().forEach((l) => l.cb({ forEach(fn) { usersDocs.forEach(fn); } }));
        },
        /**
         * Emulate an OLDER deployed message rule that carries a `hasOnly()`
         * allowlist. `null` = no allowlist (the rules in this repository).
         */
        __setMessageKeyAllowlist(keys) { messageKeyAllowlist = keys; },
        /** Emulate a deployed rule that refuses the room preview inside a batch. */
        __denyPreviewWrites(on) { previewWritesDenied = !!on; },
        /** How many batch commits have been refused (discovery cost so far). */
        __deniedCommits() { return deniedCommits; }
    };
}

const body = new FakeElement('body');
const store = {};
const realSetTimeout = setTimeout;

const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: {},
    document: {
        body,
        createElement: (tag) => new FakeElement(tag),
        addEventListener() {},
        removeEventListener() {}
    },
    localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
    },
    db: makeFakeFirestore(),
    auth: { currentUser: { email: 'hr@test.com' } },
    innerWidth: 1280,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    firebase: {
        firestore: {
            FieldValue: {
                serverTimestamp: () => ({ __serverTs: true }),
                increment: (n) => ({ __increment: n })
            }
        }
    },
    setTimeout: (fn) => realSetTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: () => 1,
    clearInterval: () => {}
};
sandbox.window.document = sandbox.document;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.db = sandbox.db;
sandbox.window.auth = sandbox.auth;
sandbox.window.innerWidth = sandbox.innerWidth;
sandbox.window.innerHeight = sandbox.innerHeight;
sandbox.window.addEventListener = sandbox.addEventListener;
sandbox.window.removeEventListener = sandbox.removeEventListener;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const Live = sandbox.window.ChatService;
const fakeDb = sandbox.db;
assert(Live, 'window.ChatService missing after load');

(async function run() {
try {
    assert.strictEqual(Live.init({ surface: 'owner', role: 'hr' }), true, 'an HR must be able to mount chat');
    // ⚠️ An HR DOES read the account roster — that is the whole point of "an
    // HR can message every superadmin" — but only through the ONE query the
    // rules' per-document HR clause is provable from:
    // `users.where('role', '==', 'superadmin')`. The filter is what keeps
    // owner and operator accounts out of an HR's reach, so it must be on the
    // very first read the client makes.
    assert.deepStrictEqual(
        fakeDb.__usersReads,
        [['role == superadmin']],
        'an HR viewer must read the roster exactly once, and only with ' +
        "where('role','==','superadmin') — an unfiltered read of `users` is denied " +
        '(got: ' + JSON.stringify(fakeDb.__usersReads) + ')'
    );
    Live.close();

    const listEl = findById(body, 'chatList');
    const inputEl = findById(body, 'chatInput');
    const sendBtn = findById(body, 'chatSendBtn');
    assert(listEl && inputEl && sendBtn, 'conversation-list markup missing');
    // ⚠️ THE "＋" BUTTON AND ITS PICKER ARE GONE, ON PURPOSE. Assert it stays
    //    gone: they were a SECOND way to start a conversation, over the same
    //    set of people the list already offers as "tap to start" rows — a
    //    duplicate entry point into one list, and the easiest one to miss.
    assert.strictEqual(
        findById(body, 'chatNewBtn'),
        null,
        'the ＋ "start a new conversation" button must not come back — the list rows are that control'
    );
    assert.strictEqual(
        findById(body, 'chatNewMenu'),
        null,
        'the floating new-conversation picker must not come back — the list rows are that control'
    );

    // --- Room identity -------------------------------------------------
    // 1. Room ids are SYMMETRIC. This is the whole basis of a 1:1 thread:
    //    both people must derive the SAME id, or each opens their own empty
    //    room and messages silently never arrive.
    const roomBoss = Live.dmRoomIdFor('hr@test.com', 'boss@test.com');
    assert(roomBoss, 'a room id must be derivable for a pair');
    assert.strictEqual(
        roomBoss,
        Live.dmRoomIdFor('boss@test.com', 'hr@test.com'),
        'dmRoomIdFor must be symmetric — otherwise each side opens a different room'
    );
    assert.notStrictEqual(
        roomBoss,
        Live.dmRoomIdFor('hr@test.com', 'other@test.com'),
        'different people must get different rooms'
    );
    assert.strictEqual(Live.dmRoomIdFor('hr@test.com', 'hr@test.com'), null, 'a room with yourself is meaningless');
    assert.strictEqual(Live.dmRoomIdFor('', 'x@y.com'), null, 'an empty email must be refused');
    assert.strictEqual(
        Live.dmRoomIdFor('A@X.com', 'b@x.com'),
        Live.dmRoomIdFor('a@x.com', 'B@X.com'),
        'room ids must be case-insensitive, or one pair ends up with two rooms'
    );
    assert.strictEqual(
        Live.dmRoomIdFor('a+b@x.com', 'c@x.com'),
        Live.dmRoomIdFor('c@x.com', 'a+b@x.com'),
        'unusual characters must not break symmetry'
    );

    // --- Who may be messaged -----------------------------------------
    // 2. The DIRECTORY decides, and conversations are strictly 1:1: an HR
    //    may only start a thread with a SUPERADMIN (the spec's only HR
    //    pairing — the store team meets in the branch group chat). Never
    //    with another HR, never with a store role.
    directoryCallback({
        forEach(fn) {
            fn({ id: 'boss', data: () => ({ email: 'boss@test.com', role: 'superadmin', displayName: 'Boss', title: 'Superadmin', active: true }) });
            fn({ id: 'boss2', data: () => ({ email: 'boss2@test.com', role: 'superadmin', displayName: 'Second Boss', active: true }) });
            fn({ id: 'peerhr', data: () => ({ email: 'peer@hr.com', role: 'hr', displayName: 'Peer HR', active: true }) });
            fn({ id: 'self', data: () => ({ email: 'hr@test.com', role: 'hr', displayName: 'Me', active: true }) });
            // ⚠️ 'viewer', NOT 'owner'. This row stands for "a person who is not
            // a chat role at all", and it used to use 'owner' because owners
            // were excluded from chat. They no longer are — an Area Manager IS
            // a chat role, so this fixture would now be offered to the HR and
            // the test would fail for the right reason at the wrong place.
            // The genuinely ineligible role for "no chat" is anything outside
            // CHAT_ALLOWED_ROLES, so that is what is asserted here.
            fn({ id: 'gone', data: () => ({ email: 'gone@test.com', role: 'viewer', displayName: 'Departed' }) });
        }
    });

    conversationCallback({
        forEach(fn) {
            fn({ id: roomBoss, data: () => ({
                members: ['hr@test.com', 'boss@test.com'],
                lastMessage: 'please review the ticket',
                lastMessageAt: { toDate: () => new Date(5_000_000) },
                lastSenderEmail: 'boss@test.com',
                unreadCount: 2
            }) });
            fn({ id: 'owner-superadmin', data: () => ({
                lastMessage: 'old shared message',
                lastMessageAt: { toDate: () => new Date(1_000_000) },
                lastSenderEmail: 'someone@test.com'
            }) });
        }
    });

    let rows = Live.conversationRows();
    const names = rows.map((r) => r.name);

    assert(names.indexOf('Boss') > -1, 'an existing conversation must appear, got ' + JSON.stringify(names));
    assert(names.indexOf('Second Boss') > -1, 'a superadmin with no thread must still be listed so one can be started');
    assert(names.indexOf('Peer HR') === -1, 'another HR must NOT be offered — conversations are strictly superadmin <-> HR');
    assert(names.indexOf('Me') === -1, 'you must not be offered as a recipient of your own message');
    assert(
        names.indexOf('Departed') === -1,
        'a person whose role is not a CHAT ROLE (here: viewer) must not be offered — the role is ' +
        'the eligibility signal, since the directory doc has no `active` field. (This fixture was ' +
        'formerly role "owner", which no longer works now that the Area Manager is a chat role)'
    );
    assert(
        names.indexOf('All HR — group chat') > -1,
        'the group chat must be listed for everybody — a new HR or superadmin account is in it ' +
        'automatically, so the row can never depend on a summary having arrived'
    );
    assert.strictEqual(
        rows[rows.length - 1].name,
        'All HR — group chat',
        'the group chat must be pinned last so a busy list cannot bury it'
    );
    assert.strictEqual(rows[0].name, 'Boss', 'the list must be ordered by most recent activity');

    const bossRow = rows.filter((r) => r.roomId === roomBoss)[0];
    // Unread is a per-device BOOLEAN derived from localStorage, not a server
    // count: a room `unreadCount` field would need a rules deploy before any
    // message could save, and the list cannot know how many messages arrived
    // without reading the thread. So the badge reads 1 ("new"), never a
    // fabricated number.
    assert.strictEqual(
        bossRow.unread,
        1,
        'a conversation with a newer message from the other person must show as unread'
    );
    assert.strictEqual(bossRow.lastMessage, 'please review the ticket', 'a row must preview the last message');
    const newRow = rows.filter((r) => r.name === 'Second Boss')[0];
    assert.strictEqual(newRow.started, false, 'a superadmin with no thread must be marked not-started');
    assert.strictEqual(
        newRow.roomId,
        Live.dmRoomIdFor('hr@test.com', 'boss2@test.com'),
        'a never-started row must point at the room derived from that pair'
    );

    // 3. The rendered DOM matches, and every row is a real <button> so it is
    //    reachable by keyboard rather than a click-only div.
    assert(/data-room-id="/.test(listEl.innerHTML), 'rows must render into the list element');
        // Three rows are expected: the existing Boss thread, the never-started Second Boss,
    assert(/chat-row-unread">1</.test(listEl.innerHTML), 'the unread badge must be rendered');

    // --- Search --------------------------------------------------------
    // 4. Search filters by name AND by message text, case-insensitively.
    Live.filterConversations('second');
    rows = Live.conversationRows();
    assert.strictEqual(rows.length, 1, 'search by name must narrow the list, got ' + rows.length);
    assert.strictEqual(rows[0].name, 'Second Boss');

    Live.filterConversations('REVIEW');
    rows = Live.conversationRows();
    assert.strictEqual(rows.length, 1, 'search must also match the last message, case-insensitively');
    assert.strictEqual(rows[0].name, 'Boss');

    Live.filterConversations('nobody at all');
    assert(
        /No conversations match/.test(listEl.innerHTML),
        'an empty search must say so rather than showing a blank list'
    );
    Live.filterConversations('');
    // Three rows: the existing Boss thread, the never-started Second Boss,
    // and the pinned group row. The roster ALSO holds an Area Manager
    // ('An Owner') — refused by the spec's pairing for an HR (HR's only
    // personal-chat peer is a superadmin), so it must NOT come back.
    assert.strictEqual(
        Live.conversationRows().length,
        3,
        "clearing the search must restore the full list — minus the Area Manager, which the spec's " +
        'pairing refuses for an HR (superadmin <-> HR only)'
    );

    // --- Switching rooms ----------------------------------------------
    // 5. Opening a conversation points EVERY listener at that room. If any
    //    were left behind on the previous room, one person would see
    //    another person's messages, typing indicator or receipts.
    Live.selectConversation(roomBoss);
    assert.strictEqual(Live.activeRoom(), roomBoss, 'the selected room must become active');
    assert.strictEqual(messageRoomId, roomBoss, 'the message listener must be on the open room');
    assert.strictEqual(presenceRoomId, roomBoss, 'the typing listener must be on the open room');
    assert.strictEqual(receiptsRoomId, roomBoss, 'the read-receipt listener must be on the open room');

    const roomBoss2 = Live.dmRoomIdFor('hr@test.com', 'boss2@test.com');
    Live.selectConversation(roomBoss2);
    // A NEVER-STARTED conversation has no room document, so it must NOT be
    // subscribed: reading a missing room is denied by the membership rule,
    // and a permission error would grey out the launcher and tell the user
    // chat is blocked. The empty state is rendered locally instead.
    assert.strictEqual(messageRoomId, null, 'a never-started conversation must not open a message listener');
    assert.strictEqual(presenceRoomId, null, 'a never-started conversation must not open a typing listener');
    const threadLog = findById(body, 'chatLog');
    assert(
        threadLog && /Send the first message/.test(threadLog.innerHTML),
        'a never-started conversation must invite the first message'
    );

    // ...but the EXISTING thread still moves every listener to itself.
    Live.selectConversation(roomBoss);
    assert.strictEqual(messageRoomId, roomBoss, 'switching back must move the message listener');
    assert.strictEqual(presenceRoomId, roomBoss, 'switching back must move the typing listener');
    assert.strictEqual(receiptsRoomId, roomBoss, 'switching back must move the receipt listener');

    // Re-selecting the same room must not resubscribe.
    messageRoomId = null;
    Live.selectConversation(roomBoss);
    assert.strictEqual(messageRoomId, null, 're-selecting the open conversation must not resubscribe');

    // 6. The GROUP CHAT IS LIVE. `chats/owner-superadmin` is gated on the ROLE
    //    (`isLegacyArchive`), not on a `members` array — that is exactly why a
    //    brand-new HR or superadmin account is in the conversation with nothing
    //    to invite and nothing that can go stale. So the composer must work,
    //    the thread must subscribe, and the message must be written with NO
    //    room preview (the row is pinned and needs none, and the room update
    //    would be refused anyway).
    Live.selectConversation('owner-superadmin');
    assert.strictEqual(Live.activeRoom(), 'owner-superadmin', 'the group chat must be openable');
    assert.strictEqual(inputEl.disabled, false, 'the group chat needs a working composer — it is a live channel');
    assert.strictEqual(sendBtn.disabled, false, 'Send must be enabled in the group chat');
    assert.strictEqual(
        messageRoomId,
        'owner-superadmin',
        'the group thread must subscribe even before any summary has arrived, so it is never blank'
    );
    // Typing now WORKS in the group chat too. It used to be skipped because
    // presence was an `isChatMember` write and that room is role-gated with no
    // members array; the rules now allow publishing presence there on the ROLE
    // (canPublishPresence() in firestore.rules), so the client no longer opts
    // out. This asserts the write actually HAPPENS — the regression that matters
    // is the indicator going missing for everyone in the group again.
    const presenceSetsBefore = presenceWrites.filter((p) => p.op === 'set').length;
    const orderBeforeGroup = writeOrder.length;
    inputEl.value = 'hello everyone';
    inputEl.dispatch('input', {});
    await new Promise((r) => realSetTimeout(r, 0));
    assert.strictEqual(
        presenceWrites.filter((p) => p.op === 'set').length,
        presenceSetsBefore + 1,
        'typing in the GROUP chat MUST publish presence — the rules now allow it on the role, so ' +
        'skipping it here is what made typing silently unavailable to everyone in the group'
    );
    // Sending withdraws the indicator (a DELETE), so the PUBLISH count must not
    // move across the send. This is compared against the count taken AFTER
    // typing — the group chat now legitimately publishes while composing, so
    // measuring against the pre-typing number would count that publish again.
    const presenceSetsAfterTyping = presenceWrites.filter((p) => p.op === 'set').length;
    inputEl.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await new Promise((r) => realSetTimeout(r, 0));
    await new Promise((r) => realSetTimeout(r, 0));
    const groupMessage = sentWrites.filter((w) => w.data && w.data.text === 'hello everyone');
    assert.strictEqual(groupMessage.length, 1, 'the group chat must actually save a message');
    assert.strictEqual(
        presenceWrites.filter((p) => p.op === 'set').length,
        presenceSetsAfterTyping,
        'sending must NOT publish another presence doc — the draft is gone, so the indicator is '
        + 'withdrawn (a delete), not re-published'
    );
    assert(
        writeOrder.slice(orderBeforeGroup).indexOf('room-summary') === -1,
        'the group send must not attempt a room-preview write at all: the row is pinned and the room ' +
        'update would be refused, so a pointless failed write is pure waste'
    );

    // ...and the SHORT-PAYLOAD FALLBACK must exist THERE TOO. The ladder used
    // to be skipped outright for the group room ("there is nothing left to
    // vary"), but the room preview is the only rung that is 1:1-specific: the
    // message payload is the very one a 1:1 send writes, so a deployed
    // `hasOnly()` that predates mentions/replyTo refuses a GROUP message on a
    // fresh browser exactly as it refuses a 1:1 one — and that first message
    // (very often the group one) was the one message in the app with no retry
    // at all.
    //
    // No shape fits here (allowlist `['text']`), on purpose. Both attempts are
    // therefore REFUSED, which is observable as exactly TWO denied commits —
    // with no ladder there would be one — and refusing both also means
    // `messageWritesMinimal` is NOT flipped (it is only set on SUCCESS), so
    // the full payload is still what §14 later proves its fallback on.
    const deniedBeforeGroupRetry = fakeDb.__deniedCommits();
    const orderBeforeGroupRetry = writeOrder.length;
    fakeDb.__setMessageKeyAllowlist(['text']);
    inputEl.value = 'no shape fits';
    inputEl.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await new Promise((r) => realSetTimeout(r, 0));
    await new Promise((r) => realSetTimeout(r, 0));
    fakeDb.__setMessageKeyAllowlist(null);
    assert.strictEqual(
        fakeDb.__deniedCommits() - deniedBeforeGroupRetry,
        2,
        'the GROUP send must retry with the short payload after the full one is refused — the payload ' +
        'rung applies to every room, only the room-preview rung is 1:1-specific'
    );
    assert.strictEqual(
        sentWrites.filter((w) => w.data && w.data.text === 'no shape fits').length,
        0,
        'nothing may be recorded as sent when both shapes are refused'
    );
    assert(
        writeOrder.slice(orderBeforeGroupRetry).indexOf('room-summary') === -1,
        'neither group attempt may write a room summary: the row is pinned and the room is frozen'
    );

    // 7. Re-init is an AUTHORIZATION re-check, not a navigation, so the same
    //    account must keep the thread it has open (a permissions refresh
    //    happens on every page action and must not lose the user's place).
    Live.selectConversation(roomBoss);
    Live.init({ surface: 'owner', role: 'hr' });
    assert.strictEqual(
        Live.activeRoom(),
        roomBoss,
        'a permissions re-check for the same account must not close the open thread'
    );

    // ...but a DIFFERENT account must never inherit it. Otherwise a shared
    // device would show one person the previous user's conversation.
    sandbox.auth.currentUser = { email: 'someone-else@test.com' };
    Live.init({ surface: 'owner', role: 'hr' });
    assert.strictEqual(
        Live.activeRoom(),
        null,
        'a different signed-in account must NOT inherit the previously open conversation'
    );
    sandbox.auth.currentUser = { email: 'hr@test.com' };
    Live.init({ surface: 'owner', role: 'hr' });
    assert.strictEqual(
        inputEl.disabled,
        true,
        'the composer must be disabled until a conversation is chosen'
    );

    // 8. Opening a conversation clears its unread state LOCALLY, with no
    //    Firestore write at all. That is deliberate: writing an `unreadCount`
    //    field would need a rules deploy before the room write is accepted,
    //    and the room write shares an atomic batch with the message — so the
    //    whole send would be rolled back until a deploy happened.
    //
    //    Timestamps are in the PAST relative to Date.now(), because "read up
    //    to now" is stamped with the local clock. A future timestamp would
    //    mean the message arrived after we claimed to have read it, which
    //    correctly keeps the badge lit.
    // Earlier steps already opened this room, which stamped it read. Clear the
    // per-device unread state so this block starts from a genuinely unread
    // conversation.
    store['rcms_chat_unread_hr@test.com'] = '{}';
    conversationCallback({
        forEach(fn) {
            fn({ id: roomBoss, data: () => ({
                members: ['hr@test.com', 'boss@test.com'],
                lastMessage: 'please review the ticket',
                lastMessageAt: { toDate: () => new Date(Date.now() - 5_000) },
                lastSenderEmail: 'boss@test.com'
            }) });
        }
    });
    assert.strictEqual(
        Live.conversationRows().filter((r) => r.roomId === roomBoss)[0].unread,
        1,
        'a newer message from the other person must show the row as unread'
    );
    const writesBeforeOpen = fakeDb.__roomUpdates.length;
    Live.selectConversation(roomBoss);
    assert.strictEqual(
        Live.conversationRows().filter((r) => r.roomId === roomBoss)[0].unread,
        0,
        'opening a conversation must clear its unread badge'
    );
    assert.strictEqual(
        fakeDb.__roomUpdates.length,
        writesBeforeOpen,
        'clearing unread must NOT write to Firestore — that write would need a rules deploy ' +
        'and shares an atomic batch with the message'
    );

    // ...and it must stay cleared, not re-light on the next snapshot.
    conversationCallback({
        forEach(fn) {
            fn({ id: roomBoss, data: () => ({
                members: ['hr@test.com', 'boss@test.com'],
                lastMessage: 'please review the ticket',
                lastMessageAt: { toDate: () => new Date(Date.now() - 5_000) },
                lastSenderEmail: 'boss@test.com'
            }) });
        }
    });
    assert.strictEqual(
        Live.conversationRows().filter((r) => r.roomId === roomBoss)[0].unread,
        0,
        'a conversation already opened must not light up again on a re-render'
    );

    // Our OWN last message never marks the thread unread.
    conversationCallback({
        forEach(fn) {
            fn({ id: roomBoss, data: () => ({
                members: ['hr@test.com', 'boss@test.com'],
                lastMessage: 'my own reply',
                lastMessageAt: { toDate: () => new Date(Date.now() - 4_000) },
                lastSenderEmail: 'hr@test.com'
            }) });
        }
    });
    assert.strictEqual(
        Live.conversationRows().filter((r) => r.roomId === roomBoss)[0].unread,
        0,
        'a conversation whose last message is MINE must not be marked unread'
    );

    // --- Starting a conversation: THE LIST IS THE CONTROL ---------------
    // 9. ⚠️ REWRITTEN WHEN THE ＋ BUTTON AND ITS PICKER WERE REMOVED. These
    //    assertions used to be about a floating picker; the guarantee they
    //    protect did not change, only the way in: the conversation LIST
    //    already offers every person a thread may legitimately be started
    //    with as a "tap to start" row, and clicking that row opens the pair's
    //    room. A second entry point over the same people was the one most
    //    people never found, so the list is now the only way in.
    const startableRows = Live.conversationRows();
    const boss2Row = startableRows.filter((r) => r.peerEmail === 'boss2@test.com')[0];
    assert(boss2Row, 'a superadmin with no thread must still be offered');
    assert.strictEqual(boss2Row.started, false, 'that row must be a "tap to start" row, not a conversation');
    assert.strictEqual(
        startableRows.filter((r) => r.peerEmail === 'peer@hr.com').length,
        0,
        'another HR must never be offered'
    );
    assert.strictEqual(
        startableRows.filter((r) => r.peerEmail === 'hr@test.com').length,
        0,
        'you must never be offered'
    );
    // Click the row the way the delegated list listener sees it: a `.chat-row`
    // ancestor carrying `data-room-id`.
    listEl.dispatch('click', {
        target: {
            closest: (sel) => (sel === '.chat-row'
                ? { getAttribute: (a) => (a === 'data-room-id' ? Live.dmRoomIdFor('hr@test.com', 'boss2@test.com') : null) }
                : null)
        }
    });
    assert.strictEqual(
        Live.activeRoom(),
        Live.dmRoomIdFor('hr@test.com', 'boss2@test.com'),
        'clicking a "tap to start" row must open the conversation with that person'
    );

    // --- The FIRST message in a never-started conversation --------------
    // 9b. ⚠️ THE BUG THIS GUARDS AGAINST. Membership is resolved by READING
    //     THE ROOM: `isChatMember(chatId)` is
    //     `get(chats/{chatId}).data.members has selfEmail()`, and the message
    //     rule inherits that check. The room and the message used to be
    //     written in ONE atomic batch — so on a conversation that had never
    //     been messaged the message was evaluated while its room did not
    //     exist yet, the get() found nothing, and the write was DENIED with
    //     "Chat cannot read or write this conversation". The room therefore
    //     has to be committed FIRST, as its own awaited write; only then may
    //     the message be sent.
    const setsBeforeFirst = roomSets.length;
    const orderBeforeFirst = writeOrder.length;
    const sentBeforeFirst = sentWrites.length;
    // ...and typing BEFORE that first message must not publish a presence doc
    // into the room that does not exist yet. The presence create rule also
    // resolves membership by reading the room, so that write would be denied
    // and chat.js would log its scary "typing indicators are DISABLED" warning
    // on the very first contact with somebody.
    const presenceBeforeFirst = presenceWrites.length;
    inputEl.value = 'the very first message';
    inputEl.dispatch('input', {});
    assert.strictEqual(
        presenceWrites.length,
        presenceBeforeFirst,
        'typing in a never-started conversation must NOT write a presence doc into a room that ' +
        'does not exist — the membership rule denies it and the console cries about the rules'
    );
    inputEl.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await new Promise((r) => realSetTimeout(r, 0));
    await new Promise((r) => realSetTimeout(r, 0));

    assert.deepStrictEqual(
        writeOrder.slice(orderBeforeFirst),
        ['room:' + roomBoss2, 'message', 'room-summary', 'commit'],
        'the room document must be CREATED (its own awaited write) BEFORE the batch that ' +
        'carries the message is committed — the message rule resolves membership with ' +
        'get(chats/{chatId}), which cannot see a room created in the same batch'
    );
    assert.strictEqual(
        roomSets.length,
        setsBeforeFirst + 1,
        'a never-started conversation must create its room exactly once on the first send'
    );
    const createdRoom = roomSets[roomSets.length - 1];
    assert.strictEqual(createdRoom.roomId, roomBoss2, "the room created must be this pair's room");
    assert.strictEqual(
        Array.prototype.join.call(createdRoom.data.members, ','),
        'hr@test.com,boss2@test.com',
        'the room must record exactly the two participants — that array IS the authorisation'
    );
    assert.deepStrictEqual(
        Object.keys(createdRoom.data).sort(),
        ['lastMessage', 'lastMessageAt', 'lastSenderEmail', 'members', 'type'],
        'the room write may carry ONLY the keys the already-deployed rules allowlist, or the ' +
        'write is denied and the conversation can never start'
    );
    assert.strictEqual(
        createdRoom.opts && createdRoom.opts.merge,
        true,
        'the room write must be idempotent ({ merge: true }) so it is also safe when the room ' +
        'already exists and the conversation list simply has not arrived yet'
    );
    assert(
        sentWrites.slice(sentBeforeFirst).filter((w) => w.data && w.data.text === 'the very first message')[0],
        'the first message must still be written'
    );
    assert.strictEqual(
        messageRoomId,
        roomBoss2,
        'once the room exists the thread must subscribe to it, or the message would never appear'
    );
    assert.strictEqual(presenceRoomId, roomBoss2, 'the typing listener must also attach after the first send');
    const firstRow = Live.conversationRows().filter((r) => r.roomId === roomBoss2)[0];
    assert(firstRow, 'the first message must give the conversation a sidebar row');
    assert.strictEqual(firstRow.started, true, 'the row must stop being a "start a conversation" placeholder');
    assert.strictEqual(firstRow.lastMessage, 'the very first message', 'the row must preview the first message');

    // ...but the guard above must not disable typing indicators FOREVER: once
    // the room exists, composing must publish presence again.
    const presenceAfterFirst = presenceWrites.length;
    inputEl.value = 'typing again';
    inputEl.dispatch('input', {});
    assert(
        presenceWrites.length > presenceAfterFirst,
        'after the first message the room exists, so typing must publish presence again'
    );
    inputEl.value = '';
    inputEl.dispatch('input', {});

    // ...and an EXISTING conversation must NOT gain a room write of its own:
    // its summary still rides in the batch with the message.
    const setsBeforeExisting = roomSets.length;
    const orderBeforeExisting = writeOrder.length;
    Live.selectConversation(roomBoss);
    inputEl.value = 'a follow-up';
    inputEl.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await new Promise((r) => realSetTimeout(r, 0));
    await new Promise((r) => realSetTimeout(r, 0));
    assert.strictEqual(roomSets.length, setsBeforeExisting, 'an existing conversation must not re-create its room');
    assert.deepStrictEqual(
        writeOrder.slice(orderBeforeExisting),
        ['message', 'room-summary', 'commit'],
        'an existing conversation must keep the message + summary in ONE atomic batch — the room ' +
        'write only exists to make the room EXIST before the first message'
    );

    // --- Escaping ------------------------------------------------------
    // 10. A display name is user input. It must never become markup in the
    //     sidebar, the thread header, or a picker row.
    // A directory snapshot REPLACES the whole roster, so re-seed everyone and
    // give the hostile name a real conversation — otherwise there is no row
    // for it to be escaped into.
    const roomEvil = Live.dmRoomIdFor('hr@test.com', 'evil@test.com');
    // The account-switch test above tore the module down, so the directory
    // listener is no longer subscribed. refreshDirectory() re-subscribes it
    // against the same fake, which is exactly what a real remount would do.
    Live.refreshDirectory();
    directoryCallback({
        forEach(fn) {
            fn({ id: 'evil', data: () => ({
                email: 'evil@test.com', role: 'superadmin',
                displayName: '<img src=x onerror=alert(1)>', title: '<b>t</b>'
            }) });
        }
    });
    conversationCallback({
        forEach(fn) {
            fn({ id: roomEvil, data: () => ({
                members: ['hr@test.com', 'evil@test.com'],
                lastMessage: 'hi',
                lastMessageAt: { toDate: () => new Date(Date.now() - 1_000) },
                lastSenderEmail: 'hr@test.com'
            }) });
        }
    });



    assert(
        listEl.innerHTML.indexOf('&lt;img') > -1,
        'a directory display name must be rendered ESCAPED in the list, got: ' +
        listEl.innerHTML.slice(0, 200)
    );
    assert(
        listEl.innerHTML.indexOf('<img') === -1,
        'a directory display name must never become raw markup in the list'
    );
    Live.selectConversation(roomEvil);
    assert(listEl.innerHTML.indexOf('<img') === -1, 'a directory display name must be escaped in the list');
    assert(listEl.innerHTML.indexOf('&lt;img') > -1, 'the escaped name must actually be shown');
    Live.selectConversation(Live.dmRoomIdFor('hr@test.com', 'evil@test.com'));
    const titleEl = findById(body, 'chatThreadTitle');

    // The header is written with textContent, so the name is held as a TEXT
    // VALUE equal to the raw string. That is safe: the browser never parses
    // it as markup. Asserting `indexOf('<img') === -1` here would be
    // wrong — it would only pass if the name had been mangled.
    assert.strictEqual(
        titleEl.textContent,
        '<img src=x onerror=alert(1)>',
        'the header must hold the display name verbatim as a text value, never as markup'
    );
    assert.strictEqual(
        titleEl.innerHTML.indexOf('<img'),
        -1,
        'the header element must never receive the name as innerHTML'
    );

    // --- The ACCOUNT ROSTER: a superadmin must see EVERY HR account ------
    // 11. ⚠️ THE BUG THIS GUARDS AGAINST. The people directory is
    //     SELF-PUBLISHED: a person appears in it only after they have opened
    //     the chat and saved a profile, and the `role` in it is whatever was
    //     current at that moment. So a brand-new HR who has never opened the
    //     chat is invisible to the superadmin ("the superadmin cannot see all
    //     the HR accounts"), and an entry published before the role was known
    //     (`role: ''`) is filtered out by isStartable().
    //
    //     The authoritative role lives in `users/{email}.role` — the field the
    //     rules and the dashboard both authorise on — and a SUPERADMIN may
    //     read that collection whole (`allow read: if isSuperAdmin() ||
    //     isSelf()`), which script.js already does in loadSuperadminUsers().
    sandbox.auth.currentUser = { email: 'boss@test.com' };
    const readsBeforeMount = fakeDb.__usersReads.length;
    // The HR mounts earlier in this suite read the roster too — they are the
    // other half of the feature, and each of them must have been the FILTERED
    // query: an unfiltered HR read of `users` is denied by the rules, so an
    // HR-side roster would silently deliver nothing.
    assert(readsBeforeMount > 0, 'every HR mount before this must have read the account roster');
    assert(
        fakeDb.__usersReads.every((f) => f.length === 1 && f[0] === 'role == superadmin'),
        "each HR roster read must be `where('role','==','superadmin')` — the only shape the users read " +
        "rule is provable from (got: " + JSON.stringify(fakeDb.__usersReads) + ")"
    );
    assert.strictEqual(Live.init({ surface: 'owner', role: 'superadmin' }), true, 'a superadmin must mount chat');
    await new Promise((r) => realSetTimeout(r, 0));
    assert.strictEqual(
        fakeDb.__usersReads.length,
        readsBeforeMount + 1,
        'a superadmin mount must read the account roster exactly once'
    );

    // A role change calls ChatService.refreshDirectory() from script.js
    // (approveUser / updateUserPermissions), so a NEWLY APPROVED HR must
    // appear without reloading the page.
    Live.refreshDirectory();
    await new Promise((r) => realSetTimeout(r, 0));
    assert.strictEqual(
        fakeDb.__usersReads.length,
        readsBeforeMount + 2,
        'refreshDirectory() must re-read the roster, or a newly approved HR stays invisible'
    );
    // The roster is a LIVE listener now, so re-subscribing must REPLACE it:
    // a stale one would keep rebuilding the list for the account that is no
    // longer signed in — the same double-subscription leak the directory
    // listener already guards against.
    assert.strictEqual(
        fakeDb.__usersListeners(),
        1,
        'refreshDirectory() must release the previous roster subscription, not stack a second one'
    );

    // An EMPTY directory is the point of this test: nobody has published a
    // profile at all, so everyone offered can only have come from the roster.
    directoryCallback({ forEach() {} });

    const rosterRows = Live.conversationRows();
    const newHrRow = rosterRows.filter((r) => r.peerEmail === 'newhr@test.com')[0];
    assert(
        newHrRow,
        'an HR who has NEVER opened the chat must still be listed for a superadmin — the roster is ' +
        'the only source that knows them'
    );
    assert.strictEqual(newHrRow.started, false, 'a roster-only person must be a "tap to start" row, not a conversation');
    assert.strictEqual(newHrRow.name, 'New HR', 'the roster supplies the registration name, so the row is not an email prefix');
    assert.strictEqual(
        rosterRows.filter((r) => r.peerEmail === 'someowner@test.com').length,
        0,
        "a superadmin must NOT be offered the Area Manager — the spec's pairing is superadmin <-> " +
        'HR only, and personal chat with store personnel lives in the branch group chat (every ' +
        'cell is proved by the pairing matrix in test/chat-access.test.js)'
    );
    assert.strictEqual(
        rosterRows.filter((r) => r.peerEmail === 'boss@test.com').length,
        0,
        'you must never be offered yourself'
    );

    // ...and clicking that same row is what starts the conversation. ⚠️ The ＋
    //    button and its picker used to do this from a second panel; the list
    //    row is now the only way in, so the click has to reach the row.
    //    Re-fetch the element: `Live.init()` above rebuilt the modal, so the
    //    `listEl` captured before it points at a detached tree.
    const rosterListEl = findById(body, 'chatList');
    assert(rosterListEl, 'the rebuilt modal must have a conversation list');
    assert.strictEqual(
        newHrRow.roomId,
        Live.dmRoomIdFor('boss@test.com', 'newhr@test.com'),
        "the row's room id must be derived from that pair — it is what the click opens"
    );
    rosterListEl.dispatch('click', {
        target: {
            closest: (sel) => (sel === '.chat-row'
                ? { getAttribute: (a) => (a === 'data-room-id' ? Live.dmRoomIdFor('boss@test.com', 'newhr@test.com') : null) }
                : null)
        }
    });
    assert.strictEqual(
        Live.activeRoom(),
        Live.dmRoomIdFor('boss@test.com', 'newhr@test.com'),
        'clicking a roster-only HR row must open that pair\'s room'
    );

    // ⚠️ The ROSTER's role must win over a stale DIRECTORY role. `users` is
    //    what the rules authorise on; the directory is only a name badge — an
    //    entry published as `role: ''` (older versions could not know the role
    //    yet) must never hide an account the roster says is an HR.
    directoryCallback({
        forEach(fn) {
            fn({ id: 'stale', data: () => ({ email: 'stale@test.com', role: '', displayName: '', title: '' }) });
        }
    });
    assert(
        Live.conversationRows().filter((r) => r.peerEmail === 'stale@test.com')[0],
        'a directory entry with a stale/empty role must not hide an HR the account roster knows about'
    );

    // A DENIED roster read must degrade to the directory, never break the
    // chat. `users` is readable by a superadmin in the deployed ruleset, but
    // an older or hand-edited ruleset must not take the whole chat down.
    const realWarn = sandbox.console.warn;
    const warnings = [];
    sandbox.console.warn = (msg) => warnings.push(String(msg));
    fakeDb.__setUsersReadDelivers(false);
    Live.refreshDirectory();
    await new Promise((r) => realSetTimeout(r, 0));
    assert(
        warnings.some((w) => w.indexOf('HR roster unavailable') > -1),
        'a denied roster read must be reported clearly instead of swallowed'
    );
    assert(
        Array.isArray(Live.conversationRows()),
        'a denied roster read must leave the conversation list working'
    );

    // ...and it must RECOVER on the next refresh, not stay blind all session.
    fakeDb.__setUsersReadDelivers(true);
    Live.refreshDirectory();
    await new Promise((r) => realSetTimeout(r, 0));
    assert(
        Live.conversationRows().some((r) => r.peerEmail === 'newhr@test.com'),
        'the roster must come back after a transient failure — a denied read must not hide everybody'
    );
    sandbox.console.warn = realWarn;

    // --- A DENIED list QUERY must not empty the conversation list --------
    // 12. ⚠️ THE QUERY CAN BE DENIED WHILE EVERY ROOM DOCUMENT IS READABLE.
    //     A query is authorised as ONE rules evaluation over the whole
    //     collection, and the membership rule resolves each room with
    //     exists()/get(), which cannot be proven that way — so the deployed
    //     ruleset can refuse `chats where members array-contains me` even
    //     though every room document is individually readable.
    //
    //     That is NOT cosmetic. selectConversation() decides whether to open a
    //     thread by finding the room in the summaries, so with an empty list
    //     NO conversation would ever show its history and no unread badge
    //     would ever light up. The list is therefore rebuilt from one
    //     document listener per room.
    const newHrRoom = Live.dmRoomIdFor('boss@test.com', 'newhr@test.com');
    const staleRoom = Live.dmRoomIdFor('boss@test.com', 'stale@test.com');
    fakeDb.__denyList();
    assert(
        fakeDb.__roomListens.indexOf(newHrRoom) > -1,
        'a denied list query must fall back to reading the room documents themselves'
    );
    assert(
        fakeDb.__roomListens.indexOf(staleRoom) > -1,
        'every known peer must get a room listener, including one only the account roster knows about'
    );
    assert(
        fakeDb.__roomListens.indexOf('owner-superadmin') > -1,
        'the legacy archive must be watched too — isLegacyArchive() lets every HR and superadmin read it'
    );

    // Repeating the work must never double up subscriptions.
    const listensAfterDeny = fakeDb.__roomListens.length;
    Live.refreshDirectory();
    await new Promise((r) => realSetTimeout(r, 0));
    assert.strictEqual(
        fakeDb.__roomListens.length,
        listensAfterDeny,
        'a room that is already subscribed must never be subscribed twice'
    );

    // An EXISTING room reports a summary, exactly as the query would have.
    fakeDb.__emitRoom(newHrRoom, {
        members: ['boss@test.com', 'newhr@test.com'],
        lastMessage: 'hello from the HR',
        lastMessageAt: { toDate: () => new Date(Date.now() - 3_000) },
        lastSenderEmail: 'newhr@test.com'
    });
    const startedRow = Live.conversationRows().filter((r) => r.roomId === newHrRoom)[0];
    assert(startedRow, 'a room that exists must appear in the list even when the query is denied');
    assert.strictEqual(startedRow.started, true, 'a per-room report must mark the row as a real conversation');
    assert.strictEqual(startedRow.lastMessage, 'hello from the HR', 'the preview must come from the room document');
    assert.strictEqual(startedRow.unread, 1, 'a room that has not been opened must light up as unread');

    // A room that DOES NOT EXIST is *denied* by the membership rule (it starts
    // with exists()). That is the normal state for somebody you have never
    // messaged: it must log nothing, break nothing, and leave the row as the
    // "tap to start" placeholder it started as.
    fakeDb.__denyRoom(staleRoom);
    const deniedRow = Live.conversationRows().filter((r) => r.roomId === staleRoom)[0];
    assert(
        deniedRow && deniedRow.started === false,
        'a room that does not exist yet must fall back to its "tap to start" row, never stay a conversation'
    );

    // ⚠️ THE RACE THE FALLBACK HAS TO CLOSE. A room can be OPENED before its
    //     document reports: selectConversation() finds no summary, so it shows
    //     the empty state and does not subscribe — and then the room turns out
    //     to exist with history in it. The report itself must attach the
    //     thread, or that conversation opens blank until a page reload.
    Live.selectConversation(staleRoom);
    assert.notStrictEqual(
        messageRoomId,
        staleRoom,
        'there is nothing to subscribe to while the room is still unknown'
    );

    // The retry path: a role change re-reads the directory and the roster,
    // which re-attempts every room whose read was refused.
    Live.refreshDirectory();
    await new Promise((r) => realSetTimeout(r, 0));
    fakeDb.__emitRoom(staleRoom, {
        members: ['boss@test.com', 'stale@test.com'],
        lastMessage: 'an older message',
        lastMessageAt: { toDate: () => new Date(Date.now() - 9_000) },
        lastSenderEmail: 'stale@test.com'
    });
    assert.strictEqual(
        messageRoomId,
        staleRoom,
        'a room that turns out to exist must still open its thread — otherwise its history is invisible'
    );
    const lateRow = Live.conversationRows().filter((r) => r.roomId === staleRoom)[0];
    assert(
        lateRow && lateRow.started === true,
        'a room that only appears later must show up as a real conversation'
    );

    // --- A CONVERSATION MUST NOT VANISH WHEN ITS OTHER SIDE LEAVES -------
    // 13. With the query denied, the sidebar is rebuilt from the rooms of the
    //     people we know (directory ∪ account roster). A conversation whose
    //     other side has since left BOTH — an account re-roled away from the
    //     chat, or a profile entry deleted — would disappear from the list and
    //     take its history with it, because a denied query is the only thing
    //     that could rediscover an unknown room. Every room this device has
    //     seen is therefore remembered and re-checked.
    const gonePeer = 'gone@test.com';
    const alsoGonePeer = 'alsogone@test.com';
    const goneRoom = Live.dmRoomIdFor('boss@test.com', gonePeer);
    const alsoGoneRoom = Live.dmRoomIdFor('boss@test.com', alsoGonePeer);
    const roomDataFor = (peer) => ({
        members: ['boss@test.com', peer],
        lastMessage: 'written before they were re-roled',
        lastMessageAt: { toDate: () => new Date(Date.now() - 20_000) },
        lastSenderEmail: peer
    });
    const startedRowFor = (roomId) =>
        Live.conversationRows().filter((r) => r.roomId === roomId && r.started)[0];
    const settle = async () => {
        await new Promise((r) => realSetTimeout(r, 0));
        await new Promise((r) => realSetTimeout(r, 0));
    };

    // While they are still in the directory, both conversations are ordinary.
    directoryCallback({
        forEach(fn) {
            fn({ id: 'gone', data: () => ({ email: gonePeer, role: 'hr', displayName: 'Gone HR' }) });
            fn({ id: 'alsogone', data: () => ({ email: alsoGonePeer, role: 'hr', displayName: 'Also Gone' }) });
        }
    });
    fakeDb.__emitRoom(goneRoom, roomDataFor(gonePeer));
    fakeDb.__emitRoom(alsoGoneRoom, roomDataFor(alsoGonePeer));
    assert(
        startedRowFor(goneRoom) && startedRowFor(alsoGoneRoom),
        'a conversation must be listed while its peer is still a known person'
    );

    // Now BOTH peers leave every roster (an account re-roled away from the
    // chat), and the page is re-initialised — which drops every listener the
    // way a reload does. The query is denied again, exactly as in production,
    // so the ONLY thing that can bring these conversations back is the
    // remembered room list.
    directoryCallback({ forEach() {} });
    fakeDb.__setUsersDocs([
        { id: 'newhr@test.com', data: () => ({ email: 'newhr@test.com', name: 'New HR', role: 'hr' }) },
        { id: 'boss@test.com', data: () => ({ email: 'boss@test.com', name: 'Boss', role: 'superadmin' }) }
    ]);
    // A full re-initialisation, the way a reload behaves: a role that the
    // chat refuses tears the module down (releasing every listener), and the
    // superadmin mount starts again from scratch. Live.close() would NOT do
    // this — it only hides the modal and deliberately keeps the listeners so
    // the launcher badge keeps working while the chat is closed.
    //
    // ⚠️ The tearing-down role is 'operator', NOT 'owner'. This used to be
    // 'owner', which was correct while the Area Manager was excluded from
    // chat. They are a full chat role now, so mounting as one no longer
    // releases the listeners and this test silently stopped exercising the
    // teardown path it is about. 'operator' is still refused everywhere.
    Live.init({ surface: 'owner', role: 'operator' });
    const listensBeforeRecall = fakeDb.__roomListens.length;
    Live.init({ surface: 'owner', role: 'superadmin' });
    await settle();
    fakeDb.__denyList();
    // The directory reports (and is still empty of these two).
    directoryCallback({ forEach() {} });
    await settle();
    const recalled = fakeDb.__roomListens.slice(listensBeforeRecall);
    assert(
        recalled.indexOf(goneRoom) > -1 && recalled.indexOf(alsoGoneRoom) > -1,
        'a remembered room must be re-checked even when its peer is in NO roster at all — otherwise the ' +
        'conversation and its history silently disappear while the query stays denied'
    );

    // The one whose room still exists keeps its conversation...
    fakeDb.__emitRoom(goneRoom, roomDataFor(gonePeer));
    assert(
        startedRowFor(goneRoom),
        'a conversation must survive its peer leaving every roster'
    );

    // ...and the one that is really gone is refused, its peer is in no roster
    // at all, and the people sources have settled — so it is forgotten instead
    // of being re-read every minute for the rest of the session.
    fakeDb.__denyRoom(alsoGoneRoom);
    const listensBeforeForget = fakeDb.__roomListens.length;
    Live.refreshDirectory();
    await settle();
    assert.strictEqual(
        fakeDb.__roomListens.slice(listensBeforeForget).indexOf(alsoGoneRoom),
        -1,
        'a room that cannot be read and whose peer is in no roster must be forgotten — it is gone for ' +
        'good, and re-reading it every minute would be a slow leak'
    );
    assert(
        startedRowFor(goneRoom),
        'forgetting one dead room must not disturb the conversation beside it'
    );
    // The GROUP chat is a channel everybody is in from the start, so its row
    // cannot depend on a summary arriving — at this point in the test no group
    // summary has ever been reported.
    const groupRow = Live.conversationRows()[Live.conversationRows().length - 1];
    assert.strictEqual(
        groupRow.roomId,
        'owner-superadmin',
        'the group chat must be listed even with no summary at all — a new HR or superadmin account is ' +
        'in it by ROLE, and nobody has to be added to anything'
    );

    // --- A DEPLOYED MESSAGE RULE OLDER THAN THE CLIENT ------------------
    // 14. The room write SUCCEEDS and the MESSAGE write is refused — the exact
    //     production report ("[Chat] Failed to send message: Missing or
    //     insufficient permissions"). A room and a message in ONE batch would
    //     fail TOGETHER, so one passing and one failing means the refusal is
    //     specific to the message document — almost always a deployed
    //     `hasOnly()` allowlist older than this client's payload.
    const inputEl2 = findById(body, 'chatInput');
    const launchersNow = () => body.children.filter((c) => c.className === 'chat-launcher');
    Live.selectConversation(goneRoom);
    assert.strictEqual(
        messageRoomId,
        goneRoom,
        'the thread must be subscribed before sending, or this test proves nothing'
    );

    // The five fields this app has always documented for a message.
    fakeDb.__setMessageKeyAllowlist(['text', 'senderEmail', 'senderName', 'senderRole', 'sentAt']);
    inputEl2.value = 'hello there';
    inputEl2.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await settle();
    const stored = sentWrites.filter((w) => w.data && w.data.text === 'hello there');
    assert.strictEqual(
        stored.length,
        1,
        'the refused attempt must roll back completely and the retry must save the message exactly once'
    );
    assert.deepStrictEqual(
        Object.keys(stored[0].data).sort(),
        ['senderEmail', 'senderName', 'senderRole', 'sentAt', 'text'],
        'the retry must carry ONLY the five documented fields — that is the whole point of the fallback'
    );
    assert.strictEqual(
        stored[0].data.senderEmail,
        'boss@test.com',
        'senderEmail must be lowercased: the create rule compares it against selfEmail(), which is ' +
        'request.auth.token.email.lower()'
    );
    assert.strictEqual(
        launchersNow()[0]._classes.indexOf('chat-launcher-disabled'),
        -1,
        'a refused write must NEVER grey the chat out — that locks the user out of their own history'
    );
    assert.strictEqual(Live.isMounted(), true, 'the chat must stay mounted after a send problem');

    // Even when BOTH payloads are refused, the chat stays usable and honest.
    fakeDb.__setMessageKeyAllowlist(['text']);
    inputEl2.value = 'this cannot be saved';
    inputEl2.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await settle();
    assert.strictEqual(
        sentWrites.filter((w) => w.data && w.data.text === 'this cannot be saved').length,
        0,
        'nothing may be recorded as sent when both attempts are refused'
    );
    assert.strictEqual(
        launchersNow()[0]._classes.indexOf('chat-launcher-disabled'),
        -1,
        'an unsendable message must not disable the chat either — the user can still read everything'
    );
    assert.strictEqual(Live.isMounted(), true, 'the chat must survive a send that the rules refuse');
    fakeDb.__setMessageKeyAllowlist(null);

    // ⚠️ THE CASING INVARIANT, END TO END. The create rule is
    //     `request.resource.data.senderEmail == selfEmail()` and selfEmail() is
    //     `request.auth.token.email.lower()`, so the payload and the rule must
    //     be in the same case. (Today `currentUserEmail` is already lowercased
    //     by init(), so this pins the invariant rather than proving a past
    //     failure — the point is that no future "simplification" back to
    //     `auth.currentUser.email` can slip through unnoticed.)
    sandbox.auth.currentUser = { email: 'Boss@Test.com' };
    Live.init({ surface: 'owner', role: 'superadmin' });
    await settle();
    fakeDb.__denyList();
    const goneRoom2 = Live.dmRoomIdFor('boss@test.com', gonePeer);
    fakeDb.__emitRoom(goneRoom2, roomDataFor(gonePeer));
    Live.selectConversation(goneRoom2);
    const inputEl3 = findById(body, 'chatInput');
    inputEl3.value = 'casing check';
    inputEl3.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await settle();
    const casingMsg = sentWrites.filter((w) => w.data && w.data.text === 'casing check')[0];
    assert(casingMsg, 'a message from a mixed-case auth address must still be saved');
    assert.strictEqual(
        casingMsg.data.senderEmail,
        'boss@test.com',
        'senderEmail must be written LOWERCASED — the rule compares it against a lowercased email, so a ' +
        'raw `auth.currentUser.email` with capitals in it is refused'
    );

    // --- WHEN IT IS THE ROOM PREVIEW THE RULES REFUSE --------------------
    // 15. The room can be CREATED (the standalone write the deployed rules
    //     plainly allow) while the room UPDATE inside the message batch is
    //     refused — e.g. a rule that only allows updates to the legacy room.
    //     A batch is ATOMIC, so that one refused write takes the message down
    //     with it and the report blames the message. The message itself must
    //     still get through, on its own.
    fakeDb.__denyPreviewWrites(true);
    const roomSetsBeforePreview = roomSets.length;
    inputEl3.value = 'preview denied';
    inputEl3.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await settle();
    const withoutPreview = sentWrites.filter((w) => w.data && w.data.text === 'preview denied');
    assert.strictEqual(
        withoutPreview.length,
        1,
        'a refused room PREVIEW must not take the message down with it — the message is sent on its own'
    );
    assert(
        roomSets.length > roomSetsBeforePreview,
        'the room preview must still be written on its own afterwards — the standalone room write is the ' +
        'one the deployed rules DO allow, so the sidebar must not freeze for the rest of the session'
    );
    assert.deepStrictEqual(
        Object.keys(withoutPreview[0].data).sort(),
        ['senderEmail', 'senderName', 'senderRole', 'sentAt', 'text'],
        'and it goes with the short payload, the only shape known to be acceptable by then'
    );
    assert.strictEqual(
        launchersNow()[0]._classes.indexOf('chat-launcher-disabled'),
        -1,
        'losing the atomic preview must not disable anything'
    );
    // ...and the next message must not pay for the discovery again.
    const orderBeforeSecond = writeOrder.length;
    inputEl3.value = 'second message';
    inputEl3.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await settle();
    assert.strictEqual(
        sentWrites.filter((w) => w.data && w.data.text === 'second message').length,
        1,
        'the second message must be saved too'
    );
    assert(
        writeOrder.slice(orderBeforeSecond).indexOf('room-summary') === -1,
        'the learned shape is used straight away: no room-preview write is attempted again in the batch'
    );
    fakeDb.__denyPreviewWrites(false);

    // --- WHAT THE DISCOVERY MUST NOT COST, AND WHAT IT MUST KEEP RIGHT ---
    // 16a. The shape is REMEMBERED. A reload must not pay for the discovery
    //      again — no refused write at all before the message goes through.
    const deniedBeforeRemount = fakeDb.__deniedCommits();
    Live.init({ surface: 'owner', role: 'owner' });
    Live.init({ surface: 'owner', role: 'superadmin' });
    await settle();
    fakeDb.__denyList();
    fakeDb.__emitRoom(goneRoom2, roomDataFor(gonePeer));
    Live.selectConversation(goneRoom2);
    const inputEl4 = findById(body, 'chatInput');
    inputEl4.value = 'after a reload';
    inputEl4.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await settle();
    assert.strictEqual(
        sentWrites.filter((w) => w.data && w.data.text === 'after a reload').length,
        1,
        'the message must still be saved after a reload'
    );
    assert.strictEqual(
        fakeDb.__deniedCommits(),
        deniedBeforeRemount,
        'the accepted write shape must be REMEMBERED per account — otherwise every page load pays ' +
        'two refused writes (and another console warning) to rediscover it'
    );
    assert.deepStrictEqual(
        JSON.parse(String(store['rcms_chat_send_shape_boss@test.com'])),
        { minimal: true, preview: false },
        'the discovered shape must be stored per account, so a real page reload starts in the working ' +
        'shape instead of failing its way back to it'
    );

    // 16b. The sidebar line must stay correct even though the server-side room
    //      summary is frozen: the newest message this device has seen is the
    //      truth, so an INCOMING message must repaint the row.
    if (typeof listenerCallback !== 'function') {
        throw new Error('the thread listener is not attached — 16b would prove nothing');
    }
    listenerCallback({
        forEach(fn) {
            fn({
                id: 'incoming-1',
                data: () => ({
                    text: 'reply from the other side',
                    senderEmail: gonePeer,
                    // Newer than everything already in the row — a reply always
                    // is. (An OLDER message must be ignored, which is what the
                    // guard in syncSummaryFromMessage() is for.)
                    sentAt: { toDate: () => new Date(Date.now() + 1_000) }
                })
            });
        }
    });
    const repainted = Live.conversationRows().filter((r) => r.roomId === goneRoom2)[0];
    assert(
        repainted && repainted.lastMessage === 'reply from the other side',
        'an incoming message must repaint the sidebar line, because the deployed rules freeze the ' +
        "server-side room summary — got: " + String(repainted && repainted.lastMessage)
    );

    // --- THE SAME ROSTER, THE OTHER WAY ROUND: an HR must see EVERY
    //     SUPERADMIN, and new accounts must appear LIVE --------------------
    // 16c. ⚠️ THE BUG THIS GUARDS AGAINST. Until the roster served both
    //      sides, an HR could only message superadmins who had PUBLISHED A
    //      CHAT PROFILE: a brand-new superadmin — registered, never opened
    //      the app — simply did not exist in the list. `users` is the one
    //      source that knows an account the moment it is registered, and the
    //      rules serve it to an HR — but only through the query their
    //      per-document clause is provable from.
    sandbox.auth.currentUser = { email: 'hr@test.com' };
    assert.strictEqual(Live.init({ surface: 'owner', role: 'hr' }), true, 'an HR must mount chat');
    await settle();
    assert.deepStrictEqual(
        fakeDb.__usersReads[fakeDb.__usersReads.length - 1],
        ['role == superadmin'],
        "the HR's own mount must ask with where('role','==','superadmin') — the shape the users read rule " +
        'is provable from; an unfiltered read would be denied'
    );
    // Empty directory on purpose: everybody offered can only have come from the roster.
    directoryCallback({ forEach() {} });
    const hrRosterRows = Live.conversationRows();
    assert(
        hrRosterRows.some((r) => r.peerEmail === 'boss@test.com'),
        'a superadmin who has NEVER published a profile must still be listed for an HR — the roster is the ' +
        'only source that knows them'
    );
    assert(
        !hrRosterRows.some((r) => r.peerEmail === 'newhr@test.com'),
        'another HR must never be offered to an HR — isStartable() pairs HR with superadmin only'
    );
    // ⚠️ AUTO-UPDATE, BOTH DIRECTIONS. A snapshot from the SERVER (an account
    //    registered or approved on another device, while this chat is open)
    //    must repaint the list with no refreshDirectory() and no reload —
    //    and a live read may not widen who is offered.
    const liveUsers = [
        { id: 'boss@test.com', data: () => ({ email: 'boss@test.com', name: 'Boss', role: 'superadmin' }) },
        { id: 'newboss@test.com', data: () => ({ email: 'newboss@test.com', name: 'New Boss', role: 'superadmin' }) },
        { id: 'newhr@test.com', data: () => ({ email: 'newhr@test.com', name: 'New HR', role: 'hr' }) },
        { id: 'someowner@test.com', data: () => ({ email: 'someowner@test.com', name: 'An Owner', role: 'owner' }) }
    ];
    fakeDb.__emitUsers(liveUsers);
    assert(
        Live.conversationRows().some((r) => r.peerEmail === 'newboss@test.com'),
        'a superadmin registered while the chat is open must appear with no reload and no refresh call'
    );
    assert(
        !Live.conversationRows().some((r) => r.peerEmail === 'someowner@test.com'),
        "the live snapshot must still honour the PAIRING rule: a superadmin is NOT offered the " +
        'Area Manager — the spec restricts personal chat to superadmin <-> HR, and a live read ' +
        'may not widen the list'
    );
    assert(
        !Live.conversationRows().some((r) => r.peerEmail === 'newhr@test.com'),
        'the live snapshot must still be filtered to a DIFFERENT role — a live read may not widen ' +
        'the list. For a superadmin that means another HR is never offered'
    );
    // ...and the same guarantee seen from the other side: a superadmin
    // watching for a newly approved HR.
    sandbox.auth.currentUser = { email: 'boss@test.com' };
    assert.strictEqual(Live.init({ surface: 'owner', role: 'superadmin' }), true, 'a superadmin must mount chat');
    await settle();
    fakeDb.__emitUsers(liveUsers.concat([
        { id: 'newhr2@test.com', data: () => ({ email: 'newhr2@test.com', name: 'Fresh HR', role: 'hr' }) }
    ]));
    assert(
        Live.conversationRows().some((r) => r.peerEmail === 'newhr2@test.com'),
        'an HR approved while the chat is open must appear for a superadmin with no reload either'
    );

    // Under the new spec the Area Manager is NOT a 1:1 personal-chat
    // participant — store roles meet HR and the superadmin in the branch
    // group chat instead. What must never regress: no personal-chat row and
    // no group-chat row for the manager; the refusal holds at the data
    // layer. An Area Manager still mounts chat on their dashboard.
    // ================================================================
    console.log('\n=== An Area Manager: no personal chat, group no, co-managers no ===');

    const amEmail = 'manager.one@test.com';
    const otherAmEmail = 'manager.two@test.com';
    sandbox.auth.currentUser = { email: amEmail };
    fakeDb.__usersReads.length = 0;

    assert.strictEqual(
        Live.init({ surface: 'owner', role: 'owner' }),
        true,
        'an AREA MANAGER must be able to mount chat on their dashboard'
    );
    await settle();

    // The roster query. `in` is the ONLY shape the per-direction users
    // so their roster is empty even though the users read stays provable.
    // An Area Manager still mounts chat on the dashboard; what must never regress: no personal-chat row and no group-chat row for the manager — the refusal holds at the data layer.
    const amRosterRead = fakeDb.__usersReads[fakeDb.__usersReads.length - 1];
    assert.strictEqual(
        amRosterRead.length,
        1,
        "an Area Manager's roster read must carry exactly ONE filter (got: " +
        JSON.stringify(amRosterRead) + ')'
    );
    assert.strictEqual(
        amRosterRead[0].indexOf('role in '),
        0,
        "the Area Manager's roster read must be where('role','in',[...]) — the only shape the " +
        "isAreaManager() users clause is provable from (got: " + amRosterRead[0] + ')'
    );
    // The ONE role an Area Manager may message (RM/SM) must be in that
    // filter, and their OWN role must not — which is what keeps one manager
    // out of another's list.
    // (The fake records `field op value` as a plain string, so the array is
    // rendered unquoted — the assertion matches the ROLE NAMES, not the
    // punctuation, which is the fake's business and not the client's.)
    // Under the new spec the Area Manager never starts a personal thread,
    // so their roster is empty even though the users read stays provable.
    // ⚠️ The check is on the ROSTER-derived rows (`started: false` — the
    // "tap to start" rows fed by `startableEmails()`), NOT on every row and
    // NOT on `fakeDb.__usersReads` (that array holds the query FILTERS, and
    // the read above deliberately carries one so Firestore can prove it).
    // Room-derived rows from earlier sections in this suite are still in
    // `conversationSummaries` and must not be counted against this role.
    assert.strictEqual(
        Live.conversationRows().filter(function (r) { return !r.started && r.peerEmail; }).length,
        0,
        "an Area Manager roster must be EMPTY (no personal-chat roster; got: " +
        JSON.stringify(Live.conversationRows().filter(function (r) { return !r.started; })) + ")"
    );
    console.log('  PASS  the roster is EMPTY for the Area Manager — no personal chat under the new spec');

    // The people they might be offered — under the spec every personal-chat
    // pairing for a store role is refused; the branch group chat carries them.
    const amRmEmail = 'rm.one@test.com';
    fakeDb.__emitUsers([
        { id: 'newhr@test.com', data: () => ({ email: 'newhr@test.com', name: 'New HR', role: 'hr' }) },
        { id: 'boss@test.com', data: () => ({ email: 'boss@test.com', name: 'Boss', role: 'superadmin' }) },
        { id: otherAmEmail, data: () => ({ email: otherAmEmail, name: 'Other Manager', role: 'owner' }) },
        { id: amRmEmail, data: () => ({ email: amRmEmail, name: 'RM One', role: 'rmsm' }) },
        { id: 'operator@test.com', data: () => ({ email: 'operator@test.com', name: 'An Operator', role: 'operator' }) }
    ]);
    const amRows = Live.conversationRows();
    assert(
        !amRows.some((r) => r.peerEmail === amRmEmail),
        "an Area Manager must NOT be offered an RM/SM — spec: store personnel meet in the BRANCH GROUP chat, " +
        'never in a personal thread (Rule 5)'
    );
    assert(
        !amRows.some((r) => r.peerEmail === 'newhr@test.com'),
        'an Area Manager must NOT be offered an HR — the spec moves that pairing into the STORE GROUP chat'
    );
    assert(
        !amRows.some((r) => r.peerEmail === 'boss@test.com'),
        'an Area Manager must NOT be offered a superadmin (spec: superadmin <-> HR only)'
    );
    assert(
        !amRows.some((r) => r.peerEmail === otherAmEmail),
        '⚠️ CO-MANAGERS: an Area Manager must NEVER be offered another Area Manager'
    );
    assert(
        !amRows.some((r) => r.peerEmail === 'operator@test.com'),
        'an operator is not a chat role and must never be offered'
    );
    console.log('  PASS  offered: none; refused: RM/SM + HR + superadmin + co-manager + operator (all in the branch group chat)');

    // ⚠️ THE GROUP ROW. This is the row that must be absent.
    assert(
        !amRows.some((r) => r.roomId === Live.LEGACY_ROOM_ID),
        '⚠️ the "All HR — group chat" row must NOT be offered to an Area Manager — the rules deny ' +
        'them that room, so the row could only ever be a guaranteed permission error'
    );
    // NB: the assertion is on the ROW MODEL, not on `listEl.innerHTML`. The
    // fake element is reused across every mount in this suite and keeps the
    // markup from the previous one, so a raw innerHTML scan reports rows from
    // earlier HR/superadmin sections that a real browser would have discarded
    // on the innerHTML assignment. The rendered-DOM check for this gate lives
    // NB: the assertion above is on the ROW MODEL, not on `listEl.innerHTML`.
    // The fake element is reused across every mount in this suite and keeps the
    // markup from the previous one, so a raw innerHTML scan reports rows from
    // earlier HR/superadmin sections that a real browser would have discarded
    // on the innerHTML assignment. The rendered-DOM check for this gate lives
    // in test/chat-access.test.js, which mounts each role on a fresh list.
    console.log('  PASS  the All HR group row is absent for an Area Manager');

    // ...and the same page, seen as HR, must still show it. Without this the
    // gate could pass simply by breaking the group chat for everyone.
    sandbox.auth.currentUser = { email: 'hr@test.com' };
    assert.strictEqual(Live.init({ surface: 'owner', role: 'hr' }), true, 'an HR must still mount chat');
    await settle();
    assert(
        Live.conversationRows().some((r) => r.roomId === Live.LEGACY_ROOM_ID),
        'the group row must STILL be offered to an HR — the Area Manager gate must not have broken ' +
        'the group chat for everybody else'
    );
    // The REFUSAL, seen from the HR side. An Area Manager appears in the
    // DIRECTORY (profiles are readable by any chat role), so the only thing
    // keeping them off an HR's list is the PAIRING rule — and by the spec
    // that pairing is refused in BOTH directions: an HR's only personal-chat
    // peer is a superadmin.
    directoryCallback({
        forEach(fn) {
            fn({ id: amEmail, data: () => ({ email: amEmail, role: 'owner', displayName: 'Manager One' }) });
        }
    });
    assert(
        !Live.conversationRows().some((r) => r.peerEmail === amEmail),
        'an HR must NOT be offered an Area Manager — the pairing is symmetric, so the refusal ' +
        'holds from both sides (store personnel meet HR in the branch group chat)'
    );
    console.log('  PASS  the group chat still works for HR, and the Area Manager stays refused');

    // --- A BRAND-NEW FIRESTORE: THE GROUP CHAT'S FIRST EVER MESSAGE --------
    // 17. ⚠️⚠️ THE BUG THIS GUARDS AGAINST — the reported one.
    //     `chats/owner-superadmin` is FROZEN BY DESIGN: firestore.rules denies
    //     BOTH `allow create` and `allow update` on it via
    //     `&& !isLegacyArchive(chatId)`. It also has NO `members` array, so the
    //     conversation-list query (`where('members','array-contains', me)`) can
    //     never return it and `conversationSummaries[LEGACY_ROOM_ID]` is
    //     therefore PERMANENTLY undefined.
    //
    //     sendMessage() used to do `if (!roomIsStarted) await roomRef().set(…)`
    //     with `roomIsStarted = Boolean(conversationSummaries[activeRoomId])`.
    //     In the group room that was ALWAYS false, so on a fresh Firestore — the
    //     one place where the document genuinely does not exist — the client
    //     attempted a CREATE the rules refuse on purpose. It threw at
    //     `stage === 'room'`, which ALSO skipped the payload-shape ladder
    //     (gated on `stage === 'message'`), so nothing was ever retried, and the
    //     failure was reported as "run firebase deploy --only firestore:rules"
    //     — advice that cannot help, because this repo's own rules refuse it too.
    //     The user's 1:1s kept working, which made it look like a rules-version
    //     problem rather than a client one.
    //
    //     No parent document is needed: the group's message rule is
    //     `allow create: if isLegacyArchive(chatId) && …`, which is ROLE-gated
    //     and never checks `exists()`.
    sandbox.auth.currentUser = { email: 'hr@test.com' };
    assert.strictEqual(Live.init({ surface: 'owner', role: 'hr' }), true, 'an HR must mount chat');
    await settle();
    // A fresh database: the list query delivers NOTHING — not even a room
    // document for the group chat, which is exactly the state that broke.
    conversationCallback({ forEach() {} });
    const freshInput = findById(body, 'chatInput');
    const freshSend = findById(body, 'chatSendBtn');
    assert(freshInput && freshSend, 'the composer must exist after a fresh mount');

    Live.selectConversation(Live.LEGACY_ROOM_ID);
    assert.strictEqual(
        Live.activeRoom(),
        Live.LEGACY_ROOM_ID,
        'the group chat must be openable on a fresh Firestore — a new HR is in it by ROLE'
    );
    // The group row must exist with no summary at all, and the composer must be
    // live: this is a channel, not an archive.
    assert(
        Live.conversationRows().some((r) => r.roomId === Live.LEGACY_ROOM_ID),
        'the pinned group row must be listed on a fresh Firestore, with no summary behind it'
    );
    assert.strictEqual(
        freshInput.disabled,
        false,
        'the group chat needs a working composer on a fresh Firestore — this is the first message of the ' +
        'channel, and it is exactly the one that used to be refused'
    );

    const roomSetsBeforeFresh = roomSets.length;
    const orderBeforeFresh = writeOrder.length;
    const presenceBeforeFresh = presenceWrites.filter((p) => p.op === 'set').length;
    // Typing first: presence must publish here too. It is a per-room write that
    // used to wait for a summary that can NEVER arrive in this room, so typing
    // indicators were silently dead for the whole group on a fresh database.
    freshInput.value = 'first words';
    freshInput.dispatch('input', {});
    await settle();
    assert.strictEqual(
        presenceWrites.filter((p) => p.op === 'set').length,
        presenceBeforeFresh + 1,
        'typing in the GROUP chat on a FRESH Firestore MUST publish presence — that room has no ' +
        '`members` array, so the summary the old guard waited for could never arrive and typing was ' +
        'dead for every member until somebody happened to send a first message'
    );

    freshInput.dispatch('keydown', { key: 'Enter', shiftKey: false });
    await settle();
    await settle();

    assert.strictEqual(
        roomSets.length,
        roomSetsBeforeFresh,
        '⚠️ THE GROUP ROOM MUST NEVER BE WRITTEN. Its document is frozen by the rules by design ' +
        '(`allow create`/`allow update` both carry `&& !isLegacyArchive(chatId)`), so this write can ' +
        'only ever be refused — and on a fresh Firestore that refusal took the whole send down with it'
    );
    assert(
        writeOrder.slice(orderBeforeFresh).indexOf('room:' + Live.LEGACY_ROOM_ID) === -1,
        'no room-document write may be attempted for the group chat, in the batch or standalone'
    );
    assert(
        writeOrder.slice(orderBeforeFresh).indexOf('room-summary') === -1,
        'no room-summary preview may be written for the group chat: the row is pinned and the room is frozen'
    );
    assert.strictEqual(
        sentWrites.filter((w) => w.data && w.data.text === 'first words').length,
        1,
        '⚠️ THE FIRST GROUP MESSAGE ON A FRESH FIRESTORE MUST SAVE. This is the send that was refused ' +
        'with a permission error misreported as "the deployed rules need a deploy"'
    );
    console.log('  PASS  the first group message on a FRESH Firestore saves, writing no room document');

    console.log('✅ Conversation list tests passed (symmetric room ids; strict 1:1 role pairing ' +
        'superadmin <-> HR only — an AREA MANAGER is offered NO personal chat (never RM/SM, ' +
        'never HR, never superadmin, never the group row, never another manager — store personnel ' +
        'meet in the BRANCH GROUP chat); ' +
        'the role-gated All HR GROUP chat (pinned, live, no per-room writes attempted in it — ' +
        'including its FIRST message on a brand-new Firestore); ' +
        'search by name and message; listeners follow the open room; ' +
        'unread cleared on open; starting a conversation from a list row (no ＋ button, no picker); the room ' +
        'committed BEFORE the first message; ' +
        'every HR account listed for a superadmin from `users`, every superadmin listed for an HR through ' +
        'the role-scoped query, and new accounts appearing LIVE in both directions; a DENIED list query rebuilt from ' +
        'per-room document reads; a conversation survives its peer leaving every roster; a message ' +
        'refused by an OLD deployed rule is retried in three shapes (short payload, then without the ' +
        'room preview) and never disables the chat; the accepted shape is remembered, and the sidebar ' +
        'line is derived from the message stream; escaping).');
} catch (err) {
    // ❌ prefix to match the other suites, and keep a short stack: a bare
    // message here is usually a vm frame that says nothing useful.
    console.error('❌ ' + (err && err.message ? err.message : err));
    if (err && err.stack) console.error(err.stack.split('\n').slice(1, 5).join('\n'));
    process.exitCode = 1;
    return;
}
process.exitCode = 0;
})();




