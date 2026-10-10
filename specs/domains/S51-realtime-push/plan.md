# Implementation Plan: S51 — Realtime push hub

**Branch**: `S51-realtime-push` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: spec.md, test-plan.md, gaps.md, questions.md (defaults accepted as written; no human-edited line found).

## Summary

Move the SSE engine out of `apps/sse-gateway` into `libs/infrastructure/realtime`, fix its correctness holes, and add the protections the spec requires: atomic validated best-effort publish (Lua script), route-keyed registry, ref-counted hub with race-free subscribe, paged replay with baseline/resync, caps/lifetime/stall/drain, fleet-wide `revoke` over a control channel, `TopicSubscriber`/`RealtimeSubscriptions`, metrics/logs, zod contracts, configuration. **Required follow-up from S03**: a tenancy projector consumes `tenancy.member_removed` and calls `revoke({ userId, prefix: 'shop', id: shopId })` so open `shop:<id>:*` streams close (item T-REV). Details of each decision: [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript strict, NestJS (Express), Node (repo version)
**Primary Dependencies**: `ioredis` (existing; Lua scripts, dedicated subscriber), zod, `@app/infrastructure/{lifecycle,events,projections}`, S50 `RateLimitModule`
**Storage**: shared Redis only, prefix `rt:` ([data-model.md](data-model.md)); no SQL
**Testing**: Jest e2e against the test Redis via `scripts/sdd/test-spec.sh`; table-driven unit specs for pure logic ([test-plan.md](test-plan.md), 12 e2e + 5 unit files)
**Target Platform**: Linux server, SSE gateway app
**Project Type**: backend infrastructure lib hosted by an existing app
**Performance Goals**: SC-001 (50k idle, 5k ev/s, p99 ≤ 500 ms) — ops proof
**Constraints**: 1 MiB pending/connection, 32 KiB payload, 1 s publish, 2 s rule, all configurable
**Scale/Scope**: 70 acceptance scenarios; ~15 existing publisher callers re-checked

## Constitution Check

| Rule | Status |
|---|---|
| I.1–I.3 layers | The lib is infrastructure: `RealtimeModule`/`RealtimeStreamModule`; stream controller is an `api`-like file inside the lib's `stream/`; pure logic (grammar, cursor, frame, resync, retention, jitter) is framework-free and takes `now` as an argument |
| I.4 one owner per key prefix | `rt:` owned by this lib; legacy `redis-pubsub` dirs deleted (G-03) once S13/S24 land |
| I.5 no logic in apps | Pass: engine moves to the lib (G-01); app keeps bootstrap + composition |
| I.6 new app | None needed |
| II.1 controller thin | Controller validates (DTO via contracts schema) and calls one application-level `StreamService`; no queries |
| III.3, III.9 | No DB transaction. Every `rt:s:` key has a TTL; no `KEYS` |
| IV.3 pub/sub only as fan-out backplane | Replay buffer = stream; revocation best effort + lifetime bound |
| IV.5 consumer idempotency | The tenancy revocation projector is naturally idempotent (revoking twice is a no-op); documented in the class |
| IV.6 timeouts | Publish 1 s, rule 2 s, discovery 1 s, command timeout on subscriber; one attempt |
| V.2 contracts | zod schemas in `packages/contracts/src/realtime.ts` |
| V.4 status codes | 401 vs 403 split, 503 for outage |
| VII | Test-first per [test-plan.md](test-plan.md); no fixed sleeps; no mock of own code |
| X.3 no domain names in the lib | Pass; revoke consumer lives in tenancy |
| S54 T037 / transactions (cross-spec 4) | Lib has no `sequelize.transaction`; none added; `.tx.baseline` stays; grep of touched files shows no audit comments |

Post-design re-check: same result; no violation, so no Complexity Tracking entries.

## Project Structure

### Documentation

```text
specs/domains/S51-realtime-push/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/{stream-http.md, library-api.md}
├── spec.md  test-plan.md  gaps.md  questions.md
└── tasks.md   # /speckit-tasks
```

### Source code

```text
packages/backend/libs/infrastructure/realtime/
├── index.ts                      # barrel (G-02)
├── realtime.module.ts            # global: publisher, registry, subscriber, subscriptions
├── realtime-stream.module.ts     # controller + hub, imported by the gateway app
├── config/realtime.config.ts     # zod-validated limits (G-34)
├── topics.ts, frame.ts, cursor.ts, retention.ts   # pure, unit-tested (G-18, G-20)
├── topic-registry.ts             # route-keyed, validated, frozen (G-25)
├── publish/{realtime-publisher.service.ts, publish.lua.ts, publish-validation.ts}   # G-21–G-24
├── hub/{topic-subscriber.service.ts, subscription-hub.ts, realtime-subscriptions.service.ts}  # G-05–G-09
├── stream/{topic-stream.controller.ts, stream.service.ts, connection.ts}   # G-10–G-19
├── metrics/realtime-metrics.ts   # G-33
└── *.spec.ts, *.e2e-spec.ts      # 12 e2e + 5 unit (test-plan.md); test topics module in test code
packages/backend/apps/sse-gateway/src/   # main.ts, instrument.ts, sse-gateway.module.ts only
packages/backend/libs/domains/tenancy/
├── infra/member-revocation.consumer.ts   # T-REV (S03 follow-up)
└── member-revocation.e2e-spec.ts
packages/contracts/src/realtime.ts        # G-31
packages/backend/test/utils/sse-client.ts # extended reader (G-29)
packages/web/lib/api/sse.ts, hooks/use-event-stream.ts   # G-32 (resync/revoked/recreate)
```

**Structure Decision**: engine in `libs/infrastructure/realtime`, hosted by the existing gateway app; domain topic modules stay in their domains.

## Work items (every gaps.md item is covered; order follows gaps.md "Order of work")

1. **Move + hub** — G-01, G-02, G-05–G-09: relocate hub/controller/module, pending-promise subscribe, isolated listener errors, graceful quit with command timeout, `resubscribed` hook, `TopicSubscriber`, `RealtimeSubscriptions` (`topicsWithSubscribers`, `revoke`), barrel; switch `live-batcher.service.ts` to `TopicSubscriber`.
2. **Registry** — G-25, G-26: route-keyed `define`, boot validation, freeze; adapt the existing domain `*TopicsModule` files to the new API (tenancy `shop`+`live`, identity `user`, auctions, launch-events, chat, fulfilment, experimentation, catalog-sync `import`, orders `order-export`, assets) without changing their policy semantics beyond the rules; `grep "prefix: 'job'"` must be empty.
3. **Publisher** — G-21–G-24: Lua atomic publish, validation + typed topics, `{published,id}` best effort, retention (count, age, expiry); re-check the 15 callers named in G-23 for use of the returned id.
4. **Stream** — G-10–G-20: close-first lifecycle, live-only bypass of cursor, paged replay, resync, baseline frame, hardened query/cursor/frame, 401/403/503 codes, jittered retry, caps, lifetime, stall, bounded replay buffer, drain.
5. **Policy, contracts, metrics, config** — G-14, G-31, G-33, G-34: `@RateLimit('realtime.connect')` and S01 anonymous marker (fall back to in-controller credential check if S01 not yet exposed, recorded in the PR), contracts schemas, metrics/logs, validated config.
6. **Revocation (T-REV, S03 follow-up)** — `revoke` over `rt:ctl` (research D6); `MemberRevocationConsumer` in tenancy (research D7) registered next to `ShopPlanConsumer`; e2e `member-revocation.e2e-spec.ts` written first; `shop` + `live` and `shop` + `assets` both close. Also covers AS-54–AS-58 in `realtime-revocation.e2e-spec.ts`.
7. **Tests** — G-27–G-30: rewrite the suite into the 12 files + unit files, test topics module (no domain imports), extended `sse-client.ts`, polling helpers; delete fixed sleeps in the files S51 owns (`live.e2e-spec.ts` fixed sleeps belong to S23: noted in gaps).
8. **Cleanup** — G-03, G-04 after S13/S24 land: delete both `redis-pubsub` dirs and dead throttler/Sequelize wiring if their consumers are gone; if not landed yet, leave them and record it in the report.
9. **Web, ops, docs** — G-32, G-35, G-36: `sse.ts` handles `resync`/`revoked`/recreate; load script reconnect-storm case; README paths. Unverified criteria are in quickstart "Ops artifacts" and `specs/UNVERIFIED.md`.

Gates before reporting done: `tsc --noEmit`, ESLint, `check:boundaries`, `check:table-ownership --strict` (0 lines for the realtime and redis-pubsub dirs), the whole `libs/infrastructure/realtime` suite once plus the tenancy revocation spec.

## Complexity Tracking

None.
