---
id: graphql-errors-array
title: GraphQL errors array
kind: term
status: draft
aliases: [errors[]]
defined_for: S48-bff
rules_hash: ebf2d1aecd1b
---
# GraphQL errors array
## Definition
`errors[]` is the list of error entries in a [BFF ↗](../sw-external-terms.md#bff) GraphQL response. It is used when some fields could not be resolved but the query as a whole ran. The HTTP status stays 200. Each entry gives the [`path`](graphql-error-path.md) of the failed field and an error code such as [`UPSTREAM_UNAVAILABLE`](upstream-unavailable-field-code.md) or [`BUDGET_EXCEEDED`](budget-exceeded.md). It is a different thing from the product page's [errors entry](errors-entry.md), which uses `{section, code, retryable}`.

## Example
The product batch answers 503:
```json
{ "data": { "products": null, "...": "..." },
  "errors": [{ "path": ["products"], "extensions": { "code": "UPSTREAM_UNAVAILABLE" } }] }
```
The shape and the placement of `code` under `extensions` are illustrative.

## Known gaps
- The spec does not say where the code sits inside an entry, for example under `extensions.code`.
- The spec does not say which rejections come back as HTTP 200 with `errors[]` and which come back as a 4xx status. For example, `INTROSPECTION_DISABLED`, `QUERY_TOO_DEEP` and `QUERY_TOO_COSTLY` are not specified either way. `TOO_MANY_ROOT_FIELDS` is stated as `400`.

## Used by
<!-- used-by:start -->
- [W03](../capabilities/W03-cart-checkout-orders.md): R-05
- [bad-user-input](bad-user-input.md)
- [errors-entry](errors-entry.md)
- [operation-deadline](operation-deadline.md)
- [upstream-unavailable-field-code](upstream-unavailable-field-code.md)
<!-- used-by:end -->
