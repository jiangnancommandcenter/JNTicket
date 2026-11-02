// Functional test for clickable VIOLATION MENTIONS in chat.
//
// "please action violation VIO-0007" — the reference renders as a chip, and
// clicking it opens that report's modal. Works in BOTH directions (superadmin
// <-> HR), because both sides load js/chat.js.
//
// The behaviour most worth locking down here:
//   1. the reference is matched in the TEXT (no new persisted field), so old
//      messages link too and no rules deploy is needed;
//   2. ONLY TRANSFERRED reports can be opened — hrStatus for HR/superadmin,
//      managerStatus for the Area Manager (the two handoffs are independent),
//      so a chip never opens nothing its reader is allowed to read;
//   3. every read is FILTERED on a transfer flag, because an unfiltered
//      `violations` query is denied for HR by design — the privacy
//      guarantee, not a bug;
//   4. there is no direct-document read in the resolver, because a violation's
//      id is a Firestore auto-id, not its report number;
//   5. the "@ticket" / "@violation" triggers work, and the "@" is never
//      inserted into the text (it would be recorded as a mentioned PERSON);
//   6. a reference that resolves to nothing says WHY instead of dead-ending;
//   7. ⚠️ CREATE ≠ CLICK. The Area Manager may not mention a violation (no
//      picker, no index, no placeholder) but DOES get the clickable chip for
//      reports transferred to them — a chip that never renders is a chip
//      nobody can click, and that was the store-chat bug.
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
const hrJs = fs.readFileSync(path.join(ROOT, 'js', 'hr-violations.js'), 'utf8');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('Testing chat violation mentions (type "violation" or "@violation", click to open)...');

// ---------------------------------------------------------------
// 1. No schema change: the reference is part of the text
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
assert(
    !/violationRefs/.test(stripComments(src)),
    'no violationRefs field may be written to a message: the reference must live ' +
    'in the text, so old messages link too and no hasOnly() can reject the write'
);

