# Implementation Plan: S37 — Share and affiliate short links (domain `marketing`)

**Branch**: `S37-share-links` (working branch `sdd/auto`) | **Date**: 2026-10-13 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md` (AS-01–AS-66, FR-001–FR-105, SC-001–SC-009), `test-plan.md`, `gaps.md` (G1–G25, L1–L7, debt D-6/D-7/D-8/D-12, ownership output), `questions.md` (defaults accepted as written), the constitution, and the follow-ups left by S49, S50 and W02 (below).

## Summary

Rebuild the share-link half of `marketing` so that a code is never lost, reused or leaked, a redirect never lies, and a click is counted once:

1. **Create** (`apps/core`): `@Idempotent` (platform record, 24 h) + header guard (400) → DTO from a `packages/contracts` schema → destination policy (pure, `domain/`) → reputation port (2 s, fail closed) → per-owner counter (conditional update, same store) → code from the leased counter through the keyed Feistel bijection (unchanged maths) → **filter entry first**, then one conditional `PutItem` (`attribute_not_exists(code)`); generated collisions retry ≤ 5 with a new number, alias collisions answer `409 alias_taken` (R-2, R-3, R-6).
2. **Redirect** (`apps/core`, `edge-be`): controller makes one call, `resolveRedirect(code, meta)`, and maps a result union (`redirect | not_found | gone | unavailable`) to status and headers. Order: format → filter (bypassed unless the *ready* marker exists) → cache-aside (miss 60 s, stale 24 h, single flight) → store with a 500 ms timeout → state and destination re-check. Clicks are published off the request path with a bounded drain on shutdown (R-4, R-7).
3. **Clicks**: one event envelope (`version 1`, `occurredAt`, origin-only referer, validated country, time-ordered `clickId`); the edge records only what it serves and proves itself to the origin with a shared credential; the consumer (`ShareLinksProjectorModule`) validates, dead-letters, and is idempotent on `clickId` and the owner statistics count `uniqExact(click_id)` from `link_clicks` at read time, so counts are exact before any merge (R-8).
4. **Manage and read**: keyset-paged list, `PATCH` destination, final `disable` (conditional updates on `status`), owner stats (`24h|7d|30d`, `uniqExact(click_id)`), `resolveAttributions` R1 export (R-9, R-10).
5. **Operate**: required config with startup validation (no secret fallback), `link_*` metrics, structured logs, filter rebuild job (S49, once per schedule), retention by a separate purge attribute (13 months), stores owned and recorded, barrel exports modules only.

Why no SQL outbox: share links own no PostgreSQL table; the click event is best effort by decision (`questions.md` LOCAL) and is published off the request path, so there is no dual write to protect. The platform idempotency record is infrastructure-owned PostgreSQL and is not a share-link table.

## Technical Context

**Language/Version**: TypeScript (strict), NestJS 11, Zod 4 in `packages/contracts`, Cloudflare Worker (`packages/edge-be`, vitest Workers pool)
**Primary Dependencies**: `DynamoService` (`@aws-sdk/lib-dynamodb`), `RedisService` + `RedisBloomFilter` + `CacheService` (single flight, S52), `@app/infrastructure/idempotency` (`@Idempotent`), `@app/infrastructure/events` (`defineEvent`), `@app/infrastructure/projections` (S53 consumer: validation, dead letters, lag), `@app/infrastructure/jobs` (S49 `declareJobType`, `upsertSchedule`), `@app/infrastructure/rate-limit` (`definePolicies`, `@RateLimit`), `Clock`/`CLOCK` (`@app/common/core/clock`), metrics registry (`@app/common/telemetry`), `ClickHouseService`, `KafkaProducerService`
**Storage**: DynamoDB `Links` (durable, owner `marketing`); Redis `share-links:*` and `link:v1:*` (derived, every key with a TTL except the counter); ClickHouse `link_clicks*` (derived from the log, 13-month TTL); no PostgreSQL table of its own
**Testing**: jest e2e through `/opt/sdd/repo/scripts/sdd/test-spec.sh` (five `share-links-*.e2e-spec.ts` files), unit specs beside `domain/` (`codes`, `destination-policy`, `alias-rules`, `click-meta`, `link-state`), vitest for `edge-be`, one W02 Playwright journey (not owned here)
**Target Platform**: Linux; `apps/core` (HTTP + R1 export), `apps/worker` (rebuild job), `apps/projector` (click consumer), Cloudflare Worker (edge)
**Project Type**: backend domain module + contracts package + edge worker; web owned by W02
**Performance Goals**: cached redirect p99 < 20 ms at origin (SC-001), 40,000 redirects/s via edge (SC-002), create 400/s (SC-006): all three are ops artifacts
**Constraints**: link store 500 ms (redirect) / 1,000 ms (writes), Redis 150 ms, reputation 2 s, publish drain 5 s, click retry ≤ 2 off-path, list page 20 default / 100 max
**Scale/Scope**: 5 billion links over 5 years (< 0.5% of 2^40 codes); 1,000 links per owner; 100 codes per attribution lookup

**Connection arithmetic (III.12)**: no PostgreSQL connection is opened by share-link code (the idempotency record uses the shared pool already sized for idempotent routes); DynamoDB, Redis, ClickHouse and Kafka use their shared clients.

## Constitution Check

| Gate | Status | How |
|---|---|---|
| 1 Layers (I.1–I.4) | PASS after work (D-6, L1, L2, L5, L7) | ports + tokens in `domain/` (`LinkRepository`, `CodeSequence`, `ExistenceFilter`, `ClickPublisher`, `ClickStatsReader`, `DestinationReputation`, `Clock`); adapters in `infra/`; `application/` imports no `infra/`; `LinkClicked` contract moves to `domain/`; `domain/` reads no clock (`Date`, `Date.now()` banned); the HMAC in `domain/codes.ts` is pure and deterministic and stays |
| 2 Pipeline (II) | PASS after work (L4) | thin controllers; request bodies/queries validated by zod schemas from `contracts` at the pipe; domain errors with `code` and status rendered by the global problem+json filter; `@Firewall()` on the five authenticated routes, `@Firewall({anonymous:true})` on the redirect |
| 3 Data access (III) | PASS after work | only `infra/` touches Dynamo/Redis/ClickHouse; no SQL transaction opened or added (`.tx.baseline` stays 0); invariants by conditional writes (alias/code claim, `ADD` counter with condition, `status = ACTIVE` condition), not check-then-write; keyset cursor (HMAC'd) for the list; stats read by `(owner, code)` lookup; every cache key has a TTL; no `KEYS`/`SCAN` on the hot path (rebuild scans the table in pages) |
| 4 Messaging (IV) | PASS after work | topic `links.events` defined once (`defineEvent`), schema in `contracts`; consumer validates, dead-letters, declares `idempotency: 'natural'` (documented: dedupe on `click_id`); explicit timeouts everywhere; cross-domain read: none |
| 5 Contracts (V) | PASS after work | six schemas in `packages/contracts/src/marketing/share-links.ts`; problem+json with stable `type` codes; `Idempotency-Key` on create; `GET` changes no state except the click event (documented); breaking shapes listed in `contracts/share-links-api.md` |
| 6 Frontend (VI) | N/A here | W02 owns the share action and cookie |
| 7 Tests (VII) | PASS after work | all 66 scenarios mapped in `test-plan.md`; every fallback forced; `Promise.all` concurrency for AS-05/06/10/12/21/32/33/54; real engines, only edge dependencies faked |
| 8 Operations (VIII) | PASS after work | startup validation of five keys; metrics `link_*`; structured logs without destination/referer/visitor data; graceful drain; jobs registered once through S49 |
| 9 DB isolation (IX) | PASS after work | zero share-link lines in `check:table-ownership --strict`; owner `marketing` recorded in `Links.json` `_design` and the ClickHouse DDL header; Redis key prefixes documented in `data-model.md` |
| 10 Monorepo (X) | PASS after work (D-8, L3) | barrel exports `ShareLinksModule`, `ShareLinksWorkerModule`, `ShareLinksProjectorModule`, `LinkAttributionService`, DTO types, `linkClickedEventSchema`; `LinkClicksProjector` leaves the barrel; apps import modules |

Post-design re-check: still PASS. Risks: (a) the platform's idempotency header validation answers `422` (R-5): a guard in front of it keeps the spec's `400`; (b) ClickHouse exact counting at read time costs more than a summing view (R-8): bounded by the 30-day maximum range and per-code `ORDER BY`; (c) the `Links` TTL attribute change needs a table migration of the local definition and of deployed tables (expand-only: new attribute `purgeAtEpoch`, TTL switched, old attribute stays readable, R-6).

## Follow-ups from built sibling specs (treated as requirements)

1. **S49 → S37** (`declareJobType`): the filter rebuild job declares its type with a payload contract next to the `JobPayloads` augmentation (`share-links.rebuild-filter`, `z.object({}).strict()`), registers the schedule through `upsertSchedule` catching `InvalidScheduleError` (not a generic `Error`), and uses no `JobsService.cancel`. Task T52; test: `ShareLinksWorkerModule` boots in the real `apps/worker` (L-004, L-015) and AS-33 runs the handler through the job registry.
2. **S50 → S37** (G-35 mis-used policies): `share-links.controller.ts` stops using `discussion.write`; the policy `share-link.create` (20/min/user, closed) is declared in `marketing/rate-limit-policies.ts` with `definePolicies('marketing', …)` and registered by `ShareLinksModule` (T25). S25 keeps `discussion.write` alone. The bullet for S25 is in `gaps.md` (Sibling-spec follow-ups).
3. **W02 → S37** (`SITE_URL`, `__Host-ref`): the backend's storefront origin (`front_host`, the origin every destination is checked against) and the web app's `SITE_URL` must be the same origin. S37 enforces its half at startup (`front_host` an absolute `https` origin without path, AS-62), documents the pairing in `quickstart.md` prerequisites, and adds a deploy check in the quickstart ("`SITE_URL` equals `front_host`"). The cookie `__Host-ref` is set by W02's `POST /api/attribution/ref` in the web app; S37 only appends `ref=<code>` to the destination and never sets a cookie (AS-24 asserts no `Set-Cookie`). Not editable from here: W02 bullet recorded in `gaps.md`.
4. **S54 toolkit**: share links open no SQL transaction (`.tx.baseline` is 0 for this domain); nothing to migrate, nothing to add. Clock, metrics registry, config validation and problem+json are used as supplied.
5. **gaps.md items**: every row G1–G25 and L1–L7 and the debt rows D-6 (paid), D-8 (paid), D-7/D-12 (not applicable) are in the tasks below (traceability table in `research.md`).
6. **Living specification**: `docs/spec/capabilities/` has no page for S37 (S25's page exists as the model), so rule (0) has nothing to edit first; the final task adds `docs/spec/capabilities/S37-share-links.md` with `[proof: …]` / `[code: …]` anchors and validates it with `python3 scripts/livespec/check.py`. No `*.reviewed.json` is created or edited; nothing signed by a human changes (`gaps.md` "Spec changes" says so).
7. **Unverified criteria** (rule 2): SC-001, SC-002, SC-004 (the 99th-percentile part), SC-006 (the 400/s part) go under "Ops artifacts" in `quickstart.md` and into `specs/UNVERIFIED.md` (done at plan time, status "not run").

## Project Structure

### Documentation

```text
specs/domains/S37-share-links/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/share-links-api.md  contracts/events.md
└── tasks.md   # /speckit-tasks
```

### Source code (`packages/backend/libs/domains/marketing/`; contracts in `packages/contracts/src/marketing/`; edge in `packages/edge-be/`)

```text
packages/contracts/src/marketing/share-links.ts        # six schemas + error code list + problem codes (T01)
packages/backend/libs/common/config/…                  # share_link_code_key, share_link_base_url (required), share_link_max_per_owner,
                                                       # share_link_edge_secret, share_link_reserved_aliases; joi + config-rules (distinct-secret rule)
