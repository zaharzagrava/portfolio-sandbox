# Feature Specification: W05 — Product chat (inbox, unread, live messages, receipts, presence, reconnect) and the streamed shopping assistant sheet (resume, stop, errors) (`packages/web`)

**Feature Branch**: `W05-chat-assistant` (spec directory `specs/web/W05-chat-assistant`)

**Created**: 2026-10-07

**Status**: Draft

**Input**: "Specify web capability W05: Product chat (realtime, unread, receipts, reconnect) and the streamed shopping assistant sheet (resume, abort, errors)."

Backend rules are cited, never re-specified: "S24 AS-17" means scenario AS-17 of `specs/domains/S24-product-chat/spec.md`; "S46 AS-22" and "S51 FR-017" likewise. Scenario IDs of this spec are `AS-nn`; `test-plan.md` maps each to exactly one row. Decisions taken without asking are in *Assumptions* and, one line each, in `questions.md`.

## Scope

**In scope**

- **Product chat page** `/chat` (member only): the inbox of the member's product chats with unread badges, one open conversation (history, scroll-back, send with retry, reply, delete, read marking, "Seen by", presence), opening a chat from a product page (`/chat?product=<id>`: join as a buyer, or open it as shop staff), live delivery and recovery after a lost connection or an offline period.
- **Shopping assistant sheet**: a launcher that opens a side sheet on any page; ask, watch the answer stream in, tool-use chips, stop, resume after a dropped connection or a reload, retry safely, conversation list / new / delete, monthly allowance meter, and the visible form of every refusal and error.
- The responsive structure, keyboard and screen-reader behaviour, and the visible form of every problem the two backends can return.

**Out of scope** (owned elsewhere or not offered)

- Channel moderation screens (ban, unban, mute, unmute, promote, demote; S24 US7) and renaming or archiving a channel: the API exists, this release has no screen. Only **delete message** is offered here. Typing indicators, attachments, message edit and 1:1 chats do not exist (S24 Assumptions).
- The product page and its **Chat with seller** link (W02); the navbar, mobile menu, skip link, `<main>`, global error and not-found pages (W07); sign-in, session handling, the session-ended flow and `useAuth()` (W01); the notification bell and the shared live connection for `user:<id>` (W03); the seller screens that list products (W04, which may link to `/chat?product=<id>`).
- Help-center and product "Ask" answers (S47, W02), notifications for missed chat messages (S28), offline push, the WebSocket gateway (S24 D1, not part of the local stack).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A shopper opens a product's chat from the product page (Priority: P1)

A buyer on a product page presses **Chat with seller** and lands in that product's chat, joined and ready to type. The seller opens the same chat from the same link.

**Why this priority**: this is the entry to every chat; without it no conversation starts.

**Independent Test**: as a buyer open `/chat?product=<id>` for a product that has a chat, then as shop staff for a product that has none.

**Acceptance Scenarios**:

1. **AS-01** (buyer joins and lands in the chat) — **Given** a signed-in buyer who is not a member and a product with a chat, **When** they open `/chat?product=<productId>`, **Then** the page shows "Opening chat…" (`role="status"`), looks the chat up by product (S24 AS-07), joins it (S24 AS-05), the address becomes `/chat?channel=<channelId>` (replace, not push, so Back leaves the chat), the conversation opens with the product title as heading, the message field has focus, and the chat appears in the inbox. Pressing Back does not return to `?product=`. (S24 AS-05, AS-07.)
2. **AS-02** (existing member) — **Given** the visitor is already an `ACTIVE` member (`myRole` not null), **When** they open `/chat?product=<id>`, **Then** no join request is made and the conversation opens exactly as in AS-01.
3. **AS-03** (no chat yet, buyer) — **Given** the product has no chat (`404 channel_not_found`), **When** a buyer opens the link, **Then** the pane shows "The seller hasn't opened a chat for this product yet." with a **Back to product** link; no request creates anything. A visitor whose role is `SELLER` or `ADMIN` additionally sees the button **Open chat for this product** (AS-04); other roles never see it.
4. **AS-04** (shop staff open the chat) — **Given** AS-03 and a visitor with role `SELLER` or `ADMIN`, **When** they press **Open chat for this product**, **Then** the button shows a spinner and is disabled, the chat is created (S24 AS-01) and opens as in AS-01 (the visitor is `OWNER`, no join). **When** the answer is `403 permission_denied` the pane shows "Only staff of this product's shop can open its chat." and the button returns; **When** `409 channel_exists` (someone created it first) the page re-runs the lookup of AS-01/AS-02; **When** `404 product_not_found` the pane shows the not-found copy of AS-05. (S24 AS-02, AS-03, AS-04.)
5. **AS-05** (refusals while resolving) — **Given** the lookup or join is refused, **Then** the pane shows one `role="alert"` message with a way out and the inbox stays usable: malformed or unknown product (`400 validation_failed`, `404 product_not_found`) "This product link isn't valid." with **Browse products**; `409 channel_archived` on join "This chat was archived and isn't accepting new members." with **Back to product**; `403 banned` "You can't join this chat."; `429 rate_limited` the wait copy of FR-063 and a **Try again** button enabled when the wait ends; any `5xx` or network failure "We couldn't open this chat." with **Try again** and "Reference: {requestId}" when the body has one (FR-062). (S24 AS-06, AS-04.)
6. **AS-06** (signed out) — **Given** an anonymous visitor, **When** they open `/chat?product=<id>` (or any `/chat` address), **Then** the server redirects before anything renders to `/login?returnTo=<the full /chat address including its query>` (W01), and after signing in the visitor is back on that address and AS-01 runs. (W01 `requireServerSession`.)

---

### User Story 2 — A member sees all their chats and what they have not read (Priority: P1)

A member opens `/chat` and sees their chats, newest activity first, each with an unread badge that matches the server's count and stays current without a reload.

**Why this priority**: the badge is what brings people back to a conversation.

**Independent Test**: seller posts 5 messages in a chat; the buyer's inbox row shows 5; reading clears it.

**Acceptance Scenarios**:

