# Feature Specification: S43 — Webhook delivery to shops (domain `developer-platform`)

**Feature Directory**: `specs/domains/S43-webhooks`
**Created**: 2026-10-06
**Status**: Draft
**Input**: Capability S43 of `scripts/sdd/capabilities.tsv`: "Webhook delivery to shops: subscriptions, signing with dual secrets, per-endpoint ordering, retries, auto-disable, replay". Sources: `docs/showcase/sections/SD-30-webhook-delivery.md`, `interview-prep/04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md` §5 (providing webhooks), `04-api-design/02-api-versioning-and-deprecation.md` §8. Patterns from `docs/architecture/pattern-map.md`: P0112, P0413, P0418, P0507, P0518, P0604, P0608, P0617. Where the existing code and the notes disagree, the notes win (gaps are in `gaps.md`).

## Overview

A shop connects its own systems to the marketplace. It registers one or more HTTPS **endpoints**, chooses which **event types** each endpoint receives (`order.paid`, `product.stock_low`, `payout.paid`, …), and the marketplace **pushes** a signed JSON message to the endpoint whenever one of those things happens to that shop. The shop's server is not ours: it can be slow, down, mis-deployed, or malicious in what address it asks us to call. This capability makes that safe and predictable:

- **One shop's dead server never delays another.** Each endpoint has its own ordered lane with one delivery in flight at a time; a hung endpoint only blocks itself.
- **Messages are provable.** Every request carries a timestamped signature that the receiver can verify, and a shop can rotate its secret without downtime because two secrets are valid during an overlap.
- **Delivery is at-least-once and observable.** Failed deliveries are retried for about three and a half days on a growing schedule; every attempt is logged for 30 days; a shop can replay any stored event byte-for-byte; an endpoint that fails continuously for three days is switched off and the shop is told.
- **Our servers are never turned against us.** Endpoint addresses are checked when they are saved and again on every attempt (DNS can change), and a request can only go to the address that passed the check.

### Scope

In scope: endpoint management (create, list, read, update, enable, disable, delete), the event-type catalogue, per-endpoint API-version pinning of payloads, signing secrets (sealed at rest, two active during rotation), routing of other domains' events to subscribed endpoints, ordered per-endpoint delivery, retries with a circuit breaker, auto-disable with an owner alert event, the 30-day delivery log, manual replay, test pings, purge when a shop is deleted, metrics and logs of all of that, and the receiver-side verification rules (published as a reference function).

Out of scope (owners named):

