# Gaps: S37 Share and affiliate short links (current code vs `spec.md`)

This is the implementation agent's to-do list. Scope is the share-link half of `marketing` (S37); ads are S36 and are not listed.

Files in scope (under `packages/backend/libs/domains/marketing/` unless noted): `api/share-links.controller.ts`, `application/share-link.service.ts`, `domain/codes.ts`, `domain/codes.spec.ts`, `infra/id-lease.ts`, `infra/link-clicks.projector.ts`, `share-links.module.ts`, `share-links.e2e-spec.ts`, `index.ts:8-9`; `packages/backend/dynamodb/Links.json`, `clickhouse/020_link_clicks.sql`, `apps/core/src/core.module.ts:11,125`, `apps/projector/src/projector.module.ts:14,52`, `libs/common/config/{types,api-config.service}.ts` (`share_link_secret`, `share_link_base_url`, `front_host`), `libs/infrastructure/rate-limit/rate-limit.types.ts:49-50`, `packages/edge-be/src/index.ts:218-256`, `packages/edge-be/test/index.spec.ts`, `packages/contracts` (no share-link schemas exist).

## Behaviour gaps

| # | Gap | Where | Spec |
|---|---|---|---|
| G1 | No `Idempotency-Key`; a retried create burns a new code and creates a second link | `share-links.controller.ts:22-25`, `share-link.service.ts:71` | FR-016, AS-09, AS-10 |
| G2 | Response is the stored item plus `shortUrl`: exposes `ownerId`, `expiresAtEpoch`; no `status`, `kind`, `updatedAt`, no `Location` header, no response DTO | `share-link.service.ts:23-29,91` | FR-011, AS-01 |
| G3 | Generated code is computed before the alias check; the format check of an alias runs after the code is computed; alias regex allows upper case and `422` for format; no reserved words | `share-link.service.ts:73-74`, `domain/codes.ts:52` | FR-030, FR-031, AS-18, AS-19 |
| G4 | A collision of a generated code answers `409 Alias is taken` and never retries; no bound; no metric | `share-link.service.ts:84-88` | FR-005, AS-07 |
| G5 | Code key falls back to `jwt_secret`; no length check; no startup validation; `share_link_secret` also read by S36 | `share-link.service.ts:63`, `libs/common/config/api-config.service.ts:337-341` | FR-002, FR-100, AS-62 |
| G6 | Destination policy: `http` allowed; comparison on `url.host` with a fixed two-host set (no IDNA normalisation, no port rule beyond equality); no reputation hook; not re-checked at redirect; `ref` removal drops nothing else but is untested for order and fragment | `share-link.service.ts:146-155` | FR-012 – FR-014, FR-047, AS-03, AS-04, AS-14, AS-35 |
| G7 | No per-owner cap; no counter | n/a | FR-017, AS-12 |
| G8 | Rate limit borrowed from `discussion.write` (closed, 10/min, shared with posts) | `share-links.controller.ts:21`, `rate-limit.types.ts:49` | FR-018, AS-13 |
| G9 | Filter loss: an empty filter answers "absent" for every real link; `.catch(() => true)` covers only errors. `bloom.add` runs after the write: a crash between them leaves a link the filter hides. No rebuild job, no ready marker | `share-link.service.ts:89,96` | FR-007, FR-045, AS-08, AS-33 |
| G10 | Store errors surface as an unhandled `500` or are cached by the loader contract (verify `CacheService.getOrLoad` with a throwing loader); no store timeout; `Retry-After` missing | `share-link.service.ts:97-101` | FR-046, AS-34 |
| G11 | Expired and unknown codes both `404`; no disabled state; no `410`; no `no-store` on `404`; `expiresAtEpoch < now` is not the exclusive `now >= expiresAt` boundary; expired rows are deleted by the table's TTL, so aliases are recycled | `share-link.service.ts:102`, `dynamodb/Links.json` | FR-033, FR-042, FR-043, AS-22, AS-28, AS-29 |
| G12 | Redirect controller builds the URL, sets `ref` and branches on domain state (`if (!link) throw`) (II.1); `HEAD` is routed to the `GET` handler and records a click; other methods untested | `share-links.controller.ts:44-60` | FR-040, FR-044, AS-24, AS-30 |
| G13 | Cache header lacks `max-age=0` | `share-links.controller.ts:58` | FR-040 |
| G14 | `x-edge-click-recorded: 1` is trusted from anyone | `share-links.controller.ts:50,55` | FR-063, AS-40 |
| G15 | Click event: aggregate version `0`, `ts` from `new Date()` (not the clock), `referer` is a 300-char slice of the full URL, `country` unvalidated, errors swallowed with no metric or log; no retry; no shutdown drain | `share-link.service.ts:107-117` | FR-061, FR-062, FR-102, AS-36, AS-37, AS-38, AS-39 |
| G16 | Edge: records the click before the lookup (even for unknown codes, 404, 410, 5xx), uses `crypto.randomUUID()` for the click ID (not time-ordered), full `Referer` slice, flag has no credential; caches only `302` (correct); no tests for the short-link route | `packages/edge-be/src/index.ts:228-256`, `test/index.spec.ts` | FR-060, FR-061, FR-063, FR-064, AS-41, AS-42 |
| G17 | Projector: events that fail `LinkClicked.match` are silently dropped (no dead letter, no metric); duplicates are removed only at background merge and the per-minute view counts every insert, so statistics double count redelivered clicks; no `ts` bounds check; no idempotency mechanism documented | `infra/link-clicks.projector.ts:19-27`, `clickhouse/020_link_clicks.sql` | FR-065 – FR-067, AS-43 – AS-45 |
| G18 | List: bare array, `Limit: 100`, no cursor, no `status`; `byOwner` order only by `createdAt` (no tiebreaker) | `share-link.service.ts:115-130` | FR-080, AS-48, AS-49 |
| G19 | Stats: the link is loaded by code and the owner compared afterwards (III.4); it goes through `resolve()`, so expired links answer `404` and the cache and filter are involved; counts are strings; fixed 7-day minute window; no countries; not dedupe-safe | `share-link.service.ts:132-141` | FR-083, FR-090 – FR-092, AS-56 – AS-61 |
| G20 | No edit and no disable operations, no state machine, no conditional updates, no `updatedAt`/`disabledAt` | n/a | FR-081, FR-082, AS-50 – AS-55 |
| G21 | No `link_*` metrics; no structured warning on publish failure; no config validation (`share_link_base_url` optional with fallback to `backend_host/api/l`) | `share-link.service.ts`, `libs/common/config/types.ts:124-126` | FR-100, FR-101, AS-62, AS-63 |
| G22 | `IdLease`: block-level logic is right; but counter loss or a key change is undetected, a number at or beyond the code space throws `RangeError` → `500`, and the key `share-links:id-seq` has no owner note | `infra/id-lease.ts`, `domain/codes.ts:37-38` | FR-003 – FR-007, AS-06, AS-07 |
| G23 | No `packages/contracts` schemas (`createShortLinkRequestSchema`, `updateShortLinkRequestSchema`, `shortLinkSchema`, `shortLinkPageSchema`, `linkStatsSchema`, `linkClickedEventSchema`); the controller uses class-validator DTOs and returns models | `share-links.controller.ts:9-14` | FR-105, V.1, V.2 |
| G24 | Errors are plain Nest exceptions (`NotFoundException('Link not found')`), not coded problem+json | `share-links.controller.ts:54`, `share-link.service.ts:84-88,135` | FR-020, AS-16 |
| G25 | `share-links.e2e-spec.ts` calls the service directly (not HTTP) for create, has no `401`, IDOR, validation-class, idempotency, rate-limit, state, consumer or degradation cases, and stubs the Kafka producer for all tests; no unit tests for destination policy, click metadata, aliases or state | `share-links.e2e-spec.ts`, `domain/` | VII.2 – VII.5, `test-plan.md` |

