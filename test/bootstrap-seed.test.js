// Functional test for the FIRESTORE BOOTSTRAP (scripts/seed.js) and the
// registration branch picker in login.html.
//
// THE BUG THIS LOCKS DOWN
// ----------------------
// Deleting all Firestore data made the app impossible to use. The reported
// symptom was "when I tried to create a first account it asked me
// 'No branches available yet.'". The chain is a hard deadlock, not a papercut:
//
//   1. Registration hard-requires at least one branch (login.html).
//   2. The branch picker reads the `branches` collection.
//   3. `branches` is `allow read: if true` (firestore.rules:192), so an
//      UNSEEDED database answers SUCCESSFULLY with [] - it does not error.
//   4. The fallback list was only rendered on a THROWN error, so [] rendered
//      "No branches available yet." instead.
//   5. Branches can only be created by a superadmin (firestore.rules:193,
//      `allow create: if isSuperAdmin()`).
//   6. New accounts are role:'owner' + status:'pending', so they need a
//      superadmin to approve them, and the UI can only assign
//      ['owner','hr'] - so no in-app account can ever BE the first superadmin.
//
// An empty database was therefore unrecoverable from the UI. Two fixes are
// asserted here: the picker falls back on EMPTY (not just on error), and
// scripts/seed.js can create both the branches and the first superadmin.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

console.log('Testing the empty-Firestore bootstrap (login.html picker + scripts/seed.js)...');

// ============================================================================
// 1. THE PICKER MUST FALL BACK ON AN EMPTY RESULT, NOT ONLY ON A THROWN ERROR
// ============================================================================
const loginHtml = read('login.html');

// Pull the branch-picker block out of the inline script and read it as code, so
// these assertions are about behaviour rather than about wording.
const pickerStart = loginHtml.indexOf('async function loadRegistrationBranches');
const pickerEnd = loginHtml.indexOf('registerForm.addEventListener', pickerStart);
assert(pickerStart > -1, 'loadRegistrationBranches() not found in login.html');
assert(pickerEnd > pickerStart, 'could not find the end of the branch picker block');
const picker = loginHtml.slice(pickerStart, pickerEnd);

// The real regression: the fallback must be reachable when the read SUCCEEDS
// with an empty array. Asserting only that FALLBACK_BRANCHES is mentioned would
// pass even with the old `catch`-only wiring, which is the bug.
assert(
    /names\.length\s*\?\s*names\s*:\s*FALLBACK_BRANCHES/.test(picker),
    'the branch picker must fall back to FALLBACK_BRANCHES when the read SUCCEEDS '
    + 'but returns [] - an unseeded `branches` collection answers successfully '
    + 'with an empty array, so a catch-only fallback never fires and registration '
    + 'dead-ends with "No branches available yet."'
);

// The read must be attempted OUTSIDE the catch, so an empty result is even
// possible to observe.
assert(
    /firestoreService\.getBranches\(\)/.test(picker) && /let names = \[\]/.test(picker),
    'the picker must read the branches into a variable and decide afterwards, so '
    + '"empty" and "failed" can be handled differently'
);


// The fallback must be honest: a user must not be told these branches exist.
assert(
    /FALLBACK_NOTE/.test(loginHtml) && /not configured/.test(loginHtml),
    'when the fallback list is used, login.html must say the branches are not yet '
    + 'configured - otherwise someone registers against branches that do not exist'
);

// Registration still hard-requires a branch (that behaviour is unchanged).
assert(
    /Please select at least one branch\./.test(loginHtml),
    'registration must still require at least one branch'
);
// ============================================================================
// 2. THE SEED SCRIPT MUST PRODUCE THE SHAPES THE APP ACTUALLY READS
// ============================================================================
const seed = require(path.join(ROOT, 'scripts', 'seed.js'));

// A branch doc without `branchName` never appears in the Branch Monitor, because
// every renderer looks the branch up by that field.
const branch = seed.buildBranchDoc('Banawe');
assert.strictEqual(branch.branchName, 'Banawe', 'a branch doc must carry branchName');
assert.strictEqual(branch.currentStatus, 'Online',
    'a new branch starts Online - script.js renders currentStatus');
assert.ok('currentDowntimeStart' in branch,
    'currentDowntimeStart must be present and null; the uptime maths reads it');
assert.ok('remarks' in branch, 'the Manage Branches form writes remarks');

// A user doc without status:'approved' is bounced to pending-approval.html
// forever, and one without role:'superadmin' fails every isSuperAdmin() check.
const user = seed.buildUserDoc('me@co.com', 'Me', ['Banawe']);
assert.strictEqual(user.role, 'superadmin', 'the seeded user must be a superadmin');
assert.strictEqual(user.status, 'approved',
    'the seeded user must be APPROVED - a pending account cannot use the site');
