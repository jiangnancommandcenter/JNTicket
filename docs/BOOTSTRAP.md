# Bootstrapping an empty Firestore

> **Read this if registration says "No branches available yet."** That is not a
> cosmetic message — it is a hard deadlock, and this file is the way out.

---

## The problem

Delete every document in Firestore and the site becomes impossible to use. The
chain is a loop with no entry point:

```
  register an account
   └─ requires at least one branch        login.html
        └─ the branch picker reads `branches`
             └─ an UNSEEDED collection answers successfully with []      ← the trap
                  └─ branches can only be CREATED by a superadmin        firestore.rules
                       └─ new accounts are role:'owner' + status:'pending'
                            └─ a superadmin must approve them
                                 └─ …and no superadmin exists
```

Two details make it unrecoverable rather than merely annoying:

1. **The fallback list only fired on a *thrown* error.** `branches` is
   `allow read: if true` (`firestore.rules`), so an empty collection **succeeds**
   and returns `[]` — it never throws. The old code rendered "No branches
   available yet." in exactly the one case where the fallback was needed.
   *(Fixed: `login.html` now falls back on an empty result as well as a failed
   one, and says so honestly so nobody registers against branches that don't exist.)*

2. **No in-app account can ever be the first superadmin.** `isSuperAdmin()` just
   reads `users/<email>.role`, while the UI can only assign `['owner','hr']`.
   So the first superadmin has to be written **out of band** — which is what
   this script is for.

---

## The fix: `npm run seed`

```bash
npm install                      # one-time: pulls firebase-admin
npm run seed -- --all            # branches + first superadmin
```

You will be prompted for the superadmin's password (input is hidden).

| Command | Effect |
|---|---|
| `npm run seed` | Branches only |
| `npm run seed -- --all` | Branches **and** the first superadmin |
| `npm run seed -- --superadmin=you@co.com` | Just the superadmin |
| `npm run seed -- --branches=A,B,C` | A custom branch list |
| `npm run seed -- --all --dry-run` | Prints everything, writes nothing |
| `npm run seed -- --all --force` | Overwrite existing docs (default is to **skip**) |

Then sign in as the superadmin — you land on `main.html` with every tab.

### Safety

- **Idempotent.** Existing branch and user documents are **skipped**, never
  overwritten (so re-running cannot reset a branch someone has taken Offline).
  Only `--force` overwrites.
- **Validated first.** A malformed email or a password under 6 characters is
  rejected *before* Firestore is touched, so a typo cannot leave a half-seeded
  project.
- **The password is never printed or logged.**
- `--dry-run` writes nothing.

---

## Credentials

The script needs a **service-account key**, because the web SDK cannot do this:
`branches` create is `isSuperAdmin()`-gated, which is precisely the thing being
bootstrapped. The Admin SDK authenticates with a service account and bypasses
rules.

1. Firebase Console → **Project Settings → Service Accounts**
2. **Generate new private key** (downloads a `.json`)
3. Either save it as `service-account.json` next to `package.json`, or:
   ```bash
   # macOS / Linux
   export GOOGLE_APPLICATION_CREDENTIALS=/full/path/to/key.json
   # Windows PowerShell
   $env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\key.json"
   ```

> ⚠️ **A service-account key is a full-admin credential for the entire project.**
> It bypasses *every* rule in `firestore.rules`, including `isSuperAdmin()`.
> `.gitignore` already excludes `service-account*.json`, but a committed key would
> hand the whole database to anyone who clones the repo. Generate it only when
> bootstrapping and **delete it afterwards**.

---

## What it writes

```js
// branches/{branchName}   — doc ID === branchName  (matches script.js setBranch)
{ branchName: 'Banawe', currentStatus: 'Online',
  currentDowntimeStart: null, remarks: '', updatedAt: <timestamp> }

// users/{email}           — doc ID === lowercased email
{ email, name, branches: [ …all 21… ], role: 'superadmin', status: 'approved',
  permissions: { viewOnly: false, canEdit: false, canDownload: false },
  registeredAt: <timestamp>, updatedAt: <timestamp> }
```

`status: 'approved'` matters — without it the account is bounced to
`pending-approval.html` forever. The branch list is asserted to stay in step with
`FALLBACK_BRANCHES` in `login.html` by `test/bootstrap-seed.test.js`.

---

## Covered by

`test/bootstrap-seed.test.js` — the fallback fires on an *empty* read (not just a
failed one), the seeded documents match the shapes the app reads, the branch
list cannot drift from `login.html`, validation runs before the SDK is touched,
nothing is overwritten without `--force`, and the key is gitignored.
