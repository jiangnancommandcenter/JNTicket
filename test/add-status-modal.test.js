// ===========================================================================
//  ADD STATUS MODAL - THE BRANCH FIELD MUST NEVER VANISH (regression)
//
//  THE REPORTED BUG. In the Add Status modal, clicking the "New" button (the
//  inline add-a-new-branch toggle) hid the Branch row. Close the modal and
//  re-open it and the row was gone FOREVER - label, select and the New
//  button - until a full page refresh.
//
//  WHY IT HAPPENED. The toggle did:
//
//      branchSelect.closest('.form-group').style.display = 'none';
//
//  ...but #btnAddBranch lives INSIDE that same .form-group (main.html), so
//  the button hid itself. Two consequences:
//    1. The toggle's own restore branch (the else) was unreachable - the
//       only element that could undo the hide was the element that got
//       hidden. Dead code.
//    2. Neither openAddModal() nor closeAddModalFn() ever un-hid the group
//       or re-added the required attribute the toggle strips, so the inline
//       display:none survived close -> reopen. Only a refresh (which
//       discards inline styles) cleared it.
//
//  THE FIX, pinned here:
//    1. resetBranchField() restores .form-group/label/select display AND
//       required, and runs on BOTH open and close, so every close path
//       (X, Cancel, backdrop click, successful save) starts clean.
//    2. The toggle moves NOTHING: the Branch row (label + select + button)
//       always stays put and only #newBranchGroup appears below it. The
//       first fix stopped the forever-vanish by hiding just the label and
//       select instead of the whole group - but that still shifted the
//       form upward on every click (the reported "pumupunta sa taas"
//       jump), and focus() could scroll the modal. Nothing hides now, and
//       focus uses preventScroll.
//
//  These are text assertions: a static check honestly proves the code that
//  hid the field is gone and that the reset exists on every path. It cannot
//  click the button, but it fails loudly the moment either half is reverted.
//
//  Run: npm test
// ===========================================================================
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const scriptSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const mainHtml = fs.readFileSync(path.join(ROOT, 'main.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

console.log('Testing the Add Status modal Branch field...');

/** Slice [start, end of body] by brace matching - never by blank line. */
function sliceBody(src, start, label) {
    const open = src.indexOf('{', start);
    assert(open !== -1, 'no body found for ' + label);
    let depth = 0, seen = false;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') { depth++; seen = true; }
        else if (src[i] === '}') {
            depth--;
            if (seen && depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error('body could not be delimited for ' + label);
}

/** Extract a function's full source by brace matching. */
function extractFunction(src, name) {
    const start = src.search(new RegExp('(async\\s+)?function\\s+' + name + '\\s*\\('));
    assert(start !== -1, name + '() must exist in script.js');
    return sliceBody(src, start, name + '()');
}

/** Extract an event listener starting at anchor through its body. */
function extractListener(src, anchor) {
    const at = src.indexOf(anchor);
    assert(at !== -1, 'listener not found in script.js: ' + anchor);
    return sliceBody(src, at, anchor);
}

// ---------------------------------------------------------------------------
// 1. The reset helper exists and restores EVERYTHING the toggle breaks.
// ---------------------------------------------------------------------------
const reset = extractFunction(scriptSrc, 'resetBranchField');

assert(
    /branchSelect\.closest\('\.form-group'\)/.test(reset),
    'resetBranchField() must target the Branch .form-group'
);
assert(
    /branchGroup\.style\.display\s*=\s*''/.test(reset),
    "resetBranchField() must clear the form-group inline display (display = '')"
);
assert(
    /branchSelect\.style\.display\s*=\s*''/.test(reset),
    "resetBranchField() must make #branchSelect visible again (display = '')"
);
assert(
    /label\[for="branchSelect"\]/.test(reset),
    'resetBranchField() must restore the Branch label the toggle hides'
);
assert(
    /branchSelect\.setAttribute\('required'/.test(reset),
    "resetBranchField() must put the removed 'required' attribute back on #branchSelect"
);
assert(
    /newBranchGroup\.style\.display\s*=\s*'none'/.test(reset),
    "resetBranchField() must collapse the New Branch Name field (display = 'none')"
);
assert(
    /newBranchInput\.value\s*=\s*''/.test(reset),
    "resetBranchField() must clear the New Branch Name input (value = '')"
);
assert(
    /newBranchInput\.removeAttribute\('required'\)/.test(reset),
    "resetBranchField() must drop #newBranchInput's required flag"
);

// ---------------------------------------------------------------------------
// 2. The reset runs on BOTH entry points: opening AND closing the modal.
//    Closing must reset too - that is the path the bug came through
//    (New -> close -> reopen -> field gone). Resetting only one side lets a
//    future edit reintroduce the stuck-hidden state.
// ---------------------------------------------------------------------------
const openBody = extractFunction(scriptSrc, 'openAddModal');
assert(
    /resetBranchField\(\)/.test(openBody),
    'openAddModal() must call resetBranchField() so the Branch row is always shown on open'
);

const closeBody = extractFunction(scriptSrc, 'closeAddModalFn');
assert(
    /resetBranchField\(\)/.test(closeBody),
    'closeAddModalFn() must call resetBranchField() - X, Cancel, backdrop and save must all reset'
);
assert(
    /addModal\.classList\.remove\('active'\)/.test(closeBody),
    'closeAddModalFn() must still remove the active class (it must actually close)'
);

// ---------------------------------------------------------------------------
// 3. The toggle must move NOTHING. Two regressions are pinned here:
//    (a) it must never hide the Branch row (label / select / .form-group) -
//        hiding shifted the whole form up on every click (the reported
//        "pumupunta sa taas" jump), and in the very first version it even
//        hid the New button itself, which made the restore branch dead
//        code;
//    (b) it must focus with preventScroll so the modal never jumps.
// ---------------------------------------------------------------------------
const toggle = extractListener(scriptSrc, "btnAddBranch.addEventListener('click'");
assert(
    !/closest\('\.form-group'\)\.style\.display\s*=\s*'none'/.test(toggle),
    "the toggle must not hide the whole .form-group - #btnAddBranch lives inside it"
);
assert(
    !/branchSelect\.style\.display\s*=\s*'none'/.test(toggle),
    'the toggle must not hide #branchSelect - the Branch row must stay put when New is pressed'
);
assert(
    !/branchLabel\.style\.display\s*=\s*'none'/.test(toggle),
    'the toggle must not hide the Branch label - hiding it shifted the form upward'
);
assert(
    /newBranchGroup\.style\.display\s*=/.test(toggle),
    'the toggle must still show/hide #newBranchGroup (that is its whole job)'
);
assert(
    /branchSelect\.removeAttribute\('required'\)/.test(toggle) &&
    /branchSelect\.setAttribute\('required'/.test(toggle),
    "the toggle must swap 'required' off #branchSelect in new mode and back on after"
);
assert(
    /newBranchInput\.setAttribute\('required'/.test(toggle) &&
    /newBranchInput\.removeAttribute\('required'\)/.test(toggle),
    "the toggle must make #newBranchInput required in new mode (native validation still blocks an empty submit) and drop it after"
);
assert(
    /focus\(\{\s*preventScroll:\s*true\s*\}\)/.test(toggle),
    'the toggle must focus the input with preventScroll - plain focus() was scrolling the modal'
);

// ---------------------------------------------------------------------------
// 4. Structure assumptions the fix depends on (main.html / style.css).
// ---------------------------------------------------------------------------
assert(mainHtml.includes('id="branchSelect"'), '#branchSelect must exist in main.html');
assert(mainHtml.includes('<label for="branchSelect">'), 'the Branch <label for="branchSelect"> must exist');

const btnAt = mainHtml.indexOf('id="btnAddBranch"');
assert(btnAt !== -1, '#btnAddBranch must exist in main.html');
const btnOpen = mainHtml.lastIndexOf('<button', btnAt);
assert(
    /type="button"/.test(mainHtml.slice(btnOpen, btnAt)),
    '#btnAddBranch must stay type="button" (it must not submit the form)'
);

// The reset assigns display = '', which hands control back to CSS. That only
// restores visibility if the base .form-group rule is not itself a hider.
const fgRuleAt = styleCss.search(/(^|\n)\s*\.form-group\s*\{/);
assert(fgRuleAt !== -1, 'expected a base .form-group rule in style.css');
const fgRule = styleCss.slice(fgRuleAt, styleCss.indexOf('}', fgRuleAt));
assert(
    !/display\s*:/.test(fgRule),
    'the base .form-group rule must not set display - resetBranchField() relies on display = "" restoring visibility'
);

console.log('');
console.log('OK: Add Status modal resets the Branch field on open + close; the New toggle moves nothing (no hiding, no scroll) and swaps required correctly.');
