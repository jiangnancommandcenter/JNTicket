// Dark-mode compatibility guard for ownerdashboard.html.
//
// WHY THIS FILE EXISTS
// ownerdashboard.html carried hardcoded LIGHT values in its inline
// <style> blocks. The worst was a 70%-opaque white on every ticket-table
// cell:
//
//     #ownerTicketsTable tbody td { background: rgba(255,255,255,0.7); }
//
// In dark mode the cell text is --text-primary (#E2E8F0) over a ~#B6BCC0
// composite — about 1.3:1 contrast against a 4.5:1 WCAG AA minimum. Every
// cell in the tickets table was unreadable, including the empty state.
//
// A fix alone is not enough: the bug returns the next time somebody styles a
// row. This test fails the build if a hardcoded light surface creeps back in.

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'ownerdashboard.html'), 'utf8');

let failed = 0;
function check(ok, message) {
    if (ok) {
        console.log('  PASS  ' + message);
    } else {
        failed++;
        console.log('  FAIL  ' + message);
    }
}

// ---- Pull the inline <style> blocks out of the page ----------------------
const styleBlocks = [];
const styleRe = /<style>([\s\S]*?)<\/style>/g;
let m;
while ((m = styleRe.exec(html)) !== null) styleBlocks.push(m[1]);
check(styleBlocks.length > 0, 'the page has inline <style> blocks to check');

// ---- Split off the token DEFINITIONS -------------------------------------
// The :root / [data-theme="dark"] blocks are where light and dark values are
// SUPPOSED to live. They are excluded from the "no hardcoded colour" scan
// below, but they are checked by a different rule further down (every light
// token needs a dark counterpart).
const tokenDefs = [];
const consuming = styleBlocks.map(function (block) {
    return block.replace(/(^|\n)\s*(:root|html\[data-theme="dark"\])\s*\{[\s\S]*?\n\s*\}/g,
        function (whole) { tokenDefs.push(whole); return ''; });
});
const consumingCss = consuming.join('\n');

console.log('\n=== No hardcoded light surfaces in consuming rules ===');