const writeFn = (src.match(/function writeMessageBatch\([\s\S]*?return batch\.commit\(\);/) || [''])[0];
assert(writeFn, 'could not read writeMessageBatch()');
assert(
    /payload\.mentions = extractMentions\(text\);/.test(writeFn),
    'the existing mentions field must be written exactly as before'
);
assert(
    !/violationRef/i.test(writeFn),
    'writeMessageBatch() must not gain any violation-specific field'
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

function loadHelpers(role) {
    const sandbox = { console, escapeHTML };
    const ctx = vm.createContext(sandbox);
    const grab = (marker) => {
        const i = src.indexOf(marker);
        assert(i > -1, 'could not find ' + marker + ' in chat.js');
        return i;
    };
    // ⚠️ THE ROLE GATES ARE PART OF THE FUNCTIONS UNDER TEST NOW.
    // linkifyViolationRefs() consults canOpenViolations() (the VIEW gate) and
    // isMentionableViolation() consults the role directly, so the sandbox must
    // carry BOTH role gates, the REAL role normaliser and a `currentRole` —
    // otherwise every existing assertion would throw a ReferenceError instead
    // of testing anything at all.
    //
    // The default is 'hr', a role that can both mention and open, so the
    // happy-path assertions below keep testing the FEATURE rather than the
    // gates. The denial cases load their own context with 'owner'.
    const normalize = src.slice(
        grab('function normalizeRole'),
        src.indexOf('*/', grab('function normalizeRole')) + 2
    );
    const roleGate = src.slice(
        grab('var VIOLATION_MENTION_ROLES'),
        grab('// The LEGACY shared room')
    );
    // isRealRefMatch() is the shared boundary guard; both the extractor and
    // the linkifier call it, and it lives above the pattern factories, so it
    // must be included or every message throws.
    const guard = src.slice(grab('function isRealRefMatch'), grab('// A ticket reference.'));
    const pattern = src.slice(
        grab('function violationRefPattern'),
        grab('function isMentionableViolation')
    );
    const gate = src.slice(
        grab('function isMentionableViolation'),
        grab('// ---- Violation index (lazy, cached)')
    );
    const link = src.slice(
        grab('function linkifyViolationRefs'),
        grab('//  PICKER TRIGGERS')
    );
    // The TICKET pattern + linkifier are loaded too, because the "@" swallowing
    // and the boundary guards are SHARED logic: a bug that broke only the
    // ticket form would pass a violation-only suite. Both linkifiers also share
    // isRealRefMatch(), so they are the pair that must be checked together.
    const ticketPattern = src.slice(
        grab('function ticketRefPattern'),
        grab('// ---- Only RESOLVED tickets')
    );
    const ticketLink = src.slice(
        grab('function linkifyTicketRefs'),
        grab('// NOTE: the bare-word')
    );
    vm.runInContext(
        'var currentRole = ' + JSON.stringify(role === undefined ? 'hr' : role) + ';\n' +
        normalize + '\n' + roleGate + '\n' + guard + '\n' + pattern + '\n' + gate + '\n' +
        link + '\n' + ticketPattern + '\n' + ticketLink + `
        globalThis.__x = {
            isViolationRefToken, extractViolationRefs, linkifyViolationRefs,
            isMentionableViolation, canMentionViolations, VIOLATION_MENTION_ROLES,
            canOpenViolations, VIOLATION_OPEN_ROLES,
            isTicketRefToken, extractTicketRefs, linkifyTicketRefs
        };
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
['please action violation VIO-0007',
    'VIOLATION vio-0007 please',
    'Violation: VIO-0007',
    'see violation #vio-0007 now',
    'ok violation vio-0007'].forEach((text) => {
    assert(
        sameRefs(H.extractViolationRefs(text), ['vio-0007']),
        'must match: ' + text
    );
});

// "violation" is a COMMON ENGLISH WORD, so the prose guard matters MORE here
// than it does for tickets. These must all stay plain text.
['a policy violation was found',
    'that violation is serious',
    'violations are up this month',
    'the violation report was filed'].forEach((text) => {
    assert(
        sameRefs(H.extractViolationRefs(text), []),
        'prose must NOT be linkified: ' + text
    );
});

// The trigger word must sit at a word boundary.
assert(
    sameRefs(H.extractViolationRefs('multiviolation VIO-0007'), []),
    '"multiviolation" must not be read as the trigger word'
);

// Several references in one message, de-duplicated, order preserved.
assert(
    sameRefs(
        H.extractViolationRefs('compare violation VIO-0007 with violation vio-0007 and violation VIO-0012'),
        ['vio-0007', 'vio-0012']
    ),
    'duplicates must collapse and order must be preserved'
);

// ---------------------------------------------------------------
// 3. The chip is a real button carrying an ESCAPED data attribute
// ---------------------------------------------------------------
console.log('\n=== The chip: escaped, inert, and still a link ===');

const chipHtml = H.linkifyViolationRefs(escapeHTML('please see violation VIO-0007'));
assert(/data-violation-ref="vio-0007"/.test(chipHtml), 'a chip must be produced: ' + chipHtml);
assert(/<button/.test(chipHtml) && /<\/button>/.test(chipHtml), 'the chip must be a real <button>');
assert(/chat-violation-chip/.test(chipHtml), 'the chip must carry its own class');
assert(/VIO-0007/.test(chipHtml), 'the chip must display the number uppercased');

// A hand-typed "@ticket BNW-TIX007" must ALSO link. This is now the form the
// composer INSERTS, and the chip must SWALLOW the "@" — not leave it dangling
// in the message in front of the button.
assert(
    /data-ticket-ref="bnw-tix007"/.test(H.linkifyTicketRefs(escapeHTML('@ticket BNW-TIX007'))),
    'a hand-typed "@ticket BNW-TIX007" must render as a chip too'
);
assert(
    /data-violation-ref="vio-0007"/.test(H.linkifyViolationRefs(escapeHTML('@violation VIO-0007'))),
    'a hand-typed "@violation VIO-0007" must render as a chip too'
);

// ⚠️ REGRESSION GUARD for an off-by-one that SILENTLY BROKE EVERY "@" REFERENCE.
// isRealRefMatch() is called with the index of the match start. It was briefly
// passed `offset + at.length`, one character PAST the "@" — so the leading
// check read the "t" of "ticket" (a word character) and rejected every single
// "@" reference. The bare form still worked, which is exactly why it was
// easy to miss: the failure was "the new feature does nothing" rather than an
// error. These assert the chip actually appears, "@" and all.
{
    const atChip = H.linkifyTicketRefs(escapeHTML('see @ticket BNW-TIX007 now'));
    assert(
        /see <button/.test(atChip),
        'the "@" must be INSIDE the chip, not left before it: ' + atChip
    );
    assert(
        !/@<button/.test(atChip),
        'no dangling "@" may sit in front of the chip: ' + atChip
    );
    assert(
        /<\/button> now/.test(atChip),
        'the text AFTER the chip must survive: ' + atChip
    );
    // ...and the same for violations, which have their own pattern + replacer.
    const vioChip = H.linkifyViolationRefs(escapeHTML('please @violation VIO-0007'));
    assert(
        /please <button/.test(vioChip),
        'the violation chip must swallow its "@" too: ' + vioChip
    );
    // The extractor must agree with the linkifier, or a resolvable reference
    // would render as a chip that cannot be clicked.
    assert(
        H.extractTicketRefs('see @ticket BNW-TIX007 now').length === 1,
        'extractTicketRefs() must see the "@" form'
    );
    assert(
        H.extractViolationRefs('@violation VIO-0007').length === 1,
        'extractViolationRefs() must see the "@" form'
    );
}

// ⚠️ THE BOUNDARY GUARDS. Both keyword+token boundaries are load-bearing, and
// the naive pattern gets both wrong.
[
    // An email address, not a reference (the "@" follows a word character).
    ['a@ticket.com now', false],
    ['mail me at bob@ticket.com', false],
    // A handle that merely STARTS with the keyword. These are only stopped
    // because the pattern REQUIRES A SEPARATOR between keyword and token, and
    // the token must end at a non-word character. Without the separator,
    // "@ticketmaster2" parses as "ticket" + "master2" — and "master2" contains
    // a digit, so it satisfied the old digit/separator rule and became a chip.
    ['hi @ticketmaster2', false],
    ['@ticketmaster please', false],
    ['@violationmaster x', false],
    ['@violationmaster2', false],
    // Ordinary prose.
    ['a policy violation was found', false],
    ['that violation is serious', false],
    ['multiticket VIO-0001', false]
].forEach(([text, shouldLink]) => {
    const t = /data-ticket-ref=/.test(H.linkifyTicketRefs(escapeHTML(text)));
    const v = /data-violation-ref=/.test(H.linkifyViolationRefs(escapeHTML(text)));
    assert.strictEqual(t, shouldLink, 'ticket link for "' + text + '"');
    assert.strictEqual(v, shouldLink, 'violation link for "' + text + '"');
});

// Trailing punctuation must NOT stop a real reference from linking. This is
// why the guard is a JS check on the following character rather than a regex
// lookahead: `(?!\w)` consumed the "!" and silently unlinked the reference.
assert(
    /data-violation-ref="vio-0007"/.test(H.linkifyViolationRefs(escapeHTML('violation vio-0007!'))),
    'a trailing "!" must not stop a reference linking'
);
assert(
    /data-ticket-ref="bnw-tix007"/.test(H.linkifyTicketRefs(escapeHTML('handle ticket BNW-TIX007.'))),
    'a trailing "." must not stop a reference linking'
);

// Injection: the reference is wrapped in a chip, so the attacker's payload
// must survive as INERT TEXT — which is exactly what escaping means.
const nasty = 'violation VIO-0007"><img src=x onerror=alert(1)>';
const nastyHtml = H.linkifyViolationRefs(escapeHTML(nasty));
// The correct property to assert is not "onerror is absent" — the WORDS
// survive as harmless INERT TEXT, which is exactly what escaping means.
const rawTags = nastyHtml.replace(/<button[\s\S]*?<\/button>/g, '').replace(/<[^>]*>/g, '');
assert(
    !/</.test(rawTags),
    'no stray "<" may open a tag outside the chip: ' + rawTags
);
const captured = /data-violation-ref="([^"]*)"/.exec(nastyHtml);
assert(captured, 'a chip must still be produced for the leading valid reference');
assert(
    !/["'<>]/.test(captured[1]),
    'the captured id must contain no quotes or brackets: ' + captured[1]
);

// A bare script tag in a message must never become a chip.
assert(
    !/data-violation-ref/.test(H.linkifyViolationRefs(escapeHTML('<script>alert(1)</script>'))),
    'a script tag must not be turned into a chip'
);

// Escaping MUST happen before linkifying, or a reference can inject markup.
const renderFn = (src.match(/function renderMessageBody\([\s\S]*?\n    \}/) || [''])[0];
assert(renderFn, 'could not read renderMessageBody()');
const escAt = renderFn.indexOf('escapeHTML(text)');
const linkAt = renderFn.indexOf('linkifyViolationRefs(body)');
assert(escAt > -1 && linkAt > -1, 'renderMessageBody() must escape and then linkify');
assert(escAt < linkAt, 'escaping MUST happen before linkifying, or a reference can inject markup');
// Both ref passes run BEFORE the @mention pass, so a mention can never be
// matched inside a chip's own markup.
assert(
    renderFn.indexOf('linkifyTicketRefs(body)') < renderFn.indexOf('linkifyViolationRefs(body)'),
    'the ticket and violation linkifiers must run in a fixed order'
);
assert(
    renderFn.indexOf('linkifyViolationRefs(body)') < renderFn.indexOf('mentionCandidates()'),
    'reference chips must be built before the @mention pass touches the string'
);

// ---------------------------------------------------------------
// 4. Only TRANSFERRED reports may be mentioned
// ---------------------------------------------------------------
console.log('\n=== Only transferred reports can be mentioned ===');

assert(H.isMentionableViolation({ violationNumber: 'VIO-0007', hrStatus: 'transferred' }),
    'a transferred report is mentionable');
// Case/whitespace tolerant, so a hand-edited doc cannot slip past.
assert(H.isMentionableViolation({ hrStatus: '  Transferred ' }),
    'the gate must tolerate casing and whitespace');
// These are the ones that matter.
assert(!H.isMentionableViolation({ violationNumber: 'VIO-0007' }),
    'a report with NO hrStatus (every report filed before the transfer ' +
    'feature existed) must NOT be mentionable');
assert(!H.isMentionableViolation({ hrStatus: 'pending' }),
    'a report that is not transferred must NOT be mentionable');
assert(!H.isMentionableViolation(null), 'a missing report must not be mentionable');

// The gate must be applied in EVERY place the ticket one is — a picker that
// filtered but a resolver that did not would hand HR the withheld record.
const indexFn = (src.match(/function ensureViolationIndex\([\s\S]*?\n    \}/) || [''])[0];
assert(indexFn, 'could not read ensureViolationIndex()');
assert(
    /if \(!isMentionableViolation\(v\)\) return;[\s\S]*slice\(0, VIOLATION_PICKER_LIMIT\)/.test(indexFn),
    'the index must drop untransferred reports BEFORE the cap — filtering ' +
    'after the slice would let a burst of untransferred reports push every ' +
    'mentionable one out of the picker, leaving it mysteriously empty'
);
const cacheFn = (src.match(/function indexViolation\([\s\S]*?\n    \}/) || [''])[0];
assert(
    /isMentionableViolation/.test(cacheFn),
    'indexViolation() must refuse to CACHE an untransferred report, so the ' +
    "resolver's fast path is gated for free"
);
const resolveFn = (src.match(/async function resolveViolationRef\([\s\S]*?\n    \}/) || [''])[0];
assert(resolveFn, 'could not read resolveViolationRef()');
assert(
    /isMentionableViolation/.test(resolveFn),
    'the resolver must re-check the gate on its query path'
);

// ---------------------------------------------------------------
// 5. Every read is FILTERED — an unfiltered query is denied for HR
// ---------------------------------------------------------------
console.log('\n=== Every read is filtered (HR cannot read unfiltered) ===');

// The real rule, quoted so a future widening of it fails HERE rather than in
// production: this suite assumes an unfiltered query is denied for HR.
//
// ⚠️ THE RULE HAS SINCE GAINED A THIRD CLAUSE for the Area Manager handoff
// (`managerStatus`, see js/owner-violations.js). That does NOT weaken what this
// file guards: the HR branch is still gated on isTransferredToHr(), so an
// unfiltered HR query is still DENIED. This assertion therefore pins the HR
// clause specifically rather than the whole expression — matching the entire
// rule would fail on a legitimate, unrelated addition and invite someone to
// "fix" it by deleting the clause that matters.
const violationsRule = (() => {
    const start = rules.indexOf('match /violations/{violationId}');
    assert(start > -1, 'firestore.rules must still contain the violations block');
    const end = rules.indexOf('match /', start + 10);
    return rules.slice(start, end > -1 ? end : undefined);
})();
assert(
    /\(isHr\(\) && isTransferredToHr\(\)\)/.test(violationsRule),
    'the violations read rule must still gate HR on isTransferredToHr(). ' +
    'This suite relies on an unfiltered query being DENIED for HR, so if THAT ' +
    'clause is widened the filtered queries here are no longer required.'
);

// The added clause must itself be transfer-gated. A bare `isAreaManager()` in
// the read rule would hand every Area Manager the entire raw operator feed.
assert(
    !/\(isAreaManager\(\) && !isTransferredToAreaManager\(\)\)/.test(violationsRule),
    'the Area Manager read clause must be gated on isTransferredToAreaManager()'
);

assert(
    /\.where\('hrStatus', '==', 'transferred'\)/.test(indexFn),
    'the index read must be filtered on hrStatus, or HR gets a denied query'
);

// ⚠️ THE UNFILTERED PROBE IS THE ONE DELIBERATE EXCEPTION, and it must come
// LAST and be guarded: it only runs to tell "not transferred yet" from "not
// found", and only a superadmin may run it. For HR it is denied, which is
// correct — "not found" is the right answer when they cannot see the record.
const probeAt = resolveFn.indexOf("db.collection('violations').get()");
assert(probeAt > -1, 'the untransferred probe should still exist (it powers the better toast)');
assert(
    probeAt > resolveFn.indexOf("where('hrStatus', '==', 'transferred')"),
    'the unfiltered probe must come AFTER the filtered lookup, so the cheap ' +
    'and permitted query is always tried first'
);
assert(
    /catch\s*\(\s*e\s*\)\s*\{[^}]*not permitted for HR/.test(resolveFn),
    'the unfiltered probe must swallow its permission error — a denial for HR ' +
    'is the expected outcome, not a failure'
);

// The resolver must NOT try a direct document read: a violation's id is a
// Firestore auto-id, so `violations/vio-0007` could never exist.
assert(
    !/collection\('violations'\)\s*\n?\s*\.doc\(/.test(resolveFn),
    'the resolver must NOT attempt a direct violations/<ref> read: violation ' +
    'ids are Firestore auto-ids (.add()), not the report number, so that ' +
    'lookup could never succeed'
);

// The picker limit is capped, like the ticket one.
assert(
    /var VIOLATION_PICKER_LIMIT = 50;/.test(src),
    'the violation picker must be capped, for the same reason the ticket one is'
);

// ---------------------------------------------------------------
// 6. The "@ticket" / "@violation" triggers — the ONLY ones
// ---------------------------------------------------------------
console.log('\n=== "@ticket" / "@violation" triggers ===');

const atFn = (src.match(/function activeAtRefQuery\([\s\S]*?\n    \}/) || [''])[0];
assert(atFn, 'the "@ticket" / "@violation" trigger must exist');
// Purity: the same freeze the ticket one documents. A read started from in
// here, whose callback called back in here, is an unbounded microtask loop.
assert(
    !/ensureViolationIndex\(/.test(atFn) && !/\.then\(/.test(atFn),
    'activeAtRefQuery() must be PURE — it may not start the read or attach a ' +
    'promise callback (that recursion froze the whole page for tickets)'
);
// ⚠️ THE BARE-WORD TRIGGERS ARE GONE, AND MUST STAY GONE. Both fired on the
// keyword plus a space anywhere in the message, so ordinary prose opened the
// picker mid-sentence — "that violation is serious" being the worst case,
// since "violation" is a common English word. Requiring "@" is the fix.
assert(
    !/function activeViolationQuery\(\)/.test(src),
    'the bare "violation " picker trigger must not come back'
);
assert(
    !/function activeTicketQuery\(\)/.test(src),
    'the bare "ticket " picker trigger must not come back'
);
// ...but the BARE form must still LINKIFY, or every message already sent
// would lose its working chip.
assert(
    /function linkifyViolationRefs\(/.test(src) && /function linkifyTicketRefs\(/.test(src),
    'the bare reference form must still render as a chip in sent messages'
);
// Each trigger word must be recognised, violation tested FIRST so "@violation"
// is never mistaken for a shorter prefix. This matches the LITERAL source
// text, so the pattern's own backslashes are matched as literal characters.
const reLine = (atFn.match(/var re = \/[^;]+;/g) || []).join(' ');
assert(
    reLine.indexOf('@violations') > -1 && reLine.indexOf('@tickets') > -1,
    'both trigger words must be matched'
);
assert(
    reLine.indexOf('@violations') < reLine.indexOf('@tickets'),
    'the violation trigger must be listed FIRST, so "@violation" is never ' +
    'matched as a shorter ticket-style prefix'
);
// Dispatch order: the ref tokens must beat a bare "@" (people).
const dispatcher = (src.match(/function syncRefPicker\(\)[\s\S]*?\n    \}/) || [''])[0];
assert(dispatcher, 'could not read syncRefPicker()');
assert(
    /function syncRefPicker\(\)[\s\S]*?activeAtRefQuery\(\)[\s\S]*?updateMentionMenu\(\)/.test(dispatcher),
    'syncRefPicker() must test the ref trigger BEFORE falling through to people'
);
assert(
    !/activeTicketQuery\(\)|activeViolationQuery\(\)/.test(dispatcher),
    'syncRefPicker() must not consult the removed bare-word triggers'
);

// ⚠️ REGRESSION GUARD: a single English word after the trigger is PROSE, not a
// query. "check @violation now" matches the trigger and leaves "now" as the
// query — one word, no space — so the multi-word check cannot catch it. Without
// this the picker opens mid-sentence, and picking a row would overwrite the
// user's actual words with a reference. The query must therefore be empty, or
// already look like the start of a numbered reference.
assert(
    /if \(query && !\/\^\[0-9\]\/\.test\(query\) && !\/\[-_\]\/\.test\(query\)\) return null;/.test(atFn),
    'a bare English word after "@violation"/"@ticket" must NOT open the picker: ' +
    'the query must be empty, or start with a digit, or already carry a separator'
);

console.log('\n=== The triggers, proved by RUNNING them (not just reading them) ===');

// Static assertions can only see the SHAPE of the code. These drive the REAL
// functions in a vm sandbox, which is the only way to catch a trigger that
// fires — or fails to fire — on a string nobody thought of.
{
    const sandbox = { console };
    const ctx2 = vm.createContext(sandbox);
    vm.runInContext(
        'var els={input:{value:"",selectionStart:0}};' +
        'var PICKER_TICKET="ticket", PICKER_VIOLATION="violation";' +
        atFn + '\n' +
        'globalThis.__t={activeAtRefQuery,' +
        '  set: function(t){els.input.value=t; els.input.selectionStart=t.length;}};',
        ctx2
    );
    const T = sandbox.__t;
    // [typed, expected kind (null = must NOT fire), expected query]
    [
        ['@violation', 'violation', ''],
        ['@violation VIO-00', 'violation', 'VIO-00'],
        ['@violation 0', 'violation', '0'],
        ['@violation VIO-0', 'violation', 'VIO-0'],
        ['@ticket ', 'ticket', ''],
        ['@ticket 007', 'ticket', '007'],
        ['@ticket BNW-', 'ticket', 'BNW-'],
        ['@tickets ', 'ticket', ''],
        ['@violations ', 'violation', ''],
        ['@Violation VIO-1', 'violation', 'VIO-1'],
        // These must all stay inert.
        ['check @violation now', null, null],    // ⚠️ prose, not a query
        ['ask @ticket about this', null, null],  // ⚠️ prose, not a query
        ['a@ticket.com', null, null],            // an address, not a trigger
        ['@violation  spaced', null, null]       // moved on to the next word
    ].forEach(([text, kind, q]) => {
        T.set(text);
        const r = T.activeAtRefQuery();
        assert.strictEqual(r ? r.kind : null, kind, 'kind for "' + text + '"');
        assert.strictEqual(r ? r.query : null, q, 'query for "' + text + '"');
    });

    // ⚠️ THE POINT OF THE WHOLE CHANGE: the BARE keyword must NOT fire the
    // picker any more. Each of these used to open it mid-sentence, which is
    // the annoyance that "@" was introduced to fix.
    [
        'that ticket looks wrong',
        'closing this ticket now',
        'please see violation VIO-0007',
        'that violation is serious',
        'the ticket ',
        'a violation of policy'
    ].forEach((text) => {
        T.set(text);
        assert.strictEqual(
            T.activeAtRefQuery(), null,
            'the bare keyword must not open the picker: "' + text + '"'
        );
    });
}

// ⚠️ THE INSERTED TEXT NOW CARRIES THE "@" — "@violation VIO-0007 " — because
// "@" is the trigger the composer inserts from, and the linkifier's chip
// SWALLOWS it, so the rendered message shows one clean chip with no stray "@".
const applyPick = (src.match(/function applyViolationPick\([\s\S]*?\n    \}/) || [''])[0];
assert(applyPick, 'could not read applyViolationPick()');
assert(
    /var insertion = '@violation ' \+ number \+ ' ';/.test(applyPick),
    'the picked text must be "@violation <NUMBER> "'
);
const applyTicket = (src.match(/function applyTicketPick\([\s\S]*?\n    \}/) || [''])[0];
assert(
    /var insertion = '@ticket ' \+ number \+ ' ';/.test(applyTicket),
    'the picked ticket must be "@ticket <NUMBER> "'
);
// ⚠️ BECAUSE THE "@" IS NOW INSERTED, extractMentions() SKIPPING THE TRIGGER
// WORDS IS LOAD-BEARING, NOT DEFENSIVE. extractMentions() scans
// /@[\w.\-]+/g, so without this guard every picked reference would write
// "violation" onto the message as a mentioned PERSON — firing a mention toast
// and a sound at whoever it resolved to. Removing the guard must fail here.
assert(
    /REF_TRIGGER_WORDS\.indexOf\(token\)/.test(src),
    'extractMentions() MUST skip the ref trigger words now that the "@" is ' +
    'inserted, or every picked reference becomes a phantom mention of a person'
);
assert(
    /'@violation'/.test(src) && /'@ticket'/.test(src),
    'both trigger words must be in the skip list'
);
// And the chip must swallow the "@", so nothing dangles in the message.
assert(
    /function linkifyViolationRefs\(/.test(src) && /isRealRefMatch\(/.test(src),
    'the chip must run the shared boundary guard that swallows the leading "@"'
);

// Picker rows carry their own data attribute, distinct from the ticket one.
assert(
    /data-violation-pick=/.test(src) && /data-ticket-pick=/.test(src),
    'each picker must mark its own rows, or Enter cannot tell them apart'
);
// A delegated click handler must exist for the chip.
const logClicks = src.match(/els\.log\.addEventListener\('click'[\s\S]{0,600}/g) || [];
assert(
    logClicks.some((b) => /data-violation-ref/.test(b)),
    'a delegated click handler on the message log must open the report'
);
assert(
    logClicks.some((b) => /data-violation-ref/.test(b) && /if \(!chip\) return;/.test(b)),
    'the violation click handler must bail out when no chip was hit'
);

// ---------------------------------------------------------------
// 7. The click opens the right modal, and failure is REPORTED
// ---------------------------------------------------------------
console.log('\n=== The click opens the report, or explains why not ===');

const openRef = (src.match(/async function openViolationFromRef\([\s\S]*?\n    \}/) || [''])[0];
assert(openRef, 'could not read openViolationFromRef()');
assert(
    /if \(!violation\)[\s\S]*?showToast\(/.test(openRef),
    'a reference that resolves to nothing must SAY so, not fail silently'
);
assert(
    /lastViolationWasUntransferred/.test(openRef),
    'the toast must distinguish "not transferred yet" from "not found" — the ' +
    'difference between a helpful message and one that sends HR hunting a typo'
);
const openChat = (src.match(/function openViolationFromChat\([\s\S]*?\n    \}/) || [''])[0];
assert(openChat, 'could not read openViolationFromChat()');
// Both pages' openers, and the HR one must be reached through the module.
assert(
    /window\.openViolationModal/.test(openChat),
    'the command center opener (script.js) must be used on main.html'
);
assert(
    /window\.HrViolations/.test(openChat) && /hrViolationModal/.test(openChat),
    'the HR opener (js/hr-violations.js) and its #hrViolationModal must be used ' +
    'on ownerdashboard.html'
);
assert(
    /window\.OwnerViolations/.test(openChat) && /ownerViolationModal/.test(openChat),
    'the Area Manager opener (js/owner-violations.js) and its #ownerViolationModal ' +
    'must be used on ownerdashboard.html'
);
assert(
    openChat.indexOf('window.OwnerViolations.openModal') > -1 &&
    openChat.indexOf('window.OwnerViolations.openModal') <
        openChat.indexOf('window.HrViolations.openModal'),
    'the Area Manager branch must come FIRST — ownerdashboard.html loads BOTH ' +
    'violation modules, and the HR one holds nothing for role "owner" (its listener ' +
    'never starts there), so availability alone would route every manager chip to an ' +
    'empty list and a permanent "not finished loading"'
);
// ⚠️ THE AREA MANAGER'S MISS TOAST must name the real reason. The unfiltered
// probe that powers "not transferred to HR yet" is DENIED for role 'owner',
// so a bare "not found" would send them hunting a typo when the answer is
// "not handed to you yet".
assert(
    /is not on your violations list yet/.test(src),
    "the Area Manager's failed click must say the report is not on THEIR list — " +
    'not that it does not exist'
);
// The chat must be suspended, not closed, and restored on modal close — the
// same machinery tickets use, so the draft and room survive.
assert(
    /suspendChatForTicket\(\)/.test(openChat) && /waitForTicketModalOpen\(/.test(openChat),
    'the chat must be suspended and the modal open WAITED for, not assumed'
);

// ⚠️ The HR opener must REPORT whether it opened, or a report whose listener
// has not arrived yet would look like a broken chip.
const hrOpen = (hrJs.match(/function openModal\(id\)[\s\S]*?\n    \}/) || [''])[0];
assert(hrOpen, 'could not read hr-violations.js openModal()');
assert(
    /return true;/.test(hrOpen) && /return false;/.test(hrOpen),
    'hr-violations.js openModal() must return a boolean on BOTH paths — chat ' +
    'cannot otherwise tell "opened" from "not loaded yet"'
);
assert(
    /opener\(\) !== false/.test(openChat),
    "chat must treat only an explicit false as failure: script.js's " +
    'openViolationModal() returns nothing on success'
);

// ---------------------------------------------------------------
// 8. The picker must not recurse (the freeze regression, again)
// ---------------------------------------------------------------
console.log('\n=== The picker must not recurse (the freeze regression) ===');

const live = (stripComments(src).match(/ensureViolationIndex\(\)\.then\(/g) || []).length;
assert.strictEqual(
    live, 1,
    'the violation index must be started from exactly ONE call site, got ' + live
);
assert(
    /function syncViolationPicker\(\)[\s\S]*?ensureViolationIndex\(\)\.then/.test(src),
    'syncViolationPicker() must own the deferred render after the read'
);
assert(
    /addEventListener\('input',[\s\S]{0,400}syncRefPicker\(\)/.test(src),
    'the input handler must reach syncViolationPicker() via syncRefPicker()'
);

// ---------------------------------------------------------------
// 9. The chip is styled, and themes with the rest of the app
// ---------------------------------------------------------------
console.log('\n=== The chip is styled ===');

assert(/\.chat-violation-chip \{/.test(chatCss), 'the chip must be styled');
// ⚠️ The chip was the translucent-blue TWIN of the ticket chip — and that
// translucent blue vanished inside the SOLID blue outgoing bubble
// (--chat-bubble-out): blue-on-blue, the chip unreadable on your OWN
// messages. It is now an OPAQUE pale-RED pill with dark red text, from its
// own theme-stable tokens — and its own HUE, so a violation (red) reads
// apart from a ticket (teal) at a glance, not by glyph alone.
assert(
    /\.chat-violation-chip\s*\{[^}]*var\(--chat-violation-chip-text/.test(chatCss) &&
    /\.chat-violation-chip\s*\{[^}]*var\(--chat-violation-chip-bg/.test(chatCss),
    'the chip must colour itself from the --chat-violation-chip-* tokens — its own pale-red ' +
    'pill, opaque so the blue outgoing bubble cannot make it blue-on-blue again'
);
// The tokens must exist in BOTH themes, theme-STABLE (same value), like
// --chat-bubble-out — a light-only pill would drift in dark mode.
const lightCss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const darkCss = fs.readFileSync(path.join(ROOT, 'theme.css'), 'utf8');
const tokenHex = (name) => {
    const m = lightCss.match(new RegExp(name + ':\\s*(#[0-9a-fA-F]{6})'));
    assert(m, 'style.css (light theme) must declare ' + name + ' as a 6-digit hex');
    assert(darkCss.includes(name + ': ' + m[1]),
        'theme.css (dark theme) must declare the SAME ' + name + ' value — theme-stable like --chat-bubble-out');
    return m[1];
};
// The text must clear AA (4.5:1) on the ACTUAL declared pill for the
// ~13px bold label — computed from the tokens, so retinting either side
// fails here first instead of shipping unreadable.
const relLum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const chan = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * chan((n >> 16) & 255) + 0.7152 * chan((n >> 8) & 255) + 0.0722 * chan(n & 255);
};
{
    const l1 = relLum(tokenHex('--chat-violation-chip-bg'));
    const l2 = relLum(tokenHex('--chat-violation-chip-text'));
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    assert(ratio >= 4.5,
        'the violation chip text must be >= 4.5:1 (WCAG AA) on its pill; computed ' + ratio.toFixed(2) + ':1');
}
assert(
    /prefers-reduced-motion[\s\S]{0,400}chat-violation-chip/.test(chatCss),
    'the chip must honour prefers-reduced-motion, like the ticket chip'
);
assert(
    /chat-violation-chip:focus-visible/.test(chatCss),
    'keyboard users must be able to SEE where they are'
);

// ---------------------------------------------------------------
// 10. THE MOUSE MUST PICK A VIOLATION ROW  (the regression)
// ---------------------------------------------------------------
// ⚠️ THIS IS THE ASSERTION WHOSE ABSENCE LET THE BUG SHIP.
// Section 6 only proved the attribute was *emitted* by violationPickerRow().
// Nothing proved anything ever *read* it, and the mousedown listener had no
// data-violation-pick branch at all — so the menu opened, the row highlighted,
// and clicking it did nothing. The keyboard worked the whole time, because the
// keydown handler dispatches on pickerMode rather than on a data attribute,
// which is what made the bug look intermittent.
//
// This runs the REAL listener body against all three row types, so a row that
// is rendered but not picked fails here.
console.log('\n=== The mouse picks a violation row, like a ticket row ===');

const mousedownMatch = src.match(
    /els\.mentionMenu\.addEventListener\('mousedown', function \(event\) \{([\s\S]*?)\n            \}\);/
);
assert(mousedownMatch, 'could not read the mention menu mousedown listener');

// A context must be created explicitly: vm.runInNewContext() returns the last
// expression's VALUE, not the context object, so it cannot be handed to
// runInContext() below.
const mdCtx = vm.createContext({});
vm.runInContext(
    'var els = { mentionMenu: { addEventListener: function (t, h) { globalThis.__h = h; } } };' +
    'globalThis.__calls = [];' +
    'function applyMention(c) { globalThis.__calls.push(["mention", c.name]); }' +
    'function applyTicketPick(id) { globalThis.__calls.push(["ticket", id]); }' +
    'function applyViolationPick(id) { globalThis.__calls.push(["violation", id]); }' +
    'globalThis.__click = function (attrs) {' +
    '    var opt = { getAttribute: function (k) {' +
    '        return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;' +
    '    } };' +
    '    globalThis.__calls = [];' +
    '    globalThis.__h({ target: { closest: function (sel) {' +
    '        return sel === ".chat-mention-option" ? opt : null;' +
    '    } }, preventDefault: function () {} });' +
    '    return globalThis.__calls;' +
    '};',
    mdCtx
);
// Install the real body, verbatim.
mdCtx.__h = vm.runInContext('(function (event) {' + mousedownMatch[1] + '})', mdCtx);

// The bug, exactly: a violation row carries ONLY data-violation-pick.
assert.deepEqual(
    mdCtx.__click({ 'data-violation-pick': 'VIO123' }),
    [['violation', 'VIO123']],
    'clicking a violation row must call applyViolationPick() with its id — this is ' +
    'the exact case that silently did nothing before the fix'
);

// The two row types that already worked must NOT regress.
assert.deepEqual(
    mdCtx.__click({ 'data-ticket-pick': 'BNW-TIX007' }),
    [['ticket', 'BNW-TIX007']],
    'clicking a ticket row must still call applyTicketPick()'
);
assert.deepEqual(
    mdCtx.__click({ 'data-mention-name': 'Ana', 'data-mention-email': 'ana@x.com' }),
    [['mention', 'Ana']],
    'a person row must still win over the ref rows — it is probed first'
);
assert.deepEqual(
    mdCtx.__click({ 'data-mention-name': 'Ana', 'data-ticket-pick': 'T1', 'data-violation-pick': 'V1' }),
    [['mention', 'Ana']],
    'the person row is probed first and must short-circuit the others'
);
// A click on a row carrying no data attribute must be a harmless no-op.
assert.deepEqual(mdCtx.__click({}), [], 'a row with no data attribute must be a no-op');

// ---------------------------------------------------------------
// 11. "NOTHING TO OFFER" MUST EXPLAIN ITSELF
// ---------------------------------------------------------------
// The picker may only offer TRANSFERRED reports, so an empty list is the normal
// outcome of a CORRECT picker, not a fault. Closing silently made a working
// feature look broken. The empty state has to stay NON-SELECTABLE, or Enter
// would be swallowed exactly when the user wants to abandon the trigger.
console.log('\n=== An empty picker explains itself, and stays inert ===');

const updateV = (src.match(/function updateViolationMenu\([\s\S]*?\n    \}/) || [''])[0];
const emptyRow = (src.match(/function violationPickerEmptyRow\([\s\S]*?\n    \}/) || [''])[0];

assert(emptyRow, 'violationPickerEmptyRow() must exist');
assert(
    /is-empty/.test(emptyRow) && /role="option"/.test(emptyRow),
    'the empty state must render as an inert option row'
);
assert(
    !/data-violation-pick/.test(emptyRow),
    'the empty row must NOT be selectable — carrying a pick attribute would let ' +
    'the mousedown handler apply an empty id'
);
assert(
    /violationIndexFailed/.test(emptyRow),
    'a failed read and a genuinely empty collection are different problems; the ' +
    'message must not claim "none transferred" when the read never landed'
);
assert(
    /No reports have been transferred to HR yet\./.test(emptyRow) &&
    /you may not have access/.test(emptyRow),
    'both outcomes need their own message'
);
assert(
    /if \(!violationIndexLoaded\) \{ closeMentionMenu\(\); return; \}/.test(updateV),
    '⚠️ the empty state must be gated on the read having RESOLVED. ' +
    'syncViolationPicker() bails on `if (!els.mentionMenu.hidden) return;`, so ' +
    'rendering the empty state while the index is still loading would block the ' +
    'deferred render and strand the picker on "no reports" for the whole session'
);
assert(
    /pickerMode = null;/.test(updateV),
    'the empty state must leave pickerMode null so Enter falls through to sending'
);
assert(
    /violationIndexLoaded = true;/.test(src) && /violationIndexFailed = true;/.test(src),
    'the index exit paths must record that the read resolved'
);

// And the styling, so it reads as inert rather than as a broken row.
assert(
    /\.chat-mention-option\.is-empty \{/.test(chatCss),
    'the empty row must be styled so it does not look like a normal option'
);
assert(
    /\.chat-mention-option\.is-empty:hover[\s\S]{0,200}background: none;/.test(chatCss),
    'the empty row must opt out of the hover/active fill — it cannot be selected'
);
assert(
    /--text-secondary/.test(chatCss),
    'the empty row must colour from a token declared in BOTH style.css and ' +
    'theme.css, or it will stay stubbornly grey in dark mode'
);

// =====================================================================
//  THE ROLE GATE — CREATE ≠ CLICK
// =====================================================================
//
//  ⚠️ TWO QUESTIONS, TWO ALLOWLISTS, AND CONFLATING THEM IS HOW THIS
//  FEATURE BROKE — first one way, then the other.
//
//  MAY YOU CREATE A MENTION?  VIOLATION_MENTION_ROLES (hr + superadmin).
//  The @violation picker, the index read and the composer placeholder are
//  all gated on canMentionViolations(), and an Area Manager has no
//  unfiltered `violations` read to back a picker anyway.
//
//  MAY YOU CLICK A CHIP YOU SEE? VIOLATION_OPEN_ROLES (hr + superadmin +
//  owner). linkifyViolationRefs() is a PURE REGEX over the message text:
//  it needs no read, so its gate is the ONLY thing standing between a
//  reader and the chip. Gating it on canMentionViolations() hid the chip
//  from the AREA MANAGER specifically: when HR said "violation VIO-0007"
//  in the store chat, the manager saw plain text — nothing to click,
//  while everyone else got a working chip. What they may then OPEN is
//  enforced downstream (firestore.rules' managerStatus branch,
//  isMentionableViolation(), OwnerViolations.openModal), not by hiding
//  the link from them.
//
//  These assertions run the REAL linkifier and the REAL predicate, in a
//  sandbox whose only difference is `currentRole`.
// =====================================================================
console.log('\n=== CREATE: only HR + superadmin. CLICK: the Area Manager too ===');

const AM = loadHelpers('owner');

// 1. The allowlist itself. An allowlist, not a denylist, so a new or unknown
//    role cannot inherit the capability by accident.
assert.deepStrictEqual(
    Array.from(AM.VIOLATION_MENTION_ROLES).sort(),
    ['hr', 'superadmin'],
    'VIOLATION_MENTION_ROLES must be exactly HR + superadmin'
);
assert(
    !Array.from(AM.VIOLATION_MENTION_ROLES).includes('owner'),
    "the Area Manager's stored role 'owner' must NOT be able to mention a violation"
);

// 2. The gate itself, across the cases that matter.
assert.strictEqual(AM.canMentionViolations(), false, 'an Area Manager must be refused');
['owner', 'Owner', ' OWNER ', 'operator', '', 'nonsense', 'admin'].forEach((role) => {
    const ctx = loadHelpers(role);
    assert.strictEqual(
        ctx.canMentionViolations(), false,
        "role '" + role + "' must NOT be able to mention a violation — the list is an " +
        'allowlist, so an unknown role is refused rather than defaulting to allowed'
    );
});
['hr', 'HR', ' superadmin ', 'SuperAdmin'].forEach((role) => {
    const ctx = loadHelpers(role);
    assert.strictEqual(
        ctx.canMentionViolations(), true,
        "role '" + role + "' must still be able to mention a violation — this is a " +
        'feature REMOVAL for one role, not a break for everyone'
    );
});

// 3. ⚠️ THE ONE THAT MATTERS: the Area Manager MUST get the chip — that is
//    the bug being fixed. Every casing and separator real people type,
//    because they all have to be clickable in the store chat.
const AM_TEXT = 'please action violation VIO-0007';
assert.strictEqual(
    AM.canOpenViolations(), true,
    'an Area Manager must be able to CLICK a violation chip: without a chip there ' +
    'is nothing to click, and a violation mentioned in the store chat is invisible ' +
    'to the one person it concerns'
);
assert.deepStrictEqual(
    Array.from(AM.VIOLATION_OPEN_ROLES).sort(),
    ['hr', 'owner', 'rmsm', 'superadmin'],
    'VIOLATION_OPEN_ROLES must be HR + superadmin + Area Manager + RM/SM — RM/SM ' +
    'opens a violation MENTIONED in the store chat (no tab of its own)'
);
// RM/SM MUST get the chip: it has no violations tab, so a mentioned report is
// the ONLY way it ever reaches one. 'operator'/''/'nonsense' still must not —
// they can never open one, and the list is an allowlist.
{
    const RMSM = loadHelpers('rmsm');
    assert.strictEqual(RMSM.canOpenViolations(), true,
        "RM/SM ('rmsm') must be able to CLICK a violation chip — it has no tab, so a " +
        'chip is the only route to a report transferred to its store');
    assert.strictEqual(RMSM.canMentionViolations(), false,
        "RM/SM must still NOT be able to CREATE a mention — CREATE and CLICK differ");
}
['operator', '', 'nonsense'].forEach((role) => {
    const ctx = loadHelpers(role);
    assert.strictEqual(
        ctx.canOpenViolations(), false,
        "role '" + role + "' must NOT see a violation chip — they can never open one, " +
        'and the list is an allowlist so an unknown role cannot inherit it'
    );
});
[
    'please action violation VIO-0007',
    'VIOLATION vio-0007 please',
    'Violation: VIO-0007',
    'see violation #vio-0007 now',
    '@violation VIO-0007',
    '@violation VIO-0007 please action'
].forEach((text) => {
    assert(
        /chat-violation-chip/.test(AM.linkifyViolationRefs(text)),
        'an Area Manager must get a CLICKABLE chip. Input: ' + text
    );
    assert(
        /data-violation-ref=/.test(AM.linkifyViolationRefs(text)),
        'the chip must carry data-violation-ref so the delegated click handler fires. ' +
        'Input: ' + text
    );
});
// Proof by SOURCE that the gate consulted is the VIEW gate: a runtime pass
// cannot tell WHICH allowlist produced the chip.
const linkFlat = stripComments(src.slice(
    src.indexOf('function linkifyViolationRefs'),
    src.indexOf('//  PICKER TRIGGERS')
));
assert(
    /canOpenViolations\(\)/.test(linkFlat),
    'linkifyViolationRefs() must gate on canOpenViolations() — the VIEW allowlist'
);
assert(
    !/canMentionViolations\(\)/.test(linkFlat),
    'linkifyViolationRefs() must NOT gate on canMentionViolations() — that is the ' +
    'exact conflation that hid the chip from the Area Manager'
);

// 4. The predicate is ROLE-AWARE, mirroring the two INDEPENDENT handoffs in
//    firestore.rules: hrStatus gates HR/superadmin, managerStatus gates the
//    Area Manager. A report transferred to the wrong side must still refuse,
//    or the picker and resolver would offer a chip the rules then deny.
assert.strictEqual(
    AM.isMentionableViolation({ hrStatus: 'transferred', violationNumber: 'VIO-0007' }),
    false,
    "a report transferred to HR must stay unopenable for an Area Manager — the role's " +
    'OWN flag is what gates them, not the presence of any transfer'
);
assert.strictEqual(
    AM.isMentionableViolation({ managerStatus: 'transferred', violationNumber: 'VIO-0007' }),
    true,
    'a report transferred TO THE AREA MANAGER must resolve when they click it — ' +
    'this is the store-chat handoff the whole fix exists for'
);
assert.strictEqual(
    AM.isMentionableViolation({ managerStatus: 'pending', violationNumber: 'VIO-0007' }),
    false,
    'a report not yet transferred to the Area Manager must not resolve either'
);
const HR_CTX = loadHelpers('hr');
assert.strictEqual(
    HR_CTX.isMentionableViolation({ managerStatus: 'transferred', violationNumber: 'VIO-0007' }),
    false,
    'an HR viewer must NOT open a manager-only report — the two handoffs are ' +
    'independent, and isTransferredToHr() is what their read rule keys on'
);
// RM/SM keys on managerStatus, IDENTICAL to the Area Manager — it reads the same
// transferred-to-the-store set, and firestore.rules admits it via isRmsm().
const RMSM_CTX = loadHelpers('rmsm');
assert.strictEqual(
    RMSM_CTX.isMentionableViolation({ managerStatus: 'transferred', violationNumber: 'VIO-0007' }),
    true,
    'a report transferred to the store (managerStatus) must resolve for RM/SM — ' +
    'a chip is the only way it ever reaches a report'
);
assert.strictEqual(
    RMSM_CTX.isMentionableViolation({ hrStatus: 'transferred', violationNumber: 'VIO-0007' }),
    false,
    "an HR-only transfer (hrStatus) must stay unopenable for RM/SM — its read rule " +
    'keys on managerStatus via isRmsm(), not hrStatus'
);
assert.strictEqual(
    RMSM_CTX.isMentionableViolation({ managerStatus: 'pending', violationNumber: 'VIO-0007' }),
    false,
    'a report not yet transferred to the store must not resolve for RM/SM either'
);

// 4b. The RESOLVER must query the field the CLICKING role's rules admit.
//     Firestore refuses a query it cannot prove BEFORE it runs, so the wrong
//     shape is indistinguishable from "report missing" — which is exactly how
//     the Area Manager's chip used to die on click.
assert(
    /where\('managerStatus', '==', 'transferred'\)/.test(resolveFn),
    'the resolver must query managerStatus for the Area Manager — an owner running ' +
    'the hrStatus shape is DENIED by firestore.rules before it executes'
);
assert(
    /where\('hrStatus', '==', 'transferred'\)/.test(resolveFn),
    'the HR/superadmin query shape must be unchanged'
);
assert(
    /isMentionableViolation\(cached\)/.test(resolveFn),
    "the resolver's fast path must RE-CHECK the cached hit — the role can change " +
    'without a reload, and an index filled under one role must not answer another'
);

// 5. ⚠️ TICKETS ARE NOT AFFECTED. This is a violation-only change; an Area
//    Manager's own sign-off tickets must keep linkifying.
assert(
    !/canMentionViolations/.test(
        stripComments(src.slice(
            src.indexOf('function linkifyTicketRefs'),
            src.indexOf('// NOTE: the bare-word')
        ))
    ),
    'the TICKET linkifier must NOT be role-gated. A ticket is the Area Manager\'s own ' +
    'sign-off work — they have a whole tickets table for their branches — so @ticket ' +
    'stays open to every chat role. Only violations are restricted.'
);
const ticketChip = H.linkifyTicketRefs('see ticket BNW-TIX007');
assert(
    /data-ticket-ref/.test(ticketChip),
    'a ticket reference must STILL render as a chip — the restriction is violations ' +
    'only, and this is the assertion that proves it. Got: ' + ticketChip
);

// 6. The picker and the index must be gated too, not just the linkifier —
//    otherwise "@violation" still opens a menu and still fires a denied read.
const flat = stripComments(src);
assert(
    /function updateViolationMenu\(\)\s*\{[\s\S]{0,400}?if \(!canMentionViolations\(\)\) return;/.test(flat),
    'updateViolationMenu() must refuse to open for a role that cannot use it — otherwise ' +
    'an Area Manager is shown "No reports have been transferred to HR yet", a message ' +
    'written for HR, shown to someone who by design can never transfer anything'
);
assert(
    /function syncViolationPicker\(\)\s*\{[\s\S]{0,200}?if \(!canMentionViolations\(\)\) return;/.test(flat),
    'syncViolationPicker() must not even ATTEMPT the read — otherwise every "@violation" ' +
    'keystroke fires a guaranteed permission-error round trip'
);
assert(
    /function ensureViolationIndex\(\)\s*\{[\s\S]{0,400}?if \(!canMentionViolations\(\)\)/.test(flat),
    'ensureViolationIndex() must be the last line of defence and must settle its promise, ' +
    'or every caller awaiting it would hang'
);

// 7. The composer must not ADVERTISE the feature it just removed.
assert(
    /els\.input\.placeholder = canMentionViolations\(\)/.test(flat),
    'the composer placeholder must drop "@violation" for a role that cannot use it — an ' +
    'Area Manager was being told to type something that silently did nothing'
);

// 8. Lockstep with the tab that already enforces this. Two files, one rule.
const hrApplyRole = hrJs.slice(hrJs.indexOf('function applyRole'), hrJs.indexOf('function applyRole') + 400);
const hrAllows = (hrApplyRole.match(/role === '(\w+)'/g) || []).map((s) => s.replace(/role === '|'/g, ''));
assert.deepStrictEqual(
    Array.from(AM.VIOLATION_MENTION_ROLES).sort(),
    hrAllows.slice(0, 2).sort(),
    'VIOLATION_MENTION_ROLES must match applyRole() in js/hr-violations.js exactly — the ' +
    'chat picker and the Violations tab are the same rule in two files, and drift means a ' +
    'role can see the tab but not mention, or the reverse'
);

console.log('  PASS  CREATE gate: only HR + superadmin mention; no picker/index/placeholder for the Area Manager');
console.log('  PASS  CLICK gate: the Area Manager gets a real chip, resolving managerStatus reports only');
console.log('  PASS  the resolver queries the field the role\u2019s rules admit; the opener routes to OwnerViolations FIRST');
console.log('  PASS  HR and superadmin still work; the ticket linkifier is untouched');
console.log('  PASS  the chat list stays in lockstep with hr-violations.js applyRole()');

console.log('\nOK: chat violation mention tests passed');
console.log('(an "@violation VIO-0007" reference renders as a chip that swallows the ' +
    '"@" and opens that report; "@violation" is the ONLY picker trigger, because ' +
    'the bare word fired on ordinary prose; only TRANSFERRED reports are ' +
    'openable — hrStatus for HR/superadmin, managerStatus for the Area Manager — ' +
    'and every read is filtered, because an unfiltered violations query is ' +
    'denied for HR by design. The bare form still linkifies, so older messages ' +
    'keep their chip. CREATE ≠ CLICK: the Area Manager may not mention, but sees ' +
    'a clickable chip for reports transferred to them, opened through ' +
    'OwnerViolations.openModal — the chip that used to render as plain text.');
