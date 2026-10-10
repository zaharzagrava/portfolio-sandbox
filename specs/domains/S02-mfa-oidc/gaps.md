# Gaps: current `identity` code versus the S02 spec

Implementation to-do list. Paths are relative to `packages/backend/libs/domains/identity/` unless stated. "→ AS-nn / FR-nn" names the spec item the change satisfies. The code is a draft; the spec and the Interview-Prep notes win. S01-owned gaps (session store, guards, hasher, JWKS, registration) are in `specs/domains/S01-auth-sessions/gaps.md` and are not repeated; this file lists what S02 must change or add.

> **Caveat on the ownership report.** `pnpm --dir packages/backend check:table-ownership` could not be run in this unattended session (the command needs interactive approval) and this task forbids code changes. Section C is therefore reconstructed by searching the code for imports, injections and queries of `FederatedIdentity`, the second-factor columns and the OIDC engine. **Run the check first and reconcile section C with its `MODEL`/`SQL` rows for `identity`** before starting work.

**Baseline run (T001, before any S02 change).** `check:table-ownership`: 87 cross-domain data accesses in 21 domains; the 12 rows "owned by identity" name only `User` / `UserModel` (S01's `UserDirectoryService` follow-up, e.g. tenancy `shop.service.ts`, `tenancy.module.ts`); none names `FederatedIdentity`, `SecondFactor`-style data or `mfa*` columns, so section C below is confirmed (no extra S02 rows). `check:boundaries`: 61 warnings, 0 errors. `check:module-graph`: 9/9. Direct `sequelize.transaction` in `libs/domains/identity`: 1 (`infra/keys/key-rotation.jobs.ts`, S01's, not touched). After the P1 pass: the same numbers (87 / 61 warnings, 0 errors / 9 of 9 / 1), `check:model-registry` green.

Existing coverage: one e2e case, `auth.e2e-spec.ts:141–163` (enrol → confirm → login challenge → replay → recovery code once). There is **no** e2e or unit test of OIDC, account linking, MFA management, throttling of the second factor, or concurrency.

## A. Behaviour the code gets wrong or lacks

### Second factor

