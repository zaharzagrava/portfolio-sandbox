---
id: transaction-conflict
title: transaction_conflict (503)
kind: term
status: draft
aliases: [transaction_conflict]
defined_for: transaction-runner
rules_hash: c13df93fe55e
---
# transaction_conflict (503)
## Definition
`transaction_conflict` is the error a serializable transaction scope returns after its conflict retries run out. The scope retries only on the database's serialization-failure and deadlock error codes. Every other error is rethrown without a retry. It is a 503 because the conflict is temporary. Design intent (not stated in the spec): the client is expected to try again later.

## Example
A serializable scope gets error `40001` on all 3 attempts. The scope stops retrying and responds with:
```json
{ "status": 503, "code": "transaction_conflict" }
```
(illustrative body; the real problem body may contain other members)

## Known gaps
- The spec does not say whether the response includes a retry delay (a `Retry-After` header or `retryAfterSeconds`).
- The spec does not say whether there is a delay or jitter between attempts.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-11
- [serializable-scope](serializable-scope.md)
<!-- used-by:end -->
