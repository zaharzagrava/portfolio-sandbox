---
id: identity-domain
title: Identity domain
kind: term
status: draft
aliases: [identity]
defined_for: S01-auth-sessions
rules_hash: 32ad269f51b4
---
# Identity domain
## Definition
The identity domain is the backend module that holds the code for [S01](../capabilities/S01-auth-sessions.md): registration, password login, sessions, [refresh tokens](token-refresh.md), signing keys and [service tokens](service-to-service-token.md). It lives under `packages/backend/libs/domains/identity` and is split into `api`, `application`, `domain` and `infra` folders. Other domains use it through its exported services: `UserDirectoryService`, [`SessionRevocationService`](session-revocation.md), `ServiceTokenService` and [`SecretBox`](secret-box.md). Its events start with the `identity.` prefix, for example `identity.user_registered`. It owns the `User` table.

## Example
Where some S01 pieces sit inside the domain (paths from the spec):
```
identity/api/auth.controller.ts           → POST /auth/register, POST /auth/login
identity/application/refresh.service.ts   → POST /auth/refresh
identity/domain/token-verifier.ts         → verifyAccessToken
identity/infra/keys/key-rotation.jobs.ts  → scheduled signing-key rotation
```

## Known gaps
- The spec does not say whether the [S02](../capabilities/S02-mfa-oidc.md) (MFA and federated login) code also lives in this domain. It only says S01 owns the MFA and federated-identity events that S02 uses.
- The spec does not say whether other domains may read identity tables directly. It only lists the exported services. Going through those services is design intent (not stated in the spec).
- The spec does not say that [`FederatedIdentity`](linked-identity.md) and `SigningKey` are owned by this domain. They are assigned to it by an ownership rule, and only `User` is listed in the facts.

## Used by
<!-- used-by:start -->
- [S10](../capabilities/S10-cart-checkout.md): R-01
- [S48](../capabilities/S48-bff.md): B-17
- [master-key](master-key.md)
- [mfa-recovery-codes-regenerated-event](mfa-recovery-codes-regenerated-event.md)
- [normalise-recovery-code](normalise-recovery-code.md)
- [oidc-provider-registry](oidc-provider-registry.md)
- [registration-service](registration-service.md)
- [second-factor-service](second-factor-service.md)
- [secret-box](secret-box.md)
- [service-to-service-token](service-to-service-token.md)
- [session-expired](session-expired.md)
- [session-revocation-service](session-revocation-service.md)
- [token-refresh](token-refresh.md)
<!-- used-by:end -->