## Layering and boundary gaps (constitution)

| # | Gap | Where | Rule / debt | Fix |
|---|---|---|---|---|
| L1 | `application/` imports `infra/` classes directly: `DynamoService`, `RedisService`, `CacheService`, `RedisBloomFilter`, `KafkaProducerService`, `ClickHouseService`, and `../infra/id-lease` | `share-link.service.ts:5-14` | I.2, debt **D-6** | Ports in `domain/` (`LinkRepository`, `CodeSequence`, `ExistenceFilter`, `ClickPublisher`, `ClickStatsReader`, `DestinationReputation`, `Clock`) with adapters in `infra/`; the service injects tokens |
| L2 | The event contract `LinkClicked` is defined in `application/` and imported by `infra/` (infra → application) | `share-link.service.ts:20`, `link-clicks.projector.ts:7` | I.2 | Move the event contract and its zod schema to `domain/` (exported through the barrel as an event contract) |
| L3 | Barrel exports the projector class; `apps/projector` wires it directly | `index.ts:9`, `apps/projector/src/projector.module.ts:14,52` | X.4, debt **D-8** | Export `ShareLinksProjectorModule` (and `ShareLinksWorkerModule` for the rebuild job); apps import modules |
| L4 | Controller holds redirect logic (URL assembly, state branching, header decisions) | `share-links.controller.ts:44-60` | II.1 | One call to `resolveRedirect(code, meta)` returning a result type; the controller maps it |
| L5 | `application/` reads wall-clock time (`new Date()`, `Date.now()`) | `share-link.service.ts:80-81,102,111` | I.3 spirit, S54 clock | Injected clock in all expiry and event timestamps |
| L6 | `ShareLinksModule` imports `AuthModule` for the guard only and relies on global Redis, Dynamo and Cache modules | `share-links.module.ts` | IV.1 | Declare dependencies explicitly; add the worker and projector modules |
| L7 | Ownership of this capability's stores is implicit: the `Links` table, `link_clicks*` tables, Redis keys `share-links:*` and `link:v1:*`, topic `links.events` | `dynamodb/Links.json`, `clickhouse/020_link_clicks.sql` | I.4, IX.1 | Record the owner (`marketing`) in each store's definition and in the check script's non-Postgres list if one exists |

