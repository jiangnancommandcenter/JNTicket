// ==============================================================
//  AUTOMATIC ERROR REPORTING
//  Runs js/error-reporter.js in a sandbox with a stubbed Firestore and
//  asserts the safety properties that matter, because this code sits in
//  the failure path — a bug here means silent data loss or an error loop
//  rather than a visible one.
//
//  Also statically checks the firestore.rules allowlist for app_errors,
//  since read access must stay superadmin-only.
// ==============================================================
// ==============================================================
//  AUTOMATIC ERROR REPORTING
//  Runs js/error-reporter.js in a sandbox and asserts the safety
//  properties that matter, because this code sits in the failure
//  path — a bug here means an error loop rather than a visible one.
//
//  ⚠️ THIS USED TO TEST FIRESTORE WRITES. The reporter no longer
//  writes anything: it logs to the console. That change was made
//  because the app runs on the free (Spark) plan and the reporter
//  was costing real quota (one write per error, PLUS a full
//  collection read from pruneCollection() on every report, plus a
//  toast shown to every user). So the headline assertion here is
//  NEGATIVE: `db`/`firebase` must never be touched at all.
//
//  The dedupe, re-entrancy and truncation guarantees are unchanged
//  and still tested — they are what stops a broken setInterval from
//  flooding anything, and that matters for console noise too.
// ==============================================================
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'js', 'error-reporter.js'), 'utf8');
const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const scriptJs = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const mainHtml = fs.readFileSync(path.join(ROOT, 'main.html'), 'utf8');
const ownerHtml = fs.readFileSync(path.join(ROOT, 'ownerdashboard.html'), 'utf8');

console.log('Testing error reporter...');

/**
 * Load the reporter in a sandbox and capture what it LOGS.
 *
 * ⚠️ `db` and `firebase` are TRAPS, not stubs: any access is recorded
 * and throws. That is the whole point — the reporter must not touch
 * Firestore at all now, so the sandbox proves it by punishing the
 * attempt rather than by supplying a working fake that would let a
 * regression pass unnoticed.
 */
function loadReporter(options = {}) {
    const logged = [];
    const dbCalls = [];
    const trap = (label) => new Proxy({}, {
        get(_t, prop) {
            dbCalls.push(label + '.' + String(prop));
            throw new Error('the reporter must not touch Firestore (called ' + label + '.' + String(prop) + ')');
        }
    });

    const sandbox = {
        db: trap('db'),
        firebase: trap('firebase'),
        auth: { currentUser: options.user === undefined ? null : { email: options.user } },
        navigator: { userAgent: 'test-agent' },
        console: {
            warn: () => {},
            error: (...args) => { logged.push(args); },
            log: () => {}
        },
        // A toast here would mean a user-facing popup, which the
        // console-only version deliberately dropped.
        showToast: () => { logged.push(['__TOAST__']); },
        location: { pathname: '/testpage.html' },
        // readyState 'complete' so the reporter calls init() on load,
        // and addEventListener is a no-op (we drive listeners manually).
        document: { readyState: 'complete', addEventListener: () => {} },
        setTimeout,
        Promise,
        Date
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);

    // init() attaches the listeners; expose a way to fire them.
    const listeners = {};
    sandbox.window.addEventListener = (type, fn) => { listeners[type] = fn; };
    sandbox.ErrorReporter.init();

    return { ER: sandbox.ErrorReporter, logged, dbCalls, listeners, sandbox };
}

