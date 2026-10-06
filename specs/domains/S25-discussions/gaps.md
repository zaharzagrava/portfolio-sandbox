# Gaps: S25 — Product discussions (domain `community`)

The implementation agent's to-do list: what today's code gets wrong or lacks against [`spec.md`](spec.md), the open debt rows that name `community` or S25, and the table-ownership findings with the IX.7 mechanism that replaces each. Paths are under `packages/backend/libs/domains/community/` unless stated. Code is an imperfect draft; the spec wins.

## 1. Code versus spec

### Boards, posts, idempotency

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Board ID is any string, silently truncated to 64 characters (`product-<uuid>`, `brand:apple`, garbage). No product check, so anyone can create a board by posting. | `api/discussions.controller.ts:23,29` | FR-001, AS-02 |
| A2 | No `Idempotency-Key`: a double submit or retry duplicates the post or comment. | `application/discussion.service.ts:58,120` | FR-004, AS-06, AS-17 |
| A3 | Post creation is not atomic and not ordered: two parallel Scylla inserts, then a separate Redis `multi`, then an in-process feed call. A crash between them leaves a post missing from `posts_by_board`, from the rankings, or both. | `application/discussion.service.ts:63-86` | FR-020, FR-035, AS-49 |
| A4 | `FeedPublisher` is `@Optional` and `DiscussionsModule` does not import `FeedPublisherModule`, so `this.feed` is `undefined` in core and the feed link never ran; errors are swallowed with `.catch(() => undefined)`. No event is recorded or published. | `application/discussion.service.ts:55,86`, `discussions.module.ts:9-14` | FR-060, AS-07 |
| A5 | Title is not trimmed before `MinLength(3)`; control characters and bidirectional overrides are accepted; unknown request fields are not rejected on these DTOs; `markdown_too_complex` does not exist. | `api/discussions.dto.ts:5-7` | FR-002, AS-03, AS-12 |
| A6 | No post deletion. The `deleted` column exists and is read, but nothing writes it. | `application/discussion.service.ts:205` (read only) | FR-005, AS-47 |
| A7 | `PostView` lacks `score`, `myVote`, and names the count `comments` instead of `commentCount`; no `degraded`. | `application/discussion.service.ts:12-22` | FR-022, FR-026 |

### Comments

| # | Gap | Where | Spec |
|---|---|---|---|
| B1 | A comment is written in four non-atomic steps (partition row, `comment_locator`, Redis counter, Redis `best` entry). A crash after the first leaves a comment that cannot be found by locator, so it cannot be deleted, voted or replied to. | `application/discussion.service.ts:143-151` | FR-014, FR-016, AS-23 |
| B2 | Top-level bucket number comes from a Redis `INCR` with no TTL; losing the key restarts numbering at bucket 0 and breaks bucket order. The `comment_buckets` bump is a read-then-write race. | `application/discussion.service.ts:132-137` | FR-014, AS-18, AS-49 |
| B3 | No depth limit, no `parent_deleted` check, no shadow-ban handling on parents. | `application/discussion.service.ts:126-130` | FR-010, AS-15 |
| B4 | `thread()` returns a flat list with a hard `LIMIT 200` and no cursor; a 50k thread cannot be paged. `bestThread()` has no cursor and awaits one locator read and two thread reads per comment in sequence (N+1); its "replies" are a flat path range, not the first 5 descendants with `hasMoreReplies`. There is no replies endpoint. | `application/discussion.service.ts:157-183`, `api/discussions.controller.ts:38-42` | FR-012, FR-013, AS-14, AS-20 |
| B5 | `CommentView` exposes the internal `path`, has no `myVote`, `replyCount` or `deletedBy`, and keeps `authorId` on tombstones. | `application/discussion.service.ts:24-35,221-232` | FR-015, AS-21 |
| B6 | Delete is author-only (`ForbiddenException` with no code), has no moderator path, does not decrement counts, records no event, and blanks `body_md` but leaves the author. Comment counts are a Redis hash field with no TTL and never decremented. | `application/discussion.service.ts:185-196,150` | FR-015, FR-016, FR-052, AS-21, AS-22 |
| B7 | Comment IDs and `createdAt` come from the driver's `TimeUuid.now()` and `Date.now()` default, not an injected clock; `pathSegment(now = Date.now())` and `node:crypto` sit in `domain/` (I.3). | `application/discussion.service.ts:59,99,140`, `domain/paths.ts:1,12` | FR-003, AS-19, AS-55 |

