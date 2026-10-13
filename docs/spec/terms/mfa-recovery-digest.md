---
id: mfa-recovery-digest
title: Recovery code digest
kind: term
status: draft
aliases: [digest]
defined_for: S02-mfa-oidc
rules_hash: fe8dbdea56f4
---
# Recovery code digest
## Definition
A recovery code digest is what the system stores in place of a plain recovery code. It is a [one-way hash ↗](../sw-external-terms.md#one-way-hash), so the codes cannot be read back from the database. The plain codes are shown to the user once, when [the factor is confirmed](mfa-confirm.md) or the codes are regenerated. After that only digests remain. Status responses must never include a digest, just as they never include the secret, the [otpauth URI](otpauth-uri.md) or a code.

## Example
[`GET /auth/mfa`](mfa-management-endpoint.md) returns only the state:
```json
{ "state": "enabled" }
```
It never returns a list of digests. (The response shape is illustrative.)

## Known gaps
- The spec does not say which hash function is used or whether it is [salted or keyed ↗](../sw-external-terms.md#salted-hash).
- Not confirmed in the code: that [`MfaRecoveryCode`](mfa-recovery-code.md) stores one digest per code. The spec only lists the model name and forbids digests in status responses.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-07
- [mfa-confirm](mfa-confirm.md)
- [mfa-state](mfa-state.md)
- [normalise-recovery-code](normalise-recovery-code.md)
- [otpauth-uri](otpauth-uri.md)
<!-- used-by:end -->
