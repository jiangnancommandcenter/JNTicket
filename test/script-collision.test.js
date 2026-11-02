// Functional test for cross-file global collisions on ownerdashboard.html.
//
// THE BUG THIS LOCKS DOWN:
//   js/notifications.js defines the real `window.showToast` (3-arg, renders a
//   toast). js/owner-dashboard.js — loaded LATER on the same page — ALSO
//   declared a top-level `function showToast`. In a classic script a top-level
//   function becomes a property of `window`, so the second declaration
//   silently OVERWROTE the first, and its body delegated to `window.showToast`
//   ... which was now itself. Every toast on the HR dashboard recursed until
//   `RangeError: Maximum call stack size exceeded`.
//
//   The nastiest consequence: hr-violations.js downloadReport() calls
//   toast('Report downloaded.') AFTER the PDF is already saved. The RangeError
//   is caught by its own catch block, which then calls toast() AGAIN — so the
//   user sees nothing while the console claims the report could not be built.
//
// WHY THE EXISTING SUITES MISSED IT:
//   Every other test node --check's each file in isolation or sandboxes ONE
//   file. This bug is an INTERACTION between two files, so no single-file test
//   can observe it. This test loads them together, in the real order that
//   ownerdashboard.html declares them.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const notificationsSrc = read('js/notifications.js');
const ownerSrc = read('js/owner-dashboard.js');

console.log('Testing cross-file global collisions on ownerdashboard.html...');

