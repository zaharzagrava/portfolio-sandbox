---
id: error-code
title: Error code (code member)
kind: term
status: draft
aliases: [code]
defined_for: problem-json-errors
rules_hash: e9c583839224
---
# Error code (code member)
## Definition
The `code` member is a short, stable identifier that every [problem+json ↗](../sw-external-terms.md#problem-json) error body carries. Clients decide how to react by reading `code`, never by parsing `title` or `detail` text. Each code is declared once, with a single definition. If two parts of the system declare the same `code` with different definitions, startup fails and names both of them.

## Example
A checkout fails and the body carries `"code": "conflict"`. [{{cap:W03}}](../capabilities/W03-cart-checkout-orders.md) picks the visible form of that checkout problem from `conflict` alone. It does not read the message wording.

## Known gaps
- The spec does not say what the full list of codes is. Only a few are named, such as [`validation_failed`](validation-failed-error.md), `conflict` and `internal_error`.
- The spec does not say what naming convention codes follow, such as their casing or whether they carry a per-capability prefix.
- The spec does not say whether a `code` may ever be renamed or retired, or how clients are told when that happens.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): B-01
- [W03](../capabilities/W03-cart-checkout-orders.md): R-13, B-17
- [W07](../capabilities/W07-app-shell.md): R-13, B-09
- [cart-empty](cart-empty.md)
- [cell-unavailable](cell-unavailable.md)
- [clamping](clamping.md)
- [conflict-error](conflict-error.md)
- [currency-not-supported](currency-not-supported.md)
- [error-catalogue](error-catalogue.md)
- [error-code-registration](error-code-registration.md)
- [error-state](error-state.md)
- [form-alert](form-alert.md)
- [method-not-allowed](method-not-allowed.md)
- [reindex-in-progress](reindex-in-progress.md)
- [unknown-query-parameter](unknown-query-parameter.md)
<!-- used-by:end -->
