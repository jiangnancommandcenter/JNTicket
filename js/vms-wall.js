/**
 * Camera wall (vms-wall.js)
 * A dashboard grid with one tile per branch: LED, name, ONLINE/OFFLINE and,
 * when offline, how long it has been down. Read-only: it reads the
 * `branches` array that script.js already keeps live and reuses
 * script.js helpers (getCurrentDowntimeText, openViewModal). Clicking a tile
 * opens the same Branch Details modal as the eye button in Branch Monitor.
 */
(function () {
    'use strict';

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function lastSeen(b) {
        try {
            var t = b.lastUpdated;
            if (!t) return '';
            var d = t.toDate ? t.toDate() : new Date(t);
            if (isNaN(d)) return '';
            return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        } catch (e) { return ''; }
    }

    function render() {
        var wall = document.getElementById('vmsWall');
        if (!wall || typeof branches === 'undefined' || !Array.isArray(branches)) return;
        var list = branches.slice().sort(function (a, b) {
            var ao = a.currentStatus === 'Offline' ? 0 : 1;
            var bo = b.currentStatus === 'Offline' ? 0 : 1;
            return (ao - bo) || String(a.branchName || '').localeCompare(String(b.branchName || ''));
        });
        var off = list.filter(function (b) { return b.currentStatus === 'Offline'; }).length;
        var legend = document.getElementById('vmsWallLegend');
        if (legend) {
            legend.innerHTML = '<span><b>' + list.length + '</b>&nbsp;branches</span>'
                + '<span><b>' + (list.length - off) + '</b>&nbsp;online</span>'
                + '<span class="off"><b>' + off + '</b>&nbsp;offline</span>';
        }
        if (!list.length) {
            wall.innerHTML = '<div class="empty-state"><p>No branches loaded yet.</p></div>';
            return;
        }
        wall.innerHTML = list.map(function (b, i) {
            var isOff = b.currentStatus === 'Offline';
            var isOn = b.currentStatus === 'Online';
            var cls = isOff ? 'is-off' : (isOn ? 'is-on' : 'is-idle');
            var time = isOff
                ? (typeof getCurrentDowntimeText === 'function' ? getCurrentDowntimeText(b) : '')
                : lastSeen(b);
            var code = (typeof window.branchToPrefix === 'function' ? window.branchToPrefix(b.branchName) : '') || ('cam' + (i + 1));
            return '<button type="button" class="vms-tile ' + cls + '" data-branch="' + esc(b.branchName) + '"'
                + ' title="' + esc(b.branchName) + ' — open details">'
                + '<span class="vms-tile-head"><span class="vms-tile-cam">' + esc(code.toUpperCase()) + '</span><span class="vms-led"></span></span>'
                + '<span class="vms-tile-name">' + esc(b.branchName) + '</span>'
                + '<span class="vms-tile-foot"><span class="vms-tile-state">' + (isOff ? 'OFFLINE' : (isOn ? 'ONLINE' : 'NO DATA')) + '</span>'
                + '<span class="vms-tile-time">' + esc(time) + '</span></span>'
                + '</button>';
        }).join('');
    }

    document.addEventListener('click', function (e) {
        var tile = e.target.closest && e.target.closest('.vms-tile');
        if (!tile || typeof openViewModal !== 'function') return;
        openViewModal(tile.getAttribute('data-branch'));
    });

    window.renderVmsWall = render;
    // Offline timers keep counting between data updates.
    setInterval(render, 60000);
})();
