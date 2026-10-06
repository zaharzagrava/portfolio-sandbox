# Research & Decisions: Phase 2 Batch 3

## R1. Layer placement for this batch's harder files {#r1}

| File | Layer | Why |
|---|---|---|
| `billing/periods.ts`, `proration.ts` | domain | Pure date and money math (`luxon` is a pure library, not a framework or client) |
| `billing/billing-gateway.port.ts` | infra | Despite the name, it imports `StripeService`, so it's an adapter |
| `statements/reporting-pool.ts`, `statement-export.ts` | infra | Raw `pg` pool / `pg-query-stream` |
| `auctions/bid-relay.service.ts`, `place-bid.lua.ts` | infra | Redis stream relay and Lua script |
| `launch-events/admission-ticker.service.ts`, `live/live-ticker.service.ts` | infra | Leased Redis tickers driven by jobs |
| `launch-events/waiting-room.service.ts`, `seat-hold.service.ts` | application | Use cases (they still use Redis and Dynamo directly: D-6) |
| `live/moderation.ts`, `reservoir.ts` | domain | Pure (reservoir sampling, banned-word rules) |
| `shop-functions/contract.ts` | domain | zod contract for the sandbox input and output |
| `shop-functions/sandbox.ts` | infra | `isolated-vm` adapter |
| `assets/fastcdc.ts` | domain | Pure content-defined chunking (`node:crypto` hashing) |
| `media/image-pipeline.ts`, `video/ffmpeg.ts` | infra | `sharp` / `child_process` adapters |
| `video/dag.ts`, `hls.ts` | domain | Pure DAG ordering and playlist generation |
| `catalog-import/rows.ts`, `integrations/provider.port.ts`, `offline-sync/hlc.ts`, `merge.ts` | domain | zod row and provider contracts, hybrid logical clock, merge rules |
| `catalog-import/clamav.ts`, `integrations/*.provider.ts` | infra | clamd socket, Shopify HTTP, fake adapter |

## R2. bis-utils belongs to payments, not orders {#r2}

- **Observation**: the module-graph check failed in payment-processor.
  `payments/payment.module` imported `BisUtilsModule` from the **orders** barrel. That loaded all
  of orders, which loops back to payments through its model and webhook imports.
- **Evidence**: `BisUtilsService` has two methods that return `LedgerAccountId` strings
  (`MERCHANT_<id>`, `USER_<id>`). It imports only payments' ledger types. Its only consumers are
  `PaymentModule` and `PaymentService`.
- **Decision**: move it into `payments` (`payments/bis-utils.module.ts`,
  `payments/application/bis-utils.service.ts`) and correct the domain map row.
- **Rationale**: ledger account identifiers are part of the ledger. The cycle came from wrong
  ownership, so fixing ownership removes it. `forwardRef` was banned and would only have hidden
  the cycle.

## R3. Orders must not depend on catalog-sync {#r3}

- **Observation**: core failed with `CatalogImportModule.providers[1]: undefined`.
  `OrderExportService` imported `IMPORT_QUEUE` from the catalog-sync barrel. So loading orders
  loaded `catalog-import.module`, which needs `OrderExportService` (still mid-load) for its
  provider list.
- **Decision**: replace the import with a local `EXPORT_QUEUE = 'catalog-imports'` in
  `order-export.service.ts`. A comment explains that exports ride catalog-sync's queue until D-10.
  Drop the now-unused `IMPORT_QUEUE` export from the catalog-sync barrel.
- **Rationale**: while catalog-sync still routes export requests and consumes export messages
  (D-10), the legal dependency direction is catalog-sync → orders. The queue name is a deployment
  fact (one SQS queue), not shared logic. Duplicating the literal is the smallest change that
  removes the illegal edge. D-10 will give exports an orders-owned queue and delete the
  duplicate. Behavior is unchanged: the same queue name and the same message.
- **Alternatives considered**:
  - Move the constant into orders and have catalog-sync import it: this puts catalog-sync's own
    queue name in the wrong domain.
  - Inject the queue name as a DI token: this changes provider wiring, which is beyond a move.
  - Lazy `require()` inside the method: this hides the dependency from tools.

## R4. Barrels stay minimal {#r4}

`phase2-entrypoints.ts` appended `BisUtilsModule` / `BisUtilsService` to orders and `IMPORT_QUEUE`
to catalog-sync because of the pre-fix usage. All three were removed by hand once nothing outside
the owning domain used them. Barrels list only what other code needs (batch 1, R3).
