---
id: safe-http-client
title: safeGet and safeRequest
kind: term
status: draft
aliases: [`saferequest`, outbound http client]
defined_for: transaction-runner
rules_hash: dbf294353281
---
# safeGet and safeRequest
## Definition
`safeGet` and `safeRequest` are the [toolkit](platform-toolkit.md)'s outbound HTTP helpers and are part of [resilient HTTP](resilient-http.md). Like the outbound HTTP client, they refuse to send any request while a [transaction is active](active-transaction.md). Design intent (not stated in the spec): a slow remote call should not hold [locks ↗](../sw-external-terms.md#row-lock) open, and a [rollback ↗](../sw-external-terms.md#database-transaction) cannot undo a call that was already sent.

## Example
[S13](../capabilities/S13-payment-intents.md) must not call the [payment provider](payment-provider.md) inside its [payment scope](transaction-scope.md). If code there called `safeRequest`, the call would be refused. The provider call has to happen after the transaction commits.

## Known gaps
- The spec does not say how a refused call fails (which error it throws).
- The spec does not say how `safeGet` and `safeRequest` differ, apart from what their names suggest.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-17
- [active-transaction](active-transaction.md)
- [payment-provider](payment-provider.md)
- [platform-toolkit](platform-toolkit.md)
- [resilient-http](resilient-http.md)
- [transaction-scope](transaction-scope.md)
- [transactional-decorator](transactional-decorator.md)
<!-- used-by:end -->
