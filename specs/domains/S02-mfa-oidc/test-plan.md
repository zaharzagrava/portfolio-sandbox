# Test Plan: S02 — TOTP MFA, Google OIDC (PKCE), Account Linking (domain `identity`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/identity/`. Each file's top-level `describe` is named after its feature (VII.8). They boot the real `AuthApiModule`/`AuthModule` with the production pipe, filter, prefix and interceptors, against real Postgres, Redis and the session key-value store (docker-compose.test.yaml), with real migrations, freeze time with the shared clock helper, reset state in `beforeEach`, and seed through the shared fixture helpers (users with a password, with an enabled factor, with a Google link, with sessions). Every test asserts the response **and** the persisted state (rows, cache keys, outbox rows, cookies).
- Only system-edge dependencies are faked: **the fake OIDC provider** (`test/fakes/fake-oidc-provider.ts`: an in-process HTTP server with discovery, key-set, token endpoints; signs ID tokens with `jose`; can inject wrong claims, delays, 4xx/5xx, oversized bodies, a hung endpoint, and records every request it receives), the outbound-client port's DNS resolver (SSRF cases only; the guard itself is real), mail transport and the clock. Repositories, stores, the secret box and the session issuer are real. Authenticator codes are produced in tests by the same RFC 6238 algorithm from the secret opened with the test master key.
- The `shop:` provider cases use a stand-in module that registers a resolver through the real `OidcProviderRegistry` (S03's own wiring is proven in S03).
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5): the TOTP verifier, the recovery-code generator/normaliser, the return-path validator, the ID-token claim reader, the linking decision function. No unit tests for controllers, repositories or glue.
- UI journeys: `packages/web/tests/auth.spec.ts` (Playwright, owned by W01) gains two happy paths for S02: MFA enrolment + login with a code, and "Continue with Google" against the fake provider. No edge case is re-tested there.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend`; `pnpm check:boundaries`; `pnpm check:table-ownership --strict` (identity lines must be 0) — see AS-63.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 enrol from `none`: URI, sealed secret bound to user, `pending`, login unchanged | `mfa-enrollment.e2e-spec.ts` | — | — |
| AS-02 re-enrol while `pending` replaces the secret | `mfa-enrollment.e2e-spec.ts` | — | — |
| AS-03 enrol while `enabled` → 409, nothing changes | `mfa-enrollment.e2e-spec.ts` | — | — |
| AS-04 confirm → `enabled`, 10 keyed-digest codes, step recorded, event | `mfa-enrollment.e2e-spec.ts` | — | — |
| AS-05 confirm validation classes and wrong code (422, counted) | `mfa-enrollment.e2e-spec.ts` | — | — |
| AS-06 confirm in `none` / expired `pending` / `enabled` → 409 | `mfa-enrollment.e2e-spec.ts` (frozen clock) | — | — |
| AS-07 concurrent confirm: one winner, one code set, one event | `mfa-enrollment.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-08 401 on all management endpoints, challenge-as-Bearer, revoked session, cross-user code | `mfa-enrollment.e2e-spec.ts` | — | — |
| AS-09 status body per state, no secret | `mfa-enrollment.e2e-spec.ts` | — | — |
| AS-10 TOTP verifier: RFC 6238 vectors, ±1 step, replay step, malformed | — | — | `domain/totp.spec.ts` |
| AS-11 recovery-code generator and normaliser | — | — | `domain/recovery-code.spec.ts` (+ one `fast-check` property: uniqueness and alphabet) |
| AS-12 verify with TOTP → session, `amr`, new session ID, no-store | `mfa-login.e2e-spec.ts` | — | — |
| AS-13 cookie delivery; evil origin → 403, challenge not consumed | `mfa-login.e2e-spec.ts` | — | — |
| AS-14 replay of a used code and of a spent challenge | `mfa-login.e2e-spec.ts` | — | — |
| AS-15 concurrent verify: same challenge, and two challenges one code | `mfa-login.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-16 wrong codes identical 401; 3 attempts burn the challenge | `mfa-login.e2e-spec.ts` | — | — |
| AS-17 per-account throttle 5/15 min shared across endpoints, reset on success | `mfa-login.e2e-spec.ts` (frozen clock) | — | — |
| AS-18 per-IP throttle and throttle-before-validation | `mfa-login.e2e-spec.ts` | — | — |
| AS-19 challenge defects → identical `invalid_mfa_challenge`; challenge as access token | `mfa-login.e2e-spec.ts` | — | — |
| AS-20 recovery-code login (forms), spent after use, remaining count, event | `mfa-login.e2e-spec.ts` | — | — |
| AS-21 concurrent use of one recovery code | `mfa-login.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-22 password reset leaves the factor enabled | `mfa-login.e2e-spec.ts` | — | — |
| AS-23 verify body validation, 415 | `mfa-login.e2e-spec.ts` | — | — |
| AS-24 replay guard survives cache flush and restart | `mfa-login.e2e-spec.ts` (flush Redis, rebuild app) | — | — |
| AS-25 regenerate: old codes die, 409 when not enabled, 422 on wrong code | `mfa-management.e2e-spec.ts` | — | — |
| AS-26 disable with TOTP or recovery code, 409 / 422 | `mfa-management.e2e-spec.ts` | — | — |
| AS-27 recovery code cannot regenerate, step reuse refused, concurrent disable | `mfa-management.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-28 providers list (configured / not) | `oidc-login.e2e-spec.ts` | — | — |
| AS-29 start: URL parameters, PKCE, flow cookie, flow record | `oidc-login.e2e-spec.ts` | — | — |
| AS-30 start rejections: provider shapes, origin, media type, rate limit, bad `returnTo` | `oidc-login.e2e-spec.ts` | — | — |
| AS-31 callback creates account: cookies, link, events, provider-side PKCE check, no provider token persisted | `oidc-login.e2e-spec.ts` (fake provider) | — | — |
| AS-32 returning user, changed provider e-mail | `oidc-login.e2e-spec.ts` | — | — |
| AS-33 callback headers and redirect target, query params ignored | `oidc-login.e2e-spec.ts` | — | — |
| AS-34 return-path validator | — | — | `domain/return-path.spec.ts` |
| AS-35 ID-token attacks end in `oidc_token_invalid` | `oidc-login.e2e-spec.ts` (fake provider signs bad tokens) | — | — |
| AS-36 ID-token claim reader (`email_verified` forms, `sub` bounds, e-mail normalisation) | — | — | `domain/id-token-claims.spec.ts` |
| AS-37 callback state/cookie/provider failures, callback rate limit | `oidc-callback-hardening.e2e-spec.ts` | — | — |
| AS-38 concurrent callbacks, same state | `oidc-callback-hardening.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-39 provider `error=` and missing/repeated `code` | `oidc-callback-hardening.e2e-spec.ts` | — | — |
| AS-40 token-endpoint failures and oversized response | `oidc-callback-hardening.e2e-spec.ts` | — | — |
| AS-41 provider timeout: one request, no retry, within budget, counter | `oidc-callback-hardening.e2e-spec.ts` (fake provider hangs; the 3 s timeout is configured low for the test) | — | — |
| AS-42 discovery integrity and cache | `oidc-callback-hardening.e2e-spec.ts` | — | — |
| AS-43 unverified / missing e-mail → refused, nothing persisted | `account-linking.e2e-spec.ts` | — | — |
| AS-44 e-mail match on a password account: link + wipe password, factor, sessions, events | `account-linking.e2e-spec.ts` | — | — |
| AS-45 concurrent first logins; concurrent registration vs Google login | `account-linking.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-46 same provider, different subject, same e-mail → `link_conflict` | `account-linking.e2e-spec.ts` | — | — |
| AS-47 soft-deleted user → `account_unavailable` | `account-linking.e2e-spec.ts` | — | — |
| AS-48 linking decision table | — | — | `domain/link-decision.spec.ts` (`it.each` over the full combination grid; an exhaustiveness check ends in `assertNever`) |
| AS-49 explicit link start: auth, step-up with factor, 401 | `account-linking.e2e-spec.ts` | — | — |
| AS-50 explicit link callback and its conflicts | `account-linking.e2e-spec.ts` | — | — |
| AS-51 list identities, scoped to caller, schema | `account-linking.e2e-spec.ts` | — | — |
| AS-52 unlink: IDOR 404, last login method 409, idempotent, 401 | `account-linking.e2e-spec.ts` | — | — |
| AS-53 store rejects duplicate `(provider, subject)` and `(userId, provider)` | `account-linking.e2e-spec.ts` (direct insert in a seed helper, expects a unique violation) | — | — |
| AS-54 Google login with enabled factor → challenge cookie, then verify | `oidc-mfa.e2e-spec.ts` | — | — |
| AS-55 challenge-cookie verify: origin, missing, expired, body token precedence | `oidc-mfa.e2e-spec.ts` | — | — |
| AS-56 shop IdP is subject-only: new account, victim untouched | `oidc-providers.e2e-spec.ts` | — | — |
| AS-57 registry lifecycle: disabled, throws, invalidate, reserved prefixes | `oidc-providers.e2e-spec.ts` | — | — |
| AS-58 SSRF refusals for dynamic issuers | `oidc-providers.e2e-spec.ts` (real guard, stubbed resolver, spy on outbound transport) | — | — |
| AS-59 audit lines and metric counters | `mfa-oidc-observability.e2e-spec.ts` | — | — |
| AS-60 no secret in logs, URLs, errors across full flows | `mfa-oidc-observability.e2e-spec.ts` (log capture) | — | — |
| AS-61 error catalogue: problem schema, `code`, `requestId`; callback error codes | `mfa-oidc-observability.e2e-spec.ts` | — | — |
| AS-62 unopenable secret → generic 500, nothing spent, no session | `mfa-oidc-observability.e2e-spec.ts` | — | — |
| AS-63 ownership and boundary gates (0 identity findings; barrel no longer exports `FederatedIdentityModel`, `OidcService`) | — (static gate: `pnpm check:table-ownership --strict`, `pnpm check:boundaries`) | — | — |
| AS-64 event envelope, payload contents, same-transaction, none on rejection | `mfa-oidc-observability.e2e-spec.ts` (outbox rows) | — | — |
| AS-65 enrol → confirm → recovery codes → log out → log in with code | — | `packages/web/tests/auth.spec.ts` (W01, journey "MFA") | — |
| AS-66 "Continue with Google" → signed in on the return page | — | `packages/web/tests/auth.spec.ts` (W01, journey "Google"; fake provider) | — |

## Mandatory case coverage per endpoint (VII.3)

| Endpoint | Happy | Validation classes | 401 | IDOR / cross-user | Rate limit 429 | Concurrency | State guard |
|---|---|---|---|---|---|---|---|
| `GET /auth/mfa` | AS-09 | n/a | AS-08 | acts on principal only (AS-08) | n/a | n/a | n/a |
| `POST /auth/mfa/enroll` | AS-01 | n/a (no body) | AS-08 | n/a | n/a | n/a (last pending wins, AS-02) | AS-03 |
| `POST /auth/mfa/confirm` | AS-04 | AS-05 | AS-08 | AS-08 | AS-17 | AS-07 | AS-06 |
| `POST /auth/mfa/verify` | AS-12 | AS-23 | AS-19 | AS-16, AS-19 | AS-17, AS-18 | AS-15, AS-21 | AS-14, AS-16 |
| `POST /auth/mfa/recovery-codes/regenerate` | AS-25 | AS-05 (same DTO), AS-27 | AS-08 | acts on principal only | AS-17 | n/a | AS-25 |
| `POST /auth/mfa/disable` | AS-26 | AS-05 (same DTO) | AS-08 | acts on principal only | AS-17 | AS-27 | AS-26 |
| `GET /auth/oidc/providers` | AS-28 | n/a | n/a (public) | n/a | n/a | n/a | n/a |
| `POST /auth/oidc/:provider/start` | AS-29 | AS-30 | n/a (public) | n/a | AS-30 | n/a | n/a |
| `POST /auth/oidc/:provider/link/start` | AS-49 | AS-49 | AS-49 | acts on principal only | policy shared with start (AS-30) | n/a | AS-49 (factor state) |
| `GET /auth/oidc/:provider/callback` | AS-31 | AS-37, AS-39 | n/a (public, bound by flow) | AS-37 (other browser), AS-50 | AS-37 | AS-38, AS-45 | AS-37, AS-43–AS-47 |
| `GET /auth/identities` | AS-51 | n/a | AS-51 | AS-51 | n/a | n/a | n/a |
| `DELETE /auth/identities/:identityId` | AS-52 | AS-52 (non-UUID id → 404) | AS-52 | AS-52 | n/a | n/a | AS-52 |

Async consumers (VII.4): identity consumes no events, so there is no consumer test here. Duplicate-delivery and poison-message tests for the events it emits belong to the consuming capabilities (S28, S03) and the outbox (S53).

Fallback and degradation paths (VII.9): the provider-outage path is forced by AS-41, AS-42 and AS-40; the fail-closed rate-limit store path is S50's.
