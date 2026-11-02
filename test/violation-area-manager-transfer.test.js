const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const firebaseJs = fs.readFileSync(path.join(ROOT, 'firebase.js'), 'utf8');
const scriptJs = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const mainHtml = fs.readFileSync(path.join(ROOT, 'main.html'), 'utf8');
const ownerHtml = fs.readFileSync(path.join(ROOT, 'ownerdashboard.html'), 'utf8');
const ownerViolationsJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-violations.js'), 'utf8');

/** Strip comments so prose that NAMES an identifier is not mistaken for code. */
const strip = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

console.log('Testing the violation → Area Manager handoff...');

// ---------------------------------------------------------------------------
// 1. THE RULES — the whole feature is dead without this clause
// ---------------------------------------------------------------------------
{
    // Before this change `allow read` had only the operator/superadmin and HR
    // branches, so role 'owner' matched NEITHER and the tab could only ever be
    // empty. This clause IS the authorisation.
    assert(/function isTransferredToAreaManager\(\)/.test(rules),
        'firestore.rules needs isTransferredToAreaManager()');
    assert(/resource\.data\.managerStatus == 'transferred'/.test(rules),
        "the helper must key on managerStatus == 'transferred' — the same shape as "
        + 'isTransferredToHr(), so an untransferred report matches nothing');

    const readAt = rules.indexOf('allow read: if isOperatorOrSuperAdmin()');
    const readClause = rules.slice(readAt, readAt + 260);
    assert(/function isOwner\(\)/.test(rules),
        'firestore.rules needs an isOwner() helper for the Area Manager read');
    assert(/isOwner\(\)\s*&&\s*isTransferredToAreaManager\(\)/.test(readClause),
        'the violations read rule must admit (isOwner() && '
        + 'isTransferredToAreaManager())');
    // RM/SM reads the SAME transferred set, but ONLY to open a report MENTIONED
    // in the store chat (it has no violations tab). A DELIBERATE, scoped grant
    // via its own isRmsm() helper (never the broad isAreaManager(), which also
    // sweeps in the chat-roster reach), keyed on the same managerStatus flag so
    // it can never exceed what the Area Manager sees.
    assert(/function isRmsm\(\)/.test(rules),
        'firestore.rules needs an isRmsm() helper for the RM/SM chat-mention read');
    assert(/isRmsm\(\)\s*&&\s*isTransferredToAreaManager\(\)/.test(readClause),
        'the violations read rule must admit (isRmsm() && '
        + 'isTransferredToAreaManager()) so an RM/SM can open a mentioned report');
    assert(!/isAreaManager\(\)/.test(readClause),
        'the violations read rule must NOT use isAreaManager() in the read clause');

    // INDEPENDENCE: a single shared flag would make the two transfers revoke
    // each other, and that failure is invisible until someone needs both.
    assert(/resource\.data\.hrStatus == 'transferred'/.test(rules),
        'the HR helper must keep keying on hrStatus');
    const hrFn = rules.slice(rules.indexOf('function isTransferredToHr'),
        rules.indexOf('function isTransferredToHr') + 260);
    assert(!/managerStatus/.test(hrFn),
        'the HR helper must NOT read managerStatus — the two flags are separate');

    // READ-ONLY. Widening the read clause must not have widened a write clause.
    const block = rules.slice(rules.indexOf('match /violations/'),
        rules.indexOf('match /chats/'));
    const writes = block.split('\n').filter(l => /allow (create|update|delete)/.test(l));
    assert(writes.length > 0, 'the violations block should still declare write rules');
    for (const w of writes) {
        assert(!/isAreaManager\(\)/.test(w),
            'no violations WRITE rule may mention isAreaManager() — the Area '
            + 'Manager tab is read-only: "' + w.trim() + '"');
    }
    // The Area Manager may stamp open/expiry time on a transferred violation:
    // a narrow, field-restricted update gated on isTransferredToAreaManager().
    // isOwner() in a WRITE rule is only allowed for that specific rule.
    if (/isOwner\(\)/.test(block) || /isRmsm\(\)/.test(block)) {
        const ownerIdx = block.indexOf('allow update: if (isOwner() || isRmsm())');
        assert(ownerIdx > -1, 'isOwner()/isRmsm() write rule must start with "allow update: if (isOwner() || isRmsm())"');
        const ownerRule = block.slice(ownerIdx, ownerIdx + 500);
        assert(/isTransferredToAreaManager\(\)/.test(ownerRule),
            'owner write must be gated on isTransferredToAreaManager()');
        assert(/managerExpiresAt/.test(ownerRule) || /managerOpenedAt/.test(ownerRule),
            'owner write must be limited to manager open/expiry fields');
    }
}

