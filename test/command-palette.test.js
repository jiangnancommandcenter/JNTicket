// Tests for the command palette + global keyboard shortcuts
// (js/command-palette.js).
//
// WHY THIS FILE EXISTS
// The palette is a keyboard-first surface, so its failure modes are silent
// and dangerous rather than loud:
//   - A single-letter shortcut that fires while the user is TYPING corrupts
//     whatever they were writing (typing "total" in a search box would toggle
//     the theme on the "t" and jump tabs on the rest).
//   - ⚠️ ...and a single-letter shortcut that fires when the user is NOT typing
//     is worse. The old "t" = theme shortcut was guarded against text fields,
//     but that guard only recognises input/textarea/select. Click a table row
//     and focus sits on THAT element, the guard passed, and the next "t"
//     silently flipped the whole app between light and dark. There is now NO
//     bare-letter shortcut here; the theme is reached through the palette
//     command or the header's moon button, both of which are explicit.
//   - Offering a command the signed-in role cannot run produces a button
//     that fails on click — the palette must never advertise Ticket Reviews
//     to an operator.
//   - A shortcut that leaks to the page while a dialog is open fires
//     "invisibly underneath" it.
//   - Labels are interpolated into HTML, and some carry user data, so every
//     rendered string has to be escaped.
//
// Run: npm test

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const paletteSrc = fs.readFileSync(path.join(ROOT, 'js', 'command-palette.js'), 'utf8');
const mainHtml = fs.readFileSync(path.join(ROOT, 'main.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

console.log('Testing command palette + keyboard shortcuts...');

// ---------------------------------------------------------------------
// A tiny fake DOM. Only the surface js/command-palette.js actually touches
// is implemented, so the test cannot pass by accident against a real browser.
// ---------------------------------------------------------------------

function makeEl(tag, opts) {
    opts = opts || {};
    return {
        tagName: (tag || 'div').toUpperCase(),
        className: opts.className || '',
        id: opts.id || '',
        innerHTML: '',
        textContent: opts.textContent || '',
        value: '',
        type: opts.type || '',
        placeholder: opts.placeholder || '',
        hidden: false,
        disabled: false,
        isContentEditable: false,
        isConnected: true,
        style: {},
        attrs: {},
        children: [],
        parentNode: null,
        display: opts.display === undefined ? 'block' : opts.display,
        listeners: {},
        // Minimal classList: the palette toggles `active` on the overlay,
        // and reads it back in closePalette().
        classList: {
            _set: opts.className ? opts.className.split(/\s+/) : [],
            add(c) { if (this._set.indexOf(c) === -1) this._set.push(c); },
            remove(c) { this._set = this._set.filter(x => x !== c); },
            contains(c) { return this._set.indexOf(c) > -1; }
        },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
        removeAttribute(k) { delete this.attrs[k]; },
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
        remove() {
            if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(c => c !== this);
            this.isConnected = false;
        },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        focus() { document.activeElement = this; },
        click() { (this.listeners.click || []).forEach(fn => fn({ target: this })); this.clicked = (this.clicked || 0) + 1; },
        select() { this.selected = true; },
        scrollIntoView() { /* no-op */ },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; }
    };
}

const document = {
    readyState: 'complete',
    activeElement: null,
    body: makeEl('body'),
    createElement: (tag) => makeEl(tag),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
};

const sandbox = {
    console,
    document,
    window: {},
    getComputedStyle: (el) => ({ display: el && el.display !== undefined ? el.display : 'block' })
};
sandbox.window.document = document;
vm.createContext(sandbox);
vm.runInContext(paletteSrc, sandbox);

const CP = sandbox.window.CommandPalette;
assert(CP, 'js/command-palette.js must expose window.CommandPalette');

// A synthetic key event. `prevented` counts preventDefault calls, which is
// how we assert a shortcut did NOT claim a key it has no business claiming.
function key(name, opts) {
    opts = opts || {};
    const ev = {
        key: name,
        target: opts.target || makeEl('div'),
        ctrlKey: !!opts.ctrlKey,
        metaKey: !!opts.metaKey,
        altKey: !!opts.altKey,
        prevented: 0,
        preventDefault() { this.prevented++; }
    };
    CP.handleKey(ev);
    return ev;
}

// ---------------------------------------------------------------------
console.log('\n=== Typing safety: a shortcut must never fire while the user types ===');

// 1. Every text-entry element is recognised.
['input', 'textarea', 'select'].forEach(function (tag) {
    assert.strictEqual(
        CP.isTypingTarget(makeEl(tag)), true,
        'a <' + tag + '> must be treated as a typing target'
    );
});
const contentEditable = makeEl('div');
contentEditable.isContentEditable = true;
assert.strictEqual(
    CP.isTypingTarget(contentEditable), true,
    'a contenteditable element must be treated as a typing target'
);
assert.strictEqual(
    CP.isTypingTarget(makeEl('button')), false,
    'a <button> must not be treated as a typing target'
);
assert.strictEqual(CP.isTypingTarget(null), false, 'a null target must be safe');

// 2. ⚠️ "t" must NOT toggle the theme — EVER, not even on the page body.
//    There used to be a bare "t" shortcut here. It looked safe because of the
//    typing-target guard below, but that guard only sees input/textarea/select.
//    After clicking a table row or any other non-input element, focus sits on
//    THAT element, so the guard passed and the next "t" silently flipped the
//    whole app between light and dark. A modifierless letter is never worth
//    that: the theme stays reachable via Ctrl+K → "theme" and the moon button.
let themeToggles = 0;
sandbox.window.ThemeManager = { toggle: () => { themeToggles++; } };

// 2a. In a text field.
const inField = key('t', { target: makeEl('input', { placeholder: 'Search branches...' }) });
assert.strictEqual(themeToggles, 0, 'pressing "t" inside a text field must NOT toggle the theme');
assert.strictEqual(inField.prevented, 0, 'a key typed into a field must not be preventDefault-ed either');

// 2b. On the page body — the regression this guards.
const onBody = key('t');
assert.strictEqual(themeToggles, 0, 'pressing "t" anywhere, including the page body, must NOT toggle the theme');
assert.strictEqual(onBody.prevented, 0, '"t" is not ours any more, so it must not be preventDefault-ed either');
key('T');
assert.strictEqual(themeToggles, 0, 'shifted "T" must not toggle the theme either');

// 2c. The theme must still be reachable EXPLICITLY, via the palette command —
//     removing the shortcut must not remove the feature.
const themeCommand = CP.commands().find(c => c.id === 'toggle-theme');
assert(themeCommand, 'the palette must still offer a "toggle theme" command');
themeCommand.run();
assert.strictEqual(themeToggles, 1, 'the palette command must still toggle the theme');

// ---------------------------------------------------------------------
console.log('\n=== Browser and OS shortcuts are never hijacked ===');

let switchCalls = 0;
sandbox.window.switchTab = () => { switchCalls++; };

// 4. Ctrl+digit is how browsers switch tabs.
const ctrlDigit = key('3', { ctrlKey: true });
assert.strictEqual(switchCalls, 0, 'Ctrl+3 must be left to the browser (it switches browser tabs)');
assert.strictEqual(ctrlDigit.prevented, 0, 'Ctrl+3 must not be preventDefault-ed');

// 5. Alt is reserved (browser back/forward on Windows).
key('ArrowLeft', { altKey: true });
assert.strictEqual(switchCalls, 0, 'Alt+Arrow must be left to the browser');

// 6. A modified key we do not own is left alone entirely.
const ctrlC = key('c', { ctrlKey: true });
assert.strictEqual(ctrlC.prevented, 0, 'Ctrl+C must pass through untouched (copy)');

// 7. Ctrl+K IS ours, and works with no palette DOM pre-built.
const ctrlK = key('k', { ctrlKey: true });
assert.strictEqual(ctrlK.prevented, 1, 'Ctrl+K must be preventDefault-ed');
assert.strictEqual(CP.isOpen(), true, 'Ctrl+K must open the palette');
key('k', { ctrlKey: true });
assert.strictEqual(CP.isOpen(), false, 'Ctrl+K again must close it (toggle)');

// ---------------------------------------------------------------------
console.log('\n=== Fuzzy matching ===');

assert.strictEqual(CP.fuzzyMatch('Tickets Overview', 'ticket'), true, 'a substring must match');
// An ordered subsequence is what makes the palette usable without spelling
// the whole word.
assert.strictEqual(CP.fuzzyMatch('tickets', 'tkt'), true, 'an ordered subsequence must match');
// Out-of-order letters must NOT match, or every query matches everything and
// the palette is useless.
assert.strictEqual(CP.fuzzyMatch('tickets', 'ktk'), false, 'out-of-order characters must not match');
assert.strictEqual(CP.fuzzyMatch('anything', ''), true, 'an empty query must match everything (the unfiltered list)');

// ---------------------------------------------------------------------
console.log('\n=== The shortcut sheet matches the implemented shortcuts ===');

// 8. The documented list and the code must agree in BOTH directions: a
//    shortcut that works but is undocumented is a discoverability bug, and a
//    documented shortcut that does nothing is worse.
const sheet = CP.shortcuts.map(r => r[0]);
['Ctrl / Cmd + K', '1 – 8', '/', '?', 'Esc'].forEach(function (k) {
    assert(sheet.indexOf(k) > -1, 'the shortcut sheet must document ' + JSON.stringify(k));
});
assert.strictEqual(
    sheet.length, 5,
    'the sheet documents exactly the four remaining app shortcuts plus Escape'
);
// ⚠️ "T" is GONE and must stay gone: a bare letter with no modifier fired
// whenever focus was on any non-input element, flipping the app's appearance
// on an ordinary keypress. The theme is still reachable through the palette
// command and the header's moon button — both explicit.
assert.strictEqual(
    sheet.indexOf('T'), -1,
    'the shortcut sheet must NOT document a bare "T" for the theme any more'
);
assert.strictEqual(
    paletteSrc.indexOf("event.key === 't' || event.key === 'T'"), -1,
    'the bare-letter theme shortcut must not be reintroduced in the handler'
);
// Every documented row needs a description, or the sheet is a list of keys
// the user has to guess the meaning of.
CP.shortcuts.forEach(function (row) {
    assert(row[1] && typeof row[1] === 'string', 'every shortcut row needs a description: ' + row[0]);
});

// The code must actually implement each documented key.
// Match the literal source text of each implemented branch. Written as
// plain string searches because these are JS fragments (a regex here has to
// escape its own slashes and quantifiers, which is where such tests rot).
[
    ["/^[1-8]$/.test(event.key)", 'the 1-8 tab jump must be implemented'],
    ["event.key === '/'", 'the / search shortcut must be implemented'],
    ["event.key === '?'", 'the ? help shortcut must be implemented'],
    ["String(event.key).toLowerCase() === 'k'", 'Ctrl/Cmd+K must be implemented']
].forEach(function (pair) {
    assert(
        paletteSrc.indexOf(pair[0]) > -1,
        pair[1] + ' (expected to find: ' + pair[0] + ')'
    );
});

// ---------------------------------------------------------------------
console.log('\n=== Accessibility wiring (static) ===');

// 9. A real dialog for screen readers.
assert(/setAttribute\('role', 'dialog'\)/.test(paletteSrc), 'the palette must set role="dialog"');
assert(/setAttribute\('aria-modal', 'true'\)/.test(paletteSrc), 'the palette must set aria-modal="true"');
// Combobox pattern: selection moves via aria-activedescendant so arrow keys
// never move DOM focus out of the text field.
assert(/setAttribute\('role', 'combobox'\)/.test(paletteSrc), 'the search field must be a combobox');
assert(/setAttribute\('role', 'listbox'\)/.test(paletteSrc), 'the results must be a listbox');
assert(
    paletteSrc.indexOf("role=\"option\"") > -1,
    'each result must be a listbox option'
);
assert(/aria-activedescendant/.test(paletteSrc), 'the active option must be published via aria-activedescendant');

// 10. Focus is restored on close, so a keyboard user is not dumped at the top
//     of the document every time they open the palette.
assert(
    /state\.lastFocus = document\.activeElement/.test(paletteSrc),
    'the palette must remember what had focus'
);
assert(/back\.focus\(\)/.test(paletteSrc), 'the palette must restore focus on close');

// ---------------------------------------------------------------------
console.log('\n=== XSS: rendered labels are escaped ===');

// 11. The palette builds HTML by string concatenation, so a raw label must
//     never reach the markup. Some labels carry user data.
assert(/esc\(cmd\.label\)/.test(paletteSrc), 'the label must be escaped with esc()');
assert(/esc\(cmd\.icon\)/.test(paletteSrc), 'the icon class must be escaped (it goes into an attribute)');
assert(/esc\(cmd\.hint\)/.test(paletteSrc), 'the hint must be escaped');
assert(/esc\(cmd\.group\)/.test(paletteSrc), 'the group heading must be escaped');

// 12. The fallback escaper must assign via textContent rather than
//     regex-replacing angle brackets, which is how hand-rolled escapers miss
//     quote-breaking payloads.
const escaper = paletteSrc.slice(
    paletteSrc.indexOf('function escapeText'),
    paletteSrc.indexOf('// Reuse the page')
);
assert(
    /textContent\s*=/.test(escaper) && /innerHTML/.test(escaper),
    'the fallback escaper must assign via textContent and read innerHTML'
);

// ---------------------------------------------------------------------
console.log('\n=== Role gating: never offer a command the user cannot run ===');

// 13. Commands come from VISIBLE nav items only. The admin nav items ship
//     with display:none and are revealed only for a superadmin, so a hidden
//     item must produce no command at all.
{
    const visibleItem = makeEl('button', { className: 'nav-item' });
    visibleItem.setAttribute('data-tab', 'tickets');
    const visibleLabel = makeEl('span');
    visibleLabel.textContent = 'Tickets';
    visibleItem.appendChild(visibleLabel);

    const hiddenItem = makeEl('button', { className: 'nav-item', display: 'none' });
    hiddenItem.setAttribute('data-tab', 'approvals');
    const hiddenLabel = makeEl('span');
    hiddenLabel.textContent = 'Ticket Reviews';
    hiddenItem.appendChild(hiddenLabel);

    document.querySelectorAll = (sel) => (sel === '.nav-item[data-tab]' ? [visibleItem, hiddenItem] : []);

    const ids = CP.commands().map(c => c.id);
    assert(ids.indexOf('nav:tickets') > -1, 'a visible tab must produce a command');
    assert(
        ids.indexOf('nav:approvals') === -1,
        'a display:none (superadmin-only) tab must NOT be offered to other roles'
    );
    // Always-present commands, so the palette is never empty — even on the
    // owner dashboard, which has no sidebar at all.
    assert(ids.indexOf('toggle-theme') > -1, 'the theme toggle must always be offered');
    assert(ids.indexOf('shortcuts') > -1, 'the shortcut sheet must always be offered');
}

// 14. Every command carries the fields the renderer depends on.
{
    document.querySelectorAll = () => [];
    const cmds = CP.commands();
    assert(cmds.length > 0, 'the palette must never be empty');
    cmds.forEach(function (cmd) {
        assert(cmd.label && typeof cmd.label === 'string', 'every command needs a label');
        assert(cmd.group && typeof cmd.group === 'string', 'every command needs a group');
        assert(typeof cmd.run === 'function', 'every command needs a run()');
        assert(cmd.keywords && typeof cmd.keywords === 'string', 'every command needs search keywords');
    });
}

// ---------------------------------------------------------------------
console.log('\n=== Motion, theming and wiring (static) ===');

// 15. The palette must honour prefers-reduced-motion.
assert(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?cmd-palette-container/.test(styleCss),
    'the palette must honour prefers-reduced-motion'
);

// 16. It reuses the shared modal layer, so it inherits light/dark for free
//     rather than hardcoding colours — the exact bug owner-dark-mode.test.js
//     guards against elsewhere in this app.
assert(
    /\.cmd-palette-overlay\s*\{[^}]*z-index/.test(styleCss),
    'the palette must sit above the standard modal layer'
);
const paletteCss = styleCss.slice(styleCss.indexOf('COMMAND PALETTE + SHORTCUT SHEET'));
const hexInPalette = paletteCss.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
assert.strictEqual(
    hexInPalette.length, 0,
    'the palette CSS must not hardcode any hex colour — it must use theme variables. Found: ' + hexInPalette.join(', ')
);

// 17. The script is loaded, and loaded AFTER script.js — it references
//     window.switchTab and window.escapeHTML, which script.js defines.
//     (It is deliberately not the *last* script: js/onboarding.js follows it
//     and calls into the palette.)
const palettePos = mainHtml.indexOf('js/command-palette.js');
assert(palettePos > -1, 'js/command-palette.js must be loaded on main.html');
assert(
    palettePos > mainHtml.indexOf('<script src="script.js?v='),
    'js/command-palette.js must load AFTER script.js, which defines switchTab and escapeHTML'
);
assert(
    palettePos < mainHtml.indexOf('</body>'),
    'js/command-palette.js must be loaded before </body>'
);
assert(
    /js\/owner-dashboard\.js[\s\S]*js\/command-palette\.js/.test(
        fs.readFileSync(path.join(ROOT, 'ownerdashboard.html'), 'utf8')
    ),
    'the palette must also load on ownerdashboard.html, after the page script'
);

// 18. A discoverable button is injected — a shortcut nobody can find is not
//     a feature.
assert(/cmdPaletteBtn/.test(paletteSrc), 'a header button must be injected so the palette is discoverable');
assert(
    mainHtml.indexOf('class="header-actions"') > -1,
    'main.html must provide a .header-actions container for the palette button'
);

// 19. The global handler must stand down while the palette owns the keyboard,
//     otherwise typing "t" into the palette's own search box would toggle the
//     theme underneath it.
assert(
    /if \(state\.open \|\| els\.shortcutsOverlay\) return;/.test(paletteSrc),
    'the global handler must stand down while the palette owns the keyboard'
);

// 20. And it must not fire while a dialog is open behind it.
assert(
    /closest\('\.modal-overlay\.active'\)/.test(paletteSrc),
    'single-letter shortcuts must not fire while a modal is open'
);

// 22. The chat composer owns Enter/Escape. The palette uses the capture
//     phase, so it must only claim those keys while it is actually open.
assert(
    paletteSrc.indexOf("addEventListener('keydown', onKeyDown, true)") > -1,
    'the global handler must use the capture phase so it can claim keys when open'
);

// ---------------------------------------------------------------------
console.log('\n=== The .u-hidden utility must stay overridable by JS ===');

// 23. ⚠️ REGRESSION GUARD. `.u-hidden` replaced 25 inline `style="display:none"`
//     attributes on elements that script.js REVEALS with
//     `el.style.display = 'flex'` (the logout button, the admin nav items, the
//     sidebar badges). An `!important` on a class beats an inline style, so if
//     anyone ever "tidies up" .u-hidden with !important, the admin nav becomes
//     permanently invisible for a superadmin and nothing errors — it just
//     silently stops appearing. This assertion is the only thing standing
//     between that edit and a broken superadmin UI.
{
    const uHidden = styleCss.match(/\.u-hidden\s*\{[^}]*\}/);
    assert(uHidden, '.u-hidden must be defined in style.css');
    assert(
        uHidden[0].indexOf('!important') === -1,
        '.u-hidden must NOT use !important — script.js reveals these elements with ' +
        '`el.style.display = ...`, and an !important class would beat that inline ' +
        'override and leave the admin nav permanently hidden. Found: ' + uHidden[0]
    );
    assert(
        /display:\s*none/.test(uHidden[0]),
        '.u-hidden must set display:none (it is the extracted inline display:none)'
    );
}

