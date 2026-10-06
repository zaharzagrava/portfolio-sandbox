# Test Plan: S51 — Realtime push hub (domain `infrastructure`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (70 scenarios, AS-01 to AS-70). A dash means the layer does not test that scenario. Each scenario is proven once, at the lowest layer that can prove it. Where a row names two layers, the e2e proves the HTTP outcome and the unit proves the pure table behind it (named in the cell); no assertion is repeated across layers.

## Conventions

- **API e2e** files live in `packages/backend/libs/infrastructure/realtime/` (the engine moves there; see `gaps.md` G-01). Each boots a Nest app from the real `RealtimeModule` and stream module with the production global pipe, filter, prefix, interceptors and the S50 interceptor, plus a small **test topics module** (test code only, no domain imports) that defines the routes the specs need: `auction` (public), `stream` (public), `user` (self only), `shop`+`live` (members, backed by a test fixture table seeded through the shared fixture helpers), `shop`+`assets`, `order-export` (async, 300 ms rule), `chat`, `flags` (singleton), and gated routes whose rule a test can hold open, make throw, or make hang. They run against the real test Redis of `docker-compose.test.yaml` and assert the stream frames **and** the stored state (replay buffer entries and their remaining lifetime, backplane subscriber counts, the metrics registry) in every test. The system-edge fake is token verification (identity), plus a frozen application clock; heartbeat, lifetime, stall, drain, retention and buffer bounds are set to milliseconds through configuration. No fixed sleeps: tests wait with a polling helper (deadline 5 s).
- **SSE reader**: the shared `readSse` helper (`test/utils/sse-client.ts`) is extended to expose comment frames, `retry:` and raw frames (`gaps.md` G-30).
- **Two instances** (AS-37, AS-40, AS-54, AS-60): two Nest apps in one test process on the same Redis, each with its own hub.
- **Backplane fault** cases (AS-38, AS-66 to AS-68) kill the hub's subscriber connection through the server's client-kill command; **store outage** (AS-32) stops the publishing client's connection; **slow reader** (AS-44, AS-45) is a raw socket that never reads. These break the real connection; no mock of the project's own code.
- **VII.3 mandatory cases**: happy path (AS-01, AS-08), each validation class (AS-04), `401` (AS-21, AS-28), cross-user `403` (AS-21, AS-23, AS-24), rate limit `429` (AS-47, AS-49), concurrency with `Promise.all` (AS-09, AS-30, AS-37, AS-56). No state-transition endpoint and no idempotency-key endpoint exist; the stream is a `GET` that changes no state. No async consumer lives in this lib (the revocation consumer is the owning domain's), so the VII.4 pair does not apply here.
- **Unit** specs sit beside the code, are table-driven (`it.each`), and cover only pure logic with time as an argument: topic grammar and route resolution, cursor encode/decode, frame formatting, publish validation, retry jitter, retention cutoff, resync decision, registry definition validation and freezing. No unit tests for the hub, controller, publisher service or glue. The type-level check (AS-34) is a compile-time test.
- **UI journeys**: none. S51 has no screen. The web hook's happy paths (a notification arrives, an import progress bar moves, a chat message arrives) are journeys of W03, W04 and W05, which exercise this endpoint end to end; their edge cases stay here. Hence the UI column is a dash in every row.
- **Static gates** (VII.1): `tsc --noEmit` strict and ESLint for `packages/backend`, `packages/contracts`, `packages/web`; `pnpm --dir packages/backend check:boundaries`; `pnpm --dir packages/backend check:table-ownership --strict`.
- **Load proof** of SC-001, SC-005 and SC-007 (`pnpm loadtest:sse`, k6 with xk6-sse) is an operations artifact, not an e2e row.

e2e files:

| Short name | File |
|---|---|
| STREAM | `topic-stream.e2e-spec.ts` |
| AUTHZ | `topic-authorization.e2e-spec.ts` |
| REPLAY | `topic-replay.e2e-spec.ts` |
| PUB | `realtime-publisher.e2e-spec.ts` |
| FAN | `realtime-fanout.e2e-spec.ts` |
| SUB | `realtime-subscriber.e2e-spec.ts` |
| LIMIT | `realtime-limits.e2e-spec.ts` |
| LIFE | `realtime-lifecycle.e2e-spec.ts` |
| REV | `realtime-revocation.e2e-spec.ts` |
| REG | `realtime-registry.e2e-spec.ts` |
| REC | `realtime-recovery.e2e-spec.ts` |
| OBS | `realtime-observability.e2e-spec.ts` |

Unit files: `topics.spec.ts` (grammar, route resolution, cursor, retention, resync decision, jitter), `frame.spec.ts`, `publish-validation.spec.ts`, `topic-registry.spec.ts`, `realtime-topic-types.spec.ts` (compile-time).

## Table

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 live delivery, headers, no compression | STREAM | — | — |
| AS-02 two topics, combined cursor | STREAM | — | — |
| AS-03 topic isolation | STREAM | — | — |
| AS-04 validation classes (11 request shapes, credentials in URL) | STREAM (every HTTP class, zero subscribers asserted) | — | `topics.spec.ts` grammar table (`it.each` over the topic shapes) |
| AS-05 duplicate topics collapse | STREAM | — | — |
| AS-06 frame injection safety | STREAM (one hostile payload end to end) | — | `frame.spec.ts` (`it.each` over `\n\n`, `data:`, `id:`, `\r`, U+2028, 30 KiB) |
| AS-07 live-only events: no id, cursor untouched | REPLAY | — | — |
| AS-08 replay exactness (3..5 after #2, then live) | REPLAY | — | — |
| AS-09 handover while publishing (no gap, no duplicate) | REPLAY (`Promise.all` publisher during replay) | — | — |
| AS-10 replay longer than one page | REPLAY | — | — |
| AS-11 replay is repeatable | REPLAY | — | — |
| AS-12 per-topic cursors | REPLAY | — | — |
| AS-13 baseline frame on first connect | REPLAY | — | — |
| AS-14 reconnect from baseline gets missed events | REPLAY | — | — |
| AS-15 malformed or hostile `Last-Event-ID` | REPLAY (one request with a mixed bad header: `200`, counter) | — | `topics.spec.ts` cursor decode (`it.each` over the eight cases) |
| AS-16 replay gap → `resync` | REPLAY | — | `topics.spec.ts` resync decision (cursor vs oldest retained vs max trimmed) |
| AS-17 expired buffer, old cursor → `resync` | REPLAY (buffer key deleted, cursor with old time part) | — | `topics.spec.ts` resync decision with `now` and retention |
| AS-18 cursor at latest: nothing replayed | REPLAY | — | — |
| AS-19 stale or duplicate live message dropped | REPLAY (crafted message put on the backplane channel) | — | — |
| AS-20 retention: count bound, age bound, expiry, live-only unstored | PUB (publishes 2,500; checks length and remaining lifetime) | — | `topics.spec.ts` retention cutoff (`it.each` over now and age) |
| AS-21 owner-only topic: 200 / 403 / 401, no residue | AUTHZ | — | — |
| AS-22 public topic for anonymous | AUTHZ | — | — |
| AS-23 all-or-nothing admission | AUTHZ | — | — |
| AS-24 indistinguishable denial | AUTHZ (existing vs missing shop, compare bodies and headers) | — | — |
| AS-25 asynchronous rule with viewer | AUTHZ | — | — |
| AS-26 rule throws or times out → 503 | AUTHZ | — | — |
| AS-27 rule runs once per topic per connection | AUTHZ | — | — |
| AS-28 invalid credential → 401; cookie and bearer accepted | AUTHZ | — | — |
| AS-29 publish: result id equals frame cursor and replayed id | PUB | — | — |
| AS-30 200 concurrent publishers: distinct, ordered, complete | PUB (`Promise.all`, two processes) | — | — |
| AS-31 publish validation (topic, type, size, payload) | PUB (one rejected call per class: store untouched) | — | `publish-validation.spec.ts` (`it.each`, all invalid and valid names) |
| AS-32 store fault: `published: false`, one attempt, 1 s | PUB | — | — |
| AS-33 publish with no viewers | PUB | — | — |
| AS-34 compile-time topic types | — | — | `realtime-topic-types.spec.ts` (`@ts-expect-error`) |
| AS-35 one backplane subscription for 100 viewers | FAN | — | — |
| AS-36 leaving viewer does not disturb others | FAN | — | — |
| AS-37 50 concurrent first subscribers, one subscribe | FAN (`Promise.all`) | — | — |
| AS-38 failed subscribe leaves no residue; `503` | REC | — | — |
| AS-39 idempotent release | SUB | — | — |
| AS-40 two instances, third without viewers | FAN (two apps) | — | — |
| AS-41 throwing listener isolated | SUB | — | — |
| AS-42 500 cycles and 100 aborts: nothing leaks | FAN | — | — |
| AS-43 abort during replay | FAN | — | — |
| AS-44 slow consumer dropped at the byte bound | LIMIT | — | — |
| AS-45 stalled writer dropped | LIMIT | — | — |
| AS-46 replay-phase buffer overflow, replay continues | LIMIT | — | — |
| AS-47 per-user and per-address connection caps | LIMIT | — | — |
| AS-48 instance capacity `503` | LIMIT | — | — |
| AS-49 `realtime.connect` rate limit; fail open | LIMIT (real S50 module; limiter store stopped for the fail-open case) | — | — |
| AS-50 heartbeat comments; timer cleared | LIFE | — | — |
| AS-51 `retry:` jitter 2000–5000 | LIFE (200 connections, range and spread) | — | `topics.spec.ts` jitter bounds (`it.each` over the random source edges) |
| AS-52 lifetime and credential-expiry end, clean resume | LIFE | — | — |
| AS-53 graceful shutdown drain | LIFE | — | — |
| AS-54 revoke on another instance: `revoked`, rest continues | REV (two apps) | — | — |
| AS-55 revoking the last topic ends the connection | REV | — | — |
| AS-56 revoke during admission is not lost | REV (rule held open, `Promise.all`) | — | — |
| AS-57 revoke without user: all viewers | REV | — | — |
| AS-58 revoke is not a ban | REV | — | — |
| AS-59 in-process subscribe, shared subscription | SUB | — | — |
| AS-60 `topicsWithSubscribers`, sorted, route-exact | SUB (two apps) | — | — |
| AS-61 discovery cap and outage | SUB | — | — |
| AS-62 route model: hyphen prefix, suffix coexistence | REG | — | `topics.spec.ts` route resolution (`it.each` over the topic shapes and the route set) |
| AS-63 duplicate route fails the boot | REG | — | — |
| AS-64 singleton and invalid definitions | — | — | `topic-registry.spec.ts` (`it.each` over definitions: valid, upper-case, illegal suffix, 33-char prefix, missing rule, empty suffix list) |
| AS-65 registry frozen after start | — | — | `topic-registry.spec.ts` (state: define before and after freeze) |
| AS-66 backplane blip: gap-fill for open viewers | REC | — | — |
| AS-67 backplane down at connect | REC | — | — |
| AS-68 replay read fails midway | REC | — | — |
| AS-69 metrics | OBS | — | — |
| AS-70 logs | OBS | — | — |

Row accounting: every scenario AS-01 to AS-70 appears exactly once. AS-34, AS-64 and AS-65 are unit-only (pure or compile-time); AS-04, AS-06, AS-15 to AS-17, AS-20, AS-31, AS-51 and AS-62 split the HTTP outcome (e2e) from its pure table (unit); all others are e2e only.
