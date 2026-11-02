/**
 * Theme Manager (theme.js)
 * Light/dark mode: applies the stored theme, persists changes, and restyles
 * Chart.js instances on change. Safe to include on every page; everything is
 * null-guarded.
 */
(function () {
    'use strict';

    const THEME_KEY = 'rcms_theme';

    // ----- Theme -------------------------------------------------
    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }

    /* Keeps the browser/OS chrome (address bar on mobile, task switcher) in the
       same colour as the app. Dark mode here is opt-in rather than
       prefers-color-scheme-driven, so the meta tag cannot be a static value. */
    const THEME_COLOR = { light: '#72bf6a', dark: '#0B1220' };

    function updateThemeColorMeta() {
        var meta = document.getElementById('themeColorMeta');
        if (meta) meta.setAttribute('content', THEME_COLOR[currentTheme()]);
    }

    function updateToggleIcons() {
        const dark = currentTheme() === 'dark';
        document.querySelectorAll('[data-theme-toggle] i').forEach(function (icon) {
            icon.className = dark ? 'fas fa-sun' : 'fas fa-moon';
        });
        document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
            btn.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
            btn.setAttribute('aria-label', btn.title);
        });
    }

    function restyleCharts() {
        if (!window.Chart || !window.Chart.instances) return;
        try {
            var css = getComputedStyle(document.documentElement);
            var color = css.getPropertyValue('--text-secondary').trim() || '#94A3B8';
            var grid = css.getPropertyValue('--border-color').trim() || '#24334D';
            Object.values(window.Chart.instances).forEach(function (chart) {
                if (!chart || !chart.options) return;
                chart.options.color = color;
                if (chart.options.plugins && chart.options.plugins.legend && chart.options.plugins.legend.labels) {
                    chart.options.plugins.legend.labels.color = color;
                }
                Object.values(chart.options.scales || {}).forEach(function (scale) {
                    if (scale.ticks) scale.ticks.color = color;
                    if (scale.grid) scale.grid.color = grid;
                    if (scale.title) scale.title.color = color;
                });
                chart.update();
            });
        } catch (e) { /* chart restyle is best-effort */ }
    }

    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
        updateToggleIcons();
        updateThemeColorMeta();
        restyleCharts();
        try { window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: theme } })); } catch (e) { /* ignore */ }
    }

    function toggleTheme() {
        applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
    }

    // ----- Bind everything -----------------------------------------
    function init() {
        if (!document.documentElement.getAttribute('data-theme')) {
            var saved = null;
            try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* ignore */ }
            if (!saved) {
                // Default theme is LIGHT. The OS/browser preference is
                // deliberately ignored so a user on a dark-mode machine still
                // lands on the light UI; dark is opt-in via the toggle button.
                saved = 'light';
            }
            document.documentElement.setAttribute('data-theme', saved);
        }
        updateToggleIcons();
        updateThemeColorMeta();

        document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
            btn.addEventListener('click', toggleTheme);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Public API
    window.ThemeManager = {
        get: currentTheme,
        set: applyTheme,
        toggle: toggleTheme
    };
})();
