// ===========================================================================
//  AREA MANAGER TICKET FORM (js/owner-ticket-form.js) + the public portal
//
//  WHAT IS ACTUALLY BEING PINNED HERE, and why each one matters:
//
//  1. The payload KEY SET. A ticket document is read field-by-field all over the
//     app: the operator's resolve step reads `requesterAttachments`, the approval
//     email reads `email`, the public Track page reads `branch`/`ticketNumber`/
//     `incident`. Dropping or renaming a key does NOT throw — it silently
//     produces a ticket whose CCTV evidence has vanished. The key list below is
//     compared against what the public form used to write, so the two cannot
//     drift apart.
//  2. BOTH attachment arrays. `attachments` and `requesterAttachments` are
//     written from the same array and BOTH are required. This is the single
//     easiest field to "tidy up" as a duplicate, and doing so breaks operator
//     resolution.
//  3. Branch restriction. The form is offered only the manager's ASSIGNED
//     branches, and a submit re-reads that list rather than trusting the select.
//  4. The public portal survives. submit-ticket.html is now status-only, but the
//     Track modal, the `?track=` deep link and the email portal URL MUST all still
//     work — including the specific regression where removing the Track button
//     silently disabled the deep link, because the deep link was gated on that
//     button existing.
//
//  Run: npm test
// ===========================================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const formJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-ticket-form.js'), 'utf8');
const portalHtml = fs.readFileSync(path.join(ROOT, 'submit-ticket.html'), 'utf8');
const ownerHtml = fs.readFileSync(path.join(ROOT, 'ownerdashboard.html'), 'utf8');
const ownerJs = fs.readFileSync(path.join(ROOT, 'js', 'owner-dashboard.js'), 'utf8');

/**
 * The form source is evaluated AS-IS, comments and all.
 *
 * An earlier version stripped comments first (so that prose merely NAMING an
 * identifier could not be mistaken for code) and that was a mistake twice over:
 * the vm does not care about comments, and the stripper had to be a real
 * string-aware lexer to survive the markup's accept="image/*,video/*..."
 * attribute — a one-character difference between a working test and a
 * mysterious "Invalid or unexpected token". Every assertion below that cares
 * about code reads the RAW source, so the stripper bought nothing.
 */
const formCode = formJs;

console.log('Testing the Area Manager ticket form + the public status portal...');

function makeEl(tag, id) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        id: id || '',
        className: '',
        style: {},
        value: '',
        innerHTML: '',
        textContent: '',
        disabled: false,
        hidden: false,
        files: [],
        options: [],
        children: [],
        _listeners: {},
        _classes: new Set(),
        setAttribute(k, v) { this['attr_' + k] = v; },
        getAttribute(k) { return this['attr_' + k]; },
        addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
        dispatch(type, evt) { (this._listeners[type] || []).forEach((fn) => fn(evt || { preventDefault() {}, target: this })); },
        appendChild(child) { this.children.push(child); return child; },
        focus() { this._focused = true; },
        classList: {
            add(c) { this._el._classes.add(c); },
            remove(c) { this._el._classes.delete(c); },
            toggle(c, on) {
                const el = this._el;
                if (on === undefined ? el._classes.has(c) : !on) el._classes.delete(c);
                else el._classes.add(c);
            },
            contains(c) { return this._el._classes.has(c); }
        },
        querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
        querySelectorAll(sel) {
            // Only the two shapes the form uses: '#id' and '.class'.
            if (sel.startsWith('#')) return this._byId(sel.slice(1));
            if (sel.startsWith('.')) return this._byClass(sel.slice(1));
            return [];
        },
        _byId(want) {
            if (this.id === want) return [this];
            return this.children.reduce((acc, c) => acc.concat(c._byId(want)), []);
        },
        _byClass(want) {
            const mine = this._classes.has(want) ? [this] : [];
            return this.children.reduce((acc, c) => acc.concat(c._byClass(want)), mine);
        },
        reset() { this._resetCalled = true; }
    };
    el.classList._el = el;

    // ⚠️ innerHTML MUST PARSE ON ASSIGNMENT. That is the whole point of
    // innerHTML in a browser: writing it builds a subtree, and the very next
    // line of the form queries that subtree for its fields. A plain data
    // property silently makes every querySelector return null, and the failure
    // surfaces a long way from the cause ("cannot read addEventListener of
    // null") as if the form were broken rather than the stub.
    Object.defineProperty(el, 'innerHTML', {
        get() { return el._html || ''; },
        set(v) { el._html = String(v); el.children = []; parseInto(el, el._html); },
        configurable: true
    });

    return el;
}

/** Parse the subset of HTML the form emits: tags carrying id/class/for. */
function parseInto(el, html) {
    const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)(\/?)>/g;
    const stack = [el];
    let m;
    while ((m = tagRe.exec(html))) {
        const [, closing, tag, attrs, selfClose] = m;
        if (closing) { if (stack.length > 1) stack.pop(); continue; }
        const child = makeEl(tag);
        const idM = /\bid="([^"]*)"/.exec(attrs);
        if (idM) child.id = idM[1];
        const clsM = /\bclass="([^"]*)"/.exec(attrs);
        if (clsM) clsM[1].split(/\s+/).filter(Boolean).forEach((c) => child._classes.add(c));
        stack[stack.length - 1].appendChild(child);
        if (!selfClose && !/^(input|img|br|hr|meta|link)$/i.test(tag)) stack.push(child);
    }
}

/**
 * The sandbox records what the form tried to write, so the payload assertions
 * run against the REAL object rather than a hand-typed copy of it.
 */