- Public API keys, API versions registry, request logs → **S42** (same domain). This capability only reads the version registry through S42's exported service.
- Telling the shop's owners that an endpoint was disabled (mail, in-app) → **S28**; this capability only emits the event.
- The dashboard screens (forms, tables, secret reveal dialog) → **W04**.
- Who is a member of a shop and what they may do → **S03**; this capability uses the permission `webhooks.manage` that S03 defines.
- Inbound webhooks from providers (Shopify, Stripe, …) → S08, S10, S13.
- Generic idempotency store, rate-limit engine, outbox/consumer framework, SSRF-safe HTTP client, secret sealing → **S53 / S50 / S54 / S01** (see Requires).
- Webhooks for sandbox shops and for suspended-shop policy: sandbox events are never delivered (FR-024); suspended shops keep their endpoints (shop suspension is S03's concern).
- Bulk replay of many events at once, per-endpoint custom headers, mutual TLS, and event types for catalog-sync, bookings, auctions or chat: not in this release.

Cross-domain data used (constitution IX.7): shop access by **R1** (S03 `ShopScoped`, no table read); API-version registry by **R1** (S42 `ApiVersionService`); order, product and payout facts by **R3** (the events carry the copies, nothing is read from another domain's table); owner alert by an **event** (S28 reacts); shop deletion by an **event** (S03). This capability reads and writes no table owned by another domain.

## User Scenarios & Testing *(mandatory)*

Common setup for the scenarios: shop `A` (live, active) with OWNER `alice` and STAFF `sam`; shop `B` with OWNER `bob`; a receiver `R` at `https://hooks.acme.test/in` that the tests control (resolver and sender are the only fakes at the system edge); the clock is frozen; the global prefix of the core app is `/api`, so the routes below are under `/api/shops/{shopId}/developers/…`. "The endpoint API" means those routes. `E1`, `E2` are endpoints of shop `A`.

### User Story 1 — Register and manage endpoints (Priority: P1)

A shop owner registers an endpoint, picks events, sees the signing secret once, edits it, turns it off and on, and deletes it. Only people with `webhooks.manage` can touch any of this, and nobody can see or touch another shop's endpoints.

**Why this priority**: nothing else exists without an endpoint, and the endpoint API is the security boundary (who may point our servers at which address).

**Independent Test**: create → list → patch → disable → enable → delete through the API as `alice`; repeat each call as `sam`, as `bob` and anonymously.

**Acceptance Scenarios**:

1. **AS-01** (create) — **Given** `alice` (OWNER of `A`), **When** she calls `POST /shops/A/developers/webhooks {url: "https://hooks.acme.test/in", events: ["order.paid", "product.stock_low"]}`, **Then** `201` with `{id, url, events, apiVersion, status: "enabled", secret, createdAt}` where `secret` matches `^whsec_[A-Za-z0-9_-]{43}$`; one `WebhookEndpoint` row exists with the secret **sealed** (the column value is not the plaintext), `status = enabled`, no failure state; one state-change row `created`; one outbox event `developer_platform.webhook_endpoint_changed` `{change: "created"}` was written in the same transaction; `GET` of the same endpoint afterwards has no `secret` field.
2. **AS-02** (validation classes) — **Given** the same caller, **When** she sends each of: no `url`; `url` not a string; `url` over 2,048 characters; `events` missing; `events` empty; `events` containing an unknown type (`"order.exploded"`); duplicate types in `events`; more than 20 types; `apiVersion` not supported by S42; an unknown property (`"foo": 1`); `url` that is not parseable, **Then** each answers `400` `validation_failed` problem+json naming the field, and no row, state-change row, or outbox row is written.
3. **AS-03** (address guard at save, P0507) — **Given** the same caller, **When** she creates (or patches) with `http://hooks.acme.test/in`; `https://user:pw@hooks.acme.test/in`; `https://hooks.acme.test:8443/in`; `https://203.0.113.9/in` (IPv4 literal); `https://[2001:db8::1]/in` (IPv6 literal); `https://localhost/in`; a name whose resolver answer is `10.0.0.5`; a name resolving to `169.254.169.254`; a name resolving to `[::ffff:10.0.0.5]`; a name with two answers where one is `192.168.1.10` and one is public; a name that does not resolve, **Then** each answers `422` `endpoint_url_rejected` with `details.reason` ∈ `not_https | credentials_not_allowed | port_not_allowed | ip_literal | blocked_address | unresolvable`, and nothing is stored.
4. **AS-04** (payload version at create) — **Given** shop `A` has pinned API version `2026-01-15` in S42 and shop `B` has no pin, **When** `alice` creates an endpoint without `apiVersion`, **Then** `apiVersion` is `2026-01-15`; **When** `bob` does the same, **Then** it is `latest`; **When** either passes a supported `apiVersion` explicitly, **Then** that value is stored. Later changes of the shop's pin do not change existing endpoints.
5. **AS-05** (list, pagination) — **Given** shop `A` has 7 endpoints, **When** `alice` calls `GET …/webhooks?limit=3`, **Then** `200 {items, nextCursor}` with 3 items ordered by `createdAt` descending then `id` descending, each `{id, url, events, apiVersion, status, disabledReason, failingSince, breaker: "closed"|"open", hasPreviousSecret, previousSecretExpiresAt, createdAt, updatedAt}` and **no secret of any kind**; following `nextCursor` twice yields the other 4 with no duplicate and no gap, the last page has `nextCursor: null`; `limit=0`, `limit=101` and a tampered cursor answer `400` (`validation_failed`, `invalid_cursor`); the default limit is 25. Endpoints of shop `B` never appear.
6. **AS-06** (read one) — **Given** `E1`, **When** `alice` calls `GET …/webhooks/E1`, **Then** `200` with the item shape above; **When** the ID is well-formed but unknown, **Then** `404` `webhook_endpoint_not_found`; **When** it is not a UUID, **Then** `400`.
7. **AS-07** (update) — **Given** `E1` with events `[order.paid]` and `apiVersion 2026-10-01`, **When** `alice` calls `PATCH …/E1 {events: ["order.paid","order.cancelled"], apiVersion: "2026-01-15", url: "https://hooks2.acme.test/in"}`, **Then** `200` with the updated item; secrets, status and failure state are unchanged; the new URL passed the AS-03 guard (a blocked URL answers `422` and changes nothing, not even the other fields of the same request); an empty body answers `400`; one state-change row per changed facet and one `webhook_endpoint_changed` event (`change: "url_changed" | "events_changed" | "api_version_changed"`) exist; deliveries already queued keep the body they were rendered with, and the next routed event uses the new events, URL and version (see AS-27).
8. **AS-08** (enable and disable, illegal transitions) — **Given** `E1` is `enabled`, **When** `alice` calls `POST …/E1/disable`, **Then** `200`, `status: "disabled"`, `disabledReason: "manual"`, a state-change row `enabled → disabled`; **When** she calls it again, **Then** `409` `endpoint_state_conflict` with `details {status: "disabled"}` and no new row; **When** she calls `POST …/E1/enable`, **Then** `200`, `status: "enabled"`, `disabledReason: null`, `failingSince: null`, the circuit breaker is closed and its failure count is zero, URL re-checked by the AS-03 guard (if now blocked: `422` and the endpoint stays disabled); enabling an enabled endpoint answers `409` `endpoint_state_conflict`.
9. **AS-09** (concurrent transitions) — **Given** `E1` is `disabled`, **When** two `POST …/E1/enable` run at the same moment (`Promise.all`), **Then** exactly one answers `200` and the other `409`; exactly one `disabled → enabled` state-change row and one event exist.
10. **AS-10** (delete) — **Given** `E1` with two queued deliveries, **When** `alice` calls `DELETE …/E1`, **Then** `204`, the row is gone, a `deleted` state-change row and event exist; the two queued deliveries are never sent and appear as `cancelled` (`endpoint_deleted`) in operator logs/metrics only (the log is unreachable through the API after delete); a second `DELETE` answers `404` `webhook_endpoint_not_found`; replay, ping, attempts and every other route on `E1` answer `404`.
11. **AS-11** (endpoint limit, invariant) — **Given** shop `A` has 18 endpoints, **When** three creates run at the same moment (`Promise.all`), **Then** exactly two answer `201`, one answers `422` `endpoint_limit_reached`, and the shop has 20 endpoints; a 21st create answers `422`. Deleting one frees a slot.
12. **AS-12** (duplicate URL) — **Given** `E1` at `https://hooks.acme.test/in`, **When** `alice` creates another endpoint whose URL is the same after normalisation (host case, default port, no fragment), **Then** `409` `duplicate_endpoint_url`; two concurrent creates of the same new URL give one `201` and one `409`. The same URL in shop `B` is allowed.
13. **AS-13** (authentication, role, tenant isolation) — **Given** every route of the endpoint API, **When** called anonymously, **Then** `401`; **When** called by `sam` (STAFF, no `webhooks.manage`), **Then** `403` `permission_denied`; **When** called by `bob` on `/shops/A/…`, **Then** `404` (shop existence hidden, S03); **When** `bob` calls `/shops/B/developers/webhooks/E1` with `E1` of shop `A`, **Then** `404` `webhook_endpoint_not_found` with a body byte-identical to that of a random unknown ID; no state changed anywhere.
14. **AS-14** (event-type catalogue) — **When** `alice` calls `GET /shops/A/developers/webhook-event-types`, **Then** `200 {items: [{type, description, resource, since}]}` listing exactly the 11 types of FR-020 in a fixed order, matching what create accepts.
15. **AS-15** (management rate limit) — **Given** the limit of FR-054, **When** shop `A` makes more than 120 mutating calls in a minute, **Then** the excess answers `429` `rate_limited` with `Retry-After`; shop `B` is unaffected; when the limiter store is down, mutating calls fail closed with `503` and `Retry-After`.

### User Story 2 — Signed messages and zero-downtime secret rotation (Priority: P1)

A receiver proves a request came from the marketplace and was not replayed. A shop can roll its secret without dropping a single event: for an overlap period both secrets sign every request (P0418, P0518).

**Why this priority**: signatures are the only way a shop can trust an inbound call; rotation is how they recover from a leak.

**Independent Test**: deliver to `R` before, during and after a rotation, verifying with the reference verifier using the old and the new secret.

**Acceptance Scenarios**:

1. **AS-16** (signature scheme) — **Given** `E1` with secret `S1` and a delivery of body `B` at frozen time `T`, **When** it is sent, **Then** the request has header `Marketplace-Signature: t=<T in unix seconds>,v1=<hex>` where `<hex>` is HMAC-SHA256 with key `S1` over the string `"<t>.<B>"` where `B` is the exact bytes sent; the reference verifier returns true with `S1`; false with another secret; false when one byte of `B` changes; the same bytes verify from the receiver's raw body.
2. **AS-17** (verification rules, reference verifier) — **Given** the receiver-side verifier with tolerance 300 s, **When** run over a table, **Then**: valid header → true; any one of several `v1` values matching → true; wrong secret → false; body changed by one byte → false; header absent, empty, without `t`, without `v1`, with non-numeric `t`, or with odd-length or non-hex `v1` → false (never throws); `t` exactly 300 s old → true, 301 s old → false; `t` 300 s in the future → true, 301 s → false; duplicate `t` pairs → false; the comparison is constant-time.
3. **AS-18** (rotation) — **Given** `E1` with secret `S1`, **When** `alice` calls `POST …/E1/rotate-secret` (no body), **Then** `201 {secret: S2, previousSecretExpiresAt: now + 24 h}`; `S2` is new and sealed; `S1` is kept sealed as the previous secret; the next delivery carries **two** `v1` values (current first, previous second) and the verifier passes with `S1` and passes with `S2`; a state-change row and a `secret_rotated` event exist (never containing a secret).
4. **AS-19** (overlap boundary) — **Given** rotation at `T0` with overlap 24 h, **When** deliveries are signed at `T0 + 24 h − 1 ms` and at `T0 + 24 h`, **Then** the first has two `v1` values and the second has exactly one (the current secret); an attempt retried after expiry is signed with the then-current set, never with the secrets of the first attempt.
5. **AS-20** (rotation state rules) — **Given** a rotation whose previous secret is still valid, **When** `alice` calls rotate again, **Then** `409` `rotation_in_progress` and the secrets are unchanged; two rotations at the same moment give one `201` and one `409`; **When** she calls `POST …/E1/expire-previous-secret`, **Then** `200`, the previous secret is erased, the next delivery carries one `v1`, and a new rotation is allowed; calling it with no previous secret answers `409` `no_previous_secret`.
6. **AS-21** (overlap option) — **Given** `E1`, **When** rotate is called with `{overlapHours: 1}` and `{overlapHours: 72}` (after expiring in between), **Then** `previousSecretExpiresAt` is exactly 1 h and 72 h after now; `0`, `73`, a non-integer and an unknown property answer `400`.
7. **AS-22** (secret hygiene) — **Given** an endpoint created, rotated and delivered to, **When** every store and output is inspected, **Then** the plaintext of any secret appears in: the create/rotate responses only; no `GET`/list response, no database column, no cache entry, no outbox row or event, no delivery-log item, no metric label and no log line (all searched); the sealed value cannot be opened with another endpoint's identity as context.

### User Story 3 — Events reach the right shop's endpoints (Priority: P1)

When an order is paid, a product runs low, or a payout is sent, each shop that is affected — and only that shop — gets one message per subscribed, enabled endpoint, in the payload version that endpoint pinned (P0608, P0413).

**Why this priority**: it is what the capability is for; the privacy rule (a shop never sees another shop's data) is the main risk.

**Independent Test**: publish source events through the consumer entry point; assert the messages created per endpoint and their bodies.

**Acceptance Scenarios**:

1. **AS-23** (multi-shop order, slice) — **Given** `order.paid` for order `O` with lines of products `pa1`, `pa2` (shop `A`, subtotal `5000`) and `pb1` (shop `B`, subtotal `3000`), both shops with an endpoint subscribed to `order.paid`, **When** the event is consumed, **Then** each endpoint gets exactly one delivery; `A`'s body is `{id: "evt_…", object: "event", type: "order.paid", created: <occurredAt>, api_version, resource_version: <orderVersion>, data: {object: {id: O, object: "order", shop_order_id, status: "PAID", total: {amount: 5000, currency}, lines: [pa1, pa2 with product_id, title, quantity, unit_price]}}}` and contains neither `pb1`, nor `3000`, nor the buyer's user ID; `B`'s body is the mirror image; money is integer minor units; `id` is the same on a re-consume (AS-30).
2. **AS-24** (pinned versions) — **Given** shop `A` has `E1` pinned to `2026-01-15` and `E2` pinned to `2026-10-01`, both subscribed to `order.paid`, **When** the event is routed, **Then** `E1`'s body shows the older shape (`total` a plain integer plus `currency`, as S42 defines for that version) and `api_version: "2026-01-15"`; `E2`'s shows the money object and `api_version: "2026-10-01"`; both have the same `id`. A resource type with no change between versions is rendered as is.
3. **AS-25** (subscription filter) — **Given** `E1` subscribed to `product.stock_low` only, `E2` subscribed to `order.paid` and disabled, and `E3` of shop `B` subscribed to `order.paid`, **When** an `order.paid` for shop `A` is consumed, **Then** no delivery is created for `E1`, `E2` or `E3`; a shop with no endpoints creates nothing and the consumer still acknowledges.
4. **AS-26** (cancel and refund) — **Given** `order.cancelled {orderId, reason: "payment_failed", previousStatus, orderVersion, shopIds: [A, B]}` and `order.refunded {…, shopIds: [A]}`, **When** consumed, **Then** shops `A` and `B` get `order.cancelled` and `A` gets `order.refunded`, each with `data.object {id, object: "order", status: "CANCELLED" | "REFUNDED", reason?}` and **no amounts and no other shop's identity** (an order-wide amount would reveal other shops' sales); an event without `shopIds` is invalid (AS-31).
5. **AS-27** (product events) — **Given** `catalog.product_created`, `_updated`, `_archived`, `_restored`, `_deleted` for a product of shop `A`, **When** consumed, **Then** `A`'s subscribed endpoints get `product.created`, `product.updated`, `product.archived`, `product.updated` (restored), `product.deleted` with `data.object {id, object: "product", title, price: {amount, currency}, stock, status, changed_fields}` copied from the event (deleted: `{id, object: "product"}`); `resource_version = productVersion`; no read of the product table happens (the event is the only source); a subscription or URL changed 2 s earlier is honoured (AS-34).
6. **AS-28** (low stock, P0608) — **Given** `catalog.product_updated` snapshots (with `occurredAt`), **When** run through the rule, **Then** the table holds: `quantity 5` and `changedFields ∋ quantity` → emits `product.stock_low` with `data.object {id, object: "product", title, stock, threshold: 5}`; `quantity 6` → nothing; `quantity 3` but `changedFields = ["title"]` → nothing; a second qualifying snapshot of the same product on the same UTC day (by `occurredAt`) → nothing (same deterministic event ID, not re-delivered); the same product on the next UTC day → emits again; `quantity 0` → emits. An `isSandbox: true` snapshot never emits (AS-29).
7. **AS-29** (sandbox and payouts) — **Given** an `isSandbox: true` product event, **Then** no delivery is created; **Given** `payout.paid {payoutId, shopId, periodStart, amountMinor, currency, transferRef, paidAt, payoutVersion}` and `payout.failed {…, failureCode, payoutVersion}`, **When** consumed, **Then** the shop's subscribed endpoints get `payout.paid` / `payout.failed` with `data.object {id: payoutId, object: "payout", amount: {amount, currency}, period_start, status, transfer_ref? | failure_code?}` and `resource_version = payoutVersion`; `payout.cancelled`, `payout.in_doubt` and `payout.discrepancy_detected` are ignored.
8. **AS-30** (duplicate source events) — **Given** one `order.paid` event, **When** it is consumed twice, and then twice at the same moment (`Promise.all`), **Then** each subscribed endpoint has exactly one delivery with the same `evt_` ID, exactly one message in its ordered lane, and one routing receipt; the second and later consumptions acknowledge without effect (VII.4).
9. **AS-31** (invalid source payload, DLQ) — **Given** an `order.paid` whose payload lacks `shopOrders`, an `order.cancelled` without `shopIds`, a payload with the wrong `version`, and a non-JSON payload, **When** delivered to the consumer, **Then** each is rejected by schema validation and dead-lettered with the reason, no delivery or receipt is created, and a valid event queued behind them is still routed (VII.4).
10. **AS-32** (out-of-order source events) — **Given** `catalog.product_updated` with `productVersion 7` consumed before the one with `productVersion 6`, **When** routed, **Then** both are delivered, none dropped, in the order consumed, each body carrying its own `resource_version` and `created`, so a receiver can discard the stale one; the router never reorders or merges.
11. **AS-33** (queue unavailable) — **Given** the ordered-lane queue rejects the write, **When** an `order.paid` is consumed, **Then** the consumer does not acknowledge (the event is redelivered), nothing is half-created for some endpoints only that cannot be completed later, and after recovery the event yields exactly one delivery per endpoint (no loss, no duplicate).
12. **AS-34** (subscription freshness) — **Given** an endpoint disabled (or its events changed) through the API on one instance, **When** an event is routed on another instance within 5 s of the commit, **Then** the change is honoured; routing never uses a per-process copy that outlives the change.

### User Story 4 — Delivery: ordered per endpoint, isolated, retried (Priority: P1)

Each endpoint receives its events one at a time in the order they were routed. A failing or slow endpoint is retried on a growing schedule and trips a circuit breaker, while every other endpoint carries on (P0604, P0617, P0418).

**Why this priority**: the promise to shops — and the reason for a queueing design at all.

**Independent Test**: a receiver that answers per script (200, 500, hang, slow-drip, 301, 429 with `Retry-After`) with a controlled clock and resolver.

**Acceptance Scenarios**:

1. **AS-35** (successful delivery) — **Given** a queued delivery of event `evt_1` to `E1`, **When** the worker handles it, **Then** `R` receives one `POST` with `Content-Type: application/json`, `Marketplace-Signature`, `Marketplace-Event-Id: evt_1`, `Marketplace-Delivery-Id`, `Marketplace-Event-Type: order.paid`, `Marketplace-Attempt: 1`, a `User-Agent` of `Marketplace-Webhooks/1`, and the exact stored body; on `2xx` the delivery is `delivered`, one attempt log item `{attempt: 1, status: 200, ok: true, durationMs, responseSnippet}` exists, and `failingSince` is null.
2. **AS-36** (order and single flight) — **Given** events `e1…e5` routed to `E1` in that order and a receiver that records arrivals and concurrent connections, **When** all are delivered, **Then** `R` sees `e1…e5` in order and never more than one request in flight for `E1`.
3. **AS-37** (isolation) — **Given** `E1` whose receiver never answers and `E3` (healthy) of another shop, each with 20 queued events, **When** all are processed, **Then** `E3`'s 20 deliveries all complete with a 99th-percentile delay under 2 s from queueing, and each of `E1`'s attempts ends within 10 s.
4. **AS-38** (timeouts) — **Given** a receiver that accepts the connection and never replies, and another that replies one byte per second forever, **When** delivered, **Then** each attempt is aborted 10 s after it started (overall deadline, not idle), logged `error: timeout`, and counted as a failure; a receiver that answers with a 1 MiB body is read at most to 1 KiB, the snippet is truncated to 1 KiB, and the attempt result is the status code.
5. **AS-39** (response classification) — **Given** receiver answers, **When** `200`, `201`, `202`, `204` come back, **Then** each is `delivered`; **When** `301` comes back with a `Location` to a second test server, **Then** the redirect is **not followed** (that server receives nothing), the attempt is a failure `status 301`; `400`, `401`, `404`, `410`, `422`, `500`, `502` and a connection reset are failures that are retried; `408`, `429` and `503` with `Retry-After: 7200` make the next retry no earlier than 2 h away (the later of the schedule and the header, capped at 24 h).
6. **AS-40** (ordered-lane then retry-lane, P0604) — **Given** `E1`'s receiver answers `500` to everything, **When** event `e1` is delivered, **Then** attempts 1–3 happen in the ordered lane 30 s apart (so `e2` waits behind them), after the third failure `e1` leaves the lane and a retry is scheduled; the retry delays follow AS-41; after the 11th failed attempt `e1` is `exhausted`, its attempts are logged with numbers 1…11, no further attempt is made, and it stays replayable.
7. **AS-41** (retry schedule, pure) — **Given** the schedule after attempt 3 of `5 min, 30 min, 2 h, 5 h, 10 h, 24 h, 24 h, 24 h`, each multiplied by a random factor in `[0.8, 1.2]`, **When** the schedule function runs over `(attempt, randomUnit 0 and 1, Retry-After)`, **Then** delays are exactly these ±20 %, never below the `Retry-After` and never above 24 h, attempt 11 returns "exhausted", and the sum of the central delays is 3 days 17 h 35 min.
8. **AS-42** (recovery and the order trade-off) — **Given** `e1` failed three times and left the ordered lane, and `e2` was delivered, **When** the receiver recovers and the retry of `e1` runs, **Then** `e1` is delivered with the same `id` and the same body bytes as before, `R` saw `e2` before `e1` (documented: a retried event can arrive after newer ones; `created` and `resource_version` let the receiver cope), `failingSince` is cleared, and later events are no longer delayed.
9. **AS-43** (worker crash mid-attempt) — **Given** a worker that dies after sending the request but before recording the result, **When** the message becomes visible again after the visibility timeout (30 s), **Then** a second attempt sends the same body with the same `Marketplace-Event-Id` and `Marketplace-Attempt: 2` (receivers deduplicate on the event ID); the repeat is attempt number 2 whether or not attempt 1 was recorded (an in-doubt attempt consumes its number), the log holds the repeat's result, and the delivery ends `delivered` or continues the schedule; nothing is lost.
10. **AS-44** (duplicate and concurrent messages) — **Given** a delivery already `delivered`, **When** its queue message is processed again, **Then** no request is sent and the message is acknowledged; **When** two workers handle the same pending delivery at the same moment (`Promise.all`), **Then** exactly one request is sent for that attempt number (the attempt is claimed atomically).
11. **AS-45** (partial batch failure) — **Given** a batch of three messages for three endpoints where the second endpoint answers `500`, **When** the batch is processed by the Lambda handler, **Then** the response lists only the second message as failed; the other two are acknowledged and sent once.
12. **AS-46** (poison message and redrive, P0604) — **Given** a queue message that is not a valid delivery, **When** it is received 5 times, **Then** it moves to the dead-letter lane without any request and without blocking other messages of its group; **Given** a valid message that landed there because the delivery log store was down, **When** an operator redrives it, **Then** it is processed and delivered exactly once.
13. **AS-47** (circuit breaker, P0617) — **Given** `E1`'s receiver fails, **When** the 5th consecutive failed attempt is recorded, **Then** `E1`'s breaker is `open` for 1 minute; deliveries handled meanwhile send **no** request and are rescheduled for the moment the breaker closes with the attempt number unchanged; after 1 minute exactly one probe request is allowed (two concurrent deliveries → one request); a successful probe closes the breaker and resets the count; a failed probe re-opens it for twice as long, up to 30 minutes; `E3`'s deliveries are untouched throughout.
14. **AS-48** (breaker state machine, pure) — **Given** the breaker rules, **When** run over `(consecutiveFailures, now, openUntil, probeInFlight)`, **Then** open durations are 1, 2, 4, 8, 16, 30, 30 … minutes after failures 5, 6, 7, 8, 9, 10, 11 …; closed→open at failure 5 exactly; half-open admits one probe; any success resets; all states are matched with `assertNever`.
15. **AS-49** (breaker store down, fallback) — **Given** the breaker's store is unreachable, **When** deliveries are processed, **Then** they are sent as if the breaker were closed (fail open), `webhook_breaker_degraded_total` increases, and no delivery is lost or doubled.
16. **AS-50** (disable and delete take effect quickly) — **Given** `E1` with five queued deliveries, **When** `alice` disables it, **Then** no request to `E1` starts later than 5 s after the response (the status is read from the store at every attempt, not from a long-lived cache), and each queued delivery becomes `cancelled` (`endpoint_disabled`) when handled; re-enabling does not resend them (the shop replays what it wants); the same holds for delete.
17. **AS-51** (address re-check per attempt, DNS rebinding, P0507) — **Given** `E1` saved while `hooks.acme.test` resolved to a public address, **When** at attempt time the resolver answers `10.0.0.5`, **Then** no connection is made, the attempt is logged `error: blocked_address`, it counts as a failure (retry schedule applies), and when the resolver answers a public address again the next attempt delivers; **When** the resolver answers address `P1` for the check, **Then** the connection goes to `P1` even if a second lookup would return `P2` (the connection is pinned to the checked address, TLS still verifies the host name; a certificate mismatch is `error: tls_error`).
18. **AS-52** (guard matrix at delivery) — **Given** a receiver that redirects to `http://169.254.169.254/latest/meta-data`, and resolver answers of `127.0.0.1`, `::1`, `::ffff:10.0.0.1`, `100.64.0.1`, `fd00::1`, `224.0.0.1`, `0.0.0.0`, **When** delivered, **Then** nothing is ever requested from those addresses; each case logs `blocked_address` or a not-followed `3xx`; no response body from a blocked target reaches the log.
19. **AS-53** (oversized body) — **Given** a routed event whose rendered body exceeds 256 KiB, **When** it is handled, **Then** it is recorded `failed` with reason `payload_too_large` on attempt 1, no request is sent, it is not retried, and it is visible in the log and replayable only as stored (it will fail again; documented).
20. **AS-54** (graceful shutdown, VIII.4) — **Given** a worker with an attempt in flight, **When** it receives the termination signal, **Then** it stops taking messages, the in-flight attempt finishes (≤ 10 s) and is recorded and acknowledged, and only then are connections closed; no attempt is recorded twice.

### User Story 5 — A dead endpoint is switched off, and the shop is told (Priority: P2)

An endpoint that has failed continuously for three days is disabled automatically so we stop calling a server that is gone; the owners get an alert, and the shop can turn it back on (P0418).

**Why this priority**: protects our workers and the shop's inbox from endless failures; second to delivery itself.

**Independent Test**: advance the clock over three days of failing attempts and then run the sweep.

**Acceptance Scenarios**:

1. **AS-55** (failure window) — **Given** an enabled `E1` whose first failed attempt at `T0` sets `failingSince = T0`, **When** another failed attempt happens at `T0 + 3 d − 1 s`, **Then** it stays enabled; **When** one happens at `T0 + 3 d`, **Then** it becomes `disabled` with `disabledReason: "auto_failing"` in the same step, a state-change row exists, its pending deliveries become `cancelled` (`endpoint_disabled`), and exactly one outbox event `developer_platform.webhook_endpoint_disabled {endpointId, shopId, host: "hooks.acme.test", failingSince: T0}` is written in the same transaction.
2. **AS-56** (a success resets the window) — **Given** `failingSince = T0` and a `2xx` at `T0 + 2 d`, **When** later failures begin at `T0 + 2 d + 1 h`, **Then** `failingSince` is the new first failure and the endpoint is disabled only three days after that.
3. **AS-57** (sweep) — **Given** `E1` with `failingSince = now − 3 d − 1 h` and no further attempts (every delivery is exhausted), and `E2` with `failingSince = now − 2 d`, **When** the scheduled job `webhooks.disable-failing-endpoints` runs (single-run, every 15 minutes), **Then** `E1` is disabled with the same effects as AS-55 and `E2` is untouched; the job running twice, or on two instances at the same moment, produces exactly one disable and one event.
4. **AS-58** (alert hygiene) — **Given** `E1` at `https://hooks.acme.test/in?token=SECRET123`, **When** it is auto-disabled, **Then** the event, every log line and every metric label contain `hooks.acme.test` and never `/in`, `token` or `SECRET123`.
5. **AS-59** (re-enable after auto-disable) — **Given** an auto-disabled `E1`, **When** `alice` enables it, **Then** `failingSince` is null, the breaker is closed; **When** it fails again for three days, **Then** it is disabled again and a second event with the new `failingSince` is written (the alert is once per failure window, not once per endpoint).

### User Story 6 — See what happened, replay it, send a test (Priority: P2)

A shop owner debugging their receiver sees every attempt with its result, re-sends any stored event exactly as it was, and can send a test event to one endpoint (D24).

**Why this priority**: self-service debugging prevents support load; depends on delivery existing.

**Independent Test**: after a failed and a delivered event, list attempts, replay, ping.

**Acceptance Scenarios**:

1. **AS-60** (attempt log) — **Given** `E1` with 60 attempts across events, **When** `alice` calls `GET …/E1/attempts?limit=25`, **Then** `200 {items, nextCursor}` newest first by `(startedAt, attemptId)` descending, each item `{attemptId, deliveryId, eventId, type, attempt, startedAt, durationMs, status, ok, error?, responseSnippet?, replay: boolean}`; the filters `eventId` and `ok=false` work; a new attempt inserted between two page calls produces no duplicate and no gap; another endpoint's attempts never appear; items older than 30 days are not returned even if not yet physically removed; no signature, header or secret is ever in an item.
2. **AS-61** (event detail) — **Given** `evt_1` delivered to `E1`, **When** `alice` calls `GET …/E1/events/evt_1`, **Then** `200 {eventId, type, createdAt, state, attempts, body}` with the stored body parsed; an unknown event, an event of another endpoint of the same shop, and an event older than 30 days answer `404` `webhook_event_not_found`.
3. **AS-62** (replay) — **Given** `evt_1` stored for `E1`, **When** `alice` calls `POST …/E1/events/evt_1/replay` with `Idempotency-Key: k1`, **Then** `202 {deliveryId, eventId: "evt_1", endpointId, state: "queued"}` immediately (no request to `R` is made inside the HTTP call); the worker then sends the **byte-identical stored body** with the same `id`, a fresh signature timestamp, a new `Marketplace-Delivery-Id`, and `Marketplace-Replay: 1`; it goes through `E1`'s ordered lane; it is attempted once with no retry; its result is in the log with `replay: true`; whether it succeeds or fails it does not change `failingSince`, the breaker, or auto-disable.
4. **AS-63** (replay idempotency, V.6) — **Given** the call above, **When** it is repeated with `Idempotency-Key: k1`, **Then** the same `202` body with `Idempotent-Replayed: true` and still one replay delivery; two at the same moment give one `202` and one `409` `idempotency_in_flight`; `k1` with another event ID answers `422` `idempotency_key_reuse`; no header answers `422` `idempotency_key_required`; after 24 h the key is accepted anew.
5. **AS-64** (replay guards) — **Given** `E1` disabled, **When** replay or ping is called, **Then** `409` `endpoint_disabled`; **When** the event is unknown, expired (older than 30 days), or belongs to another shop's endpoint, **Then** `404` `webhook_event_not_found` (the cross-shop case is byte-identical to the unknown case); replay of an event type the endpoint no longer subscribes to is allowed.
6. **AS-65** (test ping) — **Given** `E1` (subscribed or not to `webhook.ping`), **When** `alice` calls `POST …/E1/ping`, **Then** `202`; `R` receives a signed event `{type: "webhook.ping", data: {object: {object: "ping"}}}` with a fresh `evt_` ID, in `E1`'s pinned version, through the ordered lane, once, no retry, no effect on health; only `E1` gets it (not the shop's other endpoints); more than 10 pings per minute to one endpoint answer `429`.

### User Story 7 — Lifecycle and retention (Priority: P3)

When a shop is deleted its endpoints and logs go; logs and stored bodies are kept for 30 days only.

**Why this priority**: privacy and storage hygiene; independent of the main flow.

**Independent Test**: publish `tenancy.shop_deleted`; read rows and log items before and after; move the clock by 30 days.

**Acceptance Scenarios**:

1. **AS-66** (shop deleted) — **Given** shop `A` with 3 endpoints and delivery logs, and queued deliveries, **When** `tenancy.shop_deleted {shopId: A}` is consumed, **Then** the endpoints, their state-change rows and their log items are deleted in batches of at most 1,000 rows per transaction, queued deliveries are never sent, and a second consumption changes nothing; a payload without `shopId` is dead-lettered with no effect (VII.4).
2. **AS-67** (retention) — **Given** log items created at frozen times, **When** read at `created + 30 d − 1 s` and at `created + 30 d`, **Then** the API returns the item at the first moment and not at the second; the state-change history is kept 400 days.

### User Story 8 — Operability and contract (Priority: P2)

Operators can see the health of delivery; clients can rely on error shapes and schemas; the domain respects its boundaries.

**Acceptance Scenarios**:

1. **AS-68** (observability) — **Given** one delivered and one failed attempt, **When** metrics and logs are read, **Then** `webhook_delivery_attempts_total{outcome}` (`delivered | failed | timeout | blocked | breaker_skipped | cancelled`) and `webhook_delivery_duration_seconds` increased; the structured log line has `requestId` or `traceId`, `deliveryId`, `endpointId`, `eventId`, `attempt`, `status`, `host` and no URL path, query, secret, signature or body.
2. **AS-69** (contracts and errors) — **Given** every route of the endpoint API, **When** called successfully and unsuccessfully, **Then** each success body parses with its `packages/contracts` schema and each error is `application/problem+json` with `type, title, status, detail, instance, requestId, code`; a forced `500` has a generic `detail` and no stack, SQL or upstream text.
3. **AS-70** (boundaries, static gate) — **Given** the code of this capability, **Then** `pnpm --dir packages/backend check:table-ownership --strict` shows no `developer-platform` line caused by webhook code; no webhook file imports `@app/domains/notifications` or any other domain's model or `infra/`; no `ShopMembership`, `ShopOrder`, `Product`, `Shop` or `BisOrder*` reference remains; `WebhookEndpoint` has no foreign key to another owner's table; every new table and the log store are in the ownership registry under `domain:developer-platform`.
4. **AS-71** (configuration) — **Given** startup configuration, **When** the private-host allowance is set in a production environment, or the retry schedule is not increasing, or jitter is outside `0…0.5`, or a timeout is not positive, **Then** startup fails with a message naming the setting; outside production the allowance is honoured only for explicitly listed hosts.

### Edge Cases

- **Concurrency**: endpoint limit (AS-11), duplicate URL (AS-12), double enable (AS-09), double rotate (AS-20), duplicate source event (AS-30), duplicate and concurrent queue messages (AS-44), concurrent replay (AS-63), half-open probe (AS-47), sweep on two instances (AS-57).
- **Idempotent replay**: AS-62, AS-63; duplicate source events AS-30; delivered message re-processed AS-44.
- **Illegal state transitions**: enable of enabled, disable of disabled (AS-08), rotate during overlap (AS-20), `expire-previous-secret` without previous (AS-20), replay/ping on disabled (AS-64).
- **Cross-tenant**: AS-13 (every route), AS-23 (payload slice), AS-26 (no amounts), AS-64 (replay of another shop's event), AS-60/AS-61.
- **Limits and timeouts**: 20 endpoints (AS-11), 2,048-character URL and 20 types (AS-02), 10 s overall attempt timeout (AS-38), 1 KiB snippet (AS-38), 256 KiB body (AS-53), `overlapHours` 1–72 (AS-21), page size 1–100 (AS-05), rate limits (AS-15, AS-65), 30-day retention (AS-67), 5-minute signature tolerance (AS-17).
- **Out-of-order and duplicate events**: AS-32, AS-30, AS-42, AS-43.
- **Dependency faults**: queue down (AS-33), breaker store down (AS-49), limiter store down (AS-15), log store down with redrive (AS-46).
- **Redirects, DNS rebinding, blocked ranges**: AS-03, AS-39, AS-51, AS-52.

## Requirements *(mandatory)*

### Functional Requirements

**Endpoints**

- **FR-001**: A shop with `webhooks.manage` can create, list, read, update, enable, disable and delete endpoints under `/shops/{shopId}/developers/webhooks`; every route requires `webhooks.manage` (OWNER, ADMIN per S03) (AS-01, AS-05–AS-10, AS-13).
- **FR-002**: Create and update validate input at the boundary with a whitelist (unknown properties rejected): URL ≤ 2,048 characters, 1–20 distinct event types from the catalogue, optional supported `apiVersion`. Violations answer `400 validation_failed` naming the field (AS-02) (P0112).
- **FR-003**: An endpoint URL MUST be `https`, have no user-info, use port 443, be a host name (no IP literal, no `localhost`), and every address its name resolves to MUST be public; otherwise `422 endpoint_url_rejected` with a reason from the closed list. The check runs on create, on update of the URL, and on enable (AS-03, AS-07, AS-08) (P0507).
- **FR-004**: A new endpoint without `apiVersion` takes the shop's pinned version (S42), else the latest; the version is per endpoint afterwards (AS-04) (P0413).
- **FR-005**: A shop has at most 20 endpoints and no two endpoints with the same normalised URL; both rules are enforced by the store, not by check-then-write (AS-11, AS-12).
- **FR-006**: Endpoint status is `enabled` or `disabled` (`disabledReason`: `manual` or `auto_failing`). Transitions are conditional updates asserting the source status, each with a history row in the same transaction; an illegal transition answers `409 endpoint_state_conflict` (AS-08, AS-09). Enabling clears the failure window, the breaker and the failure count.
- **FR-007**: Delete removes the endpoint; deliveries not yet attempted are cancelled when handled; all other routes then answer `404` (AS-10).
- **FR-008**: Lists use keyset pagination with an opaque cursor, default 25, maximum 100, ordered by `(createdAt desc, id desc)`; a bad cursor or limit answers `400` (AS-05).
- **FR-009**: Every lookup puts the shop in the predicate. An endpoint of another shop answers `404 webhook_endpoint_not_found` byte-identical to an unknown ID; roles without `webhooks.manage` answer `403`; non-members `404`; anonymous `401` (AS-13).
- **FR-010**: The catalogue route lists the event types, their resource and the version they appeared in (AS-14).
- **FR-011**: Every state change of an endpoint (created, url/events/version changed, enabled, disabled, secret rotated, previous secret expired, deleted) writes a history row and an outbox event `developer_platform.webhook_endpoint_changed` in the same transaction (AS-01, AS-07, AS-08, AS-18).

**Signing and secrets**

- **FR-012**: Every request carries `Marketplace-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]` where each `v1` is HMAC-SHA256 over `"<t>.<exact body bytes>"` with one active secret; `t` is taken at every attempt, the body bytes never change across attempts or replays (AS-16, AS-62) (P0418).
- **FR-013**: At most two secrets are active: the current one and, for an overlap of 1–72 h (default 24 h), the previous one. The header has one `v1` per active secret at the moment of signing, current first. The previous secret is excluded exactly at its expiry instant (AS-18, AS-19, AS-21).
- **FR-014**: Rotation while a previous secret is valid is refused (`409 rotation_in_progress`); the previous secret can be ended early (`expire-previous-secret`); both are conditional updates (AS-20).
- **FR-015**: Secrets are generated with at least 256 bits of randomness, shown once (create and rotate responses), sealed at rest bound to the endpoint's identity, never cached in plaintext, never in logs, events, metrics or the delivery log (AS-22) (P0518).
- **FR-016**: A reference verification function with the rules of AS-17 (tolerance 300 s, constant-time compare, any-of-many `v1`, never throws) is part of the published developer documentation and is the function the tests use (AS-17).

**Routing**

- **FR-020**: The event catalogue is exactly: `order.paid`, `order.cancelled`, `order.refunded`, `product.created`, `product.updated`, `product.archived`, `product.deleted`, `product.stock_low`, `payout.paid`, `payout.failed`, `webhook.ping`. Adding a type is non-breaking; removing one needs a deprecation announcement (AS-14) (P0413).
- **FR-021**: Source events are consumed idempotently (receipt per source `eventId`), validated by schema, and routed per affected shop to every enabled endpoint of that shop subscribed to the type. Invalid payloads are dead-lettered with no effect and never block the stream (AS-25, AS-30, AS-31) (P0608, P0112).
- **FR-022**: The message to a receiver is `{id, object: "event", type, created, api_version, resource_version, data: {object}}`: `id` is `evt_` plus a deterministic digest of (source event, shop) so repeats have the same ID; `created` is the source event's time; `resource_version` is the source aggregate's version (null for pings); `data.object` is a fat snapshot copied from the source event, rendered in the endpoint's pinned version through S42's transformer, money as integer minor units (AS-23, AS-24) (P0608, P0413).
- **FR-023**: A message carries only the shop's own data: order events carry only that shop's lines and subtotal; cancel and refund events carry no amounts; no buyer identity is ever included (AS-23, AS-26).
- **FR-024**: Events of sandbox shops or sandbox products are never delivered (AS-29).
- **FR-025**: `product.stock_low` is produced when a product snapshot has `quantity ≤ 5`, `changedFields` contains `quantity`, and none was produced for that product on that UTC day (by the event's `occurredAt`); the event ID is deterministic per (product, day) (AS-28).
- **FR-026**: The router never reorders, merges or drops events other than by FR-024/FR-025; out-of-order source events are delivered as consumed with their own `resource_version` (AS-32).
- **FR-027**: If the ordered lane cannot accept a message, the source event is not acknowledged and is redelivered; recovery yields one delivery per endpoint (AS-33).
- **FR-028**: Subscription and status reads by the router and the worker see a change committed on another instance within 5 s; no per-process copy outlives it (AS-34, AS-50).

**Delivery, ordering, retries**

- **FR-030**: Delivery is at-least-once. Each endpoint has its own ordered lane: events are attempted in routed order, one in flight at a time, and a failing endpoint blocks only its own lane (AS-36, AS-37) (P0604).
- **FR-031**: An attempt is one `POST` of the stored body with the headers of AS-35, to an address that passed the guard of FR-040, with an overall deadline of 10 s, a response read capped at 1 KiB, no redirects. Only `2xx` is success (AS-35, AS-38, AS-39).
- **FR-032**: A failed attempt is retried: attempts 1–3 in the ordered lane 30 s apart, then after 5 min, 30 min, 2 h, 5 h, 10 h, 24 h, 24 h, 24 h, each with ±20 % jitter, stretched to honour `Retry-After` (cap 24 h). After attempt 11 the delivery is `exhausted`. All numbers are configuration (AS-40, AS-41, AS-71).
- **FR-033**: A delivery has a state: `queued → delivering → delivered | retry_scheduled → … | exhausted | cancelled | failed` (`failed` only for non-retryable `payload_too_large`). A delivery already `delivered` is never re-sent by queue redelivery; an attempt is claimed atomically so two workers never send the same attempt (AS-44).
- **FR-034**: A per-endpoint circuit breaker opens after 5 consecutive failed attempts for 1 min, doubling per further consecutive failure up to 30 min; while open, deliveries send nothing and are rescheduled to the close time without consuming an attempt; one probe is allowed when it closes; a success resets it. If the breaker's store is unavailable, delivery proceeds as closed and the degradation is counted (AS-47, AS-48, AS-49) (P0617).
- **FR-035**: A message that cannot be parsed, or fails 5 receives for infrastructure reasons, goes to the dead-letter lane; a redriven message is processed exactly once; in batch handlers only the failed messages are reported failed (AS-45, AS-46) (P0604).
- **FR-036**: A queue message stays invisible for at least the attempt deadline plus margin (30 s) so a slow attempt is not duplicated by another worker; a crash mid-attempt leads to a repeat attempt with the same event ID and body (AS-43).
- **FR-037**: A body over 256 KiB is not sent; the delivery is `failed (payload_too_large)` with no retry (AS-53).
- **FR-038**: Shutdown stops intake, lets in-flight attempts finish (≤ 10 s), records them, then closes connections (AS-54).

**Address safety**

- **FR-040**: Before every attempt the host is re-resolved and every address must be public (not loopback, private, link-local including the metadata address, carrier-grade NAT, unique-local, multicast, unspecified, reserved, or an IPv4-mapped form of those); the connection is pinned to the checked address with TLS verifying the host name; redirects are never followed; a blocked attempt is logged and counts as a failure (AS-51, AS-52) (P0507).
- **FR-041**: A configuration allowance for private hosts exists only outside production, only for listed hosts; startup fails if it is set in production (AS-71).

**Auto-disable and alerts**

- **FR-042**: `failingSince` is set by the first failed attempt after a success (or enable) and cleared by any `2xx`. When an attempt fails at or after `failingSince + 3 d`, the endpoint is disabled (`auto_failing`) by a conditional update in the same step; a scheduled single-run job every 15 minutes disables endpoints past the window with no running attempts. Exactly one `developer_platform.webhook_endpoint_disabled {endpointId, shopId, host, failingSince}` is written per disable, in the same transaction; it never contains path or query (AS-55–AS-59) (P0418).
- **FR-043**: Replays and pings are single attempts that never change `failingSince`, the breaker or the failure count (AS-62, AS-65).

**Log and replay**

- **FR-044**: Every attempt and every event body is stored for 30 days (delivery log); the API never returns items older than 30 days; the history of state changes is kept 400 days (AS-60, AS-67).
- **FR-045**: `GET …/attempts` and `GET …/events/{eventId}` return the log shapes of AS-60/AS-61, cursor-paginated and shop-scoped; they never expose secrets, signatures or request headers (AS-60, AS-61).
- **FR-046**: Replay re-sends the stored body unchanged, requires `Idempotency-Key` (replay, in-flight `409`, different-key-body `422`, 24 h TTL), answers `202` without calling the receiver inside the request, and is refused for a disabled endpoint (`409 endpoint_disabled`) or an unknown/expired event (`404`) (AS-62–AS-64) (P0414 as consumer).
- **FR-047**: A ping goes to one endpoint, signed, versioned and ordered like any event, even if it is not subscribed; limited to 10 per minute per endpoint (AS-65).

**Lifecycle**

- **FR-048**: `tenancy.shop_deleted` removes the shop's endpoints, history and log in batches of ≤ 1,000 rows per transaction, idempotently, and queued deliveries are never sent (AS-66).

**Cross-cutting**

- **FR-050**: Every error is problem+json with a stable `code` (`validation_failed` 400, `invalid_cursor` 400, `permission_denied` 403, `webhook_endpoint_not_found` 404, `webhook_event_not_found` 404, `duplicate_endpoint_url` 409, `endpoint_state_conflict` 409, `rotation_in_progress` 409, `no_previous_secret` 409, `endpoint_disabled` 409, `idempotency_in_flight` 409, `endpoint_url_rejected` 422, `endpoint_limit_reached` 422, `idempotency_key_required` 422, `idempotency_key_reuse` 422, `rate_limited` 429, `service_unavailable` 503); 5xx details are generic (AS-69).
- **FR-051**: Every response has a schema in `packages/contracts`; clients import it and never hand-write the type (AS-69).
- **FR-052**: Metrics: `webhook_delivery_attempts_total{outcome}`, `webhook_delivery_duration_seconds`, `webhook_routing_lag_seconds`, `webhook_lane_age_seconds`, `webhook_endpoints_breaker_open`, `webhook_breaker_degraded_total`, `webhook_auto_disabled_total`, `webhook_dead_lettered_total{lane}`; logs are structured with request or trace ID and carry host only (AS-68).
- **FR-053**: Every outbound or store call sets an explicit timeout; retries happen at exactly one layer (the delivery schedule); there is no network call inside an open database transaction; outbox rows carry the events (AS-55, AS-58).
- **FR-054**: Rate-limit policies declared in S50's registry: `webhooks.manage.shop` 120 mutating calls per minute per shop (fail closed); `webhooks.replay.shop` 30 per minute per shop (fail closed); `webhooks.ping.endpoint` 10 per minute per endpoint (fail closed) (AS-15, AS-65).
- **FR-055**: Every table and log store of this capability is in the ownership registry under `domain:developer-platform`; no query touches a table of another owner; cross-domain data comes only as in the "Cross-domain data used" list (AS-70) (IX.4, IX.7).

### Key Entities

- **Webhook endpoint**: a shop's registered receiver: URL, subscribed event types, pinned API version, status (`enabled`/`disabled` + reason), failure window start, current secret and optional previous secret with expiry (both sealed), creation and update times. Owned here; one shop has up to 20.
- **Endpoint state change**: append-only history of what changed and who changed it (facet, from, to, actor, time).
- **Webhook event**: one message for one endpoint: deterministic `evt_` ID, type, created time, resource version, pinned-version body (stored 30 days).
- **Delivery**: the journey of one event to one endpoint (`queued … delivered | exhausted | cancelled | failed`), including replays and pings.
- **Attempt**: one request to the receiver: number, start, duration, status or error class, response snippet, replay flag.
- **Circuit breaker state**: per endpoint, derived and disposable (closed/open/half-open, consecutive failures, open-until).
- **Routing receipt**: records that a source event was routed, for duplicate suppression.
- **Event catalogue**: the 11 types, their resource and introduction version (a constant, not stored).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: With a healthy receiver, 95% of order and product events reach the shop's endpoint within 5 seconds of the marketplace event being accepted.
- **SC-002**: While one endpoint hangs on every request, other endpoints' deliveries keep a 99th-percentile delay under 2 seconds (the SD-30 target).
- **SC-003**: 100% of requests verify with the reference verifier using the then-active secrets, including every request during a rotation overlap, with 0 failures at the overlap boundary.
- **SC-004**: 0 requests are ever made to a loopback, private, link-local, metadata, carrier-grade, multicast or reserved address across the full address matrix, at save time and at attempt time, including after DNS changes and via redirects.
- **SC-005**: For a single endpoint, 100% of events routed in order are first attempted in that order and never two at once.
- **SC-006**: Delivering any source event, queue message or shop-deleted event twice (or twice at once) results in at most one request per attempt number and one delivery per (event, endpoint); a repeated delivery after a crash carries the same event ID and bytes 100% of the time.
- **SC-007**: An endpoint failing continuously for three days is disabled within 15 minutes of the threshold and its owners get exactly one alert event; an endpoint that recovers at any time before is never disabled.
- **SC-008**: Every failed event is retried over at least three days (11 attempts) before being given up, and 100% of given-up events remain replayable for 30 days.
- **SC-009**: A manager sees the outcome of any attempt in the log within 10 seconds of it ending, and 100% of replays send the identical stored body.
- **SC-010**: 0 cross-shop leaks in the matrix of every route × another shop, and 0 other-shop fields in any multi-shop order message.
- **SC-011**: The system sustains 5,000 deliveries per second across 500,000 endpoints (ops load test; not part of the API test table).

## Assumptions

Each is also a line in `questions.md`.

- **Event catalogue** is the 11 types of FR-020. `stock.low` of the old notes is `product.stock_low`; `payout.sent` is `payout.paid`. Types for fulfilment, auctions, bookings, imports and integrations are later additions (non-breaking).
- **Retry classification**: every non-`2xx` result and every error is retried on the same schedule (a mis-deployed receiver is typically fixed within the window); redirects are failures; there is no "permanent 4xx" shortcut. Departs from the narrow IV.6 list because this is a durable delivery product with a 3-day grace period, not a synchronous dependency call.
- **Retry schedule** is 3 ordered-lane attempts then 8 delayed retries (about 3.7 days in total) with ±20 % jitter; the ordered lane is left after 3 attempts on purpose so one dead endpoint cannot hold its lane for days (SD-30). Cost: a retried event may arrive after newer ones; receivers use `created` and `resource_version`.
- **Fat payloads** with `resource_version`, not thin events (SD-30), because the receiver cannot call back with credentials it does not have; payloads contain only the shop's slice and no buyer identity.
- **Permission** is `webhooks.manage` (S03 gives it to OWNER and ADMIN) for every route including reads, because logs and bodies contain order data. Today's `shop.read`/`shop.manage` is replaced.
- **Per-endpoint pinned version** with the shop's pin as default at creation; the version registry and the resource transformer come from S42.
- **Order cancel/refund fan-out** uses a new `shopIds` field on S10's events (the existing join on `ShopOrder` is removed).
- **Suspended shops** keep receiving; **sandbox** shops never do.
- **Replay** is allowed only for events of the same endpoint that still exist in the 30-day log; a replay is one attempt with no retry and no health effect.
- **Ping** goes to one endpoint, not to every endpoint of the shop.
- **Secrets** are 256-bit, `whsec_` prefixed; shown once; no "reveal" route.
- **Numbers are configuration** (attempt deadline 10 s, snippet 1 KiB, body cap 256 KiB, breaker 5 / 1 min / 30 min, window 3 d, sweep 15 min, log TTL 30 d, history 400 d), not contract.
- **Delivery log store** keeps its current kind (a key-value document store with TTL, per the domain map); the spec fixes only the behaviour.

## Cross-capability contracts

**Provides**

- **Dashboard HTTP API** (core, session + `ShopScoped('webhooks.manage')`, prefix `/api/shops/:shopId/developers`; consumers **W04**, **J02**):
  - `POST webhooks {url, events[], apiVersion?}` → `201 {id, url, events, apiVersion, status, secret, createdAt}`; `GET webhooks?limit&cursor` → `{items: WebhookEndpointDto[], nextCursor}`; `GET webhooks/:id`; `PATCH webhooks/:id {url?, events?, apiVersion?}` → `200 WebhookEndpointDto`; `POST webhooks/:id/enable|disable` → `200 WebhookEndpointDto`; `POST webhooks/:id/rotate-secret {overlapHours?}` → `201 {secret, previousSecretExpiresAt}`; `POST webhooks/:id/expire-previous-secret` → `200 WebhookEndpointDto`; `DELETE webhooks/:id` → `204`; `GET webhooks/:id/attempts?eventId&ok&limit&cursor`; `GET webhooks/:id/events/:eventId`; `POST webhooks/:id/events/:eventId/replay` (`Idempotency-Key` required) → `202`; `POST webhooks/:id/ping` → `202`; `GET webhook-event-types` → `{items: [{type, description, resource, since}]}`.
  - `WebhookEndpointDto = {id, url, events, apiVersion, status: "enabled"|"disabled", disabledReason: "manual"|"auto_failing"|null, failingSince: string|null, breaker: "closed"|"open", hasPreviousSecret: boolean, previousSecretExpiresAt: string|null, createdAt, updatedAt}`. Schemas in `packages/contracts`.
- **Outbound webhook contract** (to shops' receivers): header `Marketplace-Signature`, headers `Marketplace-Event-Id`, `Marketplace-Delivery-Id`, `Marketplace-Event-Type`, `Marketplace-Attempt`, `Marketplace-Replay`; body `{id, object: "event", type, created, api_version, resource_version, data: {object}}`; at-least-once, per-endpoint ordered on first attempts, dedupe on `id`; the reference verifier (FR-016). Consumers: shops; **J02** ("receives the order webhook").
- **Events** (outbox → topic group of this domain, keyed by aggregate ID; envelope `{eventId, type, version: 1, occurredAt, aggregateId}`; at least once):
  - `developer_platform.webhook_endpoint_disabled` v1 `{endpointId, shopId, host, failingSince}`, `aggregateId = endpointId`, written once per auto-disable. **Consumer: S28** (matches S28's `[CONTRACT]`; `host` only).
  - `developer_platform.webhook_endpoint_changed` v1 `{endpointId, shopId, change: "created"|"url_changed"|"events_changed"|"api_version_changed"|"enabled"|"disabled"|"secret_rotated"|"previous_secret_expired"|"deleted", actorId?}`, `aggregateId = endpointId`; never a secret or URL. Optional consumers: audit, S28.
- **Exported services (R1)**: none. Nothing but the Nest modules (`WebhooksModule`, `WebhooksWorkerModule`, `WebhooksProjectorModule`, a Lambda-hosting module) and DTO types leaves the domain; `WebhookDeliverer`, `WebhookRouterProjector` and `WebhookEndpointsService` stop being exported (debt D-8).
- **Rate-limit policies declared** (S50's registry): `webhooks.manage.shop`, `webhooks.replay.shop`, `webhooks.ping.endpoint` (FR-054).
- **Scheduled job** (S49): `webhooks.disable-failing-endpoints` (every 15 min, single run).

**Requires**

- **S01**: `SecretBox.seal(plaintext, context)` / `open(sealed, context)` with `context = "webhook-endpoint:<endpointId>"` and previous-key support; `@User()` giving the authenticated user; `Firewall` defaults for dashboard routes. (The secret is never returned except at create/rotate.)
- **S03**: `ShopScoped('webhooks.manage')` (OWNER, ADMIN), `404` for non-members, status gate; event `tenancy.shop_deleted` v1 `{shopId}`. **No `MembershipQueryService` is needed** (alert recipients are S28's job).
- **S42**: `ApiVersionService` (R1): `supportedVersions()`, `latestVersion()`, `isSupported(version)`, `getPinnedVersions(shopIds ≤ 500): Map<ShopId, ApiVersion>`; **new, `[CONTRACT]`**: `transformResource(type: "order" | "product" | "payout", resource: Record<string, unknown>, targetVersion: ApiVersion): Record<string, unknown>` (pure; identity for types and versions with no change) so webhook bodies and REST bodies share one transformer.
- **S10**: topic `orders.events`: `order.paid {orderId, userId, totalMinor, currency, paymentRef, paidAt, lines: [{productId, shopId, title, quantity, unitPriceMinor, discountMinor, lineTotalMinor}], shopOrders: [{shopOrderId, shopId, subtotalMinor}], orderVersion}`; `order.cancelled {orderId, reason, previousStatus, orderVersion}` and `order.refunded {orderId, amountMinor, currency, reason, orderVersion}`, **each with a new additive `shopIds: ShopId[]`** (`[CONTRACT]`).
- **S05**: topic `products.events`: `catalog.product_created|updated|archived|restored {productId, shopId, title, priceMinor, currency, quantity, status, isSandbox, productVersion, changedFields, …}` and `catalog.product_deleted {productId, shopId, productVersion}`, with `occurredAt` in the envelope.
- **S15**: topic `payouts.events`: `payout.paid {payoutId, shopId, periodStart, amountMinor, currency, transferRef, paidAt, payoutVersion}`, `payout.failed {payoutId, shopId, periodStart, amountMinor, currency, failureCode, payoutVersion}` (a new consumer; none of S15's other events).
- **S28** (consumer of ours): reacts to `developer_platform.webhook_endpoint_disabled` and resolves recipients itself (replaces the direct `NotificationRouter` call).
- **S50**: policies above; `check(policy, key)` with fail mode per policy. **S49**: single-run scheduled jobs and delayed jobs (`runAt`, idempotency key). **S52**: cached reads with single-flight and cross-instance invalidation (no per-process layer for subscriptions or status).
- **S53**: `outbox.append` inside the domain's transaction; consumer runtime (envelope check, zod validation, inbox/dedupe, DLQ); SQS port with **FIFO groups and deduplication IDs**, visibility timeout, DLQ with redrive, partial-batch response; the shared **idempotency store** (claim, stored response, fingerprint, TTL) used by the replay route (also asked for by S42).
- **S54**: an **SSRF-safe outbound HTTP client with POST**: `safeRequest({method: "POST", url, headers, body, timeoutMs, maxResponseBytes, allowedPorts: [443], followRedirects: false, resolver?}) → {status, snippet, durationMs} | typed failure {blocked_address | unresolvable | timeout | tls_error | network}` that resolves, validates every address, pins the connection, enforces an **overall** deadline, and never follows redirects (S41 defines `safeGet` with the same guard; this is its POST form); request context with `requestId`; the problem+json filter with `code`; config validation; clock; metrics registry; graceful shutdown hooks.
- **S02 / S01**: no MFA requirement on webhook routes (assumption).
