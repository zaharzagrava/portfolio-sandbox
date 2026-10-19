---
id: J04
title: A shop imports its catalog (bulk file and Shopify), products become searchable and available near me, an offline store device sells stock, and the stock change syncs back to Shopify
kind: capability
status: draft
generated_at: 9ff6f5d2
depends_on: [S03, S05, S07, S08, S09, S19, S32, S53]
concepts: [idempotency-key, outbox-task-queue, projection-and-replay, search-index, tenant-shop-rbac, realtime-topic-stream]
models: []
scope:
---
# J04 - Catalog import to search, near me, till sale and Shopify stock sync
## Purpose
A seller fills a shop's catalog from a bulk file or a Shopify store. The products appear in public search and, once stocked at a pickup point, in "available near me". A till in the store (an offline device) sells units: the sale lowers catalog stock, search shows the new availability, and Shopify inventory is lowered to match. This journey proves only the hand-offs between the domains; each domain's own rules are proven by its own capability.

## Entry points
This journey adds no route of its own. It drives the public routes of other capabilities and observes the results through public reads, provider doubles and a control surface. The facts give no route list, so routes are described in words.
- Start, upload, complete and read a bulk import for a shop, with an `Idempotency-Key` on the start. The import runs asynchronously from the queue `catalog-imports` and streams progress and a terminal event over SSE ({{cap:S07}}).
- Connect a Shopify store, with a backfill of its active variants, by a user holding `integrations.manage`. A webhook is the fast path and a scheduled pull is the safety net ({{cap:S08}}).
- Set pickup stock at a pickup point and search "available near me" ({{cap:S19}}).
- A device pushes sales (`delta`, one `opId` per operation) and pulls the change feed with a cursor and the `X-Device-Id` header ({{cap:S09}}).
- Public product search ({{cap:S32}}) shows availability, price and title.
- The admin suspend route for a shop and the shop's imports, integrations, sync and pickup-stock routes for the cross-tenant checks ({{cap:S03}}).
- Consumers in the chain: `search-product-index`, `integrations-stock-push`, `offline-sync-feed` and the pickup-availability index. Events travel through the outbox ({{cap:S53}}).

