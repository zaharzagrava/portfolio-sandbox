# W01 — Research and decisions

Format: Decision · Rationale · Alternatives. No `NEEDS CLARIFICATION` remains.

## R-01 What already exists (verified in code, 2026-10-11)

- **Built**: `POST/GET /api/bff/session`, `/mfa`, `/logout` (`libs/composition/bff/session/session.controller.ts`); `BFF_COOKIES`, `sessionResponseSchema`, `mfaRequiredResponseSchema` in `packages/contracts/src/bff/session.ts`; S01 `register` (202), `login`, `refresh`, `logout`, `logout-all`, `sessions` (GET), `me`; S02 `GET /auth/mfa`, `enroll`, `confirm`, `verify`, identities list/delete, OIDC providers/start/link-start/callback; web `lib/api/session.ts`, stand-in `account-slot.tsx` and `lib/problem.ts`.
- **Missing**: forwarding of `/api/*` with the session identity (C-FWD); `POST /api/bff/session/refresh`; S01 `password-reset/request|confirm` and `DELETE /auth/sessions/:id` (S01 P2/P3 stories were not built); S02 `recovery-codes/regenerate` and `disable` (S02 US3, P2); a way for tests to read mail; schemas `registerRequestSchema`, `passwordReset*`, `sessionListItemSchema`, MFA code request schemas; the C-OIDC hand-off.
- **Consequence**: the plan includes these backend items (Complexity Tracking in plan.md). C-OIDC is left to S48 + S02 and keeps `AUTH_OIDC_ENABLED` off.

## R-02 Rendering model and AS-62

- **Decision**: pages and layouts are Server Components; the session is read only in small async components under `<Suspense>` (`AccountSlot`, `SignedInRedirect`, `RequireSession`), via `getServerSession()` memoized with `React.cache`. W07 renders every document per request (nonce CSP), so there is **no build-time HTML shell**; AS-62 is reworded to "the shell streams first: static card/heading render immediately, session- and URL-dependent parts stream behind Suspense with same-size fallbacks; `next build` reports no runtime-data-outside-Suspense error". Only `test-plan.md`'s AS-62 row text changes (spec.md is not edited by the plan); the build gate and U-arch prove it.
- **Rationale**: Next guide *Authentication with Cache Components* Steps 1–2: read cookies inside a Suspense child; never at layout top level; never cache session data in plain `"use cache"`.
- **Alternatives**: Prerendered static shell (rejected: conflicts with nonce CSP, W07 decision); `proxy.ts` redirect (rejected: VI.5, AS-65).

## R-03 Authenticated forwarding (C-FWD)

