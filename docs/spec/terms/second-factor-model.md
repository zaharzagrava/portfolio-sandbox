---
id: second-factor-model
title: SecondFactor model
kind: term
status: draft
aliases: [secondfactor]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# SecondFactor model
## Definition
`SecondFactor` is the [S02](../capabilities/S02-mfa-oidc.md) model that stores a user's second-factor state (`none`, [`pending`](mfa-state.md) or `enabled`). It is the record that enrol, confirm and disable change. The spec names it next to the other S02 models (`MfaRecoveryCode`, `MfaChallengeState`, [`FederatedIdentity`](federated-identity.md)), so [recovery codes](mfa-recovery-code.md) and [challenges](mfa-challenge.md) are kept apart from it. [Confirm](mfa-confirm.md) on this record is atomic, so two confirms racing with the same code produce one winner. Status responses built from it never expose a secret, URI, digest or code.

## Example
A user in state `none` calls `POST /auth/mfa/enroll`, and their `SecondFactor` moves to `pending`. They then call `POST /auth/mfa/confirm` with a current code, and it moves to `enabled`. If two confirm requests with the same code arrive at once, one gets `200` and the other gets [`409 mfa_not_pending`](mfa-not-pending.md).

## Known gaps
- The spec does not say which fields `SecondFactor` holds. [Re-enrolment](mfa-enrolment.md) replaces "the secret" and sets a [pending expiry](mfa-pending-expiry.md), but the spec does not say these are stored on this model.
- The spec does not say whether the last accepted [TOTP step](totp-time-step.md), which must be stored durably for [replay protection](totp-replay-protection.md), is a column of `SecondFactor` or lives somewhere else.
- The spec does not say whether disabling deletes the `SecondFactor` row or keeps it with state `none`. Not confirmed in the code.

## Used by
<!-- used-by:start -->
- [mfa-challenge](mfa-challenge.md)
- [mfa-confirm](mfa-confirm.md)
- [mfa-enrolment](mfa-enrolment.md)
- [mfa-pending-expiry](mfa-pending-expiry.md)
- [mfa-recovery-code](mfa-recovery-code.md)
- [mfa-state](mfa-state.md)
- [totp-replay-protection](totp-replay-protection.md)
- [totp-time-step](totp-time-step.md)
<!-- used-by:end -->