| # | Gap | Where | Fix (spec) |
|---|---|---|---|
| A1 | `enroll` sets `mfaEnabledAt: null` and overwrites the secret even when MFA is enabled: an access token alone disables and replaces the factor. | `application/mfa/totp.service.ts:29` | State machine `none/pending/enabled`; pending secret kept apart; enabled → `409 mfa_already_enabled` (FR-001, AS-01–AS-03). |
| A2 | No pending expiry, no status endpoint, no disable, no regenerate. | `api/auth.controller.ts:88–100` (only `mfa/enroll`, `mfa/confirm`) | Add `GET /auth/mfa`, `POST /auth/mfa/recovery-codes/regenerate`, `POST /auth/mfa/disable`; 15-min lazy pending expiry (FR-001, FR-006, FR-023, FR-024, AS-06, AS-09, AS-25–AS-27). |
| A3 | Secret sealed without a context: ciphertext is portable between user rows. | `application/mfa/totp.service.ts:29,49` (`box.seal(secret)`, `box.open`) | Seal/open with context `mfa:<userId>`; one-off re-seal of existing rows (FR-003, AS-01, AS-62). |
| A4 | Replay guard is a cache key with 120 s TTL, read-then-write: racy (two concurrent requests with one code both pass) and lost on flush/restart. | `application/mfa/totp.service.ts:46,56` | Durable monotonic last-accepted step updated by a conditional write in identity's store (FR-010, AS-14, AS-15, AS-24; III.6, III.9). |
| A5 | Recovery codes: 5 random bytes (40 bits) as hex, unkeyed SHA-256, stored in a JSON array; spending is read–filter–write, so two requests can spend one code. | `application/mfa/totp.service.ts:38–39,61–69`; `infra/models/user.model.ts:100` | 10 × 50-bit `XXXXX-XXXXX`, keyed digests, atomic spend via conditional update, remaining count (FR-021, FR-022, AS-11, AS-20, AS-21). |
| A6 | `confirm` and `useRecoveryCode` do `findByPk(userId)` then update (non-atomic, two enrolments racing); confirm can run twice and issue two code sets. | `application/mfa/totp.service.ts:35,62` | Conditional transition `pending → enabled` asserting one affected row (FR-004, AS-07; III.7). |
| A7 | `MfaConfirmDto` only `@MaxLength(6)`: accepts empty and non-digit input; `MfaVerifyDto` accepts any 32-char string and picks TOTP vs recovery by regex. | `api/auth.dto.ts:83–100`, `application/auth-session.service.ts:100` | Strict code DTO (6 digits for TOTP endpoints, 32-char cap for verify), form-based method selection, unknown fields rejected (FR-013, FR-017, AS-05, AS-23). |
| A8 | The challenge (`mfaToken`) is reusable for 5 minutes with unlimited tries, and `purpose: 'mfa'` is checked by hand; `mfa/verify` is limited only by `auth.login.ip`. | `application/auth-session.service.ts:78–103`, `api/auth.controller.ts:50` | Single-use challenge, burned after 3 wrong codes, `auth.mfa.account` + `auth.mfa.ip`, identical `invalid_mfa_challenge`; challenge created through S01 `SessionIssuer.createChallenge({userId, firstFactor})` (FR-011, FR-015, AS-16–AS-19). |
| A9 | Verify returns a generic `401 Invalid code`; no `amr`; no cookie delivery; no origin check. | `application/auth-session.service.ts:85–103`, `api/auth.controller.ts:51–55` | Stable codes, `amr` per FR-012, `delivery` + S01 origin check, `no-store` (AS-12, AS-13). |
| A10 | Failed confirm/disable/regenerate are not counted. | `api/auth.controller.ts:93–100` | Shared per-account failure budget (FR-016, AS-17). |
| A11 | Management routes use `SessionNotRevokedGuard` stacked above `@Firewall()`; confirm returns `400` for a wrong code. | `api/auth.controller.ts:86–100` | `Firewall({ sensitive: true })`; `422 invalid_code` (FR-005, AS-08). |
| A12 | MFA columns live on `User` (`mfaSecretEnc`, `mfaEnabledAt`, `mfaRecoveryCodes`) with no pending/last-step/spent state. | `infra/models/user.model.ts:91–100`; migration `20261001130000-auth-keys-federation-mfa.js:44–46` | Plan decides: new identity-owned table or extra columns (expand/contract, `lock_timeout`, III.11); registry entry for any new table in the same PR (IX.3). |

### Google OIDC and linking

