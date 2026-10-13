---
id: second-factor-service
title: SecondFactorService
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# SecondFactorService
## Definition
`SecondFactorService` is an [application service ↗](../sw-external-terms.md#application-service) in the [identity domain](identity-domain.md). The spec cites it as the code behind the rule that [MFA confirm](mfa-confirm.md) is atomic. Under concurrent confirm requests with the same code, only one request moves the factor from [`pending`](mfa-state.md) to `enabled`.

## Example
Two concurrent `POST /auth/mfa/confirm` requests carry the same current code for a user in state `pending`:
```
request A → 200 (factor enabled, [ten recovery codes](mfa-recovery-code.md) returned once)
request B → [409 mfa_not_pending](mfa-not-pending.md)
```
Source: `packages/backend/libs/domains/identity/application/second-factor.service.ts#SecondFactorService`

## Known gaps
- Not confirmed in the code: which other operations this service implements, such as enrol, disable, regenerate or verify. The spec only links it to atomic confirm.
- Not confirmed in the code: how the service makes confirm atomic, for example with a [guarded update](guarded-update.md), a transaction or a lock.

## Used by
<!-- used-by:start -->
- [guarded-update](guarded-update.md)
- [identity-domain](identity-domain.md)
- [mfa-confirm](mfa-confirm.md)
<!-- used-by:end -->
