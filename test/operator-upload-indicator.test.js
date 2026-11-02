// ===========================================================================
//  OPERATOR UPLOAD / SUBMIT INDICATOR — Resolve, Revise & Violation
// ===========================================================================
// THE BUG THIS LOCKS DOWN. Asked for as "the operator part attach the file and
// submit — put an indicator, because right now there is no indicator". There
// were four separate causes, all in the two operator modals of main.html
// (#resolveModal / #revisionModal), and each is pinned below:
//
//   1. The submit button only ever got `disabled`. No spinner, no label change,
//      for the whole of a Cloudinary upload AND a Firestore write.
//   2. `resetUploadProgress()` was called at the START of submit, hiding the
//      progress bar that had been working during attach — and then
//      `finishUploadProgress(..., true)` pinned it at 100% BEFORE the write, so
//      100% meant "not started" rather than "done".
//   3. `autoUploadSelectedFiles()` set statusEl.textContent = 'Uploading...'
//      and then called resetUploadProgress() on the very next line, which clears
//      that text. Selecting a file produced literally no visible output.
//   4. The per-file loops fed each file's raw 0-100 pct into the shared bar, so
//      three files produced 0->100, 0->100, 0->100.
//
// Plus a latent landmine: `resolveUploadStatus` was USED in the Resolve handler
// but never DECLARED — it only resolved because `<span id="resolveUploadStatus">`
// creates an implicit window property via named element access.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const scriptSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

/** Extract a named top-level function, brace-matched. */
function extractFn(src, name) {
    const start = src.indexOf('function ' + name + '(');
    assert(start > -1, name + '() not found');
    let depth = 0;
    for (let j = src.indexOf('{', start); j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
    }
    throw new Error('could not find the end of ' + name + '()');
}

console.log('Testing operator upload/submit indicators (Resolve + Revise + Violation)...');

// ---------------------------------------------------------------------------
// 1. aggregateUploadPercent — the bar must climb, never restart
// ---------------------------------------------------------------------------
const sandbox = { console };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(
    extractFn(scriptSrc, 'aggregateUploadPercent') + '\n' +
    extractFn(scriptSrc, 'setSubmitBusy'),
    sandbox
);
const agg = sandbox.aggregateUploadPercent;
const setSubmitBusy = sandbox.setSubmitBusy;

// Simulate exactly what the submit loop does for a 3-file batch, and collect
// every value the bar would have been set to.
const observed = [];
for (let i = 0; i < 3; i++) {
    for (const pct of [0, 25, 50, 75, 100]) observed.push(agg(i, pct, 3));
}

for (let k = 1; k < observed.length; k++) {
    assert(observed[k] >= observed[k - 1],
        'bar must never go backwards: ' + observed[k - 1] + ' -> ' + observed[k] +
        ' (a restart is what the operator saw before)');
}
assert.strictEqual(observed[0], 0, 'a fresh batch starts at 0%');
assert.strictEqual(observed[observed.length - 1], 100, 'the last file ends at 100%');
assert(Math.abs(agg(0, 100, 3) - 100 / 3) < 1e-9, 'one of three files done = 1/3');
assert(Math.abs(agg(1, 100, 3) - 200 / 3) < 1e-9, 'two of three files done = 2/3');

// Guards: a zero/absent total must not divide by zero into NaN, which would
// write "NaN%" straight into the progress text.
assert.strictEqual(agg(0, 50, 0), 0, 'zero files must not divide by zero');
assert.strictEqual(agg(0, 50, undefined), 0, 'undefined total must not divide by zero');
for (const bad of [-10, 150, NaN, undefined]) {
    const v = agg(2, bad, 3);
    assert(Number.isFinite(v) && v >= 0 && v <= 100,
        'out-of-range pct ' + bad + ' must stay clamped, got ' + v);
}

// ---------------------------------------------------------------------------
// 2. setSubmitBusy — spinner on, exact original label back off
// ---------------------------------------------------------------------------
function fakeBtn(idleHtml) {
    return {
        innerHTML: idleHtml,
        disabled: false,
        dataset: {},
        classList: {
            _s: new Set(),
            add(c) { this._s.add(c); },
            remove(c) { this._s.delete(c); },
            has(c) { return this._s.has(c); }
        }
    };
}

const RESOLVE_IDLE = '<i class="fas fa-paper-plane"></i> Submit for Approval';
const REVISE_IDLE = '<i class="fas fa-redo-alt"></i> Resubmit for Approval';

