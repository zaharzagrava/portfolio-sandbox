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
  - packages/web/app/developers/docs/**
  - packages/web/app/privacy/**
  - packages/web/app/terms/**
  - packages/web/app/health/**
  - packages/web/app/widget/**
  - packages/web/components/legal/**
  - packages/web/components/widget/**
  - packages/web/lib/widget/**
  - packages/contracts/src/developer-platform/openapi-document.ts
---
# W07 - App shell and cross-cutting UI
## Purpose
Every visitor of the web app sees the same frame around each page: header, footer, skip link, toasts and offline notice. This capability owns that frame, the legal pages, the system states (not found, error, loading, offline) and the security headers and Content Security Policy of every response. It gives the other web capabilities one baseline for layout and accessibility.

## Entry points
- Page `/terms`: static "Terms of service" page with seven sections. [code: packages/web/app/terms/page.tsx#TermsPage]
- Page `/privacy`: static "Privacy policy" page with five sections and the list of everything the app keeps in the browser. [code: packages/web/app/privacy/page.tsx#PrivacyPage]
- Page `/developers/docs`: public API reference, static text and a read-only client leaf over the same-origin description. [code: packages/web/app/developers/docs/page.tsx#ApiDocsPage]
- Document `/robots.txt`: allows public pages, disallows the private areas. [code: packages/web/app/robots.ts#robots]
- Probe `/health`: liveness of the web process. [code: packages/web/app/health/route.ts#GET]
- Script `/widget/v1/app.js`: the checkout application that the storefront widget's embed document loads from another origin. [code: packages/web/app/widget/v1/app.js/route.ts#GET]
- Root layout: renders the skip link, header, `<main>`, footer, toast area and offline notice around every page. [code: packages/web/app/layout.tsx#RootLayout]
- Not-found state, shown for an unknown address. [code: packages/web/app/not-found.tsx#NotFound]
- Error state, contained to `<main>`. [code: packages/web/app/error.tsx#ErrorPage]
- Root-layout error state, a self-contained document. [code: packages/web/app/global-error.tsx#GlobalError]
- Loading state of the root. [code: packages/web/app/loading.tsx#Loading]
- Request hook that sets the Content Security Policy on every document request. [code: packages/web/proxy.ts#proxy]
- `POST /api/csp-reports`: receives browser reports of blocked content and always answers `204`. [code: packages/backend/libs/infrastructure/platform/csp-reports.controller.ts#CspReportsController]

## Rules
- **W07.R-01** The header MUST show the logo link "Marketplace home", the "Main" navigation with Browse and Developers, the search box, theme control, cart link and [account slot](../terms/account-slot.md). [proof: W07 AS-01, W07 AS-04] [code: packages/web/components/layout/navbar.tsx#Navbar]
- **W07.R-02** At 640 px or less the header MUST show a hamburger button "Open menu" that opens a mobile menu. [proof: W07 AS-02] [code: packages/web/components/layout/mobile-menu.tsx#MobileMenu]
- **W07.R-03** The [navbar](../terms/navbar.md) search box MUST be absent on `/` and `/search`; at 640 px or less a "Search" button opens a full-width search row. [proof: W07 AS-03] [code: packages/web/components/layout/search-row.tsx#SearchRow]
- **W07.R-04** The cart link MUST always be present, with the accessible name "Cart" or "Cart, {n} items". [proof: W07 AS-04] [code: packages/web/components/cart/cart-badge.tsx#CartBadge]
- **W07.R-05** The [Admin menu entry](../terms/navbar-menu-entry.md) MUST appear only for the role `ADMIN`. [It is presentation only.](../terms/presentation-only.md) [proof: W07 AS-05] [code: packages/web/lib/admin/is-admin.ts#isAdmin]
- **W07.R-06** The theme control MUST offer Light, Dark and System, with System as default. [proof: W07 AS-06] [code: packages/web/components/layout/theme-control.tsx#ThemeControl]
- **W07.R-07** The first focusable element of every page MUST be the link "Skip to main content", which moves focus to the single `<main id="main-content">`. [proof: W07 AS-07] [code: packages/web/components/layout/skip-link.tsx#SkipLink]
- **W07.R-08** The footer MUST show the [portfolio-project sentence](../terms/portfolio-project-sentence.md) and a "Footer" navigation. [proof: W07 AS-08] [code: packages/web/components/layout/footer.tsx#Footer]
- **W07.R-09** An unknown address MUST answer `404` with the heading "Page not found" [inside the frame](../terms/page-frame.md). [proof: W07 AS-09] [code: packages/web/components/layout/system-states.tsx#NotFoundState]
- **W07.R-10** [A rendering failure](../terms/rendering-failure.md) MUST stay inside `<main>` and show "Something went wrong". Header and footer MUST stay usable. [proof: W07 AS-10] [code: packages/web/app/error.tsx#ErrorPage]
- **W07.R-11** A failure of the [root layout](../terms/root-layout.md) MUST show a [self-contained document](../terms/self-contained-document.md) with its own `<html lang="en">`. [proof: W07 AS-11] [code: packages/web/app/global-error.tsx#GlobalError]
- **W07.R-12** A [loading route](../terms/loading-route.md) MUST show the header and footer and a placeholder with [`aria-busy="true"` ↗](../sw-external-terms.md#aria-busy) in `<main>`. [proof: W07 AS-12] [code: packages/web/components/layout/page-skeleton.tsx#PageSkeleton]
- **W07.R-13** An [error state](../terms/error-state.md) MUST take its text only from the status and the [stable `code`](../terms/error-code.md), never from [`title`](../terms/problem-title.md) or [`detail`](../terms/problem-detail.md). [proof: W07 AS-13] [code: packages/web/components/layout/system-states.tsx#ErrorState]
- **W07.R-14** While the browser is [offline](../terms/offline-notice.md), a [`role="status"` ↗](../sw-external-terms.md#aria-status-role) notice MUST show "You're offline…". [proof: W07 AS-14] [code: packages/web/components/layout/offline-notice.tsx#OfflineNotice]
- **W07.R-15** The app MUST have one [toast area](../terms/toast.md), with at most 3 toasts visible. [proof: W07 AS-15] [code: packages/web/components/ui/sonner.tsx]
- **W07.R-16** Every HTML response MUST carry a [`Content-Security-Policy` ↗](../sw-external-terms.md#content-security-policy) header with a fresh [nonce ↗](../sw-external-terms.md#csp-nonce) per response. [proof: W07 AS-16] [code: packages/web/lib/security/csp.ts#buildCsp]
- **W07.R-17** [Payment provider hosts](../terms/payment-provider-hosts.md) MUST be added to the policy only on [`/checkout/pay/*`](../terms/checkout-pay-route.md). [Map tile hosts](../terms/map-tile-hosts.md) (also allowed to `fetch`, with `blob:` workers) MUST NOT be [wildcards ↗](../sw-external-terms.md#csp-host-source-wildcard). [proof: W07 AS-18] [code: packages/web/lib/security/csp.ts#buildCsp]
- **W07.R-18** Every response MUST carry the [static security headers](../terms/static-security-headers.md), including [`X-Content-Type-Options: nosniff` ↗](../sw-external-terms.md#x-content-type-options) and [`X-Frame-Options: DENY` ↗](../sw-external-terms.md#x-frame-options). [proof: W07 AS-19] [code: packages/web/lib/security/headers.ts#staticSecurityHeaders]
- **W07.R-19** [Signed-in areas](../terms/signed-in-areas.md) MUST carry [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store). [proof: W07 AS-20] [code: packages/web/lib/security/headers.ts#noStorePaths]
- **W07.R-20** [`POST /api/csp-reports`](../terms/post-csp-reports.md) MUST answer `204` for any body or content type. [proof: W07 AS-21] [code: packages/backend/libs/infrastructure/platform/csp-reports.controller.ts#CspReportsController]

- **W07.R-21** `/privacy` MUST show one `h1` "Privacy policy", "Last updated: {date}" and the sections What we store, Cookies and browser storage, Who receives data, Your choices and Contact, and the cookie section MUST list every key of the browser-storage list. [proof: W07 AS-23] [code: packages/web/app/privacy/page.tsx#PrivacyPage]
- **W07.R-22** Legal pages MUST show an "On this page" navigation (a sticky rail from 1024 px, a collapsed disclosure below) whose links move focus to the heading of the chosen section. [proof: W07 AS-25] [code: packages/web/components/legal/on-this-page.tsx#OnThisPage]
- **W07.R-23** Legal page titles MUST be "Privacy policy · Marketplace" and "Terms of service · Marketplace", and the pages MUST be indexable. [proof: W07 AS-26] [code: packages/web/app/privacy/page.tsx#metadata]
- **W07.R-24** `/developers/docs` MUST show, inside the frame, the `h1` "API documentation", the Authentication, Errors and Deprecation texts and the operations of the API description grouped by tag, each expandable by a button with `aria-expanded`, with the required scope and a Deprecated mark with sunset and replacement. [proof: W07 AS-27, W07 AS-30] [code: packages/web/app/developers/docs/reference.tsx#Reference]
- **W07.R-25** While the description loads the reference area MUST be a placeholder with `aria-busy`; when it cannot be fetched or is not an OpenAPI 3.x document the area MUST say "The API reference is temporarily unavailable." with **Try again** that replaces the area in place, and the reference line only when a `requestId` exists. [proof: W07 AS-28] [code: packages/web/lib/api/developers.ts#getOpenApiDocument]
- **W07.R-26** The developer docs MUST be read-only: no "Try it out", no form, one data request (the description, same origin), copyable examples that announce "Copied". [proof: W07 AS-29]
- **W07.R-27** `GET /robots.txt` MUST disallow exactly the no-store paths, and the same private areas MUST also answer with `X-Robots-Tag: noindex`. [proof: W07 AS-34] [code: packages/web/app/robots.ts#robots]
- **W07.R-28** Each navigation MUST emit one `page_view` named by route template (never the address, query or fragment); an unmatched address is `/not-found`, a root error `/error`. [proof: W07 AS-35] [code: packages/web/lib/routes/page-name.ts#pageNameFor]
- **W07.R-29** The browser query client MUST be one per tab and one per server request; queries retry at most twice for network errors and `5xx`, never for `400`, `401`, `403`, `404`, `409` or `422`; mutations never retry; failed active queries are fetched once when the connection returns. [proof: W07 AS-36] [code: packages/web/lib/query-client.ts#shouldRetryQuery]
- **W07.R-30** Every query key MUST be an array that starts with its domain name. [proof: W07 AS-36] [code: packages/web/lib/query-keys.ts#queryKeys]
- **W07.R-31** At 320 px no page scrolls sideways and the header, sheet and footer targets are at least 44 × 44 px. [proof: W07 AS-31]
- **W07.R-32** The keyboard order of the frame MUST be skip link, logo, main navigation, search, assistant, theme, cart, account, page content, footer, and menus MUST return focus on Escape. [proof: W07 AS-32]
- **W07.R-33** The frame and the W07 pages MUST have no serious or critical accessibility violation at 320, 390 and 1280 px in both colour schemes. [proof: W07 AS-33]
- **W07.R-34** The widget checkout application MUST be served with `Content-Type: application/javascript`, `Cache-Control: public, max-age=31536000, immutable`, `Cross-Origin-Resource-Policy: cross-origin` and `nosniff`. [proof: W07 AS-39] [code: packages/web/app/widget/v1/app.js/route.ts#GET]
- **W07.R-35** The widget checkout application MUST post only `marketplace:need-identity` and `marketplace:close`, only to its parent window with the host's origin as target (never `"*"`), and MUST accept `marketplace:identity` only from the parent window and that origin. [proof: W07 AS-40] [code: packages/web/lib/widget/messages.ts#acceptIdentityMessage]
- **W07.R-36** `GET /health` MUST answer `200 {"status":"ok"}` with `Cache-Control: no-store`, without calling the backend and without the document policy. [proof: W07 AS-41] [code: packages/web/app/health/route.ts#GET]
- **W07.R-37** Header slots that follow the session (the visitor's log-in icon, the member's bell) MUST take the server's reading of the session cookie as a prop and use it while the browser has no answer, so the server markup and the first client render agree. [proof: W07 AS-01] [code: packages/web/components/layout/session-slots.tsx#MemberSlot]

## Behaviors
- **W07.B-01** Given a page at 1024 px or wider, when it renders, then the [sticky header ↗](../sw-external-terms.md#sticky-header) shows the logo, the "Main" navigation, search, theme, cart and [account slot](../terms/account-slot.md). [proof: W07 AS-01]
- **W07.B-02** Given a page at 640 px or less, when the visitor activates "Open menu", then the [mobile menu](../terms/navbar-menu-entry.md) opens. [proof: W07 AS-02]
- **W07.B-03** Given a page other than `/` and `/search` at 640 px or less, when the visitor activates "Search", then a [full-width search row](../terms/navbar.md) opens. [proof: W07 AS-03]
- **W07.B-04** Given a member with [role `ADMIN`](../terms/shop-role.md), when the [account menu](../terms/navbar.md) opens, then it lists Admin after Account & security. [proof: W07 AS-05]
- **W07.B-05** Given a first visit, when the page paints, then the colour scheme follows the operating system. [proof: W07 AS-06]
- **W07.B-06** Given any page, when the visitor presses Tab first, then "Skip to main content" receives focus. [proof: W07 AS-07]
- **W07.B-07** Given an unknown address, when it is requested, then the response is `404` and `<main>` shows "Page not found". [proof: W07 AS-09]
- **W07.B-08** Given a [client island](../terms/client-island.md) throws, when the page renders, then `<main>` shows "Something went wrong" and header and footer stay. [proof: W07 AS-10]
- **W07.B-09** Given a screen has no place for a failed API call, when the call answers with a [problem body ↗](../sw-external-terms.md#problem-json), then [`<ErrorState>`](../terms/error-state.md) shows text chosen by [status and code](../terms/error-code.md). [proof: W07 AS-13]
- **W07.B-10** Given the browser goes offline, when the event fires, then the [offline bar](../terms/offline-notice.md) shows. [proof: W07 AS-14]
- **W07.B-11** Given a document request, when the [proxy](../terms/web-proxy.md) runs, then the response carries [the policy](../terms/content-security-policy.md) and [`Reporting-Endpoints` ↗](../sw-external-terms.md#reporting-endpoints) header. [proof: W07 AS-16]
- **W07.B-12** Given the production build, when the [main journeys](../terms/main-journeys.md) run, then the browser reports zero [CSP violations ↗](../sw-external-terms.md#content-security-policy). [proof: W07 AS-17]
- **W07.B-13** Given `/terms`, when it renders, then it shows "Terms of service", "Last updated: 2026-10-11" and seven [sections](../terms/section.md). [proof: W07 AS-24] [code: packages/web/app/terms/page.tsx#TermsPage]
- **W07.B-14** Given a browser blocks content, when it [sends a report ↗](../sw-external-terms.md#csp-violation-report), then the endpoint logs [directive ↗](../sw-external-terms.md#csp-directive) and [blocked host](../terms/blocked-host.md) and answers `204`. [proof: W07 AS-21]
- **W07.B-15** Given an image host outside [the configured list](../terms/image-host-allow-list.md), when the [image component ↗](../sw-external-terms.md#next-image-component) runs, then the [optimiser ↗](../sw-external-terms.md#image-optimiser) does not render it. [proof: W07 AS-22]

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
- The widget checkout application (R-34, R-35) cannot yet identify a customer against the real S44 routes: the embed document's policy is `default-src 'none'` with no `connect-src`, so the browser refuses its call to `identify`, and `identify` answers `403 origin_not_allowed` to the embed document's own origin. The two end-to-end tests that need that call are marked blocked and switch on when S44 allows it (see `specs/web/W07-app-shell/questions.md`).
- Not shown by any screenshot or journey, because the app cannot be made to show them without a test hook: the error page, the root-error page, the access-denied and 503 states of `ErrorState` (no page uses them yet), toasts, and the header while its slots stream. They are covered by component tests (AS-10, AS-11, AS-13, AS-15).
- The API reference reads the description in the browser (one same-origin request, cached by the query client for 5 minutes and by the HTTP cache), not on the server with `"use cache"`: the placeholder and **Try again** states of AS-28 need the request to be the browser's.
- R-15 names the toast area with a proof (AS-15) but the code file `sonner.tsx` has no listed export.
- Only the account security page is walked with Back after sign-out (R-19's proof); the other signed-in areas rely on the same header rule.