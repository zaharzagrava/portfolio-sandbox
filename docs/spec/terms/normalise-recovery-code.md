---
id: normalise-recovery-code
title: normaliseRecoveryCode
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# normaliseRecoveryCode
## Definition
`normaliseRecoveryCode` is the [domain function](identity-domain.md) that turns what the user typed into one standard form before it is compared with a stored [recovery code](mfa-recovery-code.md). Because of it, matching ignores letter case, spaces around the code and a missing hyphen. That way small typing differences do not make a valid code fail. It is in `packages/backend/libs/domains/identity/domain/recovery-code.ts`.

## Example
The stored code is `K7QPM-4XZ2R` (illustrative). These inputs all normalise to the same value and match:
```
"K7QPM-4XZ2R"   "k7qpm-4xz2r"   " k7qpm4xz2r "
```

## Known gaps
- The spec does not say which standard form the function produces (upper or lower case, with or without the hyphen), or what it does with spaces inside the code.
- The spec does not say what the function returns for input that does not have the recovery code shape.
- Not confirmed in the code: that normalisation runs before the input is turned into a [recovery code digest](mfa-recovery-digest.md) for comparison.

## Used by
<!-- used-by:start -->
- [identity-domain](identity-domain.md)
- [mfa-recovery-code](mfa-recovery-code.md)
- [mfa-recovery-digest](mfa-recovery-digest.md)
<!-- used-by:end -->
