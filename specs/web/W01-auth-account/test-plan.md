# Test Plan: W01 — Auth and account (`packages/web`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (67 scenarios, AS-01 to AS-67), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. Where a row names two layers, each proves a different part (stated in the cell); no part is proven twice. "Proven by backend spec" names the backend scenario that owns the rule; the UI never re-tests it (VII.7).

## Layers and conventions

- **UI journey (Playwright, happy path only)**: `packages/web/tests/*.spec.ts`, against the real local dev stack (`moon run :dev-monolith`, web on 3000) with an isolated user per test, web-first assertions, no fixed sleeps. Each file's top-level `describe` names its feature (VII.8). No edge case is re-tested here.
- **UI unit (Vitest + React Testing Library)**: `*.test.tsx` / `*.test.ts` next to the code. Queries by role and label, `@testing-library/user-event`, MSW at the network boundary (problem+json fixtures parsed with the contracts schemas), `jsdom`. They cover UI-only validation, states, copy, focus and accessibility. No snapshot of markup.
- **Visual (Playwright screenshot)**: `packages/web/tests/visual/*.spec.ts`. Layout states at mobile (390 × 844, ≤ 640) and desktop (1280 × 800, ≥ 1024) in the `chromium` project plus a `mobile` project. The backend is stubbed with `page.route` (layout only, no behaviour), animations disabled, an axe scan (serious/critical = 0) runs on each state, and screenshots are compared to committed baselines.
- **Static gates** (VII.1; named in the unit column as "static"): `tsc --noEmit`, ESLint, `next build` (Cache Components validation), and the architecture test.
- Backend behaviour is never faked in journeys (VII.7). Visual and unit tests use fixtures only.
- Fallback and degradation paths (VII.9) each have a forcing test: session unavailable (AS-20), sign-out failure (AS-25), expiry mid-use (AS-26), challenge gone (AS-35), reconnect refetch (AS-20).

### Test files

| Key | File | Top-level `describe` |
|---|---|---|
| JA | `packages/web/tests/auth.spec.ts` | `Authentication` |
| JM | `packages/web/tests/auth-mfa.spec.ts` | `Two-step verification` |
| JR | `packages/web/tests/auth-password-reset.spec.ts` | `Password reset` |
| JS | `packages/web/tests/auth-sessions.spec.ts` | `Active sessions` |
| JG | `packages/web/tests/auth-google.spec.ts` | `Google sign-in` (`test.fixme` until C-OIDC) |
| VP | `packages/web/tests/visual/auth-pages.spec.ts` | `Auth pages layout` |
| VN | `packages/web/tests/visual/auth-navbar.spec.ts` | `Navbar account slot layout` |
| VA | `packages/web/tests/visual/account-security.spec.ts` | `Account security layout` |
| U-reg | `app/(auth)/register/register-form.test.tsx` | `RegisterForm` |
| U-login | `app/(auth)/login/login-form.test.tsx` | `LoginForm` |
| U-banner | `app/(auth)/login/auth-banner.test.tsx` | `AuthBanner` |
| U-mfa | `app/(auth)/login/mfa/mfa-form.test.tsx` | `MfaForm` |
| U-forgot | `app/(auth)/forgot-password/forgot-password-form.test.tsx` | `ForgotPasswordForm` |
| U-reset | `app/(auth)/reset-password/reset-password-form.test.tsx` | `ResetPasswordForm` |
| U-two | `app/account/security/two-step-panel.test.tsx` | `TwoStepPanel` |
| U-codes | `app/account/security/recovery-codes-dialog.test.tsx` | `RecoveryCodesDialog` |
| U-sess | `app/account/security/sessions-panel.test.tsx` | `SessionsPanel` |
| U-meth | `app/account/security/sign-in-methods-panel.test.tsx` | `SignInMethodsPanel` |
| U-tabs | `app/account/security/security-tabs.test.tsx` | `SecurityTabs` |
| U-menu | `components/auth/account-menu.test.tsx` | `AccountMenu` |
| U-slot | `components/auth/account-slot.test.tsx` | `AccountSlot` |
| U-prob | `components/auth/problem-alert.test.tsx` | `ProblemAlert` |
| U-pw | `components/auth/password-input.test.tsx` | `PasswordInput` |
| U-code | `components/auth/code-input.test.tsx` | `CodeInput` |
| U-ret | `lib/auth/return-to.test.ts` | `safeReturnTo` |
| U-guard | `lib/auth/guards.test.ts` | `auth guards` |
| U-wait | `lib/auth/retry-after.test.ts` | `formatWait` |
| U-sync | `lib/auth/session-sync.test.ts` | `session sync` |
| U-auth | `hooks/use-auth.test.tsx` | `useAuth` |
| U-acts | `hooks/use-auth-actions.test.tsx` | `auth actions` |
| U-api | `lib/api/session.test.ts` | `session api` |
| U-csrf | `lib/api/csrf.test.ts` | `csrfHeaders` |
| U-client | `lib/api/client.test.ts` | `api client` |
| U-err | `lib/api/errors.test.ts` | `problemFromError` |
| U-gql | `lib/api/graphql.test.ts` | `gqlClient` |
| U-sse | `lib/api/sse-reader.test.ts` | `readSse` |
| U-arch | `lib/auth/architecture.test.ts` | `W01 architecture rules` |

