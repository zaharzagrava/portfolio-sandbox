# W07 — Gaps: today's code versus the spec

The implementation agent's to-do list. Paths are under `packages/web` unless stated. Scenario ids refer to [`spec.md`](spec.md).

## A. Frame and navbar (`components/layout/navbar.tsx`, `footer.tsx`, `app/layout.tsx`)

- `app/layout.tsx`: no skip link, `<main>` has no `id`/`tabIndex` (AS-07, FR-001); no `viewport`; `metadata` has title "Marketplace Showcase" and no template, no `metadataBase`, no robots (FR-050..FR-052); `<AssistantSheet />` mounted for every page (`:40`, W05 removes it; AS-04).
- `navbar.tsx:36` dispatches the untyped `toggle-assistant` window event → mount `<AssistantLauncher />` (icon and menu-item variants). Delete the event (W05 contract).
- `navbar.tsx:45-47` hamburger named "Toggle menu", no `aria-expanded`; the sheet's navigation lists only Browse and Cart and has no account entries (`:55-62`) → AS-02 (account entries first, Chats, Developers, assistant item).
- `navbar.tsx:68` logo has no accessible name distinct from the visible one; there is no `navigation` landmark or label in the header (AS-01, AS-32).
- `navbar.tsx:74-86` desktop "search" is a button with `onClick={() => {}}` and a ⌘K hint that does nothing → mount `<SearchBox variant="navbar" />` (W02); remove the hint (AS-03).
- `navbar.tsx:89` mobile search button does nothing → search row (AS-03).
- `navbar.tsx:94-102` theme is a two-state toggle with no state exposed and rotation animation regardless of reduced motion → Light/Dark/System menu (AS-06, AS-33).
- `navbar.tsx:112-117` cart badge is the literal `0` and the link name does not carry the count → `<CartBadge />` (W03; AS-04).
- `navbar.tsx:123` bell only for authenticated users — keep; add chat badge when W05 supplies it; the `Suspense` fallback for the account slot does not exist because the account block is inline client code reading `useAuth()` (`:24`, `:127-166`) → W01's `<AccountSlot />` inside `Suspense` with `<AccountSlotSkeleton />`.
- `navbar.tsx:164` anonymous controls are `hidden md:flex` so at ≤ 640 px **Log in / Sign up** are unreachable (W01 AS-17) → `<MobileAccountEntries />`.
- Whole file is `'use client'` (`:1`): the header should be a Server Component with leaf client islands (FR-064, AS-38).
- `footer.tsx:11`: "The source code is available on GitHub." has no link; no `navigation` label; no Browse/API docs links; no year (AS-08).
- No `app/not-found.tsx`, `app/error.tsx`, `app/global-error.tsx`, `app/loading.tsx` (only `app/products/[slug]/loading.tsx`); no access-denied state; no offline notice; no shared `<ErrorState />` (AS-09..AS-15).
- No route-change focus helper (AS-07); no `page_view` emitter; `lib/analytics/` does not exist yet (W02 creates `track`).

## B. Security headers and CSP (`next.config.ts`, no `proxy.ts`)

- `next.config.ts:53-62`: only `X-Frame-Options`, `nosniff`, `Referrer-Policy`; no CSP, HSTS, Permissions-Policy, COOP, `no-store` on private areas, no `no-referrer` exception for `/reset-password` and `/invites/*`; `poweredByHeader` not disabled (AS-16..AS-20).
- No `proxy.ts` to generate the nonce; `lib/providers.tsx` mounts `next-themes` without a `nonce` prop → the bootstrap script will be blocked (AS-06, AS-17).
- `next.config.ts:11` comment says "experimental Partial Prerendering" — wrong once the nonce policy is on (Q1); `cacheComponents` stays for data caching. Check every page for runtime-data-outside-Suspense errors after the change.
- `next.config.ts:23-24` wildcard `*.amazonaws.com` and `images.unsplash.com`; `:15` hard-coded `allowedOrigins` (AS-22, FR-063).
- No central configuration module (`lib/config.ts`): env is read ad hoc (`next.config.ts:4-8`, `lib/api/client.ts` `NEXT_PUBLIC_API_URL`, `lib/api/catalog.ts` `serverApiUrl`) (FR-063).
- No `app/robots.ts`, no `/health` route handler, no `/widget/v1/app.js` serving, no violation report endpoint reference (FR-024, FR-052, FR-070, FR-071).
- `lib/api/client.ts:4`: `NEXT_PUBLIC_API_URL || 'http://localhost:3000'` absolute origin, and `:15-23` an in-memory `accessToken` with `setAccessToken` (browser JS holds a token; violates VI.2, AS-37). W01 owns the replacement (cookie session via BFF, relative URLs, `csrfHeaders` from `__Host-bff-csrf`); W07's CSP `connect-src 'self'` will block any absolute origin, so it must be gone first.

## C. Legal pages and developer docs

