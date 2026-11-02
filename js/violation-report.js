// ==============================================================
//  VIOLATION REPORT — SHARED "COMMAND CENTER REPORT" BUILDER
// ==============================================================
//  Auto-filled PDF built entirely from a stored violation report.
//
//  WHY THIS IS A SEPARATE FILE: the report is produced from TWO different
//  pages — main.html (superadmin/operator) and ownerdashboard.html (HR).
//  It used to live inside script.js, which the HR dashboard does not load,
//  so HR could open a transferred report but could not print it. The
//  builder now lives here and BOTH pages load this file, so there is
//  exactly one implementation of the report layout to keep in sync.
//
//  The whole module is an IIFE and publishes only `window.ViolationReport`.
//  That is deliberate: script.js also declares top-level `const`s (e.g. the
//  letterhead URL), and two classic <script> files may NOT declare the same
//  top-level identifier — it throws "already been declared" and kills the
//  whole app. Inside an IIFE these names are private, so nothing collides.
//
//  Everything in here is PURE with respect to the report: it reads fields
//  off the violation object and returns a Blob. It never writes to
//  Firestore — deciding whether a report may be stored/linked is the
//  caller's job (see main.html's generateViolationReport, and the
//  read-only download used on the HR dashboard).
//
//  Public API:
//    ViolationReport.buildPdf(v)   -> Promise<Blob|null>   (null = no jsPDF)
//    ViolationReport.printHtml(v)  -> string               (standalone HTML)
//    ViolationReport.print(v)      -> void                 (opens a print window)
//    ViolationReport.fileName(v)   -> string               ("<Subject> report")
//    ViolationReport.download(blob, name)                  (saves to the PC)
//    ViolationReport.isAvailable() -> boolean              (jsPDF loaded?)
//    ViolationReport.formatStamp(d)                        ("September 15, 2026 0027H")
//    ViolationReport.storeLabel(store)                     ("Fame" -> "Fame Branch")
//    ViolationReport.incidentDate(v) / reportDate(v)       (Date|null)
// ==============================================================
(function (global) {
    'use strict';

    // Full-width letterhead banner (1768x174 px) shown end-to-end at the top of
    // every generated "COMMAND CENTER REPORT" PDF. No border, no margins.
    var HEADER_URL = 'https://res.cloudinary.com/gbd9cguj/image/upload/v1792676243/cfydlot1i8uwsegwmhmp.png';
    // Hardcoded aspect from the uploaded asset, used only if image probing fails.
    var HEADER_ASPECT = 1768 / 174;

    function escapeHTML(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Sanitize a single folder / public-id path segment.
     * Cloudinary public_id rules allow only letters, digits, spaces, `-`, `_`
     * and `.`; `&`, `#`, `%`, `?` etc. make the whole public_id INVALID, so
     * "&" maps to "-" and every other disallowed character becomes a space.
     */
    function sanitizeSegment(value) {
        return String(value || 'Unnamed')
            .replace(/&/g, '-')
            .replace(/[^A-Za-z0-9 _.\-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim() || 'Unnamed';
    }

    /** Date the incident happened, tolerating both Timestamp and ISO strings. */
    function incidentDate(v) {
        var raw = v && v.incidentDateTime;
        if (!raw) return null;
        if (raw.toDate) return raw.toDate();
        var d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
    }

    /** Date the report was FILED, falling back to createdAt. */
    function reportDate(v) {
        var raw = v && (v.reportDateTime || v.createdAt);
        if (!raw) return null;
        if (raw.toDate) return raw.toDate();
        var d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
    }

    /**
     * Military-style stamp used by the report:
     *   "September 15, 2026 0027H"
     * 24-hour clock, hours AND minutes zero-padded, followed by "H".
     */
    function formatStamp(d) {
        if (!d) return '—';
        var date = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        return date + ' ' + hh + mm + 'H';
    }

    /** "Fame" -> "Fame Branch"; never doubles the suffix on an already-suffixed store. */
    function storeLabel(store) {
        var name = String(store || '').trim();
        if (!name) return '—';
        return /\bbranch$/i.test(name) ? name : name + ' Branch';
    }

    /** File / public_id base for the generated report: "<Subject> report". */
    function fileName(v) {
        return sanitizeSegment(v && v.subject ? v.subject : '') + ' report';
    }

    /**
     * Full-width letterhead banner, fetched and converted to a data URL for
     * jsPDF. Returns null when it cannot be read (offline / blocked), so the
     * report degrades to the built-in text-only letterhead instead of breaking.
     */
    function fetchReportHeader() {
        if (!HEADER_URL) return Promise.resolve(null);
        return fetch(HEADER_URL, { mode: 'cors' })
            .then(function (res) { return res.ok ? res.blob() : null; })
            .then(function (blob) {
                if (!blob) return null;
                return new Promise(function (resolve) {
                    var reader = new FileReader();
                    reader.onload = function () { resolve(reader.result); };
                    reader.onerror = function () { resolve(null); };
                    reader.readAsDataURL(blob);
                });
            })
            .catch(function () { return null; });   // no header is better than a broken report
    }

    /**
     * Build the "COMMAND CENTER REPORT" PDF for one violation report.
     * Every value is auto-filled from the stored report — nothing is typed by hand.
     * @returns {Promise<Blob|null>} the PDF blob, or null when jsPDF is unavailable.
     */
    async function buildPdf(v) {
        var JsPDF = global.jspdf && global.jspdf.jsPDF;
        if (!JsPDF) return null;

        var doc = new JsPDF({ unit: 'pt', format: 'a4' });
        var pageW = doc.internal.pageSize.getWidth();
        var pageH = doc.internal.pageSize.getHeight();
        var marginX = 54;
        var y = 0;

        // ----- Letterhead: full-width banner image (end-to-end, no border) -----
        // The uploaded banner already contains the logo + brand text, so no extra
        // letterhead text is drawn when it loads. If it cannot be fetched, the
        // built-in text letterhead below is used instead so the report never breaks.
        var header = await fetchReportHeader();
        var headerUsed = false;
        if (header) {
            try {
                var headerH = pageW / HEADER_ASPECT;
                try {
                    var props = doc.getImageProperties(header);
                    if (props && props.width && props.height) {
                        headerH = pageW / (props.width / props.height);
                    }
                } catch (e) { /* keep the known aspect ratio */ }
                // End-to-end: x=0 -> page width, y=0, no border, no margin.
                doc.addImage(header, 'PNG', 0, 0, pageW, headerH);
                headerUsed = true;
                y = headerH + 26;
            } catch (e) {
                headerUsed = false;   // fall through to the text letterhead
            }
        }

        if (!headerUsed) {
            doc.setFillColor(37, 99, 235);
            doc.rect(0, 0, pageW, 8, 'F');

            y = 50;
            var brandX = marginX;

            doc.setFont('helvetica', 'bold');
            doc.setFontSize(13);
            doc.setTextColor(15, 23, 42);
            doc.text('JIANGNAN HOTPOT', brandX, y - 2);
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(8.5);
            doc.setTextColor(100, 116, 139);
            doc.text('CCTV Command Center | Branch Monitoring & Incident Ticketing', brandX, y + 11);
        }

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(16);
        doc.setTextColor(15, 23, 42);
        doc.text('COMMAND CENTER REPORT', marginX, y + 24);

        // ----- Auto-filled report fields -----
        var rows = [
            ['Subject:', v.subject],
            ['Date/Time of Report:', formatStamp(reportDate(v))],
            ['Store Name:', storeLabel(v.store)],
            ['Date/Time of Incident:', formatStamp(incidentDate(v))],
            ['Report No.:', v.violationNumber || v.id],
            ['Location:', v.location],
            ['Reported By:', v.reportedByName || v.reportedBy]
        ];
        var labelW = 150;
        var valueW = pageW - marginX * 2 - labelW;

        y += 88;
        doc.setFontSize(10.5);
        for (var i = 0; i < rows.length; i++) {
            var label = rows[i][0];
            var value = rows[i][1];
            var lines = doc.splitTextToSize(String(value == null || value === '' ? '—' : value), valueW);
            doc.setFont('helvetica', 'bold');
            doc.setTextColor(51, 65, 85);
            doc.text(label, marginX, y);
            doc.setFont('helvetica', 'normal');
            doc.setTextColor(15, 23, 42);
            lines.forEach(function (line, li) { doc.text(line, marginX + labelW, y + li * 14); });
            y += Math.max(1, lines.length) * 15 + 3;
        }

        // ----- Details of observation -----
        y += 16;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(15, 23, 42);
        doc.text('DETAILS OF OBSERVATION', marginX, y);
        y += 7;
        doc.setDrawColor(203, 213, 225);
        doc.setLineWidth(0.8);
        doc.line(marginX, y, pageW - marginX, y);
        y += 18;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10.5);
        var body = doc.splitTextToSize(String(v.details || '—'), pageW - marginX * 2);
        for (var b = 0; b < body.length; b++) {
            if (y > pageH - 70) { doc.addPage(); y = 60; }
            doc.text(body[b], marginX, y);
            y += 15;
        }

        // ----- Footer -----
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(120, 120, 120);
        doc.text('Generated on ' + formatStamp(new Date()), marginX, pageH - 34);
        doc.text('Jiangnan CCTV Command Center', pageW - marginX, pageH - 34, { align: 'right' });

        return doc.output('blob');
    }

    /**
     * Auto-filled report as a standalone printable HTML document. Used only when
     * jsPDF cannot load (offline / CDN blocked) so the button never dead-ends.
     */
    function printHtml(v) {
        var rows = [
            ['Subject', v.subject],
            ['Date/Time of Report', formatStamp(reportDate(v))],
            ['Store Name', storeLabel(v.store)],
            ['Date/Time of Incident', formatStamp(incidentDate(v))],
            ['Report No.', v.violationNumber || v.id],
            ['Location', v.location],
            ['Reported By', v.reportedByName || v.reportedBy]
        ].map(function (r) {
            return '<tr><th>' + escapeHTML(r[0]) + '</th><td>'
                + escapeHTML(r[1] == null || r[1] === '' ? '—' : r[1]) + '</td></tr>';
        }).join('');

        // Full-bleed banner (end-to-end, no border). If the image cannot load, the
        // onerror hides it and reveals the built-in text-only header instead, so
        // the printable view is never headless.
        var banner = '<img src="' + escapeHTML(HEADER_URL)
            + '" alt="JIANGNAN HOTPOT" style="display:block;width:100%;height:auto;margin:-32px -32px 20px;border:none;" '
            + 'onerror="this.style.display=\'none\';document.getElementById(\'jh-text-header\').style.display=\'block\';">';
        var textHeader = '<div class="bar"></div>'
            + '<h2>JIANGNAN HOTPOT</h2><p class="sub">CCTV Command Center | Branch Monitoring &amp; Incident Ticketing</p>';
        return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>'
            + escapeHTML(fileName(v)) + '</title><style>'
            + 'body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:32px;}'
            + '.bar{height:8px;background:#72bf6a;margin:-32px -32px 18px;}'
            + 'h1{font-size:18px;margin:18px 0 8px;letter-spacing:.5px;}'
            + 'h2{font-size:12px;margin:0 0 2px;}'
            + 'p.sub{margin:0;font-size:11px;color:#64748b;}'
            + 'table{border-collapse:collapse;width:100%;margin:14px 0 18px;}'
            + 'th{text-align:left;width:170px;padding:4px 0;font-size:12px;color:#334155;vertical-align:top;}'
            + 'td{padding:4px 0;font-size:12px;vertical-align:top;}'
            + '.details{white-space:pre-wrap;font-size:12px;line-height:1.6;}'
            + '.foot{margin-top:24px;border-top:1px solid #cbd5e1;padding-top:8px;font-size:10px;color:#64748b;}'
            + '</style></head><body>' + banner
            + '<div id="jh-text-header" style="display:none;">' + textHeader + '</div>'
            + '<h1>COMMAND CENTER REPORT</h1><table>' + rows + '</table>'
            + '<h1 style="font-size:13px;">DETAILS OF OBSERVATION</h1>'
            + '<p class="details">' + escapeHTML(v.details || '—') + '</p>'
            + '<div class="foot">Generated on ' + escapeHTML(formatStamp(new Date()))
            + ' &middot; Jiangnan CCTV Command Center</div></body></html>';
    }

    /** Print the report from a popup window (jsPDF-unavailable fallback). */
    function print(v) {
        var w = global.open('', '_blank', 'width=900,height=1000');
        if (!w) {
            if (typeof global.showToast === 'function') {
                global.showToast('Allow pop-ups for this site to print the report.', 'error');
            }
            return;
        }
        w.document.write(printHtml(v));
        w.document.close();
        w.focus();
        w.print();
    }

    /** Save a blob to the user's Downloads folder. */
    function download(blob, name) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }

    global.ViolationReport = {
        buildPdf: buildPdf,
        printHtml: printHtml,
        print: print,
        fileName: fileName,
        download: download,
        isAvailable: function () { return !!(global.jspdf && global.jspdf.jsPDF); },
        formatStamp: formatStamp,
        storeLabel: storeLabel,
        sanitizeSegment: sanitizeSegment,
        incidentDate: incidentDate,
        reportDate: reportDate
    };
})(window);
