// ==============================================================
//  AREA MANAGER TICKET FORM  (full-screen modal)
//
//  The submission form used to live ONLY on the public
//  submit-ticket.html, so filing a ticket meant leaving the dashboard
//  entirely. It now lives here as a full-screen modal, because the
//  Area Manager is the person who raises tickets for their own branches
//  and bouncing them out of the dashboard mid-task is the wrong shape.
//
//  ⚠️ THE PAYLOAD IS A CONTRACT, NOT JUST DATA. This writes the EXACT
//  field set submit-ticket.html wrote, because everything downstream
//  reads those fields by name:
//      · the operator's resolve step  → resolutionNotes, requesterAttachments
//      · the approval email (js/email.js) → email, then contact
//      · the public Track page         → branch, ticketNumber, incident
//  A missing key does not error — it silently produces a ticket whose
//  evidence is gone or which nobody can be emailed. test/owner-ticket-form.test.js
//  pins the key set against submit-ticket.html so the two cannot drift.
// ==============================================================
(function () {
    'use strict';

    // ⚠️ Mirrors submit-ticket.html:1539-1545. It is a THIRD copy of this
    // config (script.js:33-35 holds the other two), which is ugly but is the
    // existing pattern — folding all three into one shared config module is a
    // separate refactor, not something to smuggle into a UI change. If the
    // Cloudinary account or preset ever changes, change all three.
    var CLOUDINARY_CLOUD_NAME = 'jlux07ne';
    var CLOUDINARY_UPLOAD_PRESET = 'jiangnan';
    var MAX_ATTACHMENT_SIZE_MB = 100;
    var ALLOWED_ATTACHMENT_TYPES = [
        'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
        'video/mp4', 'video/webm', 'video/ogg',
        'application/pdf', 'text/plain', 'text/csv',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/zip'
    ];

    // Files that finished uploading, for THIS form. Reset on every open so a
    // half-filled draft can never leak attachments into the next ticket.
    var uploadedAttachments = [];

    var els = {};
    var injected = false;
    var busy = false;

    /**
     * The module carries its OWN escapeHTML. It cannot use the page's copy
     * safely: js/owner-dashboard.js declares a top-level `function
     * escapeHTML` in a CLASSIC script, which makes it a `window` property, so
     * an IIFE reaching for `window.escapeHTML` could get chat.js's or
     * notifications.js's implementation instead of the one it was written
     * against. js/chat.js:466 solves the same problem the same way.
     */
    function escapeHTML(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function toast(message, type) {
        if (typeof window.showToast === 'function') {
            window.showToast(message, type || 'info');
        } else {
            console.log('[TicketForm] ' + message);
        }
    }

    function getAuthEmail() {
        try {
            if (typeof auth !== 'undefined' && auth && auth.currentUser && auth.currentUser.email) {
                return String(auth.currentUser.email);
            }
        } catch (e) { /* not ready */ }
        return '';
    }

    // ------------------------------------------------------------------
    //  MARKUP
    //
    //  Injected on first open rather than living in ownerdashboard.html, for
    //  the same reason js/chat.js and js/command-palette.js inject their own:
    //  one owner of the markup. It reuses the app's .modal-overlay /
    //  .modal-container, so light + dark are inherited and it matches the
    //  other nineteen modals. `.owner-ticket-form-overlay` is a styling hook
    //  only — see the note on that block in style.css.
    // ------------------------------------------------------------------
    function inject() {
        if (injected) return;
        var req = ' <span class="req">*</span>';
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay owner-ticket-form-overlay';
        overlay.id = 'ownerTicketFormOverlay';
        overlay.setAttribute('aria-hidden', 'true');

        var rows = [
            '      <div class="form-row">',
            '        <div class="form-group">',
            // Populated from the manager\'s ASSIGNED branches only, not the
            // full list: they file for branches they run, and the per-branch
            // ticket counter is keyed off this value.
            '          <label for="otfBranch">Branch' + req + '</label>',
            '          <select id="otfBranch" required></select>',
            '        </div>',
            '        <div class="form-group">',
            '          <label for="otfPriority">Priority Level' + req + '</label>',
            '          <select id="otfPriority" required>',
            '            <option value="Low" selected>Low</option>',
            '            <option value="High">High</option>',
            '          </select>',
            '        </div>',
            '      </div>',
            '      <div class="form-row">',
            '        <div class="form-group">',
            '          <label for="otfName">Name of Reporter' + req + '</label>',
            '          <input type="text" id="otfName" required placeholder="Enter Full Name">',
            '        </div>',
            '        <div class="form-group">',
            '          <label for="otfPosition">Position</label>',
            '          <input type="text" id="otfPosition" placeholder="Store Manager / Supervisor">',
            '        </div>',
            '      </div>',
            '      <div class="form-row">',
            '        <div class="form-group">',
            // Email is REQUIRED: it is how the requester is told the ticket was
            // approved. Prefilled from the signed-in account.
            '          <label for="otfEmail">Email' + req + '</label>',
            '          <input type="email" id="otfEmail" required placeholder="you@company.com">',
            '        </div>',
            '        <div class="form-group">',
            '          <label for="otfContact">Contact Number</label>',
            '          <input type="text" id="otfContact" placeholder="09XX XXX XXXX">',
            '        </div>',
            '      </div>',
            '      <div class="form-row">',
            '        <div class="form-group">',
            '          <label for="otfDatetime">Incident Date &amp; Time</label>',
            '          <input type="datetime-local" id="otfDatetime">',
            '        </div>',
            '        <div class="form-group">',
            '          <label for="otfLocation">Location</label>',
            '          <input type="text" id="otfLocation" placeholder="Where in the branch">',
            '        </div>',
            '      </div>',
            '      <div class="form-group">',
            '        <label for="otfIncident">Incident' + req + '</label>',
            '        <input type="text" id="otfIncident" required placeholder="Tip Pocketing / Pilferage / Overcharge">',
            '      </div>',
            '      <div class="form-group">',
            '        <label for="otfDescription">Full Description' + req + '</label>',
            '        <textarea id="otfDescription" rows="5" required placeholder="Describe the incident in detail..."></textarea>',
            '      </div>'
        ].join('\n');

        overlay.innerHTML = [].concat([
            // ⚠️ A STANDARD .modal-container.modal-lg, LIKE ALL 19 OTHERS IN THE
            // APP. This was briefly a full-screen, page-shaped modal with a Back
            // arrow, and it read as navigation without any of navigation's
            // affordances — no URL, no history entry, no title bar, and a browser
            // back button that silently did nothing. It was also the only
            // full-screen modal and the only one without a × , which is a
            // consistency cost paid for nothing: nine fields in two columns is
            // about one screen at 720px.
            //
            // `.owner-ticket-form-overlay` is KEPT as a styling hook. It no
            // longer does any layout work of its own; it exists so the rules
            // that genuinely belong to THIS form (the touch-sized inputs, the
            // required-field marker, the always-visible remove button) are
            // scoped to it rather than leaking into the app's other modals.
            '<div class="modal-container modal-lg" role="dialog" aria-modal="true" aria-labelledby="ownerTicketFormTitle">',
            '  <div class="modal-header">',
            '    <h2 id="ownerTicketFormTitle"><i class="fas fa-ticket-alt"></i> Submit Incident Ticket</h2>',
            // The × IS the single exit, matching every other modal in the app.
            // The previous version had a Back arrow AND a × : two controls doing
            // the same job in the same strip of chrome, with the Back one
            // promising a return trip the browser would not honour.
            //
            // `type="button"` is explicit even though this sits outside the
            // <form> and therefore cannot submit: an unqualified <button>
            // defaults to type="submit", and "it happens to be outside a form
            // right now" is not a property worth relying on.
            '    <button type="button" class="modal-close" id="ownerTicketFormClose" aria-label="Close">&times;</button>',
            '  </div>',
            '  <div class="modal-body">',
            '    <form id="ownerTicketForm" novalidate>'
        ], [rows], [
            // The attachment block and the actions row. `.upload-widget` wraps
            // the dropzone because every .upload-dropzone rule in style.css is
            // scoped under it — without the wrapper the dropzone renders as an
            // unstyled <label>.
            '      <div class="form-group">',
            '        <label><i class="fas fa-cloud-upload-alt"></i> Supporting Images or Video (Optional)</label>',
            '        <div class="upload-widget">',
            '          <label class="upload-dropzone" for="otfFiles">',
            '            <i class="fas fa-cloud-upload-alt"></i>',
            '            <span class="upload-dropzone-text">Click to choose files or drag &amp; drop here</span>',
            '            <span class="upload-dropzone-hint">Images, video, PDF, Office, ZIP &middot; up to ' + MAX_ATTACHMENT_SIZE_MB + 'MB</span>',
            '            <input type="file" id="otfFiles" multiple accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip">',
            '          </label>',
            '          <div class="upload-progress-wrap" id="otfProgressWrap" style="display:none;">',
            '            <div class="upload-spinner"><i class="fas fa-circle-notch fa-spin"></i></div>',
            '            <div class="upload-progress"><div class="upload-progress-bar" id="otfProgressBar"></div></div>',
            '            <span class="upload-progress-text" id="otfProgressText">0%</span>',
            '          </div>',
            '          <div class="attachment-upload-status" id="otfUploadStatus"></div>',
            '          <div class="attachments-grid" id="otfGrid" style="display:none;"></div>',
            '        </div>',
            '      </div>',
            '      <div class="form-actions">',
            '        <button type="button" class="btn btn-secondary" id="otfReset">Clear</button>',
            '        <button type="submit" class="btn btn-primary" id="otfSubmit">',
            '          <i class="fas fa-paper-plane"></i> <span>Submit Ticket</span>',
            '        </button>',
            '      </div>',
            '    </form>',
            '  </div>',
            '</div>'
        ]).join('\n');

        document.body.appendChild(overlay);
        cacheEls(overlay);
        bindEvents(overlay);
        injected = true;
    }

    function cacheEls(overlay) {
        var byId = function (id) { return overlay.querySelector('#' + id); };
        els.overlay = overlay;
        els.close = byId('ownerTicketFormClose');
        els.form = byId('ownerTicketForm');
        els.branch = byId('otfBranch');
        els.priority = byId('otfPriority');
        els.name = byId('otfName');
        els.position = byId('otfPosition');
        els.email = byId('otfEmail');
        els.contact = byId('otfContact');
        els.datetime = byId('otfDatetime');
        els.location = byId('otfLocation');
        els.incident = byId('otfIncident');
        els.description = byId('otfDescription');
        els.files = byId('otfFiles');
        els.progressWrap = byId('otfProgressWrap');
        els.progressBar = byId('otfProgressBar');
        els.progressText = byId('otfProgressText');
        els.uploadStatus = byId('otfUploadStatus');
        els.grid = byId('otfGrid');
        els.reset = byId('otfReset');
        els.submit = byId('otfSubmit');
    }

    function bindEvents(overlay) {
        els.close.addEventListener('click', close);
        els.reset.addEventListener('click', function () { resetForm(true); });
        els.form.addEventListener('submit', handleSubmit);
        // Backdrop click closes, matching every other overlay in the app.
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) close();
        });
        els.files.addEventListener('change', function () { handleFiles(els.files.files); });

        // Drag & drop. `dragover` MUST preventDefault or the browser navigates
        // to the dropped file and the manager loses the whole dashboard.
        var drop = overlay.querySelector('.upload-dropzone');
        ['dragenter', 'dragover'].forEach(function (evt) {
            drop.addEventListener(evt, function (e) {
                e.preventDefault();
                drop.classList.add('dragover');
            });
        });
        ['dragleave', 'drop'].forEach(function (evt) {
            drop.addEventListener(evt, function (e) {
                e.preventDefault();
                drop.classList.remove('dragover');
            });
        });
        drop.addEventListener('drop', function (e) {
            handleFiles(e.dataTransfer && e.dataTransfer.files);
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && isOpen()) close();
        });
    }

    function isOpen() {
        return !!(els.overlay && els.overlay.classList.contains('active'));
    }

    /** Open the form, populating the branch list and the pre-filled fields. */
    function open() {
        inject();
        uploadedAttachments = [];
        populateBranches();
        prefillIdentity();
        els.overlay.classList.add('active');
        els.overlay.setAttribute('aria-hidden', 'false');
        renderGrid();
        setUploadStatus('');
        // ⚠️ AUTOFOCUS IS DELIBERATELY CONSERVATIVE ON A PHONE. Focusing a text
        // input opens the software keyboard the instant the modal appears, which
        // covers half the form and scrolls the header — including the only exit —
        // out of view. A <select> does not open the keyboard, so that case is
        // always safe. A text input is only focused on a screen with a real
        // keyboard, where it is a genuine convenience.
        var isNarrow = (typeof window.innerWidth === 'number' && window.innerWidth <= 640);
        var singleBranch = els.branch.options.length === 1;
        if (!isNarrow && !singleBranch && els.branch.focus) els.branch.focus();
        else if (!isNarrow && singleBranch && els.name.focus) els.name.focus();
    }

    function close() {
        if (!els.overlay) return;
        els.overlay.classList.remove('active');
        els.overlay.setAttribute('aria-hidden', 'true');
    }

    /**
     * Branch options come from the manager's ASSIGNED branches, read off the
     * dashboard module. That is the point of moving the form in here: the
     * page already knows which branches this person runs, so they cannot file
     * against one they do not.
     */
    function populateBranches() {
        var branches = [];
        try {
            if (typeof window.getOwnerAssignedBranches === 'function') {
                branches = window.getOwnerAssignedBranches() || [];
            }
        } catch (e) { branches = []; }
        els.branch.innerHTML = branches.length
            ? '<option value="">Select Branch</option>' + branches.map(function (b) {
                return '<option value="' + escapeHTML(b) + '">' + escapeHTML(b) + '</option>';
            }).join('')
            : '<option value="">No branches assigned</option>';
        // With exactly one branch there is no decision to make, so pick it and
        // move on rather than making them confirm the only possible answer.
        if (branches.length === 1) els.branch.value = branches[0];
    }

    /**
     * Pre-fill the reporter's own name and email from their signed-in account.
     *
     * ⚠️ The EMAIL FIELD STAYS EDITABLE on purpose. It is the address the
     * approval notification goes to, and the manager may be filing on behalf of
     * someone else — but leaving it pre-filled means a typo (the failure that
     * silently produces a ticket nobody can be emailed) is far less likely.
     */
    function prefillIdentity() {
        var name = '';
        if (typeof window.getOwnerDisplayName === 'function') {
            try { name = window.getOwnerDisplayName() || ''; } catch (e) { name = ''; }
        }
        if (els.name && !els.name.value) els.name.value = name;
        if (els.email && !els.email.value) els.email.value = getAuthEmail();
    }

    // ------------------------------------------------------------------
    //  ATTACHMENTS — same Cloudinary path, size cap and type list as the
    //  public form, so evidence that form accepted is still accepted here.
    //  Uploaded files land in `uploadedAttachments`, which is what gets
    //  written to the ticket on submit.
    // ------------------------------------------------------------------
    function setUploadStatus(msg, isError) {
        if (!els.uploadStatus) return;
        els.uploadStatus.textContent = msg || '';
        els.uploadStatus.style.display = msg ? 'block' : 'none';
        els.uploadStatus.classList.toggle('is-error', !!isError);
    }

    function setProgress(pct) {
        if (!els.progressBar) return;
        els.progressBar.style.width = pct + '%';
        if (els.progressText) els.progressText.textContent = pct + '%';
    }

    function formatSize(bytes) {
        if (!bytes) return '0 B';
        var mb = bytes / (1024 * 1024);
        return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
    }

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
function renderGrid() {
        if (!els.grid) return;
        if (!uploadedAttachments.length) {
            els.grid.style.display = 'none';
            els.grid.innerHTML = '';
            return;
        }
        els.grid.style.display = 'grid';
        els.grid.innerHTML = uploadedAttachments.map(function (a) {
            var isImg = /^image\//.test(a.mimeType || '');
            // The thumbnail is an ANCHOR so the shared viewer (js/attachment-viewer.js)
            // can open it. It used to be a <span>, which the delegated handler --
            // `a.attachment-preview` -- could never match, so a file picked here could
            // not be previewed at all before submitting. Clicking the card now opens
            // the lightbox; ctrl-click still reaches the browser for a new tab.
            var thumbInner = isImg
                ? '<img src="' + escapeHTML(a.url) + '" alt="' + escapeHTML(a.fileName) + '" decoding="async">'
                : '<i class="fas fa-file"></i>';
            var thumb = '<a href="' + escapeHTML(a.url) + '" target="_blank" rel="noopener noreferrer" class="'
                + (isImg ? 'attachment-preview' : 'attachment-file-icon')
                + '" title="' + escapeHTML(a.fileName) + '">' + thumbInner + '</a>';
            return [
                // .attachment-item / .attachment-preview / .attachment-meta /
                // .attachment-remove are the app's existing card classes —
                // reusing them is what makes the modal's attachments look
                // identical to the ones everywhere else.
                '<div class="attachment-item">',
                thumb,
                '  <div class="attachment-meta">',
                '    <span class="attachment-name" title="' + escapeHTML(a.fileName) + '">' + escapeHTML(a.fileName) + '</span>',
                '    <span class="attachment-size">' + escapeHTML(formatSize(a.bytes || 0)) + '</span>',
                '  </div>',
                // ⚠️ `.attachment-remove` is opacity:0 until the card is hovered
                // (style.css). It is given `otf-remove-always` so the remove
                // control is actually reachable by keyboard and on touch, where
                // there is no hover at all.
                '  <button type="button" class="attachment-remove otf-remove-always" data-otf-remove="' + escapeHTML(a.fileName) + '" aria-label="Remove ' + escapeHTML(a.fileName) + '">',
                '    <i class="fas fa-times"></i>',
                '  </button>',
                '</div>'
            ].join('');
        }).join('');

        els.grid.querySelectorAll('[data-otf-remove]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var target = btn.getAttribute('data-otf-remove');
                uploadedAttachments = uploadedAttachments.filter(function (a) {
                    return a.fileName !== target;
                });
                renderGrid();
            });
        });
    }

    function handleFiles(fileList) {
        var files = Array.prototype.slice.call(fileList || []);
        if (!files.length) return;
        var maxBytes = MAX_ATTACHMENT_SIZE_MB * 1024 * 1024;
        var accepted = [];
        var problems = [];
        files.forEach(function (f) {
            if (f.size > maxBytes) {
                problems.push(f.name + ' exceeds ' + MAX_ATTACHMENT_SIZE_MB + 'MB');
            } else if (f.type && ALLOWED_ATTACHMENT_TYPES.indexOf(f.type) === -1) {
                problems.push(f.name + ' is not a supported type');
            } else {
                accepted.push(f);
            }
        });
        if (problems.length) setUploadStatus(problems.join(' · '), true);
        if (!accepted.length) return;

        els.progressWrap.style.display = 'flex';
        setProgress(0);
        var done = 0;
        accepted.forEach(function (file) {
            uploadToCloudinary(file, function (ok, result) {
                if (ok) {
                    uploadedAttachments.push(result);
                } else {
                    // ⚠️ NOT a hard failure. Blocking submit here would trap the
                    // manager in the modal with a ticket they described in full,
                    // over a failed photo. They can submit without it and the
                    // description still stands.
                    setUploadStatus('Could not upload ' + file.name + '. You can still submit without it.', true);
                }
                done += 1;
                setProgress(Math.round((done / accepted.length) * 100));
                renderGrid();
                if (done === accepted.length) {
                    els.progressWrap.style.display = 'none';
                    if (!problems.length) setUploadStatus(done + ' file(s) attached.', false);
                }
            });
        });
    }

    /**
     * XHR rather than fetch, because upload PROGRESS needs
     * `xhr.upload.onprogress`. fetch has no equivalent, so the progress bar
     * could only ever jump 0→100 and would lie about a slow 90MB video.
     */
    // Generate a Cloudinary-safe public_id that guarantees uniqueness even when
    // two files share the same base name but have different extensions
    // (e.g. "0109.mp4" + "0109.png"). Same-public_id uploads replace each
    // other by default, so we append a short random suffix.
    function makeUniquePublicId(fileName) {
        var dotIdx = String(fileName || '').lastIndexOf('.');
        var base = dotIdx > 0 ? String(fileName).slice(0, dotIdx) : String(fileName);
        var safeBase = base.replace(/[^A-Za-z0-9 _.\\-]/g, ' ').replace(/\s+/g, ' ').trim() || 'file';
        var suffix = Math.random().toString(36).slice(2, 10);
        return safeBase + '-' + suffix;
    }

    function uploadToCloudinary(file, done) {
        var data = new FormData();
        data.append('file', file);
        data.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
        // Unique public_id so same-named files with different extensions don't
        // overwrite each other in Cloudinary.
        data.append('public_id', makeUniquePublicId(file.name));
        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD_NAME + '/auto/upload');
        xhr.upload.onprogress = function (e) {
            if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = function () {
            if (xhr.status < 200 || xhr.status >= 300) {
                // 401 is the usual case: the unsigned preset was renamed or the
                // cloud re-keyed. All three copies of this config then need to
                // change together (script.js:33-35, submit-ticket.html, here).
                console.error('[TicketForm] Cloudinary upload failed', xhr.status, xhr.responseText);
                return done(false, null);
            }
            try {
                var payload = JSON.parse(xhr.responseText);
                // ⚠️ WRITE THE CANONICAL SHAPE, not just whatever this form needed.
                // `url`/`publicId`/`fileName` are what this module reads back, but
                // every renderer in script.js (ticket details, approval, revision,
                // resolve) reads the Cloudinary names `secure_url`/`public_id`/
                // `name`. Writing only the local names is what produced tickets
                // showing a 1.22 MB card with an EMPTY href and no working link.
                // Both are written so either reader is satisfied, and
                // normalizeAttachment() in script.js bridges the two regardless.
                done(true, {
                    url: payload.secure_url,
                    publicId: payload.public_id,
                    fileName: file.name,
                    secure_url: payload.secure_url,
                    public_id: payload.public_id,
                    name: file.name,
                    resource_type: payload.resource_type || '',
                    format: payload.format || '',
                    mimeType: payload.resource_type === 'video' ? 'video/mp4' : (file.type || 'application/octet-stream'),
                    bytes: file.size,
                    uploadedAt: new Date().toISOString()
                });
            } catch (err) {
                console.error('[TicketForm] Could not parse Cloudinary response', err);
                done(false, null);
            }
        };
        xhr.onerror = function () { done(false, null); };
        xhr.send(data);
    }

    function resetForm(clearIdentity) {
        if (els.form) els.form.reset();
        uploadedAttachments = [];
        renderGrid();
        setUploadStatus('');
        if (els.progressWrap) els.progressWrap.style.display = 'none';
        if (clearIdentity) prefillIdentity();
    }

    // ------------------------------------------------------------------
    //  SUBMIT
    // ------------------------------------------------------------------

    /**
     * Required-field check, reported the way the rest of the app does it.
     * `novalidate` is set on the form so the browser's own bubbles do not
     * fight these messages.
     */
    function validate() {
        var missing = [];
        [
            [els.branch, 'Branch'],
            [els.name, 'Name of Reporter'],
            [els.email, 'Email'],
            [els.incident, 'Incident'],
            [els.description, 'Full Description']
        ].forEach(function (pair) {
            if (!pair[0].value || !pair[0].value.trim()) missing.push(pair[1]);
        });
        if (els.email.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(els.email.value.trim())) {
            missing.push('a valid email address');
        }
        return missing;
    }

    function setBusy(state) {
        busy = state;
        els.submit.disabled = state;
        // Disable the exits while a write is in flight. A double-tap on Submit
        // (or a stray Escape) landing mid-request would otherwise close the
        // modal out from under the promise chain that is about to resolve.
        els.close.disabled = state;
        els.reset.disabled = state;
        els.submit.innerHTML = state
            ? '<i class="fas fa-circle-notch fa-spin"></i> <span>Submitting…</span>'
            : '<i class="fas fa-paper-plane"></i> <span>Submit Ticket</span>';
    }

    function handleSubmit(e) {
        e.preventDefault();
        if (busy) return;

        var missing = validate();
        if (missing.length) {
            toast('Please fill in: ' + missing.join(', '), 'error');
            return;
        }
        // `typeof`, not a bare read: these are GLOBALS supplied by other
        // scripts, and a bare `!firestoreService` would throw ReferenceError
        // on a dashboard where the service never loaded — turning a graceful
        // message into a blank modal.
        if (typeof firestoreService === 'undefined' || !firestoreService.generateTicketNumber) {
            toast('Ticket service unavailable. Please try again.', 'error');
            return;
        }

        setBusy(true);
        var branch = els.branch.value;
        var data = {
            branch: branch,
            priority: els.priority.value,
            name: els.name.value.trim(),
            position: els.position.value.trim(),
            email: els.email.value.trim(),
            contact: els.contact.value.trim(),
            datetime: els.datetime.value,
            location: els.location.value.trim(),
            incident: els.incident.value.trim(),
            description: els.description.value.trim(),
            // ⚠️ BOTH ATTACHMENT KEYS ARE REQUIRED — see the file header.
            // Dropping `requesterAttachments` would leave the operator's
            // resolution step with nothing to show and the footage invisible.
            attachments: uploadedAttachments,
            requesterAttachments: uploadedAttachments,
            status: 'Pending',
            approvalStatus: 'pending',
            filedByRole: 'owner',
            filedByUid: (typeof auth !== 'undefined' && auth.currentUser) ? auth.currentUser.uid : '',
            filedByEmail: getAuthEmail(),
            // ⚠️ BOTH TIMESTAMPS ARE WRITTEN, and both are needed.
            // `createdAt` is a SERVER timestamp: normalizeTicketReport()
            // (js/owner-dashboard.js:402) reads createdAt FIRST, and the client's
            // clock is not a trustworthy "when was this filed" — a requester's
            // machine can be hours off. `submittedAt` is a plain ISO string that
            // also sorts correctly (owner-dashboard.js:1077 falls back to
            // `new Date(...)`), so it is a safety net, not a duplicate.
            createdAt: (typeof firebase !== 'undefined' && firebase.firestore)
                ? firebase.firestore.FieldValue.serverTimestamp()
                : new Date().toISOString(),
            submittedAt: new Date().toISOString()
        };

        firestoreService.generateTicketNumber(branch)
            .then(function (ticketNumber) {
                data.ticketNumber = ticketNumber;
                return db.collection('tickets').doc(ticketNumber).set(data);
            })
            .then(function () {
                // The ticket is through. Close first, THEN toast, so the toast
                // is anchored to the dashboard rather than flashing over a
                // modal that is about to disappear.
                close();
                toast('Ticket ' + data.ticketNumber + ' submitted successfully.', 'success');
                resetForm(false);
                if (typeof window.onOwnerTicketFiled === 'function') {
                    window.onOwnerTicketFiled(data);
                }
            })
            .catch(function (err) {
                console.error('[TicketForm] Submit failed', err);
                // ⚠️ Nothing is cleared on failure. The manager has just typed a
                // full incident description; losing it to a Firestore error is
                // the worst outcome available here.
                toast('Could not submit the ticket. Please try again.', 'error');
            })
            .then(function () { setBusy(false); });
    }

    window.OwnerTicketForm = { open: open, close: close, isOpen: isOpen };
})();
