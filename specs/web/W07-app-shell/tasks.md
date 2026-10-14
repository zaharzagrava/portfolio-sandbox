# Tasks: W07 — App shell and cross-cutting UI

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `data-model.md`, `research.md`, `quickstart.md`, `contracts/*` in `/opt/sdd/repo/specs/web/W07-app-shell/`. Constitution: `.specify/memory/constitution.md`.

**Tests**: required (test-plan.md has one row per AS). Order: failing test task → code task. Every task states the file; paths are under `packages/web` unless prefixed `packages/backend` / `packages/contracts`.

**Conventions**
- Read `packages/web/AGENTS.md` and the matching guide in `packages/web/node_modules/next/dist/docs/` (proxy, CSP, metadata, error handling, route handlers) before the first code task of each phase.
- Unit: `cd packages/web && pnpm exec vitest run <file>`. E2E: `pnpm exec playwright test tests/<file>` (only the spec for the page changed). Backend: `/opt/sdd/repo/scripts/sdd/test-spec.sh <pattern>`; after backend edits wait for `GET http://localhost:8000/health/ready`.
- Same test still red after 5 fix attempts → stop, write blocker + attempts + hypothesis into `questions.md`.
- Stand-ins for sibling slots carry the header `// Stand-in for the W0x contract: the owner replaces the body, never the name or props` (R-08). No sibling spec is edited; follow-ups live in `gaps.md` → `## Sibling-spec follow-ups` (already written).
- No `git checkout/restore/reset/stash/clean`. No new `sequelize.transaction` (no DB access in this feature; if a touched backend file has a `// S54 T037 audit` site, migrate it to `TransactionRunner.run` and delete the comment).
- No `dangerouslySetInnerHTML`, `eval`, `new Function`, string timers in shell code; no absolute API URLs; no `NEXT_PUBLIC_*` API address.

---

## Phase 1: Setup (test tooling — plan P0)

