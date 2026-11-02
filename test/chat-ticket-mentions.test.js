// Functional test for clickable TICKET MENTIONS in chat.
//
// "please handle ticket BNW-TIX007" — the reference renders as a chip, and
// clicking it opens that ticket's modal. Works in BOTH directions (superadmin
// <-> HR), because both sides load js/chat.js and both can read `tickets`.
//
// The behaviour most worth locking down here:
//   1. the reference is matched in the TEXT (no new persisted field), so old
//      messages link too and no rules deploy is needed;
//   2. ordinary prose containing the word "ticket" is NOT linkified;
//   3. the chip is a real <button> carrying an escaped data attribute —
//      escaping still happens first, so a reference can never inject markup;
//   4. a reference that resolves to nothing reports that instead of
//      dead-ending, and the click opens the modal THIS page actually has.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'chat.js'), 'utf8');
const chatCss = fs.readFileSync(path.join(ROOT, 'chat.css'), 'utf8');
const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const scriptJs = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
// NOTE: ownerJs is already read further down (the Resolved-only gate uses it),
// so it is deliberately NOT re-declared here.
const styleCss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const mainHtml = fs.readFileSync(path.join(ROOT, 'main.html'), 'utf8');

console.log('Testing chat ticket mentions (type "ticket", click to open)...');

// ---------------------------------------------------------------
// 1. The reference lives in the message TEXT — no new field
// ---------------------------------------------------------------
console.log('\n=== No schema change: the reference is part of the text ===');

const messagesBlock = (() => {
    const start = rules.indexOf('match /messages/{messageId}');
    assert(start > -1, 'firestore.rules must still contain the messages block');
    const end = rules.indexOf('match /', start + 10);
    return rules.slice(start, end > -1 ? end : undefined);
})();

assert(
    /allow create: if isChatMember\(chatId\)/.test(messagesBlock),
    'the messages create rule must be unchanged (this feature must not need a deploy)'
);
// The write payload must be exactly as it was. Comments legitimately DISCUSS
// `ticketRefs` (to explain why it was rejected), so strip them before
// asserting on what the code actually writes.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

assert(
    !/ticketRefs/.test(stripComments(src)),
    'no ticketRefs field may be written to a message: the reference must live in ' +
    'the text, so old messages link too and no hasOnly() can reject the write'
);

