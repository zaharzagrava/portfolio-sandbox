# Quickstart: validating S01

Run from `packages/backend`. Test engines per `docker-compose.test.yaml` (Postgres, Redis, local DynamoDB). Shapes: [contracts/](contracts/); tables: [data-model.md](data-model.md); decisions: [research.md](research.md).

## Fast loop (narrowest proof first)

```bash
# pure units (no DB)
pnpm jest libs/domains/identity --testPathIgnorePatterns e2e
# one e2e file at a time (condensed output, full log path printed)
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/identity/auth-register.e2e-spec.ts
```

## Scenario map

| Scenarios | File | Expected |
|---|---|---|
| AS-01–09 | `auth-register.e2e-spec.ts` | uniform 202, one user, outbox rows, 422/429 paths |
| AS-10–16, 19–21 | `auth-login.e2e-spec.ts` | token profile, identical 401, throttles (rotated headers ignored), rehash |
| AS-24–30, 57 | `auth-tokens.e2e-spec.ts` | identical 401s, legacy channels rejected, sensitive vs ordinary revocation |
| AS-31–38 | `auth-refresh.e2e-spec.ts` | rotation, reuse revoke, concurrent winner, boundaries 30 d / 90 d |
| AS-39–45 | `auth-sessions.e2e-spec.ts` | DTO, 404 IDOR, idempotent logout, cap 20, `revokeAllForUser` |
| AS-46–52, 54–56 | `auth-cookies-csrf.e2e-spec.ts` | cookies, CSRF, origin, 415, GET never mutates |
| AS-58–61, 63, 64, 66 | `auth-jwks-keys.e2e-spec.ts` | JWKS, ETag/304, third-party verify, rotation, concurrent runs, sealed key |
| AS-68–70 | `service-tokens.e2e-spec.ts` | mint profile, endpoint matrix, on-behalf-of |
| AS-73–78 | `auth-password-reset.e2e-spec.ts` | uniform 202, one message, single-use, concurrent confirm, throttles |
| AS-79–80 | `user-directory.e2e-spec.ts` | batch, limit, normalised lookup |
| AS-82–85 | `auth-observability.e2e-spec.ts` | audit lines, no secrets, error contract, corrupted key → 500 |
| OPS-01–07 | `auth-jobs-admin.e2e-spec.ts` | ADMIN-only operator routes (S49 follow-up) |
| AS-17, 18, 22, 23, 53, 62, 65, 67, 71, 72 | unit specs beside the code | table-driven matrices |

OPS rows: OPS-01 401 without token; OPS-02 403 for USER/SELLER/MODERATOR on every route; OPS-03 list with filters, cursor, clamped limit, tampered cursor → 400, no payload field; OPS-04 stats; OPS-05 retry dead (RETRIED / CONFLICT / NOT_FOUND, audit line has actor); OPS-06 cancel; OPS-07 schedules list/enable/disable (unknown name → 404). Each asserts persisted job/schedule state.

Every identity e2e app imports `RateLimitModule.forRoot()` (research R-14) and boots the production pipe, filter, prefix and interceptors.

## Static gates

```bash
pnpm exec tsc --noEmit -p tsconfig.json && pnpm lint
pnpm check:boundaries            # no identity-related error
pnpm check:module-graph          # stays 9/9
pnpm check:table-ownership --strict   # 0 findings naming User, FederatedIdentity, SigningKey (AS-81)
pnpm check:no-wallclock          # identity uses CLOCK
```

Also grep: `sequelize.transaction` count in `libs/domains/identity` is 0 and no `// S54 T037 audit` remains there; `grep -rn "cf-connecting-ip\|throttle\|skipThrottle" libs/domains/identity` is empty.

## Full capability suite (once at the end)

```bash
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/identity
```

Record the green run (VII.9). Other domains' specs that used `issueTokensFor` (`orders/cart`, `orders/checkout`, `launch-events`, `chat`, `sse-gateway/topic-stream`) must be re-run after the move to the session fixture.

## Ops artifacts (criteria no automated test proves)

Do not describe these as verified; each has a row in `specs/UNVERIFIED.md`.

- **SC-001 (timing part)**: "register then log in in under 30 seconds" is a UX measure; the indistinguishability half is proven by AS-02. Run the W01 journey (AS-86) with a stopwatch assertion once W01 exists.
- **SC-005 (edge half)**: zero identity calls per request at the edge and zero rejected valid tokens across a rotation, observed with `packages/edge-be` pinned to ES256/`aud`/`typ` (gap A46, outside identity). Drill: rotate keys while a k6 script sends valid tokens through the edge; expect 0 rejections and 0 requests to identity.
- **SC-006**: 2,000 logins/s fleet-wide, p99 < 300 ms (logins), < 50 ms (refresh), overload shed with `503 + Retry-After`. Run a k6 script with 2,000 login VUs against a staging fleet with `UV_THREADPOOL_SIZE=8`, hash concurrency 4.
- **SC-008 (browser half)**: no access/refresh token in script-readable storage in the cookie flow. Run the W01 Playwright journey (AS-86) inspecting `localStorage`, `sessionStorage`, `document.cookie`.
