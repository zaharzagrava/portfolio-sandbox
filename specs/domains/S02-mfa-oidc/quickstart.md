# Quickstart: validating S02

Run from `packages/backend`. Test engines per `docker-compose.test.yaml` (Postgres, Redis, local DynamoDB). Shapes: [contracts/](contracts/); tables: [data-model.md](data-model.md); decisions: [research.md](research.md). `ID` = `libs/domains/identity`.

## Fast loop (narrowest proof first)

```bash
# pure units (no DB): totp, recovery-code, return-path, id-token-claims, link-decision, second-factor-state
pnpm jest libs/domains/identity/domain --testPathIgnorePatterns e2e
# one e2e file at a time (condensed output, full log path printed)
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/identity/mfa-enrollment.e2e-spec.ts
# the whole identity suite once at the end (S01 files must stay green)
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/identity
```

## Scenario map

| Scenarios | File | Expected |
|---|---|---|
| AS-01–09 | `ID/mfa-enrollment.e2e-spec.ts` | state machine, sealed secret bound to user, 409s, concurrent confirm one winner, status body |
| AS-12–24 | `ID/mfa-login.e2e-spec.ts` | session with `amr`, cookies/origin, replay, 3-try burn, 5/15 min budget shared, IP limit, recovery spend, flush + restart |
| AS-25–27 | `ID/mfa-management.e2e-spec.ts` | regenerate, disable, step reuse, concurrent disable |
| AS-28–36 | `ID/oidc-login.e2e-spec.ts` | providers list, start, callback happy path against the fake provider, ID-token attacks |
| AS-37–42 | `ID/oidc-callback-hardening.e2e-spec.ts` | forged/replayed callbacks, concurrency, provider errors, timeout without retry, discovery integrity |
| AS-43–53 | `ID/account-linking.e2e-spec.ts` | unverified refused, link + wipe, races, conflicts, soft-deleted, explicit link, list/unlink, store uniqueness |
| AS-54–55 | `ID/oidc-mfa.e2e-spec.ts` | Google login with an enabled factor, challenge cookie |
| AS-56–58 | `ID/oidc-providers.e2e-spec.ts` | shop IdP subject-only, registry lifecycle, SSRF refusals |
| AS-59–62, 64 | `ID/mfa-oidc-observability.e2e-spec.ts` | audit lines, counters, no secret in logs, error catalogue, corrupt secret, outbox envelopes |
| AS-10, 11, 34, 36, 48 | unit specs beside the code in `ID/domain/` | RFC 6238 vectors, recovery codes, return path, claim reader, link decision grid |
| AS-63 | static gates | below |
| AS-65, 66 | `packages/web/tests/auth.spec.ts` (W01) | journeys "MFA" and "Google" |

Fake provider: `test/fakes/fake-oidc-provider.ts` (in-process HTTP server, discovery, key set, token endpoint, injectable faults, request log). Fixtures: users with a password, with an enabled factor, with a Google link, with sessions.

## Static gates

```bash
pnpm --dir packages/backend tsc --noEmit
pnpm --dir packages/backend lint
pnpm --dir packages/backend check:boundaries          # no identity-related error
pnpm --dir packages/backend check:table-ownership --strict   # 0 findings naming User, FederatedIdentity, SigningKey, SecondFactor, MfaRecoveryCode, MfaChallengeState
pnpm --dir packages/backend check:module-graph         # stays 9/9
```

The transaction gate: the count of direct `sequelize.transaction` sites in `libs/domains/identity` must not rise (baseline in `.tx.baseline`: 1, S01's `key-rotation.jobs.ts`). S02 uses `TransactionRunner.run` only.

## Migration and re-seal drill (expand → deploy → re-seal)

```bash
pnpm --dir packages/backend migrate                    # 20261010…-identity-s02-expand
# seed a user with a legacy enabled factor first, then:
# run the S49 job `identity.reseal-mfa-secrets` (admin routes of S01 IdentityOps) and check SecondFactor.sealVersion = 1 for every row
```

Expected: users who had MFA enabled before the migration still get a challenge at login; their `recoveryCodesRemaining` is 0 until they regenerate (documented behaviour change).

## Ops artifacts (success criteria that no automated test proves)

Listed in `specs/UNVERIFIED.md` with status `not run`; none is described as verified.

- **SC-004 (latency half)**: after approval at Google, 95 % of sign-ins complete within 3 s. Run: against staging with the real Google client, drive 200 sign-ins with the W01 Playwright "Google" journey and record time from the callback request to the front page rendered; check p95 ≤ 3 s.
- **SC-007**: a member turns on the authenticator app and saves the recovery codes in under 2 minutes. Run: W01 journey "MFA" (AS-65) with a stopwatch assertion from opening security settings to the recovery-code acknowledgement, using a scripted authenticator.
- **SC-008 (browser half)**: no token, code, secret, `state`, `nonce` or verifier in script-readable browser storage across the S02 flows. Run: W01 Playwright journeys AS-65/AS-66 inspect `localStorage`, `sessionStorage`, `document.cookie` and the URL history after each step. (The server half, logs/URLs/error bodies, is AS-60.)