### Votes

| # | Gap | Where | Spec |
|---|---|---|---|
| C1 | The server trusts the client's `targetType`; a comment ID can be voted as a post. | `api/discussions.dto.ts:15`, `api/discussions.controller.ts:62` | FR-021, AS-26 |
| C2 | No self-vote check; no deleted-target check (`context()` never looks at `deleted`); unknown posts fall through to a Scylla read per vote. | `application/vote.service.ts:116-129` | FR-021, FR-054, AS-27, AS-28 |
| C3 | Serialisation is a 3 s Redis lock; if the work outlives the lock two requests can both read the same previous value and apply the delta twice. The write is read-previous-then-write (check-then-write), not a conditional write; the two vote tables are written by two independent inserts. | `application/vote.service.ts:33-50` | FR-020, FR-023, AS-30 |
| C4 | Live counts are a Redis hash with no TTL and no rebuild on a miss; a Redis restart zeroes every displayed count until someone runs `recount`, which no schedule runs. | `application/vote.service.ts:62-65,108-114`, `infra/discussions.jobs.ts:29-32` | FR-024, AS-49, AS-50 |
| C5 | `applyDelta` writes the live hash in a `multi`, then increments the write-behind buffer in separate calls: a crash between them loses the durable delta. `flushToCounters` drains first, then writes; a crash after a successful counter update re-applies on restore. No reconciliation compares counters with `votes_by_target`. | `application/vote.service.ts:68-89,108-114` | FR-024, AS-50 |
| C6 | A replayed vote returns `{ups, downs}` without `myVote`; the first vote returns `{ups, downs, myVote}`; no `targetId`, `targetType`, `score`. | `application/vote.service.ts:38,56,62-65` | FR-022, AS-25 |
| C7 | No vote weight, no new-account rule, no shadow-ban input, no anomaly signal. | `application/vote.service.ts` (absent) | FR-025, FR-053, AS-44, AS-48 |
| C8 | `votes_by_user` is partitioned by `user_id` alone: a heavy voter's partition grows without bound. Only point reads `(user, target)` are needed. | `cql/010_discussions.cql:49-54` | FR-014 (bounded partitions), FR-020 |

### Ranking and lists

| # | Gap | Where | Spec |
|---|---|---|---|
| D1 | `hot` and `top` paging uses a numeric Redis offset as the cursor; votes between pages repeat or skip posts. The `new` cursor is a readable `bucket:pagingState`. All must be opaque keyset cursors. | `application/discussion.service.ts:93-95,99` | FR-030, AS-35, AS-39 |
| D2 | Ranking ties are broken by Redis member (the timeuuid string, whose leading bytes are `time_low`, so lexicographic order is not time order) instead of newest `postId` / oldest comment. | `application/vote.service.ts:133-141`, `application/discussion.service.ts:79-80,151` | FR-032, FR-033, AS-34, AS-42 |
| D3 | Only the `hot` set is capped; the `top` set and every score/meta hash grow forever and no key has a TTL (III.9). | `application/discussion.service.ts:77-83`, `application/vote.service.ts:108-114` | FR-030, FR-035, AS-38, AS-49 |
| D4 | `top` is all-time only; no `window`. | `api/discussions.controller.ts:26-30` | FR-034, AS-36 |
| D5 | `new` walks at most 24 monthly buckets, so a board whose last post is older than two years returns nothing; empty months are scanned one by one. | `application/discussion.service.ts:101` | AS-37 |
| D6 | Invalid `sort` silently becomes `hot`; `limit` is not a parameter; the comments `sort` is unvalidated; no `window`. | `api/discussions.controller.ts:29,40` | FR-031, AS-39 |
| D7 | `hydratePosts` issues one Scylla read, one Redis `HMGET` and one Redis `HGET` per post (3 × N round trips); `withScores` one `HMGET` per comment. | `application/discussion.service.ts:198-233` | SC-003 |
| D8 | No first-page cache for threads (SD-11: cached 5 s) and no cache invalidation on write. | (absent) | FR-036, AS-43 |
| D9 | No degraded path when Redis is down; every list depends on Redis. | (absent) | AS-51 |
| D10 | `hotScore` and `wilsonLowerBound` match the spec. The weighted inputs (FR-025) are missing. | `domain/ranking.ts` | AS-34, AS-42, AS-44 |

