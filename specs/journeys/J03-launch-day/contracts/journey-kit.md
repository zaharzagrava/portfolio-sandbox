# Contract: J03 journey kit, control-surface additions, voucher route

J03 has no runtime exports besides the routes below. The timing contract (hop table H1–H30) and the canonical consumer groups are in `spec.md`; control-surface routes are J01's, extended here.

## 1. Control-surface additions (admin role, local profile, refused in production)

| Surface | Addition | Owner |
|---|---|---|
| `POST /api/admin/jobs` | allow-listed types `launch-events.reconcile-seats`, `auctions.sweep-due`, `flash-sale.verify`, `launch-events.live-reconcile`; each idempotent | S49 |
| `GET|POST /api/admin/consumers/:group` (`/pause`, `/resume`) | also for queue consumer `orders-booking-voucher`; `lag` = visible messages | S53, S55 |
| `GET /api/admin/topics/:topic/messages?type=&key=&limit=` | `200 {items: [{eventId, type, key, version, occurredAt, payload}]}`, read-only, `limit` ≤ 200 (default 50); refused when `NODE_ENV=production`; `403` for a non-admin | S53 |

## 2. Voucher route (orders, S10)

`GET /orders/vouchers?launchEventId=&limit&cursor` (authenticated; the caller's own vouchers only) → `200 {items: [{voucherId, holdId, launchEventId, shopId, seatCount, status: "ISSUED", createdAt}], nextCursor: string | null}`; cursor convention of `GET /orders`; a filter matching nothing yields an empty page.

Consumer: group `orders-booking-voucher`, queue `orders-booking-voucher-requested`, idempotent on `booking-voucher:<holdId>`, invalid payload → DLQ.

## 3. Ticket status field (launch-events, S22)

`GET /launch-events/:eventId/queue/:ticket` adds `admittedAt` (ISO instant, present only when admitted, owner-only, no personal data).

## 4. Test kit (`packages/backend/test/journeys/support/`)

| Export | Contract |
|---|---|
| `waitForContract('J03.Hn', probe)` | polls every 250 ms, deadline `2 × maxMs × JOURNEY_TIME_FACTOR`; the failure names hop and owner; no fixed sleeps |
| `launchFixture` | `createEvent`, `createDrop`, `createStream`, `createAuction` over the public routes; unique names; idempotent |
| `sseClient(topics \| liveStreamId)` | wrappers for `queue:`, `event:…:seatmap`, `auction:`, `stream:`, `user:` and `GET /live/:id/events` |
| `eventTap(topic, filter)` | the tap above; only for events with no consumer and "exactly once" proofs |
| `controlSurface.restoreAll()` | resumes every group and queue consumer, resets the clock; idempotent, exit-safe (L-016) |

Every response is parsed with its schema from `packages/contracts`; a route without one gets one there (voucher page, tap page, ticket status), not an ad-hoc test type.