- [X] T001 Install dev dependencies with pnpm in `packages/web/package.json`: `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `@vitejs/plugin-react`, `msw`, `@axe-core/playwright`. Leave `packages/web/package-lock.json` alone (R-16).
- [X] T002 Widen `packages/web/vitest.config.ts`: `include` = `components/**`, `app/**`, `lib/**`, `hooks/**` `*.test.{ts,tsx}`; `exclude` `tests/**`; environment jsdom; React plugin; `setupFiles: ['./vitest.setup.ts']`.
- [X] T003 Create `packages/web/vitest.setup.ts`: jest-dom matchers, RTL cleanup after each test, MSW `setupServer` (listen/reset/close, `onUnhandledRequest: 'error'`), stubs for `matchMedia`, `BroadcastChannel`, `IntersectionObserver`, `ResizeObserver`. Add a smoke test `packages/web/lib/tooling.test.tsx` proving a `.tsx` component renders and MSW intercepts one `fetch`.
- [X] T004 [P] Edit `packages/web/playwright.config.ts`: projects `mobile` (390×844, touch) and `desktop` (1280×800); `expect.toHaveScreenshot` defaults (animations disabled, fixed threshold, `snapshotPathTemplate`); a second `webServer` entry (`pnpm build && pnpm exec next start`, separate port) used by `tests/security-headers.spec.ts`; keep dev server for the others.
- [X] T005 [P] Add helpers to `packages/web/tests/helpers.ts`: `expectNoCspViolations(page)` (collects `securitypolicyviolation` events and console CSP errors, asserts none), `gotoAtWidth(page, 'mobile' | 'desktop', path)`, `headersOf(request, path)`; reuse W01's `signOut` if present.
- [X] T006 [P] Edit `packages/web/eslint.config.mjs`: `no-restricted-imports`/`no-restricted-globals` for `fetch` and `axios` outside `lib/api/**` (constitution VII.1); fix or annotate existing violations only in files W07 touches; run `pnpm lint`.

---

## Phase 2: Foundational (blocks all stories)

- [X] T007 [P] Write failing `packages/web/lib/config.test.ts` (AS-18, AS-22, AS-34, FR-022, FR-051, FR-063): table over each host variable (`MEDIA_HOST`, `VIDEO_HOST`, `MAP_TILE_HOST`, `PAYMENT_PROVIDER_HOSTS`) — hosts must be exact `https://host[:port]`; wildcard, malformed, or non-HTTPS (outside development) throws with a message naming the variable; production without `SITE_URL` or with `http:` throws; `SOURCE_CODE_URL` ignored and logged once unless `https:`; image hosts derived from the same list as `img-src`; no wildcard host in production; `ALLOWED_ORIGINS` parsed to `allowedOrigins[]`.
- [X] T008 Implement `packages/web/lib/config-parse.ts` (zod, pure, usable from `next.config.ts`) and `packages/web/lib/config.ts` (`import 'server-only'`, parses once, fails fast). `Config` fields: `siteUrl`, `apiUrl`, `bffUrl`, `sseUrl`, `publicApiUrl` (defaults to `API_URL`), `mediaHosts[]`, `videoHosts[]`, `mapTileHost?`, `paymentProviderHosts[]`, `widgetAppBundleUrl` (default `/widget/v1/app.js`), `sourceCodeUrl?`, `allowedOrigins[]`, `isDev`. Local MinIO host allowed only in development. Make T007 pass.
- [X] T009 [P] Create `packages/web/lib/browser-storage-keys.ts` listing browser storage written by the app: theme key (`localStorage`), anonymous visitor cookie (W02), `__Host-bff-csrf` (W01), session cookie (HttpOnly, server-set). (Consumed by T066.)
- [X] T010 [P] Write failing `packages/web/lib/security/headers.test.ts` (AS-19, AS-20): table of `staticSecurityHeaders` (`X-Content-Type-Options: nosniff`; `X-Frame-Options: DENY`; `Referrer-Policy: strict-origin-when-cross-origin`; `Permissions-Policy: camera=(), microphone=(), payment=(), geolocation=(self)`; `Cross-Origin-Opener-Policy: same-origin-allow-popups`; production-only `Strict-Transport-Security: max-age=63072000; includeSubDomains`); `noReferrerPaths` = `/reset-password`, `/invites/*` resolve to exactly `no-referrer` (one effective `Referrer-Policy` value); `noStorePaths` cover `/dashboard/**`, `/account/**`, `/checkout/**`, `/cart`, `/chat`, `/admin/**`, `/invites/**` (+ `/api/`) and equal the robots disallow list.
- [X] T011 Implement `packages/web/lib/security/headers.ts` exporting `staticSecurityHeaders`, `noReferrerPaths`, `noStorePaths`; the general `Referrer-Policy` rule excludes `noReferrerPaths` by its `source` pattern. Make T010 pass.

**Checkpoint**: tooling, config, header definitions green (`pnpm exec vitest run lib/config.test.ts lib/security/headers.test.ts`).

---

## Phase 3: User Story 3 — Browser locked down without breaking the product (P1) 🎯 MVP (security core, plan P1)

**Goal**: strict per-response nonce CSP, static headers, per-path additions, report endpoint.
**Independent test**: `tests/security-headers.spec.ts` on a production build + `csp.test.ts`/`proxy.test.ts` + csp-reports e2e.

### Tests
- [X] T012 [P] [US3] Write failing `packages/web/lib/security/csp.test.ts` (AS-16, AS-18): table per directive per contracts/security-headers.md; nonce ≥128 random bits base64, new per call; no `unsafe-inline` in `script-src`; `'strict-dynamic'`; dev adds `'unsafe-eval'` and `ws:`/`wss:` only; `frame-ancestors 'none'`; `upgrade-insecure-requests` production only; `report-uri`/`report-to` `/api/csp-reports`; map host in `img-src`; payment hosts in `script-src`/`connect-src`/`frame-src` only for `/checkout/pay/*`; exact hosts only.
- [X] T013 [P] [US3] Write failing `packages/web/proxy.test.ts` (AS-16): sets `Content-Security-Policy` and `x-nonce` on the request and CSP, `Reporting-Endpoints: csp-endpoint="/api/csp-reports"` on the response; matcher excludes `_next/static`, `_next/image`, `favicon.ico`, `health`, `widget`, `api`, prefetches; no redirect, no status decision.
- [X] T014 [P] [US3] Write failing `packages/web/tests/security-headers.spec.ts` (suite `W07 security headers`, production build): "every document response carries a nonce policy" (pages, 404, error page; 100 responses → 100 distinct nonces, AS-16); "main journeys raise no CSP violation" with `expectNoCspViolations` around browse, product, search, theme switch, toast, docs viewer, error page (AS-17); "payment hosts only on /checkout/pay" (AS-18); "static headers present; no-referrer on reset and invites; no X-Powered-By" (AS-19); "signed-in areas are no-store; public pages are not" (AS-20); "policy names the same-origin report endpoint" (AS-21).
- [X] T015 [P] [US3] Write failing backend e2e `packages/backend/test/csp-reports.e2e-spec.ts` (real app pipeline, supertest; pattern name `csp-reports`): both `application/csp-report` and `application/reports+json` → `204` and a log entry with directive and blocked host (scheme+host only); garbage body → `204`; empty/oversized body → `204`; wrong content type → `204`; over-limit behaviour per S54 throttle; log never contains the document URL query. Place beside the existing platform-toolkit e2e specs (check `packages/backend/test` layout first).
- [X] T016 [P] [US3] Add csp-report schema (lenient) to `packages/contracts/src/` (follow the package's existing layout and `.ts` import-extension convention) and export it from the package index.

### Implementation
- [X] T017 [US3] Implement `packages/web/lib/security/csp.ts`: `buildCsp({ nonce, pathname, isDev, hosts }): string`, pure; directives exactly as in `contracts/security-headers.md`. Make T012 pass.
- [X] T018 [US3] Implement `packages/web/proxy.ts` (Next 16 name for middleware; read the Next CSP guide): generate nonce (`crypto.getRandomValues`, 16+ bytes, base64), call `buildCsp` with `config` hosts, set request + response headers, no authorization decision (FR-020, VI.5). Make T013 pass.
- [X] T019 [US3] Edit `packages/web/next.config.ts`: `headers()` from `lib/security/headers.ts`; `poweredByHeader: false`; `images.remotePatterns` from `config` (remove `*.amazonaws.com` and `images.unsplash.com`); `serverActions.allowedOrigins` from `ALLOWED_ORIGINS` (remove hard-coded values); fix the wrong "experimental Partial Prerendering" comment; keep `/account` → `/account/security` redirect (W01 request) and `/admin` redirect; add rewrite `/api/developers/openapi.json` → `${PUBLIC_API_URL}/docs-json` before the generic `/api/:path*` rule. Do not touch other rewrites.
- [X] T020 [US3] Edit `packages/web/lib/providers.tsx`: pass `nonce` (read from the `x-nonce` request header in a dynamic leaf of the root layout) to `next-themes` (R-05, AS-06/AS-17). Make every runtime-data-outside-`Suspense` build error disappear by wrapping the dynamic part in `Suspense` (R-02); do not weaken the policy. Run `pnpm build`.
- [X] T021 [US3] Check `packages/web/lib/api/client.ts` for an absolute-origin fallback (R-09): if calls still fall back to `NEXT_PUBLIC_API_URL || 'http://localhost:3000'`, change only that fallback to same-origin relative URLs (leave the in-memory token to W01; follow-up already in gaps.md).
- [X] T022 [US3] Implement `POST /api/csp-reports` in `packages/backend` (platform-toolkit area, anonymous, accepts the three content types, lenient parse using T016 schema, logs directive + blocked host only, always `204`, S54 throttle, no DB, no transaction). Make T015 pass: `/opt/sdd/repo/scripts/sdd/test-spec.sh csp-reports`.
- [X] T023 [US3] Run `pnpm exec vitest run lib/security proxy.test.ts` then `pnpm exec playwright test tests/security-headers.spec.ts` (journeys depending on later phases may stay red until Phase 4–9; record which).

**Checkpoint**: US3 header/CSP proof green except journeys that need pages from later phases.

---

## Phase 4: User Story 7 — Cross-cutting data rules (P2, plan P2) — placed early because layout depends on providers

**Goal**: query-client defaults, domain-first query keys, route-template page views, boundaries.
**Independent test**: Vitest files below; `/api/events` interception in app-shell spec.

### Tests
- [X] T024 [P] [US7] Write failing `packages/web/lib/providers.test.tsx` (AS-36, AS-14, AS-06): table of retry decisions by status — network and 5xx retry at most 2 times; 400, 401, 403, 404, 409, 422 never; mutations never retry; `staleTime`; one client per tab; a new client per server request; refetch active failed queries once on `online`; theme bootstrap carries the nonce prop.
- [X] T025 [P] [US7] Write failing `packages/web/lib/query-keys.test.ts` (AS-36): every key is an array starting with a domain name; no duplicate keys; `queryKeys.developers.openapi` exists.
- [X] T026 [P] [US7] Write failing `packages/web/lib/routes/page-name.test.ts` (AS-35, R-11): table — ids, tokens, query, fragment, trailing slash, unmatched → `/not-found`, root error → `/error`, very long path (`page` ≤ 500 characters, never contains id/token/query/fragment); templates `/products/:slug`, `/invites/:token`, `/checkout/pay/:orderId`, `/search`, `/reset-password`; plus a test that globs `app/**/page.tsx` and fails when a page has no template.
- [X] T027 [P] [US7] Write failing `packages/web/components/analytics/page-view.test.tsx` (AS-35): one `track({name:'page_view', page})` per navigation (first load and in-app), none when `track` reports tracking off (GPC/DNT).
- [X] T028 [P] [US7] Write failing `packages/web/lib/shell-boundaries.test.ts` (AS-37): static scan of shell files — no absolute URLs, no `NEXT_PUBLIC_*` API address, no `localStorage`/`document.cookie` writes except the theme key, no `dangerouslySetInnerHTML`/`eval`/`new Function`/string timers (FR-025).
- [X] T029 [P] [US7] Write failing `packages/web/app/boundaries.test.ts` (AS-38): layout, footer, legal pages, docs page contain no `"use client"`; each client file in the shell is on the leaf list (`mobile-menu`, `theme-control`, `search-row`, `offline-notice`, `route-focus`, `page-view`, `error.tsx`, `global-error.tsx`, `ErrorState`, docs `reference`, `checkout-app`, `lib/providers.tsx`).

### Implementation
- [X] T030 [US7] Implement query-client defaults in `packages/web/lib/providers.tsx` (per T024; browser singleton, per-request on server; `refetchOnReconnect` once for failed active queries). Make T024 pass.
- [X] T031 [US7] Edit `packages/web/lib/query-keys.ts`: domain-first keys (`products.search` etc., coordinate rename only where no sibling relies on it; W01 renames `auth.*`), add `developers.openapi`. Make T025 pass.
- [X] T032 [US7] Implement `packages/web/lib/routes/page-name.ts`: `pageNameFor(pathname: string, matchedTemplate?: string): string` with a static template list. Make T026 pass.
- [X] T033 [US7] Create stand-in `packages/web/lib/analytics/track.ts` (`track`, posts `page_view` to `/api/events`; W02 replaces; skip if W02 already created it) and `packages/web/components/analytics/page-view.tsx` (client leaf using `usePathname`, template via `pageNameFor`, drops query/fragment). Make T027 pass.
- [X] T034 [US7] Run T028 and T029 scans; fix violations only in W07-owned files (they stay red until Phases 5–9 land; re-run in T097).

**Checkpoint**: `pnpm exec vitest run lib components/analytics`.

---

## Phase 5: User Story 1 — Same trustworthy frame on every page (P1, plan P3)

**Goal**: layout, skip link, focus, header (desktop/mobile), theme, search row, footer, slots.
**Independent test**: `tests/app-shell.spec.ts` frame journeys + RTL files.

### Tests
- [X] T035 [P] [US1] Write failing `packages/web/components/layout/navbar.test.tsx` (AS-01, AS-04, AS-32, AS-38): desktop slot order logo → `nav "Main"` (Browse, Developers) → search → assistant → theme → cart → bell (members) → account; `banner` and labelled `navigation`; cart link always present; bell and chat badge absent for visitors with MSW asserting zero calls; account-slot fallback has the account button's exact size; a throwing slot renders nothing and the header survives; icon-only controls have accessible names, `aria-current`, decorative icons hidden; a cart change re-renders only the cart slot (render counters).
- [X] T036 [P] [US1] Write failing `packages/web/components/layout/mobile-menu.test.tsx` (AS-02): entries order (account entries first via `MobileAccountEntries`, then Chats, Developers, assistant item, Browse, Cart per spec AS-02), focus moves in and returns, Escape closes, closes on route change, Back closes; button named "Open menu" with `aria-expanded`.
- [X] T037 [P] [US1] Write failing `packages/web/components/layout/search-row.test.tsx` (AS-03): button hidden on `/` and `/search`; row opens with focus in the input; Escape and **Close search** return focus; no keyboard shortcut advertised.
- [X] T038 [P] [US1] Write failing `packages/web/components/layout/theme-control.test.tsx` (AS-06): menu items Light/Dark/System with checked state, default System, persisted value under the key from `browser-storage-keys.ts`, labelled control.
- [X] T039 [P] [US1] Write failing `packages/web/components/layout/skip-link.test.tsx` and `route-focus.test.tsx` (AS-07, FR-007): skip link first focusable, moves focus to `main#main-content`; focus to new `h1` (fallback `main`) only after client-side navigation, not on first load, not on hash or search-param change.
- [X] T040 [P] [US1] Write failing `packages/web/app/layout.test.tsx` (AS-07, FR-001): exactly one `banner`, one `main` (`id="main-content"`, `tabIndex=-1`), one `contentinfo`; order skip link, header, main, footer, toaster, offline region.
- [X] T041 [P] [US1] Write failing `packages/web/components/layout/footer.test.tsx` (AS-08, FR-006): sentence, labelled "Footer" navigation (Browse, API docs, Terms, Privacy), **Source code** only for an `https:` configured address (table: unset, `http:`, `javascript:`, `https:`), `rel` + new-tab announcement, current year.
- [X] T042 [P] [US1] Write failing `packages/web/components/layout/motion.test.tsx` (AS-33): reduced-motion media query disables sheet and toast animations (computed `transition`/`animation` none).
- [X] T043 [P] [US1] Write failing `packages/web/tests/app-shell.spec.ts` frame tests (suite `W07 app shell`): header at desktop (anonymous + member; scroll keeps header; focused link not hidden), mobile menu opens/lists account entries first/closes on navigation, admin sees Admin in account menu (AS-05), theme choice applies at once and survives reload, skip link first and moves focus / in-app navigation focuses new h1, footer links reach terms/privacy/docs.

