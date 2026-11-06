// ==============================================================
//  HR <-> SUPERADMIN CHAT  (one conversation per pair)
//  Floating chat button (top-right) that opens a chat modal with a
//  conversation list on the left and the selected thread on the right.
//
//  ⚠️⚠️ TWO DIFFERENT ROLE SETS — DO NOT COLLAPSE THEM INTO ONE.
//
//  1:1 CONVERSATIONS — STRICTLY PAIRED (spec): personal chat exists between
//  superadmin <-> HR, and Area Manager (stored 'owner') <-> RM/SM (stored
//  'rmsm'). Store personnel meet HR and the superadmin in the STORE GROUP
//  chat, never in DMs; every pairing is symmetric (one map, consulted from
//  either side, so a room can never be opened one way and stranded).
//  Operators and unknown roles are excluded entirely.
//
//  THE "All HR" GROUP CHAT: HR and superadmin ONLY. An Area Manager is a full
//  chat participant yet is deliberately NOT in the group — they never see the
//  row, and firestore.rules denies the room itself.
//
//  Enforced in three places:
//    1. canChat(role) / isStartable() / inGroupRoom()  — pure gates, unit-tested
//    2. ChatService.init()                            — hides/removes the launcher
//    3. firestore.rules   — isChatRole() for 1:1, isHrOrSuperAdmin() for the
//                            group, isChatMember() for privacy, isAreaManager()
//                            for the roster read
//
//  HR, Area Manager and superadmin share the SAME dashboard
//  (ownerdashboard.html); the role differs in the profile label, in chat
//  access and in the +Ticket shortcut. The superadmin assigns the role from
//  the User Approvals tab.
//
//  Data model:
//    chats/{chatId}              { type, members[], title, lastMessage,
//                                   lastMessageAt, lastSenderEmail }
//    chats/{chatId}/messages/{m} { text, senderEmail, senderName, sentAt }
//    chats/owner-superadmin/profiles/{k}
//                                 { email, role, displayName, title }
//                                   <- the people directory
//
//  ONE ROOM PER PAIR. There is one conversation per PAIR of participants, NOT
//  a single shared room: previously every HR and every superadmin read and
//  wrote the one room `owner-superadmin`, so with several HR accounts
//  everybody saw everybody's messages. The room id is derived from the two
//  participants' emails (see dmRoomIdFor), so both sides compute the same id
//  with no lookup and no extra document.
//
//  ⚠️ THE AREA MANAGER ROLE NEEDS A RULES DEPLOY
//  (`firebase deploy --only firestore:rules`). The 1:1 and roster rules were
//  widened to isChatRole() / isAreaManager(); until they are deployed an Area
//  Manager sees the chat circle but every read and write is denied. The
//  launcher then greys out and names the fix (see disableChatWithReason), so
//  it fails visibly rather than silently.
//
//  ⚠️ The people directory and the room doc still need NO new rule: the
//  directory reuses the deployed `profiles` subcollection and the room doc uses
//  only the field keys the deployed `hasOnly()` allowlist permits. The
//  conversation list deliberately omits `orderBy` (an `array-contains`
//  + `orderBy` combination would need a paid composite index). Unread is
//  tracked in localStorage. See the CONVERSATION LIST block for details.
//
//  Loaded on main.html (superadmin) and ownerdashboard.html
//  (Area Manager + HR + superadmin). Uses the Firebase v8 compat SDK already
//  initialised by firebase.js (global `db` / `auth`).
// ==============================================================

(function () {
    'use strict';

    // Roles allowed to hold a 1:1 CHAT CONVERSATION. An Area Manager (stored
    // role 'owner') is included: they talk to HR and to superadmins.
    // Operators and anything unknown are rejected.
    //
    // ⚠️ THIS IS *NOT* THE GROUP-CHAT LIST. The "All HR" group room is a
    // separate, narrower set (GROUP_ROOM_ROLES below) because an Area Manager
    // may hold 1:1 threads yet must never see that room.
    //
    // This is an allowlist on purpose, so a new/unknown role can never inherit
    // chat access by accident. It must stay in lockstep with `isChatRole()` in
    // firestore.rules — that rule is the real authorisation; this one only
    // controls the UI. test/chat-rules.test.js asserts both lists match.
    var CHAT_ALLOWED_ROLES = ['hr', 'superadmin', 'owner', 'rmsm'];

    // Who may be in the "All HR" GROUP chat: HR and superadmin only, so an
    // Area Manager is excluded from the group even though they can chat 1:1.
    // ⚠️ Must stay in lockstep with `isHrOrSuperAdmin()` in firestore.rules —
    // the two together are what keep Area Managers out of the group. A test
    // asserts this list is exactly these two roles and excludes 'owner'.
    var GROUP_ROOM_ROLES = ['hr', 'superadmin'];

    // A per-branch group chat is an ALL-MEMBERS broadcast channel with no
    // 1:1 semantics. Membership is the `members` list seeded at approval —
    // EVERY approved account assigned to that branch plus all superadmins
    // (see branchGroupMembers) — so this gate is about who can chat at all,
    // not about membership (the list query only returns rooms you are in).
    // Area Managers and RM/SM ARE members of their own branch's room.
    // ⚠️ NOT THE SAME AS GROUP_ROOM_ROLES — that list is the legacy "All HR"
    // room (hr + superadmin only) and must stay narrower.
    var GROUP_STYLE_ROOM_ROLES = ['hr', 'superadmin', 'owner', 'rmsm'];

    /** True when the signed-in person may see group-style rooms (legacy All HR + branch rooms). */
    function inGroupStyleRoom() {
      return GROUP_STYLE_ROOM_ROLES.indexOf(normalizeRole(currentRole)) !== -1;
    }

    // The two roles a 1:1 may be started with — HR, superadmin, and the
    // Area Manager (stored role 'owner'). Area Manager never paired with
    // themselves, and HRs never paired with HRs.

    /**
     * Who may MENTION a violation report in chat. HR and superadmin ONLY.
     *
     * ⚠️ AN AREA MANAGER (stored role 'owner') IS EXCLUDED, and this is a
     * deliberate, separate decision from the group chat — the two role sets are
     * NOT the same and must not be collapsed into one.
     *
     * The reason is written down in ownerdashboard.html: violations are CCTV
     * evidence, and an Area Manager "must never see CCTV violation data".
     * js/hr-violations.js already enforces that by hiding the whole Violations
     * tab (applyRole() allows only 'hr' and 'superadmin'), and firestore.rules
     * denies the read. Chat was the ONE surface that ignored it:
     *
     *   - linkifyViolationRefs() is a PURE REGEX over the message text, so it
     *     needs no read and no permission of its own — nothing downstream can
     *     undo what it renders. It must therefore gate on the RIGHT question:
     *     who may CLICK a chip (canOpenViolations, VIOLATION_OPEN_ROLES below),
     *     not who may CREATE one. Gating it on this list was the original bug
     *     in the other direction: the Area Manager saw PLAIN TEXT where every
     *     other reader saw a clickable chip, so a violation mentioned in the
     *     store chat could not be clicked by the one person it concerned.
     *   - "@violation" opened a picker whose read was denied, so it always
     *     came up empty and showed "No reports have been transferred to HR
     *     yet" — a message written for HR, shown to someone who by design can
     *     never transfer anything.
     *
     * ⚠️ AN ALLOWLIST, NOT A DENYLIST, for the same reason CHAT_ALLOWED_ROLES is
     * one: a new or unknown role must never inherit this capability by
     * accident. Must stay in lockstep with applyRole() in js/hr-violations.js.
     *
     * ⚠️ TICKETS ARE NOT AFFECTED. A ticket is the Area Manager's own sign-off
     * work — they have a whole tickets table for their branches — so @ticket
     * stays available to every chat role. Only violations are restricted.
     */
    var VIOLATION_MENTION_ROLES = ['hr', 'superadmin'];

    /**
     * May the signed-in person mention a violation? True only for the roles
     * above; FALSE for 'owner', for an operator, and for anything unknown.
     */
    function canMentionViolations() {
        return VIOLATION_MENTION_ROLES.indexOf(normalizeRole(currentRole)) !== -1;
    }

    /**
     * Who may OPEN a violation chip they SEE in a message — the VIEW side of
     * the feature, deliberately SEPARATE from VIOLATION_MENTION_ROLES above.
     *
     * ⚠️ CREATE ≠ CLICK, and conflating them broke the Area Manager's side of
     * the store-chat handoff. The chip is rendered per-viewer by
     * linkifyViolationRefs(), which performs no Firestore read of its own — so
     * when it consulted canMentionViolations(), the Area Manager (who must not
     * CREATE a mention) was shown PLAIN TEXT where everyone else saw a
     * clickable chip. When HR or a superadmin said "violation VIO-0007" in the
     * store chat there was literally nothing for them to click.
     *
     * The two questions are different and must stay different:
     *
     *   MAY YOU CREATE ONE?  canMentionViolations() — the "@violation" picker,
     *                        the index read and the composer placeholder.
     *                        Area Manager: NO.
     *   MAY YOU CLICK ONE?    canOpenViolations()   — the rendered chip.
     *                        Area Manager: YES, and what they may actually
     *                        OPEN from there is enforced where it belongs: by
     *                        firestore.rules (isOwner() &&
     *                        isTransferredToAreaManager()), by
     *                        isMentionableViolation() on the resolver, and by
     *                        OwnerViolations.openModal() on the modal — not by
     *                        hiding the link.
     *
     * An allowlist again, for the same reason as every list above: an operator
     * has no chat, and an unknown role must never inherit a capability by
     * accident.
     *
     * ⚠️ RM/SM ('rmsm') IS ON THE CLICK LIST, BUT ONLY THE CLICK LIST. RM/SM has
     * NO violations tab (js/owner-violations.js hides it), so there is no list
     * to browse and no picker to open — the ONLY way an RM/SM ever reaches a
     * report is a chip that HR/superadmin MENTIONED in the store chat, which is
     * exactly the handoff this feature is for. What they may OPEN is enforced
     * where it belongs: firestore.rules now admits 'rmsm' via
     * (isRmsm() && isTransferredToAreaManager()), isMentionableViolation() keys
     * 'rmsm' on managerStatus, and OwnerViolations.openModal() re-checks branch
     * scope — NOT by hiding the link. RM/SM still may not CREATE a mention
     * (canMentionViolations()), so the picker/index/placeholder stay closed.
     */
    var VIOLATION_OPEN_ROLES = ['hr', 'superadmin', 'owner', 'rmsm'];

    /**
     * May the signed-in person click a violation chip? True only for the roles
     * above; FALSE for an operator, and for anything unknown.
     */
    function canOpenViolations() {
        return VIOLATION_OPEN_ROLES.indexOf(normalizeRole(currentRole)) !== -1;
    }

    // The LEGACY shared room, kept READ-ONLY as an archive.
    //
    // Before per-person conversations, EVERY hr and superadmin read and
    // wrote this one document, so its history is genuinely mixed between
    // people. It cannot be split up afterwards — Firestore has no way to
    // know which of the several recipients any given old message was meant
    // for — so it is exposed as a read-only "archive" row instead. New
    // messages always go to a per-pair room. firestore.rules refuses any
    // WRITE to this id (isLegacyArchive), so it cannot drift back into
    // being a second shared room.
    var LEGACY_ROOM_ID = 'owner-superadmin';
    // The pinned group chat's display name. The room id is the legacy shared
    // room (see isGroupRoom() for why that room is the right one now), but the
    // name says what it IS: a channel for everyone, not a museum piece.
    var GROUP_ROOM_NAME = 'All HR — group chat';

    // The conversation currently open. Null until a row is picked, so the
    // log never renders somebody else's messages before the user chooses.
    var activeRoomId = null;

    // The other participant in a 1:1 conversation, derived from the room
    // id. Kept alongside activeRoomId so the header, the avatar and the
    // "Send" target all agree without re-reading the room doc.
    var activePeerEmail = null;

    // email -> { displayName, title, role }, from the people directory
    // (chats/owner-superadmin/profiles). Drives the conversation list rows —
    // including the "Tap to start a conversation" rows that ARE how a new
    // conversation is started (there is no separate picker any more).
    var directory = {};

    // email -> { email, role, displayName } — the AUTHORITATIVE account
    // roster, read from `users` by BOTH chat roles: a superadmin keeps the
    // whole collection, an HR reads only the superadmin docs it is allowed
    // to message (see loadHrRoster). Live, so a newly registered account
    // shows up without a reload.
    // `directory` above is SELF-PUBLISHED: an account lands in it only after
    // its owner has opened the chat and saved a profile, so somebody who has
    // never opened the chat would otherwise be missing from the list.
    var rosterEntries = {};

    // Guards against a runaway composer (mirrors the ticket text limits).
    var MAX_MESSAGE_LENGTH = 2000;

    // The LIVE TAIL. This is what the onSnapshot subscribes to with
    // limitToLast(), and it is deliberately small: every snapshot
    // re-serialises the whole window into innerHTML, so a large tail makes
    // each incoming message more expensive to render.
    var MAX_MESSAGES_RENDERED = 300;

    // How many older messages one "Load earlier" click fetches.
    var HISTORY_PAGE_SIZE = 60;

    // Ceiling on the COMBINED (older + tail) list actually rendered. A
    // memory/DOM guard, not a history limit.
    var MAX_RENDERED = 600;

    // Consecutive messages from the same person within this window are
    // grouped under one avatar/name/role header.
    var GROUP_WINDOW_MS = 2 * 60 * 1000;

    // Typing indicator = "this person is composing".
    //
    // The signal is the EXISTENCE OF AN UNSENT DRAFT, not recent keypresses.
    // Someone who types a message, then pauses to think (or reads something
    // else) is still composing, and the indicator must stay up — the same
    // way Messenger keeps "typing…" until the message is sent or the draft
    // is discarded. Keypress-only detection wrongly drops the indicator
    // during any pause in typing.
    //
    // STALENESS IS MEASURED LOCALLY, NOT FROM THE SERVER TIMESTAMP.
    // Comparing a server `at` against the local clock breaks whenever the
    // two clocks differ, so we record the LOCAL time each presence entry
    // last changed and never read `at` for timing.
    //
    // TYPING_HEARTBEAT_MS is how often a composing user refreshes their
    // presence — this runs on a timer for as long as a draft exists, not
    // only while keys are being pressed. A person is shown as composing
    // while their entry keeps arriving and is dropped once it stops for
    // TYPING_STALE_MS, which makes the indicator self-healing: a client that
    // vanishes mid-sentence (crash, closed tab, lost network) simply stops
    // heartbeating and the indicator disappears on its own.
    var TYPING_HEARTBEAT_MS = 1500;
    var TYPING_STALE_MS = 5000;

    // Local state
    var isMounted = false;
    var messagesUnsub = null;
    var typingUnsub = null;
    var readReceiptsUnsub = null;
    // ---- People directory + conversation list ----------------------
    // The directory listener (over the legacy room's `profiles`), the
    // `chats` list listener that supplies the rows (last message, timestamp),
    // and the account-roster listener over `users` (see loadHrRoster).
    var directoryUnsub = null;
    var conversationListUnsub = null;
    var rosterUnsub = null;

    // ---- The DENIED-list-query fallback -----------------------------
    // The conversation list is normally ONE query: `chats where members
    // array-contains me`. A query is authorised as a single rules evaluation
    // over the WHOLE collection, and a membership rule that resolves each
    // room with exists()/get() cannot be proven that way — so the deployed
    // ruleset can deny the query even though every room document is
    // individually readable. When that happens the list is rebuilt from one
    // document listener per known room instead (see
    // startPerRoomConversationListeners()), so a denial costs a console
    // warning and nothing else.
    var conversationListDenied = false;
    var conversationRoomUnsubs = {};   // roomId -> unsubscribe
    var conversationRoomsDenied = {};  // roomId -> true (no room document yet)

    // roomId -> unsubscribe, for the per-room NEWEST-MESSAGE watchers that
    // drive the notification sound. Deliberately separate from
    // conversationRoomUnsubs above: that one watches the room DOCUMENT (for
    // the sidebar summary), this one watches the MESSAGES subcollection (to
    // know a message actually arrived). They fail for different reasons and
    // are torn down independently.
    var roomMessageUnsubs = {};

    // roomId -> the id of the newest message already announced, seeded from
    // localStorage on first watch. This is what makes "a new message arrived"
    // a question with a definite answer, instead of guessing from a timestamp.
    var announcedMessageIds = {};

    // ⚠️ WHY A RETRY TIMER EXISTS. A room that does NOT EXIST is denied by
    // the membership rule (isChatMember() starts with exists()), so its
    // listener dies immediately and can never report "the room just got
    // created" — which is how somebody else starting a conversation with
    // you would otherwise stay invisible until a page reload. Re-attempting
    // only the DENIED rooms, on a slow interval, closes that gap without
    // polling anything that is already subscribed.
    var DENIED_ROOM_RETRY_MS = 60000;
    var deniedRoomRetryTimer = null;

    // ---- REMEMBERED ROOMS ----------------------------------------------
    // ⚠️ WHY THIS EXISTS. With the query denied, the sidebar is rebuilt from
    // the rooms of the people we KNOW (the directory ∪ the account roster).
    // A room whose other side has since left both — an account re-roled away
    // from the chat, or a profile entry deleted — would silently disappear
    // from the list and take its history with it, because a denied query is
    // the only thing that could rediscover an unknown room. So every room
    // this device has seen is remembered (per account, in localStorage, the
    // same store the unread stamps already use) and re-checked on every
    // pass. A room that is refused TWICE is forgotten again, so a permanently
    // unreadable room costs two reads and nothing more.
    // This device has seen the room, so it must not depend on the query.
    // (See the REMEMBERED ROOMS note above.)
    var KNOWN_ROOMS_MAX = 200;
    var knownRooms = {};   // roomId -> last-seen ms
    // True once loadSendShape() has run for the signed-in account.
    var sendShapeLoaded = false;

    // True once the people directory has reported at least once. Until then a
    // refused room read is never acted on, because the directory may simply
    // not have arrived yet — see the forget rule in subscribeRoomForList().
    var peopleSettled = false;

    // roomId -> { lastMessage, lastMessageAt, lastSenderEmail, peerEmail,
    // isArchive }. Built by the list listener and read by
    // renderConversationList(). There is NO unreadCount field: unread is
    // derived per-device in localStorage (see the UNREAD block).
    var conversationSummaries = {};

    // The current text in the conversation-list search box.
    var conversationFilter = '';

    // True once the list listener has delivered its first snapshot, so we
    // can tell "no conversations yet" apart from "still loading".
    var conversationListReady = false;

    var visibilityUnsub = null;
    var profilesUnsub = null;
    var reactionsUnsub = null;
    var typingSweepTimer = null;
    var draftHeartbeatTimer = null;
    var currentRole = null;
    var currentUserEmail = null;
    var els = {};

    // Last presence snapshot, kept so the periodic sweep can re-evaluate
    // staleness without waiting for another Firestore push.
    var lastPresence = [];

    // email -> local Date.now() when that person's presence last CHANGED.
    // Using local receipt time (instead of the server `at` field) makes the
    // indicator immune to clock skew between clients and Firestore.
    var presenceSeenAt = {};

    // email -> the last `at` value we saw for them, so we can tell a
    // genuinely NEW heartbeat apart from an unchanged entry that merely
    // rode along in someone else's snapshot.
    var lastPresenceByEmail = {};

    // Ids of messages already rendered, so an incoming message can be
    // distinguished from the history that loaded with the page.
    var seenMessageIds = [];

    // The message list as last rendered, kept so a read-receipt update can
    // repaint the ✓/✓✓ ticks without waiting for a messages push.
    var lastRenderedMessages = [];

    // ---- Paginated history ------------------------------------------
    // The live listener only ever sees the last MAX_MESSAGES_RENDERED
    // messages. Everything older is fetched on demand by
    // loadOlderMessages() and held here, then PREPENDED at render time.
    //
    // Before this, a thread that passed 300 messages silently hid
    // everything older with no way to reach it — real data loss for a
    // thread that discusses incidents.
    var olderMessages = [];      // prepended pages, oldest first
    var historyCursor = null;    // oldest doc of the last page fetched
    var oldestTailDoc = null;    // oldest DocumentSnapshot of the live tail
    var hasMoreHistory = true;
    var historyLoading = false;

    // --------------------------------------------------------------
    //  DRAGGABLE LAUNCHER
    //  The circle can be dragged anywhere on the page during the session.
    //  A movement threshold separates a drag from a click, so a plain
    //  click still opens the chat.
    //
    //  ⚠️ The position is deliberately NOT persisted across loads. It
    //  USED to save to localStorage and re-apply on mount — but a
    //  position saved on one viewport clamps differently on another, so
    //  the circle "wandered" (e.g. re-appearing pinned top-left after a
    //  resize). The STARTING position is always the CSS default
    //  (bottom-right); a drag moves it for the session only. A stale
    //  saved key from the old version is cleared on mount.
    // --------------------------------------------------------------

    var LAUNCHER_POS_KEY = 'rcms_chat_pos';

    // Pointer travel (px) before a press counts as a drag rather than a
    // click. Without this, every click would also nudge the button.
    var DRAG_THRESHOLD_PX = 5;

    // Keep the circle this far from the viewport edge so it can never be
    // dragged fully out of reach.
    var LAUNCHER_EDGE_MARGIN = 8;

    var dragState = null;
    var suppressNextLauncherClick = false;

    // When non-empty, chat is disabled in place because the deployed
    // Firestore rules disagree with the client allowlist. The launcher
    // stays on screen (greyed out) rather than vanishing.
    var chatDisabledReason = null;

    // ==============================================================
    //  ACCESS GATE (pure — unit-tested in test/chat-access.test.js)
    // ==============================================================

    /**
     * Normalise a role string. Handles the real edge case in the
     * owner dashboard, where a failed permissions fetch calls
     * setActiveUser(perms, false) and the role arrives as "false".
     */
    function normalizeRole(role) {
        if (role === null || role === undefined) return '';
        return String(role).trim().toLowerCase();
    }

    /**
     * True only for the roles that may hold a 1:1 conversation: 'hr',
     * 'superadmin' and 'owner' (the Area Manager). Operators, unknown roles,
     * empty values and non-strings are all rejected.
     *
     * ⚠️ Passing does NOT mean the person may use the GROUP chat — that is
     * inGroupRoom(), a deliberately narrower set.
     */
    function canChat(role) {
        return CHAT_ALLOWED_ROLES.indexOf(normalizeRole(role)) !== -1;
    }

    /**
     * Page-level gate. main.html is the Command Center (superadmin only — HR
     * and Area Managers are routed to ownerdashboard.html), while
     * ownerdashboard.html serves Area Managers, HR and superadmins. So an Area
     * Manager gets chat on the dashboard they are routed to, and never on the
     * command center.
     */
    function canChatOnSurface(surface, role) {
        if (!canChat(role)) return false;
        if (surface === 'main') return normalizeRole(role) === 'superadmin';
        return true;
    }

    // --------------------------------------------------------------
    //  ROOM IDENTITY  (pure — unit-tested)
    //
    //  A 1:1 conversation is identified by the PAIR of participants, so
    //  the room id must be a function of both emails and must be
    //  SYMMETRIC: hr@x.com must compute the same id whether it is asking
    //  "the room with admin@y.com" or the other way round. Sorting the
    //  two encoded emails is what guarantees that. Without the sort each
    //  side would open its own room, the other would see nothing arrive,
    //  and messages would appear to vanish.
    // --------------------------------------------------------------

    /**
     * The room id for a conversation between two people. SYMMETRIC by
     * construction: the two encoded emails are sorted, so the order of the
     * arguments never changes the result.
     *
     * Pure — no module state — so it can be unit-tested directly, which
     * matters because a mismatch here is silent: each side would open its
     * own room and messages would simply never arrive.
     */
    function dmRoomIdFor(emailA, emailB) {
        const a = String(emailA || '').toLowerCase();
        const b = String(emailB || '').toLowerCase();
        if (!a || !b || a === b) return null;
        const keys = [emailKeyFor(a), emailKeyFor(b)].sort();
        return 'dm_' + keys[0] + '__' + keys[1];
    }

    /** The room id between the signed-in user and `otherEmail`. */
    function myRoomIdWith(otherEmail) {
        return dmRoomIdFor(currentUserEmail, otherEmail);
    }

    /**
     * The counterpart of dmRoomIdFor: recover the OTHER participant's email
     * from a room id, given who is asking. Returns null for the legacy
     * archive and for any id that is not a well-formed pair — callers treat
     * that as "no peer", which is exactly right for a group-style archive.
     *
     * encodeURIComponent is not guaranteed to be its own inverse in every
     * JS engine, so this decodes rather than assuming a round trip.
     */
    function peerFromRoomId(roomId) {
        const id = String(roomId || '');
        if (!id || id === LEGACY_ROOM_ID) return null;
        if (id.indexOf('dm_') !== 0) return null;

        const body = id.slice(3);
        const sep = body.indexOf('__');
        if (sep <= 0) return null;

        const parts = [body.slice(0, sep), body.slice(sep + 2)];
        if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

        let decoded;
        try {
            decoded = parts.map(function (p) {
                return decodeURIComponent(p).toLowerCase();
            });
        } catch (e) {
            // A hand-edited or malformed id must not throw and break the
            // list render; treat it as "no peer" and fall back to the email.
            return null;
        }

        const me = String(currentUserEmail || '').toLowerCase();
        if (decoded[0] === me) return decoded[1];
        if (decoded[1] === me) return decoded[0];
        // Neither half is us: the row is not ours to open.
        return null;
    }

    // The room id for a per-branch group chat. branchName -> chats/branch-<slug>.
    function branchKey(branch) {
      return 'branch-' + String(branch || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    }

    // True for a per-branch group chat (the client-side shape check).
    function isBranchRoom(roomId) {
      return roomId.indexOf('branch-') === 0;
    }

    // The display name for a branch room. Accepts EITHER the branch name (as
    // seeded in the room document's `title`) or the room id — call sites pass
    // whichever they hold, and the room-id form is prettified (the `branch-`
    // prefix is dropped and hyphens become spaces) so a summary that has not
    // arrived yet still reads "sm fairview", not "branch-sm-fairview".
    function branchGroupName(branch) {
      var raw = String(branch || '');
      var name = isBranchRoom(raw) ? raw.slice('branch-'.length).replace(/-/g, ' ') : raw;
      return (name || 'Unnamed branch') + ' — branch chat';
    }

    /**
     * Who belongs in chats/branch-<slug> for `branch` — the seeded `members`
     * list written by ensureBranchGroupChats() in script.js when a superadmin
     * approves (or re-saves) a member's branch assignment.
     *
     * Three sources, all from the `users` collection:
     *   1. `approvedEmail` — the person the approval was just for, force-added
     *      ONLY while the store has a real team (the gate below): a roster-lag
     *      net that can never seed or keep a teamless room alive.
     *   2. every approved SUPERADMIN and every approved HR — the superadmin
     *      owns and manages every branch room (canManageBranchRoom) and may
     *      hold no branches of their own, and HR's access is company-wide by
     *      the spec ("HR has access to ALL Store Group Chats"), so neither is
     *      filtered by `branches`.
     *   3. every approved account whose `branches` INCLUDES this branch —
     *      the Area Manager and the RM/SM assigned to THIS store. Anyone
     *      assigned to a different branch is deliberately NOT here: a branch
     *      room is that store's team and nobody else's. Pending, rejected and
     *      operator accounts never qualify.
     *
     * PURE (no module state) — exercised for real by test/chat-rules.test.js
     * §15b, which extracts this function and runs it against fixtures.
     */
    /**
     * True when `branch` has at least one APPROVED Area Manager (owner) or
     * RM/SM assigned to it - i.e. the store actually has a team.
     *
     * SINGLE SOURCE OF TRUTH for "should chats/branch-<slug> exist at all".
     * HR and the Superadmin have company-wide access by spec, so they must NOT,
     * on their own, keep a store room alive - that is what produced a phantom
     * room for every branch the moment any HR account existed. A room is
     * justified ONLY by a real store team. PURE (no module state) - exercised
     * by test/chat-rules.test.js section 15b.
     */
    function branchHasStoreTeam(branch, users) {
      var key = String(branch || '').trim().toLowerCase();
      if (!key) return false;
      return (users || []).some(function (u) {
          if (!u) return false;
          var role = normalizeRole(u.role);
          if (role !== 'owner' && role !== 'rmsm') return false;
          var status = String(u.status || 'approved').trim().toLowerCase();
          if (status !== 'approved') return false;
          return Array.isArray(u.branches) && u.branches.some(function (b) {
              return String(b || '').trim().toLowerCase() === key;
          });
      });
    }

    function branchGroupMembers(branch, users, approvedEmail) {
      var key = String(branch || '').trim().toLowerCase();
      var seen = {};
      var add = function (email) {
          var e = String(email || '').trim().toLowerCase();
          if (e) seen[e] = true;
      };
      // ⚠️ Does this branch have ANY approved Area Manager (owner) or RM/SM
      // assigned to it? If not, the store has no team yet — the room must NOT
      // be created, so Super Admin / HR do not get a phantom room.
      var hasStoreUser = branchHasStoreTeam(branch, users);

      // ⚠️ The just-approved/saved account is force-added ONLY while the store
      // has a real team. It used to be added unconditionally, so RE-SAVING an
      // Area Manager whose role had just changed to HR (updateUserPermissions
      // passes the account itself) re-added them to `members` whatever the
      // roster said — and with the save-path phantom delete also exempted, the
      // teamless store's room survived as a 1-member ghost, so its branch rooms
      // never left that person's chat list. A person's own role or branch
      // access must never seed or keep a teamless room: the roster decides —
      // this stays only as a roster-lag net for somebody who genuinely belongs
      // to a store that HAS a team.
      if (approvedEmail && hasStoreUser) add(approvedEmail);

      (users || []).forEach(function (u) {
          if (!u) return;
          var role = normalizeRole(u.role);
          if (CHAT_ALLOWED_ROLES.indexOf(role) === -1) return;
          var status = String(u.status || 'approved').trim().toLowerCase();
          if (status !== 'approved') return;
          if (role === 'superadmin' || role === 'hr') {
              // Only add Super Admin / HR when the store actually has a team.
              if (!hasStoreUser) return;
              add(u.email || u.id);
              return;
          }
          var assigned = Array.isArray(u.branches) && u.branches.some(function (b) {
              return String(b || '').trim().toLowerCase() === key;
          });
          if (assigned) add(u.email || u.id);
      });

      return Object.keys(seen).sort();
    }

    // Exposed early so the test can grab them and the pages can probe.
    var ChatService = {
        canChat: canChat,
        canChatOnSurface: canChatOnSurface,
        LEGACY_ROOM_ID: LEGACY_ROOM_ID,
        CHAT_ALLOWED_ROLES: CHAT_ALLOWED_ROLES.slice(),
        // The group chat's narrower set. Exported so a test can assert the
        // client and the rules agree on BOTH lists, and specifically that
        // 'owner' is in the first and absent from this one.
        GROUP_ROOM_ROLES: GROUP_ROOM_ROLES.slice(),
        // Exported for unit tests: both sides must derive the SAME id for a
        // pair, or each opens a different (empty) room and messages vanish.
        dmRoomIdFor: dmRoomIdFor,
        peerFromRoomId: peerFromRoomId,
        // Branch rooms — auto-generated when a member is assigned to a branch
        // (script.js ensureBranchGroupChats): id + display name + the PURE
        // membership seeder, exported so the approval flow, this file's own
        // UI and test/chat-rules.test.js §15b all use ONE implementation.
        branchKey: branchKey,
        isBranchRoom: isBranchRoom,
        branchGroupName: branchGroupName,
        branchGroupMembers: branchGroupMembers,
        branchHasStoreTeam: branchHasStoreTeam,
        // Retire my own message into an "Unsent message" tombstone. Exposed so
        // the confirm modal (window.confirmUnsendMessage) can call it; the
        // author-only/one-way guarantee lives in firestore.rules, re-checked
        // here too. Returns a promise<boolean>. Wrapped in an arrow so the
        // reference resolves at CALL time — the access-gate test evaluates this
        // object literal in a slice that ends before unsendMessage is declared.
        unsendMessage: function (id) { return unsendMessage(id); }
    };

    window.ChatService = ChatService;

    // ==============================================================
    //  HTML ESCAPING
    //  script.js / owner-dashboard.js both define a global escapeHTML,
    //  but ownerdashboard.html does not load script.js — so chat.js
    //  carries its own copy scoped inside this IIFE (no global clash).
    // ==============================================================

    function escapeHTML(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function showToast(message, type) {
        if (typeof window.showToast === 'function') {
            window.showToast(message, type);
        } else {
            console.log('[Chat]', message);
        }
    }

    // ==============================================================
    //  DOM
    // ==============================================================

    function buildUI() {
        // ---- Launcher: floating chat circle, upper right ----
        var launcher = document.createElement('button');
        launcher.type = 'button';
        launcher.id = 'chatLauncher';
        launcher.className = 'chat-launcher';
        launcher.setAttribute('aria-label', 'Open chat. Drag to move.');
        launcher.title = 'Open chat — drag to move';
        launcher.hidden = true;
        launcher.innerHTML =
            '<i class="fas fa-comments" aria-hidden="true"></i>' +
            '<span class="chat-launcher-badge" id="chatUnreadBadge" hidden>0</span>';

        // Typing pill shown next to the floating circle. The modal's own
        // typing bar is useless while the chat is CLOSED — which is the
        // default state — so this makes "someone is typing" visible from
        // anywhere on the page, without opening the chat first.
        var launcherTyping = document.createElement('div');
        launcherTyping.id = 'chatLauncherTyping';
        launcherTyping.className = 'chat-launcher-typing';
        launcherTyping.setAttribute('role', 'status');
        launcherTyping.setAttribute('aria-live', 'polite');
        launcherTyping.hidden = true;
        launcherTyping.innerHTML =
            '<span class="chat-typing-dots" aria-hidden="true"><i></i><i></i><i></i></span>' +
            '<span id="chatLauncherTypingText"></span>';

        // ---- Modal: reuses the app's .modal-overlay/.modal-container ----
        var overlay = document.createElement('div');
        overlay.className = 'modal-overlay chat-modal-overlay';
        overlay.id = 'chatModal';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'chatModalTitle');
        overlay.innerHTML =
            '<div class="modal-container modal-lg chat-modal-container">' +
                '<div class="modal-header chat-topbar">' +
                    // Back button: mobile only (see the media query in
                    // chat.css). Returns from the thread to the list.
                    '<button type="button" class="chat-header-btn chat-back-btn" id="chatBackBtn" ' +
                        'hidden aria-label="Back to conversations">' +
                        '<i class="fas fa-arrow-left" aria-hidden="true"></i>' +
                    '</button>' +
                    '<span class="chat-avatar chat-thread-avatar" id="chatThreadAvatar" hidden ' +
                        'aria-hidden="true"></span>' +
                    '<div class="chat-heading">' +
                        '<h2 id="chatModalTitle"><span id="chatThreadTitle">Chats</span></h2>' +
                        '<div class="chat-subtitle" id="chatThreadSubtitle">Select a conversation</div>' +
                    '</div>' +
                    // Opens the display-name / job-title editor.
                    '<button type="button" class="chat-header-btn" id="chatProfileToggle" ' +
                        'title="Edit your display name and job title" aria-label="Edit your profile">' +
                        '<i class="fas fa-user-pen" aria-hidden="true"></i>' +
                    '</button>' +
                    '<button type="button" class="modal-close" id="chatCloseBtn" aria-label="Close chat">' +
                        '&times;' +
                    '</button>' +
                '</div>' +
                // The two panes. The SIDEBAR holds the conversation list; the
                // THREAD is the existing log + composer. On narrow screens
                // exactly one of the two is shown at a time (see chat.css).
                '<div class="chat-layout">' +
                '<aside class="chat-sidebar">' +
                    // ⚠️ THERE IS NO "＋" BUTTON, and there does not need to be:
                    // the list BELOW already offers every person a thread may be
                    // started with as a "Tap to start a conversation" row (the
                    // directory ∪ the account roster). A second, floating picker
                    // for the same set of people was a duplicate entry point into
                    // one list — and the one that was easiest to miss.
                    '<label class="chat-search">' +
                        '<i class="fas fa-magnifying-glass" aria-hidden="true"></i>' +
                        '<span class="chat-sr-only">Search conversations</span>' +
                        '<input type="search" id="chatListSearch" placeholder="Search conversations" ' +
                            'autocomplete="off" aria-label="Search conversations">' +
                    '</label>' +
                    '<div class="chat-list" id="chatList" role="list" aria-label="Conversations"></div>' +
                '</aside>' +
                '<div class="chat-thread">' +
                '<div class="modal-body chat-modal-body">' +
                    // History pager. Sits ABOVE the log so prepending older
                    // messages does not move the control the user is aiming
                    // at. Hidden entirely for a short thread.
                    '<div class="chat-history-bar" id="chatHistoryBar">' +
                        '<button type="button" class="btn btn-sm btn-secondary" id="chatLoadOlder">' +
                            '<i class="fas fa-chevron-up" aria-hidden="true"></i> Load earlier messages' +
                        '</button>' +
                        '<span class="chat-history-status" id="chatHistoryStatus" role="status" aria-live="polite"></span>' +
                    '</div>' +
                    '<div class="chat-log" id="chatLog" role="log" aria-live="polite" aria-relevant="additions">' +
                        '<p class="chat-empty">No messages yet. Start the conversation.</p>' +
                    '</div>' +
                '</div>' +
                '<div class="chat-typing-bar" id="chatTypingBar" role="status" aria-live="polite" hidden>' +
                    '<span class="chat-typing-dots" aria-hidden="true">' +
                        '<i></i><i></i><i></i>' +
                    '</span>' +
                    '<span id="chatTypingText"></span>' +
                '</div>' +
                '<div class="modal-footer chat-composer">' +
                    // Reply banner: shows what is being replied to, with a
                    // cancel. Lives in the composer so it is always adjacent
                    // to the text being written.
                    '<div class="chat-reply-banner" id="chatReplyBanner" hidden>' +
                        '<i class="fas fa-reply" aria-hidden="true"></i>' +
                        '<div class="chat-reply-quote">' +
                            '<span class="chat-reply-name" id="chatReplyName"></span>' +
                            '<span class="chat-reply-text" id="chatReplyText"></span>' +
                        '</div>' +
                        '<button type="button" class="chat-reply-cancel" id="chatReplyCancel" ' +
                            'title="Cancel reply" aria-label="Cancel reply">&times;</button>' +
                    '</div>' +
                    '<label class="chat-sr-only" for="chatInput">Message</label>' +
            // The ONE message context menu. iMessage-style: the emoji reaction
            // row sits on top, and a TEXT action bar (Copy · Unsend · Reply)
            // sits below it, separated by a divider. Actions used to live in
            // the header; now they are all in one popover anchored to the held
            // message. Reply and Unsend are now TEXT, not icons.
            '<div class="chat-reaction-picker" id="chatReactionPicker" role="menu" aria-label="Message actions" hidden>' +
                // ---- Emoji reaction row (top) ----
                '<div class="chat-picker-reactions">' +
                REACTION_EMOJI.map(function (e) {
                    return '<button type="button" class="chat-reaction-option" role="menuitem"' +
                        ' data-picker-key="' + e.key + '"' +
                        ' title="React with ' + e.label + '"' +
                        ' aria-label="React with ' + e.label + '">' +
                        '<span class="chat-reaction-option-glyph">' + reactionGlyph(e.key) + '</span>' +
                        '</button>';
                }).join('') +
                '</div>' +
                '<span class="chat-picker-divider" role="separator" aria-hidden="true"></span>' +
                // ---- Text action bar (bottom): Reply · Copy · Unsend ----
                '<div class="chat-picker-actions">' +
                // REPLY — quote this message into the composer.
                '<button type="button" class="chat-picker-action" role="menuitem" data-picker-reply' +
                    ' title="Reply to this message" aria-label="Reply to this message">Reply</button>' +
                // COPY — copies the message text to the clipboard, then closes.
                '<button type="button" class="chat-picker-action" role="menuitem" data-picker-copy' +
                    ' title="Copy this message" aria-label="Copy this message">Copy</button>' +
                // UNSEND — retires YOUR OWN message into an "Unsent message"
                // tombstone. Shipped hidden and revealed only when the open
                // message is mine (see openReactionPicker -> syncUnsendButton),
                // so it never appears on somebody else's message. tombstones
                // via firestore.rules (author-only, text->'', one-way).
                '<button type="button" class="chat-picker-action chat-picker-unsend" role="menuitem" data-picker-unsend' +
                    ' title="Unsend this message" aria-label="Unsend this message" hidden>Unsend</button>' +
                '</div>' +
            '</div>' +
                    // Profile editor: display name + job title, so the thread
                    // shows "Maria — HR Manager" instead of an email address.
                    '<div class="chat-profile-editor" id="chatProfileEditor" hidden>' +
                        '<label class="chat-sr-only" for="chatProfileName">Display name</label>' +
                        '<input type="text" id="chatProfileName" class="chat-profile-input" maxlength="60" ' +
                            'placeholder="Display name" aria-label="Your display name">' +
                        '<label class="chat-sr-only" for="chatProfileTitle">Job title</label>' +
                        '<input type="text" id="chatProfileTitle" class="chat-profile-input" maxlength="60" ' +
                            'placeholder="Job title (optional)" aria-label="Your job title">' +
                        '<button type="button" class="btn btn-sm btn-primary" id="chatProfileSave">Save</button>' +
                    '</div>' +
                    // Mention autocomplete. Sits above the textarea, anchored
                    // to it, and is only shown while an "@" token is being typed.
                    '<div class="chat-mention-menu" id="chatMentionMenu" role="listbox" aria-label="Mention a person" hidden></div>' +
                    '<textarea id="chatInput" class="chat-input" rows="1" maxlength="' + MAX_MESSAGE_LENGTH +
                        '" placeholder="Type a message&hellip; @ to mention someone, @ticket or @violation to link one" aria-label="Message" ' +
                        'aria-autocomplete="list" aria-controls="chatMentionMenu"></textarea>' +
                    '<button type="button" class="btn btn-primary" id="chatSendBtn" aria-label="Send message">' +
                        '<i class="fas fa-paper-plane" aria-hidden="true"></i>' +
                    '</button>' +
                '</div>' +
                '</div>' +   // .chat-thread
                '</div>';    // .chat-layout

        document.body.appendChild(launcher);
        document.body.appendChild(launcherTyping);
        document.body.appendChild(overlay);

        // Long-press focus scrim (MOBILE). A dim + blur layer that drops over
        // the whole thread when a message is held, so ONLY the held bubble
        // stays lit — the Messenger/iOS long-press look. Built here rather
        // than in the template string so it is a clean, referenceable sibling
        // of the modal box (see els.focusBackdrop). It sits below the picker
        // (z 60) and above the thread; the held bubble itself is lifted to
        // z 50 (see .chat-msg.is-focused) so it rises above this scrim.
        var focusBackdrop = document.createElement('div');
        focusBackdrop.className = 'chat-focus-backdrop';
        focusBackdrop.id = 'chatFocusBackdrop';
        focusBackdrop.hidden = true;
        overlay.appendChild(focusBackdrop);

        els = {
            launcher: launcher,
            launcherTyping: launcherTyping,
            launcherTypingText: launcherTyping.querySelector('#chatLauncherTypingText'),
            badge: launcher.querySelector('#chatUnreadBadge'),
            overlay: overlay,
            // ---- Conversation list (the left pane) ----
            list: overlay.querySelector('#chatList'),
            listSearch: overlay.querySelector('#chatListSearch'),
            backBtn: overlay.querySelector('#chatBackBtn'),
            // ---- Thread header ----
            chatTitle: overlay.querySelector('#chatThreadTitle'),
            chatSubtitle: overlay.querySelector('#chatThreadSubtitle'),
            threadAvatar: overlay.querySelector('#chatThreadAvatar'),
            log: overlay.querySelector('#chatLog'),
            historyBar: overlay.querySelector('#chatHistoryBar'),
            loadOlderBtn: overlay.querySelector('#chatLoadOlder'),
            historyStatus: overlay.querySelector('#chatHistoryStatus'),
            typingBar: overlay.querySelector('#chatTypingBar'),
            typingText: overlay.querySelector('#chatTypingText'),
            input: overlay.querySelector('#chatInput'),
            replyBanner: overlay.querySelector('#chatReplyBanner'),
            replyName: overlay.querySelector('#chatReplyName'),
            replyText: overlay.querySelector('#chatReplyText'),
            replyCancel: overlay.querySelector('#chatReplyCancel'),
            mentionMenu: overlay.querySelector('#chatMentionMenu'),
            reactionPicker: overlay.querySelector('#chatReactionPicker'),
            pickerUnsend: overlay.querySelector('[data-picker-unsend]'),
            pickerCopy: overlay.querySelector('[data-picker-copy]'),
            focusBackdrop: focusBackdrop,
            profileEditor: overlay.querySelector('#chatProfileEditor'),
            profileName: overlay.querySelector('#chatProfileName'),
            profileTitle: overlay.querySelector('#chatProfileTitle'),
            profileSave: overlay.querySelector('#chatProfileSave'),
            profileToggle: overlay.querySelector('#chatProfileToggle'),
            sendBtn: overlay.querySelector('#chatSendBtn'),
            closeBtn: overlay.querySelector('#chatCloseBtn')
        };

        bindEvents();
        bindProfileEditor();
        bindReactionPicker();
        bindReplies();
    }

    /**
     * Wiring for the conversation list: row clicks, the search box and the
     * mobile back button.
     *
     * ⚠️ Starting a conversation needs no control of its own: every person a
     * thread may be started with is ALREADY a row in the list (a
     * "Tap to start a conversation" placeholder), so the separate ＋ button and
     * its floating picker — a second way into the same list, and the one most
     * people never found — are gone.
     */
    function bindConversationList() {
        // Delegated on the LIST, not on each row: rows are re-rendered as
        // innerHTML whenever the snapshot or the filter changes, so a
        // listener bound per row would be destroyed on every repaint.
        if (els.list) {
            els.list.addEventListener('click', function (event) {
                const row = event.target.closest
                    ? event.target.closest('.chat-row')
                    : null;
                if (!row) return;
                const roomId = row.getAttribute('data-room-id');
                if (!roomId) return;
                selectConversation(roomId);
            });
        }

        // Search filters client-side. The set is small (a 1:1 list of
        // colleagues), so a round trip per keystroke would be slower and no
        // more correct.
        if (els.listSearch) {
            els.listSearch.addEventListener('input', function (event) {
                conversationFilter = event.target.value || '';
                renderConversationList();
            });
        }

        // Back (mobile): drop back to the list rather than closing the modal.
        if (els.backBtn) {
            els.backBtn.addEventListener('click', function () {
                if (els.overlay) els.overlay.classList.remove('chat-showing-thread');
                // Withdraw the typing indicator, or the other person keeps
                // seeing "…" for a thread we have navigated away from.
                withdrawPresence();
                if (els.listSearch) els.listSearch.focus();
            });
        }
    }

    function bindEvents() {
        // The circle opens the chat on a plain click; a drag is filtered
        // out inside onLauncherClick().
        els.launcher.addEventListener('click', onLauncherClick);
        els.closeBtn.addEventListener('click', closeModal);

        bindConversationList();

        enableLauncherDrag();

        // Keep the circle on screen if the window is resized smaller, so
        // it can never be stranded outside the visible area.
        window.addEventListener('resize', function () {
            if (!isMounted || !els.launcher) return;
            const left = parseFloat(els.launcher.style.left);
            const top = parseFloat(els.launcher.style.top);
            if (isNaN(left) || isNaN(top)) return; // never dragged
            const pos = clampToViewport(left, top);
            applyLauncherPosition(pos.x, pos.y);
        });

        // Clicking the dimmed backdrop (but not the card) closes.
        els.overlay.addEventListener('click', function (event) {
            if (event.target === els.overlay) closeModal();
        });

        els.sendBtn.addEventListener('click', sendMessage);

        // History pager. Click AND keyboard/scroll reaching the top, so
        // older messages are reachable without hunting for a button.
        if (els.loadOlderBtn) {
            els.loadOlderBtn.addEventListener('click', function () { loadOlderMessages(); });
        }
        if (els.log) {
            // Fetch the next page when the user scrolls to the very top.
            // Guarded so it fires once per arrival at the top, not on every
            // scroll event while parked there.
            //
            // ⚠️ The `programmaticScroll` guard matters now that the log is
            // genuinely the scroll container. Before this fix the log never
            // scrolled and this handler never fired at all. Now it does, and
            // a scroll we caused ourselves — innerHTML being reassigned (which
            // resets scrollTop to 0) or scrollLogToBottom() — must not be
            // mistaken for the user reaching the top of history.
            els.log.addEventListener('scroll', function () {
                if (programmaticScroll) return;
                if (els.log.scrollTop <= 24 && hasMoreHistory && !historyLoading) {
                    loadOlderMessages();
                }
            });
        }

        // Enter sends, Shift+Enter inserts a new line.
        els.input.addEventListener('keydown', function (event) {
            // The open picker owns these keys while it is visible, so Enter
            // picks a row instead of sending a half-typed token.
            if (els.mentionMenu && !els.mentionMenu.hidden) {
                // Which picker is open? `pickerMode` is set by the render
                // function that filled the menu and cleared by
                // closeMentionMenu(), so asking it is unambiguous. This used
                // to be inferred from `mentionMatches.length === 0`, which
                // cannot tell a ticket list from a violation list (both leave
                // that array empty) and would route Enter to the wrong apply
                // function.
                const mode = pickerMode;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    if (mode === PICKER_TICKET) {
                        moveTicketPickerSelection(event.key === 'ArrowDown' ? 1 : -1);
                        return;
                    }
                    if (mode === PICKER_VIOLATION) {
                        moveViolationPickerSelection(event.key === 'ArrowDown' ? 1 : -1);
                        return;
                    }
                    const n = mentionMatches.length;
                    mentionIndex = event.key === 'ArrowDown'
                        ? (mentionIndex + 1) % n
                        : (mentionIndex - 1 + n) % n;
                    updateMentionMenu();
                    return;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                    if (mode === PICKER_TICKET) {
                        const pick = els.mentionMenu.querySelectorAll('[data-ticket-pick]')[ticketIndexSelection];
                        if (pick) {
                            event.preventDefault();
                            applyTicketPick(pick.getAttribute('data-ticket-pick'));
                            return;
                        }
                    } else if (mode === PICKER_VIOLATION) {
                        const pick = els.mentionMenu.querySelectorAll('[data-violation-pick]')[violationIndexSelection];
                        if (pick) {
                            event.preventDefault();
                            applyViolationPick(pick.getAttribute('data-violation-pick'));
                            return;
                        }
                    } else if (mentionMatches[mentionIndex]) {
                        event.preventDefault();
                        applyMention(mentionMatches[mentionIndex]);
                        return;
                    }
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    closeMentionMenu();
                    return;
                }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendMessage();
            }
        });

        // Keep the picker in sync with what is being typed.
        //
        // ⚠️ ORDER MATTERS — SPECIFIC WINS OVER GENERAL. Three tokens can open
        // this one menu and they overlap, so they are tried most-specific
        // first:
        //   1. "@ticket" / "@violation"  — an explicit request for a list
        //   2. "ticket " / "violation "   — the plain-word form
        //   3. "@"                        — people
        // A bare "@" must never win over a ref token earlier in the message,
        // or updateMentionMenu() would open the people list on top of it.
        //
        // ⚠️ syncTicketPicker() / syncViolationPicker() are what load the
        // indexes, and they are called HERE — on the keystroke — rather than
        // from inside the query functions. When that call lived in the query
        // function its .then() callback re-entered it, attaching another
        // .then(), and so on: the page froze the moment the index resolved.
        // Both query functions are pure predicates.
        els.input.addEventListener('input', function () {
            syncRefPicker();
            syncDraftPresence();
        });
        els.input.addEventListener('paste', syncDraftPresence);
        // Clicking away (or moving the caret) dismisses the picker.
        els.input.addEventListener('blur', function () {
            setTimeout(closeMentionMenu, 120);
        });
        els.input.addEventListener('click', function () {
            syncRefPicker();
        });
        els.input.addEventListener('keyup', function (event) {
            // Arrows/Home/End move the caret, which can close a token.
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(event.key) > -1) {
                syncRefPicker();
            }
        });

        // Picking a person, a ticket, or a violation report with the mouse.
        if (els.mentionMenu) {
            els.mentionMenu.addEventListener('mousedown', function (event) {
                const option = event.target.closest
                    ? event.target.closest('.chat-mention-option')
                    : null;
                if (!option) return;
                // mousedown, not click: blur would close the menu first.
                event.preventDefault();
                // The row type is decided by which attribute is PRESENT. Each
                // row carries exactly ONE of data-mention-name,
                // data-ticket-pick or data-violation-pick, so every ordering is
                // unambiguous — but the person row is tested first because a
                // person row is the one type that MUST short-circuit. Probing
                // for a ref attribute first would be ambiguous, because an
                // attribute lookup cannot be assumed to return null for an
                // attribute that is simply absent on some element.
                const mentionName = option.getAttribute('data-mention-name');
                if (mentionName) {
                    applyMention({
                        name: mentionName,
                        email: option.getAttribute('data-mention-email')
                    });
                    return;
                }
                const ticketId = option.getAttribute('data-ticket-pick');
                if (ticketId) { applyTicketPick(ticketId); return; }
                // ⚠️ THIS BRANCH WAS MISSING, AND ITS ABSENCE IS THE WHOLE BUG.
                // violationPickerRow() marks its rows with data-violation-pick,
                // but nothing in this handler ever read that attribute, so a
                // click on a report row fell off the end of the listener and did
                // nothing at all — the menu opened, the row highlighted, and
                // clicking it did nothing visible.
                //
                // The KEYBOARD path was already wired, because the keydown
                // handler dispatches on `pickerMode` rather than on a data
                // attribute. That asymmetry is exactly the reported symptom:
                // the arrow keys and Enter worked, and the mouse did not.
                //
                // Probed LAST, after the person and ticket rows. Each row type
                // carries exactly one of the three attributes, so no ordering
                // can be ambiguous, and keeping the person row first preserves
                // the rule documented above.
                const violationId = option.getAttribute('data-violation-pick');
                if (violationId) applyViolationPick(violationId);
            });
        }

        // ⚠️ DUPLICATE REGISTRATION REMOVED. This used to read:
        //     els.input.addEventListener('input', syncDraftPresence);
        //     els.input.addEventListener('paste', syncDraftPresence);
        // directly in addition to the pair above, so ONE keystroke published TWO
        // presence writes and started TWO heartbeats. It was harmless-looking in
        // 1:1 (the extra write was simply idempotent), but it doubles the write
        // traffic for a feature that now also runs in the group room, where every
        // member is publishing. The listeners above already call
        // syncDraftPresence() on input and on paste, so this pair was pure
        // duplication.

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && els.overlay.classList.contains('active')) {
                closeModal();
            }
        });
    }

    // ==============================================================
    //  DRAGGABLE LAUNCHER
    //
    //  Pointer Events cover mouse, touch and pen with one code path.
    //  setPointerCapture keeps the drag tracking even when the pointer
    //  leaves the button, which is essential for touch.
    // ==============================================================

    function viewportSize() {
        return {
            width: window.innerWidth || document.documentElement.clientWidth || 0,
            height: window.innerHeight || document.documentElement.clientHeight || 0
        };
    }

    /** Current on-screen size of the circle (0 in non-layout contexts). */
    function launcherSize() {
        const el = els.launcher;
        if (!el) return { width: 54, height: 54 };
        const rect = typeof el.getBoundingClientRect === 'function'
            ? el.getBoundingClientRect()
            : null;
        const width = (rect && rect.width) || el.offsetWidth || 54;
        const height = (rect && rect.height) || el.offsetHeight || 54;
        return { width: width, height: height };
    }

    /**
     * Keep the circle inside the viewport, leaving an edge margin so it
     * can never be dropped somewhere unreachable. Returns the corrected
     * coordinates (the raw values are returned when there is no layout
     * information, e.g. in unit tests).
     */
    function clampToViewport(x, y) {
        const view = viewportSize();
        if (!view.width || !view.height) return { x: x, y: y };

        const size = launcherSize();
        const maxX = Math.max(LAUNCHER_EDGE_MARGIN, view.width - size.width - LAUNCHER_EDGE_MARGIN);
        const maxY = Math.max(LAUNCHER_EDGE_MARGIN, view.height - size.height - LAUNCHER_EDGE_MARGIN);

        return {
            x: Math.min(Math.max(x, LAUNCHER_EDGE_MARGIN), maxX),
            y: Math.min(Math.max(y, LAUNCHER_EDGE_MARGIN), maxY)
        };
    }

    /** Move the circle to a viewport position (already clamped). */
    function applyLauncherPosition(x, y) {
        if (!els.launcher || !els.launcher.style) return;
        // Switch from the stylesheet's right-anchored default to explicit
        // left/top coordinates once the user has positioned it.
        els.launcher.style.left = x + 'px';
        els.launcher.style.top = y + 'px';
        els.launcher.style.right = 'auto';
        positionTypingPill();
    }

    /**
     * The typing pill is a separate fixed element. Once the circle is
     * dragged it must follow, otherwise the pill detaches and floats at
     * the wrong place on screen.
     */
    function positionTypingPill() {
        if (!els.launcherTyping || !els.launcher || !els.launcherTyping.style) return;

        const size = launcherSize();

        const pillWidth = els.launcherTyping.offsetWidth || 180;
        const pillHeight = els.launcherTyping.offsetHeight || 34;

        const circleLeft = parseFloat(els.launcher.style.left);
        const circleTop = parseFloat(els.launcher.style.top);
        if (isNaN(circleLeft) || isNaN(circleTop)) return; // not dragged yet

        // Prefer the left of the circle; flip to the right if there is no
        // room, so the pill is always on screen.
        let left = circleLeft - pillWidth - 10;
        if (left < LAUNCHER_EDGE_MARGIN) {
            left = circleLeft + size.width + 10;
        }

        const top = circleTop + (size.height - pillHeight) / 2;

        els.launcherTyping.style.left = Math.max(LAUNCHER_EDGE_MARGIN, left) + 'px';
        els.launcherTyping.style.top = top + 'px';
        els.launcherTyping.style.right = 'auto';
    }

    /** Heal installs of the OLD version, which persisted the position in
     *  localStorage — a stale {x, y} from another viewport would otherwise
     *  yank the circle away from its bottom-right default on first load. */
    function clearStaleLauncherPosition() {
        try {
            localStorage.removeItem(LAUNCHER_POS_KEY);
        } catch (e) { /* ignore */ }
    }

    /** Forget the saved position so the circle returns to its CSS default. */
    function resetLauncherPosition() {
        try {
            localStorage.removeItem(LAUNCHER_POS_KEY);
        } catch (e) { /* ignore */ }

        if (els.launcher && els.launcher.style) {
            els.launcher.style.left = '';
            els.launcher.style.top = '';
            els.launcher.style.right = '';
        }
        if (els.launcherTyping && els.launcherTyping.style) {
            els.launcherTyping.style.left = '';
            els.launcherTyping.style.top = '';
            els.launcherTyping.style.right = '';
        }
    }

    // ==============================================================
    //  DRAG HANDLERS
    // ==============================================================

    function onLauncherPointerDown(event) {
        if (!isMounted || !els.launcher) return;

        // Ignore secondary mouse buttons so a right-click never starts a drag.
        if (event.button !== undefined && event.button !== 0) return;

        const rect = typeof els.launcher.getBoundingClientRect === 'function'
            ? els.launcher.getBoundingClientRect()
            : { left: 0, top: 0 };

        dragState = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            // Distance from the pointer to the circle's top-left corner,
            // so the circle does not jump so its centre is under the cursor.
            grabOffsetX: event.clientX - rect.left,
            grabOffsetY: event.clientY - rect.top,
            moved: false,
            lastX: rect.left,
            lastY: rect.top
        };

        // Capture keeps the drag tracking if the pointer leaves the button,
        // which is essential for touch.
        if (typeof els.launcher.setPointerCapture === 'function' && event.pointerId !== undefined) {
            try { els.launcher.setPointerCapture(event.pointerId); } catch (e) { /* ignore */ }
        }
    }

    function onLauncherPointerMove(event) {
        if (!dragState) return;
        // Ignore moves from other pointers (e.g. a second finger).
        if (event.pointerId !== undefined && dragState.pointerId !== undefined &&
            event.pointerId !== dragState.pointerId) return;

        const dx = event.clientX - dragState.startX;
        const dy = event.clientY - dragState.startY;

        // Not past the threshold yet: treat as a click, don't move anything.
        if (!dragState.moved) {
            if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
            dragState.moved = true;
            // Suppress the hover scale/translate so the circle tracks the
            // pointer precisely instead of jittering under the cursor.
            if (els.launcher) els.launcher.classList.add('chat-launcher-dragging');
        }

        const pos = clampToViewport(
            event.clientX - dragState.grabOffsetX,
            event.clientY - dragState.grabOffsetY
        );

        applyLauncherPosition(pos.x, pos.y);

        if (event.preventDefault) event.preventDefault();
    }

    function onLauncherPointerUp(event) {
        if (!dragState) return;
        if (event.pointerId !== undefined && dragState.pointerId !== undefined &&
            event.pointerId !== dragState.pointerId) return;

        if (typeof els.launcher !== 'undefined' && els.launcher &&
            typeof els.launcher.releasePointerCapture === 'function' && event.pointerId !== undefined) {
            try { els.launcher.releasePointerCapture(event.pointerId); } catch (e) { /* ignore */ }
        }

        if (dragState.moved) {
            // A drag ends with a click event on most browsers; swallow that
            // one click so releasing a drag never opens the chat.
            suppressNextLauncherClick = true;
            if (els.launcher) els.launcher.classList.remove('chat-launcher-dragging');
        }

        dragState = null;
    }

    /** Click on the circle: opens the chat, unless we just finished a drag. */
    function onLauncherClick() {
        if (suppressNextLauncherClick) {
            suppressNextLauncherClick = false;
            return;
        }
        openModal();
    }

    function enableLauncherDrag() {
        if (!els.launcher) return;
        els.launcher.addEventListener('pointerdown', onLauncherPointerDown);
        els.launcher.addEventListener('pointermove', onLauncherPointerMove);
        els.launcher.addEventListener('pointerup', onLauncherPointerUp);
        els.launcher.addEventListener('pointercancel', onLauncherPointerUp);

        // Double-click resets the circle back to its default corner.
        els.launcher.addEventListener('dblclick', function (event) {
            if (event && event.preventDefault) event.preventDefault();
            resetLauncherPosition();
        });
    }

    // ==============================================================
    //  MODAL OPEN / CLOSE
    // ==============================================================

    function openModal() {
        // A rules-level block keeps the button visible but inert, so the
        // user sees WHY chat is unavailable instead of a circle that
        // silently disappeared.
        if (chatDisabledReason) {
            showToast(chatDisabledReason, 'error');
            return;
        }
        if (!isMounted || els.overlay.classList.contains('active')) return;
        els.overlay.classList.add('active');
        // The log is only focusable once a conversation is open, and there is
        // nothing to read yet, so focus the search box instead — it is the
        // first thing a user reaching the list actually wants.
        //
        // ⚠️ Auto-focus is DESKTOP-ONLY. On a phone, focusing the composer
        // <textarea> summons the software keyboard, which covers half the
        // thread and yanks the view down to the input — so every tap that
        // opens the chat "jumps to the textbox". `canHover()` is the existing
        // touch test (false on phones): skip the focus there and let the user
        // tap the composer when THEY want to type. `scrollLogToBottom()` still
        // runs so the thread lands on the newest message either way. The
        // `typeof` guard keeps this safe in the isolated unit-test sandboxes
        // that lift this function out on its own (there canHover is absent, and
        // the desktop default — focus — is what those tests assert).
        if (els.input && !els.input.disabled) {
            if (typeof canHover !== 'function' || canHover()) els.input.focus();
            scrollLogToBottom();
        } else if (els.listSearch) {
            if (typeof canHover !== 'function' || canHover()) els.listSearch.focus();
        }
        // Everything currently in the OPEN thread counts as read from now on.
        stampLastSeen();
        clearUnreadForActiveRoom();
        // Forced: opening is an explicit "I have read this", so it must
        // not be swallowed by the write throttle. Guarded so a click that
        // did not actually reveal the modal writes nothing.
        if (isChatActuallyVisible()) markThreadRead(true);
        // The floating pill is redundant (and hidden behind the overlay)
        // while the chat is open.
        if (els.launcherTyping) els.launcherTyping.hidden = true;
        if (els.launcher) els.launcher.classList.remove('chat-is-typing');
    }

    function closeModal() {
        if (!isMounted) return;
        els.overlay.classList.remove('active');
        if (els.launcher) els.launcher.focus();
        // Re-evaluate immediately so a typing indicator that arrived while
        // the chat was open is visible again on the launcher straight away.
        if (lastPresence && lastPresence.length) renderTypingIndicator(lastPresence);
    }

    /**
     * True while WE are moving the log, so the auto-page-on-scroll handler
     * does not mistake our own scrolling for the user reaching the top of
     * history. Reassigned innerHTML resets scrollTop to 0, which would
     * otherwise look exactly like "scrolled to the very top".
     */
    var programmaticScroll = false;

    function scrollLogToBottom() {
        if (!els.log) return;
        programmaticScroll = true;
        els.log.scrollTop = els.log.scrollHeight;
        // Cleared on the next tick, by which time the browser has dispatched
        // the scroll event our assignment caused.
        setTimeout(function () { programmaticScroll = false; }, 0);
    }

    function clearUnreadBadge() {
        if (els.badge) {
            els.badge.hidden = true;
            els.badge.textContent = '0';
        }
    }

    function setUnreadBadge(count) {
        if (!els.badge) return;
        if (count > 0) {
            els.badge.textContent = count > 99 ? '99+' : String(count);
            els.badge.hidden = false;
        } else {
            clearUnreadBadge();
        }
    }

    // ==============================================================
    //  FIRESTORE
    // ==============================================================

    /**
     * The room document for the CONVERSATION CURRENTLY OPEN.
     *
     * ⚠️ This used to return a single fixed doc (`chats/owner-superadmin`),
     * which is why every HR shared one stream. It is now null until a row is
     * selected. Every subcollection below is derived from it, so reactions,
     * read receipts, presence and pagination all follow the open
     * conversation automatically instead of each needing their own switch.
     */
    function roomRef() {
        if (!activeRoomId) return null;
        return db.collection('chats').doc(activeRoomId);
    }

    function messagesRef() {
        const room = roomRef();
        return room ? room.collection('messages') : null;
    }

    /**
     * The people directory, read from and written to the LEGACY room's
     * `profiles` subcollection: chats/owner-superadmin/profiles/{emailKey}.
     *
     * ⚠️ WHY THE LEGACY ROOM, AND NOT A NEW `chatProfiles` COLLECTION.
     * A new top-level collection would need a NEW rule to be readable, and
     * until that rule is DEPLOYED the read is denied and the whole
     * conversation list fails closed — on a free plan that means asking you
     * to deploy before anything works. Reusing the legacy room's
     * `profiles` subcollection needs NO new rule: the already-deployed rules
     * grant `isHrOrSuperAdmin()` read/write there, so the directory works
     * today with zero deployment. The legacy room is only used as a
     * well-known container for names; no messages are ever written to it (the
     * rules refuse that, and the client disables its composer).
     *
     * Everyone still writes ONLY their own doc (the deployed create/update
     * rules require `email == selfEmail()`), so a person cannot forge a
     * colleague's name.
     */
    function directoryRef() {
        return db.collection('chats').doc(LEGACY_ROOM_ID).collection('profiles');
    }

    function myDirectoryRef() {
        return directoryRef().doc(emailKeyFor(currentUserEmail));
    }

    /** Coerce a Firestore Timestamp / Date / ISO string into a Date. */
    function toDate(value) {
        if (!value) return null;
        if (value.toDate) return value.toDate();
        if (value instanceof Date) return value;
        const parsed = new Date(value);
        return isNaN(parsed.getTime()) ? null : parsed;
    }

    function formatTime(value) {
        const date = toDate(value);
        if (!date) return '';
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    /** Short display name: the part of the email before the "@". */
    function displayNameFor(email, fallbackName) {
        if (fallbackName) return String(fallbackName);
        const raw = String(email || '').trim();
        if (!raw) return 'Unknown';
        return raw.split('@')[0];
    }

    // email -> { displayName, title, role }. Populated by the directory
    // listener; empty (and harmless) until someone publishes one.
    var chatProfiles = {};

    function profilesRef() {
        return roomSubcollection('profiles');
    }

    function myProfileRef() {
        // New rooms resolve names from the global `chatProfiles` directory
        // instead, so this legacy room-scoped roster is only still used by
        // the archive, which is exactly where the old profiles live.
        return profilesRef().doc(emailKeyFor(currentUserEmail));
    }

    /**
     * A per-room subcollection, or null when no conversation is open.
     *
     * ⚠️ Every per-room accessor goes through this. `roomRef()` returns null
     * until a row is picked, and `null.collection(...)` is a TypeError — so
     * without these guards a background tick (the typing sweep, the receipt
     * throttle flushing, a reaction) would throw on a page where the user
     * has only just opened the list and not chosen anything yet.
     */
    function roomSubcollection(name) {
        const room = roomRef();
        return room ? room.collection(name) : null;
    }

    /**
     * Publish this person's own entry to the people directory, so other
     * people can find them in the conversation list and see a real name
     * instead of an email address. Best-effort: a denied write only means
     * the list shows the email prefix, so it must never break the chat.
     *
     * ⚠️ The field set is EXACTLY the already-deployed allowlist
     * (`email, role, displayName, title`). Adding an `active` flag would be
     * denied by `hasOnly()`, and since this write is not batched with the
     * message it would fail quietly — leaving a stale name in the list.
     * "Active" is therefore inferred from the role instead (see isStartable).
     */
    function saveMyDirectoryEntry(displayName, title) {
        if (!currentUserEmail) return Promise.resolve(false);
        const payload = {
            email: currentUserEmail,
            role: currentRole || '',
            displayName: String(displayName || '').trim().slice(0, 60),
            title: String(title || '').trim().slice(0, 60)
        };
        return myDirectoryRef().set(payload, { merge: true })
            .then(function () { return true; })
            .catch(function (error) {
                console.warn('[Chat] Directory entry not saved:', error && error.message);
                return false;
            });
    }

    /**
     * The directory listener. Populates `directory` (email -> profile) and
     * repaints the conversation list, which is rendered from it.
     */
    function startDirectoryListener() {
        if (directoryUnsub) return;
        try {
            directoryUnsub = directoryRef().onSnapshot(function (snapshot) {
                const next = {};
                snapshot.forEach(function (doc) {
                    const data = doc.data() || {};
                    if (!data.email) return;
                    next[String(data.email).toLowerCase()] = data;
                });
                directory = next;
                // Keep the in-thread name resolution in step with the global
                // directory, so a message header and its list row can never
                // show two different names for the same person.
                chatProfiles = next;
                renderConversationList();
                // The directory has reported at least once, so a refused room
                // read can now be judged against a complete picture of who
                // exists (see the forget rule in subscribeRoomForList()).
                peopleSettled = true;
                // A new person in the directory is a new possible room, so the
                // denied-query fallback has to be told about them.
                startPerRoomConversationListeners();
                if (els.log && lastRenderedMessages.length) {
                    renderMessages(lastRenderedMessages);
                }
            }, function (error) {
                // The directory is a convenience, not a permission: if it is
                // denied (stale rules) the chat still works, people just
                // appear by their email prefix.
                console.warn('[Chat] People directory unavailable:', error && error.message);
            });
        } catch (error) {
            console.warn('[Chat] People directory unavailable:', error && error.message);
        }
    }

    function stopDirectoryListener() {
        // The people picture is no longer known to be complete, so a refused
        // room read must not be acted on until the directory reports again.
        peopleSettled = false;
        if (directoryUnsub) {
            try { directoryUnsub(); } catch (e) { /* ignore */ }
            directoryUnsub = null;
        }
    }

    /**
     * Load the AUTHORITATIVE account roster (the `users` collection) — for
     * BOTH chat roles, and LIVE.
     *
     * ⚠️ WHICH PROBLEM THIS SOLVES. The directory
     * (`chats/owner-superadmin/profiles`) is SELF-PUBLISHED: a person gets an
     * entry only once they have opened the chat and saved a profile, and the
     * `role` in that entry is whatever was current at that moment. So a
     * brand-new HR who has never opened the chat is missing from the
     * superadmin's list entirely, a brand-new SUPERADMIN is missing from every
     * HR's list, and an entry written before the role was known (`role: ''`)
     * is filtered out by isStartable() — together those are "I cannot message
     * the new account".
     *
     * The role the app actually authorises on is `users/{email}.role`: the
     * rules read it to decide who may use the chat at all, and the dashboard
     * writes it when an account is approved or re-roled — so `users` knows an
     * account the moment it is registered, while the directory knows it only
     * once its owner shows up. That is why the roster, not the directory, is
     * what has to carry both directions of the list.
     *
     * ⚠️ THE TWO SIDES READ DIFFERENTLY, BECAUSE THE RULES DO:
     *
     *   superadmin → `allow read: if isSuperAdmin() || isSelf()` — the WHOLE
     *                collection (script.js loadSuperadminUsers() already does
     *                exactly that in production), deliberately WITHOUT a
     *                `where()`: no index on the free plan, and it survives a
     *                role stored with stray case or whitespace ('HR', ' hr '),
     *                which an equality filter would silently miss.
     *   hr         → `allow read: if isHrOrSuperAdmin() && resource.data.role
     *                == 'superadmin'` — per-document, so it is provable only
     *                for a query filtered the same way. Hence the ONE
     *                `where()` below; an unfiltered HR read would be denied.
     *                It cannot miss anyone, because chat access itself is
     *                granted by the case-sensitive `role in ['hr',
     *                'superadmin']`, so every account that may chat already
     *                stores the lowercase value.
     *
     * ⚠️ LIVE, NOT ONE-SHOT. A single `.get()` answered only for the device
     * that asked, at mount: an account approved on somebody else's machine —
     * or while this page was open — stayed invisible until a reload.
     * `onSnapshot` is what makes "a newly registered account appears" true on
     * every screen with no refresh (the roster is still re-subscribed by
     * ChatService.refreshDirectory() right after an approval, which is when
     * script.js already calls it).
     *
     * ⚠️ IT IS A CONVENIENCE, NEVER A PERMISSION. A denied/failed roster read
     * is reported once and degrades to the directory: people then appear as
     * soon as they publish a profile, and the chat never greys itself out.
     */
    function loadHrRoster() {
        rosterEntries = {};
        // Only the two chat roles ever read it. An owner or an operator has no
        // chat at all, so asking would be a refused read that proves nothing.
        if (!canChat(currentRole)) return;
        if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') return;
        // Release the PREVIOUS listener first: this runs at mount AND from
        // refreshDirectory(), so without this a second subscription would
        // write the same state twice (the guard startDirectoryListener()
        // already has).
        if (rosterUnsub) {
            try { rosterUnsub(); } catch (e) { /* already gone */ }
            rosterUnsub = null;
        }
        // The ONLY people this person may start a thread with (isStartable()).
        // Filtering the roster to exactly those roles keeps the two in lockstep,
        // so a role the pairing rule would refuse can never become a row — and
        // in particular an Area Manager NEVER sees another Area Manager here.
        const wanted = rosterWantedRoles();
        const apply = function (snapshot) {
            const next = {};
            snapshot.forEach(function (doc) {
                const data = (doc && typeof doc.data === 'function' ? doc.data() : null) || {};
                if (wanted.indexOf(normalizeRole(data.role)) === -1) return;
                const email = String(data.email || (doc && doc.id) || '').trim().toLowerCase();
                if (!email) return;
                next[email] = {
                    email: email,
                    role: normalizeRole(data.role),
                    // `users` holds the name given at registration, so even
                    // a person who never saved a chat profile shows a real
                    // name instead of an email prefix.
                    displayName: String(data.name || '').trim()
                };
            });
            rosterEntries = next;
            renderConversationList();
            // A newly approved account is a new possible room AND a new row: the
            // denied-query fallback must subscribe to it, or their
            // conversation would never appear even after they message first.
            startPerRoomConversationListeners();
        };
        const failed = function (error) {
            rosterUnsub = null;
            // A roster read is a convenience, not a permission: if it is
            // denied (an older or hand-edited ruleset) everything still
            // works, people just have to publish a directory entry first.
            console.warn('[Chat] HR roster unavailable:', error && error.message);
        };
        // ⚠️ try/catch AS WELL AS the listener's error callback: `db.collection()`
        // can throw SYNCHRONOUSLY, and init() calls this — a throw here would
        // take the launcher down with it. Same reasoning as
        // startDirectoryListener().
        try {
            let source = db.collection('users');
            // The non-superadmin reads are the ones that must be provable from
            // the rules, so each carries exactly the filter its clause restates:
            //   HR            → where('role','==','superadmin')
            //   Area Manager / RM/SM → no personal-chat roster at all: the
            //                         store meets in the branch group chat
            //                         (rosterWantedRoles() returns [] for them)
            // The superadmin's whole-collection read (already deployed, already
            // in production) stays unfiltered — no index, and it survives a role
            // stored with stray case or whitespace.
            //
            // ⚠️ These filters are the ONLY reason the roster is readable at all.
            // An unfiltered read is denied, because the rules are per-document.
            // These roles have no paired peer → their roster is empty.
            // `rosterWantedRoles()` returns [] for them, so the read resolves
            // empty and the directory simply stays empty.
            if (currentRole === 'owner' || currentRole === 'rmsm') {
                source = source.where('role', 'in', rosterWantedRoles());
            } else if (currentRole !== 'superadmin') {
                source = source.where('role', '==', 'superadmin');
            }
            rosterUnsub = source.onSnapshot(apply, failed);
        } catch (error) {
            failed(error);
        }
    }

    /**
     * The roles this person may START a thread with — the exact set the pairing
     * rule (isStartable) accepts, derived from CHAT_ALLOWED_ROLES rather than
     * written out again, so adding a chat role cannot leave the roster behind.
     *
     * "Every chat role except my own": A superadmin may start with HRs, an HR with superadmins, and nobody else.
     * No Area Manager thread exists now
      * No store-side role starts a personal thread now.
      * No store-side role starts a personal thread. The branch group chat carries those threads instead.
     * also means a superadmin's own role is excluded here, so the query below
     * still needs its own unfiltered branch.
     */
    function rosterWantedRoles() {
        const mine = normalizeRole(currentRole);
        // Strict pairing (see isStartable): each role has exactly ONE peer it
        // may message. The intersection with CHAT_ALLOWED_ROLES keeps this
        // derived from the master allowlist — a new chat role can never leave
        // the roster behind, and the `in` filter always matches the pairing
        // the users read rule is provable from.
        const wanted = pairedRoleFor(mine);
        return CHAT_ALLOWED_ROLES.filter(function (role) { return role === wanted; });
    }

    // ==============================================================
    //  CONVERSATION LIST
    //
    //  The sidebar: one row per conversation, most recent first, with an
    //  unread badge. Rows are merged from TWO sources:
    //
    //    1. `chats` where members array-contains me — conversations that
    //       already exist. Realtime, so a new message reorders the list
    //       and bumps the badge with no refresh.
    //    2. the people directory (chats/owner-superadmin/profiles) — people
    //       who can be STARTED with, so a brand-new HR is visible
    //       immediately instead of being invisible until messaged first.
    //
    //  ⚠️ NO orderBy AND NO NEW RULES ON PURPOSE, SO THIS WORKS ON THE FREE
    //  (SPARK) PLAN WITH NOTHING DEPLOYED. Two things that would each break
    //  it, and both were deliberately avoided:
    //
    //    * `array-contains` + `orderBy` on a different field needs a
    //      COMPOSITE index, which is a paid (Blaze) feature. Sorting is done
    //      CLIENT-side in collectConversationRows() instead.
    //    * a new collection / new room field would need a new rule, and
    //      until it is deployed the read is DENIED and the list is empty.
    //      Both the directory and the unread state therefore reuse paths and
    //      fields the currently-deployed rules already permit.
    // ==============================================================

    /** Cap on rows fetched. Older conversations are reachable by search of
     *  the directory instead, and a 1:1 list is small in practice. */
    var CONVERSATION_LIST_LIMIT = 200;

    /**
     * The profile of a PERSON (by email) for the list and the picker — NOT to
     * be confused with profileFor(msg) further down, which merges a MESSAGE's
     * own sender fields.
     *
     * The self-published directory entry wins for the DISPLAY fields
     * (displayName, title — that is what the person chose to show), while the
     * account roster wins for the ROLE, because `users/{email}.role` is what
     * the rules and the dashboard authorise on and the directory is only a
     * name badge. A directory entry published before the role was known
     * (older versions stored `role: ''`, and a re-roled account can be stale
     * too) must therefore never hide an account the roster says is an HR.
     */
    function personProfileFor(email) {
        const key = String(email || '').toLowerCase();
        const entry = directory[key];
        const roster = rosterEntries[key];
        if (!entry) return roster || {};
        if (!roster) return entry;
        return Object.assign({}, entry, { email: entry.email || key, role: roster.role });
    }

    /** Best display label for a person: directory name, else email prefix. */
    function nameFor(email) {
        const key = String(email || '').toLowerCase();
        return displayNameFor(key, personProfileFor(key).displayName);
    }

    /** Job title for a person, or '' — used as the row's subtitle. */
    function titleFor(email) {
        return String(personProfileFor(email).title || '');
    }

    /** Role colour class for an avatar, matching the in-thread colours. */
    function avatarRoleFor(email) {
        return 'chat-avatar--' + escapeHTML(normalizeRole(personProfileFor(email).role) || 'unknown');
    }

    function initialsFor(name) {
        const parts = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
        if (!parts.length) return '?';
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    /**
     * True when this person can be STARTED in a conversation.
     *
     * STRICT PAIRING (spec) and SYMMETRIC: personal chat exists for exactly
     * ONE pair — superadmin <-> HR. Store personnel (Area Manager / RM/SM)
     * never start a personal thread: they meet HR and the superadmin in the
     * STORE GROUP chat instead:
     *
     *              superadmin     HR     Area Manager    RM/SM
     *   superadmin      ✗         ✓           ✗          ✗
     *   HR              ✓         ✗           ✗          ✗
     *   Area Manager    ✗         ✗           ✗          ✗
     *   RM/SM           ✗         ✗           ✗          ✗
     *
     * The ✗ diagonals are one rule, not special cases: nobody pairs with
     * their own role, and every off-diagonal cell is refused by the ONE
     * pairing map (pairedRoleFor) below.
     *
     * ⚠️ SYMMETRIC ON PURPOSE. A 1:1 room is authorised by MEMBERSHIP, not by
     * who opened it, so a one-way rule would strand a real conversation: if
     * only one side may start the pair, the other can never find the room
     * that exists. One map, consulted from either side, keeps every cell
     * agreeing with its mirror.
     */
    function isStartable(entry) {
        if (!entry) return false;
        const email = String(entry.email || '').toLowerCase();
        if (!email || email === String(currentUserEmail || '').toLowerCase()) return false;
        // The role IS the "is this person still chat-eligible" signal. The
        // directory doc cannot carry an `active` flag, because the
        // already-deployed profile rule allowlists only
        // (email, role, displayName, title) and an extra key would be denied.
        const role = normalizeRole(entry.role);
        if (CHAT_ALLOWED_ROLES.indexOf(role) === -1) return false;
        // Never yourself (already checked above), never your own role.
        if (role === normalizeRole(currentRole)) return false;
        // The pairing map: my role's ONE permitted peer. Declared after this
        // function on purpose — function declarations hoist, and the pairing
        // test's extracted slice (isStartable -> startableEntryFor) must
        // contain BOTH halves of the rule or the sandbox would go quiet.
        return pairedRoleFor(currentRole) === role;
    }

    /**
     * The ONE personal-chat pairing map: each role's single permitted peer.
     * Both isStartable() and rosterWantedRoles() derive from this, so the
     * sidebar rows, the roster query and the pairing rule can never drift
     * apart. Spec: superadmin <-> HR only — a store-side Area Manager or
     * RM/SM never starts a personal thread (they meet in the branch group chat).
     */
    function pairedRoleFor(role) {
        const PAIRED_ROLES = { superadmin: 'hr', hr: 'superadmin' };
        return PAIRED_ROLES[normalizeRole(role)];
    }

    /**
     * True when this person may be in the "All HR" group chat. Deliberately a
     * SEPARATE, narrower test from isStartable(): an Area Manager passes
     * isStartable() (they can hold 1:1 threads) and still fails this, which is
     * what hides the group row from them. Mirrors `isLegacyArchive()` in
     * firestore.rules, which denies the room itself.
     */
    function inGroupRoom() {
        return GROUP_ROOM_ROLES.indexOf(normalizeRole(currentRole)) !== -1;
    }

    /**
     * The profile to JUDGE someone by (see isStartable) — the same single
     * merge as personProfileFor(), named for the rule it feeds so a reader of
     * isStartable() does not have to hold two ideas at once.
     */
    function startableEntryFor(email) {
        return personProfileFor(email);
    }

    /**
     * Everyone the LIST may offer: the union of the self-published directory
     * and the superadmin's account roster. Every one of them is rendered as a
     * row — there is no second, floating list of people to choose from.
     */
    function startableEmails() {
        const all = {};
        Object.keys(directory).forEach(function (email) { all[email] = true; });
        Object.keys(rosterEntries).forEach(function (email) { all[email] = true; });
        return Object.keys(all);
    }

    /**
     * Every row the sidebar should show, newest activity first, filtered by
     * the search box.
     */
    // --------------------------------------------------------------
    //  UNREAD  (localStorage, NOT a Firestore field)
    //
    //  ⚠️ WHY LOCAL AND NOT A ROOM FIELD. A server-side `unreadCount` would
    //  be more robust, but writing a NEW field to the room doc means the
    //  deployed `hasOnly()` allowlist has to be changed and re-deployed
    //  first — and until that happens the create/update is DENIED, which
    //  rolls back the atomic batch and silently stops every message from
    //  saving. Keeping unread in localStorage means the conversation list
    //  works on the currently-deployed rules with nothing to deploy.
    //
    //  The trade-off, stated plainly: unread is PER DEVICE. Open the chat on
    //  your phone and the badge clears there; it does not clear on your
    //  laptop. That is the same trade the old single-room chat already made
    //  with its `rcms_chat_last_seen_<email>` stamp.
    // --------------------------------------------------------------

    /** Per-user, per-room "last read at" stamp, in ms. */
    function unreadStateKey() {
        return 'rcms_chat_unread_' + String(currentUserEmail || 'anon');
    }

    function readUnreadState() {
        try {
            const raw = localStorage.getItem(unreadStateKey());
            const parsed = raw ? JSON.parse(raw) : {};
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (e) {
            // Private mode / corrupt value — degrade to "nothing tracked",
            // which only costs the badge, never the chat.
            return {};
        }
    }

    function writeUnreadState(state) {
        try {
            localStorage.setItem(unreadStateKey(), JSON.stringify(state || {}));
        } catch (e) { /* storage disabled — the badge just won't persist */ }
    }

    /** Mark one conversation as read, right now. */
    function markConversationRead(roomId) {
        if (!roomId || roomId === LEGACY_ROOM_ID) return;
        const state = readUnreadState();
        state[roomId] = Date.now();
        writeUnreadState(state);
    }

    /**
     * Is this conversation unread for US, and by how much?
     *
     * Derived from the room summary we already receive: the conversation is
     * unread when the last message is from the OTHER person and arrived after
     * our own "last read" stamp. That needs no extra field and no extra read.
     */
    function unreadFor(summary) {
        if (!summary || summary.isArchive) return 0;
        const me = String(currentUserEmail || '').toLowerCase();
        const sender = String(summary.lastSenderEmail || '').toLowerCase();
        // Our own message never marks it unread.
        if (!sender || sender === me) return 0;
        const lastAt = Number(summary.lastMessageAtMs) || 0;
        if (!lastAt) return 0;
        const state = readUnreadState();
        const readAt = Number(state[summary.roomId]) || 0;
        if (lastAt <= readAt) return 0;
        // The list cannot know HOW MANY messages arrived without reading the
        // thread, so the badge shows "new" rather than a fabricated count.
        return 1;
    }

    // ==============================================================
    //  SOUND ANNOUNCEMENTS  (per-device, localStorage)
    //
    //  ⚠️ WHY THIS EXISTS, AND WHY IT IS NOT THE READ RECEIPT.
    //  The sound used to fire only from announceNewMessages(), which is
    //  driven by the PER-ROOM message listener — and that listener only
    //  starts in selectConversation() (see the note at the top of
    //  startListener()). So a message arriving in a conversation you had
    //  not opened had NO listener attached at all: no sound, no badge,
    //  nothing. The alert only appeared after you clicked the row, which
    //  is exactly the bug this replaces.
    //
    //  The conversation LIST listener is already live over every room
    //  (startConversationListListener) and already carries
    //  `lastMessageAtMs` + `lastSenderEmail` for each, so announcing from
    //  there covers every conversation with NO extra query, NO extra read
    //  and NO rules change — which matters because the app is on the
    //  free plan.
    //
    //  It cannot be the read receipt: a receipt means "this person looked
    //  at it", and is deliberately only written while the chat is
    //  actually visible (isChatActuallyVisible). A sound is about the
    //  message ARRIVING — you want to hear about it precisely while you
    //  are NOT looking at it.
    //
    //  Per-device, like the unread state above, and for the same reason:
    //  nothing is stored server-side, so nothing needs deploying.
    // ==============================================================

    /** Per-user "last message time I have already announced", per room. */
    function announcedStateKey() {
        return 'rcms_chat_announced_' + String(currentUserEmail || 'anon');
    }

    function readAnnouncedState() {
        try {
            const raw = localStorage.getItem(announcedStateKey());
            const parsed = raw ? JSON.parse(raw) : {};
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (e) {
            // Private mode / corrupt value — degrade to "nothing recorded",
            // which the first-run seeding in announceNewConversations()
            // then repairs in a single write.
            return {};
        }
    }

    function writeAnnouncedState(state) {
        try {
            localStorage.setItem(announcedStateKey(), JSON.stringify(state || {}));
        } catch (e) { /* storage disabled — the sound still plays, it may repeat */ }
    }

    /**
     * Announce (by sound) any conversation whose newest message is newer than
     * the last one we announced for it, and is not the conversation on screen.
     *
     * Called from the conversation-LIST listener, so this covers every room
     * whether or not it is open. One sound per arriving message, with no
     * throttling: a burst plays a burst, because a throttled alert is exactly
     * the "it never warned me" failure this is fixing.
     *
     * Returns the number of messages announced (used by the tests).
     */
    function announceNewConversations(next) {
        const me = String(currentUserEmail || '').toLowerCase();
        const state = readAnnouncedState();
        // ⚠️ THE FIRST SNAPSHOT MUST BE SILENT. With no recorded baseline every
        // existing room looks brand new, so simply opening the app would
        // machine-gun the sound for the user's ENTIRE history. An empty state
        // means "first run": record what is there now, announce nothing, and
        // return — but only AFTER writing, or the next real message would be
        // swallowed along with the history.
        const isFirstRun = Object.keys(state).length === 0;

        let announced = 0;
        Object.keys(next || {}).forEach(function (roomId) {
            const s = next[roomId];
            if (!s || s.isArchive) return;
            const at = Number(s.lastMessageAtMs) || 0;
            if (!at) return;
            const known = Number(state[roomId]) || 0;
            const sender = String(s.lastSenderEmail || '').toLowerCase();
            // Our own message is never news to us — but its time is still
            // recorded, so our message cannot leave a stale baseline that the
            // other side's next message would appear to leap over.
            const isMine = !sender || sender === me;
            // The open conversation is on screen; the thread listener owns it.
            const isOpen = roomId === activeRoomId;
            if (!isMine && !isOpen && at > known) announced++;
            // ⚠️ THE SUMMARY PATH IS A FALLBACK, NOT A PEER. The per-room
            // message watcher (watchRoomForNewMessages) is the authoritative
            // signal because the summary only moves when the sender's preview
            // write is accepted. So if a message watcher is alive for this room,
            // the summary must stay QUIET — otherwise the same message sounds
            // twice, once from each path, in whichever order they arrive.
            if (roomMessageUnsubs[roomId]) { state[roomId] = Math.max(known, at); return; }
            state[roomId] = Math.max(known, at);
        });

        writeAnnouncedState(state);
        if (isFirstRun || announced === 0) return 0;
        for (let i = 0; i < announced; i++) playIncomingSound();
        return announced;
    }

    /** Record that the list listener has sounded for this room/time. */
    function markRoomAnnounced(roomId, atMs) {
        if (!roomId) return;
        const state = readAnnouncedState();
        const at = Number(atMs) || 0;
        state[roomId] = Math.max(Number(state[roomId]) || 0, at);
        writeAnnouncedState(state);
    }

    /** True when the list listener has already sounded for this room/time. */
    function roomAlreadyAnnounced(roomId, atMs) {
        if (!roomId) return false;
        const known = Number(readAnnouncedState()[roomId]) || 0;
        const at = Number(atMs) || 0;
        return !!at && at <= known;
    }

    // ==============================================================
    //  PER-ROOM NEWEST-MESSAGE WATCHERS  (what actually drives the sound)
    //
    //  ⚠️ WHY THE SUMMARY ALONE WAS NOT ENOUGH. The conversation-list
    //  listener carries `lastMessageAt` on each ROOM DOCUMENT, and that field
    //  is only as fresh as the sender's room-preview write — which rides in
    //  the same batch as the message and is REFUSED whenever the deployed
    //  rules are older than this client (see the three-shape ladder in
    //  sendMessage()). Then `writeRoomPreviewQuietly()` is a best-effort
    //  fallback whose errors are swallowed, so `lastMessageAt` never advances
    //  and the summary-based announce correctly reports "no change" — silently,
    //  forever. The GROUP chat never writes a preview at all, so its summary is
    //  permanently 0 and could never announce.
    //
    //  The MESSAGE document is different: it is always written successfully, and
    //  `firestore.rules` already grants `allow read: if canReadChat(chatId)` on
    //  chats/{chatId}/messages. So one listener per room on the NEWEST message
    //  is the signal that is actually true.
    //
    //  Cost: one listener and one doc read per conversation. For the 1:1
    //  HR↔superadmin shape that is a handful; it would be worth revisiting if
    //  anyone accumulated dozens of open conversations.
    // ==============================================================

    /** Per-user "newest message id I have already announced", per room. */
    function announcedIdsKey() {
        return 'rcms_chat_announced_ids_' + String(currentUserEmail || 'anon');
    }

    function readAnnouncedIds() {
        try {
            const raw = localStorage.getItem(announcedIdsKey());
            const parsed = raw ? JSON.parse(raw) : {};
            return (parsed && typeof parsed === 'object') ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function writeAnnouncedIds(state) {
        try {
            localStorage.setItem(announcedIdsKey(), JSON.stringify(state || {}));
        } catch (e) { /* storage disabled — a repeat may sound, which is survivable */ }
    }

    /** Stop every per-room message watcher (teardown / account change). */
    function stopRoomMessageWatchers() {
        Object.keys(roomMessageUnsubs).forEach(function (roomId) {
            try { roomMessageUnsubs[roomId](); } catch (e) { /* ignore */ }
            delete roomMessageUnsubs[roomId];
        });
    }

    /**
     * Watch the NEWEST message in one conversation and sound when it changes.
     *
     * ⚠️ TRACKED BY DOCUMENT ID, NOT TIMESTAMP. Two messages can share a
     * `sentAt` (the server timestamps them in the same batch), and a timestamp
     * comparison would then miss the second one entirely. A document id is
     * unambiguous, so "have I already announced this one?" always has a
     * definite answer.
     *
     * The first snapshot is SILENT and only seeds the id. Without that, merely
     * opening the app would sound once for the newest message of every
     * conversation — the exact "noisy" failure this feature exists to avoid.
     */
    function watchRoomForNewMessages(roomId) {
        if (!roomId || roomMessageUnsubs[roomId]) return;
        if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') return;
        try {
            roomMessageUnsubs[roomId] = db.collection('chats')
                .doc(roomId)
                .collection('messages')
                .orderBy('sentAt', 'desc')
                .limit(1)
                .onSnapshot(function (snapshot) {
                    if (!snapshot || !snapshot.docs || !snapshot.docs.length) return;
                    const doc = snapshot.docs[0];
                    const data = doc.data() || {};
                    const id = doc.id;

                    if (!announcedMessageIds[roomId]) {
                        // First snapshot for this room: seed, stay silent.
                        announcedMessageIds[roomId] = id;
                        const ids = readAnnouncedIds();
                        ids[roomId] = id;
                        writeAnnouncedIds(ids);
                        return;
                    }
                    if (announcedMessageIds[roomId] === id) return;  // nothing new

                    // Record BEFORE sounding, so a throw here cannot cause a
                    // repeat on the next snapshot.
                    announcedMessageIds[roomId] = id;
                    const ids = readAnnouncedIds();
                    ids[roomId] = id;
                    writeAnnouncedIds(ids);

                    const me = String(currentUserEmail || '').toLowerCase();
                    const sender = String(data.senderEmail || '').toLowerCase();
                    // My own message is never news, and the OPEN conversation is
                    // already announced by the thread listener — announcing here
                    // too would make one message sound twice.
                    if (!sender || sender === me) return;
                    if (roomId === activeRoomId) return;

                    const msg = Object.assign({ id: id, roomId: roomId }, data);
                    if (mentionsMe(msg)) announceMention(msg);
                    else playIncomingSound();
                }, function (error) {
                    // ⚠️ ONE ROOM FAILING MUST NOT TAKE THE OTHERS DOWN. A
                    // denied read (rules older than the messages rule) drops
                    // this watcher only; the conversation list and the
                    // summary-based announcement still work. The handle is
                    // released because a dead listener is never retried by the
                    // SDK, and holding it would block every future attempt.
                    try { roomMessageUnsubs[roomId](); } catch (e) { /* ignore */ }
                    delete roomMessageUnsubs[roomId];
                    if (isPermissionError(error)) {
                        console.warn('[Chat] Cannot watch messages in ' + roomId +
                            ' (' + (error && error.code) + '); falling back to the ' +
                            'room-summary sound for that conversation.');
                    }
                });
        } catch (e) { /* a watcher that cannot even be built is simply absent */ }
    }

    /**
     * Keep one watcher per conversation, in step with the list.
     *
     * Called from the conversation-list listener. Rooms that appear get a
     * watcher; rooms that vanish lose theirs. The GROUP chat is included — it
     * writes messages, so it can announce, unlike its summary which is frozen
     * at 0 by design.
     */
    function syncRoomMessageWatchers() {
        const wanted = {};
        Object.keys(conversationSummaries || {}).forEach(function (roomId) {
            if (conversationSummaries[roomId]) wanted[roomId] = true;
        });
        Object.keys(roomMessageUnsubs).forEach(function (roomId) {
            if (!wanted[roomId]) {
                try { roomMessageUnsubs[roomId](); } catch (e) { /* ignore */ }
                delete roomMessageUnsubs[roomId];
            }
        });
        Object.keys(wanted).forEach(watchRoomForNewMessages);
    }


    function collectConversationRows() {
        const me = String(currentUserEmail || '').toLowerCase();
        const rows = [];
        const seen = {};

        Object.keys(conversationSummaries).forEach(function (roomId) {
            const s = conversationSummaries[roomId];
            if (!s || s.isArchive) return;
            const peer = s.peerEmail;
            // A room we cannot attribute to a peer is unusable in a 1:1
            // list, and rendering it could expose another conversation.
            if (!peer || peer === me) return;
            // Spec: a pair that may no longer personal-chat (see isStartable)
            // must not be OFFERED — but ONLY when this peer's role is actually
            // KNOWN. Hiding a conversation whose peer is in neither people
            // source would make a real thread vanish with no way to rediscover
            // it (the remembered-rooms invariant): unknown stays visible, a
            // known-forbidden role is hidden.
            const peerEntry = startableEntryFor(peer);
            if (peerEntry && normalizeRole(peerEntry.role) && !isStartable(peerEntry)) return;
            seen[peer] = true;
            rows.push({
                roomId: roomId,
                peerEmail: peer,
                name: nameFor(peer),
                lastMessage: s.lastMessage || '',
                lastMessageAt: s.lastMessageAtMs || 0,
                unread: unreadFor(s),
                isArchive: false,
                started: true
            });
        });

        // People who can be messaged but have no conversation yet — from the
        // union of the self-published directory and the account roster, so a
        // never-messaged HR is listed even before they ever open the chat.
        startableEmails().forEach(function (email) {
            if (seen[email]) return;
            const entry = startableEntryFor(email);
            if (!isStartable(entry)) return;
            rows.push({
                roomId: myRoomIdWith(email),
                peerEmail: email,
                name: nameFor(email),
                lastMessage: '',
                lastMessageAt: 0,
                unread: 0,
                isArchive: false,
                started: false
            });
        });

        // Newest first. A never-started row has lastMessageAt 0, so it sinks
        // below anything with real history — the expected order.
        rows.sort(function (a, b) {
            if (b.lastMessageAt !== a.lastMessageAt) return b.lastMessageAt - a.lastMessageAt;
            return a.name.localeCompare(b.name);
        });

        // The GROUP chat is pinned LAST and is ALWAYS shown — for every HR and
        // superadmin, whether or not the room document has been read yet. It
        // is a channel everybody is already in, so it must never depend on a
        // summary arriving (and it can never contribute to the unread badge:
        // it is one pinned row, not a conversation that goes quiet).
        // ⚠️ NOT SHOWN TO AN AREA MANAGER. They pass canChat() and hold 1:1
        // threads, but the rules deny them this room (isLegacyArchive is still
        // HR + superadmin), so offering the row would be a guaranteed
        // permission-denied the moment they clicked it. Hide it here rather
        // than letting them open a room that cannot open.
        if (inGroupRoom()) {
            const group = conversationSummaries[LEGACY_ROOM_ID];
            rows.push({
                roomId: LEGACY_ROOM_ID,
                peerEmail: null,
                name: GROUP_ROOM_NAME,
                lastMessage: (group && group.lastMessage) || '',
                lastMessageAt: (group && group.lastMessageAtMs) || 0,
                unread: 0,
                isArchive: true,
                started: true
            });
        }

        // Per-branch rooms: each branch is a separate ALL-MEMBERS broadcast
        // channel. The room appears here only if the list query returned it —
        // i.e. this user is IN its seeded `members` (approval seeds the store
        // team: every assigned member + superadmins) — so the gate below is
        // about who can chat at all, not about membership. Area Managers and
        // RM/SM of this branch DO see the row; roles outside the chat
        // allowlist never do.
        if (inGroupStyleRoom()) {
            const branchRooms = Object.keys(conversationSummaries).filter(function (id) {
                return isBranchRoom(id);
            });
            branchRooms.forEach(function (roomId) {
                const group = conversationSummaries[roomId];
                rows.push({
                    roomId: roomId,
                    peerEmail: null,
                    name: (group && group.title) || branchGroupName(roomId),
                    lastMessage: (group && group.lastMessage) || '',
                    lastMessageAt: (group && group.lastMessageAtMs) || 0,
                    unread: 0,
                    isArchive: true,
                    started: true
                });
            });
        }

        const q = String(conversationFilter || '').trim().toLowerCase();
        if (!q) return rows;
        return rows.filter(function (row) {
            return row.name.toLowerCase().indexOf(q) !== -1 ||
                String(row.lastMessage || '').toLowerCase().indexOf(q) !== -1;
        });
    }

    /** Short relative stamp for a list row: time, Yesterday, or a date. */
    function formatListTime(ms) {
        const date = new Date(ms);
        if (isNaN(date.getTime())) return '';
        const now = new Date();
        if (date.toDateString() === now.toDateString()) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        const yesterday = new Date(now.getTime() - 86400000);
        if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    /** Paint the sidebar from collectConversationRows(). */
    function renderConversationList() {
        if (!els.list) return;
        const rows = collectConversationRows();
        const q = String(conversationFilter || '').trim();

        if (!rows.length) {
            els.list.innerHTML = conversationListReady
                ? '<p class="chat-list-empty">' + (q
                    ? 'No conversations match &ldquo;' + escapeHTML(q) + '&rdquo;.'
                    // No "use the ＋ button" hint any more: there is no ＋ button.
                    // The list itself is the way in — every person a thread may
                    // be started with is already a "Tap to start a conversation"
                    // row in it, so an empty list means nobody to talk to, not
                    // "you have not found the right control yet".
                    : 'Nobody to message yet. New colleagues appear here as soon as their account is approved.') +
                '</p>'
                : '<p class="chat-list-empty">Loading conversations&hellip;</p>';
            return;
        }

        els.list.innerHTML = rows.map(function (row) {
            const isActive = row.roomId === activeRoomId;
            const when = row.lastMessageAt ? formatListTime(row.lastMessageAt) : '';
            // A never-started conversation has no preview and no time; show
            // an invitation to start it rather than a blank line.
            const preview = row.started
                ? escapeHTML(row.lastMessage || 'No messages yet')
                : 'Tap to start a conversation';
            const unreadAttr = row.unread > 0
                ? '<span class="chat-row-unread">' + (row.unread > 99 ? '99+' : row.unread) + '</span>'
                : '';
            return '<button type="button" class="chat-row' + (isActive ? ' is-active' : '') + '"' +
                ' data-room-id="' + escapeHTML(row.roomId) + '"' +
                ' aria-current="' + (isActive ? 'true' : 'false') + '">' +
                '<span class="chat-avatar ' + avatarRoleFor(row.peerEmail) + '" aria-hidden="true">' +
                    escapeHTML(initialsFor(row.name)) + '</span>' +
                '<span class="chat-row-meta">' +
                    '<span class="chat-row-top">' +
                        '<span class="chat-row-name">' + escapeHTML(row.name) + '</span>' +
                        '<span class="chat-row-time">' + escapeHTML(when) + '</span>' +
                    '</span>' +
                    '<span class="chat-row-bottom">' +
                        '<span class="chat-row-preview">' + preview + '</span>' +
                        unreadAttr +
                    '</span>' +
                '</span>' +
            '</button>';
        }).join('');
    }

    /**
     * Subscribe to the conversations I belong to.
     *
     * ⚠️ NO `orderBy()` HERE, ON PURPOSE. Combining `array-contains` with an
     * `orderBy` on a different field needs a COMPOSITE index, and composite
     * indexes are a **Blaze (paid) plan** feature — on the free/Spark plan
     * the query fails with FAILED_PRECONDITION and the sidebar is
     * permanently empty. A single-field `array-contains` uses Firestore's
     * automatic index, which every plan gets for free.
     *
     * The list is sorted CLIENT-side in collectConversationRows() instead.
     * For a 1:1 list of colleagues that is a handful of rows, so it costs
     * nothing and keeps the app on the free plan.
     */
    function startConversationListListener() {
        if (conversationListUnsub) return;
        if (typeof db === 'undefined' || !db || !currentUserEmail) return;
        try {
            conversationListUnsub = db.collection('chats')
                .where('members', 'array-contains', currentUserEmail)
                .limit(CONVERSATION_LIST_LIMIT)
                .onSnapshot(function (snapshot) {
                    const next = {};
                    snapshot.forEach(function (doc) {
                        const data = doc.data() || {};
                        const roomId = doc.id;
                        next[roomId] = {
                            roomId: roomId,
                            lastMessage: data.lastMessage || '',
                            lastMessageAtMs: (toDate(data.lastMessageAt) || new Date(0)).getTime(),
                            lastSenderEmail: data.lastSenderEmail || '',
                            isArchive: roomId === LEGACY_ROOM_ID,
                            // The peer is derived from the ID, never read from
                            // the doc's `members`, so a stale or hand-edited
                            // document cannot make the list show the wrong
                            // person (or another person's thread).
                            peerEmail: roomId === LEGACY_ROOM_ID ? null : peerFromRoomId(roomId)
                        };
                        // Branch rooms: carry `title`/`members` into the
                        // summary too. The row name, the open-header title and
                        // the @mention picker all read them — and this query
                        // path REPLACES the whole map, so without this they
                        // would only survive on the denied-query fallback
                        // (applyRoomSummaryToList copies them as well).
                        if (isBranchRoom(roomId)) {
                            next[roomId].title = data.title || '';
                            if (Array.isArray(data.members)) {
                                next[roomId].members = data.members.slice();
                            }
                        }
                    });
                    conversationSummaries = next;
                    conversationListReady = true;
                    renderConversationList();
                    updateLauncherBadgeFromList();
                    // ⚠️ THE SOUND LIVES HERE, NOT IN THE PER-ROOM LISTENER.
                    // The thread listener only exists for the conversation the
                    // user has OPEN (startListener is called from
                    // selectConversation), so a message in any other
                    // conversation had no listener at all and could not be
                    // announced — the alert only appeared after you clicked the
                    // row. This listener already spans every room, so
                    // announcing from it covers all of them with no extra read
                    // and no rules change.
                    announceNewConversations(next);
                    // ⚠️ AND THE PER-ROOM MESSAGE WATCHERS, which are the
                    // authoritative signal: the room SUMMARY above only moves
                    // when the sender's preview write is accepted, and it is not
                    // always (the group chat never writes one at all). The
                    // message document always is.
                    syncRoomMessageWatchers();
                }, function (error) {
                    conversationListReady = true;
                    renderConversationList();
                    if (isPermissionError(error)) {
                        // ⚠️ THE QUERY IS DENIED; THE ROOM DOCUMENTS ARE NOT. A
                        // query is authorised as ONE rules evaluation over the
                        // whole collection, and the membership rule resolves
                        // every room with exists()/get(), which cannot be
                        // proven that way. Each room document is still
                        // individually readable, so the list is rebuilt from
                        // one listener per room instead of being left empty.
                        // (Without this, selectConversation() finds no summary
                        // for ANY room, so no conversation would ever open its
                        // history — the sidebar is not the only casualty.)
                        conversationListDenied = true;
                        console.warn('[Chat] The `chats` list query is denied by the deployed rules, ' +
                            'so the conversation list is being rebuilt from per-room document reads. ' +
                            'Deploying the rules (firebase deploy --only firestore:rules) ' +
                            'restores the single-query path.');
                        startPerRoomConversationListeners();
                    } else {
                        console.warn('[Chat] Conversation list unavailable:', error && error.message);
                    }
                });
        } catch (error) {
            conversationListReady = true;
            renderConversationList();
            console.warn('[Chat] Conversation list unavailable:', error && error.message);
        }
    }

    function stopConversationListListener() {
        if (conversationListUnsub) {
            try { conversationListUnsub(); } catch (e) { /* ignore */ }
            conversationListUnsub = null;
        }
        // The per-room fallback listeners are part of the same subscription
        // and must be released with it, or a re-init would leave a second
        // set writing the same summaries.
        Object.keys(conversationRoomUnsubs).forEach(function (roomId) {
            const unsub = conversationRoomUnsubs[roomId];
            if (typeof unsub !== 'function') return;
            try { unsub(); } catch (e) { /* ignore */ }
        });
        conversationRoomUnsubs = {};
        conversationRoomsDenied = {};
        // ⚠️ The per-room MESSAGE watchers are part of the same subscription and
        // must be released with it. Left behind, a re-init (role refresh, or an
        // account change) would leave a second set of listeners writing to the
        // same announcement baseline — and a listener that outlives teardown
        // keeps a Firestore read open for a chat the user no longer has.
        stopRoomMessageWatchers();
        announcedMessageIds = {};
        if (deniedRoomRetryTimer) {
            clearTimeout(deniedRoomRetryTimer);
            deniedRoomRetryTimer = null;
        }
    }

    // ---- Remembered rooms (see the REMEMBERED ROOMS note above) ---------

    function knownRoomsKey() {
        return 'rcms_chat_known_' + String(currentUserEmail || 'anon');
    }

    /** Load the remembered rooms of the signed-in account. */
    function loadKnownRooms() {
        knownRooms = {};
        try {
            const raw = localStorage.getItem(knownRoomsKey());
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && typeof parsed === 'object') {
                Object.keys(parsed).forEach(function (roomId) {
                    const at = Number(parsed[roomId]) || 0;
                    if (roomId && at > 0) knownRooms[roomId] = at;
                });
            }
        } catch (e) {
            // Private mode or a corrupt value: the list simply cannot outlive
            // the session, which costs nothing but the re-roled-peer edge case.
            knownRooms = {};
        }
    }

    function saveKnownRooms() {
        try {
            const ids = Object.keys(knownRooms).sort(function (a, b) {
                return knownRooms[b] - knownRooms[a];
            });
            const trimmed = {};
            ids.slice(0, KNOWN_ROOMS_MAX).forEach(function (roomId) {
                trimmed[roomId] = knownRooms[roomId];
            });
            knownRooms = trimmed;
            localStorage.setItem(knownRoomsKey(), JSON.stringify(trimmed));
        } catch (e) { /* storage disabled — best effort, never fatal */ }
    }

    /** Note that this room exists, so it can be re-checked without the query. */
    function rememberRoom(roomId) {
        if (!roomId || roomId === LEGACY_ROOM_ID) return;
        knownRooms[roomId] = Date.now();
        saveKnownRooms();
    }

    /** Stop carrying a room around: it is gone, or was never real. */
    function forgetRoom(roomId) {
        if (!knownRooms[roomId]) return;
        delete knownRooms[roomId];
        saveKnownRooms();
    }

    /**
     * Fold ONE room document into the sidebar — the per-room counterpart of
     * the list query's snapshot.
     *
     * ⚠️ ADDITIVE, where the query's snapshot REPLACES the whole set: here
     * each room reports for itself, and a room that reports as gone is
     * dropped again. `data === null` means "no such document".
     */
    function applyRoomSummaryToList(roomId, data) {
        if (!roomId) return;
        if (!data) {
            if (!conversationSummaries[roomId]) return;
            delete conversationSummaries[roomId];
            conversationListReady = true;
            renderConversationList();
            updateLauncherBadgeFromList();
            return;
        }
        const summary = {
            roomId: roomId,
            lastMessage: data.lastMessage || '',
            lastMessageAtMs: (toDate(data.lastMessageAt) || new Date(0)).getTime(),
            lastSenderEmail: data.lastSenderEmail || '',
            isArchive: roomId === LEGACY_ROOM_ID,
            // The peer is derived from the ID, never read from the document's
            // `members`, so a stale or hand-edited room can never make the
            // list show the wrong person.
            peerEmail: roomId === LEGACY_ROOM_ID ? null : peerFromRoomId(roomId)
        };
        // Branch rooms carry their display `title` (the store name) and full
        // `members` into the summary: the row name, the open header and the
        // @mention picker all read them. The list-query path does the same in
        // startConversationListListener(); this is the per-room fallback path.
        if (isBranchRoom(roomId)) {
            summary.title = data.title || '';
            if (Array.isArray(data.members)) summary.members = data.members.slice();
        }
        conversationSummaries[roomId] = summary;
        // The room reported, so it exists: remember it, or a conversation
        // whose other side later leaves the directory and the roster would
        // vanish from this list with no way to rediscover it.
        rememberRoom(roomId);
        conversationListReady = true;
        renderConversationList();
        updateLauncherBadgeFromList();
        // ⚠️ THE FALLBACK PATH MUST ANNOUNCE TOO. This runs when the list
        // QUERY is denied by the deployed rules, so the sidebar is rebuilt
        // from per-room document reads. The summary announcement has to happen
        // here as well, or a denied query silently costs the user every alert —
        // and the message watchers must be kept in step, or the fallback has no
        // sound at all.
        announceNewConversations(conversationSummaries);
        syncRoomMessageWatchers();

        // ⚠️ A ROOM CAN BE OPENED BEFORE THIS REPORT ARRIVES. The user clicks
        // the row, selectConversation() finds no summary — so it renders the
        // empty state and does not subscribe — and only then does the room
        // document report that it exists. Attach the thread now, or a
        // conversation with history opens blank until the page is reloaded.
        if (roomId === activeRoomId && !messagesUnsub) {
            if (els.log) els.log.innerHTML = '<p class="chat-empty">Loading messages&hellip;</p>';
            startListener();
            startTypingListener();
        }
    }

    /**
     * Listen to ONE room document for the sidebar.
     *
     * ⚠️ A ROOM THAT DOES NOT EXIST IS *DENIED*, NOT EMPTY. The membership
     * rule is `isChatMember(chatId)` = `exists(chats/{chatId}) && selfEmail()
     * in get(chats/{chatId}).data.members`, so a never-created room fails the
     * `exists()` and the read is refused. For somebody you have never messaged
     * that is the NORMAL state, not a fault: it is reported as nothing at all,
     * the "tap to start" row stands, and scheduleDeniedRoomRetry() picks the
     * room up as soon as it really exists.
     */
    function subscribeRoomForList(roomId) {
        if (!roomId || conversationRoomUnsubs[roomId]) return;
        if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') return;
        try {
            conversationRoomUnsubs[roomId] = db.collection('chats').doc(roomId).onSnapshot(
                function (docSnap) {
                    // It reported, so it is readable: stop treating it as
                    // missing and stop re-attempting it.
                    delete conversationRoomsDenied[roomId];
                    applyRoomSummaryToList(
                        roomId,
                        docSnap && docSnap.exists ? (docSnap.data() || null) : null
                    );
                },
                function (error) {
                    // A failed listener is dead — the SDK will not retry it — so
                    // drop the handle or it would block every future attempt
                    // for this room.
                    delete conversationRoomUnsubs[roomId];
                    if (isPermissionError(error)) {
                        // ⚠️ FORGET A ROOM THAT CAN NEVER BE FOUND AGAIN. Once
                        // the people sources have loaded at least once, a room
                        // whose other side is in NEITHER the directory NOR the
                        // account roster cannot be rediscovered — and if its read
                        // is refused too, it is gone for good (an account
                        // re-roled away from the chat, or the room deleted).
                        // Remembering it would mean re-reading it every minute
                        // for the rest of the session for nothing. `peopleSettled`
                        // is what makes this safe: a refusal that arrives before
                        // the directory has loaded is never acted on.
                        const peer = roomId === LEGACY_ROOM_ID
                            ? ''
                            : String(peerFromRoomId(roomId) || '').toLowerCase();
                        // ⚠️ A STORE ROOM HAS NO PEER (peerFromRoomId() is null
                        // for `branch-` ids), so the rule below can never fire
                        // for it — yet a refused STORE-room read means the room
                        // was DELETED (phantom cleanup: the store lost its Area
                        // Manager / RM-SM) or this account is no longer in its
                        // `members` (re-roled away). The LIST QUERY is the
                        // authority: if membership ever returns,
                        // `chats where members array-contains me` puts the row
                        // back. Without this branch the denial lands in the retry
                        // set below and this device re-reads a dead room every
                        // DENIED_ROOM_RETRY_MS for the rest of the session.
                        if (peopleSettled && isBranchRoom(roomId)) {
                            forgetRoom(roomId);
                        } else if (peopleSettled && peer && startableEmails().indexOf(peer) === -1) {
                            // Gone for good. It must leave BOTH the remembered
                            // list and the retry set — re-adding it to the retry
                            // set would keep re-reading it every minute for the
                            // rest of the session, which is the leak this rule
                            // exists to prevent.
                            forgetRoom(roomId);
                        } else {
                            conversationRoomsDenied[roomId] = true;
                        }
                        applyRoomSummaryToList(roomId, null);
                    }
                    scheduleDeniedRoomRetry();
                }
            );
        } catch (error) {
            // One unreadable room must never take the whole list down.
            delete conversationRoomUnsubs[roomId];
        }
    }

    /**
     * Rebuild the conversation list from per-room document listeners.
     *
     * Only runs when the list QUERY was denied (conversationListDenied), and
     * is safe to call repeatedly: a room that is already subscribed, or
     * already known to be missing, is skipped. It is called again whenever
     * the people directory or the account roster changes, because that is
     * exactly when a new peer — and so a new possible room — appears.
     */
    function startPerRoomConversationListeners() {
        if (!conversationListDenied) return;
        if (typeof db === 'undefined' || !db || !currentUserEmail) return;
        const me = String(currentUserEmail).toLowerCase();
        const roomIds = {};
        startableEmails().forEach(function (email) {
            if (String(email).toLowerCase() === me) return;
            const roomId = myRoomIdWith(email);
            if (roomId) roomIds[roomId] = true;
        });
        // The legacy archive is readable by every HR and superadmin
        // (isLegacyArchive) and is not anybody's "pair" room.
        //
        // ⚠️ GATED, because an Area Manager may NOT read it. Subscribing
        // unconditionally would make the fallback re-attempt a permanently
        // forbidden room every DENIED_ROOM_RETRY_MS (60s) for the whole
        // session, and the archive row is not rendered for them anyway
        // (collectConversationRows) — so the subscription could only ever waste
        // reads and produce a misleading permission error in the console.
        if (inGroupRoom()) roomIds[LEGACY_ROOM_ID] = true;
        // Rooms this device has already seen. A conversation whose other side
        // has left the directory AND the account roster (re-roled away, or a
        // deleted profile) is still this user's conversation, so it must keep
        // appearing instead of silently vanishing.
        Object.keys(knownRooms).forEach(function (roomId) { roomIds[roomId] = true; });
        // ...plus whichever room is open, so switching threads always has a
        // summary to work from, even for a peer the directory has lost.
        if (activeRoomId) roomIds[activeRoomId] = true;

        Object.keys(roomIds).forEach(subscribeRoomForList);
        scheduleDeniedRoomRetry();
        conversationListReady = true;
        renderConversationList();
        updateLauncherBadgeFromList();
    }

    /**
     * Re-attempt the rooms that were denied because they do not exist YET.
     * Bounded by construction: only denied rooms, only while there are some,
     * one attempt per room per DENIED_ROOM_RETRY_MS.
     */
    function scheduleDeniedRoomRetry() {
        if (deniedRoomRetryTimer) return;
        if (typeof setTimeout !== 'function') return;
        if (!Object.keys(conversationRoomsDenied).length) return;
        const timer = setTimeout(function () {
            deniedRoomRetryTimer = null;
            const roomIds = Object.keys(conversationRoomsDenied);
            conversationRoomsDenied = {};
            roomIds.forEach(subscribeRoomForList);
            // Re-arm only if some of them were denied again just now.
            scheduleDeniedRoomRetry();
        }, DENIED_ROOM_RETRY_MS);
        // In Node (the vm-sandbox tests) a pending timer would keep the
        // process alive for the whole interval; browsers return a plain
        // number and have no unref.
        if (timer && typeof timer.unref === 'function') timer.unref();
        deniedRoomRetryTimer = timer;
    }

    /**
     * The launcher badge: how many conversations have unread messages.
     * The archive never contributes, and the OPEN conversation is excluded
     * because opening it is itself the read.
     */
    function updateLauncherBadgeFromList() {
        let total = 0;
        Object.keys(conversationSummaries).forEach(function (roomId) {
            const s = conversationSummaries[roomId];
            if (!s || s.isArchive || roomId === activeRoomId) return;
            total += unreadFor(s);
        });
        if (total > 0) setUnreadBadge(total);
        else clearUnreadBadge();
    }

    /**
     * Clear the unread state for the open conversation.
     *
     * Local only (see the UNREAD block above for why this is not a room
     * field): stamp "read up to now" for this room and repaint. There is no
     * Firestore write, so nothing here can be denied and no rules change is
     * needed for it to work.
     */
    function clearUnreadForActiveRoom() {
        const roomId = activeRoomId;
        if (!roomId || roomId === LEGACY_ROOM_ID) return;
        if (!conversationSummaries[roomId]) return;
        markConversationRead(roomId);
        renderConversationList();
        updateLauncherBadgeFromList();
    }

    // Branch rooms this device has already re-seeded this page-load. A repair
    // reads the whole `users` collection (superadmin-only) and may write the
    // room doc, so it runs at most ONCE per room per load — opening the same
    // store twice must not repeat it. Membership still converges on the next
    // load, and an approval re-seeds live (script.js ensureBranchGroupChats).
    var repairedBranchRooms = {};

    /**
     * Re-seed a branch room's `members` to the authoritative team when it has
     * drifted — specifically when an OLDER client wrote `everyoneKnownForGroup()`
     * into it (that helper feeds the GROUP send path, and `isGroupRoom()` is
     * true for branch rooms too).
     *
     * ⚠️ WHY THIS MATTERS BEYOND THE PICKER. `members` is not just the @mention
     * roster — it is what `firestore.rules` authorises a room READ on
     * (`selfEmail() in resource.data.members`). A branch room polluted with
     * EVERY account therefore leaked its messages to other branches' teams, not
     * merely offered them in the picker. Repairing the array fixes both, and it
     * is a security repair, not a cosmetic one.
     *
     * SUPERADMIN-ONLY, enforced twice over by the rules: reading the whole
     * `users` collection is `isSuperAdmin()`, and writing a branch room's
     * `members` is `canManageBranchRoom()` (isSuperAdmin && isBranchRoom). A
     * non-superadmin caller is refused before any write lands, so the client
     * never even attempts it for them.
     *
     * CONVERGES, NEVER RESETS: it compares the computed team to the room's
     * current `members` (the SAME normalisation script.js uses) and writes ONLY
     * on a real difference. `{ merge: true }` touches `members` alone — inside
     * the branch update rule's hasOnly() allowlist, so it can never clobber the
     * summary.
     */
    function repairBranchRoomMembers(roomId) {
        if (!roomId || !isBranchRoom(roomId)) return;
        if (normalizeRole(currentRole) !== 'superadmin') return;
        if (repairedBranchRooms[roomId]) return;
        if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') return;
        const summary = conversationSummaries[roomId];
        if (!summary) return;                       // room not known yet — nothing to compare
        repairedBranchRooms[roomId] = true;         // one attempt per room per load

        // The branch NAME (the room `title`) is what branchGroupMembers matches
        // against each user's `branches`. Fall back to the slug-derived name,
        // exactly like activeRoomBranch(), when the title has not arrived.
        const branch = String(summary.title || '').trim()
            || roomId.slice('branch-'.length).replace(/-/g, ' ').trim();
        if (!branch) return;

        const norm = function (arr) {
            return (Array.isArray(arr) ? arr : [])
                .map(function (e) { return String(e || '').trim().toLowerCase(); })
                .sort().join('\n');
        };
        const currentMembers = norm(summary.members);

        db.collection('users').get().then(function (snap) {
            const allUsers = [];
            snap.forEach(function (doc) {
                allUsers.push(Object.assign({ id: doc.id }, doc.data() || {}));
            });
            const team = branchGroupMembers(branch, allUsers);
            if (norm(team) === currentMembers) return;   // already correct — never rewrite
            return db.collection('chats').doc(roomId)
                .set({ members: team }, { merge: true })
                .then(function () {
                    // Reflect the fix locally at once, so the @mention picker is
                    // correct without waiting for the next room snapshot.
                    if (conversationSummaries[roomId]) {
                        conversationSummaries[roomId].members = team.slice();
                    }
                    renderConversationList();
                });
        }).catch(function (error) {
            // Best-effort: a denied read (non-superadmin despite the guard), an
            // offline moment, or a refused write must NEVER break opening the
            // room. The flag stays set so it is not retried in a loop this load;
            // the next load — or an approval re-seed — converges it.
            console.warn('[Chat] branch-room membership repair skipped:', error && error.message);
        });
    }


    /**
     * Open a conversation.
     *
     * ⚠️ Switching rooms must FULLY release the previous room's listeners
     * first. Otherwise the old thread's messages keep arriving into the new
     * room's log (showing one person another person's conversation), its
     * typing indicator would name the previous person, and its reactions
     * would attach to the new thread's messages. Every per-room listener is
     * stopped and every per-room cache is cleared here.
     */
    function selectConversation(roomId) {
        if (!roomId) return;
        if (roomId === activeRoomId) {
            if (els.overlay) els.overlay.classList.add('chat-showing-thread');
            return;
        }

        // Withdraw our typing indicator from the room we are leaving, or a
        // "…" would linger there for the other person.
        withdrawPresence();

        stopListener();
        stopTypingListener();
        stopReadReceiptListener();
        stopReactionsListener();
        stopProfilesListener();

        // Per-room view state must be reset, or the new thread would inherit
        // the old one's paginated history, "new messages" divider and
        // already-seen ids — which would suppress its unread badge and let
        // the incoming chime fire for its entire history.
        seenMessageIds = [];
        lastRenderedMessages = [];
        olderMessages = [];
        historyCursor = null;
        oldestTailDoc = null;
        hasMoreHistory = true;
        historyLoading = false;
        readReceipts = {};
        reactionsByMessage = {};
        myReactionDocs = {};
        firstUnreadId = null;
        cancelReply();
        closeReactionPicker();
        closeMentionMenu();

        activeRoomId = roomId;
        activePeerEmail = roomId === LEGACY_ROOM_ID ? null : peerFromRoomId(roomId);
        // Pre-load the All HR group's @mention roster for a superadmin (cached,
        // one read). No-op for HR, who cannot read `users` and use the thread
        // senders instead.
        if (roomId === LEGACY_ROOM_ID) loadGroupMentionRoster();

        applyActiveRoomToHeader();

        if (els.overlay) els.overlay.classList.add('chat-showing-thread');

        // ⚠️ A NEVER-STARTED CONVERSATION HAS NO ROOM DOCUMENT YET, so there
        // is nothing to subscribe to. Reading `chats/{id}/messages` for a
        // missing room is DENIED by the membership rule, and chat.js reacts
        // to a permission error by greying out the launcher with "Chat is
        // blocked by the current Firestore rules" — which would lock the user
        // out of chat for trying to message somebody for the first time.
        //
        // So: only subscribe when the room is known to EXIST, i.e. it came
        // back from the `chats` list query. Otherwise render the empty state
        // locally and let the FIRST SENT MESSAGE create the room: sendMessage
        // commits the room document FIRST, on its own, and only then writes
        // the message — because a message written in the same batch as the
        // room it belongs to is DENIED (the message rule resolves membership
        // by READING that room, which does not exist yet at that point).
        const roomExists = Boolean(conversationSummaries[roomId]) || isGroupRoom(roomId);
        if (roomExists) {
            if (els.log) els.log.innerHTML = '<p class="chat-empty">Loading messages&hellip;</p>';
            startListener();
            startTypingListener();
        } else if (els.log) {
            els.log.innerHTML = '<p class="chat-empty">' +
                'No messages yet.<br>Send the first message to start this conversation.' +
                '</p>';
        }
        renderConversationList();

        // A branch room whose `members` was polluted by an older client (it
        // wrote everyoneKnownForGroup() into group rooms, and isGroupRoom() is
        // true for branch rooms too) shows EVERY user in the @mention picker —
        // and, worse, leaks its messages to other branches via the read rule.
        // A superadmin opening the room re-seeds it to the real team. Gated on
        // superadmin + branch inside the helper, and best-effort (never blocks
        // opening). No-op for 1:1 / the All-HR group.
        repairBranchRoomMembers(roomId);

        // Opening IS reading: everything currently in this thread is seen.
        stampLastSeen();
        clearUnreadForActiveRoom();
        if (roomExists && isChatActuallyVisible()) markThreadRead(true);
        // Auto-focus the composer on DESKTOP only — on a phone it raises the
        // software keyboard and yanks the view to the input (see openModal()).
        // scrollLogToBottom() runs on both so the thread lands on the newest
        // message either way. `typeof` guard: safe when this function is lifted
        // into an isolated test sandbox where canHover is not in scope.
        if (els.input && !els.input.disabled) {
            if (typeof canHover !== 'function' || canHover()) els.input.focus();
            scrollLogToBottom();
        }
    }

    /**
     * The GROUP chat: every HR and every superadmin, in one thread.
     *
     * ⚠️ WHY IT IS THE LEGACY ROOM, AND WHY THAT IS THE POINT. Access to
     * `chats/owner-superadmin` is gated on the ROLE (`isLegacyArchive` =
     * `isHrOrSuperAdmin() && chatId == 'owner-superadmin'`), NOT on a
     * `members` array. A room whose membership is a list can only ever contain
     * the people who were on it when it was created — and the deployed rules
     * refuse a room UPDATE, so nobody could ever be added afterwards. A
     * role-gated room needs no list at all: a brand-new HR or superadmin
     * account is in the conversation from the moment its role is set, with
     * nothing to invite, nothing to add, and nothing that can go stale.
     *
     * What is deliberately NOT here: typing indicators and ✓✓ read receipts.
     * Both are `isChatMember`-gated writes, i.e. per-room, so in a room with
     * no member list they would be refused — and a permanent console warning
     * is a worse outcome than a feature that never claims to exist.
     */
    function isGroupRoom(roomId) {
        const id = (roomId === undefined ? activeRoomId : roomId) || '';
        return id === LEGACY_ROOM_ID || id.indexOf('branch-') === 0;
    }

    /** Header text + avatar for the open conversation. */
    function applyActiveRoomToHeader() {
        if (els.backBtn) els.backBtn.hidden = !activeRoomId;

        if (!activeRoomId) {
            if (els.chatTitle) els.chatTitle.textContent = 'Chats';
            if (els.chatSubtitle) els.chatSubtitle.textContent = 'Select a conversation';
            if (els.threadAvatar) els.threadAvatar.hidden = true;
            setComposerEnabled(false);
            return;
        }

        if (isGroupRoom()) {
            if (isBranchRoom(activeRoomId)) {
                // The seeded room document carries the bare branch name as
                // `title` ("SM Fairview"); branchGroupName() is only the
                // fallback for before that snapshot has arrived.
                const branchSummary = conversationSummaries[activeRoomId];
                if (els.chatTitle) {
                    els.chatTitle.textContent = (branchSummary && branchSummary.title)
                        || branchGroupName(activeRoomId);
                }
                if (els.chatSubtitle) els.chatSubtitle.textContent = 'All members of that branch — the superadmin manages who is in it';
            } else {
                if (els.chatTitle) els.chatTitle.textContent = GROUP_ROOM_NAME;
                if (els.chatSubtitle) {
                    els.chatSubtitle.textContent = 'Everyone with HR or superadmin access — ' +
                        'new accounts are here automatically';
                }
            }
            if (els.threadAvatar) els.threadAvatar.hidden = true;
            // A real composer: this is a live channel, not a museum piece.
            setComposerEnabled(true);
            return;
        }

        const name = nameFor(activePeerEmail);
        if (els.chatTitle) els.chatTitle.textContent = name;
        if (els.chatSubtitle) {
            const role = normalizeRole(personProfileFor(activePeerEmail).role);
            const label = role ? roleLabel(role) : '';
            // Colour-coded ROLE pill (violet = Area Manager, green = HR,
            // blue = superadmin) — same hues as the avatar fills, so the
            // superadmin knows at a glance who they are talking to.
            // innerHTML is safe: role comes from the allowlist in
            // normalizeRole() + roleLabel(), never from user text.
            if (label && (role === 'owner' || role === 'hr' || role === 'superadmin' || role === 'rmsm')) {
                // ⚠️ RANK MARKER for the superadmin: a ★ prefix + the
                // .chat-role-pill--rank gold border (chat.css), so the thread
                // header says RANK at a glance, not just role. The blue role
                // pill stays underneath — gold ACCENTS it, never replaces it
                // ("one colour = one role"). The ★ is a literal glyph from an
                // allowlisted label, never user text, so innerHTML stays safe.
                els.chatSubtitle.innerHTML = '<span class="chat-role-pill chat-role-pill--' +
                    role + (role === 'superadmin' ? ' chat-role-pill--rank' : '') + '">' +
                    (role === 'superadmin' ? '★ ' : '') + label + '</span>';
            } else {
                els.chatSubtitle.textContent = label;
            }
        }
        if (els.threadAvatar) {
            els.threadAvatar.hidden = false;
            els.threadAvatar.className = 'chat-avatar ' + avatarRoleFor(activePeerEmail);
            els.threadAvatar.textContent = initialsFor(name);
        }
        setComposerEnabled(true);
    }

    function setComposerEnabled(on) {
        if (els.input) {
            els.input.disabled = !on;
            els.input.placeholder = on
                ? 'Type a message… Use @ to mention someone'
                : 'Select a conversation to start writing';
        }
        if (els.sendBtn) els.sendBtn.disabled = !on;
    }

    /**
     * Publish (or clear) this person's own display name + job title, so a
     * long thread shows "Maria — HR Manager" instead of "maria@…". Each
     * person owns exactly one doc and may only write their own.
     */
    function saveMyProfile(displayName, title) {
        if (!currentUserEmail) return Promise.resolve(false);
        const payload = {
            email: currentUserEmail,
            role: currentRole || '',
            displayName: String(displayName || '').trim().slice(0, 60),
            title: String(title || '').trim().slice(0, 60)
        };
        // The directory entry is what the conversation list and the "new
        // chat" picker read; the room-scoped one only serves the legacy
        // archive. If either is denied the other still stands, so neither is
        // allowed to fail the save on its own.
        const writeLegacy = activeRoomId === LEGACY_ROOM_ID
            ? myProfileRef().set(payload, { merge: true })
            : Promise.resolve();
        return Promise.all([
            writeLegacy,
            saveMyDirectoryEntry(payload.displayName, payload.title)
        ]).then(function (results) {
            return results[1] === true;
        }).catch(function (error) {
            // Stale rules (profiles not deployed) must not break chat.
            console.warn('[Chat] Profile not saved:', error && error.message);
            return false;
        });
    }

    function startProfilesListener() {
        if (profilesUnsub) return;
        try {
            profilesUnsub = profilesRef().onSnapshot(function (snapshot) {
                const next = {};
                snapshot.forEach(function (doc) {
                    const data = doc.data() || {};
                    if (data.email) next[String(data.email).toLowerCase()] = data;
                });
                chatProfiles = next;
                if (els.log && lastRenderedMessages.length) {
                    renderMessages(lastRenderedMessages);
                }
            }, function (error) {
                console.warn('[Chat] Profiles unavailable:', error && error.message);
            });
        } catch (error) {
            console.warn('[Chat] Profiles unavailable:', error && error.message);
        }
    }

    function stopProfilesListener() {
        if (profilesUnsub) {
            try { profilesUnsub(); } catch (e) { /* ignore */ }
            profilesUnsub = null;
        }
    }

    /** Show/hide the profile editor, pre-filled with what is published. */
    function toggleProfileEditor(force) {
        if (!els.profileEditor) return;
        var show = typeof force === 'boolean'
            ? force
            : els.profileEditor.hidden;
        els.profileEditor.hidden = !show;
        if (show) {
            var mine = (chatProfiles && chatProfiles[String(currentUserEmail || '').toLowerCase()]) || {};
            if (els.profileName) els.profileName.value = mine.displayName || '';
            if (els.profileTitle) els.profileTitle.value = mine.title || '';
            if (els.profileName) els.profileName.focus();
        }
    }

    function bindProfileEditor() {
        if (els.profileToggle) {
            els.profileToggle.addEventListener('click', function () { toggleProfileEditor(); });
        }
        if (els.profileSave) {
            const commit = function () {
                const name = els.profileName ? els.profileName.value : '';
                const title = els.profileTitle ? els.profileTitle.value : '';
                if (!String(name).trim()) {
                    showToast('Please enter a display name.', 'error');
                    return;
                }
                els.profileSave.disabled = true;
                saveMyProfile(name, title).then((ok) => {
                    els.profileSave.disabled = false;
                    // Collapse on BOTH outcomes. A failed save means the
                    // deployed rules reject the write, and leaving the form
                    // open with the user's text in it looks like the app is
                    // stuck; the error toast already explains what to do, so
                    // the chat returns to normal either way.
                    toggleProfileEditor(false);
                    if (ok) {
                        showToast('Profile saved.', 'success');
                    } else {
                        showToast('Could not save your profile. Ask a superadmin to deploy the chat rules.', 'error');
                    }
                });
            };
            els.profileSave.addEventListener('click', commit);
            // Enter in either field saves, matching the chat composer's habit.
            if (els.profileName) els.profileName.addEventListener('keydown', onEnterSave);
            if (els.profileTitle) els.profileTitle.addEventListener('keydown', onEnterSave);
            function onEnterSave(event) {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commit();
                }
            }
        }
    }

    // ==============================================================
    //  PROFILES  (who is who in the thread)
    //
    //  Two parts:
    //
    //  1. Role badge + avatar, derived from fields ALREADY on each
    //     message (senderRole, senderName, senderEmail). Because they
    //     come from the message itself, this works on the entire existing
    //     history immediately — no migration, no backfill.
    //
    //  2. An optional display name + title, published by each person into
    //     chats/{chatId}/profiles/{emailKey}. This is deliberately NOT the
    //     `users` collection: firestore.rules only lets a superadmin or
    //     the profile owner read `users/{email}`, so an HR member could
    //     never read a colleague's profile and every name would silently
    //     fall back to the email prefix. The chat keeps its own roster,
    //     writable only by its owner and readable by the thread.
    // ==============================================================

    /** Two-letter initials for the avatar, from a name or an email. */
    function initialsFor(nameOrEmail) {
        var raw = String(nameOrEmail || '').trim();
        if (!raw) return '?';
        // An email: use the part before "@" so "hr@x.com" -> "HR".
        var local = raw.indexOf('@') > -1 ? raw.slice(0, raw.indexOf('@')) : raw;
        var parts = local.split(/[\s._-]+/).filter(Boolean);
        if (parts.length >= 2) {
            return (parts[0].charAt(0) + parts[1].charAt(0)).toUpperCase();
        }
        return local.slice(0, 2).toUpperCase();
    }

    /**
     * Human label for a role: "HR" / "Superadmin" / "Area Manager" / "RM/SM".
     *
     * ⚠️ 'owner' and 'rmsm' MUST be labelled here. They are real chat
     * participants, and an empty string is what this returns for an
     * unrecognised role — so without this the thread subtitle (and any other
     * caller) would render blank for every Area Manager or RM/SM, looking
     * like missing data rather than a role.
     */
    function roleLabel(role) {
        var r = normalizeRole(role);
        if (r === 'superadmin') return 'Superadmin';
        if (r === 'hr') return 'HR';
        if (r === 'owner') return 'Area Manager';
        if (r === 'rmsm') return 'RM/SM';
        return '';
    }

    /**
     * Short initials for a role, shown INSIDE the message avatar so the role is
     * readable at a glance without a word chip crowding the name line:
     *   superadmin -> SA, hr -> HR, owner (Area Manager) -> AM, rmsm (RM/SM) -> RM
     * An unknown/legacy role returns '' so the caller can fall back to the
     * person's name initials (never a blank circle).
     */
    function roleInitials(role) {
        var r = normalizeRole(role);
        if (r === 'superadmin') return 'SA';
        if (r === 'hr') return 'HR';
        if (r === 'owner') return 'AM';
        if (r === 'rmsm') return 'RM';
        return '';
    }

    /**
     * The published profile for a person, merged over what the message
     * itself says. A message is authoritative for the ROLE (it was the
     * role at send time); the profile only supplies a nicer name/title.
     */
    function profileFor(msg) {
        var email = String(msg.senderEmail || '').toLowerCase();
        var published = (chatProfiles && chatProfiles[email]) || null;
        // A published display name wins over the message's own senderName,
        // which is itself only the email's local part. displayNameFor()
        // takes the email as its first argument and would therefore always
        // return "maria" and ignore the nicer name — so the published name
        // is checked explicitly first.
        var name = (published && published.displayName)
            || displayNameFor(msg.senderEmail, msg.senderName);
        return {
            email: email,
            name: name,
            role: msg.senderRole || (published && published.role) || '',
            title: (published && published.title) || ''
        };
    }

    /**
     * The message avatar, in its own column beside the bubble. The circle shows
     * the sender's ROLE initials (SA / HR / AM / RM) in the role colour, so the
     * role reads at a glance without a word chip next to the name. A role-less
     * (legacy) message falls back to the person's name initials so the circle is
     * never blank. The full role label stays in the hover `title`.
     */
    function renderSenderAvatar(msg) {
        var p = profileFor(msg);
        var label = roleLabel(p.role);
        var titleAttr = p.title
            ? escapeHTML(p.title + (label ? ' · ' + label : ''))
            : escapeHTML(label || p.name);
        var glyph = roleInitials(p.role) || initialsFor(p.name);
        return '<span class="chat-avatar chat-avatar--' +
            escapeHTML(normalizeRole(p.role) || 'unknown') +
            '" aria-hidden="true" title="' + titleAttr + '">' +
            escapeHTML(glyph) + '</span>';
    }

    /**
     * The name (+ optional job title) shown in the compact header above the
     * bubble. The ROLE is not here — it is carried by the avatar's initials in
     * renderSenderAvatar(). The AVATAR is deliberately not here either: it lives
     * in its own column beside the message, so the header collapses to one
     * short line.
     */
    function renderSenderIdentity(msg) {
        var p = profileFor(msg);
        return '<span class="chat-msg-name">' + escapeHTML(p.name) + '</span>' +
            (p.title ? '<span class="chat-msg-title">' + escapeHTML(p.title) + '</span>' : '');
    }

    // ==============================================================
    //  PAGINATED HISTORY
    // ==============================================================

    /**
     * Show/hide the "Load earlier messages" control.
     * - hidden entirely for a short thread (nothing older to reach)
     * - "Beginning of history" once every page has been fetched
     * - a loading state while a page is in flight
     */
    function updateHistoryBar() {
        if (!els.historyBar || !els.loadOlderBtn) return;
        const shortThread = !olderMessages.length && !hasMoreHistory;
        els.historyBar.hidden = shortThread;
        if (els.loadOlderBtn) {
            els.loadOlderBtn.disabled = historyLoading;
            els.loadOlderBtn.hidden = !hasMoreHistory;
        }
        if (els.historyStatus) {
            els.historyStatus.textContent = historyLoading
                ? 'Loading…'
                : (hasMoreHistory ? '' : 'Beginning of history');
        }
    }

    /**
     * Fetch one page of older messages and prepend it.
     *
     * This is a ONE-SHOT get(), deliberately separate from the live
     * onSnapshot: paging back must never restart the live subscription or
     * re-download the tail.
     *
     * THE CURSOR IS A DocumentSnapshot, NOT A TIMESTAMP. `sentAt` is a
     * serverTimestamp(), so two messages sent in the same millisecond tie.
     * Ordering by sentAt alone is then non-deterministic across pages and
     * can duplicate or skip messages at a page boundary. Firestore cursors
     * carry an implicit __name__ tiebreaker, so passing the snapshot keeps
     * paging exact without needing a composite index.
     *
     * WHY DESCENDING. The page must be the messages OLDER than what we
     * already hold. In ascending order `startAfter` walks FORWARD, so it
     * would return the oldest 60 messages in the thread on the very first
     * click — not the ones just above the tail. Querying
     * `orderBy('sentAt', 'desc')` makes "after the cursor" mean "older
     * than the cursor", and the result is reversed back into display order
     * afterwards. (Also avoids `endBefore()`, which is not in the pinned
     * Firestore 8.10.1 SDK.)
     */
    async function loadOlderMessages() {
        if (historyLoading || !hasMoreHistory) return;
        if (typeof db === 'undefined' || !db) return;
        const messages = messagesRef();
        // No conversation open — nothing to page through.
        if (!messages) return;
        historyLoading = true;
        updateHistoryBar();

        try {
            // Scroll anchor, captured BEFORE anything is re-rendered.
            // Prepending grows scrollHeight, and because innerHTML is
            // reassigned wholesale the browser would otherwise keep the
            // old scrollTop and appear to jump DOWN into the new content.
            const previousTop = els.log ? els.log.scrollTop : 0;
            const previousHeight = els.log ? els.log.scrollHeight : 0;

            // The first page pages back from the OLDEST doc of the live
            // tail; later pages page back from the last page's oldest doc.
            // `oldestTailDoc` is a real DocumentSnapshot taken from the
            // live listener, so the very first page needs no guessing.
            const cursor = historyCursor || oldestTailDoc;
            let query = messages.orderBy('sentAt', 'desc');
            if (cursor) query = query.startAfter(cursor);
            const snap = await query.limit(HISTORY_PAGE_SIZE).get();

            // Descending -> back into chronological (oldest first) order.
            const fetched = [];
            for (let i = snap.docs.length - 1; i >= 0; i--) {
                const doc = snap.docs[i];
                fetched.push(Object.assign({ id: doc.id }, doc.data()));
            }

            if (!fetched.length) {
                // Nothing older exists — stop offering the control.
                hasMoreHistory = false;
                historyLoading = false;
                updateHistoryBar();
                return;
            }

            // A short page means we reached the beginning of the thread.
            if (fetched.length < HISTORY_PAGE_SIZE) hasMoreHistory = false;
            // Advance the cursor to the OLDEST doc of the page just read.
            //
            // The query is DESCENDING, so snap.docs runs newest -> oldest and
            // docs[0] is the NEWEST of the page. Using that would make the
            // next startAfter() walk back over the page just fetched and
            // render every message twice. The oldest is the LAST doc.
            historyCursor = snap.docs.length ? snap.docs[snap.docs.length - 1] : historyCursor;
            olderMessages = fetched.concat(olderMessages);

            // Belt-and-braces: mark the preloaded ids as already-seen.
            //
            // The CHIME is actually prevented by loadOlderMessages never
            // calling announceNewMessages() (that happens only in the live
            // onSnapshot), so this pre-seed is not what stops the sound
            // today. It is kept because announceNewMessages() treats any id
            // missing from seenMessageIds as brand new — so if a future
            // refactor routes history through it, a month-old page would
            // machine-gun the incoming chime. Cheap insurance.
            fetched.forEach((m) => {
                if (seenMessageIds.indexOf(m.id) === -1) seenMessageIds.push(m.id);
            });

            // Re-render the tail with history attached. Pass isHistory so
            // the unread badge is NOT recomputed against old messages.
            renderMessages(lastRenderedMessages, { isHistory: true });

            // Restore the reading position: shift by exactly how much
            // taller the log became, so the message the user was looking at
            // stays under the cursor. Marked programmatic for the same
            // reason as scrollLogToBottom(): this scroll is ours, not the
            // user's, and must not trigger another page load.
            if (els.log) {
                const grewBy = els.log.scrollHeight - previousHeight;
                programmaticScroll = true;
                els.log.scrollTop = previousTop + grewBy;
            }
        } catch (error) {
            // Never break the chat over history: a failed page just means
            // the user can try again.
            console.warn('[Chat] Could not load earlier messages:', error && error.message);
        } finally {
            historyLoading = false;
            updateHistoryBar();
        }
    }

    // ==============================================================
    //  REPLIES
    //
    //  A reply is NOT a nested subcollection. Firestore has no native
    //  threading, and nesting replies under their parent would need a
    //  collectionGroup query plus a composite index — and would mean the
    //  live listener could no longer deliver replies in thread order.
    //  Instead a message simply carries `replyTo: <parentMessageId>`, so
    //  replies arrive in the same stream as everything else and render
    //  inline, in order, exactly like the original.
    //
    //  The quoted preview is resolved from the messages already loaded, so
    //  no extra read is needed. If the parent has been paged out of the
    //  window the quote degrades to a neutral "earlier message" label
    //  rather than rendering a broken or empty box.
    //
    //  Replies never chain: replying to a reply targets the message you
    //  actually clicked, so a thread can never nest arbitrarily deep.
    // ==============================================================

    /** The message id currently being replied to, or null. */
    var replyingToId = null;

    /** id -> message, covering everything currently rendered. */
    function messageIndex() {
        const index = {};
        const combined = olderMessages.concat(lastRenderedMessages || []);
        combined.forEach(function (m) {
            if (m && m.id) index[String(m.id)] = m;
        });
        return index;
    }

    /** Short, single-line preview of a message for quoting. */
    function quotePreview(msg) {
        return String((msg && msg.text) || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 90);
    }

    function startReply(messageId) {
        if (!els.replyBanner || !messageId) return;
        const parent = messageIndex()[String(messageId)];
        if (!parent) {
            // The parent is not in the window (paged out). Still allow the
            // reply — the quote just cannot be previewed.
            replyingToId = String(messageId);
        } else {
            replyingToId = String(messageId);
            if (els.replyName) {
                els.replyName.textContent = displayNameFor(parent.senderEmail, parent.senderName);
            }
            if (els.replyText) els.replyText.textContent = quotePreview(parent);
        }
        if (els.replyBanner) els.replyBanner.hidden = false;
        if (els.input) {
            els.input.placeholder = 'Reply\u2026';
            els.input.focus();
        }
    }

    function cancelReply() {
        replyingToId = null;
        if (els.replyBanner) els.replyBanner.hidden = true;
        if (els.input) {
            els.input.placeholder =
                'Type a message\u2026 Use @ to mention someone';
        }
    }

    /** The quoted block rendered above a reply's bubble. */
    function renderReplyQuote(msg) {
        const parentId = msg && msg.replyTo ? String(msg.replyTo) : '';
        if (!parentId) return '';
        const parent = messageIndex()[parentId];
        const who = parent
            ? escapeHTML(displayNameFor(parent.senderEmail, parent.senderName))
            : 'Earlier message';
        const snippet = parent
            ? escapeHTML(quotePreview(parent))
            : 'This message is no longer in the loaded history.';
        return '<div class="chat-reply-quote-block">' +
            '<span class="chat-reply-quote-name">' + who + '</span>' +
            '<span class="chat-reply-quote-text">' + snippet + '</span>' +
            '</div>';
    }

    function bindReplies() {
        if (!els.replyBanner) return;

        // Reply is chosen from the shared context menu, not from a per-message
        // button, so there is no header click handler to bind here.
        if (els.replyCancel) {
            els.replyCancel.addEventListener('click', function (event) {
                event.preventDefault();
                cancelReply();
                if (els.input) els.input.focus();
            });
        }

        // Escape clears a pending reply before it falls through to the
        // document-level handlers.
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && replyingToId) {
                cancelReply();
            }
        });
    }

    // ==============================================================
    //  EMOJI REACTIONS
    //
    //  ONE reaction per person per message. The document is
    //  chats/{chatId}/reactions/{messageId}__{emailKey} holding
    //  { messageId, emoji, email } — one doc per PERSON per message, not
    //  per emoji. That makes "one reaction each" structural rather than a
    //  UI convention: there is only one place a person's reaction to a
    //  message can live, so a second one cannot be added.
    //
    //  Switching emoji is an UPDATE of the `emoji` field only. The rules
    //  freeze `messageId` and `email`, so nobody can repoint their reaction
    //  at another message or pass it to someone else.
    //
    //  The collection is a SIBLING of `messages` rather than nested under
    //  it: one onSnapshot over a single collection then covers the whole
    //  thread. A subcollection of a query is not directly subscribable, so
    //  nesting would have forced a collectionGroup query + a composite
    //  index for no benefit.
    // ==============================================================

    // The Messenger set: Like, Love, Haha, Wow, Sad, Angry. Chosen over a
    // grab-bag of pictographs (the old 👍❤️👀🎉❗) because these six read the
    // same way everywhere — a reaction means the same thing to everyone.
    //
    // Keys are ASCII so the Firestore doc id stays readable and never needs
    // escaping. Each one is drawn as an inline SVG rather than a Unicode
    // char so it can ANIMATE: a Unicode "😂" is a dead picture, whereas the
    // haha face can genuinely laugh. CSS drives the motion (the log's
    // innerHTML is rebuilt on every snapshot, so anything animated from JS
    // would restart constantly).
    var REACTION_EMOJI = [
        { key: 'like',  label: 'Like' },
        { key: 'love',  label: 'Love' },
        { key: 'haha',  label: 'Haha' },
        { key: 'wow',   label: 'Wow' },
        { key: 'sad',   label: 'Sad' },
        { key: 'angry', label: 'Angry' }
    ];

    /**
     * Reactions stored before the set changed, mapped onto the new keys.
     *
     * Without this, every existing reaction would VANISH from the thread:
     * the chips are rendered by looking each stored key up in
     * REACTION_EMOJI, and 'thumbsup' is no longer in it. The stored document
     * is left untouched — only the DISPLAY key is remapped, and it rewrites
     * itself the next time that person changes their reaction.
     */
    var LEGACY_REACTION_KEYS = {
        thumbsup: 'like',
        heart: 'love',
        eyes: 'wow',
        tada: 'haha',
        alarm: 'angry'
    };

    /** The current key for a stored one, remapping the old set. */
    function normaliseReactionKey(key) {
        const k = String(key || '');
        return LEGACY_REACTION_KEYS[k] || k;
    }

    function reactionMeta(key) {
        return REACTION_EMOJI.filter(function (e) { return e.key === key; })[0] || null;
    }

    /**
     * The animated glyph for a reaction, as inline SVG.
     *
     * All six share one flat, geometric style (24x24, solid fills, no
     * gradients) so the set looks like one family rather than six clip
     * arts. The mouth/eye shapes are what the CSS keyframes move.
     */
    function reactionGlyph(key) {
        const face = 'fill="#FFD23F"';
        const line = 'fill="none" stroke="#5A3A00" stroke-width="1.9" stroke-linecap="round"';
        const dark = 'fill="#4A2C00"';
        const svgs = {
            // A raised thumb: fist block plus a thumb angled up.
            like:
                '<path ' + face + ' d="M8.6 21H5.4A2.4 2.4 0 0 1 3 18.6v-6.2A2.4 2.4 0 0 1 5.4 10h3.2z"/>' +
                '<path fill="#FFC93C" d="M8.6 10l4-6.6a2 2 0 0 1 3.6 1.2L15 10h4.2a2.1 2.1 0 0 1 2 2.6l-1.5 6.6A2.1 2.1 0 0 1 17.6 21H8.6z"/>',

            // A heart with a soft highlight.
            love:
                '<path fill="#E8384F" d="M12 21.2S3.6 16 3.6 10.3A4.7 4.7 0 0 1 12 7.4a4.7 4.7 0 0 1 8.4 2.9c0 5.7-8.4 10.9-8.4 10.9z"/>' +
                '<ellipse cx="8.6" cy="10.4" rx="1.5" ry="2" fill="#fff" opacity=".45"/>',

            // Laughing: squinting crescent eyes over a wide open mouth.
            // The mouth scales open/closed and the whole face bobs, so it
            // reads as laughter rather than a grin.
            haha:
                '<circle cx="12" cy="12" r="10" ' + face + '/>' +
                '<path class="chat-react-eye" d="M6.2 10.2q1.9-2.2 3.8 0" ' + line + '/>' +
                '<path class="chat-react-eye" d="M14 10.2q1.9-2.2 3.8 0" ' + line + '/>' +
                '<path class="chat-react-mouth" d="M6.4 13.6h11.2a5.6 5.6 0 0 1-11.2 0z" ' + dark + '/>' +
                '<path d="M8 20.6h8" ' + line + ' stroke-width="1.4"/>',

            // Astonishment: tall eyes and a round O mouth, both widening.
            wow:
                '<circle cx="12" cy="12" r="10" ' + face + '/>' +
                '<ellipse class="chat-react-eye" cx="8.5" cy="9.4" rx="1.5" ry="2.1" ' + dark + '/>' +
                '<ellipse class="chat-react-eye" cx="15.5" cy="9.4" rx="1.5" ry="2.1" ' + dark + '/>' +
                '<ellipse class="chat-react-mouth" cx="12" cy="16" rx="3" ry="3.6" ' + dark + '/>',

            // A downturned mouth, lowered brows, and a falling tear.
            sad:
                '<circle cx="12" cy="12" r="10" ' + face + '/>' +
                '<path d="M6.6 8.6q1.9-1.4 3.6.4" ' + line + '/>' +
                '<path d="M13.8 9q1.7-1.8 3.6-.4" ' + line + '/>' +
                '<path d="M6.8 16.6q5.2-3.4 10.4 0" ' + line + '/>' +
                '<path class="chat-react-tear" d="M16.6 11.2c1 1.5 1.5 2.4 1.5 3a1.5 1.5 0 0 1-3 0c0-.6.5-1.5 1.5-3z" fill="#4AA8E0"/>',

            // Angled brows over a tight frown; the face jitters.
            angry:
                '<circle cx="12" cy="12" r="10" ' + face + '/>' +
                '<path class="chat-react-brow" d="M6.4 8.4l4.2 2.2" ' + line + '/>' +
                '<path class="chat-react-brow" d="M17.6 8.4l-4.2 2.2" ' + line + '/>' +
                '<ellipse class="chat-react-eye" cx="8.8" cy="12" rx="1.2" ry="1.5" ' + dark + '/>' +
                '<ellipse class="chat-react-eye" cx="15.2" cy="12" rx="1.2" ry="1.5" ' + dark + '/>' +
                '<path d="M7.6 17.4q4.4-3 8.8 0" ' + line + '/>'
        };
        const svg = svgs[key];
        if (!svg) return '';
        return '<svg class="chat-react chat-react--' + escapeHTML(key) +
            '" viewBox="0 0 24 24" width="100%" height="100%" focusable="false" ' +
            'aria-hidden="true">' + svg + '</svg>';
    }

    function reactionsRef() {
        return roomSubcollection('reactions');
    }

    /**
     * The single doc id for MY reaction to a message.
     * Keyed by EMAIL, not by emoji — that is what structurally enforces
     * "one reaction each": there is no second slot to add another into.
     * '/' is illegal in a Firestore doc id; ids never contain one, but
     * encode defensively so a weird id cannot build a bad path.
     */
    function reactionKeyFor(messageId) {
        return encodeURIComponent(String(messageId)) + '__' +
            encodeURIComponent(String(currentUserEmail || '').toLowerCase());
    }

    function emojiCharFor(key) {
        const hit = REACTION_EMOJI.filter(function (e) { return e.key === key; })[0];
        return hit ? hit.char : '';
    }

    /**
     * messageId -> emojiKey -> { count, mine, people[] }.
     * Rebuilt wholesale from each snapshot (reactions are few per message,
     * and a wholesale rebuild cannot drift out of sync).
     */
    var reactionsByMessage = {};

    /**
     * messageId -> { emoji, docId } for MY OWN reaction, captured from the
     * snapshot.
     *
     * This exists because of LEGACY DOCUMENTS. Reactions used to be keyed
     * `{messageId}__{emoji}`, and were later re-keyed to `{messageId}__{email}`
     * so that one person holds at most one reaction per message. If we always
     * recomputed the id from scratch we would address a document that does not
     * exist whenever the user's reaction is an old one — and a `delete()` of a
     * missing document is DENIED by the rules (there is no `resource` to
     * check `resource.data.email` against), which surfaced as the misleading
     * "ask a superadmin to deploy the rules" toast. Remembering the real doc
     * id lets us delete the document that is genuinely there, and quietly
     * migrates a legacy reaction to the canonical id the next time the user
     * touches it.
     */
    var myReactionDocs = {};

    /** The emoji key I currently have on this message, or null. */
    function myReactionOn(messageId) {
        const bucket = reactionsByMessage[String(messageId)];
        if (!bucket) return null;
        const found = Object.keys(bucket).filter(function (k) { return bucket[k].mine; });
        return found.length ? found[0] : null;
    }

    /**
     * Apply/undo my reaction in local state, immediately.
     *
     * OPTIMISTIC: the chip is painted before the write resolves. Without it
     * the UI does nothing until the snapshot round-trips, so a *denied*
     * write — the common case until the rules are deployed — looks like the
     * picker doing nothing at all.
     *
     * `emojiKey` of null means "remove mine". Because the state is keyed by
     * message, adding a new emoji automatically DISPLACES the old one, so
     * "one reaction only" holds in the client too and not just the database.
     */
    function applyReactionLocally(messageId, emojiKey) {
        const mid = String(messageId);
        const bucket = reactionsByMessage[mid] || (reactionsByMessage[mid] = {});
        const me = String(currentUserEmail || '').toLowerCase();
        const current = myReactionOn(mid);

        // Take mine off whatever it currently is.
        if (current) {
            const prev = bucket[current];
            prev.count = Math.max(0, prev.count - 1);
            prev.mine = false;
            prev.people = prev.people.filter(function (p) {
                return String(p).toLowerCase() !== me;
            });
            if (prev.count === 0) delete bucket[current];
        }

        if (emojiKey) {
            const entry = bucket[emojiKey] ||
                (bucket[emojiKey] = { count: 0, mine: false, people: [] });
            entry.count++;
            entry.mine = true;
            if (entry.people.indexOf(currentUserEmail) === -1) {
                entry.people.push(currentUserEmail);
            }
        }

        if (Object.keys(bucket).length === 0) delete reactionsByMessage[mid];
        if (els.log && lastRenderedMessages.length) renderMessages(lastRenderedMessages);
    }

    /**
     * React with `emojiKey`, or remove my reaction if that is already it.
     * A person can hold AT MOST ONE reaction per message, always.
     */
    function toggleReaction(messageId, emojiKey) {
        if (!currentUserEmail || !messageId) return Promise.resolve(false);
        // A reaction is a per-room membership write, so it cannot exist in the
        // GROUP chat. Say so plainly instead of letting the write be refused.
        if (isGroupRoom()) {
            showToast('Reactions are only available in 1:1 conversations.', 'info');
            return Promise.resolve(false);
        }
        const reactions = reactionsRef();
        // No conversation open, so there is nothing to react within.
        if (!reactions) return Promise.resolve(false);
        const mid = String(messageId);
        const canonicalId = reactionKeyFor(mid);
        const current = myReactionOn(mid);
        const removing = (current === emojiKey);
        // The id of the doc that ACTUALLY holds my reaction right now, which
        // for a legacy reaction is not the canonical one.
        const existingDocId = (myReactionDocs[mid] && myReactionDocs[mid].docId) || null;

        // Paint it now; undo it if the write fails.
        applyReactionLocally(mid, removing ? null : emojiKey);

        let done;
        if (removing) {
            // Delete the document that is really there. Falling back to the
            // canonical id is only for the case where the snapshot has not
            // told us about a reaction yet.
            done = reactions.doc(existingDocId || canonicalId).delete();
            delete myReactionDocs[mid];
        } else if (current && existingDocId && existingDocId !== canonicalId) {
            // Switching emoji on a LEGACY doc: the id is keyed by the old
            // emoji, so it cannot simply be updated. Remove the old document
            // and write the canonical one, so from here on the user is on the
            // new scheme. Ordered delete-then-create so a failure never
            // leaves two of the same person's reactions on one message.
            done = reactions.doc(existingDocId).delete().then(function () {
                return reactions.doc(canonicalId).set({
                    messageId: mid,
                    emoji: String(emojiKey),
                    email: currentUserEmail
                });
            });
            myReactionDocs[mid] = { emoji: String(emojiKey), docId: canonicalId };
        } else if (current) {
            // Switching emoji: only the `emoji` field may change (the rules
            // freeze messageId + email), so this is a single-doc update
            // rather than a delete + create.
            done = reactions.doc(canonicalId).update({ emoji: String(emojiKey) });
            myReactionDocs[mid] = { emoji: String(emojiKey), docId: canonicalId };
        } else {
            done = reactions.doc(canonicalId).set({
                messageId: mid,
                emoji: String(emojiKey),
                email: currentUserEmail
            });
            myReactionDocs[mid] = { emoji: String(emojiKey), docId: canonicalId };
        }

        return done.then(function () { return true; }).catch(function (error) {
            applyReactionLocally(mid, current);   // roll back
            // Visible, not a silent console.warn. Do NOT jump straight to
            // "deploy the rules": a denied write is just as often a stale
            // local doc id or a client that has not picked up newly
            // deployed rules, and the old wording sent people to re-deploy
            // rules that were already correct.
            const denied = String((error && (error.code || error.message)) || '')
                .indexOf('permission') !== -1;
            showToast(denied
                ? 'Firestore rejected that reaction. If the rules were deployed recently, reload the page to pick them up.'
                : 'Could not save that reaction.', 'error');
            console.warn('[Chat] Reaction not saved:', error && error.message);
            return false;
        });
    }

    // --------------------------------------------------------------
    // UNSEND — retire my own message into an "Unsent message" tombstone.
    //
    // A sent message is immutable EXCEPT for this: the author may wipe the
    // body and flag it `unsent`, which renders as a muted "Unsent message"
    // instead of the text. firestore.rules enforces it (author-only, only the
    // {unsent, unsentAt, text} keys may change, one-way, text -> ''), so this
    // never edits anybody else's message and never rewrites a body to new text.
    // --------------------------------------------------------------

    /** Ask before retiring — unsend is final, so it gets a confirm. */
    function confirmUnsend(messageId) {
        if (!messageId) return;
        if (typeof window.confirmUnsendMessage === 'function') {
            window.confirmUnsendMessage(messageId);
            return;
        }
        // Fallback when the modal helper is not on the page.
        if (window.confirm && window.confirm('Unsend this message? It will be replaced with "Unsent message".')) {
            unsendMessage(messageId);
        }
    }

    function unsendMessage(messageId) {
        if (!currentUserEmail || !messageId) return Promise.resolve(false);
        const messages = messagesRef();
        if (!messages) return Promise.resolve(false);
        const mid = String(messageId);

        // Author check in the client too (the rules are the real gate): only my
        // own messages can be unsent, and a message that is already unsent is a
        // no-op. Read from the rendered list, which mirrors the live thread.
        const msg = (lastRenderedMessages || []).find(function (m) { return String(m.id) === mid; });
        if (!msg) return Promise.resolve(false);
        if (String(msg.senderEmail || '').toLowerCase() !== String(currentUserEmail).toLowerCase()) {
            showToast('You can only unsend your own messages.', 'error');
            return Promise.resolve(false);
        }
        if (msg.unsent) return Promise.resolve(false);

        return messages.doc(mid).update({
            text: '',
            unsent: true,
            unsentAt: firebase.firestore.FieldValue.serverTimestamp()
        }).then(function () {
            showToast('Message unsent.', 'success');
            return true;
        }).catch(function (error) {
            const denied = String((error && (error.code || error.message)) || '')
                .indexOf('permission') !== -1;
            showToast(denied
                ? 'Firestore rejected that. If the rules were deployed recently, reload the page to pick them up.'
                : 'Could not unsend that message.', 'error');
            console.warn('[Chat] Unsend failed:', error && error.message);
            return false;
        });
    }

    // --------------------------------------------------------------
    // Emoji reactions: ONE shared picker, shown on hover.
    // --------------------------------------------------------------

    var reactionTargetId = null;
    var closeReactionTimer = null;
    // MOBILE flicker guard. When a long-press opens the menu, the browser
    // fires a synthetic `click` the instant the finger lifts. That click
    // bubbles to the document dismiss handler and closes the menu it just
    // opened — a flash-then-shut that reads as "buggy". Set this flag when the
    // long-press opens the picker; the very next document click is swallowed
    // (consumed once) so a real tap afterward still dismisses normally.
    var suppressDismissClick = false;

    /** True when the browser really has a hovering pointer. */
    function canHover() {
        try {
            return typeof window.matchMedia === 'function'
                ? window.matchMedia('(hover: hover)').matches
                : true;
        } catch (e) {
            return true;
        }
    }

    function closeReactionPicker() {
        if (closeReactionTimer) {
            clearTimeout(closeReactionTimer);
            closeReactionTimer = null;
        }
        if (els.reactionPicker) els.reactionPicker.hidden = true;
        // Hide Unsend on close too, so it can never linger visible and reappear
        // against the next (possibly not-mine) message before sync runs.
        if (els.pickerUnsend) els.pickerUnsend.hidden = true;
        // Long-press focus teardown (MOBILE): drop the dim/blur scrim and lower
        // the held bubble back into the thread. The lifted row is held by direct
        // reference (els.focusRow, set in engageMessageFocus) rather than
        // re-queried from the DOM — O(1), and immune to a re-render swapping the
        // node out from under a stale class. Inlined rather than a helper call so
        // the isolated unit test in chat-unsend.test.js — which runs THIS
        // function standalone with only pickerUnsend/reactionPicker on `els` —
        // never hits an undefined reference. Both guards are no-ops there
        // (els.focusBackdrop and els.focusRow are absent).
        if (els.focusBackdrop) els.focusBackdrop.hidden = true;
        if (els.focusRow && els.focusRow.classList) {
            els.focusRow.classList.remove('is-focused');
        }
        els.focusRow = null;
        reactionTargetId = null;
    }

    /** Close shortly after, so travelling from the message to the picker
     *  (a real gap between the two) does not dismiss it mid-move. */
    function closeReactionPickerSoon() {
        if (closeReactionTimer) clearTimeout(closeReactionTimer);
        closeReactionTimer = setTimeout(function () {
            closeReactionTimer = null;
            closeReactionPicker();
        }, 220);
    }

    /**
     * Show/hide the UNSEND button for the message the picker is open on.
     * Only the AUTHOR may unsend, so the button appears solely on my own
     * messages — the same senderEmail === currentUserEmail test renderMessages
     * uses to decide `mine`. This is a UI convenience; firestore.rules is the
     * real gate (author-only, one-way), so a hidden button is not the boundary.
     */
    function syncUnsendButton(messageId) {
        if (!els.pickerUnsend) return;
        var mine = false;
        if (currentUserEmail && lastRenderedMessages) {
            var msg = lastRenderedMessages.find(function (m) { return String(m.id) === String(messageId); });
            mine = !!msg && String(msg.senderEmail || '').toLowerCase() === String(currentUserEmail).toLowerCase();
        }
        els.pickerUnsend.hidden = !mine;
    }

    /**
     * MOBILE long-press: bring the held message into focus.
     *
     * Fires the short haptic tick, drops the dim+blur scrim over the whole
     * thread, and lifts ONLY this bubble above it — the `.is-focused` class in
     * chat.css raises it to z-index 50 with a scale(1.03) pop, so the pressed
     * message stays crisp and slightly enlarged while everything around it
     * blurs and dims (the Messenger/iOS long-press look).
     *
     * Called from the TOUCH long-press path only. Desktop hover opens the
     * picker WITHOUT a scrim, so this is never reached there.
     *
     * `row` is the .chat-msg element. It is guarded because the touch unit
     * test dispatches a synthetic pointerdown whose target.closest() returns a
     * bare stub with no classList; touching it there would throw.
     */
    function engageMessageFocus(row) {
        // Haptic tick — real devices only. Silently skipped where vibrate is
        // absent (desktop, iOS Safari, and the headless test sandbox), so the
        // typeof guard both avoids a crash and keeps the feature optional.
        try {
            if (typeof navigator !== 'undefined' && navigator.vibrate) {
                navigator.vibrate(50);
            }
        } catch (e) { /* vibration unsupported — carry on regardless */ }
        if (els.focusBackdrop) els.focusBackdrop.hidden = false;
        if (row && row.classList) {
            row.classList.add('is-focused');
            // Remember the lifted row by reference so closeReactionPicker() can
            // drop it again without re-querying the (rebuilt) DOM.
            els.focusRow = row;
        }
    }

    /**
     * Copy a message's plain text to the clipboard (the iMessage "Copy" action).
     * Reads the RAW text from lastRenderedMessages so mentions/chips are not
     * dragged along as markup — only the words. Uses the async Clipboard API
     * when available and falls back to a hidden textarea + execCommand for
     * older/insecure contexts. Confirms with a toast either way.
     */
    function copyMessageText(messageId) {
        var msg = null;
        if (lastRenderedMessages) {
            msg = lastRenderedMessages.find(function (m) { return String(m.id) === String(messageId); });
        }
        var text = msg ? String(msg.text || '') : '';
        // An unsent tombstone has no body worth copying.
        if (!text || (msg && msg.unsent)) { showToast('Nothing to copy', 'info'); return; }

        var done = function () { showToast('Copied', 'success'); };
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text, done); });
                return;
            }
        } catch (e) { /* fall through to legacy */ }
        legacyCopy(text, done);
    }

    /** Clipboard fallback for browsers without the async Clipboard API. */
    function legacyCopy(text, done) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            ta.style.top = '0';
            document.body.appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, ta.value.length);
            var ok = document.execCommand('copy');
            document.body.removeChild(ta);
            if (ok) { done(); } else { showToast('Copy failed', 'error'); }
        } catch (e) {
            showToast('Copy not supported here', 'error');
        }
    }

    function openReactionPicker(messageId, anchor) {
        if (!els.reactionPicker || !messageId) return;
        if (closeReactionTimer) {
            clearTimeout(closeReactionTimer);
            closeReactionTimer = null;
        }
        // Already open for this message: do NOT re-anchor. Re-positioning on
        // every mouseover inside the message makes the row jitter as the
        // pointer crosses child elements. The Unsend button is re-synced EVERY
        // time regardless (cheap, and it guarantees the button can never be
        // left visible from a previous message when this one is not mine).
        if (reactionTargetId === String(messageId) && !els.reactionPicker.hidden) {
            syncUnsendButton(String(messageId));
            return;
        }
        reactionTargetId = String(messageId);
        els.reactionPicker.hidden = false;
        highlightCurrentReaction();
        syncUnsendButton(reactionTargetId);
        try {
            if (anchor && anchor.getBoundingClientRect) {
                const box = anchor.getBoundingClientRect();
                const picker = els.reactionPicker;
                // Horizontal: keep it on screen, hugging the message's left edge.
                let left = Math.max(8, box.left);
                try {
                    const pw = picker.offsetWidth || 0;
                    if (pw && left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
                } catch (e) { /* offsetWidth unavailable in some test DOMs */ }
                picker.style.left = left + 'px';
                // Vertical: iMessage-style — sit BELOW the message by default.
                // The popover is now taller (emoji row + divider + text bar), so
                // measure its real height. If it would run off the BOTTOM of the
                // viewport, flip it ABOVE the message instead (there is no room
                // below). Either way it is clamped to stay on screen.
                let ph = 0;
                try { ph = picker.offsetHeight || 0; } catch (e) { /* test DOMs */ }
                let below = box.bottom + 8;
                let above = box.top - ph - 8;
                let top;
                if (ph && below + ph > window.innerHeight - 8 && above >= 8) {
                    top = above;                 // no room below → flip above
                } else {
                    top = below;                 // default: below the message
                }
                picker.style.top = Math.max(8, top) + 'px';
            }
        } catch (e) { /* keep the CSS default position */ }
    }

    /**
     * Mark the emoji I already picked, so "one reaction" is visible in the
     * picker and re-picking it is visibly a toggle-off.
     */
    function highlightCurrentReaction() {
        if (!els.reactionPicker) return;
        const current = reactionTargetId ? myReactionOn(reactionTargetId) : null;
        const options = els.reactionPicker.querySelectorAll
            ? els.reactionPicker.querySelectorAll('[data-picker-key]')
            : [];
        Array.prototype.forEach.call(options, function (opt) {
            const isCurrent = !!(current && opt.getAttribute('data-picker-key') === current);
            opt.classList.toggle('is-current', isCurrent);
            opt.setAttribute('aria-pressed', isCurrent ? 'true' : 'false');
        });
    }

    function bindReactionPicker() {
        if (!els.reactionPicker) return;

        // ---- MOBILE: tapping the dim/blur scrim dismisses the menu. ----
        // The scrim only appears on the touch long-press path (engageMessageFocus),
        // so this listener is dormant on desktop. It is an explicit affordance on
        // top of the generic document-click dismissal below, so a tap on empty
        // space around the message always tears the focus overlay back down.
        //
        // ⚠️ It MUST honour the flicker guard. On a phone the browser fires a
        // synthetic `click` the instant the finger lifts after a long-press, and
        // that click very often lands on the full-screen scrim (the finger is
        // rarely dead-centre on the bubble). Without this guard that click closes
        // the menu we just opened — the "nawawala-wala" flicker. Swallow it ONCE,
        // and stopPropagation so it does not ALSO reach the document dismiss
        // handler (which would then close it, because the flag is already spent).
        if (els.focusBackdrop) {
            els.focusBackdrop.addEventListener('click', function (event) {
                if (suppressDismissClick) {
                    suppressDismissClick = false;
                    if (event.stopPropagation) event.stopPropagation();
                    return;
                }
                closeReactionPicker();
            });
        }

        // ---- HOVER: moving onto a message pops the emoji row up. No click. ----
        // Delegated, because els.log.innerHTML is reassigned wholesale on
        // every render, so per-element mouseenter handlers would not survive.
        els.log.addEventListener('mouseover', function (event) {
            if (!canHover()) return;
            const row = event.target.closest ? event.target.closest('.chat-msg') : null;
            if (!row) return;
            const id = row.getAttribute('data-msg-id');
            if (!id) return;
            openReactionPicker(id, row);
        });

        // Leaving the message dismisses it — but only once the pointer has
        // genuinely left both the message and the picker. DESKTOP ONLY: on a
        // phone there is no hover, and the browser still fires synthetic
        // mouseout/mouseleave after a touch — a stray one (relatedTarget null)
        // would close the long-press menu ~220ms later. canHover() gates it off.
        els.log.addEventListener('mouseout', function (event) {
            if (!canHover()) return;
            if (els.reactionPicker.hidden) return;
            const to = event.relatedTarget;
            if (to && to.closest) {
                if (to.closest('.chat-msg') === event.target.closest('.chat-msg')) return;
                if (to.closest('#chatReactionPicker')) return;
            }
            closeReactionPickerSoon();
        });
        els.log.addEventListener('mouseleave', function () {
            if (!canHover()) return;
            if (!els.reactionPicker.hidden) closeReactionPickerSoon();
        });

        // Keep it alive while the pointer is over the picker itself.
        els.reactionPicker.addEventListener('mouseover', function () {
            if (closeReactionTimer) {
                clearTimeout(closeReactionTimer);
                closeReactionTimer = null;
            }
        });
        // Leaving the picker closes it — DESKTOP hover only (same reason as the
        // log's mouseout/mouseleave above: no hover-based dismiss on a phone).
        els.reactionPicker.addEventListener('mouseleave', function () {
            if (!canHover()) return;
            closeReactionPicker();
        });

        // A ticket reference inside a message opens that ticket's modal.
        //
        // ⚠️ Checked on the SAME delegated listener as the reaction chips, and
        // it returns early, so a click can never both open a ticket and toggle
        // a reaction. `mousedown` would fire before the picker logic below, but
        // `click` is what a keyboard-activated button also produces, so the
        // chip stays reachable with Enter/Space like any other button.
        els.log.addEventListener('click', function (event) {
            const chip = event.target.closest
                ? event.target.closest('[data-ticket-ref]')
                : null;
            if (!chip) return;
            event.preventDefault();
            // No stopPropagation(): the reaction listener below is a SEPARATE
            // listener on the same element, and the `return` here already
            // guarantees only one of the two handles a given click (a ticket
            // chip carries no data-reaction-msg, and vice versa).
            closeReactionPicker();
            openTicketFromRef(chip.getAttribute('data-ticket-ref'));
        });

        // A violation reference inside a message opens that report's modal.
        //
        // A SEPARATE listener rather than a branch of the ticket one above:
        // the two chips are different elements carrying different data
        // attributes, so `closest()` can only ever find one, and keeping them
        // apart means a change to one chip's markup cannot silently break the
        // other. It mirrors the ticket handler exactly, including closing the
        // reaction picker so a chip click can never also toggle a reaction.
        els.log.addEventListener('click', function (event) {
            const chip = event.target.closest
                ? event.target.closest('[data-violation-ref]')
                : null;
            if (!chip) return;
            event.preventDefault();
            closeReactionPicker();
            openViolationFromRef(chip.getAttribute('data-violation-ref'));
        });

        // An existing chip toggles straight away, no menu needed.
        els.log.addEventListener('click', function (event) {
            const chip = event.target.closest
                ? event.target.closest('[data-reaction-msg]')
                : null;
            if (!chip) return;
            event.preventDefault();
            closeReactionPicker();
            toggleReaction(chip.getAttribute('data-reaction-msg'),
                chip.getAttribute('data-reaction-key'));
        });

        // ---- TOUCH: a long press opens the menu. ----
        // There is no per-message button any more, and a touch device has no
        // hover, so a press-and-hold is the only way in. Cancelled by moving
        // the finger (that is a scroll, not a long press) or by lifting
        // before the timer fires.
        var longPressTimer = null;
        function cancelLongPress() {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
        }
        // Kill the NATIVE context menu on the message list. On Android a long
        // press fires a `contextmenu` event (the OS Copy/Select All/Share popup)
        // EVEN with user-select:none, so it would appear alongside our custom
        // overlay. preventDefault() here stops that; our own long-press handler
        // below is what opens the menu. Desktop right-click is suppressed too,
        // which is fine — the desktop path opens the menu on hover, never via a
        // context menu.
        els.log.addEventListener('contextmenu', function (event) {
            event.preventDefault();
        });
        els.log.addEventListener('pointerdown', function (event) {
            // Only where there is NO hover. `canHover()` is true on a desktop
            // that already opens the menu on mouseover, so returning when it
            // is true keeps a mouse long-press from firing a surprise menu.
            if (canHover()) return;
            if (event.pointerType === 'mouse') return;
            const row = event.target.closest ? event.target.closest('.chat-msg') : null;
            if (!row) return;
            const id = row.getAttribute('data-msg-id');
            if (!id) return;
            cancelLongPress();
            longPressTimer = setTimeout(function () {
                longPressTimer = null;
                // Bring the held message into focus first (haptic tick + dim/blur
                // scrim + lift this bubble above it), THEN open the action popover
                // on top. Mobile only — the desktop hover path below never calls
                // this, so a mouse never triggers the scrim.
                engageMessageFocus(row);
                openReactionPicker(id, row);
                // Flicker guard: swallow the synthetic release-click that the
                // browser fires the instant this finger lifts, so the document
                // dismiss handler does not close the menu we just opened.
                suppressDismissClick = true;
            }, 400);
        });
        ['pointermove', 'pointerup', 'pointercancel', 'scroll'].forEach(function (type) {
            els.log.addEventListener(type, cancelLongPress, true);
        });

        // Choosing an action. mousedown so a blur cannot close the picker
        // before the click lands.
        els.reactionPicker.addEventListener('mousedown', function (event) {
            const target = reactionTargetId;
            if (!target) return;

            // REPLY — quote this message into the composer.
            if (event.target.closest && event.target.closest('[data-picker-reply]')) {
                event.preventDefault();
                closeReactionPicker();
                startReply(target);
                if (els.input) els.input.focus();
                return;
            }

            // COPY — copy the message text to the clipboard, then close. Works
            // on any message, mine or not.
            if (event.target.closest && event.target.closest('[data-picker-copy]')) {
                event.preventDefault();
                copyMessageText(target);
                closeReactionPicker();
                return;
            }

            // Unsend — retire my own message into an "Unsent message" tombstone.
            // The button is hidden on others' messages (syncUnsendButton), and
            // the rules re-check authorship, but guard here too so a stray
            // mousedown can never reach the write.
            if (event.target.closest && event.target.closest('[data-picker-unsend]')) {
                event.preventDefault();
                closeReactionPicker();
                confirmUnsend(target);
                return;
            }

            const option = event.target.closest
                ? event.target.closest('[data-picker-key]')
                : null;
            if (!option) return;
            event.preventDefault();
            closeReactionPicker();
            toggleReaction(target, option.getAttribute('data-picker-key'));
        });

        // Disarm the flicker guard the moment the user starts a NEW touch.
        // The synthetic release-click that trails a long-press has NO
        // pointerdown of its own (the finger was already down when the menu
        // opened), so it stays guarded and is swallowed — no flicker. A real,
        // deliberate tap DOES fire its own pointerdown first, which clears the
        // guard here, so that tap's click is free to dismiss — ONE tap, not
        // two. This is correct whether or not the device fires the synthetic
        // click: if it does, it is swallowed before this ever runs; if it does
        // not, the guard simply expires here on the next real touch.
        document.addEventListener('pointerdown', function () {
            suppressDismissClick = false;
        });

        // Clicking anywhere else dismisses it.
        document.addEventListener('click', function (event) {
            if (els.reactionPicker.hidden) return;
            // Flicker guard: the first click after a long-press open is the
            // synthetic release-click — swallow it (once) so the menu we just
            // opened is not immediately closed. Every later click dismisses.
            if (suppressDismissClick) { suppressDismissClick = false; return; }
            if (event.target.closest &&
                (event.target.closest('#chatReactionPicker') ||
                 event.target.closest('[data-reaction-msg]'))) return;
            closeReactionPicker();
        });

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') closeReactionPicker();
        });
    }

    function startReactionsListener() {
        if (reactionsUnsub) return;
        const reactions = reactionsRef();
        if (!reactions) return;
        try {
            reactionsUnsub = reactions.onSnapshot(function (snapshot) {
                const next = {};
                const myDocs = {};
                snapshot.forEach(function (doc) {
                    const data = doc.data() || {};
                    if (!data.messageId || !data.email) return;
                    // Remap the OLD emoji keys onto the new set, so reactions
                    // already in Firestore keep showing instead of vanishing.
                    const key = normaliseReactionKey(data.emoji);
                    const bucket = next[data.messageId] || (next[data.messageId] = {});
                    const entry = bucket[key] || (bucket[key] = {
                        count: 0, mine: false, people: []
                    });
                    entry.count++;
                    if (String(data.email).toLowerCase() === String(currentUserEmail || '').toLowerCase()) {
                        entry.mine = true;
                        // Remember WHICH document is mine, so it can be
                        // removed later even if it is a legacy-id doc.
                        myDocs[data.messageId] = { emoji: key, docId: doc.id };
                    }
                    if (entry.people.indexOf(data.email) === -1) entry.people.push(data.email);
                });
                reactionsByMessage = next;
                myReactionDocs = myDocs;
                if (els.log && lastRenderedMessages.length) {
                    renderMessages(lastRenderedMessages);
                }
            }, function (error) {
                console.warn('[Chat] Reactions unavailable:', error && error.message);
            });
        } catch (error) {
            console.warn('[Chat] Reactions unavailable:', error && error.message);
        }
    }

    function stopReactionsListener() {
        if (reactionsUnsub) {
            try { reactionsUnsub(); } catch (e) { /* ignore */ }
            reactionsUnsub = null;
        }
    }

    /** The reaction chips shown under a bubble. */
    function renderReactionChips(messageId) {
        const bucket = reactionsByMessage[messageId];
        if (!bucket) return '';
        const chips = REACTION_EMOJI.filter(function (e) { return bucket[e.key]; })
            .map(function (e) {
                const entry = bucket[e.key];
                const who = entry.people.join(', ');
                return '<button type="button" class="chat-reaction-chip' +
                    (entry.mine ? ' is-mine' : '') + '"' +
                    ' data-reaction-msg="' + escapeHTML(String(messageId)) + '"' +
                    ' data-reaction-key="' + escapeHTML(e.key) + '"' +
                    ' title="' + escapeHTML(who) + '"' +
                    ' aria-pressed="' + (entry.mine ? 'true' : 'false') + '">' +
                    '<span class="chat-reaction-emoji">' + reactionGlyph(e.key) + '</span>' +
                    '<span class="chat-reaction-count">' + entry.count + '</span>' +
                    '</button>';
            }).join('');
        return chips ? '<div class="chat-reactions">' + chips + '</div>' : '';
    }

    // ==============================================================
    //  RENDERING
    // ==============================================================

    /**
     * @param {Array} messages the live tail from onSnapshot
     * @param {{isHistory?: boolean}} opts isHistory = re-render caused by
     *        prepending a page rather than by new activity. Skips the
     *        unread-badge recomputation (old messages are not "unread") and
     *        suppresses the auto-scroll to bottom.
     */
    function renderMessages(messages, opts) {
        if (!els.log) return;
        const options = opts || {};
        const tail = messages || [];

        // ⚠️ Clear the unread boundary BEFORE building markup. It is also
        // cleared in updateUnreadFrom(), but that runs at the END of this
        // function — so without this the divider would still be drawn for
        // one more render after the chat was opened, i.e. "New messages"
        // would show while the user was already reading them.
        if (els.overlay && els.overlay.classList.contains('active')) {
            firstUnreadId = null;
        }

        const wasNearBottom = (els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight) < 120;

        // History is PREPENDED, not re-sliced away. The old code did
        // messages.slice(-MAX_MESSAGES_RENDERED) here, which would trim off
        // exactly the page the user just asked for.
        const combined = olderMessages.concat(tail);
        const visible = combined.length > MAX_RENDERED
            ? combined.slice(-MAX_RENDERED)
            : combined;

        // NOTE: els.log.innerHTML is reassigned wholesale below, which would
        // detach the #chatEmpty node, so the empty state is rendered as part
        // of the markup rather than toggled on a separate element.
        const bubbles = visible.map(function (msg, i) {
            const mine = currentUserEmail &&
                String(msg.senderEmail || '').toLowerCase() === String(currentUserEmail).toLowerCase();
            const time = escapeHTML(formatTime(msg.sentAt));

            // Consecutive messages from the same person within GROUP_WINDOW
            // are visually grouped: the avatar/name/role row is hidden so a
            // burst from one person reads as one block, Messenger-style.
            // This is what makes a long HR thread readable at a glance.
            const prev = i > 0 ? visible[i - 1] : null;
            const grouped = !!(prev && prev &&
                String(prev.senderEmail || '').toLowerCase() === String(msg.senderEmail || '').toLowerCase() &&
                (toDate(msg.sentAt) && toDate(prev.sentAt) &&
                    (toDate(msg.sentAt).getTime() - toDate(prev.sentAt).getTime()) <= GROUP_WINDOW_MS));
            // UNSENT: the author retired this message, so its body is gone.
            // Render a muted "Unsent message" placeholder instead of the text,
            // and do NOT run the mention/ticket linkify or the "mentions me"
            // highlight — an unsent message must not ping anybody or expose the
            // (now-cleared) references it used to carry.
            const unsent = !!msg.unsent;
            const body = unsent
                ? '<span class="chat-msg-unsent">Unsent message</span>'
                : renderMessageBody(msg.text, msg.mentions);
            const mentioned = unsent ? false : mentionsMe(msg);

            // Ticks only on MY messages: a single grey ✓ once the message
            // is stored (Firestore accepted the write), turning blue ✓✓
            // once everybody else has read past it. The sender's own
            // receipt is ignored so you never "seen" your own message.
            const receipt = mine
                ? '<span class="chat-msg-ticks' + (isMessageSeenByOthers(msg) ? ' is-seen' : '') +
                  '" title="' + (isMessageSeenByOthers(msg) ? 'Seen' : 'Sent') + '">' +
                  (isMessageSeenByOthers(msg) ? '&#10003;&#10003;' : '&#10003;') + '</span>'
                : '';

            return '<div class="chat-msg ' + (mine ? 'chat-msg-mine' : 'chat-msg-theirs') +
                (mentioned ? ' chat-msg-mentions-me' : '') +
                (grouped ? ' chat-msg-grouped' : '') + '" data-msg-id="' +
                    escapeHTML(String(msg.id || '')) + '">' +
                // The avatar sits in its OWN column beside the message, so the
                // name/time header below it collapses to one short line and no
                // vertical space is wasted above the bubble.
                '<div class="chat-msg-row">' +
                renderSenderAvatar(msg) +
                '<div class="chat-msg-content">' +
                '<div class="chat-msg-meta">' + renderSenderIdentity(msg) +
                '<span class="chat-msg-time">' + time + '</span>' + receipt +
                // No per-message action buttons here any more. Reply and the
                // reactions both live in the single context menu that pops up
                // on hover (or long-press), which keeps the header to pure
                // metadata and stops every message carrying its own icons.
                '</div>' +
                renderReplyQuote(msg) +
                '<div class="chat-msg-bubble">' + body + '</div>' +
                renderReactionChips(String(msg.id || '')) +
                '</div>' +
                '</div>' +
            '</div>';
        }).join('');

        // "New messages" divider, drawn immediately BEFORE the oldest unread
        // message. Without it the badge says "3 unread" but the user has to
        // scroll hunting for where they start. The markup is spliced into the
        // bubble string (NOT returned early — the bookkeeping below must
        // still run, or lastRenderedMessages and the badge go stale).
        let markup = bubbles;
        if (firstUnreadId) {
            const marker = markup.indexOf('data-msg-id="' + firstUnreadId + '"');
            if (marker > -1) {
                const divider = '<div class="chat-unread-divider" id="chatUnreadDivider">' +
                    '<span>New messages</span></div>';
                markup = markup.slice(0, marker) + divider + markup.slice(marker);
            }
        }

        // Track the TAIL only, never the combined list. loadOlderMessages()
        // re-renders by passing lastRenderedMessages back in, so this must
        // not accumulate history or each page would be prepended twice.
        lastRenderedMessages = tail;

        els.log.innerHTML = visible.length
            ? markup
            : '<p class="chat-empty">No messages yet. Start the conversation.</p>';

        // Prepending history must NOT yank the view to the bottom — the
        // caller restores the scroll anchor itself.
        if (!options.isHistory && (wasNearBottom || !els.overlay.classList.contains('active'))) {
            scrollLogToBottom();
        }

        updateHistoryBar();

        // The unread badge reflects the live tail only. Paging back must
        // never make a month-old message count as unread.
        if (!options.isHistory) {
            updateUnreadFrom(tail);
        }
    }

    /**
     * Unread = messages from OTHER people that arrived after this user last
     * had the chat open.
     *
     * ⚠️ SINGLE SOURCE OF TRUTH. This used to read the threshold from a
     * localStorage stamp (`rcms_chat_last_seen_<email>`) while the ✓/✓✓ Seen
     * ticks read `readReceipts/{email}.lastReadAt` from Firestore — two
     * independent answers to the same question, which disagree whenever the
     * browser store is empty: a new device, cleared site data, or a private
     * window all made getLastSeen() return 0 and marked the ENTIRE history
     * unread. The badge now derives from the same Firestore receipt the
     * ticks use, so the two can never disagree.
     *
     * localStorage survives only as a first-run fallback: a user who has
     * genuinely never opened this chat has no receipt yet, and without a
     * floor their whole history would light up as unread on first load.
     */
    function readStampKey() {
        return 'rcms_chat_last_seen_' + String(currentUserEmail || 'anon');
    }

    function getLocalFloor() {
        try {
            return Number(localStorage.getItem(readStampKey())) || 0;
        } catch (e) {
            return 0;
        }
    }

    function setLocalFloor(ms) {
        try {
            localStorage.setItem(readStampKey(), String(ms));
        } catch (e) { /* private mode / storage disabled — badge just stays clear */ }
    }

    /**
     * The read threshold, preferring the Firestore receipt.
     *
     * Until this user has their own receipt (first ever visit, or the
     * receipt write is denied because the rules are stale), fall back to the
     * local floor so the badge is not permanently pinned to "everything is
     * unread". The local value is only ever a LOWER BOUND, never an
     * override — the receipt always wins once it exists.
     */
    function getLastSeen() {
        const me = String(currentUserEmail || '').toLowerCase();
        const fromReceipt = readReceipts[me];
        if (typeof fromReceipt === 'number' && fromReceipt > 0) {
            // The receipt can legitimately be behind the local floor for a
            // moment (the write is throttled / in flight). Never let the
            // badge regress and re-count messages the user already read.
            return Math.max(fromReceipt, getLocalFloor());
        }
        return getLocalFloor();
    }

    function stampLastSeen() {
        // Optimistically raise the local floor so the badge clears the
        // moment the chat opens, without waiting for the Firestore round
        // trip. The receipt write is the authoritative record.
        setLocalFloor(Date.now());
    }

    /**
     * Id of the OLDEST unread message, captured while the chat is closed so
     * the divider can be drawn in the gap. Null when everything is read.
     */
    var firstUnreadId = null;

    function updateUnreadFrom(messages) {
        // While the chat is open everything is considered read.
        if (els.overlay.classList.contains('active')) {
            clearUnreadBadge();
            firstUnreadId = null;
            return;
        }

        const me = String(currentUserEmail || '').toLowerCase();
        const lastSeen = getLastSeen();

        let firstUnread = null;
        const unread = messages.filter(function (msg) {
            if (String(msg.senderEmail || '').toLowerCase() === me) return false;
            const sentAt = toDate(msg.sentAt);
            const sentMs = sentAt ? sentAt.getTime() : 0;
            // Messages with no readable timestamp are treated as unread so a
            // message is never silently hidden.
            if (!sentMs) {
                if (!firstUnread) firstUnread = msg.id;
                return true;
            }
            if (sentMs > lastSeen) {
                if (!firstUnread) firstUnread = msg.id;
                return true;
            }
            return false;
        }).length;

        // Remember where the unread run begins so renderMessages() can draw a
        // "New messages" divider there, instead of making the user hunt for
        // it. Captured only while the modal is CLOSED (the early return
        // above), so the divider only ever shows on the way back in.
        firstUnreadId = firstUnread;
        setUnreadBadge(unread);
    }

    // ==============================================================
    //  TYPING INDICATOR
    //
    //  Presence lives in chats/{roomId}/presence/{emailKey}, one doc per
    //  person, holding just `at` (the last time they were typing). A
    //  heartbeat keeps it fresh; other clients hide it once it goes
    //  stale, so a closed tab can never leave "…" stuck on screen.
    // ==============================================================

    /**
     * A typing failure is deliberately never shown as a toast, but it MUST
     * be loud in the console: a silently-swallowed permission error looks
     * exactly like "the typing indicator is broken". The most common cause
     * is simply not having deployed the rules that added the
     * chats/{chatId}/presence subcollection.
     */
    var typingFailureLogged = false;

    function reportTypingFailure(error) {
        if (typingFailureLogged) return;
        typingFailureLogged = true;

        const code = (error && error.code) || 'unknown';
        console.warn(
            '[Chat] ⚠️ Typing indicators are DISABLED (' + code + ').\n' +
            '  Presence lives in chats/{chatId}/presence, which is a NEW ' +
            'subcollection.\n' +
            '  If this is "permission-denied", run:\n' +
            '      firebase deploy --only firestore:rules\n' +
            '  Sending messages still works; only the typing indicator is affected.'
        );
    }

    function presenceRef() {
        return roomSubcollection('presence');
    }

    // ==============================================================
    //  READ RECEIPTS  (the ✓ Sent / ✓✓ Seen ticks)
    //
    //  Messages are immutable by design, so "seen" is NOT stored on the
    //  message. Instead each person owns ONE doc here holding the time
    //  they last had the thread open. A message of mine counts as Seen
    //  when the other participants' lastReadAt is at or past the moment
    //  I sent it.
    //
    //  Two fields of state per person, so a 200-message thread costs a
    //  couple of writes rather than one per message.
    // ==============================================================

    function readReceiptsRef() {
        return roomSubcollection('readReceipts');
    }

    function myReceiptRef() {
        const receipts = readReceiptsRef();
        return receipts ? receipts.doc(emailKeyFor(currentUserEmail)) : null;
    }

    /** email -> lastReadAt (ms). Populated by the receipts listener. */
    var readReceipts = {};

    /**
     * Record that I have read the thread up to now.
     *
     * THROTTLED, BUT NEVER DROPPED. A plain `if (tooSoon) return;` looks
     * harmless but starves the feature: the receipts write is throttled,
     * and a message that arrives inside the throttle window finds no
     * pending write and no further snapshot to trigger one — so
     * `lastReadAt` never advances past that message and the sender's tick
     * stays grey until a page reload happens to re-run the write. Instead
     * a throttled call is remembered and flushed once the window ends, so
     * the state always converges.
     */
    var RECEIPT_THROTTLE_MS = 3000;
    var lastReceiptWrite = 0;
    var receiptWritePending = false;
    var receiptFlushTimer = null;

    function writeReceipt() {
        receiptWritePending = false;
        lastReceiptWrite = Date.now();
        // The GROUP chat has no per-room membership, and a read receipt is a
        // per-room write — so there is nothing to acknowledge there. Skipping
        // it is not a compromise: the rules would refuse it, and a permanent
        // console warning is worse than grey ticks.
        if (isGroupRoom()) return;
        const ref = myReceiptRef();
        // No conversation open: there is nothing to acknowledge. The write
        // is dropped (not queued) because there is no room to queue it for.
        if (!ref) return;
        try {
            ref.set({
                email: currentUserEmail,
                lastReadAt: firebase.firestore.FieldValue.serverTimestamp()
            }, { merge: true }).catch(function (error) {
                // A denied receipt must never break the chat: the ticks
                // just stay grey. Stale rules are the usual cause.
                console.warn('[Chat] Read receipt not saved:', error && error.message);
            });
        } catch (error) {
            console.warn('[Chat] Read receipt not saved:', error && error.message);
        }
    }

    function markThreadRead(force) {
        if (!currentUserEmail) return;
        var nowMs = Date.now();
        if (force || nowMs - lastReceiptWrite >= RECEIPT_THROTTLE_MS) {
            if (receiptFlushTimer) {
                clearTimeout(receiptFlushTimer);
                receiptFlushTimer = null;
            }
            writeReceipt();
            return;
        }
        // Inside the throttle window: remember the request instead of
        // discarding it, and flush it as soon as the window closes.
        if (receiptWritePending) return;
        receiptWritePending = true;
        receiptFlushTimer = setTimeout(function () {
            receiptFlushTimer = null;
            if (receiptWritePending) writeReceipt();
        }, RECEIPT_THROTTLE_MS - (nowMs - lastReceiptWrite) + 50);
    }

    /**
     * Has everybody else read this message?
     * Requires at least one OTHER participant to have a receipt at or past
     * the send time. With no receipts at all (nobody has ever opened it)
     * this is false, so a fresh message shows a single grey ✓.
     */
    function isMessageSeenByOthers(msg) {
        var sentAt = toDate(msg.sentAt);
        if (!sentAt) return false;
        var sentMs = sentAt.getTime();
        var me = String(currentUserEmail || '').toLowerCase();
        var others = 0;
        var readByOthers = 0;
        for (var email in readReceipts) {
            if (!Object.prototype.hasOwnProperty.call(readReceipts, email)) continue;
            if (String(email).toLowerCase() === me) continue;
            others++;
            var at = readReceipts[email];
            if (at && at >= sentMs) readByOthers++;
        }
        // Nobody else has a receipt yet -> not seen.
        if (others === 0) return false;
        return readByOthers >= others;
    }

    /**
     * True only when the chat modal is genuinely open AND the browser tab
     * is in the foreground.
     *
     * Both conditions matter for an honest read receipt:
     *  - the modal must be open, otherwise "Seen" would fire for a chat
     *    the person never looked at (a delivered-but-unopened message
     *    must stay a grey ✓);
     *  - the tab must be visible, otherwise switching to another window
     *    with the chat open behind it would count as reading.
     *
     * document.hidden is undefined in a few non-browser hosts, so it is
     * treated as "visible" rather than blocking the receipt.
     */
    function isChatActuallyVisible() {
        if (!els.overlay || !els.overlay.classList.contains('active')) return false;
        try {
            if (typeof document !== 'undefined' && document.hidden === true) return false;
        } catch (e) { /* no document (tests) — assume visible */ }
        return true;
    }

    /** Live-update the receipts so ticks turn blue without a refresh. */
    function startReadReceiptListener() {
        if (readReceiptsUnsub) return;
        const receipts = readReceiptsRef();
        if (!receipts) return;
        try {
            readReceiptsUnsub = receipts.onSnapshot(function (snapshot) {
                var next = {};
                snapshot.forEach(function (doc) {
                    var data = doc.data() || {};
                    var at = toDate(data.lastReadAt);
                    if (data.email && at) next[data.email] = at.getTime();
                });
                readReceipts = next;
                // Re-render only if a message list is already on screen.
                if (els.log && lastRenderedMessages.length) {
                    renderMessages(lastRenderedMessages);
                }
            }, function (error) {
                // Stale rules (readReceipts not deployed yet) degrade to
                // permanent grey ticks — the chat itself still works.
                console.warn('[Chat] Read receipts unavailable:', error && error.message);
            });
        } catch (error) {
            console.warn('[Chat] Read receipts unavailable:', error && error.message);
        }
    }

    function stopReadReceiptListener() {
        if (readReceiptsUnsub) {
            try { readReceiptsUnsub(); } catch (e) { /* ignore */ }
            readReceiptsUnsub = null;
        }
    }

    /**
     * Coming back to the tab with the chat already open means the messages
     * that arrived while hidden have now been read — without this the
     * receipt would stay stale until the next message arrives.
     */
    function onVisibilityChange() {
        if (isChatActuallyVisible()) markThreadRead(true);
    }

    function startVisibilityListener() {
        if (typeof document === 'undefined' ||
            typeof document.addEventListener !== 'function' ||
            visibilityUnsub) return;
        document.addEventListener('visibilitychange', onVisibilityChange);
        visibilityUnsub = onVisibilityChange;
    }

    function stopVisibilityListener() {
        if (!visibilityUnsub) return;
        try {
            if (typeof document !== 'undefined' && document.removeEventListener) {
                document.removeEventListener('visibilitychange', visibilityUnsub);
            }
        } catch (e) { /* ignore */ }
        visibilityUnsub = null;
    }

    /**
     * Firestore doc IDs cannot contain '/', and an email cannot either,
     * but '@' and '.' are legal — encode defensively so an unusual
     * address can never produce an invalid document path.
     */
    function emailKeyFor(email) {
        return encodeURIComponent(String(email || '').toLowerCase());
    }

    function typingDocRef() {
        const presence = presenceRef();
        return presence ? presence.doc(emailKeyFor(currentUserEmail)) : null;
    }

    /** True while the composer holds an unsent, non-blank draft. */
    function hasDraft() {
        return !!(els.input && String(els.input.value || '').trim());
    }

    /** Publish (or refresh) our "composing" presence. */
    function publishPresence() {
        if (!isMounted || !currentUserEmail) return;
        // ⚠️ THE GROUP CHAT USES PRESENCE TOO. It used to be skipped here
        // because presence is an `isChatMember` write and the group room is
        // role-gated with no members array, so the write was refused. The rules
        // now allow publishing presence in that room on the ROLE instead (see
        // canPublishPresence() in firestore.rules), which is what makes typing
        // work for everyone rather than only in 1:1. A person still may only
        // ever write THEIR OWN presence doc.
        const ref = typingDocRef();
        // No conversation open (or the read-only archive), so there is no
        // presence doc to publish to.
        if (!ref) return;
        // ⚠️ A presence doc lives at chats/{chatId}/presence/{me}, and its
        // create rule resolves membership by READING THE ROOM
        // (`isChatMember(chatId)` = `get(chats/{chatId}).data.members`). For a
        // conversation whose room does not exist yet that write is a
        // GUARANTEED denial — not a race — and a never-started conversation is
        // the normal state before the first message, not an edge case. Nothing
        // is lost by staying quiet: the other person has no thread to see the
        // indicator in until the room exists.
        //
        // ⚠️ THE GROUP ROOM IS THE EXCEPTION, AND ON A FRESH DATABASE IT IS THE
        // ONLY ROOM THAT MATTERS. It has no `members` array and its document is
        // frozen, so `conversationSummaries` can never hold it (the list query
        // filters on `members`) — meaning this guard was permanently false
        // there on a brand-new Firestore and typing indicators were silently
        // dead for every member of the All HR group until somebody's first
        // message happened to seed a local summary. `canPublishPresence()`
        // resolves on the ROLE with no `exists()` check, so the write is
        // allowed there with or without a room document.
        if (!conversationSummaries[activeRoomId] && !isGroupRoom()) return;
        ref.set({
            email: currentUserEmail,
            // ⚠️ The name the OTHER person sees must be the name they see
            // EVERYWHERE else — their list row, the thread header, the message
            // sender. `displayNameFor(email, '')` returns the email's local
            // part, so an account registered as "Jiangnan Hotpot" was
            // announced as "hotpotjiangnan is typing…" while the very same
            // person's row and messages said something else. `nameFor()` reads
            // the same directory/roster the list reads and degrades to that
            // same local part when nothing has been published yet.
            name: nameFor(currentUserEmail),
            at: firebase.firestore.FieldValue.serverTimestamp()
        }).catch(function (error) {
            // Typing is a nicety: never surface a failure as a toast, but
            // make it obvious in the console because a silent no-op here
            // looks exactly like "the feature is broken".
            reportTypingFailure(error);
        });
    }

    /**
     * Called on every composer change.
     *
     * The indicator follows the DRAFT, not the keystrokes: once there is
     * unsent text we start a repeating heartbeat, so the indicator stays up
     * for as long as the message is being composed — even if the user stops
     * typing to think, reads something, or switches tabs for a while. It is
     * only withdrawn when the draft is sent or cleared.
     *
     * (A keypress-only model dropped the indicator during every pause in
     * typing, which is exactly what this replaces.)
     */
    function syncDraftPresence() {
        if (!isMounted) return;

        if (!hasDraft()) {
            withdrawPresence();
            return;
        }

        // Publish immediately so the indicator appears on the first
        // character, then let the heartbeat keep it alive.
        publishPresence();
        startDraftHeartbeat();
    }

    /** Repeat the presence write for as long as a draft exists. */
    function startDraftHeartbeat() {
        if (draftHeartbeatTimer) return;
        draftHeartbeatTimer = setInterval(function () {
            // Stop as soon as the draft is gone (sent or cleared) so we
            // never keep writing presence for a message nobody is writing.
            if (!hasDraft()) {
                withdrawPresence();
                return;
            }
            publishPresence();
        }, TYPING_HEARTBEAT_MS);
    }

    /**
     * Withdraw the indicator: stop the heartbeat and delete our presence
     * doc. Called when the draft is sent or cleared, and on teardown.
     */
    function withdrawPresence() {
        if (draftHeartbeatTimer) {
            clearInterval(draftHeartbeatTimer);
            draftHeartbeatTimer = null;
        }
        if (!isMounted || !currentUserEmail) return;
        const ref = typingDocRef();
        try {
            if (!ref) return;
            ref.delete().catch(function () { /* best effort */ });
        } catch (e) { /* ignore */ }
    }

    // __PART_TYPING_END__

    /**
     * The label for ONE typist, resolved exactly the way every other name in
     * the chat is resolved: the published directory / account-roster name
     * first (what `nameFor()` and the conversation list use), then whatever
     * the presence doc carries, then the email's local part.
     *
     * ⚠️ It used to be the other way round — `displayNameFor(entry.email,
     * entry.name)` always preferred `entry.name`, and `publishPresence()`
     * used to write that field as the email's local part. The result was one
     * thread showing two names for one person: their row, their header and
     * their messages said "Jiangnan Hotpot" while the indicator next to them
     * said "hotpotjiangnan is typing…".
     */
    function typingNameFor(entry) {
        const key = String(entry.email || '').toLowerCase();
        const published = personProfileFor(key).displayName;
        if (published) return String(published);
        return displayNameFor(entry.email, entry.name);
    }

    /** Render the "X is typing…" bar from a presence snapshot. */
    function renderTypingIndicator(entries) {
        if (!els.typingBar || !els.typingText) return;

        const me = String(currentUserEmail || '').toLowerCase();
        const now = Date.now();

        // Staleness is judged from LOCAL receipt time (presenceSeenAt),
        // never from the server `at` — see the note on presenceSeenAt.
        const names = entries.filter(function (entry) {
            const email = String(entry.email || '').toLowerCase();
            if (!email || email === me) return false;
            const seenAt = presenceSeenAt[email];
            if (!seenAt) return false;
            return (now - seenAt) < TYPING_STALE_MS;
        }).map(typingNameFor);

        if (names.length === 0) {
            els.typingBar.hidden = true;
            els.typingText.textContent = '';
            // The launcher pill is the visible signal while the chat is closed.
            if (els.launcherTyping) els.launcherTyping.hidden = true;
            if (els.launcherTypingText) els.launcherTypingText.textContent = '';
            if (els.launcher) els.launcher.classList.remove('chat-is-typing');
            return;
        }

        let label;
        if (names.length === 1) {
            label = names[0] + ' is typing…';
        } else if (names.length === 2) {
            label = names[0] + ' and ' + names[1] + ' are typing…';
        } else {
            label = names.length + ' people are typing…';
        }

        els.typingText.textContent = label;
        els.typingBar.hidden = false;

        // While the modal is OPEN the in-modal bar is enough; the floating
        // pill would be hidden behind the overlay anyway. When the modal is
        // CLOSED the pill is the only way the user can see it.
        const pillVisible = !els.overlay.classList.contains('active');
        if (els.launcherTyping) {
            els.launcherTyping.hidden = !pillVisible;
        }
        if (els.launcherTypingText) els.launcherTypingText.textContent = label;
        if (els.launcher) els.launcher.classList.toggle('chat-is-typing', pillVisible);
    }

    function startTypingListener() {
        if (typingUnsub) return;
        // ⚠️ The group room is subscribed to like every other thread. It was
        // skipped while its presence writes were refused (see publishPresence).
        const presence = presenceRef();
        if (!presence) return;
        try {
            typingUnsub = presence.onSnapshot(function (snapshot) {
                const entries = [];
                const now = Date.now();

                snapshot.forEach(function (doc) {
                    const data = doc.data();
                    entries.push(data);

                    const email = String(data.email || '').toLowerCase();
                    if (!email) return;

                    // Stamp LOCAL time — but ONLY when this entry actually
                    // changed. Stamping unconditionally would refresh
                    // everyone on every snapshot, so a person who had
                    // stopped typing would be revived whenever anybody
                    // else typed, and their indicator would never clear.
                    //
                    // A typing user rewrites their presence on each
                    // heartbeat, so a changed entry means "still typing".
                    const previous = lastPresenceByEmail[email];
                    const changed = !previous || previous.at !== data.at;

                    if (changed) presenceSeenAt[email] = now;
                    lastPresenceByEmail[email] = { at: data.at };
                });

                // Anyone removed from the collection has stopped typing.
                const live = {};
                entries.forEach(function (entry) {
                    const email = String(entry.email || '').toLowerCase();
                    if (email) live[email] = true;
                });
                Object.keys(presenceSeenAt).forEach(function (email) {
                    if (!live[email]) delete presenceSeenAt[email];
                });

                lastPresence = entries;
                renderTypingIndicator(entries);
            }, function (error) {
                // Typing is optional — log and carry on without it.
                reportTypingFailure(error);
            });
        } catch (error) {
            reportTypingFailure(error);
        }

        // A periodic sweep hides an indicator whose heartbeat stopped,
        // which can happen if a client vanished without cleanup. It runs
        // whether or not the modal is open, so the launcher pill expires
        // on time too.
        if (!typingSweepTimer) {
            typingSweepTimer = setInterval(function () {
                if (isMounted && lastPresence) renderTypingIndicator(lastPresence);
            }, 2000);
        }
    }

    function stopTypingListener() {
        if (typingUnsub) {
            try { typingUnsub(); } catch (e) { /* ignore */ }
            typingUnsub = null;
        }
        if (typingSweepTimer) {
            clearInterval(typingSweepTimer);
            typingSweepTimer = null;
        }
        lastPresence = [];
        presenceSeenAt = {};
        lastPresenceByEmail = {};
    }

    // ==============================================================
    //  SENDING
    // ==============================================================

    /**
     * True once the deployed rules have refused the FULL message payload, so
     * later messages go straight to the short one instead of failing (and
     * retrying) every single time. See writeMessageBatch().
     */
    var messageWritesMinimal = false;

    /**
     * ⚠️ WHY THE REPLY RE-PROBE EXISTS.
     *
     * A cached `minimal` send-shape is a LIE the UI acts on forever: it drops
     * `payload.replyTo`, so a reply is stored as an ordinary message and
     * `renderReplyQuote()` returns '' — it renders with NO quote block, looking
     * exactly like a normal message. And because the retry ladder is only built
     * when the flag is false, the one warning that explains this never fires.
     * The user had no way to tell a real reply from a stripped one.
     *
     * So: while a reply is pending, a cached `minimal` is no longer trusted. The
     * full payload is probed once per session. If the deployed rules have since
     * been updated it succeeds, the stale flag is CLEARED for good, and replies
     * work again. If they have not, the user is told exactly that — which is the
     * message that was missing entirely before.
     *
     * Once per SESSION, not per reply: if the rules genuinely still refuse, a
     * probe on every reply would cost an extra refused write each time without
     * ever reaching a different conclusion.
     */
    var replyShapeReprobed = false;

    /**
     * The write shape the deployed rules accept, REMEMBERED per account.
     *
     * ⚠️ WHY. Without this, every page load would rediscover it the hard way:
     * two refused writes and a console warning before the first message goes
     * through — on every conversation, every reload, for ever. The learning
     * cost is paid once per browser and then remembered, so the notice below
     * appears at most once.
     *
     * It is a hint, never a lock: if the rules are ever updated, deleting this
     * one localStorage key makes the client rediscover the fuller shape (the
     * warning even says so).
     */
    function sendShapeKey() {
        return 'rcms_chat_send_shape_' + String(currentUserEmail || 'anon');
    }

    function loadSendShape() {
        // Optimistic defaults: the shape the current rules are SUPPOSED to allow.
        messageWritesMinimal = false;
        roomPreviewInBatch = true;
        try {
            const raw = localStorage.getItem(sendShapeKey());
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && typeof parsed === 'object') {
                messageWritesMinimal = parsed.minimal === true;
                roomPreviewInBatch = parsed.preview !== false;
            }
        } catch (e) { /* private mode or corrupt value: rediscover, no harm */ }
    }

    function saveSendShape() {
        try {
            localStorage.setItem(sendShapeKey(), JSON.stringify({
                minimal: messageWritesMinimal,
                preview: roomPreviewInBatch
            }));
        } catch (e) { /* storage disabled — rediscovered on the next load */ }
    }
    /**
     * False once the deployed rules have refused a room-summary write INSIDE the
     * message batch. That is a real possibility: a room can be *created* (the
     * standalone write the deployed rules plainly allow) while the *update*
     * rule for anything but the legacy room refuses — and the update rides in
     * the same atomic batch as the message, so one refused room update takes
     * the message down with it and the report blames the message. When that
     * happens the preview is written separately, best-effort, and a failure
     * there costs nothing but a stale sidebar line.
     */
    var roomPreviewInBatch = true;

    /**
     * The message write, in ONE atomic batch with the room preview.
     *
     * ⚠️ WHY THERE ARE TWO PAYLOAD TIERS. The DEPLOYED message create rule can
     * be older than this client. The schema this app has always documented is
     * `{ text, senderEmail, senderName, senderRole, sentAt }`; `mentions` and
     * `replyTo` came later, and the rules in this repository put NO allowlist
     * on message fields, so nothing here ever needed one. If the deployed rule
     * does carry a `hasOnly()` allowlist from that older era, the extra keys
     * are refused and the message never saves — which is exactly
     * "[Chat] Failed to send message: Missing or insufficient permissions",
     * with the room write above it SUCCEEDING (which is the tell: a room and a
     * message in the same batch fail together, so one passing and one failing
     * means the refusal is specific to the message document).
     *
     * So the full payload goes first (keeping mentions and replies) and, only
     * if the rules refuse it, sendMessage() retries the identical message with
     * the five documented fields. Nothing is lost that cannot be derived:
     * mentions are recomputed from the text, and `senderRole` is read from the
     * profile anyway.
     *
     * ⚠️ `senderEmail` IS THE MODULE'S OWN LOWERCASED ADDRESS (`me`, which is
     * `String(currentUserEmail).toLowerCase()`, and `currentUserEmail` itself
     * was stored lowercased by init()). It is written explicitly rather than
     * reused from the auth object because the create rule is
     * `request.resource.data.senderEmail == selfEmail()` and `selfEmail()` is
     * `request.auth.token.email.lower()`: the two must be compared in the SAME
     * case, and the moment anyone "simplifies" this back to
     * `auth.currentUser.email` the comparison silently becomes case-sensitive
     * again. It is the same value today, deliberately.
     */
    function writeMessageBatch(text, me, roomSummary, minimal, withPreview) {
        const batch = db.batch();
        const payload = {
            text: text,
            senderEmail: me,
            // Same rule as the typing label: fall back to the name the rest of
            // the chat shows this account (directory / roster), not the bare
            // email local part. `profileFor()` still prefers a published name
            // at render time — this is the fallback for the moment the
            // directory snapshot has not arrived yet.
            senderName: nameFor(currentUserEmail),
            senderRole: currentRole || '',
            // The listener pages and orders by this exact field, so the write
            // and the query can never disagree about it.
            sentAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        if (!minimal) {
            payload.mentions = extractMentions(text);
            payload.replyTo = replyingToId || null;
        }
        batch.set(messagesRef().doc(), payload);
        if (withPreview) {
            // The preview rides in the SAME batch as the message, so an existing
            // conversation updates atomically. (For a brand-new one the room
            // already exists by now — see above — so this is an update of the
            // same six keys, which the deployed update rule allows.)
            batch.set(roomRef(), roomSummary, { merge: true });
        }
        return batch.commit();
    }

    /**
     * The room preview on its own, for when the deployed rules refuse it
     * inside the message batch. Best-effort by design: a failure here costs a
     * stale sidebar line and nothing else, so it is deliberately silent (the
     * message itself has already been saved by then).
     */
    function writeRoomPreviewQuietly(roomSummary) {
        try {
            const done = roomRef().set(roomSummary, { merge: true });
            if (done && typeof done.catch === 'function') {
                done.catch(function () { /* the thread is fine without it */ });
            }
        } catch (e) { /* same: never let the preview break a sent message */ }
    }

    /**
     * Keep a sidebar line correct WITHOUT a server-side room-summary write.
     *
     * ⚠️ WHY THIS EXISTS. The deployed rules may refuse the room UPDATE (which
     * is why the message is now sent without its preview), and that means the
     * room document's `lastMessage` is FROZEN on the server — the sender's
     * preview stops updating, and so does the RECEIVER's, because the receiver
     * relies on the sender having written it. So the preview is derived here
     * from the message stream itself: the newest message this device has seen
     * is the truth about that conversation, and it is already in hand.
     *
     * The guard is what keeps a stale server document from overwriting a newer
     * local one: an older timestamp is ignored, never applied.
     */
    function syncSummaryFromMessage(roomId, msg) {
        if (!roomId || !msg) return;
        const at = (toDate(msg.sentAt) || new Date(0)).getTime();
        const current = conversationSummaries[roomId];
        if (current && Number(current.lastMessageAtMs || 0) >= at) return;
        const summary = {
            roomId: roomId,
            lastMessage: String(msg.text || '').slice(0, 140),
            lastMessageAtMs: at,
            lastSenderEmail: msg.senderEmail || '',
            isArchive: roomId === LEGACY_ROOM_ID,
            peerEmail: roomId === LEGACY_ROOM_ID ? null : peerFromRoomId(roomId)
        };
        // A branch room's identity lives in `title`/`members`. This function
        // REBUILDS the summary object, so carry them forward — otherwise the
        // first message sent in a branch room would rename the row to
        // "branch-x — branch chat" and empty the @mention picker until the
        // next room snapshot.
        if (current && isBranchRoom(roomId)) {
            if (current.title) summary.title = current.title;
            if (Array.isArray(current.members)) summary.members = current.members;
        }
        conversationSummaries[roomId] = summary;
        renderConversationList();
        updateLauncherBadgeFromList();
    }

    /**
     * Everyone this device knows about, for the group room's `members` list.
     *
     * ⚠️ THIS IS A FALLBACK, NOT THE MECHANISM. The group room is gated on the
     * ROLE, so a new account is in it with nothing to do. The list matters only
     * if it has to be CREATED (a brand-new project has no such room yet) AND
     * the deployed rules turn out to gate that room on `members` after all —
     * and because a room update is refused, whoever is missing from the list at
     * creation time could never be added. So it is written as complete as this
     * device can make it: the signed-in person plus everyone the directory and
     * the account roster know.
     */
    function everyoneKnownForGroup() {
        const everyone = {};
        const me = String(currentUserEmail || '').toLowerCase();
        if (me) everyone[me] = true;
        startableEmails().forEach(function (email) {
            const key = String(email || '').toLowerCase();
            if (key) everyone[key] = true;
        });
        return Object.keys(everyone);
    }

    /** Everything that must happen once a message is safely stored. */
    function finishSentMessage(text, me) {
        // The room document EXISTS — it was committed first, as its own awaited
        // write, because the message rule resolves membership by reading it.
        // So the subscriptions deliberately skipped for a never-started
        // conversation can finally start. Without this the thread would stay
        // blank until the user reloaded the page.
        if (!messagesUnsub) {
            startListener();
            startTypingListener();
        }

        // The row was rendered from the directory as a "tap to start"
        // placeholder. Seed (or REFRESH) the local summary so the sidebar shows
        // this conversation's real state immediately — and, when the deployed
        // rules refuse the room preview, so the line does not stay frozen at
        // whatever the server last accepted. The list (query, or the per-room
        // fallback) will still replace it with the server's copy when it can.
        syncSummaryFromMessage(activeRoomId, {
            text: text,
            senderEmail: me,
            sentAt: new Date()
        });

        // We have read everything we sent, so our own count is zero.
        clearUnreadForActiveRoom();

        // The room exists now, so a room listener that was DENIED while it did
        // not exist can be attached, and the room is remembered so the list can
        // still find it if the query stays denied.
        rememberRoom(activeRoomId);
        subscribeRoomForList(activeRoomId);

        // The reply is sent — clear the banner so the next message is a fresh
        // top-level one instead of silently inheriting this target.
        cancelReply();
        els.input.value = '';
        // The draft is gone, so withdraw the indicator.
        withdrawPresence();
        els.input.focus();
    }

    async function sendMessage() {
        if (!isMounted) return;

        // Nothing selected yet. The composer is disabled in that case too, but
        // a stray Enter (or a programmatic call in a test) must not reach
        // Firestore and be rejected by the rules.
        if (!activeRoomId) {
            showToast('Pick a conversation first.', 'info');
            return;
        }
        // The GROUP chat has no single peer — it is everybody — so a missing
        // peer is expected there and only there.
        if (!activePeerEmail && !isGroupRoom()) {
            showToast('Could not work out who this conversation is with.', 'error');
            return;
        }

        const text = String(els.input.value || '').trim();
        if (!text) return;
        if (text.length > MAX_MESSAGE_LENGTH) {
            showToast('Message is too long (max ' + MAX_MESSAGE_LENGTH + ' characters).', 'error');
            return;
        }
        if (!currentUserEmail) {
            showToast('You must be signed in to send a message.', 'error');
            return;
        }

        els.sendBtn.disabled = true;
        // WHICH write failed. A permission error on the ROOM and one on the
        // MESSAGE need different fixes (one is "create the conversation",
        // the other is "write inside it"), and with a single generic message
        // they are indistinguishable in the field — which is exactly how a
        // rules problem ends up being reported as the wrong bug.
        let stage = 'room';
        // Hoisted out of the try on purpose: the self-healing retry in the catch
        // needs the same lowercased address, and it is also what the message
        // payload must carry (the create rule compares it against a lowercased
        // email).
        const me = String(currentUserEmail).toLowerCase();
        let roomSummary = null;
        try {
            const them = String(activePeerEmail).toLowerCase();

            // The room summary, denormalised so the conversation list never
            // has to read every message.
            //
            // ⚠️ THE FIELD LIST IS DELIBERATELY THE *OLD* ONE. These are
            // exactly the keys the currently-DEPLOYED rules already allow
            // (`type, title, lastMessage, lastMessageAt, lastSenderEmail,
            // members`), so a conversation works on the free plan with
            // **no rules deploy at all**. Adding a field here — an
            // `unreadCount`, a `createdAt` — would make the create/update
            // `hasOnly()` check fail and reject the message write (they ride
            // in the same batch), i.e. messages would silently stop saving.
            // Unread is tracked in localStorage for the same reason (see
            // unreadStateKeyFor).
            //
            // Declared ONCE because it is written TWICE (see below). Two
            // copies of a five-key literal would drift, and a drifted key is
            // a denied write, not a warning.
            roomSummary = {
                // The group channel says what it is, and carries EVERYONE this
                // device knows (see everyoneKnownForGroup) so that even a
                // membership-gated ruleset would let them all in.
                type: isGroupRoom() ? 'group' : 'direct',
                members: isGroupRoom() ? everyoneKnownForGroup() : [me, them],
                lastMessage: text.slice(0, 140),
                lastMessageAt: firebase.firestore.FieldValue.serverTimestamp(),
                lastSenderEmail: me
            };

            // ⚠️ THE ROOM MUST EXIST ON THE SERVER *BEFORE* THE MESSAGE IS
            // WRITTEN. THIS IS NOT OPTIONAL AND IT IS NOT ATOMIC ANY MORE.
            //
            // Membership is resolved by READING THE ROOM:
            // `isChatMember(chatId)` is
            // `get(chats/{chatId}).data.members has selfEmail()` — and the
            // message rule inherits that check. On a conversation that has
            // never been messaged the room document does not exist yet, so
            // putting the room and the message in ONE batch does NOT work:
            // the rules see the state the write arrived in, the get() finds
            // no room, and (on the deployed rules, which dereference
            // `.data.members` without an exists() guard) the whole rule
            // evaluates to DENIED. The message is refused, the room is never
            // created, and every retry fails identically — the
            // "Chat cannot read or write this conversation" report.
            //
            // Creating the room first is the fix, and it needs no rules
            // deploy: the room write is the very write the deployed rules
            // already allow. `{ merge: true }` makes it idempotent, so it is
            // also harmless when the room DOES already exist and the
            // conversation list simply has not arrived yet.
            //
            // ⚠️⚠️ AND NEVER IN THE GROUP ROOM. That document is FROZEN BY
            // DESIGN — `firestore.rules` denies both `allow create` and
            // `allow update` on it with `&& !isLegacyArchive(chatId)` — so on
            // a FRESH Firestore, where `chats/owner-superadmin` does not exist
            // and `conversationSummaries` can never hold it (the list query is
            // `where('members','array-contains', me)` and this room is
            // role-gated with NO `members` array), `roomIsStarted` was always
            // false here and this line attempted a CREATE of a room the rules
            // refuse on purpose. That threw at `stage === 'room'`, which also
            // SKIPPED the payload ladder below (it is gated on
            // `stage === 'message'`), so nothing was ever retried and the
            // failure was misreported as "the deployed rules need a deploy" —
            // which fixes nothing, because this repo's own rules refuse it too.
            //
            // No parent document is needed for the group: its message rule is
            // `allow create: if isLegacyArchive(chatId) && …`, which is
            // ROLE-gated and never checks `exists()`. Firestore lets a
            // subcollection document exist under a parent that does not.
            const roomIsStarted = Boolean(conversationSummaries[activeRoomId]);
            if (!roomIsStarted && !isGroupRoom()) {
                await roomRef().set(roomSummary, { merge: true });
            }

            stage = 'message';

            // ⚠️ A pending REPLY must not silently lose its target. A cached
            // `minimal` shape drops `replyTo`, so the probe below tries the full
            // payload once before falling back — see replyShapeReprobed.
            const reprobingForReply = messageWritesMinimal && !!replyingToId && !replyShapeReprobed;
            if (reprobingForReply) {
                replyShapeReprobed = true;
                try {
                    await writeMessageBatch(
                        text,
                        me,
                        roomSummary,
                        false,                               // force the FULL payload
                        roomPreviewInBatch && !isGroupRoom()
                    );
                    // It worked: the deployed rules accept the full shape again,
                    // so the stale cached flag is dropped for good.
                    messageWritesMinimal = false;
                    saveSendShape();
                    console.log('[Chat] Reply stored WITH its target — the deployed rules accept the '
                        + 'full message payload again, and the stale minimal-shape cache was cleared.');
                    finishSentMessage(text, me);
                    return;
                } catch (probeError) {
                    if (!isPermissionError(probeError)) throw probeError;
                    // The rules genuinely still refuse it. Say so, because
                    // without this the reply is stored as a plain message and
                    // looks identical to one that was never a reply.
                    console.warn(
                        '[Chat] ⚠️ This reply will NOT be linked to the message it answers.\n'
                        + '  The deployed rules still refuse the full payload (replyTo).\n'
                        + '  Run:  firebase deploy --only firestore:rules\n'
                        + '  Then delete this browser\'s cached shape:\n'
                        + '      localStorage.removeItem(\'' + sendShapeKey() + '\')');
                }
            }

            // The group channel's pinned row needs no preview, and the room
            // update would be refused anyway — so it is never even attempted.
            await writeMessageBatch(
                text,
                me,
                roomSummary,
                messageWritesMinimal,
                roomPreviewInBatch && !isGroupRoom()
            );
            if (!roomPreviewInBatch && !isGroupRoom()) writeRoomPreviewQuietly(roomSummary);
            finishSentMessage(text, me);
        } catch (error) {
            // ⚠️ THE DEPLOYED RULES ARE OLDER THAN THIS CLIENT, SO THE WRITE IS
            // TRIED IN THREE SHAPES — each one ONCE per session, in this order,
            // and the first that works becomes the default from then on:
            //
            //   1. the full payload with the room preview (the default)
            //   2. the SHORT payload with the room preview — a deployed
            //      `hasOnly()` on messages that predates mentions/replyTo
            //   3. the short payload ALONE — the room *update* is what the
            //      deployed rules refuse. A room can be created (the standalone
            //      write they plainly allow) while the update rule for anything
            //      but the legacy room says no; the update rides in the same
            //      ATOMIC batch as the message, so one refused room update
            //      takes the message down with it and the report blames the
            //      message. Nothing is lost but an atomic preview update.
            let failure = error;
            // ⚠️ TWO RUNGS, AND ONLY ONE OF THEM IS 1:1-SPECIFIC.
            //
            //   1. THE MESSAGE SHAPE runs in EVERY room, the group channel
            //      included. The payload written there is the very one a 1:1
            //      send writes (only the room preview differs), so a deployed
            //      `hasOnly()` that predates mentions/replyTo refuses a GROUP
            //      message exactly as it refuses a 1:1 one — and while the
            //      ladder was skipped for the group room, that first message
            //      on a fresh browser was the one message in the app with no
            //      fallback at all.
            //   2. THE ROOM PREVIEW stays 1:1-only: the group row is pinned (it
            //      needs no preview) and its room is frozen, so there is
            //      nothing left to vary and the write is refused by design.
            if (stage === 'message' && isPermissionError(error)) {
                const groupRoom = isGroupRoom();
                const ladder = [];
                if (!messageWritesMinimal) {
                    ladder.push({
                        minimal: true,
                        preview: !groupRoom && roomPreviewInBatch,
                        why: 'the full message payload',
                        note: 'Mentions still work (they are derived from the text); replies are not ' +
                            'stored until the rules are updated.'
                    });
                }
                if (!groupRoom && roomPreviewInBatch) {
                    ladder.push({
                        minimal: true,
                        preview: false,
                        why: 'the room preview written in the same batch as the message',
                        note: 'The message is saved; the sidebar preview is now a separate best-effort write.'
                    });
                }
                for (const step of ladder) {
                    try {
                        await writeMessageBatch(text, me, roomSummary, step.minimal, step.preview);
                        messageWritesMinimal = true;
                        // Only the rung that actually DROPPED a preview may
                        // demote the shared 1:1 flag and write the preview on
                        // its own: the group rung has no preview either, but
                        // that is not a discovery about the room — its room is
                        // never written at all (see the group send above).
                        if (!step.preview && !groupRoom && roomPreviewInBatch) {
                            roomPreviewInBatch = false;
                            writeRoomPreviewQuietly(roomSummary);
                        }
                        // Remembered, so this is learned once per browser and
                        // not rediscovered on every page load.
                        saveSendShape();
                        console.warn('[Chat] The deployed Firestore rules refused ' + step.why +
                            ', so this message was sent without it. ' + step.note +
                            ' That is now remembered for this account — to test again after a rules ' +
                            'update, delete the localStorage key ' + sendShapeKey() + '.');
                        finishSentMessage(text, me);
                        return;
                    } catch (retryError) {
                        failure = retryError;
                    }
                }
            }

            // Surface the REAL reason. A generic "could not send" message makes
            // permission problems indistinguishable from network ones, which is
            // very hard to debug in the field.
            const code = (failure && failure.code) || '';
            // Name the write that failed. "Cannot create the conversation" and
            // "cannot write into it" are different bugs with different fixes,
            // and reporting the second when the first failed sends people
            // looking in the wrong place.
            if (stage === 'room') {
                console.error('[Chat] Could not create the room doc ' + activeRoomId + ':', failure);
            } else {
                console.error('[Chat] Failed to send message:', failure);
            }

            if (isPermissionError(failure)) {
                // ⚠️ NEVER GREY OUT THE CHAT FOR A FAILED SEND. Locking the
                // launcher turns one refused write into "the whole feature is
                // dead" — the user can no longer even READ their history, and
                // there is nothing they can do about it. Say exactly what was
                // refused, keep the chat usable, and leave the draft in place
                // so the message can be retried as-is.
                //
                // ⚠️ WHEN IT IS THE *GROUP* ROOM ONLY, IT IS THE RULESET. That
                // message carries the SAME payload a working 1:1 send writes
                // (the shape ladder above has just varied it), and every other
                // write in that room is skipped by design — so the one thing a
                // group message needs and a 1:1 one does not is its own
                // `allow create` clause:
                //     allow create: if isLegacyArchive(chatId)
                //       && request.resource.data.senderEmail == selfEmail();
                // `firestore.rules` in this repository HAS it (guarded by
                // test/chat-rules.test.js); the DEPLOYED copy evidently does
                // not, because `chats/owner-superadmin` has no `members` list
                // for the membership rule to check. Name the clause and the
                // fix: a bare "Missing or insufficient permissions" sends
                // people hunting through the payload instead.
                if (isGroupRoom()) {
                    console.warn('[Chat] The GROUP chat (chats/owner-superadmin) needs its own ' +
                        '`allow create: if isLegacyArchive(chatId) && request.resource.data.senderEmail ' +
                        '== selfEmail();` clause on `messages` in the DEPLOYED rules — the message ' +
                        'payload itself is the one a 1:1 send uses, so it is the ruleset, not the write. ' +
                        'firestore.rules in this repo already has that clause. Fix: ' +
                        'firebase deploy --only firestore:rules');
                }
                showToast(isGroupRoom()
                    ? 'The group chat could not be written to — the deployed Firestore rules refused ' +
                      'messages in it. Nothing was sent, and your 1:1 conversations are unaffected. ' +
                      'Fix: run firebase deploy --only firestore:rules.'
                    : (stage === 'room'
                        ? 'This conversation could not be started — the deployed Firestore rules ' +
                          'refused to create its room. Nothing was sent.'
                        : 'This message could not be saved — the deployed Firestore rules refused ' +
                          'messages in this conversation. Nothing was sent, and your existing ' +
                          'conversations are fine.'),
                'error');
            } else if (code === 'unavailable' || code === 'deadline-exceeded') {
                showToast('Network problem — message not sent. Please try again.', 'error');
            } else {
                showToast('Could not send the message' + (code ? ' (' + code + ')' : '') + '.', 'error');
            }
        } finally {
            els.sendBtn.disabled = false;
        }
    }

    // ==============================================================
    //  INCOMING MESSAGE SOUND
    //
    //  Delegates to the app's shared, preloaded notification sound
    //  (js/notifications.js), so a chat message sounds identical to a ticket
    //  alert and both use the same preloaded Audio.
    //
    //  ⚠️ THE LOCAL `new Audio(...)` FALLBACK WAS DELETED. It existed beside a
    //  guard on `window.playNotificationSound`, but that function was never
    //  exported — so the guard was always false, the shared path was dead code,
    //  and the fallback silently became the only path. notifications.js now
    //  exports it (see the EXPOSE GLOBALLY block there), so the delegation
    //  below is the single one. The `typeof` guard is kept: it is what stops a
    //  missing module from throwing inside the failure path.
    // ==============================================================

    function playIncomingSound() {
        try {
            if (typeof window.playNotificationSound === 'function') {
                window.playNotificationSound();
                return;
            }
            // No notification module on this page. Stay silent — a sound is a
            // nicety, and constructing a new Audio per message would be the
            // very thing the shared path avoids.
        } catch (e) {
            // Audio is a nicety; never let it break the chat.
        }
    }

    // A distinct, more insistent sound for a direct mention. Local-first like
    // the main chime (see js/notifications.js): sounds/mention.mp3 is the
    // byte-identical copy of the mixkit preview; the CDN is the fallback so
    // an ad-blocker can never mute mentions silently. Single `new Audio`
    // construction (guarded by test 68): the fallback swaps the SRC on the
    // same element instead of building a second object.
    var mentionSoundUrl = 'sounds/mention.mp3';
    var mentionSoundFallbackUrl = 'https://assets.mixkit.co/active_storage/sfx/2873/2873-preview.mp3';
    var mentionAudio = null;

    function playMentionSound() {
        try {
            if (!mentionAudio) {
                mentionAudio = new Audio(mentionSoundUrl);
                mentionAudio.addEventListener('error', function handleMentionError() {
                    mentionAudio.removeEventListener('error', handleMentionError);
                    try {
                        mentionAudio.src = mentionSoundFallbackUrl;
                        mentionAudio.preload = 'auto';
                        mentionAudio.load();
                    } catch (e) { /* ignore */ }
                });
            }
            mentionAudio.pause();
            mentionAudio.currentTime = 0;
            const p = mentionAudio.play();
            if (p && p.catch) p.catch(function () { /* autoplay may be blocked */ });
        } catch (e) {
            // Audio is a nicety; never let it break the chat.
        }
    }

    /**
     * Notify the signed-in user that they were mentioned by name. A
     * mention is stronger than an ordinary message, so it gets its own
     * sound and a toast naming the sender. It is deliberately NOT
     * auto-read: the unread badge behaves as usual and opening the chat is
     * what acknowledges it, exactly as for any other message.
     */
    function announceMention(msg) {
        if (!mentionsMe(msg)) return;
        const who = displayNameFor(msg.senderEmail, msg.senderName);
        playMentionSound();
        try {
            if (typeof showToast === 'function') {
                showToast(who + ' mentioned you in chat.', 'info');
            }
        } catch (e) { /* a toast is a nicety */ }
    }

    // Suppresses sound for the FIRST snapshot of a subscription: that
    // payload is the existing history, not new activity. Reset whenever a
    // listener is (re)started so a resubscribe never replays old messages.
    var awaitingFirstSnapshot = false;

    /**
     * Play a sound only for messages that are genuinely NEW and from
     * somebody else. The first snapshot seeds the known ids instead, so
     * opening the chat does not machine-gun through the whole history.
     *
     * ⚠️ THIS IS NOW THE *OPEN CONVERSATION'S* SHARE OF THE ALERT, not the
     * whole of it. The conversation-LIST listener announces every OTHER
     * conversation (see announceNewConversations) because only this listener
     * can see the open thread. So:
     *
     *   - a message here that the list listener has ALREADY announced is
     *     skipped, or one message would sound twice;
     *   - `activeRoomId` is captured at subscribe time by the caller, so a
     *     snapshot belonging to a room you have since left is ignored — that
     *     stale payload would otherwise replay a whole old thread.
     */
    function announceNewMessages(messages) {
        if (awaitingFirstSnapshot) {
            // Seed the baseline, stay silent.
            awaitingFirstSnapshot = false;
            seenMessageIds = messages.map(function (msg) { return msg.id; });
            return;
        }

        const me = String(currentUserEmail || '').toLowerCase();

        const incoming = messages.filter(function (msg) {
            if (seenMessageIds.indexOf(msg.id) > -1) return false;
            return String(msg.senderEmail || '').toLowerCase() !== me;
        });

        // Remember everything we have seen (ours included).
        seenMessageIds = messages.map(function (msg) { return msg.id; });

        if (incoming.length === 0) return;

        // Skip anything the list listener has already sounded for, so a
        // single message is announced exactly once whichever path gets there
        // first. The room stamp is compared per message, not per batch.
        const unannounced = incoming.filter(function (msg) {
            const at = (toDate(msg.sentAt) || new Date(0)).getTime();
            return !roomAlreadyAnnounced(msg.roomId || activeRoomId, at);
        });

        // ⚠️ A MENTION PLAYS ITS OWN SOUND ONLY. It used to get the plain
        // incoming chime FIRST and then the mention sound on top, so every
        // mention made two noises back to back and the second cut the first
        // off. A mention is the more insistent of the two, so it plays alone.
        const mentions = unannounced.filter(function (msg) { return mentionsMe(msg); });

        if (mentions.length > 0) {
            mentions.forEach(announceMention);
        } else {
            // No mention: one chime for the batch, matching "one sound per
            // arriving message" for the list listener without machine-gunning
            // a wall of history the user is already looking at.
            for (let i = 0; i < unannounced.length; i++) playIncomingSound();
        }

        // Record the room's newest time, so the list listener does not replay
        // the same message a moment later when its own snapshot lands.
        const newest = incoming[incoming.length - 1];
        if (newest) {
            markRoomAnnounced(
                newest.roomId || activeRoomId,
                (toDate(newest.sentAt) || new Date(0)).getTime()
            );
        }
    }

    // ==============================================================
    //  TICKET MENTIONS  ("ticket BNW-TIX007" — clickable)
    //
    //  Superadmin and HR point each other at a ticket by typing the word
    //  "ticket" followed by the reference. Either side can click it and the
    //  ticket's modal opens, exactly as if they had clicked the row on their
    //  own dashboard.
    //
    //  ⚠️ WHY THE REFERENCE LIVES IN THE MESSAGE TEXT AND NOT IN A FIELD.
    //  It could have been a `ticketRefs: [...]` array on the message doc, but
    //  the messages rule deliberately has NO `hasOnly()` allowlist
    //  (firestore.rules, `match /messages`) — unlike rooms, reactions and
    //  receipts, which each pin an exact key list. So a new field would be
    //  permitted... but sendMessage() is written defensively against DEPLOYED
    //  rules that may be OLDER than this client, and it already falls back to
    //  a reduced payload when a write is refused. Keeping the reference
    //  inside `text` means:
    //    * no schema change, and nothing to deploy,
    //    * a message sent BEFORE this feature existed still renders a working
    //      link, because the words are already in the text,
    //    * no new field can trip an old hasOnly() and silently stop saving.
    //  The chip is therefore built at RENDER time only — nothing about a
    //  ticket reference is ever persisted.
    // ==============================================================

    // How many recent tickets the "ticket " picker offers. Deliberately one
    // cached read of the most recent slice: this answers "what was that
    // ticket?", it is not a searchable archive, and a live listener here would
    // be a read nobody asked for.
    var TICKET_PICKER_LIMIT = 50;

    // Which ticket row the picker has highlighted. Declared with the other
    // picker state (NOT after the functions that read it) so the shared
    // keydown handler and the render helpers clearly share one variable.
    var ticketIndexSelection = 0;

    // ---- Shared picker state ---------------------------------------------
    //
    // THREE pickers share the one #chatMentionMenu element — people ("@name"),
    // tickets and violations — and only one is ever open at a time.
    //
    // `pickerMode` says which. It is set explicitly by whichever update*Menu()
    // rendered, and cleared by closeMentionMenu(), so the keydown handler never
    // has to infer the mode from a side effect.
    //
    // ⚠️ THIS REPLACES A HEURISTIC THAT A THIRD PICKER BROKE. The handler used
    // to ask `mentionMatches.length === 0`, reasoning that the people picker
    // was the only one leaving that array populated (the ticket picker closed
    // the menu rather than opening it empty). That was already inferring state
    // from a side effect, and with tickets AND violations both on screen it is
    // simply wrong: both leave `mentionMatches` empty, so Enter/Tab/arrows
    // would drive whichever row set was showing through the wrong apply
    // function — pressing Enter on a violation row could apply a ticket id.
    var PICKER_PEOPLE = 'people';
    var PICKER_TICKET = 'ticket';
    var PICKER_VIOLATION = 'violation';
    var pickerMode = null;

    /**
     * True when a ref match is a REAL reference and not a word that merely
     * starts with the keyword.
     *
     * ⚠️ BOTH SIDES MATTER, and this exists because the naive version was wrong
     * in a way that is easy to miss:
     *
     *   - "@ticketmaster2" matches the pattern, and the token "master2"
     *     contains a digit, so the "must have a digit or a separator" rule
     *     passes it. Without the TRAILING check it renders as a chip.
     *   - "a@ticket.com" matches, because "@" is a legal capture. The LEADING
     *     check rejects it: the "@" must not follow a word character.
     *
     * ⚠️ THE TRAILING CHECK IS NOT A REGEX LOOKAHEAD. Encoding it as `(?!\w)`
     * was tried and BROKE trailing punctuation: on "violation vio-0007!" the
     * lookahead consumed the "!" and the reference stopped linking, which is
     * worse than the bug it fixed. So the character after the match is
     * inspected here in JS, where it can be examined without being consumed.
     *
     * @param {string} full   the whole match
     * @param {string} at     the captured leading "@" ("" when absent)
     * @param {string} token  the captured reference token
     * @param {string} body   the string being scanned, for the leading check
     * @param {number} atIndex index of the "@" within `body`
     */
    function isRealRefMatch(full, at, token, body, atIndex) {
        // The "@" must not be preceded by a word character, so an address
        // like "a@ticket.com" is never a reference.
        if (at && atIndex > 0 && /[\w]/.test(body.charAt(atIndex - 1))) return false;
        // The token must END here. Without this, "@ticketmaster2" links.
        var end = atIndex + full.length;
        if (end < body.length && /[\w]/.test(body.charAt(end))) return false;
        return true;
    }

    // A ticket reference. Ticket numbers look like "BNW-TIX007" and their
    // document ids are the same token lowercased ("bnw-tix007") — which is
    // why the resolver can try the id directly before scanning anything.
    //
    // ⚠️ THE LEADING "@" IS CAPTURED (group 1) SO THE CHIP SWALLOWS IT.
    // "@ticket BNW-TIX007" is the form the composer now inserts, and if the
    // "@" were not part of the match it would be left sitting in the message
    // as a dangling character in front of every chip. Capturing it means the
    // button is built over the WHOLE match, so the text reads as one chip.
    //
    // The bare form still matches (@ optional), which is what keeps every
    // message sent before this feature clickable.
    //
    // Built by a factory so every use gets FRESH lastIndex state; a shared
    // /g regex would carry `lastIndex` between calls and silently skip
    // matches.
    function ticketRefPattern(flags) {
        return new RegExp(
            // ⚠️ A SEPARATOR IS REQUIRED between the keyword and the token:
            // `(?:\s*[:#]\s*|\s+)`, never `\s*[:#]?\s*` (which allows ZERO
            // characters). With the old permissive form, "@ticketmaster2"
            // matched as keyword "ticket" + token "master2" — and "master2"
            // contains a digit, so it sailed through the digit/separator rule
            // and rendered as a chip. Requiring whitespace (or a colon/hash)
            // is what makes the keyword a whole WORD rather than a prefix.
            '(@?)\\b(?:tickets?)(?:\\s*[:#]\\s*|\\s+)([A-Za-z0-9][A-Za-z0-9_-]{2,40})',
            flags || 'gi'
        );
    }

    /** True when this token looks like a ticket reference we should link. */
    function isTicketRefToken(token) {
        var t = String(token || '');
        // Must contain a digit OR a separator, so an ordinary word that
        // happens to follow the word "ticket" is never linked. Real
        // references always look like PREFIX-tixNNN.
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,40}$/.test(t)) return false;
        return /[0-9]/.test(t) || /[-_]/.test(t);
    }

    /** Every ticket reference in a message, in order, de-duplicated. */
    function extractTicketRefs(text) {
        var body = String(text || '');
        if (!body) return [];
        var out = [];
        var re = ticketRefPattern('gi');
        var match;
        while ((match = re.exec(body)) !== null) {
            // Group 1 is the optional leading "@", group 2 the token — the "@"
            // is captured so the chip can swallow it, which shifts the token.
            // ⚠️ atIndex is the MATCH START, used as-is; see the note in
            // linkifyTicketRefs().
            var at = match[1];
            var token = match[2];
            var atIndex = match.index;
            if (!isTicketRefToken(token)) continue;
            if (!isRealRefMatch(match[0], at, token, body, atIndex)) continue;
            var key = token.toLowerCase();
            if (out.indexOf(key) === -1) out.push(key);
        }
        return out;
    }

    // ---- Only RESOLVED tickets may be mentioned ---------------------------
    //
    // ⚠️ THIS MIRRORS A REAL PERMISSION, NOT A DISPLAY PREFERENCE. On the HR
    // dashboard a ticket is only visible once it is Resolved: renderOwnerTickets()
    // force-locks `selectedStatus = 'Resolved'` for the owner, HR and
    // superadmin roles (js/owner-dashboard.js). Mentioning a still-open ticket
    // would hand the other side a chip that opens a modal showing work they are
    // not allowed to see yet — so the rule is enforced HERE, at the point the
    // reference is offered and resolved, rather than relying on the recipient
    // hitting a wall.
    //
    // The stored value is the exact string 'Resolved' (script.js writes
    // `status: 'Resolved'` on resolve), compared case-insensitively so a
    // hand-edited doc cannot slip past.
    function isMentionableTicket(t) {
        if (!t) return false;
        return String(t.status || '').trim().toLowerCase() === 'resolved';
    }

    // ---- Ticket index (lazy, cached) -------------------------------------
    //
    // Cached for the life of the page rather than re-read per keystroke: the
    // picker filters this list on every input event, and a Firestore read per
    // character typed would be unusable.

    // ===============================================================
    //  STORE-SCOPED MENTIONS (spec: the Store Group Chat determines the
    //  scope, and the RM/SM dashboard access determines which tickets
    //  and violations may be mentioned within it)
    //
    //  Inside chats/branch-<slug>, the @ticket / @violation pickers AND
    //  their resolvers offer only items whose branch/store matches the
    //  room's branch — a broader dashboard (Area Manager, HR, superadmin)
    //  must NEVER widen the mention list inside a store room. Outside a
    //  branch room (1:1 DMs, the All-HR group) there is no store scope,
    //  so the existing behaviour is unchanged.
    //
    //  Every outer reference is typeof-guarded: the picker block is also
    //  executed by test/chat-ticket-mentions.test.js in a vm sandbox
    //  where the room state does not exist, and a ReferenceError there
    //  would fail the suite for a reason unrelated to the feature.
    // ===============================================================
    function activeRoomBranch() {
        var roomId = (typeof activeRoomId !== 'undefined') ? activeRoomId : '';
        if (!roomId) return '';
        if (!(typeof isBranchRoom === 'function' && isBranchRoom(roomId))) return '';
        var summary = (typeof conversationSummaries !== 'undefined' && conversationSummaries)
            ? conversationSummaries[roomId] : null;
        // The room document's `title` is the bare branch name ("SM Fairview");
        // the id slug is the fallback before the summary arrives.
        if (summary && summary.title) return String(summary.title).trim().toLowerCase();
        return roomId.slice('branch-'.length).replace(/-/g, ' ').trim().toLowerCase();
    }

    /**
     * True when `item` may be offered as a mention in the CURRENT room.
     * Tickets carry `branch`/`branchName`, violations carry `store` — the
     * comparison is trim + case-insensitive, like every other branch check
     * in the app.
     */
    function inActiveRoomScope(item) {
        var branch = activeRoomBranch();
        if (!branch) return true;              // not a store room — no scope
        if (!item) return false;
        var own = String(item.branchName || item.branch || item.store || '').trim().toLowerCase();
        return !!own && own === branch;
    }

    var ticketIndex = null;          // null = never loaded
    var ticketIndexLoading = false;
    var ticketIndexByNumber = {};    // lowercased ticketNumber -> doc id
    var ticketIndexById = {};        // lowercased doc id -> ticket

    function indexTicket(t) {
        if (!t || !t.id) return;
        // The INDEX is the mentionable set, so an unresolved ticket is never
        // cached at all — that keeps both the picker and the resolver's fast
        // path honest without a second filter.
        if (!isMentionableTicket(t)) return;
        var id = String(t.id);
        var number = String(t.ticketNumber || '').toLowerCase();
        ticketIndexById[id.toLowerCase()] = t;
        // The FIRST doc wins for a number: ids are unique, and a duplicated
        // ticketNumber (which should not happen) must still resolve the same
        // way on every click.
        if (number && !ticketIndexByNumber[number]) ticketIndexByNumber[number] = id;
    }

    /**
     * Load the recent tickets the picker offers and the resolver matches
     * against. Idempotent: a call made while one is in flight reuses it.
     */
    function ensureTicketIndex() {
        if (ticketIndex) return Promise.resolve(ticketIndex);
        if (ticketIndexLoading) return Promise.resolve([]);
        if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') {
            return Promise.resolve([]);
        }
        ticketIndexLoading = true;
        return db.collection('tickets')
            .get()
            .then(function (snapshot) {
                var out = [];
                snapshot.forEach(function (doc) {
                    var t = Object.assign({ id: doc.id }, doc.data() || {});
                    // Only Resolved tickets are mentionable, so an unresolved one
                    // is dropped HERE — before the cap. Filtering after the slice
                    // would mean a burst of open tickets could push every Resolved
                    // ticket out of the picker's 50, leaving it mysteriously empty
                    // on a busy day.
                    if (!isMentionableTicket(t)) return;
                    out.push(t);
                });
                // Newest first — the picker shows the most recent N, and
                // "most recent" is what people mean by "that ticket we were
                // just talking about".
                out.sort(function (a, b) {
                    var at = ticketTimestamp(a);
                    var bt = ticketTimestamp(b);
                    if (bt !== at) return bt - at;
                    return String(a.id).localeCompare(String(b.id));
                });
                var recent = out.slice(0, TICKET_PICKER_LIMIT);
                recent.forEach(indexTicket);
                ticketIndex = recent;
                ticketIndexLoading = false;
                return recent;
            })
            .catch(function (error) {
                // A failed read must never break chat: the picker simply
                // stays empty, and a hand-typed reference still gets the direct
                // document read in resolveTicketRef().
                ticketIndexLoading = false;
                console.warn('[Chat] ticket index unavailable:', error);
                return [];
            });
    }

    /** Best-effort sort key for a ticket, tolerating every stored shape. */
    function ticketTimestamp(t) {
        var raw = (t && (t.createdAt || t.submittedAt || t.reportDateTime)) || null;
        var d = toDate(raw);
        return d ? d.getTime() : 0;
    }

    /** Picker search text, so "fame" or "bnw" both find a ticket. */
    function ticketSearchText(t) {
        return [
            t.ticketNumber, t.id, t.branch, t.branchName, t.title,
            t.subject, t.incident, t.name, t.reporter
        ].filter(Boolean).join(' ').toLowerCase();
    }

    /** Picker options for the current "ticket " query. */
    function ticketCandidates(query) {
        // Store scope first (spec): inside a branch room the picker may only
        // offer THIS store's tickets, whoever is typing.
        var list = (ticketIndex || []).filter(inActiveRoomScope);
        var q = String(query || '').trim().toLowerCase();
        if (!q) return list;
        return list.filter(function (t) {
            return ticketSearchText(t).indexOf(q) !== -1;
        });
    }

    /**
     * Resolve a typed reference to a ticket document.
     *
     * Cheapest and most exact first:
     *   1. already-cached — indexed by doc id, then by ticket number
     *   2. a direct read of `tickets/<lowercased-ref>`, because that IS the
     *      document id for a real ticket
     *   3. one collection read matched on `ticketNumber` — the fallback for a
     *      reference whose casing or prefix does not line up with the id
     *
     * Returns a ticket object or null. Never throws: a reference that cannot
     * be found comes back null and the caller reports that to the user.
     */
    /**
     * True when the last resolveTicketRef() miss was a ticket that EXISTS but
     * is not yet Resolved. Lets the failure toast say "still open" instead of
     * "not found" — the difference between a helpful message and one that
     * looks like a typo.
     */
    var lastRefWasUnresolved = false;

    async function resolveTicketRef(ref) {
        var key = String(ref || '').trim().toLowerCase();
        if (!key) return null;
        lastRefWasUnresolved = false;

        var cached = ticketIndexById[key];
        if (cached) return inActiveRoomScope(cached) ? cached : null;
        var cachedId = ticketIndexByNumber[key];
        if (cachedId && ticketIndexById[cachedId.toLowerCase()]) {
            var cachedHit = ticketIndexById[cachedId.toLowerCase()];
            return inActiveRoomScope(cachedHit) ? cachedHit : null;
        }

        if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') {
            return null;
        }

        // 2. The id itself. A permission error is swallowed rather than
        // propagated: `tickets` is readable by any signed-in user, but a rules
        // change must degrade to "not found" instead of an unhandled rejection.
        try {
            var snap = await db.collection('tickets').doc(key).get();
            if (snap && snap.exists) {
                var found = Object.assign({ id: snap.id }, snap.data() || {});
                // It exists, but it is NOT Resolved yet — treat it as unavailable
                // and remember WHY, so the toast can say "still open" rather than
                // making a valid reference look like a typo.
                if (!isMentionableTicket(found)) {
                    lastRefWasUnresolved = true;
                    return null;
                }
                indexTicket(found);
                // Store scope (spec): a cross-STORE ticket may never become a
                // chip in THIS store's room, whoever is looking at it. Still
                // indexed — another room's picker may legitimately offer it.
                return inActiveRoomScope(found) ? found : null;
            }
        } catch (e) { /* fall through to the scan */ }

        // 3. Match on the stored ticketNumber.
        try {
            var snapshot = await db.collection('tickets').get();
            var match = null;
            var unresolved = false;
            snapshot.forEach(function (doc) {
                if (match) return;
                var data = doc.data() || {};
                var number = String(data.ticketNumber || '').toLowerCase();
                if (!number || number !== key) return;
                var candidate = Object.assign({ id: doc.id }, data);
                // Same rule: a number that matches but is still open is not a
                // mentionable ticket.
                if (!isMentionableTicket(candidate)) { unresolved = true; return; }
                // ...and a number that matches but belongs to ANOTHER store is
                // not mentionable in a store room (spec).
                if (!inActiveRoomScope(candidate)) return;
                match = candidate;
            });
            if (match) {
                indexTicket(match);
            } else if (unresolved) {
                lastRefWasUnresolved = true;
            }
            return match;
        } catch (e) {
            return null;
        }
    }

    // ==============================================================
    //  HANDING THE SCREEN TO THE TICKET MODAL
    //
    //  Both overlays declare z-index 1000 (.modal-overlay in style.css,
    //  .chat-modal-overlay in chat.css), but the chat overlay is created at
    //  runtime and appended to <body>, so it sits AFTER the static #ticketModal
    //  in DOM order. At equal z-index the later element wins, so the ticket
    //  modal used to open BEHIND the chat. Raising a z-index would only treat
    //  the symptom: the real problem is that both are open at once.
    //
    //  So chat is SUSPENDED, not closed. The overlay loses `active` (and gains
    //  .chat-suspended, which hides it and stops it taking clicks) but keeps its
    //  DOM, scroll position, unsent draft, active room and every listener. It is
    //  deliberately NOT closeModal(), which would stamp read state and move
    //  focus to the launcher — losing the user's place in the conversation.
    // ==============================================================

    var chatSuspended = false;      // chat is hidden behind a ticket modal
    var ticketModalWatcher = null;  // the MutationObserver watching that modal

    /**
     * Hide the chat so the ticket modal has the screen to itself. Returns true
     * when it actually suspended something, so the caller only arms the
     * restore when there is something to come back to.
     */
    function suspendChatForTicket() {
        if (chatSuspended) return false;
        if (!els.overlay || !els.overlay.classList.contains('active')) return false;
        chatSuspended = true;
        els.overlay.classList.add('chat-suspended');
        els.overlay.classList.remove('active');
        // Lift the page's own modals above the chat's z-index for the duration,
        // so the modal can never flash behind the chat during the swap.
        if (typeof document !== 'undefined' && document.body) {
            document.body.classList.add('chat-ticket-open');
        }
        return true;
    }

    /** Put the chat back exactly as it was: same room, same draft, same focus. */
    function restoreChatAfterTicket() {
        if (!chatSuspended) return;
        chatSuspended = false;
        if (typeof document !== 'undefined' && document.body) {
            document.body.classList.remove('chat-ticket-open');
        }
        if (!els.overlay) return;
        els.overlay.classList.remove('chat-suspended');
        els.overlay.classList.add('active');
        // Focus the composer, matching openModal() — but DESKTOP only, so a
        // phone does not pop the keyboard and jump to the input on return from
        // a ticket modal. Deliberately NOT a markThreadRead() call: the user is
        // returning to the thread they were already in, and re-stamping would
        // swallow a receipt write they did not just perform. `typeof` guard:
        // safe in the isolated sandboxes that run this function standalone.
        if (els.input && !els.input.disabled) {
            if (typeof canHover !== 'function' || canHover()) els.input.focus();
            scrollLogToBottom();
        } else if (els.listSearch) {
            if (typeof canHover !== 'function' || canHover()) els.listSearch.focus();
        }
    }

    /**
     * Restore the chat whenever this page's ticket/report modal closes.
     *
     * A MutationObserver rather than a hook on the close button, because the
     * two pages close the modal by DIFFERENT paths: main.html closes on the X
     * button alone, while ownerdashboard.html also closes on a backdrop click
     * and has its own closeOwnerReportModalFn(). Observing the `active` class
     * covers every path - X, backdrop, window.closeTicketModals() - without
     * editing script.js or owner-dashboard.js, so neither page can drift.
     */
    function watchTicketModalClose(modalEl) {
        if (!modalEl || typeof MutationObserver === 'undefined') return;
        if (ticketModalWatcher) {
            try { ticketModalWatcher.disconnect(); } catch (e) { /* ignore */ }
            ticketModalWatcher = null;
        }
        try {
            ticketModalWatcher = new MutationObserver(function () {
                // Fires on ANY attribute change, so re-check rather than assume.
                if (modalEl.classList.contains('active')) return;
                if (ticketModalWatcher) {
                    try { ticketModalWatcher.disconnect(); } catch (e) { /* ignore */ }
                    ticketModalWatcher = null;
                }
                restoreChatAfterTicket();
            });
            ticketModalWatcher.observe(modalEl, { attributes: true, attributeFilter: ['class'] });
        } catch (e) {
            // No observer available (an old host, or a test sandbox): the modal
            // still opens, it just will not bring the chat back automatically.
            ticketModalWatcher = null;
        }
    }

    /**
     * Open a ticket in whichever modal THIS page already has.
     *
     * The command center exposes `openTicketModal` (script.js); the HR
     * dashboard exposes `openOwnerReport` (js/owner-dashboard.js). Calling
     * whichever exists means the ticket appears exactly as it does when opened
     * from that page's own table - same fields, same attachments, no second
     * modal to build or keep in sync, and no new read access to invent: the
     * `tickets` read rule already admits any signed-in user.
     *
     * The chat is suspended first and the modal's close restores it, so the
     * ticket REPLACES the chat instead of appearing behind it. Pressing X on
     * the modal lands the user back in the same thread, with their draft.
     */
    function openTicketFromChat(ticket) {
        if (!ticket || !ticket.id) return false;
        var id = String(ticket.id);
        // Find the modal this page owns BEFORE suspending, so a page that has
        // no modal at all never leaves the chat hidden with nothing to restore.
        var opener = null;
        var modalEl = null;
        var doc = (typeof document !== 'undefined') ? document : null;
        if (typeof window.openTicketModal === 'function') {
            opener = window.openTicketModal;
            modalEl = doc ? doc.getElementById('ticketModal') : null;
        } else if (typeof window.openOwnerReport === 'function') {
            opener = window.openOwnerReport;
            modalEl = doc ? doc.getElementById('ownerReportModal') : null;
        }
        if (!opener) return false;

        var suspended = suspendChatForTicket();
        try {
            opener(id);
        } catch (e) {
            // The modal failed to open, so chat must NOT stay hidden behind
            // nothing - that would strand the user on a blank screen.
            if (suspended) restoreChatAfterTicket();
            return false;
        }

        // ⚠️ DO NOT DECIDE INSTANTLY WHETHER THE MODAL OPENED.
        //
        // The two pages open the SAME ticket by DIFFERENT means:
        //   - script.js  openTicketModal()  finds the ticket in the in-memory
        //     `allTickets` array and adds `active` SYNCHRONOUSLY.
        //   - owner-dashboard.js openOwnerReport() first re-reads the ticket
        //     from Firestore (db.collection('tickets').doc(id).get().then(...))
        //     and only adds `active` ASYNCHRONOUSLY.
        //
        // An earlier version checked `classList.contains('active')` on the very
        // next line. On the command center that was true, but on the HR
        // dashboard the read had not resolved yet, so the check said "never
        // opened" and immediately restored the chat — and a moment later the
        // report modal appeared on top of a VISIBLE chat, which is exactly the
        // bug that made the HR side look unfixed. So the open is now WAITED
        // for, briefly, rather than assumed.
        if (suspended) {
            waitForTicketModalOpen(modalEl);
        }
        return true;
    }

    // How long to keep waiting for an async opener to show the modal, and how
    // often to look. ~1.2s in total: comfortably longer than a Firestore
    // document read on a poor connection, but short enough that a ticket which
    // genuinely will not open does not feel like a hang.
    var TICKET_MODAL_OPEN_TIMEOUT_MS = 1200;
    var TICKET_MODAL_OPEN_POLL_MS = 60;

    /**
     * Wait (briefly) for the page's ticket/report modal to become active.
     *
     * Once it is up, watch it so closing it returns the user to the chat. If it
     * never appears — a deleted ticket, a denied read — the chat is restored
     * immediately, so a click can never leave the user staring at a hidden
     * chat with nothing on screen.
     */
    function waitForTicketModalOpen(modalEl) {
        var waited = 0;
        // No element to watch: this page has no such modal, so nothing will
        // ever restore the chat. Put it back now.
        if (!modalEl) {
            restoreChatAfterTicket();
            return;
        }
        if (modalEl.classList.contains('active')) {
            watchTicketModalClose(modalEl);
            return;
        }
        var timer = setInterval(function () {
            waited += TICKET_MODAL_OPEN_POLL_MS;
            if (modalEl.classList.contains('active')) {
                clearInterval(timer);
                watchTicketModalClose(modalEl);
                return;
            }
            if (waited >= TICKET_MODAL_OPEN_TIMEOUT_MS) {
                clearInterval(timer);
                // The modal never opened, so the chat must not stay hidden.
                restoreChatAfterTicket();
            }
        }, TICKET_MODAL_OPEN_POLL_MS);
    }

async function openTicketFromRef(ref) {
        var ticket = await resolveTicketRef(ref);
        var label = String(ref || '').toUpperCase();
        if (!ticket) {
            // Two very different reasons produce null, and the user needs to be
            // told which: a typo, versus a real ticket that exists but is not
            // Resolved yet (which they CAN mention once it is).
            showToast(
                lastRefWasUnresolved
                    ? 'Ticket ' + label + ' is not resolved yet — it can be mentioned once it is.'
                    : 'Ticket "' + label + '" was not found.',
                lastRefWasUnresolved ? 'info' : 'error'
            );
            return false;
        }
        if (!openTicketFromChat(ticket)) {
            showToast('This page cannot open ticket details.', 'error');
            return false;
        }
        return true;
    }

    /**
     * Replace "ticket XYZ" tokens with a clickable chip.
     *
     * ⚠️ ESCAPE FIRST, exactly like the @mention path. renderMessageBody()
     * has already escaped the entire message, so this can only ever wrap
     * already-escaped text in a <button> built from escaped parts — a ticket
     * reference can never inject markup, and the id travels in an escaped
     * data attribute rather than inline JS.
     */
    function linkifyTicketRefs(escapedBody) {
        return String(escapedBody || '').replace(
            ticketRefPattern('gi'),
            function (whole, at, token, offset) {
                if (!isTicketRefToken(token)) return whole;
                // ⚠️ `offset` is the MATCH START (i.e. the "@" when present)
                // and must be used as-is. Advancing it by at.length points the
                // guard past the "@", where the leading check reads the "t" of
                // "ticket" and rejects the reference outright.
                if (!isRealRefMatch(whole, at, token, escapedBody, offset)) return whole;
                var id = escapeHTML(token.toLowerCase());
                var label = escapeHTML(token.toUpperCase());
                return '<button type="button" class="chat-ticket-chip" ' +
                    'data-ticket-ref="' + id + '" ' +
                    'title="Open ticket ' + label + '">' +
                    '<i class="fas fa-ticket-alt" aria-hidden="true"></i>' +
                    '<span>' + label + '</span></button>';
            }
        );
    }

    // NOTE: the bare-word "ticket " trigger (activeTicketQuery) was REMOVED.
    // It fired on the keyword plus a space anywhere in the message, so prose
    // like "that ticket looks wrong" opened the picker mid-sentence. The "@"
    // form is now the only trigger — see activeTicketRefDescriptor().
    //
    // Its history is kept here because it is a real bug, not a style note: that
    // function once ended with
    //     ensureTicketIndex().then(function () {
    //         if (activeTicketQuery() && ...) updateTicketMenu();   // ← recursion
    //     });
    // which froze the whole page the instant the index resolved. The callback
    // re-entered the query function, which attached ANOTHER .then(), whose
    // callback called itself again — an unbounded microtask loop. Every
    // descriptor function in this file must stay PURE for that reason: no
    // read, no promise callback, nothing that can re-enter them.

    /**
     * The ONE place the ticket index is loaded, and the only place a render is
     * deferred until it arrives.
     *
     * The first "ticket " press usually happens before the read completes, so
     * the picker would not appear until the NEXT keystroke. This starts the load
     * and re-renders once it lands — but only if the token is still being typed,
     * the menu is still dismissed, and the chat is still open, so a picker the
     * user already closed (blur, Escape, a second word) is never resurrected.
     *
     * Deliberately called from the input handler ONLY. The descriptor functions
     * must stay pure, or the callback below would recurse through them.
     */
    /**
     * The active TICKET descriptor, from the "@ticket" trigger.
     *
     * ⚠️ THIS IS NOW THE ONLY WAY THE TICKET PICKER OPENS. It used to fall
     * back to the bare word "ticket " as well, but that form fires on the
     * keyword plus a space ANYWHERE in the message — so ordinary prose like
     * "that ticket looks wrong" or "closing this ticket now" popped the picker
     * open mid-sentence. Requiring the "@" makes it an unambiguous, deliberate
     * request, and it matches the convention people already expect from the
     * "@" people picker sitting in the same box.
     *
     * (The BARE form still LINKIFIES in sent messages — see
     * linkifyTicketRefs() — so every message written before this change keeps
     * its working chip. Only the AUTOCOMPLETE is gated behind the "@".)
     *
     * Kept as its own function rather than inlined, because the ticket picker's
     * render paths call it on every keystroke and it must stay PURE.
     */
    function activeTicketRefDescriptor() {
        var at = activeAtRefQuery();
        if (at && at.kind === PICKER_TICKET) return at;
        return null;
    }

    function syncTicketPicker() {
        ensureTicketIndex().then(function () {
            if (!els.mentionMenu) return;
            if (els.overlay && !els.overlay.classList.contains('active')) return;
            if (!els.mentionMenu.hidden) return;   // already open, or a person list
            if (!activeTicketRefDescriptor()) return;   // the token moved or went away
            updateTicketMenu();
        });
    }

    /**
     * One row of the ticket picker. Shared by the initial render and by the
     * arrow-key move, so the two can never render a row differently.
     */
    function ticketPickerRow(t, isActive) {
        var number = String(t.ticketNumber || t.id || '').toUpperCase();
        var detail = [t.branch || t.branchName, t.title || t.incident || t.subject]
            .filter(Boolean).join(' · ');
        return '<div class="chat-mention-option' + (isActive ? ' is-active' : '') + '"' +
            ' role="option" aria-selected="' + (isActive ? 'true' : 'false') + '"' +
            ' data-ticket-pick="' + escapeHTML(String(t.id || '')) + '">' +
            '<span class="chat-mention-at">🎫</span>' + escapeHTML(number) +
            (detail ? '<span class="chat-mention-detail">' + escapeHTML(detail) + '</span>' : '') +
            '</div>';
    }

    /** The rows currently offered, re-derived from the live query. */
    function currentTicketPickerMatches() {
        var active = activeTicketRefDescriptor();
        if (!active) return [];
        return ticketCandidates(active.query).slice(0, TICKET_PICKER_LIMIT);
    }

    /**
     * Render the ticket picker for the current "ticket " query, or close it.
     * Shares #chatMentionMenu with the @ picker — only one is ever open.
     */
    function updateTicketMenu() {
        if (!els.mentionMenu) return;
        var active = activeTicketRefDescriptor();
        if (!active) return;   // never CLOSE here: the @ picker owns that

        var matches = currentTicketPickerMatches();
        if (matches.length === 0) { closeMentionMenu(); return; }

        if (ticketIndexSelection >= matches.length) ticketIndexSelection = 0;
        els.mentionMenu.innerHTML = matches.map(function (t, i) {
            return ticketPickerRow(t, i === ticketIndexSelection);
        }).join('');
        els.mentionMenu.hidden = false;
        pickerMode = PICKER_TICKET;
        // The @ keyboard handlers read this shared state; an empty list used to
        // be how they were told the open menu is a TICKET list rather than a
        // people one. `pickerMode` now says that directly, so this is no longer
        // a signal to anyone — kept clear so the two mechanisms cannot be
        // mistaken for each other later.
        mentionMatches = [];
    }

    /**
     * Move the highlighted row. Re-renders the whole menu through
     * updateTicketMenu() so the markup comes from ticketPickerRow() exactly
     * once — the arrow keys and the first paint cannot drift apart.
     */
    function moveTicketPickerSelection(delta) {
        var matches = currentTicketPickerMatches();
        var n = matches.length;
        if (!n) return;
        ticketIndexSelection = (ticketIndexSelection + delta + n) % n;
        updateTicketMenu();
    }

    /** Insert the picked ticket, replacing the "ticket " token. */
    function applyTicketPick(ticketId) {
        if (!ticketId || !els.input) return;
        var active = activeTicketRefDescriptor();
        if (!active) return;
        var t = (ticketIndex || []).filter(function (x) { return String(x.id) === String(ticketId); })[0];
        var number = String((t && (t.ticketNumber || t.id)) || ticketId).toUpperCase();
        var value = String(els.input.value || '');
        // Replace the whole trigger token, so the inserted text is just the
        // reference. The linkifier matches "@ticket XYZ", so we keep the
        // keyword AND the "@" — that is what makes the chip render, and the
        // chip swallows the "@" so no stray character is left behind.
        var insertion = '@ticket ' + number + ' ';
        els.input.value = value.slice(0, active.start) + insertion + value.slice(active.end);
        var caret = active.start + insertion.length;
        try { els.input.setSelectionRange(caret, caret); } catch (e) { /* older browsers */ }
        closeMentionMenu();
        syncDraftPresence();
        els.input.focus();
    }

    // ==============================================================
    //  VIOLATION MENTIONS  ("violation VIO-0007" — clickable)
    //
    //  The mirror of the ticket feature above: a superadmin hands HR a
    //  specific CCTV report by reference, or hands one to the AREA
    //  MANAGER (`managerStatus`) for the store chat — and either side
    //  can click it to open that report's modal on their own page.
    //
    //  ⚠️ WHY A COPY OF THE TICKET CODE IS NOT A DROP-IN REPLACEMENT.
    //  Tickets are readable by any signed-in user, so the index is one
    //  unfiltered read. Violations are NOT (firestore.rules,
    //  `match /violations`):
    //      allow read: if isOperatorOrSuperAdmin()
    //                   || (isHr() && isTransferredToHr())
    //                   || (isOwner() && isTransferredToAreaManager());
    //  An UNFILTERED query is therefore DENIED for HR by design — the
    //  privacy guarantee, not a bug (see README-interface.md). So:
    //
    //    1. Every read here is filtered on a transfer flag: `hrStatus`
    //       for HR/superadmin (isTransferredToHr), `managerStatus` for
    //       the Area Manager (isTransferredToAreaManager). The query
    //       shape must be one the rules can PROVE for the role doing
    //       the clicking, or Firestore refuses it before it runs — see
    //       resolveViolationRef().
    //    2. There is no direct-document read in the resolver. Ticket doc ids
    //       ARE the lowercased ticket number, which is what makes
    //       resolveTicketRef() step 2 possible; violations are created with
    //       `.add()` (firebase.js addViolation) so their ids are Firestore
    //       auto-ids and the number lives in a separate `violationNumber`
    //       field. The resolver must match on that field instead.
    // ==============================================================

    // How many recent reports the picker offers. Same reasoning and same value
    // as the ticket picker: this answers "that report we were just talking
    // about", it is not a searchable archive.
    var VIOLATION_PICKER_LIMIT = 50;

    // Which violation row the picker has highlighted. Declared with the other
    // picker state (see the shared picker block above) so the keydown handler
    // and the render helpers plainly share one variable.
    var violationIndexSelection = 0;

    /**
     * A violation reference. Report numbers look like "VIO-0007".
     *
     * The leading "@" is OPTIONAL and matched separately, so "@violation
     * VIO-0007" and "violation VIO-0007" are the same reference. That is what
     * lets "@violation" work as a picker trigger without the inserted text
     * ever carrying an "@" (see applyViolationPick for why it must not).
     *
     * Built by a factory for the same reason as ticketRefPattern(): a shared
     * /g regex would carry `lastIndex` between calls and skip matches.
     */
    function violationRefPattern(flags) {
        return new RegExp(
            // A separator is REQUIRED here too — see the note on
            // ticketRefPattern(). Without it "@violationmaster" matched as
            // "violation" + "master", and "violationmaster2" as + "master2".
            '(@?)\\b(?:violations?)(?:\\s*[:#]\\s*|\\s+)([A-Za-z0-9][A-Za-z0-9_-]{2,40})',
            flags || 'gi'
        );
    }

    /** True when this token looks like a violation reference we should link. */
    function isViolationRefToken(token) {
        var t = String(token || '');
        // Same shape rule as a ticket number. "violation" is a common English
        // word, so the guard matters MORE here than for tickets: "violation of
        // policy" and "a serious violation was found" must stay plain text.
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,40}$/.test(t)) return false;
        return /[0-9]/.test(t) || /[-_]/.test(t);
    }

    /** Every violation reference in a message, in order, de-duplicated. */
    function extractViolationRefs(text) {
        var body = String(text || '');
        if (!body) return [];
        var out = [];
        var re = violationRefPattern('gi');
        var match;
        while ((match = re.exec(body)) !== null) {
            // Group 1 is the optional leading "@", group 2 the token — the "@"
            // is captured so the chip can swallow it, which shifts the token.
            // ⚠️ atIndex is the MATCH START, used as-is; see the note in
            // linkifyTicketRefs().
            var at = match[1];
            var token = match[2];
            var atIndex = match.index;
            if (!isViolationRefToken(token)) continue;
            if (!isRealRefMatch(match[0], at, token, body, atIndex)) continue;
            var key = token.toLowerCase();
            if (out.indexOf(key) === -1) out.push(key);
        }
        return out;
    }

    /**
     * ⚠️ THIS MIRRORS A REAL PERMISSION, NOT A DISPLAY PREFERENCE.
     *
     * HR can only read a report once a superadmin has transferred it
     * (`hrStatus: 'transferred'`, set by the "Transfer to HR" button in
     * script.js; js/hr-violations.js listens with exactly this filter). A
     * superadmin mentioning a report they have NOT transferred would hand HR
     * a chip that resolves to nothing they are allowed to see — so the rule is
     * enforced HERE, where the reference is offered and resolved, rather than
     * leaving the recipient to hit a wall.
     *
     * The consequence, stated plainly: a superadmin can only link reports they
     * have already handed over. That is the point of the feature — the chip is
     * a way of saying "look at THIS one", and it is useless if the other side
     * cannot open it.
     *
     * Reports filed before the transfer feature existed have no `hrStatus`
     * field at all, so they simply do not match — the same way the rules treat
     * them.
     */
    function isMentionableViolation(v) {
        if (!v) return false;
        // ⚠️ ROLE FIRST, AND THE STATUS FIELD DEPENDS ON THE ROLE — because the
        // two handoffs are independent (firestore.rules: `hrStatus` gates HR,
        // `managerStatus` gates the Area Manager, and neither helper reads the
        // other's flag):
        //
        //   hr / superadmin -> hrStatus == 'transferred'. The picker AND the
        //                      resolver for both, exactly as before.
        //   owner (mgr)     -> managerStatus == 'transferred' — a report a
        //                      superadmin handed to THEM, i.e. one that is on
        //                      their own Violations tab. They never get the
        //                      picker (still canMentionViolations()), but a
        //                      chip referencing a report transferred to them
        //                      must resolve when they CLICK it: that click is
        //                      the store-chat handoff.
        //   rmsm            -> managerStatus == 'transferred', IDENTICAL to the
        //                      Area Manager. RM/SM has no tab and no picker, so
        //                      a chip is the ONLY way they ever reach a report;
        //                      they read the same transferred-to-the-store set,
        //                      and firestore.rules admits them via isRmsm().
        //   anything else   -> false. an operator has no chat, and rules refuse
        //                      them the read outright.
        //
        // Defence in depth, as before: the picker, the index and the linkifier
        // are each gated separately, because the linkifier in particular runs
        // with no permission check of its own.
        var role = normalizeRole(currentRole);
        if (role === 'owner' || role === 'rmsm') {
            return String(v.managerStatus || '').trim().toLowerCase() === 'transferred';
        }
        if (VIOLATION_MENTION_ROLES.indexOf(role) === -1) return false;
        return String(v.hrStatus || '').trim().toLowerCase() === 'transferred';
    }

    // ---- Violation index (lazy, cached) ----------------------------------
    //
    // Cached for the life of the page for the same reason as the ticket index:
    // the picker filters this list on every input event, and a read per typed
    // character would be unusable.

    var violationIndex = null;        // null = never loaded
    var violationIndexLoading = false;
    var violationIndexByNumber = {};  // lowercased violationNumber -> doc id
    var violationIndexById = {};      // lowercased doc id -> violation

    // ⚠️ "THE READ HAS RESOLVED" IS A SEPARATE FACT FROM `violationIndex`
    // BEING null, and the empty state depends on the difference.
    //
    // On the very first keystroke the read has not come back yet, so
    // violationCandidates() legitimately yields nothing. That is "still
    // loading", NOT "there is nothing to show". Rendering the empty state in
    // that window would set the menu visible — and syncViolationPicker() bails
    // out on `if (!els.mentionMenu.hidden) return;` — so the real list would
    // never be drawn even after the read landed. The picker would be stuck on
    // "no reports" for the whole session, which is a worse bug than the silent
    // close it replaces.
    var violationIndexLoaded = false;   // the read resolved, one way or another
    var violationIndexFailed = false;   // …and it resolved to an error

    function indexViolation(v) {
        if (!v || !v.id) return;
        // The INDEX is the mentionable set, so an untransferred report is never
        // cached at all — that keeps both the picker and the resolver honest
        // without a second filter.
        if (!isMentionableViolation(v)) return;
        var id = String(v.id);
        var number = String(v.violationNumber || '').toLowerCase();
        violationIndexById[id.toLowerCase()] = v;
        // The FIRST doc wins for a number, so a duplicated violationNumber
        // (which should not happen) still resolves identically every time.
        if (number && !violationIndexByNumber[number]) violationIndexByNumber[number] = id;
    }

    /**
     * The one place the violation index is read, and the one query shape both
     * roles may run.
     *
     * ⚠️ THE `where()` IS REQUIRED, NOT AN OPTIMISATION. Because the rules
     * inspect `resource.data`, Firestore will only run a query it can prove.
     * An unfiltered `violations` read is DENIED for an HR user by design. This
     * single equality filter needs no composite index, so it works on the free
     * plan.
     *
     * A superadmin could read everything, but querying the same transferred
     * set on purpose is what keeps one code path for both roles — and it means
     * the picker can never offer a chip the recipient cannot open.
     */
    function ensureViolationIndex() {
        if (!canMentionViolations()) {
            // ⚠️ The LAST line of defence, and deliberately the first statement:
            // mark the read as resolved-and-empty so every caller that awaits
            // this promise settles instead of hanging, and so nothing anywhere
            // downstream treats "not loaded yet" as "keep trying".
            violationIndexLoaded = true;
            return Promise.resolve([]);
        }
        if (violationIndex) return Promise.resolve(violationIndex);
        if (violationIndexLoading) return Promise.resolve([]);
        if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') {
            // No Firestore at all: the read will never succeed, so record that
            // it is finished rather than leaving the picker waiting forever.
            violationIndexLoaded = true;
            violationIndexFailed = true;
            return Promise.resolve([]);
        }
        violationIndexLoading = true;
        return db.collection('violations')
            .where('hrStatus', '==', 'transferred')
            .get()
            .then(function (snapshot) {
                var out = [];
                snapshot.forEach(function (doc) {
                    var v = Object.assign({ id: doc.id }, doc.data() || {});
                    // Belt and braces: the query already filters, but this is
                    // the SAME guard a hand-edited document would hit, and the
                    // whole feature rests on it. Applied before the cap —
                    // filtering after the slice would let a burst of
                    // untransferred reports push every mentionable one out of
                    // the picker, leaving it mysteriously empty.
                    if (!isMentionableViolation(v)) return;
                    out.push(v);
                });
                // Newest first, by transfer time when present: the report the
                // conversation is about is the one just handed over.
                out.sort(function (a, b) {
                    var av = violationTimestamp(a);
                    var bv = violationTimestamp(b);
                    if (bv !== av) return bv - av;
                    return String(a.id).localeCompare(String(b.id));
                });
                var recent = out.slice(0, VIOLATION_PICKER_LIMIT);
                recent.forEach(indexViolation);
                violationIndex = recent;
                violationIndexLoading = false;
                violationIndexLoaded = true;
                violationIndexFailed = false;
                return recent;
            })
            .catch(function (error) {
                // A failed read must never break chat: the picker simply stays
                // empty. A hand-typed reference still gets one more chance in
                // resolveViolationRef(), which reports the real reason.
                violationIndexLoading = false;
                // ⚠️ An empty index is NOT a successful read. The picker offers
                // only TRANSFERRED reports, so a denied or failed read and a
                // genuinely empty collection are different problems with
                // different fixes. Recording the failure lets updateViolationMenu()
                // say "unavailable" instead of the misleading "none transferred".
                violationIndexLoaded = true;
                violationIndexFailed = true;
                console.warn('[Chat] violation index unavailable:', error);
                return [];
            });
    }

    /** Best-effort sort key for a report, tolerating every stored shape. */
    function violationTimestamp(v) {
        var raw = (v && (v.transferredAt || v.createdAt || v.reportDateTime)) || null;
        var d = toDate(raw);
        return d ? d.getTime() : 0;
    }

    /** Picker search text, so "vio", a store or a subject all find a report. */
    function violationSearchText(v) {
        return [
            v.violationNumber, v.id, v.store, v.subject, v.location,
            v.reportedByName, v.reportedBy
        ].filter(Boolean).join(' ').toLowerCase();
    }

    /** Picker options for the current violation query. */
    function violationCandidates(query) {
        // Store scope first (spec): inside a branch room the picker may only
        // offer THIS store's reports, whoever is typing.
        var list = (violationIndex || []).filter(inActiveRoomScope);
        var q = String(query || '').trim().toLowerCase();
        if (!q) return list;
        return list.filter(function (v) {
            return violationSearchText(v).indexOf(q) !== -1;
        });
    }

    /**
     * True when the last resolveViolationRef() miss was a report that EXISTS
     * but has not been transferred to HR. Lets the failure toast say "not
     * transferred yet" rather than "not found" — the difference between a
     * helpful message and one that sends someone hunting a typo that does not
     * exist.
     */
    var lastViolationWasUntransferred = false;

    /**
     * Resolve a typed reference to a violation document.
     *
     * Cheapest and most exact first:
     *   1. the cached index, by document id then by violationNumber — and a
     *      cached hit is RE-CHECKED against isMentionableViolation(), so a
     *      report cached under one role is never handed back under another
     *   2. ONE filtered collection read matched on `violationNumber` — the
     *      fallback for a reference the cache does not hold (an older report
     *      beyond the 50, or a number typed with unusual casing). The filter
     *      field is chosen for the CLICKING role: `managerStatus` for the
     *      Area Manager, `hrStatus` for HR/superadmin (see below)
     *
     * ⚠️ THERE IS NO DIRECT-DOCUMENT READ HERE, and that is not an omission.
     * resolveTicketRef() can read `tickets/<ref>` because a ticket's document
     * id IS its lowercased number. A violation is created with `.add()`, so its
     * id is a Firestore auto-id bearing no relation to "VIO-0007"; trying
     * `violations/vio-0007` would simply never exist. The number is a FIELD,
     * so matching it means a query.
     *
     * Returns a violation object or null. Never throws: a reference that
     * cannot be found comes back null and the caller reports why.
     */
    async function resolveViolationRef(ref) {
        var key = String(ref || '').trim().toLowerCase();
        if (!key) return null;
        lastViolationWasUntransferred = false;

        // ⚠️ A CACHED HIT IS RE-CHECKED, not trusted. The index is filled by
        // whoever ran first, and the role can change without a reload: a
        // report cached under `hrStatus` must not be handed back once the
        // session becomes 'owner', whose readable set is `managerStatus`.
        // The modal would refuse it anyway (OwnerViolations.openModal only has
        // its own list), but the gate belongs here too — one predicate, every
        // path.
        var cached = violationIndexById[key];
        if (cached && isMentionableViolation(cached)) {
            return inActiveRoomScope(cached) ? cached : null;
        }
        var cachedId = violationIndexByNumber[key];
        if (cachedId) {
            var cachedHit = violationIndexById[cachedId.toLowerCase()];
            if (cachedHit && isMentionableViolation(cachedHit)) {
                return inActiveRoomScope(cachedHit) ? cachedHit : null;
            }
        }

        if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') {
            return null;
        }

        // The number does not line up with a cached id, so look it up. An
        // UNFILTERED read is deliberately never attempted here: for HR it is
        // denied by the rules, for an Area Manager likewise, and for a
        // superadmin it would surface reports they are not allowed to hand
        // over in chat anyway.
        //
        // ⚠️ WHICH FIELD IS FILTERED DEPENDS ON WHO IS CLICKING, and it is not
        // cosmetic: Firestore only runs a query it can PROVE against the
        // rules. HR/superadmin use `hrStatus` (isTransferredToHr); the Area
        // Manager AND RM/SM must use `managerStatus` (isTransferredToAreaManager)
        // — an owner/rmsm running the hrStatus shape is REFUSED before it
        // executes, which is exactly why their chip used to die on click.
        try {
            var viewerRole = normalizeRole(currentRole);
            var snapshot = await ((viewerRole === 'owner' || viewerRole === 'rmsm')
                ? db.collection('violations').where('managerStatus', '==', 'transferred')
                : db.collection('violations').where('hrStatus', '==', 'transferred')
            ).get();
            var match = null;
            snapshot.forEach(function (doc) {
                if (match) return;
                var data = doc.data() || {};
                var number = String(data.violationNumber || '').toLowerCase();
                if (!number || number !== key) return;
                var candidate = Object.assign({ id: doc.id }, data);
                // The same rule as everywhere else: a number that matches but
                // is not transferred is not a mentionable report.
                if (!isMentionableViolation(candidate)) return;
                // ...and a report from ANOTHER store may never be mentioned in
                // a store room, whoever is looking at it (spec).
                if (!inActiveRoomScope(candidate)) return;
                match = candidate;
            });
            if (match) {
                indexViolation(match);
                return match;
            }
        } catch (e) {
            // Permission-denied or offline: degrade to "not found" rather than
            // an unhandled rejection inside a click handler.
            return null;
        }

        // Distinguish "no such report" from "exists but not transferred". This
        // needs its own UNFILTERED probe, which only a superadmin may run — so
        // it is attempted last, and a denial simply leaves the flag false
        // ("not found"), which is the safe answer for HR.
        try {
            var all = await db.collection('violations').get();
            all.forEach(function (doc) {
                if (lastViolationWasUntransferred) return;
                var data = doc.data() || {};
                var number = String(data.violationNumber || '').toLowerCase();
                if (number === key && !isMentionableViolation(data)) {
                    lastViolationWasUntransferred = true;
                }
            });
        } catch (e) { /* not permitted for HR — "not found" is correct here */ }
        return null;
    }

    // ==============================================================
    //  HANDING THE SCREEN TO THE VIOLATION MODAL
    //
    //  The suspend/restore machinery above is already generic — it takes the
    //  modal element and watches it — so violations reuse it unchanged. Same
    //  reasoning as tickets: the chat is SUSPENDED, not closed, so the unsent
    //  draft, the active room and the scroll position all survive the round
    //  trip, and closing the report lands the user back in the thread.
    // ==============================================================

    /**
     * Open a report in whichever modal THIS page already has.
     *
     * The command center exposes `openViolationModal` (script.js) and the HR
     * dashboard exposes `HrViolations.openModal` (js/hr-violations.js).
     * Calling whichever exists means the report appears exactly as it does
     * when opened from that page's own table — same fields, same evidence, no
     * second modal to build or keep in sync.
     */
    function openViolationFromChat(violation) {
        if (!violation || !violation.id) return false;
        var id = String(violation.id);
        // Find the modal this page owns BEFORE suspending, so a page with no
        // such modal never leaves the chat hidden with nothing to restore.
        var opener = null;
        var modalEl = null;
        var doc = (typeof document !== 'undefined') ? document : null;
        // ⚠️ THE STORE-SIDE BRANCH COMES FIRST, and the ROLE picks the
        // module — not mere availability. ownerdashboard.html loads
        // hr-violations.js AND owner-violations.js together, so the HR module
        // exists even for an Area Manager or RM/SM: its listener never starts
        // for role 'owner'/'rmsm' (applyRole only arms it for 'hr'/'superadmin'),
        // its list stays empty, and its openModal() would return false for every
        // chip — "That report has not finished loading yet", forever, with no
        // report ever arriving. The manager's own module (the managerStatus
        // listener, #ownerViolationModal) is the one that actually holds the
        // report — and RM/SM reaches a report ONLY through this branch, since it
        // has no violations tab of its own.
        var openerRole = normalizeRole(currentRole);
        if ((openerRole === 'owner' || openerRole === 'rmsm') &&
            window.OwnerViolations && typeof window.OwnerViolations.openModal === 'function') {
            opener = function () { return window.OwnerViolations.openModal(id); };
            modalEl = doc ? doc.getElementById('ownerViolationModal') : null;
        } else if (typeof window.openViolationModal === 'function') {
            opener = function () { return window.openViolationModal(id); };
            modalEl = doc ? doc.getElementById('violationModal') : null;
        } else if (window.HrViolations && typeof window.HrViolations.openModal === 'function') {
            opener = function () { return window.HrViolations.openModal(id); };
            modalEl = doc ? doc.getElementById('hrViolationModal') : null;
        }
        if (!opener) return false;

        // ⚠️ THE HR OPENER MUST REPORT WHETHER IT OPENED, and it now does
        // (js/hr-violations.js openModal returns a boolean). It has to: it
        // looks the report up in its listener's in-memory array, so a report
        // that has not arrived yet returns false — and a silent no-op would
        // look to the user like a broken chip. script.js's openViolationModal
        // returns nothing, hence the `!== false` test rather than a truthiness
        // one: only an explicit false counts as a failure.
        var opened = true;
        try {
            opened = opener() !== false;
        } catch (e) {
            opened = false;
        }
        if (!opened) {
            if (doc && modalEl && !modalEl.classList.contains('active')) {
                showToast('That report has not finished loading yet — try again in a moment.', 'info');
            }
            return false;
        }

        var suspended = suspendChatForTicket();
        if (suspended) {
            // ⚠️ WAIT, DO NOT ASSUME. See the long note on
            // openTicketFromChat(): checking `classList.contains('active')` on
            // the next line is how the HR side once appeared "unfixed" — the
            // report modal arrived asynchronously, the check said "never
            // opened", the chat was restored, and the modal then appeared on
            // top of a visible chat. The open is WAITED for, briefly.
            waitForTicketModalOpen(modalEl);
        }
        return true;
    }

    /**
     * A chip was clicked. Resolve it, open it, and — crucially — SAY SO when it
     * cannot be opened, distinguishing the two very different reasons.
     */
    async function openViolationFromRef(ref) {
        var violation = await resolveViolationRef(ref);
        var label = String(ref || '').toUpperCase();
        if (!violation) {
            // ⚠️ THE STORE-SIDE MISS MEANS SOMETHING DIFFERENT. An Area
            // Manager's or RM/SM's filtered query only ever sees reports
            // transferred to their store, and the unfiltered probe in
            // resolveViolationRef() is DENIED for those roles by design — so
            // `lastViolationWasUntransferred` can never be set for them. A bare
            // "not found" would send them hunting a typo when the real answer is
            // "not handed to your store yet"; say it plainly instead, without
            // claiming the report does not exist (it may simply not be on their
            // list).
            var ownerView = normalizeRole(currentRole) === 'owner' || normalizeRole(currentRole) === 'rmsm';
            showToast(
                lastViolationWasUntransferred
                    ? 'Report ' + label + ' has not been transferred to HR yet — transfer it before mentioning it.'
                    : (ownerView
                        ? 'Report "' + label + '" is not on your violations list yet — ask the superadmin to transfer it to you.'
                        : 'Report "' + label + '" was not found.'),
                lastViolationWasUntransferred ? 'info' : 'error'
            );
            return false;
        }
        if (!openViolationFromChat(violation)) {
            showToast('This page cannot open report details.', 'error');
            return false;
        }
        return true;
    }

    /**
     * Replace "violation XYZ" tokens with a clickable chip.
     *
     * ⚠️ ESCAPE FIRST, exactly like the ticket and @mention paths.
     * renderMessageBody() has already escaped the entire message, so this can
     * only ever wrap already-escaped text in a <button> built from escaped
     * parts — a reference can never inject markup, and the id travels in an
     * escaped data attribute rather than inline JS.
     */
    function linkifyViolationRefs(escapedBody) {
        // ⚠️ THE GATE THAT ACTUALLY MATTERS — and it is the VIEW gate, not the
        // mention gate. This function needs NO Firestore read and NO permission
        // check of its own, so nothing downstream can undo what it renders:
        // whatever it decides here is what the reader sees.
        //
        // It used to consult canMentionViolations(), which asked the WRONG
        // question and broke the Area Manager's side of the store-chat
        // handoff: they must not CREATE a mention (the picker, the index and
        // the placeholder are all still gated on canMentionViolations()), but
        // a chip that does not render is a chip nobody can click — when HR or
        // a superadmin said "violation VIO-0007" in the store chat, the
        // manager saw plain text. canOpenViolations() is the right gate;
        // what they may actually OPEN is still enforced elsewhere, three
        // times over: firestore.rules on the read, isMentionableViolation()
        // on the resolver, and OwnerViolations.openModal() on the modal.
        if (!canOpenViolations()) return String(escapedBody || '');
        return String(escapedBody || '').replace(
            violationRefPattern('gi'),
            function (whole, at, token, offset) {
                if (!isViolationRefToken(token)) return whole;
                // The leading "@" is INSIDE the match, so the chip swallows it
                // and no dangling "@" is left in the rendered message.
                // ⚠️ `offset` is the match start, used as-is.
                if (!isRealRefMatch(whole, at, token, escapedBody, offset)) return whole;
                var id = escapeHTML(token.toLowerCase());
                var label = escapeHTML(token.toUpperCase());
                return '<button type="button" class="chat-violation-chip" ' +
                    'data-violation-ref="' + id + '" ' +
                    'title="Open report ' + label + '">' +
                    '<i class="fas fa-video" aria-hidden="true"></i>' +
                    '<span>' + label + '</span></button>';
            }
        );
    }

    // ==============================================================
    //  PICKER TRIGGERS
    //
    //  A reference can be started two ways, and both are supported:
    //
    //    "@ticket " / "ticket "        -> the ticket picker
    //    "@violation " / "violation "  -> the violation picker
    //
    //  The "@" forms are the explicit ones — they read as "show me the list".
    //  The bare-word forms are the ones that read naturally mid-sentence
    //  ("see ticket BNW-TIX007").
    //
    //  ⚠️ "@" IS A TRIGGER ONLY — IT IS NEVER INSERTED. applyViolationPick()
    //  writes "violation VIO-0007 ", not "@violation VIO-0007", because
    //  extractMentions() matches /@[\w.\-]+/g and would otherwise record
    //  "violation" as a mentioned PERSON on the message.
    // ==============================================================

    /**
     * The "@ticket" / "@violation" trigger: an "@" immediately followed by one
     * of the two keywords, then an optional query.
     *
     * Returns { kind, query, start, end, length } or null. MUST STAY PURE, for
     * the same reason activeTicketQuery() does.
     */
    function activeAtRefQuery() {
        if (!els.input) return null;
        var value = String(els.input.value || '');
        var caret = typeof els.input.selectionStart === 'number' ? els.input.selectionStart : value.length;
        var upto = value.slice(0, caret);
        // Longest keyword first: "@violation" must be tested before "@vio"
        // style prefixes so it is never mistaken for a ticket trigger.
        var re = /@violations?\s*|@tickets?\s*/gi;
        var best = null;
        var m;
        while ((m = re.exec(upto)) !== null) {
            // The "@" must not be preceded by a word character, so an address
            // like "a@ticket.com" is not a trigger.
            if (m.index > 0 && /[\w]/.test(upto.charAt(m.index - 1))) continue;
            // Keep the LAST match: that is the one being typed.
            best = m;
        }
        if (!best) return null;
        var kind = /^@violations?/i.test(best[0]) ? PICKER_VIOLATION : PICKER_TICKET;
        var query = upto.slice(best.index + best[0].length);
        // A multi-word query means the user moved on and is writing prose.
        if (/\s/.test(query)) return null;
        if (query.length > 40) return null;
        // ⚠️ A SINGLE ENGLISH WORD AFTER THE TRIGGER IS NOT A QUERY — IT IS
        // PROSE. "check @violation now" matches the trigger above and leaves
        // "now" as the query, which is one word with no space in it, so the
        // multi-word check above cannot catch it. Left alone, the violation
        // picker would open mid-sentence and — worse — picking a row would
        // overwrite the user's actual words with a reference.
        //
        // So the query must look like the START of a reference: empty (the
        // common case — "@violation" alone lists everything), or a number, or
        // something already carrying a separator ("VIO-0", "BNW-"). That is
        // the right filter for this feature, because every mentionable
        // reference IS a numbered record (VIO-0007, BNW-TIX007), and it
        // makes "@violation" + a word of prose inert instead of guessy.
        if (query && !/^[0-9]/.test(query) && !/[-_]/.test(query)) return null;
        return {
            kind: kind,
            query: query,
            start: best.index,
            end: caret,
            length: best[0].length
        };
    }

    // NOTE: the bare-word "violation " trigger (activeViolationQuery) was
    // REMOVED for the same reason as the ticket one above — and it mattered
    // more here, because "violation" is a far more common English word, so
    // sentences like "that violation is serious" opened the picker. "@violation"
    // is now the only trigger. The bare form still LINKIFIES in sent messages.

    /**
     * The active violation descriptor, from the "@violation" trigger.
     *
     * ⚠️ Like the ticket picker, the bare word "violation " is NO LONGER a
     * trigger — see activeTicketRefDescriptor() for why. "violation" is a far
     * more common English word than "ticket", so the bare form was opening the
     * picker on sentences like "that violation is serious".
     *
     * The bare form still LINKIFIES in sent messages, so older messages keep
     * their working chip.
     */
    function activeViolationRefDescriptor() {
        var at = activeAtRefQuery();
        if (at && at.kind === PICKER_VIOLATION) return at;
        return null;
    }

    /**
     * One row of the violation picker. Shared by the initial render and by the
     * arrow-key move, so the two can never render a row differently.
     */
    function violationPickerRow(v, isActive) {
        var number = String(v.violationNumber || v.id || '').toUpperCase();
        var detail = [v.store, v.subject, v.location]
            .filter(Boolean).join(' · ');
        return '<div class="chat-mention-option' + (isActive ? ' is-active' : '') + '"' +
            ' role="option" aria-selected="' + (isActive ? 'true' : 'false') + '"' +
            ' data-violation-pick="' + escapeHTML(String(v.id || '')) + '">' +
            '<span class="chat-mention-at">🎥</span>' + escapeHTML(number) +
            (detail ? '<span class="chat-mention-detail">' + escapeHTML(detail) + '</span>' : '') +
            '</div>';
    }

    /** The rows currently offered, re-derived from the live query. */
    function currentViolationPickerMatches() {
        var active = activeViolationRefDescriptor();
        if (!active) return [];
        return violationCandidates(active.query).slice(0, VIOLATION_PICKER_LIMIT);
    }

    /**
     * The single row shown when the trigger is active but nothing is offerable.
     *
     * A silent closeMentionMenu() is indistinguishable from a broken feature.
     * The violation picker hits that case CONSTANTLY and by design — it may
     * only offer reports transferred to HR — so "nothing appears" is the normal
     * outcome for a correct, well-behaved picker. Saying why is the difference
     * between a user who understands the rule and a user who files a bug
     * report about a dead button.
     *
     * ⚠️ IT CARRIES NO data-violation-pick AND LEAVES pickerMode null, so it
     * is not selectable. Enter therefore falls straight through to sending the
     * message (the keydown handler's `mentionMatches[mentionIndex]` is empty and
     * `mode` is null, so neither picker branch claims the key). That matters:
     * a decorative row that swallowed Enter would make the composer look frozen
     * precisely when the user is trying to abandon the trigger and type prose.
     */
    function violationPickerEmptyRow() {
        var message = violationIndexFailed
            ? 'Reports unavailable — you may not have access.'
            : 'No reports have been transferred to HR yet.';
        return '<div class="chat-mention-option is-empty" role="option" aria-selected="false">' +
            '<span class="chat-mention-detail">' + escapeHTML(message) + '</span>' +
            '</div>';
    }

    /**
     * Render the violation picker for the current query, or close it. Shares
     * #chatMentionMenu with the @ and ticket pickers — only one is ever open.
     */
    function updateViolationMenu() {
        if (!els.mentionMenu) return;
        // ⚠️ Never OPEN the picker for a role that cannot use it. Without this
        // an Area Manager typed "@violation", the read was denied, and they
        // were shown "No reports have been transferred to HR yet" — a message
        // written for HR, shown to someone who by design can never transfer
        // anything. SILENTLY do nothing instead: they are not the audience for
        // that explanation. (Deliberately NOT closeMentionMenu() here — the @
        // people picker owns closing, see the note on `active` below.)
        if (!canMentionViolations()) return;
        var active = activeViolationRefDescriptor();
        if (!active) return;   // never CLOSE here: the @ picker owns that

        var matches = currentViolationPickerMatches();
        if (matches.length === 0) {
            // ⚠️ AN EMPTY RESULT IS ONLY NEWS ONCE THE READ HAS RESOLVED. Before
            // that it just means "still loading", and showing the empty state
            // would set the menu visible and block syncViolationPicker()'s
            // deferred render — stranding the picker on "no reports" for the
            // whole session. So keep the old silent close while it is in flight.
            if (!violationIndexLoaded) { closeMentionMenu(); return; }
            els.mentionMenu.innerHTML = violationPickerEmptyRow();
            els.mentionMenu.hidden = false;
            // Deliberately NOT setting pickerMode — there is nothing to select.
            pickerMode = null;
            mentionMatches = [];
            return;
        }

        if (violationIndexSelection >= matches.length) violationIndexSelection = 0;
        els.mentionMenu.innerHTML = matches.map(function (v, i) {
            return violationPickerRow(v, i === violationIndexSelection);
        }).join('');
        els.mentionMenu.hidden = false;
        pickerMode = PICKER_VIOLATION;
        mentionMatches = [];
    }

    /**
     * Move the highlighted row. Re-renders through updateViolationMenu() so the
     * markup comes from violationPickerRow() exactly once.
     */
    function moveViolationPickerSelection(delta) {
        var matches = currentViolationPickerMatches();
        var n = matches.length;
        if (!n) return;
        violationIndexSelection = (violationIndexSelection + delta + n) % n;
        updateViolationMenu();
    }

    /**
     * Insert the picked report, replacing the trigger token.
     *
     * ⚠️ THE INSERTED TEXT IS "violation VIO-0007 " — NEVER "@violation ...".
     * extractMentions() scans /@[\w.\-]+/g, so an inserted "@violation" would
     * be written to the message as a mention of a person named "violation",
     * and "@ticket" likewise. The "@" is a trigger only; the canonical text is
     * the plain-word form the linkifier and the picker both understand.
     */
    function applyViolationPick(violationId) {
        if (!violationId || !els.input) return;
        var active = activeViolationRefDescriptor();
        if (!active) return;
        var v = (violationIndex || []).filter(function (x) { return String(x.id) === String(violationId); })[0];
        var number = String((v && (v.violationNumber || v.id)) || violationId).toUpperCase();
        var value = String(els.input.value || '');
        // Replace the WHOLE trigger token, so the inserted text is just the
        // reference. The linkifier matches "@violation XYZ", so we keep the
        // keyword AND the "@" — the chip swallows the "@", so the rendered
        // message shows one clean chip and no stray character.
        //
        // ⚠️ THE "@" REQUIRES REF_TRIGGER_WORDS IN extractMentions(). That
        // guard is what stops "violation" being written to the message as a
        // mentioned PERSON (which would fire a mention toast and sound at
        // whoever it resolved to). It is load-bearing, not belt-and-braces.
        var insertion = '@violation ' + number + ' ';
        els.input.value = value.slice(0, active.start) + insertion + value.slice(active.end);
        var caret = active.start + insertion.length;
        try { els.input.setSelectionRange(caret, caret); } catch (e) { /* older browsers */ }
        closeMentionMenu();
        syncDraftPresence();
        els.input.focus();
    }

    /**
     * The one place the violation index is loaded, and the only place a render
     * is deferred until it arrives.
     *
     * The first "violation " press usually happens before the read completes,
     * so the picker would not appear until the NEXT keystroke. This starts the
     * load and re-renders once it lands — but only if the token is still being
     * typed, the menu is still dismissed and the chat is still open, so a
     * picker the user already closed is never resurrected.
     *
     * Called from the input handler ONLY; the descriptor functions stay pure.
     */
    function syncViolationPicker() {
        // Do not even ATTEMPT the read for a role that cannot use it. Without
        // this, every "@violation" keystroke from an Area Manager fires a
        // guaranteed permission-error round trip that can only ever come back
        // denied.
        if (!canMentionViolations()) return;
        ensureViolationIndex().then(function () {
            if (!els.mentionMenu) return;
            if (els.overlay && !els.overlay.classList.contains('active')) return;
            if (!els.mentionMenu.hidden) return;   // already open, or another list
            if (!activeViolationRefDescriptor()) return;   // token moved or went away
            updateViolationMenu();
        });
    }

    /**
     * Dispatch to whichever picker the caret is in, and start the matching
     * index read.
     *
     * ⚠️ SPECIFIC WINS OVER GENERAL: an explicit "@ticket" / "@violation" is
     * tested FIRST, and a bare "@" (people) only if no ref token is active. A
     * bare "@" must not win over a ref token, or the people list would open on
     * top of the list the user actually asked for.
     *
     * There is deliberately NO bare-word branch here any more. "ticket " and
     * "violation " used to be triggers, but they fire on the keyword plus a
     * space anywhere in the message, so ordinary prose opened the picker
     * mid-sentence. The "@" is now required.
     */
    function syncRefPicker() {
        var at = activeAtRefQuery();
        if (at) {
            if (at.kind === PICKER_VIOLATION) {
                updateViolationMenu();
                syncViolationPicker();
            } else {
                updateTicketMenu();
                syncTicketPicker();
            }
            return;
        }
        updateMentionMenu();
    }

    // ==============================================================
    //  MENTIONS  (the "@name" people picker)
    //
    //  Typing "@" in the composer opens a picker of the other people in
    //  the thread; picking one inserts "@name " and the sent message
    //  carries a `mentions` array of emails. A mentioned person gets a
    //  toast, a distinct sound and a highlighted bubble.
    //
    //  WHO CAN BE MENTIONED is derived from the senders already present
    //  in the loaded history (plus the signed-in user), NOT from the
    //  `users` collection: firestore.rules only lets a superadmin or the
    //  profile owner read `users/{email}`, so an HR member cannot list
    //  it. The thread is the authoritative roster of who is actually in
    //  the chat, and it needs no extra query or rule.
    // ==============================================================

    // ---- All HR group @mention roster (superadmin-only) ----------------
    // The group is role-gated (HR + superadmin). An HR member CANNOT read the
    // `users` collection, so their roster is the thread senders below. A
    // SUPERADMIN can, so we pre-load every approved HR + superadmin once and
    // offer them all — otherwise the superadmin (often the only one posting)
    // can mention nobody until someone else posts. null = not loaded yet.
    var groupMentionRoster = null;       // { email: displayName }
    var groupMentionRosterLoading = false;

    function loadGroupMentionRoster() {
        if (groupMentionRoster || groupMentionRosterLoading) return;
        if (normalizeRole(currentRole) !== 'superadmin') return;   // HR cannot read users
        if (typeof db === 'undefined' || !db || typeof db.collection !== 'function') return;
        groupMentionRosterLoading = true;
        db.collection('users').get().then(function (snap) {
            const out = {};
            snap.forEach(function (doc) {
                const u = doc.data() || {};
                if (GROUP_ROOM_ROLES.indexOf(normalizeRole(u.role)) === -1) return;  // hr + superadmin only
                if (String(u.status || 'approved').trim().toLowerCase() !== 'approved') return;
                const email = String(u.email || doc.id || '').trim().toLowerCase();
                if (email) out[email] = String(u.name || u.displayName || '').trim();
            });
            groupMentionRoster = out;
            groupMentionRosterLoading = false;
            // If the picker is open right now, refresh it so the new names appear.
            if (activeRoomId === LEGACY_ROOM_ID && els.mentionMenu && !els.mentionMenu.hidden) {
                updateMentionMenu();
            }
        }).catch(function (err) {
            groupMentionRosterLoading = false;
            console.warn('[Chat] group mention roster load failed:', err);
        });
    }

    /** Distinct people seen in the thread. */
    function mentionCandidates() {
        var seen = {};
        var list = [];
        function add(email, name) {
            var key = String(email || '').toLowerCase();
            if (!key || seen[key]) return;
            seen[key] = true;
            list.push({ email: key, name: displayNameFor(email, name) });
        }
        if (currentUserEmail) add(currentUserEmail, displayNameFor(currentUserEmail, ''));
        // The other person in a 1:1 thread, even before either of them has
        // sent anything. Without this the "@" picker would be empty in a
        // brand-new conversation — exactly when someone is most likely to
        // want to name the recipient.
        if (activePeerEmail) add(activePeerEmail, nameFor(activePeerEmail));
        (lastRenderedMessages || []).forEach(function (msg) {
            add(msg.senderEmail, msg.senderName);
        });
        // Branch rooms are ALL-MEMBERS groups: the @mention roster is EXACTLY
        // the room's `members` array (the live room document, carried into the
        // summary by applyRoomSummaryToList / startConversationListListener /
        // syncSummaryFromMessage). So whoever is in the store chat may mention
        // whoever else is in it — the Area Manager and RM/SM of THAT branch, the
        // company-wide HR and superadmins (who are seeded into every branch
        // room), and nobody from another branch's team.
        //
        // ⚠️ `members` IS THE AUTHORITY, and it must be the REAL team: it is also
        // what firestore.rules authorises a room read on. A room polluted with
        // everyone (an older client wrote everyoneKnownForGroup() into group
        // rooms, and isGroupRoom() is true for branch rooms) would both offer
        // every user here AND leak the thread to other branches — so a superadmin
        // opening the room re-seeds it (see repairBranchRoomMembers).
        //
        // No 1:1/All-HR fallback here: those rooms are not `members`-scoped for
        // mentions, so they rely on the thread senders above. If a branch room's
        // summary has not loaded `members` yet, the picker simply shows the
        // senders until the next snapshot — it never invents a roster.
        if (activeRoomId && isBranchRoom(activeRoomId) &&
            conversationSummaries[activeRoomId] &&
            Array.isArray(conversationSummaries[activeRoomId].members)) {
            conversationSummaries[activeRoomId].members.forEach(function (member) {
                add(member, nameFor(member) || String(member));
            });
        }
        // The All HR group is role-gated (HR + superadmin). HR falls back to the
        // thread senders above (they cannot read `users`); a superadmin gets the
        // full approved HR + superadmin roster (loadGroupMentionRoster) so they
        // can mention a member who has not posted yet.
        if (activeRoomId === LEGACY_ROOM_ID && groupMentionRoster) {
            Object.keys(groupMentionRoster).forEach(function (member) {
                add(member, groupMentionRoster[member]);
            });
        }
        return list;
    }

    /**
     * If the caret sits inside an "@token", return the query being typed,
     * otherwise null. The token must start at a word boundary so an email
     * address inside text ("a@b.com") does not open the picker.
     */
    function activeMentionQuery() {
        if (!els.input) return null;
        var value = String(els.input.value || '');
        var caret = typeof els.input.selectionStart === 'number' ? els.input.selectionStart : value.length;
        var upto = value.slice(0, caret);
        var at = upto.lastIndexOf('@');
        if (at === -1) return null;
        // Reject an "@" that is part of a word (an email, a handle).
        if (at > 0 && /[\w@.]/.test(upto.charAt(at - 1))) return null;
        var token = upto.slice(at + 1);
        // A mention token is a single word: no spaces, limited length.
        if (/\s/.test(token) || token.length > 32) return null;
        return { query: token.toLowerCase(), start: at, end: caret };
    }

    var mentionIndex = 0;
    var mentionMatches = [];

    function closeMentionMenu() {
        if (!els.mentionMenu) return;
        els.mentionMenu.hidden = true;
        els.mentionMenu.innerHTML = '';
        mentionIndex = 0;
        mentionMatches = [];
        pickerMode = null;
    }

    /** Render the picker for the current "@query". */
    function updateMentionMenu() {
        if (!els.mentionMenu) return;
        var active = activeMentionQuery();
        if (!active) { closeMentionMenu(); return; }

        var q = active.query;
        // You can never mention YOURSELF. mentionCandidates() deliberately
        // still contains the signed-in user (it seeds self at 7478 and self
        // re-enters via your own sent messages and the branch-room `members`
        // list), because the RENDER path (renderMessageBody) needs self in the
        // roster to highlight your name when SOMEONE ELSE mentions you. Only
        // the two AUTHORING paths filter self out — this picker and
        // extractMentions() below — so self-mentioning is impossible while the
        // "mentioned me" highlight keeps working.
        var me = String(currentUserEmail || '').toLowerCase();
        mentionMatches = mentionCandidates().filter(function (c) {
            if (c.email === me) return false;
            return !q || c.name.toLowerCase().indexOf(q) !== -1;
        });
        if (mentionMatches.length === 0) { closeMentionMenu(); return; }

        mentionIndex = Math.min(mentionIndex, mentionMatches.length - 1);
        els.mentionMenu.innerHTML = mentionMatches.map(function (c, i) {
            var sel = i === mentionIndex;
            return '<div class="chat-mention-option' + (sel ? ' is-active' : '') + '"' +
                ' role="option" aria-selected="' + (sel ? 'true' : 'false') + '"' +
                ' data-mention-email="' + escapeHTML(c.email) + '"' +
                ' data-mention-name="' + escapeHTML(c.name) + '">' +
                '<span class="chat-mention-at">@</span>' + escapeHTML(c.name) +
                '</div>';
        }).join('');
        els.mentionMenu.hidden = false;
        pickerMode = PICKER_PEOPLE;
    }

    /** Insert the picked mention into the composer, replacing the "@token". */
    function applyMention(candidate) {
        if (!candidate || !els.input) return;
        var active = activeMentionQuery();
        if (!active) return;
        var value = String(els.input.value || '');
        var insertion = '@' + candidate.name + ' ';
        els.input.value = value.slice(0, active.start) + insertion + value.slice(active.end);
        var caret = active.start + insertion.length;
        try { els.input.setSelectionRange(caret, caret); } catch (e) { /* older browsers */ }
        closeMentionMenu();
        syncDraftPresence();
        els.input.focus();
    }

    /**
     * Emails mentioned in a sent message. Matches "@name" tokens against
     * the thread roster case-insensitively, so a hand-typed mention works
     * even if the picker was never used.
     *
     * ⚠️ THE REF TRIGGER WORDS ARE NOT PEOPLE. "@ticket" and "@violation" are
     * the two picker triggers, so a hand-typed "@violation VIO-0007" (or one
     * pasted in from elsewhere) puts "@violation" in the text. The roster
     * lookup below would normally make that harmless — it only matches real
     * display names — but a thread that genuinely contained someone called
     * "violation" would then record them as mentioned by a reference, and
     * they would get a toast for it. Skipping the two words outright makes
     * that impossible, and costs nothing: neither can be a display name the
     * composer ever inserts.
     */
    var REF_TRIGGER_WORDS = ['@ticket', '@tickets', '@violation', '@violations'];

    function extractMentions(text) {
        var body = String(text || '');
        if (body.indexOf('@') === -1) return [];
        var byName = {};
        mentionCandidates().forEach(function (c) {
            byName['@' + c.name.toLowerCase()] = c.email;
        });
        var out = [];
        // Never record a SELF-mention, even a hand-typed one (the picker can
        // no longer offer self, but "@me" typed by hand would still resolve
        // here because self is in the roster for the render path). A mention
        // of yourself is meaningless and would fire your own toast/sound.
        var me = String(currentUserEmail || '').toLowerCase();
        var re = /@[\w.\-]+/g;
        var match;
        while ((match = re.exec(body)) !== null) {
            var token = match[0].toLowerCase();
            if (REF_TRIGGER_WORDS.indexOf(token) !== -1) continue;
            var email = byName[token];
            if (email && email !== me && out.indexOf(email) === -1) out.push(email);
        }
        return out;
    }

    /** True when this message mentions the signed-in user. */
    function mentionsMe(msg) {
        var me = String(currentUserEmail || '').toLowerCase();
        if (!me || !msg || !msg.mentions || !msg.mentions.length) return false;
        return msg.mentions.some(function (m) {
            return String(m || '').toLowerCase() === me;
        });
    }

    /**
     * Escape first, then wrap "@name" tokens in a highlight span and "ticket
     * XYZ" references in a clickable chip. Escaping BEFORE this is what makes
     * it injection-safe: a mention or a ticket can only add markup built from
     * already-escaped text, never arbitrary markup.
     */
    function renderMessageBody(text, mentions) {
        var body = escapeHTML(text).replace(/\n/g, '<br>');
        // Reference chips FIRST: they must wrap the raw "ticket XYZ" /
        // "violation XYZ" text before the @mention pass below can touch it, and
        // both operate on the same already-escaped string, so neither can
        // reintroduce markup.
        body = linkifyTicketRefs(body);
        body = linkifyViolationRefs(body);
        var names = mentionCandidates().filter(function (c) {
            return !mentions || !mentions.length ||
                mentions.indexOf(c.email) !== -1;
        });
        names.forEach(function (c) {
            var safeName = escapeHTML(c.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            body = body.replace(
                new RegExp('@(' + safeName + ')(?![\\w.\\-])', 'gi'),
                '<span class="chat-mention">@$1</span>'
            );
        });
        return body;
    }

    // ==============================================================
    //  REAL-TIME LISTENER
    // ==============================================================

    function isPermissionError(error) {
        const code = (error && error.code);
        if (code === undefined || code === null) return false;
        // v8 uses the string 'permission-denied'; the numeric 7 is the
        // gRPC code seen in some versions.
        return code === 'permission-denied' || code === 7 ||
            (typeof code === 'string' && code.indexOf('permission') !== -1);
    }

    /**
     * Disable chat IN PLACE (keep the circle on screen, greyed out) and
     * explain why. Used when the deployed Firestore rules disagree with the
     * client allowlist — the launcher must never silently disappear, or the
     * user is left with no chat and no clue why.
     */
    function disableChatWithReason(reason) {
        stopListener();
        withdrawPresence();
        stopTypingListener();
        chatDisabledReason = reason;

        if (els.launcher) {
            els.launcher.classList.add('chat-launcher-disabled');
            els.launcher.setAttribute('aria-disabled', 'true');
            els.launcher.title = reason;
        }
        if (els.overlay) els.overlay.classList.remove('active');
        if (els.launcherTyping) els.launcherTyping.hidden = true;

        console.warn('[Chat] DISABLED: ' + reason);
        showToast(reason, 'error');
    }

    /** Re-enable the launcher after a transient failure. */
    function reenableChat() {
        chatDisabledReason = null;
        if (els.launcher) {
            els.launcher.classList.remove('chat-launcher-disabled');
            els.launcher.removeAttribute('aria-disabled');
            els.launcher.title = 'Open chat — drag to move';
        }
    }

    function startListener() {
        if (messagesUnsub) return;
        // No conversation selected yet: there is no room to subscribe to.
        // The LIST listener still runs, and picking a row starts this.
        const messages = messagesRef();
        if (!messages) return;
        // The next payload is the baseline (existing history) — stay silent.
        awaitingFirstSnapshot = true;
        // Receipts are a separate listener so a denied readReceipts rule
        // (stale deploy) cannot take the message stream down with it.
        startReadReceiptListener();
        // Re-acknowledge when the tab comes back with the chat open.
        startVisibilityListener();
        // Display names / job titles for the legacy archive's roster. New
        // rooms resolve names from the global directory instead, so this is
        // only started when the archive is actually open.
        if (activeRoomId === LEGACY_ROOM_ID) startProfilesListener();
        // Emoji reactions for the whole thread (one listener, one collection).
        startReactionsListener();
        // ⚠️ STAMP THE SUBSCRIPTION WITH ITS ROOM. The snapshot callback closes
        // over the GLOBAL activeRoomId, so a payload from a room you have since
        // left would be processed against the new room: it would replay the old
        // thread as "new" (and machine-gun the sound), stamp the wrong ids as
        // seen, and write a read receipt for the wrong conversation.
        // Unsubscribing does not cancel an already-dispatched callback, so the
        // guard has to live here. Captured once, at subscribe time.
        const subscribedRoomId = activeRoomId;
        try {
            messagesUnsub = messages
                .orderBy('sentAt', 'asc')
                .limitToLast(MAX_MESSAGES_RENDERED)
                .onSnapshot(function (snapshot) {
                    // A snapshot for a room we are no longer watching. Drop it.
                    if (activeRoomId !== subscribedRoomId) return;
                    // Remember the oldest doc of the live tail. It is the
                    // cursor for the FIRST "Load earlier" page, so paging
                    // starts exactly where the visible window ends instead
                    // of guessing or skipping. `docs` is a real
                    // QuerySnapshot field, but guard it anyway: a snapshot
                    // without it must not break the message stream.
                    oldestTailDoc = (snapshot.docs && snapshot.docs[0]) || oldestTailDoc;
                    const messages = [];
                    snapshot.forEach(function (doc) {
                        // ⚠️ roomId IS STAMPED ONTO EACH MESSAGE so the announce
                        // paths can attribute a message to a conversation.
                        // Without it they would fall back to the global
                        // activeRoomId — exactly the ambiguity the
                        // subscribedRoomId guard above exists to remove.
                        messages.push(Object.assign({ id: doc.id, roomId: subscribedRoomId }, doc.data()));
                    });
                    // A snapshot arriving means the rules let us read again
                    // (e.g. after a redeploy) — undo the disabled state.
                    if (chatDisabledReason) reenableChat();
                    // A receipt is only written while the chat modal is
                    // actually OPEN. It must NOT advance just because a
                    // message was delivered to a closed chat: "Seen" has
                    // to mean a person looked at it. A background tab
                    // must not count as reading either, so visibility
                    // (not merely the .active class) is required below.
                    if (isChatActuallyVisible()) {
                        markThreadRead();
                    }
                    // Sound first: must run before renderMessages updates
                    // the "last seen" bookkeeping used by the unread badge.
                    announceNewMessages(messages);
                    // The newest message this device has seen IS the truth
                    // about the conversation. Deriving the sidebar line from
                    // it keeps the preview correct even when the deployed rules
                    // refuse the room-summary write (see syncSummaryFromMessage).
                    const newest = messages[messages.length - 1];
                    if (newest) syncSummaryFromMessage(activeRoomId, newest);
                    renderMessages(messages);
                }, function (error) {
                    console.error('[Chat] Listener error:', error);
                    // A permission error means the deployed Firestore rules
                    // disagree with the CLIENT allowlist (the most common
                    // cause is simply not having run
                    // `firebase deploy --only firestore:rules` after the role
                    // split).
                    //
                    // It must NOT call teardown(): that REMOVES the launcher
                    // from the DOM, so the circle would appear on load and
                    // then silently vanish half a second later when the first
                    // snapshot comes back denied — leaving the user with no
                    // chat and no explanation. Disable the UI in place and
                    // say why instead; the button stays put and is re-enabled
                    // if the listener ever recovers.
                    if (isPermissionError(error)) {
                        // The GROUP chat is read by ROLE, so a refusal there can
                        // only mean the room does not exist yet (a brand-new
                        // project) — which is not a broken feature and must
                        // never grey out the whole chat. The composer still
                        // works: the first message creates the room.
                        if (isGroupRoom()) {
                            if (els.log) {
                                els.log.innerHTML = '<p class="chat-empty">' +
                                    'The group chat is empty — send the first message.' +
                                    '</p>';
                            }
                            return;
                        }
                        disableChatWithReason(
                            'Chat cannot read this conversation — the deployed Firestore rules ' +
                            'do not allow it. Deploy the updated rules: ' +
                            'firebase deploy --only firestore:rules'
                        );
                    } else {
                        showToast('Chat is unavailable right now.', 'error');
                    }
                });
        } catch (error) {
            console.error('[Chat] Could not start listener:', error);
        }
    }

    function stopListener() {
        if (messagesUnsub) {
            try { messagesUnsub(); } catch (e) { /* ignore */ }
            messagesUnsub = null;
        }
    }

    /** Full teardown — used when the role is not allowed (e.g. operator). */
    function teardown() {
        stopListener();
        // ⚠️ The per-room message watchers must die with the module. A full
        // teardown means the user is no longer allowed to chat (an operator, an
        // owner), so a surviving watcher would keep reading Firestore and could
        // still fire a sound for a conversation they may not see.
        stopRoomMessageWatchers();
        announcedMessageIds = {};
        // A suspended chat must be restored before the DOM goes away, and the
        // observer disconnected — otherwise its callback would fire into a
        // torn-down module (els is empty) and try to restore a dead overlay.
        if (ticketModalWatcher) {
            try { ticketModalWatcher.disconnect(); } catch (e) { /* ignore */ }
            ticketModalWatcher = null;
        }
        if (chatSuspended) {
            chatSuspended = false;
            if (typeof document !== 'undefined' && document.body) {
                document.body.classList.remove('chat-ticket-open');
            }
        }
        // Withdraw our typing indicator and release the presence listener,
        // otherwise a "…" could linger for other members.
        withdrawPresence();
        stopTypingListener();
        if (els.overlay) {
            els.overlay.remove();
            els.overlay = null;
        }
        if (els.launcher) {
            els.launcher.remove();
            els.launcher = null;
        }
        if (els.launcherTyping) {
            els.launcherTyping.remove();
            els.launcherTyping = null;
        }
        if (els.launcherTypingText) els.launcherTypingText = null;
        els = {};
        isMounted = false;
        seenMessageIds = [];
        lastRenderedMessages = [];
        // Reset pagination so a role change / re-init never shows a stale
        // page, cursor or "beginning of history" from a previous session.
        olderMessages = [];
        historyCursor = null;
        oldestTailDoc = null;
        hasMoreHistory = true;
        historyLoading = false;
        readReceipts = {};
        chatProfiles = {};
        reactionsByMessage = {};
        stopReactionsListener();
        // The people directory and the conversation list are also torn down,
        // or a re-init would leave two subscriptions writing the same state.
        stopDirectoryListener();
        stopConversationListListener();
        // ...and so is the account roster: it is a live listener now, and a
        // stale one would keep rebuilding the list for whoever signs in next.
        if (rosterUnsub) {
            try { rosterUnsub(); } catch (e) { /* already gone */ }
            rosterUnsub = null;
        }
        conversationSummaries = {};
        conversationListReady = false;
        conversationListDenied = false;
        conversationFilter = '';
        directory = {};
        rosterEntries = {};
        // No conversation is open after a teardown, so the next mount starts
        // from the list rather than resurrecting the previous room.
        activeRoomId = null;
        activePeerEmail = null;
        // A pending reply must not survive a remount (e.g. a role change
        // while composing) — the next message would otherwise silently
        // inherit a reply target from the previous session.
        replyingToId = null;
        stopReadReceiptListener();
        stopVisibilityListener();
        stopProfilesListener();
        // A pending receipt flush must not outlive the mounted chat.
        if (receiptFlushTimer) {
            clearTimeout(receiptFlushTimer);
            receiptFlushTimer = null;
        }
        receiptWritePending = false;
        // Never leave a drag half-finished: a stale dragState would let the
        // next pointermove teleport the freshly rebuilt launcher.
        dragState = null;
        suppressNextLauncherClick = false;
    }

    // ==============================================================
    //  INIT
    // ==============================================================

    /**
     * Mount chat for the given page + role.
     * @param {{ surface: 'main'|'owner', role: string }} options
     * @returns {boolean} true when chat is available
     */
    function init(options) {
        const opts = options || {};
        const surface = opts.surface === 'main' ? 'main' : 'owner';
        const role = normalizeRole(opts.role);

        // ---- Hard gate: operators (and anything unknown) get nothing ----
        if (!canChatOnSurface(surface, role)) {
            if (isMounted) teardown();
            return false;
        }

        if (typeof db === 'undefined' || typeof auth === 'undefined') {
            console.warn('[Chat] Firebase not ready — chat stays hidden.');
            return false;
        }

        const user = auth.currentUser;
        if (!user || !user.email) {
            if (isMounted) teardown();
            return false;
        }

        currentRole = role;
        // ⚠️ The composer must not ADVERTISE a feature this role cannot use. The
        // placeholder is built once, statically, and named "@violation" — so an
        // Area Manager was being told to type something that silently did
        // nothing. Set BOTH branches explicitly: this runs again on every
        // refreshPermissionUI(), and a role change must restore the full hint
        // rather than leaving the reduced one behind.
        if (els.input) {
            els.input.placeholder = canMentionViolations()
                ? 'Type a message… @ to mention someone, @ticket or @violation to link one'
                : 'Type a message… @ to mention someone, @ticket to link one';
        }
        const nextEmail = String(user.email).toLowerCase();

        // ⚠️ A re-init for the SAME account (refreshPermissionUI() calls this
        // on every permissions fetch) must not leave the previously open
        // conversation "open": its listeners are still attached, so the log
        // would show one thread while the sidebar highlighted another, and a
        // compose would post into a room the user can no longer see. Reset to
        // the list whenever the account changes OR the chat is being mounted
        // afresh, and let the user pick a row again.
        const accountChanged = currentUserEmail !== null && currentUserEmail !== nextEmail;
        if (!isMounted || accountChanged) {
            // Release the old room's listeners before anything else.
            if (isMounted) {
                withdrawPresence();
                stopListener();
                stopTypingListener();
                stopReadReceiptListener();
                stopReactionsListener();
            }
            activeRoomId = null;
            activePeerEmail = null;
        }
        currentUserEmail = nextEmail;
        // Remembered rooms are stored PER ACCOUNT, so they follow the signed-in
        // user — a fresh mount must start from this account's own list, never
        // from whoever was signed in before. The write shape the deployed rules
        // accept is remembered the same way (see loadSendShape).
        if (accountChanged || !Object.keys(knownRooms).length) loadKnownRooms();
        if (accountChanged || !sendShapeLoaded) {
            sendShapeLoaded = true;
            loadSendShape();
        }

        if (!isMounted) {
            buildUI();
            isMounted = true;
            // A fresh mount must not treat the existing history as "new",
            // or the first snapshot would play a sound for every old message.
            seenMessageIds = [];
            lastPresence = [];
        }
        // The launcher only becomes visible AFTER the role check above,
        // so an operator never sees a chat button flash on load.
        els.launcher.hidden = false;
        // Heal any stale saved position from the OLD persistent version —
        // the circle always STARTS at the CSS default (bottom-right).
        clearStaleLauncherPosition();

        // The people directory and the conversation list are what the modal
        // shows, so they are started on mount — NOT on open. A message
        // arriving in a conversation the user has not opened yet must still
        // raise the sidebar badge and the launcher badge.
        startDirectoryListener();
        // The account roster (both chat roles) is the SECOND source of people:
        // the directory is self-published, so without it a never-messaged HR
        // who has never opened the chat — or a superadmin who never has —
        // could not be discovered at all. It is live, so a newly registered
        // account appears without a reload.
        loadHrRoster();
        startConversationListListener();
        // The per-room listeners are started by selectConversation() once a
        // row is picked; there is no room to subscribe to before that.
        applyActiveRoomToHeader();
        return true;
    }

    ChatService.init = init;
    ChatService.open = openModal;
    ChatService.close = closeModal;
    ChatService.isMounted = function () { return isMounted; };

    // ---- Conversation list API -------------------------------------
    // Exposed so the dashboard (and the tests) can drive the list without
    // reaching into private state.

    /** Open a conversation by room id. */
    ChatService.selectConversation = selectConversation;
    /** Open (or create) the conversation with a given person. */
    ChatService.startConversationWith = function (email) {
        const roomId = myRoomIdWith(email);
        if (!roomId) return false;
        if (isMounted) {
            openModal();
            selectConversation(roomId);
        }
        return Boolean(roomId);
    };
    /** The room id currently open, or null. */
    ChatService.activeRoom = function () { return activeRoomId; };
    /** Filter the list, as if the user had typed in the search box. */
    ChatService.filterConversations = function (text) {
        conversationFilter = String(text || '');
        renderConversationList();
    };
    /** The rows the sidebar is currently showing (for tests/debugging). */
    ChatService.conversationRows = collectConversationRows;
    /**
     * Refresh the people directory AND the account roster (e.g. after a role
     * change). script.js calls this from refreshChatDirectory() right after
     * an account is approved or re-roled — exactly when the set of people a
     * thread may be started with has changed. (The roster is a live listener
     * as well, so other devices pick the same change up on their own; this
     * is the immediate refresh for the screen that made the change.)
     */
    ChatService.refreshDirectory = function () {
        if (!isMounted) return;
        stopDirectoryListener();
        startDirectoryListener();
        loadHrRoster();
    };
    /**
     * A branch room was just seeded (script.js ensureBranchGroupChats): fold
     * it into THIS device's sidebar immediately — remember it (the denied
     * list-query fallback re-reads remembered rooms) and attach its document
     * listener so the title/members arrive without waiting for anything else.
     * Idempotent: subscribeRoomForList() early-returns for a room already
     * subscribed, and rememberRoom overwrites the same key.
     */
    ChatService.noteBranchRoom = function (roomId) {
        if (!isMounted || !currentUserEmail || !roomId) return;
        rememberRoom(roomId);
        subscribeRoomForList(roomId);
        startPerRoomConversationListeners();   // no-op unless the list query was denied
    };

    /**
     * Drop a branch room from THIS device immediately after script.js deleted
     * it (a phantom room with no store team). forgetRoom() clears the
     * remembered-rooms list so the denied-query fallback stops re-reading it,
     * and applyRoomSummaryToList(roomId, null) is the same "room is gone" path
     * the live listener uses - it removes the summary and re-renders the
     * sidebar. Idempotent and safe on a room this device never showed.
     */
    ChatService.forgetBranchRoom = function (roomId) {
        if (!roomId) return;
        forgetRoom(roomId);
        applyRoomSummaryToList(roomId, null);
    };
})();
