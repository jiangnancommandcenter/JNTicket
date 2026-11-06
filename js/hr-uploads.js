/**
 * ==============================================================
 *  HR COORDINATION FILE UPLOADS  (NOV document uploads)
 *
 *  HR staff issue NOVs (Notices of Violation) to violators and need
 *  to attach the scanned NOV / receipt / supporting documents to a
 *  transferred ticket or violation. Because HR cannot write to the
 *  `violations` or `tickets` collections, uploads live in their own
 *  `hr_uploads` collection, keyed by `targetKey` ('tickets/<id>' |
 *  'violations/<id>').
 *
 *  Mirrors js/remarks.js: one collection-wide presence listener flags
 *  which targets already have files, so the row button changes colour
 *  at a glance. HR can see at a glance which violations already carry
 *  an uploaded NOV.
 * ==============================================================
 */
(function () {
    'use strict';

    var els = {};
    var unsub = null;
    var currentKey = '';
    var currentLabel = '';

    var notedKeys = new Set();
    var presenceUnsub = null;
    var loadedOnce = false;

    function hasUploads(key) {
        return notedKeys.has(String(key || ''));
    }

    function paintPresence() {
        var btns;
        try { btns = document.querySelectorAll('[data-upload-key]'); } catch (e) { return; }
        for (var i = 0; i < btns.length; i++) {
            var key = btns[i].getAttribute('data-upload-key');
            if (hasUploads(key)) btns[i].classList.add('has-uploads');
            else btns[i].classList.remove('has-uploads');
        }
    }

    function watchPresence() {
        if (presenceUnsub) return;
        if (!window.db || typeof window.db.collection !== 'function') return;
        try {
            presenceUnsub = window.db.collection('hr_uploads').onSnapshot(function (snap) {
                notedKeys = new Set();
                snap.forEach(function (doc) {
                    var k = doc.data() && doc.data().targetKey;
                    if (k) notedKeys.add(String(k));
                });
                paintPresence();
            }, function (err) {
                console.warn('HR uploads presence listener stopped:', err && err.message);
            });
        } catch (e) { /* listener unavailable */ }
    }

    function esc(value) {
        if (typeof window.escapeHTML === 'function') return window.escapeHTML(value);
        return String(value == null ? '' : value).replace(/[&<>\"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    /**
     * Superadmin is a VIEWER of HR uploads — they can see files but not
     * upload or delete them (NOV upload is HR's action).
     * On main.html, script.js declares currentUserIsSuperAdmin() globally;
     * on ownerdashboard.html script.js is absent → undefined → false →
     * HR keeps full upload/delete access.
     */
    function isViewer() {
        try {
            if (typeof window.currentUserIsSuperAdmin === 'function') return window.currentUserIsSuperAdmin();
        } catch (e) { /* fall through */ }
        return false;
    }

    function toast(message, type) {
        if (typeof window.showToast === 'function') return window.showToast(message, type || 'info');
        console.log(message);
    }

    function fieldValue() {
        var fs = window.firebase && window.firebase.firestore;
        return fs && fs.FieldValue ? fs.FieldValue.serverTimestamp() : new Date();
    }

    function selfEmail() {
        var user = window.auth && window.auth.currentUser;
        var email = user && user.email ? String(user.email) : '';
        if (window.normalizeUserEmail) return window.normalizeUserEmail(email);
        return email.trim().toLowerCase();
    }

    function selfName() {
        var email = selfEmail();
        if (!email) return 'HR Staff';
        try {
            var profile = window.getUserProfile ? window.getUserProfile(email) : null;
            if (profile && profile.name) return String(profile.name).trim();
        } catch (e) { /* fall back */ }
        return email.split('@')[0];
    }

    // Cloudinary config (same public values as script.js — unsigned preset, not a secret)
    var UPLOAD_CLOUD_NAME = 'jlux07ne';
    var UPLOAD_PRESET = 'jiangnan';

    function isCloudinaryConfigured() {
        return UPLOAD_CLOUD_NAME && UPLOAD_CLOUD_NAME !== 'YOUR_CLOUD_NAME'
            && UPLOAD_PRESET && UPLOAD_PRESET !== 'YOUR_UPLOAD_PRESET';
    }

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

    async function compressVideoBeforeUpload(file, onProgress) {
        if (!file.type.startsWith('video/')) return file;
        if (file.size <= 5 * 1024 * 1024) return file;

        try {
            var video = document.createElement('video');
            video.muted = true;
            video.playsInline = true;
            video.src = URL.createObjectURL(file);

            // ⚠️ Wait for metadata so videoWidth/videoHeight/duration are populated.
            // Without this they are 0, canvas is 0×0, nothing gets drawn,
            // and the recorder stops almost immediately.
            await new Promise(function (resolve) {
                if (video.readyState >= 1) resolve();
                else video.onloadedmetadata = resolve;
            });

            var duration = video.duration;
            // Safety: if duration is invalid or infinite, use a sane default
            if (!duration || duration === Infinity) duration = 60;

            // Target size: ~2/3 of original (e.g. 90MB → ~60MB).
            var originalSizeMB = file.size / (1024 * 1024);
            var targetSizeMB = Math.max(originalSizeMB * (2 / 3), 1);
            var targetBits = targetSizeMB * 8 * 1024 * 1024;
            var bitrate = Math.floor(targetBits / duration);
            // Guardrails: prevent quality collapse on short clips, and prevent
            // a compressed output larger than the original on already-efficient video.
            var minBitrate = 300 * 1000;   // 300 kbps floor
            var maxBitrate = 8 * 1000 * 1000; // 8 Mbps ceiling
            bitrate = Math.max(minBitrate, Math.min(bitrate, maxBitrate));

            // Use original resolution — do not downscale.
            var canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            var ctx = canvas.getContext('2d');

            // Build a stream that preserves the original frame rate (no forced FPS)
            // and includes the original audio track so audio + sync are preserved.
            var videoStream = canvas.captureStream();
            var stream = new MediaStream(videoStream.getVideoTracks());

            // Capture audio from the video element so it is preserved in the output.
            try {
                var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                if (audioCtx.state === 'suspended') {
                    await audioCtx.resume();
                }
                var mediaElementSource = audioCtx.createMediaElementSource(video);
                var audioDest = audioCtx.createMediaStreamDestination();
                mediaElementSource.connect(audioDest);
                for (var i = 0; i < audioDest.stream.getAudioTracks().length; i++) {
                    stream.addTrack(audioDest.stream.getAudioTracks()[i]);
                }
            } catch (e) {
                // Audio capture is optional — proceed with video-only if it fails.
                console.warn('[VideoCompress] Audio capture skipped:', e.message);
            }

            var recorder = new MediaRecorder(stream, {
                mimeType: 'video/webm; codecs=vp9',
                videoBitsPerSecond: bitrate
            });

            var chunks = [];
            recorder.ondataavailable = function (e) { if (e.data.size > 0) chunks.push(e.data); };

            var finished = false;
            var startTime = performance.now();
            var animationFrameId = null;
            var timeoutId = null;

            // Safety timeout: stop after duration + 10 seconds so a stuck
            // video never freezes the upload forever.
            var maxTime = duration * 1000 + 10000;

            var draw = function () {
                if (finished) return;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                var elapsed = (performance.now() - startTime) / 1000;
                var pct = Math.min(100, Math.round((elapsed / duration) * 100));
                if (typeof onProgress === 'function') onProgress(pct);
                if (elapsed >= duration || video.ended) {
                    finished = true;
                    if (animationFrameId) cancelAnimationFrame(animationFrameId);
                    if (timeoutId) clearTimeout(timeoutId);
                    recorder.stop();
                } else {
                    animationFrameId = requestAnimationFrame(draw);
                }
            };

            await new Promise(function (resolve, reject) {
                recorder.onstop = resolve;
                recorder.onerror = reject;

                // Safety timeout: force-stop the recorder if it runs too long.
                timeoutId = setTimeout(function () {
                    if (!finished) {
                        finished = true;
                        if (animationFrameId) cancelAnimationFrame(animationFrameId);
                        recorder.stop();
                    }
                }, maxTime);

                recorder.start();

                // ⚠️ Await video.play() so the video actually plays during
                // compression instead of freezing on frame 0 when autoplay is blocked.
                video.play().then(function () {
                    draw();
                }).catch(function () {
                    // Autoplay blocked — start drawing anyway; canvas may still capture frames.
                    draw();
                });
            });

            // Ensure the encoder flushes any final chunk before we build the blob.
            await new Promise(function (resolve) { setTimeout(resolve, 0); });

            var blob = new Blob(chunks, { type: 'video/webm' });
            if (!blob || blob.size === 0) {
                URL.revokeObjectURL(video.src);
                video.load();
                video.pause();
                console.warn('[VideoCompress] Empty compressed output, returning original.');
                return file;
            }

            URL.revokeObjectURL(video.src);
            video.load(); // release video resources so the file is not locked
            video.pause();

            var compressed = new File([blob], file.name, {
                type: 'video/webm',
                lastModified: file.lastModified
            });

            console.log('[VideoCompress] Compressed:', file.name,
                '→', (file.size / 1024 / 1024).toFixed(2), 'MB',
                '→', (compressed.size / 1024 / 1024).toFixed(2), 'MB');
            return compressed.size < file.size ? compressed : file;
        } catch (e) {
            console.warn('[VideoCompress] Skipping compression:', e.message);
            return file;
        }
    }

    async function uploadToCloudinary(file, onProgress) {
        if (!isCloudinaryConfigured()) throw new Error('Cloudinary is not configured.');
        var uploadFile = await compressVideoBeforeUpload(file, onProgress);
        var formData = new FormData();
        formData.append('file', uploadFile);
        formData.append('upload_preset', UPLOAD_PRESET);
        // Resource type: 'auto' lets Cloudinary detect image vs raw (PDF, DOC, etc.)
        formData.append('resource_type', 'auto');
        // Unique public_id so same-named files with different extensions don't
        // overwrite each other in Cloudinary.
        formData.append('public_id', makeUniquePublicId(file.name));
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            if (onProgress && xhr.upload) {
                xhr.upload.addEventListener('progress', function (e) {
                    if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
                });
            }
            xhr.addEventListener('load', function () {
                if (xhr.status >= 200 && xhr.status < 300) {
                    try {
                        var att = JSON.parse(xhr.responseText);
                        if (att.error) { reject(new Error(att.error.message || 'Cloudinary error')); return; }
                        var url = att.secure_url || att.url;
                        if (!url) { reject(new Error('Cloudinary returned no file URL')); return; }
                        resolve(att);
                    }
                    catch (e) { reject(e); }
                }
                else {
                    try { var errBody = JSON.parse(xhr.responseText); reject(new Error('Upload failed: ' + (errBody.error && errBody.error.message || 'HTTP ' + xhr.status))); }
                    catch (e) { reject(new Error('Upload failed: HTTP ' + xhr.status)); }
                }
            });
            xhr.addEventListener('error', function () { reject(new Error('Upload network error.')); });
            xhr.addEventListener('abort', function () { reject(new Error('Upload aborted.')); });
            xhr.open('POST', 'https://api.cloudinary.com/v1_1/' + UPLOAD_CLOUD_NAME + '/auto/upload');
            xhr.send(formData);
        });
    }

    function build() {
        if (els.overlay) return;
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'hrUploadsModal';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'hrUploadsModalTitle');
        overlay.innerHTML =
            '<div class="modal-container uploads-modal">' +
              '<div class="modal-header uploads-header">' +
                '<div class="uploads-title-group">' +
                  '<div class="uploads-icon" aria-hidden="true"><i class="fas fa-cloud-upload-alt"></i></div>' +
                  '<div class="uploads-title-text">' +
                    '<h2 id="hrUploadsModalTitle"><span id="uploadsTitleLabel">Uploaded NOV Files</span><span class="uploads-count" id="uploadsCount" hidden></span></h2>' +
                    '<p class="u-section-sub uploads-subject" id="uploadsSubject" style="margin:0;"></p>' +
                  '</div>' +
                '</div>' +
                '<button type="button" class="modal-close" id="hrUploadsModalClose" aria-label="Close">&times;</button>' +
              '</div>' +
              '<div class="modal-body uploads-body">' +
                '<div id="uploadsList" class="uploads-list" role="log" aria-live="polite" aria-label="Uploaded files">' +
                  '<p class="u-section-sub">Loading&hellip;</p>' +
                '</div>' +
                '<div class="uploads-compose">' +
                  '<div class="uploads-compose-head">' +
                    '<label for="hrUploadsInput">Attach NOV file</label>' +
                    '<span class="uploads-visibility"><i class="fas fa-lock" aria-hidden="true"></i>HR team only</span>' +
                  '</div>' +
                  '<div class="uploads-dropzone-wrap">' +
                    '<label class="uploads-dropzone" for="hrUploadsInput">' +
                      '<i class="fas fa-cloud-upload-alt"></i>' +
                      '<span class="uploads-dz-text">Drag &amp; drop files here</span>' +
                      '<span class="uploads-dz-hint">or click to browse</span>' +
                      '<span class="uploads-selected-badge" id="uploadsSelectedBadge" style="display:none;"><i class="fas fa-check-circle" aria-hidden="true"></i><span id="uploadsSelectedCount">0</span> file<span id="uploadsSelectedCountS"></span> selected</span>' +
                      '<input type="file" id="hrUploadsInput" multiple accept=".pdf,.jpg,.jpeg,.png,.doc,.docx">' +
                    '</label>' +
                    '<button type="button" class="btn btn-primary btn-sm uploads-send" id="hrUploadsSaveBtn">' +
                      '<i class="fas fa-cloud-upload-alt" aria-hidden="true"></i><span>Upload</span>' +
                    '</button>' +
                  '</div>' +
                  '<div class="uploads-compose-bottom">' +
                    '<span id="uploadsCounter" aria-live="off">0 files</span>' +
                    '<div class="uploads-compose-actions">' +
                      '<span class="uploads-hint">PDF, JPG, PNG, DOC, DOCX · max 100 MB each</span>' +
                    '</div>' +
                  '</div>' +
                '</div>' +
              '</div>' +
            '</div>';
        document.body.appendChild(overlay);

        els.overlay = overlay;
        els.titleLabel = overlay.querySelector('#uploadsTitleLabel');
        els.count = overlay.querySelector('#uploadsCount');
        els.subject = overlay.querySelector('#uploadsSubject');
        els.list = overlay.querySelector('#uploadsList');
        els.input = overlay.querySelector('#hrUploadsInput');
        els.save = overlay.querySelector('#hrUploadsSaveBtn');
        els.counter = overlay.querySelector('#uploadsCounter');
        els.selectedBadge = overlay.querySelector('#uploadsSelectedBadge');
        els.selectedCount = overlay.querySelector('#uploadsSelectedCount');
        els.selectedCountS = overlay.querySelector('#uploadsSelectedCountS');

        overlay.querySelector('#hrUploadsModalClose').addEventListener('click', close);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
        // Delegated delete + open-file for upload rows (renderList recreates innerHTML each snapshot)
        els.list.addEventListener('click', function (e) {
            var btn = e.target.closest('.uploads-delete');
            if (btn) {
                e.preventDefault();
                deleteFile(btn.getAttribute('data-upload-id'));
                return;
            }
            // Clicking anywhere on the tile (name, meta, etc.) opens the file
            var tile = e.target.closest('.uploads-tile');
            if (tile && tile.getAttribute('data-url')) {
                var openLink = e.target.closest('.uploads-tile-open');
                var previewLink = e.target.closest('.uploads-tile-preview');
                // Only intercept when not already on a link that handles navigation itself
                if (!openLink && !previewLink) {
                    e.preventDefault();
                    window.open(tile.getAttribute('data-url'), '_blank');
                }
            }
        });
        els.save.addEventListener('click', submit);
        els.input.addEventListener('change', function () {
            var n = (els.input.files || []).length;
            if (els.counter) els.counter.textContent = n + ' file' + (n === 1 ? '' : 's');
            if (els.selectedBadge && els.selectedCount && els.selectedCountS) {
                if (n > 0) {
                    els.selectedCount.textContent = n;
                    els.selectedCountS.textContent = n === 1 ? '' : 's';
                    els.selectedBadge.style.display = 'inline-flex';
                } else {
                    els.selectedBadge.style.display = 'none';
                }
            }
        });
        // Drag & drop on the uploads dropzone
        var dz = els.overlay.querySelector('.uploads-dropzone');
        if (dz) {
            dz.addEventListener('dragover', function (e) {
                e.preventDefault();
                dz.classList.add('dragover');
            });
            dz.addEventListener('dragleave', function (e) {
                e.preventDefault();
                dz.classList.remove('dragover');
            });
            dz.addEventListener('drop', function (e) {
                e.preventDefault();
                dz.classList.remove('dragover');
                if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
                    // Transfer dropped files into the hidden input
                    var dt = new DataTransfer();
                    for (var i = 0; i < e.dataTransfer.files.length; i++) {
                        dt.items.add(e.dataTransfer.files[i]);
                    }
                    els.input.files = dt.files;
                    var n = dt.files.length;
                    if (els.counter) els.counter.textContent = n + ' file' + (n === 1 ? '' : 's');
                    if (els.selectedBadge && els.selectedCount && els.selectedCountS) {
                        if (n > 0) {
                            els.selectedCount.textContent = n;
                            els.selectedCountS.textContent = n === 1 ? '' : 's';
                            els.selectedBadge.style.display = 'inline-flex';
                        } else {
                            els.selectedBadge.style.display = 'none';
                        }
                    }
                }
            });
        }
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && els.overlay && els.overlay.classList.contains('active')) close();
        });
    }

    function renderList(rows) {
        if (!els.list) return;
        if (!rows.length && loadedOnce) {
            if (els.count) { els.count.hidden = true; els.count.textContent = ''; }
            els.list.innerHTML = '<div class="uploads-empty"><span class="uploads-empty-icon" aria-hidden="true"><i class="fas fa-cloud-upload-alt"></i></span><strong>No files yet</strong><span>Attach the NOV document or supporting evidence so the HR team can see it at a glance.</span></div>';
            return;
        }
        var viewOnly = isViewer();
        var AV = window.AttachmentViewer;
        var normalize = (AV && AV.helpers && typeof AV.helpers.normalizeAttachment === 'function')
            ? AV.helpers.normalizeAttachment : null;
        var buildPreview = (AV && typeof AV.buildAttachmentPreview === 'function')
            ? AV.buildAttachmentPreview : null;
        els.list.innerHTML = rows.map(function (r, i) {
            var who = esc(r.uploadedByName || r.uploadedBy || 'Unknown');
            var whenStr = esc(fmtWhen(r.uploadedAt));
            var sizeKB = Math.round((r.fileSize || 0) / 1024);
            var sizeStr = sizeKB > 1024 ? (sizeKB / 1024).toFixed(1) + ' MB' : sizeKB + ' KB';
            var name = r.fileName || 'unnamed';
            var url = r.fileUrl || '';

            // Explorer "Large Icons" preview: a REAL page-1 render for images
            // and videos (Cloudinary transform), a live document embed for
            // PDF/DOC (Google Docs Viewer with Cloudinary's pg_1 render as
            // fallback), a big typed glyph for everything else (pdf/doc/...).
            // Uses the SAME shared builder every other grid in the app uses
            // (js/attachment-viewer.js), so a file looks identical here and
            // in the report modal — and the Cloudinary /image/upload/ or
            // /video/upload/ URL is what tells it the type.
            var preview = '';
            if (buildPreview && normalize && url) {
                var norm = normalize({ secure_url: url, name: name, bytes: r.fileSize });
                if (norm) preview = buildPreview(norm, i);
            }
            if (!preview) {
                preview = '<div class="attachment-file-icon"><i class="fas fa-file" style="color:#64748b"></i></div>';
            }
            // Documents never get a flat glyph: a live page-1 render sits in
            // the tile so the NOV's own contents read at a glance —
            // click still opens the full file in a new tab.
            var fmt = '';
            var extSrc = (name ? name + ' ' : '') + (url || '');
            var extM = extSrc.match(/\.([A-Za-z0-9]{2,5})(?:\?|$|["'\s])/g);
            if (extM && extM.length) {
                var last = extM[extM.length - 1].replace(/[^A-Za-z0-9]/g, '');
                fmt = last.toLowerCase();
            }
            var isPdf = url && fmt === 'pdf';
            var isOffice = url && (fmt === 'doc' || fmt === 'docx' || fmt === 'xls' || fmt === 'xlsx' || fmt === 'ppt' || fmt === 'pptx');
            if (isPdf) {
                // PDFs render natively in the browser — no external service,
                // so this can never be a blank box from a blocked embed.
                preview = '<iframe class="uploads-doc-frame" src="' + esc(url) + '"'
                    + ' title="' + esc(name) + '" loading="lazy" scrolling="no" tabindex="-1"></iframe>';
            } else if (isOffice) {
                var viewerUrl = 'https://docs.google.com/viewer?url=' + encodeURIComponent(url) + '&embedded=true';
                var cloudPage = url.replace(/\/upload\/(v\d+\/)?/, '/upload/pg_1/');
                preview = '<iframe class="uploads-doc-frame" src="' + esc(viewerUrl) + '"'
                    + ' title="' + esc(name) + '" loading="lazy" scrolling="no" tabindex="-1"></iframe>'
                    + '<img class="uploads-doc-fallback" src="' + esc(cloudPage) + '" alt="" aria-hidden="true"'
                    + ' onerror="this.outerHTML=\'\'">';
            }

            // Superadmin (viewer) sees no delete button — HR owns these files.
            var deleteBtn = viewOnly ? '' :
                '<button type="button" class="uploads-delete" data-upload-id="' + esc(r.id) + '" title="Delete file"><i class="fas fa-trash-alt"></i></button>';

            var tile =
                '<a class="uploads-tile-preview" href="' + esc(url || '#') + '"' + (url ? ' target="_blank" rel="noopener" title="Open ' + esc(name) + '"' : '') + '>' + preview + '</a>' +
                '<div class="uploads-tile-name" title="' + esc(name) + '">' + esc(name) + '</div>' +
                '<span class="uploads-attached-badge" title="File is attached and ready to view"><i class="fas fa-paperclip" aria-hidden="true"></i> Attached</span>' +
                '<div class="uploads-tile-meta"><span>' + sizeStr + '</span><span>' + esc(who) + '</span><span>' + whenStr + '</span></div>' +
                deleteBtn;

            // Document tiles render a live embed, so the outer wrapper is always
            // a div: an anchor wrapper would trigger the shared viewer's
            // .attachment-preview click handler, which this tile must not use.
            var openLink = url
                ? '<a class="uploads-tile-open" href="' + esc(url) + '" target="_blank" rel="noopener" title="Open ' + esc(name) + ' in a new tab"><i class="fas fa-external-link-alt"></i> Open file</a>'
                : '';
            return '<div class="uploads-tile" data-url="' + esc(url) + '">' + tile + openLink + '</div>';
        }).join('');
        if (els.count) {
            var label = rows.length === 1 ? '1 file' : rows.length + ' files';
            els.count.textContent = label;
            els.count.hidden = false;
        }
    }

    function fmtWhen(value) {
        if (!value) return '';
        var d = (value && typeof value.toDate === 'function') ? value.toDate() : new Date(value);
        if (isNaN(d.getTime())) return '';
        try {
            return d.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        } catch (e) { return d.toISOString(); }
    }

    function stop() {
        if (typeof unsub === 'function') { try { unsub(); } catch (e) { /* ignore */ } }
        unsub = null;
    }

    function listen() {
        stop();
        if (!window.db || typeof window.db.collection !== 'function') {
            if (els.list) els.list.innerHTML = '<p class="u-section-sub">Uploads are unavailable right now.</p>';
            return;
        }
        try {
            unsub = window.db.collection('hr_uploads')
                .where('targetKey', '==', currentKey)
                .onSnapshot(function (snap) {
                    var rows = [];
                    snap.forEach(function (doc) {
                        var data = doc.data() || {};
                        data.id = doc.id;
                        rows.push(data);
                    });
                    rows.sort(function (a, b) {
                        var ta = a.uploadedAt && a.uploadedAt.toDate ? a.uploadedAt.toDate().getTime() : 0;
                        var tb = b.uploadedAt && b.uploadedAt.toDate ? b.uploadedAt.toDate().getTime() : 0;
                        return tb - ta;
                    });
                    renderList(rows);
                    loadedOnce = true;
                }, function (err) {
                    console.error('HR uploads listener error:', err);
                    if (els.list) els.list.innerHTML = '<p class="u-section-sub">Could not load uploads.</p>';
                });
        } catch (e) {
            console.error('HR uploads listen failed:', e);
        }
    }

    async function submit() {
        if (isViewer()) return; // Superadmin is view-only — never uploads
        var files = Array.from(els.input.files || []);
        if (!files.length) { toast('Select a file first.', 'error'); return; }

        // ── Client-side file type validation (before sending to Cloudinary) ──
        var allowedTypes = ['.pdf', '.jpg', '.jpeg', '.png', '.doc', '.docx'];
        for (var i = 0; i < files.length; i++) {
            var name = files[i].name.toLowerCase();
            var ext = '';
            var dot = name.lastIndexOf('.');
            if (dot > -1) ext = name.slice(dot);
            if (allowedTypes.indexOf(ext) === -1) {
                toast('Invalid file type: ' + files[i].name + '\nAllowed: PDF, JPG, PNG, DOC, DOCX', 'error');
                return;
            }
        }

        var email = selfEmail();
        if (!email) { toast('You must be signed in to upload.', 'error'); return; }
        if (!window.db || typeof window.db.collection !== 'function') {
            toast('Uploads are unavailable right now.', 'error'); return;
        }

        els.save.disabled = true;
        try {
            for (var i = 0; i < files.length; i++) {
                var file = files[i];
                var att = await uploadToCloudinary(file, function (pct) {
                    if (els.save) els.save.textContent = 'Uploading ' + pct + '%…';
                });
                await window.db.collection('hr_uploads').add({
                    targetKey: currentKey,
                    fileUrl: att.secure_url || att.url,
                    fileName: att.original_filename || file.name,
                    fileSize: file.size,
                    uploadedBy: email,
                    uploadedByName: selfName(),
                    uploadedAt: fieldValue()
                });
            }
            els.input.value = '';
            if (els.counter) els.counter.textContent = '0 files';
            if (els.selectedBadge) els.selectedBadge.style.display = 'none';
            notedKeys.add(String(currentKey));
            paintPresence();
            toast('File uploaded.', 'success');
        } catch (e) {
            console.error('Failed to upload:', e);
            toast('Could not upload file: ' + (e && e.message ? e.message : ''), 'error');
        } finally {
            els.save.disabled = false;
            if (els.save) els.save.innerHTML = '<i class="fas fa-cloud-upload-alt" aria-hidden="true"></i><span>Upload</span>';
        }
    }

    function open(targetKey, label) {
        build();
        currentKey = String(targetKey || '');
        currentLabel = label || currentKey;
        if (els.titleLabel) els.titleLabel.textContent = 'Uploaded NOV Files — ' + currentLabel;
        if (els.subject) els.subject.textContent = label ? ('Files attached to ' + label) : '';
        if (els.count) { els.count.hidden = true; els.count.textContent = ''; }
        if (els.input) { els.input.value = ''; els.input.disabled = false; }
        if (els.save) { els.save.disabled = false; els.save.innerHTML = '<i class="fas fa-cloud-upload-alt" aria-hidden="true"></i><span>Upload</span>'; }
        if (els.counter) els.counter.textContent = '0 files';
        if (els.selectedBadge) els.selectedBadge.style.display = 'none';
        if (els.list) els.list.innerHTML = '<div class="uploads-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>';
        // View-only for Superadmin: hide the whole upload compose area — NOV
        // upload is HR's action. Superadmin can still see and open the file list.
        var compose = els.overlay.querySelector('.uploads-compose');
        if (compose) compose.style.display = isViewer() ? 'none' : '';
        loadedOnce = false;
        els.overlay.classList.add('active');
        listen();
    }

    function close() {
        stop();
        if (els.overlay) els.overlay.classList.remove('active');
        currentKey = '';
        currentLabel = '';
    }

    async function deleteFile(uploadId) {
        if (isViewer()) return; // Superadmin is view-only — never deletes
        if (!confirm('Delete this file?')) return;
        if (!window.db || typeof window.db.collection !== 'function') {
            toast('Uploads are unavailable right now.', 'error');
            return;
        }
        try {
            await window.db.collection('hr_uploads').doc(uploadId).delete();
            // Let the Firestore presence listener update notedKeys and repaint.
            // Do NOT modify notedKeys here — it would race with the listener
            // and could wrongly remove the amber indicator if other files exist
            // for the same targetKey.
            // Re-trigger the modal listener so the file list refreshes immediately.
            listen();
            toast('File deleted.', 'success');
        } catch (e) {
            console.error('Failed to delete file:', e);
            toast('Could not delete file: ' + (e && e.message ? e.message : ''), 'error');
        }
    }

    function openFromButton(btn) {
        if (!btn) return;
        var key = btn.getAttribute('data-upload-key');
        var label = btn.getAttribute('data-upload-label') || '';
        open(key, label);
    }

    window.HrUploads = {
        open: open,
        close: close,
        openFromButton: openFromButton,
        hasUploads: hasUploads,
        watchPresence: watchPresence,
        paintPresence: paintPresence
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { watchPresence(); });
    } else {
        watchPresence();
    }
})();