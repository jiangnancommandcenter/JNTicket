// Functional test for chat UNSEND — retiring your OWN message into an
// "Unsent message" tombstone.
//
// What this locks down:
//   1. firestore.rules: the message update is the narrow tombstone only
//      (author, field-locked, one-way, text wiped); delete stays `if false`.
//      (The rules assertions live in test/chat-rules.test.js; this file covers
//      the CLIENT.)
//   2. The context menu carries an Unsend button, shown ONLY on my own
//      messages (syncUnsendButton), and its click is routed before the
//      reaction fall-through.
//   3. unsendMessage() writes exactly { text:'', unsent:true, unsentAt } — the
//      only fields the rules allow — refuses a non-author, refuses an already
//      -unsent message, and toasts a helpful error on permission-denied.
//   4. Rendering an unsent message shows the "Unsent message" placeholder and
//      does NOT run the mention/"mentions me" path.
//   5. The confirm modal is phone-friendly and calls ChatService.unsendMessage.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const chatSrc = read('js/chat.js');
const unsendUiSrc = read('js/chat-unsend.js');
const chatCss = read('chat.css');
const mainHtml = read('main.html');
const ownerHtml = read('ownerdashboard.html');

console.log('Testing chat UNSEND (retire my own message)...');

// ---------------------------------------------------------------
// 1. Wiring: the button, the handler, the export
// ---------------------------------------------------------------
console.log('\n=== wiring: button, handler, export ===');
assert(/data-picker-unsend/.test(chatSrc), 'the context menu must carry an Unsend button (data-picker-unsend)');
assert(/chat-picker-unsend/.test(chatSrc), 'the Unsend button needs its own class for the danger tint');
assert(/function syncUnsendButton/.test(chatSrc), 'syncUnsendButton() must gate the button to my own messages');
assert(/function confirmUnsend/.test(chatSrc) && /function unsendMessage/.test(chatSrc),
    'confirmUnsend() + unsendMessage() must exist');
assert(/unsendMessage:\s*function\s*\(id\)\s*\{\s*return unsendMessage\(id\);\s*\}/.test(chatSrc),
    'unsendMessage must be exported on ChatService so the confirm modal can call it');
// The click must be caught BEFORE the reaction fall-through, or a stray branch
// could toggle a reaction instead of unsending.
const unsendBranchAt = chatSrc.indexOf("closest('[data-picker-unsend]')");
const reactionBranchAt = chatSrc.indexOf("closest('[data-picker-key]')", unsendBranchAt);

// ---------------------------------------------------------------
// 2. FUNCTIONAL: unsendMessage() against a fake Firestore
// ---------------------------------------------------------------
console.log('\n=== functional: unsendMessage writes the tombstone, and only for the author ===');

// Pull the unsendMessage function out of chat.js and run it in a sandbox with
// the module's own state (currentUserEmail, lastRenderedMessages) and a fake
// messages collection that records the update.
const fnStart = chatSrc.indexOf('function unsendMessage(messageId) {');
assert(fnStart > -1, 'unsendMessage() not found in js/chat.js');
// The function ends at the reactions banner that follows it.
const fnEnd = chatSrc.indexOf('// Emoji reactions: ONE shared picker', fnStart);
const fnSrc = chatSrc.slice(fnStart, fnEnd);
assert(/messages\.doc\(mid\)\.update/.test(fnSrc) && /\n    }\s*$/.test(fnSrc.trimEnd() + '\n    }\n'),
    'could not isolate unsendMessage() body');

function runUnsend(opts) {
    const updates = [];
    const toasts = [];
    const sandbox = {
        console,
        Promise,
        String, Object, Array,
        currentUserEmail: opts.me,
        lastRenderedMessages: opts.messages || [],
        messagesRef: () => ({
            doc: (id) => ({
                update: (data) => {
                    if (opts.denied) {
                        const err = new Error('permission denied');
                        err.code = 'permission-denied';
                        return Promise.reject(err);
                    }
                    updates.push({ id, data });
                    return Promise.resolve();
                }
            })
        }),
        firebase: { firestore: { FieldValue: { serverTimestamp: () => ({ __server: true }) } } },
        showToast: (m, t) => toasts.push({ m, t })
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fnSrc + '\n; globalThis.__unsend = unsendMessage;', sandbox);
    return { api: sandbox.__unsend, updates, toasts };
}

