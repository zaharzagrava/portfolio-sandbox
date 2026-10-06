# Research & Decisions: Phase 2 Batch 4

## R1. Placement of the harder files {#r1}

| File | Layer | Why |
|---|---|---|
| `discussions/content.ts` (markdown → sanitized HTML), `paths.ts`, `ranking.ts` | domain | Pure functions. `marked` and `sanitize-html` are libraries, not frameworks or clients (I.3). |
| `feed/feed-publisher.service.ts` | application | A use-case service that defines and publishes feed events (it calls `defineEvent`, so it can't go in `domain/`). |
| `stories/blocks.ts` | domain | zod block schema plus sanitize rules. |
| `stories/cache-invalidation.ts` | infra | A projector that calls the revalidation webhook and the CDN purge over HTTP. |
| `notifications/catalog.ts`, `templates.ts`, `types.ts`, `quiet-hours.ts`, `unsubscribe-token.ts` | domain | Notification catalog, rendering, time-zone rules, signed tokens. Pure. |
| `notifications/providers/ports.ts` → `domain/provider-ports.ts` | domain | Channel port interfaces. The adapters (SES, SMTP, Twilio, FCM, log) and the breaker-wrapped `channel-sender` go in `infra/providers/`. |
| `notifications/sns-verifier.ts` | api | Signature verification for the provider webhook controller (transport). |
| `notifications/delivery-log.service.ts` | infra | A Cassandra repository. |
| `notifications/notification-workers.service.ts` | infra | Per-channel queue workers. |
| `autocomplete/search-query-logger.ts` | infra | Kafka producer of query logs. |
| `recommendations/keys.ts` → `infra/recommendation-keys.ts`, `leaderboards/keys.ts` → `infra/leaderboard-keys.ts` | infra | Redis key builders. Renamed so each reads clearly inside its merged domain. |
| `leaderboards/periods.ts` | domain | Pure period math (`luxon`). |
| `crawler/url.ts`, `robots.ts`, `simhash.ts`, `extract-price.ts` | domain | Pure parsing and hashing. Their unit spec `crawler.spec.ts` moved with them. |
| `crawler/frontier.ts` | infra | Redis frontier. |
| `crawler/crawler.module.ts` | root | A module file that also declares `CompetitorController`. Splitting it is D-6 work. |

## R2. Keeping `ranking.spec.ts` failing identically {#r2}

- **Observation**: the spec imports `./ranking`, `./paths`, and `./content`. `content.ts` imports `marked`,
  which ships only as ESM. Jest's CommonJS runtime can't `require` it, so the suite fails to load and
  runs 0 tests.
- **Decision**: move all four files to the same folder (`community/domain/`) so the relative imports stay
  byte-identical.
- **Result**: the same error and the same 0 tests, at the new path. Fixing it (an ESM transform for
  `marked`, or `transformIgnorePatterns`) is out of scope, as requested.

## R3. Renaming the two `search-events.ts` files {#r3}

search-admin's file defines `search.result_clicked`, and autocomplete's defines `search.performed`. In
the merged domain they would collide, so each is named after its event:
`application/events/search-click-events.ts` and `application/events/search-query-events.ts`. The
codemod rewrote every importer.

## R4. Why there were no runtime barrel cycles this time {#r4}

> Correction (batch 5): there was no **runtime** cycle, but the static domain graph does have catalog ↔ discovery (D-12 + D-15). See the batch 5 plan.

Every new cross-domain edge points "down" toward domains that don't import these five:
- community → catalog;
- discovery → catalog, orders;
- notifications → auctions, billing, orders;
- seller-insights → notifications, catalog, orders.

`crawler.service` → notifications is an edge between two batch 4 domains, but notifications doesn't
import seller-insights back. The module-graph check confirmed this: 9/9 apps, with node counts
identical to batch 3.
