# Feature Specification: S39 — Analytics Ingestion and A/B Testing (event schema, dedupe, assignment, exposure, SRM, results)

**Feature Branch**: none (spec directory `specs/domains/S39-analytics-ab`)

**Created**: 2026-10-06

**Status**: Draft

**Input**: Capability S39 of `scripts/sdd/capabilities.tsv` (domain `experimentation`). Sources: `docs/showcase/sections/SD-31-analytics-ab-testing.md`, `interview-prep/10-system-design/02-worked-examples.md` Example 2 (A/B testing platform with reliable event ingestion), `interview-prep/08-devops-cloud/04-testing-strategy.md` §8 (what to test for an A/B testing system). Pattern row: P0811 (deterministic hash assignment, SRM chi-square, exposure events, event-ID dedupe), shared with S38. The notes win over the code; the code is an imperfect draft.

## Scope

**In scope** (everything a browser or app, a backend process, a platform admin and an on-call engineer can observe of analytics and experiments):

- The client event contract: names, identifiers, timestamps, properties, limits, enrichment, clock rules, and what is rejected and why.
- Ingestion: the edge collector (primary path) and the backend fallback endpoint, with identical observable rules; partial acceptance; fast acknowledgement; behaviour when the stream is unavailable; rate limits.
- The event stream and the analytical event store: at-least-once delivery, dedupe by event id, event-time ordering, late and out-of-order events, malformed messages, retention.
- Server-originated business events: the `purchase` event derived from paid orders.
- Experiments: definition, validation, lifecycle (draft, running, stopped), layers (mutual exclusion), optimistic concurrency, limits, history, admin access.
- Assignment: deterministic, stateless, sticky, independent between experiments, exclusive inside a layer; the assignment endpoint; degradation to control.
- Exposure: when it is logged, what shape it has, how it is counted.
- Results: conversion per variant, two-proportion significance, sample ratio mismatch (SRM) check, trust verdict, exclusions.
- Operating the capability: rate limits, access control, metrics, logs, ownership of its stores.

**Out of scope** (owned elsewhere; named so nothing is built twice):

- The bucketing hash function itself, feature flags, remote config and their exposure *producer* side → **S38** (same domain). This capability calls S38's `bucketOf(salt, unit)` and accepts S38's flag exposure shape.
- Emitting events from screens (product view, add to cart, checkout steps, exposure on render, anonymous-id cookie, `sendBeacon` batching) → **W02** and **W03**. This capability defines what they may send.
- Trending computation from the stream → **S35** (consumer). Video playback beacons → **S30** (emitter). Link-click analytics → **S37** (its own stream).
- Experiment management screens → no web capability covers experiments yet; this spec defines the admin API they would call.
- Sequential or Bayesian analysis that allows peeking, multi-metric experiments, guardrail metrics, CUPED variance reduction. The analysis here is fixed-horizon and says so.
- Identity stitching across sign-in (merging an anonymous visitor into a user). Experiments choose one unit (`user` or `visitor`) so no merge is needed.
- Erasure of a person's analytics events on request (privacy tooling) and consent management.
- Rate-limiter mechanics (S50), event envelope, outbox and projector machinery (S53), problem+json and request context (S54), sessions and roles (S01).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Clients send events safely and cheaply (Priority: P1)

A browser or app batches events (up to 50), generates an `event_id` for each, and posts them with `sendBeacon` or `fetch` to the edge (primary) or to the backend fallback. The collector validates each event, enriches it, clamps unreliable clocks, answers `202` fast and puts accepted events on the stream. One bad event never drops the other 49. A retried batch is harmless.

**Why this priority**: every other part of this capability, and trending (S35) and video views (S30), depends on trustworthy events.

**Independent Test**: post batches (valid, mixed, malformed, oversized, replayed) to the fallback endpoint and read what reaches the stream and the response.

**Acceptance Scenarios**:

1. **AS-01** — **Given** an anonymous visitor and three valid events (`page_view`, `product_view` with `props {product_id, category}`, `add_to_cart`) at the current time, **When** they `POST /api/events` with `{"events":[…3…]}`, **Then** `202` with `{accepted: 3, rejected: []}` (parses with `ingestResultSchema`); exactly three messages are on topic `analytics.events`, keyed by each event's `anonymous_id`, each with `{event_id, name, anonymous_id, user_id: "", ts, received_at, country: "", platform: "web", page, props}`, `ts` and `received_at` as `YYYY-MM-DD HH:mm:ss.SSS` in UTC, `received_at` equal to the (frozen) request time, every `props` value a string.
2. **AS-02** — **Given** a signed-in buyer with a valid access token, **When** they post one valid event, **Then** the stored `user_id` is the token's user id; **When** an event in the same batch carries its own `user_id`, `received_at`, `country` or `platform` field, **Then** that event is rejected with code `forbidden_field` and the others are accepted; **When** the token is expired or malformed, **Then** the batch is still accepted and `user_id` is `""` (a beacon is never refused for a stale session).
3. **AS-03** — **Given** one batch holding one valid event and one invalid event of each class, **When** it is posted, **Then** `202`, `accepted: 1`, and `rejected` lists `{index, code}` in input order with exactly these codes: `invalid_event_id` (not a UUID), `unknown_event_name` (outside the closed set, including `purchase`, which only the server may emit), `invalid_anonymous_id` (length 7 or 65, or a character outside `[A-Za-z0-9_-]`), `invalid_timestamp` (not an integer number of milliseconds, negative, or a string), `invalid_props` (a nested object or array value, more than 30 keys, a key longer than 64 characters or outside `[A-Za-z0-9_.-]`, a string value longer than 500), `invalid_page` (longer than 500), `invalid_exposure` (see AS-26); only the valid event is on the stream.
4. **AS-04** — **Given** malformed requests, **When** each is posted, **Then** nothing reaches the stream and the answer is problem+json: `400 validation_failed` for non-JSON, `events` missing or not an array, 0 events, or 51 events; `413 payload_too_large` for a body over 128 KiB; `415 unsupported_media_type` for a content type other than `application/json` or `text/plain`.
5. **AS-05** — **Given** the frozen time `T`, **When** events arrive with `ts = T − 7 days` exactly, `T − 7 days − 1 ms`, `T + 10 minutes` exactly, `T + 10 minutes + 1 ms`, and `T − 2 days`, **Then** the first is accepted with its own `ts`; the second is rejected `event_too_old`; the third keeps its `ts`; the fourth is accepted with `ts` replaced by the receive time; the fifth keeps its two-day-old `ts` (event time is preserved for late events).
6. **AS-06** — **Given** a body sent as `text/plain` (what `navigator.sendBeacon` produces) holding the same JSON as AS-01, **When** it is posted, **Then** the outcome is identical to the `application/json` case.
7. **AS-07** — **Given** a batch in which the same `event_id` appears twice, **When** it is posted, **Then** `202` with the first accepted, the second reported as `{index, code: "duplicate_in_batch"}`, and one message on the stream.
8. **AS-08** — **Given** the stream is unreachable or does not acknowledge within 2 seconds, **When** a valid batch is posted, **Then** `503 ingest_unavailable` problem+json with a `Retry-After` header, no event is reported accepted, and `analytics_produce_failures_total` rises by 1; **When** the client retries the same batch (same `event_id`s) after recovery, **Then** `202`, and the store eventually holds each event once (AS-12).
9. **AS-09** — **Given** the ingest limit of 120 requests per minute per user or IP, **When** a caller sends the 121st request in the window, **Then** `429 rate_limited` problem+json with `Retry-After`, nothing is produced, and a different caller is unaffected; **When** the limiter's store is down, **Then** requests are accepted (fail open) and `analytics_rate_limiter_degraded_total` rises.
10. **AS-10** — **Given** the edge collector `POST /collect` and the fallback endpoint, **When** the shared table of test vectors (AS-01 – AS-07 inputs) is run against both, **Then** both produce the same accept/reject decision per event, the same stored event (apart from `received_at`), and the same per-index codes; the edge answers `202` before the stream acknowledges, retries a failed produce up to 3 times with backoff inside the request's background work, and counts every event it finally fails to produce in `analytics_edge_produce_failures_total`; the edge applies the same rate limit as AS-09.
11. **AS-11** — **Given** a request whose `CF-IPCountry` header is not accompanied by the edge credential, or whose `X-Client-Platform` is `toaster`, **When** an event is posted, **Then** `country` is `""` and `platform` is `"web"` for an unknown or missing platform; **When** the edge credential is present and the platform is `ios`, **Then** `country` is the header value and `platform` is `"ios"`. A client can never set `platform: "server"`.

---

### User Story 2 — Duplicates, late events and bad rows cannot corrupt the numbers (Priority: P1)

Delivery is at-least-once: clients retry, the edge retries, the stream redelivers, a projector replays. Everything downstream counts an event once. Events are ordered by when they happened, not when they arrived. A malformed message does not stop the stream.

**Why this priority**: "no lost or duplicated analytics events, or at least measured and bounded" is the non-functional core of the worked example (10/02 Ex2).

**Independent Test**: insert the same event many ways (same row twice, different arrival times, different parts) and read counts and results.

**Acceptance Scenarios**:

1. **AS-12** — **Given** one `event_id` delivered three times, with different `received_at` values and, in one copy, a re-clamped `ts`, **When** any read counts events or results are computed (before or after the store merges its parts), **Then** the event counts once and the first received copy is the one that is read; a later copy with a different `name` or `props` does not change it.
2. **AS-13** — **Given** an `exposure` with event time `T` and a `purchase` with event time `T + 5 min`, **When** the purchase is ingested first and the exposure second (out of order), **Then** the unit converts; **When** instead the purchase's event time is `T − 5 min`, **Then** it does not, whichever arrived first.
3. **AS-14** — **Given** a message on the stream that is not valid JSON or has a wrong field type, followed by valid messages, **When** the store consumes them, **Then** the valid ones are stored, the bad one lands in the error table with `raw`, `error`, `topic`, `partition`, `offset` and a timestamp, consumption never stops, and `analytics_dead_letter_total{source="store"}` rises by 1.
4. **AS-15** — **Given** an `order.paid` event `{userId, total: 4999, currency: "usd", …}` with envelope id `E` and `occurredAt: O`, **When** the purchase projector handles it, **Then** one event is stored: `event_id = E`, `name: "purchase"`, `user_id`, `anonymous_id: ""`, `ts = O`, `platform: "server"`, `props {order_id, total: "4999", currency: "usd"}`; **When** the same envelope is delivered twice, **Then** reads see one purchase; **When** a payload fails the `order.paid` schema, **Then** nothing is stored and it is dead-lettered with `analytics_dead_letter_total{source="purchase-projector"}` +1.
5. **AS-16** — **Given** the migrated store, **When** its definition is inspected, **Then** events are partitioned by event day, retained 400 days, the error table is retained 14 days, and the stream consumer group is `clickhouse-analytics`.

---

### User Story 3 — A visitor always sees the same variant (Priority: P1)

For each running experiment a visitor or user gets one variant, computed from a hash, with no lookup. It never changes while the experiment runs, it is independent of other experiments, and experiments in the same layer never overlap. When the admin stops an experiment, everyone gets the control experience.

**Why this priority**: an experiment whose assignment is unstable or correlated gives meaningless results (08/04 §8).

**Independent Test**: compute assignments for many unit ids and compare with reference vectors and distribution checks.

**Acceptance Scenarios**:

