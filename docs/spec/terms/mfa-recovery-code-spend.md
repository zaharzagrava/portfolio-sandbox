---
id: mfa-recovery-code-spend
title: Recovery code spend
kind: term
status: draft
aliases: [spend, spent]
defined_for: S02-mfa-oidc
rules_hash: 03e256aaea9e
---
# Recovery code spend
## Definition
Spending a recovery code marks it as used, so the system never accepts it again. A code is spent when it completes a login at the [verify endpoint](mfa-verify-endpoint.md), and then [`identity.mfa_recovery_code_used`](mfa-recovery-code-used-event.md) is emitted. The rule holds under concurrency: if two requests present the same code at once, only one of them can spend it. A session created with a recovery code has [`rcv` ↗](../sw-external-terms.md#jwt-amr) in its [`amr` ↗](../sw-external-terms.md#jwt-amr).

## Example
Alice sends `K7QPM-4XZ2R` (illustrative) to `POST /auth/mfa/verify` and receives a session with `amr` `["pwd","rcv","mfa"]`. When a second login presents the same code, it is rejected.

## Known gaps
- The spec does not say how a single spend is enforced (for example a [durable conditional write](durable-conditional-write.md), like the TOTP replay guard). That approach is only design intent (not stated in the spec).
- The spec does not say whether disabling MFA with an unspent recovery code spends that code, or whether it emits the used event.
- The spec does not say which error a code that is already spent returns at login. Rule S02.R-13 suggests the same `401 invalid_mfa_code` as any wrong code, but the spec does not state it explicitly.

## Used by
<!-- used-by:start -->
- [durable-conditional-write](durable-conditional-write.md)
- [invalid-mfa-code](invalid-mfa-code.md)
- [mfa-recovery-code-used-event](mfa-recovery-code-used-event.md)
- [mfa-recovery-code](mfa-recovery-code.md)
- [mfa-verify-endpoint](mfa-verify-endpoint.md)
<!-- used-by:end -->
