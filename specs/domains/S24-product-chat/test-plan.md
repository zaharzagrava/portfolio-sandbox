# Test Plan: S24 — Product chat (domain `chat`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (58 rows), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. A unit entry proves the pure rule table; the API e2e entry of the same row proves one wired case through the real stack, never the table again.

- API e2e files live in `packages/backend/libs/domains/chat/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `ChatModule`, `ChatSyncModule`, `ChatTopicsModule`, `ChatOfflineWorkerModule` and `ChatProjectorModule` with the production global prefix, `ValidationPipe`, problem+json filter and interceptors, call HTTP through `supertest`, and run against real Postgres (migrations applied, monthly partitions included), Redis and ElasticMQ/Kafka stand-ins from `docker-compose.test.yaml`.
  - `chat-channels.e2e-spec.ts` — describe "Product chat: channels, membership and access"
  - `chat-messages.e2e-spec.ts` — describe "Product chat: idempotent send, per-channel sequence and events"
  - `chat-sync.e2e-spec.ts` — describe "Product chat: sync on reconnect, history and partitions" (the existing file of that name is rewritten: it must call HTTP, not services)
  - `chat-read-state.e2e-spec.ts` — describe "Product chat: unread counts and read receipts"
  - `chat-presence.e2e-spec.ts` — describe "Product chat: presence"
  - `chat-offline-push.e2e-spec.ts` — describe "Product chat: offline push scheduling, checks and escalation" (includes the VII.4 duplicate-delivery and invalid-payload tests of the scheduler consumer)
  - `chat-moderation.e2e-spec.ts` — describe "Product chat: moderation, message deletion and gateway tickets"
  - `chat-lifecycle.e2e-spec.ts` — describe "Product chat: shop lifecycle, backfill and domain isolation" (includes the VII.4 tests of the shop-deleted consumer)
- Shops, memberships, products and users are seeded only through the shared fixture helpers, the identity fixture (`SessionIssuer` replaces `issueTokensFor`), tenancy's and catalog's exported services; no spec injects `UserModel`, `ProductModel`, `ShopModel` or `ShopMembershipModel` (D-7). Channels are created through the staff route; the realtime gateway's writes are simulated by running its three exact SQL statements through the test harness's raw connection (test code may touch every table, IX.6).
- Only system edges are faked: identity token verification, the live bus and realtime hub transport where a fault is forced, the presence store wrapper where an outage is forced, the notification consumer (S28) (a spy on the escalation event), and the clock. Faults are injected through switchable wrappers at the system edge, never by stubbing chat's own repositories.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`) and exist only for pure logic (VII.5): `message-body.spec.ts`, `read-position.spec.ts`, `moderation-rules.spec.ts`, `escalation-decision.spec.ts`, `history-cursor.spec.ts`, `partition-months.spec.ts`; `fast-check` properties on `read-position` (monotonic, capped, order-insensitive). Controllers, repositories and glue code get no unit tests.
- UI journey (Playwright): one happy-path journey owned by W05 in `packages/web/e2e/chat.spec.ts` — a buyer joins a product chat, sends a message, the seller answers, the buyer's connection drops and returns and the missed answer appears once (sync), the unread badge clears when the chat opens. Rows marked "W05 journey" below are the only UI coverage S24 asks for; edge cases are never re-tested there (VII.7).
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict` (AS-58); `pnpm check:module-graph`; `pnpm check:model-registry`.
- Gate 9 (VII.9) fallback/degradation tests that force the fault: AS-18 (limiter down), AS-19 (live bus down), AS-29 (missing partition), AS-35 (hub down), AS-40 (presence store down), AS-45 (presence and coalescing stores down), AS-47 (outbox refusing).
- Concurrency tests use `Promise.all` and assert that exactly the allowed number succeed and the invariant holds (VII.3), repeated at least 20 times in one test: AS-03, AS-05, AS-13, AS-14, AS-34, AS-38, AS-53, AS-56.
- Async consumers (VII.4): the offline scheduler (AS-46), the offline check worker (AS-44, AS-46, AS-47) and the shop-deleted purge (AS-56) each get a duplicate-delivery test and an invalid-payload test.
- The k6 sync-storm script `scripts/load-tests/chat-sync.test.js` (`pnpm loadtest:chat-sync`: 50,000 requests per second of catch-up calls with jittered reconnects) proves SC-004; SC-009 is a capacity proof on the same harness. Both are ops artifacts, not part of this table.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 create channel | `chat-channels.e2e-spec.ts` | — | — |
| AS-02 create authorization (401, 403, 404) | `chat-channels.e2e-spec.ts` | — | — |
| AS-03 one channel per product, concurrent creates | `chat-channels.e2e-spec.ts` | — | — |
| AS-04 create validation, archived product | `chat-channels.e2e-spec.ts` | — | — |
| AS-05 join, idempotent and concurrent | `chat-channels.e2e-spec.ts` | W05 journey (join) | — |
| AS-06 join denials | `chat-channels.e2e-spec.ts` | — | — |
| AS-07 channel read, membership wall, discovery route | `chat-channels.e2e-spec.ts` | — | — |
| AS-08 update, archive, transitions | `chat-channels.e2e-spec.ts` | — | — |
| AS-09 send, next sequence | `chat-messages.e2e-spec.ts` | W05 journey (send) | — |
| AS-10 identical replay | `chat-messages.e2e-spec.ts` | — | — |
| AS-11 key reuse with different content | `chat-messages.e2e-spec.ts` | — | — |
| AS-12 key scope (other author, other channel) | `chat-messages.e2e-spec.ts` | — | — |
| AS-13 concurrent identical sends | `chat-messages.e2e-spec.ts` | — | — |
| AS-14 concurrent distinct sends, gateway-style inserts, gap-free | `chat-messages.e2e-spec.ts` | — | — |
| AS-15 rejected reply target leaves no gap | `chat-messages.e2e-spec.ts` | — | — |
| AS-16 send validation | `chat-messages.e2e-spec.ts` (one case per class) | — | `message-body.spec.ts` (code-point length, trim, whitespace table) |
| AS-17 send permission and state matrix | `chat-messages.e2e-spec.ts` | — | — |
| AS-18 send rate limit and limiter outage | `chat-messages.e2e-spec.ts` | — | — |
| AS-19 live bus outage does not fail send | `chat-messages.e2e-spec.ts` | — | — |
| AS-20 `chat.message_posted` per message, key, version, order | `chat-messages.e2e-spec.ts` | — | — |
| AS-21 sync returns what was missed | `chat-sync.e2e-spec.ts` | W05 journey (reconnect) | — |
| AS-22 sync paging over a large gap | `chat-sync.e2e-spec.ts` | — | `history-cursor.spec.ts` (window arithmetic) |
| AS-23 sync across channels, 50/51 limit | `chat-sync.e2e-spec.ts` | — | — |
| AS-24 non-member, banned, unknown channels omitted | `chat-sync.e2e-spec.ts` | — | — |
| AS-25 sync input validation, cursor beyond head | `chat-sync.e2e-spec.ts` | — | — |
| AS-26 tombstones, delete visible at once | `chat-sync.e2e-spec.ts` | — | — |
| AS-27 history pages, bounds, access | `chat-sync.e2e-spec.ts` | — | `history-cursor.spec.ts` (opaque cursor round trip, tamper table) |
| AS-28 across partitions, month-boundary replay | `chat-sync.e2e-spec.ts` | — | — |
| AS-29 partition maintenance and missing partition | `chat-sync.e2e-spec.ts` (job through its handler, frozen clock) | — | `partition-months.spec.ts` (month list from a date, DST-free UTC edges) |
| AS-30 unread computation and paging | `chat-read-state.e2e-spec.ts` | W05 journey (badge) | — |
| AS-31 posting advances own position | `chat-read-state.e2e-spec.ts` | — | — |
| AS-32 mark read monotonic and capped | `chat-read-state.e2e-spec.ts` | W05 journey (badge clears) | `read-position.spec.ts` (clamp table, `fast-check` monotonic) |
| AS-33 mark read validation and access | `chat-read-state.e2e-spec.ts` | — | — |
| AS-34 concurrent mark read | `chat-read-state.e2e-spec.ts` | — | — |
| AS-35 receipt event, topic access, hub outage | `chat-read-state.e2e-spec.ts` | — | — |
| AS-36 large-channel suppression | `chat-read-state.e2e-spec.ts` | — | — |
| AS-37 heartbeat, query, expiry | `chat-presence.e2e-spec.ts` | — | — |
| AS-38 online transition broadcast once | `chat-presence.e2e-spec.ts` | — | — |
| AS-39 presence privacy and input limits | `chat-presence.e2e-spec.ts` | — | — |
| AS-40 presence store outage | `chat-presence.e2e-spec.ts` | — | — |
| AS-41 heartbeat rate limit | `chat-presence.e2e-spec.ts` | — | — |
| AS-42 scheduling of checks | `chat-offline-push.e2e-spec.ts` | — | — |
| AS-43 check decision table | `chat-offline-push.e2e-spec.ts` (one wired case per outcome) | — | `escalation-decision.spec.ts` (full outcome table) |
| AS-44 coalescing window | `chat-offline-push.e2e-spec.ts` (frozen clock) | — | — |
| AS-45 presence and coalescing outage | `chat-offline-push.e2e-spec.ts` | — | — |
| AS-46 duplicate, out-of-order, invalid payload | `chat-offline-push.e2e-spec.ts` | — | — |
| AS-47 escalation append failure and retries | `chat-offline-push.e2e-spec.ts` | — | — |
| AS-48 escalation payload and privacy | `chat-offline-push.e2e-spec.ts` | — | — |
| AS-49 ban and unban, transitions | `chat-moderation.e2e-spec.ts` | — | `moderation-rules.spec.ts` (status transition table) |
| AS-50 rank rule, self, non-member target | `chat-moderation.e2e-spec.ts` | — | `moderation-rules.spec.ts` (rank matrix) |
| AS-51 mute and unmute | `chat-moderation.e2e-spec.ts` (frozen clock) | — | — |
| AS-52 promote and demote | `chat-moderation.e2e-spec.ts` | — | `moderation-rules.spec.ts` (role transition table) |
| AS-53 delete message | `chat-moderation.e2e-spec.ts` | — | — |
| AS-54 manager authority follows shop membership | `chat-moderation.e2e-spec.ts` | — | — |
| AS-55 gateway ticket | `chat-moderation.e2e-spec.ts` | — | — |
| AS-56 shop deleted purge | `chat-lifecycle.e2e-spec.ts` | — | — |
| AS-57 shop-id backfill | `chat-lifecycle.e2e-spec.ts` (migration plus job handler) | — | — |
| AS-58 isolation gates and gateway statements still valid | `chat-lifecycle.e2e-spec.ts` (gateway statements) plus static gates | — | — |
