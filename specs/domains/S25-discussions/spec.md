# Feature Specification: S25 — Product Discussions (posts, nested comments, votes, hot/top/new/best ranking, abuse controls, safe markdown) — domain `community`

**Feature Branch**: `S25-discussions` (spec directory `specs/domains/S25-discussions`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Capability S25 — Product discussion boards: posts, nested comments, votes, hot/top/new/best ranking, abuse controls, safe markdown (domain `community`)." Sources: `docs/showcase/sections/SD-11-product-discussions.md`; notes `10-System-Design/05-social-and-content.md` §11 (comments, voting and ranking) and §9 (deletes and privacy at hydration); notes `05-Security/01-web-security-xss-csrf-csp.md` §1 (XSS, sanitising user markdown), §3 (CSRF), §5 (safe errors); constitution v3.1.0; `docs/architecture/domain-map.md` (`community`, decision D5); `docs/architecture/pattern-map.md` rows P0320, P0323, P0501, P1108.

Companion files: [`questions.md`](questions.md) (decisions taken unattended, tagged), [`test-plan.md`](test-plan.md) (constitution VII.8 table), [`gaps.md`](gaps.md) (what today's code lacks, debt rows, IX.7 replacements).

## Scope

In scope:

- **Boards**: every product has exactly one discussion board, addressed by the product's ID. A board exists as soon as its product exists; there are no free-form or brand boards.
- **Posts**: a signed-in buyer writes a post (plain-text title, markdown body) on a product's board. The author or a moderator can delete it.
- **Nested comments**: comments on a post, replies to comments, up to a fixed depth. Threads of 50,000 comments stay cheap to read: top-level comments are paged, each carries its first few replies, and "load more" fetches further replies of one branch.
- **Votes**: one vote per user per post or comment (up, down, or none), changeable and retractable. Counts stay exact under concurrent voting.
- **Ranking**: posts by **hot**, **top** (with a time window) and **new**; comments by **best** (Wilson lower bound), **new** and **old**. Every list is cursor-paged in a deterministic order.
- **Abuse controls**: write and vote rate limits, ranking weight zero for votes from new accounts and shadow-banned accounts, no self-voting, shadow-ban, moderator removal, a vote-anomaly signal, size and depth limits.
- **Safe markdown**: user markdown is rendered to HTML through an allow-list; nothing executable ever reaches a reader. The raw markdown is kept; the rendition is versioned and re-checked on read.
- **Events**: post and comment lifecycle events for the feed (S26) and notifications (S28); a batch query for the feed to hydrate posts.

Out of scope (owners named):

- Follow graph, home feed, fan-out, timelines → **S26** (same domain, own spec). This capability only emits the events S26 consumes and exposes the batch query S26 hydrates with.
- Notification delivery (reply and mention notifications, preferences) → **S28**, which consumes this capability's events.
- Photos or files attached to posts (upload, EXIF, variants) → **S29**. Posts are text only; markdown images are not rendered.
- Search over discussions, "ask this product" Q&A → **S32**, **S47**.
- Editing a post or comment, locking or pinning threads, shop-level moderators (a shop moderating its own product board), user-facing "report" queues, IP-cluster analysis of votes. Recorded as assumptions; the stored raw markdown keeps the door open for editing.
- Product page layout, tabs, composition with other product data → **W02**, **S48** (R2).
- Authentication, CSRF, session cookies → **S01**; the rate-limiter engine → **S50**.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Start a discussion on a product (Priority: P1)

A buyer on a product page opens its discussion board and asks a question ("Does it work with USB-C?"), with a title and a markdown body. A double click on "Post" creates one post, not two. The post is the newest one on the board straight away.

**Why this priority**: without posts nothing else exists; the board is the capability's entry point.

**Independent Test**: sign in, post to a product's board, read the board sorted by new, see the post exactly once.

**Acceptance Scenarios**:

1. **AS-01** — **Given** an `ACTIVE` product `P` and a signed-in buyer `B`, **When** `B` sends `POST /api/boards/P/posts` with `Idempotency-Key: K1` and `{title: "Does it work with USB-C?", body: "Planning to use it with a **laptop**."}`, **Then** `201` with `{postId, boardId: P, authorId: B, title, bodyHtml: "<p>Planning to use it with a <strong>laptop</strong>.</p>", createdAt, ups: 0, downs: 0, score: 0, commentCount: 0, myVote: 0}`; `postId` is a time-based UUID whose embedded time equals `createdAt`; one post is stored with the raw markdown and the rendition; one `discussion.post_created` event is recorded (AS-07); and `GET /api/boards/P/posts?sort=new` returns it first.
2. **AS-02** — **Given** the create route, **When** `P` is unknown, **Then** `404 board_not_found`; **When** `P`'s product is `ARCHIVED`, **Then** `409 board_closed`; **When** the board ID is not a UUID (including the legacy `product-<uuid>` and `brand:<name>` forms), **Then** `400 validation_failed`; in every case nothing is stored and no event is recorded.
3. **AS-03** — **Given** the create route, **When** `title` is missing, not a string, shorter than 3 or longer than 300 characters after trimming (a character is one Unicode code point), contains a control character (U+0000–U+001F, U+007F) or a bidirectional override (U+202A–U+202E, U+2066–U+2069); **or** `body` is not a string or longer than 40,000 characters; **or** the body carries an unknown field; **or** nesting in `body` exceeds the markdown complexity limit (AS-12), **Then** each case returns `400 validation_failed` with the offending field and nothing is stored. An empty `body` is valid (title-only post). A title that contains markup (`<b>x</b>`) is valid and is stored and returned verbatim as text (AS-11).
4. **AS-04** — **Given** no credentials, **When** any state-changing route of this capability is called (create post, create comment, delete post or comment, vote, shadow-ban), **Then** `401` with a problem+json body and no store was touched.
5. **AS-05** — **Given** user `B` who already made 10 writes (posts and comments together) in the current minute, **When** `B` sends an 11th, **Then** `429 rate_limited` with `Retry-After`; the 10 earlier writes are stored and the 11th is not; **When** the minute passes (frozen clock), **Then** the next write succeeds.
6. **AS-06** — **Given** the create-post route, **When** `Idempotency-Key` is missing or not a UUID, **Then** `422 idempotency_key_required`; **When** the same user replays a completed key with the same body, **Then** `201` with the stored body, the same `postId`, exactly one post stored; **When** the same key is sent with a different title or body, **Then** `422 idempotency_key_reuse` and the stored post is unchanged; **When** five identical requests with a new key arrive concurrently, **Then** one creates the post and the others return either the stored result or `409 request_in_progress` (never a second post); **When** another user sends the same key, **Then** it is independent (scope is user + route) and creates that user's own post; **When** a completed key is replayed 24 hours and one second later, **Then** it is a new request and creates a second post.
7. **AS-07** — **Given** a successful post creation, **Then** exactly one `discussion.post_created` event is durably recorded with the write (same acceptance as the write: if the post exists, the event will be published); **Given** the event bus is unavailable at that moment, **When** the post is created, **Then** the request still returns `201`, and once the bus is back the event is published (at least once, every delivery carrying the same `eventId`); **Given** a post written by a shadow-banned author (AS-49), **Then** no event is recorded.

**Edge cases for this story**: a key replayed after the idempotency TTL (24 h, frozen clock) is a new request and creates a second post (AS-06); unknown product vs closed board (AS-02). Scenario numbers AS-08 to AS-12 belong to User Story 7 and are numbered here to keep the post-creation scenarios together.

---

### User Story 2 — Nested comments and threads (Priority: P1)

Readers answer a post and each other. Replies nest under their parent, a thread reads in a sensible order, and a huge thread never has to be loaded whole.

**Why this priority**: the conversation is the point of a board.

**Independent Test**: post, comment, reply to the comment, reply to the reply, read the thread in order, delete the middle comment and see the replies keep their place.

**Acceptance Scenarios**:

1. **AS-13** — **Given** a post and a signed-in user `U`, **When** `U` sends `POST /api/posts/:postId/comments` with `Idempotency-Key` and `{body}` (top level) or `{body, parentId}` (reply), **Then** `201` with `{commentId, postId, parentId: null | id, depth, authorId: U, bodyHtml, createdAt, ups: 0, downs: 0, score: 0, myVote: 0, deleted: false, replyCount: 0}`; top-level comments have `depth` 0, a reply has its parent's depth + 1; the post's `commentCount` rises by one; the parent's `replyCount` rises by one; one `discussion.comment_created` event is recorded.
2. **AS-14** — **Given** comments `a`, `b` (top level, `a` older), `a1` (reply to `a`) and `a1x` (reply to `a1`), **When** `GET /api/posts/:postId/comments?sort=old` is read, **Then** `items` are `[a, b]` in that order, `a.replies` is `[a1, a1x]` in thread order with depths `[1, 2]`, and `b.replies` is `[]`; **When** the order is `sort=new`, **Then** `items` are `[b, a]` while each branch's replies stay oldest-first (`a.replies` is still `[a1, a1x]`).
3. **AS-15** — **Given** the create-comment route, **When** `parentId` belongs to another post, is unknown, or belongs to a shadow-banned author other than the caller, **Then** `404 parent_not_found`; **When** the parent is deleted, **Then** `409 parent_deleted`; **When** the parent is at the maximum depth of 8, **Then** `422 max_depth_exceeded`; **When** `parentId` is not a UUID, **Then** `400 validation_failed`; in every case nothing is stored.
4. **AS-16** — **Given** the create-comment route, **When** the post is unknown, deleted, or shadow-banned and the caller is not its author, **Then** `404 post_not_found`; **When** the post's product is `ARCHIVED`, **Then** `409 board_closed`; **When** `body` is empty or whitespace only, longer than 10,000 characters, not a string, or the body carries an unknown field, **Then** `400 validation_failed`; **When** `Idempotency-Key` is missing, **Then** `422 idempotency_key_required`.
5. **AS-17** — **Given** a completed comment create with key `K`, **When** the same user replays `K` with the same body, **Then** `201` with the stored comment and `commentCount` unchanged; **When** `K` is reused with a different `body` or `parentId`, **Then** `422 idempotency_key_reuse`; **When** eight identical requests arrive concurrently, **Then** exactly one comment exists and `commentCount` is 1.
6. **AS-18** — **Given** a post with 12 top-level comments, each with replies, and the top-level partition size configured to 5, **When** the thread is read with `sort=old` and `limit=4`, **Then** the pages follow `nextCursor` and together return the 12 top-level comments exactly once, in creation order, across the partition boundaries, each with its replies attached to its own root (a reply never lands in another root's partition); **Then** the store reads performed for one page (observed at the store edge) return at most `limit × 6` rows in total, whatever the thread size.
7. **AS-19** — **Given** a frozen clock, **When** 50 users post top-level comments concurrently, **Then** 50 distinct comment IDs exist, all with `createdAt` equal to the frozen instant, none lost, their order is deterministic (time, then a stable tiebreak) and identical on every read, and `commentCount` is 50.
8. **AS-20** — **Given** a top-level comment with 12 replies, **When** the thread is read, **Then** `replies` holds the first 5 in thread order and `hasMoreReplies: true`; **When** `GET /api/comments/:commentId/replies?limit=5` and then `?cursor=` are followed, **Then** the remaining 7 come back in thread order exactly once; **When** the cursor is malformed, tampered with, or issued for another comment or post, **Then** `400 invalid_cursor`; **When** the comment is unknown, **Then** `404 comment_not_found`.
9. **AS-21** — **Given** a comment `c` by `U` with two replies, **When** `U` sends `DELETE /api/comments/c`, **Then** `204`; `c` is read as a tombstone `{deleted: true, deletedBy: "author", bodyHtml: "", authorId: null, ups, downs, depth, replyCount}` in its original position with both replies still attached; the raw markdown is erased from storage; `commentCount` falls by one; `discussion.comment_deleted` is recorded; **When** `U` sends the same delete again, **Then** `204` and `commentCount` does not fall again and no second event is recorded.
10. **AS-22** — **Given** a comment by `U`, **When** another ordinary user deletes it, **Then** `403 forbidden` and nothing changes; **When** an `ADMIN` or `MODERATOR` deletes it, **Then** `204` with `deletedBy: "moderator"`; **When** a `SELLER` who owns the product's shop deletes it, **Then** `403 forbidden` (no shop-level moderation); **When** the comment is unknown, **Then** `404 comment_not_found`.
11. **AS-23** — **Given** a parent comment being deleted while a reply to it is created concurrently, **When** both requests run in parallel (repeated 20 times), **Then** each run ends consistently: either the reply is stored under the tombstone (it arrived first) or it is refused with `409 parent_deleted` (it arrived second); never a reply whose parent is missing; `commentCount` equals the number of non-deleted comments.

---

### User Story 3 — Vote on posts and comments (Priority: P1)

A buyer votes up or down, changes their mind, or withdraws the vote. Counts are exact even when a launch day sends thousands of votes a second.

**Why this priority**: votes drive ranking and are the first thing a vote storm breaks.

**Independent Test**: vote +1, flip to −1, retract; the score moves by 1, −2, +1; 100 users vote at once and the count is exactly 100.

**Acceptance Scenarios**:

1. **AS-24** — **Given** a post `X` with no votes and user `V` (not the author), **When** `V` sends `PUT /api/votes/X` with `{value: 1}`, **Then** `200 {targetId: X, targetType: "post", ups: 1, downs: 0, score: 1, myVote: 1}`; **When** `V` sends `{value: -1}`, **Then** `{ups: 0, downs: 1, score: -1, myVote: -1}` (the score moved by 2); **When** `V` sends `{value: 0}`, **Then** `{ups: 0, downs: 0, score: 0, myVote: 0}`; the vote store holds one record for `(V, X)` after the first two calls and none after the third; the same holds for a comment target with `targetType: "comment"`.
2. **AS-25** — **Given** `V` already voted `1`, **When** `V` sends `{value: 1}` again, **Then** `200` with the same body as the first call, counts unchanged, one vote record; **When** `V` retracts a vote that does not exist (`{value: 0}`), **Then** `200` with `myVote: 0` and counts unchanged.
3. **AS-26** — **Given** the vote route, **When** `value` is missing, `2`, `-2`, `0.5`, `"1"`, `null`; **or** `targetId` is not a UUID; **or** the body carries any other field (including a client-supplied `targetType`), **Then** `400 validation_failed`; **When** the target is neither a known post nor a known comment, **Then** `404 target_not_found`; in every case no vote is stored.
4. **AS-27** — **Given** a post or comment authored by `V`, **When** `V` votes on it, **Then** `422 self_vote_not_allowed` and nothing is stored.
5. **AS-28** — **Given** a deleted comment, **When** anyone votes on it, **Then** `409 target_deleted`; **Given** a deleted post, **Then** `404 target_not_found`; neither changes any count.
6. **AS-29** — **Given** 100 distinct users, **When** all vote `+1` on one post concurrently, **Then** all 100 calls return `200`, the post reads `ups: 100`, the vote store holds 100 records, and an exact recount of the vote store equals the displayed counts.
7. **AS-30** — **Given** one user `V`, **When** five identical `PUT` requests for `{value: 1}` arrive concurrently, **Then** every response is `200` or `409 vote_in_progress` (with `Retry-After`), at least one is `200`, and the post reads `ups: 1`; **When** a `{value: 1}` and a `{value: -1}` from `V` race (repeated 20 times), **Then** the final state is exactly one of the two votes, `ups + downs` is 1, and the displayed counts equal an exact recount of the vote store.
8. **AS-31** — **Given** user `V` who already made 60 votes (including flips and retracts) in the current minute, **When** `V` votes again, **Then** `429 rate_limited` with `Retry-After`, the 60 earlier votes are stored and the 61st is not.
9. **AS-32** — **Given** a post read by `V` (signed in) and by an anonymous reader, **Then** `V`'s read carries `myVote` of `-1 | 0 | 1` and the anonymous read carries `myVote: null`; the same holds for every post and comment in lists and threads.

---

### User Story 4 — Browse a board: hot, top, new (Priority: P2)

A buyer opens a product's board and sorts by what is hot, what is best of the week, or what is newest, and pages as far as they like.

**Why this priority**: reading dwarfs writing; ranking decides what readers see.

**Independent Test**: post three posts, vote on one, read hot, top and new, page through with the cursor.

**Acceptance Scenarios**:

1. **AS-33** — **Given** a board with a post `O` (20 weighted up-votes) created one hour before a post `N` (no votes), **When** `GET /api/boards/P/posts?sort=hot` is read, **Then** `items` is `[O, N]`; **When** `N` receives 20 weighted up-votes (so both have the same net), **Then** `[N, O]`; **When** `sort=new`, **Then** always `[N, O]`.
2. **AS-34** — **Given** posts whose weighted net scores and ages are in the table of the hot formula (FR-032), **Then** each post's hot score equals the formula to 7 decimals, and the list order is hot score descending then `postId` descending; **When** two posts have identical hot scores, **Then** the newer one (greater `postId`) is first and the order is the same on every read.
3. **AS-35** — **Given** five posts on a board, **When** `limit=2` pages are followed through `nextCursor` for each of `hot`, `top` and `new`, **Then** the pages are of sizes 2, 2, 1, the last page has `nextCursor: null`, no post appears twice and none is missing while no votes arrive; **When** a vote between two page requests moves a post across the cursor position, **Then** no page contains a duplicate **within itself** and every post whose position did not change appears exactly once (a post that moved may appear in two pages or in none; clients de-duplicate by `postId`).
4. **AS-36** — **Given** posts created 1 hour, 6 days, 8 days, 40 days and 400 days ago (frozen clock) with scores 1, 5, 9, 3, 7, **When** `sort=top&window=week`, **Then** `items` are the 1-hour and 6-day posts ordered `[6-day (5), 1-hour (1)]`; `window=day` returns the 1-hour post only; `window=month` returns the first three posts ordered by score; `window=year` returns four posts; `window=all` (default) returns all five ordered `[9, 7, 5, 3, 1]`; a post created exactly one window ago is included; ties break by newer `postId` first.
5. **AS-37** — **Given** posts in the current month, 2 months ago and 30 months ago, **When** `sort=new&limit=25` is read and `nextCursor` followed, **Then** all posts are reachable newest-first with no gap and no duplicate, including the 30-month-old post (no fixed history horizon), and an empty board returns `{items: [], nextCursor: null}` quickly.
6. **AS-38** — **Given** a board configured so hot and top consider 3 posts, **When** 5 posts exist, **Then** `hot` and `top` list at most the 3 best-ranked posts and end with `nextCursor: null`, while `new` still reaches all 5.
7. **AS-39** — **Given** the board routes, **When** `sort` is anything other than `hot | top | new`, `window` is anything other than `day | week | month | year | all` (or is sent with a sort other than `top`), `limit` is below 1, above 50, or not an integer, or `cursor` is malformed, tampered with, or was issued for another board or another sort, **Then** `400 validation_failed` (or `400 invalid_cursor`), never a silent fallback; **When** none is sent, **Then** `sort=hot`, `limit=25`.
8. **AS-40** — **Given** a board for a product that does not exist or has no posts, **When** it is read, **Then** `200 {items: [], nextCursor: null}` (reads never consult the catalog); **Given** a deleted post, **Then** it is absent from every list and `GET /api/posts/:postId` returns `404 post_not_found`.
9. **AS-41** — **Given** a post, **When** `GET /api/posts/:postId` is read by anyone (anonymous allowed), **Then** `200` with the post view of AS-01 plus current counts and `myVote`; **When** the ID is not a UUID, **Then** `400 validation_failed`; **When** unknown, **Then** `404 post_not_found`.

---

### User Story 5 — Best comments and cheap hot threads (Priority: P2)

Readers see the most helpful answers first, not the luckiest ones; a hot thread stays fast.

**Why this priority**: "best" is what makes a long thread usable; caching keeps launch-day threads online.

**Independent Test**: one comment with 1 up-vote and another with 9 up/1 down; "best" puts the second first.

**Acceptance Scenarios**:

1. **AS-42** — **Given** top-level comments `lucky` (1 up, 0 down) and `solid` (9 up, 1 down), **When** `sort=best`, **Then** `items` are `[solid, lucky]`; a comment with no votes ranks below both; **Then** each comment's best score equals the Wilson lower bound of FR-033 (table: `(0,0) → 0`, `(1,0) ≈ 0.2065`, `(90,10) ≈ 0.8256`, `(9,1) ≈ 0.5958` within 0.001); ties order older comment first and the order is stable across reads and across pages.
2. **AS-43** — **Given** a post's first comment page cached for readers, **When** a new comment is created, **Then** the next read by any reader (not only the author) already includes it (a write invalidates the cached page); **When** only votes arrive, **Then** the cached order may lag by at most 5 seconds (frozen clock: at +4 s the old order, at +6 s the new order); the cached page never contains a viewer's `myVote` (it is merged per request) and never a shadow-banned author's content for other viewers.

---

### User Story 6 — Keep the board clean: abuse controls and moderation (Priority: P2)

Fresh accounts and bad actors cannot steer rankings or flood a board; moderators can remove content and silence abusers without tipping them off.

**Why this priority**: an open board without these controls is a spam target on day one.

**Independent Test**: twenty brand-new accounts upvote a post; its ranking does not move. A moderator shadow-bans a spammer; the spammer sees their own posts, nobody else does.

**Acceptance Scenarios**:

1. **AS-44** — **Given** post `A` with 20 up-votes from accounts created 1 hour ago and post `B` (same age) with 1 up-vote from an account created 30 days ago, **When** the board is read by `hot` and by `top`, **Then** `B` ranks above `A` in both, while `A` displays `ups: 20` and `B` displays `ups: 1`; **Then** a vote's ranking weight is fixed when the vote is cast (0 for an account younger than 24 hours or for a shadow-banned voter, 1 otherwise) and is not changed when the account later ages; changing or retracting a vote replaces or removes its weight.
2. **AS-45** — **Given** the account-age lookup fails or the voter is unknown to the user directory, **When** the user votes, **Then** the vote is recorded and displayed with weight 0 for ranking, `200`, and a warning is logged.
3. **AS-46** — **Given** an `ADMIN` or `MODERATOR` `M` and user `S`, **When** `M` sends `PUT /api/moderation/shadow-bans/S`, **Then** `204`; **When** `S` then creates a post and a comment, **Then** both return the normal `201` bodies; the post appears in no board list and `GET /api/posts/:id` returns `404 post_not_found` for every other reader and `200` for `S`; `S`'s own `new` list includes it; the comment is omitted from other readers' threads and from public `commentCount`/`replyCount`; no event is recorded; `S`'s votes get weight 0; **When** `M` lifts the ban (`DELETE /api/moderation/shadow-bans/S`, `204`), **Then** content created before stays hidden and content created after is visible; repeating either call returns `204`; **When** an ordinary user calls either, **Then** `403 forbidden`; **When** `S` is unknown to the user directory, **Then** `404 user_not_found`.
4. **AS-47** — **Given** post `X` by `U`, **When** `U` sends `DELETE /api/posts/X`, **Then** `204`; `X` is absent from every list and its hot/top entries; `GET /api/posts/X` returns `404 post_not_found` to everyone but a moderator; its comments can no longer be read, created or voted on (`404 post_not_found`); `discussion.post_deleted` is recorded with `deletedBy: "author"`; **When** `U` repeats the delete, **Then** `204` with no second event; **When** another ordinary user deletes `X`, **Then** `403 forbidden`; **When** a moderator deletes a post, **Then** `204` with `deletedBy: "moderator"`; **When** the post is unknown or already deleted and the caller is not its author or a moderator, **Then** `404 post_not_found`.
5. **AS-48** — **Given** 10 votes with weight 0 (fresh or shadow-banned voters) arrive on one target within 10 minutes, **Then** exactly one `discussion.vote_anomaly_detected` event is recorded and a metric is incremented; further such votes within the next hour add no second event; votes keep working normally (the signal never blocks anyone).

---

### User Story 7 — Safe user content (Priority: P1)

Whatever someone types, readers' browsers never run it. Formatting works; scripts, handlers, dangerous links, embeds and tracking pixels do not survive.

**Why this priority**: stored XSS on a public board reaches every reader.

**Independent Test**: post a body full of known XSS payloads, read it back, assert no executable construct is present while bold, lists, code and safe links are kept.

**Acceptance Scenarios**:

1. **AS-08** — **Given** markdown using bold, italic, strikethrough, inline code, fenced code, blockquotes, ordered and unordered lists, headings (levels 3–4 kept, others become level 4), line breaks, `https`, `http` and `mailto` links, **When** it is rendered, **Then** the output uses only the tags `p, br, strong, em, del, code, pre, blockquote, ul, ol, li, a, h3, h4`; every `a` has `rel="nofollow ugc noopener noreferrer"` and `target="_blank"` and only the attributes `href`, `rel`, `target`; and the spec table in FR-040 holds case by case.
2. **AS-09** — **Given** each payload of the XSS corpus (script tags; `onerror`, `onload`, `onclick`, `onmouseover` attributes on any tag; `javascript:` links in every spelling — mixed case, entity-encoded, whitespace or control characters inside the scheme, inside markdown links and autolinks; `data:` and `vbscript:` links; `iframe`, `object`, `embed`, `svg`, `math`, `form`, `input`, `base`, `meta`, `link`, `style` elements; `style` attributes; markdown images `![x](https://evil.example/t.png)`; HTML comments; unclosed and nested-malformed tags; mutation-XSS patterns), **When** each is posted as a post body and as a comment body, **Then** the response and every later read contain none of: `<script`, `on[a-z]+=`, `javascript:`, `vbscript:`, `data:`, `<img`, `<iframe`, `<svg`, `<style`, ` style=`; the post is accepted (`201`) and the readable text remains where it was plain text; the stored raw markdown is exactly what was sent.
3. **AS-10** — **Given** a stored post whose rendition was written by an older, laxer policy (fixture: rendition contains `<img src=x onerror=…>` and has an older policy version, or none), **When** it is read through any list, post or thread route, **Then** the response body is clean per AS-09 (it is re-rendered from the raw markdown under the current policy, or re-sanitised), and an old rendition is replaced in storage lazily (next read of the same item finds the current version).
4. **AS-11** — **Given** a title `<img src=x onerror=alert(1)>` and a comment body whose rendition is empty, **When** posted and read, **Then** the title is returned byte-for-byte as a JSON string (never HTML-escaped by the server and never interpreted), responses have `Content-Type: application/json` and `X-Content-Type-Options: nosniff`, and no response field other than `bodyHtml` ever contains markup produced by the server.
5. **AS-12** — **Given** a body of 40,000 characters made of 20,000 nested `>` markers, or 5,000 nested list levels, or 10,000 unclosed `[`/`(` pairs, **When** it is posted, **Then** it is either rendered within 250 ms or refused with `400 validation_failed` (`markdown_too_complex`: more than 20 nested blockquote/list levels), never a timeout or a long stall; a normal 40,000-character body renders within 250 ms.

---

### User Story 8 — Dependable under failure and storms (Priority: P3)

Caches can be flushed, the broker can be down, the store can stall; votes are never lost, rankings recover, and users get clear answers.

**Why this priority**: it is what separates a demo from a board that survives launch day.

**Independent Test**: flush the ranking cache mid-test and read the board; stop the broker and post; time out the store and retry with the same key.

**Acceptance Scenarios**:

1. **AS-49** — **Given** a board with posts, votes and comments, **When** the ranking cache is emptied entirely, **Then** `GET` of a post returns the same `ups`, `downs`, `commentCount` as before; `hot`, `top`, `best` return the same order as before; no vote was lost; every cache entry created afterwards has an expiry (inspection of the cache after the reads: no key without a TTL).
2. **AS-50** — **Given** the displayed counts of a target drifted from the vote store (fixture: +3 ups injected into the live counter, and a stale durable counter), **When** the reconciliation job runs, **Then** the displayed counts equal an exact recount of the vote store, the ranking entries are recomputed, and one warning with the drift amount is logged; a second run changes nothing.
3. **AS-51** — **Given** the ranking cache is unavailable, **When** `sort=new`, `GET post` and `sort=old` are read, **Then** they return `200` as usual; **When** `sort=hot`, `top` or `best` is read, **Then** `200` with `degraded: true` and an order computed from the board's most recent 200 posts (resp. the thread's top-level comments) from the durable store, correct within that bound; **When** a vote is cast, **Then** `503 service_unavailable` with `Retry-After` and no vote recorded; **When** a post or comment is created, **Then** `201` as usual and, when the cache returns, the rankings include it.
4. **AS-52** — **Given** the durable store exceeds its timeout during a post creation, **When** the client retries with the same `Idempotency-Key`, **Then** the first attempt returned `503 service_unavailable` (generic `detail`, no store message, a `requestId`), and after the retry exactly one post exists whichever attempt actually stored it; no `5xx` body ever contains a stack trace, store name or query text.
5. **AS-53** — **Given** any error, **Then** the response is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `requestId` and a stable `code` from this spec; for `5xx` `detail` is generic.
6. **AS-54** — **Given** posts and comments whose bodies contain a marker string, **When** they are created, voted and deleted, **Then** the captured log stream contains `requestId` on every line, contains neither the marker nor any body, title or raw markdown, and contains no e-mail address; metrics for votes cast, writes, rate-limited calls, degraded reads, drift repaired and anomalies are emitted.
7. **AS-55** — **Given** frozen time and a bursty creation of posts and comments, **Then** time-based identifiers are unique and ordered by creation time: sorting posts by `postId` equals sorting by `createdAt` (ties in the same millisecond broken stably), and `createdAt` is derivable from the ID; `GET` requests never change any stored state (counts, caches excepted).

---

### Edge Cases

All edge cases are scenarios above; the index below points to them.

| Edge case | Scenario |
|---|---|
| Concurrency: double submit, parallel voters, same-user vote race, reply vs delete, bucket spill | AS-06, AS-17, AS-19, AS-23, AS-29, AS-30, AS-18 |
| Idempotent replay (post, comment, vote, delete, shadow-ban) | AS-06, AS-17, AS-25, AS-21, AS-47, AS-46 |
| Illegal state transitions (reply to deleted, vote on deleted, comment on closed board) | AS-15, AS-16, AS-28, AS-47 |
| Cross-user / privilege (delete others', moderator-only, seller no special right, shadow content) | AS-22, AS-46, AS-47 |
| Limits (sizes, depth, page size, rate limits, ranking cap, complexity) | AS-03, AS-05, AS-12, AS-15, AS-31, AS-38, AS-39 |
| Timeouts, outages, degradation | AS-07, AS-51, AS-52 |
| Out-of-order or duplicate events (event delivery at least once; counter drift) | AS-07, AS-50 |
| Time (frozen clock, windows, month boundaries, age weight) | AS-36, AS-37, AS-43, AS-44, AS-55 |

## Requirements *(mandatory)*

### Functional Requirements

**Boards and posts**

- **FR-001**: Every product MUST have exactly one board addressed by the product's UUID. Creating a post or comment MUST verify the product through the catalog's exported batch lookup (R1, `ProductQueryService.getProductsByIds`): unknown → `404 board_not_found`, `ARCHIVED` → `409 board_closed`. Reads MUST NOT call the catalog (AS-02, AS-40).
- **FR-002**: Creating a post MUST validate title (3–300 code points after trim, no control or bidirectional-override characters) and body (≤ 40,000 code points, may be empty) and reject unknown fields (AS-03).
- **FR-003**: Post and comment IDs MUST be time-based UUIDs whose embedded time is `createdAt` (read from the injected clock), unique under concurrent creation, so that ordering by ID is ordering by creation time (AS-01, AS-19, AS-55; pattern P0320).
- **FR-004**: `POST` routes that create a post or a comment MUST require `Idempotency-Key` (UUID) with the constitution V.6 semantics: replay returns the stored status and body, an in-flight key returns `409 request_in_progress`, a different body returns `422 idempotency_key_reuse`, a missing key returns `422 idempotency_key_required`; scope is user + route; keys live 24 hours (AS-06, AS-17).
- **FR-005**: A post MUST be deletable by its author, an `ADMIN` or a `MODERATOR`; deletion hides the post everywhere, is idempotent, and records `discussion.post_deleted` once (AS-47).

**Comments**

- **FR-010**: Comments nest to a maximum depth of 8 (top level = 0). A reply under a deleted parent is refused (`409 parent_deleted`); a reply beyond depth 8 is refused (`422 max_depth_exceeded`); a parent from another post is `404 parent_not_found` (AS-15).
- **FR-011**: A comment body MUST be 1–10,000 code points after trim (AS-16).
- **FR-012**: Thread reads MUST be paged by top-level comment (`limit` 1–50, default 25), each top-level comment carrying its first 5 descendants in thread order (oldest-first, parents before children) plus `hasMoreReplies`; further descendants of one branch MUST be loadable with `GET /api/comments/:commentId/replies` and an opaque cursor (AS-14, AS-20).
- **FR-013**: Comment sorts are `best` (default), `new` (top-level newest first) and `old` (top-level oldest first); replies are always oldest-first (AS-14, AS-42).
- **FR-014**: The storage layout MUST bound the amount of data any one read touches regardless of thread size: top-level comments are grouped into partitions of at most 5,000, and a reply is stored with its root (AS-18).
- **FR-015**: Deleting a comment MUST turn it into a tombstone (position, depth, replies, counts retained; body, raw markdown and author erased from output and storage), decrement `commentCount` exactly once, and be idempotent. Authors and moderators may delete (AS-21, AS-22).
- **FR-016**: `commentCount` and `replyCount` MUST equal the number of non-deleted, non-shadow comments visible to the public, under concurrent creation and deletion (AS-13, AS-17, AS-19, AS-23).

**Votes**

- **FR-020**: A user has at most one vote per target (post or comment) with value `1`, `-1` or none (`0` retracts). The vote store is the source of truth; uniqueness is enforced by the store, not by an application check (AS-24, AS-25, AS-29, AS-30).
- **FR-021**: The target type MUST be resolved by the server from the target ID; the client does not send it. Unknown target → `404 target_not_found`; deleted comment → `409 target_deleted`; deleted post → `404 target_not_found`; own content → `422 self_vote_not_allowed` (AS-26–AS-28).
- **FR-022**: Every vote response MUST have the shape `{targetId, targetType, ups, downs, score, myVote}`, also for replays and retractions (AS-24, AS-25).
- **FR-023**: Concurrent requests for the same `(user, target)` MUST be serialised; a request that cannot get its turn returns `409 vote_in_progress` with `Retry-After`. The final state MUST equal one requested value and the counts MUST equal an exact recount (AS-30).
- **FR-024**: Displayed counts (`ups`, `downs`, `score = ups − downs`) are derived from the vote store, served from fast derived state, and eventually exact: after any loss of derived state the next read returns the true counts; a reconciliation repairs drift for recently voted targets within 15 minutes; durable aggregate counters lag by at most 5 seconds in normal operation (AS-49, AS-50).
- **FR-025**: Each vote carries a ranking weight fixed at cast time: 0 for an account younger than 24 hours, a shadow-banned voter or an unresolved account, else 1. Displayed counts use raw votes; ranking uses weighted votes (AS-44, AS-45).
- **FR-026**: `myVote` is present on every post and comment view: `-1 | 0 | 1` for a signed-in reader, `null` for anonymous (AS-32).

**Ranking and lists**

- **FR-030**: Board sorts are `hot` (default), `top` (with `window`) and `new`. `hot` and `top` consider the 1,000 best-ranked posts of a board; `new` reaches every post. Every list uses an opaque keyset cursor and a deterministic order that ends in a unique tiebreaker; there is no offset pagination (AS-33–AS-39).
- **FR-031**: Invalid `sort`, `window`, `limit` or `cursor` MUST be refused with `400`; nothing falls back silently (AS-39).
- **FR-032**: **Hot** score = `sign(net) × log10(max(|net|, 1)) + (createdAtSeconds − E) / 45000`, with `net` = weighted ups − weighted downs, `E` = 2024-01-01T00:00:00Z in seconds, rounded to 7 decimals. Ten times more net votes is worth 45,000 s (12.5 h) of age. Order: hot score descending, `postId` descending (AS-33, AS-34; pattern P1108).
- **FR-033**: **Best** score of a comment = lower bound of the Wilson interval for the proportion of weighted up-votes, `z = 1.96`: `(p + z²/2n − z·√((p(1−p) + z²/4n)/n)) / (1 + z²/n)`, `p = ups/n`, `n = ups + downs`, and 0 when `n = 0`. Order: best score descending, then older comment first (AS-42; pattern P1108).
- **FR-034**: **Top** orders posts created within `window` (`day` 24 h, `week` 7 d, `month` 30 d, `year` 365 d, `all`; default `all`) by weighted net score descending, then `postId` descending; the window start is inclusive (AS-36).
- **FR-035**: Ranking structures are derived state: every entry has an expiry, a missing structure is rebuilt from the durable store on demand without losing a post or vote, and a post that is deleted or shadow content never appears in a shared ranking (AS-47, AS-49; pattern P0323).
- **FR-036**: The first page of a thread MAY be cached for at most 5 seconds as a viewer-independent snapshot; every write to the thread invalidates it; viewer-specific fields (`myVote`) and a shadow-banned author's own items are merged per request (AS-43).

**Safe markdown**

- **FR-040**: The renderer MUST allow only the tags `p, br, strong, em, del, code, pre, blockquote, ul, ol, li, a, h3, h4`, only the attributes `href`, `rel`, `target` on `a`, only the schemes `https`, `http`, `mailto`; MUST add `rel="nofollow ugc noopener noreferrer"` and `target="_blank"` to every link; MUST drop images, raw HTML elements, comments, styles and event handlers; and MUST reject (400) bodies over the complexity limit of 20 nested quote/list levels (AS-08, AS-09, AS-12; pattern P0501).

  | Input | Output |
  |---|---|
  | `**hi**` | `<p><strong>hi</strong></p>` |
  | `[ok](https://apple.com)` | `<p><a href="https://apple.com" rel="nofollow ugc noopener noreferrer" target="_blank">ok</a></p>` |
  | `[x](javascript:alert(1))` | `<p>x</p>` (link removed, text kept) |
  | `<script>alert(1)</script>` | no `<script`; any remaining text is inert |
  | `<img src=x onerror=alert(1)>` | no `<img`, no `onerror` |
  | `![t](https://evil.example/t.png)` | no `<img` |
  | `# big` | `<h4>big</h4>` |

- **FR-041**: The raw markdown MUST be stored unchanged (until deletion); the rendition is stored with the version of the policy that produced it; a read MUST NOT return a rendition of an older version unchanged — it re-renders from the raw markdown under the current policy (and refreshes storage) (AS-10).
- **FR-042**: Titles are plain text: stored and returned verbatim, never interpreted as markup by the server; clients MUST render them as text. Responses MUST carry `Content-Type: application/json` and `X-Content-Type-Options: nosniff` (AS-11).
- **FR-043**: The `bodyHtml` contract for clients: it is allow-list output and a client MUST still pass it through its own allow-list sanitiser before inserting it into a page (defence in depth; Requires W02).

**Abuse and moderation**

- **FR-050**: Post and comment creation share the per-user write limit (10 per minute); voting has its own (60 per minute). Over the limit → `429 rate_limited` with `Retry-After` (AS-05, AS-31).
- **FR-051**: A shadow ban, set or lifted by `ADMIN` or `MODERATOR`, marks content created from then on as shadow: invisible to every reader but its author in lists, threads, counts, rankings and by-ID reads, with identical `201` responses; it emits no events; it zeroes the banned user's vote weight (AS-46).
- **FR-052**: `ADMIN` and `MODERATOR` can delete any post or comment (`deletedBy: "moderator"`); no other role has a moderation right (AS-22, AS-47).
- **FR-053**: Ten zero-weight votes on one target within 10 minutes MUST record one `discussion.vote_anomaly_detected` event per target per hour and a metric; it never blocks voting (AS-48).
- **FR-054**: A user MUST NOT vote on their own post or comment (AS-27).

**Events and cross-capability**

- **FR-060**: Each post creation, post deletion, comment creation and comment deletion MUST durably record exactly one event with the write (never a separate best-effort publish) and publish it at least once with a stable `eventId`; shadow content records none (AS-07, AS-21, AS-46, AS-47).
- **FR-061**: The capability MUST export `DiscussionQueryService.getPostsByIds` (R1) returning only visible posts (deleted and shadow posts are filtered out, as in AS-40 and AS-46) so the feed can hide deleted posts at hydration time.

**Errors, limits, operations**

- **FR-070**: Every error MUST be problem+json with a stable `code` from the list in the Assumptions; `5xx` bodies are generic (AS-52, AS-53).
- **FR-071**: Every call to a store or the cache MUST have an explicit timeout; the end-to-end budget of a write is 2 seconds, after which the request fails with `503 service_unavailable` (AS-52).
- **FR-072**: Logs are structured and carry `requestId`; they never contain bodies, titles, raw markdown or e-mail addresses (AS-54).
- **FR-073**: Every endpoint's request and response MUST have a schema in the shared contracts package, and end-to-end tests parse responses with it (constitution V.2, VII.6).
- **FR-074**: Read endpoints are anonymous-friendly, never change state, and rely on the platform's default read limit (S50); write endpoints require authentication (AS-04, AS-55).

### Key Entities

- **Board**: the discussion space of one product; identified by the product's ID; has no stored record of its own beyond its posts.
- **Post**: title (plain text), raw markdown, rendition (with policy version), author, creation time, deleted flag and who deleted it, shadow flag, counts (`ups`, `downs`, `commentCount`).
- **Comment**: belongs to a post; optional parent; depth; raw markdown and rendition; author; creation time; deleted flag (tombstone) and who deleted it; shadow flag; counts (`ups`, `downs`, `replyCount`).
- **Vote**: `(user, target) → value (−1 | 1)` plus ranking weight and cast time; absent when retracted. One per user per target.
- **Ranking entry**: derived per-target scores (hot, top, best), rebuildable from posts, comments and votes.
- **Author flag**: shadow-ban state of a user (set by whom, when).
- **Recorded event**: durable event awaiting or after publication (`eventId`, type, version, aggregate ID, payload).
- **Idempotency record**: user + route + key → request fingerprint and stored response, 24 h.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A buyer can post a question and see it on the board in under 5 seconds including typing a 200-character body; a double click never creates two posts (AS-06).
- **SC-002**: With 100 simultaneous voters on one post the final count is exactly 100, and after a flush of all fast state it is still 100 (AS-29, AS-49); at 10,000 votes per second no vote is lost or double-counted (reconciliation finds zero drift on the vote-storm load test).
- **SC-003**: Board pages and thread first pages are served to readers at 50,000 reads per second with 99% of responses in under 50 ms; a vote completes in under 30 ms for 99% of requests (load test, ops artifact).
- **SC-004**: 100% of the XSS corpus (AS-09) yields output with no executable construct, for posts and comments, on first read and on re-read after a policy change (AS-10).
- **SC-005**: A thread of 50,000 comments loads its first page by reading no more than one page of top-level comments and their first replies; "load more" for one branch never loads other branches (AS-18, AS-20).
- **SC-006**: Twenty fresh accounts voting on a post move its ranking by zero positions (AS-44); a shadow-banned spammer's content reaches no other reader (AS-46).
- **SC-007**: After the ranking cache is lost, board order and counts return identical to before on the first reads, with no manual step (AS-49).
- **SC-008**: Errors never reveal internals: 0 stack traces, store names or query text in 5xx bodies across the failure scenarios (AS-52, AS-53).

## Cross-capability contracts

**Provides** (exact names):

- **HTTP endpoints** (all under `/api`, problem+json errors, schemas in the contracts package):
  - `POST /boards/:productId/posts` (auth, `Idempotency-Key`, rate profile `discussion.write`) → `201 PostView`.
  - `GET /boards/:productId/posts?sort=hot|top|new&window=day|week|month|year|all&limit=1..50&cursor=` (anonymous allowed) → `200 {items: PostView[], nextCursor: string | null, degraded?: true}`.
  - `GET /posts/:postId` (anonymous allowed) → `200 PostView`; `DELETE /posts/:postId` (auth) → `204`.
  - `POST /posts/:postId/comments` (auth, `Idempotency-Key`, `discussion.write`) body `{body, parentId?}` → `201 CommentView`.
  - `GET /posts/:postId/comments?sort=best|new|old&limit=1..50&cursor=` (anonymous allowed) → `200 {items: CommentNode[], nextCursor: string | null, degraded?: true}`; `CommentNode = CommentView & {replies: CommentView[], hasMoreReplies: boolean}`.
  - `GET /comments/:commentId/replies?limit=1..50&cursor=` (anonymous allowed) → `200 {items: CommentView[], nextCursor: string | null}`; `DELETE /comments/:commentId` (auth) → `204`.
  - `PUT /votes/:targetId` (auth, `discussion.vote`) body `{value: -1 | 0 | 1}` → `200 {targetId, targetType: "post" | "comment", ups, downs, score, myVote}`.
  - `PUT /moderation/shadow-bans/:userId`, `DELETE /moderation/shadow-bans/:userId` (`ADMIN` or `MODERATOR`) → `204`.
  - `PostView = {postId, boardId, authorId, title, bodyHtml, createdAt, ups, downs, score, commentCount, myVote}`; `CommentView = {commentId, postId, parentId, depth, authorId | null, bodyHtml, createdAt, ups, downs, score, myVote, deleted, deletedBy?: "author" | "moderator", replyCount}`. `authorId` is an opaque user ID; there is no display name (see questions).
- **R1 export** (`@app/domains/community`): `DiscussionQueryService.getPostsByIds(ids: PostId[]): Promise<Map<PostId, PostSummaryDto>>` (≤ 100 IDs, one batch; deleted and shadow posts are absent; `PostSummaryDto = {postId, boardId, authorId, title, createdAt, score, commentCount}`). **Consumer: S26** (feed hydration; deleted posts vanish), **J05**.
- **Events** (recorded with the write, published at least once to the topic `discussion.events`, keyed by `postId`; envelope per constitution IV.4: `eventId`, `type`, `version`, `occurredAt`, `aggregateId = postId`):
  - `discussion.post_created` v1 `{postId, boardId, authorId, title, createdAt}`. **Consumer: S26** (feed item `post` for the author's followers), S39.
  - `discussion.post_deleted` v1 `{postId, boardId, deletedBy: "author" | "moderator"}`. **Consumer: S26** (remove feed items).
  - `discussion.comment_created` v1 `{commentId, postId, boardId, authorId, parentCommentId: string | null, parentAuthorId: string | null, postAuthorId, preview, createdAt}` (`preview` = first 140 characters of the plain text, no markup). **Consumer: S28** (reply and comment notifications).
  - `discussion.comment_deleted` v1 `{commentId, postId, boardId, deletedBy}`.
  - `discussion.vote_anomaly_detected` v1 `{targetId, targetType, boardId, zeroWeightVotes, windowSeconds}`. Consumer: none required (observability).
  - No event for shadow content, votes or shadow-ban changes.
- **Composition** (R2): the product page may include an optional "top discussions" section by calling `GET /boards/:productId/posts?sort=hot&limit=3` over HTTP. **Consumer: S48 / W02.**

**Requires** (owner, exact shape assumed):

- **S05** `ProductQueryService.getProductsByIds(ids: ProductId[], options?: {shopId?}): Promise<Map<ProductId, ProductDto>>` (R1, ≤ 500, DTO has `id` and `status: "ACTIVE" | "ARCHIVED"`). Used to validate a board on writes only.
- **S01** `Firewall({anonymous?, roles?})`, `@User()`, `AuthenticatedUser = {id, role, sessionId, amr}` with `Role` values `ADMIN | MODERATOR | SELLER | USER`; `UserDirectoryService.getUsersByIds(ids: UserId[]): Promise<Map<UserId, UserSummaryDto>>` (R1, ≤ 500; only `id` and `createdAt` are used) for account age and moderation targets. CSRF protection of cookie-authenticated writes is enforced by S01/S48 before these routes (not re-implemented here).
- **S50** rate-limit profiles named `discussion.write` (10 per minute per user, token bucket, fail closed) and `discussion.vote` (60 per minute per user, fail open with a local lease), answering `429` with `Retry-After`. No other capability may reuse these two names.
- **S53** event envelope and producer (`defineEvent`, Kafka producer keyed by aggregate ID); this capability records its events in its own store and relays them (no dual write to the bus).
- **Infrastructure idempotency records** (first specified by S13; V.6 semantics, 24 h TTL) — the capability uses them for post and comment creation.
- **Clock**: an injected clock port (all time, including ID timestamps and ranking ages).
- **W02** (consumer of this capability's HTTP contract): sends `Idempotency-Key` on creates, uses the board ID = product UUID, the `{items, nextCursor}` envelopes and the new vote body, sanitises `bodyHtml` with its own allow-list before insertion, de-duplicates list items by `postId`.

## Assumptions

- Every default below is also a line in `questions.md`.
- **Board ID** is the product UUID; brand boards and free-form IDs are removed because no domain owns brands to validate them against and any string could otherwise spawn a board. `[BREAKING]`
- **Idempotency-Key is mandatory** on post and comment creation: a double submit is the most common source of duplicates. `[BREAKING]`
- **Authors are shown as `authorId` only.** Identity has no public display name and an e-mail-derived label would leak personal data (same decision as S24); a later display-name capability would be composed by the BFF (R2).
- **Voting stays allowed on posts and comments of an archived product**; only creation is closed.
- **Replies are ordered oldest-first in every sort**; only top-level comments are re-ordered by `best`, `new`, `old`.
- **Shadow ban is prospective** (applies to content created while it is set); it does not retroactively hide older content, and lifting it does not reveal content created during the ban.
- **No shop-level moderation.** Only platform `ADMIN` and `MODERATOR` roles moderate; a `SELLER` cannot remove comments on their own product board. A shop-moderator right would come from a tenancy permission (S03, R1 `ShopAccessService`) in a later capability.
- **Vote-manipulation detection by IP clusters is out of scope**; the domain has no network data. Account age and velocity of zero-weight votes are used instead.
- **Account age threshold** 24 h, anomaly threshold 10 votes in 10 minutes, hot/top cap 1,000, embedded replies 5, depth 8, first-page cache 5 s, idempotency TTL 24 h, durable counter lag ≤ 5 s, reconciliation within 15 minutes are defaults, each overridable by configuration (tests override the partition size and the cap).
- **Stable error codes**: `validation_failed`, `invalid_cursor`, `unauthorized`, `forbidden`, `board_not_found`, `post_not_found`, `comment_not_found`, `parent_not_found`, `target_not_found`, `user_not_found`, `board_closed`, `parent_deleted`, `target_deleted`, `vote_in_progress`, `request_in_progress`, `idempotency_key_required`, `idempotency_key_reuse`, `max_depth_exceeded`, `self_vote_not_allowed`, `rate_limited`, `service_unavailable`.
- **Ownership** (constitution IX, decision D5): this capability owns no PostgreSQL table; its durable data lives in the wide-column store and its derived data in the in-memory ranking cache, both owned by `community`. It reads catalog and identity data only through R1 exports, and holds no foreign key or copy of them except IDs.
- **Time** is read only through the injected clock; tests freeze it.
- **Out of scope for the web layer**: layout, copy, optimistic updates and the UI journey are specified by W02; this spec only asks that the UI journey of the test plan exists (one happy path).