| # | Gap | Where | Fix (spec) |
|---|---|---|---|
| B1 | Start is `GET` and redirects; flow state is not bound to the browser, so a stolen callback link logs a victim into the attacker's account (login CSRF). | `api/auth.controller.ts:108–112`, `infra/oidc/oidc.service.ts:71` | `POST …/start` returning `{authorizationUrl}`, `__Host-oidc-flow` cookie + stored digest (FR-041, FR-042, AS-29, AS-37). |
| B2 | Any callback failure throws a plain `Error` → 500 with the framework's error; no redirect to the web app; no closed error codes. | `infra/oidc/oidc.service.ts:89,91`; `api/auth.controller.ts:114–121` | Catch at the application boundary and map to `302 /login?error=<code>`; never echo provider text (FR-048, AS-37–AS-42). |
| B3 | Callback sets a `Strict` refresh cookie and a readable CSRF cookie with a random unrelated value, no access cookie, no `Referrer-Policy`/`no-store`. | `api/auth.controller.ts:128–135` | Use S01 `SessionIssuer.issue({delivery:'cookie'})` (three `__Host-` cookies, `Lax`), headers per FR-048 (AS-31, AS-33). |
| B4 | Client IP for session metadata trusts `cf-connecting-ip`. | `api/auth.controller.ts:142–147` | S01 trusted-proxy rule (S01 FR-014); S02 callers pass `meta` from the shared helper. |
| B5 | `returnTo` is rewritten to `/` when invalid; regex allows `%` and `?=&`, no length cap, no decode check. | `api/auth.controller.ts:137–140` | `returnTo` grammar of FR-045, rejected with `400` at start, stored server-side (AS-30, AS-34). |
| B6 | Discovery has no timeout, no retry policy, no SSRF guard, no response cap, is cached forever, and does not check issuer equality or `https` endpoints. | `infra/oidc/oidc.service.ts:113–125` | Port + adapter through S54's outbound client: 3 s timeouts, 1 MB cap, SSRF guard, 1 h cache, ≤ 1 reload/30 s, issuer and scheme checks (FR-046, FR-071, AS-41, AS-42, AS-58). |
| B7 | ID-token claims are read without a schema: `email_verified === true` ok, but no `sub` bounds, no e-mail validation, no `azp`, no size cap; the library's algorithm is not asserted. | `infra/oidc/oidc.service.ts:93–110` | Claim reader (pure, `domain/`) + pinned algorithm + `aud`/`azp`/`iss`/`exp`/`nonce` checks (FR-043, FR-044, AS-35, AS-36). |
| B8 | State `GETDEL` happens before the provider-mismatch check but the flow carries no purpose or user; no flow cookie, no callback rate limit (callback has no `@RateLimit`). | `infra/oidc/oidc.service.ts:88–91`; `api/auth.controller.ts:114` | Flow record per FR-042, `auth.oidc.ip` on start, link/start and callback (AS-37, AS-38). |
| B9 | `loginWithOidc` links **by e-mail to any account** (including password-registered, never-verified ones) and leaves the squatter's password, MFA secret and sessions alive. | `application/auth-session.service.ts:136–147` | Link + wipe (password, factor, sessions `account_linked`) in one transaction; events (FR-061, AS-44). |
| B10 | Not transactional: user create and identity create are separate statements; a crash leaves a user without a link; a concurrent first login hits the unique constraint and surfaces as a 500. | `application/auth-session.service.ts:143–144` | One transaction + conflict handling that re-reads the link (FR-064, AS-45). |
| B11 | An enabled factor is bypassed: OIDC login never consults it. | `application/auth-session.service.ts:136–147` | Challenge with first factor `fed`, `__Host-mfa-challenge` cookie, `/login/mfa` redirect (FR-048, FR-063, AS-54, AS-55). |
| B12 | Same-provider conflict is not detected (`UNIQUE(provider, subject)` only); a second subject with the same e-mail links to the same user. | migration `20261001130000-auth-keys-federation-mfa.js:33–42`; `application/auth-session.service.ts:142–144` | Add `UNIQUE(userId, provider)` (expand, `CONCURRENTLY` outside a transaction); refuse with `link_conflict` (FR-064, AS-46, AS-53). |
| B13 | Soft-deleted users are not considered: `findByPk` on a deleted row, then a new user may be created with the same e-mail. | `application/auth-session.service.ts:138–143` | `account_unavailable`, no new account (AS-47). |
| B14 | Dynamic (`shop:`) providers use the same trust path as Google: a tenant's IdP asserting `email_verified: true` for a victim's address links to the victim. | `application/auth-session.service.ts:140–144`; `infra/oidc/oidc.service.ts:52–59` | Trust level per provider; subject-only for registry providers, new account with e-mail `null` (FR-066, AS-56). |
| B15 | No explicit link/unlink/list endpoints; `FederatedIdentity.email` is a copy but `createdAt` is the only metadata. | `api/auth.controller.ts` | `POST /auth/oidc/:provider/link/start`, `GET /auth/identities`, `DELETE /auth/identities/:identityId` with last-login-method guard (FR-065, FR-067, AS-49–AS-52). |
| B16 | No `GET /auth/oidc/providers`; the UI cannot know whether Google is configured. | `api/auth.controller.ts` | Add (FR-049, AS-28). |
| B17 | No events for MFA or linking; no audit lines or metrics. | whole S02 surface | Outbox events, audit lines, counters of AS-59 and the Provides list (FR-090–FR-093, AS-59, AS-64). |
| B18 | Provider client secret and `google_oidc_*` config are optional with no cross-validation; `auth_redirect_base_url` falls back to `backend_host`. | `libs/common/config/api-config.service.ts:313–321`; `infra/oidc/oidc.service.ts:62` | Startup validation: ID without secret fails; redirect base must be https unless localhost (S54 config schema) (FR-040). |