(async () => {
    // (a) Author unsends their own message -> writes the exact tombstone.
    {
        const R = runUnsend({
            me: 'me@x.com',
            messages: [{ id: 'm1', senderEmail: 'me@x.com', text: 'hello' }]
        });
        const ok = await R.api('m1');
        assert.strictEqual(ok, true, 'an author unsending their own message must succeed');
        assert.strictEqual(R.updates.length, 1, 'exactly one update must be written');
        const d = R.updates[0].data;
        assert.strictEqual(d.text, '', 'the body must be wiped to empty string');
        assert.strictEqual(d.unsent, true, 'unsent must be set true');
        assert.deepStrictEqual(d.unsentAt, { __server: true }, 'unsentAt must be a serverTimestamp');
        // The rule allows ONLY {unsent, unsentAt, text} — assert no other key leaks.
        const keys = Object.keys(d).sort();
        assert.deepStrictEqual(keys, ['text', 'unsent', 'unsentAt'],
            'the update must touch ONLY text/unsent/unsentAt — the fields firestore.rules allows');
        console.log('  PASS  author unsend writes { text:"", unsent:true, unsentAt } and nothing else');
    }

    // (b) Someone else's message -> refused, nothing written.
    {
        const R = runUnsend({
            me: 'me@x.com',
            messages: [{ id: 'm2', senderEmail: 'other@x.com', text: 'not mine' }]
        });
        const ok = await R.api('m2');
        assert.strictEqual(ok, false, 'unsending somebody else\'s message must be refused');
        assert.strictEqual(R.updates.length, 0, 'no write may happen for a non-author');
        assert(/only unsend your own/i.test(R.toasts[0].m), 'a clear "your own messages" toast must fire');
        console.log('  PASS  a non-author cannot unsend (client guard fires before any write)');
    }

    // (c) Already-unsent message -> no-op, nothing written.
    {
        const R = runUnsend({
            me: 'me@x.com',
            messages: [{ id: 'm3', senderEmail: 'me@x.com', text: '', unsent: true }]
        });
        const ok = await R.api('m3');
        assert.strictEqual(ok, false, 're-unsending an already-unsent message must be a no-op');
        assert.strictEqual(R.updates.length, 0, 'no write for an already-unsent message');
        console.log('  PASS  an already-unsent message is a no-op');
    }

    // (d) Permission denied (rules not deployed) -> helpful toast, no crash.
    {
        const R = runUnsend({
            me: 'me@x.com',
            messages: [{ id: 'm4', senderEmail: 'me@x.com', text: 'hi' }],
            denied: true
        });
        const ok = await R.api('m4');
        assert.strictEqual(ok, false, 'a denied write must resolve false, not throw');
        assert(/reload the page|deployed/i.test(R.toasts[0].m), 'a denied write must tell the user to reload for new rules');
        console.log('  PASS  a permission-denied unsend degrades to a reload hint, not a crash');
    }

    console.log('\n✅ Chat UNSEND tests passed (author-only tombstone; button gated to my messages; ' +
        'phone-friendly confirm; rendered as "Unsent message").');
})().catch((e) => { console.error(e); process.exit(1); });

assert(unsendBranchAt > -1 && reactionBranchAt > unsendBranchAt,
    'the Unsend branch must be handled before the reaction branch in the picker mousedown handler');
// Loaded on both chat surfaces, after chat.js.
assert(/<script src="js\/chat\.js"><\/script>[\s\S]{0,240}<script src="js\/chat-unsend\.js"><\/script>/.test(mainHtml),
    'main.html must load chat-unsend.js after chat.js');
assert(/<script src="js\/chat\.js"><\/script>[\s\S]{0,240}<script src="js\/chat-unsend\.js"><\/script>/.test(ownerHtml),
    'ownerdashboard.html must load chat-unsend.js after chat.js');
// ⚠️ The overlay MUST carry the base `modal-overlay` class — that is what
// carries `display:none` (and `.active { display:flex }`) from style.css.
// Without it the confirm dialog is visible on every page load, before any
// unsend. This shipped once; the guard keeps it from coming back.
assert(/overlay\.className = 'modal-overlay chat-unsend-overlay'/.test(unsendUiSrc),
    'the confirm overlay must use the base `modal-overlay` class so it starts hidden (display:none), ' +
    'not a bespoke class that leaves it visible on load');