1. **AS-17** — **Given** a running experiment, **When** the same unit asks 1,000 times, from any instance, before and after a restart, **Then** the variant is always the same; and for the published reference vectors (unit → layer bucket, variant bucket, variant) the result equals the table.
2. **AS-18** — **Given** 100,000 distinct unit ids and experiments weighted 5,000/5,000, 9,000/1,000 and 3,400/3,300/3,300 with a layer range of 0–10,000, **When** each unit is assigned, **Then** the observed split passes the SRM test (`p ≥ 0.001`) for each, and the boundary buckets 0 and 9,999 land in the first and last variant respectively.
3. **AS-19** — **Given** two running experiments in different layers, **When** 100,000 units are assigned to both, **Then** the joint distribution of variants is independent (chi-square test of independence `p ≥ 0.001`); **Given** two running experiments in one layer with ranges 0–5,000 and 5,000–10,000, **Then** no unit is in both and a unit with layer bucket 4,999 is in the first and 5,000 in the second (`layerTo` is exclusive).
4. **AS-20** — **Given** one running experiment with unit `user` and one with unit `visitor`, **When** `GET /api/experiments/assignments` is called (a) signed in with `X-Anonymous-Id: anon-12345678`, (b) anonymously with that header, (c) anonymously without it, (d) anonymously with the id `short`, **Then** (a) returns both, the user experiment assigned by the user id and the visitor experiment by the header id; (b) returns only the visitor experiment; (c) and (d) return `{assignments: {}, degraded: false}`. A signed-in caller can never read another user's assignment: the principal, not a header, selects the user unit.
5. **AS-21** — **Given** experiments in `DRAFT` and `STOPPED` status, **When** assignments are requested, **Then** they are absent.
6. **AS-22** — **Given** a running experiment, **When** assignments are requested, **Then** `200` with `{assignments: {"<key>": {variant}}, degraded: false}` (parses with `assignmentsResponseSchema`), `Cache-Control: private, no-store`, `Vary: Authorization, X-Anonymous-Id`; the 121st request in a minute from one caller is `429 rate_limited`.
7. **AS-23** — **Given** the shared cache is down, **When** assignments are requested, **Then** the running set is read from the database and the answer is normal; **Given** the cache and the database are both down (database call times out after 500 ms), **Then** `200 {assignments: {}, degraded: true}` (everyone sees control), and `experiment_assignments_total{outcome="degraded"}` rises.
8. **AS-24** — **Given** a running experiment cached by two instances, **When** an admin stops it, **Then** the instance that handled the stop stops assigning immediately and the other within 15 seconds, and no instance assigns it after that.

---

### User Story 4 — Exposure is logged when the variant is actually seen (Priority: P1)

A client logs an `exposure` when it renders a variant, not when it fetches the assignment. An experiment's analysis counts a unit from its first valid exposure. Flags use the same event with a different shape.

**Why this priority**: logging at assignment dilutes the effect and biases results (10/02 Ex2).

**Independent Test**: send exposure events, then read results.

**Acceptance Scenarios**:

1. **AS-25** — **Given** an experiment `free-shipping` with variants `control` and `free`, **When** an `exposure` event with `props {experiment: "free-shipping", variant: "free"}` is ingested, **Then** it is stored like any event and the unit counts toward `free` in the results (AS-42).
2. **AS-26** — **Given** exposure events, **When** they are posted, **Then** valid shapes are exactly one of `props {experiment, variant}` or `props {flag_key, variant, flag_version}` (all strings, `variant` 1–32 characters); anything else (missing `variant`, both `experiment` and `flag_key`, neither, a flag exposure without `flag_version`) is rejected `invalid_exposure`. A flag exposure is stored but never appears in any experiment's results.
3. **AS-27** — **Given** a unit with ten exposure events for `control` over an hour, **When** results are computed, **Then** that unit counts once for `control`, at the time of its first exposure.
4. **AS-28** — **Given** a unit exposed to `control` and later to `free`, **When** results are computed, **Then** the unit is a crossover: excluded from every variant and counted in `excluded.crossoverUnits`; **When** crossover units exceed 1% of exposed units, **Then** `trustworthy` is `false` with problem `crossover_exceeds_threshold`.
5. **AS-29** — **Given** exposures naming a variant that the experiment does not define, or whose event time is before `startedAt` or after `stoppedAt`, **When** results are computed, **Then** they are excluded (variant-unknown ones are counted in `excluded.unknownVariant`; out-of-window ones are not counted anywhere) and the other exposures are unaffected; an exposure naming an experiment key that does not exist is accepted at ingest and ignored by every readout.

---

### User Story 5 — Admins define, start and stop experiments without breaking the analysis (Priority: P1)

A platform admin drafts an experiment, starts it, and stops it. Definitions that would corrupt the analysis cannot be saved; a running experiment's variants, weights, layer range, unit and metric cannot change; a stopped experiment cannot be restarted. Two admins never overwrite each other.

**Why this priority**: changing weights or restarting mid-run is the classic way to invalidate an A/B test.

**Independent Test**: call the admin endpoints in sequence and in parallel; inspect rows and history.

**Acceptance Scenarios**:

1. **AS-30** — **Given** no experiment `pdp-layout` and an admin, **When** they `PUT /api/admin/experiments/pdp-layout` with `expectedVersion: 0`, `owner: "growth"`, `unit: "visitor"`, variants `control` 5,000 and `gallery` 5,000, `layer: "pdp"`, `layerFrom: 0`, `layerTo: 5000`, `metric: "add_to_cart"`, **Then** `201` with `Location: /api/admin/experiments/pdp-layout` and an `experimentSchema` body with `status: "draft"`, `version: 1`, `startedAt: null`; one history row `create` with the admin as actor.
2. **AS-31** — **Given** the draft at version 1, **When** an admin saves a changed definition with `expectedVersion: 1`, **Then** `200` and `version: 2` with a history row `update` holding before and after; **When** another admin saves with the stale `expectedVersion: 1`, **Then** `409 version_conflict`; **When** a save equals the stored definition, **Then** `200` with no version bump and no history row; **When** two admins save different definitions with the same `expectedVersion` in parallel, **Then** exactly one succeeds and the other gets `409 version_conflict`.
3. **AS-32** — **Given** invalid bodies, **When** each is sent, **Then** shape errors (wrong types, key not matching `^[a-z0-9][a-z0-9-]{1,63}$`, unknown fields) are `400 validation_failed`; and semantic errors are `422 experiment_definition_invalid` with `errors: [{path, code}]` listing all problems at once, using these codes: `variants_count` (fewer than 2 or more than 10), `variant_key_invalid`, `variant_key_duplicate`, `weight_invalid` (not an integer ≥ 1), `weights_sum` (not 10,000), `layer_range_invalid` (not `0 ≤ layerFrom < layerTo ≤ 10,000`), `layer_invalid`, `metric_unknown` (outside `page_view, product_view, search, add_to_cart, checkout_step, click, video_view, purchase`), `metric_unit_mismatch` (`purchase` with unit `visitor`, because purchases carry no anonymous id), `owner_required`.
4. **AS-33** — **Given** the draft, **When** an admin calls `POST /api/admin/experiments/pdp-layout/start`, **Then** `200`, `status: "running"`, `startedAt` = the (frozen) time, `version` +1, history row `start`; **When** it is called again, **Then** `200` with the same body, no new history row, `startedAt` unchanged (idempotent); **When** called in parallel by two admins, **Then** both get `200` and exactly one history row exists.
5. **AS-34** — **Given** a running experiment, **When** an admin calls `POST …/stop`, **Then** `200`, `status: "stopped"`, `stoppedAt` set, history row `stop`; **When** stop is repeated, **Then** `200`, nothing changes; **When** `start` is called on the stopped experiment, **Then** `409 illegal_transition`; **When** `stop` is called on a `draft`, **Then** `409 illegal_transition`.
6. **AS-35** — **Given** a running or stopped experiment, **When** a save changes variants, weights, layer, range, unit or metric, **Then** `409 experiment_immutable` and nothing changes; **When** a save changes only `description` or `owner`, **Then** `200`, version +1, history row `update`.
7. **AS-36** — **Given** running `pdp-layout` in layer `pdp` with range 0–5,000, **When** a draft in layer `pdp` with range 4,000–6,000 is started, **Then** `409 layer_range_conflict` naming the blocking key; **When** the draft has range 5,000–10,000, or another layer, **Then** the start succeeds; **When** the blocker is stopped, **Then** the overlapping draft can start; **When** two overlapping drafts are started in parallel, **Then** exactly one `200` and one `409 layer_range_conflict`, and the database never holds two overlapping running ranges.
8. **AS-37** — **Given** 200 experiments exist, **When** a new key is created, **Then** `422 experiment_limit_reached`; an update of an existing key still works.
9. **AS-38** — **Given** 120 experiments, **When** `GET /api/admin/experiments?limit=50` is called repeatedly with `nextCursor`, **Then** pages are `{items, nextCursor}` ordered by `createdAt` descending then `key` descending, every experiment appears once, `limit` outside 1–200 or a tampered cursor is `400 validation_failed`, `?status=running` filters; `GET …/:key` returns one, an unknown key is `404 not_found`.
10. **AS-39** — **Given** an experiment with several changes, **When** `GET /api/admin/experiments/:key/history` is read, **Then** items `{id, action, actorId, before, after, requestId, at}` newest first with keyset paging, every applied change has exactly one row, a no-op has none, rows cannot be updated or deleted through the API, and `actorId` is never null.
11. **AS-40** — **Given** each admin endpoint, **When** called without credentials, **Then** `401`; **When** called by a signed-in buyer or a shop owner who is not an admin, **Then** `403 forbidden` with the same body whether or not the key exists (no existence leak).
12. **AS-41** — **Given** 30 admin writes in a minute by one admin, **When** the 31st is sent, **Then** `429 rate_limited`; reads and other admins are unaffected.

---

### User Story 6 — Results an analyst can trust (Priority: P1)

For one experiment, the admin reads each variant's exposed units, converted units and conversion rate, plus the comparison with control (difference, lift, confidence interval, p-value). The same page says whether the data can be trusted: a sample ratio mismatch, too many crossover units, or too little data withholds the comparison instead of showing a misleading winner.

**Why this priority**: the readout is the product of the whole capability; a wrong "winner" is worse than none.

**Independent Test**: seed events with known counts and read the results.

**Acceptance Scenarios**:

1. **AS-42** — **Given** experiment `free-shipping` (unit `user`, metric `purchase`, `control`/`free` 5,000 each, started `S`), exposures of 10,000 distinct signed-in users per variant after `S` and purchases after exposure from 1,000 control users and 1,200 `free` users, **When** an admin reads `GET /api/admin/experiments/free-shipping/results`, **Then** `200` (parses with `experimentResultsSchema`, `Cache-Control: no-store`) with `trustworthy: true`, `variants[0] = {variant: "control", exposures: 10000, conversions: 1000, conversionRate: 0.1, comparison: "control"}` and for `free`: `exposures: 10000`, `conversions: 1200`, `conversionRate: 0.12`, `absoluteDifference` 0.02, `relativeLift` 0.2, `zScore` and `pValue` below 0.001 as in the pooled two-proportion test, `confidenceInterval95` containing 0.02, `significant: true`, `comparison: "available"`; `srm.mismatch: false`; `analysis: "fixed_horizon"`; `windowStart`, `windowEnd`, `asOf` present.
2. **AS-43** — **Given** purchases by exposed users before their first exposure, after `stoppedAt`, and two purchases by one user after exposure, **When** results are read, **Then** only one conversion per unit counts, only if its event time is at or after the unit's first exposure and not after `stoppedAt` (or the read time for a running experiment).
3. **AS-44** — **Given** exposure and purchase rows duplicated across unmerged storage parts, **When** results are read, **Then** the numbers equal those of the de-duplicated data (AS-12).
4. **AS-45** — **Given** exposures 6,000 `control` / 4,000 `free` on a 5,000/5,000 experiment, **When** results are read, **Then** `srm.mismatch: true`, `trustworthy: false`, `problems` contains `srm_mismatch`, and every non-control variant has `comparison: "withheld_untrustworthy"` with no `vsControl` numbers; **Given** 5,030 / 4,970, **Then** `srm.mismatch: false`; **Given** a 3,400/3,300/3,300 experiment with observed 3,400/3,300/3,300, **Then** `chiSquare` is 0 and `pValue` is 1.
5. **AS-46** — **Given** an arm with fewer than 100 exposed units, **When** results are read, **Then** non-control variants have `comparison: "insufficient_sample"` and no `vsControl` numbers, while exposures, conversions and rates are still shown.
6. **AS-47** — **Given** an experiment with three variants, **When** results are read, **Then** each non-control variant's `significant` is decided at `alpha = 0.05 / 2 = 0.025` (Bonferroni) and the response carries `alpha: 0.025`.
7. **AS-48** — **Given** a control with zero conversions, or two arms with zero conversions, **When** results are read, **Then** no field is `NaN` or infinite: `relativeLift` is `null` when the control rate is 0, and equal zero rates give `zScore: 0`, `pValue: 1`.
8. **AS-49** — **Given** a unit-`user` experiment and a unit-`visitor` experiment, **When** results are read, **Then** the first counts only events with a non-empty `user_id` (the rest counted in `excluded.unattributable`) and the second keys every event by `anonymous_id`, including those of signed-in users.
9. **AS-50** — **Given** an experiment in `draft`, or a running one without exposures, **When** results are read, **Then** `200` with `status`, zero counts, `comparison: "no_data"`, `srm: {chiSquare: 0, pValue: 1, mismatch: false}`; an unknown key is `404 not_found`; without credentials `401`; as a non-admin `403` (AS-40).
10. **AS-51** — **Given** the analytical store is unreachable or the query exceeds 10 seconds, **When** results are read, **Then** `503 analytics_store_unavailable` problem+json with `Retry-After`, no partial numbers, and `analytics_store_errors_total{operation="results"}` rises.
11. **AS-52** — **Given** an event with event time inside the window that arrives after the experiment was stopped, **When** results are read again, **Then** it is included; an event with event time after `stoppedAt` is not.
12. **AS-53** — **Given** 20 reads of results in a minute by one admin, **When** the 21st is sent, **Then** `429 rate_limited`.

---

### User Story 7 — On-call engineers can see the pipeline's health (Priority: P2)

Operators can answer "are events flowing, how many are rejected and why, is the stream failing, are experiments trustworthy" from metrics and logs, without reading event contents.

**Why this priority**: "measured and bounded" loss and duplication needs counters.

**Independent Test**: run scenarios and read metric values and log lines.

**Acceptance Scenarios**:

1. **AS-54** — **Given** traffic from AS-01 – AS-11, **When** metrics are read, **Then** `analytics_events_total{outcome,reason}` (outcomes `accepted`, `rejected`, `duplicate_in_batch`; reasons are the codes above), `analytics_ingest_requests_total{status}`, `analytics_produce_failures_total`, `analytics_rate_limited_total`, `analytics_dead_letter_total{source}`, `experiment_assignments_total{outcome}` (`assigned`, `none`, `degraded`), `experiment_results_total{trustworthy}`, `experiment_srm_mismatch_total` and `analytics_store_errors_total{operation}` match the counts of what the scenarios did.
2. **AS-55** — **Given** any ingest, assignment or admin request, **When** logs are inspected, **Then** each line is JSON with `requestId`, and no line contains event `props` values, `user_id`, the access token, or the full anonymous id (at most its first 4 characters).
3. **AS-56** — **Given** the capability's code and migrations, **When** the static gates run, **Then** `check:table-ownership --strict` reports zero findings for `experimentation`, every new table is in the ownership registry as `domain:experimentation`, `check:boundaries` passes, and the only other domains this capability reaches are `identity` (principal and role) and `orders` (the `order.paid` event contract).
4. **AS-57** — **Given** a signed-in buyer on a product page with a running visitor experiment, **When** the page renders variant `gallery`, **Then** exactly one `exposure` event for that experiment reaches ingestion even if the component re-renders (UI journey owned by W02).

### Edge Cases

- A client retries a whole batch after a timeout: replay is safe (AS-08, AS-12); the 202 never promises the event is already queryable.
- A batch where every event is invalid: still `202` with `accepted: 0`; the client must not retry rejected events.
- A phone offline for a month: events older than 7 days are rejected, not back-dated (AS-05).
- A visitor signs in mid-experiment: a `visitor` experiment keeps its variant because the unit does not change; a `user` experiment starts assigning once signed in and its earlier anonymous exposures are not counted (AS-20, AS-49).
- Hash collision between a flag and an experiment with the same name: salts are namespaced (FR-024) so they do not correlate.
- An admin widens a running experiment's layer range: refused (`experiment_immutable`), because it would move users between variants.
- A result read while the stream lags: the numbers are as of `asOf` and may be missing the newest events; they are never double-counted.
- Cross-tenant: events and experiments are platform-owned, not tenant-owned. No endpoint returns raw events; admin endpoints are admin-only and answer identically for existing and unknown keys (AS-40); the assignment endpoint only ever computes for the caller's own principal and the visitor id the caller supplies.

## Requirements *(mandatory)*

### Functional Requirements

**Event contract and ingestion**

