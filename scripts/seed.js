#!/usr/bin/env node
// ==============================================================
//  RCMS BOOTSTRAP - scripts/seed.js
//
//  WHY THIS EXISTS
//  --------------
//  An empty Firestore is UNRECOVERABLE from the UI, and the chain is a hard
//  deadlock rather than an inconvenience:
//
//    1. Registration hard-requires one branch (login.html).
//    2. The branch picker reads the `branches` collection.
//    3. `branches` is `allow read: if true` (firestore.rules), so an unseeded
//       database answers SUCCESSFULLY with [] rather than erroring.
//    4. `branches` create is `allow create: if isSuperAdmin()` - branches need
//       a superadmin.
//    5. New accounts are role:'owner' + status:'pending', so they need a
//       superadmin to approve them.
//    6. isSuperAdmin() just reads users/<email>.role, and the UI can only assign
//       ['owner','hr'] - so no account created through the app can ever BE the
//       first superadmin.
//
//  So: you need a branch to register, you need a superadmin to make a branch,
//  and the only way to make the first superadmin is out-of-band. This is that
//  out-of-band step.
//
//  WHY THE ADMIN SDK AND NOT THE WEB SDK
//  The web SDK obeys firestore.rules, and the rules are exactly what blocks us
//  (step 4). The Admin SDK authenticates with a service account and bypasses
//  security rules - which is the whole point, and also why the key must be
//  treated as a full-admin credential and never committed.
//
//  USAGE
//      npm run seed                                  # branches only
//      npm run seed -- --all                         # branches + superadmin
//      npm run seed -- --superadmin=you@co.com       # prompts for password
//      npm run seed -- --branches=A,B,C              # your own list
//      npm run seed -- --all --dry-run               # print, write nothing
//
//  SAFETY
//    * Idempotent - existing docs are SKIPPED, never overwritten, unless
//      --force. Running it twice is harmless.
//    * --dry-run writes nothing.
//    * The password is never printed or logged.
//
//  A service-account key bypasses EVERY rule in firestore.rules for the whole
//  project. Generate it only if needed, keep it out of git, and delete it once
//  the project is bootstrapped.
// ==============================================================
'use strict';

const readline = require('readline');

const PROJECT_ID = 'jn-data-f29ae';

// The 21 branches. MUST stay in step with FALLBACK_BRANCHES in login.html -
// that list is what a user sees before any branch exists, so a mismatch would
// let someone register against a branch that was never created.
// test/seed.test.js asserts the two cannot drift.
const DEFAULT_BRANCHES = [
    'Banawe', 'BF Homes', 'Eastwood', 'Fame', 'Gil Fernando', 'Hemady',
    'Holy Spirit', 'MOA', 'Ortigas Center', 'Paseo', 'Promenade', 'SM Clark',
    'SM Fairview', 'SM Marikina', 'SM Marilao', 'SM South Mall', 'SMDC Wind',
    'SM East Ortigas', 'Sta. Rosa', 'SM Sucat', 'Tagaytay'
];

// ==============================================================
//  DOCUMENT BUILDERS  (pure; exported for test/seed.test.js)
// ==============================================================
// These mirror the LIVE shapes:
//   branches/{branchName}  <- script.js setBranch() from Manage Branches
//   users/{email}          <- login.html, the doc written at registration
// Drift here is a silent bug: a branch without 'branchName' never shows in the
// Branch Monitor, and a user doc without status:'approved' is bounced to
// pending-approval.html forever.
function buildBranchDoc(branchName) {
    return {
        branchName: branchName,
        currentStatus: 'Online',
        currentDowntimeStart: null,
        remarks: ''
    };
}

function buildUserDoc(email, name, branches) {
    return {
        email: email,
        name: name,
        branches: branches,
        role: 'superadmin',
        status: 'approved',
        permissions: { viewOnly: false, canEdit: false, canDownload: false }
    };
}

// As loose as the app's own normalizeUserEmail (trim + lowercase). Stricter
// here would refuse addresses the app itself accepts.
function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function isPlausibleEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(value));
}