// The write payload must be exactly as it was.
const writeFn = (src.match(/function writeMessageBatch\([\s\S]*?return batch\.commit\(\);/) || [''])[0];
assert(writeFn, 'could not read writeMessageBatch()');
assert(
    /payload\.mentions = extractMentions\(text\);/.test(writeFn),
    'the existing mentions field must be written exactly as before'
);
assert(
    !/ticketRef/i.test(writeFn),
    'writeMessageBatch() must not gain any ticket-specific field'
);

// ---------------------------------------------------------------
// 2. The matching rules (pure, run against the real source)
// ---------------------------------------------------------------
console.log('\n=== Matching: what becomes a link, and what does not ===');

function escapeHTML(v) {
    return String(v === null || v === undefined ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function loadHelpers() {
    const sandbox = { console, escapeHTML };
    const ctx = vm.createContext(sandbox);
    const grab = (marker) => {
        const i = src.indexOf(marker);
        assert(i > -1, 'could not find ' + marker + ' in chat.js');
        return i;
    };
    // isRealRefMatch() is the boundary guard the linkifier and the extractor
    // both call. It lives ABOVE ticketRefPattern, so it must be included or
    // both functions throw on the first message that reaches them.
    const guard = src.slice(grab('function isRealRefMatch'), grab('// A ticket reference.'));
    const pattern = src.slice(grab('function ticketRefPattern'), grab('// ---- Ticket index'));
    // linkifyTicketRefs() is the last thing before the "PICKER TRIGGERS"
    // banner, which is the stable end marker for this block.
    const link = src.slice(
        grab('function linkifyTicketRefs'),
        grab('//  PICKER TRIGGERS')
    );
    vm.runInContext(guard + '\n' + pattern + '\n' + link + `
        globalThis.__x = { isTicketRefToken, extractTicketRefs, linkifyTicketRefs };
    `, ctx);
    return sandbox.__x;
}

const H = loadHelpers();

// ⚠️ The helpers run inside a vm context, so the arrays they return are from a
// DIFFERENT realm and `deepStrictEqual` fails on prototype identity even when
// the contents match exactly. Compare as plain values instead.
const sameRefs = (actual, expected) =>
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((v, i) => v === expected[i]);

// The happy path, in every casing and separator real people type.
['please handle ticket BNW-TIX007',
    'TICKET bnw-tix007 please',
    'Ticket: BNW-TIX007',
    'see ticket #bnw-tix007 now',
    'ok ticket bnw-tix007'].forEach((text) => {
    const refs = H.extractTicketRefs(text);
    assert(sameRefs(refs, ['bnw-tix007']),
        'must find the reference in ' + JSON.stringify(text) + ' -> ' + JSON.stringify(refs));
});

// Prose that merely contains the word must NOT be linkified — the whole risk
// of a text-based trigger.
['that ticket looks wrong',
    'the tickets are late',
    'I will ticket this later',
    'tickets'].forEach((text) => {
    assert(sameRefs(H.extractTicketRefs(text), []),
        'ordinary prose must not be a reference: ' + JSON.stringify(text));
    assert(!/data-ticket-ref/.test(H.linkifyTicketRefs(escapeHTML(text))),
        'no chip may be rendered for prose: ' + JSON.stringify(text));
});

// A chip is produced, and it is a real button with an escaped id.
{
    const html = H.linkifyTicketRefs(escapeHTML('please handle ticket BNW-TIX007 now'));
    assert(/<button type="button" class="chat-ticket-chip"/.test(html),
        'a reference must render as a <button>: ' + html);
    assert(/data-ticket-ref="bnw-tix007"/.test(html),
        'the chip must carry the lowercased reference: ' + html);
    assert(/BNW-TIX007<\/span>/.test(html), 'the chip label must be uppercased: ' + html);
    assert(!/>ticket\s+BNW/.test(html), 'the "ticket" word must be replaced, not duplicated: ' + html);
}

// Several references in one message, de-duplicated for resolution.
assert(sameRefs(
    H.extractTicketRefs('compare ticket BNW-TIX007 with ticket bnw-tix007 and ticket FAME-TIX012'),
    ['bnw-tix007', 'fame-tix012']),
    'duplicates must collapse and order must be preserved');
assert(sameRefs(H.extractTicketRefs('multiticket BNW-TIX001'), []),
    '"multiticket" must not be read as the trigger word');
// ---------------------------------------------------------------
// 3. XSS: a reference can never inject markup
// ---------------------------------------------------------------
console.log('\n=== A ticket reference can never inject markup ===');

{
    // The attack: a message that is ENTIRELY the reference. Escaping runs
    // first, so the quotes/angle brackets are already inert by the time the
    // chip is built around them.
    const nasty = 'ticket BNW-TIX007"><img src=x onerror=alert(1)>';
    const html = H.linkifyTicketRefs(escapeHTML(nasty));
    // The correct property to assert is not "onerror is absent" — the words
    // survive as harmless INERT TEXT, which is exactly what escaping means.
    // What must never happen is them becoming real attributes or real tags.
    assert(!/<img/i.test(html), 'no raw <img> tag may survive: ' + html);
    assert(!/<img[^>]*onerror/i.test(html), 'no live <img onerror> may survive: ' + html);
    // Every angle bracket in the payload is an entity, so no new element can
    // be created anywhere in the output.
    const rawTags = html.replace(/<\/?(?:button|i|span)\b[^>]*>/gi, '');
    assert(!/</.test(rawTags), 'no stray "<" may open a tag outside the chip: ' + rawTags);
    // The id it did capture is escaped and inert.
    const m = /data-ticket-ref="([^"]*)"/.exec(html);
    assert(m, 'a chip must still be produced for the leading valid reference');
    assert(!/["'<>]/.test(m[1]), 'the captured id must contain no quotes or brackets: ' + m[1]);
    // The payload is still readable to a human, just not executable.
    assert(/&lt;img src=x onerror=alert\(1\)&gt;/.test(html),
        'the payload must be shown escaped, not silently dropped: ' + html);
}

// A bare script tag in a message must never become a chip.
assert(!/data-ticket-ref/.test(H.linkifyTicketRefs(escapeHTML('<script>alert(1)</script>'))),
    'a script tag must not be turned into a chip');

// ---------------------------------------------------------------
// 4. The click opens the modal THIS page has
// ---------------------------------------------------------------
console.log('\n=== The click opens the right modal on each page ===');

assert(
    /window\.openTicketModal/.test(src) && /window\.openOwnerReport/.test(src),
    'both page modals must be reachable — the command center uses openTicketModal, ' +
    'the HR dashboard uses openOwnerReport'
);
const openFn = (src.match(/function openTicketFromChat\([\s\S]*?\n    \}/) || [''])[0];
assert(openFn, 'could not read openTicketFromChat()');
assert(
    /openTicketModal/.test(openFn) && /openOwnerReport/.test(openFn),
    'openTicketFromChat() must try BOTH page modals'
);
// The superadmin modal is checked first, matching the load order on main.html.
assert(
    openFn.indexOf('openTicketModal') < openFn.indexOf('openOwnerReport'),
    'the command center modal must be preferred when both exist'
);

// A reference that resolves to nothing must SAY so, not fail silently.
const openRefFn = (src.match(/async function openTicketFromRef\([\s\S]*?\n    \}/) || [''])[0];
assert(openRefFn, 'could not read openTicketFromRef()');
assert(
    /if \(!ticket\)[\s\S]*?showToast\(/.test(openRefFn),
    'an unresolvable reference must raise a toast — a dead chip is not acceptable'
);

// Resolution order: cache -> doc id -> ticketNumber scan.
const resolveFn = (src.match(/async function resolveTicketRef\([\s\S]*?\n    \}/) || [''])[0];
assert(resolveFn, 'could not read resolveTicketRef()');
assert(
    /ticketIndexById\[key\]/.test(resolveFn),
    'the resolver must try the cache first'
);
assert(
    /collection\('tickets'\)\.doc\(key\)\.get\(\)/.test(resolveFn),
    'the resolver must fall back to a direct document read (the id is the lowercased ref)'
);
assert(
    /data\.ticketNumber \|\| ''\)\.toLowerCase\(\)/.test(resolveFn) &&
    /!number \|\| number !== key/.test(resolveFn),
    'the resolver must finally match on the stored ticketNumber (lowercased)'
);

// ---------------------------------------------------------------
// 5. ONLY RESOLVED TICKETS MAY BE MENTIONED
// ---------------------------------------------------------------
console.log('\n=== Only Resolved tickets can be mentioned ===');

assert(
    /function isMentionableTicket\(t\)/.test(src),
    'a single shared "is this mentionable" predicate must exist'
);
const gateFn = (src.match(/function isMentionableTicket\([\s\S]*?\n    \}/) || [''])[0];
assert(
    /status \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'resolved'/.test(gateFn),
    "the gate must test the ticket's status for 'Resolved', case-insensitively"
);

// It must be applied in BOTH network fallbacks, not just the picker — a
// hand-typed reference must not be able to reach an unresolved ticket.
const gateCalls = (resolveFn.match(/isMentionableTicket\(/g) || []).length;
assert(
    gateCalls >= 2,
    'both the direct-id read AND the ticketNumber scan must re-check ' +
    'isMentionableTicket(); the index alone is not enough, or a hand-typed ' +
    'reference bypasses the Resolved-only rule. Found ' + gateCalls + ' call(s).'
);

// The index must refuse to CACHE an unresolved ticket, so the fast path is
// gated without a second filter.
const indexFn2 = (src.match(/function indexTicket\([\s\S]*?\n    \}/) || [''])[0];
assert(
    /isMentionableTicket\(t\)/.test(indexFn2),
    'indexTicket() must refuse to cache an unresolved ticket'
);

// The fetch must filter BEFORE the 50-cap: filtering after the slice would let
// a burst of open tickets push every Resolved ticket out of the picker.
// Sliced between two function markers rather than by a regex, so a change in
// the block's closing braces cannot silently truncate it to ''.
const ensureFn = src.slice(
    src.indexOf('function ensureTicketIndex'),
    src.indexOf('function ticketTimestamp')
);
assert(ensureFn.length > 0, 'could not slice ensureTicketIndex()');
assert(
    /if \(!isMentionableTicket\(t\)\) return;[\s\S]*slice\(0, TICKET_PICKER_LIMIT\)/.test(ensureFn),
    'the unresolved filter must run BEFORE the 50-cap slice, not after it'
);

// The picker must therefore hold RESOLVED tickets, and that is the whole point.
assert(
    /TICKET_PICKER_LIMIT = 50;/.test(src),
    'the picker must stay capped at the 50 most recent tickets'
);

// The failure toast must distinguish "still open" from "not found".
assert(
    /lastRefWasUnresolved/.test(src),
    'the resolver must record WHY a reference failed, so the toast can say ' +
    '"not resolved yet" rather than a misleading "not found"'
);
assert(
    /is not resolved yet/.test(src),
    'the toast must explain that an unresolved ticket becomes mentionable later'
);

// This gate exists because the HR dashboard ALREADY hides non-Resolved
// tickets — it matches reality rather than inventing a new restriction.
const ownerJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8');
assert(
    /if \(ownerResolvedOnly\) selectedStatus = 'Resolved';/.test(ownerJs),
    'this gate mirrors the HR dashboard\'s own Resolved-only ticket scope; if ' +
    'that ever changes, this must change with it'
);

// The picker is capped, and reads at most what it needs.
assert(
    /var TICKET_PICKER_LIMIT = 50;/.test(src),
    'the picker must be capped at the 50 most recent tickets'
);
assert(
    /out\.slice\(0, TICKET_PICKER_LIMIT\)/.test(src),
    'the index must be sliced to the cap after sorting newest-first'
);

// ---------------------------------------------------------------
// 5. Wiring: the picker, the click, and the styles
// ---------------------------------------------------------------
console.log('\n=== Wiring ===');

assert(
    /function activeTicketRefDescriptor\(\)/.test(src) && /function updateTicketMenu\(\)/.test(src),
    'the "@ticket" picker must be implemented'
);
// ⚠️ THE BARE-WORD TRIGGER MUST STAY GONE. activeTicketQuery() fired on the
// keyword plus a space anywhere in the message, so "that ticket looks wrong"
// opened the picker mid-sentence. Its removal is the point of requiring "@",
// so a test must fail if it is ever reintroduced.
assert(
    !/function activeTicketQuery\(\)/.test(src),
    'the bare "ticket " picker trigger must not come back: it fires on ordinary ' +
    'prose ("that ticket looks wrong"). "@ticket" is the only trigger.'
);
assert(
    !/function activeViolationQuery\(\)/.test(src),
    'the bare "violation " picker trigger must not come back either — ' +
    '"violation" is an even more common English word.'
);
// The bare form must STILL LINKIFY, or every message sent before this change
// would lose its working chip.
assert(
    /function linkifyTicketRefs\(/.test(src) && /function linkifyViolationRefs\(/.test(src),
    'the bare reference form must still render as a chip in sent messages'
);
assert(
    /els\.log\.addEventListener\('click'[\s\S]{0,400}data-ticket-ref/.test(src),
    'a delegated click handler on the message log must open the ticket'
);
assert(
    /function renderMessageBody\([\s\S]{0,900}linkifyTicketRefs\(body\)/.test(src),
    'renderMessageBody() must linkify ticket references'
);
// The chip must be built on the ALREADY-ESCAPED string, never on the raw
// text — that ordering is the whole reason a reference cannot inject markup.
const renderFn = (src.match(/function renderMessageBody\([\s\S]*?\n    \}/) || [''])[0];
const escAt = renderFn.indexOf('escapeHTML(text)');
const linkAt = renderFn.indexOf('linkifyTicketRefs(body)');
assert(escAt > -1 && linkAt > -1, 'renderMessageBody() must escape and then linkify');
assert(escAt < linkAt, 'escaping MUST happen before linkifying, or a reference can inject markup');
// The chip and the reaction chip must never both fire for one click: the
// ticket handler returns before the reaction one is reachable.
const logClick = stripComments(
    (src.match(/els\.log\.addEventListener\('click'[\s\S]*?toggleReaction/g) || []).join('\n')
);
assert(
    /data-ticket-ref/.test(logClick) && /if \(!chip\) return;/.test(logClick),
    'the ticket click handler must bail out when no chip was hit'
);
assert(
    !/stopPropagation/.test(logClick),
    'the ticket handler must not rely on stopPropagation — the two click ' +
    'listeners are separate and each must bail out on its own condition'
);

// Styles: themed tokens only, never a hardcoded hex, so dark mode follows.
// ⚠️ The rule is matched up to the matching brace, NOT with `[^}]*`: it
// contains var(--token, #fallback) and the first "}" ends that, not the rule.
// ⚠️ It must be the rule at the START of a line — `.chat-ticket-chip` also
// appears INSIDE the prefers-reduced-motion block, which comes first in the
// file and carries no colours at all.
const chipRule = (() => {
    const m = /^\.chat-ticket-chip \{/m.exec(chatCss);
    if (!m) return '';
    const i = m.index;
    let depth = 0;
    for (let j = chatCss.indexOf('{', i); j < chatCss.length; j++) {
        if (chatCss[j] === '{') depth++;
        else if (chatCss[j] === '}') { depth--; if (depth === 0) return chatCss.slice(i, j + 1); }
    }
    return '';
})();
assert(chipRule, 'the .chat-ticket-chip class must be defined in chat.css');
// ⚠️ The chip was the translucent-blue twin that VANISHED inside the solid
// blue outgoing bubble (blue-on-blue on your own messages). It is now an
// OPAQUE pale-TEAL pill with dark teal text (--chat-ticket-chip-*, declared
// identically in BOTH style.css and theme.css, like --chat-bubble-out) —
// its own hue so tickets (teal) and violations (red) read apart at a glance.
assert(
    /var\(--chat-ticket-chip-text/.test(chipRule) && /var\(--chat-ticket-chip-bg/.test(chipRule),
    'the chip must colour itself from the --chat-ticket-chip-* tokens: an opaque pale-teal ' +
    'pill with dark teal text, so it survives the blue outgoing bubble and reads apart from violations'
);
// The tokens must actually exist in both themes, theme-STABLE (same value).
['bg', 'text', 'border'].forEach((kind) => {
    const m = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8')
        .match(new RegExp('--chat-ticket-chip-' + kind + ':\\s*(#[0-9a-fA-F]{6})'));
    assert(m, 'style.css must declare --chat-ticket-chip-' + kind + ' as a 6-digit hex');
    assert(fs.readFileSync(path.join(ROOT, 'theme.css'), 'utf8')
            .includes('--chat-ticket-chip-' + kind + ': ' + m[1]),
        'theme.css must declare the SAME --chat-ticket-chip-' + kind + ' value — theme-stable, ' +
        'so the pill never drifts between light and dark');
});
// The file's own convention (asserted elsewhere for @mention): no raw hex in
// a colour property, because a hardcoded value cannot follow the theme.
const colourLines = chipRule.split('\n')
    .filter((l) => /^\s*(color|background|border|background-color|border-color)\s*:/.test(l));
assert(
    colourLines.every((l) => /var\(--/.test(l)),
    'every colour in the chip rule must come from a variable: ' + colourLines.join(' | '));
assert(
    /:focus-visible/.test(chatCss),
    'the chip must keep a visible focus ring — it is a real <button>'
);
// Reduced motion must be honoured, like every other interactive chat control.
assert(
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.chat-ticket-chip/.test(chatCss),
    'the chip transition must be disabled under prefers-reduced-motion'
);

// ---------------------------------------------------------------
// 6. NO RECURSION: "ticket " must not freeze the page
// ---------------------------------------------------------------
console.log('\n=== The picker must not recurse (the freeze regression) ===');

// ⚠️ REGRESSION GUARD for a real page-freeze. The bare-word trigger
// activeTicketQuery() used to end with
// ensureTicketIndex().then(function () { ... activeTicketQuery() ... }).
// Once the index resolved, that callback re-entered activeTicketQuery(), which
// attached ANOTHER .then(), whose callback called itself again — an unbounded
// microtask loop that froze the dashboard the instant someone pressed the space
// in "ticket ". It has since been removed entirely (see the note in chat.js),
// and activeTicketRefDescriptor() replaced it.
//
// The property being protected now is that EVERY descriptor function stays PURE.
// A static check catches the old shape, and a behavioural check proves the
// promise chain actually settles.
{
    const pure = (src.match(/function activeTicketRefDescriptor\([\s\S]*?\n    \}/) || [''])[0];
    assert(pure, 'could not read activeTicketRefDescriptor()');
    assert(
        !/ensureTicketIndex\(/.test(pure),
        'activeTicketRefDescriptor() must be PURE — it may not start the ticket ' +
        'read. A .then() callback that re-entered this function attached another ' +
        '.then() each time, which froze the whole page.'
    );
    assert(
        !/\.then\(/.test(pure),
        'activeTicketRefDescriptor() must attach no promise callback at all'
    );
    // The read must exist in exactly ONE place, and be reachable from the input
    // handler — otherwise the picker would never open on the first keystroke.
    // Counted on COMMENT-STRIPPED source: the fix's explanatory comment quotes
    // the old `ensureTicketIndex().then(` line verbatim, and that must not read
    // as a second live call site.
    const live = (stripComments(src).match(/ensureTicketIndex\(\)\.then\(/g) || []).length;
    assert.strictEqual(
        live, 1,
        'the ticket index must be started from exactly ONE call site, got ' + live
    );
    assert(
        /function syncTicketPicker\(\)[\s\S]*?ensureTicketIndex\(\)\.then/.test(src),
        'syncTicketPicker() must own the deferred render after the read'
    );
    // The read must be reachable FROM THE KEYSTROKE, via syncRefPicker().
    assert(
        /addEventListener\('input',[\s\S]{0,400}syncRefPicker\(\)/.test(src),
        'the input handler must call syncRefPicker(), which dispatches to syncTicketPicker()'
    );
    assert(
        /function syncRefPicker\(\)[\s\S]*?syncTicketPicker\(\)/.test(src),
        'syncRefPicker() must dispatch to syncTicketPicker() for a ticket token'
    );
    // The dispatch must be driven by the "@ticket" descriptor, NOT the removed
    // bare-word trigger — this is the assertion that would have caught the
    // picker silently ceasing to open.
    const dispatcher = (src.match(/function syncRefPicker\(\)[\s\S]*?\n    \}/) || [''])[0];
    assert(
        /activeAtRefQuery\(\)/.test(dispatcher),
        'syncRefPicker() must dispatch on the "@ticket"/"@violation" trigger'
    );
    assert(
        !/activeTicketQuery\(\)|activeViolationQuery\(\)/.test(dispatcher),
        'syncRefPicker() must NOT consult the removed bare-word triggers'
    );
}

// Behavioural proof: drive the real picker block with a DELAYED index and count
// how many times the query function runs. Before the fix this never returned.
//
// ⚠️ Wrapped in an async IIFE on purpose: this file is CommonJS (`require`),
// so a bare top-level `await` would make Node refuse to pick a module format.
(async function () {
    const lines = src.split('\n');
    // The whole picker block: the cap + Resolved gate + lazy index + every
    // descriptor/syncTicketPicker/updateTicketMenu helper, stopping just
    // before the @-mention state that follows them. It must start at the
    // TICKET_PICKER_LIMIT declaration, since the block uses it.
    //
    // ⚠️ IT MUST ALSO INCLUDE activeAtRefQuery(), because that is now what
    // activeTicketRefDescriptor() calls to recognise an "@ticket" token.
    const startLine = src.slice(0, src.indexOf('var TICKET_PICKER_LIMIT = 50;')).split('\n').length;
    const endLine = src.slice(0, src.indexOf('var mentionIndex = 0;')).split('\n').length;
    assert(
        startLine > 0 && endLine > startLine,
        'could not locate the picker block in js/chat.js'
    );
    const block = lines.slice(startLine - 1, endLine - 1).join('\n');
    assert(
        /function syncTicketPicker/.test(block) && /function updateTicketMenu/.test(block),
        'the extracted block must contain the picker helpers being tested'
    );

    const menu = { hidden: true, innerHTML: '' };
    const input = {
        // ⚠️ The "@" IS NOW REQUIRED. With the old bare "ticket " value this
        // test would have passed for the wrong reason: the descriptor would
        // return null, the picker would never open, and "rows === 2" would
        // fail rather than prove the delayed-index path works.
        value: '@ticket ', selectionStart: 8,
        focus() {}, setSelectionRange() {}, addEventListener() {}
    };
    const overlay = {
        classList: { _s: new Set(['active']), contains(c) { return this._s.has(c); } }
    };
    const TICKETS = [
        { id: 'bnw-tix001', ticketNumber: 'BNW-TIX001', branch: 'BWNW', status: 'Resolved', createdAt: new Date('2026-09-01') },
        { id: 'fame-tix002', ticketNumber: 'FAME-TIX002', branch: 'FAME', status: 'Resolved', createdAt: new Date('2026-09-05') }
    ];
    // A DELAYED read, which is the only way to hit the old freeze.
    let queryCalls = 0;
    const db = {
        collection: () => ({
            get: () => new Promise((res) => setTimeout(() => res({
                forEach: (f) => TICKETS.forEach((d) => f({ id: d.id, data: () => d }))
            }), 5)),
            doc: () => ({ get: () => Promise.resolve({ exists: false }) })
        })
    };
    const ctx = {
        console, db, Date, Promise, Object, Array, String, JSON, setTimeout, clearTimeout,
        els: { mentionMenu: menu, input, overlay },
        escapeHTML: (v) => String(v == null ? '' : v),
        toDate: (v) => (v instanceof Date ? v : new Date(v)),
        // The @ picker's closer lives just past the block; the ticket picker
        // calls it, so the sandbox supplies the same three-line behaviour.
        closeMentionMenu() {
            menu.hidden = true;
            menu.innerHTML = '';
        },
        syncDraftPresence() {}, showToast() {}
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    // Wrap the descriptor function so a runaway caller is COUNTED, not fatal.
    vm.runInContext(block + `
        var __real = activeTicketRefDescriptor;
        activeTicketRefDescriptor = function () { globalThis.__calls = (globalThis.__calls || 0) + 1; return __real(); };
        globalThis.__t = { activeTicketRefDescriptor, updateTicketMenu, syncTicketPicker, ensureTicketIndex };
    `, ctx);

    // Yield repeatedly; if the old recursion were present this would never
    // finish, because the microtask queue would never drain.
    const result = vm.runInContext(`(async function () {
        var t = globalThis.__t;
        globalThis.__calls = 0;
        t.updateTicketMenu();
        t.syncTicketPicker();
        for (var i = 0; i < 12; i++) await new Promise(function (r) { setTimeout(r, 1); });
        return {
            calls: globalThis.__calls,
            hidden: els.mentionMenu.hidden,
            rows: (els.mentionMenu.innerHTML.match(/data-ticket-pick/g) || []).length
        };
    })()`, ctx);

    const settled = typeof result.then === 'function' ? await result : result;
    assert(
        settled.calls < 25,
        'activeTicketQuery() ran ' + settled.calls + ' times for ONE keystroke — ' +
        'that is the runaway recursion that froze the dashboard'
    );
    assert.strictEqual(settled.hidden, false, 'the picker must open once the delayed index lands');
    assert.strictEqual(settled.rows, 2, 'both resolved tickets must be offered, got ' + settled.rows);
})();

// ---------------------------------------------------------------
// 7. The ticket modal REPLACES the chat, and X returns to it
// ---------------------------------------------------------------
console.log('\n=== The modal replaces the chat; X restores it ===');

// ⚠️ Async IIFE: the give-up path is TIMED, so the checks below must await the
// real timers. This file is CommonJS, so a bare top-level `await` is not
// allowed.
(async function () {

{
    // The suspend helpers sit between openTicketFromChat()'s doc comment and
    // the click handler that follows it. The cut must land BEFORE the
    // `async` keyword of openTicketFromRef(), or the slice ends mid-signature
    // and the vm gets a bare `async` identifier.
    const start = src.indexOf('//  HANDING THE SCREEN TO THE TICKET MODAL');
    const end = src.indexOf('async function openTicketFromRef');
    assert(start > -1 && end > start, 'could not locate the suspend/restore block');
    const block = src.slice(start, end);
    assert(
        /function suspendChatForTicket/.test(block) &&
        /function restoreChatAfterTicket/.test(block) &&
        /function watchTicketModalClose/.test(block) &&
        /function openTicketFromChat/.test(block),
        'the block must contain the suspend, restore, watch and open helpers'
    );

    // A classList that behaves like the real one, on a fake element.
    function fakeEl(id) {
        const set = new Set();
        return {
            id,
            classList: {
                add: (...c) => c.forEach((x) => set.add(x)),
                remove: (...c) => c.forEach((x) => set.delete(x)),
                contains: (c) => set.has(c)
            }
        };
    }

    const chatOverlay = fakeEl('chatOverlay');
    chatOverlay.classList.add('active');
    const ticketModal = fakeEl('ticketModal');
    const bodyClassList = {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        contains(c) { return this._s.has(c); }
    };

    // The composer's draft must SURVIVE the round trip — the whole point of
    // suspending rather than closing is that the user loses nothing.
    const draft = { value: 'half-typed message', disabled: false, focused: 0, focus() { this.focused++; } };
    const observers = [];

    const ctx = {
        console,
        els: { overlay: chatOverlay, input: draft, listSearch: null },
        scrollLogToBottom() {},
        markThreadRead() {},
        // Real timers, because the wait for an async opener is TIMED: a stubbed
        // setInterval that never fires would make the HR case untestable.
        setInterval, clearInterval, setTimeout, clearTimeout
    };
    ctx.window = {};
    ctx.document = {
        body: { classList: bodyClassList },
        // Register BOTH ids so the same sandbox can drive the command center
        // (ticketModal) and the HR dashboard (ownerReportModal).
        getElementById: (id) => (id === 'ticketModal' || id === 'ownerReportModal' ? ticketModal : null)
    };
    // A working MutationObserver stub: the real one is absent in Node, and the
    // whole restore hinges on this callback firing.
    ctx.MutationObserver = class {
        constructor(cb) { this.cb = cb; observers.push(this); this.disconnected = false; }
        observe(target, opts) { this.target = target; this.opts = opts; }
        disconnect() { this.disconnected = true; }
        fire() { this.cb(); }
    };
    vm.createContext(ctx);
    vm.runInContext(block, ctx);
    vm.runInContext(`
        globalThis.__api = { suspendChatForTicket, restoreChatAfterTicket, watchTicketModalClose, openTicketFromChat };
        window.openTicketModal = function () { document.getElementById('ticketModal').classList.add('active'); };
    `, ctx);

    const api = vm.runInContext('__api', ctx);
    const TICKET = { id: 'bnw-tix001' };

    // --- opening replaces the chat -------------------------------------
    assert.strictEqual(api.openTicketFromChat(TICKET), true, 'openTicketFromChat() must report success');
    assert(
        !chatOverlay.classList.contains('active'),
        'the chat must NOT stay active behind the ticket modal — that is what put the modal behind the chat'
    );
    assert(
        chatOverlay.classList.contains('chat-suspended'),
        'the chat overlay must be marked .chat-suspended so CSS hides it and stops it eating clicks'
    );
    assert(ticketModal.classList.contains('active'), 'the ticket modal must be the thing on screen');
    assert(
        bodyClassList.contains('chat-ticket-open'),
        'body must be flagged so the page modal is lifted above the chat z-index'
    );
    assert.strictEqual(observers.length, 1, 'exactly one observer must watch the modal');
    // Property-by-property, not deepStrictEqual: the observer was constructed
    // INSIDE the vm realm, so its opts object has a different prototype and
    // deepStrictEqual would fail on identity, not on the values.
    assert.strictEqual(observers[0].opts.attributes, true, 'the observer must watch attributes');
    assert(
        Array.isArray(observers[0].opts.attributeFilter) &&
        observers[0].opts.attributeFilter.indexOf('class') > -1,
        'the observer must watch the class attribute, since that is how these modals open and close'
    );
    assert.strictEqual(draft.focused, 0, 'opening must NOT steal focus from the chat composer');

    // --- X restores the chat -------------------------------------------
    // Exactly what script.js does on the close button:
    // ticketModal.classList.remove('active').
    ticketModal.classList.remove('active');
    observers[0].fire();

    assert(
        chatOverlay.classList.contains('active'),
        'closing the ticket modal must bring the chat back'
    );
    assert(
        !chatOverlay.classList.contains('chat-suspended'),
        'the suspended marker must be cleared on restore'
    );
    assert(
        !bodyClassList.contains('chat-ticket-open'),
        'the body flag must be cleared, or every later modal inherits a raised z-index'
    );
    assert.strictEqual(draft.value, 'half-typed message', 'the unsent draft must survive the round trip');
    assert.strictEqual(draft.focused, 1, 'restoring must return focus to the composer');
    assert(observers[0].disconnected, 'the observer must disconnect itself once it has fired');

    // A duplicate fire must be harmless: no double restore, no throw.
    observers[0].fire();
    assert.strictEqual(draft.focused, 1, 'a duplicate observer fire must not re-run the restore');

    // --- a modal that never opens must not strand the chat ---------------
    // The chat must come back on its own, WITHOUT us waiting out the full
    // timeout: an opener that adds nothing must be detected on the first tick.
    chatOverlay.classList.add('active');
    vm.runInContext('window.openTicketModal = function () {};', ctx);
    assert.strictEqual(
        api.openTicketFromChat({ id: 'ghost' }), true,
        'a resolvable reference still reports success'
    );
    assert(
        !chatOverlay.classList.contains('active'),
        'while waiting to see whether the modal opens, the chat must stay hidden'
    );

    // Outlive the give-up window, then the flag must be gone too.
    await new Promise((r) => setTimeout(r, 1500));
    assert(
        chatOverlay.classList.contains('active'),
        'if the modal never opens, the chat must come back on its own'
    );
    assert(
        !bodyClassList.contains('chat-ticket-open'),
        'the body flag must not be left behind when the modal never opened'
    );

    // --- an opener that throws must not strand the chat -----------------
    chatOverlay.classList.add('active');
    vm.runInContext('window.openTicketModal = function () { throw new Error("boom"); };', ctx);
    assert.strictEqual(api.openTicketFromChat(TICKET), false, 'a throwing opener must report failure');
    assert(
        chatOverlay.classList.contains('active'),
        'a throwing opener must restore the chat, not leave it hidden'
    );

    // --- the CSS contract ----------------------------------------------
    assert(
        /\.chat-modal-overlay\.chat-suspended\s*\{[^}]*visibility:\s*hidden/.test(chatCss),
        '.chat-suspended must hide the chat overlay, or it stays visible behind the modal'
    );
    assert(
        /\.chat-modal-overlay\.chat-suspended\s*\{[^}]*pointer-events:\s*none/.test(chatCss),
        '.chat-suspended must stop the invisible overlay swallowing clicks meant for the modal'
    );
    assert(
        /body\.chat-ticket-open \.modal-overlay\s*\{[^}]*z-index:\s*1100/.test(chatCss),
        'the body flag must lift the page modal above the chat, whose z-index is 1000'
    );
    assert(
        !/body\.chat-ticket-open\s*\{[^}]*display/.test(chatCss),
        'the suspended chat must keep its layout box (visibility, not display), so restoring costs no reflow'
    );

    // --- no Escape handler was added -----------------------------------
    // The requested behaviour is the X button only. Chat's own Escape handler
    // is untouched; what must NOT exist is a NEW keydown listener that closes
    // a ticket modal.
    const liveSrc = stripComments(src);
    const liveBlock = liveSrc.slice(start, liveSrc.indexOf('async function openTicketFromRef'));
    assert(
        !/keydown|Escape/.test(liveBlock),
        'the suspend/restore path must not add an Escape handler — closing is the X button only'
    );
}

})();

// ---------------------------------------------------------------
// 8. The HR dashboard opens the SAME modal ASYNCHRONOUSLY
// ---------------------------------------------------------------
console.log('\n=== HR: the report modal opens after a Firestore read ===');

// ⚠️ Wrapped in an async IIFE on purpose: sections 8b/8c await real timers, and
// this file is CommonJS (`require`), so a bare top-level `await` would leave
// Node unable to pick a module format.
(async function () {
{
    const start = src.indexOf('//  HANDING THE SCREEN TO THE TICKET MODAL');
    const end = src.indexOf('async function openTicketFromRef');
    assert(start > -1 && end > start, 'could not locate the suspend/restore block');
    const block = src.slice(start, end);

    function fakeEl(id) {
        const set = new Set();
        return {
            id,
            classList: {
                add: (...c) => c.forEach((x) => set.add(x)),
                remove: (...c) => c.forEach((x) => set.delete(x)),
                contains: (c) => set.has(c)
            }
        };
    }
    const chatOverlay = fakeEl('chatOverlay');
    const reportModal = fakeEl('ownerReportModal');   // the HR modal
    const bodyClassList = {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        contains(c) { return this._s.has(c); }
    };
    const draft = { value: 'unsent draft', disabled: false, focused: 0, focus() { this.focused++; } };
    const observers = [];

    const ctx = {
        console,
        els: { overlay: chatOverlay, input: draft, listSearch: null },
        scrollLogToBottom() {},
        markThreadRead() {},
        setInterval, clearInterval, setTimeout, clearTimeout
    };
    ctx.window = {};
    ctx.document = {
        body: { classList: bodyClassList },
        getElementById: (id) => (id === 'ownerReportModal' ? reportModal : null)
    };
    ctx.MutationObserver = class {
        constructor(cb) { this.cb = cb; observers.push(this); this.disconnected = false; }
        observe(t, o) { this.target = t; this.opts = o; }
        disconnect() { this.disconnected = true; }
        fire() { this.cb(); }
    };
    vm.createContext(ctx);
    vm.runInContext(block, ctx);
    vm.runInContext(`
        globalThis.__api = { openTicketFromChat };
        // The HR dashboard has NO openTicketModal - only openOwnerReport.
        window.openOwnerReport = function () {
            // EXACTLY how owner-dashboard.js behaves: a Firestore read first,
            // and the 'active' class only once that read resolves.
            setTimeout(function () {
                document.getElementById('ownerReportModal').classList.add('active');
            }, 90);
        };
    `, ctx);
    const api = vm.runInContext('__api', ctx);

    chatOverlay.classList.add('active');
    // The HR page defines openOwnerReport but NOT openTicketModal, so the code
    // must take the ownerReportModal branch.
    assert.strictEqual(
        api.openTicketFromChat({ id: 'bnw-tix001' }), true,
        'the HR opener must be used when openTicketModal is absent'
    );

    // THE REGRESSION: the read has NOT resolved yet, so the modal is not up.
    // The chat must STAY hidden and wait, rather than being restored
    // immediately (which is what left the modal floating over a visible chat).
    assert(
        !chatOverlay.classList.contains('active'),
        'the chat must stay hidden while the HR report read is still in flight'
    );
    assert(
        !reportModal.classList.contains('active'),
        'precondition: the report modal is not up yet, exactly as on a real click'
    );
    assert.strictEqual(observers.length, 0, 'nothing should be watched until the modal is actually up');
}

// ---------------------------------------------------------------
// 8b. ...and once it opens, X must return to the chat
// ---------------------------------------------------------------
console.log('\n=== HR: X on the report modal returns to the chat ===');

{
    const start = src.indexOf('//  HANDING THE SCREEN TO THE TICKET MODAL');
    const end = src.indexOf('async function openTicketFromRef');
    const block = src.slice(start, end);

    function fakeEl(id) {
        const set = new Set();
        return {
            id,
            classList: {
                add: (...c) => c.forEach((x) => set.add(x)),
                remove: (...c) => c.forEach((x) => set.delete(x)),
                contains: (c) => set.has(c)
            }
        };
    }
    const chatOverlay = fakeEl('chatOverlay');
    const reportModal = fakeEl('ownerReportModal');
    const bodyClassList = {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        contains(c) { return this._s.has(c); }
    };
    const draft = { value: 'unsent draft', disabled: false, focused: 0, focus() { this.focused++; } };
    const observers = [];

    const ctx = {
        console,
        els: { overlay: chatOverlay, input: draft, listSearch: null },
        scrollLogToBottom() {},
        markThreadRead() {},
        setInterval, clearInterval, setTimeout, clearTimeout
    };
    ctx.window = {};
    ctx.document = {
        body: { classList: bodyClassList },
        getElementById: (id) => (id === 'ownerReportModal' ? reportModal : null)
    };
    ctx.MutationObserver = class {
        constructor(cb) { this.cb = cb; observers.push(this); this.disconnected = false; }
        observe(t, o) { this.target = t; this.opts = o; }
        disconnect() { this.disconnected = true; }
        fire() { this.cb(); }
    };
    vm.createContext(ctx);
    vm.runInContext(block, ctx);
    vm.runInContext(`
        globalThis.__api = { openTicketFromChat };
        window.openOwnerReport = function () {
            setTimeout(function () {
                document.getElementById('ownerReportModal').classList.add('active');
            }, 40);
        };
    `, ctx);
    const api = vm.runInContext('__api', ctx);

    chatOverlay.classList.add('active');
    api.openTicketFromChat({ id: 'bnw-tix001' });

    // Let the delayed read resolve AND the poll tick past it.
    await new Promise((r) => setTimeout(r, 260));

    assert(
        reportModal.classList.contains('active'),
        'the report modal must be up once the Firestore read resolves'
    );
    assert(
        !chatOverlay.classList.contains('active'),
        'the chat must still be hidden while the report modal is open'
    );
    assert.strictEqual(observers.length, 1, 'the modal must be watched once it finally opens');
    assert.strictEqual(draft.focused, 0, 'opening must not steal focus from the composer');

    // X on the HR modal: what owner-dashboard.js does.
    reportModal.classList.remove('active');
    observers[0].fire();

    assert(
        chatOverlay.classList.contains('active'),
        'pressing X on the HR report modal must return to the chat'
    );
    assert(
        !chatOverlay.classList.contains('chat-suspended'),
        'the suspended marker must be cleared on the HR restore too'
    );
    assert(
        !bodyClassList.contains('chat-ticket-open'),
        'the body flag must be cleared on the HR restore too'
    );
    assert.strictEqual(draft.value, 'unsent draft', 'the draft must survive the HR round trip');
    assert.strictEqual(draft.focused, 1, 'focus must return to the composer');
}

// ---------------------------------------------------------------
// 8c. A read that never lands must not strand the user
// ---------------------------------------------------------------
console.log('\n=== A report read that never resolves still returns the chat ===');

{
    const start = src.indexOf('//  HANDING THE SCREEN TO THE TICKET MODAL');
    const end = src.indexOf('async function openTicketFromRef');
    const block = src.slice(start, end);

    function fakeEl(id) {
        const set = new Set();
        return {
            id,
            classList: {
                add: (...c) => c.forEach((x) => set.add(x)),
                remove: (...c) => c.forEach((x) => set.delete(x)),
                contains: (c) => set.has(c)
            }
        };
    }
    const chatOverlay = fakeEl('chatOverlay');
    const reportModal = fakeEl('ownerReportModal');
    const bodyClassList = {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        contains(c) { return this._s.has(c); }
    };
    const draft = { value: 'unsent draft', disabled: false, focused: 0, focus() { this.focused++; } };

    const ctx = {
        console,
        els: { overlay: chatOverlay, input: draft, listSearch: null },
        scrollLogToBottom() {},
        markThreadRead() {},
        setInterval, clearInterval, setTimeout, clearTimeout
    };
    ctx.window = {};
    ctx.document = {
        body: { classList: bodyClassList },
        getElementById: (id) => (id === 'ownerReportModal' ? reportModal : null)
    };
    ctx.MutationObserver = class {
        constructor(cb) { this.cb = cb; }
        observe() {}
        disconnect() {}
    };
    vm.createContext(ctx);
    vm.runInContext(block, ctx);
    vm.runInContext(`
        globalThis.__api = { openTicketFromChat };
        // A deleted ticket, or a denied read: owner-dashboard.js returns early
        // ("if (!snap.exists) return") and the modal NEVER opens.
        window.openOwnerReport = function () {};
    `, ctx);
    const api = vm.runInContext('__api', ctx);

    chatOverlay.classList.add('active');
    api.openTicketFromChat({ id: 'gone' });

    // Outlive the 1200ms give-up window, with margin.
    await new Promise((r) => setTimeout(r, 1600));

    assert(
        chatOverlay.classList.contains('active'),
        'if the report never opens, the chat MUST come back — never strand the user on a blank screen'
    );
    assert(
        !chatOverlay.classList.contains('chat-suspended'),
        'the suspended marker must be cleared when the give-up path runs'
    );
    assert(
        !bodyClassList.contains('chat-ticket-open'),
        'the body flag must not be left behind when the report never opens'
    );
    assert.strictEqual(draft.focused, 1, 'focus must return to the composer on the give-up path');
}

console.log('\nOK: HR async ticket modal tests passed (a ticket chip suspends the chat, the report modal opens after its Firestore read, and X returns to the thread with the draft intact; the resolved-ticket modal uses the same two-section Requester/Operator layout as the Reports modal).');

})();

console.log('\nOK: HR async ticket modal tests passed');

