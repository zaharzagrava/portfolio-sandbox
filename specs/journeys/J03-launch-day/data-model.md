# Data Model: J03 — Launch Day

J03 owns **one new table** (`Voucher`, in the `orders` domain, because orders consumes the command) and test-kit types. Every other entity is owned by its capability and only observed through public APIs.

## New entity: Voucher (owner: orders, S10)

| Field | Type | Rule |
|---|---|---|
| `id` | uuid | `voucherId` |
| `holdId` | uuid | **UNIQUE**; idempotency key `booking-voucher:<holdId>` |
| `launchEventId`, `shopId` | uuid | plain ids, **no foreign key** (IX; D-12) |
| `userId` | uuid | the booking's buyer; reads are owner-only |
| `seatCount` | int | ≥ 1 |
| `status` | enum | `ISSUED` (the only state today) |
| `createdAt` | timestamp | from the injected clock |

Migration: expand only (create table, unique index on `holdId`, index `(userId, launchEventId, createdAt)`); no backfill. Registered in the model registry (`check:model-registry`). Read: `GET /orders/vouchers` → [contracts/journey-kit.md](contracts/journey-kit.md) §2.

## Entities observed (owner → observable)

| Entity | Owner | Observable | States asserted |
|---|---|---|---|
| Launch event, ticket, hold, booking | launch-events (S22) | `GET /launch-events/:id`, `…/queue/:ticket`, `…/seatmap`, `…/my-bookings` | `ON_SALE → SOLD_OUT | CLOSED`; hold expires at 10 min and frees its seats |
| Drop (flash sale), claim | orders (S11) | `GET /shops/:id/flash-sales/:saleId`, `GET /flash-sales/:saleId` | `LOADED/LIVE → ENDED → RECONCILED | START_FAILED` |
| Live stream, comment, pin | launch-events (S23) | `GET /live/:id`, `/history`, `/events`, SSE `stream:<id>` | `SCHEDULED → LIVE → ENDED`; pin `{version, productId}` or `{version, unpinned: true}` |
| Auction, bid, settlement order | auctions (S21), orders (S10) | `GET /auctions/:id`, `GET /shops/:id/auctions/:id`, `GET /orders` | `OPEN → CLOSED → SOLD | SECOND_CHANCE → SOLD | UNSOLD(reason)` |
| Inbox item, unread counter | notifications (S28) | `GET /notifications`, `/unread-count`, SSE `user:<id>` | one item per fact; `unread` equals unread items |
| Product stock | catalog (S05) | member product read (`quantity`) | stock before = shelf + sold at the end |
| Consumer group, queue consumer | S53, S55 | `GET /api/admin/consumers/:group` | `RUNNING | PAUSED`, `lag` |

## Test-kit types (test code only)

- `Hop = 'J03.H1'…'J03.H30'` → `{maxMs, owner, what}`; deadline `2 × maxMs × JOURNEY_TIME_FACTOR`.
- `LaunchFixture`: `{shop: SellerFixture, owner, staff, outsider, buyers[], event, drop, stream, auction}`; builders idempotent (409 → open existing, L-010).
- `SseClient`: `{events[], waitFor(type, pred), close()}` over `test/utils/sse-client.ts`.
- `EventTap`: `(topic, {type?, key?, limit?}) → {items: {eventId, type, key, version, occurredAt, payload}[]}`; `countExactlyOnce(type, key)` after `lag: 0`.

## Local-profile settings (validated at startup, refused when `NODE_ENV=production`)

| Setting | Meaning | Owner |
|---|---|---|
| `CLOCK_CONTROL=enabled` | clock routes (J01) | S54 |
| `PROVIDER_DOUBLES=enabled` | payment, extractor (J01/J02) and the toxicity double (`[[toxic]]` → 0.95, else 0.05) | S23 |
| `EVENT_TAP=enabled` | read-only topic tap | S53 |

## Boundary check

Orders owns `Voucher`; launch-events writes none of orders' tables (command over SQS). The tap reads topics, never tables. `launch-events` and `auctions` import no orders models (R1 services and commands only). No cycle added.
