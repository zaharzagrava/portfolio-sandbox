# Feature Specification: S28 — Notification routing (preferences, quiet hours, caps, per-channel queues, provider failover, inbox, suppression) — domain `notifications`

**Feature Branch**: `S28-notifications` (spec directory `specs/domains/S28-notifications`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: User description: "Capability S28 — Notification routing: preferences, quiet hours, caps, per-channel queues, provider failover, inbox, suppression (domain `notifications`)." Sources: `docs/showcase/sections/SD-17-notifications.md`; `10-System-Design/02-worked-examples.md` (Example 4); `10-System-Design/06-realtime-and-collaboration.md` (§17). Patterns that must be proven here (`docs/architecture/pattern-map.md`): **P0104** dates and time zones (quiet hours), **P0419** webhooks as consumer (provider status callbacks), **P0601** queue versus log, fan-out versus competing consumers (the router), **P0618** bulkheads (per-channel queues).

Companion files: [`questions.md`](questions.md) (decisions taken unattended, tagged), [`test-plan.md`](test-plan.md) (constitution VII.8 table), [`gaps.md`](gaps.md) (what today's code lacks, debt rows, IX.7 replacements), [`checklists/requirements.md`](checklists/requirements.md).

## Scope

In scope:

- **Routing**: domain events and single-consumer messages from other capabilities become notifications for the right people. Each notification is rendered once per recipient in the recipient's language, stored in the in-app inbox, and handed to the external channels (e-mail, SMS, push) the recipient allows. A notification is created **at most once** per (source event, recipient, channel), however often the source event is delivered (P0601).
- **Preferences and settings**: per category and channel opt-in or opt-out, mandatory notices that ignore opt-outs, SMS as an opt-in channel that needs a verified phone, time zone, language, quiet hours, push device registration, signed one-click unsubscribe.
- **Quiet hours** in the recipient's own time zone, daylight-saving-safe, for the intrusive channels (push, SMS); delayed delivery; stale notifications are dropped instead of arriving hours late (P0104).
- **Frequency caps** for marketing traffic, per user and channel, over a rolling window; transactional traffic is never capped.
- **Per-channel delivery lines** (bulkheads, P0618): e-mail, SMS and push are delivered independently, and marketing traffic is isolated from transactional traffic, so one provider outage or one campaign never delays the rest. Provider rate budgets, retries with backoff, a dead-letter path, **provider failover** behind circuit breakers.
- **In-app inbox**: paged list, unread counter, mark read (selected or all), live push to the open client, 180-day retention.
- **Suppression and provider status callbacks** (P0419): hard bounces, spam complaints, SMS STOP and dead push tokens stop all further sending to that address; signed provider callbacks update the delivery timeline.
- **Delivery timeline**: every external delivery has a status history that never regresses.

Out of scope (owners named):

- Producing the source events: orders → **S10**, payments → **S13**, payouts → **S15**, auctions → **S21**, booking → **S22**, chat → **S24**, discussions → **S25**, identity → **S01/S02**, shops → **S03/S04**, subscriptions → **S17**, courier delivery → **S20**, competitor watch → **S41**, webhooks → **S43**. They emit facts; this capability decides what to tell whom.
- Following graph and feed → **S26**; live streams → **S23**; statements → **S16**; finance and moderator alerts (no recipient directory exists, see Assumptions).
- Realtime transport and topic registry → **S51**; job scheduler → **S49**; token-bucket engine → **S50**; cache toolkit → **S52**; outbox, Kafka, queues and consumer framework → **S53**; problem+json filter, config validation, clock, health, metrics → **S54**.
- Marketing campaign authoring and audience tooling (an admin "send to segment" screen). Marketing traffic exists here only as the "new from a shop you follow" notice and as the engine (priority line, caps, opt-in) that any future campaign would use.
- Delivery analytics in a column store (change-data-capture of the delivery timeline) → S53/S39; this capability keeps the timeline and exposes metrics.
- Re-enabling an address that hit STOP (carrier-level START handling) and an admin console to inspect or lift suppressions.
- The web screens → **W03** (notification popover and bell) and its preferences screen; this capability gives them the HTTP and realtime contract. The UI journeys live in the web specs (see `test-plan.md`).

## Clarifications

Decided unattended; each is also in [`questions.md`](questions.md), BREAKING and CONTRACT first.

- Other domains no longer call a router service. They publish events; this capability consumes them (constitution IV.3, IX.7). Recipient contact data comes only from identity's and tenancy's exported services (R1); this capability never reads their tables.
- Marketing is opt-in on every external channel; only the in-app inbox is on by default. SMS is opt-in for every category and needs a phone number the user proved to own.
- Every message that can be wrong or harmful if late (an outbid push, a drop reminder, a reset link) has a maximum age. A message past it is dropped, never sent late.
- Replays of old events (a rebuilt consumer, a re-sent topic) must not re-notify people: an event older than its type's maximum age produces no external delivery.
- Provider callbacks are acknowledged after being durably accepted, not after being processed; processing is idempotent and status never moves backwards.
- Device removal, read marking and every other id-addressed call act only on the caller's own records; another user's id answers `404` (or is ignored in a batch) and changes nothing.

## User Scenarios & Testing *(mandatory)*

Every acceptance scenario has a stable ID `AS-nn`; `test-plan.md` maps each to exactly one row. Defaults referenced below are listed under *Defaults* in Requirements. Errors are `application/problem+json` with a stable `code`. "The consumer" means this capability's event consumer; "the worker" means its channel delivery worker.

### User Story 1 — A fact happens, the right people hear about it exactly once (Priority: P1)

A buyer pays; the buyer gets an in-app item and an e-mail, each shop in the order is told it has an order. Whether the source event arrives once, twice, concurrently, late, out of order or after a crash, nobody is told twice and nobody is told something false.

**Why this priority**: it is the capability's reason to exist and carries the exactly-once and ordering guarantees every other story builds on.

**Independent Test**: publish an `order.paid` event for a seeded buyer and shop; assert the inbox item, the unread count, the queued and sent e-mail, then deliver the event again.

**Acceptance Scenarios**:

- **AS-01 (happy path)** — **Given** buyer B (locale `uk`, default preferences, e-mail on file) and event `order.paid` `{orderId, userId: B, totalMinor: 129900, currency: "USD", paymentRef, paidAt, lines, shopOrders: [{shopOrderId, shopId: S1, subtotalMinor: 129900}], orderVersion: 3}` with `eventId: E1`, **When** the consumer processes it, **Then** B's inbox holds exactly one item `{type: "order.confirmed", category: "orders", read: false, link: "/orders/<orderId>", title/body in Ukrainian, amount formatted from 129900 USD for `uk`}`; `GET /api/notifications/unread-count` → `{unread: 1}`; exactly one e-mail is handed to the e-mail provider (subject in Ukrainian, HTML-escaped body, `unsubscribeUrl` present); the delivery timeline shows `queued` then `sent` for `(E1, B, email)`; one realtime event `notification` is published to B's own topic with `unread: 1`; the owners of shop S1 each get a `shop.order_received` item (AS-07 covers recipients).
- **AS-02 (duplicate and concurrent delivery)** — **Given** AS-01's event, **When** it is delivered a second time after the first completed, **and separately** delivered 10 times concurrently for a different buyer, **Then** in both cases the buyer ends with exactly one inbox item, one e-mail, `unread` 1 and one realtime event; the delivery timeline holds one row per `(eventId, user, channel)`; no call fails.
- **AS-03 (crash and replay)** — **Given** the queue refuses the first e-mail hand-off (forced fault) after the inbox item was stored, **When** the consumer's retry redelivers the same event, **Then** the final state equals AS-01 exactly (one inbox item, one e-mail, `unread` 1, one realtime event); no step that already completed is repeated visibly.
- **AS-04 (invalid payload, poison isolation)** — **Given** a batch of 3 events where the second has a payload that fails schema validation (for example `totalMinor` is a string), **When** the consumer processes the batch, **Then** the second is dead-lettered with reason `invalid_payload` and its `eventId`, with no inbox item, queue message or timeline row; the other two are fully processed; the consumer never blocks on the bad message.
- **AS-05 (unknown and unsupported events)** — **Given** an event of a type this capability does not map, and a known type with `version: 99`, **When** each is consumed, **Then** the unknown type is acknowledged and ignored (counter `notifications_events_ignored_total{reason="unmapped"}` +1, no side effects); the unsupported version is dead-lettered with reason `unsupported_version`.
- **AS-06 (recipient cannot be resolved or reached)** — **Given** an `order.paid` for a user id that identity does not know (deleted account), and another for a user whose identity has no e-mail address, **When** consumed, **Then** the first produces nothing and is counted `notifications_events_ignored_total{reason="recipient_not_found"}` without error or dead-letter; the second produces the inbox item and push (if a device exists) but no e-mail row and no error.
- **AS-07 (shop recipients, batched lookup)** — **Given** shop S1 with members OWNER A, OWNER B and STAFF C, and a batch of 40 events targeting 12 distinct shops, **When** a `payout.paid {payoutId, shopId: S1, amountMinor, currency, ...}` is consumed within that batch, **Then** A and B each get one `payout.paid` item and C gets nothing; tenancy's membership service is called once for the whole batch (≤ 500 shop ids per call), identity's directory once for the whole batch; each recipient has their own dedupe (a replay creates nothing new).
- **AS-08 (address-targeted message)** — **Given** the single-consumer message `tenancy.invite_requested {inviteId, shopId, shopName, email: "new@mail.com", role, token: "T", expiresAt, invitedBy}`, **When** consumed (and delivered twice), **Then** exactly one e-mail goes to `new@mail.com` containing the link `<front>/invites/T`; no inbox item and no preference lookup exist for an address; if `new@mail.com` is on the suppression list the timeline shows `suppressed` and the provider is not called; the type is mandatory so a recipient-side opt-out never applies.
- **AS-09 (secrets travel once)** — **Given** the single-consumer message `identity.password_reset_requested {userId, resetToken: "R", expiresAt}` for a user who switched every channel off, **When** consumed, **Then** one e-mail with the link `<front>/reset-password?token=R` is sent (mandatory type); no inbox item exists; across all logs, the delivery timeline, metrics and the dead-letter record (force a failure to produce one) the token `R` never appears; the dead-letter record carries the message id and a failure code only.
- **AS-10 (out-of-order events)** — **Given** auction A with `auction.closed` (`auctionVersion: 7`, winner W) already consumed, **When** a late `auction.leader_changed` (`auctionVersion: 6`, previous leader L) arrives, **Then** L receives no outbid notice; and **given** a delivery's `PICKED_UP` (`deliveryVersion: 3`) consumed after `DELIVERED` (`deliveryVersion: 4`), **Then** no "out for delivery" notice is created. An event whose version is **higher** than the last notified one is always processed.
- **AS-11 (stale events are not sent)** — **Given** an `auction.leader_changed` whose `occurredAt` is 2 hours ago (type maximum age 1 hour), **When** consumed, **Then** no push, SMS or e-mail is queued, the timeline records `expired` for each external channel the user would have had, and the inbox item is still created (history is kept); an event 5 minutes old is delivered normally.
- **AS-12 (render failure is isolated)** — **Given** two events in one batch where the first renders with a missing template variable, **When** consumed, **Then** the first is dead-lettered with reason `render_failed` and no partial side effects (no inbox item, no queue message); the second is delivered; the failure is logged without recipient data.
- **AS-13 (event → notification rules, pure)** — **Given** the rule table of "Notification catalog", **When** each source event is mapped, **Then** the output is exactly the listed recipients, type and data: `discussion.comment_created` never notifies its own author and notifies a parent author once even if they also own the post; `order.cancelled` with reason `user_cancelled` or `payment_failed` produces nothing; `order.fulfilment_changed` with status `FULFILLING` produces nothing; `payments.payment_failed` with reason `order_not_payable` or `order_cancelled` produces nothing; `billing.invoice_payment_failed` with `nextAttemptAt: null` maps to `billing.access_withdrawn`; `auction.closed` without a winner produces nothing.

---

### User Story 2 — I decide what I hear, where and when (Priority: P1)

A user sees a matrix of categories and channels, switches cells, sets a time zone and quiet hours, proves a phone number to turn on SMS, registers devices, and can leave any mailing with one click from a mail client. Notices that protect the account or the money cannot be switched off.

**Why this priority**: consent and control are legal and trust requirements; routing decisions read this data.

**Independent Test**: read the default matrix, flip a cell, route an event, assert the channel is skipped; follow an unsubscribe link.

**Acceptance Scenarios**:

- **AS-14 (defaults)** — **Given** a new user with no stored settings, **When** `GET /api/notifications/preferences`, **Then** `200 {settings: {timezone: "UTC", locale: "en", quietStart: null, quietEnd: null, phone: null, phoneVerified: false}, preferences: [{category, channels: {email, sms, push, inapp}, mandatoryChannels}]}` with: `inapp` true in every category; `sms` false everywhere; `marketing` false on `email`, `sms` and `push`; every other category true on the channels in the catalog's default list and false elsewhere; `mandatoryChannels` lists the channels at least one mandatory type of that category sends on (for example `security` → `["email"]`).
- **AS-15 (change a cell)** — **Given** the default matrix, **When** `PUT /api/notifications/preferences {category: "orders", channel: "email", enabled: false}`, **Then** `200` with the full matrix (that cell false); repeating the call returns the same `200` and matrix; a later `order.paid` for this user creates the inbox item and push but no e-mail; turning it back on restores e-mail for events routed afterwards.
- **AS-16 (preference validation and authentication)** — **Given** the endpoint, **When** called without credentials, with an unknown category, an unknown channel, a non-boolean `enabled`, a missing field, or an extra field, **Then** `401` without credentials; `400 validation_failed` (naming the field) for each other case; nothing is stored; the 61st write of one user within a minute (any write endpoint under policy `notifications.write.user`) answers `429` with `Retry-After`.
- **AS-17 (mandatory notices)** — **Given** a user who set every category and channel to false, **When** a `billing.invoice_payment_failed` event, an `identity.password_changed` event and a `shop.invite`-type message for their address are consumed, **Then** each still produces its e-mail (and inbox item where its type has one); **and given** the address is suppressed (AS-76), **Then** the e-mail is not sent: mandatory notices ignore preferences but never suppression.
- **AS-18 (SMS is opt-in and needs a verified phone)** — **Given** a user with a phone number that is not verified, **When** `PUT /api/notifications/preferences {category: "orders", channel: "sms", enabled: true}`, **Then** `422 phone_not_verified`, nothing stored; **given** a verified phone and the cell enabled, **Then** a later `order.paid` queues one SMS; a user without a verified phone never gets an SMS even if a cell was enabled earlier and the phone was since changed (AS-21).
- **AS-19 (settings and their effect)** — **Given** a user in `UTC`, **When** `PUT /api/notifications/settings {timezone: "Europe/Kyiv", locale: "uk", quietStart: "22:00", quietEnd: "07:30"}`, **Then** `200` with the full matrix reflecting the new settings; the next notification routed for this user is rendered in Ukrainian and judged against Kyiv quiet hours (AS-30); no stale copy of the old settings is used by any process after the `200`.
- **AS-20 (settings validation)** — **Given** the endpoint, **When** called with: an unknown IANA zone (`"Mars/Base"`), a locale not matching `xx` or `xx-YY`, `quietStart: "25:00"`, only `quietStart` while no `quietEnd` is stored, `quietStart` equal to `quietEnd`, a phone not in E.164, no credentials, **Then** `401` for the last; `400 validation_failed` for the format errors; `422 quiet_hours_incomplete` when exactly one of the two ends would be set after the update; `422 quiet_hours_invalid` when both are equal; `{quietStart: null, quietEnd: null}` clears quiet hours; nothing is stored on failure.
- **AS-21 (verify a phone)** — **Given** a user who sets `phone: "+380501234567"` through settings, **When** the update succeeds, **Then** `phoneVerified: false`, the response shows the phone masked (`"+380•••••4567"`), and one SMS with a 6-digit code is sent at once (it bypasses quiet hours, caps and the SMS opt-in); `POST /api/notifications/settings/phone/verify {code}` with the right code → `200` matrix with `phoneVerified: true`; changing the phone again sets `phoneVerified: false` and cancels any pending code; `phone: null` clears the phone and the verification.
- **AS-22 (verification failures)** — **Given** a pending code, **When** a wrong code is posted, **Then** `422 code_invalid {attemptsLeft: 4}`; after 5 wrong codes the pending code is void and further attempts answer `429 verification_locked` with `Retry-After: 900`, even for the right code; an expired code (> 10 minutes) answers `422 code_expired`; verifying with no pending code answers `422 code_not_requested`; a used code cannot be reused.
- **AS-23 (code requests are rate limited)** — **Given** a user who has requested 3 codes within an hour, **When** a 4th is requested (settings update with a changed phone, or `POST /api/notifications/settings/phone/code`), **Then** `429` with `Retry-After`, no SMS is sent; a code request for a phone that is on the SMS suppression list answers `422 phone_unreachable` and sends nothing.
- **AS-24 (concurrent writes)** — **Given** two concurrent `PUT /preferences` for the same cell with opposite values and two concurrent writes for different cells, **When** run with `Promise.all` (repeated 20 times), **Then** every call answers `200`; the same-cell race ends in exactly one of the two values (never an error or a mix); both different-cell writes persist; the stored state equals what the last `GET` returns.
- **AS-25 (one-click unsubscribe)** — **Given** an e-mail carrying `unsubscribeUrl` for user U and category `orders`, **When** `GET <url>`, **Then** `200 {category: "orders"}` and nothing changes (mail scanners pre-fetch links); **When** `POST <url>` (also with body `List-Unsubscribe=One-Click`), **Then** `200 {unsubscribed: "orders"}`, U's `orders`/`email` cell is false, later e-mails of that category are not sent, other channels and categories are untouched; repeating the `POST` answers the same `200`.
- **AS-26 (bad unsubscribe tokens)** — **Given** a forged token, a token with a tampered category, a token signed for U used for another user's id, an empty token, and a valid token after 31 requests from one IP within a minute, **When** each is posted, **Then** `400 invalid_unsubscribe_token` for the first four (no change to anyone), and `429` with `Retry-After` for the last; a valid token never expires.
- **AS-27 (unsubscribe link rules)** — **Given** one e-mail of a non-mandatory type and one of a mandatory type, **When** handed to the provider, **Then** the first carries `unsubscribeUrl` (and the provider adapter must send both `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers); the second carries none.
- **AS-28 (devices)** — **Given** a signed-in user, **When** `POST /api/notifications/devices {token, platform: "ios"}`, **Then** `201 {id, platform, lastSeenAt}` (never the token); the same token again → `200` with the same `id`; `GET /api/notifications/devices` lists only the caller's devices without tokens; the same token registered by another user moves to that user (the first user's list no longer has it and no longer receives its pushes); registering an 11th device evicts the least recently seen; invalid input (`token` empty or > 4096 characters, `platform` outside `ios|android|web`) → `400 validation_failed`; no credentials → `401`.
- **AS-29 (device removal is owner-only)** — **Given** device D of user A, **When** user B calls `DELETE /api/notifications/devices/<D.id>`, **Then** `404 device_not_found` and D still exists; A's own call answers `204` and D is gone; a malformed id answers `400`; repeating A's call answers `404`.

---

### User Story 3 — Quiet hours and frequency caps respect people's time and attention (Priority: P1)

A user in Kyiv asleep between 22:00 and 07:30 does not get a push or an SMS at night; it arrives when the window ends, or not at all if it has gone stale. Marketing never exceeds a cap, even under a burst.

**Why this priority**: it is the notes' headline behaviour for P0104 and the user's trust in the product.

**Independent Test**: set quiet hours around "now", route an outbid event, assert a delayed push and an immediate inbox item; route 4 marketing notices and assert the 4th is capped.

**Acceptance Scenarios**:

- **AS-30 (delay up to 15 minutes)** — **Given** a user whose quiet window ends in 10 minutes (frozen clock) with a push device, **When** `order.confirmed` (push channel) is routed, **Then** the inbox item exists at once and the push is held on the push line with a delay of 600 seconds (± 1 s) and timeline status `delayed` with the wake instant; no provider call happens before the wake instant, and one push is sent after it.
- **AS-31 (delay beyond 15 minutes)** — **Given** a window ending in 2 hours, **When** a push-channel notification is routed (and the same event replayed), **Then** exactly one scheduled job exists for `(deliveryId)` with `runAt` = the window end (± 1 s); when it fires the message joins the push line; the inbox item exists at once.
- **AS-32 (which channels and types are affected)** — **Given** the user is inside quiet hours, **When** a notification with e-mail, push and inbox channels is routed, **Then** the e-mail is queued at once, the inbox item is created at once, only the push is delayed; **and** a mandatory type (`security.password_changed`) is never delayed on any channel; **and** the phone verification SMS (AS-21) is never delayed.
- **AS-33 (time-zone arithmetic, pure)** — **Given** the rule table in the test plan (windows crossing midnight, windows not crossing, `now` exactly at `start`, exactly at `end`, `start = end`, zones `Europe/Kyiv`, `America/New_York`, `Asia/Kolkata` (+05:30), `Pacific/Auckland`; the Kyiv spring-forward night where local 03:00 does not exist and the autumn night where 03:00–04:00 occurs twice; `end` falling inside a skipped hour), **When** the window function is evaluated, **Then** it returns the exact instant the window ends (the next valid wall-clock instant when the end time does not exist, the first occurrence when ambiguous) or "send now"; an unknown zone name is rejected at write time and, if ever read, behaves as UTC with a warning counter.
- **AS-34 (stale after waiting)** — **Given** a push-channel `auction.outbid` held until 07:30 whose maximum age (1 hour) ends first, **When** the wake instant passes the maximum age, **Then** the delivery is not sent: timeline `expired`; the inbox item stays.
- **AS-35 (marketing cap)** — **Given** a user who opted in to marketing push, cap 3 pushes per rolling hour, **When** four distinct `feed.item_published` events (kind `drop_announced`) are consumed within the hour, **Then** the first three are queued; the fourth is recorded `capped` and not queued; all four inbox items exist; a transactional push (`order.confirmed`) in the same hour is never capped.
- **AS-36 (cap under concurrency)** — **Given** the same user, **When** 10 distinct marketing events are consumed concurrently (`Promise.all`, repeated 20 times with fresh users), **Then** exactly 3 deliveries are queued and 7 are `capped` in every run; never 4.
- **AS-37 (cap and replay)** — **Given** AS-35's first admitted delivery and the capped fourth, **When** each source event is replayed, **Then** the admitted one does not take a second slot, the capped one stays capped (the first decision for a `(deliveryId)` is final), and the count of admitted deliveries in the window is still 3.
- **AS-38 (rolling window and per-channel limits)** — **Given** a frozen clock, **When** 3 marketing pushes are admitted at 10:00:10, a 4th at 10:59:59, and a 5th at 11:00:11, **Then** the 4th is capped (3 within the hour ending 10:59:59) and the 5th is admitted (only 2 admitted in the hour ending 11:00:11); e-mail allows 2 per rolling 24 hours and SMS 1 per rolling 24 hours, each counted per user and channel independently.
- **AS-39 (cap store unavailable)** — **Given** the store holding cap counters is unreachable (forced), **When** a marketing event and a transactional event are consumed, **Then** the transactional delivery proceeds normally; the marketing event's external deliveries are **not** sent without a cap decision (the consumer retries the event with backoff; once the store returns, the delivery is decided and queued exactly once); the inbox item is created once.

---

### User Story 4 — A provider outage or a campaign never blocks the rest (Priority: P1)

SMS provider down: SMS backs up, e-mail and push flow. Marketing burst: "your order shipped" is still sent within seconds. E-mail provider A fails: provider B sends. A bad address is never retried and never contacted again.

**Why this priority**: P0618 and the reliability promise of the notes.

**Independent Test**: force the SMS provider to fail, route one event with e-mail and SMS channels, assert e-mail is sent while SMS is retried.

**Acceptance Scenarios**:

- **AS-40 (channel bulkhead)** — **Given** the SMS provider fails every call (forced) and 50 SMS deliveries are queued, **When** 20 e-mail and 20 push deliveries are queued after them, **Then** all 40 are sent within the normal delivery time (no waiting behind SMS retries); the SMS deliveries are retried per AS-47; the SMS backlog does not consume e-mail or push worker capacity.
- **AS-41 (priority isolation)** — **Given** a backlog of 500 queued marketing push deliveries, **When** one transactional push is queued, **Then** it is sent before the marketing backlog drains (it never waits behind it); **and** with the marketing SMS line failing, marketing push still drains; marketing and transactional deliveries of the same channel use different budgets.
- **AS-42 (provider rate budget)** — **Given** the e-mail provider's send budget is exhausted for the current second (token bucket empty), **When** a delivery is taken from the e-mail line, **Then** it is put back with a delay equal to the limiter's retry-after (at least 1 s, at most 15 min), no attempt is counted against its retry limit, and it is sent when budget exists; marketing draws on its own smaller budget (default 20 % of the channel's), so an exhausted marketing budget never delays transactional sends.
- **AS-43 (limiter outage)** — **Given** the rate-limit store is unreachable (forced), **When** a transactional and a marketing delivery are taken, **Then** the transactional one is sent (fail-open; the provider's own 429 is handled as a transient error), the marketing one is put back with a 60-second delay (fail-closed); both outcomes are counted in `notifications_limiter_unavailable_total{priority}`.
- **AS-44 (failover)** — **Given** the primary e-mail provider returns a transient failure for a message, **When** the worker sends it, **Then** the fallback provider is tried in the same attempt and succeeds: timeline `sent` with `provider` = fallback and `failover: true`; exactly one e-mail leaves; the primary was called once.
- **AS-45 (circuit breaker)** — **Given** the primary provider fails more than 50 % of at least 10 calls in the rolling window, **When** the next messages are sent, **Then** the primary's breaker opens and the following messages go to the fallback **without calling the primary** (zero calls recorded); after the 30-second reset time exactly one probe message goes to the primary; if the probe succeeds the breaker closes and traffic returns, if it fails it reopens; breaker open/close transitions are logged and counted `notifications_provider_circuit_state{provider}`.
- **AS-46 (permanent failure)** — **Given** a provider answers "this address will never work" (invalid mailbox, invalid phone number, unregistered push token), **When** the worker sends, **Then** no failover and no retry happens; e-mail and SMS addresses are added to the suppression list with reason `provider-permanent`; an unregistered push token removes that device; the timeline shows `failed` with the provider's code; the message is acknowledged.
- **AS-47 (retries and dead letter)** — **Given** all providers of a channel fail transiently (forced), **When** a delivery is attempted, **Then** it is retried with exponential backoff and full jitter (AS-48) up to 5 attempts; after the 5th it is moved to the dead-letter line, the timeline shows `failed` with detail `exhausted`, `notifications_dead_lettered_total{channel}` +1; other deliveries on the same line are not delayed by the retries; the retry layer is the line itself (adapters never retry).
- **AS-48 (backoff, pure)** — **Given** attempts 1…5, base 30 s, factor 2, cap 15 min, **When** the delay is computed with a seeded random source, **Then** it lies in `[0, min(900, 30·2^(attempt-1))]` seconds, is deterministic for the same seed, and never exceeds 900.
- **AS-49 (duplicate delivery of a queue message)** — **Given** a delivery already sent, **When** the same queue message is delivered again (visibility timeout expired), **Then** the provider is not called and no new timeline row appears; two concurrent copies produce one provider call (repeat 20 times).
- **AS-50 (malformed queue message)** — **Given** a message on a delivery line whose body fails validation (missing `deliveryId`, unknown channel), **When** the worker receives it, **Then** it is dead-lettered with reason `invalid_message`, no provider is called, and the line keeps flowing.
- **AS-51 (suppression checked at send time)** — **Given** a delivery queued (or delayed) while the address was clean, **When** the address is suppressed before the worker takes it, **Then** the provider is not called and the timeline shows `suppressed`; a push to a user whose only token was removed shows `suppressed` with detail `no_device`.
- **AS-52 (preference checked at send time)** — **Given** a non-mandatory push delayed by quiet hours, **When** the user switches the push cell off before the wake instant, **Then** at send time the delivery is not sent: timeline `skipped` with detail `preference`; a mandatory type ignores this check.
- **AS-53 (provider timeout)** — **Given** the primary provider does not answer within 10 seconds, **When** the worker sends, **Then** the call is abandoned, counted as a transient failure for the breaker, and the fallback is tried within the same attempt; total handling time for the message stays below 25 seconds.
- **AS-54 (production configuration)** — **Given** production mode and a channel that the catalog sends on but with no provider credentials configured (or an unset unsubscribe secret), **When** the worker or the core application boots, **Then** startup fails with a message naming the missing setting; in non-production modes the local stand-ins (log-only providers, local SMTP) are used and are reported in the startup log; a delivery handled by a stand-in is recorded with `provider: "log"` and never reported as `delivered`.

---

### User Story 5 — My inbox and bell are always right (Priority: P1)

The bell shows the number of unread items live; the list pages newest first; opening or clearing items updates every open tab; nothing from another user ever appears.

**Why this priority**: the in-app inbox is the only channel every user always has, and the notes size it at 30k reads per second.

**Independent Test**: route three events, list, mark one read, mark all read, assert counts and read flags.

**Acceptance Scenarios**:

- **AS-55 (paging)** — **Given** 45 items for a user across two calendar months, **When** `GET /api/notifications?limit=20` and then each `nextCursor`, **Then** pages hold 20, 20 and 5 items, newest first by event time (ties broken by item id), no item repeats or is skipped across the month boundary, the last page has `nextCursor: null`; items of other users never appear; the response parses with the contract schema `notificationPageSchema`.
- **AS-56 (list validation and authentication)** — **Given** the list endpoint, **When** called with `limit=0`, `limit=51`, `limit=abc`, a garbage cursor, a cursor issued to another user, or no credentials, **Then** `400 validation_failed` for the first three; `400 invalid_cursor` for the next two (no data leaks); `401` without credentials; the default limit without a parameter is 20; the 121st list or count request of one user within a minute answers `429` with `Retry-After` (policy `notifications.read.user`).
- **AS-57 (unread count)** — **Given** three unread and two read items, **When** `GET /api/notifications/unread-count`, **Then** `200 {unread: 3}`; without credentials `401`.
- **AS-58 (mark read, once)** — **Given** unread item I, **When** `POST /api/notifications/read {ids: [I]}` from two tabs concurrently (`Promise.all`, repeated 20 times), **Then** both answer `200` with the same final `{unread: n-1}`; the count drops by exactly one; a later repeat answers `200` with the same count; the item shows `read: true`.
- **AS-59 (mark read validation and ownership)** — **Given** the endpoint, **When** called with both `ids` and `all: true`, neither, `ids: []`, more than 100 ids, an id that is not a valid item id, or `all: false`, **Then** `400 validation_failed` for each; **When** called with the id of another user's item and an unknown but valid id, **Then** `200` and the caller's count is unchanged; the other user's item is still unread (checked through that user's list); no credentials → `401`.
- **AS-60 (mark all read)** — **Given** 3 unread items, **When** `POST /api/notifications/read {all: true}`, **Then** `200 {unread: 0}`, every listed item shows `read: true`; **when** an event whose `occurredAt` is **earlier** than the mark-all moment is consumed afterwards, **Then** its item is unread and `unread` is 1 (read state follows arrival, not event time).
- **AS-61 (counter loss)** — **Given** 3 unread items and the stored unread counter removed (forced), **When** `GET /api/notifications/unread-count`, **Then** `{unread: 3}`; a new notification then makes it 4; the rebuild looks at no more than the newest 1,000 items (a user with more than 1,000 unread shows 1,000).
- **AS-62 (crash between storing and counting)** — **Given** the process fails after storing an inbox item and before counting it (forced), **When** the event is retried and the periodic reconciliation (every 5 minutes) has run, **Then** the unread count equals the number of unread items; no item is counted twice.
- **AS-63 (realtime outage)** — **Given** the realtime hub rejects publishes (forced), **When** an event is consumed, **Then** routing succeeds, the item is stored and counted, no retry loop occurs, `notifications_realtime_publish_failed_total` +1, and the next list/count call shows the item.
- **AS-64 (retention)** — **Given** an item created 181 days ago (clock advanced), **When** the user lists, **Then** it is absent and not counted; an item 179 days old is listed.
- **AS-65 (inbox opt-out)** — **Given** a user who switched `inapp` off for `auctions`, **When** an outbid event is consumed, **Then** no inbox item, no count change and no realtime event is produced; the push still follows its own cell; mandatory types always create their item.
- **AS-66 (item content)** — **Given** a user with locale `uk`, **When** an item is created, **Then** its title and body are in Ukrainian from the recipient's settings at that moment (a later locale change does not rewrite old items), `title` ≤ 120 characters and `body` ≤ 500 (longer text is cut with an ellipsis), and `link` is an application-relative path built by the catalog (never a URL supplied by an event).

---

### User Story 6 — Bad addresses and complaints stop mail for good (Priority: P2)

A spam complaint, a hard bounce, an SMS "STOP" or a dead push token ends all sending to that address, immediately and permanently. Provider callbacks are verified, acknowledged fast, de-duplicated and never move a delivery's status backwards.

**Why this priority**: sender reputation and legal opt-out; independent of the routing story.

**Independent Test**: post a signed e-mail provider complaint for a delivered e-mail; route another event; assert the provider is not called.

**Acceptance Scenarios**:

- **AS-67 (complaint)** — **Given** a delivered e-mail to U with provider message id `M`, **When** a correctly signed callback for the pinned topic reports a complaint for `M`, **Then** `200`; U's address is suppressed (`complaint`), U's `marketing`/`email` cell is false, the delivery shows `complained`; the next event for U sends no e-mail (timeline `suppressed`, provider not called).
- **AS-68 (bounces)** — **Given** a permanent bounce and a transient bounce, **When** each is posted, **Then** the permanent one suppresses the address (`hard-bounce`) and marks `bounced`; the transient one marks `failed` (detail `Transient`) and suppresses nothing.
- **AS-69 (callback verification)** — **Given** e-mail provider callbacks with: a topic other than the pinned one, a forged signature, a tampered message body, a signing-certificate URL outside the provider's host pattern or not HTTPS, a timestamp older than 5 minutes, a body that is not JSON, and a valid envelope whose inner message is not JSON, **When** each is posted, **Then** `403` (wrong topic), `401` (signature, tampered, certificate URL, stale), `400` (not JSON, inner not JSON); in every case no suppression, preference or timeline change happens.
- **AS-70 (acknowledge fast, process once)** — **Given** a valid complaint callback, **When** posted, **Then** `200` is returned once the event is durably accepted (before its effects are applied); the same callback id posted 10 times concurrently applies its effects once; the effects are visible shortly after (suppression within 5 seconds); a failure while applying leaves the event retriable and never loses it.
- **AS-71 (status never regresses, pure)** — **Given** the status order `queued < delayed < sent < delivered`, with `bounced`, `complained`, `failed` overriding `sent` and `delivered`, `suppressed`, `capped`, `skipped`, `expired` being terminal pre-send outcomes, **When** the update rule is applied to every pair (current, incoming), **Then** the result follows the table in the test plan: `delivered` arriving after `complained` is ignored; `complained` after `delivered` wins; `sent` after `delivered` is ignored; a repeated status is a no-op.
- **AS-72 (callback before our record)** — **Given** a delivery callback whose provider message id has no timeline mapping yet (it raced the worker's own write), **When** posted, **Then** `200`, and the status is applied once the mapping appears (retried for up to 10 minutes, then dropped with a counter `notifications_callbacks_dropped_total{reason="unknown_message"}`).
- **AS-73 (subscription confirmation)** — **Given** a signed `SubscriptionConfirmation` for the pinned topic, **When** its `SubscribeURL` is on the provider's HTTPS host, **Then** the subscription is confirmed with a 5-second timeout; **when** the URL is on any other host or is not HTTPS, **Then** `400` and no outbound request is made.
- **AS-74 (SMS status callbacks)** — **Given** the SMS provider's callback signature scheme, **When** a delivered, a failed (error 30003) and a STOP (error 21610) callback are posted with valid signatures, **Then** `delivered` / `failed` are recorded and the STOP number is suppressed (`sms-stop`, E.164 normalized); an invalid or missing signature answers `401` with no effect; an unconfigured signing key answers `401`.
- **AS-75 (SMS callback replay)** — **Given** the same signed SMS callback `(MessageSid, MessageStatus)` posted twice (the scheme has no timestamp), **When** the second arrives, **Then** it answers `200`/`204` and has no further effect (one status change, one suppression row).
- **AS-76 (suppression semantics)** — **Given** the suppression list, **When** `Alice@Mail.com ` (mixed case, spaces) is suppressed, **Then** `alice@mail.com` is suppressed for e-mail; an SMS suppression holds the E.164 number; suppressing twice stores one row; a check made just before a suppression is not served stale afterwards (the very next send is blocked, no negative-cache delay); suppression is per channel (a suppressed e-mail address does not block SMS to the same user); mandatory notices obey it (AS-17).
- **AS-77 (complaint for an unknown delivery)** — **Given** a complaint whose provider message id matches no delivery of ours, **When** posted, **Then** `200`, the address is still suppressed, no preference changes (no user is known), and the callback is counted `notifications_callbacks_dropped_total{reason="unknown_message"}` only for the status part.

---

### User Story 7 — Messages read well in my language and cannot be abused (Priority: P2)

Templates are data. Variables are escaped, missing variables fail loudly, languages fall back sensibly, money shows in the user's locale with the right decimals, and nothing from an event can inject a header or a link.

**Why this priority**: correctness and safety of every message; all pure and cheap to prove.

**Independent Test**: render each template table row in `en`, `uk` and an unsupported locale.

**Acceptance Scenarios**:

- **AS-78 (interpolation and escaping)** — **Given** a product title `<script>alert(1)</script> & "Co"` in an HTML template and in a plain-text template, **When** rendered, **Then** the HTML output contains `&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Co&quot;` and the plain text keeps the raw characters; placeholders with spaces (`{{ var }}`) work; text that looks like a placeholder inside a value is not expanded again.
- **AS-79 (missing variable)** — **Given** a template referencing `{{orderShort}}` and data without it, **When** rendered, **Then** rendering throws an error naming the variable; no half-rendered text is ever returned.
- **AS-80 (locale fallback)** — **Given** locales `uk-UA`, `uk`, `fr`, `en-GB` and a type with `en` and `uk` templates only, **When** resolved, **Then** `uk-UA` → `uk`; `uk` → `uk`; `fr` → `en`; `en-GB` → `en`.
- **AS-81 (money)** — **Given** the cases (129900, USD, `en-US`) → `$1,299.00`; (129900, USD, `uk`) → the `uk` currency format of 1,299.00 USD; (1500, JPY, `en-US`) → `¥1,500` (no decimals); (1500, KWD, `en-US`) → three decimals (`KWD 1.500`); (0, EUR) → zero amount; a negative amount; a non-integer or unsafe-integer input, **When** formatted, **Then** outputs follow each currency's own minor-unit exponent and the recipient's locale; non-integers throw; amounts are never computed with floating-point division.
- **AS-82 (header, length and link safety)** — **Given** a subject built from data containing `\r\n` and `Bcc:`, a 10,000-character body, and an event whose `link`-related data contains `https://evil.example` or `../`, **When** rendered, **Then** the subject has all CR/LF removed, the inbox body is cut to 500 characters with an ellipsis and the push body to the provider's limit, and the link is built only from the catalog's path template with identifiers validated as UUID or safe slug (otherwise rendering fails as AS-12).

---

### User Story 8 — The domain stays inside its boundaries and says what it is doing (Priority: P2)

No table or model of another domain is touched; other domains do not call a router; every notification type has a producer and a test; logs and metrics are useful and clean.

**Why this priority**: constitution IX, X, VIII; it also retires debt D-6, D-7, D-8 and D-12 for this domain.

**Independent Test**: run the ownership and boundary gates; run the catalog table test.

**Acceptance Scenarios**:

- **AS-83 (data ownership)** — **Given** the repository after this capability, **When** `pnpm --dir packages/backend check:table-ownership --strict` is run, **Then** it reports zero findings for `notifications`; every query of this domain touches only `NotificationPreference`, `NotificationSettings`, `NotificationSuppression`, `PushDevice` (and the registry in `db/ownership.ts` says so); no `User`, `ShopMembership` model or table is imported, injected or queried.
- **AS-84 (public surface)** — **Given** the domain entry point `@app/domains/notifications`, **When** inspected and when `pnpm check:boundaries` runs, **Then** it exports only the Nest modules the apps need, DTO types and event contracts; it no longer exports `NotificationRouter`, `NotificationRouterProjector`, `NotificationsCoreModule` or `formatMoney`; no other domain imports a notification service; the chat, seller-insights and developer-platform domains reach this capability only through events (checked by the boundary rules).
- **AS-85 (logs are clean)** — **Given** a captured log for a full flow (AS-01, AS-08, AS-09, AS-21, a provider complaint callback), **When** searched, **Then** no e-mail address, phone number, push token, reset or invite token, OTP code, unsubscribe token or message body appears; every line carries the request or trace id; recipients appear as user ids only.
- **AS-86 (metrics)** — **Given** the flows above, **When** the metrics endpoint is read, **Then** these exist and move as described: `notifications_events_consumed_total{result}`, `notifications_deliveries_total{channel,status}`, `notifications_delivery_latency_seconds{channel}` (event time to provider acceptance), `notifications_dead_lettered_total{stage,channel}`, `notifications_provider_failover_total{channel}`, `notifications_provider_circuit_state{provider}`, `notifications_inbox_unread_rebuilds_total`, plus the counters named in other scenarios.
- **AS-87 (catalog completeness)** — **Given** one valid sample event for every row of "Notification catalog" (including the single-consumer messages), **When** each is consumed against seeded users and shops, **Then** each produces exactly the listed type for exactly the listed recipients with the listed default channels, in the recipient's locale.

---

### Edge Cases

Every item below is an acceptance scenario above:

- Duplicate, concurrent, replayed and crashed deliveries of one event: AS-02, AS-03, AS-37, AS-49, AS-70, AS-75.
- Illegal or out-of-order sequences: AS-10 (version guard), AS-34 (expiry while waiting), AS-71 (status regression), AS-72 (callback before record), AS-62 (crash between store and count).
- Concurrency with an invariant: AS-02, AS-24, AS-36, AS-49, AS-58.
- Cross-tenant and other-user access: AS-26, AS-29, AS-56 (foreign cursor), AS-59, AS-28 (token moves to the latest owner).
- Limits: AS-23 (code requests), AS-26 (unsubscribe rate), AS-28 (device cap), AS-35, AS-36, AS-38 (caps), AS-47 (attempt limit), AS-55, AS-56, AS-59 (page and batch sizes), AS-61 (rebuild bound), AS-82 (lengths).
- Timeouts and outages: AS-39, AS-40, AS-43, AS-45, AS-53, AS-63, AS-73.
- Invalid input and invalid messages: AS-04, AS-05, AS-12, AS-16, AS-20, AS-22, AS-50, AS-69, AS-79.
- Time: AS-30–AS-34 (quiet hours, daylight saving, stale), AS-64 (retention), AS-81 (currency exponents).
- Security and privacy: AS-09, AS-17, AS-26, AS-69, AS-73, AS-85.

## Requirements *(mandatory)*

### Functional Requirements

**Intake and routing**

- **FR-001**: The consumer MUST process each source event or message with these rules: validate the payload against the type's schema (invalid → dead-letter, AS-04), map it to zero or more notification requests (AS-13), and ignore types it does not map (AS-05). Unsupported versions of a known type are dead-lettered.
- **FR-002**: Every notification MUST have a stable **dedupe identity** = (source event id, recipient, channel) (for events whose owner defines its own dedupe key, that key is used instead of the event id, e.g. chat's `dedupeKey`). Processing the same identity again, sequentially or concurrently, MUST create no second inbox item, no second delivery, no second realtime event and no second count (AS-02, AS-03).
- **FR-003**: Routing a request MUST be safely repeatable after a crash at any step: each step is idempotent, the final state equals one uninterrupted run (AS-03).
- **FR-004**: A request that cannot be validated or rendered MUST be dead-lettered with a reason and the event id, without side effects, and MUST NOT affect other requests of the same batch (AS-04, AS-12). Dead-letter records for secret-bearing messages MUST NOT contain the body (AS-09).
- **FR-005**: For every aggregate whose events carry a monotonic version (`orderVersion`, `auctionVersion`, `deliveryVersion`, `paymentVersion`, `payoutVersion`), the consumer MUST drop an event whose version is lower than the highest already notified for that aggregate and notification family (AS-10).
- **FR-006**: An event older than its type's maximum age at consumption time MUST NOT produce any external delivery (timeline `expired`); its inbox item is still created (AS-11). A delivery held for quiet hours MUST be re-checked against the maximum age at its wake instant (AS-34).
- **FR-007**: Recipients MUST be resolved only through exported services of their owning domains: users and e-mail addresses through identity's user directory, shop members through tenancy's membership query, both **batched** once per consumed batch (≤ 500 ids per call); unknown users produce nothing (AS-06, AS-07). Follower audiences of a marketing notice are resolved in pages of 1,000 through the following-graph capability's exported service.
- **FR-008**: A notification type with an **address** recipient (invitation) MUST be sent to that address on the e-mail line only, with no inbox item and no preference lookup, still subject to suppression (AS-08).
- **FR-009**: Each notification MUST be rendered once per recipient in that recipient's locale at routing time (AS-01, AS-66). Money MUST be formatted from integer minor units and a currency code in the recipient's locale (AS-81).
- **FR-010**: Per recipient the router MUST, in this order: create the inbox item (when the in-app channel is allowed), then for each other allowed channel apply the marketing cap (FR-025), quiet hours (FR-021), and hand the delivery to its channel line; a failure at any step MUST leave the earlier steps valid and the event retriable (AS-03).
- **FR-011**: Marketing fan-out to followers MUST be resumable and idempotent: a retried event re-walks the followers and creates only what is missing (AS-37).
- **FR-012**: The system MUST keep a **delivery timeline** per `(dedupe identity)` with statuses `queued`, `delayed`, `sent`, `delivered`, `bounced`, `complained`, `failed`, `suppressed`, `capped`, `skipped`, `expired`, plus provider, provider message id, detail and timestamps. Timeline write failures MUST NOT fail or repeat a send (AS-71 covers ordering).
- **FR-013**: The consumer MUST be idempotent under redelivery with a documented mechanism (see Assumptions) and MUST use bounded retry with backoff for transient failures before dead-lettering (AS-39).
- **FR-014**: Secrets (reset and invite tokens, OTP codes, unsubscribe tokens) MUST appear only in the rendered message handed to the provider and nowhere else: not in logs, timeline, metrics, dead-letter records, inbox items (AS-09, AS-85).

**Preferences and settings**

- **FR-015**: The preference matrix MUST have one boolean per (category, channel); stored values are explicit overrides, defaults come from the catalog and from the rules of AS-14. Marketing external channels and SMS everywhere default to off.
- **FR-016**: `GET` and `PUT /api/notifications/preferences` and `PUT /api/notifications/settings` MUST behave as AS-14–AS-20, always return the full matrix, and be idempotent.
- **FR-017**: A type flagged **mandatory** MUST ignore category and channel opt-outs and quiet hours, and MUST NOT ignore suppression (AS-17, AS-32). Enabling the SMS channel for any category MUST require a verified phone (AS-18).
- **FR-018**: Phone ownership MUST be proven by a 6-digit code sent by SMS, valid 10 minutes, 5 attempts then a 15-minute lock, 3 code requests per hour per user; changing the phone resets verification (AS-21–AS-23). Settings responses MUST mask the phone number.
- **FR-019**: After any successful preference or settings write, no process MUST use the previous values for later routing (AS-19, AS-15); the recipient view used for routing MUST be invalidated on write and have a bounded lifetime (5 minutes).
- **FR-020**: Devices MUST be registered, listed (without tokens), moved to the latest registering user, capped at 10 per user (oldest evicted) and removed by their own id only (AS-28, AS-29).

**Quiet hours and caps**

- **FR-021**: Quiet hours MUST apply to push and SMS only, in the recipient's time zone, daylight-saving-correct, supporting overnight windows, using an injected clock (AS-30–AS-33). Delays up to 15 minutes use the channel line's delay; longer delays use the job scheduler with one job per delivery (AS-31).
- **FR-022**: Quiet hours MUST NOT delay e-mail, the inbox, mandatory types or the phone verification SMS (AS-32).
- **FR-023**: Time zone names MUST be validated against the IANA database at write time (AS-20); quiet-hour ends MUST be validated `HH:MM` and set together or cleared together.
- **FR-024**: A delayed delivery MUST be re-checked at its wake instant for maximum age, suppression and the user's current preference (AS-34, AS-51, AS-52).
- **FR-025**: Marketing deliveries MUST obey per-user, per-channel caps over a **rolling** window: push 3 per hour, e-mail 2 per 24 hours, SMS 1 per 24 hours. Transactional deliveries MUST NOT be capped. A capped delivery is recorded `capped` and not queued; its inbox item is still created (AS-35, AS-38).
- **FR-026**: The cap decision MUST be atomic under concurrency (never more than the limit admitted, AS-36), final per delivery identity (AS-37), and fail closed for marketing when the counting store is unavailable (AS-39).

**Channel lines, workers, providers**

- **FR-027**: E-mail, SMS and push MUST each have an independent delivery line, and marketing MUST have its own line per channel, with separate worker capacity, so that a backlog or outage on one line does not delay another (AS-40, AS-41). Marketing lines MUST be drained at a lower rate than transactional ones.
- **FR-028**: Each provider MUST have a send budget enforced by the rate limiter (token bucket per provider and priority); a delivery over budget is returned to its line with the limiter's retry-after delay and without consuming an attempt (AS-42). Limiter outage: transactional fail-open, marketing fail-closed (AS-43).
- **FR-029**: Each channel MUST have an ordered provider chain (e-mail: primary then fallback; SMS and push: one provider each, extendable). A transient failure or timeout of a provider MUST fail over to the next provider in the same attempt; every provider call has a 10-second timeout; each provider sits behind a circuit breaker that skips it while open and probes it after the reset time (AS-44, AS-45, AS-53).
- **FR-030**: A permanent provider failure MUST NOT fail over or retry: e-mail and SMS addresses are suppressed, dead push tokens are removed, the delivery is `failed` (AS-46).
- **FR-031**: Transient failure of the whole chain MUST retry through the line with exponential backoff and full jitter, at most 5 attempts, then dead-letter with `failed`/`exhausted`; retries happen only at the line (AS-47, AS-48).
- **FR-032**: The worker MUST be idempotent per delivery: a delivery already sent MUST never be handed to a provider again, including under concurrent copies (AS-49); malformed messages are dead-lettered (AS-50).
- **FR-033**: Before each send the worker MUST check suppression, the user's current preference (non-mandatory only) and the maximum age (AS-51, AS-52, FR-024).
- **FR-034**: In production every channel the catalog uses MUST have real provider credentials and the unsubscribe signing secret MUST be set and distinct from every other secret; otherwise startup fails. Stand-ins exist only outside production and are never reported `delivered` (AS-54).
- **FR-035**: Every e-mail of a non-mandatory type MUST carry a signed unsubscribe URL and the one-click headers; mandatory types MUST NOT (AS-27).

**Unsubscribe**

- **FR-036**: `GET /api/notifications/unsubscribe` MUST only describe the action; `POST` MUST perform it for the (user, category) of a signed, non-expiring token on the e-mail channel; both are anonymous, rate limited per IP, and answer `400 invalid_unsubscribe_token` for any invalid token without revealing why (AS-25, AS-26).

**Inbox**

- **FR-037**: `GET /api/notifications` MUST return the caller's items only, newest first by event time then id, with opaque cursors bound to the caller, limit 1–50 (default 20), retention 180 days (AS-55, AS-56, AS-64).
- **FR-038**: The unread count MUST equal the number of the caller's unread items (bounded at 1,000), be O(1) to read, survive loss of its fast store by rebuilding, and be repaired after a crash within 5 minutes (AS-57, AS-61, AS-62).
- **FR-039**: Marking read MUST be idempotent, safe under concurrency (one decrement per item), owner-scoped (foreign and unknown ids are ignored) and validated (AS-58, AS-59). Mark-all MUST be cheap (not proportional to the number of items) and MUST leave items that arrive later unread, whatever their event time (AS-60).
- **FR-040**: A new inbox item MUST be announced live to its owner only, on the owner's private realtime topic, event `notification`, best effort: a hub failure MUST NOT fail routing (AS-01, AS-63).
- **FR-041**: Inbox content rules: locale at creation time, length limits, relative link built by the catalog (AS-66, AS-82). A user may switch the in-app channel off per category (AS-65).

**Suppression and callbacks**

- **FR-042**: Suppression MUST be per (channel, normalized address), idempotent, effective for the very next send, and honoured by every type including mandatory ones (AS-76, AS-17).
- **FR-043**: Provider callbacks MUST be authenticated per provider scheme (raw-body signature, pinned topic or account, certificate host pinning, 5-minute timestamp tolerance where the scheme has a timestamp), acknowledged `2xx` after durable acceptance, deduplicated on the provider's event identity, and applied idempotently by the worker (AS-69, AS-70, AS-75). Callback processing MUST NOT make outbound requests to URLs supplied in the callback unless pinned to the provider's HTTPS host (AS-73).
- **FR-044**: Complaint, permanent bounce, SMS STOP and permanent provider errors MUST suppress the address; a complaint MUST also switch off the user's marketing e-mail when the user is known (AS-67, AS-68, AS-74, AS-77).
- **FR-045**: A delivery's status MUST move only forward by the precedence rule of AS-71; callbacks that arrive before the provider message id is recorded MUST be retried for up to 10 minutes (AS-72).

**Templates**

- **FR-046**: Templates MUST be logic-less `{{variable}}` text per type and locale; HTML values are escaped; a missing variable fails rendering; locale resolution is exact → language → English (AS-78–AS-80).
- **FR-047**: Subjects MUST have CR and LF removed; push and inbox text MUST respect length limits; links MUST come from the catalog's path templates with validated identifiers (AS-82).

**Boundaries, operations**

- **FR-048**: This capability MUST read and write only the tables it owns (`NotificationPreference`, `NotificationSettings`, `NotificationSuppression`, `PushDevice`) and its own inbox, delivery timeline and counter stores; other domains' data enters only through R1 services or events (AS-83).
- **FR-049**: The domain's public entry point MUST expose no router service, projector class or core module; other capabilities request notifications only by publishing events (AS-84).
- **FR-050**: All endpoints (`/api/notifications/*`) MUST authenticate (except unsubscribe and provider callbacks), take the principal from the session (never a user id from the request), return `application/problem+json` errors with stable codes, use response DTOs with schemas in `packages/contracts`, and rate limit as listed under Cross-capability contracts.
- **FR-051**: Logs MUST be structured, carry request or trace ids, and contain no contact data, tokens or message bodies; metrics MUST be exposed as listed in AS-86 (AS-85, AS-86).
- **FR-052**: Every row of the Notification catalog MUST be implemented and covered by AS-87; adding a type requires only a catalog entry and templates.

### Notification catalog (intended; rows are binding)

Recipients: *user* = the id in the event; *shop OWNERs* = tenancy's members with role OWNER of the shop in the event. Channels = default channels (before preferences); **M** = mandatory (ignores preferences and quiet hours, obeys suppression); **T** = transactional line; **MK** = marketing line. Maximum age (stale limit) defaults to 24 h unless noted. `—` = no inbox item.

| Type | Trigger (owner) | Recipients | Category | Line | Default channels | Notes |
|---|---|---|---|---|---|---|
| `account.welcome` | `identity.user_registered` (S01, S02) | user | account | T | email, inapp | |
| `security.registration_attempt` | `identity.registration_duplicate_attempted` (S01) | user | security | T | email | M, no inbox |
| `security.password_changed` | `identity.password_changed` (S01) | user | security | T | email, inapp | M |
| `security.password_reset` | message `identity.password_reset_requested` (S01) | user | security | T | email | M, no inbox, max age 30 min, link `<front>/reset-password?token=<resetToken>` |
| `security.mfa_enabled` / `security.mfa_disabled` / `security.recovery_code_used` / `security.recovery_codes_regenerated` | `identity.mfa_enabled`, `mfa_disabled`, `mfa_recovery_code_used {remaining}`, `mfa_recovery_codes_regenerated` (S02) | user | security | T | email, inapp | M |
| `security.sign_in_method_added` / `security.sign_in_method_removed` | `identity.federated_identity_linked {provider, linkMethod, passwordInvalidated, mfaReset}`, `identity.federated_identity_unlinked {provider}` (S02) | user | security | T | email, inapp | M; text mentions a removed password or reset MFA when the flags are true |
| `security.phone_verification` | internal (AS-21) | user | security | T | sms | M, immediate, no inbox, max age 10 min |
| `shop.invite` | message `tenancy.invite_requested` (S03) | the invited address | shop | T | email | M, address recipient, no inbox, link `<front>/invites/<token>` |
| `shop.offboarding_started` / `shop.offboarding_cancelled` | `tenancy.shop_offboarding_started {shopId, purgeAt}`, `tenancy.shop_offboarding_cancelled {shopId}` (S03) | shop OWNERs | shop | T | email, inapp | started is M |
| `shop.verified` / `shop.rejected` / `shop.document_rejected` | `shop.verified`, `shop.rejected {reasonCode}`, `shop.onboarding_document_rejected {kind, reason}` (S04) | shop OWNERs | shop | T | email, inapp | |
| `order.confirmed` | `order.paid` (S10) | user | orders | T | email, push, inapp | |
| `shop.order_received` | `order.paid.shopOrders[]` (S10) | shop OWNERs of each `shopId` | shop | T | push, inapp | amount = that shop's `subtotalMinor` |
| `order.cancelled` | `order.cancelled` (S10), reasons `out_of_stock`, `hold_expired` only | user | orders | T | email, inapp | reason shown as a localized phrase, never the code |
| `order.refunded` | `order.refunded` (S10) | user | orders | T | email, inapp | |
| `order.shipped` / `order.delivered` | `order.fulfilment_changed` status `SHIPPED` / `DELIVERED` (S10) | user | orders | T | email, push, inapp / push, inapp | trackingCode shown on shipped |
| `payment.failed` | `payments.payment_failed` (S13), except reasons `order_not_payable`, `order_cancelled` | user | orders | T | email, push, inapp | |
| `delivery.picked_up` / `delivery.cancelled` | `delivery.status_changed` status `PICKED_UP` / `CANCELLED` (S20) | `buyerId` | orders | T | push, inapp | `DELIVERED` is covered by `order.delivered` |
| `auction.outbid` | `auction.leader_changed` (S21) | `previousLeaderId` | auctions | T | push, inapp | max age 1 h |
| `auction.won` | `auction.closed` with `winnerId` (S21) | `winnerId` | auctions | T | email, push, inapp | |
| `auction.second_chance` | `auction.second_chance_offered` (S21) | `offeredToId` | auctions | T | email, push, inapp | max age until `expiresAt` |
| `auction.sold` | `auction.sold` (S21) | shop OWNERs of `shopId` | auctions | T | email, inapp | |
| `billing.payment_failed` | `billing.invoice_payment_failed`, `nextAttemptAt` set (S17) | user (`subjectType` USER) or shop OWNERs | billing | T | email, inapp | M; text varies for `reason: authentication_required` and shows the attempt number |
| `billing.access_withdrawn` | same event with `nextAttemptAt: null` | same | billing | T | email, inapp | M |
| `billing.receipt` | `billing.invoice_paid` (S17) | same | billing | T | email, inapp | |
| `payout.paid` / `payout.failed` | `payout.paid`, `payout.failed` (S15) | shop OWNERs | payouts | T | email, inapp | |
| `booking.confirmed` | `launch_events.booking_confirmed` (S22) | `userId` | bookings | T | email, push, inapp | seat count shown |
| `chat.message` | `chat.message_escalated` (S24), dedupe on its `dedupeKey` | `recipientId` | chat | T | push, inapp | channel title and preview only; max age 1 h |
| `discussion.reply` / `discussion.comment` | `discussion.comment_created` (S25) | `parentAuthorId` (reply) / `postAuthorId` (top-level) | discussions | T | push, inapp / inapp | never the commenter |
| `developers.webhook_endpoint_disabled` | `developer_platform.webhook_endpoint_disabled` (S43) | shop OWNERs | developers | T | email, inapp | M; shows host only |
| `insights.competitor_price_drop` | `seller_insights.competitor_price_dropped` (S41) | `ownerId` | insights | T | email, inapp | |
| `marketing.followed_shop_update` | `feed.item_published` kinds `drop_announced`, `auction_started` (S26) | followers of the author (paged) | marketing | MK | inapp only by default | capped; max age 1 h |

### Defaults

- Inbox: default page 20, maximum 50, retention 180 days, unread rebuild bound 1,000, title ≤ 120 characters, body ≤ 500.
- Dedupe memory: 7 days. Version guard memory: 7 days.
- Marketing caps (rolling): push 3 / hour, e-mail 2 / 24 h, SMS 1 / 24 h.
- Delay split: up to 900 s on the line, beyond that a scheduled job.
- Retries: 5 attempts; backoff base 30 s, factor 2, cap 900 s, full jitter. Provider call timeout 10 s; breaker opens at > 50 % failures over ≥ 10 calls, reset 30 s.
- Marketing send budget: 20 % of the channel budget; marketing line concurrency lower than the transactional one.
- Callback timestamp tolerance 5 minutes; early-callback retry window 10 minutes.
- Phone verification: 6 digits, 10 minutes, 5 attempts then 15-minute lock, 3 requests per hour.
- Devices per user: 10. Recipient view lifetime: 5 minutes with invalidation on write.
- Batch sizes: ≤ 500 ids per directory/membership call; marketing fan-out page 1,000.

### Key Entities

- **NotificationType** (catalog entry): type id, category, line (transactional or marketing), default channels, mandatory flag, recipient rule, maximum age, localized templates, link template.
- **NotificationRequest**: type, recipient (user id or address), template data, dedupe identity, occurred-at, source version.
- **Recipient view**: user id, e-mail (from identity), phone (verified or not), locale, time zone, quiet hours, preference overrides, devices.
- **Preference / Settings / Device / Suppression entry**: owned tables; suppression is keyed by (channel, normalized address) with a reason.
- **Inbox item**: id, owner, type, category, title, body, link, read flag, event time, arrival time.
- **Delivery**: id (deterministic from dedupe identity), user, channel, type, status history, provider, provider message id, detail.
- **Frequency window**: per user and channel, the admitted deliveries inside the rolling window.
- **Provider chain**: ordered providers per channel with breaker state and send budget.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 99 % of events, the in-app item is visible within 2 seconds of the event being published, at 115 events per second average and 2,000 per second peak.
- **SC-002**: Zero duplicate notifications (inbox, e-mail, SMS, push) when every source event is delivered 3 times and a random 10 % of deliveries crash midway.
- **SC-003**: While one channel's provider is fully down, the delivery time of the other channels stays within 1.5× of normal (99th percentile).
- **SC-004**: A transient failure of the primary e-mail provider delays affected messages by less than 15 seconds (99th percentile), and no message is lost.
- **SC-005**: During a marketing burst of 20,000 messages per second, transactional messages are sent less than 1 second later than without the burst (99th percentile).
- **SC-006**: No user ever receives more marketing messages than their cap within any rolling window (zero violations in a 1-million-user simulation).
- **SC-007**: After a user turns a channel off, 100 % of messages not yet handed to a provider (including waiting ones) are not sent on that channel.
- **SC-008**: After a complaint, hard bounce or STOP, the provider receives zero further messages for that address.
- **SC-009**: The inbox list and the unread count serve 30,000 requests per second with 99th percentile below 150 ms and 50 ms respectively.
- **SC-010**: No log line, metric label or dead-letter record in a full-flow test contains contact data or a secret.
- **SC-011**: Of 100 pre-fetches of an unsubscribe link by mail scanners, zero change a preference; 100 % of one-click posts do.
- **SC-012**: A user in any supported time zone never receives a push or SMS inside their quiet window across daylight-saving changes (checked over a full year of simulated days).

## Cross-capability contracts

**Provides** (exact names):

- **HTTP endpoints** (all under `/api`, problem+json errors, zod schemas in `packages/contracts`: `notificationPageSchema`, `notificationItemSchema`, `unreadCountSchema`, `markReadRequestSchema`, `notificationPreferencesSchema`, `updatePreferenceRequestSchema`, `updateSettingsRequestSchema`, `phoneVerifyRequestSchema`, `deviceSchema`, `registerDeviceRequestSchema`):
  - `GET /notifications?limit=1..50&cursor=` → `200 {items: {id, type, category, title, body, link, read, createdAt}[], nextCursor: string | null}`; `400 validation_failed | invalid_cursor`, `401`. Policy `notifications.read.user`.
  - `GET /notifications/unread-count` → `200 {unread: number}`. Policy `notifications.read.user`.
  - `POST /notifications/read` body `{ids: string[1..100]}` or `{all: true}` → `200 {unread}`; `400 validation_failed`. Policy `notifications.write.user`.
  - `GET /notifications/preferences` → `200 {settings: {timezone, locale, quietStart, quietEnd, phone (masked), phoneVerified}, preferences: {category, channels: {email, sms, push, inapp}, mandatoryChannels}[]}`; `PUT /notifications/preferences` body `{category, channel, enabled}` → `200` same shape; `422 phone_not_verified`.
  - `PUT /notifications/settings` body `{timezone?, locale?, quietStart?, quietEnd?, phone?}` → `200` same shape; `400 validation_failed`, `422 quiet_hours_incomplete | quiet_hours_invalid`, `429`.
  - `POST /notifications/settings/phone/code` → `202`; `POST /notifications/settings/phone/verify {code}` → `200` same shape; `422 code_invalid {attemptsLeft} | code_expired | code_not_requested | phone_unreachable`, `429 verification_locked`. Policies `notifications.phone-code.user` (3 per hour, fail closed), `notifications.phone-verify.user` (5 failures per 15 minutes, fail closed).
  - `GET /notifications/devices` → `200 {items: {id, platform, lastSeenAt}[]}`; `POST /notifications/devices {token, platform}` → `201 | 200 {id, platform, lastSeenAt}`; `DELETE /notifications/devices/:deviceId` → `204 | 404 device_not_found`.
  - `GET /notifications/unsubscribe?token=` → `200 {category}`; `POST /notifications/unsubscribe?token=` → `200 {unsubscribed: category}`; `400 invalid_unsubscribe_token`; anonymous; policy `notifications.unsubscribe.ip` (30 per minute, fail closed).
  - `POST /notifications/webhooks/ses` (provider-signed, raw body), `POST /notifications/webhooks/twilio` (provider-signed): provider callbacks, not client API; policy `notifications.webhook.ip` (fail open).
  - Other policies: `notifications.write.user` (60 per minute, fail open). **Consumers: W03 (bell, popover, preferences screen), mail clients (unsubscribe), providers.**
- **Realtime**: event `notification` `{id, type, category, title, body, link, unread, createdAt}` published on the owner-only topic `user:<userId>` (the topic and its owner policy are registered by identity/S51; this capability only publishes). **Consumer: W03.**
- **Nest modules for apps** (X.4): `NotificationsModule` (core HTTP), `NotificationsWorkerModule` (channel workers, scheduled-job handlers, callback processing, reconciliation), `NotificationsProjectorModule` (event and message consumers). No other export: no `NotificationRouter`, no `formatMoney`, no models (D-8).
- **R1 exports**: none. This capability owns no data other domains read.
- **Operations**: metrics listed in AS-86; log lines `notifications.event.routed`, `notifications.delivery.sent`, `notifications.delivery.failed` (user id, type, channel, delivery id only).

**Requires** (owner, exact shape assumed):

- **S01 (`identity`)**: `UserDirectoryService.getUsersByIds(ids: UserId[]): Promise<Map<UserId, UserSummaryDto>>` (R1, ≤ 500, unknown/deleted absent) with `UserSummaryDto = {id, email: string | null, role, createdAt}`; `Firewall()` and `@User()` (`AuthenticatedUser = {id, ...}`); events (envelope `{eventId, type, version, occurredAt, aggregateId}`) `identity.user_registered` v1 `{userId, role}`, `identity.registration_duplicate_attempted` v1 `{userId}`, `identity.password_changed` v1 `{userId}`; single-consumer message `identity.password_reset_requested` v1 `{userId, resetToken, expiresAt}` (consumed from the queue S01 publishes it on); the web route `/reset-password?token=` exists.
- **S02**: events `identity.mfa_enabled` v1 `{userId}`, `identity.mfa_disabled` v1 `{userId, reason}`, `identity.mfa_recovery_code_used` v1 `{userId, remaining}`, `identity.mfa_recovery_codes_regenerated` v1 `{userId}`, `identity.federated_identity_linked` v1 `{userId, provider, linkMethod, passwordInvalidated, mfaReset}`, `identity.federated_identity_unlinked` v1 `{userId, provider}`.
- **S03 (`tenancy`)**: `MembershipQueryService.getMembersByShopIds(shopIds: ShopId[], roles?: ShopRole[]): Promise<Map<ShopId, {userId: UserId; role: ShopRole}[]>>` (R1, ≤ 500); single-consumer message `tenancy.invite_requested` v1 `{inviteId, shopId, shopName, email, role, token, expiresAt, invitedBy}`; events `tenancy.shop_offboarding_started` v1 `{shopId, purgeAt}`, `tenancy.shop_offboarding_cancelled` v1 `{shopId}`; the web route `/invites/<token>` exists.
- **S04**: events on topic `shop-onboarding`: `shop.verified` v1 `{shopId, submissionNo, verifiedAt}`, `shop.rejected` v1 `{shopId, submissionNo, rejectedAt, reasonCode}`, `shop.onboarding_document_rejected` v1 `{shopId, documentId, kind, reason}`.
- **S10 (`orders`)**: events on `orders.events` (every payload has `orderVersion`): `order.paid` `{orderId, userId, totalMinor, currency, paymentRef, paidAt, lines, shopOrders: [{shopOrderId, shopId, subtotalMinor}], orderVersion}`, `order.cancelled` `{orderId, userId, reason, previousStatus, orderVersion}`, `order.refunded` `{orderId, userId, amountMinor, currency, reason, orderVersion}`, `order.fulfilment_changed` `{orderId, userId, status, trackingCode?, orderVersion}`. **Differs from S10's spec: `order.fulfilment_changed` there has no `userId`; this capability requires it as an additive field (`[CONTRACT]` in questions.md).**
- **S13**: `payments.payment_failed` v1 `{paymentId, paymentRef, orderId, userId, amountMinor, currency, reasonCode, occurredAt, paymentVersion}`.
- **S15**: `payout.paid` `{payoutId, shopId, amountMinor, currency, paidAt, payoutVersion}` and `payout.failed` `{payoutId, shopId, amountMinor, currency, failureCode, payoutVersion}` on `payouts.events`.
- **S17**: `billing.invoice_payment_failed` v1 `{invoiceId, subscriptionId, subjectType: 'USER' | 'SHOP', subjectId, attempt, nextAttemptAt: string | null, reason, totalMinor, currency}`; `billing.invoice_paid` v1 `{invoiceId, subscriptionId, subjectType, subjectId, kind, totalMinor, currency, periodStart, periodEnd, paidAt}`. `billing.subscription_status_changed` is **not** consumed (status vocabulary not fixed for mail purposes).
- **S20**: `delivery.status_changed` v1 `{deliveryId, orderId, shopId, buyerId, status, previousStatus, courierId, reason, feeMinor, currency, deliveryVersion}`.
- **S21**: on `auctions.events` (every payload has `auctionVersion`, `shopId`, `productId`): `auction.leader_changed {previousLeaderId, leaderId, priceMinor, currency}`, `auction.closed {status, winnerId, finalPriceMinor, currency, reserveMet, reason}`, `auction.second_chance_offered {offeredToId, priceMinor, currency, expiresAt}`, `auction.sold {buyerId, finalPriceMinor, currency, orderId, viaSecondChance}`.
- **S22**: `launch_events.booking_confirmed` `{holdId, launchEventId, shopId, userId, seats, bookingIds, confirmedAt}`.
- **S24**: `chat.message_escalated` v1 `{recipientId, channelId, channelTitle, messageId, seq, authorId, preview, dedupeKey}` on `chat.events` keyed by `recipientId`.
- **S25**: `discussion.comment_created` v1 `{commentId, postId, boardId, authorId, parentCommentId, parentAuthorId, postAuthorId, preview, createdAt}`.
- **S26 (`community`)**: event `feed.item_published` v1 `{itemId, authorId, kind, createdAt}`; **new requirement (differs from S26's spec, which exports nothing)**: R1 `FollowQueryService.getFollowerIds(accountId: string, page: {limit: number (≤ 1000); cursor?: string}): Promise<{ids: UserId[]; nextCursor: string | null}>`, where `accountId` is `shop:<uuid>` or `user:<uuid>` (`[CONTRACT]` in questions.md).
- **S41 (`seller-insights`)** (new event, replaces the direct call today): `seller_insights.competitor_price_dropped` v1 `{watchId, shopId, productId, productTitle, host, competitorPriceMinor, yourPriceMinor, currency, ownerId}`, `aggregateId = watchId`, `version` = the price observation counter.
- **S43 (`developer-platform`)** (new event, replaces the direct call today): `developer_platform.webhook_endpoint_disabled` v1 `{endpointId, shopId, host, failingSince}` (host only, never the URL path or query), `aggregateId = endpointId`.
- **S49 (job scheduler)**: `JobsService.enqueue(type, payload, {runAt, idempotencyKey})` and a handler decorator; periodic job registration for the 5-minute unread reconciliation.
- **S50 (rate limiter)**: `RateLimiterService.check(policy, key): Promise<{allowed: boolean; retryAfterMs: number}>`; send-budget policies `notify.email`, `notify.sms`, `notify.push` and their `.marketing` variants; the HTTP policies named above; the fail mode per policy.
- **S51 (realtime hub)**: `RealtimePublisher.publish(topic, event, payload)`; topic `user:<userId>` owner-only.
- **S52 (cache toolkit)**: `CacheService.getOrLoad` with TTL, negative TTL and explicit invalidation across processes (no per-process copy for preference or suppression data).
- **S53 (events and queues)**: the consumer framework (envelope validation, idempotent consumption, dead-letter, partition pause), delivery lines with delay and a dead-letter line each, the single-consumer message path for `identity.password_reset_requested` and `tenancy.invite_requested`.
- **S54 (platform toolkit)**: problem+json filter, injectable clock (frozen in tests), schema-validated configuration that fails startup, metrics registry, structured logger with redaction.

Cross-domain data used by S28 (constitution IX.7): **R1** — identity's `UserDirectoryService`, tenancy's `MembershipQueryService`, community's `FollowQueryService`; **R3** — consumption of every producer's events (topics keyed by aggregate id, idempotent, version-guarded), copying nothing but the fields a notification renders; **R2** — none (the bell and the preferences screen call this capability's own HTTP API). No JOIN, association or direct query touches another domain's table.

## Assumptions

- Defaults above are the ones chosen unattended; each is also a line in `questions.md`.
- **Idempotency mechanisms (IV.5)**: the consumer deduplicates on (event id or owner dedupe key, recipient, channel) with a fast shared store holding a 7-day memory, and every derived artefact (inbox item id, delivery id) is deterministic from that identity so a lost memory re-creates the same rows (an upsert) instead of new ones; the inbox write is a once-only insert whose result tells whether the item is new. The worker deduplicates on the delivery id. At-least-once is the guarantee at the provider boundary: a worker crash between the provider accepting a message and the "sent" marker can produce one duplicate; the delivery id travels to the provider as the reference so it is traceable.
- Stores (from the domain map): Postgres for preferences, settings, suppression and devices; a wide-column store for the inbox and the delivery timeline; a fast key-value store for the unread counters, dedupe memory, cap windows, version guards and verification codes. All of them are derived or short-lived except the four Postgres tables and the inbox.
- The notification category list is `account`, `security`, `orders`, `auctions`, `billing`, `payouts`, `shop`, `bookings`, `chat`, `discussions`, `developers`, `insights`, `marketing`. Channels are `email`, `sms`, `push`, `inapp`.
- Shop-targeted notices go to OWNERs only in this release; widening to other roles is a catalog change.
- Finance and moderator alerts (`payout.in_doubt`, `ledger.reconciliation_*`, `statements.*`, `integration_*`) are not consumed: there is no recipient directory for platform staff.
- A user's display name is not available (identity has none); texts avoid naming people (chat uses the channel title).
- Maximum ages: 24 hours by default; `security.password_reset` 30 minutes; `security.phone_verification` 10 minutes; `auction.outbid`, `chat.message`, `marketing.followed_shop_update` 1 hour; `auction.second_chance` until its expiry.
- The status order and the cap windows use the clock the platform toolkit provides, frozen in tests.
- The web screens consume this contract unchanged; today's popover (listening on a different topic and never loading the inbox) is a W03 concern recorded in `gaps.md`.