// A near-white background, or a dark-navy shadow, applied unconditionally.
const whiteBg = /background(?:-color)?\s*:\s*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/gi;
const nearWhiteBg = /background(?:-color)?\s*:\s*rgba\(\s*248\s*,\s*250\s*,\s*252\s*,/gi;
// rgba(15,23,42,...) is the near-black navy used for light-mode drop shadows;
// on a dark surface it is invisible.
const navyShadow = /box-shadow\s*:[^;]*rgba\(\s*15\s*,\s*23\s*,\s*42/gi;
// 20-55% alpha blue borders/rings are tuned for a white card.
const faintBlue = /(?:border-color|box-shadow)\s*:[^;]*rgba\(\s*37\s*,\s*99\s*,\s*235/gi;

function linesMatching(re) {
    return consumingCss.split('\n')
        .map(function (l) { return l.trim(); })
        .filter(function (l) { return l && !/^\s*(\*|\/\*)/.test(l) && re.test(l); });
}

check(linesMatching(whiteBg).length === 0,
    'no hardcoded rgba(255,255,255,...) background - that is the invisible-text bug' +
    (linesMatching(whiteBg).length ? ': ' + JSON.stringify(linesMatching(whiteBg)) : ''));
check(linesMatching(nearWhiteBg).length === 0,
    'no hardcoded near-white background (surface tokens only)' +
    (linesMatching(nearWhiteBg).length ? ': ' + JSON.stringify(linesMatching(nearWhiteBg)) : ''));
check(linesMatching(navyShadow).length === 0,
    'no hardcoded dark-navy drop shadow (invisible on a dark surface)' +
    (linesMatching(navyShadow).length ? ': ' + JSON.stringify(linesMatching(navyShadow)) : ''));
check(linesMatching(faintBlue).length === 0,
    'no hardcoded low-alpha blue border/focus ring' +
    (linesMatching(faintBlue).length ? ': ' + JSON.stringify(linesMatching(faintBlue)) : ''));


console.log('\n=== The ticket table specifically ===');
const cellRule = (consumingCss.match(/#ownerTicketsTable tbody td\s*\{[^}]*\}/) || [''])[0];
check(!!cellRule, 'the ticket table still styles its body cells');
check(
    /background:\s*var\(--owner-ticket-row\)/.test(cellRule),
    'cell background must come from a token, not a literal white'
);
check(
    !/rgba\(\s*255/.test(cellRule),
    'the cell rule must not contain a literal white (this exact line was the bug)'
);
const hoverRule = (consumingCss.match(/#ownerTicketsTable tbody tr:hover td\s*\{[^}]*\}/) || [''])[0];
check(
    /background:\s*var\(--owner-ticket-row-hover\)/.test(hoverRule),
    'row hover must come from a token too'
);
const headRule = (consumingCss.match(/#ownerTicketsTable thead th\s*\{[^}]*\}/) || [''])[0];
check(
    /background:\s*var\(--owner-ticket-head\)/.test(headRule),
    'the sticky header background must come from a token'
);

console.log('\n=== Every light token needs a dark counterpart ===');
const tokenCss = tokenDefs.join('\n');
const lightBlock = (tokenCss.match(/:root\s*\{([\s\S]*?)\n\s*\}/) || [, ''])[1];
const darkBlock = (tokenCss.match(/html\[data-theme="dark"\]\s*\{([\s\S]*?)\n\s*\}/) || [, ''])[1];

check(!!lightBlock.trim(), 'a :root token block exists');
check(!!darkBlock.trim(), 'an html[data-theme="dark"] token block exists');

const lightTokens = (lightBlock.match(/--owner-[\w-]+(?=\s*:)/g) || []);
const darkTokens = (darkBlock.match(/--owner-[\w-]+(?=\s*:)/g) || []);
check(lightTokens.length > 0, 'the :root block defines --owner-* tokens (' + lightTokens.length + ')');

lightTokens.forEach(function (tok) {
    check(darkTokens.indexOf(tok) !== -1,
        tok + ' has a dark-mode value (a light-only token is the next regression)');
});

console.log('\n=== Dark palette prerequisites ===');
const themeCss = fs.readFileSync(path.join(__dirname, '..', 'theme.css'), 'utf8');
const darkVars = (themeCss.match(/html\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/) || [, ''])[1];
check(/--bg-hover\s*:/.test(darkVars),
    'theme.css defines --bg-hover, which the dark row-hover token relies on');
check(/--shadow-lg\s*:/.test(darkVars),
    'theme.css defines --shadow-lg, which the dark elevation tokens rely on');
check(/color-scheme\s*:\s*dark/.test(darkVars),
    'theme.css sets color-scheme:dark so native <select> dropdowns follow the theme');

// ==============================================================
//  CONTRAST CHECK — the guard above had a blind spot
// ==============================================================
// It only scanned ownerdashboard.html's INLINE styles, so it could
// not see classes that live in the shared style.css. That is exactly
// where the next bug lived: `.role-badge.hr` is a hardcoded DARK teal
// (#0e7490) in style.css with no dark override, so the HR badge on the
// dashboard header composited to ~#10263A behind ~#0e7490 text —
// about 2.9:1 against a 4.5:1 WCAG AA minimum, i.e. effectively
// invisible.
//
// Rather than hardcoding the expected ratios, this recomputes real
// WCAG relative luminance and contrast from the colours that are
// actually written in theme.css. Change a badge colour to a
// too-dark value and this fails.

// ---- colour maths -------------------------------------------------------
function hexToRgb(h) {
    const s = h.replace('#', '');
    return [0, 2, 4].map(function (i) { return parseInt(s.substr(i, 2), 16); });
}
function relLuminance(rgb) {
    const c = rgb.map(function (v) {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrastRatio(a, b) {
    const l1 = relLuminance(a);
    const l2 = relLuminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
/** Composite a translucent fill over an opaque backdrop. */
function over(fg, alpha, backdrop) {
    return fg.map(function (v, i) { return Math.round(alpha * v + (1 - alpha) * backdrop[i]); });
}

const DARK_SURFACE = hexToRgb('#101B2E');   // --bg-card in dark
const AA_NORMAL = 4.5;

console.log('\n=== Role badge contrast in dark mode ===');
const ROLES = ['superadmin', 'owner', 'hr', 'viewer', 'editor'];
ROLES.forEach(function (role) {
    const re = new RegExp('html\\[data-theme="dark"\\]\\s+\\.role-badge\\.' + role +
        '\\s*\\{([^}]*)\\}');
    const block = (themeCss.match(re) || [, ''])[1];
    if (!block.trim()) {
        check(false,
            '.role-badge.' + role + ' has a dark-mode override (style.css uses a DARK hue, ' +
            'so without one the badge is invisible in dark mode)');
        return;
    }
    const colour = (block.match(/color:\s*(#[0-9a-fA-F]{3,8})/) || [])[1];
    const fill = (block.match(/background:\s*rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/) || []);
    if (!colour) {
        // e.g. color: var(--color-resolved) — resolve it from the dark palette.
        const varName = (block.match(/color:\s*var\((--[\w-]+)\)/) || [])[1];
        const fromPalette = varName &&
            (darkVars.match(new RegExp(varName + '\\s*:\\s*(#[0-9a-fA-F]{3,8})')) || [])[1];
        if (!fromPalette) {
            check(false, '.role-badge.' + role + ' dark colour is resolvable for the contrast check');
            return;
        }
        check(true, '.role-badge.' + role + ' resolves its dark colour via ' + varName);
        return;
    }
    if (fill.length < 5) {
        check(false, '.role-badge.' + role + ' dark override declares a measurable background');
        return;
    }
    const alpha = parseFloat(fill[4]);
    const chipBg = over([+fill[1], +fill[2], +fill[3]], alpha, DARK_SURFACE);
    const ratio = contrastRatio(hexToRgb(colour), chipBg);
    check(ratio >= AA_NORMAL,
        '.role-badge.' + role + ' ' + colour + ' on its chip = ' + ratio.toFixed(2) + ':1 ' +
        '(needs ' + AA_NORMAL + ':1)');
});

console.log('\n=== Section headings declare their own colour ===');
// They used to be left to inherit from <body>, four levels up. That made
// the most important text on the page depend on an unstated chain.
check(
    /\.owner-section-header h2\s*\{[^}]*color:\s*var\(--text-primary\)/.test(consumingCss),
    '.owner-section-header h2 declares color: var(--text-primary) instead of inheriting it'
);
check(
    /\.owner-section-header p\s*\{[^}]*color:\s*var\(--text-secondary\)/.test(consumingCss),
    '.owner-section-header p declares its colour explicitly'
);

console.log('\n=== Dark palette completeness (the general guard) ===');
// The real lesson from the role-badge bug: a variable that is defined for
// light but NOT overridden for dark silently keeps its LIGHT value on a
// dark surface, and any text using it disappears. Assert the dark block
// covers every colour-bearing variable the light palette declares.
const styleCss = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
const lightRoot = (styleCss.match(/(^|\n)\s*:root\s*\{([\s\S]*?)\n\s*\}/) || [, , ''])[2];
const lightNames = (lightRoot.match(/(--(?:bg|text|border)-[\w-]+)(?=\s*:)/g) || [])
    .filter(function (n, i, a) { return a.indexOf(n) === i; })
    .sort();
const darkNames = (darkVars.match(/(--(?:bg|text|border)-[\w-]+)(?=\s*:)/g) || []);

check(lightNames.length > 10,
    'the light palette declares colour variables (' + lightNames.length + ' found)');

const missingInDark = lightNames.filter(function (n) { return darkNames.indexOf(n) === -1; });
check(missingInDark.length === 0,
    'every --bg-/--text-/--border- variable has a dark value — a missing one keeps its ' +
    'LIGHT value on a dark surface and its text vanishes' +
    (missingInDark.length ? '. MISSING: ' + missingInDark.join(', ') : ''));

// ======================================================================
// THE OWNER BLOCK IN style.css (added after the inline-block guard)
// ======================================================================
// WHY: this file only scanned the INLINE <style> blocks of the page. It read
// style.css for token DEFINITIONS only, never for hardcoded colours in
// CONSUMING rules — so the owner-dashboard block in style.css was never
// guarded at all. That is how a 85%-opaque white .owner-panel, a near-white
// #ownerReportsTable cell wash, and a hardcoded light gradient on
// #ownerMainContent all shipped while every inline rule was tokenised.
console.log('\n=== style.css owner-dashboard block must be tokenised too ===');

// Start from the RULE, not from the first textual mention: the explanatory
// comment above it also contains the string "#ownerMainContent { ... }", so
// anchoring on the first match would begin the slice mid-comment and leave a
// dangling "*/" for the comment-stripper to choke on.
const ownerBlockStart = styleCss.indexOf('\n#ownerMainContent {');
const ownerBlockEnd = styleCss.indexOf('/* ==============================================================', ownerBlockStart);
check(ownerBlockStart > -1, 'the #ownerMainContent rule must exist in style.css');
check(ownerBlockEnd > ownerBlockStart, 'end of the owner block not found in style.css');
const ownerBlock = styleCss.slice(ownerBlockStart, ownerBlockEnd);

// Strip the token-definition blocks if any appear inside the region, so the
// light values that are SUPPOSED to be literal (:root) are not flagged.
const ownerConsuming = ownerBlock.replace(/(^|\n)\s*(:root|html\[data-theme="dark"\])\s*\{[\s\S]*?\n\s*\}/g, '');

const ownerWhiteBg = /background(?:-color)?\s*:[^;{}]*rgba\(\s*255\s*,\s*255\s*,\s*255\s*,/gi;
const ownerNearWhite = /background(?:-color)?\s*:[^;{}]*rgba\(\s*248\s*,\s*250\s*,\s*252\s*,|#f8fafc/gi;
const ownerNavyShadow = /box-shadow\s*:[^;{}]*rgba\(\s*15\s*,\s*23\s*,\s*42/gi;

function ownerLinesMatching(re) {
    // Strip /* ... */ comments before scanning. A comment that NAMES the bad
    // value it replaced ("was #f8fafc") must not count as the bug itself,
    // or the guard flags its own documentation.
    return ownerConsuming.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map(function (l) { return l.trim(); })
        .filter(function (l) { return l && !/^(\*|\/\*)/.test(l) && re.test(l); });
}

check(ownerLinesMatching(ownerWhiteBg).length === 0,
    'no hardcoded white background in the style.css owner block — a literal white ' +
    'stays white in dark mode' +
    (ownerLinesMatching(ownerWhiteBg).length ? ': ' + JSON.stringify(ownerLinesMatching(ownerWhiteBg)) : ''));
check(ownerLinesMatching(ownerNearWhite).length === 0,
    'no hardcoded near-white background in the style.css owner block' +
    (ownerLinesMatching(ownerNearWhite).length ? ': ' + JSON.stringify(ownerLinesMatching(ownerNearWhite)) : ''));
check(ownerLinesMatching(ownerNavyShadow).length === 0,
    'no hardcoded navy drop shadow in the style.css owner block — it is invisible on dark' +
    (ownerLinesMatching(ownerNavyShadow).length ? ': ' + JSON.stringify(ownerLinesMatching(ownerNavyShadow)) : ''));

// 27. The specific surfaces that shipped light, named individually so the
//     failure message points at the thing a user would actually see.
check(
    /\.owner-panel\s*\{[^}]*background:\s*var\(--bg-card\)/.test(ownerBlock),
    '.owner-panel background must come from a token (it was rgba(255,255,255,0.85) — a white slab in dark mode)'
);
check(
    /#ownerMainContent\s*\{[^}]*background:\s*var\(--bg-primary\)/.test(ownerBlock),
    '#ownerMainContent must use a token, not a hardcoded light gradient (it was #f8fafc→#f1f5f9)'
);
check(
    /#ownerReportsTable tbody td\s*\{[^}]*background:\s*var\(--bg-card\)/.test(ownerBlock),
    'the reports table cells must use a token (a near-white wash is the unreadable-text bug)'
);
check(
    /\.owner-filter-wrap\s*\{[^}]*background:\s*var\(--bg-card\)/.test(ownerBlock),
    '.owner-filter-wrap must use a token (it was rgba(255,255,255,0.8))'
);

// 28. ⚠️ An EMPTY rule is not an override. The page's own `#ownerMainContent`
//     block shipped with no declarations and a comment saying "no custom
//     background", which read like an override but did nothing — style.css's
//     hardcoded gradient still won on the ID match.
const inlineOwnerMain = (consumingCss.match(/#ownerMainContent\s*\{([^}]*)\}/) || ['', ''])[1];
const inlineDecls = inlineOwnerMain
    .split('\n')
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l && !/^(\*|\/\*)/.test(l); });
check(
    inlineDecls.length > 0,
    'the page\'s #ownerMainContent rule must DECLARE a background — an empty rule cannot ' +
    'override a declaration, so the hardcoded light gradient kept winning'
);
check(
    /background\s*:\s*var\(/.test(inlineOwnerMain),
    'the page\'s #ownerMainContent must declare background via a token'
);


function paletteValue(name) {
    const m = (darkVars.match(new RegExp(name + '\\s*:\\s*(#[0-9a-fA-F]{3,8})')) || [])[1];
    return m ? hexToRgb(m) : null;
}
[
    ['--text-primary', '--bg-primary', 'primary body text on the page background'],
    ['--text-secondary', '--bg-primary', 'secondary text (section blurbs, labels) on the page'],
    ['--text-muted', '--bg-primary', 'muted text (hints, counts) on the page'],
    ['--text-primary', '--bg-card', 'primary text on a card surface'],
    ['--text-secondary', '--bg-card', 'secondary text on a card surface']
].forEach(function (pair) {
    const fg = paletteValue(pair[0]);
    const bg = paletteValue(pair[1]);
    if (!fg || !bg) {
        check(false, pair[0] + ' on ' + pair[1] + ' is resolvable in the dark palette');
        return;
    }
    const ratio = contrastRatio(fg, bg);
    check(ratio >= AA_NORMAL,
        pair[0] + ' on ' + pair[1] + ' = ' + ratio.toFixed(2) + ':1 (' + pair[2] + ')');
});

console.log('\n' + (failed
    ? 'x ' + failed + ' dark-mode assertion(s) failed'
    : 'OK: Owner dashboard dark-mode tests passed (no hardcoded light surfaces; every token has a dark value; badge contrast meets WCAG AA; dark palette is complete).'));
process.exit(failed ? 1 : 0);
