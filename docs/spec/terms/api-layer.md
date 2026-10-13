---
id: api-layer
title: API layer
kind: term
status: draft
aliases: [`api`, api folder]
defined_for: S05-products
rules_hash: 9c22ce2c1be0
---
# API layer
## Definition
The API layer is the `api` folder of a [domain](domain.md). It holds the HTTP controllers that receive requests and hand them to services in the application layer. It is the HTTP entry point into a domain. [Consumers](event-consumer.md) and [jobs](job.md) come in through the [`infra` folder](infrastructure-layer.md) instead. Keeping HTTP details here means the [use-case code](use-case.md) does not depend on routes or headers. That reason is design intent (not stated in the spec).

## Example
Controllers in `packages/backend/libs/domains/catalog/api/`:
- `product.controller.ts` (`ProductController`): `POST /shops/:shopId/products` and the other member routes
- `public-product.controller.ts` (`PublicProductController`): `GET /products/:productId`, no credentials needed
- `product-batch-read.controller.ts` (`ProductBatchReadController`): `GET /batch/products?ids=` for the [BFF ↗](../sw-external-terms.md#bff)

## Known gaps
- Not confirmed in the code: where a malformed product ID is rejected. S05.R-13 only says this happens before any cache or database access.
- Not confirmed in the code: whether controllers call `parseCreateInput` themselves or leave it to the application service.
- The spec does not say whether every domain has an `api` folder. The facts only show it for catalog.

## Used by
<!-- used-by:start -->
- [application-layer](application-layer.md)
- [balance-controller](balance-controller.md)
- [domain](domain.md)
- [event-consumer](event-consumer.md)
- [infrastructure-layer](infrastructure-layer.md)
- [job](job.md)
- [notification-webhooks-controller](notification-webhooks-controller.md)
- [reconciliation-controller](reconciliation-controller.md)
- [use-case](use-case.md)
<!-- used-by:end -->