for (const [label, idle] of [['Resolve', RESOLVE_IDLE], ['Revise', REVISE_IDLE]]) {
    const btn = fakeBtn(idle);
    setSubmitBusy(btn, true);

    assert(btn.disabled, label + ': button must be disabled while submitting');
    assert(btn.classList.has('is-busy'), label + ': .is-busy drives the busy styling');
    assert(/fa-spin/.test(btn.innerHTML),
        label + ': a SPINNING icon is the indicator the operator was missing');
    assert(/Submitting/.test(btn.innerHTML),
        label + ': the label must say what is happening, not just go grey');

    setSubmitBusy(btn, false);

    assert(!btn.disabled, label + ': button must be re-enabled in the finally block');
    assert(!btn.classList.has('is-busy'), label + ': .is-busy must be removed');
    assert.strictEqual(btn.innerHTML, idle,
        label + ': the ORIGINAL label must come back — the two buttons carry ' +
        'different icons and wording, so a hard-coded restore would be wrong');

    // The double-tap guard relies on this staying put.
    assert(!btn.dataset.idleHtml,
        label + ': the stashed idle markup must be cleared, or the next busy ' +
        'cycle would re-stash the spinner and the button could never be restored');
}

// Re-entrancy: a second busy(true) before the finally must NOT overwrite the
// stashed idle copy with the spinner markup, or the label is lost forever.
const re = fakeBtn(RESOLVE_IDLE);
setSubmitBusy(re, true);
setSubmitBusy(re, true);
setSubmitBusy(re, false);
assert.strictEqual(re.innerHTML, RESOLVE_IDLE,
    'double setSubmitBusy(true) must not capture the spinner as the idle label');

// A null button (the element is absent from a given page) must not throw —
// several call sites guard with `if (btn)` and must keep working.
setSubmitBusy(null, true);
setSubmitBusy(undefined, false);

// ---------------------------------------------------------------------------
// 3. Both handlers must use the indicator, and must not wipe it first
// ---------------------------------------------------------------------------
/**
 * Strip `//` line comments so the assertions below test CODE, not prose.
 * Both handlers carry a comment explaining why they must NOT call
 * resetUploadProgress() — and a naive substring match happily "finds" the
 * forbidden call inside that explanation, which is a test that fails on a
 * correct implementation.
 */
function stripLineComments(src) {
    return src
        .split('\n')
        .map(line => {
            const at = line.indexOf('//');
            return at === -1 ? line : line.slice(0, at);
        })
        .join('\n');
}

// Slice each modal's submit handler out of script.js by its own id.
function handlerFor(btnId) {
    const at = scriptSrc.indexOf("const btn = " + btnId + ";");
    assert(at > -1, btnId + ' handler not found');
    const end = scriptSrc.indexOf('\n    });\n}', at);
    assert(end > -1, 'could not find the end of ' + btnId + ' handler');
    return stripLineComments(scriptSrc.slice(at, end));
}

