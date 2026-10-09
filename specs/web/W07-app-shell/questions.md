# W07 — Decisions taken unattended

Format: `- [TAG] question → default → why`. BREAKING first, then CONTRACT, then LOCAL. Ids (Qn) are cited by `spec.md`.

## BREAKING (change what exists today)

- [BREAKING] Content Security Policy today: none (only three static headers, `next.config.ts:55-60`) → a strict per-response nonce policy with `'strict-dynamic'` and no `'unsafe-inline'` for scripts, set by a request-time hook (`proxy.ts`) that makes no access decision (AS-16) → pattern P0502 and notes 05/01 §2 require it; the framework guide says nonce is the way for dynamic documents.
- [BREAKING] Prerendered static shell vs nonce (Q1) → every document is rendered per request and streamed; `cacheComponents` stays on for data caching only; the `next.config.ts:11` "Partial Prerendering" comment is wrong afterwards → the guide states a nonce policy is incompatible with a prerendered shell; hash-based SRI is experimental; correctness and security beat CDN-cacheable HTML for a showcase.
- [BREAKING] Image hosts today include `*.amazonaws.com` and `images.unsplash.com` (`next.config.ts:23-24`) → exact hosts from validated configuration only, shared by the image optimiser and `img-src` (AS-22, FR-022) → a wildcard host lets anyone's bucket pass through your optimiser and your policy.
- [BREAKING] Developer docs page today: own header and `<main>` inside the app's (two landmarks), hard-coded `http://localhost:3000/docs-json`, and a live "Try it out" console (`app/developers/docs/page.tsx:12-32`) → inside the shared frame, description fetched same-origin through `lib/api/developers.ts`, read-only (AS-27..AS-30) → a cookie-session console invites abuse and the hard-coded origin breaks every non-local environment.
- [BREAKING] Navbar today: literal cart badge `0` (`navbar.tsx:112-117` region), search button with `onClick={() => {}}` (`:78`) and an advertised ⌘K that does nothing, mobile search button with no action (`:89`), `toggle-assistant` window event (`:36`), single-purpose theme toggle with no state, unnamed hamburger "Toggle menu" → W03/W02/W05 components in fixed slots, working mobile search row, no shortcut advertised, theme menu Light/Dark/System, hamburger "Open menu" (AS-01..AS-06) → a control that does nothing and a wrong number are worse than none.
- [BREAKING] No skip link, no focus handling on navigation, nested `main` in a page → skip link, single `main#main-content`, focus to `h1` after in-app navigation (AS-07) → W02 FR-186 and WCAG 2.4.1.
- [BREAKING] Page titles today "Privacy Policy | Marketplace", "Marketplace Showcase" → "{Page} · Marketplace" (FR-050) → matches W01's titles; one pattern everywhere.
- [BREAKING] Query client retries once for everything (`lib/providers.tsx:15`) → at most 2 retries for network and 5xx, never for 4xx, mutations never (AS-36) → retrying a `403`/`422` is noise and delays the message.
- [BREAKING] Security headers today apply the same three values everywhere and no `Referrer-Policy` exception → add HSTS (production), Permissions-Policy, COOP, `no-referrer` on `/reset-password` and `/invites/*`, `no-store` on private areas (AS-19, AS-20) → closes token-in-Referer and Back-button leaks (W01 AS-64, W04 AS-82).
- [BREAKING] `page_view` today: none → one per navigation under the route template, never the address (AS-35) → S39 expects `page_view` from W07; raw paths would carry invite tokens and product ids.
- [BREAKING] Legal copy today is two sentences and contains no cookie list → full sections with a cookie/storage list checked by a test (AS-23, FR-053) → the policy must match what the app does.
- [BREAKING] `serverActions.allowedOrigins` hard-coded to `localhost:3100`, `marketplace.localhost` (`next.config.ts:15`) → read from `ALLOWED_ORIGINS` (FR-063) → no hard-coded environments in code.

## CONTRACT (another capability must provide or consume)