function loadForm(opts) {
    opts = opts || {};
    const submitted = [];
    const toasts = [];
    const sandbox = {
        console: console,
        Promise: Promise,
        Date: Date,
        Math: Math,
        JSON: JSON,
        FormData: function () { this.append = function (k, v) { this[k] = v; }; },
        // Deliberately a NO-OP: the deep-link style timers in the form must not
        // fire during a test, and a real setTimeout would make assertions racy.
        setTimeout: function () {},
        auth: opts.auth || { currentUser: { uid: 'am-uid', email: 'manager@jiangnan.ph' } },
        firebase: { firestore: { FieldValue: { serverTimestamp: () => '__SERVER_TS__' } } },
        firestoreService: {
            generateTicketNumber: (branch) => Promise.resolve('bnw-tix' + String(branch).slice(0, 3).toUpperCase() + '099')
        },
        db: {
            collection: () => ({
                doc: (id) => ({
                    set: (data) => { submitted.push({ id, data }); return Promise.resolve(); }
                })
            })
        },
        showToast: (msg, type) => toasts.push({ msg, type }),
        XMLHttpRequest: function () { this.upload = {}; },
        // The form builds its overlay with createElement + innerHTML rather than
        // a markup string in the page, so the stub needs both. setAttribute is
        // what carries the id and the classes the parser then reads back.
        document: (() => {
            const doc = makeEl('document');
            // The overlay is appended to <body>, not to the document itself.
            doc.body = makeEl('body');
            doc.appendChild = function (child) { doc.body.appendChild(child); return child; };
            doc.createElement = function (tag) {
                const el = makeEl(tag);
                const origSet = el.setAttribute.bind(el);
                el.setAttribute = function (k, v) {
                    origSet(k, v);
                    if (k === 'id') el.id = v;
                    if (k === 'class') String(v).split(/\s+/).filter(Boolean)
                        .forEach((c) => el._classes.add(c));
                };
                return el;
            };
            return doc;
        })()
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    if (opts.branches) sandbox.getOwnerAssignedBranches = () => opts.branches;
    if (opts.name !== undefined) sandbox.getOwnerDisplayName = () => opts.name;
    vm.createContext(sandbox);
    vm.runInContext(formCode, sandbox, { filename: 'owner-ticket-form.js' });
    return { sandbox, submitted, toasts };
}

/** Open the modal — that is when the markup is injected and the fields cached. */
function openIn(h) {
    h.sandbox.OwnerTicketForm.open();
    // Setting innerHTML already parsed the tree (see makeEl), so there is
    // nothing to parse here — re-parsing would duplicate every child.
    return h.sandbox.document.body.children[0];
}

const field = (overlay, id) => overlay.querySelector('#' + id);

/** Fill in the minimum a valid ticket needs. */
function fillValid(overlay, over) {
    over = over || {};
    const set = (id, v) => { field(overlay, id).value = v; };
    set('otfBranch', over.branch !== undefined ? over.branch : 'Banawe');
    set('otfPriority', over.priority !== undefined ? over.priority : 'High');
    set('otfName', '  Maria Santos  ');
    set('otfPosition', 'Store Manager');
    set('otfEmail', over.email !== undefined ? over.email : 'maria@jiangnan.ph');
    set('otfContact', '09171234567');
    set('otfDatetime', '2026-09-30T14:30');
    set('otfLocation', 'Cashier 3');
    set('otfIncident', 'Tip Pocketing');
    set('otfDescription', 'Observed on camera 3.');
}

const submit = (overlay) =>
    field(overlay, 'ownerTicketForm').dispatch('submit', { preventDefault() {} });

/** Drain the promise chain the submit handler runs its write in. */
const settle = () => new Promise((r) => setImmediate(r));

// ===========================================================================
console.log('\n=== The payload key set is a CONTRACT, not just data ===');
// ===========================================================================
async function testPayload() {
    const h = loadForm({ branches: ['Banawe', 'SM Fairview'] });
    const overlay = openIn(h);
    fillValid(overlay);
    submit(overlay);
    await settle();

    assert.strictEqual(h.submitted.length, 1,
        'exactly one ticket document must be written per submit. Got: ' + h.submitted.length);

    const { id, data } = h.submitted[0];

    // Each key is named with its CONSUMER, because "this field looked redundant"
    // is exactly how a silent break gets introduced later.
    const REQUIRED = {
        ticketNumber: 'the public Track page + the Approvals tab',
        branch: 'per-branch ticket numbering and every branch filter',
        name: 'the ticket report header',
        position: 'the ticket report header',
        contact: 'the two-factor Track lookup (phone side)',
        email: 'js/email.js — HOW THE REQUESTER IS NOTIFIED',
        datetime: 'the incident date in the report',
        location: 'the incident location in the report',
        incident: 'the ticket title',
        description: 'the report body',
        priority: 'the priority dot and the High/Low resolution notice',
        status: 'the queue',
        attachments: "the report's evidence gallery",
        requesterAttachments: "the OPERATOR's resolve step + footage display",
        createdAt: 'normalizeTicketReport() reads createdAt FIRST for the date'
    };
    Object.keys(REQUIRED).forEach((key) => {
        assert(Object.prototype.hasOwnProperty.call(data, key),
            'the payload MUST contain "' + key + '" (' + REQUIRED[key] + '). A missing key does ' +
            'not error — it produces a silently broken ticket. Present keys: ' +
            Object.keys(data).join(', '));
    });

    assert.strictEqual(id, data.ticketNumber,
        'the document id MUST BE the ticket number — the public Track lookup is an exact ' +
        '.doc(ticketNumber).get(), so any other id makes a filed ticket permanently untrackable');
    assert.strictEqual(data.ticketNumber, 'bnw-tixBAN099',
        'the number must come from firestoreService.generateTicketNumber(branch)');
    assert.strictEqual(data.status, 'Pending', 'a new ticket starts Pending');
    assert.strictEqual(data.approvalStatus, 'pending',
        'a new ticket must NOT be approved. The dashboard list gates on ' +
        'approvalStatus === "approved", so a wrong initial value would either show an ' +
        'unapproved ticket as approved, or hide the ticket forever');
    assert.strictEqual(data.createdAt, '__SERVER_TS__',
        'createdAt must be the SERVER timestamp — the client clock is not trustworthy for ' +
        '"when was this filed"');
    assert.strictEqual(data.filedByUid, 'am-uid',
        'the filing Area Manager must be recorded on the ticket');
    assert.strictEqual(data.filedByEmail, 'manager@jiangnan.ph',
        "the filer's email must be recorded for the audit trail");

    // Whitespace is trimmed on the way IN. A padded branch silently fails the
    // branch filter's exact match, so the ticket would vanish from the list.
    assert.strictEqual(data.name, 'Maria Santos', 'text fields must be trimmed before writing');
    assert.strictEqual(data.branch, 'Banawe', 'the branch must be the raw select value');

    console.log('  PASS  every key its consumers read by name is present');
    console.log('  PASS  the document id IS the ticket number (the Track lookup is exact-match)');
    console.log('  PASS  approvalStatus starts pending — never approved, never missing');
    console.log('  PASS  createdAt is the server timestamp; text is trimmed');
}

// ===========================================================================
console.log('\n=== BOTH attachment arrays, and they are the same evidence ===');
// ===========================================================================
async function testAttachments() {
    const h = loadForm({ branches: ['Banawe'] });
    const overlay = openIn(h);
    fillValid(overlay);

    // Drive a REAL upload through a stubbed XHR that answers like Cloudinary,
    // so the evidence in the payload is produced by the form's own code path
    // rather than being injected into the assertion.
    h.sandbox.XMLHttpRequest = function () {
        const x = this;
        this.upload = {};
        this.open = function () {};
        this.send = function () {
            setImmediate(function () {
                x.status = 200;
                x.responseText = JSON.stringify({
                    secure_url: 'https://res.cloudinary.com/demo/image/upload/cam3.jpg',
                    public_id: 'auto/upload/cam3',
                    resource_type: 'image'
                });
                x.onload();
            });
        };
    };

    const fileInput = field(overlay, 'otfFiles');
    fileInput.files = [{ name: 'cam3.jpg', size: 2048, type: 'image/jpeg' }];
    fileInput.dispatch('change');
    await settle();

    submit(overlay);
    await settle();

    const data = h.submitted[0].data;
    assert.strictEqual(data.attachments.length, 1,
        'the uploaded evidence must reach the payload. Attachments: ' +
        JSON.stringify(data.attachments));
    assert.strictEqual(data.requesterAttachments.length, 1,
        "the OPERATOR's resolve step reads requesterAttachments — with it empty the " +
        'footage the requester uploaded is invisible to the person resolving the ticket');
    assert.deepStrictEqual(data.attachments, data.requesterAttachments,
        'attachments and requesterAttachments must be the SAME evidence. They are written ' +
        'from one array; writing only one of them is the silent break this test exists for');
    assert.strictEqual(data.attachments[0].url,
        'https://res.cloudinary.com/demo/image/upload/cam3.jpg',
        'the stored url must be Cloudinary\'s secure_url, not the local File — a File ' +
        'object serialises to nothing and the evidence is lost on the round trip');
    assert.strictEqual(data.attachments[0].fileName, 'cam3.jpg',
        'the original file name must be stored; it is what the operator sees');

    // The progress bar must be real, which means XHR rather than fetch.
    assert(/xhr\.upload\.onprogress/.test(formJs),
        'the uploader must use XHR, not fetch — fetch has no upload progress event, so the ' +
        'progress bar could only jump 0 to 100 and would lie about a slow 90MB video');

    console.log('  PASS  a real Cloudinary upload reaches BOTH attachment arrays');
    console.log('  PASS  attachments === requesterAttachments (the operator can see the footage)');
    console.log('  PASS  the URL is Cloudinary\'s secure_url, not an unserialisable File');
    console.log('  PASS  the progress bar is XHR-backed, so it is not a fake 0-100 jump');
}

// ===========================================================================
console.log('\n=== Only the manager\'s ASSIGNED branches are offered ===');
// ===========================================================================
async function testBranches() {
    const h = loadForm({ branches: ['Banawe', 'SM Fairview'] });
    const overlay = openIn(h);
    const opts = field(overlay, 'otfBranch');

    const offered = opts.innerHTML;
    assert(/Banawe/.test(offered) && /SM Fairview/.test(offered),
        'the assigned branches must be offered');
    assert(!/Ortigas|Paseo|SM Clark/.test(offered),
        'a branch the manager does not run must NEVER appear as an option. The whole point ' +
        'of moving the form onto the dashboard is that the page already knows their ' +
        'branches. Offerings: ' + offered);

    // A branch with no single obvious answer must NOT be auto-selected: the
    // manager has to choose, and the choice is what the ticket counter keys off.
    assert.strictEqual(opts.value, '',
        'with several branches the select must start unchosen, not default to the first');

    // One branch is not a decision, so it is pre-selected to save a pointless step.
    const single = loadForm({ branches: ['Banawe'] });
    const singleOverlay = openIn(single);
    assert.strictEqual(field(singleOverlay, 'otfBranch').value, 'Banawe',
        'a manager with exactly ONE branch should not have to confirm the only possible answer');

    // ⚠️ With NO branches assigned, submitting must be BLOCKED, not written.
    // An Area Manager whose branch permissions are empty would otherwise file
    // against "" and the ticket would be unfilterable and untrackable.
    const none = loadForm({ branches: [] });
    const noneOverlay = openIn(none);
    fillValid(noneOverlay, { branch: '' });
    submit(noneOverlay);
    await settle();
    assert.strictEqual(none.submitted.length, 0,
        'a manager with no assigned branches must NOT be able to write a ticket');
    assert(/fill in/.test(none.toasts.map((t) => t.msg).join(' ')),
        'the refusal must be explained, not silent. Toasts: ' + JSON.stringify(none.toasts));

    console.log('  PASS  only assigned branches are offered; others are absent entirely');
    console.log('  PASS  a single branch is pre-selected; several are left unchosen');
    console.log('  PASS  no assigned branches => the submit is refused, with a message');
}

// ===========================================================================
console.log('\n=== Full-screen modal: an exit, a scroll, and a dialog contract ===');
// ===========================================================================
async function testModal() {
    const h = loadForm({ branches: ['Banawe'], name: 'Maria Santos' });
    const overlay = openIn(h);

    // ⚠️ ASSERT AGAINST THE RENDERED MARKUP, NOT THE SOURCE. The source is full
    // of prose that NAME tags — "an unqualified <button> defaults to submit" —
    // so counting occurrences in `formJs` counts the COMMENTS too, and a
    // comment about a button reads as a button. The string the browser actually
    // receives is the only honest thing to count.
    const html = overlay.innerHTML;

    // ⚠️ IT IS A STANDARD MODAL AGAIN, LIKE ALL 19 OTHERS. It was briefly a
    // full-screen, page-shaped dialog with a Back arrow: no URL, no history
    // entry, no title bar, and a browser back button that silently did nothing.
    // That is a UI which promises navigation and delivers a dialog, and it was
    // the only full-screen modal and the only modal in the app without a × .
    const container = (html.match(/<div class="modal-container[^"]*"/) || [])[0];
    assert(container, 'the modal container markup must be findable');
    assert(/class="modal-container modal-lg"/.test(container),
        "the form must use the app's STANDARD .modal-container.modal-lg. It is currently: " +
        container);
    assert(!/modal-container--fullscreen/.test(html),
        'modal-container--fullscreen must NOT come back. A full-screen overlay has no URL, no ' +
        'history entry and no title bar, so it reads as navigation while behaving like a ' +
        'dialog — and browser-back does nothing, which is worse than either. Nine fields in ' +
        'two columns fits comfortably in 720px');

    // The overlay is a plain .modal-overlay. `owner-ticket-form-overlay` is
    // RETAINED deliberately as a scoping hook for the rules that are genuinely
    // this form's (16px inputs, .req, the always-visible remove button) —
    // deleting the class would orphan them and leak them to every other modal.
    assert(/overlay\.className = 'modal-overlay owner-ticket-form-overlay'/.test(formJs),
        'the overlay must carry the standard modal-overlay class, plus ' +
        'owner-ticket-form-overlay as a SCOPING HOOK for this form\'s own rules');

    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    // The app's modals scroll the CONTAINER and pin the header with
    // position:sticky, so no override of that is needed or wanted.
    // ⚠️ THIS CHECKS FOR A SCROLLING OVERRIDE, NOT FOR THE ABSENCE OF A RULE.
    // The mobile block legitimately sets .modal-body PADDING to reclaim width
    // on a phone; an earlier version of this assertion banned the rule
    // outright and so failed the moment that padding was added — a test that
    // forbids a good change is a test that gets deleted.
    const bodyRules = css.match(/\.owner-ticket-form-overlay \.modal-body\s*\{[^}]*\}/g) || [];
    bodyRules.forEach((rule) => {
        assert(!/overflow/.test(rule),
            'the modal must NOT override .modal-body SCROLLING. The app\'s modals scroll the ' +
            'container and pin the header with position:sticky; a second scrolling region is ' +
            'one more thing to get wrong, and the full-screen version needed one only because ' +
            'it had disabled the default. (Padding is fine — that is a different property.) ' +
            'Found: ' + rule);
    });

    // ⚠️ ONE EXIT: the app's standard × . A previous version had a Back arrow
    // AND a × — two controls doing the same job in the same strip of chrome,
    // with the Back one promising a return trip the browser would not honour.
    const headerBlock = (html.match(/<div class="modal-header">[\s\S]*?<\/div>/) || [])[0];
    const headerButtons = (headerBlock.match(/<button/g) || []);
    assert.strictEqual(headerButtons.length, 1,
        'the header must contain exactly ONE button. Found ' + headerButtons.length + ' in: ' +
        headerBlock);
    assert(!/ownerTicketFormBack/.test(html),
        'the Back button must NOT come back. This is a dialog, not a page: it has no history ' +
        'entry, so a Back arrow is a control that lies about where it leads');

    const closeTag = (html.match(/<button[^>]*id="ownerTicketFormClose"[^>]*>/) || [])[0];
    assert(/class="modal-close"/.test(closeTag),
        "the close control must reuse the app's .modal-close class, so it looks and behaves " +
        "like the other nineteen. Found: " + closeTag);
    assert(/type="button"/.test(closeTag),
        'the close control must declare type="button". An unqualified <button> defaults to ' +
        'type="submit"; it sits outside the <form> today, but "it happens to be outside a ' +
        'form right now" is not a property worth relying on. Found: ' + closeTag);
    assert(/aria-label="Close"/.test(closeTag),
        'the close control is a bare glyph, so it needs an accessible name. Found: ' + closeTag);

    const resetTag = (html.match(/<button[^>]*id="otfReset"[^>]*>/) || [])[0];
    assert(/type="button"/.test(resetTag),
        'the Clear button must be type="button" too — it is the one control inside the form ' +
        'that must never submit it. Found: ' + resetTag);
    const submitTag = (html.match(/<button[^>]*id="otfSubmit"[^>]*>/) || [])[0];
    assert(/type="submit"/.test(submitTag),
        'the submit button must be type="submit". Found: ' + submitTag);

    // Dialog semantics — a screen reader must be told this is a dialog.
    assert(/role="dialog"/.test(formJs) && /aria-modal="true"/.test(formJs),
        'the modal must be role="dialog" aria-modal="true"; without them it is an unlabelled ' +
        'div and focus escapes into the dashboard behind it');
    assert(/aria-labelledby="ownerTicketFormTitle"/.test(formJs),
        'the dialog must be labelled by its heading');
    assert(/setAttribute\('aria-hidden'/.test(formJs),
        'the overlay must toggle aria-hidden with its active state, so a CLOSED form is not ' +
        'still reachable by a screen reader');

    // Opening and closing, by all three routes.
    assert.strictEqual(h.sandbox.OwnerTicketForm.isOpen(), true, 'open() must open');
    field(overlay, 'ownerTicketFormClose').dispatch('click');
    assert.strictEqual(h.sandbox.OwnerTicketForm.isOpen(), false, 'the close button must close');
    h.sandbox.OwnerTicketForm.open();
    overlay.dispatch('click', { preventDefault() {}, target: overlay });
    assert.strictEqual(h.sandbox.OwnerTicketForm.isOpen(), false, 'a backdrop click must close');
    h.sandbox.OwnerTicketForm.open();
    h.sandbox.document.dispatch('keydown', { key: 'Escape' });
    assert.strictEqual(h.sandbox.OwnerTicketForm.isOpen(), false, 'Escape must close');

    console.log('  PASS  a STANDARD .modal-container.modal-lg, like all 19 others');
    console.log('  PASS  the header holds exactly ONE control, and it is the app close glyph');
    console.log('  PASS  no full-screen class, no Back button, no .modal-body scroll override');
    console.log('  PASS  close, backdrop and Escape all close it');
    console.log('  PASS  role=dialog / aria-modal / aria-labelledby / aria-hidden are all set');
}

// ===========================================================================
console.log('\n=== Required fields, and what is pre-filled ===');
// ===========================================================================
async function testValidation() {
    const h = loadForm({ branches: ['Banawe'], name: 'Maria Santos' });
    const overlay = openIn(h);

    // The name comes from the users doc, the email from the signed-in account.
    assert.strictEqual(field(overlay, 'otfName').value, 'Maria Santos',
        'the reporter name must be pre-filled from the manager\'s profile');
    assert.strictEqual(field(overlay, 'otfEmail').value, 'manager@jiangnan.ph',
        'the email must be pre-filled from auth.currentUser.email — a typo here is the ' +
        'failure that silently produces a ticket nobody can be emailed');
    // It stays EDITABLE: the manager may be filing for someone else.
    assert(!/id="otfEmail"[^>]*\breadonly/.test(formJs),
        'the email field must stay editable — a manager often files on behalf of a requester, ' +
        'and locking the field would send the approval notice to the wrong person');

    // Every required field, blocked one at a time.
    const REQUIRED = ['otfBranch', 'otfName', 'otfEmail', 'otfIncident', 'otfDescription'];
    for (const id of REQUIRED) {
        const g = loadForm({ branches: ['Banawe'], name: 'Maria Santos' });
        const o = openIn(g);
        fillValid(o);
        field(o, id).value = '';
        submit(o);
        await settle();
        assert.strictEqual(g.submitted.length, 0,
            'a ticket with an empty "' + id + '" must NOT be written');
    }

    // A malformed email is worse than a missing one: the requester never learns
    // the ticket exists, and never chases it.
    const bad = loadForm({ branches: ['Banawe'], name: 'Maria Santos' });
    const badOverlay = openIn(bad);
    fillValid(badOverlay, { email: 'maria@' });
    submit(badOverlay);
    await settle();
    assert.strictEqual(bad.submitted.length, 0, 'a malformed email must block the submit');
    assert(bad.toasts.some((t) => /valid email address/.test(t.msg)),
        'the email complaint must NAME the problem, not just say "fill in the fields". ' +
        'Toasts: ' + JSON.stringify(bad.toasts));

    // A missing service must degrade to a message, not a ReferenceError: a throw
    // inside a submit handler leaves the form looking broken with no explanation.
    assert(/typeof firestoreService === 'undefined'/.test(formJs),
        'the service must be probed with typeof, not a bare read — a bare negation ' +
        'throws ReferenceError when the script never loaded, which reads to the manager ' +
        'as a broken form rather than a missing one');

    console.log('  PASS  name and email are pre-filled, and the email stays editable');
    console.log('  PASS  each required field blocks the write when empty');
    console.log('  PASS  a malformed email blocks it, and says why');
    console.log('  PASS  a missing service degrades to a message, not a thrown error');
}

// ===========================================================================
console.log('\n=== A failed write must NOT destroy what the manager typed ===');
// ===========================================================================
async function testFailureKeepsData() {
    const h = loadForm({ branches: ['Banawe'], name: 'Maria Santos' });
    h.sandbox.firestoreService.generateTicketNumber = () => Promise.reject(new Error('offline'));
    const overlay = openIn(h);
    fillValid(overlay);
    submit(overlay);
    await settle();

    assert.strictEqual(h.submitted.length, 0, 'nothing should have been written');
    assert(h.toasts.some((t) => t.type === 'error'),
        'the failure must be reported. Toasts: ' + JSON.stringify(h.toasts));
    assert.strictEqual(field(overlay, 'otfDescription').value, 'Observed on camera 3.',
        'the typed description MUST survive a failed submit. The manager has just written a ' +
        'full incident report; clearing it turns a transient network error into lost work');
    assert.strictEqual(h.sandbox.OwnerTicketForm.isOpen(), true,
        'a failed submit must NOT close the modal — the manager has to be able to press ' +
        'Submit again');
    assert.strictEqual(field(overlay, 'otfSubmit').disabled, false,
        'the submit button must be re-enabled after a failure, or the modal is stuck forever');

    console.log('  PASS  a failed write reports the error and keeps the form open');
    console.log('  PASS  the typed description survives, and Submit is re-enabled');
}

// ===========================================================================
console.log('\n=== The dashboard supplies the form its context (one source of truth) ===');
// ===========================================================================
function testContextBridge() {
    assert(/window\.getOwnerAssignedBranches = function/.test(ownerJs),
        'js/owner-dashboard.js must expose getOwnerAssignedBranches(). The form is a separate ' +
        'file and cannot see this module\'s lexical ownerAssignedBranches binding; having ' +
        'both files re-read the same Firestore docs would be a second source of truth that ' +
        'can drift');
    assert(/return ownerAssignedBranches\.slice\(\);/.test(ownerJs),
        'the bridge must hand over a COPY. Returning the live array would let any consumer ' +
        'mutate the dashboard\'s own state by accident');
    assert(/window\.getOwnerDisplayName = function/.test(ownerJs),
        'js/owner-dashboard.js must expose getOwnerDisplayName() for the same reason');
    // The email is deliberately NOT bridged: the form reads auth.currentUser
    // itself, which is the same source and needs no second copy.
    assert(!/window\.getOwnerEmail\s*=/.test(ownerJs),
        'the email must NOT be bridged — auth.currentUser.email is already the one source, and ' +
        'a bridged copy could disagree with it');

    // Load order is load-bearing: the bridge must be installed before the form
    // runs. The LAST occurrence is the real <script src> — the file also mentions
    // both names in prose, and matching the first mention would be comparing
    // comment text, which proves nothing.
    const dashAt = ownerHtml.lastIndexOf('<script src="js/owner-dashboard.js"');
    const formAt = ownerHtml.lastIndexOf('<script src="js/owner-ticket-form.js"');
    assert(dashAt > -1 && formAt > -1,
        'both scripts must be loaded by ownerdashboard.html. Found dashboard at ' +
        dashAt + ' and form at ' + formAt);
    assert(dashAt < formAt,
        'owner-dashboard.js must load BEFORE owner-ticket-form.js — the dashboard installs the ' +
        'context bridge and owns the +Ticket button that calls OwnerTicketForm.open()');

    // The form must actually USE the bridge, or the bridge is dead code.
    assert(/window\.getOwnerAssignedBranches/.test(formJs),
        'the form must read the branches from the bridge');
    assert(/window\.getOwnerDisplayName/.test(formJs),
        'the form must read the display name from the bridge');

    console.log('  PASS  the dashboard exposes assigned branches + display name, by copy');
    console.log('  PASS  the email is NOT bridged (auth is the single source)');
    console.log('  PASS  owner-dashboard.js loads first; the form consumes the bridge');
}

// ===========================================================================
console.log('\n=== submit-ticket.html is a STATUS PORTAL, and stays alive ===');
// ===========================================================================
function testPublicPortal() {
    // --- What was removed. ---
    assert(!/<form id="ticketForm"/.test(portalHtml),
        'the submission form must be gone from submit-ticket.html — it now lives in the ' +
        'Area Manager dashboard (js/owner-ticket-form.js)');
    assert(!/id="submitAttachmentInput"/.test(portalHtml),
        'the public uploader must be gone with the form; leaving it would keep a second, ' +
        'now-unreachable Cloudinary code path alive to rot');
    assert(!/id="successModal"/.test(portalHtml),
        'the success modal must be gone — only the removed form ever opened it');
    assert(!/id="trackTicketBtn"/.test(portalHtml),
        'the manual "Track Ticket Status" button must be removed');
    assert(!/CLOUDINARY_UPLOAD_PRESET/.test(portalHtml),
        'the Cloudinary config must leave with the form');

    // --- What must NOT have been removed. This is the load-bearing half. ---
    assert(/id="trackModal"/.test(portalHtml),
        'the Track modal must SURVIVE. It is login-free by design: a requester checking on a ' +
        'ticket has no account, so routing them through the dashboard locks them out');
    assert(/id="trackTicketInput"/.test(portalHtml) && /id="trackContactInput"/.test(portalHtml),
        'the two-factor lookup fields must survive — the contact is the second factor and is ' +
        'deliberately never put in the link');
    assert(/id="trackAttachmentViewer"/.test(portalHtml),
        'the attachment lightbox must survive so a requester can actually see their footage');
    assert(/get\('track'\)/.test(portalHtml),
        'the ?track= deep-link reader must survive');

    // ⚠️ THE REGRESSION THIS EXISTS TO CATCH. The deep-link auto-open used to be
    // gated on the Track BUTTON existing:
    //
    //     if (deepLinkedTicketNumber && trackBtn && !deepLinkPrefillDone) {
    //
    // `trackBtn` was only ever a proxy for "the Track flow is on this page".
    // Removing the button — which was supposed to be cosmetic — would have made
    // the deep link stop opening the modal SILENTLY, so every approval email
    // already sent to a requester would have landed on a page with no way in.
    const dlAt = portalHtml.indexOf('===== Deep link (?track=');
    assert(dlAt > -1, 'the ?track= auto-open block must still exist in submit-ticket.html');
    const deepLinkBlock = portalHtml.slice(dlAt, dlAt + 1200);
    assert(
        /if \(deepLinkedTicketNumber && !deepLinkPrefillDone\)/.test(deepLinkBlock),
        'the deep-link auto-open must NOT be gated on the removed track button. If it is, ' +
        'every ?track= link in every email already sent stops opening the Track modal and ' +
        'nothing on the page says why. Found: ' +
        deepLinkBlock.split('\n').filter((l) => l.includes('deepLinkedTicketNumber &&')).join(' | '));
    assert(!/if\s*\(deepLinkedTicketNumber && trackBtn/.test(portalHtml),
        'no deep-link condition may reference trackBtn any more — the element is gone, so the ' +
        'condition is permanently false and the feature is permanently dead');
    assert(!/var trackBtn\s*=/.test(portalHtml),
        'the trackBtn lookup must be removed, not left dangling as a null that reads as a bug');
    // The prefill inside openTrackModal() must survive too, or the deep link
    // opens an empty box and the requester has to type a number they were sent.
    assert(/trackInput\.value = deepLinkedTicketNumber;/.test(portalHtml),
        'the deep link must still PREFILL the ticket number — that is the whole convenience ' +
        'the email link exists to provide');

    // The email portal URL is the whole reason this file still exists.
    const emailJs = fs.readFileSync(path.join(ROOT, 'js', 'email.js'), 'utf8');
    const emailConfig = fs.readFileSync(path.join(ROOT, 'js', 'email-config.js'), 'utf8');
    assert(/submit-ticket\.html/.test(emailJs) || /submit-ticket\.html/.test(emailConfig),
        'js/email.js must still point requesters at submit-ticket.html. Renaming the page ' +
        'would break every approval link already in someone\'s inbox');
    assert(/track=/.test(emailJs) || /track=/.test(emailConfig),
        'the approval email must still carry the ?track= deep link');

    // The page must be reachable WITHOUT a login — it is the public portal, and
    // that is easy to break by accident when tightening the login gate.
    const guardTest = fs.readFileSync(path.join(ROOT, 'test', 'auth-guard.test.js'), 'utf8');
    assert(/submit-ticket\.html/.test(guardTest),
        'the login-gate test must still know about submit-ticket.html — it is the page that ' +
        'must stay reachable without a session');

    console.log('  PASS  the form, its uploader, the success modal and the Track button are gone');
    console.log('  PASS  the Track modal, its two-factor fields and the lightbox survive');
    console.log('  PASS  ?track= auto-open is no longer gated on the removed button');
    console.log('  PASS  the email portal URL and ?track= link are unchanged');
    console.log('  PASS  the page stays reachable without a login');
}

// ===========================================================================
console.log('\n=== Upload limits match the form they replaced ===');
// ===========================================================================
function testUploadLimits() {
    // Same Cloudinary account and preset, so evidence the public form accepted is
    // still accepted here. The config now lives in TWO places (script.js and
    // owner-ticket-form.js) — if the account or preset is ever rotated, both
    // must change together.
    const scriptJs = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
    const grab = (src) => {
        const m = src.match(/CLOUDINARY_CLOUD_NAME\s*=\s*'([^']+)'[\s\S]*?CLOUDINARY_UPLOAD_PRESET\s*=\s*'([^']+)'/);
        assert(m, 'Cloudinary config not found');
        return { cloud: m[1], preset: m[2] };
    };
    assert.deepStrictEqual(grab(formJs), grab(scriptJs),
        'the form and script.js must use the SAME Cloudinary cloud and preset. Two different ' +
        'accounts means evidence uploaded from the dashboard lands somewhere the operator ' +
        'never looks');

    assert(/MAX_ATTACHMENT_SIZE_MB = 100/.test(formJs),
        'the 100MB cap must be preserved — it was the limit the public form enforced');
    // The same file types, or a requester who could attach a file yesterday is
    // now told their evidence is unsupported.
    ['image/jpeg', 'video/mp4', 'application/pdf', 'application/zip'].forEach((t) => {
        assert(new RegExp("'" + t.replace('/', '\\/') + "'").test(formJs),
            'the allowed attachment types must still include ' + t);
    });

    console.log('  PASS  the same Cloudinary cloud + preset as script.js');
    console.log('  PASS  the 100MB cap and the accepted file types are preserved');
}

// ===========================================================================
console.log('\n=== Mobile: the modal must survive a real phone ===');
// ===========================================================================
function testMobile() {
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    const block = css.slice(css.indexOf('/*  AREA MANAGER TICKET FORM'),
        css.indexOf('/*  SEGMENTED BUTTON GROUP'));
    // ⚠️ EVERY PROPERTY GREP BELOW RUNS AGAINST COMMENTS-STRIPPED CSS. The
    // block is largely a note explaining that 100dvh, safe-area-inset and the
    // landscape query were REMOVED and why — so searching the raw text for
    // those names matches the explanation of their absence. A check that cannot
    // tell "the rule is gone" from "someone wrote a paragraph saying the rule is
    // gone" reports the second as the first, which is worse than no check.
    const rules = block.replace(/\/\*[\s\S]*?\*\//g, '');
    const mobileRules = rules.slice(rules.indexOf('@media (max-width: 640px)'));

    // ⚠️ EVERY ASSERTION IN HERE SURVIVES THE FULL-SCREEN REMOVAL, because each
    // one fixes a failure that happens at ANY container size. What did NOT
    // survive — and is asserted ABSENT below — existed only to fight the
    // viewport: dvh, safe-area insets, the landscape block, and a stacked
    // .form-actions. A centred 90vh modal already sits inside the safe area and
    // already scrolls, so carrying them was dead weight.

    // ⚠️ iOS zooms the page in when a focused input computes below 16px. The base
    // rule is 0.9rem, which is 14.4px and under the threshold.
    const inputRule = mobileRules.match(
        /\.owner-ticket-form-overlay \.form-group input[\s\S]*?\{[^}]*\}/);
    assert(inputRule, 'the mobile input rule must exist');
    assert(/font-size:\s*16px/.test(inputRule[0]),
        'form inputs must be 16px on a phone, not the base 0.9rem. iOS Safari zooms the page ' +
        'in on a focused input under 16px, which on a fixed overlay also pulls the modal out ' +
        'of alignment with the screen. Found: ' + inputRule[0]);

    // Touch targets. 44px is the smallest reliably tappable box (WCAG 2.5.5).
    assert(/min-height:\s*44px/.test(inputRule[0]),
        'inputs need a 44px minimum height on a phone. Found: ' + inputRule[0]);

    // ⚠️ 44px IS THE FLOOR, NOT THE CEILING — and it is deliberately NOT being
    // reduced. "Make the textboxes smaller" was the complaint, and the honest
    // answer is that a 40px text field is worse one-handed in a store, and is
    // below the platform's own default. What was too big was the CHROME AROUND
    // the inputs. These assertions pin the density cuts so they are not undone
    // by someone "tidying" the block back to the desktop values.
    const bodyRule = mobileRules.match(
        /\.owner-ticket-form-overlay \.modal-body\s*\{[^}]*\}/);
    assert(bodyRule && /padding:\s*14px/.test(bodyRule[0]),
        ".modal-body must shrink to 14px on a phone. The shared rule is 24px, which on a " +
        '390px screen leaves only ~311px of usable field width inside a 92%-wide modal. ' +
        'Found: ' + (bodyRule ? bodyRule[0] : 'no rule'));
    const headerRule = mobileRules.match(
        /\.owner-ticket-form-overlay \.modal-header\s*\{[^}]*\}/);
    assert(headerRule && /padding:\s*12px 14px/.test(headerRule[0]),
        '.modal-header must shrink to 12px 14px on a phone. The shared 20px 24px makes a ' +
        '~68px title bar, which is a lot of a short screen spent on chrome. ' +
        'Found: ' + (headerRule ? headerRule[0] : 'no rule'));
    assert(/\.form-group\s*\{[^}]*margin-bottom:\s*12px/.test(mobileRules),
        '.form-group margin must drop to 12px on a phone (the shared rule is 18px, across ' +
        'ten groups). Found: ' + (mobileRules.match(/\.form-group\s*\{[^}]*\}/) || ['none'])[0]);
    assert(/\.form-group textarea\s*\{[^}]*min-height:\s*90px/.test(mobileRules),
        'the description textarea must be 90px on a phone, not the 110px it was — a ' +
        'textarea does not need to be a comfortable typing target. Found: ' +
        (mobileRules.match(/\.form-group textarea\s*\{[^}]*\}/) || ['none'])[0]);
    assert(/upload-dropzone\s*\{[^}]*padding:\s*14px 12px/.test(mobileRules),
        'the dropzone padding must shrink on a phone (22px 16px). It is reached through the ' +
        'file picker, not tapped precisely, so its padding is pure cost. Found: ' +
        (mobileRules.match(/upload-dropzone\s*\{[^}]*\}/) || ['none'])[0]);

    // A 720px modal on a 360px phone leaves ~160px per field in a two-column
    // row — too narrow to read a branch name, let alone pick one.
    assert(/\.form-row\s*\{[^}]*grid-template-columns:\s*1fr/.test(mobileRules),
        '.form-row must collapse to one column under 640px. A 720px modal on a 360px phone ' +
        'leaves ~160px per field, which is too narrow to read a branch name in.');

    // The remove control is opacity:0 until hover, which a touch device never has.
    assert(/\.otf-remove-always\s*\{[^}]*opacity:\s*1/.test(rules),
        'the attachment remove button must always be visible. `.attachment-remove` is ' +
        'opacity:0 until hover, and a phone has no hover — the control would be unreachable');

    // ⚠️ These four existed ONLY to make a full-screen overlay clear the browser
    // chrome. Asserted absent so nobody re-adds them to a centred modal, where
    // they are redundant and each one is another thing to get wrong.
    assert(!/100dvh/.test(rules),
        'no 100dvh. It existed to size a full-screen overlay to the visible viewport; a ' +
        'centred .modal-container already has max-height:90vh from the shared stylesheet');
    assert(!/safe-area-inset/.test(rules),
        'no safe-area insets. They existed to lift a full-screen overlay clear of the notch ' +
        'and the home indicator. A centred 90vh modal sits inside the safe area already, and ' +
        'every env() is another declaration that can be invalid on an older browser');
    assert(!/@media \(max-height:/.test(rules),
        'no short-viewport block. It shrank the header and action row for landscape, which ' +
        'only a full-screen overlay needed; a centred modal simply scrolls');
    // ⚠️ THE POINT IS THE FLEX DIRECTION, NOT THE ABSENCE OF THE RULE. The
    // mobile block legitimately tightens .form-actions margins; only the
    // stacking is forbidden. Same trap as the .modal-body check above — a rule
    // that bans a whole selector starts failing the moment someone makes a
    // good change to an unrelated property on it.
    const actionsRule = (mobileRules.match(/\.form-actions\s*\{[^}]*\}/g) || []).join(' | ');
    assert(!/flex-direction/.test(actionsRule),
        '.form-actions must NOT be restacked. Clear and Submit are short labels and sit ' +
        'comfortably side by side at any width; stacking them made the PRIMARY action harder ' +
        'to find, not easier. (Margins are fine — only flex-direction is forbidden.) ' +
        'Found: ' + (actionsRule || 'no rule'));

    // ⚠️ Autofocus must not summon the software keyboard on a phone: it covers
    // half the form and scrolls the header out of view.
    const openBody = formJs.slice(formJs.indexOf('function open()'),
        formJs.indexOf('function close()'));
    assert(/innerWidth\s*<=\s*640/.test(openBody),
        'open() must detect a narrow viewport');
    assert(/if \(!isNarrow && !singleBranch && els\.branch\.focus\)/.test(openBody),
        'on a narrow screen open() must NOT focus a field. Focusing a text input raises the ' +
        'software keyboard immediately, which covers the form. Found: ' +
        openBody.slice(openBody.indexOf('isNarrow')));

    // ⚠️⚠️ THIS IS THE TEST FOR THE ACTUAL BUG THAT WAS SHIPPED. The block above
    // was once introduced with its opening slash-star MISSING, which made the CSS
    // parser discard every declaration from that point to the next `{`. The
    // modal silently fell back to .modal-container's defaults and nothing
    // failed — no error, no console warning, no broken test. A CSS comment typo
    // is invisible unless something checks, and it erases NEIGHBOURING rules
    // rather than its own, which is what made it expensive.
    let depth = 0;
    for (let i = 0; i < css.length; i++) {
        if (css[i] === '/' && css[i + 1] === '*') { depth++; i += 2; }
        else if (css[i] === '*' && css[i + 1] === '/') { depth--; i += 2; }
    }
    assert.strictEqual(depth, 0,
        'style.css has ' + depth + ' UNTERMINATED block comment(s). An unterminated comment ' +
        'makes the parser swallow every rule until the next `{` — the rules still look ' +
        'correct in the source but are silently never applied. This is exactly how the ' +
        'ticket form once rendered with no full-screen styling and no error anywhere');

    console.log('  PASS  inputs are 16px and 44px tall (no iOS zoom, thumb-sized)');
    console.log('  PASS  density cuts: body 14px, header 12px, gaps 12px, textarea 90px');
    console.log('  PASS  .form-row collapses to one column; remove buttons always visible');
    console.log('  PASS  no dvh / safe-area / landscape / stacked-actions leftovers');
    console.log('  PASS  open() does not autofocus on a phone (no keyboard over the form)');
    console.log('  PASS  every block comment in style.css is closed');
}