// ==============================================================
//  ARGS
// ==============================================================
function parseArgs(argv) {
    const opts = {
        branches: null, superadmin: '', password: '',
        all: false, force: false, dryRun: false, help: false, bad: false
    };
    argv.forEach(function (arg) {
        if (arg === '--all') opts.all = true;
        else if (arg === '--force') opts.force = true;
        else if (arg === '--dry-run') opts.dryRun = true;
        else if (arg === '--branches') opts.branches = DEFAULT_BRANCHES.slice();
        else if (arg === '--help' || arg === '-h') opts.help = true;
        else if (arg.indexOf('--superadmin=') === 0) opts.superadmin = arg.slice(13);
        else if (arg.indexOf('--password=') === 0) opts.password = arg.slice(11);
        else if (arg.indexOf('--branches=') === 0) {
            opts.branches = arg.slice(11).split(',').map(function (s) {
                return s.trim();
            }).filter(Boolean);
        } else {
            console.error('Unknown argument: ' + arg);
            opts.bad = true;
        }
    });
    return opts;
}

function wantsBranches(opts) { return !!(opts.all || opts.branches); }
function wantsSuperadmin(opts) { return !!(opts.all || opts.superadmin); }

// ==============================================================
//  SEEDERS
// ==============================================================
async function seedBranches(admin, db, opts) {
    const names = opts.branches && opts.branches.length ? opts.branches : DEFAULT_BRANCHES;
    const now = admin.firestore.FieldValue.serverTimestamp();
    console.log('Branches (' + names.length + '):');

    for (const name of names) {
        const ref = db.collection('branches').doc(name);
        if (opts.dryRun) { console.log('  [dry-run] branches/' + name); continue; }
        try {
            const snap = await ref.get();
            if (snap.exists && !opts.force) {
                // SKIP, never merge: re-running must not reset a branch that
                // someone has since taken Offline.
                console.log('  = branches/' + name + ' (exists, skipped)');
                continue;
            }
            await ref.set(Object.assign(buildBranchDoc(name), { updatedAt: now }), { merge: true });
            console.log('  + branches/' + name);
        } catch (err) {
            console.error('  ! branches/' + name + ' - ' + (err && err.message ? err.message : err));
            process.exitCode = 1;
        }
    }
}

async function seedSuperadmin(admin, db, opts) {
    const email = normalizeEmail(opts.superadmin);
    const ref = db.collection('users').doc(email);

    if (opts.dryRun) {
        console.log('  [dry-run] users/' + email + ' (role=superadmin, status=approved)');
        console.log('  [dry-run] auth user ' + email);
        return;
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const snap = await ref.get();
    if (snap.exists && !opts.force) {
        console.log('  = users/' + email + ' (exists, skipped - use --force to overwrite)');
        return;
    }

    // The auth user is created FIRST so a Firestore failure cannot leave a
    // profile with no way to sign in.
    try {
        await admin.auth().createUser({ email: email, password: opts.password, emailVerified: true });
        console.log('  + auth user ' + email);
    } catch (err) {
        const code = String((err && err.code) || '');
        if (code.indexOf('email-already-exists') > -1) {
            // Not fatal: the app authorises on the Firestore profile, and the
            // account may have been created through the console.
            console.log('  = auth user ' + email + ' (already exists)');
        } else {
            console.error('  ! auth user ' + email + ' - ' + (err && err.message ? err.message : err));
            process.exitCode = 1;
        }
    }

    const data = buildUserDoc(email, email.split('@')[0], DEFAULT_BRANCHES.slice());
    await ref.set(Object.assign({}, data, { registeredAt: now, updatedAt: now }), { merge: true });
    console.log('  + users/' + email + ' (superadmin, approved)');
}

// The 21 branches. MUST stay in step with FALLBACK_BRANCHES in login.html -
// that list is what a user sees before any branch exists, so a mismatch would

// ==============================================================
//  MAIN
// ==============================================================
/** Prompt with echo suppressed, so a password never hits the screen or history. */
function promptHidden(question) {
    return new Promise(function (resolve) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        const original = rl._writeToOutput;
        rl._writeToOutput = function () { /* suppress echo */ };
        rl.question(question, function (answer) {
            rl._writeToOutput = original;
            rl.close();
            console.log('');
            resolve(String(answer || ''));
        });
    });
}

