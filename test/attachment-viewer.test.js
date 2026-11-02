// Regression test: the in-app attachment viewer (lightbox).
//
// THE BUG THIS LOCKS DOWN
// -----------------------
// Only main.html had the lightbox -- its markup sat in main.html and its logic
// in script.js, which ownerdashboard.html does not load. So every attachment on
// the Owner Dashboard was a bare <a target="_blank">: a ticket file opened in a
// NEW TAB there, while the same file opened in the modal on the operator
// dashboard. The two dashboards disagreed about the same file.
//
// Pasting the dialog into ownerdashboard.html would NOT have fixed it. The
// delegated click handler matched `a.attachment-preview, a.upload-file-preview`
// inside `.attachments-grid, .upload-file-list, .modal-body, .modal-fields`,
// while the owner renderers emit `a.owner-attachment-image` /
// `a.owner-attachment-row` inside `.owner-attachment-list` -- class names that
// appear nowhere else. Those anchors matched nothing at all, so the new-tab
// behaviour would have survived the "fix".
//
// The fix is one shared module (js/attachment-viewer.js) whose selectors cover
// BOTH dialects, so both dashboards get the identical dialog.
//
// Run: npm test
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const moduleSrc = read('js/attachment-viewer.js');
const mainHtml = read('main.html');
const ownerHtml = read('ownerdashboard.html');
const scriptSrc = read('script.js');
const ownerDash = read('js/owner-dashboard.js');
const hrViol = read('js/hr-violations.js');

console.log('Testing shared attachment viewer (main.html + ownerdashboard.html)...');

// ============================================================================
// 1. Static wiring: both pages load the one module, neither keeps a copy
// ============================================================================
for (const [page, name] of [[mainHtml, 'main.html'], [ownerHtml, 'ownerdashboard.html']]) {
    assert(page.includes('js/attachment-viewer.js'),
        name + ' must load js/attachment-viewer.js -- without it its attachments open in a new tab');
    // The dialog is injected by the module, so a copy pasted into either page
    // means two dialogs that can drift (and a double-injection on main.html).
    assert(!/id="attachmentViewerModal"/.test(page),
        name + ' must NOT contain the attachmentViewerModal markup any more; the module injects it');
}

// script.js keeps only thin shims -- the implementation moved out.
assert(!scriptSrc.includes('function renderAttachmentViewerItem()'),
    'the viewer implementation must no longer live in script.js');
assert(scriptSrc.includes('window.AttachmentViewer'),
    'script.js must delegate to window.AttachmentViewer');
// The shim must pass the root explicitly: the module cannot reach for a
// script.js-only global, or it would be undefined on the owner dashboard.
assert(/openForRows\(violationFolderBrowser \|\| document, row\)/.test(scriptSrc),
    "openAttachmentViewerForRow() must pass #violationFolderBrowser explicitly as openForRows()'s root");

// ============================================================================
// 2. The selectors must cover the owner dashboard's dialect
// ============================================================================
const IN = moduleSrc.match(/PREVIEW_SELECTOR\s*=\s*([\s\S]*?);/);
const SC = moduleSrc.match(/SCOPE_SELECTOR\s*=\s*([\s\S]*?);/);
assert(IN && SC, 'PREVIEW_SELECTOR / SCOPE_SELECTOR must be declared');
const previewSel = IN[1], scopeSel = SC[1];

for (const sel of ['a.attachment-preview', 'a.upload-file-preview']) {
    assert(previewSel.includes(sel),
        'PREVIEW_SELECTOR must match ' + sel + ' or that attachment still opens a new tab');
}
for (const sel of ['.attachments-grid', '.owner-attachment-list', '.upload-widget']) {
    assert(scopeSel.includes(sel),
        'SCOPE_SELECTOR must include ' + sel + ' so prev/next walk the right siblings');
}

// The labels must be readable, or every owner file is titled "Attachment".
// The shared card labels every tile with .attachment-name, which nameFor() reads,
// so a file is titled by name on BOTH dashboards rather than as "Attachment".
assert(/\.attachment-name/.test(moduleSrc),
    'nameFor() must read .attachment-name, which the shared card emits');

