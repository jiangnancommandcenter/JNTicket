/**
 * ==============================================================
 *  HR COORDINATION REMARKS  (the "NOV status" shared note)
 *
 *  Several HR staff share the same transferred-violation and ticket
 *  queues, and each of them issues NOVs (Notices of Violation) to the
 *  violators. Nothing on the report says whether a colleague has already
 *  actioned one, so two people can issue the same NOV — or, worse, nobody
 *  does because each assumes someone else has.
 *
 *  This is a free-text "note to the other HR" attached to a single ticket
 *  or violation. Every note records WHO wrote it and WHEN, automatically,
 *  so the team can read the running history at a glance:
 *
 *      [Maria]  Oct 10, 3:42 PM   NOV issued to the store, receipt scanned.
 *      [Juan]   Oct 11, 9:05 AM   Follow-up call done, awaiting signature.
 *
 *  ⚠️ WHY A SEPARATE `remarks` COLLECTION, NOT A FIELD ON THE DOC.
 *  Violations are DELIBERATELY read-only for HR — firestore.rules gives the
 *  `hr` role no write on `violations` at all, and test/violation-hr-transfer.test.js
 *  hard-asserts js/hr-violations.js never calls a violation write. Storing
 *  the note on the report would break both. So the note lives in its own
 *  append-only log, keyed by `targetKey` ('tickets/<id>' | 'violations/<id>'),
 *  and the report document is never touched.
 *
 *  APPEND-ONLY: the rules allow create and read for HR/superadmin and allow
 *  NO update or delete, so the history is a trustworthy record rather than
 *  something a later note can quietly rewrite.
 *
 *  ⚠️ NO COMPOSITE INDEX. The read is `where('targetKey','==',key)` with the
 *  ordering done HERE in JS. Pairing that equality with an `orderBy` on a
 *  different field would need a composite index, which the free Firestore
 *  plan does not auto-create (the same trap test/chat-rules.test.js guards
 *  the conversation list against). A single equality filter needs only the
 *  automatic single-field index.
 * ==============================================================
 */
