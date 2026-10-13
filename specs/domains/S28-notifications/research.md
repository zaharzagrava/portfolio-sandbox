# Research: S28 — Notification routing (domain `notifications`)

Phase 0 of [plan.md](plan.md). No `NEEDS CLARIFICATION` remains: every unknown below is resolved from the code, the spec, `questions.md` (defaults accepted as written; no line was edited by a human) and the follow-ups handed over with this run. Each entry: Decision, Rationale, Alternatives.

## R-1 Reset mail does not come from an event (W01 deviation)

- **Decision**: `security.password_reset` is **not** a consumer row. The reset link reaches the user through the `PASSWORD_RESET_MAILER` port that identity defines and `TransactionalMailModule` already binds (`transactional-mail.service.ts`). The catalog keeps the type (templates, category `security`, mandatory, no inbox, max age 30 min) and the mailer renders it through the same catalog and template code, so AS-09 and AS-78..82 apply to it. Link `<front>/reset-password#token=<token>` (fragment, so the token never reaches an access log or `Referer`). `DeliveryMessage.type` already has `'auth.password_reset'`; it is aliased to the catalog type, not duplicated. Only `identity.password_changed` comes from the reset flow as an event.
- **Rationale**: `identity.password_reset_requested` is not emitted (W01, `contracts/events.md` of S01). Consuming a message nobody sends would make AS-87 pass on a fixture and fail in production.
- **Alternatives**: ask S01 to emit the message (rejected: the user input says the earlier bullets are superseded); keep a dormant consumer (rejected: dead code that can silently diverge).

## R-2 Single-consumer invite message

- **Decision**: `tenancy.invite_requested` is an outbox task on SQS queue `tenancy-invite-requested` (not on `tenancy.events`), body `{inviteId, shopId, shopName, email, role, token, expiresAt, invitedBy}`, `aggregateId` = shopId. A queue consumer in `NotificationsProjectorModule` (same validation, dead-letter-without-body and dedupe path as event consumers, dedupe identity `inviteId`) maps it to `shop.invite`: address recipient, e-mail line only, no inbox, no preference lookup, suppression still applies, link `<front>/invites/<token>`.
- **Rationale**: matches S03's P1 pass text. The token never enters the timeline, a log or a dead-letter record (FR-014).

## R-3 Consumed contracts: use the producer's schema when it exists, otherwise a consumer-side schema

