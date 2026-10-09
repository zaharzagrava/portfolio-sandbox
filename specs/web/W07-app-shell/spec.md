# Feature Specification: W07 — App shell and cross-cutting UI: navbar, footer, legal pages, developer docs, error / not-found / loading states, responsive layout, accessibility, CSP and security headers (`packages/web`)

**Capability**: W07 · **Area**: web (`packages/web`, Next.js 16, App Router, Cache Components on) · **Spec directory**: `specs/web/W07-app-shell`

**Feature Branch**: `W07-app-shell` (spec directory only; no branch was created)

**Created**: 2026-10-07

**Status**: Draft

**Input**: "App shell and cross-cutting UI: navbar, footer, legal pages, developer docs, error/not-found/loading states, responsive layout, accessibility, CSP and security headers". Sources: constitution V, VI, VII.7; `packages/web/AGENTS.md` and the Next.js guides *Content Security Policy*, *Proxy*, `error.js`, `not-found.js`, `loading.js`, *Streaming*, *Production checklist*; `docs/architecture/pattern-map.md` rows P0502, P0902, P0903; notes 09/03 and 05/01; the web specs W01–W06 and domain specs S39, S42, S44, S48 that name W07.

Companion files: [`questions.md`](questions.md) (decisions taken unattended, tagged), [`test-plan.md`](test-plan.md) (one row per scenario), [`gaps.md`](gaps.md) (what today's code lacks, missing backend endpoints, test tooling), [`checklists/requirements.md`](checklists/requirements.md).

## Scope

In scope:

- **The persistent frame** every page sits in: header (logo, search, navigation, assistant launcher, theme control, cart, notifications, account slot), mobile menu, footer, **skip link**, the single `<main>` landmark, the toast area, the offline notice.
- **Legal pages**: `/privacy`, `/terms`.
- **Developer documentation**: `/developers/docs` (the public API reference).
- **System states**: not-found, unexpected error, root-layout error, loading, access denied, offline, and the shared way a failed API call (RFC 9457 problem body) is shown when a page has no better place for it.
- **Responsive layout and accessibility baseline** every page must meet (the rules W01–W06 pages inherit).
- **Security headers and Content Security Policy** of every response of the web app, the `Referrer-Policy` exceptions, caching rules for private pages, CSP violation reporting.
- **Cross-cutting runtime rules** of the shell: document metadata, `page_view` analytics, server-state defaults (query client), same-origin and no-token rules that belong to the shell, `/health`.
- **Delivery of the widget checkout application** (the bundle that runs inside the storefront-widget iframe) and the iframe side of its `postMessage` contract (S44).

Out of scope (owned elsewhere):

- The **account slot** and **account entries of the mobile menu** (sign-in state, account menu, sign-out, session-ended flow, `<ProblemAlert />`, copy catalogue): **W01**. W07 places them.
- The **search box** and autocomplete: **W02** (W07 mounts `<SearchBox variant="navbar" />`). The **cart** and cart badge, **notification bell**: **W03**. The **assistant launcher and sheet**, **chat unread badge**: **W05**. The **Admin entry** rule (`isAdmin`): **W06**. W04 owns the seller screens and `/invites/{token}`.
- What any backend guarantees (rate limits, problem codes, public API contract, widget tokens): the owning domain specs (S42, S44, S48, S54). This spec cites their IDs and specifies only how the UI shows and handles the outcome.
- The screens inside the widget iframe beyond identification (cart, address, payment): not built; a later revision of S10/S44 and a later web capability.
- Internationalisation (the app is English only), a cookie-consent banner (none exists: nothing in the app needs consent, see FR-062), PWA/offline mode, server-side rendering of OpenAPI try-it-out calls, sitemap.

## Routes and visible states

| Route / element | Who can open it | Visible states |
|---|---|---|
| Frame (every page) | everyone | header and footer always present; account slot per W01; offline notice; toasts |
| `/privacy`, `/terms` | everyone | loaded (static text) |
| `/developers/docs` | everyone (no sign-in) | loading · loaded · reference unavailable with retry |
| Any unmatched URL, or a page that reports "not found" | everyone | not-found page (HTTP 404) |
| Any page whose rendering throws | everyone | error state inside the frame · root-layout error page (own document) |
| Any route while its content streams in | everyone | loading placeholder inside `<main>`, frame stays |
| Access-denied state (a page answered `403`) | signed in | "You don't have access" state inside the frame |
| `/health` | infrastructure | `200 {"status":"ok"}`; not a page |
| `/widget/v1/app.js` (configurable URL) | any host page's iframe document | the widget checkout bundle |
| `/robots.txt` | crawlers | rules of FR-052 |

**URL view state** (constitution VI.4): the shell owns none. It never reads or writes a query parameter except to compute the analytics page name (which drops every parameter, FR-060). Unknown paths are never echoed back into the page.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — The same trustworthy frame on every page (Priority: P1)

Every page has the same header, footer and landmarks, usable by mouse, touch, keyboard and screen reader, on a phone and on a desktop. Slots owned by other capabilities (account, search, cart, notifications, assistant) appear in a fixed order and never shift the layout while they load.

**Why this priority**: the frame is on every screen of every capability; if it is wrong, everything is.

**Independent Test**: open `/` at 390 px and at 1280 px, anonymous and signed in; walk the header and footer with the keyboard.

**Acceptance Scenarios**:

1. **AS-01 (desktop header)** — **Given** any page at ≥ 1024 px, **Then** the header (a `banner` landmark, sticky at the top) shows, left to right: logo link named "Marketplace home" (to `/`); a `navigation` named "Main" with **Browse** (to `/search`) and **Developers** (to `/developers/docs`); the navbar search box (W02 rule: absent on `/` and `/search`, where the page has its own box); then the right-hand group in this order: **AI Assistant** launcher, theme control, cart link, notifications bell (signed-in members only), the account slot. No hamburger button exists at this width. A page scrolled down keeps the header visible; content hidden behind it never hides a focused element (the focused element is scrolled into view below the header).
2. **AS-02 (mobile header and menu)** — **Given** any page at ≤ 640 px, **Then** the header shows the hamburger button named "Open menu" (expanded state announced), the logo link, and the icons for search (not on `/` and `/search`), theme, cart and, for members, notifications; no horizontal scroll at 320 px. **When** the hamburger is activated, **Then** a modal sheet titled "Menu" slides in from the left (focus moves into it, Tab stays inside, the page behind is inert, Escape or the close button closes it and returns focus to the hamburger) containing, in this order: the account entries (`<MobileAccountEntries />`, W01: **Log in** and **Sign up** for visitors, the labelled "Account" group for members), then a `navigation` named "Main": **Browse**, **Cart** (with its count), **Chats** (members, with the unread count when W05 supplies one), **Developers**, **AI Assistant** (`<AssistantLauncher variant="menu-item" />`). The **Admin** entry is part of the account group, not of this list (AS-05). Choosing a link or **AI Assistant** closes the sheet; navigating by any other means (Back) closes it too. Between 641 and 1023 px the same compact structure applies.
3. **AS-03 (search in the header)** — **Given** a page other than `/` and `/search`, **Then** at ≥ 1024 px the header holds the navbar search box (W02 `<SearchBox variant="navbar" />`; its behaviour is W02's); at ≤ 640 px a button named "Search" replaces it. **When** that button is activated, **Then** a full-width search row (the same box) opens under the header and the box's input receives focus; **Escape**, the **Close search** button, or choosing a result closes the row and returns focus to the button. On `/` and `/search` the button does not exist. The shell advertises no keyboard shortcut it does not implement.
4. **AS-04 (slots and their states)** — **Given** the header, **Then** each slot owned by another capability is mounted as follows and renders nothing it cannot back: the cart link is always present (accessible name "Cart" or "Cart, {n} items" from W03's `<CartBadge />`; no badge while the count is unknown); the notifications bell and the chat unread badge render only for a signed-in member and make no request for a visitor; the assistant launcher renders for everyone (its sheet explains sign-in for visitors, W05); the account slot is W01's component inside a boundary whose fallback has the account button's exact size. **Given** any of these is loading or fails, **Then** no other part of the header moves, resizes or disappears (no layout shift attributable to the shell) and a slot that fails renders nothing in its place rather than breaking the header.
5. **AS-05 (the Admin entry)** — **Given** a signed-in member whose role is `ADMIN`, **Then** the account menu (and, at ≤ 640 px, the account group of the sheet) also lists **Admin** (to `/admin`) after **Account & security**; for every other role it is absent. This is presentation only; authorization is enforced by W06. (W06 AS-66.)
6. **AS-06 (theme control)** — **Given** a first visit, **Then** the colour scheme follows the operating system's preference and the page is painted in it from the first frame (no flash of the other scheme, no script blocked by the CSP). **When** the visitor opens the control (button named "Theme", menu items **Light**, **Dark**, **System**, the current choice marked as checked), **Then** choosing an item applies it at once to the whole page and persists across reloads and tabs of the browser (this preference is the only thing the shell stores in the browser, and it is not a credential). The error, not-found and root-error pages follow the same scheme (the root-error page follows the operating system's preference when the saved one cannot be read).
7. **AS-07 (skip link, landmarks and focus on navigation)** — **Given** any page, **Then** the first focusable element is a link **Skip to main content**, visually hidden until focused, that moves focus to the page's single `<main id="main-content">`; the page has exactly one `banner`, one `main`, one `contentinfo`, and every `navigation` is labelled ("Main", "Footer", and the others of their capabilities); pages of other capabilities add no second `main`. **When** the visitor follows an in-app link (client-side navigation), **Then** focus moves to the new page's `h1` (or to `<main>` when the page has none) and the new page title is announced; on the first load nothing is focused. (W02 FR-186.)
8. **AS-08 (footer)** — **Given** any page, **Then** the footer (`contentinfo`) shows: the sentence "Marketplace is a portfolio project: no real goods are sold and no real payments are taken."; a `navigation` named "Footer" with **Browse** (to `/search`), **API docs** (to `/developers/docs`), **Terms** (to `/terms`), **Privacy** (to `/privacy`) and, when a source-code address is configured, **Source code** (opens in a new tab, `rel="noopener noreferrer"`, announced as opening a new tab); and "© {current year} Marketplace". At ≥ 1024 px the text is left and the links right on one row; at ≤ 640 px they stack, each link is a ≥ 44 px target, nothing is cut off. The footer is at the bottom of the viewport even on a short page and never overlaps content.

### User Story 2 — When something is missing, slow or broken, I know what happened and what to do (Priority: P1)

An unknown address, a failed page, a slow page, a missing permission, a lost connection: each has one clear screen or notice, keeps the header and footer, never shows technical detail, and always offers a way forward.

**Why this priority**: every capability depends on these states; a blank page or a stack trace is the worst possible answer.

**Independent Test**: open an unknown URL; force a page to throw; throttle the network; open a page while offline.

**Acceptance Scenarios**:

1. **AS-09 (not found)** — **Given** a URL that matches no page, or a page that reports its resource does not exist, **Then** the response status is `404`, the frame stays, and `<main>` shows the heading "Page not found", the text "We couldn't find the page you were looking for. It may have moved, or the address may be wrong.", a primary link **Go to home** (to `/`) and a link **Browse products** (to `/search`); the document title is "Page not found · Marketplace"; the page is excluded from search engines (`noindex`); the visited path is never shown in the page. A capability may supply its own not-found copy (W02's product not-found) by using the shared `<NotFoundState title description actions />`; the structure above is the default.
2. **AS-10 (unexpected error in a page)** — **Given** a page whose rendering or a client island throws, **Then** the failure is contained to `<main>`: the header and footer stay usable; `<main>` shows the heading "Something went wrong", the text "We hit an unexpected problem. Try again, and if it keeps happening come back in a few minutes.", the line "Reference: {reference}" (selectable) when the failure carries a reference (the server error digest, or the problem `requestId`), a button **Try again** and a link **Go to home**. **When** **Try again** is activated, **Then** the segment re-renders and, if it now succeeds, the error state is replaced by the page without a full reload; if it fails again the same state returns and focus moves to its heading again. No error message, stack, SQL, URL, or upstream text is rendered (V.3); focus moves to the heading when the state appears; the state is announced (`role="alert"` on the heading region).
3. **AS-11 (root-layout failure)** — **Given** the root layout itself fails, **Then** a self-contained document replaces the page (its own `<html lang="en">` and `<body>`, no dependence on the failing providers): heading "Something went wrong", the same text as AS-10, **Try again** and **Go to home**, readable in the operating system's colour scheme, and meeting the same accessibility rules (one `h1`, focus on the heading, 44 px targets at ≤ 640 px). The CSP still applies to it.
4. **AS-12 (loading)** — **Given** a route whose content is still being produced, **Then** the header and footer are already on screen and `<main>` shows a placeholder shaped like the page (`aria-busy="true"`; a single visually hidden "Loading…" in a `role="status"` region, announced once); pages with a more specific placeholder (W02's product page) use theirs; a placeholder is replaced in place without moving the header or footer; no placeholder is shown for work that finishes within 150 ms (no flash). A section of a page that loads on its own (account slot, cart count, lists) shows its own same-size placeholder, never a page-wide one.
5. **AS-13 (a failed call, shown consistently)** — **Given** a screen that has no dedicated place for a failure, **When** an API call answers with a problem body, **Then** it is shown with the shared `<ErrorState problem />`, whose text comes only from the status and the stable `code` (never from `title`/`detail`, W01 FR-040): `401` → W01's session-ended flow (not rendered here); `403` → the **access denied** state: heading "You don't have access", text "Your account can't open this page. If you think this is a mistake, contact the shop owner or an administrator.", link **Go to home**; `404` → the not-found state of AS-09; `409` → "This changed while you were looking at it. Reload and try again." with **Reload**; `422` and other `4xx` → W01's 4xx fallback "Something didn't work. Check the details and try again."; `429` → "Too many requests. Try again in {wait}." (wait text exactly W01 FR-041; the controls it disables are re-enabled by a timer, no reload); `502`, `503` → "This part of the marketplace is temporarily unavailable. Try again in a moment." with **Try again** and the reference line; any other `5xx`, a network failure or a non-problem body → the text of AS-10 and the reference line when a `requestId` exists. Backend rules behind each status: S54 (problem body), S50 (`429`), S48 AS-56 / AS-61 (`503 session_unavailable`).
6. **AS-14 (offline)** — **Given** the browser reports it is offline, **Then** a notice bar (`role="status"`) under the header reads "You're offline. Some things may not load or save until you're back online." and does not push the header; **When** the connection returns, **Then** the bar changes to "Back online." for 3 seconds and is removed, and the data already on screen that failed to load is refetched (server data is refetched on reconnect by the query client, FR-065) without a reload. Live-connection "reconnecting" states belong to W03/W05.
7. **AS-15 (toasts)** — **Given** any capability shows a toast, **Then** there is one toast area for the whole app (bottom-centre at ≤ 640 px, bottom-right at ≥ 1024 px, never covering the skip link, the mobile menu close button or the footer links when scrolled to the end), at most 3 visible at a time, announced politely (`status`) — errors assertively (`alert`) — success and info toasts disappear after 5 seconds and pause while hovered or focused, error toasts and any toast with an action stay until dismissed, every toast has a **Dismiss** button, and the toast text is plain text (never markup).

### User Story 3 — The browser is locked down without breaking the product (Priority: P1)

Every response of the web app carries a strict Content Security Policy with a fresh per-response nonce and the other security headers, private pages are never cached, and the app still works completely under that policy.

**Why this priority**: constitution VI.2/VI.7, patterns P0502 and P0903; a CSP that breaks pages gets switched off, one that is loose is decoration.

**Independent Test**: request pages and read headers; run the main journeys listening for CSP violations.

**Acceptance Scenarios**:

1. **AS-16 (the policy)** — **Given** any response that is an HTML document — pages, the not-found page, the error page, redirects' targets — **Then** it carries a `Content-Security-Policy` header with: a nonce of at least 128 bits of randomness, different on every response; `default-src 'self'`; `script-src 'self' 'nonce-<N>' 'strict-dynamic'` (plus `'unsafe-eval'` in development only; never `'unsafe-inline'` or a host wildcard in production); `style-src 'self' 'nonce-<N>'` with inline style attributes allowed through `style-src-attr 'unsafe-inline'` (the only inline allowance, accepted because styles cannot run code); `font-src 'self'`; `img-src 'self' data: blob:` plus the configured media delivery host(s); `media-src 'self' blob:` plus the configured video delivery host(s); `connect-src 'self'` (this origin including its WebSocket scheme; no other origin); `frame-src 'none'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'`; `upgrade-insecure-requests` (production); `report-to`/`report-uri` as in AS-21. The nonce reaches every script and style element the framework and the shell emit, including the theme bootstrap.
2. **AS-17 (the product works under the policy)** — **Given** the production build, **When** the main journeys run (browse, product page, search, sign-in, cart, toasts, theme switch, the developer docs viewer, an error page), **Then** the browser reports zero CSP violations.
3. **AS-18 (per-path additions)** — **Given** configuration of a map tile host, **Then** it appears in `img-src` (and `connect-src` only if the map needs it, never as a wildcard) on the pages that show a map; **Given** `/checkout/pay/*`, **Then** and only then the payment provider's script, frame and connect hosts (from configuration) are added to `script-src` (with the nonce kept), `frame-src` and `connect-src`; on every other path those hosts are absent and `frame-src` is `'none'`. Every added host is an exact `https://host` from configuration, never a wildcard.
4. **AS-19 (other headers)** — **Given** any response, **Then** it carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (in addition to `frame-ancestors 'none'`), `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denying camera, microphone and payment and allowing geolocation only for this origin, `Cross-Origin-Opener-Policy: same-origin-allow-popups`, and in production `Strict-Transport-Security: max-age=63072000; includeSubDomains`; it carries no `X-Powered-By`. **Given** `/reset-password` and every path under `/invites/`, **Then** the effective `Referrer-Policy` is exactly `no-referrer` (one value, not the default). (W01 AS-64, W04 AS-82.)
5. **AS-20 (private pages are not cached)** — **Given** a response for a signed-in area (`/dashboard/**`, `/account/**`, `/checkout/**`, `/cart`, `/chat`, `/admin/**`, `/invites/**`), **Then** it carries `Cache-Control: no-store`, so that after sign-out the Back button and shared caches show nothing private; public pages (`/`, `/search`, `/products/**`, legal pages, docs) carry no `no-store`. (W01 AS-24 proves the sign-out flow.)
6. **AS-21 (violation reports)** — **Given** the policy, **When** the browser blocks something, **Then** it sends a report to the same-origin endpoint `/api/csp-reports` (the endpoint answers `204`, never an error the page can see), so a regression is visible to operators; the page itself shows nothing. The policy is enforced from the first release (not report-only).
7. **AS-22 (images only from known hosts)** — **Given** the app's image component, **Then** it optimises only images from the exact hosts of the same configuration that feeds `img-src` (no `*.amazonaws.com`-style wildcard, no placeholder service in production); an image from any other host is not rendered through the optimiser and not allowed by the policy.

### User Story 4 — Terms and privacy that say what the product actually does (Priority: P2)

A visitor can read, on any device, what data the marketplace keeps, which cookies it sets, and the rules of using a portfolio sandbox.

**Why this priority**: linked from every footer and from registration; wrong claims are worse than none, but the pages are static.

**Independent Test**: open `/privacy` and `/terms` from the footer at both widths.

**Acceptance Scenarios**:

1. **AS-23 (privacy policy)** — **Given** `/privacy`, **Then** the page has one `h1` "Privacy policy", "Last updated: {date}" and sections (each an `h2` with an anchor id): *What we store* (email address, password hash, sessions with device and network address, carts, orders, shops, products, content you post: discussions, chat messages, photos and videos), *Cookies and browser storage* (the session cookie: HttpOnly, used only to keep you signed in; the CSRF cookie: readable by the page, not a credential; the anonymous visitor id: first party, one year, used only for the marketplace's own analytics and not set when your browser sends Global Privacy Control or Do Not Track; the theme preference in local storage; no advertising or third-party tracking cookies), *Who receives data* (the payment provider in the sandbox, the map tile host when configured, nobody else; no sale of data), *Your choices* (sign out on all devices from account security; deleting data: "Accounts and content in this showcase may be deleted at any time; ask via the address below"), *Contact*. No claim in it is false for the running system; the text is reviewed whenever a capability adds a cookie or a recipient (FR-053).
2. **AS-24 (terms of service)** — **Given** `/terms`, **Then** one `h1` "Terms of service", "Last updated: {date}", sections: *What this is* (a portfolio project demonstrating system-design patterns; no real goods sold, no real payments), *Accounts* (you are responsible for your credentials; accounts, orders and content may be deleted at any time), *Acceptable use* (no abuse, scraping at harmful rates, probing other people's data; rate limits apply), *The API* (sellers' keys are personal, used within their scopes), *No warranty*, *Changes*, *Contact*.
3. **AS-25 (layout and navigation of legal pages)** — **Given** a legal page at ≥ 1024 px, **Then** the text column is at most 48 rem wide with a sticky "On this page" `navigation` (labelled) on the right listing the section links; at ≤ 640 px the column is full width with a 16 px gutter and "On this page" is a collapsed disclosure above the text. **When** a section link is activated, **Then** focus and scroll go to that section's heading (and the address gets its anchor). The pages render without scripts, are reachable from the footer on every page, and from the sign-up form (W01).
4. **AS-26 (document metadata of legal pages)** — **Given** the two pages, **Then** titles are "Privacy policy · Marketplace" and "Terms of service · Marketplace" and they are indexable.

### User Story 5 — Developers can read the API reference (Priority: P2)

Anyone can open the API documentation without signing in, browse operations by group, and read how authentication, errors and deprecations work. It is a reference, not a console: nothing on the page sends requests to the API on the reader's behalf.

**Why this priority**: it is the public face of the developer platform (S42), but it is read-only content.

**Independent Test**: open `/developers/docs` with the API available, slow, and unavailable.

**Acceptance Scenarios**:

1. **AS-27 (the reference)** — **Given** the API description is available, **Then** `/developers/docs` shows, inside the common frame (no second header or `main`), the `h1` "API documentation"; an introduction (what the API is, that it is key-authenticated with a seller API key created under **Developers → API keys** in the seller dashboard, with a link to `/dashboard/seller`, and that versions are announced); **Authentication**, **Errors** (the problem body fields `type`, `title`, `status`, `detail`, `instance`, `requestId`, `code`, `errors`; `Retry-After` on `429`/`503`; a link to RFC 9457) and **Deprecation** (the `Deprecation` and `Sunset` headers and what they mean) sections; then the operations grouped by tag, each showing method, path, summary, parameters, request and response shapes, response codes, required scope, and a deprecated mark with sunset and replacement when the description says so (S42 AS-36, AS-67). Each operation can be expanded and collapsed; group links form a labelled "Operations" navigation.
2. **AS-28 (loading and unavailable)** — **Given** the description is being fetched, **Then** the page shows the heading and a same-shape placeholder for the reference (`aria-busy`), not a blank area; **Given** it cannot be fetched or is not a valid description (`5xx`, network failure, invalid body), **Then** the heading stays and the reference area shows "The API reference is temporarily unavailable." with **Try again** (refetches and replaces the area in place) and the reference line when a `requestId` exists; the rest of the page (introduction, authentication, errors, deprecation text) stays readable because it is static.
3. **AS-29 (read-only)** — **Given** the reference, **Then** it has no "Try it out" control, no form that sends a request to an API operation, and the page makes exactly one data request (the description, same origin); examples are copyable text blocks with a **Copy** button (announces "Copied").
4. **AS-30 (layout and accessibility)** — **Given** the page at ≥ 1024 px, **Then** a sticky "Operations" navigation (group list) sits left of the reference column; at ≤ 640 px it becomes a collapsed disclosure above the reference; code blocks and wide tables scroll horizontally inside their own box and never make the page scroll sideways; everything is operable by keyboard (expanders are buttons with `aria-expanded`), headings are nested without gaps, and the documentation viewer's code is loaded only on this page (no other page downloads it).

### User Story 6 — Every page is usable by everyone, on every device (Priority: P2)

The baseline that all capabilities inherit: reflow, touch targets, keyboard, screen reader, contrast, motion, titles, indexing.

**Why this priority**: W01–W06 cite it; a regression anywhere breaks the promise everywhere.

**Independent Test**: automated accessibility scan and keyboard walk of the frame and W07 pages at 320, 390, 1280 px; 200 % zoom.

**Acceptance Scenarios**:

1. **AS-31 (reflow and targets)** — **Given** any W07 page and the frame at widths from 320 px, **Then** there is no horizontal page scroll (320 px wide, 200 % zoom, and with text enlarged), no content is cut off, interactive targets in the header, sheet and footer are at least 44 × 44 px at ≤ 640 px, and long text (e-mail addresses in the menu) wraps or truncates with the full value available to assistive technology.
2. **AS-32 (keyboard and screen reader)** — **Given** the frame, **Then** the tab order is: skip link → logo → main navigation → search → assistant → theme → cart → notifications → account → page content → footer links; every control has a visible focus ring with enough contrast in both schemes; no keyboard trap (menus, popovers, sheets and the search row close with Escape and return focus to their trigger); icon-only controls have accessible names ("Open menu", "Search", "Theme", "Cart", "Notifications"); decorative icons are hidden from assistive technology; state is exposed (`aria-expanded`, `aria-current="page"` on the active **Browse** link, checked theme item); an automated scan of the frame and each W07 page finds no serious or critical violation in either colour scheme.
3. **AS-33 (contrast and motion)** — **Given** both colour schemes, **Then** text has at least 4.5 : 1 contrast (large text and UI boundaries 3 : 1), colour is never the only carrier of meaning (the offline bar, errors and the deprecated mark also carry text or an icon with a name), **Given** `prefers-reduced-motion: reduce`, **Then** sliding sheets, theme-icon rotation, toast and skeleton animations are replaced by instant changes.
4. **AS-34 (document metadata)** — **Given** any page, **Then** the document has `lang="en"`, a responsive viewport, a distinct title in the form "{Page} · Marketplace" (the home page "Marketplace"), a description, absolute canonical and social-preview URLs resolved against the configured public site address, and a favicon. `/robots.txt` allows public pages and disallows `/api/`, `/dashboard/`, `/account/`, `/admin/`, `/checkout/`, `/cart`, `/chat` and `/invites/`; those areas also send `noindex`.

### User Story 7 — Cross-cutting data rules are honoured by the shell (Priority: P2)

Page views are counted without leaking identifiers, server data is fetched sensibly, and nothing in the shell creates a second source of truth.

**Why this priority**: constitution VI.3/VI.4 and P0902/P0903 apply to the shell itself.

**Independent Test**: navigate between pages and inspect the events sent; break the API and watch retries.

**Acceptance Scenarios**:

1. **AS-35 (page views)** — **Given** any navigation, first load or in-app, **Then** exactly one `page_view` is emitted through W02's `track()` with `page` set to the **route template**, not the address: `/products/:slug`, `/invites/:token`, `/checkout/pay/:orderId`, `/search`, `/reset-password`; query strings and fragments are always dropped; an unmatched URL is reported as `/not-found`, a root error as `/error`; nothing is emitted when W02's privacy rule says tracking is off (Global Privacy Control, Do Not Track). (S39 FR-001, `page` ≤ 500 characters; W04 AS-82.)
2. **AS-36 (server data defaults)** — **Given** the browser's query client, **Then** it is created once per browser tab and per request on the server (never a module-level instance shared between users), queries default to `staleTime` 60 s, no refetch on window focus except where a capability opts in, and refetch on reconnect; failed queries retry at most twice with exponential backoff for network errors and `5xx`, and never for `400`, `401`, `403`, `404`, `409`, `422`; mutations never retry automatically. Every key comes from `lib/query-keys.ts`; keys are arrays beginning with the capability's domain name.
3. **AS-37 (same origin, no token in the shell)** — **Given** the shell's own code, **Then** it makes no request to any other origin, holds no access or refresh token in memory, storage, URL or DOM, writes no cookie, and every browser request it triggers (the page-view batch, the CSP report, the documentation description) is relative to the site's origin. (W01 AS-29, AS-30; the shell inherits them and adds nothing.)
4. **AS-38 (server components first)** — **Given** the shell source, **Then** the root layout, the footer, the legal pages and the developer-docs page are Server Components; `"use client"` appears only on the leaf components that need state, effects or browser APIs (mobile menu, theme control, search row, offline notice, route focus, error states, documentation viewer); a client component receives only the fields it renders. Lists in the shell use stable ids as keys; the header re-renders no more than the one slot whose data changed (a cart change never re-renders the account slot or the menu).

### User Story 8 — The storefront widget's checkout application (Priority: P3)

The embeddable widget (S44) opens an iframe whose checkout application is served by this web app. It talks to the host page only through the agreed messages, and only to that page.

**Why this priority**: S44 depends on it, but the screens beyond identification are not built yet.

**Independent Test**: load the application bundle in a test host page; send and receive the messages.

**Acceptance Scenarios**:

1. **AS-39 (the bundle)** — **Given** the configured bundle address (HTTPS, from `WIDGET_APP_BUNDLE_URL`; by default `/widget/v1/app.js` on the web origin), **Then** a `GET` returns the checkout application script with `Content-Type: application/javascript`, a long-lived immutable cache for a versioned name, `Cross-Origin-Resource-Policy: cross-origin` (so the backend's embed document can load it), `nosniff`; it is the only web-app response meant to be loaded by another origin. The web app's own pages stay under `frame-ancestors 'none'` (AS-16).
2. **AS-40 (messages with the host page)** — **Given** the application running inside the embed document, **When** it needs the customer's identity, **Then** it posts `marketplace:need-identity` to the host page (the iframe's parent, with that parent's origin as target, never `"*"`) and accepts `marketplace:identity {token}` only when the message's source is the parent window and its origin equals the registered host origin the embed document was opened for; messages from any other source or origin, and malformed ones, are ignored silently. **When** the visitor presses **Close** (or Escape), **Then** it posts `marketplace:close` to the host page. States shown: "Checking your details…" (waiting for identity, `aria-busy`), "Signed in as {email}" when recognised (via S44 `identify`), "Continue as guest" when the host page gives no identity, and "We couldn't open checkout. Close this window and try again." when identification fails (S44 `422/410/403/404` all map to this one text); the visitor's e-mail is shown only as text. The screens after identification (cart, address, payment) are not part of this release.

### User Story 9 — Operators can tell the web app is alive (Priority: P3)

**Why this priority**: required for rolling deployments; no user-facing screen.

**Acceptance Scenarios**:

1. **AS-41 (liveness)** — **Given** the running web app, **When** `GET /health` is requested, **Then** it answers `200 {"status":"ok"}` with `Cache-Control: no-store`, without calling any backend, without a session, and without the nonce policy (it is not a document).

### Edge Cases

Each is covered by the scenario shown; none is left to implementation judgement.

- Unknown or hostile path (`/<script>`, very long, encoded) → AS-09 (path never echoed). Page reports not found → AS-09.
- A client island throws after hydration; error then recovers on retry → AS-10. Layout failure → AS-11. Failure while offline → AS-14 + AS-10.
- Slow page, slow slot, instant page → AS-12. A slot that fails to load → AS-04.
- `403` from an API call → AS-13. `401` → W01 (AS-26 there). `404` hiding existence → AS-13/AS-09. `409`, `429`, `502/503`, `5xx`, non-problem body, network failure → AS-13.
- Toast flood; toast with markup in its text; error toast auto-dismiss → AS-15.
- First paint colour scheme; scheme unreadable in a failed layout → AS-06, AS-11.
- Mobile menu open while navigating Back; open at a resized desktop width → AS-02. Search row open while route changes → AS-03.
- Header covering a focused element; focus after in-app navigation; first load focus → AS-01, AS-07.
- Visitor on `/` and `/search` (no duplicate search box) → AS-03. Admin-only entry for others → AS-05. Visitor makes no notification or chat request → AS-04.
- Nonce reuse between responses; error and not-found documents without a policy; payment hosts leaking to other pages; wildcard host in configuration → AS-16, AS-18, AS-22.
- Private page restored from the Back/forward cache after sign-out → AS-20. Reset link and invitation token leaking through `Referer` → AS-19, AS-35.
- Image from an unlisted host → AS-22.
- Docs description missing, slow, invalid; description with a deprecated route; wide tables and code at 320 px → AS-28, AS-27, AS-30.
- Legal text out of date with the cookies actually set → FR-053 (review rule), AS-23.
- Page-view address carrying an id, token or query → AS-35.
- Widget identity message from the wrong window or origin; wildcard target origin → AS-40.
- Zoom 200 %, 320 px, reduced motion, forced dark scheme → AS-31, AS-33.

## Requirements *(mandatory)*

### Functional Requirements

**Frame and navigation**

- **FR-001**: The root layout renders, in order: the skip link, the header, `<main id="main-content" tabIndex={-1}>` holding the page, the footer, the toast area and the offline notice region. It contains exactly one `main`; no capability's page or layout renders another `main`, `banner` or `contentinfo`. (AS-07)
- **FR-002**: The header layouts of AS-01 (≥ 1024 px) and AS-02 (< 1024 px; specified and tested at ≤ 640 px and ≥ 1024 px) are normative; the header is sticky; focused elements are never hidden behind it (scroll padding at least the header height). (AS-01, AS-02)
- **FR-003**: Slots of other capabilities are mounted only through the names in *Cross-capability contracts → Requires*; the shell passes them no data except where stated (variants, `returnTo` is theirs). The account slot sits inside a `Suspense` boundary whose fallback has the account button's exact size; a slot that throws renders nothing in its place and does not break the header. (AS-04)
- **FR-004**: The search control follows AS-03: navbar box at ≥ 1024 px, a "Search" button opening a full-width row at ≤ 640 px, both absent on `/` and `/search`; the shell implements no keyboard shortcut it does not document in the control's accessible description. (AS-03)
- **FR-005**: The theme control follows AS-06 with the three choices Light, Dark, System; default System; the choice persists in the browser; the theme script and its styles carry the nonce; the control and its choice are labelled. (AS-06)
- **FR-006**: The footer follows AS-08; the **Source code** link renders only when `SOURCE_CODE_URL` is configured and is an `https:` address (a configured value that is not `https:` is ignored and logged once at start-up). (AS-08)
- **FR-007**: The skip link and focus rules of AS-07 are provided by the shell: a route-change focus helper moves focus to the new `h1` (or `<main>`) after client-side navigation only, never on first load, never when the navigation is a hash or search-parameter change on the same page. (AS-07)

**System states**

- **FR-010**: `not-found`, `error`, `global-error`, `loading` and the access-denied state exist at the app root with the exact structure and copy of AS-09..AS-13; the shared building blocks `<NotFoundState />`, `<ErrorState />`, `<AccessDeniedState />` and `<PageSkeleton />` are exported for other capabilities (*Provides*). (AS-09..AS-13)
- **FR-011**: No error state ever renders a message, stack trace, SQL, URL, or upstream text; text comes from the status and stable `code` only; the reference line shows the server `digest` or the problem `requestId` and nothing else (V.3). The text for the status classes is exactly AS-13's; for `401` the shell renders nothing and relies on W01. (AS-10, AS-13)
- **FR-012**: A failed segment keeps the header, footer, theme and open state of the frame (an error never unmounts the frame) except in AS-11; **Try again** re-renders only the failed segment. (AS-10)
- **FR-013**: Loading placeholders follow AS-12; no placeholder displays for less than 150 ms of waiting; placeholders have the size of what they stand for so nothing shifts when content arrives (cumulative layout shift of the frame ≤ 0.02). (AS-12, SC-004)
- **FR-014**: The offline notice follows AS-14: driven by the browser's online/offline events, one instance for the app, no polling. (AS-14)
- **FR-015**: One toast area, with the rules of AS-15; toast content is text only. (AS-15)

**Security headers and CSP**

- **FR-020**: Every document response carries the Content Security Policy of AS-16, built by one pure function from `(nonce, path, environment, configured hosts)` and applied by one request-time hook that runs on every request except static assets and the health route; the hook generates the nonce, sets the policy on the request (so the framework applies the nonce) and on the response, and **makes no authorization decision** (constitution VI.5; pattern P0903). (AS-16, AS-18)
- **FR-021**: Because a nonce policy requires a fresh document per request, no route is served from a prerendered or CDN-cached HTML shell; HTML responses are produced per request and streamed. Data caching (`"use cache"`, with explicit lifetimes) stays available for server data. This trade-off is accepted and documented in the plan. (AS-16)
- **FR-022**: Configured hosts (media, video, map tiles, payment provider) are exact `https://host[:port]` values read once from validated server configuration; a wildcard, a non-HTTPS value (outside development) or a malformed value makes start-up fail with a message naming the variable. The same list feeds the image optimiser's allowed hosts. (AS-18, AS-22)
- **FR-023**: Static security headers of AS-19 apply to every response; the `no-referrer` exception applies to `/reset-password` and `/invites/*` as one effective header value; `Cache-Control: no-store` applies to the signed-in areas of AS-20. The header definitions live in one module used by both the framework configuration and the tests. (AS-19, AS-20)
- **FR-024**: A CSP violation report is sent to `/api/csp-reports` (`Reporting-Endpoints` and `report-to`, with `report-uri` as the fallback); the endpoint is outside the web app (S54) and always answers `204`. The policy is enforced, not report-only. (AS-21)
- **FR-025**: The shell enforces VI.7: no `dangerouslySetInnerHTML`, `eval`, `new Function` or string timers in the shell's code; the documentation viewer renders operation text from the description as text (markdown from the description is rendered by an allowlist sanitizer only); the only `javascript:`-capable sinks (links from the description, the source-code link) are validated to `http:`/`https:`. (AS-17, AS-29)

**Legal pages and developer documentation**

- **FR-030**: `/privacy` and `/terms` follow AS-23..AS-26; they are static content with no data request; the "Last updated" date is a constant in the page's source, changed in the same pull request as any content change. (AS-23..AS-26)
- **FR-031**: `/developers/docs` follows AS-27..AS-30. The API description is obtained from the same-origin route `GET /api/developers/openapi.json` (S42 publishes it; the web app's proxy routes it to the public API's description route), through `lib/api/developers.ts`, cached on the server for at most 5 minutes, validated before use (OpenAPI 3.x with `paths`); the page never contains an absolute address of the API. (AS-27, AS-28, AS-37)
- **FR-032**: The documentation viewer offers no request-sending feature; it is a client leaf loaded only on its route; its text content is escaped or sanitized (FR-025). (AS-29, AS-30)

**Metadata and indexing**

- **FR-050**: Titles use the template "{Page} · Marketplace"; every route supplies its own page part (legal pages and not-found per AS-09/AS-26; other capabilities their own); a route without one gets "Marketplace". The `h1` of a page and its title name the same thing. (AS-34)
- **FR-051**: The public address `SITE_URL` (required in production, `https:`) is the base for canonical and social-preview URLs; start-up fails in production when it is missing or not `https:`. (AS-34)
- **FR-052**: `/robots.txt` is generated from the same list of private areas as FR-023's no-store rule so the two never diverge; private areas and the not-found page send `noindex`. (AS-34, AS-20)
- **FR-053**: Whenever a capability adds a cookie, a browser storage key, or a data recipient, the legal pages are updated in the same pull request; `/privacy`'s cookie list is checked by a test against the cookies and storage keys the app sets. (AS-23)

**Analytics and data**

- **FR-060**: One `page_view` per navigation via W02's `track()` with the route template of AS-35; the template list is derived from the route tree, never from the address; unknown dynamic segments map to their template name, unmatched addresses to `/not-found`. (AS-35)
- **FR-061**: The browser query client follows AS-36; server components that need data call server-only data modules and never share a client between requests. (AS-36)
- **FR-062**: No cookie-consent banner exists: the only cookies are a strictly necessary session cookie and CSRF cookie and a first-party analytics identifier that is withheld under Global Privacy Control or Do Not Track; this assumption is revisited if a capability adds a third-party script or cookie (FR-053). (AS-23)
- **FR-063**: The shell reads configuration only through one validated server-only module (`SITE_URL`, `API_URL`, `BFF_URL`, `SSE_URL`, `MEDIA_HOST`, `VIDEO_HOST`, `MAP_TILE_HOST`, `PAYMENT_PROVIDER_HOSTS`, `WIDGET_APP_BUNDLE_URL`, `SOURCE_CODE_URL`, `ALLOWED_ORIGINS`); nothing is read from a `NEXT_PUBLIC_*` variable for an API address (W01 FR for same origin). (AS-37, AS-22)
- **FR-064**: Re-render discipline (P0902): the header's slots are separate leaf client components, each subscribing only to its own data; no Context in the shell carries a value that changes more than once per session except the theme; no list in the shell uses an array index as a key. (AS-38)
- **FR-065**: Reconnect behaviour: on the browser `online` event the query client refetches active queries that failed while offline, once, without a page reload. (AS-14, AS-36)

**Widget application and operations**

- **FR-070**: The widget checkout bundle is served per AS-39 and implements the iframe side of S44's message contract per AS-40, including `targetOrigin` equal to the registered host origin (never `"*"`), source and origin checks on receipt, and no use of `eval`. (AS-39, AS-40)
- **FR-071**: `GET /health` per AS-41. (AS-41)

**Layout and accessibility baseline** (inherited by every capability)

- **FR-080**: Reflow, touch targets, keyboard, screen-reader, contrast and motion rules of AS-31..AS-33 apply to every page; W01–W06 reference them instead of restating them. (AS-31..AS-33)
- **FR-081**: Every page has exactly one `h1`; headings never skip a level; every form control has a visible label; every icon-only control has an accessible name; dynamic notices use `role="status"` and failures `role="alert"` (W01 FR-052..FR-056 are the same rules). (AS-32)

### Key Entities

- **Frame**: the header, footer, skip link, `<main>`, toast area and offline notice that wrap every page. Slots are named places in the header filled by capabilities.
- **Slot**: a header or menu position owned by a capability (account, search, cart, notifications, chat unread, assistant, Admin entry); has a fixed place, a same-size fallback and a "renders nothing when unavailable" rule.
- **System state**: not-found, error, root error, loading, access denied, offline; each with fixed copy and actions.
- **Security policy**: the per-response Content Security Policy and the static headers; a pure function of nonce, path, environment and configured hosts.
- **Configured host**: an exact HTTPS origin from configuration permitted for images, media, map tiles or payment.
- **Page name**: the route template under which a navigation is counted (never an address).
- **API reference**: the OpenAPI description published by S42, shown read-only.
- **Widget message**: one of `marketplace:need-identity`, `marketplace:identity {token}`, `marketplace:close` exchanged between the iframe application and the host page.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On all W07 pages, an automated accessibility scan reports 0 serious or critical issues at 320, 390 and 1280 px in both colour schemes, and a keyboard-only visitor reaches every header control, the page content and every footer link in the order of AS-32 without a trap.
- **SC-002**: 100 % of HTML responses of the web app (pages, not-found, error, redirect targets) carry the full policy of AS-16 with a nonce that differs from every other response, verified over at least 100 consecutive responses.
- **SC-003**: The main journeys (browse, product, search, sign-in, cart, theme switch, developer docs, error page) complete in the production build with 0 CSP violations reported by the browser or by the report endpoint.
- **SC-004**: The frame causes a cumulative layout shift of 0.02 or less on every page, including while the account slot, cart count and notifications load.
- **SC-005**: A visitor on a phone reaches **Log in**, **Sign up**, **Cart**, **Browse**, **Terms** and **Privacy** within two taps from any page.
- **SC-006**: For every failure kind of AS-13 the visitor sees a plain-language message and a way forward within 1 second of the failure being known, and never any technical detail; a visitor who gets a reference quotes it and support finds the request.
- **SC-007**: The developer-docs viewer adds 0 bytes to the first load of any other page.
- **SC-008**: After sign-out, pressing Back shows no private content on 100 % of signed-in areas.
- **SC-009**: No reported page view contains an identifier, token or query string (0 events with a `page` that is not a route template over a full journey run).

## Assumptions

Defaults chosen unattended; each is also in [`questions.md`](questions.md), tagged.

- **A-01 (nonce CSP over static prerendering)**: the pattern map and S44 call for a strict nonce policy; the framework guide states a nonce policy needs dynamic rendering and is incompatible with a prerendered shell. W07 therefore serves every document per request and keeps data caching only. W01 AS-62 ("prerenders its static shell") is restated as "the shell streams first" — a `[CONTRACT]` difference.
- **A-02 (one request-time hook, no authorization)**: the Next.js 16 "proxy" file generates the nonce and sets headers; it never decides access.
- **A-03 (inline style attributes allowed)**: components that set inline style attributes need `style-src-attr 'unsafe-inline'`; scripts get no such allowance.
- **A-04 (CSP reports to the platform)**: violations go to a same-origin `/api/csp-reports` owned by S54; until it exists the browser's failed report is harmless and is a gap.
- **A-05 (docs are read-only)**: the API reference has no try-it-out because browser calls would carry a cookie session, not an API key, and an unauthenticated console invites abuse; sellers use their own tooling with their key.
- **A-06 (docs data from S42)**: the OpenAPI description exists at the public API's documentation route (S42 AS-67); the web app proxies it at `/api/developers/openapi.json`.
- **A-07 (breakpoints)**: "mobile" ≤ 640 px and "desktop" ≥ 1024 px are tested; 641–1023 px uses the compact (mobile) structure.
- **A-08 (theme choice stored locally)**: the theme preference is a non-credential browser preference; constitution VI.2 forbids tokens, not preferences.
- **A-09 (legal text is draft)**: the legal copy is drafted from what the product demonstrably does and is not legal advice; "Contact" uses the configured `SOURCE_CODE_URL` issues page when present, otherwise states that contact details are not published for this showcase.
- **A-10 (access denied is a state, not a route)**: the framework's experimental `forbidden`/`unauthorized` conventions are not enabled; pages render `<AccessDeniedState />` when the API answers `403`.
- **A-11 (no client error beacon)**: client-side errors are logged to the console without data (W01 AS-67); server errors are logged by the server with their digest; a client error collector is a follow-up.
- **A-12 (footer and docs wording)**: the footer sentence and the documentation introduction wording above are the exact copy; tests assert them.
- **A-13 (no sitemap)**: not needed for a portfolio sandbox; `robots.txt` only.
- **A-14 (widget screens)**: only identification and close are specified for the iframe application; the rest awaits a later revision.

## Cross-capability contracts

Earlier specs searched (`grep -rl` for `W07` over `specs/domains` and `specs/web`; `specs/journeys` does not exist): **W01, W02, W03, W04, W05, W06, S44, S39** name W07 and are honoured below. Differences are raised as `[CONTRACT]` lines in `questions.md` (Q1 static shell, Q2 Admin entry owner, Q3 widget bundle URL, Q4 `Cache-Control` on guarded pages, Q5 `/api/csp-reports`, Q6 OpenAPI route).

### Provides

Exact names; modules are in `packages/web`.

- **Frame rules for every page**: one `main` (`id="main-content"`), skip link, header/footer landmarks, route-change focus to `h1`, titles "{Page} · Marketplace", toast area (`sonner`, one `<Toaster />`), AS-31..AS-33 baseline. Other capabilities add no `main`, `banner`, `contentinfo`, skip link or toaster.
- **`<NotFoundState title? description? actions? />`**, **`<ErrorState problem? reference? onRetry? />`**, **`<AccessDeniedState />`**, **`<PageSkeleton variant="detail" | "list" | "form" />`** (`components/layout/system-states.tsx`; client only where needed): shared copy of AS-09, AS-10, AS-12, AS-13. `ErrorState` takes `Problem` from W01's `problemFromError` and renders per AS-13; for `401` it renders nothing.
- **Route files**: `app/not-found.tsx`, `app/error.tsx`, `app/global-error.tsx`, `app/loading.tsx`, `app/robots.ts`, `app/health/route.ts`.
- **`lib/routes/page-name.ts`** → `pageNameFor(pathname: string, matchedTemplate?: string): string` (pure): returns the route template; used by the `page_view` emitter (`components/analytics/page-view.tsx`, client, mounted in the root layout).
- **Security module** (`lib/security/csp.ts` → `buildCsp({ nonce, pathname, isDev, hosts }): string`; `lib/security/headers.ts` → `staticSecurityHeaders`, `noReferrerPaths`, `noStorePaths`): the lists capabilities extend in the same pull request when they add a private area, a host or a cookie (FR-053). **Rule for other capabilities**: a new private area is added to `noStorePaths` and to the robots disallow list; a new external host is added to configuration (FR-022) and to the path-scoped CSP rule, never to a global allowance.
- **Configuration module** (`lib/config.ts`, `server-only`): `config` with the keys of FR-063; fails fast at start-up.
- **Query client defaults** (`lib/providers.tsx`): per AS-36; `lib/query-keys.ts` keys begin with the domain name and are the only key source. The shell adds one key, `queryKeys.developers.openapi`.
- **`<RouteFocus />`** and **`<SkipLink />`** (`components/layout`): mounted once in the root layout.
- **Widget application**: bundle at `WIDGET_APP_BUNDLE_URL` (default `/widget/v1/app.js`), message types `marketplace:need-identity`, `marketplace:identity {token}`, `marketplace:close` (S44), and the "checkout application" states of AS-40.
- **`GET /health`** → `200 {"status":"ok"}`.
- **Playwright helpers** (`tests/helpers.ts`): `expectNoCspViolations(page)` (collects `securitypolicyviolation` events and console CSP errors for the test's duration), `gotoAtWidth(page, 'mobile' | 'desktop', path)`, `headersOf(request, path)`.

### Requires

- **W01**: `<AccountSlot />`, `<AccountSlotSkeleton />`, `<MobileAccountEntries />` (`components/auth/account-slot.tsx`; the skeleton exactly the size of the account button); the account menu lists **Admin** when `isAdmin(user)` (W06) — `[CONTRACT]` Q2; `problemFromError(error): Problem` with `Problem = {status: number | null, code: string | null, errors: {field, message}[], retryAfterSeconds: number | null, requestId: string | null}`; the wait-text and 4xx fallback copy of FR-040/FR-041; the session-ended flow for `401`; `useAuth()` read-only `{user, status, isAuthenticated, isLoading}`; `requireServerSession(returnTo)` for guarded layouts; `/account` → `/account/security` redirect is **W01's request to W07** and is kept in `next.config.ts` by W07.
- **W02**: `<SearchBox variant="navbar" />` (renders nothing on `/` and `/search`; input focusable; closes itself with Escape); `track(event)` with `event = {name: 'page_view'; page?: string; props?}` and the Global Privacy Control / Do Not Track rule inside it; `lib/routes.ts` (`searchHref`, `productHref`); the media and video delivery hosts and the optional map tile host as configuration values.
- **W03**: `<CartBadge />` (accessible name "Cart" / "Cart, {n} items", no badge while unknown), `useCartCount(): number | null`, `<NotificationsPopover />` (signed-in only; makes no request for visitors); the payment provider's hosts for `/checkout/pay/*` (`PAYMENT_PROVIDER_HOSTS`).
- **W05**: `<AssistantLauncher variant="icon" | "menu-item" />` (renders for everyone; owns trigger and sheet; the layout-level `<AssistantSheet />` and the `toggle-assistant` event are removed); optional `<ChatNavBadge />` and `useChatUnreadTotal(): number | null` (signed-in only).
- **W06**: `isAdmin(user: SessionUser | null): boolean` (`lib/admin/is-admin.ts`).
- **W04**: `/invites/{token}` page (W07 only adds the header and page-name rules for it).
- **S39**: `POST /api/events` accepting `page_view` with `page` ≤ 500 characters (via W02's `track`).
- **S42**: the OpenAPI 3.x description of the public API, reachable same-origin as `GET /api/developers/openapi.json` (proxy to the public API's documentation route); per-operation scopes, deprecation and sunset marks (S42 AS-36, AS-67). `[CONTRACT]` Q6.
- **S44**: `GET /api/widget/v1/config`, `POST /api/widget/v1/identify {key, token}` → `{widgetToken, expiresIn, customer: {id, email: string | null}}`, `GET /api/widget/v1/session`; the loader's `postMessage` types and the embed document that loads the bundle with the nonce; `checkoutUrl` in the config response.
- **S48 / S54**: the same-origin `/api/*` proxy rules (`next.config.ts` rewrites stay); problem+json on every error (`type, title, status, detail, instance, requestId, code`); **new** `POST /api/csp-reports` (accepts `application/csp-report` and `application/reports+json`, always `204`, rate-limited, logs the violated directive and blocked host without the full document URL query) — owner S54 `[CONTRACT]` Q5.
- **Infrastructure** (not a capability): the ALB routes `/health` to the web service; `SITE_URL` and host variables are set per environment.

## Pattern coverage (pattern-map rows whose Specs column names W07)

| Pattern | Requirements | Scenarios |
|---|---|---|
| **P0502** CSP (strict, nonce), `frame-ancestors` per site | FR-020..FR-024, FR-070 (the web app's own pages: `frame-ancestors 'none'`; the widget's per-site ancestors are S44's embed document) | AS-16..AS-22, AS-39 |
| **P0902** Rendering and performance (keys, memoisation, virtualisation) | FR-013, FR-064, FR-065, FR-032 (viewer chunk isolated); no virtualised list exists in the shell (the only long list is the API reference, expanded on demand) | AS-12, AS-38, AS-30, SC-004, SC-007 |
| **P0903** Next.js App Router: RSC, Server Actions, caching layers, authorization not only in middleware | FR-020, FR-021, FR-031, FR-061; Server Components first (AS-38) | AS-38, AS-16, AS-27 |
