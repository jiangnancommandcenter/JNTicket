// ==============================================================
//  IN-APP ATTACHMENT VIEWER (lightbox) -- shared by BOTH dashboards
// ==============================================================
// One modal, reused everywhere (ticket grids, violation evidence, upload
// previews, the Owner Dashboard report and the HR violation list) so a file is
// reviewed without leaving the dashboard. Only ONE media element exists at a
// time and the body is emptied on close, so flipping through many videos never
// piles up hidden players (or their bandwidth).
//
// WHY THIS IS A SEPARATE FILE. It used to live inside script.js, which is
// loaded ONLY by main.html. The Owner Dashboard does not load script.js, so
// every attachment there was an <a target="_blank"> that opened a NEW TAB
// instead of this modal. Copying the viewer into owner-dashboard.js would have
// produced two implementations that silently drift apart; this module is
// loaded by both pages and is the only one.
//
// The modal MARKUP is injected rather than pasted into each page for the same
// reason -- two copies of this dialog are two that slowly disagree. The
// `.attachment-viewer-*` styles are already shared (style.css), so no CSS
// moves with it.
(function () {
    'use strict';

    // Every preview anchor that should open the viewer, and every container
    // that delimits one viewable set (so prev/next walk the RIGHT siblings).
    //
    // `.owner-attachment-list` is here because the Owner Dashboard keeps its own
    // container class even though its cards are now the shared .attachment-item
    // tiles -- without it, prev/next would walk the whole modal instead of one
    // list. The old `a.owner-attachment-row` entries are GONE: no renderer emits
    // them any more, and leaving dead selectors here is how the two dashboards
    // drifted apart in the first place.
    var PREVIEW_SELECTOR = 'a.attachment-preview, a.upload-file-preview';
    var SCOPE_SELECTOR = '.attachments-grid, .upload-file-list, .modal-body, '
        + '.modal-fields, .owner-attachment-list, .upload-widget';

    var items = [];
    var index = 0;
    var els = {};
    var bound = false;

    var MODAL_HTML =
        '<div class="modal-overlay attachment-viewer-overlay" id="attachmentViewerModal">'
        + '<div class="modal-container modal-lg attachment-viewer-container">'
        + '<div class="modal-header attachment-viewer-header">'
        + '<h2><i class="fas fa-file" id="attachmentViewerIcon"></i> '
        + '<span id="attachmentViewerTitle">Attachment</span></h2>'
        + '<div class="attachment-viewer-actions">'
        + '<span class="attachment-viewer-count" id="attachmentViewerCount"></span>'
        + '<button type="button" class="btn btn-sm btn-secondary" id="attachmentViewerPrev" title="Previous file (left arrow)"><i class="fas fa-chevron-left"></i></button>'
        + '<button type="button" class="btn btn-sm btn-secondary" id="attachmentViewerNext" title="Next file (right arrow)"><i class="fas fa-chevron-right"></i></button>'
        + '<button type="button" class="btn btn-sm btn-secondary" id="attachmentViewerOpen" title="Open in a new tab"><i class="fas fa-external-link-alt"></i> Open</button>'
        + '<button class="modal-close" id="attachmentViewerClose">&times;</button>'
        + '</div></div>'
        + '<div class="modal-body attachment-viewer-body" id="attachmentViewerBody"></div>'
        + '</div></div>';

    /** Create the dialog on first use, then cache its controls. */
    function ensureModal() {
        var modal = document.getElementById('attachmentViewerModal');
        if (!modal) {
            var host = document.createElement('div');
            host.innerHTML = MODAL_HTML;
            while (host.firstChild) document.body.appendChild(host.firstChild);
            modal = document.getElementById('attachmentViewerModal');
        }
        els.modal = modal;
        els.body = document.getElementById('attachmentViewerBody');
        els.title = document.getElementById('attachmentViewerTitle');
        els.icon = document.getElementById('attachmentViewerIcon');
        els.open = document.getElementById('attachmentViewerOpen');
        els.close = document.getElementById('attachmentViewerClose');
        els.prev = document.getElementById('attachmentViewerPrev');
        els.next = document.getElementById('attachmentViewerNext');
        els.count = document.getElementById('attachmentViewerCount');
        return modal;
    }

    /** Guess the viewer type from the delivery URL's extension. */
    function typeFromUrl(url) {
        var path = String(url || '');
        var q = path.indexOf('?');
        if (q !== -1) path = path.slice(0, q);
        var m = path.match(/\.([a-z0-9]+)$/i);
        var ext = m ? m[1].toLowerCase() : '';
        if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].indexOf(ext) !== -1) return 'video';
        if (ext === 'pdf') return 'pdf';
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].indexOf(ext) !== -1) return 'image';
        return 'other';
    }

    /**
     * Type for a preview anchor.
     *
     * ORDER MATTERS, and it used to be the other way round, which broke video
     * playback entirely.
     *
     * The old version sniffed the anchor's children first. But a video card now
     * holds an <img> POSTER FRAME (that is the whole point of the shared card),
     * so every video was classified as an IMAGE. The viewer then built
     * `<img src="....mp4">`, which of course renders nothing: the modal opened
     * blank, and only the Open button -- which uses the raw url -- worked. That
     * is the reported "click it, the video does not play, but Open in another tab
     * plays fine" split.
     *
     * So: the delivery URL decides, because the href IS the file. The explicit
     * .attachment-thumb-* class comes first so a signed or extensionless video
     * url still resolves. Child sniffing is kept only as a last resort.
     */
    function typeFor(anchor, url) {
        if (anchor && anchor.querySelector) {
            if (anchor.querySelector('.attachment-thumb-video')) return 'video';
            if (anchor.querySelector('.attachment-thumb-image')) return 'image';
        }
        var byUrl = typeFromUrl(url);
        if (byUrl !== 'other') return byUrl;
        if (anchor && anchor.querySelector) {
            if (anchor.querySelector('video')) return 'video';
            if (anchor.querySelector('img')) return 'image';
            if (anchor.querySelector('.fa-file-pdf')) return 'pdf';
        }
        return 'other';
    }

    function iconClass(type) {
        if (type === 'video') return 'fa-file-video';
        if (type === 'pdf') return 'fa-file-pdf';
        if (type === 'image') return 'fa-file-image';
        return 'fa-file';
    }

    function nameFor(anchor) {
        var nameEl = anchor.querySelector('.attachment-name, .upload-file-name');
        return (nameEl && nameEl.textContent) || anchor.getAttribute('title') || 'Attachment';
    }

    /** Draw the media for the current item -- exactly one element in the body. */
    function renderItem() {
        var item = items[index];
        if (!item) { close(); return; }

        var type = item.type || typeFor(item.anchor, item.url);
        if (els.icon) els.icon.className = 'fas ' + iconClass(type);
        if (els.title) els.title.textContent = item.name || 'Attachment';
        if (els.count) {
            els.count.textContent = items.length > 1 ? (index + 1) + ' / ' + items.length : '';
        }
        var hasPrevNext = items.length > 1;
        if (els.prev) els.prev.style.display = hasPrevNext ? '' : 'none';
        if (els.next) els.next.style.display = hasPrevNext ? '' : 'none';
        if (els.open) els.open.disabled = !(item.url && item.url !== '#');

        els.body.innerHTML = '';
        if (!item.url || item.url === '#') {
            els.body.innerHTML = '<div class="attachment-viewer-empty"><i class="fas fa-file"></i><br>No preview available for this file.</div>';
            return;
        }

        if (type === 'image') {
            var img = document.createElement('img');
            img.className = 'attachment-viewer-media';
            img.src = item.url;
            img.alt = item.name || 'Attachment';
            els.body.appendChild(img);
        } else if (type === 'video') {
            var video = document.createElement('video');
            video.className = 'attachment-viewer-media';
            video.src = item.url;
            video.controls = true;
            video.playsInline = true;
            video.preload = 'metadata';
            els.body.appendChild(video);
            var p = video.play();
            if (p && p.catch) p.catch(function () { /* autoplay blocked - controls still work */ });
        } else if (type === 'pdf') {
            // Browser-native PDF rendering. If Cloudinary PDF delivery is disabled
            // the iframe stays blank -- the "Open" button above is the fallback.
            var frame = document.createElement('iframe');
            frame.src = item.url;
            frame.title = item.name || 'PDF preview';
            els.body.appendChild(frame);
        } else {
            els.body.innerHTML = '<div class="attachment-viewer-empty"><i class="fas fa-file"></i><br>No inline preview for this file type -- use the Open button above.</div>';
        }
    }
    function showAt(i) {
        if (!items.length) return;
        // Wraps in both directions so ArrowLeft from the first file wraps to the
        // last, which is what the "Previous file" button implies.
        index = ((i % items.length) + items.length) % items.length;
        renderItem();
    }

    function step(delta) {
        showAt(index + delta);
    }

    /** Open the viewer with a list of {url, name, anchor?, type?} items. */
    function open(list, i) {
        var filtered = (Array.isArray(list) ? list : []).filter(function (x) { return x && x.url; });
        if (!filtered.length) return;
        ensureModal();
        items = filtered;
        showAt(Math.max(0, Math.min(i || 0, filtered.length - 1)));
        els.modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function close() {
        if (!els.modal) return;
        els.modal.classList.remove('active');
        if (els.body) els.body.innerHTML = '';   // stops video playback + frees memory
        document.body.style.overflow = '';
        items = [];
        index = 0;
    }

    /**
     * Open the viewer over FILE ROWS that are not anchors -- the violations
     * "REPORTS DATABASE" browser, whose rows are divs carrying `data-url`.
     *
     * `root` is a PARAMETER on purpose. The original closed over script.js's
     * `violationFolderBrowser` global, which is what made the viewer impossible
     * to share: this module also loads on ownerdashboard.html, where that name
     * does not exist, so a closed-over reference would have been `undefined`
     * there and the folder browser would have thrown.
     */
    function openForRows(root, row) {
        var url = row && row.dataset ? row.dataset.url : '';
        if (!url || url === '#') return;
        var scope = root || document;
        var rows = Array.prototype.slice.call(scope.querySelectorAll('.vdrive-row.file'));
        var list = rows.map(function (r) {
            var nameEl = r.querySelector('.vdrive-name');
            return { url: r.dataset.url || '', name: (nameEl && nameEl.textContent) || 'Attachment' };
        });
        open(list, Math.max(0, rows.indexOf(row)));
    }

    /**
     * Wire the viewer once: header buttons, Esc / arrow keys, backdrop click, and
     * one delegated click handler that turns EVERY preview anchor in the app into
     * a viewer opener. Middle-click / ctrl-click still fall through to the
     * browser default, and the viewer's own Open button still opens a tab, so
     * "open in a new tab" is never lost by taking it over.
     */
    function bind() {
        if (bound) return;
        ensureModal();
        bound = true;

        if (els.close) els.close.addEventListener('click', close);
        if (els.prev) els.prev.addEventListener('click', function () { step(-1); });
        if (els.next) els.next.addEventListener('click', function () { step(1); });
        if (els.open) {
            els.open.addEventListener('click', function () {
                var item = items[index];
                if (item && item.url && item.url !== '#') window.open(item.url, '_blank', 'noopener');
            });
        }
        els.modal.addEventListener('click', function (e) {
            if (e.target === els.modal) close();
        });
        document.addEventListener('keydown', function (e) {
            if (!els.modal.classList.contains('active')) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                close();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                step(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                step(1);
            }
        });
        document.addEventListener('click', function (e) {
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            var a = e.target.closest ? e.target.closest(PREVIEW_SELECTOR) : null;
            if (!a) return;

            // preventDefault() MUST come before the URL check. An anchor with
            // href="" (or "#") is a REAL link to the current page, so bailing out
            // before this line let a dead attachment navigate the whole app to its
            // own URL instead of opening the viewer -- the reported "clicking the
            // file takes me to main.html". The renderers no longer emit an empty
            // href; this is the second line of defence for any markup that has one.
            e.preventDefault();

            var url = a.getAttribute('href');
            if (!url || url === '#') return;
            var scope = a.closest(SCOPE_SELECTOR) || a.parentElement || document;
            var anchors = Array.prototype.slice.call(scope.querySelectorAll(PREVIEW_SELECTOR));
            var list = anchors.map(function (el) {
                return { url: el.getAttribute('href') || '', name: nameFor(el), anchor: el };
            });
            open(list, Math.max(0, anchors.indexOf(a)));
        });
    }


    // ==============================================================
    //  SHARED ATTACHMENT HELPERS
    // ==============================================================
    // These used to live in script.js, which ownerdashboard.html does not load.
    // That is the whole reason the Owner Dashboard grew its OWN copies: a third
    // getAttachmentColor() (red for video, green for image) that disagreed with
    // script.js's, a second formatFileSize(), a hand-rolled size ternary, and a
    // buildAttachmentRow() that rendered a bare icon chip with no thumbnail at
    // all. hr-violations.js even documented the choice: "avoids pulling the
    // command center's thumbnail helpers onto a page". So the same CCTV clip was
    // a thumbnail card in one place and a grey icon row in another.
    //
    // script.js now delegates here, so there is exactly one implementation and
    // both dashboards render an identical card.

    /** Decode-then-re-encode a delivery URL so it is safe in an href. */
    function normalizeFileUrl(rawUrl) {
        const value = String(rawUrl || '').trim();
        if (!value || value === '#') return '';
        if (/^(blob:|data:)/i.test(value)) return value;
        let url = value;
        for (let i = 0; i < 3; i++) {
            if (!/%[0-9A-Fa-f]{2}/.test(url)) break;
            let decoded;
            try { decoded = decodeURI(url); } catch (e) { break; }
            if (decoded === url) break;
            url = decoded;
        }
        try { return encodeURI(url); } catch (e) { return url; }
    }

    /**
     * One canonical attachment record from EITHER writer's shape.
     *
     *   script.js / Cloudinary : { secure_url, public_id, name, resource_type, ... }
     *   Area Manager form      : { url,        publicId,  fileName, mimeType,  ... }
     *
     * resource_type drives the whole rendering branch, so it is derived from
     * mimeType (or the extension) when the writer did not supply it.
     */
    function normalizeAttachment(att) {
        if (!att || typeof att !== 'object') return null;
        const url = normalizeFileUrl(att.secure_url || att.url || '');
        const name = att.name || att.fileName || att.original_filename || '';
        const publicId = att.public_id || att.publicId || '';
        const bytes = att.bytes || att.size || att.fileSize || 0;
        let resourceType = att.resource_type || '';
        if (!resourceType) {
            const mime = String(att.mimeType || att.mime_type || '').toLowerCase();
            if (mime.indexOf('image/') === 0) resourceType = 'image';
            else if (mime.indexOf('video/') === 0) resourceType = 'video';
            else if (mime.indexOf('audio/') === 0) resourceType = 'audio';
            else if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)) resourceType = 'image';
            else if (/\.(mp4|webm|ogg|mov|avi)$/i.test(name)) resourceType = 'video';
        }
        let format = att.format || '';
        if (!format && name) {
            const ext = String(name).match(/\.([A-Za-z0-9]+)$/);
            if (ext) format = ext[1].toLowerCase();
        }
        return { url: url, name: name, publicId: publicId, bytes: bytes, resourceType: resourceType, format: format, raw: att };
    }

    /**
     * Cloudinary thumbnail URL. It ALSO turns a /video/upload/ URL into a .jpg
     * still frame, so a video gets a real poster image for a few KB instead of
     * a full-size download or a bare icon. That capability already existed here
     * and the per-page copies simply never called it.
     */
    function getCloudinaryThumbUrl(secureUrl, width, height) {
        const videoMarker = '/video/upload/';
        const videoIdx = secureUrl.indexOf(videoMarker);
        if (videoIdx !== -1) {
            const videoBase = secureUrl.slice(0, videoIdx + videoMarker.length);
            const videoRest = secureUrl.slice(videoIdx + videoMarker.length);
            const firstSlash = videoRest.indexOf('/');
            const videoPath = (firstSlash !== -1 && /^v\d+$/.test(videoRest.slice(0, firstSlash)))
                ? videoRest.slice(firstSlash + 1)
                : videoRest;
            const pathSlash = videoPath.lastIndexOf('/');
            const pathDot = videoPath.lastIndexOf('.');
            const still = pathDot > pathSlash ? videoPath.slice(0, pathDot) + '.jpg' : videoPath + '.jpg';
            return videoBase + 'w_' + (width || 200) + ',h_' + (height || 200) + ',c_fill,q_auto,f_jpg/' + still;
        }
        const marker = '/image/upload/';
        const idx = secureUrl.indexOf(marker);
        if (idx !== -1) {
            const base = secureUrl.slice(0, idx + marker.length);
            const rest = secureUrl.slice(idx + marker.length);
            const slash = rest.indexOf('/');
            if (slash !== -1) {
                return base + 'w_' + (width || 200) + ',h_' + (height || 200) + ',c_fill,q_auto,f_auto/' + rest.slice(slash + 1);
            }
            return base + 'w_' + (width || 200) + ',h_' + (height || 200) + ',c_fill,q_auto,f_auto/' + rest;
        }
        return secureUrl;
    }

    function getAttachmentIcon(resourceType, format) {
        format = (format || '').toLowerCase();
        if (resourceType === 'image') return 'fa-file-image';
        if (resourceType === 'video') return 'fa-file-video';
        if (['pdf'].includes(format)) return 'fa-file-pdf';
        if (['doc', 'docx'].includes(format)) return 'fa-file-word';
        if (['xls', 'xlsx', 'csv'].includes(format)) return 'fa-file-excel';
        if (['ppt', 'pptx'].includes(format)) return 'fa-file-powerpoint';
        if (['zip', 'rar', '7z'].includes(format)) return 'fa-file-archive';
        if (['txt'].includes(format)) return 'fa-file-alt';
        return 'fa-file';
    }

    function getAttachmentColor(format) {
        format = (format || '').toLowerCase();
        if (['pdf'].includes(format)) return '#dc2626';
        if (['doc', 'docx'].includes(format)) return '#2563eb';
        if (['xls', 'xlsx', 'csv'].includes(format)) return '#16a34a';
        if (['ppt', 'pptx'].includes(format)) return '#ea580c';
        if (['zip', 'rar', '7z'].includes(format)) return '#ca8a04';
        return '#64748b';
    }

    function formatFileSize(bytes) {
        if (!bytes && bytes !== 0) return '';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    /** Escapes via a detached DOM node, exactly as script.js always has. */
    function escapeHTML(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * THE ONE attachment tile body. Every grid in the app calls this, so an
     * identical file looks identical everywhere it appears.
     *
     * @param {object} norm  a record from normalizeAttachment()
     * @param {number} index position, used only for the fallback name
     * @returns {string} HTML for the tile body (NOT the anchor)
     */
        // ⚠️ NO loading="lazy" HERE, ON PURPOSE.
            // Every one of these tiles is rendered into a modal that is display:none at
            // render time, and Chrome defers a lazy image whose ancestor has no layout --
            // then frequently never loads it at all. No error fires either, so the
            // onerror fallback below cannot rescue it, and the result is a permanently
            // BLANK tile that still opens the file correctly when clicked. That is exactly
            // the "blank image icon, but the video plays on Cloudinary" report.
            // These grids hold a handful of tiles, so lazy loading saved nothing anyway.
            // decoding="async" keeps the decode off the main thread with none of that risk.
            // (The REPORTS DATABASE tree in script.js DOES keep loading="lazy": it is a long
            // scrollable list in a permanently visible panel, which is the case lazy is for.)
    /**
     * A transform-FREE video still: just the public id with a .jpg extension.
     *
     * This is the middle rung of the tile's fallback chain. If the full
     * transformation is refused -- an account or plan without the feature, a
     * `q_auto` that cannot run, a codec Cloudinary cannot decode -- the still
     * itself is usually still derivable, and this asks for it with nothing but a
     * format change. Cheaper and far more widely available than the transform.
     */
    function cloudinaryPlainStillUrl(secureUrl) {
        const marker = '/video/upload/';
        const i = secureUrl.indexOf(marker);
        if (i === -1) return '';
        const base = secureUrl.slice(0, i + marker.length);
        let rest = secureUrl.slice(i + marker.length);
        const slash = rest.indexOf('/');
        if (slash !== -1 && /^v\d+$/.test(rest.slice(0, slash))) rest = rest.slice(slash + 1);
        const ds = rest.lastIndexOf('/');
        const dd = rest.lastIndexOf('.');
        return base + (dd > ds ? rest.slice(0, dd) + '.jpg' : rest + '.jpg');
    }
function buildAttachmentPreview(norm, index) {
    const url = norm ? norm.url : '';
    const name = (norm && norm.name) || ('Attachment ' + ((index || 0) + 1));
    const type = norm ? norm.resourceType : '';
    const icon = norm ? getAttachmentIcon(norm.resourceType, norm.format) : 'fa-file';
    const color = norm ? getAttachmentColor(norm.format) : '#64748b';

    // No URL: a link-slash tile. The caller MUST render this without an
    // anchor, because href="" is a real link to the current page.
    if (!url) {
        return '<div class="attachment-file-icon"><i class="fas fa-link-slash" style="color:#dc2626"></i></div>';
    }

    // Images AND videos both get a real thumbnail.
    if (type === 'image' || type === 'video') {
        const fallbackIcon = (type === 'video') ? 'fa-play-circle' : icon;

        // THREE rungs, tried in order, and the last one is an icon that cannot
        // fail: full transform -> transform-free still -> play/file icon.
        //
        // A single attempt is what produced the BROKEN-IMAGE glyph. The anchor
        // href is the untouched file, so clicking always worked; only the
        // thumbnail was derived, and a transformation the account or plan refuses
        // had no second chance. The reported symptom -- "broken thumbnail, but it
        // plays fine on Cloudinary when I open it" -- is exactly that split: the
        // ORIGINAL url is valid while the DERIVED one is not.
        //
        // For an image the retry is the original url (always derivable); for a
        // video it is the plain .jpg still, which needs no transformation support
        // at all. data-alt-src is cleared before the retry so this can never loop.
        const primary = getCloudinaryThumbUrl(url, 200, 200);
        const alt = (type === 'video') ? cloudinaryPlainStillUrl(url) : url;
        const onError =
            "var a=this.getAttribute('data-alt-src');"
          + "if(a){this.removeAttribute('data-alt-src');this.src=a;}"
          + "else{this.style.display='none';this.nextElementSibling.style.display='flex';}";
        return '<img class="attachment-thumb attachment-thumb-' + type + '" src="' + escapeHTML(primary) + '"'
            + (alt && alt !== primary ? ' data-alt-src="' + escapeHTML(alt) + '"' : '')
            + ' alt="' + escapeHTML(name) + '" decoding="async" onerror="' + onError + '">'
            + '<div class="attachment-file-icon" style="display:none;"><i class="fas '
            + fallbackIcon + '" style="color:' + color + '"></i></div>';
    }

    // Documents, archives, audio: no inline preview exists, so show the icon.
    return '<div class="attachment-file-icon"><i class="fas ' + icon + '" style="color:' + color + '"></i></div>';
}

    /**
     * THE WHOLE attachment card — the markup the Owner Dashboard and HR
     * violations grids now use, identical to the five grids in script.js.
     *
     * @param {object} att   a raw record (either writer's shape)
     * @param {object} opts  { index, removeHtml, added }
     * @returns {string} one .attachment-item card, or '' for a null record
     */
    function buildAttachmentCard(att, opts) {
        const o = opts || {};
        const norm = normalizeAttachment(att);
        if (!norm) return '';
        const index = o.index || 0;
        const name = norm.name || ('Attachment ' + (index + 1));
        const sizeText = norm.bytes ? formatFileSize(norm.bytes) : '';
        // Without a URL there is NO anchor: href="" is a real link to the
        // CURRENT PAGE, so it would navigate the app instead of doing nothing.
        const isBroken = !norm.url;
        const body = isBroken
            ? '<div class="attachment-preview" title="Link unavailable">' + buildAttachmentPreview(norm, index) + '</div>'
            : '<a href="' + escapeHTML(norm.url) + '" target="_blank" rel="noopener noreferrer" class="attachment-preview" title="' + escapeHTML(name) + '">'
              + buildAttachmentPreview(norm, index) + '</a>';
        // ⚠️ OPT-IN, AND TOP-LEFT. `added` marks a clip uploaded in response to a
        // footage request, so it is never set by the other grids — the violation
        // folders, the requester's own uploads and the operator's ticket modal all
        // leave it off and render exactly as before. The banner sits top-LEFT
        // because .attachment-remove already owns top-right; overlapping them would
        // hide the Remove button on a superadmin card, which is the one place
        // both can appear at once.
        //
        // ⚠️ THE WORD, NOT A GLYPH. This was a circular ➕ badge, which reads as a
        // control — an "add" button — rather than as a state. The request was for
        // a "NEW" banner: plain text says what it is, is translatable, and needs
        // no icon font. `aria-label` too, because the word is inside a decorative
        // banner whose full meaning is carried by the `title`.
        const addedBadge = o.added
            ? '<span class="attachment-added-badge" role="img" aria-label="Added footage" title="Added footage — uploaded in response to a request">NEW</span>'
            : '';
        return '<div class="attachment-item' + (o.added ? ' attachment-item--added' : '') + '"'
            + (norm.publicId ? ' data-public-id="' + escapeHTML(norm.publicId) + '"' : '') + '>'
            + addedBadge
            + (o.removeHtml || '') + body
            + '<div class="attachment-meta">'
            + '<span class="attachment-name" title="' + escapeHTML(name) + '">' + escapeHTML(name) + '</span>'
            + (sizeText ? '<span class="attachment-size">' + escapeHTML(sizeText) + '</span>' : '')
            + (isBroken ? '<span class="attachment-size" style="color:#dc2626;">link unavailable</span>' : '')
            + '</div></div>';
    }
    // The ONLY global this module creates. Everything else stays private so it
    // cannot collide with the globals script.js and owner-dashboard.js each
    // declare (test/script-collision.test.js guards exactly that).
    window.AttachmentViewer = {
        init: bind,
        open: open,
        close: close,
        openForRows: openForRows,
        // Card + tile builders, shared by every grid on both dashboards.
        buildAttachmentCard: buildAttachmentCard,
        buildAttachmentPreview: buildAttachmentPreview,
        // The normalisers. script.js delegates to these instead of keeping a
        // second copy that can drift from the Owner Dashboard's.
        helpers: {
            normalizeFileUrl: normalizeFileUrl,
            normalizeAttachment: normalizeAttachment,
            getCloudinaryThumbUrl: getCloudinaryThumbUrl,
            getAttachmentIcon: getAttachmentIcon,
            getAttachmentColor: getAttachmentColor,
            formatFileSize: formatFileSize,
            escapeHTML: escapeHTML
        },
        // Exposed for tests; not part of the page-facing API.
        _internals: {
            PREVIEW_SELECTOR: PREVIEW_SELECTOR,
            SCOPE_SELECTOR: SCOPE_SELECTOR,
            typeFromUrl: typeFromUrl,
            nameFor: nameFor
        }
    };

    // Bind on DOM ready. The markup is injected, so NEITHER page needs a <div>
    // for this -- which is why ownerdashboard.html needs no markup change here.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bind);
    } else {
        bind();
    }
})();