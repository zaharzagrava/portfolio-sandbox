---
id: totp-time-step
title: TOTP time step
kind: term
status: draft
aliases: [step t, time step]
defined_for: S02-mfa-oidc
rules_hash: a8bab9e1a025
---
# TOTP time step
## Definition
A TOTP time step is the fixed window of time during which one TOTP code is valid. The current step number is derived from the clock, and each step produces a different code. `verifyTotp` accepts a code only if it matches the current step or one neighbouring step. It also rejects any step at or below the last step it accepted for that user. Accepting a neighbouring step probably absorbs small clock differences between the phone and the server: design intent (not stated in the spec).

## Example
A user's authenticator app shows `482913` (illustrative) during step T. The server accepts it at login and records T as the last accepted step. Another login that presents `482913` during the same step gets `401 invalid_mfa_code`, because T is not above the stored step.

## Known gaps
- The spec does not say whether the server's clock or a database clock computes the step.
- The spec does not say whether the confirm, disable and regenerate endpoints also move the last accepted step forward, or only login verify does.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-08, B-06
- [durable-conditional-write](durable-conditional-write.md)
- [mfa-code](mfa-code.md)
- [second-factor-model](second-factor-model.md)
- [totp-replay-protection](totp-replay-protection.md)
- [verify-totp](verify-totp.md)
<!-- used-by:end -->
