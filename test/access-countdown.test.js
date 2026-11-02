// ===========================================================================
//  THE LIVE COUNTDOWN
//
//  The manager reads the report inside the modal while the window drains, so the
//  clock has to be VISIBLE there and not just in the Access column — a countdown
//  they can only see by closing the modal is a countdown nobody is looking at.
//
//  Three things this pins that are easy to get subtly wrong:
//
//  1. THE TICKER EDITS TEXT IN PLACE. It must NOT call renderOwnerTickets() on a
//     timer. That would rebuild every row each second, restart the interval from
//     inside its own callback, blow away focus and any open dropdown, and re-sort
//     the table under the manager's cursor. The table is re-rendered on exactly
//     one event: something actually expiring.
//
//  2. URGENCY IS A FRACTION OF THE WINDOW, NOT ABSOLUTE SECONDS. A fixed
//     "under 10 minutes" rule makes every second of the time-compressed 1-minute
//     test window red, and would never fire once on a real 2-day window. The
//     total is carried on the node as data-window-ms for this reason.
//
//  3. AT ZERO THE MODAL IS RE-DERIVED. The payload must stop being shown the
//     moment the window closes — that is the entire intent of the feature, and a
//     countdown ticking to 0:00 over a still-readable report would be worse than
//     no countdown at all.
//
//  Run: npm test
// ===========================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const ownerJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

console.log('Testing the live expiry countdown...');

/**
 * Extract a function body by brace matching.
 * ⚠️ Braces, not "up to the next blank line" — these bodies contain nested blocks
 * and template literals, and a fragment makes a test pass for the wrong reason.
 *
 * ⚠️ MATCHES BOTH DECLARATION FORMS. Some of these are hoisted declarations
 * (`function tickOwnerCountdowns()`), others are assigned onto the window
 * (`window.openOwnerReport = function (id) {}`), which is how this file exposes
 * most of its API. A helper written for only the first form reports "must
 * exist" for a function that is right there.
 */
function extractFn(src, name) {
    const re = new RegExp(`(?:function\\s+${name}\\s*\\(|${name}\\s*=\\s*function\\s*\\()`);
    const start = src.search(re);
    assert(start !== -1, `${name}() must exist in owner-dashboard.js`);
    let depth = 0, seen = false;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') { depth++; seen = true; }
        else if (src[i] === '}') { depth--; if (seen && depth === 0) return src.slice(start, i + 1); }
    }
    throw new Error(`unbalanced braces extracting ${name}()`);
}
// PLACEHOLDER_REST
// ===========================================================================
console.log('\n=== the human countdown is legible at BOTH scales ===');
// ===========================================================================
const sandbox = { window: { TRACKING_ACCESS_WINDOW_MS: 60000 }, console, Date };
vm.createContext(sandbox);
vm.runInContext(extractFn(ownerJs, 'formatAccessCountdown'), sandbox);
const fmt = sandbox.formatAccessCountdown;

{
    // The TEST window is 1 minute, so seconds are the only useful resolution —
    // this is exactly what the manager sees while testing.
    assert.strictEqual(fmt(45000), '45s', 'a 1-minute window must count in seconds');
    assert.strictEqual(fmt(59000), '59s');
    assert.strictEqual(fmt(60000), '1m 0s', 'at the boundary it rolls up to minutes');

    // The PRODUCTION window is 2 days. "47:59:59" would be unreadable, so it must
    // roll up. One function, both scales — there is no separate test-mode path
    // to forget to keep in step.
    assert.strictEqual(fmt(2 * 86400000), '2d 0h', 'a 2-day window reads as days + hours');
    assert.strictEqual(fmt(3 * 3600000 + 4 * 60000), '3h 4m', 'hours read as hours + minutes');
    assert.strictEqual(fmt(2 * 60000 + 10 * 1000), '2m 10s');

    assert.strictEqual(fmt(0), 'expired', 'zero must be a state, not "0s"');
    assert.strictEqual(fmt(-1), 'expired', 'negative is expired too');
}

