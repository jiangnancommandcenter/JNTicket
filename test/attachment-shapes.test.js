// Functional test for ATTACHMENT RENDERING across both writers' shapes.
//
// THE BUG THIS LOCKS DOWN
// -----------------------
// A ticket uploaded through the Area Manager form rendered an attachment card
// with `href=""`, `data-public-id=""`, the fallback name "Attachment 1", and a
// real file size (1.22 MB) — and clicking it navigated the whole app to its own
// URL instead of opening the viewer.
//
// Two independent defects, both required:
//
//   1. SHAPE MISMATCH. js/owner-ticket-form.js writes
//        { url, publicId, fileName, mimeType, bytes }
//      while every renderer in script.js reads
//        { secure_url, public_id, name, resource_type, format, bytes }
//      The ONLY shared key is `bytes` — which is exactly why the size rendered
//      and the link did not. The data was never lost; the reader looked for keys
//      the writer never produced.
//
//   2. `href=""` IS A REAL LINK TO THE CURRENT PAGE. The click guard did
//      `if (!url) return;` BEFORE `e.preventDefault()`, so a dead attachment
//      navigated the page instead of being ignored.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const scriptSrc = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const formSrc = fs.readFileSync(path.join(ROOT, 'js', 'owner-ticket-form.js'), 'utf8');
// The click guard lives here since the viewer was shared with ownerdashboard.html.
const viewerSrc = fs.readFileSync(path.join(ROOT, 'js', 'attachment-viewer.js'), 'utf8');

console.log('Testing attachment rendering (both writer shapes + no empty href)...');

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

// ============================================================================
// 1. normalizeAttachment() must understand BOTH shapes
// ============================================================================
const sandbox = { console, URL, encodeURI, decodeURI };
sandbox.window = sandbox;
vm.createContext(sandbox);
// These normalisers moved to js/attachment-viewer.js so the Owner Dashboard could
// share them; script.js now delegates. The logic is asserted where it LIVES,
// which is the whole point of the move.
vm.runInContext([
    extractFn(viewerSrc, 'normalizeFileUrl'),
    extractFn(viewerSrc, 'normalizeAttachment')
].join('\n'), sandbox);
const norm = sandbox.normalizeAttachment;

// The shape the Area Manager form writes — the one that produced the bug.
const fromForm = norm({
    url: 'https://res.cloudinary.com/demo/video/upload/v1/clip.mp4',
    publicId: 'rcms/abc123',
    fileName: 'Incident clip.mp4',
    mimeType: 'video/mp4',
    bytes: 1220000
});
assert.strictEqual(fromForm.url, 'https://res.cloudinary.com/demo/video/upload/v1/clip.mp4',
    "normalizeAttachment() must read the Area Manager form's `url` key");
assert.strictEqual(fromForm.publicId, 'rcms/abc123',
    'normalizeAttachment() must read `publicId`');
assert.strictEqual(fromForm.name, 'Incident clip.mp4', 'it must read `fileName`');
assert.strictEqual(fromForm.bytes, 1220000, 'the size must survive');
assert.strictEqual(fromForm.resourceType, 'video',
    'resource_type must be DERIVED from mimeType, or a video renders as a plain file icon');
assert.strictEqual(fromForm.format, 'mp4', 'the icon format must fall back to the extension');

// The original Cloudinary shape must keep working untouched.
const fromCloudinary = norm({
    secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/photo.jpg',
    public_id: 'rcms/xyz789',
    name: 'photo.jpg',
    resource_type: 'image',
    format: 'jpg',
    bytes: 2048
});
assert.strictEqual(fromCloudinary.url, 'https://res.cloudinary.com/demo/image/upload/v1/photo.jpg',
    'the Cloudinary shape must still be understood');
assert.strictEqual(fromCloudinary.publicId, 'rcms/xyz789', 'public_id must still be read');
assert.strictEqual(fromCloudinary.name, 'photo.jpg', 'name must still be read');
assert.strictEqual(fromCloudinary.resourceType, 'image', 'resource_type must still win over mimeType');
console.log('  PASS  both writer shapes normalise to one canonical attachment');

// ============================================================================
// 2. NO renderer may emit href=""
// ============================================================================
// Asserted on the SOURCE, because the renderers are template strings that need
// a full DOM to execute. The behavioural half is covered by #1: `isBroken` is
// derived from `!norm.url`, so an empty url takes the div branch, never the
// anchor branch.
['renderTicketAttachments', 'renderApprovalAttachments', 'renderRevisionAttachments']
    .forEach(function (fnName) {
        const body = extractFn(scriptSrc, fnName);
        assert(/isBroken/.test(body),
            fnName + '() must compute `isBroken` and render a div instead of an anchor when there is no URL');
        assert(!/att\.secure_url \|\| ''/.test(body),
            fnName + '() must read attachments through normalizeAttachment(), not the Cloudinary keys alone');
    });
console.log('  PASS  every ticket renderer gates its anchor on a real URL');

