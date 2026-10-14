# Tasks: W01 — Auth and account (`packages/web` + backend gaps it needs)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `research.md`, `data-model.md`, `contracts/backend-endpoints.md`, `contracts/web-modules.md`, `quickstart.md`, constitution.

**Tests**: required (constitution VII, `test-plan.md`). Order is test-first: for every test-plan row the failing test task precedes the code task. Test keys (U-*, J*, V*) are those of `test-plan.md`; all web paths are relative to `packages/web/`, backend paths to `packages/backend/`.

**Rules for every task**: read `packages/web/AGENTS.md` and the relevant guide in `packages/web/node_modules/next/dist/docs/` before web code. Backend specs run with `/opt/sdd/repo/scripts/sdd/test-spec.sh <pattern>`; after backend edits wait for `GET http://localhost:8000/health/ready` = 200. Run the narrowest test; the whole suite once in the last phase. Same test failing after 5 attempts → write blocker, attempts and hypothesis in `questions.md` and stop. Never use git checkout/restore/reset/stash/clean; undo by hand-editing. No new direct `sequelize.transaction`; use `TransactionRunner.run`/`@Transactional`; a touched file with a `// S54 T037 audit` site is migrated and the comment deleted. Use `SEED.password` from `tests/helpers.ts`, never a literal. Do not edit other specs; record cross-spec needs in `gaps.md` under `## Sibling-spec follow-ups`.

## Format: `- [ ] Txxx [P?] [US?] Description with path`

## Phase 1: Setup (tooling verification, G1–G6, A8)

- [X] T001 Verify W07 tooling is present and working (G1–G5): RTL, user-event, jest-dom, msw, `@vitejs/plugin-react`, `@axe-core/playwright` in `package.json`; `vitest.config.ts` include covers `app/**`, `components/**`, `lib/**/*.test.{ts,tsx}`, `hooks/**/*.test.{ts,tsx}` and excludes `tests/**`; setup file has jest-dom, MSW lifecycle, `BroadcastChannel`/`matchMedia`/`ResizeObserver` stubs, `afterEach(cleanup)`; Playwright has `desktop` and `mobile` (390×844) projects and `tests/visual/`. Widen/add only what is missing. Proof: `pnpm test`.
- [X] T002 [P] Add `qrcode` (+ `@types/qrcode`) and workspace dependency `@marketplace-sandbox/contracts` to `package.json` (G6, E1); confirm it resolves from a Vitest test and from `next build`.
- [X] T003 [P] Add ESLint restrictions in `eslint.config.mjs` (A8): forbid `localStorage`, `sessionStorage`, `Authorization`, `document.cookie` (except `lib/api/csrf.ts`), `fetch`/`axios` outside `lib/api` (VI.3), and `dangerouslySetInnerHTML` (VI.7) in W01 code. Proof: `pnpm lint` reports the planted violations in a scratch file, then remove the scratch file.
- [X] T004 [P] Add the `lib/auth/copy.ts` skeleton (notices FR-043, provider errors FR-044, error copy per code, field messages derived from `(field, code)` per R-04) exporting the typed unions and empty catalogue entries to be filled by story tasks.

---

## Phase 2: Foundational — backend and `lib/api` (blocks all stories)

**⚠️ No story starts before this phase is green.** Backend tasks first (test-first inside each: e2e spec, then code).

### Backend (gaps D1–D3, D5, D6, D8, D9, E1; `contracts/backend-endpoints.md`)

