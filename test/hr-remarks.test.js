// Functional test for the HR coordination remarks — the shared, append-only
// "has an NOV been issued?" log several HR staff read to avoid issuing the
// same Notice of Violation twice.
//
// What this locks down:
//
//   1. firestore.rules: a `remarks` collection exists, gated to HR/superadmin,
//      create pinned to `byEmail == selfEmail()`, and with NO update/delete
//      (append-only). And — critically — the violations rules are UNCHANGED:
//      the note is a separate collection precisely so HR never gains write
//      access to a report.
//   2. The violations/tickets documents are never written by this feature.
//   3. js/hr-violations.js still never calls a violation write (the existing
//      privacy invariant survives), and it routes the Remarks button to
//      window.Remarks BEFORE the openModal() fall-through.
//   4. The Remarks button is drawn only for HR/superadmin, on BOTH the ticket
//      rows (desktop + phone card) and the violation rows.
//   5. A FUNCTIONAL run of js/remarks.js: open() subscribes to the right
//      targetKey, renders author + timestamp, submit() stamps byEmail/byName/
//      createdAt and refuses a blank note, and it is sorted oldest-first.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const rules = read('firestore.rules');
const ownerJs = read('js/owner-dashboard.js');
const hrJs = read('js/hr-violations.js');
const ownerHtml = read('ownerdashboard.html');
const remarksJs = read('js/remarks.js');
const css = read('style.css');

console.log('Testing HR coordination remarks (the shared NOV-status log)...');

// ---------------------------------------------------------------
// 1. firestore.rules: an append-only remarks collection for HR/superadmin
// ---------------------------------------------------------------
console.log('\n=== firestore.rules: the remarks log is HR/superadmin, append-only ===');

const remarksBlock = (() => {
    const start = rules.indexOf('match /remarks/');
    assert(start > -1, 'firestore.rules must contain a `match /remarks/` block');
    const end = rules.indexOf('match /', start + 10);
    return rules.slice(start, end > -1 ? end : undefined);
})();

assert(
    /allow read: if isHrOrSuperAdmin\(\);/.test(remarksBlock),
    'remarks must be readable by HR/superadmin'
);
assert(
    /allow create: if isHrOrSuperAdmin\(\)[\s\S]*?request\.resource\.data\.byEmail == selfEmail\(\);/.test(remarksBlock),
    'a remark create must be HR/superadmin AND pinned to byEmail == selfEmail() so nobody can forge a note under a colleague'
);
assert(
    !/allow update/.test(remarksBlock) && !/allow delete/.test(remarksBlock),
    'the remarks log must be APPEND-ONLY — no allow update, no allow delete, or a later note could rewrite history'
);

// The whole point of Approach A: the violations rules must NOT have changed.
// Bounded by the `remarks` block that now follows it — NOT by the next
// `match /`, because the violations block itself contains a nested
// `match /chats/{chatId}` sub-block that would otherwise swallow the slice.
const violationsBlock = (() => {
    const start = rules.indexOf('match /violations/');
    const end = rules.indexOf('// ---------------- remarks', start);
    assert(start > -1 && end > start, 'could not bound the violations block between `match /violations/` and the remarks block');
    return rules.slice(start, end);
})();
assert(
    !/remarks/.test(violationsBlock),
    'the violations block must stay untouched — the note lives in its own collection so HR keeps NO write on a report'
);
assert(
    /allow create: if isOperatorOrSuperAdmin\(\);/.test(violationsBlock),
    'HR must still have no create on violations (create stays operator/superadmin only)'
);

