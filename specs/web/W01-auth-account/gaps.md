# Gaps: current code vs W01 spec

Files in scope: `packages/web/app/(auth)/*`, `app/layout.tsx`, `components/layout/navbar.tsx`, `hooks/use-auth.tsx`, `lib/api/{client,graphql,sse-reader,errors}.ts`, `lib/{safe-return-url,query-keys,providers,types}.ts`, `next.config.ts`, `tests/{auth.spec,helpers}.ts`, `vitest.config.ts`, `playwright.config.ts`, and the callers of `useAuth`. Line numbers refer to the files as read on 2026-10-06. This is the implementation agent's to-do list; order of work is at the end. Nothing was changed while writing the spec.

## A. Session model, tokens and CSRF (constitution VI.2, P0504, P0512)

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Access token kept in a module variable and sent as `Authorization: Bearer` on every request | `lib/api/client.ts:13-24,48-51` | FR-001, AS-29 |
| A2 | Browser-side refresh: `refreshSession()` posts to `/api/auth/refresh`, an axios 401 interceptor retries requests and queues callers | `client.ts:58-131` | FR-008, AS-26 (the BFF refreshes; the browser must not) |
| A3 | Session restored on mount by a refresh call in `useEffect`, with an epoch ref to dodge races | `hooks/use-auth.tsx:41-59` | FR-004 (one TanStack Query key, server-rendered first value) |
| A4 | CSRF header reads the old `__Host-csrf` cookie and sends `x-csrf-token` | `client.ts:26-34,52-54` | FR-003 (`__Host-bff-csrf` → `X-CSRF-Token`; one helper in `lib/api/csrf.ts`) |
| A5 | Absolute base URL `NEXT_PUBLIC_API_URL \|\| 'http://localhost:3000'` | `client.ts:3,5-11` | FR-002, AS-30 (relative URLs only; remove the env var) |
| A6 | GraphQL client sends the memory token as bearer; SSE reader sends bearer | `lib/api/graphql.ts:1,20-23`, `lib/api/sse-reader.ts:51-59` | FR-001, AS-31 |
| A7 | `/api/*` is rewritten straight to the core API (`API_URL`), so a BFF session cookie would never be exchanged for a token for REST calls | `next.config.ts:42` (rewrites `31-44`) | C-FWD (see section D) |
| A8 | No static guard against token handling creeping back (`localStorage`, `sessionStorage`, `Authorization`, `document.cookie` outside the CSRF helper) | `eslint.config.mjs` | AS-29, AS-67: add `no-restricted-properties`/`no-restricted-syntax` rules for W01 code |
| A9 | Two sources of truth for "who am I": `AuthContext` (`useState`) and, elsewhere, per-page `useAuth()` effects | `use-auth.tsx:34-116`; `dashboard-shell.tsx:33`, `checkout/page.tsx:41`, `chat-view.tsx:47` | FR-004, FR-009 (read-only `useAuth()` over the query; server guard helper) |
| A10 | `AuthProvider` wraps the whole tree in the root layout and runs client-side only; the navbar can only know the user after hydration plus a network call (a signed-in member sees the signed-out controls until that call returns) | `app/layout.tsx:36-41`, `navbar.tsx:126,164` | AS-18, FR-005 (`<AccountSlot/>` under Suspense, server-read session) |
| A11 | Default `refetchOnWindowFocus: false` for all queries; the session query needs it on | `lib/providers.tsx:15-18` | FR-004, AS-20, AS-22 |
| A12 | No cross-tab propagation of sign-in/sign-out | — | AS-22, FR-030 |

## B. Pages and forms

