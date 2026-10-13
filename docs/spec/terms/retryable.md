---
id: retryable
title: retryable
kind: term
status: draft
aliases: [retryable flag]
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# retryable
## Definition
`retryable` is a member of each [errors entry](errors-entry.md) on the product page, next to [`section`](section.md) and [`code`](error-code.md). It tells the client whether asking again later might fill the failed section. It is only a hint to the client. The [BFF ↗](../sw-external-terms.md#bff) never retries an [optional section](required-section.md) itself, because only the [product call](product-page-endpoint.md) is retried.

## Example
```json
{ "section": "recommendations", "code": "UPSTREAM_TIMEOUT", "retryable": true }
```
(The `retryable` value is illustrative.)

## Known gaps
- The spec does not say which error codes (`UPSTREAM_TIMEOUT`, `BUDGET_EXCEEDED`, `CIRCUIT_OPEN`, `UPSTREAM_OVERLOADED`) have `retryable` set to true or false.
- The spec does not say whether `retryable` is always a boolean.

## Used by
<!-- used-by:start -->
- [errors-entry](errors-entry.md)
- [product-page-endpoint](product-page-endpoint.md)
- [required-section](required-section.md)
<!-- used-by:end -->