/** The structured object logged for a report (ignoring the '[RCMS]' tag). */
function entries(logged) {
    return logged
        .filter((args) => args[0] === '[RCMS]')
        .map((args) => args[1]);
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --------------------------------------------------------------
// 1. Nothing is written to Firestore — the reason this changed
// --------------------------------------------------------------
test('the reporter never touches Firestore', () => {
    const h = loadReporter({ user: 'hr@test.com' });
    h.ER.report({ message: 'chat blew up', source: 'script.js:42' });
    h.ER.report({ message: 'second failure' });
    assert.deepStrictEqual(h.dbCalls, [],
        'the reporter must not call db/firebase at all; saw: ' + JSON.stringify(h.dbCalls));
    assert.strictEqual(entries(h.logged).length, 2, 'both errors should still be reported');
});

test('no app_errors rule remains in firestore.rules', () => {
    assert(!/match \/app_errors/.test(rules),
        'the app_errors block must be gone from firestore.rules');
    // ⚠️ CHECKED ON COMMENT-STRIPPED SOURCE. The reporter's header explains
    // what was removed and therefore NAMES app_errors on purpose, so a raw
    // text search would fail on the very comment documenting the change.
    // What matters is that no LIVE code refers to it.
    const live = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(!/app_errors/.test(live),
        'js/error-reporter.js must not reference app_errors in live code');
    assert(!/\bdb\b\s*\.\s*collection/.test(live),
        'the reporter must not read or write a collection at all');
});

test('the Error Log tab is gone from the command center', () => {
    assert(!/id="tabErrors"/.test(mainHtml), 'the #tabErrors section must be removed');
    assert(!/id="errorsNavItem"/.test(mainHtml), 'the Error Log nav item must be removed');
    assert(!/loadErrorLog/.test(scriptJs), 'script.js must not still call loadErrorLog()');
    assert(!/app_errors/.test(scriptJs), 'script.js must not still read app_errors');
});

// --------------------------------------------------------------
// 2. What the console line must contain
// --------------------------------------------------------------
test('a report logs one line carrying the debugging context', () => {
    const h = loadReporter({ user: 'HR@Test.com' });
    h.ER.report({ message: 'chat blew up', source: 'script.js:42', kind: 'error' });

    const out = entries(h.logged);
    assert.strictEqual(out.length, 1, 'expected exactly one logged entry');
    const e = out[0];

    assert.strictEqual(e.message, 'chat blew up');
    assert.strictEqual(e.source, 'script.js:42');
    assert.strictEqual(e.kind, 'error');
    assert.strictEqual(e.page, 'testpage.html');
    assert.strictEqual(e.user, 'hr@test.com', 'email should be lowercased');
    assert.strictEqual(e.userAgent, 'test-agent');
    assert.strictEqual(e.count, 1, 'the first line must already carry a count');
    assert(typeof e.at === 'string' && e.at.length > 0, 'a timestamp makes the line self-describing');
});

test('a signed-out visitor is reported, not dropped', () => {
    const h = loadReporter();
    h.ER.report({ message: 'anon crash' });
    assert.strictEqual(entries(h.logged)[0].user, 'signed-out');
});

test('no toast is shown — the popup was dropped deliberately', () => {
    const h = loadReporter();
    h.ER.report({ message: 'quiet please' });
    assert.strictEqual(h.logged.filter((a) => a[0] === '__TOAST__').length, 0,
        'the console-only version must not interrupt the user with a toast');
});

// --------------------------------------------------------------
// 3. De-duplication — the anti-flood guarantee
// --------------------------------------------------------------
test('the same error twice logs ONE line, not two', () => {
    const h = loadReporter();
    h.ER.report({ message: 'repeated failure' });
    h.ER.report({ message: 'repeated failure' });
    h.ER.report({ message: 'repeated failure' });

    assert.strictEqual(entries(h.logged).length, 1,
        'a repeat must not add a line, or a broken setInterval floods the console');
    assert.deepStrictEqual(h.dbCalls, [], 'and must still not write anything');
});

test('different errors are both logged', () => {
    const h = loadReporter();
    h.ER.report({ message: 'error one' });
    h.ER.report({ message: 'error two' });
    assert.strictEqual(entries(h.logged).length, 2);
});

test('a repeat after the dedupe window logs again', () => {
    const h = loadReporter();
    const clock = { t: 1000 };
    // report() reads Date.now() for the window, so drive that directly.
    h.sandbox.Date.now = () => clock.t;
    h.ER.report({ message: 'later failure' });
    clock.t += h.ER.DEDUPE_MS + 1;
    h.ER.report({ message: 'later failure' });
    assert.strictEqual(entries(h.logged).length, 2,
        'once the window passes, the error must be reported again');
});

// --------------------------------------------------------------
// 4. Never throws, never loops
// --------------------------------------------------------------
test('a completely bare sandbox still works (no db, no auth, no navigator)', () => {
    const sandbox = { console, location: { pathname: '/x.html' } };
    sandbox.window = sandbox;
    sandbox.addEventListener = () => {};
    sandbox.document = { readyState: 'complete', addEventListener: () => {} };
    // `db`, `firebase`, `auth` and `navigator` are all deliberately absent.
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox);
    assert.doesNotThrow(() => sandbox.ErrorReporter.report({ message: 'still fine' }));
});