### Layering and tests

| # | Gap | Where | Fix |
|---|---|---|---|
| C0 | `TotpService` injects `User` and `RedisService` directly; `OidcService` (infra) holds Redis, config and protocol logic, and is injected into the controller; `AuthSessionService` injects both models. | `application/mfa/totp.service.ts:21–23`, `api/auth.controller.ts:15,31`, `application/auth-session.service.ts:36–43` | Ports in `domain/` (`SecondFactorRepository`, `FederatedIdentityRepository`, `OidcProviderPort`, `FlowStore`, `Clock`), adapters in `infra/`, injected by token; pure `domain/` modules for the TOTP verifier, recovery codes, return-path validator, claim reader, linking decision (D-6). |
| C1 | Tests: one MFA happy path; none for OIDC, linking, throttling, concurrency, management. | `auth.e2e-spec.ts:141–163` | Split into the e2e files of `test-plan.md`; add `test/fakes/fake-oidc-provider.ts` and fixtures for "enabled factor", "Google link", "password account with sessions"; unit specs of the plan. |
| C2 | Web: `/mfa?token=<mfaToken>` puts the challenge in the URL; no enrolment, security-settings or Google UI; `verifyMfa` posts `{mfaToken, code}` only. | `packages/web/app/(auth)/login/login-form.tsx:53`, `hooks/use-auth.tsx:79–80`, `app/(auth)/mfa/mfa-form.tsx:32–35` | Owned by W01: keep the challenge in memory/route state or the challenge cookie; add enrolment, recovery-code display, Google button, `/login?error=`, `/login/mfa`, identities list (spec Provides list). |

## B. Open debt-register rows naming `identity` or S02

| ID | Rule | Status for S02 | Replacement (IX.7 mechanism) |
|---|---|---|---|
| D-6 | I.2 | Open. S02 part: C0 above (`TotpService`, `OidcService`, `AuthSessionService` import models/redis; controller injects `OidcService`, `TotpService`). | Repository/port tokens in `domain/`, adapters in `infra/`. Not a cross-domain mechanism. |
| D-7 | IX.4 | Open. S02 part: `FederatedIdentityModel` is exported from the barrel (`index.ts:7`). No importer outside identity was found by search, so removal is free. (The `User` model exports belong to S01.) | Remove the export. Any future reader of identities uses an R1 method on an identity export; none is required today. |
| D-8 | X.4 | Open. S02 part: `OidcService` exported from the barrel (`index.ts:24`) and used by tenancy (`tenancy/application/shop-sso.service.ts:4,17,22,36`). | **R1**: `OidcProviderRegistry.registerResolver` / `invalidate` (spec Provides). Tenancy opens its own sealed secret with the exported `SecretBox` (an S01 R1 export) and hands a plain secret to the registry. |
| D-12 | IX.4 | Open for other domains; no raw SQL on `FederatedIdentity` or the second-factor data exists outside identity (search below). The `User` SQL rows are S01's (R1 `UserDirectoryService`). | n/a for S02. |
| D-17 | X.5 | `identity/application/user-utils.service.ts` imports a type from `identity/api/` — S01's. | n/a for S02. |
| D-1–D-5, D-9–D-11, D-13–D-16 | — | Do not name identity or S02. | — |

## C. `check:table-ownership` — identity lines relevant to S02 (reconstructed, see caveat)

Objects S02 owns: `FederatedIdentity` (registry `db/ownership.ts:51` → `domain:identity`), the second-factor data (currently columns on `User`, registry `db/ownership.ts:50`), and any new table the plan adds for the factor or for flow state (registry entry in the same PR, IX.3).