## Open rows of `docs/architecture/debt-register.md` that name `marketing` or S37

The register contains no row that names `S37` or `marketing` in its **Resolved by** column. The open rows below touch this domain's share-link code; each is settled by this capability as stated.

| Debt | Applies here? | What to do in S37 |
|---|---|---|
| **D-6** (layering inside domains) | Yes: L1, L2, L4 | Repository and publisher ports in `domain/`, adapters in `infra/`; a controller that makes one call |
| **D-7** (other domains import `*Model` exports) | No: share links own no Sequelize model, import none, and nobody imports a share-link model | None. Do not add an export that violates it |
| **D-8** (barrels export infrastructure internals) | Yes: L3 | `LinkClicksProjector` leaves the barrel (replaced by `ShareLinksProjectorModule`) |
| **D-12** (raw SQL on other domains' tables) | Not for share links: its only `marketing` line is the ads query (`ads.service.ts`, `Product`) which belongs to S36 | See the table-ownership output below; nothing to change for S37 |
| D-1, D-2, D-3, D-4, D-5, D-9, D-13 | Resolved | none |
| D-10, D-11, D-14, D-15, D-16, D-17 | Not about marketing | none |

## `pnpm --dir packages/backend check:table-ownership`: lines for `marketing`

Run on 2026-10-05:

```
marketing  (1)
  SQL   Product   owned by catalog   libs/domains/marketing/application/ads.service.ts
```

- The one finding is in `ads.service.ts` (ads, S36): it reads `Product` and is replaced by R1 `catalog.getProductsByIds` in S36's `gaps.md`.
- **No finding belongs to share links** (D-7 and D-12 do not apply): `share-link.service.ts` queries only its own stores (the `Links` DynamoDB table and the `link_clicks*` ClickHouse tables) and uses no model of another domain. The checker only resolves Postgres tables, so S37's stores are covered by the review rule IX.4 and by AS-64 (no other domain touches them).
- Cross-domain data needed by S37: **none**. The owner is a plain `ownerId` with no foreign key; no name, email or profile is read. If a later screen needs the owner's display name, use R2 (BFF composition by `ownerId`), not a new read in this domain. The only consumer-facing data flow out is `resolveAttributions` (R1, S37 → S10 or the commission capability) and the `link.clicked` event (R3 for any analytics consumer).

## Implementation order (suggested)

1. Contracts (`packages/contracts`) and config keys with startup validation (G5, G21, G23).
2. Domain: code scheme tests kept, add `destination-policy`, `alias-rules`, `click-meta`, `link-state` (G3, G6, G11, G15; L2, L5).
3. Ports and adapters; remove direct `infra/` imports (L1); conditional state updates, purge attribute, owner counter (G7, G11, G20).
4. Create path: idempotency, collision retry, filter-before-write, limit, rate profile, reputation hook (G1 – G4, G7 – G9, G22).
5. Redirect path: resolution order, `410`/`404`/`503`, headers, HEAD, edge credential, destination re-check, shutdown drain (G9 – G14, G24; L4).
6. Clicks: event envelope, publish metrics, consumer with schema validation, dead letters, exact counting (G15 – G17).
7. Management and statistics (G18 – G20).
8. Edge worker (G16) and its spec.
9. Barrel, modules, app wiring (L3, L6, L7); replace `share-links.e2e-spec.ts` with the five e2e files (G25); run `check:boundaries`, `check:module-graph`, `check:model-registry`, `check:table-ownership --strict`.