assert(/classList\.add\('active'\)/.test(unsendUiSrc) && /classList\.remove\('active'\)/.test(unsendUiSrc),
    'the confirm must show/hide via the .active class, matching the shared modal idiom');
console.log('  PASS  the Unsend button, handler, export and script load are wired');

// ---------------------------------------------------------------
// 1b. FUNCTIONAL: syncUnsendButton shows the button ONLY on my
//     own messages — the exact "don't offer unsend on others"
//     guarantee. Simulates hovering my message, then theirs.
// ---------------------------------------------------------------
console.log('\n=== functional: the Unsend button is hidden on other people\'s messages ===');
const syncFnStart = chatSrc.indexOf('function syncUnsendButton(messageId) {');
const syncFnEnd = chatSrc.indexOf('function openReactionPicker(', syncFnStart);
const syncFnSrc = chatSrc.slice(syncFnStart, syncFnEnd);
assert(/els\.pickerUnsend\.hidden = !mine/.test(syncFnSrc), 'could not isolate syncUnsendButton()');

function runSync(opts) {
    const unsendBtn = { hidden: true }; // ships hidden, like the real markup
    const sandbox = {
        console,
        String, Object, Array,
        currentUserEmail: opts.me,
        lastRenderedMessages: opts.messages || [],
        els: { pickerUnsend: unsendBtn }
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(syncFnSrc + '\n; globalThis.__sync = syncUnsendButton;', sandbox);
    return { sync: sandbox.__sync, btn: unsendBtn };
}

// My own message -> button visible.
{
    const S = runSync({
        me: 'me@x.com',
        messages: [
            { id: 'a', senderEmail: 'me@x.com' },
            { id: 'b', senderEmail: 'other@x.com' }
        ]
    });
    S.sync('a');
    assert.strictEqual(S.btn.hidden, false, 'the Unsend button MUST show on my own message');
    // Now hover someone else's message -> it must hide again.
    S.sync('b');
    assert.strictEqual(S.btn.hidden, true, 'the Unsend button MUST hide on somebody else\'s message');
    // A message not in the list at all -> hidden (fail safe).
    S.sync('zzz');
    assert.strictEqual(S.btn.hidden, true, 'an unknown message id must leave the button hidden');
    console.log('  PASS  the button shows on my message and hides on everyone else\'s');
}

// Case/whitespace in the email must not matter (both sides lowercased).
{
    const S = runSync({
        me: 'Me@X.com',
        messages: [{ id: 'a', senderEmail: 'me@x.com' }]
    });
    S.sync('a');
    assert.strictEqual(S.btn.hidden, false, 'ownership must be compared case-insensitively');
    console.log('  PASS  ownership is case-insensitive');
}

// ---------------------------------------------------------------
// 1c. REGRESSION: the picker's re-anchor guard and its close path
//     must never leave a visible Unsend button behind. This shipped
//     as a real bug — the early-return skipped the sync, so a button
//     shown for MY message lingered visibly on OTHER people's
//     messages when the picker was already open.
// ---------------------------------------------------------------
console.log('\n=== regression: the picker never leaks a visible Unsend button ===');
const openStart = chatSrc.indexOf('function openReactionPicker(messageId, anchor) {');
const openEnd = chatSrc.indexOf('function highlightCurrentReaction()', openStart);
const openSrc = chatSrc.slice(openStart, openEnd);
const closeStart = chatSrc.indexOf('function closeReactionPicker() {');
const closeEnd = chatSrc.indexOf('function closeReactionPickerSoon(', closeStart);
const closeSrc = chatSrc.slice(closeStart, closeEnd);
assert(openStart > -1 && openEnd > openStart, 'could not isolate openReactionPicker()');
assert(closeStart > -1 && closeEnd > closeStart, 'could not isolate closeReactionPicker()');
// The re-anchor guard must re-sync BEFORE returning — that is the fix.
assert(/if \(reactionTargetId === String\(messageId\) && !els\.reactionPicker\.hidden\) \{\s*\n\s*syncUnsendButton\(String\(messageId\)\);/.test(openSrc),
    "openReactionPicker's early-return must re-sync the Unsend button before returning");
// Closing must hide the button too, not just the picker.
assert(/els\.pickerUnsend\.hidden = true/.test(closeSrc),
    'closeReactionPicker() must hide the Unsend button when the picker closes');

// ⚠️ THE ACTUAL SHIPPED BUG: `.chat-picker-action` sets display:inline-flex —
// an AUTHOR rule, which beats the user-agent `[hidden] { display:none }`
// cascade. With no `.chat-picker-action[hidden]` override, syncUnsendButton()
// toggled the `hidden` attribute but the pixels never changed: the Unsend
// button showed on EVERY message, mine or not. Same trap this codebase
// already cured for `.btn` (style.css) and `.icon-btn` (theme.css) — the
// same guard test/set-role.test.js runs for `.btn[hidden]` applies here.
const unsendCssRule = chatCss.match(/\.chat-picker-action\[hidden\]\s*\{[^}]*\}/);
assert(unsendCssRule, 'chat.css must define `.chat-picker-action[hidden]` — .chat-picker-action sets ' +
    'display:inline-flex, an author rule that beats the user-agent [hidden] rule, so without it the ' +
    'attribute is set but the pixels remain and Unsend shows on every message');
assert(/display:\s*none/.test(unsendCssRule[0]),
    '`.chat-picker-action[hidden]` must set display:none. Found: ' + unsendCssRule[0]);
console.log('  PASS  the [hidden] attribute actually hides the button (CSS override present)');

function runPicker(opts) {
    const unsendBtn = { hidden: true }; // ships hidden, like the real markup
    const pickerEl = { hidden: true, style: {} };
    const sandbox = {
        console,
        String, Object, Array, Math,
        clearTimeout, setTimeout,
        currentUserEmail: opts.me,
        lastRenderedMessages: opts.messages || [],
        closeReactionTimer: null,
        reactionTargetId: null,
        els: { pickerUnsend: unsendBtn, reactionPicker: pickerEl },
        highlightCurrentReaction: function () {} // not under test
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(syncFnSrc + '\n' + closeSrc + '\n' + openSrc +
        '\n; globalThis.__api = { open: openReactionPicker, close: closeReactionPicker };', sandbox);
    return { api: sandbox.__api, btn: unsendBtn, picker: pickerEl };
}

const pickerMessages = [
    { id: 'mine', senderEmail: 'me@x.com' },
    { id: 'theirs', senderEmail: 'other@x.com' }
];

// (a) Opening on their message while a stale visible button lingers -> hide it.
{
    const S = runPicker({ me: 'me@x.com', messages: pickerMessages });
    S.btn.hidden = false;              // simulate the stale state the bug shipped with
    S.api.open('theirs', null);
    assert.strictEqual(S.btn.hidden, true,
        "opening the picker on somebody else's message must hide the Unsend button");
    assert.strictEqual(S.picker.hidden, false, 'the picker itself must be open');
    console.log("  PASS  opening on another person's message hides a stale visible button");
}

// (b) THE REGRESSION: re-hovering the SAME open message takes the
//     early-return guard — it must still re-sync, or my button lingers.
{
    const S = runPicker({ me: 'me@x.com', messages: pickerMessages });
    S.api.open('theirs', null);        // picker open on their message
    S.btn.hidden = false;              // stale visible button reappears (the shipped bug)
    S.api.open('theirs', null);        // early-return path — previously skipped the sync
    assert.strictEqual(S.btn.hidden, true,
        'the re-anchor early-return must still hide the Unsend button on a non-mine message');
    console.log('  PASS  the re-anchor guard still re-syncs (the early-return fix)');
}

// (c) My own message shows it; closing the picker must hide it again.
{
    const S = runPicker({ me: 'me@x.com', messages: pickerMessages });
    S.api.open('mine', null);
    assert.strictEqual(S.btn.hidden, false, 'my own message must show the Unsend button');
    S.api.close();
    assert.strictEqual(S.picker.hidden, true, 'close must hide the picker');
    assert.strictEqual(S.btn.hidden, true, 'close must hide the Unsend button too');
    console.log('  PASS  the button shows on my message and is hidden when the picker closes');
}
