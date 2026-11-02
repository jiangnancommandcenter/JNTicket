// ==============================================================
//  HR DASHBOARD — TRANSFERRED VIOLATIONS (read-only)
// ==============================================================
//  An operator files a CCTV violation -> the superadmin reviews it on the
//  command center -> if it is worth an incident report they press
//  "Transfer to HR", which stamps `hrStatus: 'transferred'` on the SAME
//  document -> the report appears HERE.
//
//  READ-ONLY BY CONSTRUCTION, in two independent layers:
//    1. firestore.rules gives the `hr` role no create/update/delete access to
//       the `violations` collection at all, and only lets it read documents
//       where `hrStatus == 'transferred'`.
//    2. There is no edit / delete / transfer control anywhere in this file or
//       in the tab markup. Even a hand-edited DOM cannot reach a write.
//  HR's only actions are: view the details, open the evidence, download the
//  report PDF.
//
//  It is deliberately NOT loaded by main.html: operators and superadmins use
//  the command center's own Violations tab instead.
// ==============================================================
(function () {
    'use strict';

    const $hr = (id) => document.getElementById(id);

    // DOM — every one is optional so a partial page never throws on load.
    const navItem = $hr('hrViolationsNavItem');
    const search = $hr('hrViolationSearch');
    const storeFilter = $hr('hrViolationStoreFilter');
    const periodFilter = $hr('violationPeriodFilter');
    const tableBody = $hr('hrViolationsBody');
    const pagination = $hr('hrViolationPagination');
    const modal = $hr('hrViolationModal');
    const modalTitle = $hr('hrViolationModalTitle');
    const modalBody = $hr('hrViolationModalBody');
    const attachmentsGrid = $hr('hrViolationAttachmentsGrid');
    const btnDownload = $hr('btnHrViolationReport');
    const btnCloseModal = $hr('closeHrViolationModal');

    // ===== Flash-free first paint =====
    // This nav item ships display:none and is normally revealed only once
    // owner-dashboard.js resolves the role ASYNCHRONOUSLY (see init()'s poll
    // below) — which made the Violations button blink in on refresh, unlike the
    // static Overview/Tickets tabs. owner-dashboard.js caches the last resolved
    // role in sessionStorage; if it says hr/superadmin we reveal the button NOW,
    // synchronously, before first paint. This is OPTIMISTIC and self-corrects:
    // init()/setActiveUser() still run applyRole() with the authoritative role a
    // moment later, which hides it again if the cache was wrong. Only the BUTTON
    // is touched here — the report data stays rules-gated regardless.
    try {
        if (navItem && typeof window.getCachedOwnerRole === 'function') {
            const cached = window.getCachedOwnerRole();
            if (cached === 'hr' || cached === 'superadmin') navItem.style.display = 'flex';
        }
    } catch (e) { /* leave it hidden; the poll will settle it */ }

    const PAGE_SIZE = 20;

    let allViolations = [];       // every report transferred to HR
    let previousHrViolations = []; // for detecting newly transferred reports
    let filtered = [];
    let page = 1;
    let currentId = null;
    let listenerStarted = false;

    // ===== Helpers =====
    // owner-dashboard.js already defines escapeHTML / showToast as globals on
    // this page; the local fallbacks keep this module usable on its own.

    function esc(value) {
        if (typeof window.escapeHTML === 'function') return window.escapeHTML(value);
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    }

    function toast(message, type) {
        if (typeof window.showToast === 'function') window.showToast(message, type || 'info');
        else console.log(message);
    }    function fmtDate(d) {
        if (!d) return '—';
        return d.toLocaleDateString();
    }

    function fmtTime(d) {
        if (!d) return '';
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function fmtDateTime(d) {
        if (!d) return '—';
        return fmtDate(d) + ' · ' + fmtTime(d);
    }

    // The shared report builder exposes these two; fall back to local versions
    // so the dates still render if that script failed to load.
    function incidentDate(v) {
        const lib = window.ViolationReport;
        if (lib && lib.incidentDate) return lib.incidentDate(v);
        const raw = v && v.incidentDateTime;
        if (!raw) return null;
        if (raw.toDate) return raw.toDate();
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
    }

    function reportDate(v) {
        const lib = window.ViolationReport;
        if (lib && lib.reportDate) return lib.reportDate(v);
        const raw = v && (v.reportDateTime || v.createdAt);
        if (!raw) return null;
        if (raw.toDate) return raw.toDate();
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
    }

    // Searchable date strings for a Date, so the search bar matches a date the
    // way it is SHOWN in the table ("10/10/2026") plus an ISO fallback
    // ("2026-10-10"). Minimal set: exactly the two formats users type.
    function dateSearchTokens(d) {
        if (!d || isNaN(d.getTime())) return [];
        const pad = (n) => String(n).padStart(2, '0');
        const iso = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
        return [d.toLocaleDateString(), iso];
    }

    // ===== Store filter =====
    // Options come from the reports actually transferred, not from the branch
    // list: HR may legitimately see a store that is not in their branch scope.
    function populateStoreFilter() {
        if (!storeFilter) return;
        const current = storeFilter.value;
        const stores = Array.from(new Set(allViolations.map(v => v.store).filter(Boolean)))
            .sort((a, b) => a.localeCompare(b));
        storeFilter.innerHTML = '<option value="all">All Stores</option>'
            + stores.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
        if (current && (current === 'all' || stores.includes(current))) storeFilter.value = current;
    }

    // ===== Period filter (view window) =====
    // Purely a VIEW filter — nothing is deleted. A report outside the selected
    // period stays in Firestore and returns with "All reports". Age is measured
    // from when the report was FILED (reportDate → reportDateTime/createdAt), so
    // a transferred review of an older incident is not hidden the day it lands.
    // Reports without a usable date are always KEPT (safer than hiding them).
    const VIOLATION_PERIODS = {
        daily:   { label: 'Today' },
        weekly:  { label: 'Last 7 days' },
        monthly: { label: 'This month' },
        all:     { label: 'All reports' }
    };

    function periodValue() {
        const value = (periodFilter && periodFilter.value) || 'daily';
        return VIOLATION_PERIODS[value] ? value : 'daily';
    }

    /** Midnight (local) at the start of the selected period; null for "all". */
    function periodStart(period, now) {
        if (period === 'all') return null;
        const start = now ? new Date(now) : new Date();
        start.setHours(0, 0, 0, 0);
        if (period === 'daily') return start;                                          // today 00:00
        if (period === 'weekly') { start.setDate(start.getDate() - 6); return start; } // today + previous 6 days
        start.setDate(1);                                                              // 'monthly' → 1st of this month
        return start;
    }

    function inPeriod(v, period, now) {
        const start = periodStart(period, now);
        if (!start) return true;
        const filed = reportDate(v);
        if (!filed) return true;
        return filed.getTime() >= start.getTime();
    }

    // ===== List =====
    function applyFilters() {
        const term = (search && search.value || '').trim().toLowerCase();
        const store = (storeFilter && storeFilter.value) || 'all';

        filtered = allViolations.filter(v => {
            // Belt-and-braces: the rules already hide non-transferred reports,
            // but never render one even if the query ever changes.
            if (v.hrStatus !== 'transferred') return false;
            if (store !== 'all' && (v.store || '') !== store) return false;
            if (!term) return true;
            const haystack = [
                v.violationNumber, v.subject, v.store, v.location,
                v.details, v.reportedByName, v.reportedBy
            ]
                // Both date columns the table shows, in the formats users type
                // ("10/10/2026" and ISO "2026-10-10"), so a date is searchable.
                .concat(dateSearchTokens(reportDate(v)), dateSearchTokens(incidentDate(v)))
                .filter(Boolean).join(' ').toLowerCase();
            return haystack.includes(term);
        });

        // Period window: only reports filed inside the selected period are listed.
        // Nothing is deleted — the rest stay in Firestore and return with "All reports".
        filtered = filtered.filter(v => inPeriod(v, periodValue(), Date.now()));

        page = 1;
        render();
    }

    function render() {
        if (!tableBody) return;

        if (!filtered.length) {
            const hasAny = allViolations.length > 0;
            tableBody.innerHTML = '<tr><td colspan="9" class="empty-state">'
                + '<i class="fas fa-video"></i><p>'
                + (hasAny
                    ? 'No transferred reports match your search.'
                    : 'No violation reports have been transferred to you yet.')
                + '</p></td></tr>';
            if (pagination) pagination.innerHTML = '<span class="page-info">0 report(s)</span>';
            return;
        }

        const totalPages = Math.ceil(filtered.length / PAGE_SIZE) || 1;
        if (page > totalPages) page = totalPages;
        if (page < 1) page = 1;
        const start = (page - 1) * PAGE_SIZE;
        const rows = filtered.slice(start, start + PAGE_SIZE);

        tableBody.innerHTML = rows.map(v => {
            const incident = incidentDate(v);
            const report = reportDate(v);
            const files = Array.isArray(v.attachments) ? v.attachments.length : 0;
            // Built once and used by BOTH the desktop Actions cell and the
            // card's footer — below 900px the desktop cells hide and only the
            // card shows (ROW CARD SWAP in style.css). The row-level
            // delegation above serves both copies, because the card cell sits
            // inside the same `tr[data-id]`.
            const actionsGroup = `
                        <div class="action-group">
                            <button class="action-btn view" type="button" title="View details"><i class="fas fa-eye"></i></button>
                            <button class="action-btn remarks" type="button" title="Remarks / NOV status"
                                data-remarks-key="violations/${esc(v.id)}"
                                data-remarks-label="${esc(v.violationNumber || v.id)}"><i class="fas fa-sticky-note"></i></button>
                            <span class="action-btn upload-indicator" title="Upload NOV files"
                                data-upload-key="violations/${esc(v.id)}"
                                data-upload-label="${esc(v.violationNumber || v.id)}"
                                onclick="event.stopPropagation(); window.HrUploads.openFromButton(this);"><i class="fas fa-file-contract"></i><span class="upload-indicator-label">NOV</span></span>
                        </div>`;
            return `
                <tr class="hr-violation-row" data-id="${esc(v.id)}">
                    <td data-label="Report"><span class="ticket-link">${esc(v.violationNumber || v.id)}</span></td>
                    <td data-label="Reported">${esc(fmtDate(report))}</td>
                    <td data-label="Incident">${esc(incident ? fmtDate(incident) + ', ' + fmtTime(incident) : '—')}</td>
                    <td data-label="Store">${esc(v.store || '—')}</td>
                    <td data-label="Subject">${esc(v.subject || '—')}</td>
                    <td data-label="Reporter">${esc(v.reportedByName || v.reportedBy || '—')}</td>
                    <td data-label="Files">${files > 0 ? `<i class="fas fa-paperclip"></i> ${files}` : '—'}</td>
                    <td>${actionsGroup}</td>
                    <td class="approval-card-cell" data-label="Card">
                        <div class="approval-card">
                            <div class="approval-card-head">
                                <span class="approval-card-branch"><i class="fas fa-store"></i>${esc(v.store || '—')}</span>
                                <span class="approval-card-pill approval-card-pill--neutral">${esc(v.violationNumber || v.id)}</span>
                            </div>
                            <div class="approval-card-grid">
                                <div class="approval-card-field"><span class="approval-card-label">Report Date</span><span class="approval-card-value">${esc(fmtDate(report))}</span></div>
                                <div class="approval-card-field"><span class="approval-card-label">Incident Date/Time</span><span class="approval-card-value">${esc(incident ? fmtDate(incident) + ', ' + fmtTime(incident) : '—')}</span></div>
                                <div class="approval-card-field"><span class="approval-card-label">Subject</span><span class="approval-card-value">${esc(v.subject || '—')}</span></div>
                                <div class="approval-card-field"><span class="approval-card-label">Reporter</span><span class="approval-card-value">${esc(v.reportedByName || v.reportedBy || '—')}</span></div>
                            </div>
                            <div class="approval-card-foot">
                                <div class="approval-card-expiry">
                                    <span class="approval-card-label">Evidence</span>
                                    <span class="approval-card-note">${files > 0 ? `<i class="fas fa-paperclip"></i> ${files} file${files === 1 ? '' : 's'}` : 'No attachments'}</span>
                                </div>
                                <div class="approval-card-actions">${actionsGroup}</div>
                            </div>
                        </div>
                    </td>
                </tr>`;
        }).join('');

        // Re-flag the Remarks buttons for the rows just drawn (red = already has a note).
        try { if (window.Remarks && window.Remarks.paintPresence) window.Remarks.paintPresence(); } catch (e) { /* ignore */ }
        // Re-flag the Upload buttons for the rows just drawn (amber = already has files).
        try { if (window.HrUploads && window.HrUploads.paintPresence) window.HrUploads.paintPresence(); } catch (e) { /* ignore */ }

        renderPagination(totalPages);
    }

    function renderPagination(totalPages) {
        if (!pagination) return;
        if (totalPages <= 1) {
            pagination.innerHTML = `<span class="page-info">${filtered.length} report(s)</span>`;
            return;
        }
        let html = `<span class="page-info">Page ${page} of ${totalPages} &middot; ${filtered.length} report(s)</span>`;
        html += '<div class="pagination-controls">';
        if (page > 1) html += `<button class="btn btn-sm btn-secondary" data-page="${page - 1}">Previous</button>`;
        if (page < totalPages) html += `<button class="btn btn-sm btn-secondary" data-page="${page + 1}">Next</button>`;
        html += '</div>';
        pagination.innerHTML = html;

        pagination.querySelectorAll('[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                page = parseInt(btn.dataset.page, 10) || 1;
                render();
            });
        });
    }

    // ===== Evidence (read-only) =====
    // Uses the SHARED attachment card from js/attachment-viewer.js — the same
    // .attachment-item card with a real thumbnail that the command center grids
    // render. This used to be a hand-rolled icon row (owner-attachment-row) with
    // no thumbnail at all, chosen deliberately to "avoid pulling the command
    // center's thumbnail helpers onto a page". That left HR seeing CCTV footage as
    // a grey icon chip while an operator saw the same clip as a poster frame.
    // Clicking a card opens the shared viewer.
    function renderAttachments(attachments) {
        if (!attachmentsGrid) return;
        const list = Array.isArray(attachments) ? attachments : [];
        const view = window.AttachmentViewer;
        if (!list.length || !view) {
            attachmentsGrid.innerHTML = '<p class="u-section-sub">No attachments on this report.</p>';
            return;
        }
        attachmentsGrid.innerHTML = list.map(function (att, i) {
            return view.buildAttachmentCard(att, { index: i });
        }).join('');
    }
    function detailsHtml(v) {
        const incident = incidentDate(v);
        const report = reportDate(v);
        // ⚠️ Deliberately NO "Transferred to HR / by whom / when" row and NO
        // "Reported By" row. HR already knows the report is theirs — it is on
        // their list *because* it was transferred — so the transfer line was
        // pure noise, and it exposed the superadmin's own email address to
        // every HR who opened the report. The reporter is likewise not needed
        // to write the incident report, so their identity stays off HR's view
        // (the superadmin still sees it, in their modal, the table and the PDF).
        return `
            <div class="modal-field"><label>Report No.</label><p>${esc(v.violationNumber || v.id)}</p></div>
            <div class="modal-field"><label>Store</label><p>${esc(v.store || '—')}</p></div>
            <div class="modal-field"><label>Location</label><p>${esc(v.location || '—')}</p></div>
            <div class="modal-field"><label>Incident Date/Time</label><p>${esc(fmtDateTime(incident))}</p></div>
            <div class="modal-field"><label>Report Date/Time</label><p>${esc(fmtDateTime(report))}</p></div>
            <div class="modal-field" style="grid-column:1 / -1;"><label>Subject</label><p style="font-weight:600;">${esc(v.subject || '—')}</p></div>
            <div class="modal-field" style="grid-column:1 / -1;"><label>Details of Observation</label><p style="white-space:pre-wrap;line-height:1.6;">${esc(v.details || '—')}</p></div>
        `;
    }

    /**
     * Open a report in the modal. Returns TRUE only when it actually opened.
     *
     * ⚠️ The return value is load-bearing, not decoration. `openModal()` looks
     * the report up in `allViolations` — the in-memory array fed by the
     * listener — so a caller that is not this page's own table (the chat's
     * violation chips, via window.HrViolations.openModal) can ask for a report
     * that has not arrived yet, or that this role may not read at all. This
     * used to `return` undefined in BOTH the success and the failure case, so
     * the caller could not tell "opened" from "not found" and a click would
     * appear to do nothing at all. Returning a boolean lets chat.js say why.
     */
    function openModal(id) {
        const v = allViolations.find(x => x.id === id);
        if (!v) return false;
        currentId = id;
        if (modalTitle) modalTitle.textContent = v.violationNumber || 'Violation Report';
        if (modalBody) modalBody.innerHTML = detailsHtml(v);
        renderAttachments(v.attachments);
        if (modal) {
            modal.classList.add('active');
            return true;
        }
        // No modal element on this page, so nothing was opened.
        return false;
    }

    function closeModal() {
        if (modal) modal.classList.remove('active');
        currentId = null;
    }

    /**
     * Download the "COMMAND CENTER REPORT" for the open report.
     *
     * ⚠️ This DOWNLOADS ONLY. The command center additionally re-uploads the
     * PDF into the report's Cloudinary folder and rewrites `attachments`, but
     * that would be a Firestore write — which the `hr` role is denied by
     * firestore.rules. So HR regenerates the identical PDF locally (the layout
     * is the shared js/violation-report.js) and saves it, without touching the
     * stored record. The copy already in Cloudinary stays exactly as the
     * superadmin left it.
     */
    async function downloadReport() {
        const v = allViolations.find(x => x.id === currentId);
        if (!v) return;
        const label = btnDownload ? btnDownload.querySelector('span') : null;
        const lib = window.ViolationReport;

        if (btnDownload) btnDownload.disabled = true;
        if (label) label.textContent = 'Preparing…';
        try {
            const name = (lib ? lib.fileName(v) : 'report') + '.pdf';
            const blob = lib ? await lib.buildPdf(v) : null;
            if (!blob) {
                // jsPDF unavailable (offline / CDN blocked) — print instead so
                // the action still produces the report rather than dead-ending.
                if (lib) lib.print(v);
                else toast('The report builder is still loading. Please try again.', 'error');
                return;
            }
            if (lib) lib.download(blob, name);
            toast('Report downloaded.', 'success');
        } catch (error) {
            console.error('Failed to build the violation report:', error);
            toast('Could not generate the report: ' + ((error && error.message) || 'unknown error'), 'error');
        } finally {
            if (btnDownload) btnDownload.disabled = false;
            if (label) label.textContent = 'Download Report';
        }
    }

    // ===== Live data =====
    function startListener() {
        if (listenerStarted) return;
        listenerStarted = true;

        const service = window.firestoreService;
        if (!service || typeof service.listenTransferredViolations !== 'function') {
            console.warn('listenTransferredViolations is unavailable — HR violations list is empty.');
            return;
        }

        service.listenTransferredViolations(
            (violations) => {
                const list = violations || [];
                if (previousHrViolations.length > 0) {
                    const prevIds = new Set(previousHrViolations.map(v => v.id));
                    for (const v of list) {
                        if (!prevIds.has(v.id) && typeof window.notifyViolationTransferred === 'function') {
                            window.notifyViolationTransferred(v);
                        }
                    }
                }
                previousHrViolations = list.map(v => ({ ...v }));
                allViolations = list;
                populateStoreFilter();
                applyFilters();
                // A report that was reverted while its modal was open must not
                // stay on screen — close it rather than show stale data.
                if (currentId && !allViolations.some(v => v.id === currentId)) closeModal();
            },
            (error) => {
                console.error('HR violations listener error:', error);
                if (tableBody) {
                    tableBody.innerHTML = '<tr><td colspan="9" class="empty-state">'
                        + '<em>Unable to load transferred violations.</em></td></tr>';
                }
            }
        );
    }

    // ===== Role gate =====
    /**
     * Show the tab to HR (and superadmin, who uses the command center anyway)
     * and hide it from owners.
     *
     * This is UI ONLY. The real authorisation is firestore.rules: an owner
     * cannot read the `violations` collection at all, so even if this button
     * were forced visible the query would return nothing.
     */
    function applyRole(role) {
        const allowed = role === 'hr' || role === 'superadmin';
        if (navItem) {
            navItem.style.display = allowed ? 'flex' : 'none';
            navItem.classList.toggle('u-hidden', !allowed);
        }
        if (!allowed) {
            // Owners must not be able to reach the section by any route.
            const section = $hr('tabViolations');
            if (section) section.classList.remove('active');
            closeModal();
        }

        if (allowed) startListener();
    }

    // ===== Events =====
    function bindEvents() {
        if (search) {
            let timer = null;
            search.addEventListener('input', () => {
                clearTimeout(timer);
                timer = setTimeout(applyFilters, 250);
            });
        }
        if (storeFilter) storeFilter.addEventListener('change', applyFilters);
        if (periodFilter) periodFilter.addEventListener('change', applyFilters);
        if (btnCloseModal) btnCloseModal.addEventListener('click', closeModal);
        if (modal) modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
        // The modal's button always prints whatever report is currently open.
        if (btnDownload) btnDownload.addEventListener('click', () => downloadReportFor(currentId));

        // One delegated listener covers rows re-rendered by every filter change
        // and every snapshot, so no handler is ever attached twice.
        if (tableBody) {
            tableBody.addEventListener('click', e => {
                const row = e.target.closest('tr[data-id]');
                if (!row) return;
                const id = row.getAttribute('data-id');
                // The Remarks button opens the shared NOV-status log. It must be
                // caught BEFORE the openModal() fall-through below, or clicking
                // it would ALSO open the report modal on top of it.
                if (e.target.closest('.remarks')) {
                    if (window.Remarks && typeof window.Remarks.openFromButton === 'function') {
                        window.Remarks.openFromButton(e.target.closest('.remarks'));
                    }
                    return;
                }
                openModal(id);
            });
        }
    }

    // ===== Boot =====
    /**
     * Is this a ROLE WE CAN ACT ON, or the 'viewer' placeholder?
     *
     * ⚠️ This mirrors js/owner-violations.js. owner-dashboard.js declares
     * `let activeUserRole = 'viewer'` and resolves the real role ASYNCHRONOUSLY
     * from Firestore, so at load getOwnerRole() returns the TRUTHY string
     * 'viewer'. A naive `if (r) return r` treats that placeholder as resolved,
     * applyRole('viewer') hides the nav item — undoing the cached-role reveal
     * above — and the poll believes it is finished and STOPS, so the real role
     * arriving a moment later is never picked up by readRole().
     *
     * 'viewer'/'editor' are UI labels for accounts with no stored role; they are
     * not roles the rules or applyRole() authorise on. The badge LABELS
     * ('Area Manager'/'am' → 'owner', 'RM/SM' → 'rmsm') ARE accepted so the
     * badge fallback can still resolve a real stored role.
     */
    function isRealRole(role) {
        const r = String(role === null || role === undefined ? '' : role).trim().toLowerCase();
        return r === 'owner' || r === 'hr' || r === 'superadmin'
            || r === 'area manager' || r === 'am'
            || r === 'rmsm' || r === 'rm/sm';
    }

    /**
     * Current role, however the page happens to expose it. owner-dashboard.js
     * installs `window.getOwnerRole()` in setActiveUser(); the role badge in the
     * header is the fallback and is always present in the DOM.
     *
     * ⚠️ We deliberately do NOT read the `activeUserRole` variable: it is
     * declared with `let` at the top level of a classic script, which creates a
     * *script-scoped* binding, NOT a property on `window` (only `var` and
     * function declarations would). Reading `window.activeUserRole` would
     * always be undefined.
     */
    function readRole() {
        if (typeof window.getOwnerRole === 'function') {
            const r = window.getOwnerRole();
            // ⚠️ REJECT THE PLACEHOLDER. owner-dashboard.js declares
            // `let activeUserRole = 'viewer'` and resolves the real role
            // ASYNCHRONOUSLY, so at load getOwnerRole() returns the TRUTHY
            // string 'viewer'. Returning it made applyRole('viewer') HIDE the
            // button this module had just revealed from the role cache — and
            // stopped the poll — so the tab still blinked in on refresh. Treat
            // non-stored placeholders as "not known yet" and keep polling;
            // setActiveUser()'s direct applyRole() call settles the real role.
            if (isRealRole(r)) return String(r).toLowerCase();
        }
        const badge = $hr('ownerUserRoleBadge');
        const text = badge ? String(badge.textContent || '').trim().toLowerCase() : '';
        // 'area manager' is the LABEL owner-dashboard.js now puts in the badge
        // for the stored role 'owner'. It must map back to 'owner', because
        // applyRole() (and the rules) authorise on the stored value, not the
        // label. Without this the badge fallback would yield '' and the poll
        // above would keep retrying a role it can never match.
        if (text === 'hr' || text === 'superadmin' || text === 'owner') return text;
        if (text === 'area manager' || text === 'am') return 'owner';
        // 'RM/SM' is the badge LABEL owner-dashboard.js renders for the
        // stored role 'rmsm' — map it back exactly the same way
        // 'Area Manager' maps to 'owner', or the fallback yields ''.
        if (text === 'rm/sm') return 'rmsm';
        return '';
    }

    function init() {
        bindEvents();

        // owner-dashboard.js resolves the role asynchronously from Firestore, so
        // on first paint it may not be known yet. Poll briefly, then stop: an
        // unauthenticated or slow visit simply never shows the tab, which is
        // the safe direction to fail in.
        let tries = 0;
        const check = () => {
            const role = readRole();
            if (role) { applyRole(role); return; }
            if (++tries < 40) setTimeout(check, 250);
        };
        check();
    }

    // Exposed so owner-dashboard.js can hand the role over directly, and for
    // the tab-restoration path and tests.
    window.HrViolations = {
        applyRole: applyRole,
        openModal: openModal,
        closeModal: closeModal,
        applyFilters: applyFilters,
        readRole: readRole
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
