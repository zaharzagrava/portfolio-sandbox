---
id: mfa-confirm
title: MFA confirm
kind: term
status: draft
aliases: [confirm]
defined_for: S02-mfa-oidc
rules_hash: 45c73eaf6898
---
# MFA confirm
## Definition
Confirm is the step that finishes [enrolment](mfa-enrolment). It is done with `POST /auth/mfa/confirm`. The user sends a current [TOTP code ↗](../sw-external-terms.md#totp) from the [pending secret](mfa-state.md). If the code is valid, the [MFA state](mfa-state) becomes `enabled` and the response returns the [recovery-code set](mfa-recovery-code.md). That response is the only time the recovery codes are ever shown. The step is atomic: when two requests carry the same code at the same time, only one of them succeeds.

## Example
A user in state `pending` sends `{ "code": "123456" }` (illustrative) and gets `200` with ten recovery codes such as `ABCDE-12345` (illustrative). A second request sent at the same moment with the same code gets `[409 mfa_not_pending](mfa-not-pending.md)`. A body with 5 digits, letters or an extra field gets `400 validation_failed`, and nothing changes.

## Known gaps
- The spec does not name the field that carries the code in the request body. The `code` name in the example above is illustrative.
- Not confirmed in the code: whether confirm emits `identity.mfa_enabled`. The event is owned by this capability, but the spec does not say which step publishes it.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-04, R-05, B-02, B-03
- [durable-conditional-write](durable-conditional-write.md)
- [mfa-not-pending](mfa-not-pending.md)
- [mfa-pending-expiry](mfa-pending-expiry.md)
- [mfa-recovery-code](mfa-recovery-code.md)
- [mfa-recovery-digest](mfa-recovery-digest.md)
- [mfa-state](mfa-state.md)
- [second-factor-model](second-factor-model.md)
- [second-factor-service](second-factor-service.md)
- [unknown-body-field](unknown-body-field.md)
<!-- used-by:end -->
