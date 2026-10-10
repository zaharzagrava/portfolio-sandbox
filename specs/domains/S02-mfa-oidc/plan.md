# Implementation Plan: S02 — TOTP MFA, Google OIDC (PKCE), Account Linking

**Branch**: `S02-mfa-oidc` | **Date**: 2026-10-10 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [test-plan.md](test-plan.md), [gaps.md](gaps.md), [questions.md](questions.md) (defaults accepted; no line was edited by a human). Constitution: `.specify/memory/constitution.md`.

## Summary

S01 is built; S02 plugs the second factor and federated login into it. The plan, in one paragraph: move the second-factor data out of `User` into three identity-owned tables with conditional-update state transitions (`SecondFactor`, `MfaRecoveryCode`, `MfaChallengeState`), so replay protection, single-use challenges and recovery-code spending are decided by the store (III.6/III.7); write the verifier, recovery-code, return-path, claim-reader and link-decision logic as pure `domain/` modules; put the OIDC protocol behind ports (`OidcProviderPort`, `OidcFlowStore`) with an adapter that runs `openid-client` through the platform's SSRF-guarded `safeRequest`; link accounts in one transaction (after the provider exchange, before the session revocation) with the password/factor/session wipe for unproven accounts; re-wire `/auth/mfa/*` and `/auth/oidc/*` onto `SessionIssuer.issue`; declare the three S50 policies; replace `OidcService` and `FederatedIdentityModel` in the barrel by `OidcProviderRegistry` and `SecondFactorService`. Decisions and alternatives: [research.md](research.md); tables: [data-model.md](data-model.md); interfaces: [contracts/](contracts/); validation: [quickstart.md](quickstart.md).

Follow-ups from built specs, treated as requirements:

| From | Requirement | Where planned |
|---|---|---|
| S01 | re-wire `/auth/mfa/*`, `/auth/oidc/*` onto `SessionIssuer.issue` | WP-2, WP-4, WP-5 (controller no longer builds cookies or tokens itself) |
| S01 | provide `isSecondFactorEnrolled(userId)` | WP-2 (`SecondFactorService`, exported; `LoginService` uses it) |
| S01 | linking must not link to unverified password accounts without invalidating password and sessions | WP-5 (`link_email_wipe`, research R-11, AS-44, SC-005) |
| S50 | declare `auth.mfa.ip`, `auth.mfa.account` (failures-only, shared by four code paths via `refund`/`reset`), `auth.oidc.ip` | WP-1 (policies), WP-2 (`MfaAttemptBudget`, research R-07) |

## Technical Context

**Language/Version**: TypeScript (strict), Node 22, NestJS; `packages/backend`, domain `identity`; contracts in `packages/contracts`; web in `packages/web` (W01-owned).

**Primary Dependencies**: existing: `openid-client` ^6.8, `@nestjs/sequelize` + `sequelize-typescript`, `TransactionRunner`/`@Transactional` (`@app/infrastructure/context`), `OutboxService`, S50 `RateLimiterService`/`@RateLimit`, `safeRequest` (`@app/infrastructure/net`), `MetricsRegistry`, `AuditService`, `SecretBox`, `SessionIssuer`. Test only: `jose` (fake provider signing; already a transitive dependency), `fast-check` (present). `otplib` is no longer imported by identity (research R-06).

