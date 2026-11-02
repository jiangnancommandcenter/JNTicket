// Functional test for the Command Center (superadmin/operator) Tickets tab
// DATE search.
//
// The Tickets "Date Created" column shows formatDateTime() → "Oct 10, 2026,
// 10:53 AM". The search bar must match a ticket by that date however it is
// typed ("Oct 10, 2026", "oct 10", "10/10/2026", "2026-10-10"). dateSearchTokens()
// seeds those representations and filterTickets() folds them into the haystack.
//
// (The Owner dashboard uses a different column format — "10/10/2026" — and has
// its own dateSearchTokens; this file is only the Command Center side.)
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

console.log('Testing Command Center Tickets date search...');

// Extract dateSearchTokens() and run it against fixtures.
const fnSrc = (src.match(/function dateSearchTokens\(value\)\s*\{[\s\S]*?\n\}/) || [''])[0];
assert(fnSrc, 'dateSearchTokens() not found in script.js');
const sb = { console, isNaN, Date, String };
vm.createContext(sb);
vm.runInContext(fnSrc, sb);
const dateSearchTokens = sb.dateSearchTokens;

// A Firestore Timestamp-like value (has .toDate()).
const ts = (iso) => ({ toDate: () => new Date(iso) });

// 1. The superadmin display format ("Oct 10, 2026") is searchable, plus the
//    numeric and ISO fallbacks.
const tokens = dateSearchTokens(ts('2026-10-10T10:53:00'));
const hay = tokens.join(' ').toLowerCase();
assert(hay.indexOf('oct 10, 2026') > -1,
    'the month-short column format must be searchable — got ' + JSON.stringify(tokens));
assert(hay.indexOf('10/10/2026') > -1, 'the numeric format must be searchable — got ' + JSON.stringify(tokens));
assert(hay.indexOf('2026-10-10') > -1, 'the ISO format must be searchable — got ' + JSON.stringify(tokens));

// 2. A plain Date and an ISO string both resolve to the same tokens.
assert(
    dateSearchTokens(new Date('2026-10-10T10:53:00')).join(' ').toLowerCase().indexOf('oct 10, 2026') > -1,
    'a plain Date must work'
);
assert(
    dateSearchTokens('2026-10-10T10:53:00').join(' ').toLowerCase().indexOf('oct 10, 2026') > -1,
    'an ISO string must work'
);

// 3. Missing / invalid → [] (never throws, never a bogus token).
//    NOTE: the function runs in a vm sandbox, so it returns a SANDBOX-realm
//    Array — deepStrictEqual would fail on the prototype. Compare length.
assert.strictEqual(dateSearchTokens(null).length, 0, 'null → []');
assert.strictEqual(dateSearchTokens(undefined).length, 0, 'undefined → []');
assert.strictEqual(dateSearchTokens('').length, 0, 'empty string → []');
assert.strictEqual(dateSearchTokens('not a date').length, 0, 'unparseable → []');

// 4. filterTickets() must fold the date tokens into the searchable haystack,
//    so the Tickets search bar actually filters by Date Created.
assert(
    /\.\.\.dateSearchTokens\(ticket\.createdAt\)/.test(src),
    'filterTickets() must spread dateSearchTokens(ticket.createdAt) into the search haystack'
);

console.log('✅ Command Center Tickets date-search tests passed (Date Created searchable in the ' +
    'superadmin month-short format + numeric + ISO; missing/invalid dates degrade to no match).');