- **FR-001**: The client event is `{event_id, name, anonymous_id, ts, page?, props?}`. `event_id` is a UUID generated by the client. `name` is one of the closed set `page_view`, `product_view`, `search`, `add_to_cart`, `checkout_step`, `exposure`, `click`, `video_view`. `anonymous_id` is 8–64 characters from `[A-Za-z0-9_-]`. `ts` is an integer of epoch milliseconds. `page` is at most 500 characters. `props` is a flat map of at most 30 entries: keys 1–64 characters from `[A-Za-z0-9_.-]`; values string (≤ 500), number or boolean. Unknown top-level fields are rejected with `forbidden_field` when they are `user_id`, `received_at`, `country` or `platform`, and ignored otherwise. (AS-02, AS-03)
- **FR-002**: Server-only names exist: `purchase`. A client event with a server-only name is rejected `unknown_event_name`. Adding a name is additive and is made in one place that both collectors share. (AS-03)
- **FR-003**: The stored event is `{event_id, name, anonymous_id, user_id, ts, received_at, country, platform, page, props}` with `ts` and `received_at` as `YYYY-MM-DD HH:mm:ss.SSS` UTC and `props` values all strings (numbers in canonical decimal, booleans as `true`/`false`). It is published on topic `analytics.events` keyed by `anonymous_id`. A schema for it is published as `storedAnalyticsEventSchema`. Server-originated events carry `anonymous_id: ""`. (AS-01, AS-15)
- **FR-004**: `user_id` is set only from a verified access token. A body field, a header such as `X-User-Id`, or an unverifiable token never sets it. `country` is recorded only when the edge credential is present; `platform` is one of `web`, `ios`, `android` (default `web`) for client events and `server` for server events only. No IP address or user agent is stored. (AS-02, AS-11)
- **FR-005**: Clock rules: an event older than 7 days (`ts < receive time − 7 days`) is rejected `event_too_old`; an event more than 10 minutes in the future (`ts > receive time + 10 minutes`) is stored with `ts` equal to the receive time; any other `ts` is kept as the event time. (AS-05)
- **FR-006**: A request carries 1–50 events and at most 128 KiB, as `application/json` or `text/plain` (the same JSON). Each event is validated on its own: valid events are accepted, invalid ones are reported by index and code, and the request is `202` whenever the envelope is valid, even with zero accepted. Duplicate `event_id`s inside one request are collapsed (first wins) and the rest reported `duplicate_in_batch`. (AS-03, AS-04, AS-06, AS-07)
- **FR-007**: The fallback endpoint answers only after the stream acknowledged all accepted events, within 2 seconds. If it cannot, the whole request fails `503 ingest_unavailable` with `Retry-After` and reports nothing as accepted. The edge answers `202` before acknowledgement, retries failed produces up to 3 times with exponential backoff and jitter, and counts every finally failed event. (AS-08, AS-10)
- **FR-008**: Ingestion is public (anonymous allowed) and rate limited: 120 requests per minute per user or IP at the fallback and the same at the edge, failing open if the limiter is unavailable. Over the limit: `429 rate_limited` with `Retry-After`. (AS-09)
- **FR-009**: The edge collector and the fallback apply identical validation, clamping and enrichment from one shared definition and one shared table of test vectors. (AS-10)

**Store, dedupe, ordering**

- **FR-010**: Delivery is at-least-once. The store treats `event_id` as the identity of an event across all names, days and receive times: every read counts an event once, reads are correct before the store has merged duplicate parts, and the first received copy is the one read. (AS-12, AS-44)
- **FR-011**: Events are stored and ordered by event time (`ts`); late events fall into their own event day. Every analysis uses event time, never arrival order. (AS-13, AS-52)
- **FR-012**: Messages the store cannot parse go to a dead-letter table with raw payload, error, topic, partition, offset and time, never block the stream, and are counted. Retention: events 400 days, dead letters 14 days. (AS-14, AS-16)
- **FR-013**: A `purchase` event is derived from every `order.paid` event by a projector (IX.7 R3): `event_id` is the envelope id, `ts` is `occurredAt`, `user_id` from the payload, `props {order_id, total (integer minor units as a string), currency (default "usd")}`. Redelivery has no additional effect; an invalid payload is dead-lettered with no write. Refunds and cancellations do not reverse a purchase in this capability. (AS-15)

**Experiments**

- **FR-020**: An experiment has an immutable `key` matching `^[a-z0-9][a-z0-9-]{1,63}$`, `description` (≤ 500, may be empty), `owner` (1–100, required), `unit` (`user` or `visitor`, default `user`), `variants` (2–10; each a `key` matching `^[a-z0-9][a-z0-9_-]{0,31}$` and an integer `weight` ≥ 1 in basis points; weights sum to 10,000; the first variant is the control), `layer` (`^[a-z0-9][a-z0-9-]{1,31}$`), `layerFrom` and `layerTo` (`0 ≤ layerFrom < layerTo ≤ 10,000`, `layerTo` exclusive), `metric` (one of `page_view`, `product_view`, `search`, `add_to_cart`, `checkout_step`, `click`, `video_view`, `purchase`), `status`, `version`, `startedAt`, `stoppedAt`, `startedBy`, `stoppedBy`, `createdAt`, `updatedAt`. At most 200 experiments exist. (AS-30, AS-32, AS-37)
- **FR-021**: `unit: "visitor"` requires a metric other than `purchase`. `unit: "user"` experiments assign and analyse only signed-in users. (AS-32, AS-49)
- **FR-022**: Lifecycle `draft → running → stopped`, one direction only. Start and stop are idempotent and are conditional updates asserting one affected row, each with one history row in the same transaction; a repeat changes nothing and writes nothing. Any other transition is `409 illegal_transition`. A stopped experiment is never restarted; a new experiment is created instead. (AS-33, AS-34)
- **FR-023**: Saves require `expectedVersion` (0 creates). A stale version is `409 version_conflict`; an equal definition is a no-op `200`. Once running or stopped, only `description` and `owner` may change; any other change is `409 experiment_immutable`. (AS-31, AS-35)
- **FR-024**: Assignment is `layerBucket = bucketOf("layer:" + layer, unit)` and `variantBucket = bucketOf("exp:" + key, unit)`, both from S38's single `bucketOf(salt, unit)` (murmur3, `% 10,000`). A unit is in the experiment when `layerFrom ≤ layerBucket < layerTo`; the variant is taken by cumulative integer weight over `variantBucket`. No floating-point arithmetic is used. (AS-17 – AS-19)
- **FR-025**: Layers give mutual exclusion: the ranges of running experiments in one layer never overlap. The store enforces it, so two parallel starts cannot both succeed; a stopped experiment frees its range. (AS-36)
- **FR-026**: Admin writes (`PUT`, `start`, `stop`) are admin-only, rate limited to 30 per minute per admin, and each applied change appends one immutable history row `{id, experimentKey, action: create | update | start | stop, actorId (not null), before, after, requestId, at}`. A no-op appends none. (AS-39, AS-41)
- **FR-027**: List and history endpoints use keyset pagination with an opaque cursor and `limit` 1–200 (default 50). Errors are problem+json with a stable machine `code`. (AS-38, AS-39)

