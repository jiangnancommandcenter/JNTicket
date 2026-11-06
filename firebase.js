/**
 * Firebase Configuration & Initialization
 * Unified for Branch Monitoring + Ticket System
 * Uses Firebase v8 Compatibility SDK
 */

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyD3R9VtLbqPxPlKXn5QBRdyiwPOrGRdDRE",
  authDomain: "jn-data-f29ae.firebaseapp.com",
  projectId: "jn-data-f29ae",
  storageBucket: "jn-data-f29ae.firebasestorage.app",
  messagingSenderId: "1067159087911",
  appId: "1:1067159087911:web:9157cb14590a382a4a1702",
  measurementId: "G-HR7CJLT7H3"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Initialize Firestore
const db = firebase.firestore();

// Initialize Auth
const auth = firebase.auth();

// Enable offline persistence (wrapped to avoid INTERNAL ASSERTION FAILED in v8.10.1)
try {
    db.enablePersistence()
        .catch(function(err) {
            if (err.code === 'failed-precondition') {
                console.warn('Firebase persistence failed: Multiple tabs open');
            } else if (err.code === 'unimplemented') {
                console.warn('Firebase persistence not supported in this browser');
            } else {
                console.warn('Firebase persistence error (non-critical):', err);
            }
        });
} catch (e) {
    console.warn('Firebase persistence skipped:', e.message);
}

// ==============================================================
// FIRESTORE UTILITY FUNCTIONS
// ==============================================================

// ==============================================================
// TICKET NUMBER PREFIXES (single source of truth)
// ==============================================================

const BRANCH_CODES = {
    "Banawe": "bnw", "BF Homes": "bf", "Eastwood": "estw",
    "Fame": "fame", "Gil Fernando": "gilf", "Hemady": "hmdy",
    "Holy Spirit": "hspi", "MOA": "moa", "Ortigas Center": "ortc",
    "Paseo": "pseo", "Promenade": "prme", "SM Clark": "smc",
    "SM Fairview": "smf", "SM Marikina": "smmk", "SM Marilao": "smml",
    "SM South Mall": "smsm", "SMDC Wind": "smwd", "SM East Ortigas": "smeo",
    "Sta. Rosa": "str", "SM Sucat": "smsu", "Tagaytay": "tag"
};

/**
 * Map a branch name to its ticket-number prefix. Single source of truth for
 * both the transactional generator and any public submission forms.
 */
function branchToPrefix(branch) {
    if (!branch) return '';
    return BRANCH_CODES[branch] || branch.toLowerCase().substring(0, 3);
}
window.branchToPrefix = branchToPrefix;
window.BRANCH_CODES = BRANCH_CODES;