// ============================================================================
// 3. The click guard must preventDefault BEFORE bailing on an empty URL
// ============================================================================
// The guard moved out of script.js when the viewer became a shared module, so it
// is asserted against js/attachment-viewer.js. The selectors are a named
// constant there, so the handler is located by its click BINDING rather than by
// a selector string that only ever appeared inline.
const guardAt = viewerSrc.indexOf("document.addEventListener('click'");
assert(guardAt > -1, 'the attachment click handler was not found in js/attachment-viewer.js');
// Search FORWARD from guardAt so a bare indexOf cannot match an earlier spot.
const preventAt = viewerSrc.indexOf('e.preventDefault()', guardAt);
const bailAt = viewerSrc.indexOf("if (!url || url === '#') return;", guardAt);
assert(preventAt > -1, 'the click handler must call e.preventDefault()');
assert(bailAt > -1, 'the click handler must still guard on an empty URL');
assert(preventAt < bailAt,
    'e.preventDefault() MUST run BEFORE the `if (!url) return;` guard. An anchor with href="" '
    + 'is a real link to the current page, so bailing out first let a dead attachment navigate '
    + 'the app to its own URL instead of being ignored — the reported symptom.');
console.log('  PASS  preventDefault() runs before the empty-URL bail-out');

// ============================================================================
// 5. THE WRITE SIDE MUST NEVER PRODUCE `undefined`
// ============================================================================
// THE BUG: "Submit for Approval" died with
//   FirebaseError: DocumentReference.update() called with invalid data.
//   Unsupported field value: undefined (found in field resolutionAttachmentUrl)
// Every write was `X.length > 0 ? X[0].secure_url : ''` — and that ternary is a
// TRAP: the false branch yields '' but the true branch yields `undefined` for
// anything uploaded through the Area Manager form (which stores `url`, not
// `secure_url`). Firestore rejects undefined outright, so the whole update()
// threw and the resolution was lost with NO field written.
vm.runInContext(extractFn(scriptSrc, 'attachmentUrl'), sandbox);
const url = sandbox.attachmentUrl;

// The exact record that broke it: form-shaped, so no secure_url anywhere.
assert.strictEqual(url({ url: 'https://res.cloudinary.com/x/video/upload/v1/c.mp4', publicId: 'a', bytes: 5 }),
    'https://res.cloudinary.com/x/video/upload/v1/c.mp4',
    "attachmentUrl() must read the Area Manager form's `url`");
assert.strictEqual(url({ secure_url: 'https://res.cloudinary.com/x/image/upload/v1/p.jpg', name: 'p.jpg' }),
    'https://res.cloudinary.com/x/image/upload/v1/p.jpg', 'and the Cloudinary `secure_url` too');
assert.strictEqual(url({ bytes: 500 }), '',
    'a record with no URL anywhere MUST yield "" — Firestore rejects undefined, which is '
    + 'what killed the submission');
assert.strictEqual(url(null), '', 'null must yield ""');
assert.strictEqual(url(undefined), '', 'undefined must yield ""');
console.log('  PASS  attachmentUrl() always returns a string, never undefined');

// And no write site may read X[0].secure_url directly again.
const writes = scriptSrc.match(/resolutionAttachmentUrl\s*[:=][^\n]*/g) || [];
assert(writes.length >= 9,
    'sanity: the expected number of resolutionAttachmentUrl write sites is still present (found '
    + writes.length + ')');
writes.forEach(function (line) {
    if (/^\s*\*/.test(line)) return;                 // skip comment lines
    assert(!/\[0\]\.secure_url/.test(line),
        'no resolutionAttachmentUrl write may read [0].secure_url directly — it is undefined for '
        + 'form-shaped records. Offending line: ' + line.trim());
    assert(/attachmentUrl\(/.test(line) || /''/.test(line),
        'every resolutionAttachmentUrl write must route through attachmentUrl() or be a literal '
        + "'': " + line.trim());
});
console.log('  PASS  all ' + writes.length + ' resolutionAttachmentUrl writes are undefined-safe');

// ============================================================================
// 4. The writer must emit the canonical shape too
// ============================================================================
assert(/secure_url:\s*payload\.secure_url/.test(formSrc) && /public_id:\s*payload\.public_id/.test(formSrc),
    'js/owner-ticket-form.js must ALSO write secure_url/public_id — otherwise the very next '
    + 'upload reproduces the same mismatch, even though the reader now tolerates both shapes');
assert(/name:\s*file\.name/.test(formSrc), 'it must also write `name` so the filename is not "Attachment 1"');

console.log('\n✅ Attachment tests passed (both writer shapes normalise to one canonical record; a '
    + 'URL-less record renders an unclickable card instead of an empty anchor; the click guard '
    + 'cancels navigation before bailing; and the Area Manager form writes the canonical keys so '
    + 'the two writers can no longer drift apart).');


// A record with no URL at all must be reported as broken, never as a valid link.
const broken = norm({ bytes: 500, fileName: 'gone.png' });
assert.strictEqual(broken.url, '',
    'an attachment with no URL anywhere must normalise to url === "" — that is what makes '
    + 'the renderer emit a dead card instead of an anchor');
assert.strictEqual(norm(null), null, 'null must not throw');
assert.strictEqual(norm(undefined), null, 'undefined must not throw');
assert.strictEqual(norm('a string'), null, 'a non-object must not throw');
console.log('  PASS  a URL-less record is detected, and junk input is safe');
