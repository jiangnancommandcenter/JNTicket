/**
 * Command Palette + Global Keyboard Shortcuts
 * (js/command-palette.js)
 *
 * One keyboard-first entry point for the app: Ctrl/Cmd+K opens a searchable
 * command list, plus a small set of global shortcuts.
 *
 * Design rules this file follows, all taken from the existing codebase:
 *  - It REUSES the app's `.modal-overlay` / `.modal-container` markup, so the
 *    palette inherits the light/dark theme for free (same trick the chat modal
 *    uses at js/chat.js:271).
 *  - Every rendered string is escaped. Command labels include user data
 *    (branch names, ticket subjects), so this is an XSS boundary.
 *  - It never offers a command the signed-in role cannot actually run — the
 *    list is filtered against the same DOM visibility the sidebar uses, so a
 *    non-superadmin never sees "Ticket Reviews" offered and then refused.
 *  - It is loaded LAST on the page and every global lookup is guarded, so a
 *    page without a sidebar simply gets fewer commands rather than a broken
 *    palette.
 */
(function () {
    'use strict';

    function isTypingTarget(el) {
        if (!el) return false;
        if (el.isContentEditable) return true;
        var tag = (el.tagName || '').toLowerCase();
        return tag === 'input' || tag === 'textarea' || tag === 'select';
    }

    function escapeText(value) {
        var el = document.createElement('div');
        el.textContent = String(value === null || value === undefined ? '' : value);
        return el.innerHTML;
    }

    function esc(value) {
        if (typeof window.escapeHTML === 'function') {
            try { return window.escapeHTML(value); } catch (e) { /* fall through */ }
        }
        return escapeText(value);
    }

    function visible(el) {
        if (!el) return false;
        if (el.hidden) return false;
        if (getComputedStyle(el).display === 'none') return false;
        return true;
    }

    function focusElement(el) {
        if (!el) return;
        el.focus();
        // Select existing text so typing replaces it rather than appending.
        if (typeof el.select === 'function') {
            try { el.select(); } catch (e) { /* ignore */ }
        }
    }


    function buildCommands() {
        var commands = [];

        // --- Navigation: mirror the sidebar, honouring its visibility ---
        var navItems = document.querySelectorAll('.nav-item[data-tab]');
        Array.prototype.forEach.call(navItems, function (item) {
            if (!visible(item)) return;               // role-gated items stay hidden
            var tabId = item.getAttribute('data-tab');
            var labelEl = item.querySelector('span:not(.badge)');
            var label = labelEl ? labelEl.textContent.trim() : tabId;
            var iconEl = item.querySelector('i');
            commands.push({
                id: 'nav:' + tabId,
                group: 'Go to',
                label: label,
                icon: iconEl ? iconEl.className : 'fas fa-circle',
                hint: 'Switch tab',
                keywords: tabId + ' ' + label,
                run: function () {
                    if (typeof window.switchTab === 'function') return window.switchTab(tabId);
                }
            });
        });

        // --- Focus a search box on the current tab ---
        // Only the VISIBLE tab's search box is offered; focusing a hidden input
        // would silently do nothing.
        var activeTab = document.querySelector('.tab-content.active');
        if (activeTab) {
            var searchBox = activeTab.querySelector('.search-box input[type="text"]');
            if (searchBox && !searchBox.disabled) {
                commands.push({
                    id: 'focus-search',
                    group: 'Go to',
                    label: 'Search this page',
                    icon: 'fas fa-magnifying-glass',
                    hint: 'Focus the search box',
                    keywords: 'search filter find ' + (searchBox.placeholder || ''),
                    run: function () { focusElement(searchBox); }
                });
            }
        }

        // --- Primary actions ---
        var addStatus = document.getElementById('btnAddStatus');
        if (addStatus && visible(addStatus)) {
            commands.push({
                id: 'add-status',
                group: 'Create',
                label: 'Add branch status update',
                icon: 'fas fa-plus-circle',
                hint: 'New status',
                keywords: 'add status update online offline branch',
                run: function () { addStatus.click(); }
            });
        }

        var newViolation = document.getElementById('btnNewViolation');
        if (newViolation && visible(newViolation)) {
            commands.push({
                id: 'new-violation',
                group: 'Create',
                label: 'Report a violation',
                icon: 'fas fa-video',
                hint: 'New report',
                keywords: 'violation report cctv new',
                run: function () { newViolation.click(); }
            });
        }

        // --- Appearance ---
        commands.push({
            id: 'toggle-theme',
            group: 'View',
            label: 'Toggle light / dark mode',
            icon: 'fas fa-circle-half-stroke',
            hint: 'Appearance',
            keywords: 'theme dark light mode appearance night',
            run: function () {
                if (window.ThemeManager) window.ThemeManager.toggle();
            }
        });

        // --- Session ---
        var logout = document.getElementById('logoutBtn')
            || document.getElementById('ownerLogoutBtn')
            || document.getElementById('pendingLogoutBtn');
        if (logout && visible(logout)) {
            commands.push({
                id: 'logout',
                group: 'Account',
                label: 'Sign out',
                icon: 'fas fa-sign-out-alt',
                hint: 'Account',
                keywords: 'logout log out sign out exit',
                run: function () { logout.click(); }
            });
        }

        // --- Meta ---
        commands.push({
            id: 'shortcuts',
            group: 'Help',
            label: 'Keyboard shortcuts',
            icon: 'fas fa-keyboard',
            hint: 'Press ? anytime',
            keywords: 'keyboard shortcuts help hotkeys',
            run: function () { openShortcuts(); }
        });

        // The tour is once-only, so without this there is no way back to it
        // once dismissed. Gated on the same sidebar check it uses internally.
        if (window.Onboarding && document.querySelector('.sidebar-nav')) {
            commands.push({
                id: 'replay-tour',
                group: 'Help',
                label: 'Replay the quick tour',
                icon: 'fas fa-circle-info',
                hint: '3 steps',
                keywords: 'tour help guide introduction onboarding walkthrough',
                run: function () { window.Onboarding.start(); }
            });
        }

        return commands;
    }

    var state = {
        open: false,
        commands: [],
        filtered: [],
        index: 0,
        lastFocus: null
    };

    var els = {};

    function buildUI() {
        if (els.overlay) return;

        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay cmd-palette-overlay';
        overlay.id = 'cmdPalette';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Command palette');

        var field = document.createElement('div');
        field.className = 'cmd-palette-field';
        field.innerHTML = '<i class="fas fa-magnifying-glass cmd-palette-field-icon" aria-hidden="true"></i>';

        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'cmd-palette-input';
        input.id = 'cmdPaletteInput';
        input.placeholder = 'Search commands, tabs, actions…';
        input.setAttribute('aria-label', 'Search commands');
        // Combobox pattern: the listbox below is owned by this input, and
        // aria-activedescendant (not focus) moves the selection, so arrow keys
        // never move DOM focus out of the text field.
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-expanded', 'true');
        input.setAttribute('aria-controls', 'cmdPaletteList');
        input.setAttribute('aria-autocomplete', 'list');
        input.autocomplete = 'off';
        field.appendChild(input);

        var list = document.createElement('div');
        list.className = 'cmd-palette-list';
        list.id = 'cmdPaletteList';
        list.setAttribute('role', 'listbox');

        var footer = document.createElement('div');
        footer.className = 'cmd-palette-footer';
        footer.innerHTML =
            '<span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>' +
            '<span><kbd>Enter</kbd> run</span>' +
            '<span><kbd>Esc</kbd> close</span>';

        var container = document.createElement('div');
        container.className = 'modal-container cmd-palette-container';
        container.appendChild(field);
        container.appendChild(list);
        container.appendChild(footer);

        overlay.appendChild(container);
        document.body.appendChild(overlay);

        els.overlay = overlay;
        els.input = input;
        els.list = list;

        input.addEventListener('input', function () {
            state.index = 0;
            render();
        });

        // Keyboard handling lives on the overlay, so it cannot fire while the
        // palette is closed.
        overlay.addEventListener('keydown', function (event) {
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                moveSelection(1);
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                moveSelection(-1);
            } else if (event.key === 'Enter') {
                event.preventDefault();
                runSelected();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closePalette();
            } else if (event.key === 'Tab') {
                // The palette is one control (input + listbox); there is nowhere
                // useful for Tab to go, so trap it rather than escaping to the
                // page behind the dialog.
                event.preventDefault();
            }
        });

        // Click the dimmer to dismiss. mousedown (not click) so it does not
        // fight a drag that starts inside the dialog and ends on the overlay.
        overlay.addEventListener('mousedown', function (event) {
            if (event.target === overlay) closePalette();
        });

        list.addEventListener('click', function (event) {
            var row = event.target.closest('.cmd-palette-item');
            if (!row) return;
            var idx = Number(row.getAttribute('data-index'));
            if (!isNaN(idx)) { state.index = idx; runSelected(); }
        });

        // Hover moves the selection so mouse and keyboard never disagree.
        list.addEventListener('mousemove', function (event) {
            var row = event.target.closest('.cmd-palette-item');
            if (!row) return;
            var idx = Number(row.getAttribute('data-index'));
            if (!isNaN(idx) && idx !== state.index) {
                state.index = idx;
                paintSelection();
            }
        });
    }

    function fuzzyMatch(haystack, needle) {
        if (!needle) return true;
        var h = String(haystack || '').toLowerCase();
        var n = needle.toLowerCase();
        if (h.indexOf(n) > -1) return true;
        var hi = 0;
        for (var i = 0; i < n.length; i++) {
            hi = h.indexOf(n[i], hi);
            if (hi === -1) return false;
            hi++;
        }
        return true;
    }

    function filterCommands(query) {
        var q = String(query || '').trim();
        if (!q) return state.commands.slice();
        return state.commands.filter(function (cmd) {
            return fuzzyMatch(cmd.label + ' ' + cmd.keywords + ' ' + cmd.group, q);
        });
    }

    function render() {
        state.filtered = filterCommands(els.input.value);
        state.index = 0;

        if (!state.filtered.length) {
            // An empty result must SAY so — a blank list reads as a broken
            // palette rather than "nothing matched".
            els.list.innerHTML =
                '<div class="cmd-palette-empty">' +
                '<i class="fas fa-inbox" aria-hidden="true"></i>' +
                '<p>No matching commands</p>' +
                '</div>';
            els.input.setAttribute('aria-activedescendant', '');
            return;
        }

        // Group headings, in the order buildCommands() produced them.
        var html = '';
        var lastGroup = null;
        state.filtered.forEach(function (cmd, i) {
            if (cmd.group !== lastGroup) {
                html += '<div class="cmd-palette-group" role="presentation">'
                    + esc(cmd.group) + '</div>';
                lastGroup = cmd.group;
            }
            html +=
                '<div class="cmd-palette-item" role="option" id="cmdPaletteItem' + i + '"' +
                ' data-index="' + i + '" aria-selected="false">' +
                    '<i class="' + esc(cmd.icon) + '" aria-hidden="true"></i>' +
                    '<span class="cmd-palette-label">' + esc(cmd.label) + '</span>' +
                    (cmd.hint ? '<span class="cmd-palette-hint">' + esc(cmd.hint) + '</span>' : '') +
                '</div>';
        });
        els.list.innerHTML = html;
        paintSelection();
    }

    function paintSelection() {
        var rows = els.list.querySelectorAll('.cmd-palette-item');
        Array.prototype.forEach.call(rows, function (row, i) {
            var active = i === state.index;
            row.classList.toggle('active', active);
            row.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        var active = rows[state.index];
        if (active && typeof active.scrollIntoView === 'function') {
            // block:'nearest' scrolls the list only, never the page behind.
            try { active.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
        }
        els.input.setAttribute('aria-activedescendant', 'cmdPaletteItem' + state.index);
    }

    function moveSelection(delta) {
        if (!state.filtered.length) return;
        var next = state.index + delta;
        if (next < 0) next = state.filtered.length - 1;
        if (next >= state.filtered.length) next = 0;
        state.index = next;
        paintSelection();
    }

    function runSelected() {
        var cmd = state.filtered[state.index];
        // Close BEFORE running: a command that opens a modal (Add Status) must
        // not end up behind the palette we are about to hide.
        closePalette();
        if (cmd && typeof cmd.run === 'function') {
            try { cmd.run(); } catch (e) { console.warn('Command failed:', e); }
        }
    }

    function openPalette() {
        if (state.open) return;
        buildUI();
        // Remember focus so Escape returns the user exactly where they were.
        state.lastFocus = document.activeElement;
        state.open = true;
        // Rebuilt on every open so a role change or a tab that appeared since
        // last time is reflected immediately.
        state.commands = buildCommands();
        els.input.value = '';
        render();
        els.overlay.classList.add('active');
        els.input.focus();
    }

    function closePalette() {
        if (!state.open || !els.overlay) return;
        state.open = false;
        els.overlay.classList.remove('active');
        var back = state.lastFocus;
        state.lastFocus = null;
        if (back && typeof back.focus === 'function' && back.isConnected) {
            try { back.focus(); } catch (e) { /* ignore */ }
        }
    }

    var SHORTCUT_ROWS = [
        ['Ctrl / Cmd + K', 'Open the command palette'],
        ['1 – 8', 'Jump to a tab (sidebar order)'],
        ['/', 'Focus the search box on this tab'],
        ['?', 'Show this shortcut list'],
        ['Esc', 'Close any dialog or overlay']
    ];

    function openShortcuts() {
        if (els.shortcutsOverlay) { closeShortcuts(); return; }

        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay cmd-palette-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'Keyboard shortcuts');

        var container = document.createElement('div');
        container.className = 'modal-container cmd-palette-container cmd-shortcuts-container';
        container.setAttribute('tabindex', '-1');
        container.innerHTML =
            '<div class="cmd-palette-field-static">' +
                '<i class="fas fa-keyboard" aria-hidden="true"></i>' +
                '<span>Keyboard shortcuts</span>' +
            '</div>' +
            '<div class="cmd-shortcuts-list">' +
            SHORTCUT_ROWS.map(function (row) {
                return '<div class="cmd-shortcut-row">' +
                    '<kbd class="cmd-shortcut-key">' + esc(row[0]) + '</kbd>' +
                    '<span class="cmd-shortcut-desc">' + esc(row[1]) + '</span>' +
                '</div>';
            }).join('') +
            '</div>' +
            '<div class="cmd-palette-footer">' +
                '<span>Press <kbd>Esc</kbd> or click outside to close</span>' +
            '</div>';

        overlay.appendChild(container);
        document.body.appendChild(overlay);
        els.shortcutsOverlay = overlay;

        overlay.addEventListener('click', function (event) {
            if (event.target === overlay) closeShortcuts();
        });
        // Focus the dialog itself so Escape is caught even though there is no
        // text field in it.
        container.focus();
    }

    function closeShortcuts() {
        if (els.shortcutsOverlay) {
            els.shortcutsOverlay.remove();
            els.shortcutsOverlay = null;
        }
    }

    function visibleTabs() {
        return Array.prototype.filter.call(
            document.querySelectorAll('.nav-item[data-tab]'),
            visible
        );
    }

    function onKeyDown(event) {
        if (!event) return;

        // Ctrl/Cmd+K toggles the palette from anywhere, including inside a text
        // field. Every OTHER modified key is left to the browser.
        if (event.ctrlKey || event.metaKey) {
            if (String(event.key).toLowerCase() === 'k') {
                event.preventDefault();
                if (state.open) closePalette(); else openPalette();
            }
            return;
        }
        if (event.altKey) return;

        if (event.key === 'Escape') {
            // Only the overlays this module owns. When neither is open we fall
            // through so the chat / rename / attachment handlers still get it.
            if (els.shortcutsOverlay) { closeShortcuts(); return; }
            if (state.open) { closePalette(); return; }
            return;
        }

        // The palette owns the keyboard while it is up — otherwise typing "t"
        // into its search box would toggle the theme underneath it.
        if (state.open || els.shortcutsOverlay) return;

        // Never hijack a key the user is using to type.
        if (isTypingTarget(event.target)) return;

        // A dialog is open behind us: single-letter shortcuts would fire
        // invisibly underneath it.
        if (event.target && event.target.closest
            && event.target.closest('.modal-overlay.active')) {
            return;
        }

        // ? is Shift+/
        if (event.key === '?') {
            event.preventDefault();
            openShortcuts();
            return;
        }

        // / — focus the current tab's search box
        if (event.key === '/') {
            var activeTab = document.querySelector('.tab-content.active');
            var searchBox = activeTab
                && activeTab.querySelector('.search-box input[type="text"]');
            if (searchBox) {
                event.preventDefault();
                focusElement(searchBox);
            }
            return;
        }

        // ⚠️ NO BARE-LETTER SHORTCUT FOR THE THEME. There used to be one: pressing
        // "t" anywhere on the page toggled light/dark. It was removed because a
        // single letter that fires with no modifier hijacks ordinary activity —
        // after clicking a table row or any non-input element, focus sits on
        // that element (NOT a text field), so the "am I typing?" guard could
        // not see it and the next "t" silently flipped the whole app's
        // appearance.
        //
        // The theme is still one keystroke away, deliberately: Ctrl/Cmd+K then
        // "theme" in the palette (the `toggle-theme` command), or the moon
        // button in the header. Both are EXPLICIT — nothing happens by
        // accident.
        //
        // Do not reintroduce a bare letter here. `/` and `1`–`8` survive
        // because they cannot be part of a word and cannot fire mid-typing.

        // 1–8 — jump to the nth VISIBLE tab, so the number always matches what
        // the user sees in the sidebar. An operator has 5 tabs, so 6-8 do
        // nothing rather than opening a superadmin-only page.
        if (/^[1-8]$/.test(event.key)) {
            var items = visibleTabs();
            var target = items[Number(event.key) - 1];
            if (!target) return;
            event.preventDefault();
            if (typeof window.switchTab === 'function') {
                window.switchTab(target.getAttribute('data-tab'));
            }
        }
    }

    function init() {
        // Capture phase so the palette wins over the per-feature document-level
        // Escape handlers in chat.js / script.js when both are open.
        document.addEventListener('keydown', onKeyDown, true);

        // A visible entry point in the header so the palette is discoverable
        // without knowing the shortcut exists. Injected next to the existing
        // theme toggle rather than hardcoded into the markup, so it cannot
        // drift out of sync with the header layout.
        var actions = document.querySelector('.header-actions');
        if (actions && !document.getElementById('cmdPaletteBtn')) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'icon-btn cmd-palette-btn';
            btn.id = 'cmdPaletteBtn';
            btn.setAttribute('aria-label', 'Open command palette');
            btn.setAttribute('aria-haspopup', 'dialog');
            btn.title = 'Command palette (Ctrl+K)';
            btn.innerHTML = '<i class="fas fa-magnifying-glass" aria-hidden="true"></i>';
            btn.addEventListener('click', function () { openPalette(); });
            actions.appendChild(btn);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.CommandPalette = {
        open: openPalette,
        close: closePalette,
        isOpen: function () { return state.open; },
        commands: buildCommands,
        shortcuts: SHORTCUT_ROWS,
        fuzzyMatch: fuzzyMatch,
        isTypingTarget: isTypingTarget,
        handleKey: onKeyDown
    };
})();