- **Decision**: add `ForwardController` in `libs/composition/bff/forward`: `ALL /api/bff/f/*` is **not** exposed to the browser directly; `next.config.ts` rewrites the existing generic `/api/:path*` (and the SSE prefixes) to `${bffUrl}/api/bff/f/:path*`. The controller (1) resolves the target from an **allowlisted route table** (core API for `/api/*` except the prefixes owned by the SSE gateway: `/api/streams`, `/api/live/:id/events`, `/api/payment/stream`, `/api/assistant/*`), (2) strips `Cookie`, `Authorization`, `Host`, `X-CSRF-Token`, hop-by-hop headers from the inbound request, (3) when a BFF session cookie is present resolves the session through `SessionAccessService` (single-flight refresh already built) and attaches `Authorization: Bearer <access token>`; no session → forwards anonymously, (4) on non-`GET`/`HEAD` requires origin and CSRF (reuse `OriginGuard`/`CsrfGuard`) **only when a session cookie is present**, so anonymous flows (register, password reset, public POSTs) work without CSRF as AS-28 specifies, (5) streams the body both ways (no buffering, so SSE and uploads work), copies status, `Content-Type`, `Retry-After`, `Cache-Control` and problem+json unchanged, drops `Set-Cookie` from upstream, (6) refuses `/api/bff/*` and `/api/auth/refresh|login|logout` to avoid bypassing the session endpoints (`404 not_found`). `session_expired` from a failed refresh becomes `401 session_expired` problem (same code as the session endpoint).
- **Rationale**: S48 FR-043 and X.8.3 allow session/token handling and propagating the auth context; a pass-through creates no aggregate. One hop keeps `lib/api` modules of every capability unchanged apart from dropping the bearer header.
- **Alternatives**: Next route handler as forwarder (rejected: duplicates session crypto in Node-web; the BFF owns the store); per-endpoint BFF routes (rejected: dozens of near-identical controllers); S01 cookie delivery (rejected by the spec's Assumptions).
- **Risk**: streaming pass-through for `text/event-stream`; mitigated by an e2e check that the first event arrives before the upstream ends.

## R-04 `errors[]` shape on the wire

- **Finding**: `packages/contracts/problem.ts` defines `errors: {field, code}[]` (no `message`); the spec assumed `{field, message}`.
- **Decision**: keep the wire shape (`field`, `code`) and make the web side derive text from `(field, code)` through `lib/auth/copy.ts` (`fieldErrorMessage`), with the per-field fallbacks of AS-03 (`email` → "Enter a valid email address."; `password` → "Use 12 to 128 characters."; unknown → "Check this field."). If the backend adds an optional `message`, the UI ignores it (FR-040: no server text rendered). This is a **clarification of the spec's "server's field message" wording**, recorded here and in gaps.md; FR-043 strings stay the contract.
- **Alternatives**: add `message` to the global problem filter (rejected: changes S54 for every capability; server text is not to be rendered anyway).

## R-05 Session query, cross-tab and expiry

- **Decision**: `useAuth()` wraps `useQuery({ queryKey: queryKeys.auth.session(), queryFn: sessionApi.current, staleTime: 60_000, refetchOnWindowFocus: true, refetchOnReconnect: true, retry: false })` with `initialData` from the server-read session when the Server Component passes it through the provider (a `SessionBootstrap` client leaf receives only `{id, email, role}`). Query function: `200` → user; `401` → `null` (anonymous) and, if the previous value was a user, runs the expiry flow; `503`/network → throws, the hook maps to status `unavailable` while `data` keeps the last value (TanStack keeps previous data on error). `session-sync.ts` owns the `BroadcastChannel('auth')` and exposes `announce(type)`/`subscribe(handler)`; unsupported browsers fall back to the focus refetch.
- **Expiry flow** (`lib/auth/session-ended.ts`): a module-level one-shot guard (`let ended = false`, reset on sign-in) so concurrent 401s run it once; it clears the query cache, announces `signed-out`, calls `router.refresh()` through a registered callback, shows the sonner toast with the Sign in action. The shared axios client calls it from a response interceptor for `401` with codes `session_expired|unauthenticated|invalid_token` **only when the cache holds a user**; the interceptor never retries.
- **Rationale**: FR-004, FR-008; guard in module scope is acceptable (no React state) and is test-resettable.

## R-06 CSRF helper and client

- **Decision**: `lib/api/csrf.ts` exports `csrfHeaders()` (exact cookie-name match `__Host-bff-csrf`, no suffix matching) and `hasCsrf()`. `client.ts` keeps `apiClient = axios.create({ baseURL: '', withCredentials: true })`: request interceptor adds `X-CSRF-Token` to non-GET/HEAD/OPTIONS unless `config.anonymous === true` (register, reset request/confirm, session login/MFA use their own anonymous option); if the interceptor believes the user is signed in (query cache has a user) and the cookie is missing it rejects with a synthetic `csrf_missing` error and runs the expiry flow (AS-28). No `Authorization` is ever set; a lint rule forbids the identifier in `lib/`, `app/`, `components/`, `hooks/` outside tests.
- The S48-added `session.ts` uses `fetch`; to keep VI.3 and one error path, it is rewritten on top of `apiClient` (axios) and returns the typed result as today. Existing callers (none besides tests) change in the same task.
- **Alternatives**: keep `fetch` in `session.ts` and axios elsewhere (rejected: two CSRF paths).

## R-07 Forms

- **Decision**: controlled components with `useState` and small pure validators in each form file (limits are few and fixed); no Server Actions (FR-006). `react-hook-form` is installed but its resolver indirection adds nothing for 2–4 fields and complicates the "first invalid field gets focus / aria-describedby" rules that tests assert; revisit if a later spec has long forms.
- **Submission**: a single `useMutation` per form calls `lib/api`; pending state disables the button and makes fields `readOnly` (AS-12); a ref guard blocks a second submit in the same tick.
- **Alternatives**: Server Actions (rejected: FR-006, CSRF scheme), react-hook-form (rejected above).

## R-08 QR code

- **Decision**: `qrcode` package's `create()` returns the module matrix; a small `QrSvg` component renders `<svg>` rects from it (no HTML injection, no `dangerouslySetInnerHTML`, no image URL). `role="img"` with the FR-054 alternative text.
- **Alternatives**: `toString` SVG string injected as HTML (rejected: VI.7), external QR image service (rejected: leaks the secret).

## R-09 Google (C-OIDC) behind a flag

- **Decision**: `AUTH_OIDC_ENABLED` read on the server (`lib/config`), passed as a boolean prop to `LoginForm`/`SignInMethodsPanel`; providers come from `GET /api/auth/oidc/providers` (query `oidcProviders()`); button renders only when flag AND list contains `google` (FR-045). Unit tests run with the flag on (MSW); the journey stays `fixme`. Start → `POST /api/auth/oidc/google/start {returnTo}` → `window.location.assign(authorizationUrl)` after validating that `authorizationUrl` is `https:` (or the configured dev IdP origin).
- **Open contract**: `GET /api/bff/session` must accept the S02 cookie session after the callback; recorded as sibling follow-up for S48/S02.

## R-10 Password reset (S01 P3, built here)

- **Decision**: `POST /api/auth/password-reset/request {email}` → always `202 {status:"accepted"}` (same body/timing path for known and unknown addresses; unknown does no work beyond a dummy digest); known address: create a single-use token (32 random bytes, base64url), store only SHA-256 digest with `expires_at = now + 30 min` and invalidate older tokens of the user, hand the link `${SITE_URL}/reset-password#token=<token>` to the notifications port (S01 `contracts/identity-services.md`/S28) in the same call; the raw token is never written to an outbox payload, log or database column. `confirm {token, password}` → in one `TransactionRunner.run`: look up by digest, check unused and unexpired, apply the password policy (reuse S01's breached-password and length checks → `422 weak_password`, `400 validation_failed`), set the hash, mark token used, revoke every session of the user (S01 FR-083), emit `identity.password_changed`. Unknown/used/expired → `400 invalid_reset_token`. Routes, rate-limit policies (`auth.reset.ip`, code check of `auth.reset.account`, `auth.reset.confirm.ip`) and error codes follow `specs/domains/S01-auth-sessions/contracts/auth-http.md` exactly.
- **Rationale**: S01 FR-080..FR-084; the S28 catalogue's `?token=` is replaced by the fragment (contract D2).

## R-11 Dev mailbox for the reset journey

- **Decision**: in the dev/test notification provider, keep the last 50 sent messages in memory (`FakeEmailProvider` if one exists in `notification-providers.ts`, else a new `MemoryEmailProvider` selected by `EMAIL_PROVIDER=memory`) and expose `GET /api/dev/mailbox?to=<address>` returning `{messages:[{to,subject,text,links:string[]}]}` only when `NODE_ENV !== 'production'` AND `DEV_MAILBOX_ENABLED=true` (otherwise `404`). `tests/helpers.ts getResetLink(email)` polls it (web-first `expect.poll`).
- **Alternatives**: Mailpit container (rejected: extra infrastructure for the local stack); reading the database (rejected: tests would see digests, not tokens).

## R-12 Test strategy deltas

- Vitest `include` already covers `app|components|lib|hooks` `.test.{ts,tsx}`; `lib/**/*.test.ts` for server-only modules needs `vitest.server-only.ts` alias (present).
- Playwright: journeys under `desktop`; visual specs run on `desktop` and `mobile`. Journeys need `SEED.password`; `helpers.register()` becomes register → login through the UI.
- Backend e2e: new specs `bff-forward.e2e-spec.ts`, `bff-session-refresh.e2e-spec.ts` (inside `bff-session.e2e-spec.ts`), `password-reset.e2e-spec.ts`, `sessions-revoke.e2e-spec.ts`, `mfa-lifecycle.e2e-spec.ts`, `dev-mailbox.e2e-spec.ts`; each run with `scripts/sdd/test-spec.sh <pattern>`.
- SCs without an automated proof (SC-001, SC-002 at 100 %, SC-006) go to quickstart "Ops artifacts" and `specs/UNVERIFIED.md`.
