// ===========================================================================
//  AREA MANAGER DASHBOARD — PHONE LAYER
//
//  What is being pinned, and why each one is a real failure mode rather than a
//  style preference:
//
//  1. THE TABLES BECOME CARDS — VIA THE SHARED MECHANISM. This page used to
//     carry its own private conversion (hide `thead`, blockify `tr`, label
//     every `td` from `attr(data-label)`) for two of its three tables; the
//     third never got it and no main.html table did. All NINE tables now go
//     through ONE mechanism: the trailing `approval-card-th` / 
//     `approval-card-cell` column plus the "ROW CARD SWAP" block in style.css,
//     at the same 899px breakpoint as the Approvals card. This test therefore
//     asserts the SHARED rules, and asserts that the one-off copy is GONE — a
//     leftover private rule would silently fork the design again.
//
//  2. ⚠️ THE `<th>` COUNT MUST EQUAL THE RENDERER'S `<td>` COUNT, and exactly
//     ONE cell may go unlabelled — the Actions cell. The counts are read from
//     the real files, never hardcoded: a hardcoded count only says the number
//     changed, not whether the change was right. The card cell is LAST and is
//     labelled `Card`, mirroring the Approvals table exactly.
//
//  3. THE EMPTY STATE IS NOT CAUGHT BY THE ACTIONS-HIDING RULE. It is the only
//     cell in its row — also `:last-child`, also without a `data-label` in
//     some tables — so the shared hide rule is gated on `:has(> 
//     .approval-card-cell)` and excludes `.empty-state` by class. Asserted on
//     both halves: the gate exists, and no `:last-child` / `:not([data-label])`
//     rule that would blank "No tickets found for your branches."
//
//  4. THE HEADER IS SCOPED, NOT GLOBAL. The overrides must beat the shared
//     main.html rules by specificity, not by being unscoped — an unscoped
//     `.header-left` here would silently reformat the command centre too.
//
// ===========================================================================
//  5. THE ACCESS DETAIL IS REAL TEXT INSIDE THE CARD. A phone has no hover, so
//     the closure date and the reopen reason have to render visibly in the
//     card's foot (`.approval-card .owner-access-note`), not in a `title`
//     attribute — and the card's Access block is gated on
//     `expiryAppliesToViewer()`, the same predicate that hides the desktop
//     Access column for HR and a superadmin.
//
//  Run: npm test
// ===========================================================================
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const ownerHtml = fs.readFileSync(path.join(ROOT, 'ownerdashboard.html'), 'utf8');
const ownerJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8');
const hrJs = fs.readFileSync(path.join(ROOT, 'js', 'hr-violations.js'), 'utf8');

/**
 * The phone layer, isolated.
 *
 * ⚠️ LOCATE IT IN THE RAW CSS, THEN STRIP COMMENTS — never the other way round.
 * The block's own header comment is what marks its start, so stripping first
 * deletes the marker and the slice silently becomes "from -1 to the end", which
 * is a large chunk of unrelated rules that happens to satisfy most assertions.
 * A test that passes for the wrong reason is worse than no test.
 */