## Scenarios

| Scenario | UI journey (Playwright, happy path) | UI unit (Vitest + RTL) | Visual (Playwright screenshot) | Proven by backend spec |
|---|---|---|---|---|
| AS-01 register, land on sign-in with notice, not signed in | JA › `register, sign in, stay signed in, sign out` (register step: URL `/login?notice=registered`, banner, navbar still anonymous) | U-reg › `sends only email and password and navigates to the registered notice` | — | S01 AS-01 |
| AS-02 existing address looks identical | — | U-reg › `shows the same outcome for every 202 response` (the form has no other input to branch on) | — | S01 AS-02, AS-08 |
| AS-03 client-side validation | — | U-reg › `blocks submission and names each invalid field` (table-driven: e-mail, 11/129 chars, mismatch, terms; focus, `aria-invalid`, `aria-describedby`) | — | — |
| AS-04 server validation and weak password | — | U-reg › `places field errors from validation_failed`; `weak_password clears passwords and focuses Password` | — | S01 AS-05, AS-06 |
| AS-05 register layout and field order | — | U-reg › `has no name or role field and the expected tab order` | VP › `register` (mobile, desktop) | — |
| AS-06 sign in and land on `returnTo` | JA › same test (anonymous visit to `/account/security` → login → lands there; navbar shows account menu) | U-acts › `useLogin applies the sign-in effects` (session set, queries invalidated, merge requested once, replace + refresh); U-login › `announces Signing in… and disables while pending` | — | S48 AS-43; S01 AS-10 |
| AS-07 `returnTo` safety | — | U-ret › `accepts same-site paths and rejects every unsafe vector` (table-driven, same vectors as S02 AS-34) | — | S02 AS-34 (server validator) |
| AS-08 wrong credentials | — | U-login › `shows the credentials alert, clears and focuses password` | VP › `login: credentials error` (mobile, desktop) | S01 AS-11; S48 AS-45 |
| AS-09 throttled | — | U-login › `disables Sign in for Retry-After and re-enables itself` (fake timers); U-wait › `formats seconds, minutes, hours, missing` | — | S01 AS-12, AS-14 |
| AS-10 unavailable, unexpected, offline | — | U-login › `maps 503, 500, network failure to the catalogue copy; keeps values; shows Reference id` | — | S01 AS-18; S48 AS-45, AS-61 |
| AS-11 verification failure (csrf/origin) | — | U-login › `shows the verify alert with a Reload button` | — | S48 AS-44, AS-59 |
| AS-12 double submit | — | U-login › `sends one request when submitted twice; fields read-only while pending` | — | — |
| AS-13 MFA hand-off | — | U-login › `navigates to /login/mfa?returnTo with history replaced and nothing else in the URL` | — | S01 AS-19; S48 AS-48 |
| AS-14 login layout and focus order | — | U-login › `has no Remember me or GitHub and the expected tab order` | VP › `login` (mobile, desktop) | — |
| AS-15 notice and provider-error banners | — | U-banner › `renders one banner per allowlisted value with the right role; ignores unknown; never echoes input` (table-driven over FR-043/FR-044) | VP › `login: notice banner` (mobile, desktop) | S02 FR-048 (closed code list) |
| AS-16 signed-in visitor redirected from auth pages | — | U-guard › `authPageRedirect` (table-driven: signed in + returnTo, signed in + error code → security methods tab, anonymous → none) | — | — |
| AS-17 anonymous navbar entries at every width | — | U-menu › `anonymous: Log in and Sign up links; mobile icon link named Log in` | VN › `anonymous` (mobile header and open sheet, desktop) | — |
| AS-18 placeholder and no signed-out flash | — | U-slot › `renders the same-size placeholder with aria-busy; resolves to menu without rendering Log in` | VN › `loading` (route delayed; no layout shift measured) | — |
| AS-19 account menu (content, keyboard, mobile sheet) | JA › same test (opens "Account menu", sees e-mail, entries) | U-menu › `opens with Enter/Space/ArrowDown, arrow navigation, Escape returns focus; shows e-mail and role; entries and order` | VN › `signed in: menu open` (mobile sheet, desktop) | — |
| AS-20 session unavailable and recovery on reconnect | — | U-auth › `503 and network keep the previous user and set status unavailable; refetch on online and focus`; U-menu › `shows the retry button, not anonymous controls` | — | S48 AS-56, AS-61 |
| AS-21 still signed in after reload and in a new tab | JA › same test (reload; second page in the same context) | — | — | S48 AS-51; S01 AS-86 |
| AS-22 cross-tab sync | — | U-sync › `signed-out message clears the session query and cache within one tick; signed-in message refetches`; U-auth › `focus refetch fallback` | — | — |
| AS-23 role change visible | — | U-acts › `useRefreshSession writes the returned role to the session query`; U-menu › `shows the new role` | — | S01 AS-28; S48 AS-53 |
| AS-24 sign out | JA › same test (menu → Log out → `/login?notice=signed_out`, navbar anonymous, `/account/security` redirects) | U-acts › `useLogout clears the cache, broadcasts, navigates` | — | S48 AS-58 |
| AS-25 sign-out failure | — | U-acts › `failed logout keeps the session and offers Try again` (network, 403 csrf_invalid, 500); U-menu › `toast copy` | — | S48 AS-58 |
| AS-26 session ended mid-use | — | U-client › `a 401 session_expired/unauthenticated/invalid_token while signed in triggers one expiry flow for concurrent failures`; U-acts › `expiry drops the cache, refreshes server guards, shows the toast with a Sign in link carrying returnTo and notice, and does not navigate a public page` | — | S48 AS-52, AS-55 |
| AS-27 guarded page redirects anonymous | JA › same test (first step) | U-guard › `requireServerSession redirects to loginHref(returnTo)` | — | — |
| AS-28 CSRF header on non-GET | — | U-csrf › `reads __Host-bff-csrf (not suffix matches), decodes`; U-client › `adds X-CSRF-Token to POST/PUT/PATCH/DELETE, not GET, not anonymous flows; missing cookie aborts and triggers expiry` | — | S48 AS-58, AS-59; S01 AS-47 |
| AS-29 no tokens in script-readable places | JA › same test (assert `localStorage`, `sessionStorage`, `document.cookie`, IndexedDB names, URL contain no token; only `__Host-bff-csrf` readable; no request has `Authorization`) | U-client › `never sets an Authorization header` | — | S48 AS-43; S01 AS-86 |
| AS-30 same-origin relative URLs | — | U-client › `baseURL is empty; every lib/api module issues /api/... paths` (table over module exports) | — | S48 AS-63 |
| AS-31 GraphQL and SSE use the cookie session | — | U-gql › `sends credentials + X-CSRF-Token on POST, no bearer`; U-sse › `no Authorization header, credentials include` | — | S48 AS-42 |
| AS-32 second step with a code | JM › `enable two-step verification, save recovery codes, sign in with a code` (sign-in step) | U-mfa › `posts the code and applies the sign-in effects` | — | S48 AS-48; S02 AS-12 |
| AS-33 recovery code mode | — | U-mfa › `switches to recovery mode and back; accepts case, hyphen, spaces variants; posts the code` | — | S02 AS-20 |
| AS-34 wrong code | — | U-mfa › `invalid_mfa_code and invalid_code show the same alert; field cleared and focused` | — | S02 AS-16; S48 AS-49 |
| AS-35 sign-in timed out | — | U-mfa › `mfa_not_pending, invalid_mfa_challenge, invalid_token replace the form with the timed-out message and a Back to sign in link carrying returnTo` | — | S02 AS-19; S48 AS-49 |
| AS-36 too many incorrect codes | — | U-mfa › `429 disables Verify for Retry-After` | — | S02 AS-17, AS-18 |
| AS-37 code field behaviour | — | U-code › `digits only, paste normalisation, maxlength, attributes, Verify enabled at 6, no auto-submit` | — | — |
| AS-38 MFA layout and focus order | — | U-mfa › `expected tab order` | VP › `mfa` (mobile, desktop) | — |
| AS-39 reset request confirmation | JR › `request a reset link, set a new password, sign in with it` (request step: confirmation screen) | U-forgot › `shows the confirmation only on 202; focus moves to the heading` | VP › `forgot-password: sent` (mobile, desktop) | S01 AS-73 |
| AS-40 reset request failures | — | U-forgot › `429, 400, 500, network keep the form and never show the confirmation` | — | S01 AS-78 |
| AS-41 set a new password | JR › same test (opens the link from the dev mailbox; asserts the URL has no fragment after load; sets password; signs in with it; notice shown) | U-reset › `reads and strips the fragment token with replaceState; submits {token, password}; success screen and Sign in link` | VP › `reset-password` (mobile, desktop) | S01 AS-75 |
| AS-42 bad, used, expired or missing token | — | U-reset › `no token makes no request and shows the invalid-link state; invalid_reset_token shows it too` | VP › `reset-password: invalid link` (mobile, desktop) | S01 AS-76 |
| AS-43 confirm failures keep the token | — | U-reset › `weak_password, validation_failed, 429 keep the form and the in-memory token; client checks send nothing` | — | S01 AS-76, AS-78 |
| AS-44 forgot and reset layout, focus order | — | U-reset › `expected tab order` | VP › `forgot-password` (mobile, desktop) | — |
| AS-45 two-step status states | — | U-two › `skeleton, error with Retry (other tabs unaffected), none, pending, enabled, low and zero recovery codes` | VA › `two-step: enabled, none` (mobile, desktop) | S02 AS-09 |
| AS-46 set up and confirm | JM › same test (enrol: QR visible, read key, confirm with `totp(key)`, codes shown) | U-two › `walks the three steps; QR has the text alternative; Copy key` | VA › `two-step: setup dialog` (mobile sheet, desktop modal) | S02 AS-01, AS-04, AS-65 |
| AS-47 recovery codes shown once | JM › same test (acknowledge, Done) | U-codes › `Done disabled until acknowledged; Escape/outside click blocked; beforeunload registered; Copy all and Download; nothing left in query cache, storage or DOM after close` | VA › `two-step: recovery codes` (mobile, desktop) | S02 AS-04 |
| AS-48 setup failures | — | U-two › `invalid_code, 429, mfa_not_pending on the confirm step` | — | S02 AS-05, AS-06, AS-17 |
| AS-49 stale status reconciled on 409 | — | U-two › `mfa_already_enabled, mfa_not_enabled, mfa_not_pending close the dialog, refetch status, toast the real situation` | — | S02 AS-03, AS-06, AS-25, AS-26 |
| AS-50 pending after reload | — | U-two › `pending offers Start over; starting over calls enrol again` | — | S02 AS-02 |
| AS-51 regenerate recovery codes | — | U-two › `asks for a TOTP code only; shows new codes; errors as AS-48` | — | S02 AS-25, AS-27 |
| AS-52 turn off | — | U-two › `warns, accepts TOTP or recovery code, 204 → none + toast; errors as AS-48` | — | S02 AS-26, AS-27 |
| AS-53 security page layout | — | U-tabs › `tablist keyboard (arrows, Home, End), only the active panel in the accessibility tree, tab in URL` | VA › `security: tabs and dialogs` (mobile strip + sheets, desktop vertical tabs + modals) | — |
| AS-54 sessions list states | JS › `see my devices, sign one out, sign out everywhere` (list shows two rows, "This device") | U-sess › `skeleton, error with Retry, rows with time elements, current row without revoke control` | — | S01 AS-39 |
| AS-55 log out another device | JS › same test (second browser context listed, revoked, row disappears, that context is signed out on its next request) | U-sess › `404 session_not_found removes the row; other errors toast and keep it` | — | S01 AS-40, AS-41 |
| AS-56 log out everywhere | JS › same test (last step: lands on `/login?notice=signed_out_everywhere`) | U-sess › `confirmation dialog; success ends local session` | — | S01 AS-43 |
| AS-57 sessions layout | — | — | VA › `sessions: table (desktop), cards (mobile)` | — |
| AS-58 Google button and start | JG › `continue with Google` (fixme; start step) | U-login › `renders Continue with Google only when offered and enabled; start navigates to authorizationUrl; failure shows AS-10 copy` | — | S02 AS-28, AS-29 |
| AS-59 Google sign-in lands signed in | JG › same test (fixme) | — | — | S02 AS-31, AS-66 |
| AS-60 Google plus second step | JG › `google with two-step` (fixme) | — | — | S02 AS-54 |
| AS-61 sign-in methods tab | JG › `link and unlink Google` (fixme) | U-meth › `list, empty state, Link Google with and without a code, ?linked=google banner, ?error banner, unlink 204 / 404 / 409 last_login_method` | — | S02 AS-49, AS-50, AS-51, AS-52 |
| AS-62 static shell and Suspense boundaries | — | static: `next build` succeeds with Cache Components (no runtime-data-outside-Suspense error); U-arch › `no layout reads the session at top level; no "use cache" function imports the session reader` | — | — |
| AS-63 Server Components by default | — | static: U-arch › `every page.tsx and layout.tsx under (auth) and account has no "use client"; client files are leaves` | — | — |
| AS-64 reset page referrer policy | JR › same test (response header `Referrer-Policy: no-referrer`; no third-party request) | — | — | — |
| AS-65 authorization not only in proxy; API re-authorizes | — | static: U-arch › `no proxy.ts or middleware.ts makes an auth decision`; U-guard › `guards only redirect`; U-client › `401/403/404 handling (see AS-26)` | — | S48 AS-51; S01 AS-29 |
| AS-66 accessibility baseline | — | U-pw, U-code, U-prob, each form test › `one h1, labelled controls, aria-invalid/describedby, live regions, focus after error, document title` | VP, VN, VA › axe scan on every state at both widths (serious/critical = 0); 320 px no horizontal scroll | — |
| AS-67 console hygiene | — | U-err › `problemFromError keeps only status, code, requestId`; each form test › `console spies receive no password, code, token or body` | — | — |

## Coverage notes

- **Journeys**: five files, one happy path each (JA, JM, JR, JS; JG is `fixme`). JA also owns S01 AS-86 and S02 AS-65/AS-66's browser halves; the journeys never assert backend rules (throttling, reuse detection, password policy).
- **Pattern-map rows**: P0504 → AS-11, AS-24, AS-25, AS-28, AS-31; P0512 → AS-06, AS-21, AS-26, AS-29, AS-30, AS-31; P0903 → AS-18, AS-27, AS-62..AS-65.
- **Edge cases appear once**: open redirect (AS-07 unit), wrong credentials (AS-08 unit), throttling (AS-09 unit), expiry (AS-26 unit), stale MFA status (AS-49 unit), reset token reuse (AS-42 unit). Layout and accessibility states live only in the visual column.
- **Data setup**: journeys create users through the UI (`register` helper) or the seeded accounts in `tests/helpers.ts`; a user with two-step verification is made inside JM; a second device in JS is a second Playwright context. TOTP codes come from `totp(secret)` in `tests/helpers.ts` (RFC 6238, SHA-1, 6 digits, 30 s; no new dependency).
