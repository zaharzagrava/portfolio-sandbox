---
id: W01
title: Sign up, log in, forgot password, MFA step-up, session cookie via BFF, CSRF, logout, account state in the navbar
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S01, S02, S48, S50, S54, W07]
concepts: [access-token-session, bff-aggregate, problem-json-errors, rate-limit-policy]
models: []
scope:
  - packages/backend/libs/composition/bff/**
  - packages/backend/libs/domains/identity/**
  - packages/backend/libs/domains/notifications/**
  - packages/web/app/(auth)/**
  - packages/web/app/account/**
  - packages/web/components/auth/**
  - packages/web/lib/api/**
  - packages/web/lib/auth/**
---
# W01 - Sign up, log in, forgot password, MFA step-up, session cookie via BFF, CSRF, logout, account state in the navbar
## Purpose
Visitors and members need to create an account, sign in, recover a password, finish two-step verification and sign out from the browser. The browser holds a signed-in state only through an opaque HttpOnly session cookie and a readable CSRF cookie, never a token. The navbar shows the account state, and the security page lets a member manage two-step verification, devices and linked sign-in methods. See {{concept:access-token-session}} and {{concept:bff-aggregate}}.

## Entry points
- `/register`: creates an account from e-mail and password. [code: packages/web/app/(auth)/register/page.tsx#Page]
- `/login`: signs in; reads `returnTo`, `notice` and `error`; shows **Continue with Google** only when offered. [code: packages/web/app/(auth)/login/page.tsx#Page]
- `/login/mfa`: second step at sign-in with an authenticator code or a recovery code. [code: packages/web/app/(auth)/login/mfa/page.tsx#Page]
- `/forgot-password`: requests a reset link by e-mail.
- `/reset-password#token=…`: sets a new password from the link token.
- `/account/security`: tabs for two-step verification, active sessions and sign-in methods. [code: packages/web/app/account/security/page.tsx#SecurityPage]
- `POST /api/bff/session`: sign-in through the BFF. [code: packages/backend/libs/composition/bff/session/session.controller.ts#SessionController]
- `POST /api/bff/session/mfa`: second step through the BFF.
- `GET /api/bff/session`: the session check that feeds the navbar.
- `POST /api/bff/session/refresh`: re-issues the session, used for role refresh.
- `POST /api/bff/session/logout`: sign-out.
- Navbar account slot and mobile menu entries. [code: packages/web/components/auth/account-slot.tsx#AccountSlot]
- Browser event `auth` on a `BroadcastChannel`: tells other tabs about sign-in and sign-out. [code: packages/web/lib/auth/session-sync.ts#announceAuth]

## Rules
- **W01.R-01** The browser MUST NOT hold an [access, refresh or challenge token](../terms/access-token.md) in storage, [cookies it can read ↗](../sw-external-terms.md#httponly), the URL or the DOM. [proof: W01 AS-29] [code: packages/web/lib/api/client.ts#apiClient]
- **W01.R-02** Every call made by W01 code MUST use a [relative same-origin URL](../terms/bff-forwarder.md) (`/api/…`), with no [absolute API origin](../terms/domain-api-origin.md). [proof: W01 AS-30] [code: packages/web/lib/api/client.ts#apiClient]
- **W01.R-03** While signed in, every non-`GET` request MUST carry [`X-CSRF-Token` ↗](../sw-external-terms.md#csrf-token) equal to the [`__Host-bff-csrf` cookie ↗](../sw-external-terms.md#csrf-token). `GET` requests and [anonymous flows](../terms/x-anonymous-id.md) carry none. [proof: W01 AS-28] [code: packages/web/lib/api/csrf.ts#csrfHeaders]
- **W01.R-04** The [GraphQL client ↗](../sw-external-terms.md#graphql) and the [event-stream reader ↗](../sw-external-terms.md#server-sent-events) MUST authenticate with the [session cookie](../terms/session-cookie.md) plus the CSRF header on `POST`, never with a [bearer token ↗](../sw-external-terms.md#authorization-bearer). [proof: W01 AS-31] [code: packages/web/lib/api/sse-reader.ts#streamSse]
- **W01.R-05** A [`returnTo`](../terms/return-to.md) value MUST be a [same-site path](../terms/return-path.md); any other value falls back to `/`. [proof: W01 AS-07] [code: packages/web/lib/auth/return-to.ts#safeReturnTo]
- **W01.R-06** A signed-in visitor opening `/login`, `/register`, `/forgot-password` or `/login/mfa` MUST be redirected before any form is shown. [proof: W01 AS-16] [code: packages/web/lib/auth/guards.ts#authPageRedirect]
- **W01.R-07** The register form MUST send only `email` and `password`; the confirmation field and the terms box are checked in the browser only. [proof: W01 AS-01]
- **W01.R-08** The register form MUST show the [same result for a new and an existing e-mail address](../terms/identical-registration-response.md). [proof: W01 AS-02] [code: packages/web/app/(auth)/register/register-form.tsx#RegisterForm]
- **W01.R-09** Sign-in with [`401 invalid_credentials`](../terms/invalid-credentials.md) MUST show one message for wrong password and unknown address, clear and focus the password field, and keep the e-mail. [proof: W01 AS-08] [code: packages/web/app/(auth)/login/login-form.tsx#LoginForm]
- **W01.R-10** On [`429 rate_limited`](../terms/rate-limited.md) the wait text MUST derive from [`Retry-After` ↗](../sw-external-terms.md#retry-after), and the submit button MUST stay disabled until that time has passed. [proof: W01 AS-09] [code: packages/web/lib/auth/retry-after.ts#formatWait]
- **W01.R-11** On [`403 csrf_invalid` ↗](../sw-external-terms.md#csrf-token) or [`403 origin_not_allowed`](../terms/origin-not-allowed.md), the alert MUST offer a **Reload** button. [proof: W01 AS-11] [code: packages/web/lib/auth/copy.ts#needsReload]
- **W01.R-12** While a submission is in flight, the button MUST be disabled with [`aria-busy` ↗](../sw-external-terms.md#aria-busy), and a second submit MUST send nothing. [proof: W01 AS-12] [code: packages/web/components/auth/password-input.tsx#PasswordInput]
- **W01.R-13** The [pending second-step challenge](../terms/mfa-challenge.md) MUST NOT appear in the URL, the DOM or [script-readable storage ↗](../sw-external-terms.md#httponly). [proof: W01 AS-13] [code: packages/web/hooks/use-auth-actions.ts#useLogin]
- **W01.R-14** The [MFA code](../terms/mfa-code.md) field MUST reduce pasted text to digits, accept at most 6, and keep **Verify** disabled until 6 digits are present. [proof: W01 AS-37] [code: packages/web/components/auth/code-input.tsx#normalizeTotp]
- **W01.R-15** The [recovery code](../terms/mfa-recovery-code.md) field MUST accept upper or lower case, with or without the hyphen, and with surrounding spaces. [proof: W01 AS-33] [code: packages/web/components/auth/code-input.tsx#normalizeRecoveryCode]
- **W01.R-16** The sign-out request MUST succeed before the interface shows the anonymous state; on failure the member stays signed in and sees a toast. [proof: W01 AS-25] [code: packages/web/hooks/use-auth-actions.ts#useLogout]
- **W01.R-17** A `401` with [`session_expired`](../terms/session-expired.md), `unauthenticated` or [`invalid_token`](../terms/invalid-token-error.md) MUST [end the local session](../terms/session-revocation.md) exactly once, even if several requests fail together. [proof: W01 AS-26] [code: packages/web/lib/auth/session-ended.ts#endSession]
- **W01.R-18** A [session check](../terms/session-lifetime.md) failing with `503` or no network MUST show the "unavailable" state, not the anonymous state. [proof: W01 AS-20] [code: packages/web/components/auth/account-menu.tsx#AccountSlotClient]
- **W01.R-19** No browser console output from W01 code MUST contain a password, code, token, recovery code, [setup key](../terms/manual-entry-key.md) or request body. [proof: W01 AS-67] [code: packages/web/components/auth/problem-alert.tsx#ProblemAlert]
- **W01.R-20** [Guards](../terms/protected-route.md) MUST only redirect for convenience; [the BFF ↗](../sw-external-terms.md#bff) and the [owning API](../terms/capability.md) MUST authorize every data request again. [proof: W01 AS-65] [code: packages/web/lib/auth/session.server.ts#requireServerSession]

## Behaviors
- **W01.B-01** Given a visitor on [`/register`](../terms/register-page.md) with a valid e-mail, a password of 12 to 128 characters, a matching confirmation and the terms ticked, when they press **Create account**, then one request goes out with `email` and `password` and the browser goes to [`/login?notice=registered`](../terms/login-notice.md). [proof: W01 AS-01]
- **W01.B-02** Given an e-mail that already has an account, when the register form is submitted, then the visitor sees [the same navigation and banner as a new address](../terms/identical-registration-response.md). [proof: W01 AS-02]
- **W01.B-03** Given an invalid e-mail, a short or long password, a different confirmation or unticked terms, when the visitor submits, then no request goes out and each problem shows under its field. [proof: W01 AS-03]
- **W01.B-04** Given the server answers [`400 validation_failed`](../terms/validation-failed-error.md) or [`422 weak_password`](../terms/weak-password.md), when the register form receives it, then the messages appear under the matching fields. [proof: W01 AS-04]
- **W01.B-05** Given `/login?returnTo=%2Faccount%2Fsecurity` and correct credentials, when the visitor presses **Sign in**, then the navbar shows the account menu and the browser lands on `/account/security` with [history replaced ↗](../sw-external-terms.md#history-replace). [proof: W01 AS-06]
- **W01.B-06** Given an [unsafe `returnTo`](../terms/return-path.md) such as `//evil.example` or [`javascript:…` ↗](../sw-external-terms.md#javascript-url-xss), when sign-in succeeds, then the browser goes to `/`. [proof: W01 AS-07]
- **W01.B-07** Given wrong credentials, when the server answers [`401 invalid_credentials`](../terms/invalid-credentials.md), then the alert reads "The email or password is incorrect." [proof: W01 AS-08]
- **W01.B-08** Given a [`429 rate_limited`](../terms/rate-limited.md) answer with [`Retry-After` ↗](../sw-external-terms.md#retry-after), when sign-in fails, then the alert reads "Too many sign-in attempts. Try again in {wait}." and the button re-enables after the wait. [proof: W01 AS-09]
- **W01.B-09** Given a `503`, another `5xx` or no network, when sign-in fails, then the alert shows the matching message. [proof: W01 AS-10]
- **W01.B-10** Given an account with [two-step verification](../terms/mfa-state.md), when the server answers [`200 {mfaRequired: true}`](../terms/mfa-challenge.md), then the browser goes to [`/login/mfa?returnTo=…`](../terms/login-mfa-page.md) with history replaced. [proof: W01 AS-13]
- **W01.B-11** Given the member enters the current 6-digit code on `/login/mfa`, when they press **Verify**, then the navbar shows the account menu and the browser goes to the validated [`returnTo`](../terms/return-to.md). [proof: W01 AS-32]
- **W01.B-12** Given a wrong code, when the server answers [`401 invalid_mfa_code`](../terms/invalid-mfa-code.md) or [`422 invalid_code`](../terms/invalid-code.md), then one message shows, and the field is cleared and focused. [proof: W01 AS-34]
- **W01.B-13** Given the [pending sign-in](../terms/mfa-challenge.md) is missing, [spent](../terms/refresh-token-rotation.md) or expired, when the code is posted, then the form is replaced by "Your sign-in timed out. Sign in again." with a **Back to sign in** link. [proof: W01 AS-35]
- **W01.B-14** Given [`429 rate_limited`](../terms/rate-limited.md) at the [second step](../terms/mfa-verify-endpoint.md), when **Verify** is pressed, then the alert reads "Too many incorrect codes. Try again in {wait}." [proof: W01 AS-36]
- **W01.B-15** Given an [anonymous visitor](../terms/viewer.md), when the page loads, then the navbar shows **Log in** and **Sign up**, and a fixed-size placeholder shows while the [session check](../terms/session-lifetime.md) runs. [proof: W01 AS-17, W01 AS-18]
- **W01.B-16** Given a signed-in member, when they open the account menu, then it shows e-mail, role, **Dashboard**, **Orders**, **Account & security** and **Log out**. [proof: W01 AS-19]
- **W01.B-17** Given a signed-in member reloads the page, when the page renders, then the account area never passes through the [anonymous state](../terms/viewer.md). [proof: W01 AS-21]
- **W01.B-18** Given two tabs, when the member signs out in one, then the other shows the anonymous navbar within 1 second. [proof: W01 AS-22]
- **W01.B-19** Given the member opens a shop and becomes a seller, when the page requests a [session refresh](../terms/token-refresh.md), then the menu shows the new role without a reload. [proof: W01 AS-23]
- **W01.B-20** Given a member chooses **Log out**, when the request succeeds, then the browser goes to [`/login?notice=signed_out`](../terms/signed-out-notice.md) and [the cache is cleared](../terms/client-cache-clear.md). [proof: W01 AS-24]
- **W01.B-21** Given an [anonymous visitor](../terms/visitor.md) opens `/account/security`, when [the guard](../terms/route-guard.md) runs, then they land on [`/login?returnTo=%2Faccount%2Fsecurity`](../terms/return-to.md). [proof: W01 AS-27]

## Lifecycles
The account slot moves between four states: loading, anonymous, signed in and unavailable. The session check moves it: `401` gives anonymous, a user gives signed in, and `503` or no network gives unavailable. A sign-out or session end moves it to anonymous. No model is listed.

## Owns
- Browser state: query key `queryKeys.auth.session()`, the `auth` BroadcastChannel, and the readable `__Host-bff-csrf` cookie.
- Migration `20261012100000-identity-w01-password-reset-token.js` for the password reset token.
- Configuration read: `AUTH_OIDC_ENABLED`, a server flag passed as a boolean to the Google button.
- Backend endpoints used (owned by {{cap:S01}}, {{cap:S02}} and {{cap:S48}}): `/api/bff/session*` and `/api/auth/*`.

## Decisions
- The BFF holds the tokens so that browser code never sees one (FR-001).
- All network calls live in `lib/api/*` and use same-origin URLs (FR-002).
- The session is server data in TanStack Query, so every consumer sees one value (FR-004).
- Guards only redirect; the BFF and owning APIs authorize again (FR-009).
- Every error text comes from one copy catalogue built from the problem body (FR-040), see {{concept:problem-json-errors}}.
- Server Components are the default; forms, dialogs and the account menu are small client leaves (FR-006).
- Sign-in, MFA and sign-out use no Server Action (FR-006).
- Continue with Google appears only when the provider list contains `google` and `AUTH_OIDC_ENABLED` is true (FR-045).

## Known gaps
- Forgot password and reset password (AS-40 to AS-44) have no test with their ids; only AS-39 (`auth.test.ts`) does.
- `/account/security` is a stub in the excerpt that shows only the heading "Security". The tabs, dialogs and sessions list (AS-45 to AS-57) are not visible in the code facts; only AS-45, AS-46, AS-55 and AS-58 have tests (`account.test.ts`).
- Recovery-code display, regenerate and turn-off dialogs (AS-47 to AS-52), the sessions table and cards (AS-53, AS-57) and "log out of all devices" (AS-56) have no test id.
- Google callback and sign-in methods (AS-59 to AS-61) have no test id.
- Prerender and Suspense structure (AS-62) is tested only through `architecture.test.ts`; the `Referrer-Policy: no-referrer` header on `/reset-password` (AS-64) has no test.
- The responsive layouts of AS-05, AS-14 and AS-38 rely on `auth-pages.spec.ts`; the P2 layout scenarios AS-44 and AS-53 have no test.
- `/forgot-password` and `/reset-password` page files are not in the file list, so their code is not verified here.
- The tests for AS-01 and AS-04 sit in `auth.test.ts`, which also covers the API layer; whether they exercise the form itself is not confirmed.