| Where | Kind | What | Replacement |
|---|---|---|---|
| `libs/domains/tenancy/application/shop-sso.service.ts:4,17,22,36` | Barrel import (X.4/D-8, not a table access) | `OidcService.setResolver` and `register` called from tenancy | **R1** `OidcProviderRegistry` (see D-8) |
| `libs/domains/identity/index.ts:7` | MODEL export | `FederatedIdentityModel` in the public barrel | Delete the export (D-7) |
| `libs/domains/identity/index.ts:24` | Infra export | `OidcService` in the public barrel | Delete; export `OidcProviderRegistry` and `SecondFactorService` instead |
| Other domains → `FederatedIdentity` | MODEL/SQL | **No finding** (search for `FederatedIdentity`, `"FederatedIdentity"`, `forFeature` with it outside identity: 0 hits) | Keep at 0 (AS-63) |
| Other domains → `mfaSecretEnc`, `mfaEnabledAt`, `mfaRecoveryCodes` | SQL | **No finding** (0 hits outside identity) | Keep at 0 (AS-63) |
| Other domains → `User` (tenancy, notifications, chat, catalog, orders, payments, seeds) | MODEL/SQL | S01's section C lists them; S02 adds nothing | R1 `UserDirectoryService` (S01) |

After the work: `pnpm --dir packages/backend check:table-ownership --strict` must report **0** findings naming `User`, `FederatedIdentity`, `SigningKey` or any new identity table; `pnpm check:boundaries` must show no identity-related error; `pnpm check:module-graph` stays 9/9.

## D. Order of work

1. Pure units first: TOTP verifier, recovery-code generator/normaliser, return-path validator, claim reader, linking decision (`test-plan.md` Unit column).
2. Agree the S01 additions (`createChallenge({userId, firstFactor})`, `verifyChallenge`, `SessionIssuer.issue` with `amr` and cookie delivery) with S01's implementation; S02 cannot create sessions or challenges without them.
3. Second factor: state machine, durable step guard, recovery codes, throttling, verify, management endpoints; migration (expand/contract) and re-sealing of existing secrets.
4. OIDC engine behind ports: fake provider, flow store and cookie binding, `POST start`, callback outcomes and error redirects, timeouts, SSRF-guarded client.
5. Linking: decision function, transaction with wipe and events, explicit link, list/unlink, unique indexes.
6. Registry for S03 and removal of `OidcService`/`FederatedIdentityModel` from the barrel; update `tenancy/application/shop-sso.service.ts` in S03's PR.
7. Contracts schemas (`mfaStatusSchema`, `mfaEnrollSchema`, `mfaRecoveryCodesSchema`, `oidcProviderSchema`, `oidcStartSchema`, `federatedIdentitySchema`); split and rewrite e2e; UI journeys with W01; record the green run (VII.9).

## Sibling-spec follow-ups

Things S02's work changes that another capability's spec relies on. Their specs are not edited here.

