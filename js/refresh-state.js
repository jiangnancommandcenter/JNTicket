/**
 * RefreshState — cross-refresh location persistence.
 *
 * Keeps each page's user on the same spot after a refresh (F5 / Ctrl+R) so they
 * are never bounced back to the default dashboard. Works purely with the
 * per-tab `sessionStorage` API, which means:
 *   - state is scoped to the current browser tab,
 *   - it is cleared automatically when the tab is closed,
 *   - it never leaks between tabs, windows, or users.
 *   - Every call is wrapped in try/catch so a blocked storage API never breaks
 *     the rest of the application.
 *
 * Public API (all methods are safe to call even if RefreshState is missing):
 *
 *   RefreshState.capture(name, { tab, modal, id })   // partial merge, drops empties
 *   RefreshState.captureTab(name, tabId)
 *   RefreshState.captureModal(name, modal, id)
 *   RefreshState.restore(name)                       // -> ctx | null
 *   RefreshState.clearModal(name)                    // drop modal/id, keep tab
 *   RefreshState.clearPage(name)
 *   RefreshState.clearAll()                          // only the rcms_ keys
 */
(function () {
    'use strict';

    const PREFIX = 'rcms_'; // refresh-context-management-state

    function canStore() {
        try { return typeof sessionStorage !== 'undefined' && sessionStorage !== null; } catch (e) { return false; }
    }
    function sk(name) { return PREFIX + name; }

    window.RefreshState = {
        capture(name, ctx) {
            if (!canStore() || !name) return null;
            try {
                const prev = window.RefreshState.restore(name) || {};
                const merged = Object.assign(prev, ctx || {});
                Object.keys(merged).forEach((p) => {
                    if (merged[p] === null || merged[p] === undefined || merged[p] === '') {
                        delete merged[p];
                    }
                });
                sessionStorage.setItem(sk(name), JSON.stringify(merged));
                return merged;
            } catch (e) { return null; }
        },
        captureTab(name, tabId) {
            return window.RefreshState.capture(name, { tab: tabId || '' });
        },
        captureModal(name, modal, id) {
            return window.RefreshState.capture(name, { modal: modal || '', id: id || '' });
        },
        restore(name) {
            if (!canStore() || !name) return null;
            try {
                const raw = sessionStorage.getItem(sk(name));
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                return parsed && typeof parsed === 'object' ? parsed : null;
            } catch (e) { return null; }
        },
        clearModal(name) {
            if (!canStore() || !name) return;
            try {
                const ctx = window.RefreshState.restore(name);
                if (ctx) {
                    delete ctx.modal;
                    delete ctx.id;
                    if (ctx.tab) {
                        sessionStorage.setItem(sk(name), JSON.stringify(ctx));
                    } else {
                        sessionStorage.removeItem(sk(name));
                    }
                }
            } catch (e) { /* ignore */ }
        },
        clearPage(name) {
            if (!canStore() || !name) return;
            try { sessionStorage.removeItem(sk(name)); } catch (e) { /* ignore */ }
        },
        clearAll() {
            if (!canStore()) return;
            try {
                Object.keys(sessionStorage)
                    .filter((k) => k.indexOf(PREFIX) === 0)
                    .forEach((k) => sessionStorage.removeItem(k));
            } catch (e) { /* ignore */ }
        }
    };
})();