### Safe markdown

| # | Gap | Where | Spec |
|---|---|---|---|
| E1 | HTML is sanitised once at write and served as stored. There is no policy version and no re-sanitising at output, so a future allow-list fix never reaches old rows (notes 05/01 §1). | `domain/content.ts:20-22`, `application/discussion.service.ts:61,142`, stored `body_html` | FR-041, AS-10 |
| E2 | Headings `h1`/`h2` lose their tags and text stays plain; the spec table says other levels become `h4`. | `domain/content.ts:4-5` | FR-040 table, AS-08 |
| E3 | No complexity bound before `marked.parse` on up to 40,000 characters. | `domain/content.ts:20` | FR-040, AS-12 |
| E4 | The only unit case covers one payload; no corpus (`data:`, `vbscript:`, entity-encoded schemes, svg/math, mutation XSS), and no test of comments, of the stored raw markdown being unchanged, or of re-read. | `domain/ranking.spec.ts:30-37` | AS-09 |
| E5 | Responses carry no `X-Content-Type-Options: nosniff` guarantee test for these routes. | (absent) | FR-042, AS-11 |

### Abuse and moderation

| # | Gap | Where | Spec |
|---|---|---|---|
| F1 | No moderation routes, no role check (`@Firewall()` without roles), no shadow-ban store, no visibility rules. | `api/discussions.controller.ts` | FR-051, FR-052, AS-46, AS-47 |
| F2 | `discussion.write` is borrowed by media uploads and share links, so uploads consume the post budget. | `../media/api/media.controller.ts:28`, `../marketing/api/share-links.controller.ts:21` | FR-050, `questions.md` |
| F3 | Anonymous reads are `skipThrottle: true`: no limit at all. | `api/discussions.controller.ts:26,32,38` | FR-074 |
| F4 | No `403 forbidden` with a stable `code`; all errors are Nest exceptions with English messages and no `code`. | `application/discussion.service.ts:116,122,128,189`, `application/vote.service.ts:34,121,127` | FR-070, AS-53 |

### Events, operations, structure

| # | Gap | Where | Spec |
|---|---|---|---|
| G1 | No events from discussions at all; no durable event record or relay; community has no outbox because it owns no PostgreSQL table (D5). | (absent) | FR-060, AS-07 |
| G2 | No `DiscussionQueryService.getPostsByIds` for the feed. | (absent) | FR-061 |
| G3 | No explicit timeout on any Scylla or Redis call visible in the domain; no timeout budget; no 503 mapping. | `application/*.ts` | FR-071, AS-52 |
| G4 | No structured logging, no metrics; nothing proves bodies stay out of logs. | (absent) | FR-072, AS-54 |
| G5 | No zod schemas for discussions in `packages/contracts`; e2e does not parse responses. | `packages/contracts` (absent) | FR-073 |
| G6 | `application/` imports `infra/` directly: `CassandraService`, `RedisService`, `WriteBehindCounter` (D-6): needs repository ports in `domain/` and adapters in `infra/`. | `application/discussion.service.ts:4-5`, `application/vote.service.ts:3-5` | constitution I.2 |
| G7 | `DiscussionsWorkerModule` provides its own `VoteService`; reconciliation, relay and recount jobs need explicit schedules (only `flush-votes` is scheduled). | `discussions-worker.module.ts:8-11`, `infra/discussions.jobs.ts:21` | FR-024, FR-060 |
| G8 | The existing e2e calls services directly, not HTTP; no 401, IDOR, validation, idempotency, rate-limit, degradation, concurrency-on-same-user or markdown-corpus cases; no contract parse. | `discussions.e2e-spec.ts:39-88` | constitution VII.2, VII.3, test-plan |

### Schema work needed (additive, expand-only)

- New columns: posts and comments `shadow boolean`, `deleted_by text`, `html_version int`; votes `weight tinyint` and `cast_at`; comment `reply_count` is derived, not stored.
- New tables owned by `community`: shadow-ban flags per user, durable recorded events, a per-board index of non-empty months (D5 above), idempotency records if the infrastructure service cannot be used.
- Re-key `votes_by_user` to `((user_id, target_id))` (C8): new table, backfill, switch, drop later (expand/contract).