- **S01**: `SessionIssuer.createChallenge` becomes `createChallenge({userId, firstFactor}) → {token, jti}` and `verifyChallenge` returns `{userId, firstFactor, jti}` (S01's `identity-services.md` still shows `createChallenge(userId): Promise<string>`); `LoginService` passes `'pwd'` and returns `token` as `mfaToken`; `UserRecord.mfaEnabled` is removed and `LoginService` asks `SecondFactorService.isSecondFactorEnrolled`; `SecretBox.seal/open` gains the optional `context` (v2, GCM AAD) that S01's spec lists but the code never had, plus `keyedDigest`; `UserRepository` gains `clearPassword(id)`.
- **S01**: cookie delivery, the origin guard and the JSON-only guard (tasks T051–T054) are not built yet; S02's cookie-mode verify and the OIDC callback consume `CredentialCookies.set` and the guards. If S02 lands first it adds the minimal writer `api/credential-cookies.ts` with the contract of S01 FR-050; S01 T053 must adopt that file instead of writing a second one.
- **S01**: the `User.mfaSecretEnc`, `mfaEnabledAt`, `mfaRecoveryCodes` columns become dead after S02's cut-over (data moves to `SecondFactor`/`MfaRecoveryCode`); a later contract migration drops them. `UserModel` consumers in S01's barrel plan must not re-read them.
- **S01**: the S01 password-reset confirm must not touch `SecondFactor` (S02 AS-22); it already does not, keep it that way when `UserRepository` changes.
- **S03**: `OidcService.setResolver/register` no longer exist; tenancy registers `shop:` through `OidcProviderRegistry.registerResolver('shop:', …)` and calls `invalidate('shop:<id>')` after a config change, handing over the plain secret it opened with `SecretBox`. S02 makes the minimal edit in `tenancy/application/shop-sso.service.ts` so the build stays green; S03's spec/tasks must adopt that wiring and own the rest (issuer `https` validation message at configure time, membership provisioning from `identity.user_registered` / `identity.federated_identity_linked`). Shop-IdP logins now create accounts with `email = null` and never link by e-mail (behaviour S03's scenarios must not assume otherwise).
- **S50**: three policies are declared in `identityRatePolicies`: `auth.mfa.ip`, `auth.oidc.ip` by `@RateLimit`, `auth.mfa.account` (`key: 'user'`, failures-only, resetOnSuccess) enforced from code through `RateLimiterService.check/refund/reset` because the subject is known only after the challenge is verified and one budget is shared by four code paths. S50's route-coverage check (SC-007 there) must treat `auth.mfa.account` as code-enforced, like `auth.reset.account`.
- **S54**: `validateOidcConfig` (Google client ID without secret, non-HTTPS redirect base other than localhost) is added to the config rules; the guarded outbound fetch uses `safeRequest` with `SafeUrlOptions` injected by token for the in-process fake provider (hatches stay refused in production).
- **S49**: three small jobs registered by identity: `identity.reseal-mfa-secrets` (one-off), `identity.purge-mfa-challenges` and `identity.purge-expired-pending-mfa` (daily, bounded batches).
- **S28**: new events `identity.mfa_enabled|mfa_disabled|mfa_recovery_code_used|mfa_recovery_codes_regenerated|federated_identity_linked|federated_identity_unlinked` (see `contracts/events.md`); `federated_identity_linked` with `passwordInvalidated: true` is the "your password was removed" mail.
- **W01 / S48**: all items of gap C2; API and web must share one origin for the `__Host-` cookies; `POST …/start` then navigate to `authorizationUrl`; `/login?error=<code>`, `/login/mfa`, `?linked=google`; switch on `code`, never on message text; show `recoveryCodesRemaining: 0` as a prompt to regenerate (legacy recovery codes are not migrated).

- **S01** (added by the P1 pass): S02 landed first, so it created `api/credential-cookies.ts` (`CredentialCookies.set/clear…`, three `__Host-` cookies, `Lax`, `Path=/`; CSRF value = random part + keyed MAC over the session ID), `api/guards/origin.guard.ts` (`OriginGuard`, allowlist = `front_host` origin + `CORS_ALLOWED_ORIGINS`, falls back to `Sec-Fetch-Site`) and `api/guards/json-only.guard.ts` (415 for a body that is not `application/json`). S01 T052–T054 must adopt these files instead of writing a second set, and replace the CSRF value if its signer differs. The old Strict refresh/CSRF cookie code of the OIDC callback is gone.
- **S01** (added): `AuthController` lost `mfa/enroll`, `mfa/confirm`, `mfa/verify` and the OIDC routes (now `MfaController`, `OidcController`, `IdentitiesController`); `AuthSessionService`, `TotpService` and the old MFA case in `auth.e2e-spec.ts` are deleted; S01's `auth-login.e2e-spec.ts` AS-19 now seeds the factor through the S02 fixture and expects `fa: 'pwd'` in the challenge. The S01 password-reset endpoint is not built yet, so S02 AS-22 is proven on the one write a reset makes (`replacePasswordHash`); the full-flow check belongs in the S01 reset suite.
- **S54** (added): `openid-client` does not verify the signature of an ID token that came from the token endpoint and its key-set cache (5 min, 60 s reload) cannot be bounded to FR-046; `IdTokenSignatureVerifier` (`infra/oidc/id-token-signature.ts`) checks it against the guarded key-set fetch (1 h cache, one reload per 30 s). Recorded as the R-09 outcome in research.md. New optional config key `GOOGLE_OIDC_ISSUER` (default `https://accounts.google.com`).