/** Strip comments so prose that NAMES an identifier is not mistaken for code. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------
// Enough DOM for js/notifications.js to build a toast and for
// js/owner-dashboard.js to run its top-level init without throwing
// on an unrelated missing element. The point is NOT to test either
// module here — it is to let both LOAD so their global side effects
// collide exactly as they do in the browser.
function makeSandbox() {
  const mkEl = () => ({
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    style: {}, dataset: {}, children: [], innerHTML: '', textContent: '',
    setAttribute() {}, getAttribute: () => null, appendChild() {},
    addEventListener() {}, remove() {}, querySelector: () => null,
    querySelectorAll: () => [], focus() {}, click() {}, disabled: false,
  });
  const document = {
    readyState: 'complete',
    documentElement: { getAttribute: () => 'light', setAttribute() {} },
    getElementById: () => null,
    createElement: mkEl,
    body: { appendChild() {} },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
  };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn) => fn(),
    document,
    localStorage: { getItem: () => null, setItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    auth: { currentUser: null, onAuthStateChanged() {}, signOut: async () => {} },
    db: {
      collection: () => ({
        where: () => ({ onSnapshot() {} }),
        doc: () => ({ get: async () => ({ exists: false }) }),
      }),
    },
    CSS: { escape: (s) => String(s) },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

const loadBoth = () => {
  const sandbox = makeSandbox();
  // ⚠️ The order matters and mirrors ownerdashboard.html: notifications.js is
  // line 1037, owner-dashboard.js is line 1045.
  vm.runInContext(notificationsSrc, sandbox);
  const afterNotifications = sandbox.showToast;
  vm.runInContext(ownerSrc, sandbox);
  return { sandbox, afterNotifications, afterBoth: sandbox.showToast };
};

// ---------------------------------------------------------------
// 1. THE REGRESSION GUARD — the actual reported bug
// ---------------------------------------------------------------
console.log('\n=== The reported bug: a delegated global that overwrites itself ===');

{
  const { sandbox, afterBoth } = loadBoth();

  assert.notStrictEqual(
    afterBoth, undefined,
    'window.showToast must still exist after owner-dashboard.js loads'
  );

  // Count how deep the call actually goes, so a failure names the cause
  // instead of dumping a stack. A self-delegating wrapper never returns.
  let depth = 0;
  const wrapped = sandbox.showToast;
  sandbox.showToast = function counting(...args) {
    depth += 1;
    if (depth > 200) throw new Error('RECURSION: showToast called itself 200+ times deep');
    return wrapped.apply(this, args);
  };

  // This is literally what js/hr-violations.js toast() does.
  assert.doesNotThrow(
    () => sandbox.showToast('Report downloaded.', 'success'),
    'window.showToast(msg, type) — as called by hr-violations/chat/error-reporter — must RETURN, not recurse'
  );
  assert.ok(depth < 20, 'showToast must not delegate more than a handful of times (depth=' + depth + ')');

  console.log('  PASS  window.showToast survives owner-dashboard.js and terminates (depth=' + depth + ')');
}

// ---------------------------------------------------------------
// 2. The real implementation, not a 2-arg wrapper, stays installed
// ---------------------------------------------------------------
console.log('\n=== The genuine 3-arg toast from notifications.js stays installed ===');

{
  const { afterNotifications, afterBoth } = loadBoth();
  assert.strictEqual(
    afterBoth, afterNotifications,
    'js/owner-dashboard.js must not overwrite window.showToast — notifications.js owns it'
  );
  // NB: do NOT discriminate on `fn.length` — `showToast(message, type = 'info',
  // duration = 4000)` has `.length === 1`, because Function.length stops at the
  // first default parameter. That is the SAME arity as the old 2-arg delegating
  // wrapper, so arity cannot tell the real implementation from the bug. The
  // identity check above is the reliable discriminator; this DOM check is the
  // behavioural one: the real toast creates and appends a node, a pure
  // delegating wrapper never does.
  const appended = [];
  const s = makeSandbox();
  s.document.body = { appendChild: (n) => appended.push(n) };
  vm.runInContext(notificationsSrc, s);
  vm.runInContext(ownerSrc, s);
  s.showToast('probe', 'success', 10);
  assert.ok(
    appended.length > 0,
    'the surviving showToast must actually render a toast into the DOM — a pure ' +
    'delegating wrapper never creates one'
  );
  console.log('  PASS  the surviving showToast is the real renderer (appended ' + appended.length + ' node)');
}

// ---------------------------------------------------------------
// 3. STATIC GUARD — stop the collision being reintroduced quietly
// ---------------------------------------------------------------
console.log('\n=== owner-dashboard.js must not declare page-global helpers ===');

// `showToast` only. `escapeHTML` is deliberately NOT in this list: renaming it
// here would change which implementation wins, and the two are not equivalent
// (notifications.js `String(str)` renders the literal text "null"/"undefined",
// owner-dashboard.js `String(v ?? '')` renders ""). Flipping the winner would
// be a visible behaviour change, so escapeHTML stays a tracked follow-up
// rather than a silent drive-by rename.
assert.ok(
  !/^\s*function\s+showToast\s*\(/m.test(stripComments(ownerSrc)),
  'js/owner-dashboard.js must not declare a top-level `function showToast` — in a classic ' +
  'script that becomes a window property and clobbers js/notifications.js, which owns it. ' +
  'Use a private helper instead (see the ownerToast helper).'
);

// The delegated-wrapper shape is the actual bug, so require the self-guard
// explicitly. (Trying to prove the *absence* of an unguarded call is brittle
// — the guard and the call are on different lines.)
assert.ok(
  /window\.showToast\s*!==\s*ownerToast/.test(stripComments(ownerSrc)),
  'js/owner-dashboard.js delegates to window.showToast, so it MUST carry the ' +
  '`window.showToast !== ownerToast` self-guard — without it, a wrapper that ' +
  'delegates to the global it overwrites is exactly what caused the infinite recursion'
);

console.log('  PASS  no top-level `function showToast` in owner-dashboard.js');
console.log('  PASS  the delegating helper carries its self-guard');

// ---------------------------------------------------------------
// 4. Every consumer still resolves a working function
// ---------------------------------------------------------------
console.log('\n=== Consumers on this page still resolve a callable toast ===');

{
  const { sandbox } = loadBoth();
  // js/chat.js:424 and js/hr-violations.js:59 guard on
  // `typeof window.showToast === 'function'` before calling it.
  assert.strictEqual(
    typeof sandbox.showToast, 'function',
    "js/chat.js and js/hr-violations.js both guard on typeof window.showToast === 'function' " +
    '— it must still be a function after both scripts load'
  );
  assert.doesNotThrow(
    () => sandbox.showToast('probe', 'info'),
    'the real toast must be buildable, i.e. the notification path really runs'
  );
  console.log('  PASS  window.showToast is callable for chat / error-reporter / hr-violations');
}

// ---------------------------------------------------------------
// 5. main.html must stay clean (script.js declares no global showToast)
// ---------------------------------------------------------------
console.log('\n=== main.html is not affected — guard against regression there too ===');

{
  assert.ok(
    !/^\s*function\s+showToast\s*\(/m.test(stripComments(read('script.js'))),
    'script.js must not declare a global showToast — it loads after notifications.js on ' +
    'main.html and would collide exactly as owner-dashboard.js did'
  );
  const mainHtml = read('main.html');
  assert.ok(/src="js\/notifications\.js"/.test(mainHtml), 'main.html must load js/notifications.js');
  assert.ok(!/src="js\/owner-dashboard\.js"/.test(mainHtml), 'main.html must not load owner-dashboard.js');
  console.log('  PASS  script.js declares no global showToast; main.html is unaffected');
}

console.log('\n✅ Cross-file collision tests passed (notifications.js keeps window.showToast; ' +
  'no self-delegating global; all consumers resolve a working toast).');

