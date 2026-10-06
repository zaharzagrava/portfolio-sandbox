# Data Model: Batch 2

No database schema change and no registry entry change. See the registry model in
[batch 1 data-model](../002-phase2-domain-restructuring/data-model.md).

## Tables now enforced by model placement (registry spec rule 5)

| Domain | Models in `infra/models/` | Other owned tables (raw SQL, no model) |
|---|---|---|
| orders | `BisOrder`, `BisOrderItem`, `ShopOrder`, `StockReservation`, `FlashSale` | `OrderEvent`, `ExportJob` |
| payments | `Payment`, `LedgerEntry` (+ monthly partitions, `LedgerEntry_legacy`), `Payout` | `ReconciliationRun`, `ReconciliationIssue` |
| chat | `ChatChannel`, `ChatChannelMember`, `ChatMessage` | — |
| fulfilment | — | `PickupPoint`, `PickupStock`, `Courier`, `Delivery`, `DeliveryEvent` |
| seller-onboarding | — | `ShopOnboarding`, `ShopDocument`, `DocumentExtraction`, `ReviewTask` |

Placement coverage: 22 of the 30 models in the backend now live in their owning domain or
infrastructure lib (20 domain, 2 infrastructure). The 8 remaining legacy models are `Auction`, `Booking`, `LaunchEvent`, `Plan`,
`Price`, `Subscription`, `Invoice`, and `InvoiceLine` (batches 3–4).

## State machines that moved into `domain/`

- `orders/domain/order-state.ts`: the order status union with guarded transitions (`assertNever`).
- `fulfilment/domain/delivery-state.ts`: REQUESTED → OFFERED → ASSIGNED → PICKED_UP → DELIVERED /
  CANCELLED.

Both are pure (no Nest, ORM, or infrastructure imports), which satisfies I.3.
