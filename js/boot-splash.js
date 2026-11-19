/**
 * ==============================================================
 *  BOOT SPLASH — branded loading screen shown while a page loads
 *
 *  Purely ADDITIVE and self-contained: it injects its own <style> and
 *  overlay, listens to Firebase Auth with its OWN listener (js/auth.js is
 *  untouched), and removes itself when the page is ready. Nothing in the
 *  app depends on it; if it fails, the page simply loads as before.
 *
 *  Load it in <head>, right after the inline theme script, so the overlay
 *  is in place before the page body paints.
 *
 *  Per page:
 *    main.html / ownerdashboard.html  "Checking your sign-in..."  — hides
 *        once a user is signed in AND the page has loaded. With no user it
 *        stays up while auth.js redirects to login.html.
 *    login.html                       "Checking your sign-in..."  — on load
 *    pending-approval.html            "Checking your account status..."
 *    anything else (submit-ticket)    "Loading..."
 *
 *  Failsafe: always removed after 10 s, so the app can never be stuck
 *  behind it.
 * ==============================================================
 */
(function () {
    'use strict';

    var page = (String(location.pathname).split('/').pop() || '').toLowerCase();
    var PROTECTED = page === 'main.html' || page === 'ownerdashboard.html';
    var MESSAGE = (PROTECTED || page === 'login.html') ? 'Checking your sign-in...'
        : page === 'pending-approval.html' ? 'Checking your account status...'
        : 'Loading...';

    var MIN_VISIBLE_MS = 400;   // never flash on a fast load
    var FAILSAFE_MS = 10000;    // never block the app
    var startedAt = Date.now();

    var root = document.documentElement;

    function theme() {
        var t = root.getAttribute('data-theme');
        if (!t) { try { t = localStorage.getItem('rcms_theme'); } catch (e) { /* ignore */ } }
        return t === 'light' ? 'light' : 'dark';
    }

    // ---- Style ---------------------------------------------------------
    var css =
        '#bootSplash{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;' +
            'align-items:center;justify-content:center;gap:18px;background:#0e1319;' +
            'transition:opacity .25s ease,visibility .25s ease;opacity:1;visibility:visible;}' +
        'html[data-theme="light"] #bootSplash{background:#f3f4f6;}' +
        '#bootSplash.boot-splash--out{opacity:0;visibility:hidden;}' +
        '#bootSplash .boot-splash-logo{width:132px;height:132px;object-fit:contain;display:block;' +
            'user-select:none;-webkit-user-drag:none;}' +
        '#bootSplash .boot-splash-ring{width:36px;height:36px;border-radius:50%;box-sizing:border-box;' +
            'border:3px solid rgba(229,53,43,.18);border-top-color:#e5352b;' +
            'animation:bootSplashSpin .8s linear infinite;}' +
        'html[data-theme="light"] #bootSplash .boot-splash-ring{border-color:rgba(200,16,46,.12);border-top-color:#c8102e;}' +
        '#bootSplash .boot-splash-text{margin:0;font:400 15px/1.4 Inter,"Segoe UI",system-ui,-apple-system,sans-serif;' +
            'letter-spacing:.01em;color:#9caab7;}' +
        'html[data-theme="light"] #bootSplash .boot-splash-text{color:#6b7280;}' +
        '@keyframes bootSplashSpin{to{transform:rotate(360deg);}}' +
        '@keyframes bootSplashPulse{0%,100%{opacity:.35;}50%{opacity:1;}}' +
        '@media (prefers-reduced-motion:reduce){#bootSplash .boot-splash-ring{' +
            'animation:bootSplashPulse 1.6s ease-in-out infinite;}}' +
        // Keep the page background matching the splash so there is no white flash.
        'html.boot-splash-active{background:#0e1319;}' +
        'html[data-theme="light"].boot-splash-active{background:#f3f4f6;}' +
        'html.boot-splash-active body{overflow:hidden;}';

    try {
        var style = document.createElement('style');
        style.id = 'bootSplashStyle';
        style.textContent = css;
        (document.head || root).appendChild(style);
        root.classList.add('boot-splash-active');
    } catch (e) { return; }

    // ---- Overlay -------------------------------------------------------
    var splash = null;
    var removed = false;

    function build() {
        if (splash || removed || !document.body) return;
        splash = document.createElement('div');
        splash.id = 'bootSplash';
        splash.setAttribute('role', 'status');
        splash.setAttribute('aria-live', 'polite');

        var logo = document.createElement('img');
        logo.className = 'boot-splash-logo';
        logo.alt = 'Jiangnan';
        logo.width = 132;
        logo.height = 132;
        // Same pairing as the login page: the dark-text logo on light backgrounds.
        logo.src = theme() === 'light' ? 'jn-logo-dark.png' : 'jn-logo.png';

        var ring = document.createElement('div');
        ring.className = 'boot-splash-ring';
        ring.setAttribute('aria-hidden', 'true');

        var text = document.createElement('p');
        text.className = 'boot-splash-text';
        text.textContent = MESSAGE;

        splash.appendChild(logo);
        splash.appendChild(ring);
        splash.appendChild(text);
        document.body.insertBefore(splash, document.body.firstChild);
    }

    // Insert the overlay the moment <body> exists (before its content paints).
    if (document.body) {
        build();
    } else {
        try {
            var mo = new MutationObserver(function () {
                if (document.body) { mo.disconnect(); build(); }
            });
            mo.observe(root, { childList: true });
        } catch (e) { /* fall back to DOMContentLoaded below */ }
    }

    function hide() {
        if (removed) return;
        var wait = Math.max(0, MIN_VISIBLE_MS - (Date.now() - startedAt));
        setTimeout(function () {
            if (removed) return;
            removed = true;
            root.classList.remove('boot-splash-active');
            if (!splash) return;
            splash.classList.add('boot-splash--out');
            setTimeout(function () {
                if (splash && splash.parentNode) splash.parentNode.removeChild(splash);
                splash = null;
            }, 300);
        }, wait);
    }

    // ---- When to hide --------------------------------------------------
    var pageReady = false;
    var signedIn = !PROTECTED;   // only the dashboards wait for a user

    function maybeHide() { if (pageReady && signedIn) hide(); }

    function markReady() {
        if (pageReady) return;
        pageReady = true;
        maybeHide();
    }

    document.addEventListener('DOMContentLoaded', function () {
        build();
        // Don't hold the screen for slow images/CDNs: hide on `load`, or at the
        // latest 3 s after the DOM is ready.
        setTimeout(markReady, 3000);
    });
    window.addEventListener('load', markReady);

    if (PROTECTED) {
        // Separate listener — js/auth.js keeps its own and is not modified.
        // window.auth is set by firebase.js at the end of the body scripts.
        var tries = 0;
        (function waitForAuth() {
            var a = window.auth;
            if (a && typeof a.onAuthStateChanged === 'function') {
                try {
                    a.onAuthStateChanged(function (user) {
                        if (user) { signedIn = true; maybeHide(); }
                        // No user: auth.js redirects to login.html; keep the splash up.
                    });
                } catch (e) { signedIn = true; maybeHide(); }
                return;
            }
            if (++tries > 200) { signedIn = true; maybeHide(); return; }   // ~10 s
            setTimeout(waitForAuth, 50);
        })();
    }

    setTimeout(hide, FAILSAFE_MS);

    window.BootSplash = { hide: hide };
})();