- **Decision**: built producers (`order.paid|cancelled|refunded|fulfilment_changed` in `packages/contracts/src/orders/order-events.ts`, `payments.payment_failed` in `payments/payment-events.ts`) are imported as they are. For producers that are not built or have no contract yet (identity, tenancy, shop-onboarding, auctions, billing, payouts, launch-events, chat, discussions, feed, seller-insights, developer-platform, delivery) the plan adds **one file** `packages/contracts/src/notifications/consumed-events.ts` with zod schemas that contain exactly the fields a notification renders (spec "Requires" shapes), `strict` on the envelope, tolerant of extra payload fields (additive evolution, V.7). When a producer later ships its own schema, the mapping switches the import; the field names are the same.
- **Rationale**: IV.5 (validate before acting) cannot wait for the producers; X.4 forbids importing their classes; copying only rendered fields is IX.8.
- **Alternatives**: import the old event classes (today's projector; breaks X.4 and hides renames); skip validation until producers exist (violates IV.5).

## R-4 Events from other domains and the `order.fulfilment_changed.userId` gap

- **Decision**: the consumer schema for `order.fulfilment_changed` requires `userId`. If the schema in `packages/contracts` (S10) has no `userId` at implementation time, the mapping for `order.shipped|delivered` is built behind the schema and its e2e rows (AS-87) use a contract-valid fixture that carries it; the gap is a sibling follow-up for S10 (additive field). It is never resolved by reading S10's tables.
- **Rationale**: [CONTRACT] row of `questions.md`.

## R-5 Follower audience (S26) does not exist yet

- **Decision**: a port `FOLLOWER_AUDIENCE` in `domain/ports.ts` (`getFollowerIds(accountId, {limit ≤ 1000, cursor?})`). The adapter in `infra/` calls `FollowQueryService` from `@app/domains/community` when the entry point exports it; **today it does not** (grep: no `FollowQueryService` in `libs`), so the shipped adapter is a fail-closed stub that returns an empty page and increments `notifications_events_ignored_total{reason="audience_unavailable"}`. The marketing engine (priority line, caps, opt-in) is exercised in e2e through a test double bound to the port (system-edge-like fake of a missing sibling). Sibling bullet for S26.
- **Rationale**: the catalog row is binding (AS-87), the engine must be proven (AS-35..41), and importing a model of another domain is forbidden.
- **Alternatives**: remove the type (questions.md allows it only if S26 declines; not yet known); read follow tables (IX.4).

## R-6 Exactly-once: deterministic identities + atomic steps, markers only as shortcuts

- **Decision**: dedupe identity `(sourceId, recipient, channel)`; `deliveryId` and `inboxItemId` = UUIDv5 of the identity. Steps and their idempotency: (1) inbox insert = Cassandra `INSERT … IF NOT EXISTS`, `[applied]` says "new"; (2) counter `INCR` only when new, protected by the dirty-set repair (R-9); (3) realtime publish best effort only when new; (4) delivery timeline row = upsert on `deliveryId` with forward-only status; (5) cap admit = atomic script with a per-delivery final decision (R-8); (6) line enqueue with SQS FIFO-style dedupe id `deliveryId` (standard queue + worker-side claim, R-10). The Redis `notif:done:<identity>` marker (7 days) is written last and only short-circuits; losing it re-runs idempotent steps.
- **Rationale**: spec Assumptions (IV.5); fixes G-04, G-18, G-22.

## R-7 Version guard

- **Decision**: Redis script `GT`-style compare-and-set on key `notif:ver:<family>:<aggregateId>` (7 days): returns `stale` if `incoming < stored`, otherwise stores the max and returns `ok`. Equal version = same event redelivered → handled by dedupe, not dropped by the guard. Families: order, auction, delivery, payment, payout (FR-005). Fail mode on Redis outage: the consumer throws (transient → framework retry); never "assume fresh".

## R-8 Rolling-window caps

- **Decision**: one Lua script per call on sorted set `notif:cap:<userId>:<channel>` (score = admit time ms from the injected clock, member = `deliveryId`): trim entries older than the window, if `deliveryId` is already a member return its recorded decision (admit), else if `ZCARD < limit` add and admit, else reject and remember the rejection in `notif:cap:dec:<deliveryId>` (TTL = 7 days) so a replay is final. Limits push 3 / 1 h, e-mail 2 / 24 h, SMS 1 / 24 h. Store error: marketing → throw a transient `CapStoreUnavailable` (delivery stays in the retry path, nothing sent: fail closed, AS-39); transactional never calls the script.
- **Alternatives**: fixed window `INCR` (today; admits double at the boundary); token bucket from S50 (wrong semantics: caps are counts per window over delivery identities, not a rate).

## R-9 Unread counter and repair

- **Decision**: counter `notif:unread:<userId>` (Redis, no TTL beyond 400 days). Before the inbox insert the router adds `userId` to sorted set `notif:unread:dirty` (score = now); after a successful insert+count it removes it. The 5-minute job `notifications.reconcile-unread` (S49 periodic, `fleetConcurrency 1`) takes entries older than 60 s, rebuilds each counter from the inbox (bounded 1,000), removes the entry. A missing counter at read time is rebuilt inline (bounded) with `SET NX`. Mark read: Cassandra conditional update `IF read = false` returns `[applied]`; `DECR` only when applied (floor 0 via script).
- **Rationale**: AS-58, AS-61, AS-62 without a second source of truth (III.9).

## R-10 Delivery lines, delay, retry

- **Decision**: six SQS standard queues `notify-{email,sms,push}` and `notify-marketing-{email,sms,push}`, each with its own dead-letter queue (`…-dlq`), worker concurrency transactional 10 / marketing 3 per line (configurable). Message = `DeliveryMessage` validated with zod. Worker order per message: validate → atomic claim `SET notif:claim:<deliveryId> NX PX 90000` → suppression → current preference (non-mandatory) → maximum age → send budget (S50 `notify.<channel>[.marketing]`; over budget → `ChangeMessageVisibility` to `retryAfterMs`, attempt count unchanged) → provider chain → mark `sent` (`notif:sent:<deliveryId>`, 7 days) → timeline. Transient failure: `ChangeMessageVisibility` to `backoff(attempt)` from `domain/backoff.ts` (base 30 s ×2, cap 900 s, full jitter, injected `random`); the attempt number rides in the message attribute `ApproximateReceiveCount`; at 5 the worker sends the message to the dead-letter queue itself, records `failed/exhausted`, increments the counter. Quiet-hours delay ≤ 900 s = SQS `DelaySeconds`; longer = S49 job `notifications.wake-delivery` with `idempotencyKey = deliveryId` that re-checks age, suppression, preference and enqueues on the line.
- **Rationale**: bulkheads (P0618), FR-027..033. A crash after the provider accepted and before `sent` can duplicate once; the delivery id is the provider reference (spec Assumptions).

## R-11 Providers and production configuration

- **Decision**: a zod config schema `notifications.config.ts` (validated at startup through the S54 config mechanism): in `NODE_ENV=production` each channel the catalog uses needs real credentials (SES or SMTP for e-mail, Twilio for SMS, FCM for push), `NOTIFICATION_SECRET` (≥ 32 bytes, must differ from the JWT, session and every other configured secret), and the SNS topic ARN / Twilio auth token. Outside production the log/memory providers are chosen explicitly (`provider: "log"`), and their result is recorded as `sent` with `provider: "log"`, never `delivered`. `ChannelSender` gains: `failover` flag in the timeline, gauge `notifications_provider_circuit_state{provider}`.

## R-12 Callbacks: accept durably, apply in a worker

- **Decision**: controller verifies (raw body, SNS certificate host pinned to `sns.<region>.amazonaws.com`, topic ARN pinned, timestamp within 5 minutes; Twilio `X-Twilio-Signature` HMAC over URL + sorted params) then writes one message to SQS queue `notifications-callbacks` (dedupe id = provider event id: SNS `MessageId`, Twilio `MessageSid + MessageStatus`) and answers 2xx. The callback worker applies effects (status precedence, suppression, marketing e-mail off) idempotently; an unknown provider message id is re-queued with delay for ≤ 10 minutes. `SubscribeURL` is fetched only when HTTPS and host matches `^sns\.[a-z0-9-]+\.amazonaws\.com$`.

## R-13 Phone verification

- **Decision**: code = 6 random digits from a CSPRNG, stored as HMAC(`notification_secret`, userId|phone|code) in `notif:otp:<userId>` (TTL 600 s); attempts counter `notif:otp:att:<userId>` (5 per 15 min → lock key); requests limited by `notifications.phone-code.user` (3/h, fail closed) and `…phone-verify.user` (5 failures/15 min, fail closed). Success sets `NotificationSettings.phoneVerifiedAt` (expand migration: nullable column; contract never needed). Changing the phone nulls it. SMS goes out as the mandatory, immediate `security.phone_verification` type on the SMS line, bypassing quiet hours. The phone is returned masked (`+380•••••1234`).

## R-14 Recipient view and cache

- **Decision**: `RecipientViewService` builds the view in code (never SQL join): batch `UserDirectoryService.getUsersByIds` (≤ 500) for e-mail; own tables `NotificationSettings`, `NotificationPreference`, `PushDevice` read with `IN (…)`; cached per user in the S52 shared tier only (`l1: 'never'`), TTL 5 min, key invalidated by every preference, settings, device and phone write (and by complaint → marketing e-mail off). Suppression is never cached negatively beyond 0 s: it is a direct primary-key read (`l1: 'never'`, no negative TTL) so the next send sees a new row.

## R-15 Cursor and pagination

- **Decision**: inbox keyset `(eventTime desc, id desc)` bucketed by month in the existing partition scheme; cursor = base64url(`{v:1,u:userId,b:bucket,ps:pageState}` + `.` + HMAC-SHA256 truncated 16 bytes with `notification_secret`); wrong user, bad MAC, bad shape → `400 invalid_cursor`. Retention = Cassandra TTL 180 days on write; the month walk stops at `now − 180 d` (a derived constant, not `MONTHS_KEPT`).

## R-16 Mark-all watermark on arrival time

- **Decision**: inbox rows store `arrivedAt` (set at first insert, preserved on replay via `IF NOT EXISTS`). `readAllBefore:<userId>` = arrival-time watermark taken from the injected clock; an item is unread iff `read = false AND arrivedAt > watermark`. Counter after mark-all = 0 by `SET` guarded with the new-items race: items inserted with `arrivedAt` ≥ watermark after the `SET` increment normally.

## R-17 Transactions

- `notifications` has no `sequelize.transaction` site and no `// S54 T037 audit` comment (baseline `.tx.baseline` = 0 verified in the repo); the plan adds none. Multi-row Postgres writes (device cap eviction, preference upsert batch) use `TransactionRunner.run` from `@app/infrastructure/context` if they ever need atomicity: the device registration (insert + evict oldest beyond 10) does, and uses it.

## R-18 Out of this release (recorded, not planned)

`billing.subscription_status_changed`, `statements.*`, `ledger.reconciliation_*` (optional edge in the follow-ups: **not** consumed — no recipient directory for finance staff), `payout.in_doubt|discrepancy_detected`, `integration_*`, `catalog_sync.*`, `order_export.finished`, `flash_sale.*`, `live.*`, `payments.payment_succeeded|refunded`, `delivery.status_changed DELIVERED`. Each is a catalog row away.

## R-19 Rate-limit follow-up (S50) and cache follow-up (S52)

`definePolicies` + `forFeature` in `rate-limit-policies.ts`, with the structured `RateLimit`/`RateLimit-Policy` headers and the `503 rate_limiter_unavailable` / `422 rate_limit_cost_exceeded` answers documented in [contracts/http.md](contracts/http.md); the five numbers live in this domain. Cache: `l1: 'never'` for preference, suppression and site records (R-14).

## R-20 Job types (S49 follow-up)

`declareJobType` with a payload contract next to the `JobPayloads` augmentation for `notifications.wake-delivery` (`{deliveryId}`), `notifications.reconcile-unread` (periodic, no payload) and `notifications.purge-expired-state` is **not** needed (TTLs do it). The existing `notification-delivery.job-types.ts` is rewritten to declare the two types; `InvalidScheduleError` is caught where schedules are upserted; callers of `JobsService.cancel` (none today) would adapt to the discriminated result.
