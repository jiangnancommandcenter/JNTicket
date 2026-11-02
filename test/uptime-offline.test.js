// Functional test for the downtime/uptime panels (Branch Uptime,
// Downtime Trend, Top Downtime, Total Downtime).
//
// THE BUG THIS LOCKS DOWN:
//   Every one of these panels used to derive downtime from `status_logs`
//   ALONE. A branch that is offline RIGHT NOW has no closing "Online" log,
//   and if its "Offline" log predates the reporting window it is filtered
//   out entirely. The branch then fell through to a default of
//   { uptimePct: 100, offlineMinutes: 0, incidents: 0 } and rendered as a
//   healthy green 100% row while it was actually down.
//
//   The fix: the `branches` doc is authoritative for CURRENT state,
//   `status_logs` remain the historical record, and
//   resolveOngoingOutageStart() reconciles the two exactly once.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

const start = src.indexOf('//  BRANCH UPTIME / SLA STATISTICS');
assert(start > -1, 'uptime statistics block not found in script.js');
const blockStart = src.lastIndexOf('// ====', start);
const end = src.indexOf('function renderDashboard()', start);
assert(end > blockStart, 'end of the uptime statistics block not found in script.js');
const blockSrc = src.slice(blockStart, end);

// getDurationMinutes lives outside that block; pull it in too.
const gStart = src.indexOf('function getDurationMinutes');
assert(gStart > -1, 'getDurationMinutes not found in script.js');
const gEnd = src.indexOf('function getCurrentDowntimeText', gStart);
assert(gEnd > gStart, 'end of getDurationMinutes not found in script.js');
const durSrc = src.slice(gStart, gEnd);

// calculateDowntimeFromLogs lives further down (dashboard totals), so it is
// extracted separately rather than relying on the uptime block.
const cStart = src.indexOf('function calculateDowntimeFromLogs');
assert(cStart > -1, 'calculateDowntimeFromLogs not found in script.js');
const cEnd = src.indexOf('function renderQuickStatus', cStart);
assert(cEnd > cStart, 'end of calculateDowntimeFromLogs not found in script.js');
const calcSrc = src.slice(cStart, cEnd);

console.log('Testing downtime/uptime panels (offline branches must not read 100%)...');

const sandbox = {
    console, window: {},
    // Globals the extracted block reads. Reassigned per test.
    branches: [], allLogs: []
};
vm.createContext(sandbox);
vm.runInContext(durSrc + '\n' + blockSrc + '\n' + calcSrc, sandbox);

const { computeBranchUptime, calculateDowntimeFromLogs, isBranchOfflineNow } = sandbox;
assert(computeBranchUptime, 'computeBranchUptime was not exposed to the sandbox');
assert(calculateDowntimeFromLogs, 'calculateDowntimeFromLogs was not exposed to the sandbox');
assert(isBranchOfflineNow, 'isBranchOfflineNow was not exposed to the sandbox');

// Deterministic clock: the "current month" the panels measure against.
const NOW = Date.now();
const MONTH_START = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
const HOUR = 60 * 60 * 1000;
const mins = (ms) => Math.round(ms / 60000);

const log = (branchName, status, ms) => ({ branchName, status, dateTime: new Date(ms) });
const branch = (name, status, downtimeStartMs, lastUpdatedMs) => ({
    branchName: name, currentStatus: status,
    currentDowntimeStart: downtimeStartMs == null ? null : new Date(downtimeStartMs),
    lastUpdated: new Date(lastUpdatedMs == null ? NOW : lastUpdatedMs)
});

function setState(branchList, logList) {
    sandbox.branches = branchList;
    sandbox.allLogs = logList;
}

// 1. THE REPORTED BUG: "Gil Fernando" is offline, but its "Offline" log
//    predates the month, so there are NO in-window logs at all. It must NOT
//    report 100% — this is the exact scenario that shipped the bug.
setState([branch('Gil Fernando', 'Offline', MONTH_START - 5 * 24 * HOUR)], []);
let up = computeBranchUptime(new Date()).perBranch['Gil Fernando'];
assert(up.uptimePct < 100, 'a branch offline since before the month must not read 100% uptime');
assert(up.incidents >= 1, 'an ongoing outage must count as at least one incident');
assert(
    up.offlineMinutes >= mins(NOW - MONTH_START) - 1,
    'downtime accrued from the month start must be counted'
);
assert(isBranchOfflineNow('Gil Fernando') === true, 'the live branches doc says offline');

// 2. A branch offline for the whole window reports ~0%, not 100%.
setState([branch('Banawe', 'Offline', MONTH_START - 40 * 24 * HOUR)], []);
up = computeBranchUptime(new Date()).perBranch.Banawe;
assert(up.uptimePct < 5, 'a branch down for the entire window must be near 0% uptime');
assert(up.offlineMinutes >= mins(NOW - MONTH_START) - 1, 'full-window downtime must be counted');