test('a missing payload does not throw', () => {
    const h = loadReporter();
    assert.doesNotThrow(() => h.ER.report());
    assert.doesNotThrow(() => h.ER.report({}));
    assert.strictEqual(entries(h.logged).length, 0, 'a blank message is not worth a line');
});

test('a broken console does not throw (the reporter cannot break the page)', () => {
    const h = loadReporter();
    h.sandbox.console.error = () => { throw new Error('console is on fire'); };
    assert.doesNotThrow(() => h.ER.report({ message: 'console exploded' }));
});

test('a report raised from inside a report cannot recurse', () => {
    const h = loadReporter();
    let depth = 0;
    h.sandbox.console.error = () => {
        depth++;
        if (depth < 5) h.ER.report({ message: 'recursive failure' });
    };
    h.ER.report({ message: 'outer failure' });
    assert.strictEqual(depth, 1,
        'the re-entrancy flag must stop a report raised from inside a report');
});

// --------------------------------------------------------------
// 5. Truncation — one readable line, not a wall of text
// --------------------------------------------------------------
test('long messages are truncated', () => {
    const h = loadReporter();
    h.ER.report({ message: 'x'.repeat(5000) });
    const e = entries(h.logged)[0];
    assert(e.message.length < 600, 'message should be bounded, got ' + e.message.length);
    assert(e.message.endsWith('…'), 'truncation should be visible');
});

test('truncate handles odd input', () => {
    const h = loadReporter();
    assert.strictEqual(h.ER.truncate(undefined), '');
    assert.strictEqual(h.ER.truncate(null), '');
    assert.strictEqual(h.ER.truncate(''), '');
    assert.strictEqual(h.ER.truncate(123), '123');
});

// --------------------------------------------------------------
// 6. The hooks, and where the file loads
// --------------------------------------------------------------
test('it hooks error and unhandledrejection, but not console', () => {
    const h = loadReporter();
    assert(typeof h.listeners.error === 'function', 'no window error hook');
    assert(typeof h.listeners.unhandledrejection === 'function', 'no unhandledrejection hook');
    assert.strictEqual(h.listeners.log, undefined, 'must NOT hook console.log');
    assert.strictEqual(h.listeners.warn, undefined, 'must NOT hook console.warn');
});

test('a window error is reported with a readable source', () => {
    const h = loadReporter();
    h.listeners.error({
        message: 'boom',
        filename: 'https://cdn.example/js/chat.js',
        lineno: 10,
        colno: 5,
        target: null
    });
    const e = entries(h.logged)[0];
    assert.strictEqual(e.message, 'boom');
    assert.strictEqual(e.source, 'chat.js:10:5', 'the source should be reduced to file:line:col');
});

test('a <script> resource failure is ignored (the pages handle those)', () => {
    const h = loadReporter();
    h.listeners.error({ message: 'load failed', target: { tagName: 'SCRIPT' } });
    assert.strictEqual(entries(h.logged).length, 0,
        'a resource-load error is not an app crash and must stay out');
});

test('an unhandled rejection is reported', () => {
    const h = loadReporter();
    h.listeners.unhandledrejection({ reason: new Error('send failed') });
    const e = entries(h.logged)[0];
    assert.strictEqual(e.message, 'send failed');
    assert.strictEqual(e.kind, 'unhandledrejection');
});

test('the reporter is loaded on both pages before the other scripts', () => {
    for (const [name, html] of [['main.html', mainHtml], ['ownerdashboard.html', ownerHtml]]) {
        assert(html.includes('js/error-reporter.js'), `${name} does not load the reporter`);
        const reporterAt = html.indexOf('js/error-reporter.js');
        const chatAt = html.indexOf('js/chat.js');
        if (chatAt > -1) {
            assert(reporterAt < chatAt, `${name}: reporter must load before js/chat.js to catch its failures`);
        }
    }
});

// ---------------------------------------------------------------
(async () => {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log('  PASS  ' + name);
        } catch (e) {
            failed++;
            console.log('  FAIL  ' + name);
            console.log('        ' + (e && e.message ? e.message : e));
        }
    }
    console.log(failed === 0
        ? `OK: ${tests.length}/${tests.length} error reporter assertions passed`
        : `\n${failed} of ${tests.length} error reporter assertions FAILED`);
    process.exit(failed === 0 ? 0 : 1);
})();