## Deferred until a later pass

The P1 pass (Setup, Foundational, US1, US2, US4, US5, US6) is done. Not started, by the priority limit:

| Story | Scenarios | Waits for |
|---|---|---|
| US3 regenerate recovery codes / disable (P2) | AS-25–AS-27; AS-08 for the two management endpoints that do not exist yet | nothing external; next pass. `SecondFactorService.consumeTotpCode` and `MfaAttemptBudget` already exist for it |
| US7 Google sign-in with an enabled factor (P2) | AS-54, AS-55 | nothing external. **Until then a Google sign-in of a user whose factor is `enabled` ends in `oidc_exchange_failed` with no session** (fail closed: it must not bypass the factor; the challenge cookie and `/login/mfa` redirect arrive with T103) |
| US8 shop identity providers (P2) | AS-56–AS-58 | S03 (`tenancy`) for the final wiring. Until then `OidcProviderRegistry` knows only `google`; `shop:<uuid>` answers `404 oidc_provider_not_found`; `OidcService` stays in the barrel and in `AuthApiModule` only so tenancy's `shop-sso.service.ts` still compiles (T083, T109 not done) |
| US9 observability (P3) | AS-59–AS-62, AS-64 | next pass. Already present: `auth_oidc_login_total{provider,result}` and `auth_oidc_provider_timeout_total`, the six outbox events; not yet: audit lines, `auth_mfa_total` & co |
| US10 ownership (P3) | AS-63 | US8 (tenancy edit before `FederatedIdentityModel` / `OidcService` leave the barrel). Gate numbers today are unchanged from the baseline |
| US11 browser journeys (P3) | AS-65, AS-66 | W01 (`packages/web`) |
| Polish, cross-cutting, convergence | T120–T126 | final pass (quickstart ops artifacts and the three `not run` UNVERIFIED rows are already written and untouched) |

Other leftovers of the P1 pass, for the final pass: `SecondFactorService` lives in `AuthApiModule` (needs the rate limiter and outbox), not in the light `AuthModule`; the burned-challenge cookie is cleared on `invalid_mfa_challenge` but the third wrong code (which burns the challenge while answering `invalid_mfa_code`) does not clear it yet; the `link_email_plain` branch (account that already has a verified-email identity) is proven by the unit grid only, because Google is the one verified-email provider and a second Google subject is a `link_conflict`; `otplib` is no longer imported but is still in `package.json`; `down` of the migration was run (up, down, up) and works.

## Coverage of this file by the plan

Every gap above maps to a section of `plan.md` ("Gap coverage"); constitution debt rows D-6, D-7, D-8 are plan work items (WP-3, WP-6), D-12/D-17 are not S02's. The ownership caveat at the top is handled by plan task "baseline gate run" (WP-0): the reconstruction in section C is reconciled with the real `check:table-ownership` output before any code changes.

## Gate repairs

- **Test integrity (`auth.e2e-spec.ts`, 47 < 57 it()/expect() calls)**: the S01 test "MFA: login returns a challenge; the TOTP code completes it; the same code cannot be replayed" had been deleted when the MFA endpoints moved to S02. It is restored with every assertion kept (challenge, `mfaToken` rejected as an access token, replayed TOTP code refused, recovery code works once then refused). Only the S02 contract changes were adopted: `enroll`/`confirm` now answer 200 (not 201), and the secret is read from the enroll response's `manualEntryKey` because the sealed secret moved to the second-factor table. `check-tests.py integrity` and the spec (9/9) pass; `tsc --noEmit` is clean.