### Implementation
- [X] T044 [P] [US1] Create sibling stand-ins at their contract paths with the stand-in header comment (R-08): `components/auth/account-slot.tsx` (`AccountSlot`, `AccountSlotSkeleton` exact account-button size, `MobileAccountEntries`; wraps today's `useAuth` UI; Admin entry when `isAdmin(user)`), `lib/admin/is-admin.ts` (if absent), `components/search/search-box.tsx` (`SearchBox variant="navbar"`, renders nothing on `/` and `/search`), `components/cart/cart-badge.tsx` (`CartBadge`, name "Cart"/"Cart, {n} items", reads existing cart count), `components/chat/assistant-launcher.tsx` (`AssistantLauncher variant="icon" | "menu-item"` wrapping the existing assistant sheet trigger), `lib/problem.ts` `problemFromError` returning `Problem = {status, code, errors[], retryAfterSeconds, requestId}` if absent. Reuse existing files where they already exist; do not rename them.
- [X] T045 [US1] Implement `packages/web/components/layout/skip-link.tsx` and `route-focus.tsx` (client leaf). Make T039 pass.
- [X] T046 [US1] Implement `packages/web/components/layout/theme-control.tsx` (client leaf; Light/Dark/System dropdown; CSS handles reduced motion). Make T038 pass.
- [X] T047 [US1] Implement `packages/web/components/layout/search-row.tsx` (client leaf). Make T037 pass.
- [X] T048 [US1] Implement `packages/web/components/layout/mobile-menu.tsx` (client leaf; sheet, "Open menu", `aria-expanded`, closes on route change). Make T036 pass.
- [X] T049 [US1] Rewrite `packages/web/components/layout/navbar.tsx` as a Server Component with the leaf islands; logo with accessible name; `nav "Main"`; slots inside `Suspense` with fixed-size fallbacks and an error boundary so a throwing slot renders nothing; remove `toggle-assistant` event, the ⌘K hint and the no-op search button; breakpoints ≤ 640 px mobile / ≥ 1024 px desktop; sticky with scroll padding ≥ header height. Make T035 pass.
- [X] T050 [US1] Rewrite `packages/web/components/layout/footer.tsx` (Server Component; Source code link from `config.sourceCodeUrl`). Make T041 pass.
- [X] T051 [US1] Edit `packages/web/app/layout.tsx`: skip link, header, `<main id="main-content" tabIndex={-1}>`, footer, toaster region, offline notice region, `PageView`, `RouteFocus`; `viewport`; `metadata` with title template `"{Page} · Marketplace"` default "Marketplace", `metadataBase` from `config.siteUrl`; remove the layout-level `<AssistantSheet />` mount. Make T040, T042 pass.
- [X] T052 [US1] Run `pnpm exec vitest run components/layout app/layout.test.tsx` and `pnpm exec playwright test tests/app-shell.spec.ts -g "header|menu|theme|skip|footer|Admin"` on both projects.

**Checkpoint**: US1 independently testable.

---

## Phase 6: User Story 2 — Missing, slow or broken states (P1, plan P4)

**Goal**: not-found, error, global-error, loading, access denied, `ErrorState`, offline, toasts.
**Independent test**: RTL files + `tests/app-shell.spec.ts` unknown-address and slow-page tests.

### Tests
- [X] T053 [P] [US2] Write failing `packages/web/app/not-found.test.tsx` and `components/layout/system-states.test.tsx` (AS-09): heading, text, actions, title "Page not found · Marketplace", `noindex`, path never rendered (hostile and very long path table); custom `NotFoundState({title?, description?, actions?})` copy.
- [X] T054 [P] [US2] Write failing `packages/web/app/error.test.tsx` (AS-10, FR-011/012): copy; reference line only when `digest` exists; **Try again** calls `reset`; focus to heading on each failure; no message/stack/URL/SQL rendered (table of thrown values incl. a leaking message).
- [X] T055 [P] [US2] Write failing `packages/web/app/global-error.test.tsx` (AS-11): own `html lang`/`body`, copy, buttons, one `h1`, touch targets, no dependency on providers.
- [X] T056 [P] [US2] Write failing `packages/web/app/loading.test.tsx` and `components/layout/page-skeleton.test.tsx` (AS-12, FR-013): `aria-busy`, single `status` "Loading…", no placeholder before 150 ms (fake timers), `PageSkeleton variant 'detail' | 'list' | 'form'`.
- [X] T057 [P] [US2] Write failing `packages/web/components/layout/error-state.test.tsx` (AS-13): table over `401` (renders nothing), `403` (access denied: "You don't have access", text, **Go to home**), `404` (not-found state), `409` (+ **Reload**), `422`/other `4xx` (W01 fallback "Something didn't work. Check the details and try again."), `429` with Retry-After 59 s, 60 s, 3599 s, 3600 s, missing (wait text exactly W01 FR-041; controls re-enabled by timer), `502`/`503` ("This part of the marketplace is temporarily unavailable. Try again in a moment." + **Try again** + reference), other `5xx`/network/non-problem body with and without `requestId`; `title`/`detail` never rendered.
- [X] T058 [P] [US2] Write failing `packages/web/components/layout/offline-notice.test.tsx` (AS-14): `online`/`offline` events drive the `role="status"` bar "You're offline. Some things may not load or save until you're back online.", then "Back online." for 3 s and removed; header not pushed; one instance, no polling.
- [X] T059 [P] [US2] Write failing `packages/web/components/ui/toaster.test.tsx` (AS-15): one area, max 3 visible, politeness per kind, 5 s auto-dismiss for success/info with pause on hover/focus, error and action toasts persist, **Dismiss**, markup rendered as text.
- [X] T060 [P] [US2] Add failing journeys to `packages/web/tests/app-shell.spec.ts`: "unknown address shows the not-found page inside the frame" (status 404), "slow page keeps header and footer and shows a placeholder" (`page.route` delay).

### Implementation
- [X] T061 [US2] Implement `packages/web/components/layout/system-states.tsx` (`NotFoundState`, `ErrorState({problem?, reference?, onRetry?})` text from status + stable `code` only, `AccessDeniedState`) and `components/layout/page-skeleton.tsx`. Make T053 (system-states part), T056 (skeleton part), T057 pass.
- [X] T062 [US2] Implement `packages/web/app/not-found.tsx`, `error.tsx` (client, shows `error.digest`), `global-error.tsx`, `loading.tsx` (150 ms delay). Make T053–T056 pass; also confirm `app/products/[slug]/loading.tsx` still works.
- [X] T063 [P] [US2] Implement `packages/web/components/layout/offline-notice.tsx` (client leaf) and the single `sonner` `<Toaster />` in `lib/providers.tsx` (`visibleToasts` 3, 5 s, persistent errors/actions, `closeButton`, text only, R-12). Make T058, T059 pass.
- [X] T064 [US2] Run `pnpm exec vitest run app components/layout components/ui` and `pnpm exec playwright test tests/app-shell.spec.ts -g "not-found|slow page"`.

---

## Phase 7: User Story 4 — Legal pages (P2, plan P6)

**Goal**: `/privacy`, `/terms` with sections, anchors, on-this-page, metadata.
**Independent test**: page tests + footer journeys.

### Tests
- [X] T065 [P] [US4] Write failing `packages/web/app/privacy/page.test.tsx` and `app/terms/page.test.tsx` (AS-23, AS-24, AS-26): one `h1` ("Privacy policy"/terms title), "Last updated: {date}" constant, sections with `h2` and anchor ids (privacy: What we store, Cookies and browser storage, Who receives data, Your choices, Contact — copy per spec AS-23), `metadata.title` "{Page} · Marketplace", indexable.
- [X] T066 [P] [US4] Write failing `packages/web/app/privacy/cookies.test.ts` (AS-23, FR-053): every cookie and storage key in `lib/browser-storage-keys.ts` appears in the privacy cookie section.
- [X] T067 [P] [US4] Write failing `packages/web/components/legal/on-this-page.test.tsx` (AS-25): link per section, focus + hash go to the heading, disclosure collapsed at mobile markup.
- [X] T068 [P] [US4] Add failing journeys to `packages/web/tests/app-shell.spec.ts`: "privacy page reachable from the footer", "terms page reachable from the footer".

### Implementation
- [X] T069 [US4] Implement `packages/web/components/legal/on-this-page.tsx` (sticky rail desktop, disclosure mobile) and rewrite `packages/web/app/privacy/page.tsx` and `app/terms/page.tsx` as static Server Components (no data request, no new dependency, no MDX). Make T065–T067 pass. Content must be true for the running system (FR-053).

---

## Phase 8: User Story 5 — Developer docs (P2, plan P7) and OpenAPI route (plan P9)

**Goal**: read-only API reference in the shared frame; same-origin data route.
**Independent test**: `tests/developer-docs.spec.ts`, `reference.test.tsx`, backend openapi e2e.

### Tests
- [X] T070 [P] [US5] Write failing backend e2e `packages/backend/test/developers-openapi.e2e-spec.ts` (pattern `openapi`): `GET /api/developers/openapi.json` → `200 application/json`, parsed by `openApiDocumentSchema` (`openapi` starts with `3.`, `paths` object); error → problem+json via the global filter; anonymous.
- [X] T071 [P] [US5] Add `openApiDocumentSchema` to `packages/contracts/src/` and export (zod; passthrough of unknown fields; `info`, `paths`, `tags?`, per-operation `x-scope`/`security`, `deprecated`).
- [X] T072 [P] [US5] Write failing `packages/web/app/developers/docs/reference.test.tsx` (AS-27..AS-30; MSW fixture): sections grouped by tag, scopes, deprecated mark with sunset and replacement, one `h1`, heading nesting; placeholder `aria-busy`; failure and invalid-body states with **Try again** replacing in place; reference line only with `requestId`; no "Try it out", no form, **Copy** announces "Copied"; expanders are buttons with `aria-expanded`; "Operations" navigation labelled; description markdown rendered without raw HTML, links validated to `http:`/`https:`.
- [X] T073 [P] [US5] Write failing `packages/web/tests/developer-docs.spec.ts` (suite `W07 developer docs`): "operations are listed, expand and collapse"; "page makes one data request and has no try-it-out" (request log); "viewer chunk is not downloaded by other pages" (visit `/`, assert no request for it, SC-007). Use `page.route` fixture only for unavailable-state tests (R-07).
- [X] T074 [P] [US5] Write failing unit test for `getOpenApiDocument` in `packages/web/lib/api/developers.test.ts`: same-origin URL `/api/developers/openapi.json`, validated with the contracts schema, invalid body → typed failure, no absolute API address.

### Implementation
- [X] T075 [US5] Implement `GET /api/developers/openapi.json` in `packages/backend` (public API area/core app so the dev stack at :8000 answers; same content as public-api `docs-json`; global filter for errors). Make T070 pass: `/opt/sdd/repo/scripts/sdd/test-spec.sh openapi`; wait for `/health/ready`.
- [X] T076 [US5] Add `getOpenApiDocument()` to `packages/web/lib/api/developers.ts` (server cache ≤ 5 min via `"use cache"` with explicit lifetime, validated before use); use `queryKeys.developers.openapi`. Make T074 pass.
- [X] T077 [US5] Create read-only viewer `packages/web/app/developers/docs/reference.tsx` (client leaf, dynamic import on this route only; `react-markdown` without raw HTML; link scheme validation). Rewrite `packages/web/app/developers/docs/page.tsx` as a Server Component (no nested `<main>`/`<header>`, no hard-coded origin, title "API reference · Marketplace" or per spec AS-27). Remove `swagger-ui-react` from `packages/web/package.json` and delete its imports/CSS. Make T072, T073 pass.
- [X] T078 [US5] Run `pnpm exec playwright test tests/developer-docs.spec.ts` and `pnpm exec vitest run app/developers lib/api`.

---

## Phase 9: User Story 7 (rest) — Document metadata and robots (P2, plan P6)

- [X] T079 [P] [US7] Write failing `packages/web/app/robots.test.ts` (AS-34, FR-052): disallow list equals `noStorePaths`; private areas and not-found send `noindex`.
- [X] T080 [US7] Implement `packages/web/app/robots.ts` from `noStorePaths` and `config.siteUrl`. Make T079 pass.
- [X] T081 [US7] Add failing then passing journeys to `packages/web/tests/app-shell.spec.ts`: "titles follow the pattern and robots lists private areas" (`/`, `/privacy`, 404; `GET /robots.txt`), "navigating the site reports page names, never addresses" (intercept `/api/events`; `/`, `/products/:slug`, `/invites/:token`, `/not-found`), "Back after sign-out shows no private content" (AS-20, reuse W01 `signOut`).

---

## Phase 10: User Story 6 — Usable by everyone, on every device (P2)

- [X] T082 [P] [US6] Add to `packages/web/tests/app-shell.spec.ts`: "no horizontal scroll at 320 px on frame, legal pages, docs, not-found" (`scrollWidth <= clientWidth`, AS-31); "keyboard walk of header and footer follows the order; menus return focus on Escape" (AS-32); `@axe-core/playwright` scan of `/`, `/privacy`, `/terms`, `/developers/docs`, not-found at 320/390/1280 px in light and dark — 0 serious/critical (SC-001, AS-33 contrast).
- [X] T083 [US6] Fix accessibility findings (labels, names, focus ring, contrast tokens, touch targets ≥ 44 px, single `h1`, heading levels, `role="status"`/`alert`) in W07-owned components only; re-run `pnpm exec playwright test tests/app-shell.spec.ts`.

---

## Phase 11: User Story 8 — Widget checkout application (P3, plan P5)

### Tests
- [X] T084 [P] [US8] Write failing `packages/web/lib/widget/messages.test.ts` (AS-40): table — wrong source, wrong origin, malformed payload ignored silently; `targetOrigin` is the registered host origin, never `"*"`; `marketplace:identity { token }` accepted only if `event.source === window.parent` and `event.origin === registeredHostOrigin`; `marketplace:need-identity` and `marketplace:close` posted to the registered origin.
- [X] T085 [P] [US8] Write failing `packages/web/components/widget/checkout-app.test.tsx` (AS-40): states "Checking your details…" (`aria-busy`) → "Signed in as {email}" (e-mail as text) · "Continue as guest" · failure text "We couldn't open checkout. Close this window and try again." for `422`, `410`, `403`, `404`; Close and Escape post `marketplace:close`.
- [X] T086 [P] [US8] Write failing `packages/web/tests/widget-embed.spec.ts` (suite `W07 widget checkout application`): "bundle is served cross-origin with correct headers" (`Content-Type: application/javascript`, `Cache-Control: public, max-age=31536000, immutable`, `Cross-Origin-Resource-Policy: cross-origin`, `X-Content-Type-Options: nosniff`); "iframe application identifies the customer and closes" (test host page).

### Implementation
- [X] T087 [US8] Implement `packages/web/lib/widget/messages.ts` (pure, no `eval`). Make T084 pass.
- [X] T088 [US8] Implement `packages/web/components/widget/checkout-app.tsx` (client leaf) using S44 `identify`. Make T085 pass.
- [X] T089 [US8] Add the esbuild script `build:widget` in `packages/web/package.json` and `app/widget/v1/app.js/route.ts` serving the built script with the T086 headers; URL from `config.widgetAppBundleUrl`; excluded from the proxy matcher. Make T086 pass.

---

## Phase 12: User Story 9 — Liveness (P3)

- [X] T090 [P] [US9] Write failing `packages/web/app/health/route.test.ts` (AS-41): `200 {"status":"ok"}`, `Cache-Control: no-store`, no outbound call.
- [X] T091 [US9] Implement `packages/web/app/health/route.ts`. Make T090 pass.

---

## Phase 13: Polish, visual and close-out (plan P8, P10)

- [X] T092 [P] Write `packages/web/tests/app-shell.visual.spec.ts` (top-level `describe('W07 app shell layout')`) with the screenshot rows of test-plan.md (header anonymous/member light+dark, header while slots load, mobile menu open, 320 px, search row, first paint dark, skip link focus, footer mobile/desktop, not-found, error, global-error, loading skeleton, access-denied and 503, offline bar, toasts, `/privacy`, `/terms`, legal rail/disclosure, docs desktop/mobile/unavailable, focus rings); generate baselines and review them by eye.
- [X] T093 Verify `specs/web/W07-app-shell/quickstart.md` "Ops artifacts" lists SC-004, SC-005, SC-006 (each with how-to-run) and that `specs/UNVERIFIED.md` has one row each (spec W07, criterion, how to run, status `not run`). Add any missing row; never describe them as verified.
- [X] T094 Verify every SC has an automated proof or an Ops row: SC-001 (axe T082), SC-002 (T014), SC-003 (T014), SC-007 (T073), SC-008 (T081), SC-009 (T081). Add Ops rows for any not proven.
- [X] T095 Update `docs/work/architecture/pattern-map.md`: P0502 and P0903 rows set to `planned` (docs file only; no spec edited). Resolved: rows already list W07 and read `implemented` (the map has no `planned` status); kept as is, see questions.md "RESOLVED (agent decision)".
- [X] T096 Confirm `gaps.md` coverage: every item A–G has a completed task above (A → T035–T051, T053–T063; B → T017–T021, T080, T089, T091; C → T069, T076–T077; D → T030–T031; E → T022, T075; F → T001–T006, T028–T029; G → `## Sibling-spec follow-ups` present and unchanged). Fix `gaps.md` only to append the sibling bullets still missing.
- [X] T097 Final runs, once: `cd packages/web && pnpm lint && pnpm exec tsc --noEmit && pnpm test`; `pnpm exec playwright test` (all W07 specs, both projects); `/opt/sdd/repo/scripts/sdd/test-spec.sh csp-reports` and `... openapi`; then the backend capability suite. Record results honestly in `questions.md` if anything stays red.

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 → everything else. Phase 3 (US3) needs Phase 2; Phase 4 (US7 data rules) needs Phase 1; Phases 5, 6, 11, 12 need Phases 2–4 and are mutually independent after that (US1 layout T051 integrates US2 regions, so land T061–T063 before T051's journeys go green). Phase 7 (US4) needs T009 and T051. Phase 8 (US5) needs T019 (rewrite) and T051; T070–T071/T075 (backend) can start after Phase 1. Phase 9 needs T011 and T051. Phase 10 needs Phases 5–8. Phase 13 last.
- Within a story: failing test → implementation → run narrowest test.

## Parallel examples

- Phase 5 tests T035–T043 touch distinct files: run in parallel; stand-ins T044 in parallel with them.
- Phase 3: T012–T016 in parallel; backend T015/T022 independent of web tasks.
- Phase 8: backend T070/T071/T075 in parallel with web T072–T074.

## Implementation strategy

MVP = Phases 1–3 (+ Phase 5/6 minimal frame so journeys exist): tooling, config, headers, nonce CSP, report endpoint. Then US1 frame and US2 states (both P1), then P2 stories (US7, US4, US5, US6), then P3 (US8, US9), then visuals and close-out.

## Notes

- Test tasks per AS: AS-01..08 T035–T043; AS-09..15 T053–T060; AS-16..22 T012–T016; AS-23..26 T065–T068; AS-27..30 T070–T074; AS-31..33 T042, T082; AS-34..38 T024–T029, T079, T081; AS-39..40 T084–T086; AS-41 T090.
- Commit after each logical group; end commit messages with the attribution line required in this session.

---

## Phase 14: Convergence

- [X] T098 Run the W07 browser specs the close-out never ran, on a fresh stack, one file at a time (`tests/security-headers.spec.ts`, `tests/widget-embed.spec.ts`, `tests/developer-docs.spec.ts`, `tests/app-shell.prod.spec.ts`), and fix or record in `questions.md` any failure per AS-16..AS-20, AS-27..AS-30, AS-39..AS-40 (partial)
- [X] T099 Run the full backend capability suite once (`/opt/sdd/repo/scripts/sdd/test-spec.sh`, in batches) and `python3 scripts/livespec/check.py`; record results in `questions.md` per T097 (partial)
- [X] T100 For the `pnpm lint` errors and W03 `refCode`/AS-34 test failures the close-out reported in other capabilities' files, add one bullet each under `## Sibling-spec follow-ups` in `gaps.md` naming the owner (W01, W03, W05, seller); fix only what sits in files W07 touched (partial)
