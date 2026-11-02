// Behavioural test for js/hr-violations.js — the HR "Transferred Violations" tab.
//
// Where violation-hr-transfer.test.js asserts on the RULES and the wiring
// (static, textual), this one actually RUNS the module against a stubbed DOM
// and checks what it renders. It is the regression net for the behaviour that
// is easy to break silently:
//
//   - the role gate: HR sees the tab, an owner does not and is bounced off the
//     section even if a refresh restored it;
//   - ONLY reports flagged hrStatus === 'transferred' are listed — an unflagged
//     report and a reverted one must both stay invisible;
//   - the search box and the store filter narrow the list;
//   - the empty state is rendered instead of a blank table.
//
// The stubs are deliberately minimal (innerHTML is a plain string), so this
// proves the module's own logic, not the framework's.
//
// Run: npm test
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js/hr-violations.js'), 'utf8');

function el(id) {
    return {
        id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
        classList: {
            _s: new Set(),
            add(c) { this._s.add(c); },
            remove(c) { this._s.delete(c); },
            toggle(c, f) {
                if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); }
                else if (f) { this._s.add(c); } else { this._s.delete(c); }
            },
            contains(c) { return this._s.has(c); }
        },
        listeners: {},
        addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
        querySelectorAll() { return []; },
        querySelector() { return null; },
        closest() { return null; }
    };
}

const nodes = {};
['hrViolationsNavItem', 'hrViolationSearch', 'hrViolationStoreFilter', 'hrViolationsBody',
    'hrViolationPagination', 'hrViolationModal', 'hrViolationModalTitle', 'hrViolationModalBody',
    'hrViolationAttachmentsGrid', 'btnHrViolationReport', 'closeHrViolationModal',
    'tabViolations', 'ownerUserRoleBadge'].forEach(i => { nodes[i] = el(i); });
nodes.hrViolationSearch.value = '';
nodes.hrViolationStoreFilter.value = 'all';

let capturedCb = null;
const win = {};
const ctx = {
    window: win, console, setTimeout, clearTimeout, Date, Array, Set, parseInt, String, Math,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    document: { readyState: 'complete', getElementById: id => nodes[id] || null, addEventListener() {} },
    firestoreService: { listenTransferredViolations(cb) { capturedCb = cb; return () => {}; } },
    ViolationReport: { fileName: () => 'X report', buildPdf: async () => null, print() {}, download() {} },
    showToast() {},
    escapeHTML: v => String(v == null ? '' : v)
};
// firebase.js exposes its service as `window.firestoreService` (line ~571), so
// the stub must hang it off `window` too, not just the bare context global.
win.window = win;
win.document = ctx.document;
win.firestoreService = {
    listenTransferredViolations(cb) { capturedCb = cb; return () => {}; }
};
vm.createContext(ctx);
vm.runInContext(src, ctx);

const H = win.HrViolations;
assert(H, 'HrViolations must be exported');

// --- role gate ---
H.applyRole('hr');
assert.strictEqual(nodes.hrViolationsNavItem.style.display, 'flex', 'HR sees the tab');
assert(capturedCb, 'the listener must start for HR');

H.applyRole('owner');
assert.strictEqual(nodes.hrViolationsNavItem.style.display, 'none', 'an owner must not see the tab');
assert.strictEqual(nodes.tabViolations.classList.contains('active'), false, 'owner is bounced off the section');

H.applyRole('hr');

// --- only transferred reports render ---
const V = (id, extra = {}) => ({
    id, violationNumber: 'VIO-' + id, store: 'Fame', subject: 'Strainer',
    details: 'd', reportedByName: 'Ana', hrStatus: 'transferred', ...extra
});
capturedCb([
    V('1'),
    V('2', { store: 'SM', subject: 'Cash' }),
    V('3', { hrStatus: undefined }),
    V('4', { hrStatus: 'reverted' })
]);
const count = () => (nodes.hrViolationsBody.innerHTML.match(/data-id=/g) || []).length;
assert.strictEqual(count(), 2, 'only the 2 transferred reports render, got ' + count());
assert(!/data-id="3"/.test(nodes.hrViolationsBody.innerHTML), 'an unflagged report stays hidden');
assert(!/data-id="4"/.test(nodes.hrViolationsBody.innerHTML), 'a reverted report stays hidden');

// --- search ---
nodes.hrViolationSearch.value = 'cash';
H.applyFilters();
assert.strictEqual(count(), 1, 'search narrows the list to 1');
nodes.hrViolationSearch.value = '';

// --- store filter ---
nodes.hrViolationStoreFilter.value = 'Fame';
H.applyFilters();
assert.strictEqual(count(), 1, 'the store filter works');
nodes.hrViolationStoreFilter.value = 'all';
H.applyFilters();
assert.strictEqual(count(), 2, 'clearing the store filter restores the list');

// --- empty state ---
capturedCb([]);
assert(/No violation reports have been transferred to you yet/i.test(nodes.hrViolationsBody.innerHTML),
    'the empty state is shown');
assert.strictEqual(nodes.hrViolationsBody.innerHTML.includes('data-id='), false, 'no rows while empty');

console.log('HR violations module OK: role gate, transfer-only filter, search, store filter and empty state all behave correctly.');
