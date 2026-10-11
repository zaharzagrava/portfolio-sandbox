# Tasks: W02 — Storefront discovery (`packages/web` + the backend pieces it needs)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `data-model.md`, `research.md`, `contracts/`, `quickstart.md` in `specs/web/W02-storefront-discovery/`.
**Tests**: requested (constitution VII, `test-plan.md`). Every test-plan row gets a failing-test task **before** its code task. Paths are relative to `packages/web/` unless they start with `packages/` or `specs/`.
**Rules for every task**: read `packages/web/AGENTS.md` and the matching guide in `packages/web/node_modules/next/dist/docs/` before writing Next code. Run only the narrowest test (`pnpm exec vitest run <file>`, `pnpm exec playwright test tests/<file>.spec.ts`, backend `/opt/sdd/repo/scripts/sdd/test-spec.sh <spec>`); after backend edits wait for `GET http://localhost:8000/health/ready` = 200. Never use git checkout/restore/reset/stash/clean; undo by editing by hand. No new direct `sequelize.transaction` (use `TransactionRunner.run`/`@Transactional`; migrate and delete any `// S54 T037 audit` site in a touched file). If one test still fails after 5 fix attempts, stop and write the blocker, attempts and hypothesis into `specs/web/W02-storefront-discovery/questions.md`.

## Format: `- [ ] Txxx [P?] [US?] Description with path`

- **[P]**: different files, no dependency on an unfinished task. **[USn]** maps to spec.md user stories: US1 Home · US2 Suggestions · US3 Search results · US4 Pickup in search · US5 Product page · US6 Pickup on product · US7 Discussions · US8 Ask · US9 Share/referral · US10 Videos and sponsored · US11 Visitor events · US12 Rendering/safety/a11y rules.

---

## Phase 1: Setup (tooling and static guards)

- [X] T001 Add dependencies in `packages/web/package.json`: `dompurify` (+ `@types/dompurify` only if the bundled types are absent), `maplibre-gl`, `hls.js`; verify `server-only`, `msw`, `@testing-library/{react,user-event,jest-dom}`, `@vitejs/plugin-react`, `@axe-core/playwright` are present (gaps G1, G2, G9) and install with the repo's package manager
- [X] T002 Widen `vitest.config.ts` `include` to `lib/**`, `hooks/**`, `components/**`, `app/**` for `*.test.ts(x)`; extend `vitest.setup.ts` with jest-dom matchers, MSW server start/reset/close, `matchMedia`, `IntersectionObserver`, geolocation and clipboard stubs (gaps G3); add `lib/test/msw-handlers.ts` with problem+json fixtures parsed with `packages/contracts` schemas
- [X] T003 [P] Playwright: add a `mobile` project (390×844) and the `tests/visual/` config with `toHaveScreenshot` defaults, animations disabled, and an axe helper (serious/critical = 0) in `playwright.config.ts` and `tests/visual/axe.ts` (gaps G4)
- [X] T004 [P] Add `grantLocation(page, lat, lng)` and rewrite `productId()` to read `items[].title` (S32) in `tests/helpers.ts` (gaps G5)
- [X] T005 Write `lib/storefront/architecture.test.ts` (U-arch) with its rules failing first: no `fetch`/`axios`/`EventSource` in `components/`, `hooks/`, `app/**/page|layout.tsx`; no `NEXT_PUBLIC_API_URL`; no `Authorization` or storage access in W02 files; pages/layouts are Server Components and client files are leaves with plain-field props; `dangerouslySetInnerHTML` only in sanitizer output and JSON-LD; no array index as key; no new Context/store; no `"use cache"` function reads cookies/headers; `sanitizeBodyHtml` not imported from a Server Component (AS-69..AS-72, AS-76; gaps A8, G11)
- [X] T006 Raise ESLint in `eslint.config.mjs`: `no-restricted-globals` (fetch/EventSource) and axios imports to **error** for `components/`, `hooks/`, `app/**/page.tsx|layout.tsx`; restrict `dangerouslySetInnerHTML` and `NEXT_PUBLIC_API_URL`; allow `lib/api`, `lib/server`, `app/api` (gaps A8)

---

## Phase 2: Foundational (blocks every story)

**No story starts before this phase is green.**

