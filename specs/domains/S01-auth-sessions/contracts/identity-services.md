# Contract: identity exports (barrel `@app/domains/identity`)

Added: `UserDirectoryService`, `UserSummaryDto`, `SessionRevocationService`, `SessionIssuer`, `ServiceTokenService`, `ServiceAuthGuard`, `AllowedCallers`, `ServicePrincipal`, `AuthenticatedUser`, event contracts (`identity.*` zod schemas), `IdentityOpsModule`, `Firewall`, `User`, `RequestWithUser`, `UserUtilsService`, `SecretBox`, `AuthModule`, `AuthApiModule`, `AuthWorkerModule`, `IdentityTopicsModule`, `identityRatePolicies`, `Role`.

Removed: `UserModel`, `FederatedIdentityModel`, `SigningKeyModel` (last, after consumers moved — WP-12), `AuthService`, `KeyStore`, `OidcService`, `UsersModule`, `UsersDtoModule`, `UserUtilsModule`, `AdminModule`, `CreateUserDto`, `UserRawDto`.

```ts
Firewall({ anonymous?: boolean; roles?: Role[]; sensitive?: boolean })   // no throttle/skipThrottle

UserDirectoryService.getUsersByIds(ids: UserId[]): Promise<Map<UserId, UserSummaryDto>>  // ≤ 500, else TooManyIds; soft-deleted omitted; one read
UserDirectoryService.findByEmail(email: string): Promise<UserSummaryDto | null>          // trims + lower-cases
UserSummaryDto = { id; email: string | null; role; createdAt }

SessionRevocationService.revokeAllForUser(userId, reason): Promise<number>
SessionRevocationService.revokeSession(userId, sessionId, reason): Promise<boolean>      // idempotent, scoped to userId

SessionIssuer.issue({ userId, amr: string[], delivery: 'body'|'cookie', meta }): Promise<IssuedSession>   // same result as login
SessionIssuer.createChallenge(userId): Promise<string>        // typ mfa+jwt, aud mfa, 5 min
SessionIssuer.verifyChallenge(token): Promise<{ userId }>     // throws InvalidToken

ServiceTokenService.mint({ caller, audience, ttlSec? }): Promise<string>                  // svc+jwt, ES256, default 60 s, max 300
ServiceTokenService.exchange({ userAccessToken, caller, audience }): Promise<string>      // act.sub = svc:<caller>, needs live session
@UseGuards(ServiceAuthGuard) @AllowedCallers('worker','billing')                          // audience from config
ServicePrincipal = { kind:'service'; caller; onBehalfOf?: { userId; sessionId } }

SecretBox.seal(plaintext, context?) / open(sealed, context?)   // versioned; context as AAD; current + previous master key
```

Domain ports (internal; tokens in `domain/`): `USER_REPOSITORY`, `SESSION_REPOSITORY`, `SIGNING_KEY_REPOSITORY`, `RESET_TOKEN_REPOSITORY`, `PASSWORD_HASHER`, `SECRET_SEALER`, `BREACH_CHECKER` (`isBreached(password): Promise<boolean>`, 800 ms timeout enforced by the adapter, failure → skip + counter `auth_breach_check_skipped_total`).

Rate-limit policies (`definePolicies('identity', …)`, all `failMode: 'closed'`): `auth.register.ip` 10/h · `auth.login.ip` 20/min · `auth.login.account` 5/15 min failures-only + resetOnSuccess (`key: 'body.email'`) · `auth.refresh.ip` 60/min · `auth.reset.ip` 5/h · `auth.reset.confirm.ip` 10/h · `auth.reset.account` 3/h failures-only + resetOnSuccess (code-enforced, research R-04).