const phoneBlock = css.slice(
    css.indexOf('AREA MANAGER DASHBOARD'),
    css.indexOf('.perm-chip {', css.indexOf('AREA MANAGER DASHBOARD'))
).replace(/\/\*[\s\S]*?\*\//g, '');

console.log('Testing the Area Manager dashboard phone layer...');

// ===========================================================================
console.log('\n=== The tables become CARDS via the SHARED row-card swap ===');
// ===========================================================================
{
    assert(phoneBlock.length > 500, 'the owner phone-layer block must exist in style.css');

    // The one mechanism, isolated by its marker comment — sliced BEFORE
    // stripping comments, exactly like phoneBlock above: the block's own
    // header is what marks its start, so stripping first deletes the marker
    // and the slice silently becomes "the rest of the file".
    const swapAt = css.indexOf('ROW CARD SWAP');
    assert(swapAt > -1, 'the shared ROW CARD SWAP block must exist in style.css');
    const swapBlock = css.slice(swapAt, css.indexOf('Extra-small phones', swapAt))
        .replace(/\/\*[\s\S]*?\*\//g, '');

    // Both owner tables opt in with the SAME class every other table uses.
    // Without it they would fall back to the horizontal swipe this replaced.
    ['ownerTicketsTable', 'hrViolationsTable', 'ownerViolationsTable'].forEach((id) => {
        assert(new RegExp('<table class="data-table row-card-table" id="' + id + '"').test(ownerHtml),
            '#' + id + ' must carry the row-card-table opt-in class — a table without it is ' +
            'untouched by the swap and swipes sideways on a phone again');
        const at = ownerHtml.indexOf('id="' + id + '"');
        const head = ownerHtml.slice(at, ownerHtml.indexOf('</thead>', at));
        assert(/<th class="approval-card-th"/.test(head),
            '#' + id + ' must declare the trailing card header cell');
    });

    assert(/\.row-card-table thead\s*\{\s*display:\s*none/.test(swapBlock),
        'the shared swap must hide thead of ANY .row-card-table — the column names then live ' +
        'inside each card. It must be `display: none`, not `visibility: hidden`: a screen ' +
        'reader must not read a header row that is not on screen.');
    assert(/\.row-card-table tbody tr\s*\{\s*display:\s*block/.test(swapBlock),
        'each row must become a block so it renders as its own card');

    // ⚠️ THE GATE. The hide rule must be conditional on the row actually
    // having a card cell, and must exclude the empty state by class. Both
    // halves are asserted because the failure is silent: group headers,
    // detail panels and "No tickets found for your branches." all sit in
    // rows without a card cell, and a blunt rule blanks them.
    assert(/\.row-card-table tbody tr:has\(> \.approval-card-cell\) > td:not\(\.approval-card-cell\):not\(\.empty-state\)\s*\{\s*display:\s*none/.test(swapBlock),
        'data cells must hide only in rows that carry a card, and never the empty state — the ' +
        'gate is `:has(> .approval-card-cell)` plus an explicit `:not(.empty-state)`');
    assert(/\.row-card-table tbody td\.approval-card-cell\s*\{\s*display:\s*block/.test(swapBlock),
        'the card cell itself must be shown as a block');
    assert(/\.table-container:has\(\.row-card-table\)\s*\{[^}]*overflow-x:\s*visible/.test(swapBlock),
        'the container must stop inviting a dead horizontal swipe once the rows are cards');
    assert(/\.row-card-table tbody tr\.user-detail-gap\s*\{\s*display:\s*none/.test(swapBlock),
        'the zero-height spacer row between users only makes sense in the table layout');

    // ⚠️ THE ONE-OFF IS GONE. These are the selectors that used to exist only
    // for the owner page; any of them coming back forks the design away from
    // the shared swap and silently stops covering #ownerViolationsTable.
    // Comments are STRIPPED first: several of the tombstones left in
    // style.css quote the old rule to say where it went, and a raw match
    // would fail on the documentation rather than on a live rule.
    const cssStripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/#ownerTicketsTable thead\s*\{/.test(cssStripped),
        'the private `#ownerTicketsTable thead` rule must be gone — thead hiding is shared now');
    assert(!/#ownerTicketsTable tbody td::before/.test(cssStripped),
        'the private `attr(data-label)` labelling must be gone — the card replaces it');
    assert(!/#ownerTicketsTable tbody td:not\(\[data-label\]\)/.test(cssStripped),
        'the private Actions-hiding rule must be gone — the shared `:has()` gate replaces it');
    assert(!/#ownerMainContent \.table-container\s*\{[^}]*overflow-x:\s*visible/.test(cssStripped),
        'the private container rule must be gone — `.table-container:has(.row-card-table)` ' +
        'replaces it and covers main.html too');
    console.log('  PASS  the shared ROW CARD SWAP drives the card layout; the one-off is gone');

    // -----------------------------------------------------------------------
    // 2. THE <td> COUNT MUST MATCH THE <th> COUNT.
    //
    // Both sides are read from the real files, never a hardcoded number: a
    // hardcoded count only says the number changed, not whether the change was
    // right. The headers come from the markup, the cells from the renderer, and
    // they must agree — with exactly one documented unlabelled exception.
    // -----------------------------------------------------------------------
    const countTable = (label, theadSrc, rowSrc) => {
        const th = (theadSrc.match(/<th[\s>]/g) || []).length;
        const td = (rowSrc.match(/<td[\s>]/g) || []).length;
        const bare = (rowSrc.match(/<td(?![^>]*data-label)[^>]*>/g) || []).length;

        assert(td > 0, label + ': found no <td> in the row renderer — the slice markers have ' +
            'drifted, so this test would pass vacuously');
        assert.strictEqual(td, th,
            label + ': the renderer emits ' + td + ' cells but the <thead> declares ' + th +
            ' headers. The card cell must be counted on BOTH sides or a phone renders a card ' +
            'under a header row that never mentioned it.');
        assert.strictEqual(bare, 1,
            label + ': exactly ONE cell may go unlabelled — the Actions cell, a button with ' +
            'nothing to name. Found ' + bare + ' unlabelled cells.');
        return { th, td, bare };
    };

    const sliceBetween = (src, start, end) => {
        const a = src.indexOf(start);
        const b = src.indexOf(end, a);
        assert(a > -1 && b > a, 'could not isolate the slice starting ' + start.slice(0, 40));
        return src.slice(a, b);
    };

    const ownerHead = sliceBetween(ownerHtml, 'id="ownerTicketsTable"', '</thead>');
    // Sliced to the map's own close so the empty-state rows — which carry a
    // colspan and no data-label — cannot contaminate the count.
    const ownerRow = sliceBetween(
        ownerJs, 'ownerTicketsBody.innerHTML = tickets.map((t) => {', '}).join(\'\');');
    const ownerCols = countTable('owner tickets', ownerHead, ownerRow);

    const hrHead = sliceBetween(ownerHtml, 'id="hrViolationsTable"', '</thead>');
    const hrRow = sliceBetween(hrJs, 'tableBody.innerHTML = rows.map(v => {', '}).join(\'\');');
    const hrCols = countTable('HR violations', hrHead, hrRow);

    // The LAST cell must be the CARD cell, and it must be labelled — it is
    // the only cell a phone renders, so a missing or unlabelled one IS the
    // whole row. The single bare cell (Actions) therefore sits earlier in the
    // row, which is exactly what countTable() just enforced.
    const lastCell = (src) => {
        const at = src.lastIndexOf('<td');
        return src.slice(at, src.indexOf('>', at) + 1);
    };
    assert(/class="approval-card-cell" data-label="Card"/.test(lastCell(ownerRow)),
        'the owner row\'s LAST cell must be the labelled card cell');
    assert(/class="approval-card-cell" data-label="Card"/.test(lastCell(hrRow)),
        'the HR row\'s LAST cell must be the labelled card cell');
    assert(/class="approval-card"/.test(ownerRow) && /class="approval-card"/.test(hrRow),
        'both rows must emit the shared card markup, mirroring the Approvals card');

    console.log('  PASS  owner tickets: ' + ownerCols.th + ' headers / ' + ownerCols.td +
        ' cells, 1 unlabelled (Actions), card cell last');
    console.log('  PASS  HR violations: ' + hrCols.th + ' headers / ' + hrCols.td +
        ' cells, 1 unlabelled (Actions), card cell last');

    // -----------------------------------------------------------------------
    // 3. THE ACCESS COLUMN EXISTS, AND ITS DETAIL IS REAL TEXT.
    //
    // ⚠️ A `title` attribute is not a fallback. A phone has no hover, so a
    // manager reading this list on the device it is actually built for saw a
    // bare "Expired" and could not learn when it closed or why they asked to
    // reopen. These fail if the detail is ever moved back into a tooltip.
    // -----------------------------------------------------------------------
    assert(/<th>\s*Access\s*<\/th>/.test(ownerHead),
        'the tickets table needs its own Access header. Status (where is this in the ' +
        'pipeline) and Access (can this person still open it) are different questions.');
    assert(/<td data-label="Access">/.test(ownerRow),
        'the Access cell must carry data-label="Access", or it renders unlabelled on a phone');
    assert(/Expired<\/span>/.test(ownerRow),
        'the closed state must be VISIBLE TEXT reading "Expired" INSIDE the badge span, ' +
        'not a title attribute — a phone has no hover, so a tooltip is invisible there');
    // ⚠️ "Expired" HERE IS ABOUT THE VIEWING WINDOW, NOT THE TICKET. The word was
    // changed to "Expired" on request to match the shared .status-badge.expired
    // class; the Access column heading (and the .owner-access-note beneath the
    // badge, which names the closure date) are what disambiguate it — the ticket
    // itself is still listed, only its report and evidence are withheld.
    assert(/owner-access-note/.test(ownerRow),
        'the closure date and the reopen reason must render as real text (.owner-access-note) — ' +
        'they are unreachable on a touch device');
    assert(/escapeHTML\(reopen\.reason\)/.test(ownerRow) &&
        /escapeHTML\(formatDate\(expiresAt\)\)/.test(ownerRow),
        'the reopen reason and the expiry date carry user-influenced text and must be escaped');

    // Visible inside the phone card, hidden in the desktop table. The gate is
    // what makes this safe: `.owner-access-note` is display:none everywhere by
    // default, and only `.approval-card .owner-access-note` (the card styles,
    // live under 900px) re-enables it — so the desktop Access cell stays one
    // line per row while the card prints the detail as real text.
    assert(/\.owner-access-note\s*\{[^}]*display:\s*none/.test(css),
        '.owner-access-note must be display:none by default — the desktop table has to stay one ' +
        'line per row');
    assert(/\.approval-card \.owner-access-note\s*\{[^}]*display:\s*block/.test(css),
        '.owner-access-note must be display:block INSIDE a card. Without this the detail is ' +
        'in the DOM but the manager never sees it, which is the bug this column exists to fix.');

    // ⚠️ THE CARD'S ACCESS BLOCK IS GATED ON THE VIEWER, exactly like the
    // desktop column (hidden for HR/superadmin via .owner-hides-access). The
    // card has no column position to hide, so the predicate has to be in the
    // renderer — otherwise a role with no viewing window is shown an Access
    // section that means nothing to them.
    assert(/expiryAppliesToViewer\(\)[\s\S]{0,400}approval-card-expiry/.test(ownerRow),
        'the card\'s Access block must be gated on expiryAppliesToViewer() — the same predicate ' +
        'that hides the desktop Access column for a role with no window');
    console.log('  PASS  Access is its own column; its detail is visible text, not a tooltip');
}

// ===========================================================================
console.log('\n=== The ticket card mirrors the row (nothing dropped, nothing doubled) ===');
// ===========================================================================
// WHAT REPLACED WHAT. The old private card turned all EIGHT columns into
// label/value pairs (an eight-line block per ticket) and then hid three of
// them by selector. The shared card lays the same facts out once — head =
// ticket + status pill, grid = branch/reporter/date/incident, foot = access
// + the eye — and the desktop cells simply hide behind the shared
// `:has(> .approval-card-cell)` gate. These assertions fail if the card ever
// loses a field the desktop row shows, or if the one-off hiding rules creep
// back in beside the shared mechanism.
{
    // Re-sliced here on purpose: the slice in the block above is `const`-scoped
    // to that block, and this section must fail on its own markers rather than
    // silently reuse a variable it cannot see.
    const ownerRowAt = ownerJs.indexOf('ownerTicketsBody.innerHTML = tickets.map((t) => {');
    assert(ownerRowAt > -1, 'renderOwnerTickets() row marker not found in owner-dashboard.js');
    const ownerRow = ownerJs.slice(ownerRowAt, ownerJs.indexOf('}).join(\'\');', ownerRowAt));
    const cardAt = ownerRow.indexOf('class="approval-card-cell"');
    assert(cardAt > -1, 'the owner row must emit the trailing card cell');
    const card = ownerRow.slice(cardAt);

    // The card head: the identifier and the self-labelling status pill.
    assert(/approval-card-branch[\s\S]*?ticketNumber/.test(card),
        'the card head must carry the ticket number — it is the only thing that says which ' +
        'row this is once the desktop Ticket cell is hidden');
    assert(/approval-card-pill approval-card-pill--/.test(card),
        'the card head must carry the status pill; the badges are self-labelling, so no ' +
        '"Status:" label line is needed');

    // The four grid fields mirror the four desktop data columns a phone
    // would otherwise lose: Branch, Reporter, Date Created, Incident.
    ['Branch', 'Reporter', 'Date Created', 'Incident'].forEach((label) => {
        assert(new RegExp('approval-card-label">' + label + '<').test(card),
            'the card must print the ' + label + ' field — its column is hidden on a phone, ' +
            'so dropping it from the card loses it entirely');
    });

    // ⚠️ Branch must NOT be dropped. A manager may own several branches, so
    // "which branch is this ticket at" is real information, not filler.
    assert(/approval-card-value">\$\{escapeHTML\(t\.branchName\)\}/.test(card),
        'the Branch field must render the real branch name');

    // The incident stays visible — it is what says "you are looking at the
    // right ticket" — but as an ellipsised value, not a wrapped paragraph
    // that makes every card four lines taller.
    assert(/\.approval-card-value\s*\{[^}]*text-overflow:\s*ellipsis/.test(css),
        'the shared .approval-card-value must ellipsis — a long incident wrapping to four ' +
        'lines is exactly what made the old label/value card tall');

    // The card foot is the ONLY surface for actions and access detail on a
    // phone (the desktop Actions and Access cells are hidden). NOTE: the foot
    // markup is built in a `cardFoot` variable that appears BEFORE the `<td>`
    // in source and is interpolated as `${cardFoot}`, so these must match
    // against the whole row slice — a slice from the td would only see the
    // interpolation, not the markup.
    assert(/approval-card-foot[\s\S]*?approval-card-actions/.test(ownerRow),
        'the card foot must carry the actions — on a phone the desktop Actions cell is ' +
        'hidden, so nothing else exposes View');
    // The note is assembled into `accessNote` (with literal owner-access-note
    // divs) earlier in the callback, then interpolated into the expiry block —
    // so in source the class precedes `approval-card-foot`. Assert the wiring
    // in BOTH directions rather than one ordered run that can never match.
    assert(/class="owner-access-note"/.test(ownerRow),
        'the access note must be rendered as a real .owner-access-note element — a phone ' +
        'has no hover, so a title attribute alone leaves a bare unexplained word');
    assert(/approval-card-expiry[\s\S]{0,300}\$\{accessNote\}/.test(ownerRow),
        'the access note must be interpolated INTO the card foot\'s Access block, not left ' +
        'only in the hidden desktop cell');

    // ⚠️ THE EMPTY STATE MUST SURVIVE. The trap is `:last-child`: the
    // empty-state row's single colspan cell is also a last child, so a rule
    // written to hide the Actions cell would blank "No tickets found for your
    // branches." and leave an empty bordered card. The shared gate excludes
    // `.empty-state` by class (asserted above); here we pin the other half —
    // nothing anywhere may hide the tail cell outright.
    assert(
        !/#ownerTicketsTable tbody td:last-child\s*\{[^}]*display:\s*none/.test(css),
        'no rule may hide the tickets table\'s :last-child outright — that cell is the empty ' +
        'state as often as it is Actions'
    );
    console.log('  PASS  the card mirrors every desktop field, with actions + access in the foot');
    console.log('  PASS  hiding the Actions cell cannot hide the empty state');
}

// ===========================================================================
console.log('\n=== KPI row, branch list, and touch targets ===');
// ===========================================================================
{
    assert(/#ownerMainContent \.owner-summary-grid\s*\{[^}]*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(phoneBlock),
        'the four KPI cards must be TWO-up on a phone, not one per row — four full-width ' +
        'blocks before any real content. Note minmax(0, 1fr), not 1fr: a 1fr track is floored ' +
        'at min-content, so a long label like "Total Monthly Reports" refuses to shrink and ' +
        'blows the grid into unequal columns.');
    assert(/#ownerMainContent \.owner-summary-grid \.card\s*\{[^}]*flex-direction:\s*column/.test(phoneBlock),
        'the KPI icon must go ABOVE the text. Side-by-side, a 173px card has to fit a 34px ' +
        'icon, a 12px gap and 24px of padding, leaving ~100px for a two-word label — which ' +
        'wraps to three lines and gives the four cards four different heights.');
    assert(/#ownerMainContent \.owner-branch-list\s*\{[^}]*minmax\(150px,\s*1fr\)/.test(phoneBlock),
        'the branch list must fit two per row (150px floor, so "SM Fairview" does not truncate)');

    // 44px is the WCAG 2.5.5 / iOS HIG minimum touch target.
    const touch = phoneBlock.match(
        /#ownerMainContent \.header-actions \.btn,[\s\S]*?\{([^}]*)\}/);
    assert(touch, 'the header touch-target rule must exist');
    assert(/min-height:\s*44px/.test(touch[1]) && /min-width:\s*44px/.test(touch[1]),
        'the header buttons, the theme toggle and the hamburger must be at least 44x44. ' +
        'They were sized for a mouse. Found: ' + touch[1]);

    // Clickable rows gave no feedback at all — no cursor, and on touch no hover.
    assert(/#ownerTicketsTable tbody tr:active/.test(phoneBlock),
        'a tappable row needs :active feedback. These rows open the report on click and had ' +
        'no cursor:pointer anywhere, so on a phone a pressable row and a static one were ' +
        'indistinguishable.');
    console.log('  PASS  KPI cards are two-up with the icon above the text');
    console.log('  PASS  branch list fits two per row; header targets are >= 44x44');
    console.log('  PASS  clickable rows have :active feedback');
}

// ===========================================================================
console.log('\n=== The container stops inviting a swipe that does nothing ===');
// ===========================================================================
{
    assert(/\.table-container:has\(\.row-card-table\)\s*\{[^}]*overflow-x:\s*visible/.test(css),
        'once the rows are cards there is nothing left to scroll sideways, and the shared ' +
        '`overflow-x: auto` invites a swipe that goes nowhere — which reads as a broken ' +
        'page. The container border and fill go too, so a second box is not drawn. The rule ' +
        'is the shared `.table-container:has(.row-card-table)`, not an owner-only copy.');

    // ⚠️ The comment-balance guard, carried over from the ticket form. A block
    // comment with no opener makes the parser swallow every rule up to the next
    // `{` — the rules still look right in the source and are silently never
    // applied. That is not hypothetical: it shipped once already.
    let depth = 0;
    for (let i = 0; i < css.length; i++) {
        if (css[i] === '/' && css[i + 1] === '*') { depth++; i += 2; }
        else if (css[i] === '*' && css[i + 1] === '/') { depth--; i += 2; }
    }
    assert.strictEqual(depth, 0,
        'style.css has ' + depth + ' unterminated block comment(s). An unterminated comment ' +
        'makes the parser swallow every rule until the next `{` — the rules still look ' +
        'correct in the source but are silently never applied.');
    console.log('  PASS  the table container no longer invites a dead horizontal swipe');
    console.log('  PASS  every block comment in style.css is closed');
}

console.log('\n× Owner dashboard phone layer tests passed (all THREE owner tables render as cards ' +
    'on a phone via the shared row-card swap, with the th/td counts checked against the real ' +
    'markup so an unlabelled cell cannot be added silently, and the private one-off conversion ' +
    'asserted GONE so the design cannot fork again; the card mirrors every desktop field with ' +
    'actions and the access note as visible text in the foot, gated on the same viewer ' +
    'predicate that hides the desktop Access column; the empty state is not mistaken for the ' +
    'Actions cell; the header is two rows and every selector in the owner block is scoped to ' +
    '#ownerMainContent so main.html cannot be affected; four KPI cards go two-up with ' +
    'minmax(0,1fr) so a long label cannot blow out the grid; header targets are 44x44 and ' +
    'clickable rows have active feedback; and the CSS comment-balance guard is kept, ' +
    'because a missing comment opener once deleted a whole block of rules in silence).');
