# Contracts: J05 — Engagement loop

## HTTP changes

| Route | Change | Owner |
|---|---|---|
| `POST /checkout` | optional body `ref` (`^[A-Za-z0-9_-]{3,64}$`); `refCode` removed; unknown properties still `400`; unknown/disabled/self `ref` ⇒ `2xx`, `attribution: null`; malformed ⇒ `400` | S10 |
| `GET /orders/:id` | `attribution: { code } \| null` | S10 |
| `GET /links/:code/conversions` | new; owner only (`404` for others); `{items:[{conversionId, paidAt, amountMinor, currency, status, refundedMinor}], nextCursor}`; no buyer, order id | S37 |
| `GET /links/:code/stats` | adds `conversions`, `convertedMinor` | S37 |
| `GET /api/admin/consumers/:group` | accepts the eight new aliases | S53 |
| `POST /api/admin/jobs` | allow-list contains `recommendations.build-bought-together` | S49 |

## Events

| Event | Topic / key | Payload |
|---|---|---|
| `order.paid` (v+) | `orders.events` / `orderId` | existing + `attribution: {code, ownerId} \| null` |
| `link.converted` v1 | `links.events` / link code | `conversionId, linkCode, amountMinor, currency, paidAt` |
| `link.conversion_reversed` v1 | `links.events` / link code | `conversionId, linkCode, refundedMinor, amountMinor` |

Schemas are zod objects in `packages/contracts` (V.2/V.3); both sides parse with them.

## Journey kit (`packages/backend/test/journeys/support/`)

| Export | Contract |
|---|---|
| `engagementFixture` | over public routes only: `follow(user, shopOwner)`, `publishProduct(seller, {price, stock, category})`, `post(user, productId, key)`, `comment`, `createLink(user, productId, key)`, `referredCheckout(buyer, lines, {ref, key})`, `payOrder(buyer, orderId)` (J01 chain), `createExperiment(admin, {unit:'user', metric:'purchase'})`. Idempotent: `409` ⇒ open existing (L-010). |
| `storefrontDouble` | `post(events[], {token, anonymousId})` to `POST /api/events`; fresh `event_id` per event; `anonymousId` 8–64 chars |
| `waitForContract(hop, probe)` | `hop` ∈ `J05.H1..H16`; deadline = 2 × max × `JOURNEY_TIME_FACTOR`; poll 250 ms; no fixed sleeps. Extends the existing `wait-for-contract.ts` hop table |
| `controlSurface` (existing) | `afterAll`: restore clock, resume every paused group, also on failure (L-013) |

The test never reads a table, topic or queue directly; topics only through the event tap. Absence is asserted only after `lag: 0` and the hop maximum on the stack clock (L-003). Log scans use `logMark`/`logLinesSince` from `beforeAll` (L-032).