// 24. And the elements that relied on it really were converted, so the guard
//     above is testing something real rather than an unused class.
const uHiddenUses = (mainHtml.match(/u-hidden/g) || []).length;
assert(
    uHiddenUses >= 20,
    'the .u-hidden utility should replace the ~25 inline display:none declarations (found ' + uHiddenUses + ')'
);

// 25. No duplicate class attributes were introduced by the extraction. Two
//     `class="..."` on one tag means the second is silently ignored by every
//     browser, which would hide styling rather than throw.
assert.strictEqual(
    (mainHtml.match(/<[a-zA-Z][^>]*\sclass="[^"]*"[^>]*\sclass="/g) || []).length,
    0,
    'an element with two class attributes silently loses the second one'
);

// 26. ⚠️ REGRESSION GUARD for the "Report Violation" header button.
{
    const scriptJs = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
    const btn = mainHtml.match(/<button[^>]*id="btnNewViolation"[^>]*>/);
    assert(btn, 'the Report Violation button must exist in main.html');
    assert(
        /class="[^"]*u-hidden[^"]*"/.test(btn[0]),
        'the Report Violation button is expected to ship hidden with .u-hidden — ' +
        'if this now starts visible, the guard below needs revisiting. Found: ' + btn[0]
    );

    // The real bug: switchTab() revealed it with `style.display = ''`, which only
    // REMOVES the inline style and hands control back to `.u-hidden{display:none}`
    // — so the button stayed invisible on the very tab that needs it. The reveal
    // must assign a real display value that overrides the class.
    const reveal = scriptJs.match(/btnNewViolation\.style\.display\s*=\s*([^;]+);/);
    assert(reveal, 'switchTab() must set an inline display on btnNewViolation');
    assert(
        /'inline-flex'/.test(reveal[1]) && /'none'/.test(reveal[1]),
        'the Report Violation button must be revealed with a real display value ' +
        "(.btn is display:inline-flex), never '' — an empty string just removes the " +
        'inline style and .u-hidden hides it again. Found: ' + reveal[1].trim()
    );

    // The command palette gates its "Report a violation" command on the button
    // being visible, so the same bug silently removed that command too.
    const paletteGate = paletteSrc.match(/var newViolation[\s\S]{0,120}?visible\(newViolation\)/);
    assert(paletteGate, 'the palette must offer the violation command when the button is visible');
}

console.log('\nOK: command palette + shortcuts tests passed (typing safety, no browser hijacking, fuzzy match, role gating, a11y wiring, XSS escaping, reduced motion, script order, .u-hidden overridability).');