- [X] T005 [P] Add contract schemas in `packages/contracts/src/auth/`: `registerRequestSchema {email, password}` `.strict()`, `passwordResetRequestSchema {email}`, `passwordResetConfirmSchema {token, password}`, `sessionListItemSchema {sessionId, device, ip, createdAt, lastUsedAt, current}`, `mfaCodeRequestSchema {code: string(1..64)}` `.strict()` (reused by confirm); export from the package index (explicit `.ts` import extensions). Add `packages/contracts` unit tests for accept/reject.
- [X] T006 Write failing e2e `libs/composition/bff/forward/bff-forward.e2e-spec.ts` (B-1): cart read with session reaches core with bearer and response unchanged; anonymous public GET; POST without CSRF → 403 `csrf_invalid`; wrong Origin → 403 `origin_not_allowed`; expired session → 401 `session_expired`; core 401 passed through; `Retry-After` passed; `/api/bff/*`, `/api/graphql`, `/api/auth/login|refresh|logout` → 404 `not_found`; core never sees `Cookie`/forged `Authorization`; SSE first event arrives before stream ends; two concurrent requests with an expiring token cause one refresh; store down → 503 `session_unavailable` with `Retry-After`; upstream unreachable → 502; oversize JSON → 413. Run `test-spec.sh bff-forward` (red).
- [X] T007 Implement `ForwardController`, allowlisted route table (SSE prefixes `/api/streams`, `/api/live/:id/events`, `/api/payment/stream`, `/api/assistant/*` → `sseUrl`; others → `apiUrl`; `streamBody` flag), streaming pass-through, header stripping, identity attach via `SessionAccessService`, `Cache-Control: no-store` with a session, in `libs/composition/bff/forward/` (B-1; forwards unchanged to one owning endpoint, no aggregate). Register in the BFF module. Proof: `test-spec.sh bff-forward` green.
- [X] T008 Add failing cases to `libs/composition/bff/session/bff-session.e2e-spec.ts` (B-2, B-3): `POST /api/bff/session/refresh` happy with role change visible, no cookie 401, bad CSRF 403 `csrf_invalid`, concurrent calls = one upstream refresh, store down 503; MFA cookie `Path=/` (change only the path assertion; `Max-Age`/`HttpOnly`/`Secure`/`SameSite` unchanged). Run `test-spec.sh bff-session` (red).
- [X] T009 Implement `POST /api/bff/session/refresh` (guards `CsrfGuard`, `OriginGuard`; forced refresh through `RefreshCoordinator`; returns `sessionResponseSchema`) in `libs/composition/bff/session/session.controller.ts`, and change `MFA_PATH` to `/` in `session/session-cookies.ts` (S48/S02 follow-up). Proof: `test-spec.sh bff-session` green.
- [X] T010 Write failing e2e `libs/domains/identity/**/password-reset.e2e-spec.ts` (B-4): request known/unknown address byte-identical body+headers (`202 {"status":"accepted"}`); mail only for the known address with link `<SITE_URL>/reset-password#token=`; confirm happy (old password fails, new works, other sessions revoked); reused/expired/unknown token → 400 `invalid_reset_token`; weak password → 422 `weak_password` and token still valid; `validation_failed` returns `{field, code}` pairs for `email` and `password` on register and on confirm (B-8); 429 on both routes; second request invalidates the first link; raw token absent from DB and logs; 401/403 not applicable noted.
- [X] T011 Add migration `packages/backend/migrations/<next free number>` creating `identity.password_reset_tokens`: `id` uuid PK; `user_id` uuid FK `identity.users(id)` on delete cascade, indexed; `token_digest` char(64) unique (SHA-256 hex; the token is never stored); `expires_at` timestamptz (`created_at + 30 min`), indexed; `used_at` timestamptz null (single use); `created_at` timestamptz default now.
- [X] T012 Implement password reset request/confirm in `libs/domains/identity` (entity, repository, service, thin controller; requesting sets `used_at = now()` on the user's older unused rows; confirm in `TransactionRunner.run`: consume token + set password + revoke all sessions; outbox event consumed by notifications S28; reset e-mail template with the fragment link in `libs/domains/notifications`). Proof: `test-spec.sh password-reset` green (D5, D8).
- [X] T013 Write failing e2e `sessions-revoke.e2e-spec.ts` (B-5): `DELETE /api/auth/sessions/:sessionId` 204 and target device's next request 401; another user's id → 404 `session_not_found` (IDOR); unknown id 404; already revoked 404; no auth 401.
- [X] T014 Implement `DELETE /api/auth/sessions/:sessionId` in `libs/domains/identity` and wire `sessionListItemSchema` into the existing GET. Proof: `test-spec.sh sessions-revoke` green.
- [X] T015 Write failing e2e `mfa-lifecycle.e2e-spec.ts` (B-6): regenerate happy (`200 {recoveryCodes[10]}`, old codes rejected at login), wrong code 422 `invalid_code`, recovery code not accepted for regenerate, disable with TOTP and with recovery code 204, `409 mfa_not_enabled`, 429 `rate_limited` after N wrong codes (shared failed-code counter), 401, no secret/digest in any response.
- [X] T016 Implement `POST /api/auth/mfa/recovery-codes/regenerate` and `POST /api/auth/mfa/disable` in `libs/domains/identity/api/mfa.controller.ts` per S02 `contracts/http.md`, using `mfaCodeRequestSchema`. Proof: `test-spec.sh mfa-lifecycle` green (D6).
- [X] T017 Write failing e2e `dev-mailbox.e2e-spec.ts` (B-7): disabled → 404; enabled returns the reset mail with `links`; `NODE_ENV=production` → 404 even when enabled; filter by `to`; bounded to 50 newest-first.
- [X] T018 Implement `MemoryEmailProvider` (`EMAIL_PROVIDER=memory`) in `libs/domains/notifications/infra` and `GET /api/dev/mailbox?to=` (only when `NODE_ENV !== 'production'` AND `DEV_MAILBOX_ENABLED=true`); set both env vars in the dev stack config and document in `quickstart.md` prerequisites (D9). Proof: `test-spec.sh dev-mailbox` green.
- [X] T019 Transaction audit (B-10): `grep -rn "S54 T037 audit"` over every backend file touched by T007–T018; migrate each site to `TransactionRunner.run`/`@Transactional` and delete the comment; confirm no new direct `sequelize.transaction`. Re-run the affected specs.
- [X] T020 Record sibling bullets in `gaps.md` `## Sibling-spec follow-ups` if not already present and keep them accurate after T007–T018 (S48 cookie path + forwarder/refresh routes; S48/S02 C-OIDC open; S01 reset/revoke and no auto-login after registration; S02 regenerate/disable; S28 fragment link + dev mailbox; S54 `errors[]` shape; W02 `product-page.spec.ts` and `returnTo`; W03–W06 adopt `returnTo`/`loginHref`/`requireServerSession`/read-only `useAuth`, W06 admin guard; W07 `lib/problem.ts` re-export + `/reset-password` header rule).

### `lib/api` rewrite (A1–A7, B11–B12, B14, E2, G9)

- [X] T021 [P] Write failing `lib/api/csrf.test.ts` (U-csrf, AS-28): reads `__Host-bff-csrf` exactly (not suffix matches), decodes; `{}` when absent. Then implement `lib/api/csrf.ts` (`csrfHeaders`, `hasCsrfCookie`).
- [X] T022 [P] Write failing `lib/api/errors.test.ts` (U-err, AS-67): `problemFromError` keeps only `status`, `code`, `errors[{field,code}]`, `retryAfterSeconds`, `requestId`; no `title`/`detail`; status 0 for no response. Then implement `lib/api/errors.ts` (`problemFromError`, `Problem`, `waitText` re-export) and make `lib/problem.ts` re-export it keeping W07 callers compiling (B12).
- [X] T023 Write failing `lib/api/client.test.ts` (U-client, AS-26/28/29/30), rewriting the existing file (G9): baseURL empty and every module issues `/api/...`; adds `X-CSRF-Token` to POST/PUT/PATCH/DELETE, not GET, not `anonymous: true`; missing CSRF cookie aborts and triggers expiry; never sets `Authorization`; 401 `session_expired|unauthenticated|invalid_token` with a cached user runs `endSession()` once for concurrent failures; 401/403/404 handling (AS-65).
- [X] T024 [P] Write failing `lib/auth/session-ended` test cases inside `lib/api/client.test.ts` or `lib/auth/session-ended.test.ts`, then implement `lib/auth/session-ended.ts` (`endSession()` one-shot, `rearmSessionEnd()`).
- [X] T025 Rewrite `lib/api/client.ts` (A1, A2, A4, A5): relative base, `withCredentials`, CSRF via `csrfHeaders`, no token state, no refresh interceptor, no `NEXT_PUBLIC_API_URL`; delete `setAccessToken`/`getAccessToken`/`refreshSession`. Update direct callers of the deleted exports so `tsc` passes (only what is needed to compile; behaviour moves in Phase 3 and T094).
- [X] T026 [P] Write failing `lib/api/graphql.test.ts` (U-gql, AS-31) then update `lib/api/graphql.ts` (A6): credentials + `X-CSRF-Token` on POST, no bearer.
- [X] T027 [P] Write failing `lib/api/sse-reader.test.ts` (U-sse, AS-31) then update `lib/api/sse-reader.ts` (A6): no `Authorization`, `credentials: 'include'`.
- [X] T028 Write failing `lib/api/session.test.ts` (U-api; MSW, problem+json fixtures parsed with contracts schemas) for `sessionApi.{login, verifyMfa, current, logout, refresh}` returning `SessionResult` with typed `code`; every response parsed, parse failure → `Problem` 500. Then extend `lib/api/session.ts` with `refresh` and the shared parse helper (E2).
- [X] T029 [P] Write failing tests then implement `lib/api/auth.ts` (`register`, `requestPasswordReset`, `confirmPasswordReset`; anonymous, contracts schemas) and `lib/api/account.ts` (`getMfaStatus`, `enrollMfa`, `confirmMfa`, `regenerateRecoveryCodes`, `disableMfa`, `listSessions`, `revokeSession`, `logoutAll`, `listIdentities`, `unlinkIdentity`, `listOidcProviders`, `startOidc`, `startOidcLink`; every response parsed, parse failure = `Problem` status 500) — tests in `lib/api/auth.test.ts` and `lib/api/account.test.ts`.
- [X] T030 Wire the generic `/api/:path*` rewrite through the BFF forwarder `/api/bff/f/*` (and SSE prefixes) in `next.config.ts` (A7, F4 prerequisites); keep `connect-src 'self'`. Verify with a Playwright-free curl of a cart read against the dev stack.
- [X] T031 [P] Delete dead types (`User.name`, `mfaEnabled`, `AuthTokens`, `LoginRequest.totpCode`, old role union) from `lib/types.ts` and use contract types (B14); delete `lib/api/auth-relay.ts` and `app/api/auth/**` after T025–T030 and fix their imports (S01/W01 follow-up); replace `lib/safe-return-url.ts` in T038.

**Checkpoint**: backend specs green, `pnpm test lib/api` green, `tsc` green.

---

## Phase 3: Session state (blocks all UI stories) (A3, A9–A12, B11, B13–B15)

- [X] T032 [P] Update `lib/query-keys.ts` (B15): `auth.session()`, `auth.mfaStatus()`, `auth.sessions()`, `auth.identities()`, `auth.oidcProviders()`; remove `auth.user`.
- [X] T033 [P] Write failing `lib/auth/return-to.test.ts` (U-ret, AS-07; replaces `lib/safe-return-url.test.ts`, G9): table-driven same vectors as S02 AS-34 incl. `/%2F%2Fevil.example`, control characters, length cap, backslashes, scheme-relative; `loginHref`. Implement `lib/auth/return-to.ts` (`safeReturnTo`, `loginHref`) and delete `lib/safe-return-url.ts` (B11).
- [X] T034 [P] Write failing `lib/auth/retry-after.test.ts` (U-wait, AS-09) then implement `lib/auth/retry-after.ts` (`formatWait`: seconds, minutes, hours, missing).
- [X] T035 [P] Write failing `lib/auth/session-sync.test.ts` (U-sync, AS-22) then implement `lib/auth/session-sync.ts` (`announceAuth`, `subscribeAuth` over `BroadcastChannel('auth')`; messages carry `{type}` only).
- [X] T036 [P] Write failing `lib/auth/guards.test.ts` (U-guard, AS-16/27/65): `authPageRedirect` table (signed in + returnTo; signed in + error code → security methods tab; anonymous → none); `requireServerSession` redirects to `loginHref(returnTo)`; guards only redirect. Implement `lib/auth/guards.ts` and `lib/auth/session.server.ts` (`import 'server-only'`, `getServerSession`, `requireServerSession`).
- [X] T037 Write failing `hooks/use-auth.test.tsx` (U-auth, AS-20/22/23): read-only `useAuth()` over `queryKeys.auth.session()`; 503 and network keep previous user with status `unavailable`; refetch on `online` and focus; focus-refetch fallback; `AuthBootstrap` seeds the first value from the server. Implement `hooks/use-auth.tsx` replacing `AuthContext`/`useState` (A3, A9, B13) and set `refetchOnWindowFocus` on the session query in `lib/providers.tsx` (A11); mount `AuthBootstrap`/`SessionBootstrap` under Suspense in `app/layout.tsx` (A10, F1).
- [X] T038 Write failing `hooks/use-auth-actions.test.tsx` (U-acts, AS-06/23/24/25/26): `useLogin` applies sign-in effects (session set, other queries invalidated, merge requested once, `router.replace` + `refresh`); `useVerifyMfa`; `useLogout` clears cache, broadcasts, navigates, and a failed logout (network, 403 `csrf_invalid`, 500) keeps the session and offers Try again; `useRefreshSession` writes the returned role; expiry drops cache, refreshes server guards, toasts with Sign-in link carrying `returnTo` + `notice=session_expired`, does not navigate a public page. Implement `hooks/use-auth-actions.ts` (A12, B13). Subscribe `session-sync` to the query client.
- [X] T039 Adapt existing callers to compile and behave the same with the new API, without redesigning them (Phase-8 minimum, F2): `app/dashboard/*` (incl. `seller/view.tsx` → `useRefreshSession`), `app/checkout/page.tsx`, chat view, assistant, `app/admin/**` — replace `returnUrl` with `returnTo`/`loginHref`, drop `Authorization`/`setAccessToken`/`refreshSession` use, and `useAuth` mutation use. Fix `tests/helpers.ts:29-35` `returnUrl` usage. Run each touched file's existing unit tests.

**Checkpoint**: `pnpm test lib hooks`, `tsc`, `pnpm lint` green.

---

## Phase 4: User Story 11 — Rendering, access and accessibility rules (P3, but its shared UI is needed first)

**Goal**: shared components, copy catalogue, auth shell, architecture rules.
**Independent test**: component tests pass; `next build` succeeds; U-arch green.

- [X] T040 [P] [US11] Write failing `components/auth/problem-alert.test.tsx` (U-prob, AS-66/67, SC-004): per-`code` catalogue copy, never raw `detail`/`title`/message text, Reference id shown, `role` (alert vs status), Reload button for csrf/origin. Implement `components/auth/problem-alert.tsx` (`ProblemAlert({problem, context})`) and fill `lib/auth/copy.ts` entries (B12).
- [X] T041 [P] [US11] Write failing `components/auth/password-input.test.tsx` (U-pw) then implement `components/auth/password-input.tsx` (show/hide toggle with accessible name, `autocomplete` per use, `aria-invalid`/`aria-describedby`).
- [X] T042 [P] [US11] Write failing `components/auth/code-input.test.tsx` (U-code, AS-37): digits only, paste normalisation, `maxlength`, `inputmode`/`autocomplete="one-time-code"`, Verify enabled at 6, no auto-submit. Implement `components/auth/code-input.tsx` (single field; replaces six-box input, B3).
- [X] T043 [P] [US11] Write failing `app/(auth)/login/auth-banner.test.tsx` (U-banner, AS-15; VP states later): one banner per allowlisted `notice`/`error` value with correct `role`, unknown ignored, input never echoed, table over FR-043/FR-044. Implement `app/(auth)/login/auth-banner.tsx` (B8).
- [X] T044 [US11] Fix `app/(auth)/layout.tsx` (B7, FR-050/FR-052): remove `/noise.png`, no `<h1>` in the decorative panel, no duplicate mobile logo, Server Component; add per-page `metadata` titles in each page as pages are built (B10).
- [X] T045 [US11] Write `lib/auth/architecture.test.ts` (U-arch, AS-62/63/65, red where applicable): every `page.tsx`/`layout.tsx` under `app/(auth)` and `app/account` has no `"use client"`; no layout reads the session at top level; no `"use cache"` function imports the session reader; no `proxy.ts`/`middleware.ts` makes an auth decision; `lib/api` is the only place with network calls. Make it pass as pages land.

---

## Phase 5: User Story 1 — Create an account (P1) 🎯 MVP

**Goal**: `/register` accepts email+password, shows identical outcome for new and existing addresses, lands on `/login?notice=registered` not signed in.
**Independent test**: `app/(auth)/register/register-form.test.tsx` green; JA register step (T052).

- [X] T046 [US1] Write failing `app/(auth)/register/register-form.test.tsx` (U-reg, AS-01..AS-05, AS-66/67): sends only `{email, password}` and navigates to `/login?notice=registered`; same outcome for every 202; table-driven client validation (invalid e-mail, 11 and 129 chars password — enforce the spec's exact length rule, mismatch, terms) with focus, `aria-invalid`, `aria-describedby`; `validation_failed` places field errors from `(field, code)`; `weak_password` clears passwords and focuses Password; no name/role field and expected tab order; one h1; console spies see no password/body.
- [X] T047 [US1] Implement `app/(auth)/register/page.tsx` (Server Component, title, signed-in redirect via `authPageRedirect`) and `register-form.tsx` (client leaf, plain controlled state per R-07, `PasswordInput`, no toast-only feedback, no auto-login) (B1, B9, B10, FR-020).
- [X] T048 [P] [US1] Add visual spec `tests/visual/auth-pages.spec.ts` (VP) `register` state (mobile, desktop; `page.route` stubs, animations disabled, axe serious/critical = 0, 320 px no horizontal scroll); generate and commit baselines.

---

## Phase 6: User Story 2 — Sign in (P1)

**Goal**: `/login` signs in through the BFF session, honours safe `returnTo`, handles every failure by `code`.
**Independent test**: `login-form.test.tsx` green; JA sign-in step.

- [X] T049 [US2] Write failing `app/(auth)/login/login-form.test.tsx` (U-login, AS-06, AS-08..AS-14, AS-58): announces "Signing in…" and disables while pending; credentials alert clears and focuses password (switch on `code`, never message text); `Retry-After` disables Sign in and re-enables via fake timers; 503/500/network → catalogue copy, values kept, Reference id; csrf/origin → verify alert with Reload; double submit sends one request and fields read-only; MFA hand-off navigates to `/login/mfa?returnTo=…` with history replaced and nothing else in the URL; no Remember me/GitHub; tab order with "Forgot password?" after the password input; Google button only when provider offered and `AUTH_OIDC_ENABLED`; start calls `POST …/start` then navigates to `authorizationUrl`; start failure shows AS-10 copy.
- [X] T050 [US2] Implement `app/(auth)/login/page.tsx` (Server Component; reads `returnTo`, `notice`, `error`; `authPageRedirect`; Suspense around client leaves), `login-form.tsx` (uses `useLogin`; no `autoFocus`), `google-button.tsx` (client leaf, behind `AUTH_OIDC_ENABLED`) and wire `/login?error=<code>` banners via `AuthBanner` (B2, B8, B9, D4 gated).
- [X] T051 [P] [US2] Add VP states `login`, `login: credentials error`, `login: notice banner` (mobile, desktop) and commit baselines.
- [X] T052 [US2] Rewrite `tests/auth.spec.ts` (JA, G7, G8, AS-01/06/19/21/24/27/29) as `Authentication › register, sign in, stay signed in, sign out` using roles/labels, `register` helper (registers then signs in), `login` with `returnTo`, `signOut`; steps: anonymous `/account/security` redirects to login; register → `/login?notice=registered`; sign in lands on `returnTo`; reload and second page in same context stay signed in; account menu shows e-mail; storage/`document.cookie`/URL contain no token, only `__Host-bff-csrf` readable, no request carries `Authorization`; sign out → `/login?notice=signed_out`. Update `tests/helpers.ts` (`register`, `login`, `signOut`, `SEED.password`).
- [X] T053 [US2] Add `tests/bff-session.spec.ts` (S48 follow-up): sign in via the BFF, cookies set (`__Host-bff-session` HttpOnly, `__Host-bff-csrf` readable), authenticated forwarded call works, POST without CSRF is refused, logout clears cookies.

---

## Phase 7: User Story 3 — Navbar tells the truth (P1)

**Goal**: real `AccountSlot`/`MobileAccountEntries`; no signed-out flash; entries at every width.
**Independent test**: U-slot, U-menu, VN.

- [X] T054 [US3] Write failing `components/auth/account-slot.test.tsx` (U-slot, AS-18) and `components/auth/account-menu.test.tsx` (U-menu, AS-17/19/20/23/25): same-size placeholder with `aria-busy`, resolves to menu without ever rendering Log in; anonymous Log in/Sign up links and mobile icon link named "Log in"; menu opens with Enter/Space/ArrowDown, arrow navigation, Escape returns focus, accessible button name, shows e-mail and role, entries order incl. "Account & security", Admin entry via W06 `isAdmin`; `unavailable` shows retry button not anonymous controls; new role shown; logout failure toast copy.
- [X] T055 [US3] Replace the body of `components/auth/account-slot.tsx` (keep `AccountSlot`, `AccountSlotSkeleton`, `MobileAccountEntries` names/props), add `components/auth/account-menu.tsx` and `AccountSlotClient` (retry, online/focus); server-read session under its own Suspense boundary (C1–C4, A10, F1). Do not edit `components/layout/navbar.tsx` (C5).
- [X] T056 [P] [US3] Add `tests/visual/auth-navbar.spec.ts` (VN): `anonymous` (mobile header + open sheet, desktop), `loading` (route delayed, no layout shift), `signed in: menu open` (mobile sheet, desktop); axe scan; baselines.

---

## Phase 8: User Story 4 — Sign out and sessions that end on their own (P1)

**Goal**: sign-out, failure handling, expiry mid-use, cross-tab sync.
**Independent test**: U-acts/U-sync/U-client (already written in Phases 2–3); JA sign-out step.

- [X] T057 [US4] Wire `useLogout` into `AccountMenu` (toast + Try again on failure), register the expiry handler (`endSession`) at provider level in `lib/providers.tsx`, and add the `/login?notice=session_expired|signed_out|signed_out_everywhere|password_reset` copy. Proof: U-menu/U-acts/U-sync green.
- [X] T058 [US4] Extend JA with a two-page cross-tab step (sign out in one page, other shows anonymous within 1 s) in `tests/auth.spec.ts`; two-tab scope only (SC-002 beyond two tabs is in Ops artifacts).

---

## Phase 9: User Story 5 — No token in the browser, CSRF on every change (P1)

**Goal**: guarantees AS-28..AS-31 hold across the app.
**Independent test**: U-csrf, U-client, U-gql, U-sse (T021–T027) and JA storage assertions (T052).

- [X] T059 [US5] Run `pnpm lint` and U-arch over the whole `packages/web` tree; remove any remaining `Authorization`, token storage, `NEXT_PUBLIC_API_URL`, or `fetch` outside `lib/api` found (A1–A6, A8). Proof: lint + U-arch green, `grep -rn "NEXT_PUBLIC_API_URL\|setAccessToken\|auth-relay" packages/web` empty.

---

## Phase 10: User Story 6 — Second step at sign-in (P1)

**Goal**: `/login/mfa` finishes sign-in with TOTP or recovery code; old `/mfa` removed.
**Independent test**: `mfa-form.test.tsx`; JM sign-in step.

- [X] T060 [US6] Write failing `app/(auth)/login/mfa/mfa-form.test.tsx` (U-mfa, AS-32..AS-38): posts code and applies sign-in effects; recovery mode toggles back and forth and accepts case/hyphen/space variants; `invalid_mfa_code` and `invalid_code` show the same alert, field cleared and focused; `mfa_not_pending`, `invalid_mfa_challenge`, `invalid_token` replace the form with timed-out message and Back-to-sign-in link carrying `returnTo`; 429 disables Verify for `Retry-After`; tab order; challenge never in URL.
- [X] T061 [US6] Implement `app/(auth)/login/mfa/page.tsx` and `mfa-form.tsx` using `CodeInput` and `useVerifyMfa`; delete `app/(auth)/mfa/**` and add `/mfa` removal/redirect in `next.config.ts` (B3, F4, FR-022).
- [X] T062 [P] [US6] Add VP state `mfa` (mobile, desktop) and baselines.

---

## Phase 11: User Story 7 — Forgot my password (P2)

**Goal**: `/forgot-password` and `/reset-password` with fragment token; referrer policy.
**Independent test**: U-forgot, U-reset; JR.

- [X] T063 [P] [US7] Write failing `app/(auth)/forgot-password/forgot-password-form.test.tsx` (U-forgot, AS-39/40): confirmation only on 202 with focus on heading; 429, 400, 500, network keep the form, never show confirmation; no `console.error` of raw errors.
- [X] T064 [P] [US7] Write failing `app/(auth)/reset-password/reset-password-form.test.tsx` (U-reset, AS-41..AS-44): reads token from `location.hash`, strips it via `history.replaceState` (SC-007), keeps it in a ref only; submits `{token, password}`; success screen with Sign in link (`notice=password_reset`); no token → no request and invalid-link state, `invalid_reset_token` same state; `weak_password`, `validation_failed`, 429 keep form and in-memory token; client checks send nothing; tab order.
- [X] T065 [US7] Implement `forgot-password/page.tsx` + `forgot-password-form.tsx` (B4) and `reset-password/page.tsx` + `reset-password-form.tsx` (B5), both Server Component pages with client leaves.
- [X] T066 [US7] Add the `/reset-password` `Referrer-Policy: no-referrer` path rule in `lib/security/headers.ts` (only that rule; F3, AS-64) with a unit assertion in its existing test file.
- [X] T067 [P] [US7] Add VP states `forgot-password`, `forgot-password: sent`, `reset-password`, `reset-password: invalid link` and baselines.
- [X] T068 [US7] Add `tests/auth-password-reset.spec.ts` (JR, G7 `getResetLink(email)` reading `GET /api/dev/mailbox`): request link → confirmation; open link, assert URL has no fragment after load and `Referrer-Policy: no-referrer` and no third-party request; set password; sign in with it; `password_reset` notice shown.

---

## Phase 12: User Story 8 — Two-step verification in my account (P2)

**Goal**: `/account/security` with tabs; two-step enrol, codes, regenerate, disable.
**Independent test**: U-tabs, U-two, U-codes; JM.

- [X] T069 [P] [US8] Write failing `app/account/security/security-tabs.test.tsx` (U-tabs, AS-53): tablist keyboard (arrows, Home, End), only the active panel in the accessibility tree, tab in URL `?tab=two-step|sessions|methods`.
- [X] T070 [P] [US8] Write failing `app/account/security/two-step-panel.test.tsx` (U-two, AS-45..AS-52) and `recovery-codes-dialog.test.tsx` (U-codes, AS-47): skeleton, error with Retry (other tabs unaffected), none/pending/enabled, low and zero `recoveryCodesRemaining` prompt to regenerate (legacy codes not migrated); three-step setup, QR with text alternative and Copy key; `invalid_code`, 429, `mfa_not_pending` on confirm; `mfa_already_enabled`/`mfa_not_enabled`/`mfa_not_pending` close dialog, refetch, toast; Start over from pending; regenerate asks TOTP only; turn off warns and accepts TOTP or recovery code; Done disabled until acknowledged, Escape/outside click blocked, `beforeunload` registered, Copy all and Download, nothing left in cache/storage/DOM after close (`gcTime: 0`).
- [X] T071 [US8] Implement `app/account/security/page.tsx` (+ the guard: `app/account/layout.tsx` and `member-guard.tsx` with `requireServerSession`, F1/F2 — a minimal guard and a placeholder page already exist, built early by the repair step so T052's anonymous-redirect assertion can pass; T071 replaces the placeholder), `security-tabs.tsx`, `two-step-panel.tsx`, `recovery-codes-dialog.tsx` (QR from `qrcode` data rendered as SVG element tree, never injected HTML, R-08); add `/account` → `/account/security` redirect in `next.config.ts` (B6, F4).
- [X] T072 [P] [US8] Add `tests/visual/account-security.spec.ts` (VA) states `two-step: enabled, none`, `two-step: setup dialog`, `two-step: recovery codes`, `security: tabs and dialogs`; baselines.
- [X] T073 [US8] Add `tests/auth-mfa.spec.ts` (JM, G7 `totp(secret)` RFC 6238, no new dependency): enable two-step (QR visible, read key, confirm with `totp(key)`, codes shown, acknowledge, Done), sign out, sign in with code.

---

## Phase 13: User Story 9 — See and end my sessions (P2)

**Independent test**: U-sess; JS.

- [X] T074 [US9] Write failing `app/account/security/sessions-panel.test.tsx` (U-sess, AS-54..AS-56): skeleton, error with Retry, rows with `<time>` elements, current row without revoke control; `404 session_not_found` removes row, other errors toast and keep it; log-out-everywhere confirmation dialog, success ends local session → `/login?notice=signed_out_everywhere`.
- [X] T075 [US9] Implement `sessions-panel.tsx` (stable keys by `sessionId`, VI.6) and wire the tab.
- [X] T076 [P] [US9] Add VA state `sessions: table (desktop), cards (mobile)` and baselines.
- [X] T077 [US9] Add `tests/auth-sessions.spec.ts` (JS): two contexts, list shows "This device", revoke second device, row disappears, that context signed out on its next request; log out everywhere lands on `/login?notice=signed_out_everywhere`.

---

## Phase 14: User Story 10 — Google and sign-in methods (P3, conditional on C-OIDC)

**Independent test**: U-meth; JG is `fixme`.

- [X] T078 [US10] Write failing `app/account/security/sign-in-methods-panel.test.tsx` (U-meth, AS-61): list, empty state, Link Google with and without a code (`startOidcLink`, navigate to `authorizationUrl`), `?linked=google` banner, `?error=<code>` banner, unlink 204/404/409 `last_login_method`; switch on `code`.
- [X] T079 [US10] Implement `sign-in-methods-panel.tsx`; Google features render only when providers are offered and `AUTH_OIDC_ENABLED` (D4 gated; C-OIDC not built).
- [X] T080 [US10] Add `tests/auth-google.spec.ts` (JG) with `test.fixme` for `continue with Google`, `google with two-step`, `link and unlink Google` until C-OIDC (AS-58..61).

---

## Phase 15: Polish, close-out and ops artifacts

- [X] T081 Reword AS-62 in `test-plan.md` to "the shell streams first" (no build-time HTML shell) keeping the proof (`next build` + U-arch) (W07 follow-up).
- [X] T082 Verify gaps.md coverage: walk A1–H and mark each as done/gated in `gaps.md` "Plan corrections" (append a short "Status at close" list) — every item has a task above (A1–A6→T025–T027; A7→T030; A8→T003; A9–A12→T037–T038; B1→T047; B2→T050; B3→T061; B4/B5→T065; B6→T071; B7→T044; B8→T043; B9→T047/T050; B10→T044; B11→T033; B12→T022/T040; B13/B14→T031/T037; B15→T032; C1–C5→T055; D1–D3→T007/T009; D4→gated T079/T080; D5/D6→T012/T014/T016; D7→T010; D8→T012; D9→T018; D10 none; E1/E2→T005/T028/T029; F1→T037/T055; F2→T039/T071; F3→T066; F4→T061/T071; F5 none; G1–G6→T001–T002; G7→T052/T068/T073; G8→T052/T073/T077/T080; G9→T023/T033; G10→T001).
- [X] T083 Confirm Ops artifacts: `quickstart.md` lists SC-001, SC-002 (beyond two tabs), SC-006, and `specs/UNVERIFIED.md` has the three W01 rows with status `not run`; verify no other SC-nnn lacks an automated proof (SC-003 → JA storage assertions + U-client/U-err; SC-004 → U-prob; SC-005 → axe in VP/VN/VA; SC-007 → U-reset + JR; SC-008 → U-reg) and add rows for any that lack it. Never describe unverified criteria as verified.
- [X] T084 Final static gates: `pnpm exec tsc --noEmit && pnpm lint && pnpm build` in `packages/web` (no runtime-data-outside-Suspense error).
- [x] T085 (deferred to the final checkpoint: `cd packages/web && pnpm exec playwright test` and `scripts/sdd/test-spec.sh "bff-forward|bff-session|password-reset|sessions-revoke|mfa-lifecycle|dev-mailbox"`; vitest and tsc were green at 20:33 UTC: 167 files, 2212 tests) Final runs, once: whole web suite (`pnpm test`, then `pnpm exec playwright test`), then backend capability specs once (`test-spec.sh "bff-forward|bff-session|password-reset|sessions-revoke|mfa-lifecycle|dev-mailbox"` and the existing S01/S02/S48 specs touched). Record the green run (VII.9) and report each cross-spec follow-up handled (S02/S48 C2 items, `__Host-bff-mfa` path, `bff-session.spec.ts`, W07 items, `SEED.password`, relays removed).

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (backend T005–T020 in the listed order; `lib/api` T021–T031 may run in parallel with backend after T005) → Phase 3 → Phase 4 → stories.
- US1 (Phase 5) is the MVP together with US2 (Phase 6) and US3 (Phase 7): register → sign in → truthful navbar. US4/US5 follow; US6 needs US2; US7 independent of US6; US8 and US9 need US2/US3 and backend T015–T016/T013–T014; US10 is gated.
- T068 needs T018 (mailbox) and T012; T073 needs T016; T077 needs T014; T053 needs T007/T009.
- Within each story: test task → implementation task → visual/journey task.

## Parallel opportunities

- Phase 1: T002, T003, T004. Phase 2: T005 ∥ T021/T022/T026/T027; independent backend groups (reset T010–T012, revoke T013–T014, MFA T015–T016, mailbox T017–T018) after T005. Phase 3: T032–T036. Phase 4: T040–T043. Phase 11: T063 ∥ T064. Phase 12: T069 ∥ T070. All visual-baseline tasks marked [P] run alongside the next story's tests.

## Implementation strategy

MVP = Phases 1–3 + US1 + US2 + US3 (register, sign in, navbar), validate with `auth.spec.ts` and `bff-session.spec.ts`; then US4–US6 (P1), then US7–US9 (P2), US11 rules throughout, US10 gated; close with Phase 15.

## Phase 16: Convergence

- [X] T086 Fix the failing B-4 e2e `libs/domains/identity/password-reset.e2e-spec.ts:240` ("more than 3 requests for one address in an hour are 429 for known and unknown addresses alike"): after `t.rateTime.advance(3_600_001)` the first request for `ghost@example.com` is still 429, so either the per-IP window is not advanced by the test clock or the limiter keeps state the test cannot reset. Decide which side is wrong, correct it, keep known/unknown responses byte-identical, and prove with `test-spec.sh password-reset` green per T010/T012 (partial)
- [X] T087 Remove the throwaway debug spec `packages/web/tests/zz-dbg.spec.ts` (cart/checkout trace with `console.log`; no W01 task or test-plan row calls for it) per plan: test inventory (unrequested)
- [X] T088 Make `pnpm exec tsc --noEmit` in `packages/web` green: it fails only on stale generated types in `.next-prod/types/validator.ts` that reference the deleted `app/(auth)/mfa/page` and `app/api/auth/{login,logout,mfa/verify,refresh}/route`; exclude `.next-prod` in `tsconfig.json` or remove the stale output so the T084 gate does not depend on leftovers per T031/T061/T084 (partial)
- [X] T089 Reconcile `gaps.md` "Deferred until a later pass": its first bullet says T052 stays unticked pending `app/account/security`, but T052 is ticked, `app/account/{layout,member-guard}.tsx` and a placeholder page exist, and `tests/auth.spec.ts` passes at the desktop project; rewrite the bullet to the current state and run `tests/auth.spec.ts` at the mobile project once to confirm per T052 (partial)

## Phase 17: Convergence

- [X] T090 Run the final proofs that T085 only deferred, once, and record the result (green or failing test names) under "Status at close" in `gaps.md` per T085/VII.9: `cd packages/web && pnpm exec playwright test --reporter=line` (desktop and mobile projects, including `auth.spec.ts` at mobile for T089, `bff-session`, `auth-mfa`, `auth-password-reset`, `auth-sessions`, `tests/visual/*`), then `scripts/sdd/test-spec.sh "bff-forward|bff-session|password-reset|sessions-revoke|mfa-lifecycle|dev-mailbox"`; fix W01 failures, and do not treat T085 as proven until both are green (partial)
- [X] T091 Remove the stray log `packages/web/pw-full.log` (82 KB Playwright output, untracked, not covered by `.gitignore`; no task or test-plan row calls for it) per plan: test inventory (unrequested)
- [X] T092 Reconcile T084 with the lint state: `pnpm lint` in `packages/web` still exits 1 with 4 errors, none in W01 files (`app/chat/chat-view.tsx:109`, `app/dashboard/seller/[shopId]/developers/webhooks/view.tsx:50`, `components/assistant/chat-interface.tsx:60`, `hooks/use-event-stream.ts:13`); do not edit those files here, add each as a bullet under "## Sibling-spec follow-ups" in `gaps.md` naming its owner capability, and note in the gate record that W01's own files lint clean per T084 (partial)

## Phase 18: Convergence

- [X] T093 Record the W02 beacon follow-up (S48/W01 forwarder H9) as a decision in `gaps.md` per the W02 follow-up (partial): `navigator.sendBeacon` in `packages/web/lib/api/events.ts` cannot send `X-CSRF-Token`, so for a signed-in visitor the forwarder answers `csrf_invalid` to the unload batch; `bff-forward.e2e-spec.ts` ("S48 W02-H9") already pins "no exemption, loss accepted" and nothing in W01 records the choice. Under "Decisions taken", state that W01 accepts the loss (the 5 s timer path uses `fetch` with the header), or add the `/api/events` exemption with its e2e proof; either way mention it in the final report (LOW)
