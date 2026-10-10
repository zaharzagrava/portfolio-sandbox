# Contract: identity exports and internal ports added by S02

Paths relative to `packages/backend/libs/domains/identity/`.

## Barrel `@app/domains/identity`

Added:

```ts
SecondFactorService.isSecondFactorEnrolled(userId: UserId): Promise<boolean>   // true only for state 'enabled'
OidcProviderRegistry.registerResolver(prefix: string, resolver: (providerId: string) => Promise<OidcProviderSettings | undefined>): void
OidcProviderRegistry.invalidate(providerId: string): void
OidcProviderSettings = { issuer: string; clientId: string; clientSecret: string; scope?: string }   // plain secret; the caller opens its own sealed value with SecretBox
// event contracts: MfaEnabled, MfaDisabled, MfaRecoveryCodeUsed, MfaRecoveryCodesRegenerated, FederatedIdentityLinked, FederatedIdentityUnlinked
// rate policies: identityRatePolicies gains auth.mfa.ip, auth.mfa.account, auth.oidc.ip
```

Removed: `FederatedIdentityModel` (D-7), `OidcService` (D-8). The only consumer of `OidcService` (`tenancy/application/shop-sso.service.ts`) is moved to `OidcProviderRegistry` in the same change. `AuthModule` provides and exports `OidcProviderRegistry` and `SecondFactorService` so apps that only check tokens or host tenancy can import them without the HTTP module.

Registration rules (FR-070): empty prefix, `google` and a duplicate prefix throw at registration (startup); resolver output is validated; `trust` is forced to `subject-only`; issuers must be `https` and pass the SSRF guard (otherwise the provider answers as unknown).

## Changed S01 seams (same domain)

```ts
SessionIssuer.createChallenge({ userId, firstFactor: 'pwd' | 'fed' }): Promise<{ token: string; jti: string }>   // typ mfa+jwt, aud mfa, 5 min, claim fa
SessionIssuer.verifyChallenge(token): Promise<{ userId: string; firstFactor: 'pwd' | 'fed'; jti: string }>
SecretBox.seal(plaintext, context?) / open(sealed, context?)          // context = GCM AAD (v2 format); no context = v1, unchanged
SecretBox.keyedDigest(purpose: string, value: string): string          // HMAC-SHA-256, HKDF-derived key
UserRepository.clearPassword(id: string): Promise<boolean>             // conditional on passwordHash IS NOT NULL
UserRecord.mfaEnabled                                                  // removed; LoginService asks SecondFactorService
```

## Domain ports (tokens in `domain/ports/index.ts`; adapters in `infra/`)

| Token | Port | Adapter |
|---|---|---|
| `SECOND_FACTOR_REPOSITORY` | `enrol(userId, sealed, sealVersion, expiresAt)`, `find(userId, now)`, `confirm(userId, step, now, codeDigests)`, `acceptStep(userId, step)`, `replaceCodes(userId, digests)`, `spendCode(userId, digest, now)`, `remainingCodes(userId)`, `disable(userId)`, `deleteAll(userId)`, `reseal(batch)` | `infra/models/second-factor.repository.ts` (Sequelize; joins the CLS transaction) |
| `MFA_CHALLENGE_REPOSITORY` | `reserveAttempt(jti, userId, expiresAt, max)`, `spend(jti, now)`, `purge(before, limit)` | `infra/models/mfa-challenge.repository.ts` |
| `FEDERATED_IDENTITY_REPOSITORY` | `findByProviderSubject`, `findByUser(userId)`, `listForUser`, `insert`, `deleteOwned(id, userId)`, `countLoginMethods(userId)`, `markWipeDone(id)` | `infra/models/federated-identity.repository.ts` |
| `OIDC_FLOW_STORE` | `put(flow, ttlSec)`, `consume(stateDigest): Promise<Flow \| undefined>` (atomic) | `infra/oidc/redis-flow-store.ts` |
| `OIDC_PROVIDER` | `authorizationUrl(...)`, `exchange(...)` returning verified raw claims | `infra/oidc/openid-client.provider.ts` (guarded fetch) |
| `OIDC_NET_OPTIONS` | `SafeUrlOptions` for the guarded fetch (test seam; `{}` in production) | provider in `auth-api.module.ts`, overridden in e2e |
| `CLOCK` (existing) | time source | — |

## Application services

`SecondFactorService` (state, enrol, confirm, verify-for-login, regenerate, disable, `isSecondFactorEnrolled`), `MfaAttemptBudget` (research R-07), `MfaLoginService` (challenge verification, completes the session through `SessionIssuer.issue`), `OidcFlowService` (start/link-start), `OidcCallbackService` (callback outcomes → redirect codes), `OidcLoginService` (resolution + linking transaction), `FederatedIdentityService` (list/unlink). Controllers depend on these only (D-6); none imports a model, Redis or `openid-client`.

## Pure domain modules (unit-tested)

`domain/totp.ts`, `domain/recovery-code.ts`, `domain/return-path.ts`, `domain/id-token-claims.ts`, `domain/link-decision.ts`, `domain/second-factor-state.ts`.
