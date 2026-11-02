// Functional test for the User Approvals "Set Role" (Owner / HR / RM.SM) helpers.
//
// The superadmin assigns each user one of three assignable roles. Owner and HR
// share the same dashboard but differ only in profile label and chat access.
// RM/SM mirrors the Area Manager role exactly (same dashboard, branches,
// feature permissions, ticket filing) with no chat access. All three roles use
// the same role assignment helpers, which normalise/clamp what the dropdown
// can write, so a tampered DOM value can never grant a privileged role such
// as 'superadmin'.
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

const start = src.indexOf('const ASSIGNABLE_ROLES');
assert(start > -1, 'ASSIGNABLE_ROLES not found in script.js');
const blockStart = src.lastIndexOf('// ====', start);
const end = src.indexOf('function toggleUserDetails', start);
assert(end > blockStart, 'end of the role-assignable block not found in script.js');
const blockSrc = src.slice(blockStart, end);

console.log('Testing "Set Role" (Owner / HR) assignment...');

const sandbox = { console, window: {} };
vm.createContext(sandbox);
vm.runInContext(blockSrc, sandbox);

const { ASSIGNABLE_ROLES, currentUserRoleLabel, storedRole, roleDisplayName, roleBadgeClass,
    roleIsAssignable, isApprovalQueueRole, roleHintHtml, clampRoleSelection } =
    sandbox.window.__setRoleInternals;
assert(ASSIGNABLE_ROLES, 'the role helpers were not exposed on window.__setRoleInternals');
assert(storedRole && roleDisplayName && roleBadgeClass && roleIsAssignable,
    'storedRole/roleDisplayName/roleBadgeClass/roleIsAssignable must be exposed on window.__setRoleInternals');
assert(isApprovalQueueRole, 'isApprovalQueueRole must be exposed on window.__setRoleInternals');

/** Strip comments so prose that NAMES an identifier is not mistaken for code. */
const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

// 1. Exactly the three assignable roles exist.
assert.strictEqual(
    ASSIGNABLE_ROLES.slice().sort().join(','),
    'hr,owner,rmsm',
    'ASSIGNABLE_ROLES must be owner + hr + rmsm'
);
assert.strictEqual(ASSIGNABLE_ROLES.indexOf('superadmin'), -1, 'superadmin must not be assignable');
assert.strictEqual(ASSIGNABLE_ROLES.indexOf('operator'), -1, 'operator must not be assignable');

// 2. Normal roles round-trip, case- and whitespace-insensitively.
assert.strictEqual(currentUserRoleLabel({ role: 'owner' }), 'owner', 'owner must be preserved');
assert.strictEqual(currentUserRoleLabel({ role: 'hr' }), 'hr', 'hr must be preserved');
assert.strictEqual(currentUserRoleLabel({ role: 'HR' }), 'hr', 'uppercase HR must normalise');
assert.strictEqual(currentUserRoleLabel({ role: '  Owner ' }), 'owner', 'padded owner must normalise');

// 3. Anything unknown falls back to 'owner' — the safe default (no chat).
['superadmin', 'admin', 'operator', 'viewer', '', null, undefined, 'hr-admin', 'the-hr']
    .forEach((role) => {
        assert.strictEqual(
            currentUserRoleLabel({ role: role }),
            'owner',
            `role ${JSON.stringify(role)} must fall back to owner`
        );
    });
assert.strictEqual(currentUserRoleLabel({}), 'owner', 'a user doc with no role must default to owner');
assert.strictEqual(currentUserRoleLabel(null), 'owner', 'a null user must default to owner');

// 3b. ⚠️ DISPLAY vs ASSIGNABLE — the bug this whole section now guards.
//     A real superadmin stored in `users` is NOT in ASSIGNABLE_ROLES, so
//     currentUserRoleLabel() clamps it to 'owner'. That is correct for the
//     WRITE path (a dropdown must never hand out 'superadmin') but WRONG for
//     DISPLAY: it made the User Approvals row show a superadmin as "Area
//     Manager". storedRole()/roleDisplayName()/roleBadgeClass() read the TRUE
//     stored role, so the row shows "Superadmin" — while currentUserRoleLabel()
//     keeps clamping for writes. The two must stay deliberately different.
assert.strictEqual(storedRole({ role: 'superadmin' }), 'superadmin',
    'storedRole() must return the TRUE role, unclamped — a superadmin is a superadmin');