**Assignment and exposure**

- **FR-030**: `GET /api/experiments/assignments` is public, rate limited to 120 per minute per user or IP, and returns `{assignments: {<key>: {variant}}, degraded}` for running experiments only: `user` experiments for the authenticated principal, `visitor` experiments for a valid `X-Anonymous-Id` (8–64 characters of `[A-Za-z0-9_-]`; an invalid one is ignored). Responses are `Cache-Control: private, no-store` with `Vary: Authorization, X-Anonymous-Id`. (AS-20, AS-22)
- **FR-031**: The running set is read from memory or cache refreshed on change; a write invalidates it at once, and every instance reflects a start or stop within 15 seconds. If cache and database are both unreachable, the answer is `200` with no assignments and `degraded: true`: everyone sees control. Computing assignments for 100 running experiments takes under 5 ms at the 99th percentile. (AS-23, AS-24)
- **FR-032**: Exposure shape is exactly one of `props {experiment, variant}` or `props {flag_key, variant, flag_version}`, all strings, `variant` 1–32 characters. Server-rendered variants are logged by calling the same ingestion with the visitor's own identity; there is no separate privileged path. (AS-26)

**Results**

- **FR-040**: `GET /api/admin/experiments/:key/results` computes, from de-duplicated events by event time: per unit (the experiment's unit), the first exposure within `[startedAt, stoppedAt or now]` fixes the unit's variant; a unit exposed to several variants is a crossover and is excluded; a unit converts once if an event of the metric has event time at or after its first exposure and not after the window end. (AS-27 – AS-29, AS-43, AS-52)
- **FR-041**: Per variant: `exposures` (units), `conversions` (units), `conversionRate`. Per non-control variant against control: `absoluteDifference`, `relativeLift` (`null` when the control rate is 0), `zScore` and `pValue` from the pooled two-proportion z-test, `confidenceInterval95` of the absolute difference (unpooled), `significant` at `alpha = 0.05 / (variants − 1)`. All finite; equal zero rates give `zScore: 0`, `pValue: 1`. (AS-42, AS-47, AS-48)
- **FR-042**: SRM: a chi-square goodness-of-fit test of observed exposed units against the configured weights, `degrees of freedom = variants − 1`. `mismatch` is true when there is at least one exposure and `p < 0.001`. (AS-45)
- **FR-043**: `trustworthy` is false, with `problems` naming why, when SRM mismatches (`srm_mismatch`) or when crossover units exceed 1% of exposed units (`crossover_exceeds_threshold`). When untrustworthy, non-control variants carry `comparison: "withheld_untrustworthy"` and no comparison numbers. When any arm has fewer than 100 exposed units, comparisons are `insufficient_sample` and withheld. With no exposures, `comparison: "no_data"`. (AS-28, AS-45, AS-46, AS-50)
- **FR-044**: The response states `analysis: "fixed_horizon"`, `windowStart`, `windowEnd`, `asOf`, `alpha`, `excluded {unattributable, unknownVariant, crossoverUnits}`, and the experiment's `version`. New events appear in results within 60 seconds of acknowledgement at nominal stream lag. (AS-42)
- **FR-045**: If the analytical store fails or exceeds 10 seconds: `503 analytics_store_unavailable` with `Retry-After`; never partial numbers. Results reads are admin-only and rate limited to 20 per minute per admin. (AS-51, AS-53)

**Operating**

- **FR-050**: All routes sit behind the global validation, problem+json and request-context pipeline; every table or store this capability uses (experiments and history in the primary database, events in the analytical store) belongs to `experimentation` alone. No other domain reads them; other domains receive data only through R1, R2 or R3 (Cross-capability contracts). (AS-56)
- **FR-051**: Metrics of AS-54 exist with those names and labels. Logs never contain event `props` values, user ids, tokens or full anonymous ids. (AS-54, AS-55)
- **FR-052**: Every response body of the endpoints above parses with its `packages/contracts` schema: `ingestRequestSchema`, `ingestResultSchema`, `storedAnalyticsEventSchema`, `assignmentsResponseSchema`, `experimentWriteSchema`, `experimentSchema`, `experimentPageSchema`, `experimentHistoryPageSchema`, `experimentResultsSchema`. (all)

### Key Entities

- **Client event**: what a browser or app sends. **Stored event**: the enriched row (FR-003); identity is `event_id`.
- **Experiment**: definition and lifecycle of one test (FR-020). **Layer**: a named hash space of 10,000 buckets shared by mutually exclusive experiments. **Experiment history row**: one immutable record per applied change.
- **Assignment**: the variant a unit gets, never stored; recomputed from the hash.
- **Exposure**: an `exposure` event naming an experiment (or a flag) and a variant.
- **Unit**: the identifier an experiment counts: a user id (`user`) or an anonymous id (`visitor`).
- **Results readout**: per-variant counts, comparison with control, SRM verdict, trust verdict, exclusions.
- **Dead-letter row**: a stream message the store could not parse.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A 50-event batch is acknowledged at the fallback in under 200 ms at the 99th percentile and at the edge in under 50 ms; a load run at 2,000 events/s sustained through the fallback shows zero lost accepted events and stream consumer lag under 10 s (operations artifact, k6).
- **SC-002**: Replaying 100% of a 10,000-event set (including a re-clamped `ts` and different receive times) leaves every count and every results number unchanged.
- **SC-003**: Over 100,000 units, 100% of correctly weighted experiments pass the SRM test at `p ≥ 0.001`, and 100% of a 60/40-on-50/50 data set is flagged; no two same-layer running experiments share a unit.
- **SC-004**: Assignment computation for 100 running experiments takes under 5 ms at the 99th percentile; the same unit gets the same variant in 100% of 1,000 repeated calls across restarts.
- **SC-005**: After an admin stops an experiment, no instance assigns it more than 15 seconds later.
- **SC-006**: Results for an experiment with 1,000,000 exposed units are returned in under 3 seconds at the 95th percentile.
- **SC-007**: Every acceptance scenario has exactly one row in `test-plan.md`; the VII.2/VII.3 cases exist for each endpoint; `check:table-ownership --strict` and `check:boundaries` pass for `experimentation`.

## Assumptions

- Analytics events are platform data, not tenant data; no shop-level analytics are exposed by this capability. Seller-visible analytics are a different capability.
- Property values are the emitters' responsibility: they must not put personal data (emails, names) into `props`. The collector cannot detect it.
- Fixed-horizon analysis: the p-value is valid only when read once at the planned sample size; repeated peeking inflates false positives. Sequential methods are out of scope.
- Conversion is binary per unit within one run; revenue per user and multiple metrics are out of scope.
- The experiment set is small (≤ 200) so assignment evaluates all running experiments per request.
- Anonymous ids come from a first-party cookie issued by the web app (W02/W03/W07); an anonymous id is not a secret and assignment from it discloses nothing.
- Orders that are later cancelled or refunded still count as conversions (`order.paid` happened); reversing them is out of scope.
- The analytical store is ClickHouse (events, dead letters) and the primary database holds experiments and history; the consumer of the stream into the store is the store's own stream engine.
- Existing experiments and events stay readable; the migration to `unit`, integer weights and `owner` backfills `unit: "user"`, rescales weights to 10,000 and sets `owner` to `unknown` until an admin edits it.

## Cross-capability contracts

**Provides**

- HTTP `POST /api/events` (fallback) and edge `POST /collect`: request `{events: ClientEvent[1..50]}`, response `202 {accepted: number, rejected: [{index: number, code: string}]}`. Names: `page_view | product_view | search | add_to_cart | checkout_step | exposure | click | video_view`. Consumers: **W02**, **W03** (web emitters), **S30** (`video_view` with `props.video_id`), **S35** (via the stream).
- Event stream topic `analytics.events` (constant `ANALYTICS_TOPIC`, exported through `@app/domains/experimentation` as an event contract), key `anonymous_id`, value = stored event of FR-003, schema `storedAnalyticsEventSchema` in `packages/contracts`. `product_view` and `add_to_cart` forward `props.product_id` (UUID) and `props.category` (catalog slug) unchanged. Guarantees: at-least-once, `ts` clamped/rejected per FR-005, same shape from edge and fallback. Consumer: **S35** (R3), idempotent by `event_id`.
- HTTP `GET /api/experiments/assignments`: request headers `Authorization?`, `X-Anonymous-Id?`; response `{assignments: {[experimentKey]: {variant: string}}, degraded: boolean}`. Consumers: **W02**, **W03** (render the variant, then log the exposure), reached through **S48** by R2 (the BFF forwards the session and `X-Anonymous-Id`, never caches the response in a shared cache).
- Exposure event shapes: `name: "exposure"`, `props {experiment, variant}` (experiments) or `props {flag_key, variant, flag_version}` (S38 flags), all strings.
- HTTP admin API `PUT /api/admin/experiments/:key`, `POST …/start`, `POST …/stop`, `GET /api/admin/experiments`, `GET …/:key`, `GET …/:key/history`, `GET …/:key/results` (shapes above). Consumer: future admin UI; **J05** reads results to prove a purchase after an exposure shows up.
- Purchase events in the store (`name: "purchase"`, `platform: "server"`) from `order.paid`; consumed only by this capability's results.
- Metrics of AS-54.

**Requires**

- **S38** (`experimentation`): `bucketOf(salt: string, unit: string): number` in `[0, 10000)`, exported from the domain, the single assignment hash (S38 FR-024). Differs from S38's note only in that the salt is `"exp:" + key` and `"layer:" + layer` rather than the bare key (see `questions.md`, `[CONTRACT]`). The edge-credential check S38 defines (FR-044) for trusting `CF-IPCountry`.
- **S01** (`identity`): `Firewall({anonymous: true})` and `Firewall({roles: [Role.ADMIN]})` route policies; `request.user.id` set only from a verified token; invalid or expired tokens on an anonymous-allowed route leave the request anonymous. Roles `ADMIN`, buyer, shop owner.
- **S53** (`infrastructure`): the projector host, event envelope `{eventId, type, version, occurredAt, aggregateId, payload}`, the `OrderPaid` event contract (`order.paid` v1 `{userId, total: integer minor units, currency?: string, paymentId, lines}`) exported by `@app/domains/orders` (event contract, IX.7 R3), versioned replayable projections and a dead-letter queue for payloads that fail the schema.
- **S10** (`orders`): emits `order.paid` v1 as above through the outbox.
- **S50** (`infrastructure`): rate-limit policies named `analytics.ingest` (120/min, `userOrIp`, fail open), `experiments.assignments` (120/min, `userOrIp`, fail open), `experiments.admin.write` (30/min, `user`, fail closed), `experiments.results` (20/min, `user`, fail closed), with `Retry-After` headers.
- **S54** (`infrastructure`): the problem+json filter carrying a machine `code` extension, request context with `requestId`, metrics registry and logging.
- **S52** (`infrastructure`): a shared cache with invalidation for the running-experiment set.
- **W02** / **W03** (web): generate the anonymous id (first-party cookie, 8–64 characters of `[A-Za-z0-9_-]`), batch events in memory (flush every 5 s, at 20 events, or on `visibilitychange` through `sendBeacon`), generate `event_id` once per event and reuse it on retry, emit `product_view` and `add_to_cart` with `props.product_id` and `props.category`, and log one `exposure` when a variant is rendered.
- **S30** (`media`): emits `video_view` with `props.video_id` from player beacons.
