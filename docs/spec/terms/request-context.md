---
id: request-context
title: Request context
kind: term
status: draft
aliases: [request context and transactions]
defined_for: idempotency-key
rules_hash: e8e4b7de590f
---
# Request context
## Definition
Request context is the per-request data a backend service keeps while it handles one HTTP request. The [platform toolkit](platform-toolkit.md) provides it, and other [capabilities](section.md) reuse it instead of building their own. The toolkit lists it together with [transactions ↗](../sw-external-terms.md#database-transaction), so the two likely work together during request handling. Typical contents are a request id, the caller's [principal](principal.md) and the open transaction (general engineering knowledge). Keeping this data in one shared place makes every service behave the same way. That reason is design intent (not stated in the spec).

## Example
Illustrative only: a [`POST /checkout`](post-checkout.md) handler reads the caller's principal from the request context. It then runs its order writes inside the transaction that the request context holds. The spec does not confirm that [S10](../capabilities/S10-cart-checkout.md) uses the request context.

## Known gaps
- The spec does not say which fields the request context holds or how a handler reads them.
- The spec does not say how the request context and transactions are tied together, for example whether each request opens one transaction.
- The spec does not say which capabilities use the toolkit's request context.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-11, R-12, R-13, B-04
- [job-scheduler-lease](../concepts/job-scheduler-lease.md): C-02
- [configure-http-app](configure-http-app.md)
- [http-pipeline](http-pipeline.md)
- [no-active-transaction-error](no-active-transaction-error.md)
- [platform-toolkit](platform-toolkit.md)
- [principal](principal.md)
- [programmer-error](programmer-error.md)
- [request-id](request-id.md)
- [section](section.md)
- [tenant-setting](tenant-setting.md)
<!-- used-by:end -->