- [CONTRACT] W01 AS-62 says every W01 page "prerenders its static shell" (Q1) → restated: the shell streams first; no route depends on a build-time HTML shell → a nonce policy forbids it (see BREAKING above); W01 must reword AS-62 and its build check.
- [CONTRACT] Who renders the **Admin** entry (Q2) → W01's `<AccountSlot />` / `<MobileAccountEntries />` render it using W06's `isAdmin(user)`; W07 requires it and tests the visible result (AS-05) → W06 says "W07 owns the menu", W01 says it owns the account slot; the menu lives in W01's component, so W01 implements and W07 asserts.
- [CONTRACT] Widget checkout bundle address and route (Q3) → configuration `WIDGET_APP_BUNDLE_URL`, default `/widget/v1/app.js` on the web origin, served with `Cross-Origin-Resource-Policy: cross-origin`; the web app's pages stay `frame-ancestors 'none'`; `checkoutUrl` opens the normal `/checkout` as a top-level page, not in a frame → S44's embed document loads the bundle (S44 says "script URL lacks the `/api` prefix"); screens after identification wait for a later S10/S44 revision.
- [CONTRACT] `Cache-Control: no-store` on guarded HTML (Q4) → set by W07 for the path list of AS-20 (`/dashboard/**`, `/account/**`, `/checkout/**`, `/cart`, `/chat`, `/admin/**`, `/invites/**`); capabilities add new private areas to that list → W01 AS-24 ("Back does not reveal private data") needs it at the header level.
- [CONTRACT] `POST /api/csp-reports` (Q5) → owner S54; accepts `application/csp-report` and `application/reports+json`, always `204`, rate-limited, logs directive and blocked host only → violations must reach operators (observability); missing today (gap).
- [CONTRACT] OpenAPI description route for the docs page (Q6) → S42 publishes `GET /api/developers/openapi.json` (OpenAPI 3.x, scopes, deprecations); the web proxy routes it to the public API's documentation route (`packages/backend/apps/public-api/src/main.ts` serves the description today) → the page must not contain an API origin.
- [CONTRACT] W02 `track()` must accept `page_view` with a template string and apply Global Privacy Control / Do Not Track itself → W07 only supplies the page name; W02 FR-140 already lists `page_view`.
- [CONTRACT] W02's `<SearchBox variant="navbar" />` renders nothing on `/` and `/search` and closes with Escape; W03's `<CartBadge />`, `<NotificationsPopover />`; W05's `<AssistantLauncher />`, optional `<ChatNavBadge />` → named exactly as those specs provide; W07 adds no props.
- [CONTRACT] W01 asks W07 for the `/account` → `/account/security` redirect and `Referrer-Policy: no-referrer` on `/reset-password` → both kept in `next.config.ts`/headers module by W07 (AS-19).
- [CONTRACT] Payment provider hosts on `/checkout/pay/*` only (W03) → configuration `PAYMENT_PROVIDER_HOSTS`, exact hosts, added to `script-src`, `frame-src`, `connect-src` on that path (AS-18) → W03 supplies the host list per provider.
- [CONTRACT] `/health` for the ALB/Kubernetes probe → web route handler, no backend call → infra capability must route to it (outside W07's code).

## LOCAL

- [LOCAL] Breakpoints → ≤ 640 px mobile, ≥ 1024 px desktop, in between uses the mobile structure → keeps two layouts to maintain.
- [LOCAL] `style-src-attr 'unsafe-inline'` → allowed, scripts never → UI libraries set inline style attributes; styles cannot run code.
- [LOCAL] Theme menu (Light/Dark/System) with nonce on the bootstrap script → replaces the two-state toggle → no flash, CSP-clean.
- [LOCAL] Access denied as a component, not the experimental `forbidden` convention → keeps the config stable.
- [LOCAL] Client errors are not reported to a collector → console only, no data; server logs carry the digest → follow-up.
- [LOCAL] No sitemap → robots only.
- [LOCAL] No cookie banner → nothing needs consent; revisit with any third-party script (FR-062).
- [LOCAL] COOP `same-origin-allow-popups` (not `same-origin`) → payment 3-D Secure windows must keep working.
- [LOCAL] Permissions-Policy: geolocation allowed for self → pickup-near-me may ask for location.
- [LOCAL] Toast timing 5 s, max 3 visible → common defaults.
- [LOCAL] "No placeholder under 150 ms" → avoids flashes; value is tunable.
- [LOCAL] Legal pages stay static TSX, not MDX → no new dependency.
- [LOCAL] Docs description cached on the server ≤ 5 min → protects the public API from page views.
- [LOCAL] `Source code` link only when `SOURCE_CODE_URL` is configured and `https:` → the current footer promises a link that does not exist.