| # | Gap | Where | Spec |
|---|---|---|---|
| B1 | Register page is a `'use client'` page, signs the visitor in, goes to `/`, shows a "Full name" field the API rejects, minimum password 8, toast-only feedback | `register/page.tsx:1,20-31,55-57,76-87` | FR-020, FR-006, AS-01..AS-05 |
| B2 | Login form: `returnUrl`; MFA hand-off puts the challenge in the URL (`/mfa?token=…`); dead "Remember me"; Google and GitHub buttons without handlers; "Forgot password?" link sits in the label row before the password input (wrong tab order); `autoFocus`; errors only as toasts that print server `detail` | `login-form.tsx:22-26,34,53,57-60,86,95-103,116-128,147-158` | FR-021, AS-06..AS-15 |
| B3 | MFA form: token from the URL, six one-digit inputs, auto-submit on the sixth digit, error text from `error.response?.data?.message`, dead "Use recovery code instead" button, redirect + toast when the token is missing | `mfa/mfa-form.tsx:18-30,39,54-62,132-136` | FR-022, AS-32..AS-38 |
| B4 | Forgot password: wrong endpoint (`/api/auth/forgot-password`), swallows every error (including no network) and always shows "Check your email", `console.error(error)` logs the raw error, page is `'use client'` | `forgot-password/page.tsx:1,36-45` | FR-023, AS-39, AS-40, AS-67 |
| B5 | No `/reset-password` page | — | FR-024, AS-41..AS-43 |
| B6 | No `/account/security` page: no two-step enrolment, recovery codes, regenerate, disable, no sessions list, no linked identities; the navbar menu links to `/dashboard`, `/dashboard/orders` only; the dashboard nav links `/dashboard/settings`, which has no page | `navbar.tsx:147-156`, `dashboard-shell.tsx:15` | FR-025..FR-027, AS-45..AS-61 |
| B7 | Auth layout: references `/noise.png` that does not exist in `public/`; decorative panel contains an `<h1>` (second `h1` on every page); mobile logo duplicates the navbar's | `(auth)/layout.tsx:10,17-19,31-36` | FR-050, FR-052, AS-66 |
| B8 | No `notice` / `error` banners; success is a toast ("Successfully logged in!", "Registration successful!") | `login-form.tsx:52,57`, `register/page.tsx:56` | AS-15, FR-043, FR-044 |
| B9 | Signed-in visitors can open `/login`, `/register` | `(auth)/login/page.tsx`, `register/page.tsx` | AS-16 |
| B10 | No per-page document titles (root metadata only) | `app/layout.tsx:18-21` | FR-052 |
| B11 | `safeReturnUrl` accepts `/%2F%2Fevil.example`, `/a\nb`, any length; callers still use `returnUrl` | `lib/safe-return-url.ts:2-4`, `checkout/page.tsx:41`, `chat-view.tsx:47`, `tests/helpers.ts:29-35` | AS-07, FR-010 (replace with `safeReturnTo`, `loginHref`) |
| B12 | Error helper prints server `detail`; no problem model (`code`, `errors[]`, `Retry-After`, `requestId`), no copy catalogue | `lib/api/errors.ts:6-16` | FR-040..FR-043 |
| B13 | `useAuth` exposes mutations and `any`-typed arguments; `User` has an optional `name` and a role union without `MODERATOR` | `use-auth.tsx:8-30,72-102` | Provides: `useAuth`, `useLogin`, `useVerifyMfa`, `useLogout`, `useRefreshSession` |
| B14 | Dead and wrong auth types (`User.name`, `mfaEnabled`, role `buyer\|seller\|admin`, `AuthTokens`, `LoginRequest.totpCode`) | `lib/types.ts:9-30` | delete; use contract types |
| B15 | `queryKeys.auth.user` is the only auth key | `lib/query-keys.ts:8` | FR-011 (`session`, `mfaStatus`, `sessions`, `identities`, `oidcProviders`) |

## C. Navbar account slot

| # | Gap | Where | Spec |
|---|---|---|---|
| C1 | Log in / Sign up are `hidden md:flex`, and the hamburger sheet has no auth entries: a visitor on a phone cannot reach sign-in | `navbar.tsx:164-171,50-66` | AS-17 |
| C2 | Account button has no accessible name except the avatar initials; menu closes on item select but focus return is unchecked; no "Account & security" entry; role not shown | `navbar.tsx:129-156` | AS-19, FR-052 |
| C3 | Logout calls `logout` directly as `onClick` and always "succeeds" | `navbar.tsx:158`, `use-auth.tsx:84-96` | AS-24, AS-25 |
| C4 | No loading placeholder, no unavailable state, no retry | `navbar.tsx:122-172` | AS-18, AS-20 |
| C5 | The navbar frame belongs to W07; W01 must hand over `<AccountSlot/>` and `<MobileAccountEntries/>` rather than edit the frame in two specs | `components/layout/navbar.tsx` | Cross-capability contracts (Provides/Requires W07) |

## D. Missing or unconfirmed backend endpoints

