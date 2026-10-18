# Contract: J02 journey kit and timing contract

J02 has no runtime exports. What it provides to other capabilities and to the stack is the **timing contract** (hop table H1–H17 in `spec.md`, owners must not exceed the maxima), the **canonical consumer-group names**, and a **test kit**. Control-surface routes (`/api/admin/jobs`, `/api/admin/consumers/:group`, `/api/admin/clock`) are J01's ([J01 control-surface contract](../../J01-buy-to-payout/contracts/control-surface.md)); J02 only extends the job allow-list.

## 1. Job allow-list additions

| `type` | Owner | Used by | Idempotent |
|---|---|---|---|
| `billing.run` | S17 | AS-14 (dunning retry after clock move) | yes (invoice already `PAID` → no-op) |
| `onboarding.verify-pending` | S04 | AS-11 | yes (one `shop.verified` per `submissionNo`) |
| `webhooks.retry` | S43 | AS-27 | yes (delivery keyed by event id) |
| `search.reindex` | S32 | optional, not asserted | yes |

## 2. Canonical consumer groups

`identity-seller-promotion`, `tenancy-shop-lifecycle`, `entitlements-invalidation`, `search-product-index`, `webhook-router`, `leaderboards`, `product-cache-invalidator`. Each answers `GET /api/admin/consumers/:group` with `{state: RUNNING | PAUSED, lag}`; a group at rest has `lag: 0`.

## 3. Local-profile settings

See [data-model.md](../data-model.md) (bootstrap admin, provider doubles, `allowedReceiverHosts`, search refresh, rate-limit allow-list). All refused at startup when `NODE_ENV=production`.

## 4. Test kit (`packages/backend/test/journeys/support/`)

| Export | Contract |
|---|---|
| `waitForContract(hop, probe)` | polls `probe` every 250 ms until it returns a value, deadline `2 × maxMs × JOURNEY_TIME_FACTOR`; failure message names the hop and its owner; no fixed sleeps |
| `sellerFixture` (extended) | `registerSeller()`, `createShop()`, `onboardVerified(shop, kyc=ok)`, `subscribe(shop, pm)`, `createProduct(shop, overrides)`, `createEndpoint(shop, url, events)`; each idempotent (409 → open existing) |
| `webhookReceiver` | HTTPS server on an ephemeral port; verifies with S43's reference verifier; scripted answers; `received[]` |
| `fixtures/kyc-*.pdf` | five files with recorded `sha256` |
| `controlSurface.restoreAll()` | resumes every group and resets the clock; idempotent and exit-code safe when nothing is paused (L-016) |

## 5. Response parsing

Every response is parsed with its schema from `packages/contracts` (`subscriptionSchema`, `productMemberSchema`, `productSearchResponseSchema`, `leaderboardPageSchema`, `shopRankSchema`, shop and onboarding view schemas). A route without a schema gets one in `packages/contracts` in the task that needs it, not an ad-hoc type in the test.