(function () {
    'use strict';

    var els = {};
    var unsub = null;      // the live listener for the open target
    var currentKey = '';   // 'tickets/<id>' | 'violations/<id>'

    // ===== Presence tracker =====
    // ONE collection-wide listener (HR/superadmin may read every remark per the
    // rules) that records which targetKey already has at least one note. The
    // ticket and violation rows use this to flag their sticky-note button red,
    // so HR can see at a glance which items already carry a note instead of
    // opening each one. Read-only; it never writes.
    var notedKeys = new Set();
    var presenceUnsub = null;

    /** True when `key` already has ≥1 remark. */
    function hasNote(key) {
        return notedKeys.has(String(key || ''));
    }

    /** Toggle the red `has-remarks` flag on every remarks button on the page. */
    function paintPresence() {
        var btns;
        try { btns = document.querySelectorAll('[data-remarks-key]'); } catch (e) { return; }
        for (var i = 0; i < btns.length; i++) {
            var key = btns[i].getAttribute('data-remarks-key');
            if (hasNote(key)) btns[i].classList.add('has-remarks');
            else btns[i].classList.remove('has-remarks');
        }
    }

    /** Start the single collection-wide presence listener (idempotent). */
    function watchPresence() {
        if (presenceUnsub) return;
        if (!window.db || typeof window.db.collection !== 'function') return;
        try {
            presenceUnsub = window.db.collection('remarks').onSnapshot(function (snap) {
                notedKeys = new Set();
                snap.forEach(function (doc) {
                    var k = doc.data() && doc.data().targetKey;
                    if (k) notedKeys.add(String(k));
                });
                paintPresence();
            }, function (err) {
                // A permission error here is harmless: the buttons simply stay
                // neutral. Never surface it — it is not the user's problem.
                console.warn('Remarks presence listener stopped:', err && err.message);
            });
        } catch (e) { /* listener unavailable — flags just stay off */ }
    }

    function esc(value) {
        if (typeof window.escapeHTML === 'function') return window.escapeHTML(value);
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function toast(message, type) {
        if (typeof window.showToast === 'function') window.showToast(message, type || 'info');
    }

    function fieldValue() {
        var fs = window.firebase && window.firebase.firestore;
        return fs && fs.FieldValue ? fs.FieldValue.serverTimestamp() : new Date();
    }

    /** The signed-in address, lowercased — the same normalisation the rules use. */
    function selfEmail() {
        var user = window.auth && window.auth.currentUser;
        var email = user && user.email ? String(user.email) : '';
        if (window.normalizeUserEmail) return window.normalizeUserEmail(email);
        return email.trim().toLowerCase();
    }

    function fmtWhen(value) {
        if (!value) return '';
        var d = (value && typeof value.toDate === 'function') ? value.toDate() : new Date(value);
        if (isNaN(d.getTime())) return '';
        try {
            return d.toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        } catch (e) {
            return d.toISOString();
        }
    }

    /** Two initials, e.g. "MS" for "Maria Santos". */
    function initialsOf(name) {
        var parts = String(name || '').trim().split(/\s+/);
        if (!parts.length) return '';
        var first = parts[0].charAt(0).toUpperCase();
        var last = parts.length > 1 ? parts[parts.length - 1].charAt(0).toUpperCase() : first;
        return first + last;
    }

    /** Deterministic accent color, keyed by the writer's name so the same
     * person always gets the same tone across sessions (no network). */
    function avatarToneOf(name) {
        var hash = 0;
        for (var i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i);
        hash = hash & 0x7fffffff;
        var tones = ['#16a34a', '#dc2626', '#f59e0b', '#8b5cf6', '#6366f1', '#0ea5e9'];
        return tones[hash % tones.length];
    }

    /** "just now", "5m ago", "2d ago", ... */
    function fmtRelative(value) {
        if (!value) return '';
        var d = (value && typeof value.toDate === 'function') ? value.toDate() : new Date(value);
        if (isNaN(d.getTime())) return '';
        var now = new Date();
        var diff = now.getTime() - d.getTime();
        var min = Math.floor(diff / 60000);
        if (min < 1) return 'just now';
        if (min < 60) return min + 'm ago';
        var hr = Math.floor(min / 60);
        if (hr < 24) return hr + 'h ago';
        var day = Math.floor(hr / 24);
        if (day < 7) return day + 'd ago';
        return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
    }

    /** "Today", "Yesterday", "Oct 10, 2024" */
    function fmtDayLabel(value) {
        if (!value) return '';
        var d = (value && typeof value.toDate === 'function') ? value.toDate() : new Date(value);
        if (isNaN(d.getTime())) return '';
        var today = new Date();
        var dm = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
        if (dm) return 'Today';
        var yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
        var dy = d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate();
        if (dy) return 'Yesterday';
        return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
    }

    /** Scroll the log down to the newest note. No-op in non-DOM contexts. */
    function autoscroll() {
        var list = els.list;
        if (!list || typeof list.scrollTo !== 'function' || !window.matchMedia) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            list.scrollTop = list.scrollHeight;
        } else {
            list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
        }
    }

    /** Build the modal once and cache its nodes. Reuses the shared modal CSS. */
    function build() {
        if (els.overlay) return;
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.id = 'remarksModal';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'remarksModalTitle');
        overlay.innerHTML =
            '<div class="modal-container remarks-modal">' +
              '<div class="modal-header remarks-header">' +
                '<div class="remarks-title-group">' +
                  '<span class="remarks-icon" aria-hidden="true"><i class="fas fa-comments"></i></span>' +
                  '<div class="remarks-title-text">' +
                    '<h2 id="remarksModalTitle"><span id="remarksTitleLabel">Remarks</span><span class="remarks-count" id="remarksCount" hidden></span></h2>' +
                    '<p class="u-section-sub remarks-subject" id="remarksSubject" style="margin:0;"></p>' +
                  '</div>' +
                '</div>' +
                '<button type="button" class="modal-close" id="remarksModalClose" aria-label="Close">&times;</button>' +
              '</div>' +
              '<div class="modal-body remarks-body">' +
                '<div id="remarksList" class="remarks-list" role="log" aria-live="polite" aria-label="Shared remarks">' +
                  '<p class="u-section-sub">Loading&hellip;</p>' +
                '</div>' +
                '<div class="remarks-compose">' +
                  '<div class="remarks-compose-head">' + '<label for="remarksInput">Add a remark</label>' + '<span class="remarks-visibility"><i class="fas fa-lock" aria-hidden="true"></i>HR team only</span>' + '</div>' +
                  '<div class="remarks-input-row">' +
                    '<textarea id="remarksInput" rows="2" maxlength="2000" ' +
                      'placeholder="e.g. NOV issued to the store on Oct 10, receipt scanned&hellip;"></textarea>' +
                    '<button type="button" class="btn btn-primary btn-sm remarks-send" id="remarksSaveBtn">' +
                      '<i class="fas fa-paper-plane" aria-hidden="true"></i><span>Post Remark</span></button>' +
                  '</div>' +
                  '<div class="remarks-compose-bottom">' +
                    '<span class="remarks-counter" id="remarksCounter" aria-live="off">0/2000</span>' +
                    '<span class="remarks-posting"><span class="remarks-presence" aria-hidden="true"></span><span id="remarksPosting">Posting as ' + (selfEmail() || 'HR Staff') + '</span></span>' +
                    '<div class="remarks-compose-actions">' +
                      '<span class="remarks-hint">Name &amp; date added automatically · <kbd>Ctrl</kbd>+<kbd>Enter</kbd> to send</span>' +
                    '</div>' +
                  '</div>' +
                '</div>' +
              '</div>' +
            '</div>';
        document.body.appendChild(overlay);

        els.overlay = overlay;
        els.titleLabel = overlay.querySelector('#remarksTitleLabel');
        els.count = overlay.querySelector('#remarksCount');
        els.subject = overlay.querySelector('#remarksSubject');
        els.list = overlay.querySelector('#remarksList');
        els.input = overlay.querySelector('#remarksInput');
        els.save = overlay.querySelector('#remarksSaveBtn');
        els.counter = overlay.querySelector('#remarksCounter');
        els.posting = overlay.querySelector('#remarksPosting');

        overlay.querySelector('#remarksModalClose').addEventListener('click', close);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
        els.save.addEventListener('click', submit);
        els.input.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
        });
        els.input.addEventListener('input', function () {
            if (els.counter) els.counter.textContent = els.input.value.length + '/2000';
        });
        // Esc closes, only while this modal is the open one.
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && els.overlay && els.overlay.classList.contains('active')) close();
        });
    }

    function renderList(rows) {
        if (!els.list) return;
        if (!rows.length) {
            if (els.count) { els.count.hidden = true; els.count.textContent = ''; }
            els.list.innerHTML = '<div class="remarks-empty"><span class="remarks-empty-icon" aria-hidden="true"><i class="fas fa-comments"></i></span><strong>No remarks yet</strong><span>Be the first to leave a note so the team knows this one is being handled.</span></div>';
            autoscroll();
            return;
        }
        var prevKey = null;
        els.list.innerHTML = rows.map(function (r) {
            var who = esc(r.byName || r.byEmail || 'Unknown');
            var initials = initialsOf(r.byName);
            var tone = avatarToneOf(r.byName);
            var date = (r.createdAt && typeof r.createdAt.toDate === 'function') ? r.createdAt.toDate() : new Date(r.createdAt);
            var text = esc(r.text);
            var when = esc(fmtWhen(r.createdAt));
                        var sep = '';
            if (fmtDayLabel(date) !== fmtDayLabel(prevKey)) {
                sep = '<div class="remarks-day-sep">' + esc(fmtDayLabel(date)) + '</div>';
                prevKey = date;
            }
            var mine = r.byEmail === selfEmail();
            var youBadge = mine ? '<span class="remark-you">You</span>' : '';
            var body =
                '<span class="remark-avatar" style="background:' + tone + '" aria-hidden="true">' + initials + '</span>' +
                '<div class="remark-bubble">' +
                  '<div class="remark-meta">' +
                    '<span class="remark-author">' + who + '</span>' + youBadge +
                    '<span class="remark-time" title="' + fmtRelative(r.createdAt) + '">' + when + '</span>' +
                  '</div>' +
                  '<div class="remark-text">' + text + '</div>' +
                '</div>';
            return sep + '<div class="remark-item' + (mine ? ' remark-item--mine' : '') + '">' + body + '</div>';
        }).join('');
        if (els.count) {
            var label = rows.length === 1 ? '1 note' : rows.length + ' notes';
            els.count.textContent = label;
            els.count.hidden = false;
        }
        autoscroll();
    }


    function stop() {
        if (typeof unsub === 'function') { try { unsub(); } catch (e) { /* ignore */ } }
        unsub = null;
    }

    function listen() {
        stop();
        if (!window.db || typeof window.db.collection !== 'function') {
            if (els.list) els.list.innerHTML = '<p class="u-section-sub">Remarks are unavailable right now.</p>';
            return;
        }
        try {
            unsub = window.db.collection('remarks')
                .where('targetKey', '==', currentKey)
                .onSnapshot(function (snap) {
                    var rows = [];
                    snap.forEach(function (doc) {
                        var data = doc.data() || {};
                        data.id = doc.id;
                        rows.push(data);
                    });
                    // Ordered here, not in the query — see the no-composite-index
                    // note at the top of the file.
                    rows.sort(function (a, b) {
                        var ta = a.createdAt && a.createdAt.toDate ? a.createdAt.toDate().getTime() : 0;
                        var tb = b.createdAt && b.createdAt.toDate ? b.createdAt.toDate().getTime() : 0;
                        return ta - tb;
                    });
                    renderList(rows);
                }, function (err) {
                    console.error('Remarks listener error:', err);
                    if (els.list) els.list.innerHTML = '<p class="u-section-sub">Could not load remarks.</p>';
                });
        } catch (e) {
            console.error('Remarks listen failed:', e);
        }
    }

    async function submit() {
        var text = (els.input.value || '').trim();
        if (!text) { toast('Type a remark first.', 'error'); return; }
        var email = selfEmail();
        if (!email) { toast('You must be signed in to add a remark.', 'error'); return; }
        if (!window.db || typeof window.db.collection !== 'function') {
            toast('Remarks are unavailable right now.', 'error'); return;
        }

        els.save.disabled = true;
        try {
            // byName comes from the writer's own profile so a note reads as a
            // person, not an address; byEmail is what the rules pin to self.
            var name = email;
            try {
                var profile = await window.getUserProfile(email);
                if (profile && profile.name) name = String(profile.name).trim();
            } catch (e) { /* fall back to the email */ }

            await window.db.collection('remarks').add({
                targetKey: currentKey,
                text: text.slice(0, 2000),
                byEmail: email,
                byName: name,
                createdAt: fieldValue()
            });
            els.input.value = '';
            if (els.counter) els.counter.textContent = '0/2000';
            // Mark this target as noted immediately and repaint the row buttons,
            // so the just-used sticky-note turns red without waiting for the
            // collection listener's round-trip.
            notedKeys.add(String(currentKey));
            paintPresence();
            toast('Remark added.', 'success');
        } catch (e) {
            console.error('Failed to save remark:', e);
            toast('Could not save the remark. ' + (e && e.message ? e.message : ''), 'error');
        } finally {
            els.save.disabled = false;
        }
    }

    function open(targetKey, label) {
        build();
        currentKey = String(targetKey || '');
        if (els.titleLabel) els.titleLabel.textContent = 'Remarks — ' + (label || currentKey);
        if (els.subject) els.subject.textContent = label ? ('Shared notes for ' + label) : '';
        if (els.count) { els.count.hidden = true; els.count.textContent = ''; }
        if (els.input) { els.input.value = ''; els.input.disabled = false; }
        if (els.save) els.save.disabled = false;
        if (els.counter) els.counter.textContent = '0/2000';
        if (els.posting) els.posting.textContent = 'Posting as ' + (selfEmail() || 'HR Staff');
        if (els.list) els.list.innerHTML = '<div class="remarks-skeleton" aria-hidden="true"><span></span><span></span><span></span></div>';
        els.overlay.classList.add('active');
        listen();
        autoscroll();
    }

    function close() {
        stop();
        if (els.overlay) els.overlay.classList.remove('active');
        currentKey = '';
    }

    // Public surface. openFromButton reads the key/label off data-* attributes,
    // which keeps the value out of any inline JS string (only the attribute is
    // escaped) and lets one handler serve tickets and violations alike.
    window.Remarks = {
        open: open,
        close: close,
        openFromButton: function (btn) {
            if (!btn) return;
            open(btn.getAttribute('data-remarks-key'), btn.getAttribute('data-remarks-label'));
        },
        hasNote: hasNote,
        // Called by the ticket / violation renderers after they (re)draw rows, so
        // freshly-rendered buttons pick up the red "already has a note" flag.
        paintPresence: paintPresence
    };

    // Start the presence listener as soon as the module loads, so the red flags
    // are live before the first list render (and keep updating as notes land).
    watchPresence();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', build);
    } else {
        build();
    }
})();