- [X] T007 [P] Write contract tests in `packages/contracts` that parse a real controller response for each new schema (B-7, gaps G10/H7): `fulfilment/pickup.ts` (`pickupNearSearchResponseSchema`, `pickupPointsNearResponseSchema`, `pickupClustersResponseSchema`), `community/discussions.ts` (`postViewSchema`, `commentViewSchema`, `postPageSchema`, `commentThreadPageSchema`, `commentRepliesPageSchema`, `voteResultSchema`), `assistant/ask.ts` (`ragStreamEventSchema`), `marketing/share.ts`, `marketing/ads.ts`, `media/gallery.ts`, `media/video.ts`, `events/client-events.ts`, and `bff/product-page.ts` with an optional `gallery` section
- [X] T008 Add the schemas of T007 to `packages/contracts/src/{fulfilment/pickup,community/discussions,assistant/ask,marketing/share,marketing/ads,media/gallery,media/video,events/client-events}.ts`, extend `bff/product-page.ts` (+`gallery`), export them from the package index with those names; remove any temporary `lib/api/schemas/` folder in `packages/web` if it exists
- [X] T009 [P] Failing test `lib/utils.test.ts` (U-money): `formatMoney(minor, currency, locale?)` with required currency, fraction digits from the currency (JPY 0, USD 2, KWD 3)
- [X] T010 Implement `formatMoney` with required `currency` in `lib/utils.ts` and adapt every caller (cart, seller, orders) only so `tsc --noEmit` compiles
- [X] T011 [P] Failing test `lib/query-keys.test.ts` (U-keys): W02 keys are tuples from the factory; params canonicalised so equal views share a key
- [X] T012 Rewrite `lib/query-keys.ts`: add `search.{results,near}`, `suggest.prefix`, `rails.{trending,recommendations}`, `product.page`, `pickup.{near,clusters}`, `discussions.{board,thread,replies}`, `share.link`, `video.playback`, `ads.sponsored`; remove `products.search`; per-key stale times (discussions, pickup) in `lib/providers.tsx` (gaps A3, A7)
- [X] T013 [P] Failing test `lib/search/search-view.test.ts` (U-view): table of unknown, legacy (`priceMin`, `priceMax`, `rating`, `nearMe`, `size`, `from`), repeated (first wins), out-of-range, over-long `q` (cut to 100), `min` above `max` (both dropped), `semantic` without `q` dropped, `sort=relevance` only with `q`, `radiusKm` ∈ {1,2,10,20,50} (5 omitted), `cursor` ≤ 2048 dropped on any other change → canonical form; parsing is total (never throws)
- [X] T014 Implement `lib/search/search-view.ts` (`SearchView`, `parseSearchView`, `toSearchParams`, `searchRequestParams`, `canonicalKeyPart`) per data-model §2: `q` trimmed 1..100; `category`/`brand` ≤ 100; `minPriceMinor` ≥ 0; `maxPriceMinor` ≥ `minPriceMinor` (else both dropped); `minRating` 1..5; `inStock` true; `sort` ∈ price-asc|price-desc|newest (+relevance with q); with `near=1` the request carries only `q`, `radiusKm`, `cursor` plus coordinates
- [X] T015 [P] Failing test `lib/search/price-input.test.ts` (U-price): major→minor, decimals, min above max, non-numeric, negative, empty bound, band fills fields; then implement `lib/search/price-input.ts` and `lib/search/facet-label.ts` (hyphens as spaces, capital first letter)
- [X] T016 [P] Failing test `lib/safe-html.test.ts` (U-html: hostile-input table — script, img, event handlers, `javascript:` links, other schemes, nested quotes, headings demoted; links get `rel` and `target`), then implement `lib/safe-html.ts` `sanitizeBodyHtml` (dompurify, browser only) and `lib/safe-url.ts` (https-only absolute URLs)
- [X] T017 [P] Implement `lib/api/idempotency.ts` `newIdempotencyKey()` and `lib/routes.ts` (`productHref`, `searchHref`, sign-in links via W01's `loginHref(returnTo)`) with a small unit test each
- [X] T018 [P] Failing test `lib/api/problem-copy.test.ts` (U-copy): table-driven `(surface, status, code)` → exact copy for surfaces `search`, `pickup-search`, `product`, `pickup`, `discussions-read`, `discussions-write`, `vote`, `ask`, `share`, `video`; `Retry-After` wait text; reference for 5xx; unknown 4xx/5xx fall back; server `detail`/`title` never rendered; `problemFromError` keeps only status, code, requestId (AS-73, AS-77)
- [X] T019 Implement `lib/api/problem-copy.ts` (`problemCopy`, `Surface`) reusing W01's `waitText` and `ProblemAlert`, with the Copy catalogue of spec.md verbatim
- [X] T020 [P] Failing tests `lib/pickup/coords.test.ts` (U-coords: rounded to three decimals, memory only) and `lib/pickup/format.test.ts` (U-fmt: distance text; opening status table — empty hours, open, closed with next opening, other time zone), then implement `lib/pickup/{coords,format}.ts` (`OpeningStatus` = `{kind:'unknown'}|{kind:'open',closesAt}|{kind:'closed',opensAt?}`)
- [X] T021 [P] Failing test `hooks/use-browser-location.test.tsx` (U-loc): denied, unsupported, insecure, timeout, unavailable → states and exact messages; Try again where it helps; no API call; idle→asking (user action only) → granted|denied|timeout|unavailable; then implement `hooks/use-browser-location.ts`
- [X] T022 Failing test `lib/analytics/track.test.ts` (U-track): event shape and props limits (≤ 30 entries; key `[A-Za-z0-9_.-]{1,64}`; value string ≤ 500 | number | boolean), batch of 20, 5 s flush, `sendBeacon` on visibility change, retry 1/2/4 s with the same `event_id` then drop, GPC (`navigator.globalPrivacyControl === true`) and DNT create no cookie and no event, anonymous id 22 chars `[A-Za-z0-9_-]`, accepts `{name:'page_view', page}`, no search text/question/coordinates in any event (AS-67, AS-68, AS-77)
- [X] T023 Implement `lib/analytics/track.ts` replacing W07's stand-in (keep the name `track`; add `__resetTrackForTests()`): module-state queue, first-party anonymous-id cookie (`SameSite=Lax`, one year), same-origin `/api/events` through `lib/api/events.ts`
- [X] T024 [P] Add `lib/config.test.ts` cases and `.env.example` / README values for `MEDIA_HOST`, `VIDEO_HOST`, `MAP_TILE_HOST`, `NEXT_PUBLIC_MAP_TILE_URL`, `SITE_URL`, `STOREFRONT_ADS_ENABLED` (W07 follow-up); the map tile host must also be in `MAP_TILE_HOST` for the CSP
- [X] T025 Make `API_URL`, `BFF_URL`, `SITE_URL` readable only from `lib/server/*.server.ts` (`import 'server-only'`); remove `serverApiUrl()` use from client-reachable files (gaps A6)

**Checkpoint**: `pnpm exec vitest run lib hooks` green; `pnpm exec tsc --noEmit` green.

---

## Phase 3: US1 — Land on Home and start shopping (P1)

**Goal**: hero with the search box, category shortcuts, cached Trending rail with fallback. **Independent test**: JS `home lists products`, VH, U-card, U-home, U-cats.

- [X] T026 [P] [US1] Failing test `components/product/product-card.test.tsx` (U-card): rail variant (rank, title, category, price from `priceMinor`/`currency`, one link, no implementation note); title, brand, rating text or none (0 → absent), price, out of stock, placeholder when `imageUrl` is null, non-https `imageUrl` ignored, sponsored label announced before the title with position/order untouched, memoised (same props do not re-render) (AS-02, AS-10, AS-22, AS-72, AS-76)
- [X] T027 [US1] Implement `lib/product/cards.ts` (`CardModel` `{id,title,brand?,priceMinor,currency,rating?,imageUrl? (https only),inStock?,sponsored?,rank?,category?,href}`; `railItemToCard`, search and sponsored mappers; delete `Recommendation`/`recommendationToCard`) and `components/product/{product-card,rail-card}.tsx`; make `components/product-card.tsx` re-export the new `ProductCard` (no `slug`, `name`, `shopName`, `price`, `reviewsCount`; no `placehold.co`)
- [X] T028 [P] [US1] Failing test `lib/home/rail-source.test.ts` (U-home): empty, 429, 503, 400, invalid body, timeout, network → catalogue browse; both fail → "No products yet."; failures not kept longer than 5 s (AS-03)
- [X] T029 [US1] Implement `lib/server/trending.server.ts` (`use cache`, `cacheLife` 30 s, tag `trending`, failed 5 s; reads the S35 envelope `{category,windowMinutes,generatedAt,items[{rank,productId,…priceMinor,currency,category}]}`) and `lib/home/rail-source.ts` (fallback to catalogue browse through `lib/server/search.server.ts`)
- [X] T030 [P] [US1] Failing test `lib/home/category-shortcuts.test.ts` (U-cats): first eight category facets become links; any failure omits the row (AS-01)
- [X] T031 [US1] Implement `lib/server/category-shortcuts.server.ts` (`use cache` 60 s, tag `search-facets`, failed 5 s) and `lib/home/category-shortcuts.ts`
- [X] T032 [US1] Failing visual test `tests/visual/home.spec.ts` (VH: shell with skeleton rail; desktop and mobile; region order, shortcut row scroll, two/four columns; axe) (AS-04, AS-75)
- [X] T033 [US1] Rebuild `app/page.tsx` as a Server Component: hero + `SearchBox variant="hero"` (placeholder until US2), `<Suspense>` shortcuts, `<Suspense>` `components/home/trending-rail.tsx`, static showcase in `components/home/showcase.tsx` with links fixed to real routes; remove the "Powered by Count-Min Sketch…" copy and every direct `fetch` (gaps B1–B7)
- [X] T034 [US1] Failing journey `tests/home-trending.spec.ts` (AS-41, T56: trending card links to `/products/<id>`, prices formatted, no Count-Min Sketch copy), then make it pass (needs the B-6 trending seed, T110)

---

## Phase 4: US2 — Type, get suggestions, search (P1)

**Goal**: combobox on Home, search page and navbar. **Independent test**: U-box, U-sugg, JS `type iph, pick a suggestion`.

- [X] T035 [P] [US2] Failing test `hooks/use-suggestions.test.tsx` (U-sugg): debounce 150 ms; out-of-order answers show the latest prefix; superseded request aborted; 60 s cache; no request for blank text; unknown `source` accepted (AS-07)
- [X] T036 [US2] Implement `lib/api/suggest.ts` (`fetchSuggestions(prefix,{signal})` parsing `suggestResponseSchema`; delete `suggestionsFrom`, old `SuggestResponse` and `fetchAutocomplete` from `lib/api/catalog.ts`) and `hooks/use-suggestions.ts` → `{items,status,announce}`
- [X] T037 [P] [US2] Failing test `components/search/search-box.test.tsx` (U-box): combobox roles/attributes (input is the combobox, `aria-activedescendant`, status line); Down/Up/Enter/Escape/Tab; focus stays in the input; 429, 400, 5xx, invalid body, network, empty 200 → list closed or "No suggestions", no alert, submit still works; trim; blank submit rules; 100-char cut with hint; Clear search keeps focus; suggestion text rendered as text; typing does not re-render the results grid (render counter); no text in console/reporter spies; Escape closes and returns focus (AS-06, AS-08, AS-09, AS-75..AS-77)
- [X] T038 [US2] Implement `components/search/{search-box,suggestion-list}.tsx` (`SearchBox({variant:'hero'|'page'|'navbar'})`, renders nothing for `navbar` on `/` and `/search`), replacing W07's stand-in with the same name and props; labelled input, submit button, named clear button (gaps C9, C10); mount in the Home hero
- [X] T039 [US2] Failing journey in `tests/search.spec.ts` `type iph, pick a suggestion` (five suggestions, URL carries `q=iphone+17`), then make it pass (AS-05)

---

## Phase 5: US3 — Browse and narrow search results (P1)

**Goal**: server-rendered first view handed to TanStack Query; the URL is the only view state; facets, chips, price, sort, cursor paging, errors. **Independent test**: JS `search finds one`, `filters and sort are in the address…`, `next page…`, VS.

- [X] T040 [P] [US3] Failing test `lib/api/search.test.ts` (U-sapi): request carries `limit` and `cursor` (no `from`); reads `items`, `total.exact`, `degraded`, facet keys; `logSearchClick` sends one keepalive record per result per view with the API position and `searchId`; failures ignored, never block navigation (AS-23)
- [X] T041 [US3] Implement `lib/api/search.ts` (`fetchSearch(view,{signal})`, `logSearchClick(record)`, contract schemas, page size 24) and `lib/server/search.server.ts` (`getSearchFirstView(view)`, no server cache); make `lib/api/catalog.ts` public-only (remove hand-written types)
- [X] T042 [P] [US3] Failing test `components/search/sort-control.test.tsx` (U-sort): Relevance hidden without `q`; label "Featured"; default omitted from the address (AS-13)
- [X] T043 [P] [US3] Failing test `components/search/filter-panel.test.tsx` (U-filters): counts as given; keys as labels; single choice per group; re-select clears; empty group hidden; avgRating line; chips with names; remove returns focus to heading; clear all keeps `q` and `sort`; rating choices set and clear `minRating`; In stock only sets `inStock=true`; keyboard operation of every control (AS-14, AS-15, AS-17, AS-27)
- [X] T044 [US3] Failing test `components/search/search-results.test.tsx` (U-results): cleaned address replaces the entry; Next page link, Back to first page, cursor dropped on other changes, duplicate id shown once, count line identical on every page; no-match message, hint with q, Clear all filters only when filters are on; browse mode heading "All products"; semantic switch (one page, no Next page, facet counts hidden with the note, degraded notice keeps the switch); `invalid_cursor` → first page with notice; 429 with wait and re-enable; 503/5xx/no body → Try again with reference; offline → retry on online (Reconnecting… with aria-busy); unreachable 422 codes → cleaned view; first view has no skeleton, client change keeps previous results dimmed with `aria-busy`; one main, one h1, Filters form landmark, Search results region, focus after chip removal and page change (AS-12, AS-18..AS-21, AS-24, AS-25, AS-27, AS-74)
- [X] T045 [US3] Implement `components/search/{search-results,filter-panel,filter-sheet,filter-chips,price-filter,sort-control,results-grid}.tsx` and `hooks/use-search-view.ts` (history-API integration, no RSC refetch per filter, previous data kept); rebuild `app/search/page.tsx` as a Server Component with `HydrationBoundary`, `loading.tsx`, `error.tsx`; no nested `<main>`; filter column from 1024 px; filter sheet with footer actions (gaps C1–C7, C11, C12, C15)
- [X] T046 [US3] Implement `components/search/canonical-url.tsx` and the robots metadata in `app/search/page.tsx` (`noindex, follow` whenever `q`, a filter, `semantic`, `near` or `cursor` is present); sponsored label through `ProductCard` (AS-22; gaps C14)
- [X] T047 [US3] Failing visual test `tests/visual/search.spec.ts` (VS: results desktop/mobile, filters panel states, results empty, refreshing, desktop sidebar vs mobile sheet, toolbar, chips row; axe on every state; 320 px no horizontal scroll), then commit baselines (AS-10, AS-14, AS-19, AS-25..AS-27)
- [X] T048 [US3] Rewrite `tests/search.spec.ts` (JS, describe `Catalog & search`): `home lists products`, `search finds one`, `filters and sort are in the address; reload and back restore the view` (category facet, price 10–500 → `minPriceMinor=1000&maxPriceMinor=50000`, sort `price-desc`), `next page keeps the filters and the browser back button returns` (AS-10, AS-11, AS-13, AS-14, AS-16, AS-18; gaps G6)

---

## Phase 6: US5 — Read the product page (P1)

**Goal**: one anonymous cached aggregate, partial sections, gallery, tabs in the URL, rails, structured data. **Independent test**: U-page, U-sections, U-gallery, JS `home → search → product`, `product-page.spec.ts`, VP.

### Backend and contracts first (B-1, B-2)

- [X] T049 [US5] Failing e2e `media-gallery-public.e2e-spec.ts` in the media domain: happy, ordering by position, only READY items, unknown/archived/sandbox/suspended-shop product → identical `404`, malformed id → `400`, anonymous; run `/opt/sdd/repo/scripts/sdd/test-spec.sh media-gallery-public`
- [X] T050 [US5] Implement public `GET /products/:productId/gallery` → `{items:[{mediaId,position,urls:{thumb,feed,full},width,height}]}` in `packages/backend/libs/domains/media/{api,application}` (thin controller, logic in the service, product visibility through the S05/S03 client, no cross-domain table read); grep touched files for `// S54 T037 audit` and migrate (B-8)
- [X] T051 [US5] Failing e2e extension in `bff.e2e-spec.ts` and `bff-contracts.spec.ts`: `gallery` section present; upstream failure → `gallery: null` plus an `errors` entry; budget 300 ms exceeded → null; anonymous request returns no per-visitor data
- [X] T052 [US5] Add the `gallery` entry in `packages/backend/libs/composition/bff/page/section-registry.ts` (`GET /products/{id}/gallery`, budget 300 ms, optional, anonymous-safe) and `gallery` in `BFF_SECTIONS`/`productPageResponseSchema`; run `test-spec.sh bff`

### Web

- [X] T053 [P] [US5] Failing test `lib/api/product-page.server.test.ts` (U-page): `404`, `503`, `502`, `429`, network map to the page states `not-found` (also malformed id, noindex) | `unavailable` (with `requestId`) | `rate-limited` (with wait) | `offline`; the read sends no cookie, `Authorization` or `X-Anonymous-Id`; cache key is the id; degraded not kept (AS-33, AS-69)
- [X] T054 [US5] Implement `lib/server/product-page.server.ts` (`use cache`, 15 s, tag `product:{id}`, 5 s when non-empty `errors` or parse failure) and `lib/product/parse-page.ts` per data-model §4: `product` required (invalid → 502); every other section parsed on its own, invalid → `null`; empty `items` of recommendations/trending → `null`; trending drops own id and is cut to 8; unused sections never read; `degraded` flag
- [X] T055 [P] [US5] Failing tests `components/product/product-summary.test.tsx` (U-summary: breadcrumb, brand and tag links to `/search?brand=`/`/search?q=`, rating text or "Not rated yet" for 0, no stock count, description as text with line breaks, "Sold by {name}" as text, omitted when null) and `lib/seo/product-jsonld.test.ts` (U-ld: currency from the response, `<` escaped as `<`, availability) (AS-32, AS-35)
- [X] T056 [US5] Implement `components/product/{product-summary,breadcrumb}.tsx` and `lib/seo/product-jsonld.ts`; `generateMetadata` reads the same cached aggregate
- [X] T057 [P] [US5] Failing tests `components/product/product-unavailable.test.tsx` (U-unavail: copy, Try again, reference, noindex marker, link to search) and `components/product/product-sections.test.tsx` (U-sections: each optional section null or invalid → hidden, page and purchase area intact; error codes never rendered; degraded response not kept more than 5 s) (AS-33, AS-34)
- [X] T058 [US5] Failing test `app/p/[productId]/page.test.tsx` (U-redir: `308` to `/products/<id>` with every parameter kept; non-UUID renders not found), then implement `app/p/[productId]/page.tsx` (`permanentRedirect`); in `test-plan.md` reword AS-69 ("the shell streams first") and move the U-redir path
- [X] T059 [US5] Implement `components/product/{product-unavailable,section-boundary}.tsx` and rename `app/products/[slug]` to `app/products/[productId]/{page,loading,error}.tsx` (malformed id → not found; read through `product-page.server.ts`; no direct `fetch`)
- [X] T060 [P] [US5] Failing test `components/product/gallery.test.tsx` (U-gallery): thumbnail switching with `aria-current`; lightbox closes with Escape and restores focus; placeholder without images or on image error; eager first image; https-only URLs (AS-36)
- [X] T061 [US5] Implement `components/product/gallery.tsx` (lightbox is the client leaf; reserved image boxes)
- [X] T062 [P] [US5] Failing test `components/product/purchase-area.test.tsx` (U-buy): order of controls; Add to cart disabled and labelled when out of stock; bottom bar only when the main area is out of view and not covering focus (AS-37)
- [X] T063 [US5] Implement `components/product/{purchase-area,mobile-purchase-bar}.tsx` hosting W03's `<AddToCartButton productId category disabled />` (pass `category`), chat link `/chat?product=<id>`
- [X] T064 [P] [US5] Failing test `components/product/product-rails.test.tsx` (U-rails): empty `items`, 404, 429, 503, invalid body → section absent; own product removed from trending; max eight; envelope `{type, items}`; money from `priceMinor`/`currency` (AS-39)
- [X] T065 [US5] Implement `components/product/product-rails.tsx` reading the aggregate's `recommendations` and `trending`
- [X] T066 [P] [US5] Failing test `components/product/product-tabs.test.tsx` (U-tabs): ARIA tab pattern keys; only the active panel exposed; invalid tab → details; lazy mount (first open, then kept); tab in the address, change pushes history (AS-40)
- [X] T067 [US5] Implement `lib/product/page-view.ts` (`tab` details|pickup|ask|discussions, `sort` hot|top|new, `window` day|week|month|year only with top, `post` uuid, `ref`, `ad`) and `components/product/product-tabs.tsx` with the tabs `Details`, `Pickup near me`, `Ask about this product`, `Discussions`
- [X] T068 [US5] Failing visual test `tests/visual/product-page.spec.ts` (VP: desktop two columns and mobile single column with focus order; not found and unavailable; all optional sections missing; gallery states; mobile bottom bar; axe) (AS-32..AS-34, AS-36..AS-38)
- [X] T069 [US5] Add journeys `tests/product-page.spec.ts` (S48 journey: price `$899.99`, "In stock", partial page still purchasable), `tests/product-recommendations.spec.ts` (AS-48, A25) and `home → search → product` in `tests/search.spec.ts`; JD `product page shows frequently bought together` in `tests/storefront-discovery.spec.ts` (B-6 dataset D)

---

## Phase 7: US4 — Pickup availability near me in search (P2)

**Independent test**: JD `search near me`, U-near, VS pickup mode.

- [ ] T070 [P] [US4] Failing test `components/search/pickup-mode.test.tsx` (U-near): filters disabled with values kept; heading; no count; 429, 503, offline forms; empty with radius control; address never contains coordinates; request has `cache: 'no-store'` (last test of the file); location messages as U-loc; no coordinates in console/reporter (AS-29..AS-31, AS-77)
- [ ] T071 [US4] Implement `lib/api/pickup.ts` (`fetchPickupNearSearch`, `fetchPickupPoints`, `fetchPickupClusters`; contract schemas) and `components/search/pickup-mode.tsx` (`near=1`, `radiusKm`; coordinates in memory, 3 dp), wired into `search-results.tsx`
- [ ] T072 [US4] Add VS `search: pickup mode` and JD `search near me` (grant location; cards show distance and point; radius changes `radiusKm`) in `tests/visual/search.spec.ts` and `tests/storefront-discovery.spec.ts`; B-6 pickup seed (AS-28)

---

## Phase 8: US6 — Pickup point near me on the product page (P2)

- [ ] T073 [P] [US6] Failing test `components/product/pickup-panel.test.tsx` (U-pickup): idle makes no request; asking; denied/unsupported/timeout reuse the AS-29 messages; empty; 429; 5xx; offline; radius change refetches from page one; Show 10 more appends without duplicates (by `id`) and moves focus; button absent without a cursor (AS-43, AS-44)
- [ ] T074 [US6] Implement `components/product/pickup-panel.tsx` (infinite query keyed `(productId, radiusKm, coords3dp)`, page size 10, default radius 5 km, choices 1/2/5/10/20/50)
- [ ] T075 [P] [US6] Failing test `components/product/pickup-map.test.tsx` (U-map): request after 300 ms pause with rounded bounds (bbox 4 dp, integer zoom 0–20); superseded request aborted; truncated note; list view when no tile source; marker names; Close returns focus (AS-42)
- [ ] T076 [US6] Implement `components/product/pickup-map.tsx` (lazy `maplibre-gl`, tile URL from `NEXT_PUBLIC_MAP_TILE_URL`, no third-party host by default)
- [ ] T077 [US6] Add VC `tests/visual/product-panels.spec.ts` (`pickup: states`, `pickup map: desktop panel and mobile dialog`) and JD `pickup near me`, `map clusters` (AS-41, AS-42)

---

## Phase 9: US7 — Read and join the discussion (P2)

### Backend (B-4, B-5)

- [ ] T078 [US7] Failing e2e `discussions-delete-post.e2e-spec.ts` in the community domain: author `204`, ADMIN/MODERATOR `204`, other user `403 forbidden`, unknown `404 post_not_found`, twice `204`, no credentials `401`, malformed id `400`, `discussion.post_deleted` emitted once
- [ ] T079 [US7] Implement `DELETE /posts/:postId` in `packages/backend/libs/domains/community` (tombstone semantics as S25 FR-005/FR-052, existing outbox pattern, `TransactionRunner.run`/`@Transactional` if SQL is touched) and update `packages/contracts`; run `test-spec.sh discussions-delete-post`
- [ ] T080 [US7] Failing e2e `discussions-replies.e2e-spec.ts`: 12 replies in pages of 5 → 5+5+2 exactly once, `limit` 1–50 default 5, malformed/tampered/foreign cursor → `400 invalid_cursor`, unknown or hidden comment → `404`, anonymous allowed, shadow-ban visibility as S25
- [ ] T081 [US7] Implement `GET /comments/:commentId/replies?limit&cursor` → `{items, nextCursor, degraded?}` oldest first; run `test-spec.sh discussions-replies`; grep touched community files for `// S54 T037 audit` and migrate (B-8)

### Web

- [ ] T082 [P] [US7] Failing test `components/product/discussions/discussion-list.test.tsx` (U-dlist): sort and window in the address (window only with top); show more de-duplicates by `postId`; empty text; skeleton; author label `You` or `Community member` (tombstone `authorId: null`); relative times up to 30 days then `Mon D, YYYY` with `<time datetime title>`; article named by title; h2/h3 order; labelled sort controls; focus after show more (AS-45, AS-53)
- [ ] T083 [P] [US7] Failing test `components/product/discussions/discussion-composer.test.tsx` (U-comp): counters; Post disabled while pending; idempotency key kept on retry and replaced after success or edit; double click posts once; field errors; focus and status after success; offline write fails at once keeping the text; `title` 3–300 code points trimmed, `body` ≤ 40,000; list switches to `new` after posting; no text in console (AS-46, AS-74, AS-77)
- [ ] T084 [P] [US7] Failing test `components/product/discussions/vote-buttons.test.tsx` (U-vote): optimistic update and rollback; flip and retract send value 1, -1, 0; self vote `aria-disabled` with text; signed-out prompt "Sign in to vote."; `vote_in_progress` retried once after `Retry-After`; at most one request in flight per target; failures per catalogue (AS-48)
- [ ] T085 [P] [US7] Failing test `components/product/discussions/comment-thread.test.tsx` (U-thread): embedded replies (≤ 5) and Show more replies; no Reply at depth 8; tombstone texts; indentation cap after depth 3 (≤ 640 px); de-duplication by `commentId`; expanded post in the address as `post=<uuid>` (AS-49)
- [ ] T086 [P] [US7] Failing tests `components/product/discussions/delete-dialog.test.tsx` (U-del: visible for author and ADMIN/MODERATOR only; dialog with Cancel focused; `204` removes a post or tombstones a comment; 403, 404, 409 refresh the item; Escape closes and restores focus), `discussions-auth.test.tsx` (U-dauth: signed-out controls and sign-in links with `returnTo`; `401` on a write runs the W01 session-ended flow once and keeps typed text) and `discussions-errors.test.tsx` (U-derr: problem-code table → texts beside the control; degraded notice; `board_not_found`; `board_closed`; `invalid_cursor` reload; vanished content removed; list stays on failure) (AS-50..AS-52)
- [ ] T087 [US7] Implement `lib/api/discussions.ts` (`listPosts/createPost/listComments/listReplies/createComment/putVote/deletePost/deleteComment`; `PUT /votes/:targetId {value}`; `Idempotency-Key` and CSRF header on writes; no token from JS) and `components/product/discussions/{discussion-list,discussion-post,discussion-composer,vote-buttons,comment-thread,comment-form,delete-dialog,discussions-panel}.tsx`; bodies only through `sanitizeBodyHtml` after hydration; delete `components/product/product-discussions.tsx` (gaps E1–E7)
- [ ] T088 [US7] Add VC `discussions: desktop column of votes, mobile inline votes; composer; thread` with axe, and rewrite `tests/product-community.spec.ts` (JC): `discussions deep link opens the tab`, `start a discussion, upvote it, reply, ask the product` (bold rendered, no raw tags, score 1, reply under the post) (AS-40, AS-45..AS-49, AS-53; gaps G6)

---

## Phase 10: US8 — Ask this product (P2)

- [ ] T089 [P] [US8] Failing test `lib/api/ask.test.ts` (U-aapi): SSE parsing — `sources` items by `n`, `text`, `done`; invalid JSON event ends the answer without throwing; CSRF header and abort signal ours, no `Authorization` (AS-54, AS-57)
- [ ] T090 [US8] Implement `lib/api/ask.ts` `askProduct(question,{signal,onEvent})` through `lib/api/sse-reader.ts` with `ragStreamEventSchema`; remove the bearer-token path from `sse-reader.ts` if W01 has not (verify)
- [ ] T091 [US8] Failing test `components/product/ask-panel.test.tsx` (U-ask): status, token-by-token plain text, cited sources only with heading path and page, question kept; `not_found` shows our copy, not the server message; refusal copy without category; partial text kept with the rest-can't-be-shown line; 404 replaces the tab; 422, 429 ×2 with wait and re-enable, 503, 400, offline, 5xx with reference; error codes and abrupt end keep the text and show Ask again; `grounded` false notice and empty sources; Stop aborts and keeps text with "Stopped."; unmount aborts; one request on double press; asking again clears first; tab switch keeps streaming; region `Answer` with `aria-busy`, no live token region, hidden polite status, `role=alert` only for request errors; no question in console (AS-54..AS-59, AS-77)
- [ ] T092 [US8] Implement `components/product/ask-panel.tsx` (`useReducer`: idle→asking→streaming→answered|not_found|refused|stopped|failed, plus `blocked`); delete `components/product/ask-product.tsx` (gaps F1–F6)
- [ ] T093 [US8] Add VC `ask: desktop and mobile` and the JC ask step (seeded public knowledge document, scripted embedder and model provider; B-6; fail fast in `tests/global-setup.ts` naming the missing seed, otherwise `test.fixme` and record in `questions.md`)

---

## Phase 11: US9 — Share a product and keep the referral (P2)

- [ ] T094 [P] [US9] Failing test `components/product/share-popover.test.tsx` (U-share): creating state; one request with `Idempotency-Key` and `{SITE_URL}/products/{productId}` destination; reopen shows the same link; clipboard fallback; Escape restores focus; signed-out prompt with `returnTo`, no request, disabled while the session loads; non-https `shortUrl` ignored; `link_limit_reached`, destination errors, 429 with wait, `409 idempotency_in_flight` retried with the same key (1 s, ≤ 3), 503 with reference, 401 flow, offline (AS-60..AS-62, AS-72)
- [ ] T095 [US9] Implement `lib/api/share.ts` (`createShortLink(destination,key)`) and `components/product/share-popover.tsx`
- [ ] T096 [P] [US9] Failing test `lib/attribution/ref.test.ts` (U-ref): code validation table `^[A-Za-z0-9_-]{1,64}$`; route answers `204` with the exact `Set-Cookie: __Host-ref=<code>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`; invalid code or failure changes nothing; same-origin only; last click replaces (AS-63)
- [ ] T097 [US9] Implement `app/api/attribution/ref/route.ts`, `lib/attribution/ref.server.ts` (`getRefCode()`), `components/analytics/ref-capture.tsx` and mount it on the product page
- [ ] T098 [US9] Add VC `share: popover and mobile sheet` and journey `tests/share-link.spec.ts` (JL: share, copy, open as a second-context visitor, `__Host-ref` HttpOnly 30 days) (AS-60, AS-63)

---

## Phase 12: US11 — Visitor events (P2)

- [ ] T099 [P] [US11] Failing test `components/analytics/product-view.test.tsx` (U-pv): once per page view; Strict Mode double mount and tab changes add none; another product adds one; carries `props.product_id` and `props.category` (AS-67)
- [ ] T100 [US11] Implement `components/analytics/product-view.tsx` (client leaf mounted by the product page) and `lib/api/events.ts` (same-origin `POST /api/events`, parsed with `events/client-events.ts`); emit `page_view` from the app shell call site; make `track()` the call target for W03's `add_to_cart`
- [ ] T101 [US11] Add journey `tests/visitor-events.spec.ts` (JE: the request to `/api/events` carries one `product_view` with `product_id` and `category`; proves H9 forwarding reaches the analytics controller)

---

## Phase 13: US10 — Product videos and sponsored cards (P3, conditional)

- [ ] T102 [P] [US10] Failing test `components/product/video-section.test.tsx` (U-video): tiles from `items`; player code (`hls.js`) loaded on first activation; one `video_view` per play; 404, 429, 503 texts; absent without items; non-https `masterUrl` ignored (AS-65, AS-72)
- [ ] T103 [US10] Implement `lib/api/videos.ts` (`fetchPlayback`) and `components/product/video-section.tsx`; add `tests/product-video.spec.ts` as `test.fixme` (until S30's seed video and player flag exist)
- [ ] T104 [P] [US10] Failing test `components/search/sponsored-slot.test.tsx` (U-ads): `clickUrl` verbatim; `rel="sponsored nofollow"`; not prefetched; empty, 429, 503, invalid, offline render nothing; flag off makes no request; non-https `clickUrl` ignored (AS-66)
- [ ] T105 [US10] Implement `lib/api/ads.ts` and `components/search/sponsored-slot.tsx` behind `STOREFRONT_ADS_ENABLED` (off); add `tests/sponsored-listing.spec.ts` as `test.fixme`

---

## Phase 14: US12 — Rendering, data flow, safety, accessibility (P3) and cleanup

- [ ] T106 [US12] Delete old code: `suggestionsFrom`, `SuggestResponse`, `Recommendation`/`recommendationToCard`, `fetchAutocomplete`, hand-written catalog types, `placehold.co` URLs, `ask-product.tsx`, `product-discussions.tsx`, any direct `fetch` in `app/page.tsx`, `app/products/**`, `app/search/page.tsx`; `components/product-card.tsx` re-export stays until W03 moves
- [ ] T107 [US12] Make `lib/storefront/architecture.test.ts` fully green and `eslint` report 0 warnings in W02 files (AS-69..AS-72, AS-76)
- [ ] T108 [US12] Run `pnpm exec tsc --noEmit`, `pnpm lint` and `pnpm build` (Cache Components validation: no runtime-data-outside-Suspense or blocking-route error)
- [ ] T109 [US12] Run `pnpm exec playwright test tests/visual`: axe serious/critical = 0 at 390 and 1280 px, 320 px no horizontal scroll, 200 % zoom (AS-75)

---

## Phase 15: Polish, gaps and close-out

- [ ] T110 B-6 seeds: pickup point with stock near the fake location; recommendation list (S34 dataset D); trending dataset (S35 dataset T); processed public knowledge document and scripted model provider (S47); READY video (S30, P3); `tests/global-setup.ts` fails fast naming the missing seed; seeds without an owner hook go to `questions.md` and their journey stays `fixme` (gaps G8, H5, H6)
- [ ] T111 Update `specs/web/W02-storefront-discovery/gaps.md` `## Sibling-spec follow-ups`: add **W03** (adopt `formatMoney(minor, currency)`, `track()` for `add_to_cart`, `<AddToCartButton productId category disabled />`, the new `ProductCard` props, `productHref`) and **W04/W06** (`formatMoney` signature); confirm each existing bullet (S05, S25, S29, S34/S35, S36, S37, S10/W03, W05, W07, S19) still matches what was built
- [ ] T112 Verify `specs/web/W02-storefront-discovery/quickstart.md` "Ops artifacts" lists SC-001, SC-002, SC-003, SC-004, SC-008 (keyboard part) and SC-009 as unproven by tests, and `specs/UNVERIFIED.md` has exactly one W02 row each with status `not run` (rows exist: check, do not duplicate); describe none as verified
- [ ] T113 Confirm every gaps.md item maps to a task: A1–A8, B1–B7, C1–C15, D1–D12, E1–E7, F1–F6, G1–G11, H1–H10 (coverage table at the end of this file)
- [ ] T114 Final runs once: whole web suite (`pnpm test`, `pnpm exec playwright test`), then backend suites for `media`, `community`, `composition/bff` through `test-spec.sh` after `/health/ready`; report each follow-up from S05, S32, S33, S34, S35, S48, W01 and W07 with the task that satisfied it

---

## Dependencies and execution order

- Phase 1 → Phase 2 → stories. The contract schemas (Phase 2) block US4–US9.
- US1 provides `ProductCard` (also used by US3, US5). US2 needs Phase 2 only. US3 uses `SearchBox` (stand-in until US2 lands). US5 needs US1's cards and the B-1/B-2 backend (T049–T052). US4 needs US3; US6 needs US5 and US4's `pickup.ts`. US7 needs US5 tabs and B-4/B-5 (T078–T081). US8, US9, US11 need US5. US10 needs US3/US5. US12 and Polish last. T110 (seeds) must precede the journeys T034, T069, T072, T077, T088, T093.
- Parallel: Phase 2 [P] tasks; U-* test tasks inside one phase; backend B-1/B-2 and B-4/B-5 alongside web Phases 3–5.

## Implementation strategy

MVP = Phases 1–2 + US1 + US2 + US3 + US5 (the P1 stories): a visitor lands, searches, narrows and reads a product. Then P2 stories (US4, US6, US7, US8, US9, US11), P3 (US10, US12), then Polish. Each phase ends green on its narrowest test.

## Gaps coverage

| Gaps | Tasks |
|---|---|
| A1–A8 | T005, T006, T012, T025, T033, T041, T045, T087, T090, T106 |
| B1–B7 | T026–T033 |
| C1–C15 | T036–T048, T070–T072 |
| D1–D12 | T053–T069, T097, T100 |
| E1–E7 | T078–T088 |
| F1–F6 | T089–T093 |
| G1–G11 | T001–T005, T007–T008, T041, T048, T110 |
| H1 | T049–T052 |
| H2, H4, H8 | T111 (sibling bullets) |
| H3 | built by W01; verified by U-dauth (T086) |
| H5, H6 | T110 |
| H7 | T007–T008 |
| H9 | T101 |
| H10 | T097 |
