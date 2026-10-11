# Research: W02 — Storefront discovery

Decisions that the spec leaves to the plan, plus facts verified in the code on 2026-10-11. Format: Decision / Rationale / Alternatives. Next.js guides read: *Caching*, `use cache`, `cacheLife` (conditional lifetimes), *Linking and navigating* (History API), *Client-side data fetching with TanStack Query* (HydrationBoundary), *JSON-LD*, *Backend for Frontend*, *Error handling*, *Route handlers*.

## Verified facts (what is built today)

| Fact | Evidence | Consequence |
|---|---|---|
| Tooling W02 needs is installed (RTL, user-event, jest-dom, msw, `@vitejs/plugin-react`, `@axe-core/playwright`, `qrcode`), Vitest `include` already covers `components/`, `app/`, `lib/`, `hooks/`, setup file has an MSW server (`onUnhandledFrame: 'error'`) | `packages/web/package.json`, `vitest.config.ts`, `vitest.setup.ts` | gaps G1–G3 are closed by W07/W01. Still missing: `dompurify`, `server-only` is aliased already, a map library, a video player library, Playwright `mobile` project check, `tests/visual/` exists (W01) |
| The root layout is rendered per request (CSP nonce) and opts out of the static shell | `next.config.ts` comment on `cacheComponents` | AS-69/FR-001 "prerendered static shell" cannot hold literally; see R-01 |
| `/api/:path*` is rewritten to the BFF forwarder, which attaches the session; `/api/bff/*` goes to the BFF directly | `next.config.ts` rewrites; `packages/backend/libs/composition/bff/forward` | W02 browser calls use relative `/api/...` URLs only (C-FWD is built by W01) |
| Contracts has `catalog` (`productPublicSchema`), `search/{product-search,suggest,recommendations,trending,click}`, `bff/product-page`, `bff/upstream`; it has **no** schema for pickup, discussions, ask stream, share link, ads, video playback, gallery, client-event batch | `ls packages/contracts/src/*` | schemas for those are added in `packages/contracts` (R-08, B-7); the temporary `lib/api/schemas/` folder of gap G10 is **not** needed |
| `GET /products/:id/gallery` (public, S29 AS-38) is **not** implemented: `media.controller.ts` has only `PUT shops/:shopId/products/:productId/gallery` and `GET media/:id` | `domains/media/api/media.controller.ts:71-84` | backend task B-1 (+ B-2 BFF `gallery` section) |
| `DELETE /posts/:postId` and `GET /comments/:commentId/replies` do not exist (the controller has post read, `posts/:id/comments`, `comments/:id` delete and votes), although S25 specifies both (FR-005, FR-012) | `domains/community/api/discussions.controller.ts:32-105` | backend tasks B-4, B-5 (S25 completion) |
| `POST /events` exists in `experimentation/api/analytics.controller.ts`; `POST /links` in `marketing/api/share-links.controller.ts`; `GET videos/:videoId/playback` in `media/api/video.controller.ts`; `POST products/:productId/ask` in `assistant/api/knowledge.controller.ts`; pickup `search/near`, `pickup-points/near`, `pickup-points/clusters`; boards/posts/comments/votes (`discussions.controller.ts`) | controllers | the forwarder reaches all of them; no new route except B-1, B-4. The ads read (`GET ads/sponsored`) has no controller yet (only `POST shops/:shopId/ads/campaigns`) → P3, conditional: the slot stays behind `STOREFRONT_ADS_ENABLED` and its journey `fixme`; no backend task |
| `components/search/search-box.tsx` is W07's stand-in (navbar only, `variant: 'navbar'`); no `lib/analytics/` exists, `track` has no stand-in file yet | `packages/web/components/search`, `grep track` | W02 owns both from scratch, keeping the names W07 imports |
| Env hosts exist: `MEDIA_HOST`, `VIDEO_HOST`, `MAP_TILE_HOST` parsed in `lib/config-parse.ts` | `lib/config-parse.ts:79-99` | W02 supplies values in `.env.example`/README and uses `config.mediaHosts` for `images.remotePatterns` (already wired) |

## R-01 Rendering model under a per-request root layout