// ===========================================================================
console.log('\n=== Rules: creation is authenticated, the portal read stays open ===');
// ===========================================================================
function testRules() {
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    const block = rules.slice(rules.indexOf('match /tickets/{ticketId}'),
        rules.indexOf('// ---------------- violations'));

    // With the public form gone, `if true` on create means anyone on the
    // internet can write unlimited documents into tickets.
    // ⚠️ MATCH TO END-OF-LINE, NOT TO THE NEXT SEMICOLON. These rules are
    // heavily commented, and the comment above this one contains a semicolon
    // (`...not a formality: with X, anyone...`). A `[^;]*` match therefore runs
    // backwards through the PROSE and reports a rule that does not exist,
    // which is a test that fails for a reason that has nothing to do with the
    // code. Anchoring on a line that starts with `allow` is unambiguous.
    const allowLines = block.split('\n')
        .map((l) => l.trim())
        .filter((l) => /^allow\b/.test(l));
    const createRules = allowLines.filter((l) => /^allow create\b/.test(l));
    assert(createRules.length === 1,
        'expected exactly ONE `allow create` in the tickets block, so the assertion below is ' +
        'about the real rule and not one of several. Found: ' + allowLines.join(' | '));
    assert(/^allow create: if isSignedIn\(\);$/.test(createRules[0]),
        'ticket creation must require a session. The form is now inside the dashboard, so ' +
        'the "anyone may file" exemption no longer has a caller — and with it open, anyone ' +
        'could flood the collection and drive up the Cloudinary bill. Found: ' + createRules[0]);

    // ⚠️ The READ rule must stay open to approved tickets. The Track modal is
    // login-free on purpose — a requester checking their own ticket is not an
    // employee and has no account. "Tidying" this into isSignedIn() would lock
    // every requester out of the ticket they just filed, with no error message,
    // because the deep link would simply render nothing.
    assert(allowLines.indexOf(
        "allow read: if isSignedIn() || resource.data.approvalStatus == 'approved';") > -1,
        'the read rule must STILL let the login-free Track lookup read APPROVED tickets. A ' +
        'requester is not an employee and has no account; making this auth-only would lock ' +
        'them out of their own ticket with no error shown. Found: ' + allowLines.join(' | '));

    assert(allowLines.indexOf('allow delete: if isSuperAdmin();') > -1,
        'ticket deletion must stay superadmin-only. Found: ' + allowLines.join(' | '));
    assert(allowLines.indexOf('allow update: if true;') > -1,
        'the public "Request Additional Footage" flow still updates a ticket without a ' +
        'login, so update must stay open — it carries a TODO and is out of scope here. ' +
        'Found: ' + allowLines.join(' | '));

    console.log('  PASS  ticket creation requires a session (the public form is gone)');
    console.log('  PASS  the approved-ticket READ stays open — the Track portal is login-free');
    console.log('  PASS  delete stays superadmin-only; the public update keeps its TODO');
}

