---
id: verify-totp
title: verifyTotp
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# verifyTotp
## Definition
`verifyTotp` is the domain function that decides whether a submitted [MFA code](mfa-code.md) is a valid [TOTP ↗](../sw-external-terms.md#totp) code for a user's secret. It accepts a code only for the current TOTP step or one of its [direct neighbours](direct-neighbour.md), which allows for [clock skew tolerance](clock-skew-tolerance.md). The code's step must also be above the user's [last accepted step](totp-time-step.md). That is how [TOTP replay protection](totp-replay-protection.md) stops a reused or older code from working again.

## Example
The last accepted step for a user is T (illustrative). At login, the user sends a code to the MFA verify endpoint:
- A code for step T+1, within the window around the current time, is accepted and a session is issued.
- A code for step T is still inside the window, but the answer is `401 invalid_mfa_code`, the same as for any other wrong code.

## Known gaps
- Not confirmed in the code: whether `verifyTotp` writes the accepted step itself, or only returns it so the caller can save it with the durable conditional write that S02.R-09 requires.
- The spec does not say whether `verifyTotp` also checks a pending secret during MFA confirm, or which error confirm returns when the code is rejected.

## Used by
<!-- used-by:start -->
- [clock-skew-tolerance](clock-skew-tolerance.md)
- [direct-neighbour](direct-neighbour.md)
- [mfa-code](mfa-code.md)
- [totp-replay-protection](totp-replay-protection.md)
- [totp-time-step](totp-time-step.md)
<!-- used-by:end -->
