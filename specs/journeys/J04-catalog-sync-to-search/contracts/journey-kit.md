# Contract: J04 journey kit and timing contract

No runtime exports. Provides the hop table `J04.H1`–`J04.H16` (spec.md; deadline 2 × max × `JOURNEY_TIME_FACTOR`), the canonical consumer groups, and the kit in `packages/backend/test/journeys/support/`. Control-surface routes are J01's.

## Job allow-list additions
`catalog-sync.sync-all`, `catalog-sync.reconcile-all`, `catalog-sync.recover-stalled-imports`, `search.reindex` (add any missing; idempotent).

## Canonical groups
`search-product-index`, `product-cache-invalidator`, `integrations-stock-push`, `offline-sync-feed`, `pickup-availability`: each answers `{state, lag}`; at rest `lag: 0`.

## Local-profile settings (refused when `NODE_ENV=production`)
`ALLOWED_PROVIDER_HOSTS`, `clamav_host` → scanner double, `SEARCH_REFRESH_INTERVAL=1s`, journey address on the rate-limit allow-list.

## Kit exports
| Export | Contract |
|---|---|
| `shopifyDouble` | HTTPS; OAuth exchange, products/variants (draft ignored), inventory levels, signed webhooks, `writeLog`, scripted `200/409/503/hang`, `sell()` |
| `scannerDouble` | clamd streaming protocol; clean unless EICAR |
| `catalogFixture` | `csv(rows, opts)`, `zipAsCsv()`, `uploadParts(start)` PUT to presigned URLs, `startAndComplete()` |
| `pickupFixture` | point at a coordinate, shopper location 1.2 km away, set/adjust stock |
| `deviceClient` | `X-Device-Id`, HLC, UUIDv7 `opId`, `push`, `pull` |
| `waitForContract('J04.Hn', probe)` | existing helper, rows added |
| `controlSurface.restoreAll()` | existing; resumes groups, resets clock |

Responses are parsed with `packages/contracts` schemas (`importJobSchema`, `integrationSchema`, `conflictPageSchema`, `productPageSchema`, `productSearchResponseSchema`, sync push/pull, near-me); a missing schema is added there.
