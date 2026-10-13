---
id: programmer-error
title: Programmer error
kind: term
status: draft
aliases: [programmer errors]
defined_for: S54-platform-toolkit
rules_hash: 2a0049241edf
---
# Programmer error
## Definition
A programmer error is a failure caused by a bug in the calling code, not by bad client input or an outage. The [platform toolkit](platform-toolkit.md) raises one when a [request context](request-context.md)'s [`shopId`](shop-id-param.md) is already set and code tries to set a different value. The call fails loudly instead of silently changing the shop. Design intent (not stated in the spec): a request must not switch tenant halfway through.

## Example
Inside one request context, code calls set `shopId = "shop-A"` and later set `shopId = "shop-B"` (illustrative values). The second call fails. Setting `"shop-A"` again is allowed by the rule's wording, because it is not a different value.

## Known gaps
- The spec does not say which error type is thrown, or what the client receives. It probably becomes [`500 internal_error`](internal-error.md) through the [problem exception filter](problem-exception-filter.md), but this is not confirmed.
- The spec does not say whether other context values besides `shopId` are protected the same way.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-12
- [platform-toolkit](platform-toolkit.md)
- [problem-exception-filter](problem-exception-filter.md)
- [request-context](request-context.md)
<!-- used-by:end -->
