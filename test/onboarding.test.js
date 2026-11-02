// Tests for the first-run onboarding tour (js/onboarding.js).
//
// WHY THIS FILE EXISTS
// An onboarding tour that misbehaves is worse than no tour at all, because it
// intercepts the UI of someone who is trying to do their job. The specific
// failure modes this guards:
//   - Showing on a page it was not written for (the owner dashboard has a
//     completely different layout, so the copy would describe UI that is not
//     there).
//   - Showing again on every reload after being dismissed.
//   - Pointing at an element that no longer exists.
//   - Trapping the user: there must always be a way out (Skip / Escape).
//
// Run: npm test

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'onboarding.js'), 'utf8');
const mainHtml = fs.readFileSync(path.join(ROOT, 'main.html'), 'utf8');
const ownerHtml = fs.readFileSync(path.join(ROOT, 'ownerdashboard.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const paletteSrc = fs.readFileSync(path.join(ROOT, 'js', 'command-palette.js'), 'utf8');

console.log('Testing onboarding tour...');

// A single element factory shared by makeEnv and by the tests, so every node
// has a real (own-property) classList. Arrow functions inside an object
// literal capture the enclosing `this`, which silently broke classList.add —
// hence the named `el` closure rather than method shorthand.
function makeNode() {
    const el = {
        _attrs: {},
        _classes: [],
        addEventListener() {},
        appendChild() {},
        focus() {},
        setAttribute(k, v) { el._attrs[k] = v; },
        getAttribute(k) { return el._attrs[k] || null; },
        set className(v) { el._c = v; },
        get className() { return el._c; },
        set innerHTML(v) { el._h = v; },
        get innerHTML() { return el._h; },
        set textContent(v) { el._t = v; },
        get textContent() { return el._t; }
    };
    el.classList = {
        add(c) { if (el._classes.indexOf(c) === -1) el._classes.push(c); },
        remove(c) { el._classes = el._classes.filter(x => x !== c); },
        contains(c) { return el._classes.indexOf(c) > -1; }
    };
    return el;
}

// A minimal document. querySelector returns null unless a test opts in, so
// the "unsupported page" path is the default.
function makeEnv(opts) {
    opts = opts || {};
    const storage = {};
    const body = {
        classes: [],
        children: [],
        appendChild(child) { body.children.push(child); return child; },
        classList: {
            add: (c) => { if (body.classes.indexOf(c) === -1) body.classes.push(c); },
            remove: (c) => { body.classes = body.classes.filter(x => x !== c); },
            contains: (c) => body.classes.indexOf(c) > -1
        }
    };
    const targets = opts.targets || {};
    const document = {
        readyState: 'complete',
        body,
        createElement: makeNode,
        querySelector: (sel) => (sel in targets ? targets[sel] : null),
        addEventListener() {}
    };
    const sandbox = {
        console,
        document,
        window: {},
        localStorage: {
            getItem: (k) => (k in storage ? storage[k] : null),
            setItem: (k, v) => { storage[k] = String(v); }
        },
        setTimeout: () => {}   // suppress the auto-start during the test
    };
    sandbox.window.document = document;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return { sandbox, storage, body };
}

// ---------------------------------------------------------------------
console.log('\n=== The tour only runs on the command center ===');

// 1. With no sidebar (owner dashboard, login, public ticket page), start() is
//    a no-op rather than describing a UI that is not there.
{
    const env = makeEnv({ targets: {} });
    env.sandbox.window.Onboarding.start();
    assert.strictEqual(
        env.sandbox.window.Onboarding.isOpen(), false,
        'the tour must not open on a page without a sidebar nav'
    );
    assert.strictEqual(env.body.classList.contains('is-touring'), false, 'the page must not be dimmed');
}

// 2. On the command center (sidebar + active tab) it does open.
{
    const env = makeEnv({ targets: { '.sidebar-nav': makeNode(), '.tab-content.active': makeNode() } });
    env.sandbox.window.Onboarding.start();
    assert.strictEqual(env.sandbox.window.Onboarding.isOpen(), true, 'the tour must open on the command center');
    assert.strictEqual(env.body.classList.contains('is-touring'), true, 'the page must be dimmed while touring');
}

// 3. A sidebar alone is not enough — every step points at something inside a
//    tab panel, so the active tab is required too.
{
    const env = makeEnv({ targets: { '.sidebar-nav': makeNode() } });
    env.sandbox.window.Onboarding.start();
    assert.strictEqual(
        env.sandbox.window.Onboarding.isOpen(), false,
        'the tour must not open without an active tab panel'
    );
}

// ---------------------------------------------------------------------
console.log('\n=== It shows once, and only once ===');

const KEY = 'rcms_tour_seen';

// 4. Dismissing persists the flag and lifts the dim.
{
    const env = makeEnv({ targets: { '.sidebar-nav': makeNode(), '.tab-content.active': makeNode() } });
    env.sandbox.window.Onboarding.start();
    env.sandbox.window.Onboarding.finish();
    assert.strictEqual(env.storage[KEY], '1', 'finishing must persist rcms_tour_seen=1');
    assert.strictEqual(env.body.classList.contains('is-touring'), false, 'the dim must be lifted on finish');
}

// 5. A later page load with the flag set does not re-open the tour.
{
    const env = makeEnv({ targets: { '.sidebar-nav': makeNode(), '.tab-content.active': makeNode() } });
    env.storage[KEY] = '1';
    env.sandbox.window.Onboarding.start();
    assert.strictEqual(env.sandbox.window.Onboarding.isOpen(), false, 'the tour must not re-open once seen');
}

// 6. The storage key follows the existing rcms_* convention.
assert(src.indexOf("rcms_tour_seen") > -1, 'the tour must use the rcms_ localStorage prefix');

// ---------------------------------------------------------------------
console.log('\n=== Steps point at real elements ===');

// Pull the step definitions straight off the module's public API rather than
// re-evaluating the source. Same data, no fragile source-slicing.
const steps = makeEnv({ targets: {} }).sandbox.window.Onboarding.steps;

// 7. A short tour, and every step is fully written.
assert.strictEqual(steps.length, 3, 'the tour is a short 3-step tour');
steps.forEach(function (step, i) {
    assert(step.title && step.title.length > 0, 'step ' + (i + 1) + ' needs a title');
    assert(step.body && step.body.length > 0, 'step ' + (i + 1) + ' needs body copy');
    assert(typeof step.target === 'string' && step.target, 'step ' + (i + 1) + ' needs a target selector');
});

// 8. Every selector must resolve to something that really exists in main.html.
//    A tour that points at a removed element silently skips the step, so a
//    broken tour looks like a shorter tour rather than an error.
//
//    The check maps each CSS selector onto the markup that would satisfy it.
//    Comparing the selector text against the HTML would never work —
//    `.sidebar-nav` is not a substring of `class="sidebar-nav"`. Class matching
//    has to consider a token ANYWHERE in a class attribute, because real
//    elements carry several: `class="summary-cards dash-kpis"` satisfies
//    `.dash-kpis` but not `class="dash-kpis"`.
function selectorExistsInHtml(selector, html) {
    return selector.split(',').some(function (part) {
        const sel = part.trim();
        if (sel.charAt(0) === '#') {
            return html.indexOf('id="' + sel.slice(1) + '"') > -1;
        }
        if (sel.charAt(0) === '.') {
            // Every class in the selector must appear as a token in some
            // class attribute. A rough substring test is enough here: this is
            // a "did the markup move" guard, not a CSS engine.
            return sel.slice(1).split('.').every(function (cls) {
                return new RegExp('class="[^"]*\\b' + cls + '\\b').test(html);
            });
        }
        return html.indexOf(sel) > -1;
    });
}
steps.forEach(function (step, i) {
    assert(
        selectorExistsInHtml(step.target, mainHtml),
        'step ' + (i + 1) + ' targets "' + step.target + '", which matches nothing in main.html'
    );
});

// 9. A step whose element is missing is SKIPPED rather than rendered pointing
//    at nothing — and if the LAST step's target is gone the tour closes rather
//    than hanging on a step that can never render.
//
//    Here only the sidebar (step 0's target) exists, so the tour opens on step
//    0 and waits for the user. That is correct: the skip-forward is driven by a
//    missing target, and step 0's target is present.
{
    const env = makeEnv({ targets: { '.sidebar-nav': makeNode(), '.tab-content.active': makeNode() } });
    env.sandbox.window.Onboarding.start();
    assert.strictEqual(
        env.sandbox.window.Onboarding.isOpen(), true,
        'the tour must open on the one step whose target exists'
    );
    env.sandbox.window.Onboarding.finish();
    assert.strictEqual(
        env.sandbox.window.Onboarding.isOpen(), false,
        'and must close when finished'
    );
}

// 9b. The skip-forward and close-on-missing-target logic is present, so a
//     step pointing at a deleted element cannot strand the tour.
assert(
    src.indexOf('if (index < STEPS.length - 1) { index++; render(); }') > -1,
    'a step with a missing target must advance to the next one'
);
assert(
    src.indexOf('else finish();') > -1,
    'the last step with a missing target must close the tour, not hang'
);

// ---------------------------------------------------------------------
console.log('\n=== The user can always escape ===');

// 10. Escape, clicking the dimmer, and a visible Skip button all close it.
assert(src.indexOf("event.key === 'Escape'") > -1, 'Escape must close the tour');
assert(
    src.indexOf('if (event.target === overlay) finish();') > -1,
    'clicking outside the card must close the tour'
);
assert(
    src.indexOf("skipBtn.textContent = 'Skip'") > -1,
    'there must be a visible Skip button — a tour with no exit is a trap'
);

// 11. The final step ends the tour rather than looping, and says so.
assert(src.indexOf('index >= STEPS.length - 1') > -1, 'the last step must finish the tour');
assert(src.indexOf("'Got it'") > -1, 'the last step must relabel its button so the end is obvious');

// ---------------------------------------------------------------------
console.log('\n=== Wiring, accessibility and motion ===');

// 12. Loaded on the command center, after the palette (which offers replay).
assert(/js\/onboarding\.js[\s\S]*<\/body>/.test(mainHtml), 'js/onboarding.js must be loaded on main.html');

// 13. NOT loaded on the owner dashboard — the tour describes the operator /
//     superadmin layout, so loading it there could only ever no-op.
assert(
    ownerHtml.indexOf('js/onboarding.js') === -1,
    'the tour must NOT load on ownerdashboard.html (different layout entirely)'
);

// 14. A real dialog for assistive tech, labelled by its own heading.
assert(src.indexOf("setAttribute('role', 'dialog')") > -1, 'the tour must be role="dialog"');
assert(src.indexOf("setAttribute('aria-modal', 'true')") > -1, 'the tour must be aria-modal');
assert(src.indexOf("setAttribute('aria-labelledby', 'tourTitle')") > -1, 'the tour must be labelled by its title');
assert(src.indexOf('id="tourTitle"') > -1, 'the title element must exist to be referenced');

// 15. Focus moves into the tour when it opens, so a keyboard user is not left
//     tabbing around the page behind the dim.
assert(src.indexOf('els.next.focus()') > -1, 'focus must move to the tour on open');

// 16. Copy is escaped — the tour builds HTML by concatenation.
assert(src.indexOf('escapeText(step.title)') > -1, 'the title must be escaped');
assert(src.indexOf('escapeText(step.body)') > -1, 'the body copy must be escaped');

// 17. Motion is opt-out-able, and the spotlight falls back to an outline so the
//     target is still identifiable.
assert(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?is-tour-target/.test(styleCss),
    'the tour spotlight must honour prefers-reduced-motion'
);

// 18. It themes through the shared modal classes rather than hardcoding
//     colours — the same rule owner-dark-mode.test.js enforces elsewhere.
const tourCss = styleCss.slice(styleCss.indexOf('ONBOARDING TOUR'));
const hexInTour = tourCss.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
assert.strictEqual(
    hexInTour.length, 0,
    'the tour CSS must not hardcode hex colours — it must use theme variables. Found: ' + hexInTour.join(', ')
);

// 19. Dismissing is not permanent — the palette offers a replay.
assert(paletteSrc.indexOf('replay-tour') > -1, 'the command palette must offer a way to replay the tour');

console.log('\nOK: onboarding tour tests passed (page scoping, once-only persistence, real targets, escapability, a11y, reduced motion, theme tokens, replay path).');