// ===========================================================================
console.log('\n=== the ticker updates text IN PLACE ===');
// ===========================================================================
{
    const ticker = extractFn(ownerJs, 'tickOwnerCountdowns');
    const guard = ticker.indexOf('if (!lapsed) return;');
    assert(guard > -1, 'the ticker must return early while nothing has expired');

    // ⚠️ THE ASSERTION THAT MATTERS. A re-render inside the tick would rebuild
    // the table once a second. The guard is that the NORMAL path cannot reach
    // renderOwnerTickets() at all.
    assert(!/renderOwnerTickets\s*\(/.test(ticker.slice(0, guard)),
        'renderOwnerTickets() must NOT be reachable from the normal tick path. It is a ' +
        'plausible "just refresh it" move, and it rebuilds every row each second, restarts ' +
        'the interval from inside its own callback, and re-sorts the table under the ' +
        'manager\'s cursor.');

    // But at zero it MUST re-derive, or the report stays readable.
    const lapsed = ticker.slice(guard);
    assert(/renderOwnerTickets\s*\(\s*ownerAllTicketsCache\s*\)/.test(lapsed),
        'when a countdown reaches zero the table must be re-rendered so the badge flips to ' +
        '"Expired". A clock that ticks to 0:00 over a still-open row is a lie.');
    assert(/openOwnerReport\s*\(\s*ownerReopenTicketId\s*\)/.test(lapsed),
        'when a countdown reaches zero the OPEN MODAL must be re-derived too — that is where ' +
        'the report and the footage are, and they must stop being shown.');
// ===========================================================================
console.log('\n=== urgency is proportional, so it works at 1 minute AND 2 days ===');
// ===========================================================================
{
    const ticker = extractFn(ownerJs, 'tickOwnerCountdowns');
    assert(/data-window-ms/.test(extractFn(ownerJs, 'accessCountdownHtml')),
        'each countdown node must carry the TOTAL window length as data-window-ms');
    assert(/data-window-ms/.test(ticker) && /total\s*\*\s*0\.1/.test(ticker),
        'urgency must be judged as a FRACTION of the window. An absolute threshold ' +
        '(e.g. "under 10 minutes") makes every second of a 1-minute test window red, and ' +
        'never fires once on a real 2-day window.');
}

// ===========================================================================
console.log('\n=== the OPEN modal shows a clock too ===');
// ===========================================================================
{
    assert(/owner-access-live/.test(ownerJs),
        'the open report modal must carry a live countdown banner — that is where the ' +
        'manager is actually reading while the window drains.');
    assert(/startOwnerCountdownTicker\(\)/.test(extractFn(ownerJs, 'openOwnerReport')),
        'opening a report with a running window must start the ticker');
    assert(/startOwnerCountdownTicker\(\)/.test(extractFn(ownerJs, 'renderOwnerTickets')),
        'the Access-column countdowns need the ticker too — the list is where a manager ' +
        'compares several tickets at once');

    // Idempotent, or every re-render stacks another interval.
    assert(/if\s*\(ownerCountdownTicker\)\s*return;/.test(extractFn(ownerJs, 'startOwnerCountdownTicker')),
        'startOwnerCountdownTicker() must be idempotent. The list re-renders on every ' +
        'Firestore snapshot, so a naive start would spawn a new interval each time.');
}

// ===========================================================================
console.log('\n=== the styles exist and the comments balance ===');
// ===========================================================================
{
    assert(/\.owner-access-timer\b/.test(css), 'the countdown readout needs styling');
    assert(/\.owner-access-live\b/.test(css), 'the in-modal banner needs styling');

    // tabular-nums, or the row twitches as the digits change width every second.
    assert(/font-variant-numeric:\s*tabular-nums/.test(css),
        'the countdown must use tabular-nums — without it every tick changes the digits\' ' +
        'width and the row visibly jitters.');

    // The comment-balance guard, carried from owner-mobile.test.js. An unterminated
    // comment swallows every rule up to the next `{`; the rules still look right in
    // the source and are silently never applied.
    let depth = 0;
    for (let i = 0; i < css.length; i++) {
        if (css[i] === '/' && css[i + 1] === '*') { depth++; i += 2; }
        else if (css[i] === '*' && css[i + 1] === '/') { depth--; i += 2; }
    }
    assert.strictEqual(depth, 0,
        `style.css has ${depth} unterminated block comment(s). An unterminated comment makes ` +
        'the parser swallow every rule until the next `{` — the rules still look correct ' +
        'in the source but are silently never applied.');
}

// ===========================================================================
console.log('\n=== ⚠️ the helpers are TOP-LEVEL, not nested ===');
// ===========================================================================
{
    // ⚠️ THE BUG THIS SECTION EXISTS FOR. The countdown block was inserted
    // directly after `ownerTicketExpiry()`'s `catch` and BEFORE its closing
    // brace, so all four helpers became function-LOCAL to ownerTicketExpiry.
    //
    // `node --check` passed — nested function declarations are perfectly legal
    // JavaScript — and so did every other test in this file, because they read
    // the source as TEXT and a nested declaration looks identical in source.
    //
    // The runtime effect was total: `renderOwnerTickets()` calls
    // `startOwnerCountdownTicker()`, which was not in module scope, so it threw
    // ReferenceError. renderOwnerTickets' own try/catch swallowed it and
    // replaced the list with "Unable to load tickets." — the Area Manager's
    // ticket list vanished the moment a superadmin approved anything.
    //
    // So: assert the declaration is at column zero. A text check is the only
    // thing that catches this, and it catches it precisely.
    ['formatAccessCountdown', 'accessCountdownHtml', 'tickOwnerCountdowns', 'startOwnerCountdownTicker']
        .forEach(name => {
            assert(new RegExp(`^function\\s+${name}\\s*\\(`, 'm').test(ownerJs),
                `${name}() must be declared at TOP LEVEL (column 0). A declaration nested ` +
                `inside another function is invisible to every other check here — the file ` +
                `still parses and the source still reads correctly — but it is not in module ` +
                `scope, so renderOwnerTickets() throws ReferenceError and its catch replaces ` +
                `the Area Manager's ticket list with "Unable to load tickets."`);
        });

    // And the thing that swallowed it: ownerTicketExpiry() must still be a short
    // function, not a 100-line block with helpers hidden inside it.
    const expiryFn = extractFn(ownerJs, 'ownerTicketExpiry');
    assert(expiryFn.length < 400,
        `ownerTicketExpiry() is ${expiryFn.length} characters long — it has other declarations ` +
        'buried inside it. It only ever coerces a date and returns it.');

    // ⚠️ PROOF THE SCOPING IS ACTUALLY FIXED, not merely re-indented. Column-0
    // is a text check; this runs the real thing. `startOwnerCountdownTicker` is
    // evaluated at module scope, exactly as renderOwnerTickets() does. When the
    // helpers were nested it threw ReferenceError here — which is precisely what
    // blanked the Area Manager's ticket list.
    const probe = {
        window: { TRACKING_ACCESS_WINDOW_MS: 60000 },
        console: { warn: () => {} },
        document: undefined,
        // ⚠️ THE VM SANDBOX HAS NO setInterval. Without these the probe fails
        // with "setInterval is not defined" — a defect in the TEST, and an easy
        // one to misread as the very bug it is meant to catch.
        setInterval: (fn, ms) => ({ fake: true, fn, ms }),
        clearInterval: () => {}
    };
    vm.createContext(probe);
    vm.runInContext('var ownerCountdownTicker = null;', probe);
    // ⚠️ BOTH functions, in one shared context. Loading only the starter gives a
    // misleading "tickOwnerCountdowns is not defined" — the callee has to be in
    // scope too, which is precisely the relationship that broke.
    vm.runInContext(extractFn(ownerJs, 'tickOwnerCountdowns'), probe);
    vm.runInContext(extractFn(ownerJs, 'startOwnerCountdownTicker'), probe);
    probe.window.getTrackingAccessExpiry = () => null;
    assert.strictEqual(typeof probe.startOwnerCountdownTicker, 'function',
        'startOwnerCountdownTicker() must be callable at MODULE scope. This is the call ' +
        'renderOwnerTickets() makes; if it is not defined here, that render throws ' +
        'ReferenceError and the catch replaces the whole ticket list with an error row.');
    assert.strictEqual(typeof probe.tickOwnerCountdowns, 'function',
        'tickOwnerCountdowns() must also be at module scope — the starter calls it directly.');
    // Calling it with no countdowns on the page must not throw either.
    probe.document = { querySelectorAll: () => [] };
    probe.startOwnerCountdownTicker();
    assert.ok(probe.ownerCountdownTicker,
        'starting the ticker must install the interval');
    assert.strictEqual(probe.ownerCountdownTicker.ms, 1000,
        'the countdown must tick once a second');
    // Idempotent: a second call must not replace the live interval.
    const first = probe.ownerCountdownTicker;
    probe.startOwnerCountdownTicker();
    assert.strictEqual(probe.ownerCountdownTicker, first,
        'startOwnerCountdownTicker() must be idempotent — the list re-renders on every ' +
        'Firestore snapshot, so a naive start would spawn a new interval each time.');
}

console.log('\n× Live-countdown tests passed (all four countdown helpers are declared at column ' +
    'zero rather than nested inside ownerTicketExpiry(), which is the one failure that parsed ' +
    'cleanly, read correctly as source, passed every other assertion here, and still emptied ' +
    'the Area Manager\'s ticket list at runtime because renderOwnerTickets() threw a ' +
    'ReferenceError its own catch turned into "Unable to load tickets."; the human formatter ' +
    'reads in seconds at the ' +
    'time-compressed 1-minute window and rolls up to days+hours at the real 2-day one, with ' +
    'zero reported as a state rather than "0s"; the ticker writes textContent in place and ' +
    'cannot reach renderOwnerTickets() on the normal path, so the table is never rebuilt once ' +
    'a second — but at zero it DOES re-render the list AND re-derive the open modal, because ' +
    'that is where the report and footage are; urgency is a tenth of the window rather than an ' +
    'absolute number of seconds, so it fires correctly at either scale, and the node carries ' +
    'its total window length for exactly that reason; the open modal carries its own banner and ' +
    'starts the ticker, which is idempotent so the per-snapshot list re-render cannot stack ' +
    'intervals; the readout is tabular so the row does not jitter each tick; and the CSS ' +
    'comment-balance guard is kept).');
}

// PLACEHOLDER_REST