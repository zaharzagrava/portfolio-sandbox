# Data model: J05 — Engagement loop

Only three storage changes; everything else already exists in the owning domains.

## orders (S10)

| Change | Detail |
|---|---|
| `Order.refCode` (exists) | now holds the code of the **frozen** attribution, `null` if not credited |
| `Order.attributionOwnerId` (new, nullable uuid) | owner of the link at checkout; migration in orders' migration folder; never returned by any API |
| `GET /orders/:id` | adds `attribution: { code } \| null` (no owner id) |
| `order.paid` payload | adds `attribution: { code, ownerId } \| null`; `paidAt`, `orderVersion` unchanged |
| Checkout fingerprint | `ref` replaces `refCode`; same key + different `ref` ⇒ `422 idempotency_key_reused` |

## marketing (S37): `AffiliateConversion` (new table, marketing-owned)

| Field | Type | Rule |
|---|---|---|
| `id` | uuid PK | UUIDv5(namespace, `orderId`): deterministic, unique ⇒ idempotent insert |
| `linkCode` | text | link whose owner is credited |
| `ownerId` | uuid | frozen from `order.paid.attribution` |
| `orderId` | uuid, unique | internal only; not in routes or events |
| `amountMinor`, `currency` | bigint, text | from `order.paid.totalMinor` |
| `status` | `CONFIRMED` \| `REVERSED` (\| `PENDING_REFUND` internal) | see transitions |
| `refundedMinor` | bigint ≥ 0 | sum of refunds, ≤ `amountMinor` |
| `orderVersion` | int | highest applied; lower versions discarded |
| `paidAt`, `createdAt`, `updatedAt` | timestamptz | `paidAt` from payload, never `now()` |

Transitions: `(none) → CONFIRMED` on `order.paid` with attribution (emit `link.converted`); `CONFIRMED → CONFIRMED` partial refund (`refundedMinor` raised); `CONFIRMED → REVERSED` when `refundedMinor ≥ amountMinor` (emit `link.conversion_reversed`); `PENDING_REFUND → CONFIRMED|REVERSED` when the paid event arrives. A failed/cancelled order never reaches the table (no `order.paid`).

Events (outbox, topic `links.events`, key = link code, schema version 1): `link.converted {conversionId, linkCode, amountMinor, currency, paidAt}`, `link.conversion_reversed {conversionId, linkCode, refundedMinor, amountMinor}`. No buyer id, order id or key.

Read: `GET /links/:code/conversions` (owner only, paged, rows `conversionId, paidAt, amountMinor, currency, status, refundedMinor`); `GET /links/:code/stats` adds `conversions` (CONFIRMED count) and `convertedMinor` (CONFIRMED amount minus refunded).

## infrastructure

`CANONICAL_CONSUMER_GROUPS` gains eight aliases (research D6); no group renamed.

## Journey kit (test code, no storage)

`engagementFixture`, `storefrontDouble`, `waitForContract` rows H1–H16: see `contracts/journey-kit.md`.
