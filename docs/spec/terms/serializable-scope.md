---
id: serializable-scope
title: Serializable scope
kind: term
status: draft
aliases: [serializable]
defined_for: transaction-runner
rules_hash: 894ed3514ccd
---
# Serializable scope
## Definition
A serializable scope is a [transaction scope](transaction-scope.md) that automatically retries the work when the database reports a [serialization failure ↗](../sw-external-terms.md#postgres-serialization-errors) or a [deadlock ↗](../sw-external-terms.md#deadlock). It retries only those two error codes and allows a fixed number of attempts in total. Any other error is rolled back and rethrown unchanged, as in any other scope. If the last attempt still conflicts, the scope stops retrying and returns [transaction_conflict](transaction-conflict.md). [Statement and lock timeouts](transaction-timeouts.md) still apply to each attempt.

## Example
These values are illustrative. Attempt 1 fails with `40001` (serialization failure), attempt 2 fails with `40P01` (deadlock) and attempt 3 fails with `40001`. All attempts are used up, so the caller gets `503 transaction_conflict`. If attempt 1 had failed with any other error code, the scope would not retry. It would roll back and rethrow that error unchanged.

## Known gaps
- The spec does not say how code asks for a serializable scope instead of a normal one.
- The spec does not say whether a retry waits between attempts.
- The spec does not say which capabilities actually use a serializable scope.

## Used by
<!-- used-by:start -->
- [S54](../capabilities/S54-platform-toolkit.md): R-15, B-06
- [max-owned-shops](max-owned-shops.md)
- [order-settlement](order-settlement.md)
- [transaction-conflict](transaction-conflict.md)
- [transaction-scope](transaction-scope.md)
- [transaction-timeouts](transaction-timeouts.md)
- [transactional-decorator](transactional-decorator.md)
<!-- used-by:end -->