1. **AS-07** (inbox rows) — **Given** the member belongs to chats, **When** `/chat` loads, **Then** each chat is one row (a link to `/chat?channel=<id>`) with title, time of the last message ("2 min ago", today's time, or a date), an **Archived** tag for archived chats and an unread badge when `unread > 0` showing the number (`99+` above 99) with the accessible name "{n} unread messages" ("1 unread message"); rows are ordered by last message time, newest first, archived chats after active ones; the open chat's row has `aria-current="page"`; the badge value is the server's `unread` (S24 AS-30, FR-030) and is never computed from messages on screen.
2. **AS-08** (loading, empty, failed) — **Given** the inbox is loading, **Then** a skeleton list is shown (`aria-busy="true"`, "Loading chats…" as `role="status"`). **Given** no chats, **Then** "No chats yet. Open a product and press Chat with seller." with a **Browse products** link. **Given** the first inbox read fails (not `401`), **Then** the list area shows "We couldn't load your chats." with **Try again** and the reference of FR-062, while the page shell and the open conversation (if any) stay usable; a failed *later* refresh keeps the old rows and shows nothing but a quiet "Couldn't refresh" line (`role="status"`) that clears on the next success.
3. **AS-09** (more chats) — **Given** the inbox has a `nextCursor`, **Then** a **Show more chats** button follows the last row; pressing it appends the next page (each chat once, no reordering of rows already shown) and the button disappears when `nextCursor` is null; focus stays on the button's position (the first newly added row receives no focus).
4. **AS-10** (the inbox stays current) — **Given** `/chat` is open and visible, **Then** the inbox is re-read when the window regains focus or the tab becomes visible, every 30 s while visible, after every message the member sends, after every live hint for a chat in the list (FR-043), and after reconnecting; a new chat or a new message elsewhere appears (badge and order) without a reload. A background tab does not poll.
5. **AS-11** (unread total for the navbar) — **Given** a signed-in member on any page, **When** W07 mounts `<ChatNavBadge />`, **Then** it shows the total of the unread badges of the first inbox page (`99+` above 99; nothing when 0 or unknown) and refreshes at most every 30 s while the tab is visible; for anonymous visitors it renders nothing and makes no request.

---

### User Story 3 — A member reads, sends, replies and deletes (Priority: P1)

A buyer reads the conversation, scrolls back, sends a question over a flaky connection, and sees it exactly once, in order, whatever happens to the network.

**Why this priority**: sending and reading are the product; duplicates and lost messages destroy trust (S24 US2).

**Independent Test**: send a message, drop the network before the answer, press **Retry**; one message results.

**Acceptance Scenarios**:

1. **AS-12** (opening a conversation) — **Given** `/chat?channel=<id>`, **Then** the conversation shows the 50 newest messages (history page, S24 AS-27) oldest to newest; while loading, a skeleton list with "Loading messages…" (`role="status"`); when the member had unread messages (inbox `unread = n > 0`) a separator "{n} new messages" (`role="separator"`) sits before the first unread message and the view scrolls to it, otherwise to the newest message; an empty chat shows "No messages yet. Say hello!"; a failure shows "We couldn't load this chat." with **Try again** and the composer disabled. The heading is the chat title with a **View product** link to the product page.
2. **AS-13** (scroll-back) — **Given** the history has a `nextCursor`, **Then** a **Load earlier messages** button sits above the oldest message; pressing it prepends the next page without moving the message the reader is looking at; when `nextCursor` is null the button is replaced by "Start of the chat"; a failed page keeps the loaded messages and shows "Couldn't load earlier messages." with **Try again** (history page failures never clear the list).
3. **AS-14** (send) — **Given** an active member with a non-empty draft, **When** they press **Send** (or Enter, FR-025), **Then** within 100 ms a bubble with the text, "You" and "Sending…" appears at the bottom, the field is emptied and keeps focus; on `201` the bubble becomes a normal message with its time; the realtime hint or sync that later delivers the same message (same `id`) does not add a second copy; the message is announced once as "Message sent" (`role="status"`). The request carries the message's `clientMessageId` (FR-026). (S24 AS-09.)
4. **AS-15** (the composer) — **Given** the composer, **Then**: it is a multi-line field labelled "Message" with placeholder "Type a message…"; Enter sends, Shift+Enter inserts a newline, and Enter during IME composition never sends; the text is trimmed before sending and a whitespace-only draft keeps **Send** disabled; the limit is 4,000 characters counted as Unicode code points (S24 FR-010): beyond 3,500 a counter "{n} / 4,000" appears (`aria-live="polite"` only when crossing 3,500 and 4,000), and typing or pasting past the limit is cut at the limit; the draft of each chat is kept while the member switches to another chat in the same visit (in memory only, never stored in the browser); **Send** has the accessible name "Send message".
5. **AS-16** (a failed send can be retried safely) — **Given** a send that did not complete (network error, timeout, `5xx`), **Then** the bubble stays in place marked "Not sent" with **Retry** and **Discard**; **Retry** re-sends the *same* `clientMessageId`, body and reply reference, so a request that had in fact succeeded comes back `200 duplicate: true` and is shown as one normal message (never twice); **Discard** removes the bubble; while one bubble is retrying, later drafts may be sent and are ordered after it by the sequence the server assigns. (S24 AS-10, AS-11, AS-13.)
6. **AS-17** (automatic retry after a lost connection) — **Given** bubbles in the "Not sent" state caused by a network failure (not by a server refusal), **When** the browser comes back online or the live connection is restored, **Then** each is retried once automatically, oldest first, with the same `clientMessageId`; refusals (`4xx`) are never retried automatically and keep **Retry**/**Discard**.
7. **AS-18** (what the member sees when the chat refuses a send) — **Given** the chat answers a send or has told the page its state, **Then**: `403 banned` replaces the composer with "You can no longer take part in this chat." and the conversation becomes read-only (further reads may answer `403`/`404`, FR-015); `403 muted` with `mutedUntil` disables the composer with "You're muted until {local time}." and re-enables it by a timer at that instant; `409 channel_archived` (or `isArchived` on load, or a live `channel_archived` hint) disables the composer with "This chat was archived. You can read it, but not reply." and the draft stays; `404 channel_not_found` on a send replaces the pane with the unavailable state of FR-015; `422 reply_target_invalid` removes the reply reference, marks the bubble "Not sent" with "The message you replied to is no longer available." and **Retry** sends it without the reference (new `clientMessageId`); `400 validation_failed` marks the bubble "Not sent" with "That message can't be sent." (client checks make this unreachable except for server-side rule changes). (S24 AS-16, AS-17, AS-15.)
8. **AS-19** (rate limit on send) — **Given** `429 rate_limited` with `Retry-After`, **Then** the bubble is marked "Not sent", a line under the composer reads "You're sending messages too fast. Try again in {wait}." (FR-063), **Retry** is disabled until the wait ends and then enables itself; other chats are unaffected. (S24 AS-18.)
9. **AS-20** (delete a message) — **Given** the member's own message, or any message when `myRole` is `OWNER` or `MODERATOR`, **Then** its **Message actions** menu has **Delete**; choosing it opens a confirmation "Delete this message? This can't be undone." with **Delete** and **Cancel** (focus on Cancel; Esc cancels); on `204` the message becomes the tombstone "Message removed" in place (same sequence, no gap), and a message that others delete appears as the same tombstone after the next live hint, sync of the recent window, or reopen; `403 permission_denied` shows a toast "You can't delete this message."; `404`/already deleted is treated as success. (S24 AS-26, FR-040.)
10. **AS-21** (reply) — **Given** any non-deleted message, **When** the member chooses **Reply** in its actions menu, **Then** a "Replying to {author}: {first 80 characters}" chip with a **Cancel reply** button appears above the composer and focus moves to the field; the sent message shows a quoted preview of the original (found among loaded messages, otherwise "Original message"); a tombstoned original shows "Message removed" in the quote. (S24 AS-15.)
11. **AS-22** (how a message is shown) — **Given** messages, **Then** each shows author label ("You"; "Seller" when `authorId` equals the chat's `sellerId`; otherwise "Buyer {first 4 characters of the id}" because the API publishes no display names, S24 Assumptions), time, and the body as plain text with line breaks preserved (never HTML or Markdown; long words wrap); a day separator ("Today", "Yesterday", a date) appears between days; own messages are aligned to the end and others to the start; a tombstone shows "Message removed"; the list keys are message `id`s (never indexes) and consecutive rows stay in strict sequence order whatever order they arrived in.

---

### User Story 4 — Messages arrive live, and a lost connection heals itself (Priority: P1)

The phone loses signal for an hour. When it is back, the chat shows everything it missed, once, in order, and says honestly while it is catching up.

**Why this priority**: "push is best-effort, sync is the guarantee" is the contract (S24 US3, S51 US2); the page must make that true for the person.

**Independent Test**: with the conversation open, cut the connection, post messages from another account, restore the connection.

**Acceptance Scenarios**:

1. **AS-23** (live delivery) — **Given** a conversation is open, **When** another member posts, **Then** within 2 seconds the page learns of it (live hint, FR-043) and runs the catch-up of FR-041, so the message appears once, at the end, with a polite announcement "{author}: {first 100 characters}" (`role="status"`, only messages from others, at most one announcement per second, coalesced); if the reader is at the bottom the view follows, otherwise AS-32 applies. Without a hint (the hub carries none, or it is down) the open chat is still synced every 15 s while visible. (S24 AS-21; S51 US1.)
2. **AS-24** (stream lost, then restored) — **Given** the live connection drops, **Then** within 3 seconds a banner "Reconnecting…" (`role="status"`) appears at the top of the conversation and inbox, the open chat is synced every 5 s meanwhile, the composer keeps working, and when the connection is open again the banner disappears only after a full catch-up (FR-041) has completed; messages are neither missing nor duplicated across the gap. (S51 AS-08–AS-10, FR-046; S24 AS-21.)
3. **AS-25** (catch-up is complete and ordered) — **Given** a catch-up, **Then** the page sends the highest `seq` it holds for every conversation whose messages it has loaded (at most 50), repeats for any chat answering `hasMore: true` until `false`, merges by `id` (a re-delivered message replaces its copy) and orders by `seq`; a chat that answers with `messages: []` changes nothing; the sync call is read-only and is repeated freely. (S24 AS-21–AS-23, FR-020.)
4. **AS-26** (`resync`) — **Given** the hub sends `resync` for a chat topic (S51 FR-017), **Then** the page re-reads that chat's newest history page, the inbox, runs the catch-up, and replaces the messages it holds with the result (so deletions and gaps are corrected); no error is shown.
5. **AS-27** (`revoked`) — **Given** the hub sends `revoked` for a chat topic (the member was removed), **Then** the page stops listening to that topic, re-reads the chat, and if it answers `403`/`404` shows the unavailable state of FR-015 and removes the chat from the inbox; if it still answers `200` it re-subscribes once. (S51 FR-039.)
6. **AS-28** (a refused stream is recreated) — **Given** the browser reports the connection permanently closed (a final `401`/`403`/`503` before the stream started, S51 FR-007), **Then** the page shows "Reconnecting…", refreshes the session (W01), and recreates the connection with back-off (1, 2, 4, 8, 16, then every 30 s, each delay randomised by ±20 %); a `401` that persists runs W01's session-ended flow once; the polling of AS-24 covers the meanwhile. (S51 A-13.)
7. **AS-29** (offline and background tabs) — **Given** the browser goes offline, **Then** the banner reads "You're offline. Messages will send when you're back online." (`role="status"`), no polling runs, composing continues and sends become "Not sent" bubbles (AS-16/AS-17); on `online` the catch-up of FR-041 runs at once. **Given** the tab is hidden, polling and heartbeats pause; when it becomes visible the catch-up runs immediately.
8. **AS-30** (cursor ahead of the server) — **Given** a sync entry whose `lastSeq` is lower than the highest `seq` held (restored backup, other environment), **Then** the page discards what it holds for that chat, re-reads the newest history page and continues from there. (S24 Edge Cases.)

---

### User Story 5 — Read receipts and presence help without watching the member (Priority: P2)

A buyer's unread badge clears when they have actually seen the messages; the seller sees "Seen by 2" under their answer and whether the seller is online.

**Why this priority**: these make chat feel alive; they must never claim a message was seen when it was not.

**Independent Test**: seller posts; the buyer's page is hidden: badge stays; the tab becomes visible and scrolled to the end: badge clears and the seller sees "Seen".

**Acceptance Scenarios**:

1. **AS-31** (when a message counts as read) — **Given** a conversation, **Then** the page marks messages read (`POST …/read {seq}`) only when the tab is visible and focused **and** the message is rendered in the scroll view's visible area (at least its bottom edge); `seq` is the highest such message; calls are debounced (500 ms) and never repeat a position already acknowledged or lower than it; the inbox badge is set from the response (`unread`), not guessed; opening a chat from the inbox without scrolling marks only what fits on screen; the member's own sends mark nothing (S24 AS-31). (S24 AS-32–AS-34.)
2. **AS-32** (scrolled up) — **Given** the reader is more than one screen above the newest message, **When** new messages arrive, **Then** the view does not move; a button "{n} new message(s) ↓" (`aria-label` "Jump to latest, {n} new messages") appears; pressing it (or scrolling to the end) shows them and marks them read (AS-31).
3. **AS-33** (Seen by) — **Given** a small chat (≤ 50 active members), **Then** under the member's own newest message that others have read the page shows "Seen" (one reader) or "Seen by {n}", from the `read {userId, seq}` events received on the chat topic and the starting positions read when the chat opens (FR-044); a reader counts when their position ≥ that message's `seq`; the member's own position never counts; nothing is shown when no event or position says so (never a guess). In larger chats no receipts exist (S24 AS-36) and nothing is shown.
4. **AS-34** (presence) — **Given** the page is visible, **Then** it sends a heartbeat on open and then every 30 s (never faster than the 6-per-minute limit), and for the open chat's seller (when the member is not the seller) reads presence every 30 s; when the seller is online the header shows "Seller online" (a dot with the text, never colour alone); otherwise nothing is shown (no "offline", no "last seen"). (S24 AS-37, AS-39.)
5. **AS-35** (presence is optional) — **Given** `503 presence_unavailable` on a read, `429 rate_limited` on a heartbeat or read, or any presence failure, **Then** the indicator simply disappears, no toast or banner is shown, heartbeats pause for the `Retry-After` seconds (default 60) and resume afterwards; chat sending and reading are unaffected. (S24 AS-40, AS-41.)
6. **AS-36** (read marking is rate-limited) — **Given** `429 rate_limited` on a read call, **Then** the page waits for `Retry-After` (default 10 s) and sends one call with the then-highest position; the badge shows the last known server value meanwhile and nothing is shown to the member.

---

### User Story 6 — The chat page works on a phone and with a keyboard or screen reader (Priority: P2)

**Why this priority**: the audience reads chats on phones; keyboard and screen-reader users must be able to do everything a pointer can.

**Acceptance Scenarios**:

1. **AS-37** (desktop, ≥ 1024 px) — **Given** `/chat`, **Then** two regions sit side by side below the navbar and above the footer, filling the viewport height with no page-level scroll: the **inbox** (a fixed-width column, own scroll) and the **conversation pane** (rest of the width: header, message list with its own scroll, composer fixed at the bottom of the pane). With no `channel` the pane shows "Select a chat to read it." and nothing is marked read.
2. **AS-38** (mobile, ≤ 640 px; the same single-pane layout applies up to 1023 px) — **Given** `/chat`, **Then** one pane is visible at a time: without `channel` the inbox fills the width; with `channel` the conversation fills the width, headed by a **Back to all chats** link (`/chat`, replacing the pane) above the title, the composer stays above the on-screen keyboard (it is never covered), and the message list is the only scroller. Moving to the conversation moves focus to its heading; **Back to all chats** returns focus to the row that was open; the browser Back button does the same.
3. **AS-39** (keyboard and screen reader) — **Given** the page, **Then**: landmarks are `<main>` (W07), a `<nav aria-label="Your chats">` holding the rows, the conversation as a `<section aria-labelledby>` headed by the chat title (`h1`), the message list `role="list"` named "Messages in {title}", the composer a `<form>` with its field labelled; focus order is skip link → navbar → inbox rows → **Show more chats** → conversation header (**Back to all chats** on mobile, **View product**) → **Load earlier messages** → per-message **Message actions** buttons (each named "Message actions for the message from {author} at {time}") → **Jump to latest** → the field → **Send**; menus and dialogs trap focus, close on Esc and return focus to their trigger; new messages and status changes are announced only through the polite status regions of AS-14, AS-23, AS-24 (never through the whole list); every state keeps visible focus rings, colour is never the only carrier of meaning (unread, online, not sent), and touch targets are at least 44 × 44 px on mobile.
4. **AS-40** (the session ends while the page is open) — **Given** any chat request answers `401`, **Then** W01's session-ended flow runs once (toast with **Sign in**), the page redirects to sign-in with `returnTo`, drafts and "Not sent" bubbles are dropped with the cache (they hold no data worth keeping), and the live connection is closed; **Given** a `403`/`404` on a chat the member could read a moment ago, **Then** FR-015's unavailable state is shown and nothing from a cache is displayed for it. (W01 AS-26, AS-65; S24 AS-07.)

---

### User Story 7 — A shopper asks the assistant and watches the answer arrive (Priority: P1)

A shopper opens the assistant from any page, types "find me a phone under €800", and sees the answer appear word by word, with chips showing what the assistant is looking up.

**Why this priority**: it is the whole feature (S46 US1).

**Independent Test**: open the sheet, ask, read the streamed answer.

**Acceptance Scenarios**:

1. **AS-41** (the launcher and the sheet) — **Given** any page, **Then** a button named "AI Assistant" (W07 mounts `<AssistantLauncher />`) opens a sheet titled "AI Shopping Assistant" (a modal dialog: focus moves into it, Tab is trapped, Esc or the close button closes it and returns focus to the launcher, the page behind is inert). **Given** an anonymous visitor, **Then** the sheet shows "Sign in to chat with the shopping assistant." with a **Sign in** link to `/login?returnTo=<current address>`; **Given** the session is being read, a skeleton; **Given** the session check is unavailable, "We can't check your session right now. Try again in a moment." **Given** a member and no conversation yet, **Then** the empty state "Hi! I'm your AI Shopping Assistant." / "How can I help you today?" and the composer.
2. **AS-42** (ask and stream) — **Given** a member with the sheet open, **When** they send "hi", **Then** at once their message appears right-aligned, the field empties, **Send** becomes **Stop generating**, and an assistant bubble labelled "Thinking…" appears; on `meta` it takes the reply's identity; each `text` event appends its text to the bubble in arrival order (the page does not re-split or re-order); the view follows the end unless the reader scrolled up; on `done` the bubble is final, **Stop generating** returns to **Send**, "Answer ready" is announced once (`role="status"`), the allowance meter updates from `done.allowance` (AS-47), and the exchange equals what the history later returns (S46 AS-01). No toast is used for any state of this flow; every message of the flow is inline.
3. **AS-43** (tool chips) — **Given** `tool {id, name, status}` events, **Then** each tool call is one chip above the answer text, keyed by `id`: running "Searching products…" / "Reading product details…" / "Checking pickup points near you…" with a spinner; done "Searched products" / "Read product details" / "Checked pickup points" with a check; failed "Couldn't search products" etc. with a cross; the text is part of the chip (never only an icon); an unknown tool name shows the name with underscores replaced by spaces; chips remain after the answer (they are not saved in the transcript beyond tool names, S46 AS-08). (S46 FR-016.)
4. **AS-44** (the answer is text, safely) — **Given** an answer, **Then** it is rendered as Markdown limited to paragraphs, emphasis, lists, tables, code and links; raw HTML, images and scripts are never rendered; links open in a new tab with `rel="noopener noreferrer"` and only `http`, `https` or same-site relative targets are links (others show as text); an unfinished Markdown construct while streaming is shown as plain text until completed without flicker of the layout. (Constitution VI.7.)
5. **AS-45** (composer rules and safe retry) — **Given** the composer, **Then** it is a multi-line field labelled "Message to the assistant" with placeholder "Ask me anything..."; Enter sends, Shift+Enter newline, never during IME composition; whitespace-only keeps **Send** (named "Send message") disabled; the limit is 4,000 characters with the counter of AS-15; while a reply is running the field stays editable but sending is disabled; every send carries an `Idempotency-Key` created once per user action and **reused** when the same unsent text is sent again after a failure (so a lost response or a double press never creates a second paid turn); a new text gets a new key. (S46 AS-63–AS-67.)
6. **AS-46** (device location, opt-in) — **Given** the composer, **Then** a switch **Use my location** is off by default; turning it on asks the browser for the position once per switch-on; while on and available, each send includes `lat` and `lng`; a denied or failed lookup turns the switch off and shows "Location unavailable. Allow location access in your browser to use this." inline; the position is held in memory only and is never stored in the browser, logged or shown; turning the switch off or closing the sheet forgets it. (S46 FR-019.)
7. **AS-47** (allowance meter) — **Given** the sheet is open for a member, **Then** a quiet line under the composer reads "{p}% of your monthly allowance used" (rounded down, `role="progressbar"`-free plain text with a `<progress>` named "Monthly allowance used"), read from `GET /assistant/usage` when the sheet opens and updated from every `done.allowance`; at 100 % it reads "Monthly allowance used up. Resets {date}." and the composer is disabled (AS-59); a failed usage read shows nothing and never blocks sending. (S46 AS-32, AS-42.)
8. **AS-48** (conversations and what survives a reload) — **Given** a first message, **Then** the conversation is created on that first send (title "New chat" from the server); the sheet remembers the current conversation (and the running reply, AS-50) for the browser tab only (per-tab storage of ids, no tokens, no text, cleared at sign-out); reopening the sheet, navigating to another page, or reloading shows that conversation's history (user and assistant messages with their tool names as chips) newest at the bottom; a conversation that no longer exists (`404 not_found`) silently falls back to the empty state. (S46 AS-07, AS-08.)

---

### User Story 8 — A dropped connection never loses an answer; the shopper can stop it (Priority: P1)

The phone goes through a tunnel mid-answer; when it reconnects the answer continues from the word it stopped at. A reload mid-answer carries on too. The shopper can stop a reply.

**Why this priority**: streaming over mobile networks is the main failure mode of an LLM chat and unread paid tokens are pure cost (S46 US3).

**Independent Test**: start a slow reply, cut the connection, restore it within the grace period; then repeat with a page reload; then press **Stop generating**.

**Acceptance Scenarios**:

1. **AS-49** (resume after a drop) — **Given** a reply is streaming and the connection ends without a terminal event, **Then** the bubble shows "Reconnecting…" (`role="status"`) at once, keeps the text already shown, and the page attaches to `GET /assistant/messages/{messageId}/stream` with `Last-Event-ID` = the id of the last event received, retrying at 0 s, 1 s, 2 s, 4 s, 8 s (all inside the server's 10 s grace period, S46 AS-26) and then every 10 s up to 2 minutes; the continuation appends from the next event only, so no text is repeated or lost (S46 AS-22); on the terminal event the bubble finishes as in AS-42; a `400 invalid_last_event_id` is never sent (the id is taken only from received events).
2. **AS-50** (reload or navigation away mid-answer) — **Given** a reply is running and the page is reloaded within the replay window, **Then** after reload the sheet (if it was open it reopens, otherwise a dot on the launcher marks a running reply) re-attaches to the remembered `messageId` **without** `Last-Event-ID`, replays the reply from `meta`, rebuilds the bubble from scratch and continues live (S46 AS-23); the user's own message is shown from the remembered conversation history plus the pending text kept in the tab's storage for this purpose only, removed when the reply ends. If more than the grace period passed with no viewer, AS-51 applies.
3. **AS-51** (the reply cannot be resumed) — **Given** an attach answers `404 generation_not_found`, **Then** the page reads the conversation history: if it now holds the assistant message with that `messageId` the answer is shown from history (finished); otherwise the bubble shows "The reply was interrupted. Ask again to retry." with the question kept as a **Try again** action that puts the text back in the field. **Given** every attempt of AS-49 failed (2 minutes), the bubble shows "We couldn't reconnect to the reply." with **Try again** (re-attach once more). (S46 AS-25, AS-30.)
4. **AS-52** (stop) — **Given** a running reply, **When** the member presses **Stop generating**, **Then** the button is disabled with "Stopping…", `POST …/cancel` is sent, the reading of the stream continues until its terminal `error {code: "CANCELLED"}`; then the partial text stays on screen with the note "Stopped. This reply wasn't saved." and **Send** returns; the question is not in the history afterwards (S46 AS-28, FR-012). **When** the cancel answers `409 generation_finished` the reply is in fact complete: the page reads the history and shows the finished answer instead; `404 generation_not_found` shows AS-51; a second press is impossible while stopping; the stop works from a keyboard (Tab to it, Enter or Space).
5. **AS-53** (closing the sheet or moving around keeps the reply) — **Given** a running reply, **When** the member closes the sheet or navigates inside the app, **Then** reading continues (the launcher is part of the persistent navbar); reopening shows the progress. **Given** the whole tab is closed or reloaded and no viewer attaches within the server's grace period, the server stops the reply (`CANCELLED`) and, on the next visit, AS-51 shows the interrupted note. The page never starts a second reply for the same conversation while one is running (**Send** is disabled).
6. **AS-54** (a retried send attaches instead of duplicating) — **Given** a send whose response was lost before `meta` arrived and the member sends again (same text, same key, AS-45): **When** the server answers `409 idempotency_in_flight` with `messageId`, **Then** the page attaches to that reply as in AS-49 (from the start) with no second bubble and no second turn; **When** the server answers `200` with `Idempotent-Replay: true` for a finished turn, the stored events are rendered as an ordinary reply, once. **When** `422 idempotency_key_reuse` comes back (the text changed under the same key) the page starts again with a new key. (S46 AS-63–AS-65.)
7. **AS-55** (sign-out forgets everything) — **Given** the member signs out (here or in another tab, W01 `BroadcastChannel('auth')`), **Then** the sheet closes, the remembered conversation, running-reply pointer, pending text and cached conversations are cleared, the live reading is aborted, and the launcher offers sign-in.

---

### User Story 9 — Every refusal and error is explained in place (Priority: P1)

**Why this priority**: the assistant is gated by moderation, quotas, rate limits and provider health (S46 US4–US6); each must read as an instruction, not as a failure.

**Acceptance Scenarios**:

1. **AS-56** (rejections before the stream starts) — **Given** a send answered with a problem, **Then** the member's text stays in the field, nothing is added to the transcript, one inline `role="alert"` message (above the composer) shows the copy below, and Send is enabled again as stated; unknown codes fall back by status class (FR-062). Copy (exact): `validation_failed` "That message can't be sent. Messages can be up to 4,000 characters."; `input_rejected` with category `sensitive_data` "Your message looks like it contains a card number or a password. Remove it and try again.", any other category "I can't help with that request."; `turn_in_progress` "The assistant is still answering. Wait for it to finish."; `conversation_full` "This chat is full. Start a new chat to continue." with **New chat**; `not_found` "This chat no longer exists." and the sheet resets to an empty conversation (the text stays in the field); `rate_limited` "You're sending messages too fast. Try again in {wait}." and Send disabled until the wait ends; `too_many_active_turns` "The assistant is already answering in other chats. Wait for one to finish."; `assistant_busy` "The assistant is busy right now. Try again in {wait}."; `assistant_unavailable` "The assistant is unavailable right now. Try again in {wait}."; `quota_exceeded` AS-59; `idempotency_in_flight` / `idempotency_key_reuse` AS-54; `idempotency_key_required` (a client defect) the unexpected-error copy; `401` W01's flow (AS-60). (S46 AS-03–AS-06, AS-36, AS-37, AS-39–AS-41, AS-52, AS-53.)
2. **AS-57** (the reply ends in an error) — **Given** a terminal `error {code, retryAfterMs?}`, **Then** the partial text stays, followed by an inline `role="alert"` note, and Send returns: `CANCELLED` AS-52's "Stopped. This reply wasn't saved." (also when the server cancelled for lack of viewers); `GENERATION_LOST` "The reply was interrupted. Ask again to retry."; `PROVIDER_UNAVAILABLE` "The assistant is busy right now. Try again in {wait}." with {wait} from `retryAfterMs` (default "a moment"); `TURN_TIMEOUT` "That took too long to answer. Try a shorter or simpler question."; `MODERATION_UNAVAILABLE` "The assistant can't check this reply right now. Try again in a moment."; `INTERNAL` and any unknown code "The assistant ran into a problem. Try again." Each note offers **Try again** which puts the question back in the field (it is **not** re-sent automatically and gets a new key). Provider, model and stack text is never shown. (S46 AS-26, AS-28, AS-30, AS-44, AS-45, AS-48, AS-49, AS-55.)
3. **AS-58** (refusals) — **Given** a terminal `refusal {category, source}`, **Then** the streamed text (if any) is **replaced** by the notice "I can't help with that." (the declined text is not left readable; moderation may have published earlier chunks, S46 AS-54), the question remains in the transcript with the note "This exchange wasn't saved.", and the category is not displayed. (S46 AS-51, AS-54.)
4. **AS-59** (allowance used up) — **Given** `quota_exceeded {used, limit, resetsAt}` (or usage at 100 %), **Then** the composer is disabled with "You've used your monthly assistant allowance. It resets on {date}." (local date), the text stays, and at `resetsAt` the composer re-enables by timer and the usage is re-read; a send is never attempted while disabled. (S46 AS-32, AS-34.)
5. **AS-60** (the session ends mid-use) — **Given** a send, resume, cancel, history or usage call answers `401`, **Then** W01's session-ended flow runs once, the partial reply stays visible until sign-out clears the sheet (AS-55), and no retry is attempted. (W01 AS-26; S46 AS-04.)

---

### User Story 10 — The shopper keeps, switches and deletes assistant conversations (Priority: P2)

**Acceptance Scenarios**:

1. **AS-61** (conversation list) — **Given** the sheet header's **Chats** button, **Then** it opens a list (own conversations only, newest first, 20 per page with **Show more** while `nextCursor` is set, S46 AS-07) showing titles and relative times; choosing one loads its history (AS-48) and closes the list; loading, empty ("No conversations yet.") and failed ("We couldn't load your conversations." with **Try again**) states exist; while a reply is running choosing another conversation is allowed and the running reply keeps streaming in the background (its indicator is shown on the launcher and on the list row).
2. **AS-62** (new chat) — **Given** the **New chat** button, **Then** the transcript clears to the empty state, no request is made until the first send (AS-48), the field keeps its text, and the button is disabled while the current chat is empty; with a running reply it is allowed (AS-61).
3. **AS-63** (delete a conversation) — **Given** a row's **Delete**, **Then** a confirmation "Delete this conversation? Its messages are removed permanently." with **Delete**/**Cancel** (focus on Cancel); on `204` the row disappears and, when it was the open one, the sheet shows the empty state; `409 turn_in_progress` shows "Wait for the reply to finish, then delete the conversation."; `404` is treated as deleted. (S46 AS-09.)
4. **AS-64** (a full conversation) — **Given** `conversation_full` (AS-56) the composer is replaced by "This chat is full." with **New chat**; the history stays readable. (S46 AS-41.)

---

### User Story 11 — The assistant sheet works on a phone and with a keyboard or screen reader (Priority: P2)

**Acceptance Scenarios**:

1. **AS-65** (layout) — **Given** the open sheet, **Then** at ≤ 640 px it covers the full width and height of the viewport (dynamic viewport height, so the on-screen keyboard never hides the composer); at ≥ 1024 px it is a panel anchored to the right edge, 28 rem wide, full height, with the page behind dimmed; both have, top to bottom: header (title, **Chats**, **New chat**, close), the transcript (the only scroller; tool chips above each answer), the allowance line, and the composer with the location switch, the counter and the Send/Stop control; the **Chats** list replaces the transcript inside the sheet (never a second overlay).
2. **AS-66** (keyboard and screen reader) — **Given** the sheet, **Then**: it is `role="dialog"` named by its title with a description; on open focus goes to the message field (signed in) or the **Sign in** link; Tab order is **Chats**, **New chat**, close, transcript tool/answer links, the field, location switch, **Send**/**Stop generating**; the transcript is `role="log"` with `aria-label="Conversation with the assistant"` and `aria-busy="true"` while a reply streams, **not** `aria-live` for streamed text; announcements come only from two visually hidden polite regions: "The assistant is answering…" when a reply starts and "Answer ready" (or the note of AS-57/58) when it ends; user and assistant bubbles carry the hidden prefixes "You said:" and "Assistant said:"; the Stop control has the name "Stop generating" and keeps its place in the tab order; every inline alert is `role="alert"`; reduced-motion users get no spinner animation or smooth scrolling.

---

### User Story 12 — Everything rides on the same rules (Priority: P3)

**Why this priority**: correct data flow is what keeps the two features safe and testable (constitution VI).

**Acceptance Scenarios**:

1. **AS-67** (calls and secrets) — **Given** the code of this capability, **Then** no component or hook calls `fetch`, `axios` or `EventSource`; every request and stream lives in `lib/api/chat.ts`, `lib/api/assistant.ts` and `lib/realtime/*`; every URL is same-origin and relative; no request carries a token from JavaScript (the session cookie and W01's CSRF header are the only credentials; `streamSse` stops reading an access token); there is no `localStorage`/`sessionStorage` entry holding a token, text of a message, or a position (only the ids and flags of FR-071); no `dangerouslySetInnerHTML`.
2. **AS-68** (state has one home) — **Given** server data (inbox, history pages, conversations, usage, presence), **Then** it lives only in TanStack Query under the keys of `lib/query-keys.ts` (`queryKeys.chat.*`, `queryKeys.assistant.*`, FR-070), never copied into `useState`, Context or a store; the view state "which chat is open" is the URL (`?channel=`); everything else (draft, reply target, pending bubbles, streaming reply, location switch, open sheet) is local state in the lowest component that needs it; no new Context, no global store.
3. **AS-69** (rendering) — **Given** `/chat`, **Then** its page is a Server Component that reads the request (`searchParams`, session) inside a `<Suspense>` boundary, redirects anonymous visitors on the server, reads the first inbox page on the server and hands it to the client views through the query cache's hydration, and passes client components only the fields they render; the static shell (navbar, page frame, skeletons) is prerendered; nothing in either feature uses `"use cache"` for member data (it is private and per-user); `/chat` responses are `private, no-store`. The assistant sheet is a client island that loads nothing until opened.
4. **AS-70** (contract tolerance) — **Given** responses and stream events, **Then** every response parses with the `packages/contracts` schema named in FR-072 and a mismatch is treated as the unexpected error of FR-062 (never shown as data); stream frames parse per the event schemas; an unknown event name or a `data` that is not valid JSON is skipped and counted in the console (development only), never shown, never ending the stream; heartbeat comments are ignored; unknown fields are ignored.

---

### Edge Cases

- A message the member sent arrives again through sync or a live hint with the same `id`: replaced, never duplicated (AS-14, AS-25).
- Two tabs of the same member: both read the same inbox; each marks read independently; the larger position wins on the server (S24 Edge Cases); the sheet's remembered conversation is per tab.
- Gateway-written messages may lack `seq` in a live push (S24 Assumptions): the page treats pushes as hints only and reads `seq` from sync/HTTP, so no row is ever ordered by arrival.
- The member sends 11 messages in 10 s: the 11th follows AS-19 while the first ten are unaffected.
- A chat is archived while the member types: the live hint or the next send flips the composer (AS-18) and the draft is kept.
- A product behind a chat is archived: nothing changes in the chat (S24 Assumptions); **View product** may lead to a not-found page owned by W02.
- The assistant sends `meta` twice (a replay attach after a reload): the bubble is rebuilt from scratch, never doubled (AS-50).
- The assistant stream contains a `text` event after `done`: ignored (the server guarantees none, S46 AS-10; the page still treats the first terminal event as final).
- Retry-After values above one hour or below one second are displayed with FR-063's rounding.
- Very long chats (thousands of messages) stay responsive: only loaded pages are in memory, older pages load on request (AS-13), and a page of 50 never re-renders the whole list on an incoming message.

## Requirements *(mandatory)*

### Functional Requirements

**Routes, guards and links**

- **FR-001**: `/chat` accepts exactly two query parameters: `channel` (a channel UUID; the open chat) and `product` (a product UUID; a one-shot resolver). Any other parameter is ignored. A malformed `channel` shows the unavailable state of FR-015 (no request); a malformed `product` shows the invalid-link copy of AS-05 (no request). `product` is always replaced by `channel` once resolved (AS-01).
- **FR-002**: `/chat` is guarded on the server with W01's `requireServerSession(returnTo)` where `returnTo` is the full address including its query, before any member data is read; the guard is a convenience only: every API call is authorized again (VI.5, AS-06, AS-40).
- **FR-003**: `lib/chat/links.ts` exports `chatHref({ product } | { channel } | {}): string` so other capabilities never hand-build the address.
- **FR-004**: The assistant is opened only through `<AssistantLauncher />`; there is no window-level custom event and no sheet mounted in the root layout (AS-41, AS-67).

**Chat: inbox and conversation**

- **FR-010**: The inbox reads `GET /chat/channels/mine?limit&cursor` (FR-072; one call returns channel fields, `unread`, `lastSeq`, `lastMessageAt`) — never one request per chat (VI.9) — and the open conversation reads `GET /chat/channels/{id}` for its `myRole`, `isArchived`, `sellerId`, `productId` and `title` (AS-07, AS-12).
- **FR-011**: Conversation history is read newest-first in keyset pages of 50 and held as one infinite query per chat; catch-up (FR-041) writes merged messages into the same query entry; the list is derived from that entry only (AS-12, AS-13, AS-25).
- **FR-012**: A message is identified by `id`; ordering is by `seq` once known; a pending bubble (no `seq` yet) sorts after every confirmed message and in the order of sending (AS-14, AS-22).
- **FR-013**: Unread, archived, banned and role information shown comes from the server fields (`unread`, `isArchived`, `myRole`); the page never derives them from loaded messages (AS-07).
- **FR-014**: Opening a chat from a product page resolves in this order: by-product lookup → join when `myRole` is null → open; create only on the explicit button of AS-04 (AS-01–AS-05).
- **FR-015**: Unavailable chat state (used for `403`/`404`/`revoked` on a chat): the pane shows "This chat isn't available." with **Back to all chats**; the chat leaves the inbox; nothing cached for it is shown (AS-27, AS-40).

**Chat: sending**

- **FR-025**: Enter sends and Shift+Enter inserts a newline in both composers; Enter never sends during IME composition (`isComposing`), nor when the draft is empty after trimming, nor while a send for the same draft is in flight (AS-15, AS-45).
- **FR-026**: `clientMessageId` is a UUID created **once per user action** (when the draft is first submitted) and stored with the pending bubble; every retry of that bubble, manual or automatic, reuses it; a changed body or reply reference is a new action with a new id (AS-16, AS-17; S24 FR-011).
- **FR-027**: A pending bubble has exactly the states `sending`, `failed(network|refused)`, `confirmed`; `confirmed` replaces the bubble by the stored message (the response's `message`, `duplicate` ignored); a bubble leaves `failed` only by Retry, automatic retry (network failures only, once per reconnection) or Discard (AS-16, AS-17).
- **FR-028**: The send button and Enter are disabled for archived chats, muted members until `mutedUntil`, banned members and a loading failure; the reason is always visible text next to the composer (AS-18).

**Chat: realtime, catch-up, receipts, presence**

- **FR-040**: The page opens one live connection `GET /api/streams?topics=…` through the shared connection of W03 (FR-045) containing `chat:<channelId>` for the open chat and for up to 8 other chats with the latest activity (a connection holds at most 10 topics, S51 FR-008, together with the member's `user:<id>`); the topic set changes without a page reload as the open chat changes; chats beyond the cap rely on the inbox refresh of AS-10.
- **FR-041**: The catch-up is the single recovery routine: sync (`POST /chat/sync`) for every loaded chat, looping on `hasMore`, then re-read of the inbox, then clearing the "Reconnecting…" banner. It runs after: a live hint, a (re)opened connection, `online`, tab visible, `resync`, and on the intervals of AS-23/AS-24. Concurrent triggers share one run (single flight) and a trigger during a run schedules exactly one more run after it.
- **FR-042**: Back-off for recreating a closed connection is 1, 2, 4, 8, 16, then 30 s, each randomised by ±20 %, reset by an open connection that lasted 30 s (AS-28).
- **FR-043**: Live events on `chat:<id>` are *hints*: `message {channelId, messageId, seq?}`, `message_deleted {channelId, messageId}` and `channel_archived {channelId}` (when the hub carries them, FR-072) trigger the catch-up or the flag they name; `read {userId, seq}` and `presence {userId, online, ttlSeconds}` update receipts and presence; the page never renders a message from a hint's payload (AS-23).
- **FR-044**: Receipts: positions of other members come from `read` events and, when the endpoint exists (FR-072), from `GET /chat/channels/{id}/receipts` read when a small chat opens and after `resync`; "Seen by" counts distinct other members with position ≥ the message's `seq` (AS-33).
- **FR-045**: The page uses W03's shared live connection (`subscribeTopics`, FR-072) so a page never holds more than one stream (S51 A-14); if W03's connection manager is not available at implementation time, `lib/realtime/chat-stream.ts` is the single owner of the page's connection with the same behaviour (reconnect, `resync`, `revoked`, recreate rule).
- **FR-046**: Presence heartbeat and read are best-effort and never produce a visible error (AS-35); read-marking calls follow AS-31 and AS-36.

**Assistant: send, stream, resume**

- **FR-050**: A send is `POST /assistant/conversations/{id}/messages` with header `Idempotency-Key` (FR-026-style: one per user action, reused for the same unsent text) and body `{text, lat?, lng?}`; the answer is read as a stream of frames `meta`, `text`, `tool`, one terminal `done`/`refusal`/`error`; the stream is read by `lib/api/assistant.ts` which returns typed events to the hook; the browser reads only same-origin URLs with the session cookie (AS-42, AS-45, AS-67).
- **FR-052**: Resume (AS-49, AS-50) uses `GET /assistant/messages/{messageId}/stream` with `Last-Event-ID` set only from the last received event's `id`; a continuation never restarts text; a replay from scratch (no header) always rebuilds the bubble; strictly increasing event ids are asserted and an id that does not increase is ignored (AS-49, AS-70).
- **FR-053**: One reply is active per conversation in the page's state machine with the closed phases `idle | sending | streaming | reconnecting | stopping | ended(done|refused|error|stopped|lost)`; transitions are performed by a pure reducer so impossible combinations (for example `stopping` with `idle`) cannot be represented (AS-42, AS-49, AS-52).
- **FR-054**: Stop uses `POST /assistant/messages/{messageId}/cancel` once per reply; the page does not abort its own read on press (the terminal `CANCELLED` arrives and ends it; an abort of the local read happens only if the server has not ended the stream within 5 s) (AS-52).
- **FR-055**: The remembered state (FR-071) never contains message text except the single pending question needed by AS-50, never a token, never a location, and is removed on the reply's end, on conversation delete and on sign-out.
- **FR-056**: History is read with `GET /assistant/conversations/{id}/messages` and shown as returned (`text`, `tools`); the page never shows the per-turn context line or any thinking text (the API does not send it, S46 AS-08).
- **FR-057**: Usage: `GET /assistant/usage` on first open per sign-in and on `done.allowance`; the meter shows `floor(used / limit × 100)` capped at 100 and the reset date; when `limit` is 0 or unknown nothing is shown (AS-47).
- **FR-058**: Conversation list, create (on first send), delete use S46's endpoints with keyset pages of 20; the list is one query; a created conversation is added to the list's cache and the list is invalidated at the end of each reply (AS-48, AS-61).

**Errors, copy, caching, keys, contracts, observability**

- **FR-060**: Every error shown is derived from the RFC 9457 body (`code`, `status`, `Retry-After`, `requestId` and the extension members `mutedUntil`, `used`, `limit`, `resetsAt`, `messageId`, `category`) through W01's `problemFromError`/`<ProblemAlert />` where the shape fits, and through the typed extension parsers in `lib/api/chat.ts` / `lib/api/assistant.ts` for the extension members; the message text comes only from this spec's copy (server `detail`/`title` are never shown) (AS-05, AS-18, AS-56).
- **FR-061**: Stream-level errors (`error` events) carry a `code` and no request id; their copy is AS-57's table (AS-57).
- **FR-062**: Unknown codes fall back by status class (4xx "Something didn't work. Check the details and try again."; 5xx, network or unparsable "Something went wrong. Try again." plus "Reference: {requestId}" when known); never stack, SQL, provider or upstream text (V.3).
- **FR-063**: Waits from `Retry-After` / `retryAfterMs` are shown as W01 FR-041 specifies ("{n} seconds", "{n} minutes", "{n} hours"; unknown "a moment"); controls the wait disables are re-enabled by a timer without a reload.
- **FR-070**: `lib/query-keys.ts` gains, and every query of this capability uses only: `chat.inbox()`, `chat.unreadTotal()`, `chat.channel(channelId)`, `chat.byProduct(productId)`, `chat.messages(channelId)`, `chat.receipts(channelId)`, `chat.presence(userId)`; `assistant.conversations()`, `assistant.history(conversationId)`, `assistant.usage()`; `chat.all` and `assistant.all` exist as invalidation prefixes only. The current `chat.channels` and `chat.messages(channelId)` entries are replaced.
- **FR-071**: The only data this capability keeps in the browser: per tab (session storage) `assistant.active = { conversationId, messageId?, pendingText?, idempotencyKey? }` and a "sheet was open" flag; nothing else; both removed at sign-out (AS-48, AS-50, AS-55, AS-67).
- **FR-072**: Contracts consumed (names exact; see *Cross-capability contracts*): the nine S24 schemas, the S46 schemas, `problemSchema`, and the additive asks in *Requires*. Every response is parsed with its schema in `lib/api/*`; hand-written duplicates (`ChatChannel`, `ChatMessage`, `ChannelSync`, `Conversation`, `AssistantHistoryMessage`) are removed (V.2, AS-70).
- **FR-073**: Cache lifetimes in the browser: inbox 15 s, `chat.unreadTotal` 30 s, `chat.channel` 60 s, `chat.messages` 0 s stale on reconnect (invalidated by FR-041), presence 30 s, `assistant.conversations` 60 s, `assistant.history` 0 s while a reply runs and 60 s otherwise, `assistant.usage` 0 s on `done`. The server caches none of this data (AS-69).
- **FR-074**: Console and metrics: the page logs nothing containing message text, positions of other members, coordinates or tokens; client-side failures are counted by name only (`chat_sync_failed`, `chat_stream_recreated`, `assistant_resume_failed`) through the platform's client error reporter when present (no new dependency introduced by this spec).

### Key Entities *(include if feature involves data)*

- **Inbox row**: one chat of the member: `channelId`, title, `productId`, `isArchived`, `myRole`, `unread`, `lastSeq`, `lastMessageAt`.
- **Conversation view**: the open chat: its channel fields, the loaded messages (confirmed and pending), the scroll anchor, the draft, the reply target, the connection banner state.
- **Pending message**: a bubble not yet confirmed: `clientMessageId`, body, optional reply reference, state (`sending`, `failed`), failure kind.
- **Receipt / presence view**: other members' read positions and the seller's online flag, both live and never stored.
- **Assistant turn**: a user question plus its assistant reply, with the reply's phase, `messageId`, last event id, text, tool chips, and terminal outcome.
- **Remembered assistant state**: the per-tab pointer of FR-071.
- **Reply phase**: the closed set of FR-053.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A message a member sends appears in their conversation within 100 ms of pressing Send and is never shown twice, across 1,000 randomised combinations of lost responses, retries and live deliveries (AS-14, AS-16, AS-25).
- **SC-002**: After any interruption of connectivity, up to one hour, 100 % of the messages posted meanwhile appear once, in order, within 5 seconds of the connection coming back, in as many catch-up calls as the backend's page size needs (AS-24, AS-25).
- **SC-003**: The unread number a member sees equals the server's count in 100 % of observed states and is never negative, never counts the member's own messages, and never decreases for messages that were not on screen (AS-07, AS-31).
- **SC-004**: A message from another member is visible within 2 seconds when the live connection works and within 20 seconds when it does not (AS-23, AS-24).
- **SC-005**: The first words of an assistant answer are on screen as soon as the first piece arrives (no waiting for the full answer), and a connection drop of up to 10 seconds during an answer loses and repeats no words (AS-42, AS-49).
- **SC-006**: A member can stop an answer and sees the stop confirmed within 2 seconds, and sending the same question again after a lost response never produces two answers or two charges (AS-52, AS-54).
- **SC-007**: Every error either backend can return is shown as a specific sentence that says what happened and what to do, in the same place the member is working, with no technical text, in 100 % of the codes of AS-05, AS-18, AS-56, AS-57 (checked by a table-driven test).
- **SC-008**: Both features can be completed with the keyboard alone and announce their state changes (new message, reconnecting, answer started, answer ready, errors) through status regions, with zero serious or critical accessibility violations on every state captured in the visual suite at mobile and desktop widths (AS-39, AS-66).
- **SC-009**: At 390 px width no page scrolls horizontally, the composer is never covered by the on-screen keyboard, and all interactive controls are at least 44 × 44 px (AS-38, AS-65).
- **SC-010**: No credential, message text or location is ever readable from browser storage or the console by script on the page (AS-67, FR-055, FR-074).

## Assumptions

- **Decisions marked `[BREAKING]` / `[CONTRACT]` / `[LOCAL]` are listed one per line in `questions.md`**; this spec adopts each default stated there.
- **The browser session is the S48 token handler** (W01): the web app uses same-origin relative URLs with the HttpOnly session cookie; the BFF attaches the bearer for `/api/chat/*`, `/api/assistant/*` and `/api/streams` (W01 C-FWD). Today's reading of an access token in `streamSse`, the cross-origin `NEXT_PUBLIC_SSE_URL` and the `Authorization` header from JavaScript are removed.
- **There is no display name**: authors are labelled "You", "Seller" (the chat's `sellerId`) or "Buyer {4}"; other shop staff who reply appear as "Buyer {4}" until the identity domain publishes a display name (S24 Assumptions).
- **Chat uses the realtime hub only for hints, receipts and presence**; `read`/`presence` are published by S24 today; `message`, `message_deleted`, `channel_archived` hints on `chat:<id>` are requested as a `[CONTRACT]`. The page is correct without them (polling fallback of AS-23/AS-24).
- **Joining a public product chat is implied by pressing "Chat with seller"** (explicit action on the product page); a deep link `?channel=` never joins.
- **Moderation screens are not built**; only delete-message is offered.
- **Copy is English-only** and is the catalogue in the scenarios; times use the viewer's locale and zone.
- **Assistant history ids**: the assistant message `id` in history equals the `messageId` of the stream's `meta` (needed for AS-51); `[CONTRACT]` with S46.
- **A running reply survives sheet close and in-app navigation** because the launcher lives in the persistent navbar; it does not survive tab close beyond the server's grace period.
- **The assistant's conversation pointer is per tab** (session storage): a new tab starts empty and can open any conversation through **Chats**.
- **The allowance meter shows percentages**, not raw token counts (tokens mean nothing to a shopper).
- **Visual regression** compares layout states at 390 × 800 and 1280 × 800 with the backend stubbed; copy and behaviour are proven by unit and journey tests.
- Next.js behaviour relied on (checked in `packages/web/node_modules/next/dist/docs`, Next 16 with Cache Components): request data (`searchParams`, cookies) is read only inside `<Suspense>`; member-specific data is not cached with `"use cache"`; client components receive only serialisable, minimal props; `Link` navigation to `/chat?channel=…` is a soft navigation that keeps the layout (and the launcher) mounted.

## Cross-capability contracts

Earlier specs searched (`grep -rl` over `specs/domains`, `specs/web`, `specs/journeys` for `W05` and `web`; `specs/journeys` does not exist): **S24, S46, S51** name W05 and are honoured in *Requires*; **W01, W02, W03** name W05 and are honoured; **S48** (chat unread in the product-page aggregate, forwarding) and **W04** (may link to chat) are touched. Differences from what an earlier spec assumed are `[CONTRACT]` lines in `questions.md`.

### Provides

Exact names; modules are in `packages/web`.

- **Route** `/chat` with query `channel=<channelId>` and `product=<productId>` (W02's **Chat with seller** link `/chat?product=<id>` keeps working; W04 may link the same way).
- **`chatHref(target: { product: string } | { channel: string } | Record<string, never>): string`** (`lib/chat/links.ts`) → `/chat?product=…`, `/chat?channel=…`, `/chat`.
- **`<AssistantLauncher variant="icon" | "menu-item" />`** (`components/assistant/assistant-launcher.tsx`, client): the "AI Assistant" button plus the sheet it owns; replaces `<AssistantSheet />` in `app/layout.tsx` and the `toggle-assistant` window event in `components/layout/navbar.tsx`. Mounted by W07 (navbar and mobile menu); renders for anonymous visitors too (sign-in prompt inside the sheet).
- **`<ChatNavBadge />`** (`components/chat/chat-nav-badge.tsx`, client) and **`useChatUnreadTotal(): number | null`** (`null` while unknown or anonymous): optional for W07's navbar (AS-11).
- **`queryKeys.chat.{all, inbox(), unreadTotal(), channel(id), byProduct(id), messages(id), receipts(id), presence(userId)}`** and **`queryKeys.assistant.{all, conversations(), history(id), usage()}`** (`lib/query-keys.ts`).
- **`lib/api/chat.ts`** → `chatApi.{inbox, unreadPage, channel, byProduct, create, join, history, send, sync, markRead, remove, receipts, heartbeat, presence}`; **`lib/api/assistant.ts`** → `assistantApi.{listConversations, createConversation, deleteConversation, history, send, resume, cancel, usage}` (stream functions deliver typed events); both parse with `packages/contracts` schemas.
- **Playwright helpers** (`tests/helpers.ts`): `openAssistant(page)` (clicks "AI Assistant", waits for the dialog) and `askAssistant(page, text)` (fills, presses Enter) used by W02's "Ask this product" tests if needed; `openProductChat(page, productId)`.
- **Behavioural guarantees**: a message is never shown twice and never sent twice by a retry; unread shown is the server's number; the assistant never starts a second reply for a conversation while one runs and never re-sends a question automatically; no request of this capability carries a token from JavaScript; every `401` runs W01's flow once.

### Requires

- **S24** (`chat`), under `/api`, schemas in `packages/contracts` (`chatChannelSchema`, `chatMessageSchema`, `sendMessageRequestSchema`, `sendMessageResponseSchema`, `chatMessagePageSchema`, `chatSyncRequestSchema`, `chatChannelSyncSchema`, `chatUnreadPageSchema`, `markReadRequestSchema`, `markReadResponseSchema`, `presenceResponseSchema`): `GET /chat/channels/by-product/:productId`, `GET /chat/channels/:channelId` → `{id, productId, shopId, sellerId, title, isArchived, archivedAt, createdAt, updatedAt, myRole}`; `POST /chat/channels {productId, title?}`; `POST /chat/channels/:id/join`; `POST /chat/channels/:id/messages {clientMessageId, body, replyToId?}` → `201|200 {message: {id, seq, authorId, body: string | null, replyToId: string | null, createdAt, deleted}, duplicate}`; `GET /chat/channels/:id/messages?limit&cursor` → `{items, nextCursor}`; `DELETE /chat/channels/:id/messages/:messageId` → `204`; `POST /chat/sync {cursors}` → `{channelId, messages, lastSeq, hasMore}[]`; `GET /chat/unread?limit&cursor` → `{items: {channelId, unread, lastSeq}[], nextCursor}`; `POST /chat/channels/:id/read {seq}` → `{lastReadSeq, unread}`; `POST /chat/presence/heartbeat` → `204`; `GET /chat/presence?userIds=` → `Record<UserId, {online, lastSeenAt}>`; problem codes `validation_failed`, `channel_not_found`, `permission_denied`, `product_not_found`, `channel_exists`, `product_archived`, `banned`, `muted` (+ `mutedUntil`), `channel_archived`, `idempotency_key_reuse`, `reply_target_invalid`, `rate_limited` (+ `Retry-After`), `too_many_channels`, `presence_unavailable`, `invalid_transition`. Hub topic `chat:<channelId>` events `read {userId, seq}`, `presence {userId, online: true, ttlSeconds: 60}`.
  - **New asks (`[CONTRACT]`)**: (a) **`GET /chat/channels/mine?limit&cursor`** → `{items: (chatChannel & {unread: number, lastSeq: number, lastMessageAt: string | null})[], nextCursor}` (the member's `ACTIVE` channels, archived included, newest `lastMessageAt` first, keyset; `limit` 1–100, default 50) — replaces `unread` + N× `GET /chat/channels/:id`; (b) hub events **`message {channelId, messageId, seq}`**, **`message_deleted {channelId, messageId}`**, **`channel_archived {channelId}`** on `chat:<id>` with `replay: false`; (c) **`GET /chat/channels/:id/receipts`** → `{items: {userId, lastReadSeq}[], suppressed: boolean}` (active members only; `suppressed: true` and no items above 50 members); (d) optional `authorIsShopStaff` on `chatMessageSchema` for the "Seller" label (not required).
- **S46** (`assistant`), under `/api`: `POST/GET /assistant/conversations`, `DELETE /assistant/conversations/:id`, `GET /assistant/conversations/:id/messages` → `{conversation: {id, title, updatedAt}, messages: {id, turnId, role, text, tools: string[]}[]}`, `POST /assistant/conversations/:id/messages` (`Idempotency-Key`, `{text, lat?, lng?}`) → `text/event-stream`, `GET /assistant/messages/:messageId/stream` (`Last-Event-ID?`), `POST /assistant/messages/:messageId/cancel` → `202 {cancelling: true}`, `GET /assistant/usage` → `{used, limit, resetsAt}`; schemas `assistantConversationSchema`, `assistantConversationListSchema`, `assistantHistorySchema`, `assistantSendMessageRequestSchema`, `assistantStreamEventSchema`, `assistantUsageSchema`; events `meta {messageId, conversationId}`, `text {t}`, `tool {id, name, status: 'running' | 'done' | 'failed'}`, `done {stopReason, truncated, usage, allowance: {used, limit}}`, `refusal {category, source}`, `error {code, retryAfterMs?}`; error codes `CANCELLED`, `GENERATION_LOST`, `PROVIDER_UNAVAILABLE`, `TURN_TIMEOUT`, `MODERATION_UNAVAILABLE`, `INTERNAL`; problem codes `validation_failed`, `invalid_cursor`, `invalid_last_event_id`, `unauthenticated`, `not_found`, `generation_not_found`, `turn_in_progress`, `conversation_full`, `generation_finished`, `idempotency_in_flight` (+ `messageId`), `idempotency_key_required`, `idempotency_key_reuse`, `input_rejected` (+ `category`), `rate_limited`, `quota_exceeded` (+ `used`, `limit`, `resetsAt`), `assistant_busy`, `too_many_active_turns`, `assistant_unavailable`; response header `Idempotent-Replay: true`. **New ask (`[CONTRACT]`)**: the `id` of an assistant message in history equals the stream's `meta.messageId`.
- **S51** (`realtime`): `GET /api/streams?topics=` frames and cursor behaviour as in FR-001 to FR-020, in-band `resync` and `revoked`, final refusals `401/403/429/503` before the stream starts, `retry:` jitter.
- **W01**: `requireServerSession(returnTo)`, `loginHref(returnTo)`, `useAuth()` (read-only; `status`, `user`), `problemFromError`, `<ProblemAlert />`, `csrfHeaders()`, the session-ended flow, `BroadcastChannel('auth')`, cache emptying at sign-out; `streamSse`'s token reading is removed.
- **W03**: **`subscribeTopics(topics: string[], handler: (e: { topic: string; type: string; data: unknown }) => void): () => void`** and `useStreamStatus(): 'connecting' | 'open' | 'reconnecting'` in `lib/realtime/` — the page's single ref-counted connection that already carries `user:<id>`, with `resync`, `revoked`, back-off and the 401/403 recreate rule (`[CONTRACT]`; W03 only promises `useUserStream` today and says W04/W05 "may add their topics").
- **W02**: `productHref(productId)`; the **Chat with seller** link `/chat?product=<id>`.
- **W07**: mounts `<AssistantLauncher />` (navbar and mobile menu) and optionally `<ChatNavBadge />`; removes the `toggle-assistant` dispatch and the layout-level `<AssistantSheet />`; provides `<main>`, the skip link, global error and not-found pages and a CSP allowing same-origin connections only for these features.
- **S48** (BFF): same-origin forwarding with the bearer attached (W01 C-FWD) for `/api/chat/*`, `/api/assistant/*` (including the POST event stream and the resume stream, unbuffered, uncompressed, `Idempotent-Replay` and `Last-Event-ID` passed through) and `/api/streams`; `next.config.ts` rewrites that today send `/api/assistant/*` and `/api/streams` straight to the stream gateway must go through the forwarder. No new aggregate is needed (the inbox is one S24 call, `gaps.md`).
- **S50**: `Retry-After` and rate-limit headers on `429`, exposed to the browser.
- **`packages/contracts`**: the schemas named above (the package has no source today).

## Pattern coverage (pattern-map rows whose Specs column names W05)

| Pattern | Requirements | Scenarios |
|---|---|---|
| P0209 SSE / streaming responses | FR-050, FR-052, FR-053, FR-054, FR-061, FR-070, FR-071 | AS-42, AS-43, AS-44, AS-49, AS-50, AS-51, AS-52, AS-53, AS-54, AS-57, AS-58, AS-66, AS-70 |
| P0406 Push instead of poll (SSE) | FR-040, FR-041, FR-042, FR-043, FR-044, FR-045, FR-073 | AS-10, AS-23, AS-24, AS-25, AS-26, AS-27, AS-28, AS-29, AS-30, AS-33, AS-34 |