// ---------------------------------------------------------------------------
// 2. THE DATA LAYER — the listener must PROVE the rule
// ---------------------------------------------------------------------------
{
    // A single equality filter needs no composite index, so this works on the
    // Spark plan. Two filters (adding `store`) would need Blaze.
    const fn = firebaseJs.slice(
        firebaseJs.indexOf('listenTransferredViolationsForAreaManager'),
        firebaseJs.indexOf('async transferViolationToAreaManager'));
    assert(/\.where\('managerStatus', '==', 'transferred'\)/.test(fn),
        "the listener MUST filter on managerStatus == 'transferred'; an unfiltered "
        + 'query is DENIED by the rules, which is the guarantee working');
    assert(!/\.where\('store'/.test(fn),
        "the query must NOT add a `store` filter: two filters on different fields "
        + 'need a COMPOSITE INDEX, which is a Blaze (paid) plan feature');
    assert(!/db\.collection\('violations'\)\s*\.onSnapshot/.test(fn),
        'the listener must never run an unfiltered violations query');

    // Transfer writes managerStatus; revert DELETES it, so the document returns
    // to its original shape and the rules treat it like any pre-handoff report.
    const put = firebaseJs.slice(firebaseJs.indexOf('async transferViolationToAreaManager'),
        firebaseJs.indexOf('async revertViolationTransferFromAreaManager'));
    assert(/managerStatus: 'transferred'/.test(put), 'transfer must stamp managerStatus');
    assert(!/hrStatus/.test(put),
        'the Area Manager transfer must NOT touch hrStatus — that is the HR handoff');

    const revAt = firebaseJs.indexOf('async revertViolationTransferFromAreaManager');
    const revert = firebaseJs.slice(revAt, revAt + 700);
    assert(/managerStatus: firebase\.firestore\.FieldValue\.delete\(\)/.test(revert),
        'revert must DELETE managerStatus, not set it to another value');
    assert(!/hrStatus/.test(revert),
        'reverting the Area Manager transfer must not disturb an HR transfer');
}

// ---------------------------------------------------------------------------
// 3. THE COMMAND CENTER BUTTON
// ---------------------------------------------------------------------------
{
    assert(mainHtml.includes('id="btnTransferViolationToManager"'),
        'main.html needs the Transfer to Area Manager button');
    assert(mainHtml.includes('Transfer to Area Manager'),
        'the button must be labelled for the Area Manager, not reuse the HR label');
    assert(mainHtml.includes('id="btnTransferViolation"'),
        'the HR button must still exist — the two transfers are independent');

    const s = strip(scriptJs);
    assert(/function toggleViolationTransferToManager\(/.test(s),
        'script.js needs the manager toggle');
    assert(/function refreshManagerTransferButtonState\(/.test(s),
        'script.js needs the manager button state refresher');

    // Both buttons must be refreshed wherever the HR one is, or one goes stale
    // while the other tracks the listener.
    const refreshManager = scriptJs.split('refreshManagerTransferButtonState(v)').length - 1;
    const refreshHr = scriptJs.split('refreshTransferButtonState(v)').length - 1;
    assert(refreshManager >= 2 && refreshManager >= refreshHr - 1,
        'refreshManagerTransferButtonState() must be called wherever the HR one is '
        + '(open + live-update). Found ' + refreshManager + ' call(s) vs HR\'s '
        + refreshHr);

    assert(/v\.managerStatus === 'transferred'/.test(s),
        'the manager button state must read managerStatus, not hrStatus');
}

// ---------------------------------------------------------------------------
// 4. THE AREA MANAGER TAB — and the id collision with HR's
// ---------------------------------------------------------------------------
{
    assert(ownerHtml.includes('id="tabOwnerViolations"'),
        'ownerdashboard.html needs its own section');
    assert(ownerHtml.includes('id="tabViolations"'),
        "HR's section must still exist — the two tabs must not be merged");

    // switchOwnerTab() resolves the section as 'tab' + Capitalised(data-tab), so
    // a mismatch here means the tab silently never opens.
    assert(/data-tab="ownerViolations"/.test(ownerHtml),
        "the nav item's data-tab must be ownerViolations");
    assert(ownerHtml.includes('id="tabOwnerViolations"'),
        'switchOwnerTab() maps data-tab="ownerViolations" to #tabOwnerViolations');

    assert(ownerHtml.includes('js/owner-violations.js'),
        'ownerdashboard.html must load the new module');
    assert(ownerHtml.includes('js/hr-violations.js'),
        "HR's module must still load — the two lists are independent");

    // Load order: the new module reads the role + branches owner-dashboard.js
    // installs, and the PDF builder from violation-report.js.
    //
    // ⚠️ MATCH THE <script src> TAGS, NOT THE BARE FILENAME. Both names appear
    // earlier in prose comments ("after js/violation-report.js so the shared PDF
    // builder is available"), and indexOf would return one of those — making this
    // assert fail against markup that is in fact correct.
    const scriptOrder = [];
    const tagRe = /<script src="([^"]+)"/g;
    let m;
    while ((m = tagRe.exec(ownerHtml)) !== null) scriptOrder.push(m[1]);
    const posOf = (file) => scriptOrder.indexOf(file);

    assert(posOf('js/owner-dashboard.js') > -1, 'owner-dashboard.js must still load');
    assert(posOf('js/owner-violations.js') > -1, 'js/owner-violations.js must be loaded');
    assert(posOf('js/hr-violations.js') > -1,
        "HR's module must still load — the two lists are independent");
    assert(posOf('js/owner-violations.js') > posOf('js/owner-dashboard.js'),
        'js/owner-violations.js must load AFTER js/owner-dashboard.js — it reads '
        + 'getOwnerRole()/getOwnerAssignedBranches() from it');
    assert(posOf('js/owner-violations.js') > posOf('js/violation-report.js'),
        'js/owner-violations.js must load AFTER js/violation-report.js for the PDF');

    // READ-ONLY: no edit / delete / transfer control may exist on the tab.
    const secAt = ownerHtml.indexOf('id="tabOwnerViolations"');
    const sec = ownerHtml.slice(secAt, secAt + 3000);
    for (const forbidden of ['Edit Report', 'Delete Report', 'btnTransfer']) {
        assert(!sec.includes(forbidden),
            'the Area Manager tab must have no "' + forbidden + '" control — the '
            + 'rules deny the role writes on violations, so it could not work');
    }
}

// ---------------------------------------------------------------------------
// 5. BRANCH SCOPING — and the ways it must FAIL CLOSED
// ---------------------------------------------------------------------------
{
    // branchKey + scopeIn are load-bearing, so exercise them in a sandbox.
    const sandbox = { console };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(
        ownerViolationsJs.slice(ownerViolationsJs.indexOf('function branchKey'),
            ownerViolationsJs.indexOf('function incidentDate'))
        + '\n'
        + ownerViolationsJs.slice(ownerViolationsJs.indexOf('function scopeIn'),
            ownerViolationsJs.indexOf('// ===== Store dropdown =====')),
        sandbox
    );
    const branchKey = sandbox.branchKey;
    const scopeIn = sandbox.scopeIn;

    // Case/whitespace-insensitive, or a 'banawe' grant silently matches nothing
    // and the manager sees an empty list with no explanation.
    assert.strictEqual(branchKey(' Banawe '), 'banawe');
    assert.strictEqual(branchKey(null), '');
    assert.strictEqual(branchKey(undefined), '');

    const keys = [branchKey('Banawe'), branchKey('FAME')];
    assert(scopeIn({ store: 'Banawe' }, keys), 'an assigned branch must match');
    assert(scopeIn({ store: 'banawe' }, keys), 'matching must be case-insensitive');
    assert(scopeIn({ store: ' BANAWE ' }, keys), 'matching must ignore whitespace');
    assert(!scopeIn({ store: 'Hollywood' }, keys),
        'another manager\'s branch must NOT match');
    assert(!scopeIn({}, keys), 'a report with no store must NOT match');
    assert(!scopeIn({ store: null }, keys), 'a report with no store must NOT match');

    // An EMPTY scope must never mean "everything". That would publish every
    // manager's reports to one whose branch list has not loaded yet.
    assert(!scopeIn({ store: 'Banawe' }, []),
        'an empty branch list must match NOTHING — the scope fails CLOSED');
}

// ---------------------------------------------------------------------------
// 6. THE ROLE GATE must be the inverse of HR's
// ---------------------------------------------------------------------------
{
    const s = strip(ownerViolationsJs);

    // ⚠️ SCOPE THE MATCH TO applyRole. readRole() legitimately mentions 'hr' and
    // 'superadmin' — it has to recognise every role the badge can display so it
    // can return the right stored value. A file-wide ban on `=== 'hr'` would
    // fail on correct code; what must be banned is the GATE admitting HR.
    const gateAt = s.indexOf('function applyRole');
    const gate = s.slice(gateAt, s.indexOf('function refresh', gateAt));
    assert(/===\s*'owner'/.test(gate),
        "the gate must be exactly `role === 'owner'` — a bare truthiness check, or "
        + "a default that falls through, would reveal the tab to the wrong roles");
    assert(!/'hr'/.test(gate) && !/'superadmin'/.test(gate),
        'applyRole() must not mention hr/superadmin — they have their own tabs, '
        + 'and revealing this one to either would duplicate the data');

    // It must re-check the scope when opening, not only when listing:
    // allViolations holds every manager's reports, so openModal is the last gate.
    const openAt = ownerViolationsJs.indexOf('function openModal');
    const open = ownerViolationsJs.slice(openAt, openAt + 900);
    assert(/scopeIn\(v, keys\)/.test(open),
        'openModal() must re-check branch scope — the list filter alone would let '
        + 'a stale row id open another branch\'s CCTV');
    assert(/!keys\.length \|\| !scopeIn/.test(open),
        'openModal() must refuse while the branch list is empty (fail closed)');
}

// ---------------------------------------------------------------------------
// 7. THE TAB MUST ACTUALLY APPEAR (regression: the 'viewer' placeholder)
// ---------------------------------------------------------------------------
// "there's no violation tab in area managers dashboard."
//
// THE BUG. owner-dashboard.js declares `let activeUserRole = 'viewer'` and
// resolves the real role ASYNCHRONOUSLY from Firestore. This module first asks
// at DOMContentLoaded, when the getter still returns that TRUTHY placeholder.
// The obvious `if (r) return r` "succeeded" on it, applyRole() ran with a role
// that is not the user's, the nav item was hidden — and because readRole() had
// returned truthy the poll STOPPED, so the real role arriving a moment later was
// never seen. The tab stayed hidden for the whole session with no error anywhere.
{
    const s = strip(ownerViolationsJs);
    assert(!/if \(r\) return String\(r\)\.toLowerCase\(\);/.test(s),
        'readRole() must not accept ANY truthy getter value — at load that is the '
        + "placeholder 'viewer', not the user's role. Filter through isRealRole().");

    const readAt = ownerViolationsJs.indexOf('function readRole');
    const read = ownerViolationsJs.slice(readAt, ownerViolationsJs.indexOf('function isRealRole'));
    assert(/isRealRole\(r\)/.test(read),
        'readRole() must validate the getter value with isRealRole()');
    assert(/isRealRole\(text\)/.test(read),
        'readRole() must validate the badge fallback the same way');

    // Executable proof: a 'viewer' placeholder must NOT resolve, and 'owner' must.
    const s2 = { console };
    s2.window = s2;
    vm.createContext(s2);
    const fns = ownerViolationsJs.slice(
        ownerViolationsJs.indexOf('function isRealRole'),
        ownerViolationsJs.indexOf('function init'));
    vm.runInContext(fns, s2);
    assert.strictEqual(s2.isRealRole('viewer'), false,
        "'viewer' is the load-time placeholder, NOT a role — accepting it hides the tab forever");
    assert.strictEqual(s2.isRealRole('editor'), false,
        "'editor' is likewise a display label, not a stored role");
    assert.strictEqual(s2.isRealRole(''), false, 'an empty role is not resolved');
    assert.strictEqual(s2.isRealRole(null), false, 'null is not resolved');
    assert.strictEqual(s2.isRealRole('owner'), true, "the stored role 'owner' must resolve");
    assert.strictEqual(s2.isRealRole('Area Manager'), true,
        "the badge LABEL 'Area Manager' must resolve, or the fallback can never "
        + 'identify an Area Manager');
    assert.strictEqual(s2.isRealRole('hr'), true, 'hr must resolve');
    assert.strictEqual(s2.isRealRole('superadmin'), true, 'superadmin must resolve');
    assert.strictEqual(s2.isRealRole('rmsm'), true,
        "the stored role 'rmsm' (RM/SM) must resolve, or the tab stays hidden for RM/SM");
    assert.strictEqual(s2.isRealRole('RM/SM'), true,
        "the badge LABEL 'RM/SM' must resolve, or the fallback can never identify an RM/SM");

    // And the placeholder must be mapped to the STORED value before the gate.
    const gate2 = s.slice(s.indexOf('function applyRole'), s.indexOf('function refresh'));
    assert(/===\s*'owner'/.test(gate2),
        'applyRole() must still gate on the stored role so the badge label maps through');
    // POLICY REVERSAL, DELIBERATE: RM/SM may now OPEN a violation MENTIONED in the
    // store chat, so applyRole() arms the listener + openModal for 'rmsm' too.
    // What must NOT change is the TAB: it stays owner-only (tabVisible).
    assert(/===\s*'rmsm'/.test(gate2),
        'applyRole() must now admit rmsm to the listener/openModal path so a ' +
        'mentioned violation can be opened; RM/SM reaches a report ONLY via chat');
    assert(/tabVisible\s*=/.test(gate2),
        'applyRole() must split the tab (tabVisible, owner-only) from the ' +
        'listener/openModal path (allowed) so RM/SM opens a chip but sees no tab');
    assert(/navItem\.style\.display\s*=\s*tabVisible/.test(gate2),
        'the nav item must show only when tabVisible (owner), never when merely ' +
        'allowed (rmsm) — RM/SM now gets the same violations tab');
}

console.log('  ✓ violation → Area Manager handoff');
console.log('\n✅ Area-Manager violation handoff tests passed (firestore.rules admits the '
    + "'owner' role for managerStatus==='transferred' while every WRITE rule still "
    + 'refuses it; the listener filters on managerStatus only, so it needs no '
    + 'composite index and can never run an unfiltered query; transfer stamps and '
    + 'revert deletes managerStatus without touching hrStatus, so the two handoffs are '
    + 'independent; main.html gains its own button beside the HR one and both are '
    + 'refreshed wherever either is; the Area Manager gets its own #tabOwnerViolations '
    + 'rather than sharing HR\'s, with no edit/delete/transfer control; the branch '
    + 'scope is case/whitespace-insensitive and fails CLOSED on an empty list, a '
    + 'missing store, and at openModal(); and readRole() rejects the async '
    + "'viewer' placeholder so the tab actually appears once the real role lands).");

// ---------------------------------------------------------------------------
// 8. THE PERIOD FILTER — #ownerViolationPeriodFilter (Today / This week /
//    This month / All reports) on the Area Manager's Transferred Violations
//    tab. Mirrors the HR tab's #violationPeriodFilter on the same page.
// ---------------------------------------------------------------------------
const src = ownerViolationsJs;
{
    // ---- stub the DOM elements the module reads at load ----
    function makeEl(value) {
        return {
            value,
            listeners: {},
            addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
            dispatch(type) { (this.listeners[type] || []).forEach(fn => fn()); },
            classList: {
                _s: new Set(),
                add(c) { this._s.add(c); },
                remove(c) { this._s.delete(c); },
                toggle(c, force) { if (force === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (force) { this._s.add(c); } else { this._s.delete(c); } },
                contains(c) { return this._s.has(c); }
            },
            style: {},
            dataset: {},
            innerHTML: '',
            textContent: ''
        };
    }
    const nodes = {};
    ['ownerViolationsNavItem', 'ownerViolationSearch', 'ownerViolationStoreFilter',
     'ownerViolationPeriodFilter', 'ownerViolationsBody', 'ownerViolationPagination',
     'ownerViolationModal', 'ownerViolationModalTitle', 'ownerViolationModalBody',
     'ownerViolationAttachmentsGrid', 'btnOwnerViolationReport',
     'closeOwnerViolationModal', 'tabOwnerViolations', 'ownerUserRoleBadge'].forEach(id => {
        nodes[id] = makeEl('');
    });
    nodes.ownerViolationPeriodFilter.value = 'all';

    const ctx = {
        window: {},
        console,
        setTimeout,
        clearTimeout,
        Date,
        Array,
        Set,
        parseInt,
        String,
        Math,
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
        document: {
            readyState: 'complete',
            getElementById: (id) => nodes[id] || null,
            addEventListener() {}
        },
        capturedCb: null,
        firestoreService: {
            // THE ONLY SHAPE THE MODULE CALLS — the result populates
            // allViolations on the listener, then applyFilters().
            listenTransferredViolationsForAreaManager(cb) {
                ctx.capturedCb = cb;
                return () => {};
            }
        },
        showToast() {},
        escapeHTML: (v) => String(v == null ? '' : v),
        // Branch scope the manager resolves — the module re-reads this on
        // every filter, so injecting it mid-test is legal.
        getOwnerAssignedBranches: () => ['Banawe']
    };
    ctx.window = ctx;
    ctx.document.window = ctx.document;
    ctx.firestoreService.window = ctx.firestoreService;
    vm.createContext(ctx);
    vm.runInContext(src, ctx);

    const H = ctx.window.OwnerViolations;
    assert(H, 'OwnerViolations must be exported');

    // ---- the tab shows for both store-side managers (Area Manager + RM/SM), never for HR ----
    H.applyRole('owner');
    assert.strictEqual(nodes.ownerViolationsNavItem.style.display, 'flex',
        'the Area Manager (owner) sees the Transferred Violations tab');
    H.applyRole('rmsm');
    assert.strictEqual(nodes.ownerViolationsNavItem.style.display, 'flex',
        'RM/SM also sees the Transferred Violations tab');
    H.applyRole('hr');
    assert.strictEqual(nodes.ownerViolationsNavItem.style.display, 'none',
        'HR is never shown the tab');

    // ---- seed the listener, then watch the period filter work ----
    const now = new Date('2026-10-15T12:00:00.000Z');
    const aDayAgo = new Date(now); aDayAgo.setDate(aDayAgo.getDate() - 1);
    const aWeekAgo = new Date(now); aWeekAgo.setDate(aWeekAgo.getDate() - 10);
    const aMonthAgo = new Date(now); aMonthAgo.setDate(aMonthAgo.getDate() - 20);

    const seed = () => ctx.capturedCb([
        { id: 'v1', violationNumber: 'VIO-2001', store: 'Banawe', managerStatus: 'transferred',
          reportDateTime: now.toISOString(), subject: 'Cash missing' },
        { id: 'v2', violationNumber: 'VIO-2002', store: 'Banawe', managerStatus: 'transferred',
          reportDateTime: aWeekAgo.toISOString(), subject: 'Smash and grab' },
        { id: 'v3', violationNumber: 'VIO-2003', store: 'Banawe', managerStatus: 'transferred',
          reportDateTime: aMonthAgo.toISOString(), subject: 'Broken window' },
        { id: 'v4', violationNumber: 'VIO-2004', store: 'Banawe', managerStatus: 'transferred',
          subject: 'Undated report' }     // no reportDateTime → never hidden
    ]);

    const body = () => nodes.ownerViolationsBody.innerHTML;
    const rowCount = () => (body().match(/data-id=/g) || []).length;

    // Today (default) → today's row + dateless row; the week-old and month-old
    // rows are cut, but the dateless one still shows.
    seed();
    nodes.ownerViolationPeriodFilter.value = 'daily';
    H.applyFilters();
    assert.strictEqual(rowCount(), 2, 'Today bucket: today + dateless, got ' + rowCount());
    assert.ok(/VIO-2001/.test(body()), 'today row shown (default bucket)');
    assert.ok(!/VIO-2002/.test(body()), 'week-old row cut by "Today"');
    assert.ok(!/VIO-2003/.test(body()), 'month-old row cut by "Today"');
    assert.ok(/VIO-2004/.test(body()), 'dateless reports are NEVER hidden, even outside today');

    // Weekly → today + dateless only; v2 is 20 days old, in the month but not
    // in the week, so this bucket is identical to "Today" with this seed.
    nodes.ownerViolationPeriodFilter.value = 'weekly';
    H.applyFilters();
    assert.strictEqual(rowCount(), 2, 'This week: today + dateless, got ' + rowCount());

    // Monthly → today + week-old + dateless (v2 is inside the current month);
    // v3 is 40 days old and falls out.
    nodes.ownerViolationPeriodFilter.value = 'monthly';
    H.applyFilters();
    assert.strictEqual(rowCount(), 3, 'This month: today + week-old + dateless, got ' + rowCount());
    assert.ok(/VIO-2002/.test(body()), 'month-old row shown in "This month"');

    // All → nothing is cut by the period filter.
    nodes.ownerViolationPeriodFilter.value = 'all';
    H.applyFilters();
    assert.strictEqual(rowCount(), 4, 'All reports shows every row');

    // ---- the filter never deletes, it only hides ----
    // Re-seed, then narrow and widen again: rows come back out of the window.
    seed();
    nodes.ownerViolationPeriodFilter.value = 'monthly';
    H.applyFilters();
    assert.strictEqual(rowCount(), 3, 'monthly hides 1 row (v3), keeps today + week-old + dateless');
    nodes.ownerViolationPeriodFilter.value = 'all';
    H.applyFilters();
    assert.strictEqual(rowCount(), 4, 'switching to All restores all 4');

    // ---- the empty state distinguishes "no reports transferred" from
    //      "reports outside the selected period" and points at All ----
    // A seed with NO in-window and NO dateless row empties the daily bucket;
    // the "2 older reports" count proves the period predicate cut them.
    ctx.capturedCb([
        { id: 'v2', violationNumber: 'VIO-2002', store: 'Banawe', managerStatus: 'transferred',
          reportDateTime: aWeekAgo.toISOString(), subject: 'Smash and grab' },
        { id: 'v3', violationNumber: 'VIO-2003', store: 'Banawe', managerStatus: 'transferred',
          reportDateTime: aMonthAgo.toISOString(), subject: 'Broken window' }
    ]);
    nodes.ownerViolationPeriodFilter.value = 'daily';
    H.applyFilters();
    assert.strictEqual(rowCount(), 0, 'nothing from 10/20 days ago survives the Today bucket');
    assert.ok(/No reports in this period/i.test(body()),
        'empty state says "no reports in this period", not a generic "nothing matches"');
    assert.ok(/2 older reports? outside the selected date range/i.test(body()),
        'empty state counts the reports that fell outside the window');
    assert.ok(/All reports/i.test(body()),
        'empty state points the manager back to "All reports" so the row count can be restored');

    // "No reports have been transferred to you yet" is still reachable: re-seed an
    // empty array and the period filter must not manufacture a report.
    ctx.capturedCb([]);
    nodes.ownerViolationPeriodFilter.value = 'daily';
    H.applyFilters();
    assert.ok(/No violation reports have been transferred to you yet/i.test(body()),
        '"no violation reports transferred yet" stays true when the list never populated');

    // ---- the period change is wired through the listener, not just the test ----
    seed();
    nodes.ownerViolationPeriodFilter.value = 'weekly';
    nodes.ownerViolationPeriodFilter.dispatch('change');
    assert.strictEqual(rowCount(), 2,
        'a change on the period select re-runs the filter by itself');

    // ---- search + period work together ----
    nodes.ownerViolationSearch.value = 'CASH';
    H.applyFilters();
    assert.strictEqual(rowCount(), 1, 'search narrows inside the period bucket');
    nodes.ownerViolationSearch.value = '';
    H.applyFilters();

    // ---- store + period together (the store is already scoped to the manager) ----
    seed();
    nodes.ownerViolationStoreFilter.value = 'Banawe';
    nodes.ownerViolationPeriodFilter.value = 'all';
    H.applyFilters();
    assert.strictEqual(rowCount(), 4, 'store + All: every scoped row shows');
    nodes.ownerViolationPeriodFilter.value = 'daily';
    H.applyFilters();
    assert.strictEqual(rowCount(), 2, 'store + Today: the two filters intersect cleanly');
    nodes.ownerViolationStoreFilter.value = 'all';
}

