---
id: errors-entry
title: Errors entry
kind: term
status: draft
aliases: [errors]
defined_for: bff-aggregate
rules_hash: 90dd8fca533c
---
# Errors entry
## Definition
An errors entry is one item in the response's `errors` list. It describes a section that failed when the response can still be returned without that section. It has three fields: the section's name, an error code, and whether retrying may help. Each such failed section adds exactly one entry, and its section is [`null`](section.md). A section that does not apply adds no entry.

## Example
The [`shop` upstream](upstream.md) did not answer within its own [time limit](page-deadline.md) (the `retryable` value is illustrative):
```json
{ "section": "shop", "code": "UPSTREAM_TIMEOUT", "retryable": true }
```
Other codes include [`BUDGET_EXCEEDED`](page-deadline.md), [`CIRCUIT_OPEN` ↗](../sw-external-terms.md#circuit-breaker), `UPSTREAM_OVERLOADED` and `UPSTREAM_UNAVAILABLE` (the last one is used for GraphQL fields).

## Known gaps
- The spec does not say which codes are `retryable: true` and which are `false`.
- The spec does not say where the `errors` list sits in the page response, or how it relates to the standard GraphQL `errors` array.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): R-03, R-04, B-04
- [bff-aggregate](../concepts/bff-aggregate.md): C-02
- [anonymous-chat-section](anonymous-chat-section.md)
- [budget-exceeded](budget-exceeded.md)
- [chat-unread](chat-unread.md)
- [graphql-errors-array](graphql-errors-array.md)
- [not-found-error](not-found-error.md)
- [page-aggregate](page-aggregate.md)
- [page-deadline](page-deadline.md)
- [required-section](required-section.md)
- [retryable](retryable.md)
- [section-budget](section-budget.md)
- [section](section.md)
- [shop-id-param](shop-id-param.md)
- [upstream-in-flight-limit](upstream-in-flight-limit.md)
- [upstream-timeout](upstream-timeout.md)
- [upstream](upstream.md)
<!-- used-by:end -->
