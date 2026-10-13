---
id: durable-conditional-write
title: Durable conditional write
kind: term
status: draft
aliases: [conditional write, durable]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# Durable conditional write
## Definition
A durable conditional write is how [S02](../capabilities/S02-mfa-oidc.md) guards against [TOTP replay](totp-replay-protection.md). It writes the accepted [TOTP step](totp-time-step.md) for a user to persistent storage, but only if a condition on the stored value holds. The condition is that the new step must be above the last accepted step. The record lives in durable storage, not in a cache, so a [cache flush](l2-cache.md) or a restart cannot make a spent code work again. Doing the check and the write as one conditional operation lets only one of several concurrent requests succeed. That concurrency reason is design intent (not stated in the spec).

## Example
A code is accepted at step T (illustrative: step `58200001`). A second login then sends the same code:
```
POST /auth/mfa/verify  → 401 invalid_mfa_code
```
The stored step is not below T, so the write is refused. The answer stays the same after a cache flush and a service restart.

## Known gaps
- Not confirmed in the code: which store, table or column holds the last accepted step, or how the condition is written there.
- The spec does not say whether recovery-code spending and the [atomic confirm](mfa-confirm.md) use the same mechanism. It only requires that each happens once under concurrent requests.

## Used by
<!-- used-by:start -->
- [deliver-order](deliver-order.md)
- [l2-cache](l2-cache.md)
- [mfa-confirm](mfa-confirm.md)
- [mfa-recovery-code-spend](mfa-recovery-code-spend.md)
- [order-status-history](order-status-history.md)
- [payment-already-exists](payment-already-exists.md)
- [totp-replay-protection](totp-replay-protection.md)
- [totp-time-step](totp-time-step.md)
- [version-pointer](version-pointer.md)
<!-- used-by:end -->
