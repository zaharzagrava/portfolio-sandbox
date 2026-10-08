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
| G10 | `playwright.config.ts` starts `pnpm run dev`; the visual project needs no backend (stubbed routes), the journeys need `moon run :dev-monolith` and the BFF/auth work above (global setup already checks `/readyz`) | `playwright.config.ts`, `tests/global-setup.ts` |

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