// 3. REGRESSION GUARD: an online branch with no logs is a clean 100%.
setState([branch('Paseo', 'Online', null)], []);
up = computeBranchUptime(new Date()).perBranch.Paseo;
assert.strictEqual(up.uptimePct, 100, 'an online branch must stay at 100%');
assert.strictEqual(up.offlineMinutes, 0, 'an online branch must have 0 downtime');
assert.strictEqual(up.incidents, 0, 'an online branch must have 0 incidents');
assert(isBranchOfflineNow('Paseo') === false, 'an online branch is not offline now');

// 4. NO DOUBLE COUNT: one outage evidenced by BOTH the log and the branches
//    doc must be counted once, not twice.
const threeHoursAgo = NOW - 3 * HOUR;
setState(
    [branch('SM Clark', 'Offline', threeHoursAgo)],
    [log('SM Clark', 'Offline', threeHoursAgo)]
);
up = computeBranchUptime(new Date()).perBranch['SM Clark'];
assert.strictEqual(up.incidents, 1, 'a single outage must be exactly one incident, not two');
assert(
    Math.abs(up.offlineMinutes - mins(3 * HOUR)) <= 1,
    `a single 3h outage must be ~180m, got ${up.offlineMinutes}`
);

// 5. A closed outage (Offline then Online) counts once, and adds no
//    ongoing outage on top because the branch is back online.
const closedStart = NOW - 6 * HOUR;
const closedEnd = NOW - 4 * HOUR;
setState(
    [branch('Fame', 'Online', null)],
    [log('Fame', 'Offline', closedStart), log('Fame', 'Online', closedEnd)]
);
up = computeBranchUptime(new Date()).perBranch.Fame;
assert.strictEqual(up.incidents, 1, 'a closed outage must be exactly one incident');
assert(
    Math.abs(up.offlineMinutes - mins(2 * HOUR)) <= 1,
    `a closed 2h outage must be ~120m, got ${up.offlineMinutes}`
);

// 6. An outage that began before the window and CLOSED inside it is measured
//    from the window start only — the window is the reporting period.
setState(
    [branch('MOA', 'Online', null)],
    [log('MOA', 'Offline', MONTH_START - 3 * 24 * HOUR), log('MOA', 'Online', MONTH_START + 2 * HOUR)]
);
up = computeBranchUptime(new Date()).perBranch.MOA;
assert.strictEqual(up.incidents, 1, 'the boundary-crossing outage is one incident');
assert(
    Math.abs(up.offlineMinutes - mins(2 * HOUR)) <= 1,
    `only the 2h inside the window counts, got ${up.offlineMinutes}`
);

// 6b. CARRY-IN: the outage's opening "Offline" log is BEFORE the window, so it
//     is filtered out of monthLogs entirely. Without carry-in state the window
//     would start mid-outage and attribute none of the 2h.
assert(
    up.offlineMinutes > 0,
    'an outage that began before the window must still charge the time inside it'
);

// 6c. A branch whose outage began AND ended before the window contributes
//     nothing to this window.
setState(
    [branch('Paseo', 'Online', null)],
    [
        log('Paseo', 'Offline', MONTH_START - 10 * 24 * HOUR),
        log('Paseo', 'Online', MONTH_START - 9 * 24 * HOUR)
    ]
);
up = computeBranchUptime(new Date()).perBranch.Paseo;
assert.strictEqual(up.offlineMinutes, 0, 'a fully pre-window outage must not leak into this window');
assert.strictEqual(up.incidents, 0, 'a fully pre-window outage must add no incidents');

// 7. calculateDowntimeFromLogs: a SINGLE "Offline" log is a real ongoing
//    outage. The old `length < 2` guard returned 0m for a down branch.
setState([branch('Hemady', 'Offline', threeHoursAgo)], [log('Hemady', 'Offline', threeHoursAgo)]);
let total = calculateDowntimeFromLogs(sandbox.allLogs, 'Hemady');
assert(
    Math.abs(total - mins(3 * HOUR)) <= 1,
    `a single Offline log must report ~180m, got ${total}`
);

// 8. calculateDowntimeFromLogs with no logs at all still honours the live
//    branches doc (a branch offline since before the month).
setState([branch('Ortigas Center', 'Offline', MONTH_START - 2 * 24 * HOUR)], []);
total = calculateDowntimeFromLogs([], 'Ortigas Center', MONTH_START);
assert(total > 0, 'an offline branch with no logs must still report downtime');

// 9. An online branch with no logs reports zero, not NaN or -1.
setState([branch('Eastwood', 'Online', null)], []);
total = calculateDowntimeFromLogs([], 'Eastwood', MONTH_START);
assert.strictEqual(total, 0, 'an online branch with no logs must report exactly 0');

console.log('✅ Downtime/uptime panel tests passed (offline branches show real downtime; no double counting).');
