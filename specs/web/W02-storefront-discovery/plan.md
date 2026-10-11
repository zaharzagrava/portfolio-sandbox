# Implementation Plan: W02 — Storefront discovery (`packages/web` + the backend pieces it needs)

**Branch**: `W02-storefront-discovery` (spec directory only) | **Date**: 2026-10-11 | **Spec**: [spec.md](spec.md)

**Inputs**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted as written), constitution (`.specify/memory/constitution.md`), the follow-ups handed to W02 by S05, S32, S33, S34, S35, S48, W01 and W07. Next.js guides read: *Caching*, `use cache`, `cacheLife`, *Linking and navigating*, *Client-side data fetching with TanStack Query*, *JSON-LD*, *Backend for Frontend*, *Error handling*, *Route handlers*.

## Summary

Rebuild the three storefront pages (`/`, `/search`, `/products/[productId]`) and the pieces around them on the constitution's frontend rules, replacing today's single `'use client'` search page, raw `fetch` calls and invented data.

1. **Foundations** (`packages/web/lib`): route builders, the canonical search-view parser (the URL is the only copy of view state), query-key factory, one `lib/api/*` module per backend surface (search, suggest, pickup, discussions, ask, share, videos, ads, events) that parse with `packages/contracts` schemas, a problem-copy catalogue, `formatMoney` with a required currency, `sanitizeBodyHtml`, `useBrowserLocation`, `track`, `newIdempotencyKey`, `getRefCode`.
2. **Pages**: Home (cached trending rail with fallback, category shortcuts), Search (server-rendered first view handed to TanStack Query, facets, chips, price, cursor paging, semantic and pickup modes, click logging, sponsored label), Product page (one anonymous cached aggregate read, partial sections, gallery, tabs in the URL, rails, structured data), `/p/[productId]` redirect, referral capture.
3. **Product tabs**: Pickup near me (list + lazy map), Discussions (list, composer, votes, comments, delete), Ask this product (SSE read in `lib/api/ask.ts`), Share popover, Videos and Sponsored slot (conditional P3).
4. **Backend and contracts** the UI cannot work without and no built capability provides (verified 2026-10-11, see `research.md`): public product gallery read (S29) and its S48 `gallery` section, `DELETE /posts/:postId` and `GET /comments/:id/replies` (S25), the missing contract schemas, seeds for journeys. Everything else the spec lists as *Requires* already exists.
5. **Follow-ups from built specs** (table below) are requirements of this plan, each with a phase and a test.

## Technical Context

**Language/Version**: TypeScript 5 strict, Node 20+, React 19.2, Next.js 16.3.8 (Cache Components on, per-request root layout), NestJS backend (existing).
**Primary Dependencies**: `@tanstack/react-query` 5, `zod` 4 + `@marketplace-sandbox/contracts`, radix/shadcn `ui/*`, `sonner`, `lucide-react`, `@microsoft/fetch-event-source` (already used by `lib/api/sse-reader.ts`; `lib/api/ask.ts` uses the platform `fetch` + `ReadableStream` through `sse-reader` so the CSRF header and abort signal are ours). **New**: `dompurify` (+ `@types/dompurify` if the bundled types are absent), `maplibre-gl` and `hls.js` (both lazy, R-10). Already present from W07/W01: RTL, user-event, jest-dom, msw, `@vitejs/plugin-react`, `@axe-core/playwright`, `qrcode`.
**Storage**: browser: one first-party anonymous-id cookie (analytics, AS-68), the `__Host-ref` HttpOnly cookie (server-set), in-memory query cache; no storage. Backend: no new tables.
**Testing**: Vitest (jsdom) + RTL + MSW for every `U-*` row of `test-plan.md`; Playwright `desktop`/`mobile` projects for journeys JS, JD, JC, JL, JE (+ `fixme` JV, JA, + small named files `product-page`, `product-recommendations`, `home-trending`) and `tests/visual/*` for VH, VS, VP, VC; backend e2e through `scripts/sdd/test-spec.sh` for B-1, B-2, B-4, B-5; static gates `tsc`, ESLint, `next build`, `lib/storefront/architecture.test.ts`.
**Target Platform**: evergreen browsers; Next on Node behind the same-origin rewrites.
**Project Type**: web application (`packages/web`) with small backend additions and shared schemas.
**Performance Goals**: SC-002/SC-003/SC-004 are real-browser timings with no automated proof (UNVERIFIED rows); structural guarantees (150 ms debounce, abort, keep-previous, reserved image boxes, bounded lists) are tested.
**Constraints**: browser calls only relative same-origin URLs; no `Authorization`, no storage, no coordinates/text in URL/console/events; no third-party host by default; no new Context or global store; no new direct `sequelize.transaction`.
**Scale/Scope**: 3 pages + 1 redirect + 1 route handler, ~60 modules/components, 1 hook set, 9 `lib/api` modules, 4 backend changes, ~48 unit files, 8 journey files, 4 visual files.

