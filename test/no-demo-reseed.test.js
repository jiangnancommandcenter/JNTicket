// ===========================================================================
//  DELETED DATA MUST NOT COME BACK  (regression)
//
//  TWO AUTO-SEEDERS, ONE BUG. Both list renderers re-created the exact
//  documents you had just deleted, on every page load, the moment their
//  collection came back empty.
//
//  1. TICKETS. `loadTicketsDirect()` read:
//
//      const tickets = await firestoreService.getTickets();
//      if (tickets.length > 0) { allTickets = tickets; ... }
//      else { await seedSampleTickets(); }      // <-- writes two demo tickets
//
//      `seedSampleTickets()` created "Tip Pocketing" (Juan Dela Cruz) and
//      "Overcharge Discrepancy" (Maria Santos), both `status: 'Pending'`.
//      Delete the last ticket and the next page load re-created two PENDING
//      tickets. The write succeeded — the app was recreating it. Superadmins
//      could never clear the list, and a project reset could never look clean.
//
//  ⚠️ THE CATCH BRANCH DID IT TOO. On ANY error reading tickets — a dropped
//  connection, a permission hiccup — the handler also called
//  `seedSampleTickets()`. A network blip wrote two tickets into production.
//  Removing the seed from the happy path but leaving it in the catch would
//  have fixed the common case and kept the worse one, so both are pinned.
//
//  ⚠️ SCOPE — TICKETS ONLY. `loadBranchData()` has the same shape of bug: it
//  auto-seeds 21 hardcoded branches and ~20 fabricated status logs whenever the
//  branch list is empty. That is real, and it was confirmed here — but the fix
//  was reverted on request, so it is deliberately NOT pinned by this file. If
//  it is ever fixed again, the assertions to add are listed at the bottom.
//
//  These are text assertions, because that is what a static check can honestly
//  claim. They cannot prove a Firestore write did not happen; they prove the
//  code that made it is gone and has not returned under another name.
//
//  Run: npm test
// ===========================================================================
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

console.log('Testing that deleted tickets stay deleted...');

/**
 * Pull out a function's body by brace matching.
 *
 * ⚠️ Match the braces; do not slice to the next blank line. These functions
 * contain nested blocks, so any heuristic that stops at the first "}" or the
 * next blank line returns a fragment — and a fragment is exactly what makes a
 * test pass for the wrong reason.
 */
