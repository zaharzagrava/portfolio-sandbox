---
id: no-active-transaction-error
title: NoActiveTransactionError
kind: term
status: draft
aliases: []
defined_for: outbox-task-queue
rules_hash: e3b0c44298fc
---
# NoActiveTransactionError
## Definition
`NoActiveTransactionError` is the error the [outbox](inbox-table.md) [`append`](outbox-append.md) call raises when the caller has no open [database transaction ↗](../sw-external-terms.md#database-transaction). The outbox only accepts an event inside the same transaction as the state change that caused it. That way the change and its event [commit together or not at all ↗](../sw-external-terms.md#transactional-outbox). Without this check, a change could commit with no event, which the outbox exists to prevent.

## Example
```ts
// illustrative names: [S13](../capabilities/S13-payment-intents.md) code calls append outside any transaction
await outbox.append(paymentStatusChangedEvent);
// → rejects with NoActiveTransactionError; nothing is written
```

## Known gaps
- The spec does not say how `append` detects the caller's transaction (for example, whether it reads it from the [request context](request-context.md) or takes it as an argument).
- The spec does not say whether callers should catch this error or treat it only as a programming bug.

## Used by
<!-- used-by:start -->
- [inbox-table](inbox-table.md)
- [request-context](request-context.md)
<!-- used-by:end -->
