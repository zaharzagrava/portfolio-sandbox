---
id: mfa-recovery-codes-regenerated-event
title: identity.mfa_recovery_codes_regenerated event
kind: term
status: draft
aliases: [identity.mfa_recovery_codes_regenerated]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# identity.mfa_recovery_codes_regenerated event
## Definition
`identity.mfa_recovery_codes_regenerated` is an event owned by the [identity domain](identity-domain.md). It records that a user replaced their whole [recovery code set](mfa-recovery-code.md). It belongs to the [regenerate action](mfa-recovery-code-regenerate.md), `POST /auth/mfa/recovery-codes/regenerate`, which works only with a current [TOTP code ↗](../sw-external-terms.md#totp). It is one of four MFA events. The others are `identity.mfa_enabled`, `identity.mfa_disabled` and `identity.mfa_recovery_code_used`.

## Example
A user with an [enabled factor](mfa-state.md) calls `POST /auth/mfa/recovery-codes/regenerate` with the code their authenticator app shows now, for example `482913` (illustrative). The old set is replaced by new codes in the form `XXXXX-XXXXX`, and the system emits `identity.mfa_recovery_codes_regenerated` for that user.

## Known gaps
- The spec does not say what the event payload contains. For example, it does not say whether it carries the user id, the number of codes or a timestamp. It also does not say which consumers subscribe to it.
- The spec does not say whether the event is emitted only when a regenerate succeeds, or also when one fails because of a wrong or missing TOTP code.
- Not confirmed in the code: the regenerate scenarios (AS-25 to AS-27) have no test with a scenario id. No test is known to check that this event is emitted.

## Used by
<!-- used-by:start -->
- [identity-domain](identity-domain.md)
- [mfa-recovery-code-regenerate](mfa-recovery-code-regenerate.md)
- [mfa-recovery-code](mfa-recovery-code.md)
- [mfa-state](mfa-state.md)
<!-- used-by:end -->