assert.strictEqual(storedRole({ role: 'HR' }), 'hr', 'storedRole() still normalises case');
assert.strictEqual(storedRole({ role: '  Owner ' }), 'owner', 'storedRole() still trims');
assert.strictEqual(storedRole({}), 'owner', 'a missing role still reads as the owner default');
assert.strictEqual(storedRole(null), 'owner', 'a null user still reads as the owner default');

// The DISPLAY label must name the true role.
assert.strictEqual(roleDisplayName({ role: 'superadmin' }), 'Superadmin',
    'a superadmin must DISPLAY as "Superadmin", not "Area Manager" — the reported bug');
assert.strictEqual(roleDisplayName({ role: 'operator' }), 'Operator',
    'an operator must display as "Operator", not silently "Area Manager"');
assert.strictEqual(roleDisplayName({ role: 'hr' }), 'HR', 'hr still displays as HR');
assert.strictEqual(roleDisplayName({ role: 'rmsm' }), 'RM/SM', 'rmsm still displays as RM/SM');
assert.strictEqual(roleDisplayName({ role: 'owner' }), 'Area Manager', 'owner still displays as Area Manager');
assert.strictEqual(roleDisplayName({ role: 'nonsense' }), 'Area Manager',
    'an unknown role still falls back to the safe "Area Manager" display');

// The BADGE CLASS must match the true role so the colour is right too.
// `.role-badge.superadmin` (amber) and `.role-badge.owner` (violet) already
// exist in style.css/theme.css; rmsm intentionally shares the owner violet.
assert.strictEqual(roleBadgeClass({ role: 'superadmin' }), 'superadmin',
    'a superadmin badge must use the amber .role-badge.superadmin class, not the violet owner one');
assert.strictEqual(roleBadgeClass({ role: 'hr' }), 'hr', 'an HR badge keeps the teal hr class');
assert.strictEqual(roleBadgeClass({ role: 'owner' }), 'owner', 'an owner badge keeps the violet owner class');
assert.strictEqual(roleBadgeClass({ role: 'rmsm' }), 'owner', 'RM/SM shares the owner violet badge class');
assert.strictEqual(roleBadgeClass({ role: 'nonsense' }), 'owner', 'an unknown badge keeps the owner class');

// Only an assignable role may be changed from the dropdown. A superadmin /
// operator is LOCKED (read-only badge), which is what protects them from being
// demoted by an Approve/Save on this screen.
assert.strictEqual(roleIsAssignable({ role: 'owner' }), true, 'owner is assignable');
assert.strictEqual(roleIsAssignable({ role: 'hr' }), true, 'hr is assignable');
assert.strictEqual(roleIsAssignable({ role: 'rmsm' }), true, 'rmsm is assignable');
assert.strictEqual(roleIsAssignable({ role: 'superadmin' }), false,
    'a superadmin must be LOCKED — the dropdown must not offer to re-role them');
assert.strictEqual(roleIsAssignable({ role: 'operator' }), false,
    'an operator must be LOCKED for the same reason');

// 4. The hint text must describe the REAL consequence of each role, so the
//    superadmin is not surprised by chat appearing/disappearing.
const ownerHint = roleHintHtml({ role: 'owner' });
const hrHint = roleHintHtml({ role: 'hr' });
assert.notStrictEqual(ownerHint, hrHint, 'the two roles must have different hints');
assert(/no chat access/i.test(ownerHint), 'the owner hint must say there is no chat access');
assert(/chat/i.test(hrHint), 'the HR hint must mention chat');
assert(/branches/i.test(hrHint), 'the HR hint must mention branches');
const rmsmHint = roleHintHtml({ role: 'rmsm' });
assert(!/chat/i.test(rmsmHint), 'the RM/SM hint must not mention chat');