## Follow-ups from built specs (requirements of this plan)

| Source | Requirement | Plan home |
|---|---|---|
| S05 | web types follow `productPublicSchema` / `productMemberSchema`; routes `/shops/:shopId/products…`; `expectedVersion` on edit/archive/restore | Public side: Phase 2/5 (product page reads `productPublicSchema` through the aggregate). `productMemberSchema` / shop routes / `expectedVersion` are **W04's seller screens** (S05 adapted only the types in `lib/api/shops.ts`); W02 touches none of them — recorded in `gaps.md` sibling bullets. W02 also makes `lib/api/catalog.ts` public-only (T below) |
| S32 / S48 | search page sends `limit`/`cursor` (no `from`), `searchId` with each click, reads `items`, `total.exact`, `degraded`, facet keys; BFF does not compose search | Phase 4 (`lib/api/search.ts`, `parseSearchView`, click logging); AS-10..AS-24, U-sapi |
| S33 | adopt `suggestResponseSchema`; delete `suggestionsFrom` and old `SuggestResponse`; debounce 150 ms, abort, drop stale, cache 60 s, unknown `source` accepted; no `suggestions` in search response | Phase 4 (`lib/api/suggest.ts`, `use-suggestions`); AS-05..AS-09; deletion in `lib/api/catalog.ts` |
| S34 | new recommendation shape in `catalog.ts` (`Recommendation`, `recommendationToCard`) and `products/[slug]/page.tsx` (envelope `{type, items}`, money from `priceMinor`/`currency`, section hidden on empty/404/429/503); journey `tests/product-recommendations.spec.ts` (AS-48, A25) | Phase 5 (rails from the aggregate's `recommendations`), `recommendationToCard` replaced by `railItemToCard` in `lib/product/cards.ts`; Phase 9 journey file; U-rails |
| S35 | "Trending now" from `priceMinor`/`currency`, fallback to catalogue on empty/429/503, drop the Count-Min Sketch copy; `tests/home-trending.spec.ts` (AS-41, T56) | Phase 3 (`lib/server/trending.server.ts`, `lib/home/rail-source.ts`); AS-02, AS-03; Phase 9 journey file |
| S35 | emit `product_view` (product page) and `add_to_cart` (cart action) with `props.product_id`, `props.category` through S39 (T55) | `product_view`: Phase 6 (`ProductView`, `track`). `add_to_cart`: W03 calls the `track()` W02 provides (Provides in spec); W02 passes `category` to `<AddToCartButton>` and records the sibling bullet; JE proves `product_view` reaches `/api/events`. Synthetic-event dependence ends when JE is green |
| S48 | product page reads `priceMinor` + `currency`, every section but `product` nullable, `errors` read but not shown, never cached publicly; search page as S32; `tests/product-page.spec.ts` | Phase 5 (R-03, R-05); AS-32..AS-34; journey `product-page.spec.ts` (Phase 9) |
| S48 (T051) / W01 | `bff-session.spec.ts` (W01 built) and `product-page.spec.ts` | `product-page.spec.ts` in Phase 9; `bff-session.spec.ts` already exists (W01) |
| W01 | `returnTo` replaces `returnUrl`; add `product-page.spec.ts` | every sign-in link built with `loginHref(returnTo)` (Phases 6–8: discussions, share); journey in Phase 9 |
| W07 | replace the stand-in `SearchBox` and `track` (keep names); `track` accepts `{name:'page_view', page}` and applies GPC/DNT itself; supply `MEDIA_HOST`, `VIDEO_HOST`, `MAP_TILE_HOST` values | Phase 4 (`SearchBox`), Phase 6 (`track`); values in `packages/web/.env.example` and README table (Phase 9), checked by `lib/config.test.ts` additions |
| W07 | `app/page.tsx`, `app/products/[slug]/page.tsx`, `app/search/page.tsx` still call `fetch` directly (ESLint `no-restricted-globals` warns) | Phases 3–5 remove every direct `fetch`; the ESLint rule is raised from warn to **error** for `components/`, `hooks/`, `app/**/page.tsx|layout.tsx` (Phase 0) and the warning count for W02 files must be 0 |
| gaps.md | every item A–I (code fixes, constitution debt, tooling, backend needs) | "Gap coverage" below |

## Constitution Check

*GATE: passes before research; re-checked after design (below).*

| Rule | Status | Note |
|---|---|---|
| I/II layering, routing | PASS | backend additions are a controller method + service in `media` (gallery) and `community` (delete post) and a registry entry in `composition/bff`; thin controllers, logic in services |
| III transactions | PASS (planned) | `deletePost` writes to the store through the existing community store (Cassandra-style statements, no SQL transaction); if any touched file carries a `// S54 T037 audit` comment, that site is migrated to `TransactionRunner.run`/`@Transactional` and the comment removed (task B-8 greps touched files); no new `sequelize.transaction` |
| IV communication | PASS | BFF reads the gallery through the media client/port, never tables; `community` emits `discussion.post_deleted` via its existing outbox pattern |
| V.1–V.4 contracts, errors | PASS (planned) | every new body/response has a schema in `packages/contracts`; stable problem codes; `lib/api/problem-copy.ts` maps `(surface, status, code)` and never renders `detail`/`title` |
| VI.1 Server Components first | PASS (planned) | pages/layouts are Server Components; client leaves listed in `data-model.md`; U-arch |
| VI.2 same origin, no tokens | PASS (planned) | relative URLs, no `Authorization`, CSRF header from `csrfHeaders()` on writes, ask stream sends no credentials from JS |
| VI.3 network only in `lib/api/*` or server-only modules | PASS (planned) | ESLint error rule + U-arch (AS-70) |
| VI.4 state homes | PASS | server data in TanStack Query (factory keys), view state in the URL, local state in `useState`; **no** Context, **no** store (the analytics queue is module state without subscribers, R-12) |
| VI.5 authz not only in proxy | PASS | delete buttons are convenience; the API decides; the referral route validates its own input |
| VI.6 stable keys | PASS (planned) | ids/keys listed in AS-76; U-arch rejects index keys |
| VI.7 user content as text | PASS (planned) | `sanitizeBodyHtml` and escaped JSON-LD are the only HTML sinks; URLs from responses must be https |
| VI.8 minimal props | PASS (planned) | server components pass ids and display fields only; the search leaf receives the dehydrated state and the parsed view |
| VI.9 no business rules in the web | PASS | ranking, visibility, moderation, throttling stay in S32/S25/S47; W02 shapes and presents |
| VII.1 static gates | gate | `tsc`, ESLint, `next build`, U-arch |
| VII.2/3 backend e2e | PASS (planned) | B-1, B-2, B-4, B-5 each get an e2e spec: happy, validation (malformed id), 401 where authenticated, 403/IDOR, 404 uniformity, idempotency (delete twice) |
| VII.7 UI testing | PASS (planned) | journeys happy path only, no stubbed backend; failures are MSW unit tests |
| VII.8 traceability | PASS | `test-plan.md` has one row per AS-01..AS-77 |
| VII.9 green run | gate | recorded at close-out; fallback paths each have a forcing test (test-plan list) |
| IX DB isolation | PASS | no cross-domain table reads; the BFF reads the gallery through HTTP |
| X module boundaries | PASS | web imports `@marketplace-sandbox/contracts` only |
| PR gate 6 contracts | PASS | schemas added to `packages/contracts` |

**Justified deviations (Complexity Tracking)**

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Backend additions (gallery read, delete post) inside a web plan | the product page cannot show an image and the Delete control would call a missing route | shipping the UI against `404`/`405` is a fake; waiting blocks P1 stories |
| `maplibre-gl` and `hls.js` dependencies | map and HLS playback are browser features with no platform equivalent | a hand-written tile renderer / HLS demuxer is far more risk; both are lazy and absent from every initial bundle |
| Module-level analytics queue | it has no React readers and must outlive component unmounts (flush on `pagehide`) | a Context/store would be state with no subscribers (VI.4) |
| AS-69 "static shell" reworded to "shell streams first" | the CSP nonce forces per-request HTML (W07) | changing W07's CSP model is out of scope (same as W01 R-02) |

**Post-design re-check**: unchanged. The only new rule risk found is `dompurify` running in the browser only (R-11); the discussion components therefore never render a body on the server, and U-arch asserts that `sanitizeBodyHtml` is not imported from a Server Component.

## Project Structure

### Documentation (this feature)

```text
specs/web/W02-storefront-discovery/
├── spec.md  test-plan.md  gaps.md  questions.md  checklists/
├── plan.md            # this file
├── research.md        # decisions R-01..R-18 and verified facts
├── data-model.md      # entities, URL state, state homes and transitions
├── quickstart.md      # run guide + Ops artifacts
└── contracts/
    ├── backend-endpoints.md   # what W02 calls, what B-1/B-2/B-4/B-5 add, schemas to add
    └── web-modules.md         # exported names, signatures, URL contract
```

### Source code (repository root)

```text
packages/web/
├── app/
│   ├── page.tsx                                   # Home: hero + SearchBox(hero), <Suspense> shortcuts, <Suspense> TrendingRail, showcase
│   ├── loading.tsx? (kept)  error.tsx (kept, FR-161 copy)
│   ├── search/{page.tsx,loading.tsx,error.tsx}    # Server Component; first view + HydrationBoundary
│   ├── products/[productId]/{page.tsx,loading.tsx,error.tsx}   # renamed from [slug]
│   ├── p/[productId]/page.tsx                     # permanentRedirect (308), query kept
│   └── api/attribution/ref/route.ts               # sets __Host-ref (R-13)
├── components/
│   ├── search/{search-box.tsx,suggestion-list.tsx,search-results.tsx,filter-panel.tsx,filter-sheet.tsx,filter-chips.tsx,
│   │           price-filter.tsx,sort-control.tsx,pickup-mode.tsx,sponsored-slot.tsx,canonical-url.tsx,results-grid.tsx}
│   ├── product/{product-card.tsx (moved from components/), rail-card.tsx, product-rails.tsx, product-summary.tsx, breadcrumb.tsx,
│   │            gallery.tsx, purchase-area.tsx, mobile-purchase-bar.tsx, product-tabs.tsx, product-unavailable.tsx,
│   │            section-boundary.tsx, pickup-panel.tsx, pickup-map.tsx, ask-panel.tsx, share-popover.tsx, video-section.tsx,
│   │            discussions/{discussion-list.tsx,discussion-post.tsx,discussion-composer.tsx,vote-buttons.tsx,
│   │                         comment-thread.tsx,comment-form.tsx,delete-dialog.tsx,discussions-panel.tsx}}
│   ├── home/{trending-rail.tsx,category-shortcuts.tsx,showcase.tsx}
│   └── analytics/{product-view.tsx,ref-capture.tsx}
├── hooks/{use-suggestions.ts,use-browser-location.ts,use-search-view.ts}
├── lib/
│   ├── routes.ts  query-keys.ts  utils.ts (formatMoney)  safe-html.ts  safe-url.ts
│   ├── api/{search.ts,suggest.ts,pickup.ts,discussions.ts,ask.ts,share.ts,videos.ts,ads.ts,events.ts,idempotency.ts,problem-copy.ts,catalog.ts (public-only, shrinks)}
│   ├── server/{search.server.ts,trending.server.ts,category-shortcuts.server.ts,product-page.server.ts}   # server-only
│   ├── search/{search-view.ts,price-input.ts,facet-label.ts}
│   ├── home/{rail-source.ts,category-shortcuts.ts}
│   ├── product/{cards.ts,parse-page.ts}   lib/seo/product-jsonld.ts
│   ├── pickup/{coords.ts,format.ts}   lib/analytics/track.ts   lib/attribution/{ref.ts,ref.server.ts}
│   └── storefront/architecture.test.ts
├── next.config.ts (images/CSP hosts already wired; /p handled by a page)   eslint.config.mjs (rules to error)
├── playwright.config.ts (mobile project check)   .env.example
└── tests/{search,storefront-discovery,product-community,share-link,visitor-events,product-video,sponsored-listing,
           product-page,product-recommendations,home-trending}.spec.ts  tests/visual/{home,search,product-page,product-panels}.spec.ts  helpers.ts

packages/contracts/src/{fulfilment/pickup.ts,community/discussions.ts,assistant/ask.ts,marketing/{share.ts,ads.ts},media/{gallery.ts,video.ts},events/client-events.ts,bff/product-page.ts (+gallery)}
packages/backend/libs/domains/media/{api,application}/        # B-1 public gallery read (+ e2e spec)
packages/backend/libs/composition/bff/page/section-registry.ts # B-2 gallery section (+ e2e)
packages/backend/libs/domains/community/{api,application}/    # B-4 DELETE /posts/:postId (+ e2e)
packages/backend/{seed}                                       # B-6 journey seeds
```

**Structure Decision**: keep W07/W01 layout. Server-only code in `lib/server/*.server.ts` with `import 'server-only'`; client leaves named after their UI role; business-free helpers (parsers, formatters) are pure modules with unit tests next to them. `components/product-card.tsx` moves to `components/product/product-card.tsx` (test-plan path); the old path re-exports until callers (cart, W03) move.

## Decision tables

**Cache table** (FR-151, R-02)

| Data | Where | Lifetime | Tag | Failed/degraded |
|---|---|---|---|---|
| Trending rail | `trending.server.ts` `use cache` | 30 s | `trending` | 5 s |
| Category shortcuts | `category-shortcuts.server.ts` | 60 s | `search-facets` | 5 s |
| Product aggregate | `product-page.server.ts` | 15 s | `product:{id}` | 5 s (non-empty `errors` or parse failure) |
| Search first view, pickup, discussions, ask, share, events | no server cache | — | — | — |

**Client/server split** (FR-156): client leaves are `SearchBox`, `SearchResults` (+ `FilterPanel`, `FilterSheet`, `SortControl`, `PickupMode`, `SponsoredSlot`, `CanonicalUrl`), `Gallery` lightbox part, `ProductTabs`, `PickupPanel`, `PickupMap`, `DiscussionsPanel` tree, `AskPanel`, `SharePopover`, `VideoSection` player, `ProductView`, `RefCapture`, `MobilePurchaseBar`. Everything else is a Server Component.

**Error copy**: one `problemCopy(surface, problem)` in `lib/api/problem-copy.ts` (surfaces: `search`, `pickup-search`, `product`, `pickup`, `discussions-read`, `discussions-write`, `vote`, `ask`, `share`, `video`), shared `waitText` from W01, `ProblemAlert` from W01 renders it.

## Phases (dependency order; each ends green on its narrowest test)

| Phase | Content | Proof |
|---|---|---|
| 0 | Dependencies (`dompurify`, `maplibre-gl`, `hls.js`); ESLint restrictions to error (fetch/axios/EventSource outside `lib/api`, `lib/server`, `app/api`; `dangerouslySetInnerHTML`; `NEXT_PUBLIC_API_URL`); `lib/storefront/architecture.test.ts` with its rules failing first; Playwright `mobile` project check; `tests/visual` config reuse | `vitest run lib/storefront`, `eslint` |
| 1 | **Contracts + backend**: B-7 schemas in `packages/contracts`; B-1 public gallery read; B-2 `gallery` section; B-4 `DELETE /posts/:postId`; B-5 replies read; B-6 seeds; B-8 `T037` audit of touched files | `test-spec.sh` for media gallery, bff product-page, community delete; contracts tests |
| 2 | Foundations: `routes.ts`, `query-keys.ts` (factory + removal of `products.search`), `formatMoney` (required currency) + callers, `idempotency.ts`, `safe-url.ts`, `safe-html.ts`, `problem-copy.ts`, `search-view.ts` (parser/canonicaliser), `price-input.ts`, `facet-label.ts`, `pickup/{coords,format}.ts`, `track.ts`, `useBrowserLocation` | U-view, U-price, U-money, U-keys, U-html, U-copy, U-coords, U-fmt, U-loc, U-track |
| 3 | `ProductCard` + `RailCard`, `lib/product/cards.ts`; Home: `trending.server.ts`, `category-shortcuts.server.ts`, `rail-source.ts`, rail + shortcuts + `SearchBox hero`, showcase link fixes; delete direct `fetch` from `app/page.tsx` | U-card, U-home, U-cats; VH |
| 4 | Search: `lib/api/search.ts` (+ click logging), `search.server.ts`, `lib/api/suggest.ts`, `use-suggestions`, `SearchBox` (replaces stand-in), page + `SearchResults` + filters/chips/price/sort/paging/errors/offline, `CanonicalUrl`, robots metadata, semantic mode, pickup mode (`lib/api/pickup.ts`, `PickupMode`), sponsored label, `SponsoredSlot` behind the flag; rewrite `tests/search.spec.ts` and `helpers.ts` | U-box, U-sugg, U-results, U-filters, U-sort, U-near, U-ads, U-sapi; JS, JD (search near me); VS |
| 5 | Product page read and shell: rename `[slug]`→`[productId]`, `/p` redirect, `product-page.server.ts`, `parse-page.ts`, metadata + JSON-LD, summary, breadcrumb, gallery (+ lightbox), purchase area + mobile bar (hosting W03 `AddToCartButton` with `category`), unavailable states, loading/error, rails (recommendations/trending), tabs in URL | U-page, U-ld, U-summary, U-unavail, U-sections, U-gallery, U-buy, U-rails, U-tabs, U-redir; JS product test; VP |
| 6 | Events and referral: `ProductView`, `RefCapture`, `app/api/attribution/ref/route.ts`, `ref.server.ts`, W03 follow-up bullet | U-pv, U-ref; JE |
| 7 | Tabs: Pickup panel + map (`lib/api/pickup.ts` reuse); Discussions (api, list, composer, votes, thread, delete, auth interplay, degraded); Ask (`lib/api/ask.ts`, panel); Share (`lib/api/share.ts`, popover); Videos (`lib/api/videos.ts`, section) | U-pickup, U-map, U-dlist, U-comp, U-vote, U-thread, U-del, U-dauth, U-derr, U-ask, U-aapi, U-share, U-video; VC |
| 8 | Delete the old code: `suggestionsFrom`, `SuggestResponse`, `Recommendation`/`recommendationToCard`, `fetchAutocomplete`, hand-written catalog types, `placehold.co` URLs, the old `ask-product.tsx`/`product-discussions.tsx`, `sse-reader` bearer token path (W01 may already have removed it; verify) | `tsc`, `eslint` (0 warnings in W02 files), U-arch green |
| 9 | Journeys and visual baselines per `test-plan.md` (JS, JD, JC, JL, JE, `fixme` JV/JA, `product-page`, `product-recommendations`, `home-trending`), `.env.example`/README host values, AS-69 rewording in `test-plan.md`, UNVERIFIED rows, full web suite, backend capability suite once | whole `vitest run`, `playwright test`, `next build`, backend suites |

## Backend and contract tasks

| ID | Task | Owner spec | Where | Test |
|---|---|---|---|---|
| B-1 | Public `GET /products/:productId/gallery` → `{items:[{mediaId, position, urls:{thumb,feed,full}, width, height}]}`; unknown/archived/sandbox/suspended-shop product → identical `404`; malformed id → `400`; anonymous | S29 AS-38 | `domains/media` (controller + service reading product visibility through the S05/S03 clients) | `media-gallery-public.e2e-spec.ts` (happy, ordering, 404 uniformity, 400, anonymous, only READY items) |
| B-2 | `gallery` entry in the S48 section registry (`GET /products/{id}/gallery`, budget 300 ms, optional, anonymous-safe) and `gallery` in `productPageResponseSchema`; `BFF_SECTIONS` gets `gallery`, `errors[]` may name it | S48 | `composition/bff/page/section-registry.ts`, `packages/contracts/src/bff/product-page.ts` | extend `bff.e2e-spec.ts`: present section, upstream failure → `null` + `errors` entry, budget exceeded |
| B-4 | `DELETE /posts/:postId` (author, or `ADMIN`/`MODERATOR`), `204`, idempotent, tombstone semantics as S25 FR-005/FR-052, `discussion.post_deleted` | S25 | `domains/community` | `discussions-delete-post.e2e-spec.ts`: author, moderator, other user `403`, unknown `404`, twice `204`, `401` |
| B-5 | `GET /comments/:commentId/replies` paged read (specified by S25 FR-012, route missing) | S25 | `domains/community` | `discussions-replies.e2e-spec.ts` |
| B-6 | Journey seeds: pickup point with stock near the fake location; recommendation list; trending dataset; knowledge document processed with the scripted embedder and a scripted model provider; (P3) READY video | S19, S34, S35, S47, S30 | seed command / test hooks | `globalSetup` check names the missing seed; a seed that has no owner hook is recorded in `questions.md` and its journey stays `fixme` |
| B-7 | Contract schemas (R-08) | S54 | `packages/contracts/src` | contract tests parse a real controller response per schema |
| B-8 | `// S54 T037 audit` grep of every backend file touched; migrate sites to `TransactionRunner.run` | S54 | touched files | existing suites of the touched domains |
| B-9 | Ads read `GET /ads/sponsored` is **not built** (no controller): `STOREFRONT_ADS_ENABLED` stays off, JA stays `fixme`; recorded as a sibling bullet for S36 | S36 | — | — |

## Gap coverage (gaps.md → phase)

| Gaps | Phase | Gaps | Phase |
|---|---|---|---|
| A1–A8 | 0, 2, 4, 7, 8 | E1–E7 | 7 |
| B1–B7 | 3 | F1–F6 | 7 |
| C1–C15 | 4 | G1–G3 | already closed (W07/W01); verified in Phase 0 |
| D1–D12 | 5, 6 | G4 | 0, 9 |
| G5–G7 | 4, 9 | G8 | 1 (B-6), 9 |
| G9, G10 | 0, 1 (B-7) | G11 | 0, 9 |
| H1 | 1 (B-1, B-2) | H2, H3, H4, H5 | H2: sibling bullet (R-07). H3: built by W01 (verified). H4: sibling bullet (S10/W03). H5: B-6 |
| H6 | B-6 | H7 | B-7 |
| H8 | sibling bullet to S05; U-card/U-ld treat any category string as given | H9 | verified: `/api/events` reaches `analytics.controller` through the forwarder; JE proves it |
| H10 | 6 | I | the phase table above follows gaps.md section I |

## Test strategy summary

- Every `U-*` file in `test-plan.md` is created in its phase and run alone (`vitest run <file>`).
- Journeys run one file at a time with `playwright test tests/<file>.spec.ts`; the final full run happens in Phase 9 after `next build`.
- Backend: `scripts/sdd/test-spec.sh <spec>` for B-1/B-2/B-4/B-5, then the capability suites of `media`, `community`, `composition/bff` once.
- Unverified criteria (no automated test): SC-001, SC-002, SC-003, SC-004, SC-009 (timings measured in a real browser) and the keyboard-only completion of SC-008 → `quickstart.md` "Ops artifacts" and `specs/UNVERIFIED.md`, status `not run`.