// ---------------------------------------------------------------
// 2. The violations/tickets documents are NEVER written by this feature
// ---------------------------------------------------------------
console.log('\n=== the report documents are never touched by a remark ===');
assert(
    !/collection\('violations'\)[\s\S]{0,40}(update|set|delete)/.test(remarksJs) &&
    !/collection\("violations"\)[\s\S]{0,40}(update|set|delete)/.test(remarksJs),
    'js/remarks.js must only ever write its own `remarks` collection, never a violation'
);
assert(
    /collection\('remarks'\)/.test(remarksJs),
    'js/remarks.js must read/write the `remarks` collection'
);
// The existing privacy invariant in hr-violations.js survives: it still must
// not call any violation write method.
assert(
    !/\.(addViolation|updateViolation|deleteViolation|transferViolationToHr|revertViolationTransfer)\s*\(/.test(hrJs),
    'js/hr-violations.js must still never call a violation write — the remark is a separate log, not an edit'
);

// ---------------------------------------------------------------
// 3. The violation row routes Remarks BEFORE openModal()
// ---------------------------------------------------------------
console.log('\n=== the violation row opens Remarks, not the modal, on the sticky-note ===');
const remarksRouteAt = hrJs.indexOf("closest('.remarks')");
const openModalAt = hrJs.indexOf('openModal(id);', remarksRouteAt > -1 ? remarksRouteAt : 0);
assert(remarksRouteAt > -1, 'js/hr-violations.js must handle the .remarks button');
assert(
    openModalAt > remarksRouteAt,
    'the .remarks branch must be checked BEFORE the openModal() fall-through, or clicking Remarks would ALSO open the report modal'
);
assert(
    /window\.Remarks\.openFromButton/.test(hrJs),
    'the violation row must delegate to window.Remarks.openFromButton()'
);

// ---------------------------------------------------------------
// 4. The button is HR/superadmin only, on tickets (desktop + card) and violations
// ---------------------------------------------------------------
console.log('\n=== the Remarks button is drawn for HR/superadmin on both surfaces ===');
assert(
    /function isHrOrSuperAdmin\(\)\s*\{\s*return activeUserRole === 'hr' \|\| activeUserIsSuperAdmin;/.test(ownerJs),
    'js/owner-dashboard.js must expose isHrOrSuperAdmin() mirroring the rules gate'
);
// The ticket row builds remarksBtn once (gated) and drops it into BOTH the
// phone card footer and the desktop actions cell.
assert(
    /const remarksBtn = isHrOrSuperAdmin\(\)/.test(ownerJs),
    'the ticket Remarks button must be gated on isHrOrSuperAdmin()'
);
assert(
    (ownerJs.match(/\$\{remarksBtn\}/g) || []).length >= 2,
    'the ticket row must place ${remarksBtn} in BOTH the desktop Actions cell and the phone card footer'
);
assert(
    /data-remarks-key="tickets\//.test(ownerJs),
    'the ticket button must carry data-remarks-key="tickets/<id>"'
);
assert(
    /event\.stopPropagation\(\)/.test(ownerJs),
    'the ticket Remarks button must stopPropagation() so it does not also fire the row onclick (openOwnerReport)'
);
assert(
    /data-remarks-key="violations\//.test(hrJs),
    'the violation button must carry data-remarks-key="violations/<id>"'
);
// Loaded on the page, after firebase.js.
assert(
    /<script src="js\/remarks\.js"><\/script>/.test(ownerHtml),
    'ownerdashboard.html must load js/remarks.js'
);
// The list/compose styling exists and themes via tokens, not a hardcoded hex.
assert(/\.remarks-list\s*\{/.test(css) && /\.remarks-compose\s*textarea\s*\{/.test(css),
    'style.css must style the remarks list and compose box');
assert(
    /\.remark-item\s*\{[^}]*var\(--/.test(css),
    '.remark-item must take its colours from theme tokens, not a hardcoded hex'
);



// ---------------------------------------------------------------
// 5. FUNCTIONAL: run js/remarks.js against a fake Firestore + DOM
// ---------------------------------------------------------------
console.log('\n=== functional: open renders the log, submit stamps who/when ===');

// A tiny DOM good enough for js/remarks.js. Elements are cached BY ID so a
// querySelector('#remarksList') always returns the same node the module wrote
// to — the point of the functional test is to read back what it rendered.
function buildDom() {
    const byId = {};
    function getEl(id) {
        if (!byId[id]) {
            byId[id] = {
                id, innerHTML: '', textContent: '', value: '', disabled: false, _handlers: {},
                classList: { _s: {}, add(c) { this._s[c] = true; }, remove(c) { delete this._s[c]; }, contains(c) { return !!this._s[c]; } },
                setAttribute() {}, getAttribute() { return null; },
                addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
            };
        }
        return byId[id];
    }
    const overlay = {
        id: 'remarksModal', innerHTML: '', _handlers: {},
        classList: { _s: {}, add(c) { this._s[c] = true; }, remove(c) { delete this._s[c]; }, contains(c) { return !!this._s[c]; } },
        setAttribute() {}, getAttribute() { return null; },
        addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
        querySelector(sel) { return getEl(sel.replace(/^#/, '')); },
        appendChild() {},
    };
    // Fire a recorded handler (e.g. the save button's click).
    function fire(el, type, evt) { (el._handlers[type] || []).forEach((fn) => fn(evt || { preventDefault() {} })); }
    return { overlay, getEl, fire, byId };
}

function buildSandbox() {
    const added = [];
    let snapCb = null;
    let whereField = null;
    let whereValue = null;
    const dom = buildDom();

    const fakeCollection = {
        where(field, _op, value) { whereField = field; whereValue = value; return this; },
        onSnapshot(cb) { snapCb = cb; return function unsub() { snapCb = null; }; },
        add(doc) { added.push(doc); return Promise.resolve({ id: 'r' + added.length }); },
    };

    const sandbox = {
        console, Promise, Date, setTimeout,
        document: {
            readyState: 'complete',
            createElement: () => dom.overlay,
            body: { appendChild() {} },
            addEventListener() {},
        },
        window: {
            escapeHTML: (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
                { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
            )),
            showToast: () => {},
            normalizeUserEmail: (v) => String(v || '').trim().toLowerCase(),
            getUserProfile: async () => ({ name: 'Maria Santos' }),
            auth: { currentUser: { email: 'Maria@Jiangnan.com' } },
            firebase: { firestore: { FieldValue: { serverTimestamp: () => ({ __server: true }) } } },
            db: { collection: (name) => { if (name !== 'remarks') throw new Error('only remarks may be touched, got ' + name); return fakeCollection; } },
        },
    };
    sandbox.window.document = sandbox.document;
    sandbox.globalThis = sandbox;
    sandbox.window.window = sandbox.window;
    vm.createContext(sandbox);
    vm.runInContext(remarksJs, sandbox, { filename: 'remarks.js' });

    return {
        api: sandbox.window.Remarks, dom, added,
        get whereField() { return whereField; },
        get whereValue() { return whereValue; },
        emit(rows) {
            assert(snapCb, 'no active onSnapshot — open() was not called');
            snapCb({ forEach(fn) { rows.forEach((r, i) => fn({ id: r.id || ('r' + i), data: () => r })); } });
        },
    };
}


const R = buildSandbox();
assert(R.api && typeof R.api.open === 'function', 'window.Remarks.open must be exposed');

// --- open() subscribes to the right targetKey and field ------------------
R.api.open('violations/VIO-0007', 'VIO-0007');
assert.strictEqual(R.whereField, 'targetKey', 'the listener must filter on targetKey');
assert.strictEqual(R.whereValue, 'violations/VIO-0007', 'the listener must filter on the exact target key');
assert.strictEqual(R.dom.overlay.classList.contains('active'), true, 'open() must show the modal');

// --- a snapshot renders author + timestamp + text, OLDEST-FIRST ----------
R.emit([
    { id: 'b', text: 'Follow-up call done.', byName: 'Juan', byEmail: 'juan@jiangnan.com', createdAt: { toDate: () => new Date(2000, 0, 2) } },
    { id: 'a', text: 'NOV issued to the store.', byName: 'Maria', byEmail: 'maria@jiangnan.com', createdAt: { toDate: () => new Date(2000, 0, 1) } },
]);
const listHtml = R.dom.getEl('remarksList').innerHTML;
assert(listHtml.indexOf('Maria') > -1 && listHtml.indexOf('Juan') > -1, 'the rendered log must show every author');
assert(listHtml.indexOf('NOV issued to the store.') > -1, 'the rendered log must show the note text');
assert(listHtml.indexOf('Maria') < listHtml.indexOf('Juan'), 'remarks must render oldest-first (Maria on Jan 1 before Juan on Jan 2)');

// --- extra rendering contract: avatars, day separators, relative time, counter
R.emit([
    { id: 'b', text: 'Follow-up call done.', byName: 'Juan Delacruz', byEmail: 'juan@jiangnan.com', createdAt: { toDate: () => new Date(2000, 0, 2) } },
    { id: 'a', text: 'NOV issued to the store.', byName: 'Maria Santos', byEmail: 'maria@jiangnan.com', createdAt: { toDate: () => new Date() } },
]);
const listHtml2 = R.dom.getEl('remarksList').innerHTML;
assert(listHtml2.indexOf('MS') > -1 && listHtml2.indexOf('JD') > -1, 'each note shows a two-initial author avatar');
assert(listHtml2.indexOf('style="background:') > -1, 'each avatar carries a deterministic accent-tone');
assert(listHtml2.indexOf('Today') > -1, 'a date separator is shown when a new day starts');
assert(listHtml2.indexOf('just now') > -1, 'a relative time is shown for the newest note');
assert(listHtml2.indexOf('remark-item--mine') > -1, 'the writer own note is tinted');

// --- the character counter starts at 0/2000 and counts as you type -----------
assert.strictEqual(R.dom.getEl('remarksCounter').textContent, '0/2000', 'the character counter starts at 0/2000');
assert.strictEqual(R.dom.getEl('remarksPosting').textContent, 'Posting as maria@jiangnan.com', 'the posting-as line names the writer');
R.dom.getEl('remarksInput').value = 'test';
R.dom.fire(R.dom.getEl('remarksInput'), 'input');
assert.strictEqual(R.dom.getEl('remarksCounter').textContent, '4/2000', 'the counter counts characters as you type');

// --- openFromButton reads data-* attributes (no inline JS value) ----------
R.api.openFromButton({ getAttribute: (k) => (k === 'data-remarks-key' ? 'tickets/BNW-TIX007' : 'BNW-TIX007') });
assert.strictEqual(R.whereValue, 'tickets/BNW-TIX007', 'openFromButton must drive the same open() path from data-remarks-key');

// --- submit() stamps byEmail (lowercased) + byName (profile) + createdAt -
(async () => {
    const S = buildSandbox();
    S.api.open('tickets/BNW-TIX009', 'BNW-TIX009');
    S.dom.getEl('remarksInput').value = '  NOV issued, receipt scanned.  ';
    S.dom.fire(S.dom.getEl('remarksSaveBtn'), 'click');
    await new Promise((r) => setTimeout(r, 0)); // let getUserProfile + the write drain
    assert.strictEqual(S.added.length, 1, 'a non-blank note must write exactly one remark');
    const doc = S.added[0];
    assert.strictEqual(doc.targetKey, 'tickets/BNW-TIX009', 'the note must carry the open targetKey');
    assert.strictEqual(doc.text, 'NOV issued, receipt scanned.', 'the note text must be trimmed');
    assert.strictEqual(doc.byEmail, 'maria@jiangnan.com', 'byEmail must be the auth email, lowercased to match the rules');
    assert.strictEqual(doc.byName, 'Maria Santos', 'byName must come from the writer profile');
    assert.deepStrictEqual(doc.createdAt, { __server: true }, 'createdAt must be a Firestore serverTimestamp');

    // A blank note is refused — nothing is written.
    const B = buildSandbox();
    B.api.open('tickets/BNW-TIX010', 'BNW-TIX010');
    B.dom.getEl('remarksInput').value = '   ';
    B.dom.fire(B.dom.getEl('remarksSaveBtn'), 'click');
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(B.added.length, 0, 'a blank note must be refused before any write');

    console.log('\n✅ HR remarks tests passed (append-only log gated to HR/superadmin; ' +
        'report documents untouched; button on tickets + violations; live open/render/submit).');
})().catch((e) => { console.error(e); process.exit(1); });

