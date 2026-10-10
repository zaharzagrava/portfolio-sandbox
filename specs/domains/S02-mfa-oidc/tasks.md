---
description: "Task list for S02 — TOTP MFA, Google OIDC (PKCE), account linking (domain identity)"
---

# Tasks: S02 — TOTP MFA, Google OIDC (PKCE), Account Linking

**Input**: `specs/domains/S02-mfa-oidc/` — plan.md, spec.md, test-plan.md, gaps.md, questions.md (defaults accepted), research.md, data-model.md, contracts/ (http.md, identity-services.md, events.md), quickstart.md. Constitution: `.specify/memory/constitution.md`.

**Tests**: requested (test-plan.md, constitution VII). Every test-plan row has a failing-test task that comes **before** the code task that satisfies it.

**Paths**: `ID` = `packages/backend/libs/domains/identity`. Run backend commands from `packages/backend`. E2E: `/opt/sdd/repo/scripts/sdd/test-spec.sh <path>` (condensed output; open the full log only if needed). Narrowest test first; the whole identity suite once at the end (T125). If the same test still fails after 5 fix attempts: stop, write blocker + what was tried + hypothesis into `questions.md`.

**Rules that apply to every task**:
- Never use `git checkout/restore/reset/stash/clean`; to undo, edit by hand and keep other changes.
- Transactions: `TransactionRunner.run` / `@Transactional` only. Never add a `sequelize.transaction` (baseline in `.tx.baseline` = 1, S01 `key-rotation.jobs.ts`; do not touch it).
- No network I/O inside a transaction (provider exchange before; DynamoDB issue/revoke after commit).
- Do not edit other capabilities' specs; cross-spec impacts go in gaps.md "Sibling-spec follow-ups" (already written; add a bullet if a task discovers a new one).
- Success criteria no automated test proves (SC-004 latency half, SC-007, SC-008 browser half) stay under "Ops artifacts" in quickstart.md and as `not run` rows in `specs/UNVERIFIED.md` (both already written; T120 re-checks). Never describe them as verified.
- Follow-ups from built specs are requirements: S01 (re-wire onto `SessionIssuer.issue`, `isSecondFactorEnrolled`, link wipe) → T050, T062, T081, T097; S50 (`auth.mfa.ip`, `auth.mfa.account`, `auth.oidc.ip`) → T023, T047.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[US#]**: user story of spec.md (US1 enrol, US2 login with code, US3 regenerate/disable, US4 Google sign-in, US5 callback hardening, US6 linking, US7 Google + factor, US8 shop IdP, US9 observability, US10 ownership, US11 UI journeys)

---

## Phase 1: Setup

- [X] T001 Run `pnpm --dir packages/backend check:table-ownership`, `check:boundaries`, `check:module-graph`; record counts in gaps.md under a new "Baseline run" line and reconcile gaps.md section C with the real `identity` MODEL/SQL rows (the section was reconstructed without running the gate). Confirm `.tx.baseline` = 1 by `grep -rn "sequelize.transaction" ID`.
- [X] T002 Verify research R-09: write a throwaway check (not committed) of whether `openid-client` ^6.8 with `customFetch` honours a 1 h key-set cache and ≤ 1 reload per 30 s on unknown `kid`; append the result and the chosen path (openid-client alone, or `jose.createRemoteJWKSet({cooldownDuration: 30_000, cacheMaxAge: 3_600_000})` fed by the guarded fetch) as an "R-09 outcome" line in `specs/domains/S02-mfa-oidc/research.md`.
- [X] T003 [P] In `packages/backend/package.json` add `jose` as an explicit devDependency (fake-provider signing). Keep `otplib` while `ID/auth.e2e-spec.ts` or any other file imports it (`grep -rn otplib packages/backend/libs packages/backend/apps`); remove it only if nothing imports it after T063. _(done differently: the fake provider signs with `node:crypto`, so `jose` is not needed; `otplib` is no longer imported by any file but stays in package.json so the lockfile does not change)_
- [X] T004 [P] In `packages/contracts/src/auth/` add zod schemas `mfaStatusSchema` (`state: 'none'|'pending'|'enabled'`, `enabledAt?`, `recoveryCodesRemaining?`; no secret, no digests), `mfaEnrollSchema` (`otpauthUri`, `manualEntryKey`), `mfaRecoveryCodesSchema` (`recoveryCodes`: array of exactly 10 strings matching `^[A-Z2-9]{5}-[A-Z2-9]{5}$`), `oidcProviderSchema` (`id`, `displayName`), `oidcStartSchema` (`authorizationUrl`), `federatedIdentitySchema` (`id`, `provider`, `email: string|null`, `linkedAt`); export from the package index. Shapes: `contracts/http.md`.
- [X] T005 [P] Create `packages/backend/test/fakes/fake-oidc-provider.ts`: in-process HTTP server with discovery, key set and token endpoints; signs ID tokens with `jose`; injectable faults (wrong `iss`/`aud`/`azp`/`nonce`/`exp`, `alg` none/HS256, unknown `kid`, 4xx/5xx, oversized body, hung endpoint, discovery issuer mismatch, non-https endpoint); records every request it receives (to assert PKCE `code_verifier`, request count = 1 on timeout, no retry); verifies the PKCE challenge itself.
- [X] T006 [P] Create/extend fixtures in `ID/testing/` (shared helpers): user with a password, user with an enabled factor (secret sealed with `mfa:<userId>`, helper producing RFC 6238 codes from the opened secret), user with a Google link, password account with live sessions, soft-deleted user, frozen-clock helper usage, outbox-row reader, Redis flush helper, log-capture helper.

---

## Phase 2: Foundational (blocks every user story)

**Pure units — failing tests first** (all [P], different files, table-driven `it.each`)

- [X] T007 [P] `ID/domain/totp.spec.ts` (AS-10): RFC 6238 SHA-1 vectors, ±1 step accepted, ±2 refused, a step ≤ `lastStep` refused (replay), malformed input (empty, 5/7 digits, non-digits, whitespace, unicode digits) refused, `otpauthUri` shape, 160-bit secret length.
- [X] T008 [P] `ID/domain/recovery-code.spec.ts` (AS-11): `XXXXX-XXXXX` format, exact alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` minus look-alikes (as fixed in the file), `normalise()` accepts trim/case/optional single hyphen at position 5 and nothing else, plus one `fast-check` property: the 10 codes of a set are unique and only use the alphabet.
- [X] T009 [P] `ID/domain/return-path.spec.ts` (AS-34): grammar of FR-045 — exactly one leading `/`, ≤ 512 chars, no control chars, no backslash, no `//` before or after one round of percent-decoding (`%2f%2f`, `/%5c`), rejects absolute URLs and `javascript:`; invalid is rejected, never rewritten.
- [X] T010 [P] `ID/domain/id-token-claims.spec.ts` (AS-36): `email_verified` honoured only as boolean `true` (`"true"`, `1` → unverified), `sub` non-empty with its length bound, e-mail validated and lower-cased/trimmed, missing e-mail, ID token size cap 8 KB, unknown extra claims ignored.
- [X] T011 [P] `ID/domain/link-decision.spec.ts` (AS-48): `it.each` over the full grid of `{linkExists, linkedUserDeleted, trust: 'verified-email'|'subject-only', emailVerified, emailMatch: none|plain|federated, sameProviderOtherSubject}` → `login_existing | create_account | link_email_wipe | link_email_plain | refuse(email_not_verified|link_conflict|account_unavailable)`; an exhaustiveness check ends in `assertNever`.
- [X] T012 [P] `ID/domain/second-factor-state.spec.ts`: every (state, event) pair of data-model.md "State machine" (`none→pending`, `pending→pending`, `pending→enabled`, `enabled→none`, `pending→none` lazy expiry); every other pair is an illegal transition (409); `assertNever` exhaustiveness.
- [X] T013 [P] Extend `ID/domain/auth-rate-policies.spec.ts` (create if absent): `auth.mfa.ip` = slidingWindow 20 / 60 000 ms `key:'ip'` failMode closed; `auth.mfa.account` = slidingWindow 5 / 900 000 ms `key:'user'` failMode closed, failures-only, `resetOnSuccess`; `auth.oidc.ip` = slidingWindow 30 / 60 000 ms `key:'ip'` failMode closed; all three registered in `identityRatePolicies`.
- [X] T014 [P] Unit spec for `SecretBox` (`ID/infra/crypto/secret-box.spec.ts`, extend if present): `seal(x)` without context stays the v1 format and round-trips; `seal(x,'mfa:<A>')` is v2; `open` with the wrong context, or with none on a v2 value, throws; ciphertext copied to another context fails; `keyedDigest(purpose, value)` is deterministic, differs per purpose and per value, base64url, and differs from plain SHA-256.

**Pure units — code**

- [X] T015 [P] Create `ID/domain/totp.ts` per research R-06: `generateSecret()` (160 bits from `crypto.randomBytes`), base32 codec, `verifyTotp({secret, code, nowMs, lastStep?}) → {valid, step}` over steps `t-1,t,t+1`, strict `^\d{6}$`, constant-time compare, `otpauthUri({issuer,label,secret})`. SHA-1, 6 digits, 30 s.
- [X] T016 [P] Create `ID/domain/recovery-code.ts`: 10 codes × 10 symbols, rejection sampling (no modulo bias), `normalise()`, `format()` → `XXXXX-XXXXX`.
- [X] T017 [P] Create `ID/domain/return-path.ts` implementing the grammar asserted in T009.
- [X] T018 [P] Create `ID/domain/id-token-claims.ts`: pure reader from the raw verified claims object to `{subject, email: string|null, emailVerified: boolean}` or a typed refusal.
- [X] T019 [P] Create `ID/domain/link-decision.ts`: `decideLink(input)` returning a discriminated union, `assertNever` on the unreachable branch.
- [X] T020 [P] Create `ID/domain/second-factor-state.ts`: state type, `nextState(state, event)`, `assertNever`.
- [X] T021 [P] Create `ID/domain/oidc-errors.ts`: closed set of callback error codes `oidc_state_invalid, oidc_denied, oidc_exchange_failed, oidc_token_invalid, oidc_provider_unavailable, email_not_verified, account_unavailable, link_conflict, identity_already_linked` (contracts/http.md) as a union type + guard.
- [X] T022 `ID/infra/crypto/secret-box.ts`: add optional `context` to `seal`/`open` (v2 format, context as GCM AAD; no context = v1 unchanged) and `keyedDigest(purpose, value)` (HMAC-SHA-256, key derived from the KEK with HKDF, `info = purpose`, base64url). Make T014 pass; keep `SecretSealerPort` consistent (gap A3).
- [X] T023 `ID/domain/auth-rate-policies.ts`: append `auth.mfa.ip`, `auth.mfa.account`, `auth.oidc.ip` exactly as in T013 (S50 follow-up). Make that spec pass.
- [X] T024 `ID/domain/events.ts`: add via `defineEvent` (aggregate `identity`, topic key `userId`, version 1) `identity.mfa_enabled {userId}`, `identity.mfa_disabled {userId, reason:'user'|'account_linking'}`, `identity.mfa_recovery_code_used {userId, remaining}`, `identity.mfa_recovery_codes_regenerated {userId}`, `identity.federated_identity_linked {userId, provider, linkMethod:'login'|'email_match'|'explicit', passwordInvalidated, mfaReset}`, `identity.federated_identity_unlinked {userId, provider}`. Identifiers and flags only (no e-mail, secret, code, digest).
- [X] T025 `ID/domain/errors.ts`: add the FR-100 stable `code`s: `mfa_already_enabled`, `mfa_not_pending`, `mfa_not_enabled` (409), `invalid_code` (422), `invalid_mfa_challenge`, `invalid_mfa_code` (401), `origin_not_allowed` (403), `oidc_provider_not_found` (404), `oidc_provider_unavailable` (503), `identity_not_found` (404), `last_login_method` (409), `unsupported_media_type` (415) if absent. Problem body shape unchanged (`type,title,status,detail,instance,requestId`).
- [X] T026 `ID/domain/ports/index.ts`: add tokens and interfaces `SECOND_FACTOR_REPOSITORY`, `MFA_CHALLENGE_REPOSITORY`, `FEDERATED_IDENTITY_REPOSITORY`, `OIDC_FLOW_STORE`, `OIDC_PROVIDER`, `OIDC_NET_OPTIONS` with the method lists of contracts/identity-services.md; add `UserRepository.clearPassword(id): Promise<boolean>` to the port.

**S01 seams (same domain)**

- [X] T027 `ID/application/session-issuer.service.ts`: change to `createChallenge({userId, firstFactor:'pwd'|'fed'}) → {token, jti}` (typ `mfa+jwt`, aud `mfa`, 5 min, claim `fa`) and `verifyChallenge(token) → {userId, firstFactor, jti}`; update `LoginService` (pass `'pwd'`, return `token` as `mfaToken`) and every S01 caller/test that used the old signature (gap A8; S01 sibling bullet already in gaps.md). Run the S01 login e2e file to prove it still passes.
- [X] T028 Implement `UserRepository.clearPassword(id)` in the user repository adapter under `ID/infra/` (sets `passwordHash = NULL` `WHERE id = :id AND "passwordHash" IS NOT NULL`, returns whether a row changed). Only identity touches `User`.
- [X] T029 Check whether S01 T051–T054 landed (`ID/api/credential-cookies.ts`, `ID/api/guards/origin.guard.ts`, a JSON-only guard; at planning time none existed). For each that is missing, create the minimal file with the S01 FR-050 contract: `CredentialCookies.set(res, issued)` writes `__Host-access`, `__Host-refresh`, `__Host-csrf` (`Secure`, no `Domain`, `Path=/`, `SameSite=Lax`, CSRF value from S01's signer, HttpOnly except csrf), `OriginGuard` (403 `origin_not_allowed`, runs before the challenge is consumed), JSON-only guard (415 `unsupported_media_type`, body ≤ 16 KB). Add a bullet to gaps.md "Sibling-spec follow-ups": "S01 T052–T054 must adopt these files instead of writing a second set" (research R-14, gap B3).
- [X] T030 [P] Provide the client-IP helper used for session metadata so S02 callers pass `meta` from the S01 trusted-proxy rule (`req.clientIp`), not `cf-connecting-ip` (gap B4). If S01's helper exists, only wire it; otherwise note the dependency in gaps.md.

**Storage**

- [X] T031 Create `packages/backend/migrations/<ts>-identity-s02-expand.js` (timestamp after `20261010090000-identity-s01-expand.js`) per data-model.md: (1) in a transaction with `SET LOCAL lock_timeout='5s'` create `SecondFactor` (`userId uuid PK`, `state text not null check in ('pending','enabled')`, `secretSealed text not null`, `sealVersion smallint not null default 0`, `pendingExpiresAt timestamptz null`, `enabledAt timestamptz null`, `lastStep bigint null`, `createdAt/updatedAt timestamptz not null`), `MfaRecoveryCode` (`id uuid PK default uuidv7()`, `userId uuid not null`, `digest text not null`, `usedAt timestamptz null`, `createdAt timestamptz not null`, `UNIQUE (userId, digest)`, partial index `(userId) WHERE usedAt IS NULL`), `MfaChallengeState` (`jti uuid PK`, `userId uuid not null`, `attempts smallint not null`, `spentAt timestamptz null`, `expiresAt timestamptz not null`); add `FederatedIdentity.wipePending boolean not null default false`; copy users with `mfaEnabledAt IS NOT NULL AND mfaSecretEnc IS NOT NULL` into `SecondFactor` (`state='enabled'`, `sealVersion=0`, `lastStep=NULL`); do not copy pending enrolments or legacy recovery codes. (2) outside the transaction: duplicate check `GROUP BY "userId","provider" HAVING count(*) > 1` that aborts with the offending pairs in the message and deletes nothing, then `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "FederatedIdentity_user_provider_uq" ON "FederatedIdentity" ("userId","provider")`. (3) `down` drops the new tables and index only. Expand-only; do not touch `User.mfa*` columns.
- [X] T032 [P] `packages/backend/db/ownership.ts`: add `SecondFactor`, `MfaRecoveryCode`, `MfaChallengeState` → `domain:identity` (IX.3, same change).
- [X] T033 Create `ID/infra/models/second-factor.model.ts`, `mfa-recovery-code.model.ts`, `mfa-challenge-state.model.ts` with the column constraints of T031 verbatim; add `wipePending` to the `FederatedIdentity` model and a comment that `email` is a hint (null allowed). Register the models in the identity module.
- [X] T034 Create `ID/infra/models/second-factor.repository.ts` implementing `SECOND_FACTOR_REPOSITORY` (`enrol, find(userId, now), confirm, acceptStep, replaceCodes, spendCode, remainingCodes, disable, deleteAll, reseal`). Every transition is a conditional `UPDATE … WHERE state = :from` asserting one affected row; `acceptStep` = `UPDATE … SET lastStep = :s WHERE userId = :u AND (lastStep IS NULL OR lastStep < :s)`; `spendCode` = `UPDATE … SET usedAt = :now WHERE userId = :u AND digest = :d AND usedAt IS NULL RETURNING id`; `find` treats `pending` past `pendingExpiresAt` as `none`; joins the CLS transaction (no own `sequelize.transaction`). The only code path allowed to read these tables (III.1).
- [X] T035 [P] Create `ID/infra/models/mfa-challenge.repository.ts` implementing `MFA_CHALLENGE_REPOSITORY`: `reserveAttempt(jti,userId,expiresAt,max)` = `INSERT … ON CONFLICT (jti) DO UPDATE SET attempts = attempts + 1 WHERE "spentAt" IS NULL AND attempts < :max RETURNING attempts` (no row = spent or burned); `spend(jti, now)` = `UPDATE … SET "spentAt" = :now WHERE jti = :j AND "spentAt" IS NULL`; `purge(before, limit)` bounded delete.
- [X] T036 [P] Create `ID/infra/models/federated-identity.repository.ts` implementing `FEDERATED_IDENTITY_REPOSITORY` (`findByProviderSubject` joining the user including `deletedAt`, `findByUser`, `listForUser`, `insert` refusing any provider not `google` or `shop:<uuid>` before the insert, `deleteOwned(id, userId)` with `WHERE id = :id AND "userId" = :caller`, `countLoginMethods(userId)`, `markWipeDone(id)` conditional on `wipePending`). Unique violations surface as a typed conflict.
- [X] T037 Wire the new tokens/providers/services in `ID/auth.module.ts` and `ID/auth-api.module.ts` (`OIDC_NET_OPTIONS` provider `{}` in production, overridable in e2e). `AuthModule` exports `SecondFactorService` and `OidcProviderRegistry` once they exist (T046, T108). _(`OidcProviderRegistry` is exported by `AuthModule`; `SecondFactorService` is provided and exported by `AuthApiModule` because it needs the rate limiter and the outbox, which the token-only `AuthModule` does not import)_
- [X] T038 Run `pnpm --dir packages/backend migrate` against the test database (up, down, up) and `tsc --noEmit`; fix until clean. Run the S01 login e2e file to confirm nothing regressed.

**Checkpoint**: pure units green (`pnpm jest libs/domains/identity/domain --testPathIgnorePatterns e2e`), tables exist, repositories compile. User stories can start.

---

## Phase 3: User Story 1 — Turn on an authenticator app (P1) 🎯 MVP

**Goal**: enrol → confirm → recovery codes; state machine `none/pending/enabled`; status endpoint; `isSecondFactorEnrolled`.

**Independent Test**: `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/identity/mfa-enrollment.e2e-spec.ts` green (AS-01–AS-09) plus the job cases.

### Tests (write first; they fail until the code tasks are done)

All in `ID/mfa-enrollment.e2e-spec.ts` (top-level `describe` named after the feature; real Postgres/Redis/Dynamo, real migrations, frozen clock; each test asserts the response **and** persisted rows / outbox / cookies).

- [X] T039 [US1] AS-01 enrol from `none`: `200 {otpauthUri, manualEntryKey}`, row `pending` with `pendingExpiresAt = now+15 min`, secret sealed with context `mfa:<userId>` (opening with another user's context fails), password login unchanged (no challenge). AS-02 re-enrol while `pending` replaces the secret and expiry. AS-03 enrol while `enabled` → `409 mfa_already_enabled`, row unchanged.
- [X] T040 [US1] AS-04 confirm with a valid code → `200 {recoveryCodes}` (10 × `XXXXX-XXXXX`), state `enabled`, 10 keyed-digest rows (`MfaRecoveryCode.digest` ≠ plain/SHA-256 of the code), `lastStep` recorded, `identity.mfa_enabled` outbox row in the same transaction. AS-06 confirm in `none`, in expired `pending` (advance frozen clock 15 min + 1 s) and in `enabled` → `409 mfa_not_pending`, nothing changes.
- [X] T041 [US1] AS-05 confirm validation classes: empty, 5/7 digits, non-digits, extra fields → `400`; wrong valid-format code → `422 invalid_code`, failure counted against `auth.mfa.account`; bodies match the problem schema with `code` and `requestId`.
- [X] T042 [US1] AS-07 `Promise.all` of two confirms with the same valid code: exactly one `200`, one `409 mfa_not_pending`, exactly one code set (10 rows), exactly one `identity.mfa_enabled`.
- [X] T043 [US1] AS-08 all management endpoints (`GET /auth/mfa`, `enroll`, `confirm`, `recovery-codes/regenerate`, `disable`) → `401` without a token, with a challenge token used as Bearer, with a revoked session; a cross-user attempt (user B's token with user A's code) never touches A's row.
- [X] T044 [US1] AS-09 `GET /auth/mfa` per state (`none`, `pending`, `enabled` with `recoveryCodesRemaining`), body validates against `mfaStatusSchema`, contains no secret/digest; a migrated user (legacy factor, no recovery rows) shows `recoveryCodesRemaining: 0`.
- [X] T045 [US1] Job cases in the same file: `identity.reseal-mfa-secrets` re-seals `sealVersion=0` rows with `mfa:<userId>` (idempotent, resumable, bounded batches) and login works before and after (gap A3); `identity.purge-expired-pending-mfa` removes `pending` rows expired for more than a day in bounded batches and leaves live ones; `identity.purge-mfa-challenges` removes `MfaChallengeState` rows with `expiresAt < now() - 1 h`. _(the three job bodies are proven through `MfaMaintenanceService`; the `MfaStateJobs` handler class that calls it is not run by the e2e)_

### Implementation

- [X] T046 [US1] Create `ID/application/second-factor.service.ts`: `status`, `enrol` (state machine via `nextState`, secret from `domain/totp`, sealed with `mfa:<userId>`), `confirm` (code check with `verifyTotp` against the opened secret; then one `@Transactional` unit: conditional `pending→enabled` asserting one row, `acceptStep`, insert 10 keyed-digest codes via `SecretBox.keyedDigest('mfa-recovery', normalised)`, append `MfaEnabled` to the outbox), `isSecondFactorEnrolled(userId)` (true only for `enabled`; a pending enrolment never changes login). Export from `AuthModule`. Gaps A1, A2 (status), A3, A4, A6, A12.
- [X] T047 [US1] Create `ID/application/mfa-attempt-budget.ts` (research R-07): wraps `RateLimiterService`; `take(userId)` = `check('auth.mfa.account', userId)` immediately before a code is compared (denied → the standard rate-limit error with `Retry-After`), failure counted, `reset(userId)` on success, `refund` when a request is rejected before a code is compared; used by the four code paths (verify, confirm, regenerate, disable). Gap A10, SC-003.
- [X] T048 [US1] `ID/api/auth.dto.ts`: strict code DTOs — TOTP endpoints `code` exactly `^\d{6}$`; verify `code` ≤ 32 chars with strict form; unknown fields rejected (`400 validation_failed`); method chosen by form, not by regex guess. Gap A7.
- [X] T049 [US1] Create `ID/api/mfa.controller.ts` with `GET /auth/mfa`, `POST /auth/mfa/enroll`, `POST /auth/mfa/confirm` (`@Firewall({ sensitive: true })` on the sensitive ones; `@RateLimit('auth.mfa.ip')` on confirm; auth and IP throttle run before body validation); no cookie or token building in the controller. Remove `mfa/enroll`/`mfa/confirm` from `ID/api/auth.controller.ts` (and the stacked `SessionNotRevokedGuard`). Gaps A2, A11.
- [X] T050 [US1] `ID/application/login.service.ts`: replace `UserRecord.mfaEnabled` with `SecondFactorService.isSecondFactorEnrolled(userId)` and delete `mfaEnabled` from `UserRecord` (S01 follow-up; contracts/identity-services.md). Run the S01 login e2e plus `mfa-enrollment.e2e-spec.ts`.
- [X] T051 [US1] Create `ID/infra/jobs/reseal-mfa-secrets.job.ts` (S49 job `identity.reseal-mfa-secrets`: bounded batches, conditional `UPDATE … WHERE "sealVersion" = 0`, opens without context, seals with `mfa:<userId>`, sets `sealVersion = 1`) and `ID/infra/jobs/purge-mfa-state.jobs.ts` (`identity.purge-mfa-challenges`, `identity.purge-expired-pending-mfa`, daily, bounded batches). Register with the S49 scheduler like S01's jobs. No `sequelize.transaction`.
- [X] T052 [US1] Run `test-spec.sh libs/domains/identity/mfa-enrollment.e2e-spec.ts` until green.

**Checkpoint**: US1 independently functional.

---

## Phase 4: User Story 2 — Log in with a password and a code (P1)

**Goal**: password login with an enabled factor ends in a session only after a valid TOTP/recovery code; single-use challenge, replay protection, throttling.

**Independent Test**: `test-spec.sh libs/domains/identity/mfa-login.e2e-spec.ts` green (AS-12–AS-24).

### Tests (all in `ID/mfa-login.e2e-spec.ts`)

- [X] T053 [US2] AS-12 verify with TOTP → S01 login result, `amr ["pwd","otp","mfa"]`, new session ID, `Cache-Control: no-store`. AS-13 cookie delivery (`delivery:'cookie'`, challenge via `__Host-mfa-challenge` cookie or body `mfaToken`): three `__Host-` cookies, no token in body; evil `Origin` → `403 origin_not_allowed` and the challenge is **not** consumed (a correct retry still works).
- [X] T054 [US2] AS-14 replay: the same code a second time (same step) is refused, and a spent challenge is refused (`invalid_mfa_challenge`). AS-15 `Promise.all`: same challenge twice with a valid code → one session; two different challenges with one code → one session, the other `401`.
- [X] T055 [US2] AS-16 wrong codes (non-matching, out-of-window step) all answer an identical `401 invalid_mfa_code`; the third wrong attempt burns the challenge; a correct code afterwards is `invalid_mfa_challenge`; a parallel burst of 10 wrong attempts performs at most 3 comparisons. AS-19 challenge defects (expired, tampered, wrong `typ`/`aud`, user deleted, factor no longer enabled, access token presented as challenge) all identical `401 invalid_mfa_challenge`.
- [X] T056 [US2] AS-17 per-account budget: 5 failures per 15 min shared across verify/confirm/regenerate/disable, the sixth is `429` with `Retry-After`, success resets, window slides with the frozen clock, a malformed body costs nothing. AS-18 per-IP limit 20/min and throttle-before-validation (a malformed body from a throttled IP is `429`, not `400`).
- [X] T057 [US2] AS-20 recovery-code login in all accepted forms (`XXXXX-XXXXX`, lower case, without hyphen): session with `amr ["pwd","rcv","mfa"]`, code spent, `remaining` decremented, `identity.mfa_recovery_code_used` outbox row. AS-21 `Promise.all` of two requests with one recovery code → exactly one session.
- [X] T058 [US2] AS-22 completing an S01 password reset leaves the factor `enabled` and the next login still demands a code. AS-23 verify body validation (missing code, > 32 chars, unknown field → `400`; `text/plain` → `415`).
- [X] T059 [US2] AS-24 replay guard survives a Redis flush and an application restart (flush Redis, rebuild the Nest app, replay the used code → refused).

### Implementation

- [X] T060 [US2] `ID/application/second-factor.service.ts`: add `verifyForLogin` — reserve the attempt (R-04) → open the secret (`sealVersion` aware) → `verifyTotp` with `lastStep` → in one `@Transactional` unit: `acceptStep` (conditional) and `MFA_CHALLENGE_REPOSITORY.spend(jti)`, or for recovery codes `spendCode` + `MfaRecoveryCodeUsed` outbox; both writes succeed or the transaction rolls back to a generic wrong-code/challenge error. An unopenable secret → generic 500, nothing spent (AS-62). Gaps A4, A5, A6.
- [X] T061 [US2] Create `ID/application/mfa-login.service.ts`: verifies the challenge (`SessionIssuer.verifyChallenge`; every defect → `invalid_mfa_challenge`), checks the user still exists and the factor is still enabled, takes the budget, calls `verifyForLogin`, and **after commit** completes through `SessionIssuer.issue({userId, amr, delivery, meta})` (amr `[firstFactor, 'otp'|'rcv', 'mfa']`); resets the budget on success; clears `__Host-mfa-challenge` on success and on a burned challenge. Gaps A8, A9.
- [X] T062 [US2] `ID/api/mfa.controller.ts`: `POST /auth/mfa/verify {mfaToken?, code, delivery?}` with `@RateLimit('auth.mfa.ip')`, `OriginGuard` for cookie delivery (before the challenge is consumed), JSON-only guard, `no-store`/`Pragma: no-cache`, cookies via `CredentialCookies.set`, challenge cookie read only when `delivery === 'cookie'` and no `mfaToken` in the body. The controller builds no cookies or tokens itself (S01 follow-up: re-wire onto `SessionIssuer.issue`).
- [X] T063 [US2] Delete `ID/application/mfa/totp.service.ts`, the MFA parts of `ID/application/auth-session.service.ts` and `mfa/verify` in `ID/api/auth.controller.ts`; delete the old MFA case in `ID/auth.e2e-spec.ts:141–163` (replaced by the new files); remove `otplib` from `package.json` only if `grep` shows no other importer (T003). Gap C0 (second-factor part), D-6. _(legacy files and the old e2e case are gone; `otplib` is left in package.json, see T003)_
- [X] T064 [US2] Run `test-spec.sh libs/domains/identity/mfa-login.e2e-spec.ts`, then `mfa-enrollment.e2e-spec.ts` and the S01 login file until green.

**Checkpoint**: US1 + US2 work; the legacy MFA code is gone.

---

## Phase 5: User Story 3 — Replace recovery codes, turn the factor off (P2)

**Independent Test**: `test-spec.sh libs/domains/identity/mfa-management.e2e-spec.ts` green (AS-25–AS-27).

- [ ] T065 [US3] `ID/mfa-management.e2e-spec.ts` AS-25 regenerate with a valid TOTP code: new set of 10, all old codes dead, event `identity.mfa_recovery_codes_regenerated`; `409 mfa_not_enabled` when not enabled; `422 invalid_code` on a wrong code (counted).
- [ ] T066 [US3] Same file, AS-26 disable with a TOTP code or an unspent recovery code → `204`, row and codes deleted, `identity.mfa_disabled{reason:'user'}` (plus `mfa_recovery_code_used` when a recovery code was spent); `409 mfa_not_enabled`; `422 invalid_code`.
- [ ] T067 [US3] Same file, AS-27 a recovery code cannot regenerate (`422`), a TOTP step already used is refused (step reuse), `Promise.all` of two disables → one `204` and one `409`, exactly one `mfa_disabled` event. Covers SC-010 (no weakening without a current code).
- [ ] T068 [US3] `ID/application/second-factor.service.ts`: add `regenerate` (TOTP only; `acceptStep` + `replaceCodes` — delete the user's rows and insert 10 new digests — in one `@Transactional` unit; outbox `MfaRecoveryCodesRegenerated`) and `disable` (TOTP or recovery code; conditional `enabled→none`, delete codes, outbox `MfaDisabled{reason:'user'}`); both use `MfaAttemptBudget`.
- [ ] T069 [US3] `ID/api/mfa.controller.ts`: `POST /auth/mfa/recovery-codes/regenerate` and `POST /auth/mfa/disable` (`@Firewall({ sensitive: true })`, `@RateLimit('auth.mfa.ip')`, strict code DTO, `disable` → `204`).
- [ ] T070 [US3] Run `test-spec.sh libs/domains/identity/mfa-management.e2e-spec.ts` until green.

---

## Phase 6: User Story 4 — Sign in with Google (P1)

**Goal**: `POST start` → provider → callback creates/returns the account and issues S01 cookie sessions; every failure is a redirect with a stable code.

**Independent Test**: `test-spec.sh libs/domains/identity/oidc-login.e2e-spec.ts` green (AS-28–AS-36) against the fake provider.

### Tests (all in `ID/oidc-login.e2e-spec.ts`)

- [X] T071 [US4] AS-28 `GET /auth/oidc/providers` returns `[{id:'google', displayName}]` when configured and `[]` when not; validates against `oidcProviderSchema`. AS-29 `POST /auth/oidc/google/start`: `200 {authorizationUrl}` with `response_type=code`, `scope=openid email profile`, `state`, `nonce`, `code_challenge`, `code_challenge_method=S256`, exact `redirect_uri`; `Set-Cookie: __Host-oidc-flow` (HttpOnly, Secure, `SameSite=Lax`, `Path=/`, Max-Age 600, no Domain); Redis key `oidc:flow:<sha256(state)>` with TTL ≤ 600 s holding only the digest of the cookie value.
- [X] T072 [US4] AS-30 start rejections: unknown/disabled/bad-shape provider names all identical `404 oidc_provider_not_found`; evil `Origin` → `403`; non-JSON → `415`; bad `returnTo` → `400 validation_failed` (never rewritten); `auth.oidc.ip` exceeded → `429` with `Retry-After`; fake provider down at discovery → `503 oidc_provider_unavailable`.
- [X] T073 [US4] AS-31 callback creates an account: `302` to `<front>/<returnTo>`, three `__Host-` cookies, user created with the verified e-mail and no password, link row, outbox `identity.user_registered` + `identity.federated_identity_linked{linkMethod:'login'}`, fake provider saw the PKCE `code_verifier` and exactly one token request, no provider token persisted anywhere (DB, Redis, logs). AS-32 returning user: same account; a changed provider e-mail neither changes the account nor creates a second one.
- [X] T074 [US4] AS-33 callback response headers (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`), redirect only to the configured front-end origin and the stored `returnTo`, extra query parameters ignored. AS-35 ID-token attacks via the fake provider (wrong `iss`, `aud`, `azp`, `nonce`, expired, `alg` none/HS256, unknown `kid`, oversized token) each → `302 /login?error=oidc_token_invalid`, no session, nothing persisted. AS-34/AS-36 are proven by the unit specs (T009, T010); here only wiring (invalid `returnTo` at start; unverified e-mail claim at callback → `email_not_verified`).

### Implementation

- [X] T075 [US4] `packages/backend/libs/common/config/api-config.service.ts` (and the S54 config rules): `validateOidcConfig` — Google client ID without secret fails startup; redirect base URL must be `https` unless the host is localhost; stop falling back to `backend_host` for `auth_redirect_base_url`. Add a config assertion next to the existing config tests. Gap B18.
- [X] T076 [US4] Create `ID/infra/oidc/redis-flow-store.ts` implementing `OIDC_FLOW_STORE` (`put(flow, ttlSec)`, `consume(stateDigest)` with `GETDEL`; key `oidc:flow:<sha256(state)>`, TTL 600 s, JSON `{provider, purpose, userId?, verifier, nonce, returnPath, cookieDigest}`).
- [X] T077 [US4] Create `ID/infra/oidc/guarded-fetch.ts` on `safeRequest`: `timeoutMs: 3000`, `maxResponseBytes: 1 MiB`, `followRedirects: false`, `allowedPorts: [443]`, SSRF guard on every request, `SafeUrlOptions` from `OIDC_NET_OPTIONS`; no retry of the code exchange (retries only idempotent GETs). Gap B6.
- [X] T078 [US4] Create `ID/infra/oidc/openid-client.provider.ts` implementing `OIDC_PROVIDER` (`authorizationUrl`, `exchange` returning verified raw claims) with `openid-client` ^6.8 through the guarded fetch; pinned ID-token algorithm; checks `iss`, `aud`/`azp`, `exp`, `nonce`; discovery issuer equality and `https` endpoints; discovery + key set cached 1 h, unknown-`kid` reload ≤ 1 per 30 s (use the path chosen in T002); ID token cap 8 KB; scope fixed `openid email profile`; provider tokens used inside the callback only and never stored or logged. Gaps B6, B7.
- [X] T079 [US4] Create `ID/application/oidc-flow.service.ts` (`start`): validates provider shape and `returnTo` (`domain/return-path`), generates `state`, `nonce`, PKCE verifier and a 256-bit flow-cookie value, stores the flow with the cookie digest, returns `{authorizationUrl}` + the cookie value. Gaps B1, B5, B8.
- [X] T080 [US4] Create `ID/application/oidc-login.service.ts`: `complete(claims, provider)` runs `TransactionRunner.run` with `decideLink(...)`; implement `login_existing` and `create_account` (insert user with the verified e-mail or `null`, `passwordHash = null`, insert link, outbox `UserRegistered` + `FederatedIdentityLinked`); a unique violation re-reads once and re-decides (convergence, AS-45). Other decision branches are added in T097. Gap B10.
- [X] T081 [US4] Create `ID/application/oidc-callback.service.ts` (callback order of FR-043: consume flow → constant-time compare of the flow-cookie digest → provider match → provider `error` parameter → exactly one `code` → exchange → claim reader → `OidcLoginService.complete` → `SessionIssuer.issue({amr:['fed'], delivery:'cookie', meta})` **after commit**); every failure maps to a closed code from `domain/oidc-errors`; provider text is never echoed. Gaps B2, B3, B8 (S01 follow-up: re-wire onto `SessionIssuer.issue`).
- [X] T082 [US4] Create `ID/api/oidc.controller.ts`: `GET /auth/oidc/providers`, `POST /auth/oidc/:provider/start` (`@RateLimit('auth.oidc.ip')`, `OriginGuard`, JSON-only, sets `__Host-oidc-flow`), `GET /auth/oidc/:provider/callback` (`@RateLimit('auth.oidc.ip')`; always clears `__Host-oidc-flow`, `no-store`, `Referrer-Policy: no-referrer`, `302` only to the configured front origin; every failure → `302 <front>/login?error=<code>`; cookies via `CredentialCookies.set`; client IP from the helper of T030). Remove the old `GET start`/`callback`, the Strict-cookie code and `cf-connecting-ip` use from `ID/api/auth.controller.ts`. Gaps B1, B3, B4, B16.
_T083 (delete `OidcService`) moved to Phase 10 (US8), after T109: it needs tenancy off `OidcService`, a P2 task, and blocked the P1 pass._
- [X] T084 [US4] Run `test-spec.sh libs/domains/identity/oidc-login.e2e-spec.ts` until green.

---

## Phase 7: User Story 5 — A forged, replayed or interrupted callback never signs anyone in (P1)

**Independent Test**: `test-spec.sh libs/domains/identity/oidc-callback-hardening.e2e-spec.ts` green (AS-37–AS-42).

- [X] T085 [US5] `ID/oidc-callback-hardening.e2e-spec.ts` AS-37 callback with unknown/expired/replayed `state`, missing or wrong flow cookie (another browser), mismatched provider in the path → `302 /login?error=oidc_state_invalid`, no session; callback rate limit `auth.oidc.ip` → `429`. AS-39 provider `error=access_denied` (`oidc_denied`, provider text never echoed), missing `code`, repeated `code` → closed codes.
- [X] T086 [US5] Same file, AS-38 `Promise.all` of two callbacks with the same `state`+`code`: exactly one session, the other `oidc_state_invalid`; one token request reached the fake provider.
- [X] T087 [US5] Same file, AS-40 token endpoint 400/401/500 → `oidc_exchange_failed`; oversized (> 1 MiB) response → `oidc_exchange_failed`, body not read past the cap. AS-41 hung provider: exactly one request, no retry, redirect within the 10 s budget (3 s timeout configured low for the test), `oidc_provider_unavailable`, counter `auth_oidc_provider_timeout_total` +1.
- [X] T088 [US5] Same file, AS-42 discovery integrity: issuer mismatch, non-https endpoint, oversized discovery document → refused; discovery cached (second sign-in does not refetch within 1 h; frozen clock), unknown `kid` reload at most once per 30 s.
- [X] T089 [US5] Fix whatever T085–T088 expose in `ID/application/oidc-callback.service.ts`, `ID/infra/oidc/openid-client.provider.ts`, `ID/infra/oidc/guarded-fetch.ts` (all callback paths end in a redirect with a closed code; metrics `auth_oidc_callback_total{outcome}`, `auth_oidc_provider_timeout_total`). Gaps B2, B6, B8.
- [X] T090 [US5] Run `test-spec.sh libs/domains/identity/oidc-callback-hardening.e2e-spec.ts` and `oidc-login.e2e-spec.ts` until green.

---

## Phase 8: User Story 6 — One person, one account, however they sign in (P1)

**Goal**: link by verified e-mail with wipe of password/factor/sessions; conflicts; explicit link/unlink; store uniqueness.

**Independent Test**: `test-spec.sh libs/domains/identity/account-linking.e2e-spec.ts` green (AS-43–AS-53).

### Tests (all in `ID/account-linking.e2e-spec.ts`)

- [X] T091 [US6] AS-43 unverified or missing e-mail claim → `302 /login?error=email_not_verified`, nothing persisted (no user, no link). AS-47 soft-deleted owner of the link or of the address → `account_unavailable`, no new account created.
- [X] T092 [US6] AS-44 verified e-mail matching a password-registered account with live sessions and an enabled factor: link created, `passwordHash` cleared, `SecondFactor` + recovery codes deleted, all pre-link sessions revoked (`account_linked`) before a session is issued, outbox `federated_identity_linked{linkMethod:'email_match', passwordInvalidated:true, mfaReset:true}` and `mfa_disabled{reason:'account_linking'}`; a simulated crash between commit and revocation leaves `wipePending = true` and the next sign-in repeats the revocation before issuing (SC-005); an e-mail match on an account that already has a verified-email federated identity links without the wipe.
- [X] T093 [US6] AS-45 `Promise.all` of two first Google logins → one user, one link, no 500; concurrent S01 registration vs Google login for the same address → one account, consistent outcome. AS-46 same provider, different subject, same e-mail as a linked account → `link_conflict`, no link added.
- [X] T094 [US6] AS-49 `POST /auth/oidc/google/link/start`: `401` without token; with an `enabled` factor the current TOTP `code` is required (`422 invalid_code` when wrong or missing; counted; step consumed); flow record carries `purpose:'link'` and `userId`. AS-50 explicit link callback: links regardless of e-mail, issues no session and no cookies, redirects to `<returnPath>?linked=google`, event `linkMethod:'explicit'`; conflicts (`identity_already_linked` when that subject belongs to another user, `link_conflict` when the user already has Google).
- [X] T095 [US6] AS-51 `GET /auth/identities` returns only the caller's links, validates against `federatedIdentitySchema`. AS-52 `DELETE /auth/identities/:identityId`: other user's / unknown / non-UUID / already-deleted id → identical `404 identity_not_found`; last login method (no password, one identity) → `409 last_login_method`; password + one identity may unlink; success `204` + `federated_identity_unlinked`; second delete is `404`; `401` without token.
- [X] T096 [US6] AS-53 the store itself rejects duplicate `(provider, subject)` and duplicate `(userId, provider)` (direct insert from a seed helper expects a unique violation); the S02 migration pre-check query reports offending pairs when duplicates pre-exist.

### Implementation

- [X] T097 [US6] `ID/application/oidc-login.service.ts`: implement `link_email_wipe` (in the transaction: `UserRepository.clearPassword`, `SecondFactorRepository.deleteAll` + `MfaDisabled{reason:'account_linking'}` when it was `enabled`, insert link with `wipePending = true`, outbox `FederatedIdentityLinked{linkMethod:'email_match', passwordInvalidated, mfaReset}`; **after commit** `SessionRevocationService.revokeAllForUser(userId,'account_linked')` then `markWipeDone`; while `wipePending` is true and revocation fails, the callback answers `oidc_exchange_failed` and issues nothing), `link_email_plain`, `refuse` reasons, soft-deleted handling and unique-violation re-read. Gaps B9, B10, B12, B13; S01 follow-up (no link to unverified password accounts without invalidating password and sessions).
- [X] T098 [US6] `ID/application/oidc-flow.service.ts` + `ID/api/oidc.controller.ts`: `POST /auth/oidc/:provider/link/start {returnTo?, code?}` (`@Firewall({ sensitive: true })`, `@RateLimit('auth.oidc.ip')` and `auth.mfa.ip`; with an `enabled` factor consume the code through the step guard and `MfaAttemptBudget`); `purpose:'link'` in the flow; link callback branch in `oidc-callback.service.ts` (no session, redirect `?linked=google`). Gap B15.
- [X] T099 [US6] Create `ID/application/federated-identity.service.ts` (`list`; `unlink` in `TransactionRunner.run`: count login methods, refuse the last with `last_login_method`, `deleteOwned(id, userId)`, outbox `FederatedIdentityUnlinked`) and `ID/api/identities.controller.ts` (`GET /auth/identities`, `DELETE /auth/identities/:identityId` with `@Firewall({ sensitive: true })`, non-UUID → 404). Principal bound in the WHERE (III.4). Gap B15.
- [X] T100 [US6] Run `test-spec.sh libs/domains/identity/account-linking.e2e-spec.ts` until green; re-run `oidc-login` and `oidc-callback-hardening`.

---

## Phase 9: User Story 7 — Google login does not bypass my second factor (P2)

**Independent Test**: `test-spec.sh libs/domains/identity/oidc-mfa.e2e-spec.ts` green (AS-54–AS-55).

- [ ] T101 [US7] `ID/oidc-mfa.e2e-spec.ts` AS-54 Google login for a user with an enabled factor → `302 <front>/login/mfa?returnTo=…` with `__Host-mfa-challenge` (HttpOnly, Secure, Lax, Path=/, Max-Age 300), **no** access/refresh cookies, no session in the store; `POST /auth/mfa/verify {delivery:'cookie', code}` → session with `amr ["fed","otp","mfa"]`, challenge cookie cleared.
- [ ] T102 [US7] Same file, AS-55 challenge-cookie verify: evil origin → `403` (challenge intact), no cookie and no body token → `401 invalid_mfa_challenge`, expired cookie → `401`, body `mfaToken` takes precedence over the cookie; a burned challenge clears the cookie.
- [ ] T103 [US7] `ID/application/oidc-callback.service.ts`: when the resolved user's factor is `enabled` (`isSecondFactorEnrolled`), create `createChallenge({userId, firstFactor:'fed'})`, set `__Host-mfa-challenge` and redirect to `/login/mfa?returnTo=<validated>` instead of issuing; `mfa-login.service.ts` completes with `fed`. Gap B11, research R-13.
- [ ] T104 [US7] Run `test-spec.sh libs/domains/identity/oidc-mfa.e2e-spec.ts` until green.

---

## Phase 10: User Story 8 — Enterprise IdPs of shops cannot take over other accounts (P2)

**Independent Test**: `test-spec.sh libs/domains/identity/oidc-providers.e2e-spec.ts` green (AS-56–AS-58) and the tenancy shop-SSO e2e still green.

- [ ] T105 [US8] `ID/oidc-providers.e2e-spec.ts` (a stand-in module registers a `shop:` resolver through the real `OidcProviderRegistry`) AS-56 shop IdP asserting a victim's verified e-mail → new account with `email = null`, claimed address kept only as hint on the link, victim's account, password, factor and sessions untouched, no link to the victim (SC-006).
- [ ] T106 [US8] Same file, AS-57 registry lifecycle: disabled provider → `404 oidc_provider_not_found`; resolver that throws → provider answers as unknown (no 500); `invalidate('shop:<id>')` makes the next flow use fresh settings and drops the discovery cache; registering prefix `''`, `google` or a duplicate throws at registration; resolver output validated; `trust` forced to subject-only.
- [ ] T107 [US8] Same file, AS-58 SSRF refusals for dynamic issuers with the real guard, a stubbed DNS resolver and a spy on the outbound transport: `http://`, loopback, link-local/metadata (169.254.169.254), private ranges, DNS rebinding to a private address, non-443 port → provider answers as unknown/`503`, **no outbound request is made**.
- [ ] T108 [US8] Create `ID/application/oidc-provider-registry.ts`: static `google` entry from config (trust `verified-email`), `registerResolver(prefix, resolver)` (refuses `''`, `'google'`, duplicates), `invalidate(providerId)` (drops settings + discovery cache via an in-process emitter the engine listens to), resolver output validation (issuer `https` + SSRF check; `trust` forced to `subject-only`), `OidcProviderSettings = {issuer, clientId, clientSecret, scope?}`. Provide and export from `AuthModule`. Gap B14, D-8.
- [ ] T109 [US8] Edit `packages/backend/libs/domains/tenancy/application/shop-sso.service.ts` (registry wiring only, the lines using `OidcService.setResolver/register`): use `OidcProviderRegistry.registerResolver('shop:', …)` and `invalidate('shop:<id>')` after a config change, handing over the plain secret it opened with the exported `SecretBox`. Then delete any remaining `OidcService` usage. Run the existing tenancy shop-SSO e2e. (Sibling bullet for S03 is already in gaps.md.)
- [ ] T083 [US8] (moved here from US4) Delete `ID/infra/oidc/oidc.service.ts` and its `OidcService` provider/export in `auth-api.module.ts` and `index.ts` now that T109 moved tenancy to the registry. Gap C0 (OIDC part), D-6.
- [ ] T110 [US8] `ID/application/oidc-login.service.ts`: pass `trust` from the registry to `decideLink`; subject-only providers never link by e-mail and create the account with `email = null`. Gap B14.
- [ ] T111 [US8] Run `test-spec.sh libs/domains/identity/oidc-providers.e2e-spec.ts` and the tenancy shop-SSO spec until green.

---

## Phase 11: User Story 9 — Operators can see what happened and secrets stay secret (P3)

**Independent Test**: `test-spec.sh libs/domains/identity/mfa-oidc-observability.e2e-spec.ts` green (AS-59–AS-62, AS-64).

- [ ] T112 [US9] `ID/mfa-oidc-observability.e2e-spec.ts` AS-59 audit lines (`auth.mfa.enrolled|confirmed|failed|verified|recovery_used|regenerated|disabled|challenge_burned`, `auth.oidc.started|callback_failed|login|linked|unlinked`) and counters (`auth_mfa_total{outcome}`, `auth_mfa_challenge_burned_total`, `auth_oidc_callback_total{outcome}`, `auth_oidc_provider_timeout_total`, `auth_identity_linked_total{method}`) across the S02 flows. AS-60 log capture over full flows: no token, code, secret, `state`, `nonce`, verifier, recovery code or digest in any log line, URL or error body (SC-008 server half).
- [ ] T113 [US9] Same file, AS-61 error catalogue: every error response is `application/problem+json` with `type,title,status,detail,instance,requestId` and the stable `code` of FR-100; callback error codes are exactly the closed set. AS-62 an unopenable (corrupt / wrong-context) secret → generic `500`, nothing spent (step, challenge attempts, codes), no session, no secret in the response.
- [ ] T114 [US9] Same file, AS-64 outbox envelope for each of the six events (`eventId, type, version, occurredAt, aggregateId = userId, payload`), payload has identifiers and flags only, row written in the same transaction as the state change (a rolled-back operation leaves none), rejected operations (409/422/401) append nothing.
- [ ] T115 [US9] Add audit lines (`AuditService`) and counters (`MetricsRegistry`) to `second-factor.service.ts`, `mfa-login.service.ts`, `oidc-flow.service.ts`, `oidc-callback.service.ts`, `oidc-login.service.ts`, `federated-identity.service.ts` with outcomes and no secrets (research R-15); verify the corrupt-secret path and the error catalogue; fix whatever the tests expose. Gap B17.
- [ ] T116 [US9] Run `test-spec.sh libs/domains/identity/mfa-oidc-observability.e2e-spec.ts` until green.

---

## Phase 12: User Story 10 — Identity's data stays inside identity (P3)

**Independent Test**: static gates report 0 identity findings (AS-63, SC-009).

- [ ] T117 [US10] `ID/index.ts`: remove the `FederatedIdentityModel` export (D-7) and the `OidcService` export (D-8); add `SecondFactorService`, `OidcProviderRegistry`, `OidcProviderSettings`, the six event contracts and the three rate policies (via `identityRatePolicies`); fix any importer the compiler reports.
- [ ] T118 [US10] Run `pnpm --dir packages/backend check:table-ownership --strict` (0 findings naming `User`, `FederatedIdentity`, `SigningKey`, `SecondFactor`, `MfaRecoveryCode`, `MfaChallengeState`), `check:boundaries` (no identity-related error), `check:module-graph` (stays 9/9), and the direct-`sequelize.transaction` count in `ID` (still 1). Fix findings; record the numbers in gaps.md next to the baseline line. Gaps section C, D-6, D-7, D-8.

---

## Phase 13: User Story 11 — The browser journeys work end to end (P3)

**Owned by W01** (`packages/web`); nothing to implement in this backend change.

- [ ] T119 [US11] Confirm gaps.md "Sibling-spec follow-ups" lists the W01/S48 items of gap C2 (single origin for `__Host-` cookies, `POST …/start` then navigate to `authorizationUrl`, `/login?error=<code>`, `/login/mfa`, `?linked=google`, switch on `code`, challenge never in a URL, `recoveryCodesRemaining: 0` prompt) and names the journeys AS-65 ("MFA") and AS-66 ("Google") in `packages/web/tests/auth.spec.ts`. Add the missing bullet if any. AS-65/AS-66 are not run by this change.

---

## Phase 14: Polish and cross-cutting

- [ ] T120 Re-check that quickstart.md "Ops artifacts" lists SC-004 (latency half), SC-007 and SC-008 (browser half) and that `specs/UNVERIFIED.md` has exactly one `not run` row for each (present at lines 37–39); do not mark any as verified. If a task above changed what is automated, adjust both files together.
- [ ] T121 Re-read gaps.md "Sibling-spec follow-ups" against what was actually built (S01 challenge signature, cookie/guard files, `SecretBox` context, `clearPassword`, dead `User.mfa*` columns; S03 registry; S50 code-enforced policy; S54 config + guarded fetch; S49 jobs; S28 events; W01 items) and fix any bullet that no longer matches. Do not edit other specs.
- [ ] T122 Run the migration and re-seal drill of quickstart.md: seed a legacy enabled factor, migrate, confirm login still demands a code, run `identity.reseal-mfa-secrets`, check `SecondFactor.sealVersion = 1` for every row and `recoveryCodesRemaining = 0` until regeneration.
- [ ] T123 Record the deferred contract migration (drop `User.mfaSecretEnc`, `mfaEnabledAt`, `mfaRecoveryCodes`; add the `FederatedIdentity.provider` check constraint) in quickstart.md and gaps.md as **not part of this change**, gated on the re-seal job having completed in every environment.
- [ ] T124 Run `pnpm --dir packages/backend tsc --noEmit` and `pnpm --dir packages/backend lint`; fix all findings in files touched here.
- [ ] T125 Run the whole capability once: `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/identity` (S01 files must stay green) plus `pnpm jest libs/domains/identity/domain --testPathIgnorePatterns e2e`; record the green run (VII.9) in gaps.md.
- [ ] T126 Report to the human: what was built, the four follow-ups (S01 ×3, S50) and where each is satisfied, the legacy-recovery-codes behaviour change, the duplicate-identity migration abort, the three `not run` UNVERIFIED rows, and the sibling bullets.

---

## Dependencies and execution order

- Setup → Foundational → stories. Foundational blocks every story.
- **US1** first (MVP); **US2** needs US1 (service, budget, controller); **US3** needs US1 + US2 service; **US4** needs Foundational only (plus `CredentialCookies`/`OriginGuard` from T029); **US5** needs US4; **US6** needs US4 (and US1 for the factor wipe and step-up); **US7** needs US2 + US4 + US6; **US8** needs US4 + US6 (`OidcLoginService`); **US9** after US1–US8; **US10** after US8 (tenancy edit before the barrel export is removed); **US11** is W01's.
- Within each story: failing e2e tests → services → controller → run the file. Tests in the same file are sequential; different files are [P].
- Tasks touching the same file are never [P]: `second-factor.service.ts` (T046 → T060 → T068), `mfa.controller.ts` (T049 → T062 → T069), `oidc-login.service.ts` (T080 → T097 → T110), `oidc-callback.service.ts` (T081 → T089 → T098 → T103), `oidc.controller.ts` (T082 → T098).

## Parallel opportunities

- Setup: T003, T004, T005, T006.
- Foundational unit tests T007–T014 can be written together; unit code T015–T021 together after them; T035 and T036 in parallel with T034.
- After Foundational: US1→US2→US3 (second factor) and US4→US5 (OIDC engine) can run in parallel by two workers; they meet in US6/US7.
- E2E files in different stories (`mfa-enrollment`, `mfa-login`, `oidc-login`) are separate files and can be written in parallel before their code tasks.

## Implementation strategy

- **MVP**: Setup + Foundational + US1 (+ US2 so the factor is useful at login). Stop and validate with `mfa-enrollment` and `mfa-login`.
- **Incremental**: US3 → US4 → US5 → US6 (the security-critical linking wipe) → US7 → US8 → US9 → US10; run each story's file when it closes and keep the S01 files green.
- **Final**: static gates, whole identity suite once, UNVERIFIED rows untouched.

## Gap coverage (every row of gaps.md has a task)

| Gap | Task(s) |
|---|---|
| A1 | T046, T039 |
| A2 | T046, T049, T069 |
| A3 | T022, T051, T045 |
| A4 | T034, T060, T059 |
| A5 | T016, T060, T057 |
| A6 | T046, T042 |
| A7 | T048, T041, T058 |
| A8 | T027, T061, T055 |
| A9 | T061, T062, T053 |
| A10 | T047, T056 |
| A11 | T049, T041 |
| A12 | T031, T033, T032 |
| B1 | T079, T082, T071 |
| B2 | T081, T089 |
| B3 | T029, T081, T082 |
| B4 | T030, T082 |
| B5 | T017, T079, T072 |
| B6 | T077, T078, T087, T088, T107 |
| B7 | T018, T078, T074 |
| B8 | T079, T081, T089 |
| B9 | T097, T092 |
| B10 | T080, T097, T093 |
| B11 | T103, T101 |
| B12 | T031, T097, T096 |
| B13 | T097, T091 |
| B14 | T108, T110, T105 |
| B15 | T098, T099, T094, T095 |
| B16 | T082, T071 |
| B17 | T024, T115, T112, T114 |
| B18 | T075 |
| C0 | T026, T063, T083, T118 |
| C1 | every e2e test task (T039–T045, T053–T059, T065–T067, T071–T074, T085–T088, T091–T096, T101–T102, T105–T107, T112–T114), T005, T006 |
| C2 | T119 |
| D-6 | T026, T063, T083 |
| D-7 | T117 |
| D-8 | T108, T109, T117 |
| Section C rows | T001, T117, T118 |
| Sibling-spec follow-ups | T121, T029 |
| D-12, D-17, other D rows | not S02's (no task) |
| Order of work D.1–D.7 | followed by phase order |
