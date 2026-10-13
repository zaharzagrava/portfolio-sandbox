---
id: mfa-recovery-code
title: Recovery code
kind: term
status: draft
aliases: [recovery codes, set]
defined_for: S02-mfa-oidc
rules_hash: 3b037c31bd15
---
# Recovery code
## Definition
A recovery code is a single-use backup code that replaces a [TOTP code ↗](../sw-external-terms.md#totp) when the user has no access to their [authenticator app ↗](../sw-external-terms.md#totp). A full set is shown only once, when the user finishes setting up the second factor. The user can later replace the whole set with a new one, and doing so needs a current TOTP code. The system tells a recovery code from a TOTP code by its form and does not try both kinds. Matching ignores case, surrounding spaces and a missing hyphen ([`normaliseRecoveryCode`](normalise-recovery-code.md)), and each code can be used only once, even when requests arrive at the same time.

## Example
Alice has the code `K7QPM-4XZ2R` (illustrative). She types ` k7qpm4xz2r ` at verify, and it matches. The session is issued with [`amr` ↗](../sw-external-terms.md#jwt-amr) `["pwd","rcv","mfa"]`, the code is spent, and the event `identity.mfa_recovery_code_used` is emitted.

## Known gaps
- The spec does not say which characters a code can contain, for example whether lookalikes such as `0` and `O` are excluded.
- The scenarios for regenerate and disable, including [step-up ↗](../sw-external-terms.md#mfa-step-up) with a recovery code and concurrent disable (AS-25 to AS-27), have no test with a scenario id.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-10, R-11, B-02, B-07
- [W01](../capabilities/W01-auth-account.md): R-15
- [login-mfa-page](login-mfa-page.md)
- [mfa-already-enabled](mfa-already-enabled.md)
- [mfa-challenge-token](mfa-challenge-token.md)
- [mfa-code](mfa-code.md)
- [mfa-confirm](mfa-confirm.md)
- [mfa-management-endpoint](mfa-management-endpoint.md)
- [mfa-recovery-code-regenerate](mfa-recovery-code-regenerate.md)
- [mfa-recovery-code-spend](mfa-recovery-code-spend.md)
- [mfa-recovery-code-used-event](mfa-recovery-code-used-event.md)
- [mfa-recovery-codes-regenerated-event](mfa-recovery-codes-regenerated-event.md)
- [mfa-state](mfa-state.md)
- [mfa-verify-endpoint](mfa-verify-endpoint.md)
- [normalise-recovery-code](normalise-recovery-code.md)
- [second-factor-model](second-factor-model.md)
- [totp-replay-protection](totp-replay-protection.md)
<!-- used-by:end -->