- `app/privacy/page.tsx`, `app/terms/page.tsx`: two sentences each; titles "Privacy Policy | Marketplace" / "Terms of Service | Marketplace" (AS-23..AS-26, FR-050); no sections, date, anchors, "On this page" navigation, no cookie list test.
- `app/developers/docs/page.tsx:12-13` nested `min-h-screen` wrapper and its own `<header>`; `:29` a second `<main>` inside the root `<main>`; `:32` hard-coded `http://localhost:3000/docs-json`; `:1` the whole page is `'use client'`, and the viewer's "Try it out" is live (AS-27..AS-30, FR-031, FR-032).
- `lib/api/developers.ts` holds seller API-key and webhook types only; there is no `getOpenApiDocument()`; `lib/query-keys.ts` has no `developers.openapi` key.
- `swagger-ui-react` (package.json) is imported with `dynamic(..., {ssr:false})` — keep it out of other pages' bundles (SC-007) or replace it with a small read-only renderer; whichever is chosen must pass CSP (no `eval`) and render description text sanitized (FR-025).

## D. Query client and data rules

- `lib/providers.tsx:14-18`: `retry: 1` for everything; no reconnect refetch policy; `refetchOnWindowFocus: false` is fine; mutations' retry unspecified (AS-36).
- `lib/query-keys.ts`: keys are not namespaced by a domain-first convention in every entry (`products.search`); W01 renames `auth.*`; add `developers.openapi`; add a test that every key is an array starting with its domain name.

## E. Missing backend endpoints and contracts the UI needs

| Need | Owner | Notes |
|---|---|---|
| `POST /api/csp-reports` (accepts `application/csp-report` and `application/reports+json`, always `204`, rate-limited, logs directive and blocked host only) | **S54** platform toolkit (same-origin via the web proxy's core rule) | AS-21, FR-024; until it exists reports fail silently |
| `GET /api/developers/openapi.json` (OpenAPI 3.x of the public API; proxy rule `/api/developers/:path*` → public-api documentation route) | **S42** public API (route) + web `rewrites` (W07) | AS-27; today served by `apps/public-api` at its own documentation path and read from `http://localhost:3000/docs-json` |
| `identify` / `config` / `session` behaviour for the widget iframe application | **S44** (exists in spec) | AS-40; screens after identification need a later S10/S44 revision |
| Per-provider payment host list for `/checkout/pay/*` | **W03** / **S13** | AS-18; value of `PAYMENT_PROVIDER_HOSTS` |
| Public config of media, video and map tile hosts | **W02** / **S29** / **S30** / **S19** | AS-16; values of `MEDIA_HOST`, `VIDEO_HOST`, `MAP_TILE_HOST` |
| No BFF aggregate is needed by W07 itself (the shell reads no aggregate; the header's data comes from W01, W03, W05 components) | — | constitution IX.7 R2 not triggered |

## F. Test-tooling gaps

- `vitest.config.ts:5` `include` is `lib/**/*.test.ts` and `hooks/**/*.test.ts`: components, pages and `.tsx` tests are not collected → extend to `components/**/*.test.{ts,tsx}`, `app/**/*.test.{ts,tsx}`, `lib/**/*.test.{ts,tsx}`, `hooks/**/*.test.{ts,tsx}`; exclude `tests/**` (Playwright); add `setupFiles` (jest-dom matchers, cleanup, MSW server, `matchMedia`/`BroadcastChannel`/`IntersectionObserver` stubs) and the React plugin or the automatic JSX runtime for `.tsx`.
- Not installed (package.json): `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `msw`, `@axe-core/playwright`, `@vitejs/plugin-react` (if needed for JSX).
- Playwright: single `chromium` desktop project (`playwright.config.ts:42-47`); add `mobile` (390 × 844, touch) and `desktop` (1280 × 800) projects, `expect.toHaveScreenshot` defaults (animations disabled, threshold, `snapshotPathTemplate`), `colorScheme` light/dark variants; `webServer` runs `pnpm run dev` (dev CSP differs from production) → CSP journeys need `next build && next start`; `package-lock.json` exists beside a pnpm workspace — pick one package manager for the web scripts.
- `tests/helpers.ts`: add `expectNoCspViolations`, `gotoAtWidth`, `headersOf`; reuse W01's `signOut`.
- No test reads the cookie/storage keys the app sets; add constants module `lib/browser-storage-keys.ts` listing them (theme key, W02's anonymous-id cookie, `__Host-bff-csrf`) so FR-053 can be checked.
- Static boundary scans (`app/boundaries.test.ts`, `lib/shell-boundaries.test.ts`) need an agreed leaf list; ESLint import restrictions for `fetch`/`axios` outside `lib/api/*` (constitution VII.1) are not configured (`eslint.config.mjs`).
- Existing e2e files (`tests/*.spec.ts`) have no navbar, footer, legal or not-found journey; W07's journeys go in `tests/app-shell.spec.ts`, `tests/security-headers.spec.ts`, `tests/developer-docs.spec.ts`, `tests/widget-embed.spec.ts`, and the visual file `tests/app-shell.visual.spec.ts`.

## G. Cross-capability follow-ups (so other specs stay consistent)

- W01 AS-62 ("prerenders its static shell") must be reworded to "the shell streams first" (Q1).
- W06 and W01 must agree that the Admin entry is rendered by W01's account components (Q2).
- S44 must state the final bundle address (Q3); S54 must list `POST /api/csp-reports` (Q5); S42 must list the same-origin description route (Q6).
- `docs/architecture/pattern-map.md` P0502/P0903 rows say "implemented" while the code has neither a CSP nor a proxy: set to `planned` until this spec is built.
