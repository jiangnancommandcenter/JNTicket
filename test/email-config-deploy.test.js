// Deploy-safety guard for the APPROVAL EMAIL PORTAL LINK (js/email-config.js).
//
// The reported production bug: the link emailed to requesters pointed at
// `portal.jiangnanhotpot.com`, which has no public DNS record, so every customer
// saw "This site can't be reached / DNS_PROBE_FINISHED_NXDOMAIN".
//
// The rule this file enforces: you may leave `portalUrl` EMPTY (the link then
// auto-derives from the page the superadmin is on, which is the normal local
// workflow), but if you DO set it, it must be an address a stranger on the
// internet could open. That is the one mistake that reaches customers, and it
// is trivially avoidable — so it is a test failure, not a footnote.
//
// Run: npm test   (also runnable directly: node test/email-config-deploy.test.js)
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

// ---- 1. The real reachability classifier, loaded from js/email.js ------------
// Reusing the shipped function (rather than re-declaring the rules here) is the
// whole point: a second copy of these rules would drift from the one that runs
// in production, and the guard would start passing things the app rejects.
const emailSrc = fs.readFileSync(path.join(ROOT, 'js', 'email.js'), 'utf8');
const sandbox = { console: { log() {}, warn() {}, error() {}, info() {} }, URL, setTimeout, clearTimeout };
sandbox.window = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(emailSrc, sandbox);

assert.strictEqual(typeof sandbox.EmailService.publicHostProblem, 'function',
    'js/email.js must expose publicHostProblem() — this guard depends on it');

// ---- 2. Read the REAL config the site ships with ----------------------------
const configPath = path.join(ROOT, 'js', 'email-config.js');
assert(fs.existsSync(configPath), 'js/email-config.js is missing');
const configSrc = fs.readFileSync(configPath, 'utf8');
const configSandbox = { window: {} };
vm.createContext(configSandbox);
vm.runInContext(configSrc, configSandbox);
const config = configSandbox.window.EMAIL_CONFIG;

assert(config && typeof config === 'object', 'js/email-config.js must set window.EMAIL_CONFIG');

// ---- 3. THE RULE ----------------------------------------------------------
// Both links are checked, not just `portalUrl`. The APPROVAL email now sends
// `ownerDashboardUrl` (the login-gated Owner Dashboard) while the RE-ACCESS
// email still sends `portalUrl` (the login-free Track page). Checking only one
// of them would let the OTHER ship a dead link to customers, which is the exact
// failure this file exists to prevent.
const LINKS = [
  { key: 'portalUrl', note: 'the login-free Track page (re-access email)' },
  { key: 'ownerDashboardUrl', note: 'the Owner Dashboard (the APPROVAL email)' }
];

const linkValues = {};

LINKS.forEach(function (link) {
  const value = String(config[link.key] === undefined || config[link.key] === null ? '' : config[link.key]).trim();
  linkValues[link.key] = value;

  if (value) {
    const verdict = sandbox.EmailService.publicHostProblem(value);
    assert.strictEqual(verdict.ok, true,
      'EMAIL_CONFIG.' + link.key + ' is set to "' + value + '" but that is not reachable from the '
      + 'public internet (' + verdict.reason + ').\n'
      + '  It serves ' + link.note + '.\n'
      + '  Recipients would see "This site can\'t be reached / DNS_PROBE_FINISHED_NXDOMAIN".\n'
      + '  Either point ' + link.key + ' at the real public https:// address,\n'
      + '  or clear it to \'\' to auto-derive the link (correct while testing locally).');
  } else {
    // Empty is allowed and is the normal local workflow - but say so out loud,
    // because an empty value in PRODUCTION means the link silently follows
    // whatever host the superadmin happens to be browsing on.
    console.log('  note: EMAIL_CONFIG.' + link.key + ' is empty - the link auto-derives from the '
      + 'superadmin\'s current page (fine locally; MUST be pinned to a public address before go-live).');
  }
});

const portalUrl = linkValues.portalUrl;
// ---- 4. Sanity: the classifier still behaves, so rule 3 cannot pass vacuously
[
    ['http://localhost:5500/submit-ticket.html', false],
    ['http://192.168.1.50:5000/submit-ticket.html', false],
    ['file:///C:/portal/submit-ticket.html', false],
    ['http://portal.jiangnanhotpot.internal/submit-ticket.html', false],
    ['http://172.16.4.9/submit-ticket.html', false],
    ['https://example.com/submit-ticket.html', true],
    ['https://jiangnanhotpot.com/tickets/submit-ticket.html', true],
    ['https://192.168.example.com/submit-ticket.html', true]   // a NAME, not an address
].forEach(function (entry) {
    assert.strictEqual(sandbox.EmailService.publicHostProblem(entry[0]).ok, entry[1],
        'publicHostProblem("' + entry[0] + '") must be ' + entry[1]);
});

// ---- 5. localDev must be a real boolean (a typo'd string would silently enable it)
if (config.localDev !== undefined) {
    assert.strictEqual(typeof config.localDev, 'boolean',
        'EMAIL_CONFIG.localDev must be true or false, not ' + JSON.stringify(config.localDev)
        + ' — only the literal true turns dev mode on.');
}

console.log('OK: portal link deploy-safety assertions passed (portalUrl='
    + (portalUrl ? '"' + portalUrl + '"' : 'empty/auto-derive') + ').');