for (const [label, btnId, statusId] of [
    ['Resolve', 'submitResolutionBtn', 'resolveUploadStatus'],
    ['Revise', 'submitRevisionBtn', 'revisionUploadStatus']
]) {
    const h = handlerFor(btnId);

    assert(/setSubmitBusy\(btn, true\)/.test(h),
        label + ': must set the busy spinner before the upload/write starts');
    assert(/setSubmitBusy\(btn, false\)/.test(h),
        label + ': must restore the button in the finally block — otherwise the ' +
        'spinner is left permanently on a clickable button');
    assert(/if \(btn && btn\.disabled\) return;/.test(h),
        label + ': needs the double-tap guard');

    // The regression that caused the original complaint: resetUploadProgress
    // removes .visible, so calling it here would hide the bar we just built.
    assert(!/resetUploadProgress\(/.test(h),
        label + ': must NOT resetUploadProgress on submit — that removes .visible ' +
        'and hides the indicator at the exact moment the operator clicks Submit');

    // 100% BEFORE the write reads as "done" while nothing has been written.
    assert(!/finishUploadProgress\(\w+, true\)/.test(h),
        label + ': must not mark the bar 100% before the Firestore write — 100% ' +
        'means "finished", and the write has not started yet');

    assert(/setUploadProgressIndeterminate\(/.test(h),
        label + ': needs the indeterminate state during the Firestore write');
    assert(h.indexOf('setUploadProgressIndeterminate') < h.indexOf('await firestoreService.updateTicket'),
        label + ': the indeterminate state must be entered BEFORE the write awaits');
    assert(/aggregateUploadPercent\(/.test(h),
        label + ': the batch loop must aggregate progress, not restart per file');

    // A failed submit must be visible, not just console.log'd.
    assert(new RegExp(statusId + "\\.classList\\.add\\('error'\\)").test(h),
        label + ': a failed submit must set an error indicator on ' + statusId);
}

// ---------------------------------------------------------------------------
// 4. The latent landmine: resolveUploadStatus must be DECLARED
// ---------------------------------------------------------------------------
assert(/const resolveUploadStatus = \$\('#resolveUploadStatus'\);/.test(scriptSrc),
    'resolveUploadStatus is used in the Resolve handler and must be declared ' +
    'explicitly. It previously only resolved via the implicit window property ' +
    'that id="resolveUploadStatus" happens to create.');

// And every status/progress element the JS drives must exist in the markup it
// is queried against — a renamed id fails silently at runtime, not at parse time.
for (const id of ['resolveUploadStatus', 'revisionUploadStatus',
    'resolveUploadProgressWrap', 'revisionUploadProgressWrap']) {
    assert(mainSrc.includes('id="' + id + '"'),
        'main.html is missing #' + id + ', which script.js queries');
}

// ---------------------------------------------------------------------------
// 5. The attach step must announce itself (cause #3)
// ---------------------------------------------------------------------------
{
    const at = scriptSrc.indexOf('async function autoUploadSelectedFiles');
    assert(at > -1, 'autoUploadSelectedFiles() not found');
    const body = scriptSrc.slice(at, scriptSrc.indexOf('\nasync function ', at + 10));
    const resetAt = body.indexOf('resetUploadProgress(widget)');
    const announceAt = body.indexOf("statusEl.textContent = 'Uploading");
    assert(resetAt > -1 && announceAt > -1,
        'autoUploadSelectedFiles must both reset and announce');
    assert(resetAt < announceAt,
        'resetUploadProgress() clears .attachment-upload-status, so it must run ' +
        'BEFORE the "Uploading…" text — the old order deleted that text on the ' +
        'next line, which is why selecting a file showed nothing at all');
}

// ---------------------------------------------------------------------------
// 6. The CSS the indicator depends on
// ---------------------------------------------------------------------------
assert(/\.upload-progress-wrap\.indeterminate \.upload-progress-bar/.test(cssSrc),
    'style.css needs the .indeterminate bar treatment');
assert(/@keyframes uploadIndeterminateSweep/.test(cssSrc),
    'style.css needs the sweep keyframes');
assert(/\.btn\.is-busy/.test(cssSrc),
    'style.css needs the .is-busy button treatment');
assert(/prefers-reduced-motion[\s\S]{0,600}indeterminate/.test(cssSrc),
    'the sweep animation must be disabled under prefers-reduced-motion');

// finishUploadProgress / resetUploadProgress must both clear `indeterminate`,
// or a finished bar would keep crawling after the modal is reused.
for (const fn of ['resetUploadProgress', 'finishUploadProgress']) {
    const src = extractFn(scriptSrc, fn);
    assert(/classList\.remove\([^)]*'indeterminate'/.test(src),
        fn + '() must remove the indeterminate class or a completed bar keeps animating');
}

// ---------------------------------------------------------------------------
// 7. THE VIOLATION FORM (+ Report Violation) — the modal actually reported
// ---------------------------------------------------------------------------
// "I clicked + report violation, attached files, submitted, and there was no
// indication — the modal just disappeared." This modal is NOT auto-upload:
// `violationPendingFiles` only STAGES files and the real Cloudinary calls happen
// in saveViolationForm(). So the two halves of the fix are deliberately
// different things:
//
//   * on ATTACH  — an honest staged-count line (NOT a fake 0->100 bar; nothing
//     has been transmitted yet, and the report's folder path depends on
//     store/subject/incident-date which may not even be filled in)
//   * on SUBMIT  — the real per-file bar, then the indeterminate sweep for the
//     PDF build, which was the longest completely silent step

{
    const submit = stripLineComments(extractFn(scriptSrc, 'saveViolationForm'));
    const attach = stripLineComments(extractFn(scriptSrc, 'addViolationPendingFiles'));

    // --- submit button ---
    assert(/setSubmitBusy\(btnSubmitViolation, true\)/.test(submit),
        'violation: the submit button must show its busy state');
    assert(/setSubmitBusy\(btnSubmitViolation, false\)/.test(submit),
        'violation: the button must be restored in the finally block');
    // Grey ONLY while busy: a bare `disabled = false` leaves the spinner markup
    // behind, and a bare `disabled = true` leaves the button unlabelled.
    assert(!/btnSubmitViolation\.disabled = (true|false)/.test(submit),
        'violation: use setSubmitBusy(), not a bare .disabled assignment — the ' +
        'operator asked for green when idle and grey+spinner while uploading');

    // --- the real upload bar, aggregated across files ---
    assert(/aggregateUploadPercent\(/.test(submit),
        'violation: the evidence upload must aggregate progress, not restart per file');
    assert(/Uploading \$\{i \+ 1\} of \$\{files\.length\}/.test(submit),
        'violation: the operator must be told which file is uploading');

    // --- the PDF step, which previously showed NOTHING ---
    assert(/setUploadProgressIndeterminate\(violationUploadWidget\)/.test(submit),
        'violation: the PDF build/upload needs the indeterminate indicator — it ' +
        'is the longest step and used to be completely silent');
    assert(submit.indexOf('Generating PDF report') > -1,
        'violation: the PDF phase needs a label');
    assert(submit.indexOf('setUploadProgressIndeterminate') < submit.indexOf('await autoSaveViolationReportPdf'),
        'violation: the PDF indicator must be entered BEFORE awaiting the build');

    // --- failure must be visible where the operator is looking ---
    assert(/finishUploadProgress\(violationUploadWidget, false\)/.test(submit),
        'violation: a failed submit must switch the bar out of indeterminate ' +
        'into an error state — a sweeping animation on a failure reads as "busy"');

    // --- attach-time line ---
    assert(/updateViolationAttachStatus\(\)/.test(attach),
        'violation: attaching files must state how many are staged');
    const status = stripLineComments(extractFn(scriptSrc, 'updateViolationAttachStatus'));
    assert(/file\(s\) attached/.test(status),
        'violation: the attach line must report a count');
    assert(/violationPendingFiles\.length === 0/.test(status),
        'violation: evidence is OPTIONAL — zero files is a valid state and must ' +
        'clear the line rather than report a failure');
}

// ---------------------------------------------------------------------------
// 8. THE VIOLATION DROPDZONE MUST BE CLICKABLE (drag-and-drop alone was broken)
// ---------------------------------------------------------------------------
// "the attach file is not clickable, I can only drag files."
//
// THE BUG. bindViolationUploadWidget() had:
//     dropzone.addEventListener('click', e => { e.preventDefault(); input.click(); });
// but the dropzone is a <label> that WRAPS the file input, so the browser
// ALREADY forwards the click natively. preventDefault() cancelled that, leaving
// only a synthetic input.click() — and the input is hidden with
// `clip: rect(0 0 0 0)`, which several browsers refuse to open a dialog for.
// Drag-and-drop kept working because it reads e.dataTransfer.files directly and
// never touches the input, which is exactly why only one path was broken.
{
    const bind = stripLineComments(extractFn(scriptSrc, 'bindViolationUploadWidget'));
    assert(!/dropzone\.addEventListener\('click'/.test(bind),
        'violation: the dropzone click handler must stay DELETED — re-adding it ' +
        'cancels the <label>\'s native file-input forwarding with preventDefault() ' +
        'and the zone silently stops opening the picker (drag-and-drop masks it)');
    assert(!/preventDefault[\s\S]{0,40}input\.click\(\)/.test(bind),
        'violation: preventDefault() + input.click() is the exact anti-pattern ' +
        'that broke clicking; the label must do this natively');

    // The native forwarding only works while the input is a CHILD of the label.
    // If someone "tidies up" the markup and moves it out, clicks die again with
    // no JS left to catch them.
    const dzAt = mainSrc.indexOf('id="violationDropzone"');
    assert(dzAt > -1, 'violation dropzone not found in main.html');
    const dzOpen = mainSrc.lastIndexOf('<label', dzAt);
    const dzClose = mainSrc.indexOf('</label>', dzAt);
    const inputAt = mainSrc.indexOf('id="violationAttachmentInput"');
    assert(inputAt > dzAt && inputAt < dzClose,
        'the file input must stay INSIDE the dropzone <label>, otherwise the ' +
        'native click-to-open behaviour this fix relies on is gone');

    // And the change handler that actually stages the files must remain bound.
    assert(/input\.addEventListener\('change'/.test(bind),
        'violation: the input change handler must stay bound — it is what calls ' +
        'addViolationPendingFiles() for BOTH click-selected and dropped files');
}

console.log('  ✓ operator upload/submit indicator — all checks passed');