function usage() {
    console.log([
        'RCMS bootstrap - seeds branches and the first superadmin.',
        '',
        '  --all                  seed branches AND the first superadmin',
        '  --branches             seed the default branch list',
        '  --branches=A,B,C       seed a custom list',
        '  --superadmin=<email>   create the first superadmin (prompts for password)',
        '  --password=<password>  supply the password non-interactively',
        '  --force                overwrite existing docs (default is to SKIP them)',
        '  --dry-run              print what would happen, write nothing',
        '',
        'Credentials: set GOOGLE_APPLICATION_CREDENTIALS, or place service-account.json',
        'next to package.json.'
    ].join('\n'));
}

/** A Firestore stand-in so --dry-run exercises the real code paths. */
function makeDryRunDb() {
    return {
        collection: function () {
            return {
                doc: function () {
                    return {
                        get: async function () { return { exists: false }; },
                        set: async function () {}
                    };
                }
            };
        }
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help || (!wantsBranches(opts) && !wantsSuperadmin(opts))) { usage(); return; }
    if (opts.bad) { process.exitCode = 1; return; }

    // Validate EVERYTHING before opening a connection. A typo in the email must
    // not leave a half-bootstrapped project, because the branches would already
    // have been written by the time it was noticed.
    if (opts.superadmin && !isPlausibleEmail(opts.superadmin)) {
        console.error('"' + opts.superadmin + '" is not a valid email address. Nothing was written.');
        process.exitCode = 1;
        return;
    }
    if (opts.superadmin && !opts.password && !opts.dryRun) {
        opts.password = await promptHidden('Password for ' + normalizeEmail(opts.superadmin) + ': ');
    }
    if (opts.superadmin && !opts.dryRun && String(opts.password).length < 6) {
        // Firebase's own minimum, checked here so the error names the real
        // problem instead of surfacing from deep inside the Admin SDK.
        console.error('Password must be at least 6 characters. Nothing was written.');
        process.exitCode = 1;
        return;
    }

    if (opts.dryRun) {
        console.log('Dry run - nothing will be written.\n');
        const stubAdmin = { firestore: { FieldValue: { serverTimestamp: function () { return 'TS'; } } } };
        if (wantsBranches(opts)) await seedBranches(stubAdmin, makeDryRunDb(), opts);
        if (wantsSuperadmin(opts)) await seedSuperadmin(stubAdmin, makeDryRunDb(), opts);
        console.log('\nDry run complete - nothing was written.');
        return;
    }

    // Required lazily so --help and --dry-run work with no dependency installed.
    let admin;
    try {
        admin = require('firebase-admin');
    } catch (err) {
        console.error('firebase-admin is not installed. Run:\n\n    npm install\n');
        process.exitCode = 1;
        return;
    }

    try {
        admin.initializeApp({ credential: admin.credential.applicationDefault(), projectId: PROJECT_ID });
    } catch (err) {
        console.error([
            'Could not initialise the Admin SDK: ' + (err && err.message ? err.message : err),
            '',
            'Provide a service-account key:',
            '  1. Firebase Console > Project Settings > Service Accounts',
            '  2. "Generate new private key"',
            '  3. Save it as service-account.json next to package.json, or set',
            '     GOOGLE_APPLICATION_CREDENTIALS=/path/to/the/key.json',
            '',
            'Nothing was written.'
        ].join('\n'));
        process.exitCode = 1;
        return;
    }

    const db = admin.firestore();
    if (wantsBranches(opts)) await seedBranches(admin, db, opts);
    if (wantsSuperadmin(opts)) await seedSuperadmin(admin, db, opts);
    console.log('\nDone. Sign in as the superadmin to reach main.html.');
}

// Only run when EXECUTED. test/seed.test.js requires this file to reach the pure
// builders; without this guard it would try to seed Firestore during the test run.
if (require.main === module) {
    main().catch(function (err) {
        console.error('Seed failed:', err && err.message ? err.message : err);
        process.exit(1);
    });
}

module.exports = {
    DEFAULT_BRANCHES: DEFAULT_BRANCHES,
    PROJECT_ID: PROJECT_ID,
    buildBranchDoc: buildBranchDoc,
    buildUserDoc: buildUserDoc,
    normalizeEmail: normalizeEmail,
    isPlausibleEmail: isPlausibleEmail,
    parseArgs: parseArgs,
    wantsBranches: wantsBranches,
    wantsSuperadmin: wantsSuperadmin
};