## Rules
- **J04.R-01** Every product change from an [import](../terms/catalog-import.md), Shopify, a device or a seller MUST reach the catalog through its [exported commands](../terms/exported-command.md), and only the catalog writes [`catalog.product_*` events](../terms/catalog-product-events.md). [proof: J04 AS-22]
- **J04.R-02** Each accepted product change MUST raise [`productVersion`](../terms/product-version.md) by exactly one and emit exactly one event. [proof: J04 AS-22, J04 AS-03]
- **J04.R-03** A change that [changes nothing](../terms/no-op-update.md) MUST emit no event; a repeated import of the same file changes nothing. [proof: J04 AS-02, J04 AS-11]
- **J04.R-04** A retried import start with the same [`Idempotency-Key`](../terms/idempotency-key.md) MUST return the stored result with one effect ({{concept:idempotency-key}}). [proof: J04 AS-02]
- **J04.R-05** An import row without a stock column MUST leave the product quantity untouched. [proof: J04 AS-03]
- **J04.R-06** A rejected file (a ZIP renamed `.csv`) MUST end the import `FAILED` with [`failure.code: unsupported_file_type`](../terms/failure-code.md), MUST send the terminal [SSE ↗](../sw-external-terms.md#server-sent-events) event `failed`, and MUST change no product count or [search total](../terms/search-totals.md). [proof: J04 AS-04]
- **J04.R-07** A duplicate Shopify [webhook ↗](../sw-external-terms.md#webhook-event) delivery MUST have one effect. [proof: J04 AS-06]
- **J04.R-08** A [scheduled pull](../terms/scheduled-pull.md) MUST find a Shopify change that arrived without a webhook. [proof: J04 AS-07]
- **J04.R-09** Public {{concept:search-index}} MUST show every imported or synced product and every later price, title, availability and visibility change. [proof: J04 AS-01, J04 AS-03, J04 AS-05, J04 AS-10]
- **J04.R-10** The [near-me index](../terms/near-me-index.md) MUST follow pickup stock changes and catalog product changes, and MUST show only [visible products](../terms/is-publicly-visible.md) of [active shops](../terms/shop-status.md). [proof: J04 AS-08, J04 AS-09, J04 AS-20]
- **J04.R-11** A [catalog stock](../terms/catalog-stock.md) change MUST NOT change [pickup stock](../terms/pickup-stock.md), and pickup stock MUST NOT hide a catalog stock change. [proof: J04 AS-12]
- **J04.R-12** A [device sale](../terms/device-sale.md) MUST apply exactly once per [`(shopId, opId)`](../terms/stock-operation-id.md); a [replay](../terms/event-replay.md) MUST return the [stored outcome](../terms/idempotency-stored-answer.md) with no second catalog effect and no second Shopify write. [proof: J04 AS-11]
- **J04.R-13** A stock change on a [Shopify-linked](../terms/shopify-link.md) product MUST be written to Shopify as a [conditional absolute write](../terms/conditional-absolute-write.md); a product that is not linked MUST NOT cause a Shopify call. [proof: J04 AS-10, J04 AS-12]
- **J04.R-14** A [Shopify echo](../terms/shopify-echo.md) of the marketplace's own write MUST cause no catalog change, no event and no second write. [proof: J04 AS-10]
- **J04.R-15** When both sides changed stock, the [merge](../terms/stock-three-way-merge.md) MUST equal `local + remote − base`; an impossible (negative) merge MUST set both sides to 0 and open one [conflict](../terms/stock-conflict.md). [proof: J04 AS-14, J04 AS-15]
- **J04.R-16** The catalog MUST accept a sale even when Shopify answers `503`; the next [trigger](../terms/sync-trigger.md) repairs the difference without reversing the sale. [proof: J04 AS-16]
- **J04.R-17** Every [consumer](../terms/event-consumer.md) MUST be [idempotent ↗](../sw-external-terms.md#idempotency) and [version-guarded](../terms/version-guard.md), so a replay reproduces the same observable state with no provider write ({{concept:projection-and-replay}}). [proof: J04 AS-19]
- **J04.R-18** A [paused consumer](../terms/consumer-pause.md) MUST NOT affect the other consumers and MUST reach [`lag: 0`](../terms/consumer-lag.md) after resume. [proof: J04 AS-17, J04 AS-18]
- **J04.R-19** A shop that is not [active](../terms/shop-status.md) MUST leave search and [near-me](../terms/pickup-near-me.md) and MUST stop [imports](../terms/shopify-import.md), [pushes and pulls](../terms/shopify-push-pull.md) ({{concept:tenant-shop-rbac}}). [proof: J04 AS-20]
- **J04.R-20** A route of one shop MUST NOT reach another shop's import, [integration](../terms/shop-integration.md), [device sync](../terms/device-sync.md) or product; the answer is [`404` or `403`](../terms/identical-not-found.md). [proof: J04 AS-21]

## Behaviors
- **J04.B-01** Given shop `SH`, its owner and a [catalog file](../terms/catalog-import-file.md) `F1` of 60 rows, when the owner imports it, then the products appear in [public search](../terms/search-visibility.md). [proof: J04 AS-01]
- **J04.B-02** Given the same start sent again with [key `k1`](../terms/idempotency-key.md), when the [import is re-run](../terms/catalog-import.md), then the [stored result](../terms/idempotency-stored-answer.md) returns and no product changes. [proof: J04 AS-02]
- **J04.B-03** Given file `F2` with rows 001–003 at price `18.00` and no stock column, when it is imported, then 3 products update to [version 2](../terms/product-version.md), [`rowsUpdated: 3`](../terms/import-row-counts.md), [`rowsUnchanged: 57`](../terms/import-row-counts.md), [quantity is untouched](../terms/catalog-stock.md), and search shows the new price. [proof: J04 AS-03]
- **J04.B-04** Given `F3`, a ZIP renamed `.csv`, when the import runs, then it ends [`FAILED`](../terms/import-run-status.md) with [`unsupported_file_type`](../terms/unsupported-file-type.md) and neither the product count nor the [search total](../terms/search-totals.md) moves. [proof: J04 AS-04]
- **J04.B-05** Given a [Shopify store](../terms/shopify-connection.md) with 7 [active variants](../terms/shopify-variant.md) and an owner with [`integrations.manage`](../terms/permission.md), when the owner connects it, then the variants are [backfilled](../terms/shopify-backfill.md) into the catalog and search. [proof: J04 AS-05]
- **J04.B-06** Given a connected store whose price for variant `V1` changes to `21.50`, when the [webhook](../terms/shop-webhook.md) arrives twice, then [the catalog changes once ↗](../sw-external-terms.md#idempotency). [proof: J04 AS-06]
- **J04.B-07** Given a title change in Shopify with no webhook, when the [scheduled pull](../terms/shopify-scheduled-pull.md) runs, then the catalog and search show the new title. [proof: J04 AS-07]
- **J04.B-08** Given product `Pc` with [catalog quantity](../terms/catalog-stock.md) 5 and no [pickup stock](../terms/pickup-stock.md), when the seller stocks a [pickup point](../terms/pickup-point.md), then `Pc` appears in "[available near me](../terms/pickup-near-me.md)". [proof: J04 AS-08]
- **J04.B-09** Given `Pc` stocked at a pickup point, when the catalog product changes, then the [near-me result](../terms/pickup-near-me.md) follows. [proof: J04 AS-09]
- **J04.B-10** Given Shopify-linked `Ps` at quantity 10 and the [push consumer](../terms/shopify-push-consumer.md) at [`lag: 0`](../terms/consumer-lag.md), when a device sells units, then catalog stock, [search availability](../terms/in-stock-filter.md) and [Shopify inventory](../terms/shopify-inventory.md) all drop to the new quantity. [proof: J04 AS-10]
- **J04.B-11** Given the sale of B-10, when the device sends the same [`opId`](../terms/op-id.md) again, then the [stored outcome](../terms/idempotency-stored-answer.md) returns with [no second effect ↗](../sw-external-terms.md#idempotency); a later sale of the remaining units sells the product out. [proof: J04 AS-11]
- **J04.B-12** Given a [CSV product](../terms/csv-product.md) `Pc` ([catalog 5](../terms/catalog-stock.md), [pickup stock](../terms/pickup-stock.md) 4 at `PP1`), when a stock change happens, then no [Shopify write](../terms/shopify-write.md) occurs and the pickup count stays independent. [proof: J04 AS-12]
- **J04.B-13** Given device `D2` that pulled at [cursor `C0`](../terms/pagination-cursor.md) before the sale, when it pulls with `C0` and [`X-Device-Id`](../terms/x-device-id-header.md), then the [feed](../terms/device-feed.md) holds an entry for `Ps` with the new quantity. [proof: J04 AS-13]
- **J04.B-14** Given catalog and Shopify stock 10, when a device sells 2 and Shopify sells 3 before the [push](../terms/stock-push.md), then the [conditional write](../terms/durable-conditional-write.md) "set 8, expected 10" is refused and [the merge gives 5](../terms/stock-merge.md). [proof: J04 AS-14]
- **J04.B-15** Given stock 3 on both sides, when a device sells 3 and Shopify sells 2, then both sides are set to 0 and one [`catalog_sync.stock_conflict_opened`](../terms/catalog-sync-stock-conflict-opened-event.md) is raised. [proof: J04 AS-15]
- **J04.B-16** Given Shopify answering `503`, when a device sells 2 from 10, then the push answers at once with [`quantityAfter 8`](../terms/quantity-after.md) and the next [trigger](../terms/stock-sync-trigger.md) repairs Shopify. [proof: J04 AS-16]
- **J04.B-17** Given [`search-product-index`](../terms/search-product-index-queue.md) [paused](../terms/queue-pause.md), when a device sells all 4 units, then the catalog shows 0 and Shopify is lowered, while search still shows [`inStock: true`](../terms/in-stock-filter.md) until resume. [proof: J04 AS-17]
- **J04.B-18** Given [`integrations-stock-push`](../terms/integrations-stock-push-queue.md) [paused](../terms/queue-pause.md), when three pushes sell 1, 1 and 2, then nothing is written to Shopify while paused and one write follows after resume. [proof: J04 AS-18]
- **J04.B-19** Given a completed run, when the [operator](../terms/operator.md) [replays the topics](../terms/event-replay.md) through the [control surface](../terms/control-surface.md), then [duplicates and old versions](../terms/consumer-outcomes.md) leave the observable state unchanged. [proof: J04 AS-19]
- **J04.B-20** Given an [import](../terms/catalog-import.md) completed but not yet processed, when the admin [suspends the shop](../terms/shop-status.md), then the shop leaves [search](../terms/search-visibility.md) and [near-me](../terms/pickup-near-me.md) and the import does not run. [proof: J04 AS-20]

## Owns
- No tables. The journey owns no queue, topic or event.
- It reads the queue `catalog-imports` and the consumers `search-product-index`, `integrations-stock-push`, `offline-sync-feed` and the pickup-availability consumer, all owned by other capabilities. The local queue configuration is `infra/docker/elasticmq/elasticmq.conf`.
- Configuration: `allowedProviderHosts`, the scanner double and the control surface exist only outside production.

## Decisions
- The journey tests hand-offs only, because each domain rule is already proven by its own capability.
- Every change goes through the catalog's commands, so one writer sets one version and one event per change.
- The catalog accepts a sale without waiting for Shopify, so a Shopify outage does not block the till.
- Shopify receives conditional absolute writes and a three-way merge, so concurrent sales on both sides are not lost.
- Impossible stock clamps to zero and opens a conflict for a human instead of choosing a side.
- Consumers are idempotent and version-guarded, so replays are safe and paused consumers do not block others.
- The journey uses no fixed sleep and restores the clock and resumes consumers even on failure.

## Known gaps
- Proof tests `J04 G-08`, `G-11`, `G-22` and `G-25` carry no description in the facts; no rule here is tied to them.
- The work-order text for AS-01, AS-13, AS-19, AS-20, AS-21, AS-22 and AS-23 is cut off in the facts; their behaviors above state only the visible part.
- The numeric bounds named H3, H7, H8, H10, H11, H12 and H15 are not defined in the facts, so no time limit is stated.
- AS-23 (observability of each hop through public reads) has a test, but no rule above states its details.
- Replayability of the SSE terminal event (FR-016) has no scenario that names it.
- The startup refusal of `allowedProviderHosts`, the scanner double and the control surface in production (FR-018) has no scenario id in the list.
- No `` clause is given: the only file listed has no exported symbols.
- No route list is in the facts, so no route is shown in backticks in Entry points.
- The facts name no status model, so no lifecycle is described.

### Claims the generator could not verify (removed from the rules above)
- code ref `...` (file not found: ...)
