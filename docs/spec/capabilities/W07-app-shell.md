---
id: W07
title: App shell and cross-cutting UI: navbar, footer, legal pages, developer docs, error/not-found/loading states, responsive layout, accessibility, CSP and security headers
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S54, S50, W01, W02, W03]
concepts: [problem-json-errors, rate-limit-policy]
models: []
scope:
  - packages/backend/libs/domains/orders/**
  - packages/backend/libs/infrastructure/platform/**
  - packages/contracts/src/platform/**
  - packages/web/app/admin/**
  - packages/web/components/layout/**
  - packages/web/lib/api/**
  - packages/web/lib/security/**
---
# W07 - App shell and cross-cutting UI
## Purpose
Every visitor of the web app sees the same frame around each page: header, footer, skip link, toasts and offline notice. This capability owns that frame, the legal pages, the system states (not found, error, loading, offline) and the security headers and Content Security Policy of every response. It gives the other web capabilities one baseline for layout and accessibility.

## Entry points
- Page `/terms`: static "Terms of service" page with seven sections. [code: packages/web/app/terms/page.tsx#TermsPage]
- Page `/privacy`: legal page for privacy. No file of this page is in the facts.
- Page `/developers/docs`: public API reference. No file of this page is in the facts.
- Root layout: renders the skip link, header, `<main>`, footer, toast area and offline notice around every page. [code: packages/web/app/layout.tsx#RootLayout]
- Not-found state, shown for an unknown address. [code: packages/web/app/not-found.tsx#NotFound]
- Error state, contained to `<main>`. [code: packages/web/app/error.tsx#ErrorPage]
- Root-layout error state, a self-contained document. [code: packages/web/app/global-error.tsx#GlobalError]
- Loading state of the root. [code: packages/web/app/loading.tsx#Loading]
- Request hook that sets the Content Security Policy on every document request. [code: packages/web/proxy.ts#proxy]
- `POST /api/csp-reports`: receives browser reports of blocked content and always answers `204`. [code: packages/backend/libs/infrastructure/platform/csp-reports.controller.ts#CspReportsController]

## Rules
- **W07.R-01** The header MUST show the logo link "Marketplace home", the "Main" navigation with Browse and Developers, the search box, theme control, cart link and account slot. [proof: W07 AS-01, W07 AS-04] [code: packages/web/components/layout/navbar.tsx#Navbar]
- **W07.R-02** At 640 px or less the header MUST show a hamburger button "Open menu" that opens a mobile menu. [proof: W07 AS-02] [code: packages/web/components/layout/mobile-menu.tsx#MobileMenu]
- **W07.R-03** The navbar search box MUST be absent on `/` and `/search`; at 640 px or less a "Search" button opens a full-width search row. [proof: W07 AS-03] [code: packages/web/components/layout/search-row.tsx#SearchRow]
- **W07.R-04** The cart link MUST always be present, with the accessible name "Cart" or "Cart, {n} items". [proof: W07 AS-04] [code: packages/web/components/cart/cart-badge.tsx#CartBadge]
- **W07.R-05** The Admin menu entry MUST appear only for the role `ADMIN`. It is presentation only. [proof: W07 AS-05] [code: packages/web/lib/admin/is-admin.ts#isAdmin]
- **W07.R-06** The theme control MUST offer Light, Dark and System, with System as default. [proof: W07 AS-06] [code: packages/web/components/layout/theme-control.tsx#ThemeControl]
- **W07.R-07** The first focusable element of every page MUST be the link "Skip to main content", which moves focus to the single `<main id="main-content">`. [proof: W07 AS-07] [code: packages/web/components/layout/skip-link.tsx#SkipLink]
- **W07.R-08** The footer MUST show the portfolio-project sentence and a "Footer" navigation. [proof: W07 AS-08] [code: packages/web/components/layout/footer.tsx#Footer]
- **W07.R-09** An unknown address MUST answer `404` with the heading "Page not found" inside the frame. [proof: W07 AS-09] [code: packages/web/components/layout/system-states.tsx#NotFoundState]
- **W07.R-10** A rendering failure MUST stay inside `<main>` and show "Something went wrong". Header and footer MUST stay usable. [proof: W07 AS-10] [code: packages/web/app/error.tsx#ErrorPage]
- **W07.R-11** A failure of the root layout MUST show a self-contained document with its own `<html lang="en">`. [proof: W07 AS-11] [code: packages/web/app/global-error.tsx#GlobalError]
- **W07.R-12** A loading route MUST show the header and footer and a placeholder with `aria-busy="true"` in `<main>`. [proof: W07 AS-12] [code: packages/web/components/layout/page-skeleton.tsx#PageSkeleton]
- **W07.R-13** An error state MUST take its text only from the status and the stable `code`, never from `title` or `detail`. [proof: W07 AS-13] [code: packages/web/components/layout/system-states.tsx#ErrorState]
- **W07.R-14** While the browser is offline, a `role="status"` notice MUST show "You're offline…". [proof: W07 AS-14] [code: packages/web/components/layout/offline-notice.tsx#OfflineNotice]
- **W07.R-15** The app MUST have one toast area, with at most 3 toasts visible. [proof: W07 AS-15] [code: packages/web/components/ui/sonner.tsx]
- **W07.R-16** Every HTML response MUST carry a `Content-Security-Policy` header with a fresh nonce per response. [proof: W07 AS-16] [code: packages/web/lib/security/csp.ts#buildCsp]
- **W07.R-17** Payment provider hosts MUST be added to the policy only on `/checkout/pay/*`. Map tile hosts MUST NOT be wildcards. [proof: W07 AS-18] [code: packages/web/lib/security/csp.ts#buildCsp]
- **W07.R-18** Every response MUST carry the static security headers, including `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`. [proof: W07 AS-19] [code: packages/web/lib/security/headers.ts#staticSecurityHeaders]
- **W07.R-19** Signed-in areas MUST carry `Cache-Control: no-store`. [proof: W07 AS-20] [code: packages/web/lib/security/headers.ts#noStorePaths]
- **W07.R-20** `POST /api/csp-reports` MUST answer `204` for any body or content type. [proof: W07 AS-21] [code: packages/backend/libs/infrastructure/platform/csp-reports.controller.ts#CspReportsController]

## Behaviors
- **W07.B-01** Given a page at 1024 px or wider, when it renders, then the sticky header shows the logo, the "Main" navigation, search, theme, cart and account slot. [proof: W07 AS-01]
- **W07.B-02** Given a page at 640 px or less, when the visitor activates "Open menu", then the mobile menu opens. [proof: W07 AS-02]
- **W07.B-03** Given a page other than `/` and `/search` at 640 px or less, when the visitor activates "Search", then a full-width search row opens. [proof: W07 AS-03]
- **W07.B-04** Given a member with role `ADMIN`, when the account menu opens, then it lists Admin after Account & security. [proof: W07 AS-05]
- **W07.B-05** Given a first visit, when the page paints, then the colour scheme follows the operating system. [proof: W07 AS-06]
- **W07.B-06** Given any page, when the visitor presses Tab first, then "Skip to main content" receives focus. [proof: W07 AS-07]
- **W07.B-07** Given an unknown address, when it is requested, then the response is `404` and `<main>` shows "Page not found". [proof: W07 AS-09]
- **W07.B-08** Given a client island throws, when the page renders, then `<main>` shows "Something went wrong" and header and footer stay. [proof: W07 AS-10]
- **W07.B-09** Given a screen has no place for a failed API call, when the call answers with a problem body, then `<ErrorState>` shows text chosen by status and code. [proof: W07 AS-13]
- **W07.B-10** Given the browser goes offline, when the event fires, then the offline bar shows. [proof: W07 AS-14]
- **W07.B-11** Given a document request, when the proxy runs, then the response carries the policy and `Reporting-Endpoints` header. [proof: W07 AS-16]
- **W07.B-12** Given the production build, when the main journeys run, then the browser reports zero CSP violations. [proof: W07 AS-17]
- **W07.B-13** Given `/terms`, when it renders, then it shows "Terms of service", "Last updated: 2026-10-11" and seven sections. [proof: W07 AS-24] [code: packages/web/app/terms/page.tsx#TermsPage]
- **W07.B-14** Given a browser blocks content, when it sends a report, then the endpoint logs directive and blocked host and answers `204`. [proof: W07 AS-21]
- **W07.B-15** Given an image host outside the configured list, when the image component runs, then the optimiser does not render it. [proof: W07 AS-22]

## Lifecycles
None. The capability has no status that changes.

## Owns
- Route `POST /api/csp-reports` (implemented in the platform toolkit, {{cap:S54}}). The `/api` prefix is not visible in the controller; the facts name the path in its comment.
- Browser storage key for the theme. [code: packages/web/lib/browser-storage-keys.ts#THEME_STORAGE_KEY]
- Configuration read through one validated module: `SITE_URL`, `API_URL`, `BFF_URL`, `SSE_URL`, `MEDIA_HOST`, `VIDEO_HOST`, `MAP_TILE_HOST`, `PAYMENT_PROVIDER_HOSTS`, `WIDGET_APP_BUNDLE_URL`, `SOURCE_CODE_URL`, `ALLOWED_ORIGINS`. [code: packages/web/lib/config.ts#config]

## Decisions
- The policy uses a nonce per response, so no route is served from a prerendered or CDN-cached HTML shell.
- One pure function builds the policy and one request-time hook applies it, so the policy has one source.
- Error text comes only from status and `code`, so no upstream text, stack trace or address reaches the screen.
- The policy is enforced, not report-only, from the first release.
- The robots list and the no-store list come from one list of private areas, so they never diverge.
- The shell avoids cookie-consent banners because its only cookies are session, CSRF and a first-party analytics identifier.
- Other capabilities reference the accessibility baseline here instead of restating it.

## Known gaps
- No test carries an id for AS-23 (`/privacy`), AS-25 (legal page layout), AS-26 (legal titles), AS-27 to AS-30 (developer docs), AS-35 (page-view events), AS-36 (query client), AS-37 (no cross-origin requests) or AS-41 (`/health`). Their behavior is not stated as rules here.
- AS-39 and AS-40 (widget bundle and identity messages, P3) have no test and no code in the facts.
- AS-33 (contrast, reduced motion) and AS-34 (document metadata, robots) have tests, but this page states no rule for them. AS-31, AS-32 and AS-38 are likewise not stated as rules.
- R-15 names the toast area with a proof (AS-15) but the code file `sonner.tsx` has no listed export.
- The code for `/privacy`, `/developers/docs` and the footer's Source code link (`SOURCE_CODE_URL`) is not in the facts, so these entry points are unchecked.