// The Owner Dashboard used to render its OWN chips (owner-attachment-row /
// owner-attachment-image): a bare icon with no thumbnail, and a <div> wrapper
// around images that was not an anchor. It now renders the SAME shared card as
// main.html, so both files must delegate to the shared builder.
assert(ownerDash.includes('buildAttachmentCard'),
    'js/owner-dashboard.js must render the shared attachment card');
assert(hrViol.includes('buildAttachmentCard'),
    'js/hr-violations.js must render the shared attachment card');
for (const [nm, s] of [['js/owner-dashboard.js', ownerDash], ['js/hr-violations.js', hrViol]]) {
    assert(!/class="owner-attachment-(row|image)"/.test(s),
        nm + ' must not emit the old owner chips -- they carried no thumbnail and drifted from every other grid');
}
// The duplicated helpers that let them drift must be gone too.
assert(!/function getAttachmentColor/.test(ownerDash),
    'js/owner-dashboard.js must not keep a second getAttachmentColor; it disagreed with script.js on icon colour');
assert(!/function formatFileSize/.test(hrViol),
    'js/hr-violations.js must not keep a second formatFileSize');

console.log('  ok  one shared module, loaded by both pages, no duplicated dialog');
console.log('  ok  selectors cover both the main and owner attachment dialects');
// ============================================================================
// 3. Behaviour: an owner-dashboard chip must open the modal, not a new tab
// ============================================================================
// A minimal DOM: enough to run the module's own delegation and rendering. The
// dialog is pre-registered so ensureModal() finds it instead of parsing
// MODAL_HTML (that string is covered by the markup assertions in section 1).
function makeEl(tag, attrs) {
    const node = {
        tag: String(tag).toLowerCase(),
        attrs: attrs || {},
        children: [],
        parent: null,
        textContent: '',
        style: {},
        dataset: {},
        _cls() { return String(this.attrs.class || '').split(/\s+/).filter(Boolean); }
    };
    node._html = '';
    node._ls = {};
    node.classList = {
        add(c) { const cs = node._cls(); if (cs.indexOf(c) === -1) { cs.push(c); node.attrs.class = cs.join(' '); } },
        remove(c) { node.attrs.class = node._cls().filter(x => x !== c).join(' '); },
        contains(c) { return node._cls().indexOf(c) !== -1; }
    };
    Object.defineProperty(node, 'className', {
        get() { return node.attrs.class || ''; },
        set(v) { node.attrs.class = v; }
    });
    Object.defineProperty(node, 'innerHTML', {
        get() { return node._html; },
        // Assigning innerHTML replaces the children -- the module relies on this
        // to stop video playback and free memory on close.
        set(v) { node._html = v; node.children = []; }
    });
    node.appendChild = function (c) { c.parent = node; node.children.push(c); return c; };
    node.getAttribute = function (n) { return this.attrs[n] != null ? this.attrs[n] : null; };
    node.setAttribute = function (n, v) { node.attrs[n] = v; };
    // The module calls video.play() and tolerates the rejected promise when
    // autoplay is blocked; the stub resolves so the render path completes.
    node.play = function () { return Promise.resolve(); };
    node.matches = function (sel) {
        return String(sel).split(',').some(function (p) {
            p = p.trim();
            if (!p) return false;
            if (p.charAt(0) === '.') return node._cls().indexOf(p.slice(1)) !== -1;
            const bits = p.split('.');
            if (bits[0] && bits[0] !== '*' && bits[0].toLowerCase() !== node.tag) return false;
            return !bits[1] || node._cls().indexOf(bits[1]) !== -1;
        });
    };
    node.closest = function (sel) { let n = node; while (n) { if (n.matches(sel)) return n; n = n.parent; } return null; };
    node.querySelectorAll = function (sel) {
        const out = [];
        (function walk(n) { n.children.forEach(function (c) { if (c.matches(sel)) out.push(c); walk(c); }); })(node);
        return out;
    };
    node.querySelector = function (sel) { return this.querySelectorAll(sel)[0] || null; };
    node.addEventListener = function (t, fn) { (node._ls[t] = node._ls[t] || []).push(fn); };
    node.fireAt = function (t, ev) { (node._ls[t] || []).forEach(function (f) { f(ev || {}); }); };
    return node;
}

