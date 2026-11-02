/**
 * First-run onboarding tour (js/onboarding.js)
 *
 * A short, dismissible 3-step tour for operators and superadmins, shown once.
 *
 * Deliberate constraints:
 *  - It is OPTIONAL and skippable at every point (Skip, Escape, or clicking
 *    outside). A tour that blocks a control-room operator during a shift is
 *    worse than no tour.
 *  - It never shows for a role it was not written for. Owners get the owner
 *    dashboard and a different feature set, so the tour would be describing
 *    UI they cannot see.
 *  - It reuses the app's `.modal-overlay` / `.modal-container` so it themes
 *    for free, and it points at REAL elements via selectors — if an element it
 *    references is missing, the step is skipped rather than throwing.
 *  - `localStorage` access is wrapped: private browsing degrades to "the tour
 *    shows again next time", which is the harmless failure mode.
 */
(function () {
    'use strict';

    const SEEN_KEY = 'rcms_tour_seen';

    // Each step: the element to spotlight, plus the copy. Selectors are
    // resolved at render time, so a step whose element is gone is skipped.
    var STEPS = [
        {
            target: '.sidebar-nav',
            title: 'Everything lives in this sidebar',
            body: 'Operations (Dashboard, Branch Monitor, Status History) on top, ' +
                  'Incidents (Tickets, Violations) below. Administration appears here ' +
                  'only if you are a superadmin.'
        },
        {
            target: '.dash-kpis',
            title: 'The four tiles are your morning check',
            body: 'Operational Readiness, Active Outages, open Tickets and this week\'s ' +
                  'Violations. Every tile is a link — click one to jump straight to that screen.'
        },
        {
            target: '.dash-alert, .dash-panel',
            title: 'When something is wrong, the banner says so',
            body: 'A red strip appears across the top of the dashboard the moment a branch ' +
                  'goes offline, naming the branch. Below it, "Needs Attention" ranks what ' +
                  'to fix first. Press ? any time for the keyboard shortcuts.'
        }
    ];

    function alreadySeen() {
        try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; }
    }

    function markSeen() {
        try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* private mode */ }
    }

    // Written for the operator / superadmin command center. The owner dashboard
    // and the public pages have a completely different layout.
    function pageSupportsTour() {
        return !!document.querySelector('.sidebar-nav')
            && !!document.querySelector('.tab-content.active');
    }

    function escapeText(value) {
        var el = document.createElement('div');
        el.textContent = String(value == null ? '' : value);
        return el.innerHTML;
    }

    var els = {};
    var index = 0;
    var open = false;

    function build() {
        if (els.overlay) return;

        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay tour-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'tourTitle');

        var card = document.createElement('div');
        card.className = 'modal-container tour-card';

        var body = document.createElement('div');
        body.className = 'tour-body';

        var footer = document.createElement('div');
        footer.className = 'tour-footer';

        var dots = document.createElement('div');
        dots.className = 'tour-dots';
        dots.setAttribute('aria-hidden', 'true');

        var actions = document.createElement('div');
        actions.className = 'tour-actions';

        var skipBtn = document.createElement('button');
        skipBtn.type = 'button';
        skipBtn.className = 'btn btn-secondary btn-sm';
        skipBtn.textContent = 'Skip';
        skipBtn.addEventListener('click', function () { finish(); });

        var nextBtn = document.createElement('button');
        nextBtn.type = 'button';
        nextBtn.className = 'btn btn-primary btn-sm';
        nextBtn.addEventListener('click', function () {
            if (index >= STEPS.length - 1) finish();
            else { index++; render(); }
        });

        actions.appendChild(skipBtn);
        actions.appendChild(nextBtn);
        footer.appendChild(dots);
        footer.appendChild(actions);

        card.appendChild(body);
        card.appendChild(footer);
        overlay.appendChild(card);
        document.body.appendChild(overlay);

        els.overlay = overlay;
        els.body = body;
        els.dots = dots;
        els.next = nextBtn;
        els.card = card;

        overlay.addEventListener('click', function (event) {
            if (event.target === overlay) finish();
        });
        document.addEventListener('keydown', function (event) {
            if (!open) return;
            if (event.key === 'Escape') { event.preventDefault(); finish(); }
            else if (event.key === 'ArrowRight') { if (index < STEPS.length - 1) { index++; render(); } }
            else if (event.key === 'ArrowLeft') { if (index > 0) { index--; render(); } }
        });
    }

    function render() {
        var step = STEPS[index];

        // A step whose target is gone (markup changed, or the element is on a
        // hidden tab) is skipped rather than shown pointing at nothing.
        var target = step.target ? document.querySelector(step.target) : null;
        if (!target) {
            if (index < STEPS.length - 1) { index++; render(); }
            else finish();
            return;
        }

        els.body.innerHTML =
            '<p class="tour-step-count">Step ' + (index + 1) + ' of ' + STEPS.length + '</p>' +
            '<h2 class="tour-title" id="tourTitle">' + escapeText(step.title) + '</h2>' +
            '<p class="tour-text">' + escapeText(step.body) + '</p>';

        els.dots.innerHTML = STEPS.map(function (s, i) {
            return '<span class="tour-dot' + (i === index ? ' active' : '') + '"></span>';
        }).join('');

        els.next.textContent = (index === STEPS.length - 1) ? 'Got it' : 'Next';

        // Move the spotlight. `is-tour-target` is removed from the previous
        // element first, or every step would leave a highlight behind.
        var prev = document.querySelector('.is-tour-target');
        if (prev) prev.classList.remove('is-tour-target');
        target.classList.add('is-tour-target');
        els.card.setAttribute('data-tour-step', String(index));
    }

    function start() {
        if (open || alreadySeen() || !pageSupportsTour()) return;
        build();
        open = true;
        index = 0;
        document.body.classList.add('is-touring');
        els.overlay.classList.add('active');
        render();
        if (els.next) els.next.focus();
    }

    function finish() {
        if (!open) return;
        open = false;
        // Marked seen even when dismissed with Escape — they have now seen it,
        // and re-showing on every reload is the annoying failure mode.
        markSeen();
        document.body.classList.remove('is-touring');
        var prev = document.querySelector('.is-tour-target');
        if (prev) prev.classList.remove('is-tour-target');
        if (els.overlay) els.overlay.classList.remove('active');
    }

    function init() {
        // A short delay so the first dashboard render has landed; opening on
        // top of a half-painted dashboard looks broken.
        setTimeout(function () {
            if (typeof window.startOnboardingTour === 'function') {
                window.startOnboardingTour();
            } else {
                start();
            }
        }, 900);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.Onboarding = {
        start: start,
        finish: finish,
        isOpen: function () { return open; },
        steps: STEPS
    };
})();

