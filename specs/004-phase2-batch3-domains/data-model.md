# Data Model: Batch 3

No schema change and no registry entry change. See the registry model in
[batch 1](../002-phase2-domain-restructuring/data-model.md).

## Tables now enforced by model placement

| Domain | Models in `infra/models/` | Other owned tables (raw SQL, no model) |
|---|---|---|
| billing | `Plan`, `Price`, `Subscription`, `Invoice`, `InvoiceLine` | — |
| statements | — | `CommissionRate`, `StatementSnapshot`, `StatementAdjustment`, `AccountingPeriod` |
| auctions | `Auction` | `Bid` (+ monthly partitions) |
| launch-events | `LaunchEvent`, `Booking` | `LiveStream` |
| shop-functions | — | `ShopFunction`, `ShopFunctionVersion`, `ShopFunctionTestCase` |
| asset-library | — | `Asset`, `AssetVersion`, `AssetChunk`, `AssetChange`, `AssetShareLink`, `AssetSyncState`, `DigitalProduct` |
| media | — | `Media`, `Video`, `VideoTask` |
| catalog-sync | — | `ImportJob`, `Integration`, `ExternalLink`, `SyncCursor`, `SyncQuarantine`, `ShopSyncState`, `SyncOperation`, `ShopChangeLog`, `ProductFieldClock` |

**Placement coverage: 30 of 30 models** (28 domain, 2 infrastructure). From here on, every model the
registry spec sees is checked against its owner. The remaining tables are raw SQL, so the future
IX.5 static query check will cover them.

## State machines and pure algorithms that moved into `domain/`

- `billing/domain/periods.ts`, `proration.ts`: anchored billing periods and day-based proration.
- `launch-events/domain/reservoir.ts`: per-viewer comment sampling.
- `media/domain/dag.ts`: transcoding DAG topological order. `hls.ts`: playlists.
- `catalog-sync/domain/hlc.ts`, `merge.ts`: the hybrid logical clock and the per-field merge rules.
- `asset-library/domain/fastcdc.ts`: content-defined chunking.
