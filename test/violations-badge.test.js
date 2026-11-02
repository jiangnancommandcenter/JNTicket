// Functional test for the Violations sidebar badge ("unseen reports").
//
// The badge must mean "reports THIS user has not opened yet".
//
// History of this feature (all three states were wrong at some point):
//   1. It counted a rolling 24h window  -> never cleared, so it looked
//      like a permanent "new report" alert.
//   2. It cleared on TAB open           -> wrong, because operators and
//      superadmins SHARE that tab, so opening it is not the same as
//      having read the reports.
//   3. (current) It clears per REPORT, when the report is actually opened
//      via openViolationModal().
//
// The helper block is extracted from script.js (browser globals stubbed) so
// the logic runs in plain Node. Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

const start = src.indexOf('//  VIOLATIONS SIDEBAR BADGE');
assert(start > -1, 'violations badge block not found in script.js');
const blockStart = src.lastIndexOf('// ====', start);
const end = src.indexOf('function populateViolationStoreFilter', start);
assert(end > blockStart, 'end of violations badge block not found in script.js');
const blockSrc = src.slice(blockStart, end);

console.log('Testing violations badge (unseen reports)...');

// Reports are identified by their Firestore document id, exactly like the
// real listener payload. createdAt plays no part in this model.
const VIO = (id) => ({ id: id, violationNumber: 'VIO-' + id.slice(-4) });

// Minimal DOM/globals the extracted block touches.
let badge = { textContent: '', style: { display: 'inline' } };
const storage = {};

const sandbox = {
    console,
    violationsBadge: badge,
    allViolations: [],
    auth: { currentUser: { email: 'admin@example.com' } },
    localStorage: {
        getItem: (k) => (k in storage ? storage[k] : null),
        setItem: (k, v) => { storage[k] = String(v); },
        removeItem: (k) => { delete storage[k]; }
    },
    document: { getElementById: () => null },
    window: { normalizeUserEmail: (v) => String(v || '').trim().toLowerCase() }
};
vm.createContext(sandbox);
vm.runInContext(blockSrc, sandbox);

const {
    loadViolationsSeen,
    markViolationSeen,
    updateViolationsBadge,
    isViolationUnseen
} = sandbox;

const KEY = 'rcms_violations_seen_admin@example.com';

// 1. A fresh user has read nothing, so every report is unseen.
delete storage[KEY];
sandbox.allViolations = [VIO('a1'), VIO('b2'), VIO('c3')];
badge.style.display = 'inline';
loadViolationsSeen();
updateViolationsBadge();
assert.strictEqual(badge.textContent, '3', 'every unread report must be counted, got: ' + badge.textContent);
assert.strictEqual(badge.style.display, 'inline', 'the badge must show when reports are unread');

// 2. Opening ONE report clears only that one — not the others.
markViolationSeen('a1');
updateViolationsBadge();
assert.strictEqual(
    badge.textContent,
    '2',
    'opening one report must clear exactly one, got: ' + badge.textContent
);
assert.strictEqual(isViolationUnseen(VIO('a1')), false, 'the opened report must count as seen');
assert.strictEqual(isViolationUnseen(VIO('b2')), true, 'the other reports must stay unseen');

// 3. THE KEY REQUIREMENT: merely being on the tab must NOT clear anything.
//    There is deliberately no tab-active check any more — the badge does
//    not care which tab is visible, only which reports were opened.
updateViolationsBadge();
assert.strictEqual(
    badge.textContent,
    '2',
    'the badge must NOT clear just because the Violations tab is open, got: ' + badge.textContent
);
assert.strictEqual(
    badge.style.display,
    'inline',
    'the badge must stay visible while the Violations tab is open'
);

// 4. Opening the rest clears the badge entirely.
markViolationSeen('b2');
markViolationSeen('c3');
updateViolationsBadge();
assert.strictEqual(badge.textContent, '0', 'opening every report must bring the count to 0');
assert.strictEqual(badge.style.display, 'none', 'the badge must hide once everything is read');

// 5. A NEW report raises it again — that is the whole point of the badge.
sandbox.allViolations = [VIO('a1'), VIO('b2'), VIO('c3'), VIO('d4')];
updateViolationsBadge();
assert.strictEqual(badge.textContent, '1', 'a brand-new report must be counted as unseen');
assert.strictEqual(badge.style.display, 'inline', 'a brand-new report must re-show the badge');

// 6. Re-opening an already-seen report must not double-count or go negative.
markViolationSeen('a1');
markViolationSeen('a1');
updateViolationsBadge();
assert.strictEqual(badge.textContent, '1', 're-opening a seen report must not change the count');

// 7. The seen ids persist per user, so a reload keeps the badge cleared.
const persisted = JSON.parse(storage[KEY]);
assert.ok(Array.isArray(persisted), 'the persisted value must be an array of ids, got: ' + storage[KEY]);
assert(persisted.indexOf('a1') > -1, 'a1 must be persisted as seen');
sandbox.allViolations = [VIO('a1'), VIO('b2'), VIO('c3'), VIO('d4')];
loadViolationsSeen();
updateViolationsBadge();
assert.strictEqual(
    badge.textContent,
    '1',
    'after a reload only the report never opened may still be unseen, got: ' + badge.textContent
);

// 8. A legacy value (an older build stored a plain timestamp here) must be
//    discarded rather than throwing or silently marking everything seen.
storage[KEY] = '1750000000000';
loadViolationsSeen();
updateViolationsBadge();
assert.strictEqual(
    badge.textContent,
    '4',
    'a legacy timestamp value must be ignored, counting everything as unseen'
);

// 9. Corrupt JSON must not throw.
storage[KEY] = '{not valid json';
loadViolationsSeen();
updateViolationsBadge();
assert.strictEqual(badge.textContent, '4', 'corrupt storage must degrade to all-unseen, not crash');

// 10. The persisted seen list is capped so storage cannot grow without bound.
const many = Array.from({ length: 600 }, (_, i) => VIO('bulk' + i));
many.forEach((v) => markViolationSeen(v.id));
const capped = JSON.parse(storage[KEY]);
assert(
    capped.length <= 500,
    'the persisted seen list must be capped, got ' + capped.length + ' entries'
);
sandbox.allViolations = many;
loadViolationsSeen();
updateViolationsBadge();
// 600 reports, only the newest 500 ids retained => 100 remain unseen,
// which the 99+ display cap renders as "99+".
assert.strictEqual(badge.textContent, '99+', 'capping must still count correctly, got: ' + badge.textContent);

// 11. A huge unseen count is capped at 99+ so the label cannot blow out the sidebar.
sandbox.allViolations = Array.from({ length: 150 }, (_, i) => VIO('fresh' + i));
loadViolationsSeen();
updateViolationsBadge();
assert.strictEqual(badge.textContent, '99+', 'a large unseen count must be capped at 99+');

console.log('✅ Violations badge tests passed (per-report: clears only when a report is actually opened).');