assert.deepStrictEqual(user.permissions,
    { viewOnly: false, canEdit: false, canDownload: false },
    'the permissions shape must match the one login.html writes at registration');
console.log('  PASS  the seeded documents match the shapes the app reads');

console.log('  PASS  the seeded branch list matches the one shown at registration');

// ============================================================================
// 3. THE BRANCH LIST MUST NOT DRIFT FROM login.html's FALLBACK_BRANCHES
// ============================================================================
const fallbackInLogin = (loginHtml.match(/const FALLBACK_BRANCHES = \[([\s\S]*?)\];/) || [])[1] || '';
const loginBranches = (fallbackInLogin.match(/'([^']+)'/g) || [])
    .map((s) => s.replace(/'/g, ''));
assert.deepStrictEqual(
    seed.DEFAULT_BRANCHES.slice().sort(),
    loginBranches.slice().sort(),
    'scripts/seed.js DEFAULT_BRANCHES and login.html FALLBACK_BRANCHES have drifted. '
    + 'A mismatch means someone can register against a branch the seeder never created, '
    + 'and that ticket then matches no branch document.'
);

// ============================================================================
// 4. VALIDATION AND SAFETY
// ============================================================================
assert.strictEqual(seed.normalizeEmail('  Me@CO.com '), 'me@co.com',
    'the user doc id must be the normalized email, matching window.normalizeUserEmail');
assert.strictEqual(seed.isPlausibleEmail('not-an-email'), false,
    'a malformed email must be rejected BEFORE anything is written');
assert.strictEqual(seed.isPlausibleEmail('me@co.com'), true, 'a real address must pass');
assert.strictEqual(seed.isPlausibleEmail(''), false, 'an empty address must be rejected');

// A typo must not half-seed, so the email is checked up front. Assert the check
// sits BEFORE the admin SDK is required/initialised.
const seedSrc = read('scripts', 'seed.js');
const validationAt = seedSrc.indexOf('is not a valid email address');
const sdkAt = seedSrc.indexOf("require('firebase-admin')");
assert(validationAt > -1, 'the seed script must reject a malformed email');
assert(sdkAt > -1, 'the seed script must use the Admin SDK');
assert(validationAt < sdkAt,
    'the email must be validated BEFORE the Admin SDK is touched, or a typo leaves a '
    + 'half-bootstrapped project (branches written, superadmin missing)');

// It must never silently overwrite: that would reset a branch someone has since
// taken Offline.
assert(
    /snap\.exists\s*&&\s*!opts\.force/.test(seedSrc),
    'an existing document must be SKIPPED unless --force is passed'
);
assert(/--dry-run/.test(seedSrc) && /if \(opts\.dryRun\)/.test(seedSrc),
    '--dry-run must write nothing');

// The password must never be printed.
const logLines = seedSrc.split('\n').filter((l) => /console\.(log|error)/.test(l));
assert(
    !logLines.some((l) => /console\.(log|error)\([^)]*opts\.password/.test(l)),
    'the password must never be passed to console.log/console.error'
);

// The script must NOT auto-run when required by a test.
assert(
    /if \(require\.main === module\)/.test(seedSrc),
    'seed.js must only run when executed directly, or requiring it from a test '
    + 'would attempt to seed Firestore during the test run'
);
console.log('  PASS  validation happens first, nothing is overwritten, and no password is logged');

// ============================================================================
// 5. CREDENTIALS MUST BE EXTERNAL AND GITIGNORED
// ============================================================================
assert(
    /applicationDefault\(\)/.test(seedSrc),
    'the script must authenticate via applicationDefault() (GOOGLE_APPLICATION_CREDENTIALS '
    + 'or ./service-account.json) so the key is never hardcoded in the repo'
);
assert(
    /role:\s*'superadmin'/.test(seedSrc),
    'the script is the ONLY way to create the first superadmin, because the UI can '
    + 'only assign owner/hr - so it must write that role'
);

// A committed service-account key bypasses every rule in firestore.rules for the
// whole project.
const gitignore = read('.gitignore');
assert(
    /service-account\*\.json/.test(gitignore),
    '.gitignore MUST exclude the service-account key - it is a full-admin credential'
);

const pkg = JSON.parse(read('package.json'));
assert(pkg.scripts && /scripts\/seed\.js/.test(pkg.scripts.seed),
    'package.json must expose an npm run seed script');
assert(pkg.devDependencies && pkg.devDependencies['firebase-admin'],
    'package.json must depend on firebase-admin, or `npm run seed` can never work');
console.log('  PASS  credentials are external, the key is gitignored, and the SDK is declared');

console.log('\n✅ Bootstrap tests passed (an empty Firestore no longer dead-ends registration: the '
    + 'picker falls back on an empty read as well as a failed one; scripts/seed.js writes the '
    + 'document shapes the app reads; the branch list cannot drift from login.html; and the '
    + 'first superadmin - which no in-app account can ever be - is created out of band).');
