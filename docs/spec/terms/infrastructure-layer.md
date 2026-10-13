---
id: infrastructure-layer
title: Infra layer
kind: term
status: draft
aliases: [infrastructure layer]
defined_for: S05-products
rules_hash: e326e4e02358
---
# Infra layer
## Definition
The infra layer is the folder of a domain that holds the code started by events or schedules, not by HTTP requests or other domains. In the catalog domain it holds the [cache invalidator](cache-invalidator.md), the [shop consumers](event-consumer.md) and the [scheduled product jobs](job.md). It sits beside the `api`, [`application`](application-layer.md) and `domain` folders of the same domain. Keeping this code apart lets business rules stay free of messaging and scheduling details; this is design intent (not stated in the spec).

## Example
Files in `packages/backend/libs/domains/catalog/infra/`:
- `product-cache-invalidator.projector.ts` (`ProductCacheInvalidator`, consumes [`products.events`](products-events-topic.md))
- `shop-consumers.ts` (`ShopStatusConsumer`, consumes `tenancy.shop_status_changed`)
- `product-maintenance.jobs.ts` (`ProductMaintenanceJobs`, runs `products.flush-view-counts` and the stock-operation purge)

## Known gaps
- The spec does not say what each layer may import from the others, for example whether infra code may call `application` services directly.
- Not confirmed in the code: whether every domain uses the same `api` / `application` / `domain` / `infra` folder split. The facts only show it for catalog.

## Used by
<!-- used-by:start -->
- [api-layer](api-layer.md)
- [application-layer](application-layer.md)
- [cache-invalidator](cache-invalidator.md)
- [event-consumer](event-consumer.md)
- [job](job.md)
- [ledger-jobs](ledger-jobs.md)
- [product-maintenance-jobs](product-maintenance-jobs.md)
- [reset-token-jobs](reset-token-jobs.md)
- [stripe-statement-adapter](stripe-statement-adapter.md)
<!-- used-by:end -->
