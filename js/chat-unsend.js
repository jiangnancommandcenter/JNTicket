/**
 * ==============================================================
 *  UNSEND CONFIRM  (phone-friendly)
 *
 *  The chat's message context menu offers "Unsend" on your OWN
 *  messages only. Unsend is final — it replaces the text with a
 *  muted "Unsent message" — so it asks first. This is a real modal
 *  with big tap targets rather than window.confirm(), which is
 *  tiny, unstyled and easy to mis-tap on a phone.
 *
 *  chat.js calls window.confirmUnsendMessage(id); on confirm it
 *  calls window.ChatService.unsendMessage(id). Loaded AFTER chat.js
 *  so ChatService exists. No Firebase here — the write lives in
 *  chat.js behind the author-only firestore.rules gate.
 * ==============================================================
 */
(function () {
    'use strict';

    var els = {};
    var pendingId = null;

    function esc(value) {
        if (typeof window.escapeHTML === 'function') return window.escapeHTML(value);
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function build() {
        if (els.overlay) return;
        var overlay = document.createElement('div');
        // `modal-overlay` is the BASE class that carries `display:none` (and
        // `.active { display:flex }`) from style.css — WITHOUT it the dialog is
        // visible on page load. `chat-unsend-overlay` only raises the z-index.
        overlay.className = 'modal-overlay chat-unsend-overlay';
        overlay.id = 'chatUnsendConfirm';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'chatUnsendTitle');
        // Hidden by default; .active shows it (same idiom as the chat modal).
        overlay.innerHTML =
            '<div class="chat-unsend-box" role="document">' +
                '<div class="chat-unsend-icon"><i class="fas fa-trash-alt" aria-hidden="true"></i></div>' +
                '<h2 id="chatUnsendTitle" class="chat-unsend-title">Unsend this message?</h2>' +
                '<p class="chat-unsend-body">It will be replaced with &ldquo;Unsent message&rdquo; for everyone. ' +
                    'This can&rsquo;t be undone.</p>' +
                '<div class="chat-unsend-actions">' +
                    '<button type="button" class="chat-unsend-cancel" id="chatUnsendCancel">Cancel</button>' +
                    '<button type="button" class="chat-unsend-confirm" id="chatUnsendConfirmBtn">Unsend</button>' +
                '</div>' +
            '</div>';
        document.body.appendChild(overlay);

        els.overlay = overlay;
        els.cancel = overlay.querySelector('#chatUnsendCancel');
        els.confirm = overlay.querySelector('#chatUnsendConfirmBtn');

        els.cancel.addEventListener('click', close);
        // Tapping the backdrop cancels, like the chat modal.
        overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
        els.confirm.addEventListener('click', function () {
            var id = pendingId;
            close();
            if (id && window.ChatService && typeof window.ChatService.unsendMessage === 'function') {
                window.ChatService.unsendMessage(id);
            }
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && overlay.classList.contains('active')) close();
        });
    }

    function close() {
        pendingId = null;
        if (els.overlay) els.overlay.classList.remove('active');
    }

    function open(messageId) {
        build();
        pendingId = String(messageId || '');
        if (els.overlay) els.overlay.classList.add('active');
        // Move focus to Cancel (the safe choice) for keyboard/AT users.
        try { if (els.cancel) els.cancel.focus(); } catch (e) { /* ignore */ }
    }

    window.confirmUnsendMessage = open;
    window.closeUnsendConfirm = close;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', build);
    } else {
        build();
    }
})();
