# Research: S02 design decisions

No `NEEDS CLARIFICATION` remains: `questions.md` defaults are accepted and decide product behaviour (none of its lines was edited by a human). This file records the technical choices the plan adds. Format: Decision / Rationale / Alternatives. Paths are relative to `packages/backend/libs/domains/identity/` (`ID/`) unless stated.

## State of S01 that S02 builds on (read from the code, not the spec)

| S01 seam | State in the repo | Consequence for S02 |
|---|---|---|
| `SessionIssuer.issue({userId, amr, delivery, meta})` | Built. `delivery` is returned in `IssuedSession`; **cookies are set by no one yet** (S01 US6, tasks T051–T054, unchecked). | Callback and cookie-mode verify need S01's cookie helper, CSRF and origin guard. See R-14. |
| `createChallenge(userId): string` / `verifyChallenge(token): {userId}` | Built, no first factor, no `jti` returned. | S02 changes both (same domain): R-04. |
| `UserRecord.mfaEnabled` (from `User.mfaEnabledAt`) read by `LoginService` | Built. | Replaced by `SecondFactorService.isSecondFactorEnrolled` (R-02). |
| `SecretBox.seal/open(value)` | **No `context` parameter** although `SecretSealerPort` declares one. | S02 adds the optional context (R-05) and tells S01 (gaps.md, Sibling-spec follow-ups). |
| `identityRatePolicies` | Built (`auth.login.*`, `auth.reset.*`). | S02 appends three policies (R-07). |
| `TransactionRunner`, `OutboxService`, `IDENTITY_AGGREGATE`, `AuditService`, `MetricsRegistry` | Built. | Used as is. The only direct `sequelize.transaction` in identity is `infra/keys/key-rotation.jobs.ts` (S01's, baseline 1); S02 adds none. |
| `safeRequest` (`@app/infrastructure/net`) | Built: HTTPS-only, allowed ports, SSRF guard, redirect policy, `timeoutMs`, `maxResponseBytes`, test hatches (`allowHttpHosts`, `allowPrivateHosts`, `testTransport`) refused in production. | The platform's outbound client for discovery, key set and token requests (R-09). |

## R-01 Where the second-factor data lives

- **Decision**: two new identity-owned tables, `SecondFactor` (one row per user) and `MfaRecoveryCode` (one row per code), plus `MfaChallengeState` (R-04). The three `User.mfa*` columns stay in place (read by nobody after the cut-over) until a contract migration that is **not** part of this change (listed in tasks.md as deferred, gated on the re-seal job having run in every environment). Registry entries for all three in the same change (IX.3).
- **Rationale**: the state machine needs `pending` secret kept apart from the active one, a pending expiry, a `lastStep`, and per-code spent marks; five more nullable columns on `User` would widen the hottest table and the S01-owned model. A separate row lets `UPDATE … WHERE state = :from` and `lastStep < :step` be single-statement guards (III.6, III.7). A code table makes "spend a code" one conditional `UPDATE … RETURNING` with no JSON read–filter–write (A5).
- **Alternatives**: columns on `User` (couples S01 and S02 migrations, `User` rows rewritten on every accepted step); JSONB column of codes with `jsonb_set` (works but unreadable, no unique index on digests); Redis (violates III.9 for a security invariant, SC-002 requires survival of a flush).

## R-02 `isSecondFactorEnrolled` and the S01 login

- **Decision**: `SecondFactorService.isSecondFactorEnrolled(userId)` reads `SecondFactor.state = 'enabled'` (one indexed read by PK). `LoginService` injects `SecondFactorService` (same domain, no cycle: it depends on the repository port, the sealer, the clock and the outbox, not on `LoginService`). `UserRecord.mfaEnabled` and its `toRecord` mapping are deleted; `SequelizeUserRepository` stops reading `mfaEnabledAt`.
- **Rationale**: one owner for the question; no dual source of truth during the transition.
- **Transition**: the expand migration copies every user with `mfaEnabledAt IS NOT NULL` into `SecondFactor` (state `enabled`, `sealVersion = 0`) so enabled users stay protected the moment the new code runs; code and migration ship together (migrations run as a separate deploy step *before* the new code, III.11, and the old code keeps reading `User.mfa*`, which stays intact: expand-only).

## R-03 State machine and replay guard in the store

- **Decision** (`SecondFactorRepository`, all conditional statements, no read–then–write):
  - enrol: `INSERT … ON CONFLICT ("userId") DO UPDATE SET secretSealed = :new, pendingExpiresAt = :exp, state = 'pending' WHERE "SecondFactor".state <> 'enabled'`; zero rows returned and an existing `enabled` row → `409 mfa_already_enabled`. A `pending` row past its expiry is treated as `none` by every read (lazy expiry, no job) and is overwritten by the next enrol.
  - confirm (one transaction via `TransactionRunner.run`): `UPDATE … SET state = 'enabled', enabledAt = :now, lastStep = :step, pendingExpiresAt = NULL WHERE userId = :u AND state = 'pending' AND pendingExpiresAt > :now AND (lastStep IS NULL OR lastStep < :step)` must affect exactly one row; then insert the 10 code digests; then `OutboxService.append(MfaEnabled)`. Zero rows → re-read to choose `409 mfa_not_pending` (none/expired/enabled) or `422 invalid_code` (the step lost to a replay). Two racing confirms: the second sees zero rows.
  - accept a step (login verify, disable, regenerate, link step-up): `UPDATE … SET lastStep = :step WHERE userId = :u AND state = 'enabled' AND (lastStep IS NULL OR lastStep < :step) RETURNING 1`. No row → `invalid_mfa_code` / `invalid_code`.
  - disable: in one transaction, conditional delete of the `SecondFactor` row `WHERE state = 'enabled'` (asserts one row), delete its codes, append `MfaDisabled`.
- **Rationale**: FR-001, FR-004, FR-010, AS-07, AS-15, AS-24, III.6, III.7. The step column is the single monotonic cursor shared by every code path, so "two challenges, one code" and "a code used for confirm cannot be replayed at login" fall out of one predicate.
- **History row (III.7)**: not added. The state is not an order lifecycle with an audit trail requirement; every transition emits an outbox event (the durable history) and an audit line in the same transaction/commit. Recorded as a deliberate reading of III.7 in the plan's Complexity Tracking.
- **Alternatives**: `SELECT … FOR UPDATE` then compare (two round trips, longer lock); a Redis `SET NX` (cache as truth).

## R-04 Challenge: first factor, single use, attempts

- **Decision**:
  - `SessionIssuer.createChallenge({userId, firstFactor: 'pwd'|'fed'}): Promise<{token, jti}>` puts `fa` (first factor) in the claims; `verifyChallenge(token): Promise<{userId, firstFactor, jti}>`. `LoginService` passes `'pwd'` and returns `token`.
  - State by `jti` lives in `MfaChallengeState(jti PK, userId, attempts, spentAt, expiresAt)` in Postgres, created **lazily** on the first attempt: `INSERT … ON CONFLICT (jti) DO UPDATE SET attempts = attempts + 1 WHERE spentAt IS NULL AND attempts < 3 RETURNING attempts` (no row = spent or burned → `invalid_mfa_challenge`). A correct code later runs `UPDATE … SET spentAt = :now WHERE jti = :j AND spentAt IS NULL` inside the same transaction as the step update (R-03); both must succeed or the transaction rolls back and the answer is the generic wrong-code/challenge error. The session is issued **after** commit (DynamoDB write is network I/O, III.3). A purge job removes rows with `expiresAt < now() - 1 h` (S49, bounded batch).
  - The attempt is reserved *before* the code is compared, so a parallel burst cannot exceed 3 comparisons (`attempts < 3` is evaluated by the store).
- **Rationale**: FR-011, SC-003, AS-14–AS-16. No row is written at login time, so the password-login hot path is unchanged; Postgres gives the single winner that a Redis `GETDEL` also would, but survives a flush (III.9).
- **Alternatives**: eager row per challenge (a write for every MFA login, abandoned challenges leave rows); Redis counters (lost on flush: an attacker flushing is unrealistic, but a restart would reset the 3-try budget); a stateless counter in the token (cannot be single-use).
- **Cross-spec**: S01's signatures change; listed in gaps.md "Sibling-spec follow-ups".

## R-05 Sealing and keyed digests (`SecretBox`)

- **Decision**: `SecretBox.seal(plaintext, context?)` / `open(sealed, context?)`. Without a context the format is today's `v1.<iv>.<tag>.<ct>`; with a context the format is `v2…` and the context is passed as GCM additional authenticated data, so a ciphertext copied to another row (`mfa:<otherUserId>`) fails the tag check. `open` of a `v2` value without the matching context throws. S02 seals with `mfa:<userId>`. New method `SecretBox.keyedDigest(purpose, value): string` = HMAC-SHA-256 under a key derived from the KEK with HKDF (`info = purpose`); S02 uses purpose `mfa-recovery`.
- **Rationale**: FR-003, FR-021, AS-01, AS-62; `SecretSealerPort` already declares the optional context, `SecretBox` simply never implemented it. HKDF keeps the digest key distinct from the encryption key.
- **Re-seal of existing rows**: expand migration copies `User.mfaSecretEnc` into `SecondFactor.secretSealed` with `sealVersion = 0` (opened without context). A one-off S49 job `identity.reseal-mfa-secrets` (bounded batches, conditional `UPDATE … WHERE sealVersion = 0`, idempotent, resumable) opens each secret without context and seals it with `mfa:<userId>`; until it finishes, `SecondFactorService` opens by `sealVersion`. A corrupt or unopenable secret anywhere → generic 500, nothing spent, no session (AS-62).
- **Legacy recovery codes** (40-bit, unkeyed SHA-256) are **not** carried over: they cannot be re-derived into keyed digests. After cut-over a migrated user has `recoveryCodesRemaining: 0` and the status endpoint makes that visible so the UI can ask for regeneration (needs a current TOTP code). Flagged for the human as the one behavioural cost of the BREAKING recovery-code line; the alternative (accepting unkeyed 40-bit digests for a transition) was rejected because it keeps the weak scheme alive indefinitely.
- **Alternatives**: AAD via a separate `v1` field (breaks the S01 signing-key format); an envelope key per user (no KMS in scope).

## R-06 Pure domain modules (no framework, no I/O)

- **Decision**: `ID/domain/`:
  - `totp.ts`: RFC 6238 / RFC 4226 HMAC-SHA-1, 6 digits, 30 s, base32 codec, `verifyTotp({secret, code, nowMs, lastStep?}) → {valid, step}` over steps `t-1, t, t+1`, constant-time compare, strict `^\d{6}$`; `generateSecret()` (160 bits from `crypto.randomBytes`), `otpauthUri({issuer, label, secret})`. `otplib` is no longer imported by identity (the dependency is removed from `package.json` if nothing else imports it, otherwise left).
  - `recovery-code.ts`: 10 codes × 10 symbols from the 32-symbol alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` minus look-alikes (exact alphabet fixed in the file and asserted by the property test), rejection sampling (no modulo bias), `normalise()` (trim, case-fold, optional single hyphen at position 5, nothing else), `format()`.
  - `return-path.ts`, `id-token-claims.ts`, `link-decision.ts` (discriminated union result, `assertNever`), `second-factor-state.ts` (state type and `nextState`), `oidc-errors.ts` (closed callback error codes).
- **Rationale**: VII.5 (unit tests only for pure logic) and FR-010/021/044/045/060; own verifier is ~60 lines and makes the RFC vectors, the ±1 tolerance and the "step greater than last" rule testable without a library's option semantics.
- **Alternatives**: keep `otplib.verify` (hides the matched step behind `afterTimeStep` option; the guard must be in the store anyway).

## R-07 Rate limits (S50 follow-up)

- **Decision**: append to `identityRatePolicies` (`ID/domain/auth-rate-policies.ts`):
  - `auth.mfa.ip`: slidingWindow, 20 / 60 000 ms, `key: 'ip'`, `failMode: 'closed'`; `@RateLimit('auth.mfa.ip')` on `POST /auth/mfa/verify`, `confirm`, `recovery-codes/regenerate`, `disable`.
  - `auth.mfa.account`: slidingWindow, 5 / 900 000 ms, `key: 'user'`, `failMode: 'closed'`, `count: 'failures-only'`, `resetOnSuccess: true`. **Enforced from code**, not through the decorator, because the subject (user ID) is known only after the challenge token is verified (verify) and is the authenticated principal elsewhere, and because one budget is shared by four code paths. A small application service `MfaAttemptBudget` wraps `RateLimiterService`: `take(userId)` = `check('auth.mfa.account', userId)` immediately before a code is compared (a denied check raises the standard `Domain_RateLimitedError` → 429 + `Retry-After`); a wrong code keeps the slot (failures-only); `succeeded(userId)` = `reset(...)`; `refund(userId)` is called when the attempt failed for a reason that says nothing about the code (state guard 409, store error 5xx). The four paths: login verify, confirm, regenerate, disable (plus the step-up of explicit link start). Same pattern as S01 R-04 for `auth.reset.account`.
  - `auth.oidc.ip`: slidingWindow, 30 / 60 000 ms, `key: 'ip'`, `failMode: 'closed'`; on `POST …/start`, `POST …/link/start` and `GET …/callback`.
- **Rationale**: names and numbers fixed by the spec and by S50's follow-up; fail-closed on all three; `Retry-After` comes from the shared error. Throttling per IP runs in the interceptor before body validation (FR-015); the per-account budget is consumed only when a code is actually compared, so a malformed body costs nothing.
- **Alternatives**: `key: 'custom'` resolver reading the challenge (the interceptor would have to verify the token twice).

## R-08 OIDC flow store and browser binding

- **Decision**: `OidcFlowStore` port, Redis adapter in `ID/infra/oidc/`. Key `oidc:flow:<sha256(state)>`, TTL 600 s, value JSON `{provider, purpose, userId?, verifier, nonce, returnPath, cookieDigest}`, consumed with `GETDEL` (atomic single use: AS-38). `state` and the flow cookie value are 256-bit random; the cookie `__Host-oidc-flow` (HttpOnly, Secure, `SameSite=Lax`, `Path=/`, no Domain, Max-Age 600) carries the cookie value; only its SHA-256 is stored. Callback order exactly as FR-043: consume → compare cookie digest (constant time) → provider match → provider `error` parameter → code exchange → ID-token validation.
- **Rationale**: the flow is ephemeral by definition (10 min, one user action), single-use needs an atomic consume; losing it on a Redis restart only makes an in-flight sign-in fail with `oidc_state_invalid` (the user retries), unlike the factor data, which is durable. III.9 is respected: Redis is not the source of truth for any durable fact here.
- **Alternatives**: Postgres row (a write per click on "Continue with Google", purge job); signed state cookie only (not single-use).

## R-09 OIDC engine behind a port, using the platform's guarded client

- **Decision**: `OidcProviderPort` (domain): `authorizationUrl(provider, {state, nonce, challenge, redirectUri}) → string`, `exchange(provider, {callbackParams, verifier, nonce, state, redirectUri}) → ProviderClaims` (raw, unvalidated claims object after signature checks). Adapter `ID/infra/oidc/openid-client.provider.ts` wraps `openid-client` v6 with `customFetch` routed to a `GuardedFetch` built on `safeRequest`: `timeoutMs: 3000`, `maxResponseBytes: 1 MiB`, `followRedirects: false`, `allowedPorts: [443]`, SSRF guard on every request (re-checked on DNS rebinding by the guard itself). Discovery document and key set cached in-process for 1 h; an unknown `kid` triggers at most one reload per 30 s. Retries (≤ 2 extra attempts, full-jitter backoff, only while the 10 s callback budget allows) apply to discovery and key-set GETs only; the token POST has no retry. The adapter checks `issuer` equality with the configured issuer and `https` scheme for every discovered endpoint, pins the algorithm to the discovery's `id_token_signing_alg_values_supported` ∩ {ES256, RS256, PS256, EdDSA} (never `none`/HS*), and asserts `azp` when `aud` has several entries. A domain `claimReader` (R-06) then turns the verified claims into `OidcIdentity {subject, email?, emailVerified}`.
- **Test seam**: the adapter receives `SafeUrlOptions` through the token `OIDC_NET_OPTIONS`; production binds `{}` (and the guard refuses hatches under `NODE_ENV=production`), the e2e app binds `allowHttpHosts` / `allowPrivateHosts` for the in-process fake provider. SSRF cases (AS-58) use the real guard with a stubbed resolver.
- **Verification step in implementation (T-task)**: confirm that `openid-client` 6.8 honours our key-set cache/cooldown through `customFetch`; if its internal JWKS cache cannot be bounded to the 1 h / 30 s rule, validate the ID token with `jose.createRemoteJWKSet({cooldownDuration: 30_000, cacheMaxAge: 3_600_000})` fed by the same guarded fetch, keeping `openid-client` for discovery and the token request. `jose` is added as a devDependency for the fake provider either way (it is already a transitive dependency).
- **R-09 outcome (T002, read from `openid-client` 6.8.8 / `oauth4webapi` 3.8.8)**: (1) `authorizationCodeGrant` validates the ID token's claims but **does not check its signature** when the token came from the token endpoint (OIDC Core 3.1.3.7 allows TLS to stand in); the e2e proved it (a token signed by a foreign key was accepted). (2) Its own key-set cache lives 300 s and reloads at most once per 60 s, which cannot be bounded to FR-046's 1 h / 30 s through `customFetch`. (3) The default clock tolerance is 30 s and is read from the client metadata at construction, not from the `Configuration` afterwards. **Chosen path**: `openid-client` for the authorization URL and the code exchange through the guarded fetch (tolerance 5 s via metadata, algorithm pinned from discovery), plus our own `IdTokenSignatureVerifier` (node `crypto`, key set cached 1 h, one reload per 30 s on an unknown `kid`) instead of `jose`; the discovery document is cached 1 h by the adapter. `jose` is therefore not added.
- **Rationale**: FR-043, FR-044, FR-046, FR-071, B6, B7; D-6 (protocol logic out of the controller path).
- **Alternatives**: hand-rolled protocol (more code to get wrong); `ResilientHttpClient` without the SSRF guard (does not cover FR-071).

## R-10 Providers and the registry for S03

- **Decision**: `OidcProviderRegistry` is provided and exported by **`AuthModule`** (the light module, so tenancy can import it in any app), holds the static `google` entry (from config, trust `verified-email`) and the registered resolvers keyed by prefix; `registerResolver(prefix, resolver)` refuses `''`, `'google'` and a duplicate prefix (throws at registration, i.e. at startup); `invalidate(id)` drops the cached settings and the discovery cache entry (through an `OidcProviderCache` invalidation event on an in-process emitter that the engine listens to). Resolver output is validated (https issuer, non-empty id/secret, optional scope string ≤ 200) and `trust` is set to `subject-only` by the registry; a throwing resolver or invalid output answers as an unknown provider (404) and increments a counter. Settings are cached for 5 min.
- **Tenancy**: the four lines in `tenancy/application/shop-sso.service.ts` that use `OidcService.setResolver/register` are changed to `registry.registerResolver('shop:', …)` / `registry.invalidate('shop:<id>')` **in this change** so the barrel can drop `OidcService` without breaking the build (D-8). This is a code edit in tenancy, not an edit of S03's spec; S03's spec is told through gaps.md.
- **Rationale**: FR-066, FR-070, FR-071, AS-56–AS-58, D-8.

## R-11 Linking transaction and conflict handling

- **Decision**: after the provider exchange (no network inside a transaction), `OidcLoginService.complete(identity, provider)` runs `TransactionRunner.run` with the pure `decideLink({linkExists, linkedUserDeleted, trust, emailVerified, emailMatch: none|plain|federated, sameProviderOtherSubject})` result:
  - `login_existing` → return user.
  - `create_account` → `UserRepository.insertIfAbsent`-style insert with `email` (verified-email) or `null` (subject-only), `passwordHash = null`; insert the link; append `UserRegistered` + `FederatedIdentityLinked`.
  - `link_email_wipe` (e-mail matches a password-registered account with no federated identity) → `UserRepository.clearPassword(id)` (conditional on `passwordHash IS NOT NULL`, new method on the port), `SecondFactorRepository.deleteAll(userId)` (+ `MfaDisabled{reason:'account_linking'}` when it was `enabled`), insert the link, append `FederatedIdentityLinked{linkMethod:'email_match', passwordInvalidated, mfaReset}`; **after commit** `SessionRevocationService.revokeAllForUser(userId, 'account_linked')` (DynamoDB). If the process dies between commit and revoke, the next login through the now-existing link repeats the revocation: the link row carries `wipePending boolean` (expand-only column, default false), set true in the transaction and cleared by a conditional update after `revokeAllForUser` succeeds; the callback never issues a session while it is true and the revoke fails (it answers `oidc_exchange_failed`). This keeps SC-005 true: no pre-link session survives a successful sign-in.
  - `link_email_plain` (e-mail matches an account that already has a verified-email federated identity) → link without the wipe.
  - `refuse` with reason `email_not_verified | link_conflict | account_unavailable`.
  - Unique-violation (`UNIQUE(provider, subject)`, `UNIQUE(userId, provider)`, or `User` e-mail) → re-read once and re-decide; a concurrent first login converges to one account with one link (AS-45).
- **Soft-deleted users**: the lookup of a link joins the user including `deletedAt`; a deleted owner → `account_unavailable`; creating a new user with the address of a soft-deleted one is refused by the same decision (the `lower(email)` unique index already covers soft-deleted rows because it is not partial on `deletedAt`; the decision function maps that conflict to `account_unavailable`).
- **Rationale**: FR-060–FR-064, FR-091, AS-43–AS-48, B9–B13.
- **Alternatives**: revoke inside the transaction (network I/O in a transaction, III.3).

## R-12 Explicit link, list and unlink

- **Decision**: `POST /auth/oidc/:provider/link/start {returnTo?, code?}` requires an authenticated principal (`Firewall({sensitive: true})`); when the factor is `enabled` the current TOTP code is required and consumed through the same step guard and budget (R-03, R-07). The flow record carries `purpose: 'link'` and `userId`. The link callback requires that the principal in the *flow* equals the identity decision input (it does not need the access token again: the flow cookie plus stored `userId` bind it), links regardless of e-mail, issues no session, and redirects to `<returnPath>?linked=google`. `GET /auth/identities` and `DELETE /auth/identities/:identityId` use predicates `WHERE id = :id AND "userId" = :caller` (III.4); unlink runs in a transaction: count the user's login methods (identities + password present), refuse the last one with `409 last_login_method`, delete (a missing row, whether another user's, non-UUID or already deleted, answers `404 identity_not_found`, AS-52), append `FederatedIdentityUnlinked`. A user with a password and one identity may unlink it (password remains a method).
- **Rationale**: FR-065, FR-067, AS-49–AS-52, B15.

## R-13 Challenge delivery for federated logins

- **Decision**: when the resolved user has an enabled factor, the callback creates a challenge `{firstFactor: 'fed'}` and sets `__Host-mfa-challenge` (HttpOnly, Secure, `SameSite=Lax`, `Path=/`, Max-Age 300, no Domain; the `__Host-` prefix forces `Path=/`) and redirects to `<front>/login/mfa?returnTo=<validated>`. `POST /auth/mfa/verify` reads the cookie only when `delivery === 'cookie'`, the body has no `mfaToken`, and the S01 origin check passes; the cookie is cleared on success and on a burned challenge.
- **Rationale**: FR-048, FR-063, AS-54, AS-55; keeps the token out of URLs (questions.md BREAKING).

## R-14 S01 cookie delivery, CSRF and origin check are not built yet

- **Finding**: `SessionIssuer.issue` returns `delivery` but nothing writes `__Host-access` / `__Host-refresh` / `__Host-csrf`; `csrf.guard.ts` exists, `origin.guard.ts`, `json-only.guard.ts` and the cookie writer are S01 tasks T052–T053 (unchecked). The controller still has the old Strict-cookie code for the OIDC callback.
- **Decision**: S02's tasks that need them (cookie-mode verify, callback success, `POST …/start` origin check) are ordered **after** the S01 tasks T052–T054 and consume `CredentialCookies.set(res, issued)` and the origin/JSON guards unchanged. If this change is implemented before S01 US6 lands, the first S02 task of that group creates the minimal writer `ID/api/credential-cookies.ts` with the S01 contract (three `__Host-` cookies, `SameSite=Lax`, values from `IssuedSession`, CSRF token from S01's signer) and records in gaps.md that S01 T053 must adopt it instead of writing its own. The tasks file marks the dependency explicitly.
- **Rationale**: avoids two implementations of the same cookie contract and avoids silently keeping the Strict-cookie callback (B3).

## R-15 Errors, events, audit, metrics

- **Decision**: new `Domain_*` errors in `ID/domain/errors.ts` for every code of FR-100 that S01 does not own (`invalid_mfa_code` 401, `invalid_mfa_challenge` 401, `invalid_code` 422, `mfa_already_enabled|mfa_not_pending|mfa_not_enabled|last_login_method` 409, `identity_not_found` 404, `oidc_provider_not_found` 404, `oidc_provider_unavailable` 503). Callback outcomes are a closed `OidcCallbackError` union mapped to the redirect, never thrown to the filter. Events in `ID/domain/events.ts` via `defineEvent` (names and payloads from the spec; envelope from S01/S53; same `IDENTITY_AGGREGATE`). `AuditEvent` gains the `auth.mfa.*` / `auth.oidc.*` / `auth.identity.*` lines; counters `auth_mfa_total{outcome}`, `auth_oidc_callback_total{outcome}`, `auth_oidc_provider_timeout_total`, `auth_identity_linked_total{method}`, `auth_mfa_challenge_burned_total` in the `MetricsRegistry`. Provider tokens, `code`, `state`, `nonce`, verifier, secrets and recovery codes never reach a logger (a `redact` unit check on the audit field allow-list plus the e2e log capture of AS-60).
- **Rationale**: FR-090–FR-093, FR-100, AS-59–AS-62, AS-64.

## R-16 Configuration validation (S54)

- **Decision**: add a `validateOidcConfig(config)` step in `ApiConfigService`'s startup rules: `google_oidc_client_id` without `google_oidc_client_secret` (or the reverse) fails startup; `auth_redirect_base_url` must be `https:` unless the host is `localhost`/`127.0.0.1`, and the silent fall-back to `backend_host` is removed (when Google is configured the base URL is required). Tunables of the Defaults paragraph (attempt budgets, lifetimes, caps) become config keys with the spec defaults.
- **Rationale**: FR-040, B18.

## R-17 Database arithmetic (III.12)

- New load: one indexed PK read per MFA-enabled password login (`SecondFactor`), one upsert + one transaction per verify attempt, one `INSERT … ON CONFLICT` per challenge attempt. All are single-statement and sub-millisecond; no new pool, no new connection holder. The pool-size × instances arithmetic of S01/S54 is unchanged (no transaction is held across network I/O: provider calls precede the linking transaction, DynamoDB writes follow commit).

## R-18 Web (W01) scope

- **Decision**: S02 delivers the contract schemas in `packages/contracts` and the server side. The web changes in gaps.md C2 (`login-form.tsx:53`, `use-auth.tsx`, `mfa-form.tsx`, enrolment, security settings, Google button, `/login?error=`, `/login/mfa`, identities list) are W01's; the two Playwright journeys (AS-65, AS-66) are written by W01 against the fake provider. S02 only keeps the API stable and lists these in gaps.md.
