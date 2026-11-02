// ==============================================================
//  ERROR REPORTER
//  Captures genuine breakage and writes it to the browser console,
//  so a crash is visible while developing instead of vanishing
//  when the tab closes.
//
//  ⚠️ THIS USED TO WRITE TO FIRESTORE. It no longer does, and that
//  was deliberate: the app runs on the free (Spark) plan, and this
//  reporter was costing real quota. It was worse than one write per
//  error — every successful report also ran a FULL COLLECTION READ
//  (pruneCollection() re-queried the whole log to check the cap),
//  plus deletes, plus a toast shown to every user. The dedupe window
//  was in-memory, so a page reload reset it and ordinary activity
//  could burn writes on the free tier. All of that is gone.
//  The Error Log tab, the `app_errors` collection and its rules were
//  removed with it. A crash now appears in devtools only.
//
//  CAPTURES ONLY:
//    - window.onerror          — crashes / thrown errors
//    - unhandledrejection      — failed promises nobody handled
//  It deliberately does NOT hook console.warn/error/log, so routine
//  warnings stay out of the log and every entry is worth reading.
//
//  SAFETY (this code runs inside the failure path, so it must never
//  be able to make things worse):
//    - Every path is wrapped in try/catch; a failed report is silent.
//    - A crash inside this file cannot loop (guarded by a re-entrancy flag).
//    - Duplicate errors within DEDUPE_MS are collapsed into a single
//      line with a repeat counter, so a broken setInterval cannot
//      flood the console either.
//    - Nothing is transmitted anywhere: no network, no storage, no
//      writes of any kind. The worst this can cost is log noise.
// ==============================================================

(function () {
    'use strict';

    var MAX_MESSAGE_LENGTH = 500;   // truncate the error text
    var DEDUPE_MS = 5 * 60 * 1000;  // same error within 5 min => one line

    // Guards against this reporter reporting an error about itself.
    var isReporting = false;

    // message -> { at, count } for de-duplication within this page.
    //
    // ⚠️ IN-MEMORY ONLY, so it resets on reload. That was the same
    // limitation the Firestore version had for its write-dedupe, and
    // it is acceptable here precisely because the cost of a repeat is
    // one console line rather than a write. A page that throws on
    // every reload will log once per reload; a localStorage window
    // would fix that at the price of persistence this does not need.
    var recent = {};

    function now() { return Date.now(); }

    function truncate(text) {
        var s = String(text === null || text === undefined ? '' : text);
        return s.length > MAX_MESSAGE_LENGTH ? s.slice(0, MAX_MESSAGE_LENGTH) + '…' : s;
    }

    /** Best-effort description of where the error came from. */
    function describeSource(source, lineno, colno) {
        if (!source) return '';
        var file = String(source).split('/').pop();
        if (lineno) return file + ':' + lineno + (colno ? ':' + colno : '');
        return file;
    }

    function currentUser() {
        try {
            var user = (typeof auth !== 'undefined' && auth && auth.currentUser) ? auth.currentUser : null;
            if (user && user.email) return String(user.email).toLowerCase();
        } catch (e) { /* ignore */ }
        return 'signed-out';
    }

    /** Role is resolved lazily; it may not be loaded yet when a crash happens. */
    function currentRole() {
        try {
            if (typeof currentUserRole !== 'undefined' && currentUserRole) return String(currentUserRole);
        } catch (e) { /* not on this page */ }
        return 'unknown';
    }

    function currentPage() {
        try {
            return String(window.location.pathname.split('/').pop() || 'unknown');
        } catch (e) {
            return 'unknown';
        }
    }

    /**
     * Log one error. Never throws, never rejects, never loops.
     *
     * ⚠️ SYNCHRONOUS AND STORAGE-FREE ON PURPOSE. The previous version was
     * async and wrote a document per error, then ran a full collection read
     * to enforce a size cap. Both cost quota on the free plan, and the cap
     * could not prevent them — only trim afterwards. Logging is the whole
     * job now, so this returns as soon as the line is out.
     */
    function report(payload) {
        if (isReporting) return;      // never report a failure to report
        isReporting = true;
        try {
            var message = truncate(payload && payload.message);
            if (!message) return;

            // ---- De-duplicate: the same text within the window collapses to
            // ONE line carrying a repeat count, so a broken setInterval that
            // throws every second does not scroll the console away.
            var existing = recent[message];
            if (existing && (now() - existing.at) < DEDUPE_MS) {
                existing.at = now();
                existing.count += 1;
                return;
            }

            var entry = {
                message: message,
                source: truncate(payload.source || ''),
                kind: payload.kind || 'error',
                page: currentPage(),
                user: currentUser(),
                role: currentRole(),
                userAgent: truncate((navigator && navigator.userAgent) || ''),
                at: new Date().toISOString()
            };

            recent[message] = { at: now(), count: 1 };

            // ⚠️ ONE console.error, ONE object. A structured object rather
            // than a formatted string, so devtools can expand and filter it.
            // `count: 1` is present from the first line so the shape never
            // changes when a repeat bumps it.
            entry.count = 1;
            try {
                if (typeof console !== 'undefined' && console.error) {
                    console.error('[RCMS]', entry);
                }
            } catch (e) { /* a broken console must not throw */ }
        } catch (e) {
            // Never let the reporter itself break the page.
        } finally {
            isReporting = false;
        }
    }

    // ==============================================================
    //  EVENT CAPTURE
    // ==============================================================

    function init() {
        if (typeof window.addEventListener !== 'function') return;

        // Crashes / thrown errors.
        window.addEventListener('error', function (event) {
            try {
                // Ignore errors from <script> and <img> element loads — those
                // fire on the element, not the window, and are handled by the
                // pages' own onerror fallbacks.
                const target = event && event.target;
                if (target && target !== window && (target.tagName === 'SCRIPT' || target.tagName === 'IMG' || target.tagName === 'LINK')) {
                    return;
                }
                report({
                    message: (event && event.message) || 'Unknown error',
                    source: describeSource(event && event.filename, event && event.lineno, event && event.colno),
                    kind: 'error'
                });
            } catch (e) { /* ignore */ }
        });

        // Failed promises nobody handled — e.g. the chat "could not send"
        // path, where the rejection escapes an async function.
        window.addEventListener('unhandledrejection', function (event) {
            try {
                const reason = event && event.reason;
                const message = (reason && (reason.message || reason)) || 'Unhandled promise rejection';
                report({
                    message: message,
                    source: describeSource(reason && reason.stack ? String(reason.stack).split('\n')[1] : ''),
                    kind: 'unhandledrejection'
                });
            } catch (e) { /* ignore */ }
        });
    }

    // Exposed for the unit test (test/error-reporter.test.js), which runs the
    // file in a vm sandbox.
    //
    // ⚠️ `COLLECTION` and `MAX_ENTRIES` are GONE. They existed only for the
    // Firestore write path; leaving them exported would let a future caller
    // think there is still somewhere to write to.
    window.ErrorReporter = {
        report: report,
        init: init,
        truncate: truncate,
        DEDUPE_MS: DEDUPE_MS,
        MAX_MESSAGE_LENGTH: MAX_MESSAGE_LENGTH
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