## 2. Debt register: open rows naming `community` or S25

| Row | What applies to community | Who pays | Mechanism that replaces it |
|---|---|---|---|
| D-6 (I.2 layering) | S25: `application/` imports Cassandra, Redis and write-behind classes directly (G6). | S25 | Repository ports in `domain/`, adapters in `infra/`; no mechanism from IX.7 is involved (same domain). |
| D-7 (IX.4 model exports) | `ProductModel` is imported and injected by community's projector: `infra/product-feed.projector.ts:4,19`. | **S26** (follow-feed owns this projector). S25 has none. | S26: R3 — consume S05's product snapshot events and store the few fields it needs in a table or store owned by community. |
| D-8 (X.4 barrel exports infrastructure internals) | `index.ts:11-12` exports `FeedFanoutConsumer` and `ProductFeedProjector` so `apps/projector` can wire them. | **S26**. S25 must not add any: its worker and projector wiring goes through `DiscussionsWorkerModule` only. | Apps import the domain's worker or projector module instead of its internals. |
| D-12 (IX.4 raw SQL on another domain's table) | The same projector reads catalog's `Product`: `infra/product-feed.projector.ts:25` (`productModel.findAll`). S25 needs product facts for one new reason only: validating a board on writes. | S26 (projector), S25 (board validation) | S25 board validation: **R1** `ProductQueryService.getProductsByIds(ids)` (S05 AS-48, writes only). S26 projector: **R3** snapshot events. |
| D-17 / D-11 / D-15 | Not applicable to community. | — | — |

## 3. `pnpm --dir packages/backend check:table-ownership` — community lines

The command asks for approval in this unattended run and was **not executed**. The findings below come from reading the domain's sources (`grep` for `InjectModel`, `sequelize`, `.query(`, `literal(` and `@app/domains/` imports over `libs/domains/community/`). The implementation agent must re-run the command and confirm; the expected result after S25 and S26 are done is zero community lines.

| Kind | Finding | File | Belongs to | Replacement |
|---|---|---|---|---|
| MODEL | `ProductModel` (catalog) imported | `infra/product-feed.projector.ts:4` | S26 | R3 (D-7) |
| MODEL | `@InjectModel(Product)` | `infra/product-feed.projector.ts:19` | S26 | R3 (D-7) |
| SQL | `productModel.findAll` on `Product` | `infra/product-feed.projector.ts:25` | S26 | R3 (D-12) |

S25's own code issues no Sequelize or SQL access. Its cross-domain edges are `@app/domains/identity` (`AuthModule`, `Firewall`, `User`, `UserRawDto`: allowed entry point). New S25 cross-domain needs are all reads through exports: catalog `getProductsByIds` (R1, writes only) and identity `UserDirectoryService.getUsersByIds` (R1, account age and moderation targets). Neither introduces a model import or a join. The wide-column tables and cache keys are community's own (decision D5); nothing outside the domain reads them (verified by `grep` for the table names over `libs` and `apps`: only `cql/010_discussions.cql` and community's own files).

## 4. Cross-capability follow-ups (tracked here, paid elsewhere)

| Item | Owner | Where today |
|---|---|---|
| Web board component calls `apiClient` directly in a component (VI.3), renders `bodyHtml` with `dangerouslySetInnerHTML` and no client sanitiser (VI.7), prefixes board IDs with `product-`, sends no `Idempotency-Key`, has no comments, no sort tabs, no cursor paging | **W02** | `packages/web/components/product/product-discussions.tsx:25-26,38,42,54,108` |
| UI journey exists but covers only post + upvote + ask; extend with markdown render and a reply | **W02** | `packages/web/tests/product-community.spec.ts` |
| Media upload comment promises "discussion posts" photos | **S29** | `libs/domains/media/application/events/media-events.ts:4` |
| Rate-limit profile names `discussion.write`, `discussion.vote` become S25-only; media and share links get their own | **S50**, **S29**, **S37** | `libs/infrastructure/rate-limit/rate-limit.types.ts:49-50` |
| Feed consumes `discussion.post_created` / `discussion.post_deleted` and hydrates through `DiscussionQueryService.getPostsByIds` | **S26** | `application/feed-publisher.service.ts:14` (`'post'` kind) |
| Reply notifications consume `discussion.comment_created` | **S28** | (absent) |
