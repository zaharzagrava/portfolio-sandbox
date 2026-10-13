---
id: mfa-recovery-code-used-event
title: identity.mfa_recovery_code_used event
kind: term
status: draft
aliases: [identity.mfa_recovery_code_used]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# identity.mfa_recovery_code_used event
## Definition
`identity.mfa_recovery_code_used` is an event owned by [S02 (MFA service)](../capabilities/S02-mfa-oidc.md). Its name says it records that a user [spent](mfa-recovery-code-spend.md) a [recovery code](mfa-recovery-code.md). A recovery code is spent when it completes a login at the [verify endpoint](mfa-verify-endpoint.md), and the resulting session has `rcv` in its [`amr` ↗](../sw-external-terms.md#jwt-amr). A recovery code can be spent only once, even under concurrent requests. Emitting at most one event per spent code would follow from that, but this is design intent (not stated in the spec).

## Example
A user sends `K7QPM-4XZ2R` (illustrative) with their [challenge](mfa-challenge.md) to `POST /auth/mfa/verify`. The session is issued with `amr` `["pwd","rcv","mfa"]` and the code is spent. Going by its name, this is when `identity.mfa_recovery_code_used` is published. If the same code is presented again, it is rejected.

## Known gaps
- The spec does not say when the event is emitted. It lists the event under "Owns" but no rule or behavior names it. Linking it to a verify-time spend comes only from the event's name.
- The spec does not say whether disabling MFA with an unspent recovery code (`POST /auth/mfa/disable`) spends the code or emits this event. AS-25 to AS-27 also have no test with a scenario id.
- The spec does not say what the event payload contains, for example the user, the remaining code count, or the IP. The audit and log-secrecy scenarios (AS-59 onward) have no test with a scenario id.

## Used by
<!-- used-by:start -->
- [mfa-challenge](mfa-challenge.md)
- [mfa-recovery-code-spend](mfa-recovery-code-spend.md)
- [mfa-recovery-code](mfa-recovery-code.md)
- [mfa-verify-endpoint](mfa-verify-endpoint.md)
<!-- used-by:end -->
