# Feature Specification: W01 — Sign up, log in, password reset, two-step verification, browser session, account state in the navbar (`packages/web`)

**Capability**: W01 · **Area**: web (`packages/web`, Next.js 16, App Router, Cache Components on) · **Spec directory**: `specs/web/W01-auth-account`

**Feature Branch**: `W01-auth-account` (spec directory only; no branch was created)

**Created**: 2026-10-06

**Status**: Draft

**Input**: "Sign up, log in, forgot password, MFA step-up, session cookie via BFF, CSRF, logout, account state in the navbar". Sources: constitution VI, VII.7, V; `packages/web/AGENTS.md` and the Next.js guides *Authentication*, *Authentication with Cache Components*, *Backend for Frontend*, *Proxy*; `docs/architecture/pattern-map.md` rows P0504, P0512, P0903; backend specs S01, S02, S48; notes 09/03 and 05/02.

Companion files: [`questions.md`](questions.md) (decisions taken unattended, tagged), [`test-plan.md`](test-plan.md) (one row per scenario), [`gaps.md`](gaps.md) (what today's code lacks, missing backend endpoints, test tooling), [`checklists/requirements.md`](checklists/requirements.md).

## Scope

In scope (every screen the visitor or member reaches through these flows):

- **Create an account** (`/register`), **sign in** (`/login`), **second step at sign-in** (`/login/mfa`), **forgot password** (`/forgot-password`), **set a new password** (`/reset-password`).
- **Account security** (`/account/security`): turn two-step verification on and off, recovery codes, active sessions (devices), linked sign-in methods.
- **Browser session**: how the browser holds a signed-in state without ever holding a token; CSRF proof on every state-changing request; sign-out; what happens when the session ends by itself.
- **Account state in the navbar**: the account slot (anonymous, loading, signed in, unavailable) and the account entries of the mobile menu.
- **Redirects and notices** between these pages (`returnTo`, `notice`, `error`).
- **Continue with Google** UI, **conditional** on contract C-OIDC (see Cross-capability contracts). It is specified here; it ships only when the contract is met.

Out of scope (owned elsewhere):

- What the backend guarantees (credential checks, throttling, token rotation, MFA rules, OIDC protocol, password policy): **S01**, **S02**, **S48**. This spec cites their requirement IDs and specifies only how the UI shows and handles the outcome.
- The navbar frame (logo, search, theme, cart, notifications, footer, security headers, error and not-found pages): **W07**. W01 owns only the account slot and the account entries in the mobile menu.
- Merging the guest cart after sign-in: **W03** / **S10** own the merge; W01 triggers it (FR-007).
- Authorization of any other page (dashboard, checkout, chat, admin): their web capabilities. W01 provides the guard helper and the `returnTo` convention they must use.
- Display names, avatars, profile editing, e-mail change, e-mail verification, passkeys, "remember me": not built (the API has none of them).

## Routes and visible states

| Route | Who can open it | Visible states |
|---|---|---|
| `/register` | anonymous (a signed-in visitor is redirected away, AS-16) | form · submitting · field errors · form error · rate-limited · unavailable/offline |
| `/login` | anonymous (signed-in → redirected, AS-16) | form · notice banner · provider-error banner · submitting · wrong credentials · rate-limited · unavailable/offline · verification failure |
| `/login/mfa` | anyone with a pending sign-in (the page cannot tell, the server decides) | code form · recovery-code form · submitting · wrong code · attempts exhausted · sign-in timed out · rate-limited |
| `/forgot-password` | anyone | form · submitting · "check your inbox" confirmation · rate-limited · unavailable/offline |
| `/reset-password` | anyone holding a reset link | form · submitting · success · link invalid/expired · weak password · rate-limited |
| `/account/security` | signed-in only (anonymous → `/login?returnTo=%2Faccount%2Fsecurity`) | tabs `two-step` (default), `sessions`, `methods`; each tab loads independently: loading · loaded · error with retry |
| Navbar account slot (every page) | everyone | loading · anonymous · signed in · unavailable |

`/account` redirects to `/account/security`. `/mfa` (old route) no longer exists.

**URL view state** (constitution VI.4): `returnTo` (a validated same-site path), `notice` (one of `registered`, `signed_out`, `signed_out_everywhere`, `session_expired`, `password_reset`), `error` (one of the closed S02 callback codes, FR-044), `tab` (`two-step` | `sessions` | `methods`), `linked` (`google`). Unknown values are ignored, never echoed. No credential, code, token or e-mail ever appears in a URL (the reset token travels only in the URL fragment and is removed at once, AS-41).

## User Scenarios & Testing *(mandatory)*

Every acceptance scenario has a stable ID `AS-nn`; `test-plan.md` maps each to exactly one row. Backend rules are cited, never re-specified: "S01 AS-11" means scenario AS-11 of the S01 spec. Visible copy is in the *Copy catalogue* (FR-043).

### User Story 1 — Create an account (Priority: P1)

A visitor opens Sign up, enters an e-mail address and a password, confirms the password and accepts the terms. They are taken to the sign-in page with a neutral confirmation. They are **not** signed in automatically (see Assumptions: an automatic sign-in would reveal whether the address already had an account).

**Why this priority**: nothing else works without an account; the uniform outcome is a binding rule (constitution V.4, S01 AS-02).

**Independent Test**: fill the form with a new address, then with the same address again, and compare what the visitor sees.

**Acceptance Scenarios**:

1. **AS-01** — **Given** an anonymous visitor on `/register`, **When** they enter a valid e-mail, a password of 12–128 characters, the same password in "Confirm password", tick "I agree to the Terms and Privacy Policy" and press **Create account**, **Then** one request is sent with only `email` and `password`, and the browser navigates (history replaced) to `/login?notice=registered`, where the banner reads the `registered` notice; the visitor is not signed in and the navbar still shows **Log in** / **Sign up**; the e-mail and password are not in the URL. (S01 AS-01.)
2. **AS-02** — **Given** an e-mail that already has an account, **When** the same form is submitted, **Then** the visitor sees exactly the same navigation, banner and timing path as AS-01; no screen, string, focus move or announcement differs between a new and an existing address. (Backend sameness: S01 AS-02, AS-08.)
3. **AS-03** — **Given** the form, **When** the visitor submits with an empty or malformed e-mail, a password shorter than 12 or longer than 128 characters, a confirmation that differs, or the terms unticked, **Then** no request is sent, each problem shows as an inline message under its field (e-mail: "Enter a valid email address."; password: "Use 12 to 128 characters."; confirmation: "The passwords don't match."; terms: "Accept the terms to continue."), the first invalid field takes focus, and fields are marked `aria-invalid` and linked to their message.
4. **AS-04** — **Given** the server refuses a well-formed submission, **When** it answers `400 validation_failed` with per-field errors, **Then** each message appears under the matching field (a field the form does not have appears in the form-level alert); **When** it answers `422 weak_password`, **Then** the password field shows "This password has appeared in a known data breach. Choose a different one.", both password fields are cleared, focus moves to "Password", and the e-mail stays filled; the submitted password is never shown again anywhere. (S01 AS-05, AS-06.)
5. **AS-05** — **Given** `/register` at ≤ 640 px and ≥ 1024 px, **Then** the page has the structure of FR-050 and the fields in this order: E-mail, Password, Confirm password, Terms checkbox, **Create account**, link "Already have an account? Log in". There is no "Full name" field and no role choice.

### User Story 2 — Sign in (Priority: P1)

A member enters e-mail and password and lands on the page they were going to. Every failure the server can return has a specific, calm message next to the form; a wrong guess never reveals whether the address exists.

**Why this priority**: the main entry to everything behind an account.

**Independent Test**: sign in with right and wrong credentials, with and without `returnTo`.

**Acceptance Scenarios**:

1. **AS-06** — **Given** an anonymous visitor who opened `/login?returnTo=%2Faccount%2Fsecurity`, **When** they enter correct credentials and press **Sign in**, **Then** the button shows a spinner and "Signing in…" is announced; on success the navbar shows the account menu, the browser is at `/account/security` (history replaced, so Back does not return to the form), all previously cached server data is dropped, and the guest cart merge is requested once without blocking the navigation. Without `returnTo` the destination is `/`. (S48 AS-43; S01 AS-10.)
2. **AS-07** — **Given** the `returnTo` value, **When** it is a same-site path (`/`, `/account`, `/account/security?tab=methods`, `/orders/123#top`), **Then** it is used unchanged; **When** it is `//evil.example`, `/\evil.example`, `/%2F%2Fevil.example`, `/%5Cevil.example`, an absolute URL, `javascript:…`, empty, without a leading `/`, containing a control character, longer than 512 characters, or repeated, **Then** it is replaced by `/` without an error. (Same vector table as S02 AS-34; the web validator is separate code.)
3. **AS-08** — **Given** wrong credentials or an unknown address, **When** the server answers `401 invalid_credentials`, **Then** the form-level alert reads "The email or password is incorrect." (identical for both cases), the password field is cleared and focused, the e-mail stays, and the alert is announced. (S01 AS-11; S48 AS-45.)
4. **AS-09** — **Given** the server answers `429 rate_limited`, **When** it carries `Retry-After`, **Then** the alert reads "Too many sign-in attempts. Try again in {wait}." with {wait} per FR-041, the **Sign in** button is disabled until that time has passed and then re-enabled automatically, and the typed values stay. (S01 AS-12, AS-14.)
5. **AS-10** — **Given** the server answers `503` (`overloaded`, `session_unavailable`, `oidc_provider_unavailable`), any other `5xx`, an unknown error, or the request cannot reach the server, **Then** the alert reads, respectively, "This is taking longer than expected. Try again in a moment." (503), "Something went wrong on our side. Try again." with "Reference: {requestId}" (other 5xx or unknown), or "You appear to be offline. Check your connection and try again." (no response); the form stays filled and the button stays enabled. (S01 AS-18; S48 AS-45, AS-61.)
6. **AS-11** — **Given** the server answers `403 csrf_invalid` or `403 origin_not_allowed`, **Then** the alert reads "We couldn't verify this request. Reload the page and try again." with a **Reload** button that reloads the page. (S48 AS-44, AS-59.)
7. **AS-12** — **Given** a submission in flight, **Then** the button is disabled with `aria-busy`, the fields become read-only (values and focus kept), a second Enter press or click sends nothing, and when the request ends the controls are restored.
8. **AS-13** — **Given** an account with two-step verification, **When** the server answers `200 {mfaRequired: true}`, **Then** the browser navigates (history replaced) to `/login/mfa?returnTo=<validated path>`; no challenge or token is in the URL, the DOM or script-readable storage. (S01 AS-19; S48 AS-48.)
9. **AS-14** — **Given** `/login` at ≤ 640 px and ≥ 1024 px, **Then** the page has the structure of FR-050 and the focus order: E-mail, Password, Show/hide password, "Forgot password?", **Sign in**, **Continue with Google** (only when offered, AS-58), "Register" link. There is no "Remember me" checkbox and no GitHub button.
10. **AS-15** — **Given** `/login?notice=<value>` or `/login?error=<value>`, **Then** exactly one banner appears above the form with the copy of FR-043/FR-044 (`role="status"` for notices, `role="alert"` for errors); an unknown value shows nothing; the value is never rendered as typed. (Closed code list: S02 FR-048.)
11. **AS-16** — **Given** a signed-in visitor, **When** they open `/login`, `/register`, `/forgot-password` or `/login/mfa`, **Then** they are redirected before any form is shown to the validated `returnTo`, or `/`; **Given** a signed-in visitor opening `/login?error=<code>` (a failed link flow, S02), **Then** they are redirected to `/account/security?tab=methods&error=<code>`. `/reset-password` is open to signed-in visitors.

### User Story 3 — The navbar always shows the truth about who I am (Priority: P1)

On every page the navbar's account area shows a placeholder while the session is being checked, **Log in** / **Sign up** for visitors, the account menu for members, and a neutral retry state when the session cannot be checked. A signed-in member never sees a signed-out flash.

**Why this priority**: it is the one place where every page shows the session; a wrong state here misleads on every screen.

**Independent Test**: load pages anonymous, signed in, with a delayed session lookup, with a failing lookup.

**Acceptance Scenarios**:

1. **AS-17** — **Given** an anonymous visitor, **Then** at ≥ 1024 px the navbar shows **Log in** (link to `/login`) and **Sign up** (link to `/register`); at ≤ 640 px the header shows an icon link named "Log in", and the menu (hamburger) lists **Log in** and **Sign up** as its first two entries. Neither entry is ever unreachable at any width.
2. **AS-18** — **Given** the session check has not finished (including server streaming), **Then** the account area shows a fixed-size placeholder (`aria-busy="true"`, no text announced) of the same size as the account button, so nothing shifts when it resolves; **Given** a signed-in member, **Then** the placeholder resolves to the account menu and the **Log in** / **Sign up** controls are never rendered for them, not even for one frame.
3. **AS-19** — **Given** a signed-in member, **Then** the navbar shows a button with the accessible name "Account menu" (visible: two-letter initials from the e-mail local part) that opens a menu showing the e-mail address and role, then entries **Dashboard**, **Orders**, **Account & security**, **Log out**; Enter/Space/ArrowDown opens it, arrow keys move, Escape closes it and returns focus to the button; at ≤ 640 px the same entries appear in the hamburger sheet under the e-mail (a labelled "Account" group).
4. **AS-20** — **Given** the session check fails with `503 session_unavailable` or no network, **Then** the account area shows a button named "Sign-in status unavailable. Retry" (not the anonymous controls, not the account menu with stale data being asserted as current), and the last known account menu stays usable when one was already shown; **When** the connection returns (browser `online` event) or the tab regains focus, **Then** the session is checked again and the area updates without a reload. (S48 AS-56, AS-61.)
5. **AS-21** — **Given** a signed-in member, **When** they reload the page or open the site in a new tab, **Then** they are still signed in and the account area never passes through the anonymous state. (S48 AS-51; S01 AS-86.)
6. **AS-22** — **Given** two tabs of the same browser, **When** the member signs out (or the session ends) in one tab, **Then** within 1 second the other tab shows the anonymous navbar and drops its cached private data; **When** they sign in in one tab, **Then** the other tab shows the account menu within 1 second.
7. **AS-23** — **Given** an action that changes the member's role (opening a shop makes them a seller), **When** the page requests a session refresh, **Then** the account menu and every consumer of the session show the new role without a reload. (S01 AS-28; S48 AS-53.)

### User Story 4 — Sign out, and sessions that end on their own (Priority: P1)

A member signs out from the menu and lands on the sign-in page with a confirmation. If the session ends by itself (expired, signed out elsewhere, password reset), the next action explains it and offers to sign in again, returning them to where they were.

**Why this priority**: sign-out must be real, and an ended session must never look like a broken page.

**Independent Test**: sign out; end a session on the server and use the page.

**Acceptance Scenarios**:

1. **AS-24** — **Given** a signed-in member, **When** they choose **Log out**, **Then** the browser navigates to `/login?notice=signed_out`, the navbar is anonymous, every cached server answer is dropped, and Back does not reveal private data (guarded pages redirect to `/login`). (S48 AS-58.)
2. **AS-25** — **Given** the sign-out request fails (no network, `403 csrf_invalid`, `5xx`), **Then** the member stays signed in and sees a toast "We couldn't sign you out. Try again." with a **Try again** action (for `csrf_invalid`: "Reload the page and try again."); the interface never pretends to be signed out while the server session may still be active.
3. **AS-26** — **Given** a signed-in member whose session ended on the server, **When** any request (including the session check itself) answers `401` with `session_expired`, `unauthenticated` or `invalid_token`, **Then** exactly once (concurrent failures are de-duplicated) the cached data is dropped, the navbar becomes anonymous, the page's server guards re-run (`router.refresh()`, so a guarded page redirects to `/login?returnTo=<its path>`), and a status toast reads "Your session ended. Sign in again to continue." with a **Sign in** action linking to `/login?returnTo=<current path>&notice=session_expired`; a public page stays where it is; no automatic retry of the failed request is made by the browser. (S48 AS-52, AS-55.)
4. **AS-27** — **Given** an anonymous visitor, **When** they open `/account/security` (or any page guarded with the W01 helper), **Then** they land on `/login?returnTo=%2Faccount%2Fsecurity` and, after signing in, on `/account/security`. (Authorization is still enforced by every API the page calls, AS-65.)

### User Story 5 — The browser never holds a token and proves every change (Priority: P1)

The browser has an opaque session cookie it cannot read and a CSRF cookie it must echo. No script, storage, URL or header the web code controls carries an access or refresh token. Every state-changing request from a signed-in browser carries the CSRF proof.

**Why this priority**: constitution VI.2, patterns P0504 and P0512.

**Independent Test**: sign in, inspect storage and cookies, intercept requests.

**Acceptance Scenarios**:

1. **AS-28** — **Given** a signed-in browser, **When** any non-`GET` request is sent through the shared API client, **Then** it carries `X-CSRF-Token` equal to the value of the script-readable `__Host-bff-csrf` cookie; `GET` requests do not; requests of anonymous flows (register, sign-in, password reset request/confirm) carry none; **When** the cookie is missing while the interface believes the member is signed in, **Then** the request is not sent and the session-ended flow of AS-26 runs. (S48 AS-58, AS-59; S01 AS-47.)
2. **AS-29** — **Given** a member who signed in, registered, used two-step setup, **Then** `localStorage`, `sessionStorage`, IndexedDB, `document.cookie`, the URL and the DOM contain no access token, refresh token, challenge token or token digest (only `__Host-bff-csrf` is readable, and it is not a credential); no browser request made by web code has an `Authorization` header. (S48 AS-43; S01 AS-86.)
3. **AS-30** — **Given** any call made by W01 code, **Then** its URL is relative to the site's own origin (`/api/…`); no absolute API origin and no `NEXT_PUBLIC_*` base URL is used. (S48 AS-63; same-origin routing in `next.config.ts`.)
4. **AS-31** — **Given** the GraphQL client and the event-stream reader, **Then** they authenticate with the session cookie plus the CSRF header on `POST`, never with a bearer token read from memory. (S48 AS-42.)

### User Story 6 — Finish signing in with a second step (Priority: P1)

A member with two-step verification enters the 6-digit code from their authenticator app (or a recovery code) and arrives where they were going. Wrong codes, a timed-out sign-in and too many attempts each have a clear next step.

**Why this priority**: it is the step-up that makes the factor meaningful, and the part with the most failure states.

**Independent Test**: sign in as an enrolled member; try a wrong code, a recovery code, an expired sign-in.

**Acceptance Scenarios**:

1. **AS-32** — **Given** the member reached `/login/mfa?returnTo=/account/security` (AS-13), **When** they enter the current 6-digit code and press **Verify**, **Then** the navbar shows the account menu and the browser is at the validated `returnTo` (history replaced); the sign-in effects of AS-06 apply. (S48 AS-48; S02 AS-12.)
2. **AS-33** — **Given** the page, **When** the member chooses **Use a recovery code instead**, **Then** the field becomes "Recovery code" (hint "Format: XXXXX-XXXXX"), accepts the code in upper or lower case, with or without the hyphen, and with surrounding spaces, and **Use authenticator code instead** switches back; success behaves as AS-32. (S02 AS-20.)
3. **AS-34** — **Given** a wrong code, **When** the server answers `401 invalid_mfa_code` (or `422 invalid_code`), **Then** the alert reads "That code isn't right. Check your authenticator app and try again." (identical for both code kinds), the field is cleared and focused and the alert is announced. (S02 AS-16; S48 AS-49.)
4. **AS-35** — **Given** no pending sign-in exists or the pending sign-in is spent or expired or burned (`409 mfa_not_pending`, `401 invalid_mfa_challenge`, `401 invalid_token`), **Then** the form is replaced by "Your sign-in timed out. Sign in again." with a **Back to sign in** link to `/login` (carrying the validated `returnTo`). (S02 AS-19; S48 AS-49.)
5. **AS-36** — **Given** `429 rate_limited`, **Then** the alert reads "Too many incorrect codes. Try again in {wait}." and **Verify** is disabled until the time has passed. (S02 AS-17, AS-18.)
6. **AS-37** — **Given** the code field, **Then** it is one text input labelled "Authentication code" with `inputmode="numeric"`, `autocomplete="one-time-code"` and `maxlength` 6; pasted text such as "123 456" or "123-456" is reduced to its digits; non-digits typed are ignored; **Verify** stays disabled until 6 digits are present; nothing is submitted automatically when the sixth digit is typed (the member presses Verify or Enter).
7. **AS-38** — **Given** `/login/mfa` at ≤ 640 px and ≥ 1024 px, **Then** the page has the structure of FR-050 with focus order: code field, **Verify**, "Use a recovery code instead", "Back to sign in".

### User Story 7 — Forgot my password (Priority: P2)

A member asks for a reset link and always sees the same confirmation; with the link they set a new password and are sent to sign in.

**Why this priority**: required by constitution V.4 anti-enumeration and S01 User Story 9.

**Independent Test**: request for a known and an unknown address; open a reset link; open it again.

**Acceptance Scenarios**:

1. **AS-39** — **Given** `/forgot-password`, **When** the visitor submits any well-formed e-mail and the server answers `202`, **Then** the form is replaced by the heading "Check your inbox" and "If an account exists for that address, we've sent a link to reset the password. The link works once and expires in 30 minutes." with a **Back to sign in** link; focus moves to the heading; the screen is identical for every address. (S01 AS-73.)
2. **AS-40** — **Given** the request does not get `202`, **When** the server answers `429 rate_limited`, `400 validation_failed`, `5xx`, or there is no network, **Then** the confirmation is **not** shown; instead the form stays with, respectively, "Too many reset requests. Try again in {wait}.", the field message "Enter a valid email address.", "Something went wrong on our side. Try again." (+ reference), or the offline message; the typed address is kept. (S01 AS-78.)
3. **AS-41** — **Given** a reset link `/reset-password#token=<token>`, **When** the page loads, **Then** the token is read from the fragment, removed from the address bar and history immediately (the URL becomes `/reset-password`), held only in memory, and the form "New password" / "Confirm new password" is shown; **When** the visitor submits a valid new password and the server answers `204`, **Then** the page shows "Password updated" with a **Sign in** link, any signed-in state is dropped locally, and following **Sign in** opens `/login?notice=password_reset`. (S01 AS-75.)
4. **AS-42** — **Given** the page is opened without a token in the fragment, or the server answers `400 invalid_reset_token` (unknown, used or expired), **Then** the form is replaced by "This reset link is invalid or has expired." with a **Request a new link** link to `/forgot-password`; opening without a token makes no request. (S01 AS-76.)
5. **AS-43** — **Given** a token and a submission, **When** the server answers `422 weak_password`, `400 validation_failed` or `429 rate_limited`, **Then** the form stays, the token stays in memory (it was not consumed), and the message appears under "New password" ("This password has appeared in a known data breach. Choose a different one." / the server's field message / the wait message "Too many attempts. Try again in {wait}."); client-side checks (12–128 characters, confirmation equal) show first and send nothing. (S01 AS-76, AS-78.)
6. **AS-44** — **Given** `/forgot-password` and `/reset-password` at ≤ 640 px and ≥ 1024 px, **Then** both have the structure of FR-050; focus order of the reset form: New password, Show/hide, Confirm new password, **Update password**.

### User Story 8 — Two-step verification in my account (Priority: P2)

A member opens Account security, turns on two-step verification (scan or type the key, confirm with a code), saves ten recovery codes shown once, and can later get new codes or turn it off. Changing the factor always needs a fresh code.

**Why this priority**: it is how members get the protection that US6 relies on; flaws here weaken the account.

**Independent Test**: enrol, save codes, sign out, sign in with a code; regenerate; disable.

**Acceptance Scenarios**:

1. **AS-45** — **Given** the **Two-step verification** tab, **Then** while loading it shows a skeleton; on failure a message "We couldn't load this section." with **Retry** (other tabs still work); for state `none` it shows "Two-step verification is off." and **Set up**; for `pending` "Setup wasn't finished." and **Start over**; for `enabled` "Two-step verification is on since {date}." with "{n} recovery codes left", **Get new recovery codes**, **Turn off**; with 3 or fewer codes left it adds "Only {n} recovery codes left. Get new ones soon." and with 0 "You have no recovery codes left. Get new ones now." (S02 AS-09.)
2. **AS-46** — **Given** state `none`, **When** the member presses **Set up**, **Then** a dialog "Set up two-step verification" shows step 1 (a QR code with a text alternative, the setup key as text with a **Copy key** button), step 2 (field "6-digit code", **Confirm**), and on success step 3, the recovery codes (AS-47); the tab then shows state `enabled`; a later sign-in asks for a code (AS-32). (S02 AS-01, AS-04, AS-65.)
3. **AS-47** — **Given** recovery codes returned by confirm or regenerate, **Then** the ten codes are shown in a grid (`XXXXX-XXXXX`) with "Store these somewhere safe. You won't see them again." plus **Copy all** and **Download .txt**; **Done** is disabled until "I've saved these codes" is ticked; Escape and outside click do not close the dialog before then; leaving the page while it is open triggers the browser's unsaved-changes prompt; after close the codes exist nowhere in the page (not in the query cache, storage, URL or DOM). (S02 AS-04.)
4. **AS-48** — **Given** setup, **When** the confirm step gets `422 invalid_code`, **Then** "That code isn't right. Check your authenticator app and try again." under the field, the field is cleared and focused, setup stays on step 2; `429 rate_limited` shows "Too many incorrect codes. Try again in {wait}."; `409 mfa_not_pending` shows "Setup timed out. Start again." and returns to step 1 with a fresh enrolment on **Set up**. (S02 AS-05, AS-06, AS-17.)
5. **AS-49** — **Given** the status shown is stale (another tab changed it), **When** an action answers `409 mfa_already_enabled`, `409 mfa_not_enabled` or `409 mfa_not_pending`, **Then** the dialog closes, the status is re-read, and a toast states the real situation ("Two-step verification is already on." / "Two-step verification isn't turned on." / "Setup timed out. Start again."). (S02 AS-03, AS-06, AS-25, AS-26.)
6. **AS-50** — **Given** state `pending` after a reload (the secret is never shown again), **Then** the tab offers **Start over**, which begins a new setup (new key); the old key is not recoverable. (S02 AS-02.)
7. **AS-51** — **Given** state `enabled`, **When** the member presses **Get new recovery codes**, **Then** a dialog asks for the current 6-digit authenticator code only (a recovery code is not accepted: hint "Use the code from your authenticator app"), and on success shows the new codes as AS-47; `422 invalid_code` and `429` show as AS-48; the old codes stop working (nothing to display). (S02 AS-25, AS-27.)
8. **AS-52** — **Given** state `enabled`, **When** the member presses **Turn off**, **Then** a dialog warns "Your account will be protected by your password only." and asks for an authenticator code or a recovery code; on `204` the dialog closes, the tab shows `none` and a toast "Two-step verification is off."; `422 invalid_code` and `429` show as AS-48. (S02 AS-26, AS-27.)
9. **AS-53** — **Given** `/account/security` at ≤ 640 px and ≥ 1024 px, **Then** the page has the structure of FR-051; dialogs at ≤ 640 px fill the width as bottom sheets with the primary action reachable without scrolling the page; the QR code never overflows.

### User Story 9 — See and end my sessions (Priority: P2)

A member sees the devices that are signed in, signs out one other device, or signs out everywhere.

**Why this priority**: instant revocation is the reason sessions are server-side (S01 User Story 5).

**Independent Test**: sign in on two browsers; revoke the other from the first; sign out everywhere.

**Acceptance Scenarios**:

1. **AS-54** — **Given** the **Active sessions** tab, **Then** while loading it shows skeleton rows; on failure "We couldn't load this section." with **Retry**; loaded, it lists the member's sessions newest first, each with device, IP address, "Signed in {date}" and "Last active {relative time}" in `<time>` elements; the current one is labelled "This device" (text, not colour only) and has no revoke control; the list is never empty (the current session is in it). (S01 AS-39.)
2. **AS-55** — **Given** another device's row, **When** the member presses **Log out** on it, **Then** the button shows a spinner, and on `204` the row disappears and "Device signed out." is announced; **When** the server answers `404 session_not_found` (already ended elsewhere), **Then** the row disappears with the same announcement; other errors show a toast with the FR-040 copy and the row stays. (S01 AS-40, AS-41.)
3. **AS-56** — **Given** the tab, **When** the member presses **Log out of all devices**, **Then** a confirmation dialog says "This signs you out here too." with **Cancel** / **Log out everywhere**; on success the interface ends the local session and navigates to `/login?notice=signed_out_everywhere`. (S01 AS-43.)
4. **AS-57** — **Given** the tab at ≤ 640 px and ≥ 1024 px, **Then** at ≥ 1024 px the sessions are a table (Device, IP address, Signed in, Last active, Actions); at ≤ 640 px each session is a stacked card with the same fields as a definition list and a full-width action.

### User Story 10 — Continue with Google and manage sign-in methods (Priority: P3, conditional on C-OIDC)

A visitor chooses **Continue with Google** and lands signed in; a member links or unlinks Google in their account. Specified now, shipped when contract C-OIDC is met; until then the button is not rendered (FR-045).

**Why this priority**: one-click sign-in is valuable but depends on a session hand-off between S02 and S48 that does not exist yet.

**Acceptance Scenarios**:

1. **AS-58** — **Given** the providers list contains `google`, **Then** `/login` shows **Continue with Google**; when the list is empty or the request fails, the button is not rendered and nothing else changes; **When** pressed, a start request is sent (`returnTo` validated), the button shows a spinner and is disabled, and the browser navigates to the returned `authorizationUrl`; a start failure shows the AS-10 messages above the button. (S02 AS-28, AS-29.)
2. **AS-59** — **Given** a visitor who approves at Google, **When** the callback completes, **Then** they are on the page they came from, the navbar shows the account menu and the sessions list shows this device. (S02 AS-31, AS-66.)
3. **AS-60** — **Given** a member with two-step verification who signs in with Google, **When** the callback completes, **Then** they arrive at `/login/mfa?returnTo=…` with no token or challenge in the URL and finish as AS-32. (S02 AS-54.)
4. **AS-61** — **Given** the **Sign-in methods** tab, **Then** it lists linked identities (provider, e-mail or "No e-mail shared", "Linked {date}") with **Unlink**; empty state "No sign-in methods linked yet."; a **Link Google** button (shown only when offered) that, for a member with two-step verification, first asks for a code (AS-48 error handling) and then navigates to the returned `authorizationUrl`; returning with `?linked=google` shows "Google account linked."; with `?error=` shows the FR-044 copy; **Unlink** answering `409 last_login_method` shows "This is your only way to sign in. Add another sign-in method first.", `204` removes the row, `404 identity_not_found` removes it silently. (S02 AS-49, AS-50, AS-51, AS-52.)

### User Story 11 — Rendering, access and accessibility rules (Priority: P3)

How these pages are rendered and guarded, and the accessibility baseline all of them meet.

**Acceptance Scenarios**:

1. **AS-62** — **Given** the production build, **Then** every W01 page prerenders its static shell (card, heading, description) and streams the parts that read the session or the URL behind `<Suspense>` boundaries with fallbacks of the same size; the session is never read at the top level of a layout or inside a plain `"use cache"` function; the build reports no "runtime data outside Suspense" error.
2. **AS-63** — **Given** the W01 source, **Then** every `page.tsx` and `layout.tsx` is a Server Component; `"use client"` appears only on leaf components that use state, effects, event handlers or browser APIs (forms, dialogs, tabs, the account menu).
3. **AS-64** — **Given** `/reset-password`, **Then** its response carries `Referrer-Policy: no-referrer` and the page loads no third-party resource.
4. **AS-65** — **Given** the app, **Then** there is no `proxy.ts` that makes an authorization decision; guards in layouts only redirect for convenience (`requireServerSession`), and every data request is authorized again by the BFF and the owning API: when one answers `401` the UI follows AS-26, when `403` or `404` it shows the FR-040 copy, never data from a cache. (Constitution VI.5; S48 AS-51; S01 AS-29.)
5. **AS-66** — **Given** every W01 page and dialog, **Then** it meets FR-052..FR-056 (one `h1`, labelled controls, focus management, live regions, keyboard-only completion, visible focus, 44 px touch targets at ≤ 640 px, no horizontal scroll at 320 px).
6. **AS-67** — **Given** any W01 flow, **Then** nothing the browser console receives from W01 code contains a password, code, token, recovery code, setup key or request body; error logging is limited to HTTP status, problem `code` and `requestId`.

### Edge Cases

Each is covered by the scenario shown; none is left to implementation judgement.

- Same address registered twice → AS-02. Weak or breached password → AS-04.
- Open redirect through `returnTo` → AS-07. Forged `notice` / `error` values → AS-15.
- Wrong password, unknown address, throttling, outage, offline → AS-08..AS-10. Forged cross-site request → AS-11. Double submit → AS-12.
- Signed-in visitor on an auth page → AS-16. Failed link flow while signed in → AS-16.
- Session ending on its own, in another tab, or while a request is in flight → AS-22, AS-26.
- Session check failing (503/offline) → AS-20 (never rendered as anonymous).
- Missing CSRF cookie while signed in → AS-28.
- Wrong, reused, expired second-step codes; burned challenge; throttle → AS-34..AS-36, AS-48.
- Reset link opened twice, expired, or without a token; token in history/Referer → AS-41, AS-42, AS-64.
- Stale two-step status across tabs → AS-49. Recovery codes lost on reload → AS-47 (by design, shown once).
- Session already revoked elsewhere when revoking → AS-55. Revoking the current device → no control (AS-54).
- Last remaining sign-in method → AS-61.
- Provider errors on return from Google → AS-15, AS-16, AS-61.
- Layout: 320 px width, long e-mail addresses (truncate with accessible full text), long device strings (wrap), zoom 200 % → AS-66.

## Requirements *(mandatory)*

### Defaults

Password input limits shown to the visitor: 12–128 characters (S01 FR-005). Code length: 6 digits (S02). Reset link lifetime shown: 30 minutes (S01 FR-081). Low recovery-code warning at ≤ 3 codes. Session check re-run on window focus and on reconnect; otherwise 60 s stale time. Cross-tab propagation ≤ 1 s. All copy is in English (no localization layer in this version).

### Functional Requirements

**Data flow and boundaries (constitution VI; P0504, P0512, P0903)**

- **FR-001**: The browser MUST hold a signed-in state only through the BFF session cookie (opaque, HttpOnly) and the readable CSRF cookie. Web code MUST NOT read, receive, store, forward or log an access, refresh or challenge token, and MUST NOT set an `Authorization` header (AS-29, AS-31).
- **FR-002**: All network calls MUST live in `lib/api/*` (typed functions that parse responses with `packages/contracts` schemas) or in server-only data modules; components and hooks never call `fetch`, `axios` or `EventSource` directly. Every URL is same-origin and relative (AS-30).
- **FR-003**: Every non-`GET` request sent while signed in MUST carry `X-CSRF-Token` taken from `__Host-bff-csrf` by one helper in `lib/api`; anonymous flows send none; a missing cookie while signed in aborts the request and runs AS-26 (AS-28).
- **FR-004**: The session is server data: it lives in TanStack Query under the key `queryKeys.auth.session()` (from `lib/query-keys.ts`), fetched with `GET /api/bff/session`. `401` means anonymous; `503`/no network means *unavailable* (the previous value is kept, never replaced by anonymous). The query refetches on window focus and on reconnect. The session is not copied into `useState`, a store, or a second context (AS-18, AS-20, AS-21).
- **FR-005**: The account slot and every guard read the session on the server through one server-only function (`getServerSession`) that forwards only the session cookie to the BFF, is memoized per request, and returns the narrow `{id, email, role}` or `null`. It is called only inside a component under a `<Suspense>` boundary, never at the top of a layout, never inside `"use cache"` (AS-18, AS-62, AS-65).
- **FR-006**: Server Components are the default. Pages and layouts are Server Components; forms, dialogs, tabs and the account menu are small client leaves that receive only the props they render (constitution VI.1, VI.8). W01 defines no Server Action: sign-in, MFA and sign-out are same-origin requests made from `lib/api`, so the BFF itself sets the cookies and CSRF stays one scheme. A Server Action added later MUST re-read the session, validate its input and authorize the record (P0903) (AS-63).
- **FR-007**: After every sign-in (password, MFA, OIDC) the interface MUST: store the returned user under `queryKeys.auth.session()`, invalidate all other queries (data cached for the anonymous visitor), request the guest-cart merge without blocking (failure is silent and does not block navigation), `router.replace` to the validated `returnTo`, then `router.refresh()`, and announce the change to other tabs (AS-06, AS-22).
- **FR-008**: After sign-out or session end the interface MUST clear the whole query cache, announce it to other tabs, and then do what AS-24 (navigate to sign-in) or AS-26 (toast with a Sign in action, server guards re-run) specify. Any API response `401` with `session_expired`, `unauthenticated` or `invalid_token` for a request made while signed in, and a `401` from the session check when it previously held a user, runs the AS-26 flow once; the browser never refreshes tokens or retries the request (AS-24, AS-26).
- **FR-009**: Authorization is never decided only in a guard or `proxy.ts`: guards redirect for convenience, and the BFF and owning APIs authorize every data request again (VI.5). W01 adds no auth logic to a `proxy.ts` (AS-65).
- **FR-010**: Shareable view state is in the URL (`returnTo`, `notice`, `error`, `tab`, `linked`); each is validated against its allowlist or validator; unknown or malformed values are ignored (AS-07, AS-15, AS-53).
- **FR-011**: Server data of the security page (`mfaStatus`, `sessions`, `identities`, `oidcProviders`) lives in TanStack Query with keys from `lib/query-keys.ts`; each tab owns its queries so one failing section does not hide the others; mutations invalidate exactly the keys they change. Recovery codes and the setup key are mutation results shown from local component state only and are never written to the query cache (`gcTime` 0), storage or URL (AS-45, AS-47, AS-54).

**Pages and forms**

- **FR-020**: Register (AS-01..AS-05): fields E-mail, Password, Confirm password, Terms checkbox; sends `{email, password}` only (e-mail trimmed); the confirmation field and the terms box are interface-only checks. Success navigates to `/login?notice=registered`; the interface never signs the visitor in automatically. Password fields use `autocomplete="new-password"`, a Show/hide toggle (`aria-pressed`, label "Show password"/"Hide password"), and the hint "Use 12 to 128 characters." linked with `aria-describedby`.
- **FR-021**: Sign in (AS-06..AS-16): fields E-mail (`autocomplete="username"`, `type="email"`) and Password (`autocomplete="current-password"`, Show/hide toggle); sends `{email, password}` to the BFF session endpoint; the password is checked client-side only for non-empty (login never enforces the registration policy). Controls not backed by the API ("Remember me", GitHub) do not exist.
- **FR-022**: Second step (AS-32..AS-38): a form that posts `{code}` to the BFF MFA endpoint; the pending challenge lives server-side in the BFF (HttpOnly cookie), so it is never in the URL, DOM or storage. Inputs per AS-37 and AS-33. History is replaced on success.
- **FR-023**: Forgot password (AS-39, AS-40): field E-mail; the confirmation of AS-39 is shown only after a `202`; the endpoint is the S01 reset request.
- **FR-024**: Reset password (AS-41..AS-43): reads the token from `location.hash` (`#token=…`), removes it with `history.replaceState`, keeps it in a ref; sends `{token, password}` to the S01 reset confirmation; fields New password and Confirm new password (`autocomplete="new-password"`). The page sets `Referrer-Policy: no-referrer` (AS-64).
- **FR-025**: Account security (AS-45..AS-57): tabs in a `tablist` with the selected tab in `?tab=` (default `two-step`); the page requires a session (AS-27) and every call is re-authorized by the API.
- **FR-026**: Two-step setup, recovery codes, regenerate and turn-off dialogs follow AS-46..AS-52; each is a modal dialog that traps focus, labels itself with its title, returns focus to the control that opened it, and disables its primary action while a request is in flight. Changing the factor always asks for a fresh code.
- **FR-027**: Sessions tab (AS-54..AS-57): current device has no revoke control (signing out the current device is the menu's **Log out**); revoking another device and "everywhere" follow AS-55/AS-56.
- **FR-028**: Navbar account slot (AS-17..AS-23): states loading / anonymous / signed in / unavailable; exported to W07's navbar as one component with a same-size fallback.
- **FR-029**: Sign-out (AS-24, AS-25) is a button in the account menu and mobile sheet that requests the BFF sign-out; it succeeds only when the request succeeds.
- **FR-030**: Cross-tab sync (AS-22): sign-in, sign-out and session end are broadcast to other tabs (`BroadcastChannel` named `auth`, message `{type: "signed-in" | "signed-out"}` with no user data); receiving tabs refetch or clear the session query.
- **FR-031**: Role refresh (AS-23): a hook asks the BFF to re-issue the session and writes the returned user to `queryKeys.auth.session()`.

**Errors and copy (constitution V.3)**

- **FR-040**: Every error shown to a visitor is derived from the RFC 9457 problem body: the stable `code`, the HTTP `status`, the `errors` list of `validation_failed`, the `Retry-After` header and `requestId`. The mapping in the *Copy catalogue* is the only source of text. Server `detail`/`title` strings are never rendered, except the per-field messages of `validation_failed`. Unknown codes fall back by status class (4xx: "Something didn't work. Check the details and try again."; 5xx and no body: the unexpected-error copy). One component renders the alert (`role="alert"`) and one function converts a failed call to a displayable problem; both are shared with other capabilities.
- **FR-041**: Wait text for `429`: `Retry-After` seconds < 60 → "{n} seconds" ("1 second"); < 3600 → whole minutes rounded up ("{n} minutes", "1 minute"); otherwise whole hours rounded up; header missing → the sentence ends "Try again later." instead of "Try again in {wait}.". Controls that the wait disables are re-enabled by a timer without a reload.
- **FR-042**: For `5xx`, unknown errors and `502`, the alert adds "Reference: {requestId}" (selectable text) when the body has one; never any stack, SQL or upstream text (V.3).
- **FR-043**: Copy catalogue (exact strings; tests assert them). Notices (`role="status"`): `registered` "Thanks for signing up. Sign in with your email and password to continue. If you already had an account, use your existing password or reset it."; `signed_out` "You've been signed out."; `signed_out_everywhere` "You've been signed out on all devices."; `session_expired` "Your session ended. Sign in again to continue."; `password_reset` "Your password was changed. Sign in with your new password." Errors (`role="alert"`): `invalid_credentials` "The email or password is incorrect."; wrong code (`invalid_mfa_code`, `invalid_code`) "That code isn't right. Check your authenticator app and try again."; challenge gone (`mfa_not_pending`, `invalid_mfa_challenge`, `invalid_token` on the MFA step) "Your sign-in timed out. Sign in again."; `invalid_reset_token` "This reset link is invalid or has expired."; `weak_password` "This password has appeared in a known data breach. Choose a different one."; `csrf_invalid` / `origin_not_allowed` "We couldn't verify this request. Reload the page and try again."; `rate_limited` "Too many {sign-in attempts | incorrect codes | sign-up attempts | reset requests | attempts}. Try again in {wait}."; `503` family "This is taking longer than expected. Try again in a moment."; other `5xx`/unknown "Something went wrong on our side. Try again."; no response "You appear to be offline. Check your connection and try again."; `last_login_method` "This is your only way to sign in. Add another sign-in method first."; `mfa_already_enabled` "Two-step verification is already on."; `mfa_not_enabled` "Two-step verification isn't turned on."; `mfa_not_pending` (setup) "Setup timed out. Start again.".
- **FR-044**: Provider-error banners for `?error=` (closed list of S02 FR-048): `oidc_state_invalid` "That sign-in link is no longer valid. Start again from this page."; `oidc_denied` "Google sign-in was cancelled. You can try again or use your email and password."; `oidc_exchange_failed` "We couldn't complete sign-in with Google. Try again."; `oidc_token_invalid` "We couldn't verify your Google sign-in. Try again."; `oidc_provider_unavailable` "Google sign-in is unavailable right now. Try again in a moment, or use your email and password."; `email_not_verified` "Google didn't confirm your email address, so we couldn't sign you in with it."; `account_unavailable` "This account is unavailable. Contact support if you think this is a mistake."; `link_conflict` "This account already has a Google sign-in linked, or that address belongs to a different one."; `identity_already_linked` "That Google account is already linked to another user."; any other value shows nothing.
- **FR-045**: **Continue with Google** and **Link Google** render only when the providers list contains `google` AND contract C-OIDC is in force (a build-time/deploy flag `AUTH_OIDC_ENABLED` read on the server and passed as a boolean to the leaf). Until then neither appears and no OIDC request is made.

**Layout and accessibility**

- **FR-050**: Auth shell (register, sign in, second step, forgot, reset). ≥ 1024 px: two equal columns inside `<main>`; the left is a decorative brand panel (`aria-hidden`, no heading, no focusable content); the right is the form column, vertically centred, content width ≤ 28 rem inside a bordered card. ≤ 640 px: one column; no brand panel; the logo link "Marketplace" is centred above the card; the card is borderless and full width with a 16 px side gutter; fields and the primary button are full width. Between 640 and 1024 px the single-column structure applies, centred. Inside the card, in order: `h1` title, description, banner/alert area, form, secondary links. The site navbar and footer stay present on these pages.
- **FR-051**: Account security. ≥ 1024 px: `h1` "Account security", a vertical tab list (220 px) left, the active panel right; sessions as a table. ≤ 640 px: the tab list becomes a horizontal, scrollable tab strip above the panel (the selected tab scrolled into view), panels full width, sessions as cards, dialogs as bottom sheets. Both: only the active panel is in the accessibility tree; the tab list is operable with Left/Right (horizontal) or Up/Down (vertical) arrows, Home and End.
- **FR-052**: Every page has exactly one `h1` (the form title) and sets a distinct document title ("Sign in · Marketplace", "Create account · Marketplace", "Two-step verification · Marketplace", "Forgot password · Marketplace", "Reset password · Marketplace", "Account security · Marketplace"). Every control has a visible `<label>`; hints and errors are tied with `aria-describedby`; invalid fields have `aria-invalid="true"`; required fields are indicated in text, not by colour.
- **FR-053**: Focus: nothing is auto-focused on load (a screen-reader user hears the page title first); after a failed submission focus goes to the first invalid field, or to the form-level alert (`tabIndex=-1`) when no field is at fault, except where a scenario names a field; after a success screen replaces a form (AS-39, AS-41) focus moves to its heading; dialogs follow FR-026.
- **FR-054**: Live regions: notices use `role="status"`, errors `role="alert"`; the submit state is announced politely ("Signing in…", "Creating your account…", "Verifying…", "Sending…", "Updating…"); the QR code has the text alternative "QR code for your authenticator app. The setup key below is the same secret."; loading placeholders use `aria-busy` and are not announced.
- **FR-055**: Everything W01 renders is reachable and operable by keyboard alone, with visible focus; interactive targets are at least 44 × 44 px at ≤ 640 px; content has no horizontal scroll from 320 px width up and survives 200 % zoom; colour is never the only carrier of meaning; motion respects `prefers-reduced-motion`.
- **FR-056**: Long values (e-mail addresses, device strings) wrap or truncate with the full text available to assistive technology; the account menu shows the full e-mail in a wrapping line.

**Observability and safety**

- **FR-060**: Client-side error logging contains only HTTP status, problem `code` and `requestId`; never a request body, password, code, token, recovery code or setup key (AS-67). `console.error(error)` of raw error objects is not allowed in W01 code.
- **FR-061**: Pages that show or consume secrets (reset password, recovery codes dialog) are never cached by the browser's back-forward state beyond the session: the recovery-code dialog unmounts its contents on close (AS-47).

### Key Entities

- **Session (browser view)**: `{user: {id, email, role}}` plus a status `loading | authenticated | anonymous | unavailable`. The only identity data the web app holds. Roles: `USER`, `SELLER`, `MODERATOR`, `ADMIN`.
- **Pending sign-in**: a server-side state in the BFF between password and code; the browser holds only an HttpOnly cookie for it and never sees its content.
- **Notice / provider error**: a short, allowlisted code in the URL that selects one banner.
- **Problem**: the failed-call description (`status`, `code`, `errors[]`, `retryAfterSeconds`, `requestId`) from which all error copy is derived.
- **Two-step status**: `none | pending | enabled` with `enabledAt` and `recoveryCodesRemaining`.
- **Recovery code set / setup key**: ten codes and one key, shown once from component state, never persisted.
- **Session item**: `{sessionId, device, ip, createdAt, lastUsedAt, current}` from the identity service.
- **Linked identity**: `{id, provider, email | null, linkedAt}`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new visitor can create an account and be signed in on the home page within 60 seconds, using only a keyboard if they wish.
- **SC-002**: After signing in, signing out, or having a session end, 100 % of open tabs show the correct account state within 1 second of the change or of the next focus, and a signed-in member never sees **Log in** / **Sign up** on any page load.
- **SC-003**: Across all W01 flows, zero access, refresh or challenge tokens, passwords, codes or recovery codes appear in browser storage, URLs, the DOM after use, or console output.
- **SC-004**: 100 % of the backend error classes the flows can receive show a specific, calm message with a next step; 0 raw server messages, stack traces or upstream texts are ever displayed.
- **SC-005**: Every W01 page is completable by keyboard alone, passes an automated accessibility scan with 0 serious violations, and shows no horizontal scroll at 320 px width.
- **SC-006**: A member can turn on two-step verification and save their recovery codes in under 2 minutes.
- **SC-007**: A reset link's secret is gone from the address bar and history within one second of the page opening in 100 % of runs.
- **SC-008**: Registering an address that exists and one that does not produces visually and behaviourally identical results in 100 % of runs.

## Assumptions

- Decisions marked `[BREAKING]` / `[CONTRACT]` / `[LOCAL]` are listed one per line in `questions.md`; this spec adopts each default stated there.
- **The browser session is the S48 token handler**, not the S01 cookie delivery: the web app never calls S01 with `delivery: "cookie"`. Every browser call that needs identity goes same-origin and is authenticated by the BFF session (contract C-FWD).
- **No automatic sign-in after registration.** S01 returns the same `202` for new and existing addresses; an immediate sign-in attempt would succeed only for new addresses and so reveal membership. The visitor signs in themselves. This differs from S01's assumption "the web client does so automatically" and is recorded as a `[CONTRACT]` question.
- The registration form has no name field because the API has no display name (unknown fields are rejected, S01 AS-04); the navbar shows the e-mail local part. Role is always the default `USER`; members become sellers by opening a shop (W04).
- "Remember me" does not exist: session lifetime (24 h idle, 30 days absolute) is fixed by S48. GitHub sign-in does not exist in the backend and is removed.
- The reset link carries its token in the URL fragment (`/reset-password#token=…`), not the query string, so it never reaches server logs, `Referer` headers or analytics. S28's catalogue currently says `?token=`; this is a `[CONTRACT]` change.
- The setup key and QR code are rendered in the browser from the enrolment response; this is unavoidable for TOTP enrolment and the secret exists only in component state while the dialog is open.
- A signed-in member's pages are never shared-cacheable; nothing in W01 uses `"use cache"` for session-derived content.
- Copy is English-only; no localization layer exists.
- Google sign-in UI is specified but gated by FR-045 until C-OIDC holds; its journey is marked `fixme` in the test plan until then.
- Email delivery, link composition and templates belong to S28.

## Cross-capability contracts

Earlier specs searched (`grep -rl` for `W01` and `web` over `specs/domains`, `specs/web`; `specs/journeys` does not exist): **S01**, **S02**, **S48** name W01 and are honoured below; **S03**, **S10**, **S28** mention login, cart merge and the reset link and are covered under Requires. Differences from what an earlier spec assumed are raised as `[CONTRACT]` lines in `questions.md` (D1 automatic sign-in, D2 reset-link fragment, D3 link-flow failure redirect).

### Provides

Exact names; modules are in `packages/web`.

- **Routes** (stable URLs other capabilities link to): `/login`, `/login/mfa`, `/register`, `/forgot-password`, `/reset-password`, `/account/security?tab=two-step|sessions|methods`. Query parameters: `returnTo` (replaces the old `returnUrl`), `notice`, `error`, `linked`. `/mfa` is removed.
- **`useAuth()`** (`hooks/use-auth.tsx`, client): read-only `{ user: SessionUser | null; status: 'loading' | 'authenticated' | 'anonymous' | 'unavailable'; isAuthenticated: boolean; isLoading: boolean }`, where `SessionUser = { id: string; email: string; role: 'USER' | 'SELLER' | 'MODERATOR' | 'ADMIN' }`. It replaces the context's `login`, `register`, `verifyMfa`, `logout`, `refreshSession` members, which become separate hooks below. Consumers today: dashboard, checkout, chat, admin, assistant, discussions, seller view (W03, W04, W05, W06).
- **Mutation hooks** (`hooks/use-auth-actions.ts`): `useLogin()`, `useVerifyMfa()`, `useLogout()`, `useRefreshSession()` (role change; W04 calls it after a shop opens). Sign-in effects are exactly FR-007; sign-out effects FR-008.
- **`getServerSession(): Promise<SessionUser | null>`** and **`requireServerSession(returnTo: string): Promise<SessionUser>`** (`lib/auth/session.server.ts`, `server-only`): the second redirects anonymous visitors to `loginHref(returnTo)`. Guarantee: forwards only the session cookie; never returns tokens.
- **`safeReturnTo(raw: string | null | undefined): string`** and **`loginHref(returnTo: string): string`** (`lib/auth/return-to.ts`; replace `lib/safe-return-url.ts`). `loginHref('/checkout')` = `/login?returnTo=%2Fcheckout`.
- **`<AccountSlot />`** and its fallback **`<AccountSlotSkeleton />`** (`components/auth/account-slot.tsx`, Server Component): placed by W07's navbar inside `<Suspense fallback={<AccountSlotSkeleton />}>`. The mobile menu receives the account entries through `<MobileAccountEntries />` from the same module.
- **`lib/api/csrf.ts` → `csrfHeaders(): Record<string, string>`**: used by the shared API client for every non-`GET` request, so every other capability's mutation is CSRF-protected without extra code.
- **Error rendering** (`lib/api/errors.ts`): `problemFromError(error: unknown): Problem` with `Problem = { status: number | null; code: string | null; errors: {field: string; message: string}[]; retryAfterSeconds: number | null; requestId: string | null }`, and `<ProblemAlert problem context />` (`components/auth/problem-alert.tsx`) implementing FR-040..FR-043. Other capabilities should use them for V.3 errors.
- **`queryKeys.auth`** (`lib/query-keys.ts`): `session()`, `mfaStatus()`, `sessions()`, `identities()`, `oidcProviders()`. `queryKeys.auth.user` is removed.
- **Browser sync message**: `BroadcastChannel('auth')` with `{ type: 'signed-in' | 'signed-out' }`.
- **Playwright helpers** (`tests/helpers.ts`): `register(page, email?)` keeps its current contract (returns `{email, password}` with the page signed in on the home page) while the implementation becomes register → sign in through the UI; `login(page, email, password, returnTo?)` uses `returnTo`; new `signOut(page)`, `totp(secret)`.
- **Behavioural guarantees**: after sign-in all non-session queries are invalidated; after sign-out/expiry the query cache is empty; a `401` from any shared-client request while signed in runs the session-ended flow of AS-26 exactly once (toast with a **Sign in** action to `/login?returnTo=…&notice=session_expired`; guarded pages redirect themselves).

### Requires

- **S48 (BFF)** — exact shapes assumed:
  - `POST /api/bff/session` `{email, password}` → `200 {user: {id, email, role}, expiresAt}` or `200 {mfaRequired: true}`; `POST /api/bff/session/mfa` `{code}` (TOTP or recovery code) → `200 {user, expiresAt}`; `GET /api/bff/session` → `200 {user, expiresAt}` or `401 unauthenticated|session_expired`; `POST /api/bff/session/logout` → `204`. Cookies `__Host-bff-session` (HttpOnly), `__Host-bff-csrf` (readable), `__Host-bff-mfa`; header `X-CSRF-Token`. Problem codes `invalid_credentials`, `origin_not_allowed`, `csrf_invalid`, `mfa_not_pending`, `session_expired`, `unauthenticated`, `session_unavailable`, `rate_limited` (+ `Retry-After`), relayed `invalid_mfa_code`, `invalid_mfa_challenge`, `invalid_token`.
  - **C-FWD (new)**: authenticated forwarding. Every same-origin `/api/*` request from a browser holding a BFF session (cart, checkout, orders, `/api/auth/sessions`, `/api/auth/logout-all`, `/api/auth/mfa/*`, `/api/auth/identities`, `/api/auth/oidc/*/link/start`, chat, assistant streams, GraphQL) reaches the owning API with `Authorization: Bearer <session access token>` attached server-side, `Cookie` stripped, CSRF and origin checks on non-`GET`, status and problem+json passed through unchanged. Owner S48.
  - **C-REFRESH (new)**: `POST /api/bff/session/refresh` (CSRF) → `200 {user, expiresAt}` re-issuing the identity token so a changed role shows. Owner S48.
  - **C-OIDC (new)**: after a successful Google callback or Google + second step, `GET /api/bff/session` answers `200` for that browser (S48 resolves the S02 cookie session, or S02's callback creates the BFF session), and the second step of a federated sign-in is completed by `POST /api/bff/session/mfa`. Owners S48 + S02.
- **S01**: `POST /api/auth/register` `{email, password}` → `202 {status: "accepted"}`; `POST /api/auth/password-reset/request` `{email}` → `202`; `POST /api/auth/password-reset/confirm` `{token, password}` → `204` | `400 invalid_reset_token` | `422 weak_password`; `GET /api/auth/sessions` → `{sessionId, device, ip, createdAt, lastUsedAt, current}[]`; `DELETE /api/auth/sessions/:sessionId` → `204` | `404 session_not_found`; `POST /api/auth/logout-all` → `200 {revokedSessions}`. Problem body: `type, title, status, detail, instance, requestId, code`, and for `validation_failed` a list `errors: {field: string, message: string}[]` (`[CONTRACT]` Q: shape). `Retry-After` on `429`/`503`.
- **S02**: `GET /api/auth/mfa` → `{state, enabledAt?, recoveryCodesRemaining?}`; `POST /api/auth/mfa/enroll` → `{otpauthUri, manualEntryKey}`; `POST /api/auth/mfa/confirm {code}` → `{recoveryCodes: string[10]}`; `POST /api/auth/mfa/recovery-codes/regenerate {code}` → same; `POST /api/auth/mfa/disable {code}` → `204`; `GET /api/auth/oidc/providers` → `{id, displayName}[]`; `POST /api/auth/oidc/google/start {returnTo?}` and `…/link/start {returnTo?, code?}` → `{authorizationUrl}`; `GET /api/auth/identities` → `{id, provider, email | null, linkedAt}[]`; `DELETE /api/auth/identities/:identityId` → `204` | `404 identity_not_found` | `409 last_login_method`. Callback redirects to `/login?error=<code>`, `/login/mfa?returnTo=…`, `<returnTo>`, `<returnTo>?linked=google`. Codes: `invalid_code`, `invalid_mfa_code`, `mfa_already_enabled`, `mfa_not_pending`, `mfa_not_enabled`.
- **S10 / W03**: `mergeGuestCart(): Promise<void>` in `lib/api/cart.ts` (exists), idempotent and race-safe (S10 AS-06); W01 calls it once per sign-in, ignores failure.
- **S28**: the reset e-mail links to `<front>/reset-password#token=<resetToken>` (differs from S28's catalogue `?token=`; `[CONTRACT]`). In the development stack, a way for tests to read the sent link (`[CONTRACT]` on test tooling).
- **S54 / `packages/contracts`**: zod schemas `problemSchema`, `sessionLoginRequestSchema`, `sessionMfaRequestSchema`, `sessionResponseSchema`, `mfaRequiredResponseSchema`, `registerRequestSchema`, `passwordResetRequestSchema`, `passwordResetConfirmSchema`, `mfaStatusSchema`, `mfaEnrollSchema`, `mfaRecoveryCodesSchema`, `sessionListItemSchema`, `federatedIdentitySchema`, `oidcProviderSchema`, `oidcStartSchema`. `packages/contracts` has no source today (gap).
- **W07**: navbar frame embeds `<AccountSlot/>` and `<MobileAccountEntries/>`; per-route header `Referrer-Policy: no-referrer` for `/reset-password` in `next.config.ts`; `/account` → `/account/security` redirect.
- **W03, W04, W05, W06**: adopt `returnTo`, `useAuth()` (read-only), `loginHref`, and `requireServerSession` for their guards; replace direct token use.

## Pattern coverage (pattern-map rows whose Specs column names W01)

| Pattern | Requirements | Scenarios |
|---|---|---|
| P0504 CSRF (double-submit / SameSite / Origin) for cookie-authenticated mutations | FR-003, FR-006, FR-029 | AS-11, AS-24, AS-25, AS-28, AS-31 |
| P0512 Token storage in the browser (BFF holds tokens, HttpOnly cookie) | FR-001, FR-002, FR-004, FR-005, FR-007, FR-008 | AS-06, AS-21, AS-26, AS-29, AS-30, AS-31 |
| P0903 Next.js App Router: RSC, Server Actions, caching layers, authorization not only in middleware | FR-005, FR-006, FR-009, FR-024 | AS-18, AS-27, AS-62, AS-63, AS-64, AS-65 |
