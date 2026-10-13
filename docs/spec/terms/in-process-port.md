---
id: in-process-port
title: In-process port
kind: term
status: draft
aliases: [port]
defined_for: S32-product-search
rules_hash: 45f1e11383cc
---
# In-process port
## Definition
An in-process port is a service that [S32](../capabilities/S32-product-search.md) exposes to other modules inside the same application. Those modules call it as a direct method call, not as an HTTP request. S32 has two: [`ProductSearchService.search`](product-search-service.md) and [`ProductTitleSuggester.suggestTitles`](product-title-suggester.md). Design intent (not stated in the spec): other modules can reuse search without going through the public route's HTTP layer.

## Example
A module inside the application needs products that match the text "iphone". It calls `ProductSearchService.search` directly instead of sending `GET /products/search`. Another module that needs product title completions calls `ProductTitleSuggester.suggestTitles`.

## Known gaps
- The spec does not say what either port accepts or returns, or whether the result of `search` matches [`productSearchResponseSchema`](product-search-response-schema.md).
- The spec does not say whether the ports apply the same [search visibility](search-visibility.md), [rate limit policy](rate-limit-policy.md) and [search budget](search-budget.md) as `GET /products/search`.
- Not confirmed in the code: no test carries the [scenario ids](acceptance-scenario.md) for the exported services (AS-78, AS-79), and the facts do not explain the "R1" label on `ProductSearchService.search`.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-28
- [S51](../capabilities/S51-realtime-push.md): R-33
- [acceptance-scenario](acceptance-scenario.md)
- [ledger-module](ledger-module.md)
- [ledger-service](ledger-service.md)
- [list-seller-balances](list-seller-balances.md)
- [model-registration](model-registration.md)
- [orm-association](orm-association.md)
- [password-reset-mailer-port](password-reset-mailer-port.md)
- [product-search-service](product-search-service.md)
- [provider-statement](provider-statement.md)
- [rate-limit-policy](rate-limit-policy.md)
- [search-budget](search-budget.md)
- [search-surface](search-surface.md)
- [search-visibility](search-visibility.md)
- [stripe-statement-adapter](stripe-statement-adapter.md)
- [suggest-titles-fuzzy](suggest-titles-fuzzy.md)
- [transactional-mail-module](transactional-mail-module.md)
<!-- used-by:end -->