const doc = {
    readyState: 'complete',
    _byId: {},
    _listeners: {},
    createElement(t) { return makeEl(t); },
    getElementById(id) { return this._byId[id] || null; },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    fire(t, ev) { (this._listeners[t] || []).forEach(function (f) { f(ev); }); }
};
doc.body = makeEl('body');

function reg(id, tag, attrs) {
    const e = makeEl(tag, attrs); e.attrs.id = id;
    doc._byId[id] = e; doc.body.appendChild(e); return e;
}
const modal = reg('attachmentViewerModal', 'div', { class: 'modal-overlay attachment-viewer-overlay' });
reg('attachmentViewerBody', 'div', { class: 'modal-body attachment-viewer-body' });
reg('attachmentViewerTitle', 'span', {});
reg('attachmentViewerIcon', 'i', { class: 'fas fa-file' });
reg('attachmentViewerOpen', 'button', {});
reg('attachmentViewerClose', 'button', {});
reg('attachmentViewerPrev', 'button', {});
reg('attachmentViewerNext', 'button', {});
reg('attachmentViewerCount', 'span', {});

const openedTabs = [];
const sandbox = {
    console: console, document: doc, Math: Math, String: String, Array: Array,
    open: function (u) { openedTabs.push(u); return null; }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(moduleSrc, sandbox);
const viewer = sandbox.window.AttachmentViewer;
assert(viewer, 'the module must expose window.AttachmentViewer');

const $ = (id) => doc.getElementById(id);
function click(a, mods) {
    const ev = {
        target: a, defaultPrevented: false, button: 0,
        metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
        preventDefault() { this.defaultPrevented = true; }
    };
    Object.keys(mods || {}).forEach(function (k) { ev[k] = true; });
    doc.fire('click', ev);
    return ev;
}

// The REAL card markup, exactly as the shared builder emits it. Both dashboards
// now produce this, so it is the only fixture the viewer needs. `.attachment-name`
// is what the viewer reads for the header title, and an <img>/<video> child is
// what it sniffs to decide the media type.
const list = makeEl('div', { class: 'attachments-grid' });
doc.body.appendChild(list);
function chip(name, href, kind) {
    const a = makeEl('a', { class: 'attachment-preview', href: href, title: name });
    // A VIDEO card holds an <img> poster frame, NOT a <video> -- exactly what the
    // shared builder emits. An earlier version of this fixture used a <video>
    // child, which was the pre-consolidation markup; it kept passing while the
    // real app was broken, because the fixture no longer matched reality.
    if (kind === 'video' || kind === 'image') {
        a.appendChild(makeEl('img', {
            class: 'attachment-thumb attachment-thumb-' + kind,
            src: kind === 'video' ? href.replace(/\.mp4$/, '.jpg') : href
        }));
    } else {
        a.appendChild(makeEl('div', { class: 'attachment-file-icon' }));
    }
    const label = makeEl('span', { class: 'attachment-name' });
    label.textContent = name;
    a.appendChild(label);
    list.appendChild(a);
    return a;
}
// A fourth list, in the Owner Dashboard's own container, proves the viewer scopes
// prev/next to that container too instead of walking the whole page.
const ownerList = makeEl('div', { class: 'owner-attachment-list' });
doc.body.appendChild(ownerList);
function ownerChip(name, href) {
    const a = makeEl('a', { class: 'attachment-preview', href: href, title: name });
    a.appendChild(makeEl('img', { src: href }));
    const label = makeEl('span', { class: 'attachment-name' });
    label.textContent = name;
    a.appendChild(label);
    ownerList.appendChild(a);
    return a;
}
const img1 = chip('1856H Hinalo ang sauces.png', 'https://res.cloudinary.com/x/image/upload/v1/a.png', 'image');
const vid2 = chip('Incident clip.mp4', 'https://res.cloudinary.com/x/video/upload/v1/b.mp4', 'video');
const doc3 = chip('Incident report.docx', 'https://res.cloudinary.com/x/raw/upload/v1/c.docx');

// Clicking a file chip opens the modal -- the whole point of the fix.
const ev = click(vid2);
assert(ev.defaultPrevented, 'the click must be preventDefault()ed so the browser does not navigate');
assert(modal.classList.contains('active'), 'clicking an owner attachment chip must open the modal');
assert.strictEqual($('attachmentViewerTitle').textContent, 'Incident clip.mp4',
    'the header must show the file name read from .owner-attachment-name');
assert.strictEqual($('attachmentViewerCount').textContent, '2 / 3', 'the counter must show position 2 of 3');
assert.strictEqual($('attachmentViewerBody').children.length, 1, 'exactly one media element at a time');
assert.strictEqual($('attachmentViewerBody').children[0].tag, 'video', 'a .mp4 must render as <video>');
assert.strictEqual($('attachmentViewerIcon').className, 'fas fa-file-video');

// Next wraps to the end of the list.
$('attachmentViewerNext').fireAt('click');
assert.strictEqual($('attachmentViewerTitle').textContent, 'Incident report.docx', 'next must advance');
assert.strictEqual($('attachmentViewerCount').textContent, '3 / 3');
assert.ok($('attachmentViewerBody').innerHTML.indexOf('attachment-viewer-empty') !== -1,
    'a .docx has no inline preview and must say so instead of rendering nothing');

// Next again wraps around to the first file.
$('attachmentViewerNext').fireAt('click');
assert.strictEqual($('attachmentViewerTitle').textContent, '1856H Hinalo ang sauces.png',
    'next must wrap past the end');
assert.strictEqual($('attachmentViewerBody').children[0].tag, 'img');
assert.strictEqual($('attachmentViewerIcon').className, 'fas fa-file-image');

// Ctrl/cmd-click must fall through to the browser so "open in a new tab" survives.
$('attachmentViewerClose').fireAt('click');
assert(!modal.classList.contains('active'), 'close must deactivate the modal');
assert.strictEqual($('attachmentViewerBody').innerHTML, '', 'close must empty the body (stops video playback)');
const ctrl = click(img1, { ctrlKey: true });
assert(!ctrl.defaultPrevented, 'ctrl-click must NOT be hijacked -- it opens a new tab');
assert(!modal.classList.contains('active'), 'ctrl-click must not open the modal');

// The modal's own Open button is the remaining route to a new tab.
click(img1);
$('attachmentViewerOpen').fireAt('click');
assert.deepStrictEqual(openedTabs, ['https://res.cloudinary.com/x/image/upload/v1/a.png'],
    'the Open button must still hand the file to the browser');

// Escape closes.
doc.fire('keydown', { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
assert(!modal.classList.contains('active'), 'Escape must close the modal');
assert.strictEqual(doc.body.style.overflow, '', 'closing must restore page scrolling');

// Non-previewable / dead links must not navigate.
const dead = chip('Broken', '');
const deadEv = click(dead);
assert(deadEv.defaultPrevented, 'a dead href="" anchor must still be preventDefault()ed');

// Type sniffing straight off the delivery URL.
const t = viewer._internals.typeFromUrl;
assert.strictEqual(t('https://x/y/a.MP4?v=1'), 'video');
assert.strictEqual(t('https://x/y/a.pdf'), 'pdf');
assert.strictEqual(t('https://x/y/a.PNG'), 'image');
assert.strictEqual(t('https://x/y/a.docx'), 'other');

console.log('  ok  owner attachment chips open the shared modal with name + counter');
console.log('  ok  prev/next wrap, non-previewable types explained, Esc closes');
console.log('  ok  ctrl-click and the Open button still reach a new tab');
// ============================================================================
// 4. EVERY preview the renderers emit must be an ANCHOR
// ============================================================================
// The delegated handler matches `a.attachment-preview` — an ANCHOR. A
// `<div class="attachment-preview">` looks identical on screen and matches
// nothing, so the card is inert: that is the reported "hindi napipindot" on a
// video ticket attachment, where a 56 MB CCTV clip had no route into the
// lightbox at all. Asserted on the SOURCE because these are template strings
// that need a DOM to execute.
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
const ticketRender = extractFn(scriptSrc, 'renderTicketAttachments');
// A <div class="attachment-preview"> IS allowed in exactly one place: the
// broken-record placeholder, which must NOT be an anchor because href="" is a
// real link to the current page. Every OTHER preview has to be an anchor, so
// the two counts must match exactly — if a second div ever appears here, a
// clickable-looking card has become inert again.
// Count on CODE ONLY. The explanatory comment above quotes the old markup
// verbatim, and a naive grep cannot tell prose from a template string.
// Only whole-line `//` comments are dropped — a partial strip would also eat
// the `https://` inside any literal URL, which is why this is line-anchored.
const ticketCode = ticketRender
    .split(/\r?\n/)
    .filter(function (l) { return l.trim().slice(0, 2) !== '//'; })
    .join('\n');
const divPreviews = (ticketCode.match(/<div class="attachment-preview/g) || []).length;
const brokenPlaceholders = (ticketCode.match(/title="Link unavailable"/g) || []).length;
assert(divPreviews === brokenPlaceholders,
    'the only <div class="attachment-preview"> allowed in renderTicketAttachments() is the broken-record '
    + 'placeholder (found ' + divPreviews + ' div(s) vs ' + brokenPlaceholders + ' broken placeholder(s)); '
    + 'any other div renders as a card that looks clickable but is not');
// A video is NO LONGER a special case here. It used to emit an inline <video>
// inside a <div> that was not an anchor — so it could never open the viewer —
// plus its own "Open full video" link. It is now an ordinary tile whose thumbnail
// is a Cloudinary poster frame from the shared builder, so nothing inline may be
// left, and it picks up the shared `.attachment-preview:hover img` zoom for free.
assert(!/<video\b/.test(ticketCode),
    'renderTicketAttachments() must not emit an inline <video> — a video is now a poster-frame tile from the shared builder; the old inline player was a full-size download in a 110px box that could not open the viewer');
assert(!/attachment-open-link/.test(ticketCode),
    'the per-card "Open full video" link must be gone with the video branch — ctrl-click and the viewer\'s Open button cover "new tab" for every file type');

// The Area Manager form had the same defect: a <span> thumbnail.
const formSrc = read('js/owner-ticket-form.js');
const formGrid = extractFn(formSrc, 'renderGrid');
assert(!/<span class="attachment-preview"/.test(formGrid),
    'owner-ticket-form.js must not render a <span class="attachment-preview"> thumbnail — it is not an anchor, so it is not clickable');
assert(formGrid.includes('target="_blank"') && formGrid.includes("'attachment-preview'"),
    'the form thumbnail must be an anchor with an href so the shared viewer can open it');

console.log('  ok  every rendered preview is an anchor, so every one is clickable');
// ============================================================================
// 5. ONE tile builder: every grid must look the same for the same file
// ============================================================================
// The five renderers each carried their own if/else and drifted: the ticket grid
// put the RAW url in the <img> (full-size download), a video was an inline
// <video> in one grid, a bare play icon in three, and a plain file icon in the
// approval grid, which had no video branch at all. Same file, three looks.
assert(moduleSrc.includes('function buildAttachmentPreview('),
    'the shared tile builder must be defined in js/attachment-viewer.js');
assert(/function buildAttachmentPreview\(norm, index\) \{ return window\.AttachmentViewer/.test(scriptSrc),
    'script.js must DELEGATE to the module rather than keep a second implementation');
const RENDERERS = ['renderApprovalAttachments', 'renderAttachmentsIntoGrid',
                   'renderRevisionAttachments', 'renderTicketAttachments',
                   'renderViolationAttachments'];
for (const n of RENDERERS) {
    const c = extractFn(scriptSrc, n)
        .split(/\r?\n/).filter(l => l.trim().slice(0, 2) !== '//').join('\n');
    assert(c.includes('buildAttachmentPreview(norm, index)'), n + '() must use the shared builder');
    assert(c.includes('normalizeAttachment(att)'),
        n + '() must normalise, or it only understands one writer\'s shape');
    assert(/const isBroken =/.test(c), n + '() must guard a missing URL');
    assert(/title="Link unavailable"/.test(c),
        n + '() must render a URL-less record as a div, never an anchor with href=""');
    assert(!/preview = `|preview \+= `/.test(c),
        n + '() must not keep a hand-rolled preview arm; that is how the grids diverged');
    assert(!/<img src="\$\{url\}"/.test(c),
        n + '() must not put the raw delivery url in an <img> — that skips the thumbnail transform');
}
console.log('  ok  all ' + RENDERERS.length + ' grids share one builder, one shape guard, one normaliser');

// Behaviour: images and videos must both get a real thumbnail.
// escapeHTML() escapes via a DETACHED DOM NODE (div.textContent -> div.innerHTML),
// so the sandbox needs a document that models exactly that. Only the escaping
// the builder actually exercises is implemented: < > & " ' -- enough to catch an
// unescaped filename reaching the markup.
const escStub = {
    createElement() {
        let t = '';
        return {
            set textContent(v) { t = v; },
            get innerHTML() {
                return String(t)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
            }
        };
    }
};
const box = { console: console, document: escStub };
vm.createContext(box);
vm.runInContext([
    extractFn(moduleSrc, 'escapeHTML'),
    extractFn(moduleSrc, 'getCloudinaryThumbUrl'),
    extractFn(moduleSrc, 'cloudinaryPlainStillUrl'),
    extractFn(moduleSrc, 'getAttachmentIcon'),
    extractFn(moduleSrc, 'getAttachmentColor'),
    extractFn(moduleSrc, 'buildAttachmentPreview')
].join('\n'), box);
const tile = box.buildAttachmentPreview;
const CDN = 'https://res.cloudinary.com/demo';
const img = tile(box.normalizeAttachment ? null : { url: CDN + '/image/upload/v1/pic.jpg', name: 'pic.jpg', resourceType: 'image', format: 'jpg' }, 0);
assert(img.indexOf('<img') !== -1, 'an image tile must render a real thumbnail');
assert(img.indexOf('/w_200,h_200,c_fill,q_auto,f_auto/') !== -1,
    'an image tile must use the Cloudinary thumbnail transform, not the full-size url');
const vid = tile({ url: CDN + '/video/upload/v123/tickets/bnw/y2xk.mp4', name: 'univid.mp4', resourceType: 'video', format: 'mp4' }, 0);
assert(vid.indexOf('<img') !== -1, 'a video tile must render a poster frame, not just an icon');
assert(vid.indexOf('f_jpg') !== -1 && vid.indexOf('.jpg') !== -1,
    'a video tile must ask Cloudinary for a .jpg still frame');
assert(vid.indexOf('fa-play-circle') !== -1, 'a video tile needs a play-icon fallback if the still fails');
const docTile = tile({ url: CDN + '/raw/upload/v1/r.docx', name: 'r.docx', resourceType: 'raw', format: 'docx' }, 0);
assert(docTile.indexOf('<img') === -1 && docTile.indexOf('fa-file-word') !== -1,
    'a document has no inline preview and must show its file icon');
const deadTile = tile(null, 3);
assert(deadTile.indexOf('fa-link-slash') !== -1, 'a URL-less record must show the link-slash tile');
assert(deadTile.indexOf('<img') === -1, 'a URL-less record must not try to load a thumbnail');
console.log('  ok  image + video both get a thumbnail; doc shows an icon; dead shows link-slash');
// The Owner Dashboard keeps its OWN container class, so prev/next must scope to
// it as well. Without .owner-attachment-list in SCOPE_SELECTOR the arrows would
// walk every card on the page instead of one list.
const ownerA = ownerChip('Branch A - entrance.mp4', 'https://x/owner-a.mp4');
ownerChip('Branch A - till.mp4', 'https://x/owner-b.mp4');
const ownerEv = click(ownerA);
assert(ownerEv.defaultPrevented, 'a card inside .owner-attachment-list must open the viewer too');
assert.strictEqual($('attachmentViewerTitle').textContent, 'Branch A - entrance.mp4',
    'the owner list\'s card supplies its own name');
assert.strictEqual($('attachmentViewerCount').textContent, '1 / 2',
    'prev/next must be scoped to the owner list, not to every card on the page');
$('attachmentViewerClose').fireAt('click');
console.log('  ok  the owner dashboard\'s own container scopes prev/next too');

console.log('  ok  hidden-modal tiles load eagerly; the long violation tree still lazy-loads');
// ============================================================================
// 6. NO loading="lazy" on a tile that renders into a hidden modal
// ============================================================================
// Chrome defers a lazy image whose ancestor has no layout, and then often never
// loads it at all. No error fires, so the onerror fallback cannot rescue it, and
// the tile stays BLANK forever -- while still opening the file correctly on
// click. That is the "blank image icon, but the video plays on Cloudinary"
// report, and it is invisible to a URL check: the poster resolves 200 with a
// real frame, which is why it was worth downloading one and looking at it.
//
// The REPORTS DATABASE tree in script.js is deliberately EXEMPT: it is a long
// scrollable list in a permanently visible panel, which is the case lazy is for.
function spanOf2(src, name) {
    const s = src.indexOf('function ' + name + '(');
    assert(s > -1, name + '() not found');
    let d = 0;
    for (let j = src.indexOf('{', s); j < src.length; j++) {
        if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (d === 0) return src.slice(s, j + 1); }
    }
    throw new Error('unbalanced ' + name);
}
const LAZY_HIDDEN = [
    ['js/attachment-viewer.js', 'buildAttachmentPreview', moduleSrc],
    ['js/owner-ticket-form.js', 'renderGrid', read('js/owner-ticket-form.js')],
    ['script.js', 'renderAutoUploadFileList', scriptSrc]
];
for (const [file, fn, src] of LAZY_HIDDEN) {
    const body = spanOf2(src, fn);
    assert(!/loading="lazy"/.test(body),
        file + ' :: ' + fn + '() must not lazy-load a thumbnail that renders into a display:none modal -- '
        + 'the tile stays permanently blank, with no error for the onerror fallback to catch');
    assert(/<img/.test(body), file + ' :: ' + fn + '() must still render an <img>');
}
// And the exemption must stay exempt, or the long violation tree regresses.
const vdrive = spanOf2(scriptSrc, 'renderViolationBrowserLevel');
assert(/loading="lazy"/.test(vdrive),
    'the REPORTS DATABASE tree KEEPS loading="lazy" -- it is a long scrollable list in a visible panel');
// ============================================================================
// 7. A tile must never show a BROKEN-image glyph
// ============================================================================
// The reported symptom: the thumbnail renders as the browser's broken-image
// glyph, but clicking it opens the file perfectly on Cloudinary.
//
// That split is the tell. The anchor href is the UNTOUCHED delivery url, while
// the <img> src is a DERIVED one (a Cloudinary transformation). So the original
// is valid and the transformation is not -- an account/plan that refuses the
// transform, a q_auto that cannot run, a codec Cloudinary cannot decode. With a
// single attempt there was nowhere left to go, so the tile stayed broken-looking.
//
// The chain: full transform -> transform-free still -> play/file icon. The last
// rung is a static <i>, so it cannot fail, and data-alt-src is cleared before the
// retry so the chain cannot loop.
assert(moduleSrc.includes('function cloudinaryPlainStillUrl('),
    'a transform-free still helper must exist as the middle rung');
const chBox = { console: console, document: escStub, encodeURI: encodeURI, decodeURI: decodeURI };
vm.createContext(chBox);
vm.runInContext([
    'normalizeFileUrl', 'normalizeAttachment', 'getCloudinaryThumbUrl',
    'cloudinaryPlainStillUrl', 'getAttachmentIcon', 'getAttachmentColor',
    'escapeHTML', 'buildAttachmentPreview'
].map(n => extractFn(moduleSrc, n)).join('\n'), chBox);

const VURL = 'https://res.cloudinary.com/jlux07ne/video/upload/v1790945332/tickets/bnw-tix002/lynirpmgdttlnvdp1d55.mp4';
const vrec = chBox.normalizeAttachment({ secure_url: VURL, name: '11am.mp4', resource_type: 'video', format: 'mp4' });
const vhtml = chBox.buildAttachmentPreview(vrec, 0);
assert(vhtml.indexOf('attachment-thumb-video') !== -1,
    'a video thumbnail must be labelled attachment-thumb-video - typeFor() reads it FIRST, because the card holds an <img> poster and a plain img sniff would call every video an image');

const src1 = vhtml.match(/<img[^>]*\ssrc="([^"]+)"/)[1];
const alt = vhtml.match(/data-alt-src="([^"]+)"/);
assert(alt, 'a video tile must carry data-alt-src -- that is the second chance when the transform is refused');
assert(src1.indexOf('/w_200,h_200,c_fill') !== -1, 'rung 1 is the resized transform');
assert(alt[1].indexOf('w_200') === -1 && alt[1].indexOf('/video/upload/') !== -1,
    'rung 2 must be a transform-free still on the video delivery path');
assert(alt[1] !== src1, 'the two rungs must differ, or the retry re-requests the same failing url');
assert(vhtml.indexOf('fa-play-circle') !== -1, 'rung 3 is the play icon');
// The version segment must be stripped on BOTH rungs, or Cloudinary 404s.
assert(src1.indexOf('v1790945332') === -1 && alt[1].indexOf('v1790945332') === -1,
    'the v<version> segment must be stripped from both rungs');

// Fire the onerror chain against a fake element and prove it terminates.
const handler = vhtml.match(/onerror="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const el = {
    attrs: { 'data-alt-src': alt[1] }, style: {}, nextElementSibling: { style: {} }, _src: null,
    getAttribute(k) { return this.attrs[k] || null; },
    removeAttribute(k) { delete this.attrs[k]; },
    set src(v) { this._src = v; }, get src() { return this._src; }
};
const fireErr = new Function('el', 'return (function(){' + handler + '}).call(el);');
fireErr(el);
assert.strictEqual(el.src, alt[1], 'rung 1 failure must retry with the plain still');
assert.strictEqual(el.getAttribute('data-alt-src'), null,
    'data-alt-src MUST be cleared before the retry, or the chain would loop forever on one failing url');
fireErr(el);
assert.strictEqual(el.style.display, 'none', 'rung 2 failure must hide the img');
assert.strictEqual(el.nextElementSibling.style.display, 'flex', 'and show the icon instead');
assert.strictEqual(el._src, alt[1], 'the retry must not fire again');

// An image retried with its ORIGINAL url, which is always derivable.
const ihtml = chBox.buildAttachmentPreview(
    chBox.normalizeAttachment({ secure_url: 'https://res.cloudinary.com/x/image/upload/v1/pic.jpg', name: 'pic.jpg' }), 0);
const ialt = ihtml.match(/data-alt-src="([^"]+)"/);
assert(ialt, 'an image tile must carry data-alt-src too');
assert(ialt[1] === 'https://res.cloudinary.com/x/image/upload/v1/pic.jpg',
    'an image retries with its original url');
console.log('  ok  a failed thumbnail retries, then falls back to an icon \u2014 never a broken glyph');
console.log('\nAll attachment viewer tests passed.');