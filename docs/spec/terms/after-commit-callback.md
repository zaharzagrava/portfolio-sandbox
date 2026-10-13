---
id: after-commit-callback
title: afterCommit callback
kind: term
status: draft
aliases: [`aftercommit`, aftercommit callbacks]
defined_for: transaction-runner
rules_hash: 71eb8de580d7
---
# afterCommit callback
## Definition
An `afterCommit` callback is code registered inside a [transaction scope](transaction-scope.md) that runs only after the transaction [commits ↗](../sw-external-terms.md#database-transaction). Each callback runs once, in the order it was registered. If the scope [rolls back ↗](../sw-external-terms.md#database-transaction), no callback runs. Design intent (not stated in the spec): this keeps [side effects](consumer-effects.md) from happening for writes that were undone.

## Example
Illustrative: a scope registers callback A and then callback B, and then commits. A runs, then B. If the scope throws instead, the transaction rolls back and neither A nor B runs.

## Known gaps
- The spec does not say what happens when an `afterCommit` callback throws, or whether the callbacks after it still run.
- The spec does not say how a callback is registered (which function or object you call).
- The spec does not say whether a callback may make outbound HTTP calls. A transaction is no longer active at that point, but the spec does not confirm the calls are allowed.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-14
- [transaction-runner](../concepts/transaction-runner.md): C-02
- [consumer-effects](consumer-effects.md)
- [membership-removal-source](membership-removal-source.md)
- [payment-succeeded-event](payment-succeeded-event.md)
- [source-of-truth](source-of-truth.md)
- [transaction-scope](transaction-scope.md)
- [transactional-decorator](transactional-decorator.md)
<!-- used-by:end -->
