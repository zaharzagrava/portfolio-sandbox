---
id: mfa-recovery-code-regenerate
title: Recovery code regenerate
kind: term
status: draft
aliases: [regenerate]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# Recovery code regenerate
## Definition
Regenerate swaps the user's whole [recovery code set](mfa-recovery-code.md) for a new one through `POST /auth/mfa/recovery-codes/regenerate`. It works only with a [current TOTP code ↗](../sw-external-terms.md#totp), so a recovery code alone cannot produce new recovery codes. It is an [MFA management endpoint](mfa-management-endpoint.md), so it needs a [real session credential](session-cookie.md) and refuses a [challenge token](mfa-challenge-token.md). A successful call emits [`identity.mfa_recovery_codes_regenerated`](mfa-recovery-codes-regenerated-event.md).

## Example
Alice has used most of her recovery codes. She calls `POST /auth/mfa/recovery-codes/regenerate` with the 6-digit code her authenticator app shows now, for example `482913` (illustrative). The old set is replaced by ten new codes in the form `XXXXX-XXXXX`.

## Known gaps
- The spec does not say whether the new codes come back in the response once, as they do at confirm, or how the request body looks.
- The spec does not say whether codes from the old set stop working at the same moment as the new set is stored.
- Not confirmed in the code: the regenerate scenarios (AS-25 to AS-27) have no test with a scenario id.

## Used by
<!-- used-by:start -->
- [mfa-challenge-token](mfa-challenge-token.md)
- [mfa-management-endpoint](mfa-management-endpoint.md)
- [mfa-recovery-code](mfa-recovery-code.md)
- [mfa-recovery-codes-regenerated-event](mfa-recovery-codes-regenerated-event.md)
- [session-cookie](session-cookie.md)
<!-- used-by:end -->