// 4b. The Area Manager rename is DISPLAY-ONLY. The stored value stays
//     'owner' everywhere, so no user document has to be migrated and the
//     rules / chat allowlist / login redirect keep matching. If anyone
//     "tidies" the value to 'area_manager' instead, every existing account
//     silently falls back to the safe default and the rename breaks.
assert(/area manager/i.test(ownerHint), 'the Area Manager hint must name the role by its new label');
assert(
    !/area_manager/.test(stripComments(blockSrc)),
    'script.js must not introduce an "area_manager" role VALUE — the rename is label-only ' +
    '(comments are stripped, so the note warning against it does not trip this)'
);
assert.strictEqual(
    currentUserRoleLabel({ role: 'owner' }), 'owner',
    'a stored role "owner" must still resolve to "owner" (it is now displayed as Area Manager)'
);
assert.strictEqual(
    currentUserRoleLabel({ role: 'Area Manager' }), 'owner',
    'a legacy/hand-edited "Area Manager" value must clamp to "owner", not become an unknown role'
);

// 5. The dropdown value written by getUserDetailData() must be clamped the
//    same way, so a hand-edited <select> cannot inject 'superadmin'.
assert.strictEqual(clampRoleSelection('hr'), 'hr', 'a real HR selection must pass through');
assert.strictEqual(clampRoleSelection('owner'), 'owner', 'a real owner selection must pass through');
assert.strictEqual(clampRoleSelection('superadmin'), 'owner', 'a tampered superadmin value must be clamped');
assert.strictEqual(clampRoleSelection('operator'), 'owner', 'a tampered operator value must be clamped');
assert.strictEqual(clampRoleSelection(null), 'owner', 'a missing selection must default to owner');

assert.strictEqual(clampRoleSelection(null), 'owner', 'a missing selection must default to owner');

// ===========================================================================
// 6. THE "+Ticket" BUTTON — Area Manager only.
//
//    The button was previously REMOVED for every role because tickets were
//    only filed from the public submit-ticket.html. It is back for the Area
//    Manager alone. Three things can silently break that, so each is pinned:
//
//      a) it must SHIP HIDDEN. The role resolves asynchronously from
//         Firestore, so a button that starts visible flashes on screen for
//         HR and superadmin on every single load.
//      b) it must be gated on the ROLE, and the role VALUE is still 'owner'.
//         Gating on the display label ("Area Manager") would never match.
//      c) `[hidden]` must actually hide it — `.btn` sets display:inline-flex,
//         which beats the user-agent [hidden] rule. Without the explicit
//         `.btn[hidden]` rule the attribute is set but the pixels remain.
// ===========================================================================
const ownerHtml = fs.readFileSync(path.join(ROOT, 'ownerdashboard.html'), 'utf8');
const ownerJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

// The button was an <a href="submit-ticket.html"> and is now a <button> that
// opens the in-dashboard full-screen form (js/owner-ticket-form.js). The
// element type is asserted, not just tolerated: an <a> would be middle-clickable
// and would have to be prevented from navigating, and a plain <button> with no
// type defaults to type="submit" inside a form.
const newTicketBtn = (ownerHtml.match(/<button[^>]*id="btnOwnerNewTicket"[^>]*>/) || [])[0];
assert(newTicketBtn, 'ownerdashboard.html must contain the #btnOwnerNewTicket button');
assert(
    !/<a[^>]*id="btnOwnerNewTicket"/.test(ownerHtml),
    '#btnOwnerNewTicket must NOT be an anchor any more — the form is a modal on this ' +
    'page, and a link would let the manager open a new tab with no dashboard context'
);
assert(
    /type="button"/.test(newTicketBtn),
    'the +Ticket button must declare type="button". It opens a modal; the implicit ' +
    'type="submit" default only bites inside a form, but the explicit type is the ' +
    'contract. Found: ' + newTicketBtn
);

assert(
    /\shidden(\s|>|=)/.test(newTicketBtn),
    'the +Ticket button must ship with the `hidden` attribute — the role is not known at ' +
    'parse time, so a visible-by-default button flashes for HR/superadmin on every load. Found: ' + newTicketBtn
);
assert(
    !/href=/.test(newTicketBtn),
    'the +Ticket button must not carry an href any more. Found: ' + newTicketBtn
);