None of these exist in code today (the S01/S02/S48 specs' own `gaps.md` files list their implementation); W01 cannot be completed without them.

| # | Endpoint / capability | Owner | Why W01 needs it |
|---|---|---|---|
| D1 | `POST /api/bff/session`, `POST /api/bff/session/mfa`, `GET /api/bff/session`, `POST /api/bff/session/logout`, cookies `__Host-bff-session`, `__Host-bff-csrf`, `__Host-bff-mfa` (S48 FR-040..FR-049) | **S48** (`libs/composition/bff`, `apps/bff`) | the whole session model; S48's own gaps say session handling does not exist |
| D2 | **C-FWD**: forwarding of same-origin `/api/*` requests of a BFF session with `Authorization` attached server-side (cart, checkout, orders, `/api/auth/sessions`, `/api/auth/logout-all`, `/api/auth/mfa/*`, `/api/auth/identities`, `/api/auth/oidc/*/link/start`, chat, assistant streams) plus the `next.config.ts` rewrite that routes them through the BFF | **S48**, under X.8.3 ("session and token handling, plus propagation of the auth context"); it forwards unchanged to one owning endpoint, so no IX.7 R2 aggregate is created | without it, removing the memory token breaks every authenticated call |
| D3 | **C-REFRESH**: `POST /api/bff/session/refresh` (CSRF) → `{user, expiresAt}` | **S48** | role changes (seller view calls `refreshSession()` today, `app/dashboard/seller/view.tsx:30`) |
| D4 | **C-OIDC**: Google callback and federated second step end in a BFF session | **S48 + S02** | AS-58..AS-61; until then the Google UI stays behind `AUTH_OIDC_ENABLED` |
| D5 | `POST /api/auth/register` → `202`, `POST /api/auth/password-reset/request`, `POST /api/auth/password-reset/confirm`, `GET /api/auth/sessions`, `DELETE /api/auth/sessions/:id`, `POST /api/auth/logout-all` (S01 FR-001, FR-080..FR-084, FR-037) | **S01** | register, forgot/reset, sessions tab |
| D6 | `GET /api/auth/mfa`, `POST …/enroll`, `…/confirm`, `…/recovery-codes/regenerate`, `…/disable`, `GET /api/auth/oidc/providers`, `POST /api/auth/oidc/google/start`, `…/link/start`, `GET /api/auth/identities`, `DELETE /api/auth/identities/:id` (S02) | **S02** | two-step panel, methods tab, Google button |
| D7 | Problem body: `errors: {field, message}[]` on `validation_failed`, `code` on every error, `Retry-After` on `429`/`503` | **S54** (global filter) with S01/S02/S48 | FR-040, AS-04 |
| D8 | Reset e-mail link `<front>/reset-password#token=<resetToken>` | **S28** | AS-41, SC-007 (today its catalogue says `?token=`) |
| D9 | A way for tests to read the link sent to a test address in the dev stack (local mail catcher or fake provider with an HTTP read) | **S28 / ops** | JR journey |
| D10 | No R2 aggregate is needed: the account page's three tabs load three independent resources and must stay independently failing (AS-45, AS-54), and the navbar needs only the session | — | recorded so nobody adds a "get my account" aggregate |

## E. Contracts (constitution V.2)

| # | Gap | Where |
|---|---|---|
| E1 | `packages/contracts` has no source (`moon.yml`, `package.json` only), so none of the schemas in Requires exist; every `lib/api` module hand-writes its types | `packages/contracts` |
| E2 | Until the package has them, W01's `lib/api/*` modules define the zod schemas locally under the contract names (`problemSchema`, `sessionResponseSchema`, `mfaRequiredResponseSchema`, `registerRequestSchema`, `passwordResetRequestSchema`, `passwordResetConfirmSchema`, `mfaStatusSchema`, `mfaEnrollSchema`, `mfaRecoveryCodesSchema`, `sessionListItemSchema`, `federatedIdentitySchema`, `oidcProviderSchema`, `oidcStartSchema`) so the swap is an import change. Parse every response; a parse failure is the unexpected-error state (AS-10), never a crash |

## F. Rendering model (P0903, Cache Components)

| # | Gap | Where | Spec |
|---|---|---|---|
| F1 | `cacheComponents: true`; the login and MFA pages already wrap their form in `<Suspense>` for `useSearchParams`. The session-reading parts (signed-in redirect, `AccountSlot`, `/account/*` guard) must be new server components under their own boundaries, never at a layout top level or in `"use cache"` | `next.config.ts:12`, `(auth)/login/page.tsx`, `(auth)/mfa/page.tsx` | AS-62, FR-005 |
| F2 | Guards today are client `useEffect` redirects (`checkout/page.tsx:40-42`, `chat-view.tsx:47`, `dashboard-shell.tsx:30-35`) and the admin layout has none | listed files; `app/admin/layout.tsx` | AS-27, AS-65; adoption belongs to W03/W04/W05/W06 (Cross-capability) |
| F3 | `/reset-password` needs `Referrer-Policy: no-referrer` (global header is `strict-origin-when-cross-origin`) | `next.config.ts:59` | AS-64 (W07 owns the headers file) |
| F4 | `/account` → `/account/security` redirect and removal of `/mfa` | `next.config.ts` `redirects()` | Routes table |
| F5 | No Server Action is used for auth (by design, FR-006); `serverActions.allowedOrigins` stays as is | `next.config.ts:13-16` | FR-006 |

## G. Test tooling

| # | Gap | Where |
|---|---|---|
| G1 | React Testing Library is not installed: add `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `msw`, `@vitejs/plugin-react` to `devDependencies` | `package.json` |
| G2 | Vitest `include` covers only `lib/**/*.test.ts` and `hooks/**/*.test.ts`; add `app/**/*.test.{ts,tsx}`, `components/**/*.test.{ts,tsx}`, `lib/**/*.test.tsx`, `hooks/**/*.test.tsx`; exclude `tests/**` (Playwright) | `vitest.config.ts:7` |
| G3 | No Vitest setup file (jest-dom matchers, MSW server lifecycle, `BroadcastChannel`/`matchMedia`/`ResizeObserver` stubs, `afterEach(cleanup)`); `jsdom` is installed but React plugin and `next/navigation` mocks are not wired | `vitest.config.ts` |
| G4 | Playwright has one project (`Desktop Chrome`); add a `mobile` project (390 × 844) for the visual specs, `expect.toHaveScreenshot` thresholds, a `tests/visual/` folder and committed baselines | `playwright.config.ts` (`projects`) |
| G5 | Accessibility scan tool not installed: add `@axe-core/playwright` | `package.json` |
| G6 | No QR library: add `qrcode` (client-side SVG) | `package.json` |
| G7 | Journey helpers: `register` must register then sign in; `login` must use `returnTo`; add `signOut`, `totp(secret)`, `getResetLink(email)` | `tests/helpers.ts:16-35` |
| G8 | `tests/auth.spec.ts` uses `input[name="name"]`, the initials-named button and `button[id="terms"]`; rewrite to roles and labels; add `auth-mfa.spec.ts`, `auth-password-reset.spec.ts`, `auth-sessions.spec.ts`, `auth-google.spec.ts` (`fixme`) | `tests/auth.spec.ts:8-33` |
| G9 | Existing unit tests that change: `lib/api/client.test.ts` (CSRF cookie name and header), `lib/safe-return-url.test.ts` (becomes `lib/auth/return-to.test.ts`), `lib/api/errors.test.ts` (problem model) | listed files |
| G10 | `playwright.config.ts` starts `pnpm run dev`; the visual project needs no backend (stubbed routes), the journeys need `moon run dev-monolith` and the BFF/auth work above (global setup already checks `/health/ready`) | `playwright.config.ts`, `tests/global-setup.ts` |

## H. Order of work

1. Test tooling (G1–G5) and the contracts stubs (E2), so every later step is test-first.
2. `lib/api` rewrite: relative client, `csrf.ts`, `session.ts`, `errors.ts` (problem model), `graphql.ts`, `sse-reader.ts`; delete memory token and refresh interceptor (A1–A6, B12). Blocked on D1/D2 for end-to-end runs; unit tests run against MSW meanwhile.
3. Session state: `queryKeys.auth.*`, read-only `useAuth`, action hooks, cross-tab sync, `getServerSession` / `requireServerSession`, `safeReturnTo` / `loginHref` (A3, A9–A12, B11, B13–B15).
4. Shared UI: `ProblemAlert`, `PasswordInput`, `CodeInput`, copy module, `AuthBanner`, auth shell layout fixes (B7, B8, B12).
5. Pages as Server Components with client leaves: login, register, MFA (`/login/mfa`), forgot, reset (B1–B5, B9, B10).
6. `AccountSlot`, `AccountMenu`, `MobileAccountEntries`; hand over to W07 (C1–C5).
7. `/account/security`: sessions tab, two-step tab and dialogs, methods tab (B6). Google parts behind `AUTH_OIDC_ENABLED` (D4).
8. Callers in other capabilities: `returnTo`, `useAuth`, guards, seller `useRefreshSession` (F2, questions CONTRACT lines).
9. Journeys and visual baselines; record the green run (VII.9).

## Plan corrections (2026-10-11, `/speckit-plan`)

The tables above were written before S48 and W07 were built. Verified against the code on 2026-10-11:

- `packages/contracts` now has source (`src/auth`, `src/bff`): E1 is partly done; still missing `registerRequestSchema`, `passwordReset*Schema`, `sessionListItemSchema`, `mfaCodeRequestSchema`.
- W07 installed the test tooling and Playwright projects (G1–G5 are verification only); `qrcode` (G6) is still missing.
- S48 built `POST/GET /api/bff/session`, `/mfa`, `/logout` (D1 done). Still missing: C-FWD (D2), C-REFRESH (D3), S01 password reset and `DELETE /auth/sessions/:id` (D5), S02 recovery-code regeneration and disable (D6), dev mailbox (D9). The plan builds them (`contracts/backend-endpoints.md`). C-OIDC (D4) is not built; Google stays behind `AUTH_OIDC_ENABLED`.
- D7: the wire shape of `validation_failed.errors` is `{field, code}` (no `message`); the web derives text from `(field, code)` (research R-04). Spec wording "the server's field message" is read that way.

## Sibling-spec follow-ups

- **S48**: the `__Host-bff-mfa` cookie is now `Path=/` (browsers reject a `__Host-` cookie with another path); update the spec text and any assertion of `Path=/api/bff/session`. W01 changes `session-cookies.ts` and the cookie assertion in `bff-session.e2e-spec.ts`.
- **S48**: new BFF routes owned by W01's plan: the authenticated forwarder `/api/bff/f/*` (C-FWD) and `POST /api/bff/session/refresh` (C-REFRESH); add them to S48's contract; the web rewrites the generic `/api/:path*` through the forwarder.
- **S48 (revoked session, found by `tests/auth-sessions.spec.ts`)**: `GET /api/bff/session` and the forwarder do not notice that the member's session was revoked elsewhere: the BFF session check is local (`200`), while every forwarded call answers `401 invalid_token` without clearing the BFF cookies. The browser therefore shows the session-ended toast and an anonymous navbar, but a server guard (`requireServerSession`) keeps passing, so a guarded page does not redirect to `/login?returnTo=…` as AS-26 expects. Either `GET /api/bff/session` verifies the session against identity (or a revocation marker) or the forwarder ends the BFF session on `401 invalid_token`/`session_expired` (clear cookies, delete the record). The journey asserts what is true today (toast and anonymous navbar).
- **W05**: `pnpm lint` errors `react-hooks/set-state-in-effect` in `app/chat/chat-view.tsx:109`, `react/no-unescaped-entities` in `components/assistant/chat-interface.tsx:60`, and `react-hooks/refs` in `hooks/use-event-stream.ts:13` (the SSE hook is consumed by chat and assistant).
- **W04**: `pnpm lint` error `react-hooks/immutability` in `app/dashboard/seller/[shopId]/developers/webhooks/view.tsx:50` (`fetchWebhooks` used before its declaration).
- **Lint gate note (T092)**: `pnpm lint` exits 1 with exactly those 4 errors; none is in W01's files (the two `forgot-password` errors the W07 follow-up named are gone), so W01's own files lint clean per T084. None is in W01's files (the two `forgot-password` errors the W07 follow-up named are gone); `tsc --noEmit` and `pnpm build:e2e` are clean.
- **S48 (logout-all)**: the web ends the BFF session itself after `POST /api/auth/logout-all` (BFF sign-out). If the forwarder should end it on `logout-all`, the extra call can be dropped.
- **S48 / S02**: C-OIDC is still open: `GET /api/bff/session` must answer `200` after a Google callback (or the callback must create the BFF session) and the federated second step must end at `POST /api/bff/session/mfa`. Until then `AUTH_OIDC_ENABLED` stays false.
- **S01**: password reset (`request`/`confirm`) and `DELETE /auth/sessions/:id` are implemented by W01's plan; the e-mail link uses the fragment `/reset-password#token=`; drop the assumption "the web client logs in automatically after registration". Already-revoked sessions answer `404 session_not_found` (the S01 service was idempotent).
- **S01 (table naming)**: the reset table is `"PasswordResetToken"` in the default schema with column `"digest"` (created by `20261010090000-identity-s01-expand`; the codebase has no `identity` schema and uses camelCase quoted columns), not `identity.password_reset_tokens`/`token_digest`. W01 only adds migration `20261012100000` (an expiry index). No FK to `"User"` was added.
- **S01 (events.md, deviation)**: `identity.password_reset_requested {userId, resetToken, expiresAt}` through the outbox is NOT used. W01 requires the raw token to be absent from every table, so identity hands the link to a port (`PASSWORD_RESET_MAILER`, exported from `@app/domains/identity`) that notifications binds (`TransactionalMailModule`, global) and sends directly through the e-mail provider chain, fire-and-forget after commit. A lost mail is recovered by requesting again; only `identity.password_changed` is emitted (on confirm).
- **S48 (forwarder)**: besides `bff/*`, `graphql` and `auth/login|refresh|logout`, the forwarder also refuses `auth/mfa/verify` (its answer carries tokens). New optional setting `BFF_SSE_URL` (origin of the SSE gateway for `/api/streams`, `/api/live/:id/events`, `/api/payment/stream`, `/api/assistant/*`); unset means the upstream origin (right for the monolith). Request headers pass through an allowlist; `Origin` is not forwarded. New problem code `bad_gateway` (502).
- **S02**: `recovery-codes/regenerate` and `disable` are implemented by W01's plan per S02 `contracts/http.md`.
- **S28**: the reset link is `<front>/reset-password#token=<token>` (catalogue said `?token=`); the dev stack gets `EMAIL_PROVIDER=memory` and `GET /api/dev/mailbox` (with `DEV_MAILBOX_ENABLED=true`, set in `start:dev:monolith`). The reset mail is not a catalogue type; `DeliveryMessage.type` is widened by `'auth.password_reset'`.
- **S54**: `problemDetailsSchema.errors` has no `message`; the UI relies on `field` + `code`.
- **W02**: add `product-page.spec.ts` (the S48 journey left for the product page); `returnTo` replaces `returnUrl`.
- **W03, W04, W05, W06**: adopt `returnTo`, `loginHref`, `requireServerSession`, read-only `useAuth()`; drop any `Authorization` header and `setAccessToken`/`refreshSession` use (W04 calls `useRefreshSession()` after a shop opens); the admin layout needs a guard (W06).
- **W07**: reword AS-62 as "the shell streams first"; `lib/problem.ts` becomes a re-export of `lib/api/errors.ts`; add the `/reset-password` `Referrer-Policy: no-referrer` path rule to `lib/security/headers.ts` (W01 edits that one rule).
- **W07 (navbar at 320 px)**: at a 320 px viewport the site header's right-hand controls (`.ml-auto` group: assistant, theme, cart, account) extend to x = 349, so the page scrolls sideways by ~21-29 px on every page (found by the `auth-pages` visual spec). W01's VP check therefore measures the page content (`#main-content`), not the document; AS-66's "no horizontal scroll at 320 px" is not proven for the whole page until the header fits.
- **W07 / navbar (hydration)**: the dev server logs a React hydration mismatch in `components/layout/navbar.tsx` (the mobile account link `aria-label="Log in"` is rendered by the server but not by the first client render, while the session is unknown); seen while running the visual specs. Not caused by the auth pages.
- **S01 / backend (found by `tests/bff-session.spec.ts`)**: `GET /api/auth/sessions` for a signed-in member answered `500 internal_error` through the forwarder during this run (identity files were being edited at the time); the journey uses `GET /api/auth/mfa` as its member-only forwarded call instead. Re-check when T013/T014 land.

## Deferred until a later pass (superseded: every item below was built in the US7–US10 pass; see "Status at close")

- **T052 is done (guard only)**: `tests/auth.spec.ts` passes at the desktop and mobile projects, including the anonymous `/account/security` → `/login?returnTo=%2Faccount%2Fsecurity` assertions. They run against the minimal `app/account/{layout,member-guard}.tsx` and a placeholder `security/page.tsx`; T071 (US8, deferred) replaces the placeholder with the real tabs.
- **AS-66 "document title" in unit tests**: pages are async Server Components (session read inside Suspense) and cannot be rendered by Vitest; titles ("Sign in", "Create account", "Two-step verification") are exported as `metadata` and asserted with `toHaveTitle` in `tests/visual/auth-pages.spec.ts`.
- **Terms and Privacy links** inside the register form's checkbox label add two tab stops between the checkbox and **Create account** (the tab order in AS-05 lists the checkbox then the button); the register unit test asserts the order with those links. Revisit if the spec order is meant literally.
- **U-arch (T045)** is green (7 tests). It skips `app/(auth)/forgot-password/page.tsx` (still the old client page); remove that entry in the pass that builds US7.
- **T058** done: two-tab sign-out journey is a separate test in `tests/auth.spec.ts` (it does not need `/account/security`); passes at desktop and mobile.
- **T030 / dev stack**: the forwarder rewrite is covered by `lib/api/rewrites.test.ts` and by `tests/bff-session.spec.ts` (forwarded call). The dev process must be restarted for `EMAIL_PROVIDER=memory` / `DEV_MAILBOX_ENABLED=true` (needed only by T068, deferred).
- **Shared UI built early**: T040–T045 (US11, P3) were built in this pass because the P1 pages need them; the remaining US11 scenarios (AS-62 build gate `next build`, AS-64 header rule T066) stay for the final pass.
- **US7 Forgot/reset password (P2)**: AS-39..AS-44; waits for nothing external (backend T010–T012 and the dev mailbox are built); tasks T063–T068.
- **US8 Two-step in account (P2)**: AS-45..AS-53; tasks T069–T073; backend T015–T016 built.
- **US9 Sessions (P2)**: AS-54..AS-57; tasks T074–T077; backend T013–T014 built.
- **US10 Google and sign-in methods (P3)**: AS-58..AS-61 (the Google button and `startOidc` are built and unit-tested behind `AUTH_OIDC_ENABLED`; the journey stays `fixme`); waits for C-OIDC (S48 + S02). Tasks T078–T080.
- **Phase 15** (T081–T085): final pass; `next build` and the full Playwright run are not done in this pass.

## Gate repairs

- **Missing-ID gate (AS-42, 44, 47, 49, 52, 53, 56, 60, 61)**: every one of these belongs only to deferred stories (US7 forgot/reset AS-42/44, US8 two-step AS-47/49/52/53, US9 sessions AS-56, US10 Google AS-60/61). `scripts/sdd/check-tests.py` counts them as required in this P1 pass because the P1 stories cite them as cross-references to other capabilities (e.g. "S48 AS-52", "S02 AS-49" in AS-10, AS-20, AS-26, AS-28, AS-34/35) and because the US10 heading `(Priority: P3, conditional on C-OIDC)` does not match the script's `(Priority: Pn)` pattern. No test was faked or stubbed and no test was weakened. Their tests land with T063–T080 in the pass that builds US7–US10 (see "Deferred until a later pass"); the script was not edited (outside this capability).

## Gate repairs

- **Scenario-ID gate (AS-42, AS-44, AS-47, AS-49, AS-52, AS-53, AS-56, AS-60, AS-61): not repaired, needs a decision.** All nine are scenarios of W01's own P2/P3 stories (US7 reset password, US8 two-step, US9 sessions, US10 Google), which this P1 pass must not start; their components do not exist, so a test titled `W01 AS-NN` could only be a placeholder. The gate lists them because `check-tests.py` (`deferred_scenarios`) reads every `AS-nn` in a P1 story body as a W01 citation, and P1 stories cite other capabilities' scenarios ("S48 AS-44", "S48 AS-49", "S48 AS-61", ...). A scenario cited by any P1 story is therefore never treated as deferred. Fix options: make the parser ignore `AS-nn` preceded by another capability ID (`S\d+ AS-`), or run the P2/P3 passes. No test was weakened, skipped or faked.

## Gate repairs (US10 priority heading)

- **Scenario-ID gate (AS-60, AS-61)**: `check-tests.py` reads a story's priority from `(Priority: Pn)`; the US10 heading was `(Priority: P3, conditional on C-OIDC)`, so US10 was never parsed and its scenarios counted as uncited, hence required in the P1 pass. Fixed in `spec.md` by writing the heading as `(Priority: P3)` and moving "Conditional on contract C-OIDC" into the story's first line. No test was added, weakened or skipped; AS-60/AS-61 stay deferred (see "Deferred until a later pass", US10).

## Gate repairs (stale generated types, B-4 clock)

- **`tsc --noEmit` TS2307 (5 errors)**: `.next-prod/types/validator.ts` is gitignored build output from before T031/T061 and still referenced the deleted `(auth)/mfa/page` and `app/api/auth/{login,logout,mfa/verify,refresh}/route`. Removed the stale `.next-prod/types` directory (regenerated by the next `build:e2e`); `npx tsc --noEmit` is now clean. No source or test changed.
- **`password-reset.e2e-spec.ts` "more than 3 requests for one address in an hour"**: the code was right, the test's clock step was too small. The S50 sliding window weighs the previous window's count, so after advancing one hour plus 1 ms the per-IP budget (5/h, already spent) still rejected. The test now advances two windows (`2 * 3_600_000 + 1`); its assertions are unchanged. `test-spec.sh password-reset`: 12/12.
- **`tests/zz-dbg.spec.ts` (T087)**: was left in place by the repair rules; it is no longer in the tree (T087 done).

## Gate repairs (Playwright: API down, CSP violations)

- **`playwright test` aborted in `global-setup.ts` ("API is not ready")**: the dev API (`nest start local-monolith --watch`) lost its app process after a restart raced the previous instance's slow shutdown (`EADDRINUSE` on 8000); the watcher stayed alive but never relaunched. Touching a source file made it rebuild and `GET /health/ready` returned 200. No code change.
- **`W07 AS-17: main journeys raise no CSP violation` (desktop and mobile)**: a real regression from W01. `lib/providers.tsx` imported `SessionLifecycle` (new, W01) before anything else; it pulls in `sonner` and, through `use-auth-actions` → `lib/api/account.ts`, zod schemas. So sonner injected its `<style>` before `lib/style-nonce` ran (inline-style violations), and zod probed `new Function('')` before `z.config({ jitless: true })` ran (eval violation). Both side effects now live in modules imported first in `providers.tsx` (`lib/style-nonce`, new `lib/zod-jitless.ts`). No test changed. Full `playwright test`: 73 passed, 7 skipped; `tsc --noEmit` clean; `lib/providers*` unit tests pass.

## Gate repairs (auth-sessions mobile flake)

- **`tests/auth-sessions.spec.ts` [mobile] "Your session ended…" not found (full run, 2 workers)**: not reproducible: the spec passes alone and 32/32 with `--repeat-each=4` next to `auth-navbar.spec.ts`. One real gap found in the code under it: `endSession()` latched `ended` even when `SessionLifecycle` had not yet registered its handler, so a 401 that beats hydration under load lost the notice for the rest of the page's life. `lib/auth/session-ended.ts` now remembers that end and runs it once when the handler registers; unit test `W01 AS-26: an end seen before the handler registers…` added. Whether this was the cause of the gate failure is a hypothesis, not proven. No test was changed. (`pnpm lint` still reports 4 errors in other capabilities' files: `app/chat`, `developers/webhooks`, `components/assistant`, `hooks/use-event-stream.ts`; the forgot-password ones are fixed.)

## Status at close (US7–US10 pass)

Walked A1–H against the code and tests of this pass. "gated" = built and unit-tested, but the journey is `fixme` until C-OIDC.

- **A1–A8 done** (no in-memory token, no browser refresh, CSRF double-submit, same-origin client, forwarder rewrite, static guard). **A9–A12 done** (one session source, cookie-based provider, focus refetch, cross-tab sync).
- **B1–B3 done** (register, login, `/login/mfa`). **B4, B5 done** this pass (`forgot-password`, `reset-password`; token in the fragment, stripped with `replaceState`). **B6 done** this pass (`/account/security`: tabs, two-step panel, recovery-codes dialog, sessions panel, sign-in methods panel; `/account` redirect already in `next.config.ts`). **B7–B15 done.**
- **C1–C5 done** (account slot, menu, sign-out, unavailable state, hand-over to W07).
- **D1–D3 done. D4 gated** (C-OIDC not built; Google parts render only with `AUTH_OIDC_ENABLED`, `tests/auth-google.spec.ts` is `test.fixme`). **D5–D9 done. D10 none.**
- **E1, E2 done.** **F1–F4 done** (F3: the `/reset-password` rule is W07's; W01 asserts it in `lib/security/headers.test.ts` and `tests/auth-password-reset.spec.ts`). **F5 none** by design.
- **G1–G10 done.** `tests/helpers.ts` gained `getResetLink(email)` (reads `GET /api/dev/mailbox`) and `totp(secret)` (RFC 6238, `node:crypto`).
- `lib/auth/architecture.test.ts` (AS-63) no longer skips `forgot-password/page.tsx`: every page under `(auth)` and `account` is a Server Component.
- **T087**: `tests/zz-dbg.spec.ts` is no longer in the tree.
- **T090 final proofs (2026-10-14)**: `pnpm exec playwright test --reporter=line` (desktop and mobile): 276 passed, 34 skipped (`fixme`/gated, including `auth-google`), 0 failed. `scripts/sdd/test-spec.sh "bff-forward|bff-session|password-reset|sessions-revoke|mfa-lifecycle|dev-mailbox"`: 7 suites, 105/105 passed. T091 done (`pw-full.log` removed). T092 done (lint note above).

Decisions taken in this pass that the spec leaves open:

- **AS-48 vs AS-49 on `mfa_not_pending` at the confirm step**: the dialog closes, the status is re-read (it becomes `none`) and the toast says "Setup timed out. Start again."; the next **Set up** starts a fresh enrolment. Both scenarios read the same way.
- **"Only {n} recovery codes left"** is singular for one code ("Only 1 recovery code left").
- **Log out of all devices** calls `POST /api/auth/logout-all`, then the BFF sign-out (`POST /api/bff/session/logout`): the BFF keeps its own session record and cookies, and without it `/login` treated the visitor as still signed in and bounced to `/`.
- **The shared destructive `Button` variant** (red on a red tint) measures 4.0:1; the account dialogs add `text-red-700` locally (`DESTRUCTIVE_TEXT`) to reach 4.5:1 without editing `components/ui/button.tsx`.
- **W02 beacon follow-up (S48/W01 forwarder, H9)**: W01 accepts the loss. `navigator.sendBeacon` in `lib/api/events.ts` cannot send `X-CSRF-Token`, so for a signed-in visitor the forwarder answers `csrf_invalid` to the batch queued at unload; the 5 s timer path uses `fetch` with the header and works. No `/api/events` exemption is added; `bff-forward.e2e-spec.ts` ("S48 W02-H9") pins this behaviour.
- **Recovery codes** never enter the query cache or a mutation: the dialogs call the API functions directly and hold the codes in component state that is dropped on **Done**.

## Spec changes

- `spec.md` AS-62 and the `test-plan.md` AS-62 row now say "the shell streams first, with no build-time HTML shell" (W07 follow-up, T081). No `*.reviewed.json` was touched.