function extractFunction(src, name) {
    const start = src.search(new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`));
    assert(start !== -1, `${name}() must exist in script.js`);
    let depth = 0, seen = false;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') { depth++; seen = true; }
        else if (src[i] === '}') {
            depth--;
            if (seen && depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`unbalanced braces while extracting ${name}()`);
}

// ===========================================================================
console.log('\n=== the demo-ticket seeder is GONE ===');
// ===========================================================================
{
    assert(!/function\s+seedSampleTickets\s*\(/.test(script),
        'seedSampleTickets() is back. It writes two hardcoded demo tickets with ' +
        "status 'Pending' whenever the tickets collection comes back empty, which " +
        'is how deleted tickets started reappearing on every page load.');

    // Not just the definition — any call at all, from any path.
    assert(!/seedSampleTickets\s*\(/.test(script),
        'something still calls seedSampleTickets(). The definition being gone is not ' +
        'the requirement; the WRITE is. Check for a surviving call in the load path ' +
        'or in a catch handler.');

    // The demo data itself, by its distinctive strings. These are the payloads
    // that actually reached production, so assert them individually — a renamed
    // function reusing the same literals would still be caught.
    ['Juan Dela Cruz', 'Tip Pocketing', 'Maria Santos', 'Overcharge Discrepancy']
        .forEach(s => {
            assert(!script.includes(s),
                `demo ticket literal ${JSON.stringify(s)} is back in script.js. ` +
                'Demo data belongs in scripts/seed.js, which is run deliberately.');
        });
}
// ===========================================================================
console.log('\n=== the load path WRITES nothing ===');
// ===========================================================================
{
    const body = extractFunction(script, 'loadTicketsDirect');

    assert(!/if\s*\(\s*tickets\.length\s*>\s*0\s*\)/.test(body),
        'loadTicketsDirect() still branches on `tickets.length > 0`. That branch ' +
        'existed solely to decide whether to seed: empty -> write demo tickets. An ' +
        'empty collection is a legitimate state and must render as-is.');

    // ⚠️ ALLOWLIST, NOT A DENYLIST. A denylist of mutators (`.set(`/`.add(`/
    // `.setTicket(`) is MISSED BY THE ACTUAL BUG: the old code's write was
    // buried inside the seeder, so nothing inside this function matched a
    // mutator name and the guard passed on the broken code. Assert the other
    // way round — every firestoreService call in a READ path must be a known
    // read — so a new write shows up as "unexpected method" whatever it is
    // named. Adding a read method here is a deliberate, reviewable act.
    const READ_ONLY = ['getTickets', 'getBranches', 'getAllLogs'];
    const calls = [...body.matchAll(/firestoreService\.(\w+)\s*\(/g)].map(m => m[1]);
    const unexpected = calls.filter(c => !READ_ONLY.includes(c));
    assert.strictEqual(unexpected.length, 0,
        `loadTicketsDirect() calls firestoreService.${unexpected.join('(), firestoreService.')}` +
        `() — not a known read. It is a READ path: it loads the ticket list and renders ` +
        `it. Any write here means loading the page can mutate the database, which is how a ` +
        `network error used to create tickets. If you added a legitimate read, add it to ` +
        `READ_ONLY in this test.`);

    // A failed read is NOT an empty database. The old catch handler treated it as
    // one and seeded, which is how two demo tickets reached production by a
    // dropped connection. NOT re-checked here: a function-local `catch … seed`
    // regex needs a precedence-safe group AND then trips over the word "seeder"
    // in this file's own comments — it failed on correct code, which is worse
    // than no check. The whole-file `seedSampleTickets\s*\(` assertion above already
    // covers this branch, because a call inside catch is still a call.

    // The old code could leave this `true` whenever the list came back empty,
    // which flipped `isInitialTicketLoad || allTickets.length === 0` above it
    // onto its other branch precisely when there was nothing to show.
    const flagWrites = (body.match(/isInitialTicketLoad\s*=\s*false/g) || []).length;
    assert.strictEqual(flagWrites, 1,
        `isInitialTicketLoad = false must be assigned exactly once, on the single ` +
        `unconditional path. Found ${flagWrites} assignment(s) — more than one means ` +
        `it is again nested inside a "did we find any tickets?" branch.`);

    assert(!/if\s*\([^)]*\)\s*\{[^}]*isInitialTicketLoad\s*=\s*false/.test(body),
        'isInitialTicketLoad = false must NOT sit inside a conditional. It used to ' +
        'be set only in the branches that found at least one ticket, so an empty ' +
        'collection left it true and the guard above it took the wrong branch.');
}

// ===========================================================================
console.log('\n=== an empty list still renders properly ===');
// ===========================================================================
{
    // Removing the seeding means the empty state is now a state the app will
    // actually reach in normal use, so pin that it is handled rather than
    // assuming it still works.
    assert(/No tickets found/.test(script),
        'the "No tickets found." empty state must remain. With the auto-seed gone, ' +
        'an empty collection is expected on a fresh project or after a reset — the ' +
        'list must say so instead of rendering nothing.');
}

console.log('\n× Deletion-sticks tests passed (seedSampleTickets() no longer exists and is ' +
    'called from nowhere; the demo ticket literals are gone from the app; every ' +
    'firestoreService call in the ticket load path is an allowlisted READ so neither the ' +
    'happy path nor the error branch can write; isInitialTicketLoad is cleared on a single ' +
    'unconditional path; and the "No tickets found" empty state is still in place for the ' +
    'now-reachable empty collection). NOTE: the equivalent branch auto-seeder is still ' +
    'present and is deliberately NOT covered by this file.');