packages/backend/dynamodb/Links.json                   # purgeAtEpoch TTL, byOwner stays, ownerCount item, owner note
packages/backend/clickhouse/020_link_clicks.sql        # owner note; exact-count read (no schema break), optional 021 for the daily view
marketing/
├── api/
│   └── share-links.controller.ts                      # 5 authenticated routes + public redirect; thin; @Idempotent, @RateLimit
│   └── idempotency-header.guard.ts                    # 8–128 chars → 400 validation_failed before the platform interceptor
├── application/
│   ├── share-link-command.service.ts                  # create / change / disable
│   ├── share-link-query.service.ts                    # list, stats
│   ├── redirect.service.ts                            # resolveRedirect(code, meta) → result union; click recording
│   ├── link-attribution.service.ts                    # R1 resolveAttributions
│   └── filter-rebuild.service.ts                      # job body
├── domain/
│   ├── ports.ts (+ tokens)                            # LinkRepository, CodeSequence, ExistenceFilter, ClickPublisher, ClickStatsReader,
│   │                                                  # DestinationReputation, LinkCache; Clock from @app/common/core
│   ├── codes.ts (+ spec)                              # unchanged maths; range errors typed
│   ├── destination-policy.ts (+ spec)                 # host/IDNA/port/user-info rules, ref removal, URL assembly
│   ├── alias-rules.ts (+ spec)                        # format, reserved words
│   ├── click-meta.ts (+ spec)                         # country and referer clean-up
│   ├── link-state.ts (+ spec)                         # ACTIVE/DISABLED/EXPIRED, transition table, now >= expiresAt
│   ├── link-events.ts                                 # LinkClicked contract (moved from application)
│   ├── link-errors.ts                                 # DomainError(code, status)
│   └── link-metrics.ts
├── infra/
│   ├── dynamo-link.repository.ts                      # conditional put/update, owner counter, byOwner keyset, batch get
│   ├── redis-code-sequence.ts (id-lease.ts)           # lease + counter-loss detection + owner note
│   ├── redis-existence.filter.ts                      # bloom + ready marker + rebuild lock
│   ├── redis-link.cache.ts                            # CacheService wrapper, errors never cached
│   ├── kafka-click.publisher.ts                       # bounded retry, in-flight set, drain
│   ├── clickhouse-click-stats.reader.ts               # exact counts
│   ├── allow-all-reputation.adapter.ts                # default adapter behind the port
│   ├── link-clicks.projector.ts                       # validated, dead-lettered, 'natural' idempotency
│   └── share-links.jobs.ts                            # declareJobType + schedule (S49)
├── rate-limit-policies.ts                             # share-link.create
├── share-links.module.ts  share-links-worker.module.ts  share-links-projector.module.ts  index.ts
├── share-links-{create,redirect,clicks,manage,platform}.e2e-spec.ts   # replace share-links.e2e-spec.ts
└── testing/share-links.fixtures.ts                    # frozen clock, fault-injecting store wrappers, fake reputation, edge fakes
packages/edge-be/src/index.ts                          # shortLinkRedirect: record only on served 302, uuidv7, origin-only referer, credential
packages/edge-be/test/short-link.spec.ts               # AS-41, AS-42
docs/spec/capabilities/S37-share-links.md              # living page (last task)
```

`marketing-contracts.spec.ts` stays for S36's shapes; its share-link assertions (if any) move to the new schemas. Ads files are not touched (S36).

**Structure Decision**: stay inside `marketing` (no new deployable, I.6). Splitting the 218-line service into command, query, redirect and attribution services keeps each reviewable; ports make the Dynamo/Redis/Kafka adapters swappable for the fault-injecting wrappers the tests need.

## Technical tasks by gap (input for `/speckit-tasks`)

Order is test-first within each step; the whole capability suite runs once at the end (L-008: batches of fresh processes). Backend commands from `packages/backend`; specs through `scripts/sdd/test-spec.sh`.

1. **Contracts, config, schema (T01–T07)**: `contracts/src/marketing/share-links.ts` (G23); config keys + joi + distinctness rule against `jwt_secret` and the S36 ad secret, `front_host` https-origin rule (G5, G21, AS-62); remove `share_link_secret` from the share-link path (S36 keeps its own read until it migrates — sibling bullet); `Links.json` purge attribute and owner note (G11, L7); ClickHouse owner note (L7); rate-limit policy file (G8); problem codes registered in the catalogue. Boot the real `core` once (L-015, L-004).
2. **Pure logic with unit specs (T10–T16)**: `destination-policy` (G6; 13 refused + 2 accepted variants, `ref` removal, assembly), `alias-rules` (G3), `click-meta` (G15), `link-state` (G11, G20, AS-65), `link-events` move (L2), `codes.ts` typed range error and `fast-check` properties (G22); `domain/` free of `Date` (lint).
3. **Ports and adapters (T20–T27)**: `ports.ts` + tokens (L1); Dynamo repository with conditional create/update, owner counter, purge attribute, `batchGet` (G7, G11, G20); lease with counter-loss detection (G22); filter with ready marker and add-before-write (G9); cache wrapper that never stores errors (G10); publisher with drain (G15); reputation port + allow-all adapter (G6); module wiring with explicit imports (L6).
4. **Create path (T30–T36)**: idempotency guard + `@Idempotent` (G1); command service: policy → reputation → limit → code → filter → conditional write → cache invalidation; collision retry ≤ 5 with metric (G4); alias claim and reserved words (G3); response DTO with `Location` (G2); coded errors (G24); `share-links-create.e2e-spec.ts` (AS-01–AS-23 except AS-23).
5. **Redirect path (T40–T47)**: `resolveRedirect` and result mapping (G12, L4); `410`/`404`/`503` with headers (G11, G13, G10); HEAD without click, `405` for other methods (G12); credential for the edge flag (G14); destination re-check (G6); injected clock (L5); shutdown drain (G15); `share-links-redirect.e2e-spec.ts` (AS-23–AS-37).
6. **Clicks and attribution (T50–T55)**: event envelope (G15); consumer with validation, dead letters, `natural` idempotency, `ts` bounds (G17); exact-count read; `LinkAttributionService` (R1, batched, typed errors); rebuild job `share-links.rebuild-filter` (G9, S49 follow-up); `share-links-clicks.e2e-spec.ts` (AS-38–AS-47).
7. **Management and statistics (T60–T65)**: keyset list with HMAC'd cursor (G18); `PATCH` and `disable` with conditional updates and cache removal (G20, FR-048); owner-in-lookup for edit/disable/stats (G19, FR-083); stats with ranges and countries (G19); `share-links-manage.e2e-spec.ts` (AS-48–AS-61).
8. **Edge worker (T70–T72)**: record only served `302`, `uuidv7`, origin-only referer, credential, event envelope `version 1` (G16); `short-link.spec.ts` with fake origin, sink, cache clock (AS-41, AS-42).
9. **Operations, barrel and wiring (T80–T86)**: metrics and log scan (G21); `ShareLinksWorkerModule`, `ShareLinksProjectorModule`; `index.ts` (L3); `apps/core`, `apps/worker`, `apps/projector` import modules; delete `share-link.service.ts` and `share-links.e2e-spec.ts` once replacements pass (G25); `share-links-platform.e2e-spec.ts` (AS-62–AS-65).
10. **Gates (T90–T94)**: `tsc --noEmit` and ESLint (backend, contracts, edge-be); `pnpm check:boundaries`, `check:module-graph`, `check:model-registry`, `check:table-ownership --strict`, `check:no-wallclock`; `python3 scripts/livespec/check.py` with the new page; whole capability suite once; `scripts/qa/fresh-run.sh` (L-012); start the real API, worker and projector (L-004); T95 adds the k6 script `scripts/load-tests/share-links.test.js` and the `loadtest:share-links` package script (ops artifact).

## Complexity Tracking

| Violation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Idempotency header guard in front of the platform interceptor | Spec and `questions.md` fix `400 validation_failed` for a bad key; the platform answers `422 idempotency_key_invalid` | Changing the platform contract is S54's, and `422` for a header would contradict AS-02 |
| Filter entry written before the link, a stray entry tolerated | A crash must never leave a link the filter hides (FR-007) | Writing after the link is the defect G9 |
| Exact-count read-time dedupe in ClickHouse | Counts must be exact before any merge (AS-43) | `SummingMergeTree` view counts every insert, so a redelivery inflates it (G17) |
| Separate purge attribute instead of the table TTL on `expiresAt` | Codes must not be recycled for 13 months (FR-033) | TTL on `expiresAt` deletes the row at expiry |