const firestoreService = {
    // ===== BRANCH MONITORING =====

    /**
     * Get all branches
     */
    async getBranches(options = {}) {
        // `options.source: 'cache'` reads Firestore's offline cache (persistence)
        // for an instant, network-free first paint; omit it to fetch from the
        // server exactly as before.
        const snapshot = options.source
            ? await db.collection('branches').get({ source: options.source })
            : await db.collection('branches').get();
        const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        results.sort((a, b) => (a.branchName || '').localeCompare(b.branchName || ''));
        return results;
    },

    /**
     * Update or create a branch document
     */
    async setBranch(branchName, data) {
        const docRef = db.collection('branches').doc(branchName);
        await docRef.set({
            branchName,
            ...data,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    },

    /**
     * Delete a branch document
     */
    async deleteBranch(branchName) {
        await db.collection('branches').doc(branchName).delete();
    },

    /**
     * Get status logs for a specific branch
     */
    async getBranchLogs(branchName) {
        const snapshot = await db.collection('status_logs')
            .where('branchName', '==', branchName)
            .get();
        const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        results.sort((a, b) => {
            const aTime = a.dateTime?.toDate?.()?.getTime() || 0;
            const bTime = b.dateTime?.toDate?.()?.getTime() || 0;
            return bTime - aTime;
        });
        return results;
    },

    /**
     * Get all status logs
     */
    async getAllLogs(options = {}) {
        // `options.source: 'cache'` for an instant network-free first paint;
        // omit it to fetch from the server exactly as before.
        const snapshot = options.source
            ? await db.collection('status_logs').get({ source: options.source })
            : await db.collection('status_logs').get();
        const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        results.sort((a, b) => {
            const aTime = a.dateTime?.toDate?.()?.getTime() || 0;
            const bTime = b.dateTime?.toDate?.()?.getTime() || 0;
            return bTime - aTime;
        });
        return results;
    },

    /**
     * Add a new status log entry
     */
    async addStatusLog(data) {
        const docRef = await db.collection('status_logs').add({
            branchName: data.branchName,
            status: data.status,
            dateTime: firebase.firestore.Timestamp.fromDate(new Date(data.dateTime)),
            remarks: data.remarks || '',
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        return docRef.id;
    },

    /**
     * Update an existing status log entry
     */
    async updateStatusLog(logId, data) {
        await db.collection('status_logs').doc(logId).update({
            branchName: data.branchName,
            status: data.status,
            dateTime: firebase.firestore.Timestamp.fromDate(new Date(data.dateTime)),
            remarks: data.remarks || '',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    },

    /**
     * Delete a status log entry
     */
    async deleteStatusLog(logId) {
        await db.collection('status_logs').doc(logId).delete();
    },

    /**
     * Get logs for a branch within a date range
     */
    async getBranchLogsInRange(branchName, startDate, endDate) {
        const snapshot = await db.collection('status_logs')
            .where('branchName', '==', branchName)
            .get();
        const startTime = startDate.getTime();
        const endTime = endDate.getTime();

        let results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        results = results.filter(log => {
            const logTime = log.dateTime?.toDate?.()?.getTime() || 0;
            return logTime >= startTime && logTime <= endTime;
        });
        results.sort((a, b) => {
            const aTime = a.dateTime?.toDate?.()?.getTime() || 0;
            const bTime = b.dateTime?.toDate?.()?.getTime() || 0;
            return aTime - bTime;
        });
        return results;
    },

    // ===== TICKET SYSTEM =====

    /**
     * Get all tickets ordered by createdAt descending
     */
    async getTickets() {
        const snapshot = await db.collection('tickets').get();
        const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        results.sort((a, b) => {
            const aTime = a.createdAt?.toDate?.()?.getTime() || 0;
            const bTime = b.createdAt?.toDate?.()?.getTime() || 0;
            return bTime - aTime;
        });
        return results;
    },

    /**
     * Add (or set) a ticket document
     */
    async setTicket(ticketId, data) {
        await db.collection('tickets').doc(ticketId).set(data, { merge: true });
    },

    /**
     * Update specific fields of a ticket
     */
    async updateTicket(ticketId, data) {
        await db.collection('tickets').doc(ticketId).update({
            ...data,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    },

    /**
     * Delete a ticket
     */
    async deleteTicket(ticketId) {
        await db.collection('tickets').doc(ticketId).delete();
    },

    /**
     * Listen to real-time ticket updates
     */
    listenTickets(callback, onError = null) {
        return db.collection('tickets').onSnapshot(
            (snapshot) => {
                const tickets = [];
                snapshot.forEach((doc) => {
                    tickets.push({ id: doc.id, ...doc.data() });
                });
                tickets.sort((a, b) => {
                    const aTime = a.createdAt?.toDate?.()?.getTime() || 0;
                    const bTime = b.createdAt?.toDate?.()?.getTime() || 0;
                    return bTime - aTime;
                });
                callback(tickets, snapshot.docChanges());
            },
            (error) => {
                console.error('🔥 Firestore ticket listener error:', error);
                if (onError) onError(error);
            }
        );
    },

    // ===== VIOLATIONS REPORT (CCTV monitoring — operator & superadmin only) =====

    /**
     * Get all violation reports ordered by createdAt descending
     */
    async getViolations() {
        const snapshot = await db.collection('violations').get();
        const results = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        results.sort((a, b) => {
            const aTime = a.createdAt?.toDate?.()?.getTime() || 0;
            const bTime = b.createdAt?.toDate?.()?.getTime() || 0;
            return bTime - aTime;
        });
        return results;
    },

    /**
     * Add a new violation report document
     */
    async addViolation(data) {
        const docRef = await db.collection('violations').add({
            ...data,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        return docRef.id;
    },

    /**
     * Update specific fields of a violation report
     */
    async updateViolation(violationId, data) {
        await db.collection('violations').doc(violationId).update({
            ...data,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    },

    /**
     * Delete a violation report
     */
    async deleteViolation(violationId) {
        await db.collection('violations').doc(violationId).delete();
    },

    /**
     * Listen to real-time violation report updates
     */
    listenViolations(callback, onError = null) {
        return db.collection('violations').onSnapshot(
            (snapshot) => {
                const violations = [];
                snapshot.forEach((doc) => {
                    violations.push({ id: doc.id, ...doc.data() });
                });
                violations.sort((a, b) => {
                    const aTime = a.createdAt?.toDate?.()?.getTime() || 0;
                    const bTime = b.createdAt?.toDate?.()?.getTime() || 0;
                    return bTime - aTime;
                });
                callback(violations, snapshot.docChanges());
            },
            (error) => {
                console.error('🔥 Firestore violations listener error:', error);
                if (onError) onError(error);
            }
        );
    },

    // ===== HR HANDOFF =====
    // A superadmin reviews each report and, when the violation is worth an
    // incident report, hands it to HR by stamping `hrStatus: 'transferred'`
    // on the SAME document. Nothing is copied and nothing is deleted: the
    // report stays in the command center list and simply becomes readable by
    // HR as well. That is why HR can still print the same PDF from their own
    // dashboard.

    /**
     * Listen ONLY to the reports a superadmin has transferred to HR.
     *
     * ⚠️ The `where()` is REQUIRED, not an optimisation. firestore.rules grants
     * HR read access per-document via `resource.data.hrStatus == 'transferred'`,
     * and Firestore will only run a query whose constraints it can prove against
     * the rule. An unfiltered query from HR is therefore DENIED — which is
     * exactly the privacy guarantee we want.
     *
     * A single equality filter on one field needs no composite index, so this
     * works on the Spark (free) plan.
     */
    listenTransferredViolations(callback, onError = null) {
        return db.collection('violations')
            .where('hrStatus', '==', 'transferred')
            .onSnapshot(
                (snapshot) => {
                    const violations = [];
                    snapshot.forEach((doc) => {
                        violations.push({ id: doc.id, ...doc.data() });
                    });
                    // Newest transfer first when timestamps tie, then newest
                    // filing date — the list is sorted again by the HR view.
                    violations.sort((a, b) => {
                        const aTime = a.createdAt?.toDate?.()?.getTime() || 0;
                        const bTime = b.createdAt?.toDate?.()?.getTime() || 0;
                        return bTime - aTime;
                    });
                    callback(violations, snapshot.docChanges());
                },
                (error) => {
                    console.error('🔥 Firestore transferred-violations listener error:', error);
                    if (onError) onError(error);
                }
            );
    },

    /**
     * Hand one report to HR. Superadmin-only in practice (firestore.rules
     * allows update only to a superadmin or the reporting operator).
     */
    async transferViolationToHr(violationId, byEmail, byName) {
        await db.collection('violations').doc(violationId).update({
            hrStatus: 'transferred',
            transferredAt: firebase.firestore.FieldValue.serverTimestamp(),
            transferredBy: byEmail || null,
            transferredByName: byName || null,
            // Cleared so a later re-transfer does not show a stale revert time.
            revertedAt: firebase.firestore.FieldValue.delete(),
            revertedBy: firebase.firestore.FieldValue.delete(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    },

    /**
     * Take a report back off HR's list. `hrStatus` is DELETED rather than set
     * to some other value so the document matches its original shape again and
     * the rules treat it exactly like every pre-handoff report.
     */
    async revertViolationTransfer(violationId, byEmail, byName) {
        await db.collection('violations').doc(violationId).update({
            hrStatus: firebase.firestore.FieldValue.delete(),
            transferredAt: firebase.firestore.FieldValue.delete(),
            transferredBy: firebase.firestore.FieldValue.delete(),
            transferredByName: firebase.firestore.FieldValue.delete(),
            revertedAt: firebase.firestore.FieldValue.serverTimestamp(),
            revertedBy: byEmail || null,
            revertedByName: byName || null,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    },

    // ===== AREA MANAGER HANDOFF =====
    // Identical shape to the HR handoff above but stamped on `managerStatus` /
    // `managerTransferred*` instead of `hrStatus` / `transferred*`.
    //
    // ⚠️ WHY SEPARATE FIELDS RATHER THAN ONE SHARED `hrStatus`. The two handoffs
    // are INDEPENDENT: a superadmin can send a report to HR, to an Area
    // Manager, or to both. Reusing one field would make the second transfer
    // silently revoke the first, and reverting one would revoke the other — the
    // two lists would be impossible to hold at the same time.
    //
    // Nothing is copied or deleted here either: the report stays in the command
    // center list and simply becomes readable by Area Managers as well.

    /**
     * Listen ONLY to the reports a superadmin has transferred to an Area Manager.
     *
     * ⚠️ The `where()` is REQUIRED, for the same reason the HR listener needs
     * one: firestore.rules grants the `owner` role read access per-document via
     * `resource.data.managerStatus == 'transferred'`, and Firestore will only
     * run a query whose constraints it can prove against the rule. An unfiltered
     * query from an Area Manager is therefore DENIED — which is the guarantee,
     * not a bug.
     *
     * A single equality filter on one field needs no composite index, so this
     * works on the Spark (free) plan.
     *
     * ⚠️ THIS RETURNS EVERY MANAGER-TRANSFERRED REPORT, NOT ONLY THE READER'S
     * BRANCHES. Branch scoping happens in js/owner-violations.js, because the
     * branch list lives on the user's document and a query cannot constrain it
     * (see the long note above `allow read` in firestore.rules).
     */
    listenTransferredViolationsForAreaManager(callback, onError = null) {
        return db.collection('violations')
            .where('managerStatus', '==', 'transferred')
            .onSnapshot(
                (snapshot) => {
                    const violations = [];
                    snapshot.forEach((doc) => {
                        violations.push({ id: doc.id, ...doc.data() });
                    });
                    violations.sort((a, b) => {
                        const aTime = a.managerTransferredAt?.toDate?.()?.getTime() || 0;
                        const bTime = b.managerTransferredAt?.toDate?.()?.getTime() || 0;
                        // Newest transfer first when the timestamps tie, then fall
                        // back to the filing date.
                        if (bTime !== aTime) return bTime - aTime;
                        const aFile = a.createdAt?.toDate?.()?.getTime() || 0;
                        const bFile = b.createdAt?.toDate?.()?.getTime() || 0;
                        return bFile - aFile;
                    });
                    callback(violations, snapshot.docChanges());
                },
                (error) => {
                    console.error('🔥 Firestore manager-violations listener error:', error);
                    if (onError) onError(error);
                }
            );
    },

    /**
     * Hand one report to an Area Manager. Superadmin-only in practice
     * (firestore.rules allows update only to a superadmin or the reporting
     * operator — the `owner` role gets no write access at all).
     */
    async transferViolationToAreaManager(violationId, byEmail, byName) {
        await db.collection('violations').doc(violationId).update({
            managerStatus: 'transferred',
            managerTransferredAt: firebase.firestore.FieldValue.serverTimestamp(),
            managerTransferredBy: byEmail || null,
            managerTransferredByName: byName || null,
            // Cleared so a later re-transfer does not show a stale revert time.
            managerRevertedAt: firebase.firestore.FieldValue.delete(),
            managerRevertedBy: firebase.firestore.FieldValue.delete(),
            // Clear any stale expiry stamps from a previous transfer cycle so the
            // Area Manager gets a fresh 1-minute timer when they open the report.
            managerExpiresAt: firebase.firestore.FieldValue.delete(),
            managerExpiresAtMs: firebase.firestore.FieldValue.delete(),
            managerOpenedAt: firebase.firestore.FieldValue.delete(),
            managerOpenedBy: firebase.firestore.FieldValue.delete(),
            managerOpenedByName: firebase.firestore.FieldValue.delete(),
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    },

    /**
     * Take a report back off the Area Manager's list. `managerStatus` is DELETED
     * rather than set to another value, so the document matches its original
     * shape again and the rules treat it like every pre-handoff report.
     *
     * This touches ONLY the manager* fields — an HR transfer on the same report
     * is untouched.
     */
    async revertViolationTransferFromAreaManager(violationId, byEmail, byName) {
        await db.collection('violations').doc(violationId).update({
            managerStatus: firebase.firestore.FieldValue.delete(),
            managerTransferredAt: firebase.firestore.FieldValue.delete(),
            managerTransferredBy: firebase.firestore.FieldValue.delete(),
            managerTransferredByName: firebase.firestore.FieldValue.delete(),
            // Clean up expiry stamps so a re-transfer doesn't immediately
            // trigger the auto-revert loop from a stale managerExpiresAt.
            managerExpiresAt: firebase.firestore.FieldValue.delete(),
            managerExpiresAtMs: firebase.firestore.FieldValue.delete(),
            managerOpenedAt: firebase.firestore.FieldValue.delete(),
            managerOpenedBy: firebase.firestore.FieldValue.delete(),
            managerOpenedByName: firebase.firestore.FieldValue.delete(),
            managerRevertedAt: firebase.firestore.FieldValue.serverTimestamp(),
            managerRevertedBy: byEmail || null,
            managerRevertedByName: byName || null,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    },
    /** ===== TICKET HANDOFF (Superadmin Ticket Approval Workflow) ===

     * Instead of a single "Approve", the superadmin now chooses where a
     * resolved ticket goes:
     *   - Transfer to HR    → ticketTransferTo: 'hr'   (HR only, hidden from Area Manager/RM/SM)
     *   - Transfer to Store → ticketTransferTo: 'store' (HR + Area Manager/RM/SM, current approve flow)
     */

    /**
     * Hand a resolved ticket to HR only. Area Manager / RM/SM must NOT see it.
     * Used for sensitive cases (e.g. assault) where only HR investigates.
     * No email is sent to HR — only to the requester (under investigation).
     */
    async transferTicketToHr(ticketId, byEmail, byName) {
        await db.collection('tickets').doc(ticketId).update({
            ticketTransferTo: 'hr',
            approvalStatus: 'approved',
            status: 'Resolved',
            transferredAt: firebase.firestore.FieldValue.serverTimestamp(),
            transferredBy: byEmail || null,
            transferredByName: byName || null,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    },

    /**
     * Hand a resolved ticket to Store (HR + Area Manager / RM/SM can both see).
     * This is the existing "Approve" behaviour — the ticket becomes visible to
     * branch users with the normal 2-day viewing window.
     */
    async transferTicketToStore(ticketId, byEmail, byName) {
        await db.collection('tickets').doc(ticketId).update({
            ticketTransferTo: 'store',
            approvalStatus: 'approved',
            approvedAt: firebase.firestore.FieldValue.serverTimestamp(),
            approvedBy: byEmail || null,
            accessWindowStartsOnOpen: true,
            transferredAt: firebase.firestore.FieldValue.serverTimestamp(),
            transferredBy: byEmail || null,
            transferredByName: byName || null,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    },


    /**
     * Stamp when an Area Manager first opens a transferred violation modal.
     * Starts the 1-minute countdown. After managerExpiresAt the report should
     * auto-revert (managerStatus deleted) so it returns to the superadmin's
     * command-center list.
     *
     * Only the Area Manager (owner) opens these modals — HR and superadmin
     * have their own violation lists and never call this.
     */
    async markViolationOpenedForAreaManager(violationId, openedByEmail, openedByName) {
        const ref = db.collection('violations').doc(violationId);
        const snap = await ref.get();
        const existingMs = snap.exists ? (Number(snap.data().managerExpiresAtMs) || 0) : 0;
        const now = Date.now();
        // Idempotent: if a valid (future) expiry already exists, do NOT reset
        // the countdown. Closing and reopening the modal (or a duplicate stamp)
        // must continue the original deadline, not restart it.
        if (existingMs > now) {
            return new Date(existingMs);
        }
        const expiresAt = new Date(now + 8 * 60 * 60 * 1000); // +8 hours
        await ref.update({
            managerOpenedAt: firebase.firestore.FieldValue.serverTimestamp(),
            managerExpiresAt: firebase.firestore.FieldValue.serverTimestamp(),
            // Client-computed expiry so the countdown UI can start without
            // waiting for the server round-trip.
            managerExpiresAtMs: expiresAt.getTime(),
            managerOpenedBy: openedByEmail || null,
            managerOpenedByName: openedByName || null,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        return expiresAt;
    },

    /**
     * Generate the next violation report number (VIO-0001 format).
     * Uses a Firestore transaction on the shared `counters/violations`
     * document so concurrent submissions can never receive the same number.
     */
    async generateViolationNumber() {
        const counterRef = db.collection('counters').doc('violations');
        let allocated = 0;
        await db.runTransaction(async (transaction) => {
            const snap = await transaction.get(counterRef);
            const current = snap.exists ? (Number(snap.data().count) || 0) : 0;
            allocated = current + 1;
            await transaction.set(counterRef, {
                count: allocated,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        });
        return `VIO-${String(allocated).padStart(4, '0')}`;
    },

    /**
     * Generate the next ticket number for a branch.
     *
     * Uses a Firestore transaction + a per-branch counter document
     * (`counters/tickets-<prefix>`) so concurrent submissions can never
     * receive the same ticket number (the old client-side count was racy).
     *
     * Lazy seeding: the first time a branch's counter is missing, the current
     * highest existing ticket number for that branch is used as the baseline,
     * so ID numbering stays contiguous with legacy tickets.
     */
    async generateTicketNumber(branch) {
        const prefix = branchToPrefix(branch);
        const counterId = 'tickets-' + prefix;
        const counterRef = db.collection('counters').doc(counterId);

        // Only scan existing tickets while this branch has no counter yet.
        let seed = 0;
        try {
            const pre = await counterRef.get();
            if (!pre.exists) {
                const snapshot = await db.collection('tickets').get();
                let maxNum = 0;
                snapshot.forEach((doc) => {
                    const id = doc.id;
                    if (id.indexOf(prefix + '-tix') === 0) {
                        const n = parseInt(id.slice((prefix + '-tix').length), 10);
                        if (!isNaN(n) && n > maxNum) maxNum = n;
                    }
                });
                seed = maxNum;
            }
        } catch (e) {
            console.warn('Ticket counter pre-roll skipped:', e && e.message ? e.message : e);
        }

        let allocated = 0;
        await db.runTransaction(async (transaction) => {
            const snap = await transaction.get(counterRef);
            const current = snap.exists ? (Number(snap.data().count) || 0) : seed;
            allocated = Math.max(current, seed) + 1;
            await transaction.set(counterRef, {
                prefix,
                count: allocated,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
        });

        return `${prefix}-tix${String(allocated).padStart(3, '0')}`;
    }
};

// Roles are managed in Firestore user documents; hardcoded emails are intentionally not used here.
window.SUPERADMIN_EMAILS = [];

window.normalizeUserEmail = function(value) {
    return String(value || '').trim().toLowerCase();
};

window.getUserProfile = async function(email) {
    const normalized = window.normalizeUserEmail(email);
    if (!normalized) return null;
    try {
        const snap = await db.collection('users').doc(normalized).get();
        if (snap.exists) return { id: snap.id, ...snap.data() };

        const querySnap = await db.collection('users').where('email', '==', normalized).limit(1).get();
        if (!querySnap.empty) {
            const doc = querySnap.docs[0];
            return { id: doc.id, ...doc.data() };
        }

        return null;
    } catch (error) {
        console.warn('Failed to load user profile from Firestore:', error && error.message ? error.message : error);
        return null;
    }
};

// ==============================================================
//  2-DAY TRACKING ACCESS WINDOW (approved tickets)
//  After the superadmin approves a resolution, the manager/store may
//  view the report + footage through the public "Track Ticket Status"
//  lookup for exactly 2 days. Once the window lapses the ticket is
//  shown as EXPIRED (viewing blocked) until a superadmin RESENDS it,
//  which starts a fresh 2-day window. Nothing is ever deleted — this
//  only gates viewing; operators/owners/superadmins keep full access.
// ==============================================================
//  Ticket tracking access window — how long a manager/store can view an
//  approved ticket before it expires. Set to 24 hours for production.
window.TRACKING_ACCESS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Coerce Firestore Timestamps / Date / ISO strings into a real Date (or null). */
window.toTrackingDate = function(value) {
    if (!value) return null;
    if (typeof value.toDate === 'function') return value.toDate();
    const d = value instanceof Date ? value : new Date(value);
    return isNaN(d.getTime()) ? null : d;
};

/**
 * ⚠️ TRUE WHEN THIS TICKET'S CLOCK STARTS ON FIRST VIEW, NOT AT APPROVAL.
 *
 * Written by the superadmin at APPROVAL, in place of `accessExpiresAt`. This
 * flag is the ONLY way to tell "approved under the new rule, nobody has opened
 * it yet" from "approved under the old rule, whose window is already running".
 *
 * ⚠️ WITHOUT IT, THE OLD FALLBACK SILENTLY DEFEATS THE FEATURE. Firestore
 * cannot distinguish an ABSENT field from a null one, so an approval that
 * simply stops writing `accessExpiresAt` produces a document shaped exactly
 * like a pre-feature ticket. `getTrackingAccessExpiry()` would then take its
 * legacy branch — `approvedAt + window` — and the countdown would start at
 * approval again, for every new ticket, with nothing on screen to explain it.
 * An explicit boolean is the discriminator; do not "simplify" it away.
 */
window.trackingAccessStartsOnOpen = function(ticket) {
    return !!(ticket && ticket.accessWindowStartsOnOpen === true);
};

/**
 * When the manager/store FIRST OPENED the approved ticket, or null if never.
 * The stamp is written once and never rewritten, so closing the modal does not
 * extend anything — the clock runs continuously from the first open.
 */
window.getTrackingAccessOpenedAt = function(ticket) {
    if (!ticket) return null;
    return window.toTrackingDate(ticket.accessOpenedAt);
};

/**
 * Moment (Date) when the manager/store loses viewing access, or null when the
 * ticket is not approved / has no derivable window.
 *
 * ⚠️ THREE CASES, IN ORDER. Each is a real document shape, not a preference:
 *
 *  1. STORED `accessExpiresAt`. A ticket that was already open (or was
 *     approved and opened under the old rule) carries its own deadline. It wins
 *     over everything, because it is the one value written by a clock that was
 *     actually running.
 *  2. `accessWindowStartsOnOpen` — the NEW rule. The deadline is
 *     `accessOpenedAt + window`, and it is NULL while nobody has opened the
 *     ticket. A NULL here is the whole feature: approved, never viewed, never
 *     expires. Callers must treat "no expiry" as "not expired" rather than
 *     "expired".
 *  3. NEITHER — a ticket approved before this feature existed. It has no
 *     marker and no stamp, so the original `approvedAt + window` fallback
 *     still applies. Without this case those tickets would silently become
 *     permanent and lose the expiry the business relies on.
 */
window.getTrackingAccessExpiry = function(ticket) {
    if (!ticket) return null;
    if ((ticket.approvalStatus || 'pending') !== 'approved') return null;

    const stored = window.toTrackingDate(ticket.accessExpiresAt);
    if (stored) return stored;

    // Case 2 — clock starts on first open.
    if (window.trackingAccessStartsOnOpen(ticket)) {
        const opened = window.getTrackingAccessOpenedAt(ticket);
        if (!opened) return null;
        return new Date(opened.getTime() + window.TRACKING_ACCESS_WINDOW_MS);
    }

    // Case 3 — legacy, approved before the feature.
    const approved = window.toTrackingDate(ticket.approvedAt);
    if (!approved) return null;
    return new Date(approved.getTime() + window.TRACKING_ACCESS_WINDOW_MS);
};

/**
 * ⚠️ THE ONLY PLACE `accessOpenedAt` IS EVER WRITTEN.
 *
 * ⚠️ RETURNS A REASON, NOT A BARE null. This used to return null for four
 * completely different situations — not approved, no marker, already stamped,
 * bad date — plus a fifth when the write itself failed. From outside, "already
 * stamped" and "the helper isn't loaded" and "Firestore rejected the write" all
 * looked identical: the ticket simply never expires, with no error anywhere.
 * That is exactly how a stale cached firebase.js presented as "the expiry
 * feature doesn't work". Each reason below is now distinguishable.
 *
 * Returns { stamped: true, at: Date } when it wrote, or
 *         { stamped: false, reason: '…' } when it did not.
 *
 * Reason values:
 *   'no-ticket'          — nothing was passed
 *   'no-id'              — the object carries no document id. Firestore's
 *                          `snap.data()` returns fields only, so an object read
 *                          that way has `id === undefined` and `doc(undefined)`
 *                          throws. Caught here with a nameable reason rather than
 *                          surfacing as a bare SDK error — this exact case
 *                          silently stopped EVERY window from ever starting.
 *   'not-approved'       — nothing to view yet
 *   'legacy-no-marker'   — approved before this feature; its deadline is already
 *                          set by the approvedAt + window fallback, so it must
 *                          NOT be stamped
 *   'already-stamped'    — the stamp exists; closing/reopening cannot extend
 *   'bad-date'           — the caller's `now` was unusable (tests inject one)
 *   'write-failed'       — Firestore rejected it. NEVER blocks the report; the
 *                          ticket keeps its no-expiry state until the next open.
 */
window.markTrackingAccessOpened = async function(ticket, now) {
    if (!ticket) return { stamped: false, reason: 'no-ticket' };
    // ⚠️ CHECKED BEFORE ANY WRITE, AND ITS OWN REASON. `doc(undefined)` throws
    // inside the SDK, which would otherwise be indistinguishable from a genuine
    // permission denial in the catch below.
    if (!ticket.id) return { stamped: false, reason: 'no-id' };
    if ((ticket.approvalStatus || 'pending') !== 'approved') return { stamped: false, reason: 'not-approved' };
    if (!window.trackingAccessStartsOnOpen(ticket)) return { stamped: false, reason: 'legacy-no-marker' };
    if (window.getTrackingAccessOpenedAt(ticket)) return { stamped: false, reason: 'already-stamped' };

    const stamp = now ? window.toTrackingDate(now) : new Date();
    if (!stamp || isNaN(stamp.getTime())) return { stamped: false, reason: 'bad-date' };

    try {
        // `db` / `auth` are this file's own top-level consts, used directly
        // rather than via window.db — that mirrors every other write in
        // firebase.js and does not depend on the window.* aliases that are only
        // assigned at the very bottom of the file.
        await db.collection('tickets').doc(ticket.id).update({
            accessOpenedAt: firebase.firestore.FieldValue.serverTimestamp(),
            accessOpenedBy: (auth && auth.currentUser && auth.currentUser.email) || 'unknown'
        });
        // Mirror locally so the modal that is rendering RIGHT NOW sees its own
        // write. Without this the first open computes an expiry from a missing
        // stamp and would flash the "withheld" state at a manager whose access
        // is in fact open — then correct itself a beat later on the listener.
        ticket.accessOpenedAt = stamp;
        return { stamped: true, at: stamp };
    } catch (e) {
        // Never block the report on a bookkeeping write.
        console.warn('Could not stamp accessOpenedAt:', e);
        return { stamped: false, reason: 'write-failed', error: e };
    }
};

/**
 * True when an approved ticket's viewing window has already lapsed.
 *
 * ⚠️ A NULL EXPIRY MEANS NOT EXPIRED, never expired. That covers an
 * unapproved ticket, a legacy ticket with no derivable window, and — the case
 * this feature exists for — an approved ticket nobody has opened yet.
 */
window.isTrackingAccessExpired = function(ticket, now) {
    const expiresAt = window.getTrackingAccessExpiry(ticket);
    if (!expiresAt) return false;
    const reference = now ? window.toTrackingDate(now) : new Date();
    return expiresAt.getTime() <= (reference ? reference.getTime() : Date.now());
};

/**
 * Human-readable length of the current window ("1 minute", "2 days").
 * Every place that USED to hardcode "2 days" (track-page hint, Resend
 * confirmation, success toast, button label) reads this instead, so the UI
 * stays truthful while the window is time-compressed for testing.
 */
window.formatTrackingAccessWindow = function(ms) {
    const value = Number(ms) > 0 ? Number(ms) : window.TRACKING_ACCESS_WINDOW_MS;
    const minutes = Math.round(value / 60000);
    if (minutes < 60) return minutes === 1 ? '1 minute' : minutes + ' minutes';
    const hours = Math.round(value / 3600000);
    if (hours < 48) return hours === 1 ? '1 hour' : hours + ' hours';
    const days = Math.round(value / 86400000);
    return days === 1 ? '1 day' : days + ' days';
};

// Make firestoreService globally accessible
window.firestoreService = firestoreService;
window.db = db;
window.auth = auth;