// ===========================================================================
console.log('\n=== Running the suites ===');
// ===========================================================================
(async function run() {
    await testPayload();
    await testAttachments();
    await testBranches();
    await testModal();
    await testValidation();
    await testFailureKeepsData();
    testContextBridge();
    testPublicPortal();
    testUploadLimits();
    testMobile();
    testRules();

    console.log('\n\u00d7 Ticket form tests passed (exact payload key set; BOTH attachment arrays ' +
        'written from one real upload; assigned-branch restriction including the blocked ' +
        'empty-permissions case; a STANDARD .modal-container.modal-lg with a single close, ' +
        'matching all nineteen other modals — with guards against the full-screen / ' +
        'Back-button version creeping back; pre-filled but ' +
        'editable identity; required-field and email validation; a failed write that keeps the ' +
        'manager\'s typed report; the dashboard context bridge and its load order; ' +
        'submit-ticket.html reduced to a status portal with the ?track= deep link, the ' +
        'two-factor lookup and the email portal URL all intact — including the specific ' +
        'regression where removing the Track button would have silently killed every deep ' +
        'link already sent by email; upload limits unchanged; and the mobile rules that ' +
        'survive at any container size — 16px inputs, 44px targets, one-column rows, no ' +
        'autofocus keyboard — with the full-screen-only ones asserted ABSENT).');
})().catch((err) => {
    console.error('\n\u00d7 Ticket form tests FAILED\n');
    console.error(err && err.message ? err.message : err);
    process.exit(1);
});