**Storage**: PostgreSQL (three new tables, `FederatedIdentity` unique index and column, expand-only); Redis for the 10-minute flow record and S50 counters; DynamoDB `Auth` table untouched (sessions stay S01's).

**Testing**: Jest e2e via `/opt/sdd/repo/scripts/sdd/test-spec.sh`; unit specs for pure modules only; Playwright journeys by W01. Real Postgres/Redis/Dynamo, real migrations, fake only for the OIDC provider, DNS resolution (SSRF cases), mail and clock ([test-plan.md](test-plan.md)).

**Target Platform**: Linux containers (`apps/core` hosts `AuthApiModule`; token-only apps use `AuthModule`).

**Project Type**: web-service (backend domain) + contracts package; web UI is a dependency, not a deliverable.

**Performance Goals**: no new cost on non-MFA logins; MFA-enabled password login adds one PK read; verify = one conditional upsert + one short transaction; callback within the 10 s budget (3 s per provider call), SC-004 latency is an ops artifact.

**Constraints**: no network I/O inside a transaction (provider exchange first, DynamoDB revoke/issue after commit); no new direct `sequelize.transaction`; expand/contract migrations with `lock_timeout`; cache never the source of truth for a durable fact; secrets never in logs/URLs.

**Scale/Scope**: 12 HTTP routes (7 new, 5 re-wired), 3 tables, 6 events, 3 policies, 5 pure modules + the state machine, 2 OIDC adapters, 66 acceptance scenarios (nine e2e files, five unit specs, two W01 journeys).

## Constitution Check

*GATE before Phase 0; re-checked after Phase 1.*

| Rule | Status | How |
|---|---|---|
| I.2 / D-6 layering | Pass (closes the S02 part of D-6) | controllers → application services → ports in `domain/ports`; adapters in `infra/`; `TotpService`, `OidcService`, `AuthSessionService` (models, Redis, protocol in the application path) are deleted/replaced |
| I.4, III.1, IX.1 owner-only data access | Pass | only `infra/` repositories touch the new tables and `FederatedIdentity` |
| II request pipeline | Pass | `Firewall({sensitive:true})` on management routes; `@RateLimit` metadata only; auth and IP throttle before validation |
| III.2 / rule (4) transactions | Pass | `TransactionRunner.run` only; no new `sequelize.transaction` (baseline 1 stays); the S54 T037 audit comment lives in S01's `key-rotation.jobs.ts`, not touched |
| III.3 no I/O in a transaction | Pass | exchange before; DynamoDB issue/revoke after commit; outbox inside |
| III.4 principal in the predicate | Pass | identity list/unlink, management endpoints, link flow bind `userId` in the WHERE |
| III.6 / III.7 invariants and transitions | Pass, with one reading recorded below | conditional updates assert one row; `nextState` + `assertNever` |
| III.9 cache not truth | Pass | step guard, challenge state, codes are Postgres; Redis holds only the single-use flow record (loss = retry) |
| III.11 migrations | Pass | expand-only, `lock_timeout`, `CONCURRENTLY` outside the transaction, duplicate pre-check; contract step deferred and listed |
| IV.3 / IV.6 / IV.8 communication | Pass | events through outbox; outbound only through `safeRequest`; retries only on idempotent GETs; startup config validation |
| V.3–V.5 contracts | Pass | stable `code`s (FR-100); POST for state creation; callback redirect is a browser navigation, not an API error response (questions.md BREAKING line) |
| VI.2 tokens out of JS | Pass (server) | `__Host-` HttpOnly cookies, no token in URL; browser half is an ops artifact |
| VII testing | Pass | table in test-plan.md; units only for pure logic; Mandatory-case table per endpoint; frozen clock; real stores |
| VIII.1 audit/metrics | Pass | audit lines and counters without secrets (research R-15) |
| IX.3, IX.4, IX.6, IX.7 | Pass | registry entries for the 3 tables in the same change; `FederatedIdentityModel` leaves the barrel (D-7); only cross-owner write is the outbox; tenancy uses an R1 export (D-8) |
| X.4 / X.5 barrels | Pass | barrel adds `SecondFactorService`, `OidcProviderRegistry`, event contracts; removes `FederatedIdentityModel`, `OidcService` |
| Open debt D-6, D-7, D-8 | Closed by this plan | WP-3, WP-6; D-12, D-17 and the others do not name S02 |

Post-design re-check (after Phase 1): unchanged; the only judgement call is below.

## Complexity Tracking

| Departure | Why | Simpler alternative rejected because |
|---|---|---|
| III.7 "plus a history row in the same transaction" not implemented for the factor state | Every transition appends an outbox event and an audit line in the same transaction; a separate history table duplicates the event stream (`full-history` retention on `identity.events`) | A history table would store only what the outbox already holds durably, and add a purge/retention policy |
| Three new tables instead of columns on `User` | Pending secret, `lastStep`, per-code spent marks, lazy challenge state need their own rows for single-statement guards | Columns on S01's `User` couple both specs' migrations and rewrite a hot row on every accepted step |
| `auth.mfa.account` enforced from code | Subject (user ID) is known only after the challenge verifies; one budget spans four paths | A `custom` key resolver would verify the token twice per request |

## Project Structure

### Documentation (this feature)

```text
specs/domains/S02-mfa-oidc/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/ (http.md, identity-services.md, events.md)
├── spec.md  test-plan.md  gaps.md  questions.md   # inputs
└── tasks.md                                       # /speckit-tasks, not created here
```

### Source Code

```text
packages/backend/libs/domains/identity/
├── domain/
│   ├── totp.ts  recovery-code.ts  return-path.ts  id-token-claims.ts
│   ├── link-decision.ts  second-factor-state.ts  oidc-errors.ts      (+ *.spec.ts beside each, table-driven)
│   ├── events.ts (add 6)  errors.ts (add FR-100 codes)  auth-rate-policies.ts (add 3)
│   └── ports/index.ts (add SECOND_FACTOR_REPOSITORY, MFA_CHALLENGE_REPOSITORY, FEDERATED_IDENTITY_REPOSITORY,
│                       OIDC_FLOW_STORE, OIDC_PROVIDER, OIDC_NET_OPTIONS; UserRepository.clearPassword)
├── application/
│   ├── second-factor.service.ts  mfa-attempt-budget.ts  mfa-login.service.ts
│   ├── oidc-flow.service.ts  oidc-callback.service.ts  oidc-login.service.ts
│   ├── federated-identity.service.ts  oidc-provider-registry.ts
│   └── (delete) mfa/totp.service.ts  auth-session.service.ts ; (change) login.service.ts  session-issuer.service.ts
├── infra/
│   ├── models/ second-factor.model.ts  mfa-recovery-code.model.ts  mfa-challenge-state.model.ts
│   │          second-factor.repository.ts  mfa-challenge.repository.ts  federated-identity.repository.ts  (+ wipePending)
│   ├── oidc/  openid-client.provider.ts  guarded-fetch.ts  redis-flow-store.ts  (delete oidc.service.ts)
│   ├── crypto/secret-box.ts (context, keyedDigest)
│   └── jobs/  reseal-mfa-secrets.job.ts  purge-mfa-state.jobs.ts
├── api/  auth.controller.ts (MFA + OIDC routes move to mfa.controller.ts, oidc.controller.ts, identities.controller.ts)
│         auth.dto.ts (strict code DTOs)  credential-cookies.ts (only if S01 T053 not landed)
├── index.ts  auth.module.ts  auth-api.module.ts
└── *.e2e-spec.ts  (nine files of test-plan.md)  testing/ (fixtures)
packages/backend/migrations/<ts>-identity-s02-expand.js     db/ownership.ts (+3 entries)
packages/backend/test/fakes/fake-oidc-provider.ts
packages/backend/libs/domains/tenancy/application/shop-sso.service.ts    (registry wiring only)
packages/backend/libs/common/config/api-config.service.ts                (OIDC startup validation)
packages/contracts/src/auth/                                             (6 schemas)
```

**Structure Decision**: extend the existing `identity` domain in its S01 shape (ports in `domain/`, adapters in `infra/`, thin controllers). The auth controller is split so MFA, OIDC and identities each fit on one screen.

## Work packages (tasks.md derives from these)

Order follows gaps.md section D. Each package ends with its narrowest test green.

| WP | Content | Gaps / debt | Proof |
|---|---|---|---|
| WP-0 Baseline | Run `check:table-ownership` and `check:boundaries`, reconcile gaps.md section C with the real `identity` rows (gap file caveat); record counts; confirm the `openid-client` JWKS/cache behaviour (research R-09 verification) and whether `otplib` has other importers | caveat, C | gate output noted in tasks |
| WP-1 Pure units | `totp`, `recovery-code`, `return-path`, `id-token-claims`, `link-decision`, `second-factor-state`; error classes; events; 3 rate policies; `SecretBox` context + `keyedDigest`; contracts schemas | A7, A8 (codes), B5, B7, B17 (events), D-6 start | unit specs; `auth-rate-policies.spec.ts` |
| WP-2 Second factor | migration (tables, copy, `wipePending`, unique index), registry entries, models + repositories, `SecondFactorService`, `MfaAttemptBudget`, `MfaLoginService`, challenge with first factor, `LoginService` switch, controller routes enroll/confirm/status/verify/regenerate/disable, strict DTOs, `Firewall({sensitive:true})`, audit + counters; delete `TotpService` | A1–A12, C0 (second-factor part), B11 (challenge half), D-6 | `mfa-enrollment`, `mfa-login`, `mfa-management` e2e |
| WP-3 Re-seal and purge jobs | `identity.reseal-mfa-secrets`, purge jobs (S49); re-seal drill in quickstart | A3 | job e2e inside `mfa-enrollment` + drill |
| WP-4 OIDC engine | fake provider, flow store, cookie binding, `POST start`, providers list, callback outcomes → redirects, guarded fetch, discovery cache, config validation, `oidc.controller`; cookie writer dependency (S01 T052–T053 or the minimal file) | B1–B8, B16, B18, C0 (OIDC part) | `oidc-login`, `oidc-callback-hardening` e2e |
| WP-5 Linking | `OidcLoginService` + transaction + wipe + revoke-after-commit, soft-deleted, conflicts, explicit link, identities list/unlink, federated factor challenge cookie | B9–B15, B11 | `account-linking`, `oidc-mfa` e2e |
| WP-6 Registry and barrel | `OidcProviderRegistry` (trust forced, SSRF check, invalidate), tenancy `shop-sso.service.ts` edit, barrel changes, delete `oidc.service.ts` and `FederatedIdentityModel` export | B14, D-7, D-8, section C | `oidc-providers` e2e; `check:boundaries`, `check:table-ownership --strict` |
| WP-7 Observability and errors | audit lines, counters, log capture, error catalogue, corrupt-secret path, event envelopes | B17 | `mfa-oidc-observability` e2e |
| WP-8 Cross-spec | gaps.md Sibling-spec follow-ups (written), UNVERIFIED rows (written), W01 hand-off items (C2) | C2 | review |
| WP-9 Finish | whole identity suite once, tsc, lint, gates, record green run (VII.9); contract-migration task listed as deferred (drop `User.mfa*` after re-seal ran everywhere) | — | `test-spec.sh libs/domains/identity` |

## Gap coverage (every row of gaps.md)

| Gap | WP | | Gap | WP | | Gap | WP |
|---|---|---|---|---|---|---|---|
| A1 | 2 | | B1 | 4 | | B10 | 5 |
| A2 | 2 | | B2 | 4 | | B11 | 2, 5 |
| A3 | 1, 3 | | B3 | 4 (needs S01 T053, R-14) | | B12 | 2 (index), 5 |
| A4 | 2 | | B4 | 4 (uses `req.clientIp`) | | B13 | 5 |
| A5 | 1, 2 | | B5 | 1, 4 | | B14 | 6 |
| A6 | 2 | | B6 | 4 | | B15 | 5 |
| A7 | 1, 2 | | B7 | 1, 4 | | B16 | 4 |
| A8 | 1, 2 | | B8 | 4 | | B17 | 1, 7 |
| A9 | 2 | | B9 | 5 | | B18 | 4 |
| A10 | 2 | | C0 | 2, 4, 5 | | C1 | all e2e files |
| A11 | 2 | | C2 | 8 (W01) | | D-6 / D-7 / D-8 | 2–6 |
| A12 | 2 (new tables) | | D-12, D-17 | not S02 | | Section C rows | 6 |

## Risks

1. **S01 cookie delivery not built** (R-14): WP-4/WP-5 cookie-mode tests depend on it; mitigated by the minimal writer and the ordering rule.
2. **openid-client JWKS cache** may not honour the 30 s reload rule (R-09): WP-0 verifies, fallback `jose.createRemoteJWKSet`.
3. **Legacy recovery codes lost** at cut-over (R-05): intentional, visible in the status body, flagged for the human.
4. **Duplicate `(userId, provider)` rows** in existing data abort the unique-index migration by design (data-model); a human resolves them.
5. **`tenancy` edit** crosses a domain boundary in code (not spec); limited to the registry wiring, covered by the existing tenancy e2e plus `oidc-providers` e2e.