**Decision**: "static shell" in the spec means *the shell streams first*: pages are Server Components; each runtime read (`searchParams`, `params`, cookies) sits inside a `<Suspense>` with a same-size fallback; public data uses `use cache` with `cacheLife` and `cacheTag`; the root layout stays as W07 left it. AS-69's wording "prerender their static shell" is reworded in `test-plan.md` (this spec's own artifact) to "the page streams its shell before the data and `next build` reports no blocking-route or runtime-data-outside-Suspense error" (same reconciliation as W01 R-02).
**Rationale**: the CSP nonce requires per-request HTML (W07); we cannot change it here.
**Alternatives**: a static shell with hash-based CSP (rejected: W07's decision, out of scope).

## R-02 Cache functions and lifetimes

**Decision**: three server-only modules with `use cache`:
`lib/server/trending.server.ts` (`cacheLife({ stale: 30, revalidate: 30, expire: 300 })`, tag `trending`), `lib/server/category-shortcuts.server.ts` (60 s, tag `search-facets`), `lib/server/product-page.server.ts` (15 s, tag `product:{id}`). Each cached function takes only plain arguments (id, limit) and never reads cookies/headers. A failed or degraded result calls the other branch `cacheLife({ revalidate: 5, expire: 5 })` (documented "conditional cache lifetimes": one call per invocation), so it is not kept more than 5 s; the failure result is a value (`{kind:'error', ...}`), not a throw, because a thrown error would not be cached at all and every concurrent visitor would hit the API.
**Rationale**: FR-151, AS-69. `expire` under 5 minutes makes the entry a dynamic hole at prerender time, which is already true because the layout is per request; the Suspense fallback covers it.
**Alternatives**: `fetch(..., {next:{revalidate}})` (rejected: Cache Components docs prefer `use cache`); `unstable_cache` (deprecated).

## R-03 Product page read is anonymous and shared

**Decision**: the cached read calls `GET {BFF_URL}/api/bff/product-page/{id}` with only `Accept` and `X-Request-Id`; no cookie/Authorization/`X-Anonymous-Id`. Tag `product:{id}` is revalidated by nothing in W02 (15 s expiry is the contract). The response is parsed with `productPageResponseSchema` extended with the `gallery` section (B-2). A parse failure of a *section* is handled per section (R-05); a parse failure of `product` is `502`.
**Rationale**: FR-050, S48 `private, no-store` protects shared caches, an anonymous answer holds nothing per visitor (S48 AS-02/AS-23).
**Alternatives**: client-side aggregate read (rejected: slower first paint and no SEO).

## R-04 Search page: server first view + client history updates

**Decision**: `app/search/page.tsx` (Server Component) reads `searchParams` inside `<Suspense>`, parses them with `parseSearchView` (pure, total), `redirect`s nothing (the cleaned address is applied by a tiny client leaf `CanonicalUrl` via `history.replaceState` when it differs), fetches page one through `lib/server/search.server.ts` (no `use cache`, `cache: 'no-store'`), `prefetchQuery`s into a per-request `QueryClient` and renders `<HydrationBoundary>` around the client leaf `SearchResults`. The leaf reads the view from `useSearchParams()` (kept in sync by `history.pushState/replaceState`, which the Next router observes), calls `useQuery(queryKeys.search.results(view))`, `placeholderData: keepPreviousData`, `startTransition` for control changes.
**Rationale**: the documented TanStack + Next pattern; no double fetch on first view; the URL is the only copy of the view (VI.4).
**Alternatives**: `router.push` per filter (rejected by the spec: an RSC refetch per change); `useState` for filters (forbidden).

## R-05 Optional sections

**Decision**: `parseProductPage(raw)` returns `{ product, shop, gallery, recommendations, trending, videos, degraded: boolean }` where each optional section is parsed on its own with `safeParse`; an invalid or `null` section becomes `null`; `degraded = errors.length > 0 || any section failed to parse`. Each optional section component is wrapped in a `SectionBoundary` (error boundary rendering nothing) per FR-161.
**Rationale**: P0402, AS-34.

## R-06 Gallery source

**Decision**: add the S29 public read `GET /products/:productId/gallery` (B-1) and a `gallery` entry in the S48 section registry (B-2, budget 300 ms, optional, anonymous-safe). Until B-1/B-2 are green the web code treats a missing `gallery` as `null` (placeholder), so the web work does not wait.
**Rationale**: questions.md [CONTRACT] S48+S29; composing in the web tier breaks VI.9.

## R-07 Additive `imageUrl` on rails

**Decision**: **not** built in this plan. Rails are text cards (spec Assumption); S34/S35 are built specs and an additive field is their change. The card accepts `imageUrl?: string | null` already (the `ProductCard` contract), so nothing changes in W02 when they add it. Recorded as a sibling follow-up in `gaps.md`.
**Rationale**: scope; the spec's own default.

## R-08 Contract schemas

**Decision**: add to `packages/contracts/src`: `fulfilment/pickup.ts` (`pickupNearSearchResponseSchema`, `pickupPointsNearResponseSchema`, `pickupClustersResponseSchema`), `community/discussions.ts` (`postViewSchema`, `commentViewSchema`, `postPageSchema`, `commentThreadPageSchema`, `commentRepliesPageSchema`, `voteResultSchema`), `assistant/ask.ts` (`ragAskRequestSchema`, `ragStreamEventSchema`), `marketing/share.ts` (`shortLinkSchema`, `createShortLinkRequestSchema`), `media/gallery.ts` (`productGallerySchema`), `media/video.ts` (`productVideosSchema` re-exported from `bff/upstream.ts` if it exists, `videoPlaybackSchema`), `events/client-events.ts` (`clientEventBatchSchema`, `clientEventSchema`), `marketing/ads.ts` (`sponsoredSlotsResponseSchema`). The backend controllers validate with the same schemas where they do not already (checked task by task in B-7). The shapes come from the spec's *Requires* list and the controllers' DTOs; where the backend already has a DTO, the contract schema is derived from it so a test (`contracts-resolve.test.ts`-style) proves they agree.
**Rationale**: FR-153, V.2.

## R-09 Query-key and stale-time table (AS-71)

| Key | Stale | Notes |
|---|---|---|
| `search.results(view)` | 60 s | `placeholderData: keepPreviousData`; first view hydrated |
| `search.near(view, coords3dp)` | 0 | `gcTime` 0; never persisted |
| `suggest.prefix(prefix)` | 60 s | `retry: false`; `signal` forwarded |
| `rails.trending(category)` / `rails.recommendations(id)` | 30 s | server-fed; client only if ever refetched |
| `product.page(id)` | 15 s | server-only today (cached function); key kept for tag naming |
| `pickup.near(id, {radiusKm, coords3dp})` / `pickup.clusters(id, bbox, zoom)` | 0 | refetch on tab open; infinite query for the list |
| `discussions.board(id, {sort, window})` | 30 s | infinite query, refetch on focus |
| `discussions.thread(postId, sort)` / `discussions.replies(commentId)` | 30 s | |
| `share.link(productId)` | `Infinity` for the page visit | mutation result stored with `setQueryData` |
| `video.playback(id)` | 0 | |
| `ads.sponsored(category)` | 30 s | |
Params are canonicalised by `canonicalKeyPart()` (sorted keys, defaults dropped) so equal views share a key.

## R-10 Map and video libraries

**Decision**: map: **`maplibre-gl`**, dynamic `import()` on first **Show map**, raster tiles from `NEXT_PUBLIC_MAP_TILE_URL` (`{z}/{x}/{y}` template); without it the list view only. Video: **`hls.js`** dynamic `import()` on first activation (native HLS where `canPlayType('application/vnd.apple.mpegurl')`). Both are loaded only from client leaves via `next/dynamic`/`import()`.
**Rationale**: both are widely used, MIT/BSD licensed, no network call on import, and keep the bundle out of the initial route. `leaflet` was considered for the map (smaller) but its marker DOM has no keyboard story and needs CSS imports; with a text list as the accessible equivalent either works, MapLibre avoids a second tile-format debate later.
**Alternatives**: Leaflet (simpler, heavier a11y work), `video.js` (bigger than needed), native `<video>` only (no HLS in Chromium).
**Risk**: the dev stack has no tile source, so the map journey (`map clusters`) runs against a stub tile URL served by a Playwright route; the library is mocked in unit tests (`vi.mock('maplibre-gl')`).

## R-11 Sanitiser

**Decision**: `dompurify` in `lib/safe-html.ts`, `ALLOWED_TAGS`/`ALLOWED_ATTR` per AS-47, `ALLOWED_URI_REGEXP` for `https|http|mailto`, a hook that sets `rel`/`target` on `a` and rewrites `h1`–`h6` to `p > strong` (headings demoted). Browser only (`typeof window` guard): discussions render after hydration (LOCAL decision).

## R-12 Analytics emitter

**Decision**: `lib/analytics/track.ts` implements the queue as module state (a closure, not a store: it has no React subscribers), flushes with `fetch(keepalive)` for timers and `navigator.sendBeacon` on `visibilitychange: hidden`/`pagehide`. Anonymous id cookie written with `document.cookie` (first-party analytics cookie, allowed by AS-70). `track` is called from one leaf `ProductView` (effect keyed by product id, guarded by a module-level `Set` of viewed ids per page-load so Strict Mode double mount adds none). W07 stand-in for `page_view` is replaced, same name and signature widened.
**Rationale**: FR-140..FR-144; no new global store (the queue is not UI state).

## R-13 Referral cookie

**Decision**: `app/api/attribution/ref/route.ts` (`POST`, body `{code}`; same-origin check via `Origin`/`Sec-Fetch-Site`) validates `^[A-Za-z0-9_-]{1,64}$` and answers `204` with `Set-Cookie: __Host-ref=<code>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`; the client leaf `RefCapture` posts once per page view when `ref` is valid. `lib/attribution/ref.server.ts` exports `getRefCode()`. In `next dev` over `http://localhost`, browsers accept `Secure` cookies on localhost; the journey uses that.
**Rationale**: FR-124; a Route Handler wins over the `/api/:path*` rewrite because rewrites run after the filesystem.

## R-14 `/p/[productId]`

**Decision**: `app/p/[productId]/route.ts` `GET` returns `NextResponse.redirect(new URL('/products/' + id + search, SITE_URL), 308)` for UUIDs and renders not-found (`notFound()` in a page, hence a `page.tsx` that calls `permanentRedirect`) otherwise; implemented as `page.tsx` with `permanentRedirect` (308 in a Server Component) so the not-found page keeps the app shell. The unit test `app/p/[productId]/route.test.ts` in the test-plan is renamed `page.test.tsx` in this plan (one-line change in `test-plan.md` keys).
**Alternatives**: `redirects()` in `next.config.ts` (cannot validate the UUID).

## R-15 Coordinates and the pickup hook

**Decision**: `useBrowserLocation()` keeps `status` and `coords` in `useState`, rounds with `Math.round(x * 1000) / 1000`, requests with `{ timeout: 10_000, maximumAge: 300_000, enableHighAccuracy: false }`; the query key contains the rounded coordinates, the pickup queries set `gcTime: 0`, send `cache: 'no-store'`, and no log/reporter receives them (U-near, U-coords).

## R-16 Money

**Decision**: `formatMoney(minor, currency, locale = 'en')` uses `Intl.NumberFormat(locale, { style: 'currency', currency })` and divides by `10 ** resolvedOptions().maximumFractionDigits`; the three-argument signature makes currency required; callers in cart, checkout, orders, dashboard get the currency from their data (one-line compile fixes, listed in `tasks.md` as the "formatMoney callers" task).

## R-17 Existing journeys and callers

**Decision**: `tests/search.spec.ts`, `tests/product-community.spec.ts`, `tests/helpers.ts productId()` are rewritten by this plan (BREAKING lines). `tests/product-page.spec.ts` (S48's journey, W01 follow-up) is added as part of JS/JD; `tests/product-recommendations.spec.ts` (S34 AS-48, A25) and `tests/home-trending.spec.ts` (S35 AS-41, T56) are separate small files because those specs name them; they are listed in `test-plan.md` as additional files in Phase 9.

## R-18 Backend seeds for journeys

**Decision**: a dev/test-only seed extension in `packages/backend` (`seed:dev` additions behind the existing seed command): pickup point with stock near the fake location for one seed product, a recommendation list via the S34 job call, a trending dataset via the S35 test hook (or the S39 stream with synthetic events), a READY video (S30, P3, journey `fixme`), one public knowledge document processed with the scripted embedder (S47). `globalSetup` fails fast naming the missing seed. Where the owner capability has no such hook, the journey is `test.fixme` with the missing seed named in the title and an entry in `questions.md` (never faked in the web).
