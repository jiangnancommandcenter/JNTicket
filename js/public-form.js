// ==============================================================
//  PUBLIC SUBMISSION FORM (submit-ticket.html)
// ==============================================================
(function () {
    'use strict';
    var CLOUDINARY_CLOUD_NAME = 'jlux07ne';
    var CLOUDINARY_UPLOAD_PRESET = 'jiangnan';
    var MAX_ATTACHMENT_SIZE_MB = 100;
    var uploadedAttachments = [];
    var fileListEl = document.getElementById('publicFileList');
    var publicForm = document.getElementById('publicTicketForm');
    var btnSubmit = document.getElementById('btnSubmitTicket');
    var btnReset = document.getElementById('btnResetForm');
    var btnShowTrack = document.getElementById('btnShowTrack');
    var trackModal = document.getElementById('trackModal');
    var successModal = document.getElementById('publicSuccessModal');
    var closeSuccessBtn = document.getElementById('closePublicSuccess');
    var copyBtn = document.getElementById('publicCopyBtn');
    var copyStatus = document.getElementById('publicCopyStatus');
    var btnTrackMyTicket = document.getElementById('btnTrackMyTicket');
    var ticketNumberEl = document.getElementById('publicTicketNumber');
    var busy = false;
    function setBusy(b) {
        busy = b;
        if (btnSubmit) btnSubmit.disabled = b;
        if (btnSubmit) btnSubmit.innerHTML = b
            ? '<i class="fas fa-spinner fa-spin"></i> Submitting...'
            : '<i class="fas fa-paper-plane"></i> Submit Ticket';
    }
    function showTrackModal() {
        if (trackModal) trackModal.classList.add('active');
        var trackInput = document.getElementById('trackTicketInput');
        if (trackInput) trackInput.focus();
    }
    if (btnShowTrack) btnShowTrack.addEventListener('click', showTrackModal);
    if (closeSuccessBtn) closeSuccessBtn.addEventListener('click', function () {
        if (successModal) successModal.style.display = 'none';
    });
    if (successModal) {
        successModal.addEventListener('click', function (e) {
            if (e.target === successModal) successModal.style.display = 'none';
        });
    }
    if (copyBtn) copyBtn.addEventListener('click', function () {
        var val = ticketNumberEl ? ticketNumberEl.textContent : '';
        if (!val || val === '—') return;
        navigator.clipboard.writeText(val).then(function () {
            copyBtn.innerHTML = '<i class="fas fa-check"></i> Copied!';
            copyBtn.classList.add('copied');
            if (copyStatus) copyStatus.style.display = 'flex';
            setTimeout(function () {
                copyBtn.innerHTML = '<i class="fas fa-copy"></i> Copy';
                copyBtn.classList.remove('copied');
                if (copyStatus) copyStatus.style.display = 'none';
            }, 1500);
        });
    });
    if (btnTrackMyTicket) btnTrackMyTicket.addEventListener('click', function () {
        if (successModal) successModal.style.display = 'none';
        showTrackModal();
    });
    // One entry per picked file: { name, status: 'uploading'|'done'|'failed', pct }.
    // `uploadedAttachments` holds only the finished uploads, which is what is
    // saved on the ticket.
    var uploadItems = [];
    var pendingUploads = 0;
    var uploadGen = 0; // bumped on reset so late responses from cleared uploads are ignored

    function escapeText(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function updateFileList() {
        if (!fileListEl) return;
        if (uploadItems.length === 0) { fileListEl.innerHTML = ''; return; }
        fileListEl.innerHTML = uploadItems.map(function (it) {
            var icon, text, color;
            if (it.status === 'done') { icon = 'fa-check-circle'; text = 'Uploaded'; color = '#3fb950'; }
            else if (it.status === 'failed') { icon = 'fa-times-circle'; text = 'Upload failed'; color = '#e5484d'; }
            else { icon = 'fa-spinner fa-spin'; text = 'Uploading ' + (it.pct || 0) + '%'; color = 'inherit'; }
            return '<div style="display:flex;gap:6px;align-items:center;margin-top:4px;color:' + color + '">' +
                '<i class="fas ' + icon + '"></i><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
                escapeText(it.name) + ' &mdash; ' + text + '</span></div>';
        }).join('');
        updateSubmitState();
    }

    function updateSubmitState() {
        if (!btnSubmit || busy) return;
        if (pendingUploads > 0) {
            btnSubmit.disabled = true;
            btnSubmit.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading attachments...';
        } else {
            btnSubmit.disabled = false;
            btnSubmit.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Ticket';
        }
    }

    // Cloudinary-safe unique public_id (same approach as js/owner-ticket-form.js),
    // so two files with the same base name never overwrite each other.
    function makeUniquePublicId(fileName) {
        var dotIdx = String(fileName || '').lastIndexOf('.');
        var base = dotIdx > 0 ? String(fileName).slice(0, dotIdx) : String(fileName);
        var safeBase = base.replace(/[^A-Za-z0-9 _.\\-]/g, ' ').replace(/\s+/g, ' ').trim() || 'file';
        return safeBase + '-' + Math.random().toString(36).slice(2, 10);
    }

    // Uploads one file and records it in the CANONICAL attachment shape that the
    // operator's ticket view reads (secure_url / public_id / name, plus the
    // url / publicId / fileName aliases) — the same shape owner-ticket-form.js writes.
    function uploadToCloudinary(file) {
        var gen = uploadGen;
        var item = { name: file.name, status: 'uploading', pct: 0 };
        uploadItems.push(item);
        pendingUploads++;
        updateFileList();

        function finish(ok) {
            if (gen !== uploadGen) return;
            item.status = ok ? 'done' : 'failed';
            pendingUploads = Math.max(0, pendingUploads - 1);
            updateFileList();
            if (!ok) alert('Upload failed: ' + file.name + '. Please try attaching it again.');
        }

        var data = new FormData();
        data.append('file', file);
        data.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
        data.append('public_id', makeUniquePublicId(file.name));
        var xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD_NAME + '/auto/upload');
        xhr.upload.onprogress = function (e) {
            if (!e.lengthComputable || gen !== uploadGen) return;
            item.pct = Math.min(99, Math.round((e.loaded / e.total) * 100));
            updateFileList();
        };
        xhr.onload = function () {
            if (gen !== uploadGen) return;
            if (xhr.status < 200 || xhr.status >= 300) {
                console.error('[PublicForm] Cloudinary upload failed', xhr.status, xhr.responseText);
                return finish(false);
            }
            try {
                var res = JSON.parse(xhr.responseText);
                uploadedAttachments.push({
                    url: res.secure_url,
                    publicId: res.public_id,
                    fileName: file.name,
                    secure_url: res.secure_url,
                    public_id: res.public_id,
                    name: file.name,
                    resource_type: res.resource_type || '',
                    format: res.format || '',
                    mimeType: file.type || 'application/octet-stream',
                    bytes: file.size,
                    uploadedAt: new Date().toISOString()
                });
                finish(true);
            } catch (err) {
                console.error('[PublicForm] Could not parse Cloudinary response', err);
                finish(false);
            }
        };
        xhr.onerror = function () { finish(false); };
        xhr.send(data);
    }

    function clearUploads() {
        uploadGen++;
        uploadedAttachments = [];
        uploadItems = [];
        pendingUploads = 0;
        updateFileList();
        updateSubmitState();
    }
    var fileInput = document.getElementById('publicAttachments');
    if (fileInput) {
        fileInput.addEventListener('change', function () {
            var files = fileInput.files;
            if (!files || files.length === 0) return;
            for (var i = 0; i < files.length; i++) {
                var f = files[i];
                if (f.size > MAX_ATTACHMENT_SIZE_MB * 1024 * 1024) {
                    alert('File too large: ' + f.name + ' (max ' + MAX_ATTACHMENT_SIZE_MB + ' MB)');
                    continue;
                }
                uploadToCloudinary(f);
            }
        });
    }
    if (publicForm) {
        publicForm.addEventListener('submit', function (e) {
            e.preventDefault();
            if (busy) return;
            if (pendingUploads > 0) {
                alert('Please wait — attachments are still uploading.');
                return;
            }
            var nameEl = document.getElementById('publicName');
            var positionEl = document.getElementById('publicPosition');
            var emailEl = document.getElementById('publicEmail');
            var contactEl = document.getElementById('publicContact');
            var datetimeEl = document.getElementById('publicDatetime');
            var locationEl = document.getElementById('publicLocation');
            var incidentEl = document.getElementById('publicIncident');
            var descriptionEl = document.getElementById('publicDescription');
            var requiredFields = [
                [nameEl, 'Name of Reporter'], [positionEl, 'Position'], [emailEl, 'Email'],
                [contactEl, 'Contact Number'], [datetimeEl, 'Incident Date & Time'],
                [locationEl, 'Location'], [incidentEl, 'Incident'], [descriptionEl, 'Full Description']
            ];
            var missing = requiredFields.filter(function (f) { return !f[0] || !String(f[0].value || '').trim(); });
            requiredFields.forEach(function (f) { if (f[0]) f[0].classList.remove('field-missing'); });
            if (missing.length) {
                missing.forEach(function (f) {
                    if (!f[0]) return;
                    f[0].classList.add('field-missing');
                    f[0].addEventListener('input', function clear() {
                        f[0].classList.remove('field-missing');
                        f[0].removeEventListener('input', clear);
                    });
                });
                alert('Please fill in: ' + missing.map(function (f) { return f[1]; }).join(', '));
                var first = missing[0][0];
                if (first) {
                    try { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {}
                    first.focus();
                }
                return;
            }
            setBusy(true);
            var payload = {
                branch: 'Head office',
                priority: document.getElementById('publicPriority').value,
                name: nameEl.value.trim(),
                position: positionEl.value.trim(),
                email: emailEl.value.trim(),
                contact: contactEl.value.trim(),
                datetime: datetimeEl.value,
                location: locationEl.value.trim(),
                incident: incidentEl.value.trim(),
                description: descriptionEl.value.trim(),
                attachments: uploadedAttachments.slice(),
                requesterAttachments: uploadedAttachments.slice(),
                status: 'Pending',
                approvalStatus: 'pending',
                filedByRole: 'public',
                createdAt: (typeof firebase !== 'undefined' && firebase.firestore)
                    ? firebase.firestore.FieldValue.serverTimestamp()
                    : new Date().toISOString(),
                submittedAt: new Date().toISOString()
            };
            firestoreService.generateTicketNumber('Head office')
                .then(function (ticketNumber) {
                    payload.ticketNumber = ticketNumber;
                    return db.collection('tickets').doc(ticketNumber).set(payload);
                })
                .then(function () {
                    setBusy(false);
                    if (ticketNumberEl) ticketNumberEl.textContent = payload.ticketNumber;
                    publicForm.reset();
                    clearUploads();
                    if (successModal) successModal.style.display = 'flex';
                    if (fileInput) fileInput.value = '';
                })
                .catch(function (err) {
                    console.error('[PublicForm] Submit error', err);
                    setBusy(false);
                    alert('Could not submit the ticket. Please try again.');
                });
        });
    }
    if (btnReset) btnReset.addEventListener('click', function () {
        publicForm.reset();
        publicForm.querySelectorAll('.field-missing').forEach(function (el) { el.classList.remove('field-missing'); });
        clearUploads();
        if (fileInput) fileInput.value = '';
    });
})();