// The click handler must open the modal AND re-check the role. `hidden` is a
// CSS/AT concern, not a security boundary: anything holding a reference to the
// element can clear it, so the handler is the actual gate.
assert(
    /ownerNewTicketBtn\.addEventListener\('click'/.test(ownerJs),
    'the +Ticket button must be wired to a click handler that opens the ticket form'
);
const newTicketHandler = ownerJs.slice(
    ownerJs.indexOf("ownerNewTicketBtn.addEventListener('click'"),
    ownerJs.indexOf('// ==============================================================\n//  CONTEXT BRIDGE')
);
assert(
    /if\s*\(!isAreaManager\(\)\)\s*return;/.test(newTicketHandler),
    'the +Ticket click handler must re-check isAreaManager() before opening the form. ' +
    '`hidden` can be cleared by any code holding a reference to the element, so the ' +
    'handler itself is the only real gate. Found: ' + newTicketHandler.trim()
);
assert(
    /OwnerTicketForm\.open\(\)/.test(newTicketHandler),
    'the +Ticket click handler must call OwnerTicketForm.open()'
);

// (b) The gate compares the stored role value, not the label.
assert(
    /function isAreaManager\(\)\s*\{\s*return activeUserRole === 'owner'\s*\|\|\s*activeUserRole === 'rmsm';/.test(ownerJs),
    'isAreaManager() must test the STORED role value "owner" or "rmsm" — comparing the "Area Manager" ' +
    'label would never match and the button would never appear'
);
assert(
    /activeUserRole === 'rmsm'/.test(ownerJs),
    'isAreaManager() must also return true for "rmsm" — ensuring RM/SM has same ticket access as Area Manager'
);
assert(
    /syncNewTicketButton\(\);/.test(ownerJs),
    'setActiveUser() must call syncNewTicketButton() so the button is gated on the live role'
);
// Calling it anywhere other than setActiveUser() would miss a re-role in
// another tab, which is why the call must sit inside that function.
const setActiveUserBody = ownerJs.slice(
    ownerJs.indexOf('function setActiveUser('),
    ownerJs.indexOf('function switchOwnerTab(')
);
assert(
    /syncNewTicketButton\(\);/.test(setActiveUserBody),
    'syncNewTicketButton() must be called from setActiveUser(), not only at first load, ' +
    'so a role changed in another tab takes effect immediately'
);

// (c) The stylesheet must make `hidden` beat `.btn { display: inline-flex }`.
const btnHiddenRule = styleCss.match(/\.btn\[hidden\]\s*\{[^}]*\}/);
assert(btnHiddenRule, 'style.css must define `.btn[hidden]` — .btn sets display:inline-flex, ' +
    'which is an author declaration and beats the user-agent [hidden] rule, so the attribute ' +
    'alone would leave the button visible');
assert(
    /display:\s*none/.test(btnHiddenRule[0]),
    '`.btn[hidden]` must set display:none. Found: ' + btnHiddenRule[0]
);

// The button must not leak into the OTHER roles' markup: it lives on the
// shared Area Manager / HR page, so the gate is the only thing separating
// them and it is asserted above.
assert(
    !/id="btnOwnerNewTicket"/.test(fs.readFileSync(path.join(ROOT, 'main.html'), 'utf8')),
    'the +Ticket button belongs to the Area Manager dashboard only; main.html is the ' +
    'operator/superadmin command center and must not gain it'
);

// The label rename must be visible in the header the user actually sees.
assert(
    /'Area Manager'/.test(ownerJs),
    'js/owner-dashboard.js must label the role "Area Manager"'
);

// RM/SM must show ITS OWN label — the exact regression reported as
// "I changed my role to RM/SM but the dashboard label did not change".
// 'rmsm' falls INSIDE isAreaManager() (it shares the +Ticket button, the
// expiry window and the resolved-only scope), so a naive ternary falls
// through and keeps labelling a re-roled RM/SM "Area Manager". The probe
// runs the REAL accessLevelLabel() + isAreaManager() out of the file.
{
    const isAmAt = ownerJs.indexOf('function isAreaManager');
    const syncAt = ownerJs.indexOf('function syncNewTicketButton');
    assert(isAmAt > -1 && syncAt > isAmAt,
        'isAreaManager() and syncNewTicketButton() must both exist to build the label probe');
    const labelSb = { console };
    labelSb.window = labelSb;
    vm.createContext(labelSb);
    vm.runInContext(
        "let activeUserRole = 'viewer';\n" +
        'let activeUserPermissions = { permissions: { canEdit: false } };\n' +
        ownerJs.slice(isAmAt, syncAt) + '\n' +
        'function probeLabel(r) { activeUserRole = r; return accessLevelLabel(); }\n' +
        'function probeIsAm(r) { activeUserRole = r; return isAreaManager(); }\n',
        labelSb
    );
    assert.strictEqual(labelSb.probeLabel('rmsm'), 'RM/SM',
        'the badge + KPI tile must label role "rmsm" as RM/SM, not fall through to "Area Manager"');
    assert.strictEqual(labelSb.probeLabel('owner'), 'Area Manager', 'owner must still label as Area Manager');
    assert.strictEqual(labelSb.probeLabel('hr'), 'HR', 'hr must still label as HR');
    assert.strictEqual(labelSb.probeLabel('superadmin'), 'Superadmin', 'superadmin must still label as Superadmin');
    // The LABEL differs, but the GATES are shared: RM/SM keeps +Ticket, the
    // expiry window and the resolved-only scope.
    assert.strictEqual(labelSb.probeIsAm('rmsm'), true,
        'isAreaManager() must remain true for rmsm — that is what gates +Ticket/expiry/scope');
    assert.strictEqual(labelSb.probeIsAm('owner'), true, 'isAreaManager() stays true for owner');
    assert.strictEqual(labelSb.probeIsAm('hr'), false, 'isAreaManager() stays false for hr');
}
assert(
    />Area Manager<\/option>/.test(src),
    'the User Approvals role dropdown must offer "Area Manager" (value stays "owner")'
);
assert(
    />RM\/SM<\/option>/.test(src),
    'the User Approvals role dropdown must offer "RM/SM"'
);

// Every option must appear EXACTLY ONCE inside the <select>. A duplicated
// <option> (which happened when RM/SM was added by an earlier edit that
// re-inserted the HR line) silently renders two identical rows and can make
// the wrong value win the "selected" tie-break.
const roleSelectMatch = src.match(/<select id="roleSelect[^>]*>[\s\S]*?<\/select>/);
assert(roleSelectMatch, 'the role <select> could not be found in script.js');
['owner', 'hr', 'rmsm'].forEach((value) => {
    const count = (roleSelectMatch[0].match(new RegExp('value="' + value + '"', 'g')) || []).length;
    assert.strictEqual(count, 1,
        `the role dropdown must contain exactly ONE option with value="${value}", found ${count}`);
});

console.log('✅ Set Role tests passed (owner + hr + rmsm; unknown/privileged roles clamped; ' +
    'Area Manager is a label-only rename; +Ticket is gated, ship-hidden and really hides).');

// ---------------------------------------------------------------------------
// 4b. ⚠️ THE WRITE PATH MUST NEVER DEMOTE A LOCKED ROLE.
//
//     The reported bug had a silent, worse half: because a superadmin clamped
//     to 'owner' for display, the role dropdown pre-selected "Area Manager",
//     and approveUser()/updateUserPermissions() wrote `role: detail.role`
//     unconditionally. Approving (or saving) a still-pending superadmin would
//     therefore OVERWRITE role:'superadmin' with 'owner' — a real privilege
//     loss, not just a label. These assertions pin all three guards that make
//     that impossible. They read `script.js` as text because the write
//     functions live outside the sandbox block above (they touch the DOM +
//     Firestore).
// ---------------------------------------------------------------------------

// (a) A locked role renders NO <select>, and getUserDetailData() must read that
//     as "leave the role alone" (null) — NOT the clamped 'owner'.
assert(
    /const roleEl = document\.getElementById\('roleSelect-' \+ safeEmail\);\s*\n\s*const role = roleEl \? window\.__setRoleInternals\.clampRoleSelection\(roleEl\.value\) : null;/.test(src),
    'getUserDetailData() must return role:null when the locked role renders no <select>, so a superadmin ' +
    'is never read back as the clamped "owner"'
);

// (b) A locked role must render a read-only badge, NOT a dropdown that could be
//     changed and saved.
assert(
    /roleIsAssignable\(user\) \? `[\s\S]*?<select id="roleSelect-[\s\S]*?` : `[\s\S]*?role-locked/.test(src),
    'a non-assignable role (superadmin/operator) must render the read-only role-locked badge, not the ' +
    'editable <select> — otherwise the superadmin could re-role (and demote) themselves from this screen'
);

// (c) Both write sites must ADD `role` only when it is present (an assignable
//     account), so a locked role is preserved verbatim. The old unconditional
//     `role: detail.role,` must be gone from both.
assert(
    /if \(detail\.role\) update\.role = detail\.role;/.test(src),
    'the approve/save write must add `role` ONLY for an assignable account (if (detail.role) update.role ' +
    '= detail.role), so a locked superadmin/operator role is never overwritten'
);
assert(
    (src.match(/if \(detail\.role\) update\.role = detail\.role;/g) || []).length === 2,
    'BOTH approveUser() and updateUserPermissions() must guard the role write — one missing guard still ' +
    'demotes a superadmin on that path'
);
assert(
    !/role: detail\.role,/.test(src),
    'the old unconditional `role: detail.role,` must be gone — that literal is what demoted a superadmin to ' +
    'Area Manager the moment they were approved or saved'
);

console.log('✅ Locked-role write-guard tests passed (superadmin displays as Superadmin and can never be ' +
    'demoted by an Approve/Save on this screen).');

// ---------------------------------------------------------------------------
// 5. THE APPROVAL QUEUE MUST EXCLUDE OUT-OF-BAND ROLES.
//
//     The reported bug, at its root: a self-registered account is created
//     role:'owner' + status:'pending'; the superadmin then re-roled it to
//     'superadmin' directly in Firestore. loadSuperadminUsers() filtered ONLY
//     on status, so the still-pending superadmin kept showing up in the User
//     Approvals list. The rule is now explicit: a superadmin (the approver) and
//     an operator (made directly in Firestore, per docs/reset.html) are NEVER
//     approval candidates. isApprovalQueueRole() is the single source of that.
// ---------------------------------------------------------------------------

// (a) The predicate itself: out-of-band roles are excluded, everything else stays.
assert.strictEqual(isApprovalQueueRole({ role: 'superadmin' }), false,
    'a superadmin must NOT be an approval-queue candidate — they are the approver, not an approver\'s subject');
assert.strictEqual(isApprovalQueueRole({ role: 'operator' }), false,
    'an operator must NOT be an approval-queue candidate — created directly in Firestore');
assert.strictEqual(isApprovalQueueRole({ role: 'SUPERADMIN' }), false,
    'the exclusion is case-insensitive, like every other role check in the app');
['owner', 'hr', 'rmsm'].forEach((role) => {
    assert.strictEqual(isApprovalQueueRole({ role: role }), true,
        `${role} IS an approval-queue candidate — it is one of the three assignable roles`);
});
assert.strictEqual(isApprovalQueueRole({}), true,
    'a role-less account still defaults to owner and stays an approval candidate');
assert.strictEqual(isApprovalQueueRole({ role: 'viewer' }), true,
    'only superadmin/operator are out-of-band; an unknown role is not silently hidden from the queue');

// (b) loadSuperadminUsers() MUST actually apply the filter — and it must apply
//     it AFTER the status if/else, so the "empty → show all" fallback (which
//     re-derives from snapshot.docs) cannot smuggle a superadmin back in.
assert(
    /users = users\.filter\(isApprovalQueueRole\);/.test(src),
    'loadSuperadminUsers() must filter the queue through isApprovalQueueRole(), or a re-roled superadmin ' +
    'lingers in the list'
);
const queueFilterAt = src.indexOf('users = users.filter(isApprovalQueueRole);');
const fallbackAt = src.indexOf("users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(user => {");
assert(
    queueFilterAt > fallbackAt && fallbackAt > -1,
    'the isApprovalQueueRole() filter must run AFTER the "empty → show all" fallback re-derives from ' +
    'snapshot.docs, otherwise a superadmin is pulled straight back into the list through the fallback'
);

console.log('✅ Approval-queue role filter tests passed (superadmin + operator are excluded from the queue; ' +
    'owner/hr/rmsm remain; the filter runs after the fallback).');
