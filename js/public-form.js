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
    function updateFileList() {
        if (!fileListEl) return;
        if (uploadedAttachments.length === 0) { fileListEl.textContent = ''; return; }
        var names = uploadedAttachments.map(function (a) { return a.name || 'Attachment'; }).join(', ');
        fileListEl.textContent = uploadedAttachments.length + ' file(s): ' + names;
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
            var nameEl = document.getElementById('publicName');
            var positionEl = document.getElementById('publicPosition');
            var emailEl = document.getElementById('publicEmail');
            var contactEl = document.getElementById('publicContact');
            var datetimeEl = document.getElementById('publicDatetime');
            var locationEl = document.getElementById('publicLocation');
            var incidentEl = document.getElementById('publicIncident');
            var descriptionEl = document.getElementById('publicDescription');
            if (!nameEl.value.trim() || !positionEl.value.trim() || !emailEl.value.trim() ||
                !contactEl.value.trim() || !datetimeEl.value || !locationEl.value.trim() ||
                !incidentEl.value.trim() || !descriptionEl.value.trim()) {
                alert('Please fill in all required fields.');
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
                attachments: uploadedAttachments,
                requesterAttachments: uploadedAttachments,
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
                    uploadedAttachments = [];
                    updateFileList();
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
        uploadedAttachments = [];
        updateFileList();
        if (fileInput) fileInput.value = '';
    });
})();