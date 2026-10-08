# Gaps: current code vs W02 spec

Files in scope: `packages/web/app/page.tsx`, `app/search/page.tsx`, `app/products/[slug]/{page,loading}.tsx`, `components/product-card.tsx`, `components/product/{ask-product,product-discussions}.tsx`, `components/add-to-cart-button.tsx` (W03, host only), `lib/api/{catalog,sse-reader,client,errors}.ts`, `lib/{query-keys,utils,providers}.ts`, `next.config.ts`, `tests/{search,product-community,helpers}.ts`, `vitest.config.ts`, `playwright.config.ts`, `eslint.config.mjs`. Line numbers refer to the files as read on 2026-10-06. This is the implementation agent's to-do list; the order of work is at the end. Nothing was changed while writing this spec. Items owned by W01 (session, tokens, CSRF, `useAuth`) or W07 (navbar frame, headers) are listed only where W02 depends on them.

## A. Data flow and constitution VI

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | Network calls inside components: `apiClient.get/post/put` in the discussions component, hand-made `streamSse` call in the ask component, raw `fetch` in the search page and the home page | `product-discussions.tsx:36-57`, `ask-product.tsx:27`, `search/page.tsx:22-64`, `app/page.tsx:197-209` | FR-070..FR-107, AS-70 (everything moves into `lib/api/search.ts`, `suggest.ts`, `pickup.ts`, `discussions.ts`, `ask.ts`, `share.ts`, `videos.ts`, `ads.ts` and server-only modules) |
| A2 | Server data copied into `useState` and filters kept in `useState` seeded from the URL, then pushed back with `router.push` | `search/page.tsx:71-81,99-122` | FR-020, FR-022, FR-023, AS-11, AS-71 |
| A3 | Ad-hoc query keys inside components; `products.search(query)` in the factory is unused | `search/page.tsx:89,95`, `product-discussions.tsx:37,48,55`, `lib/query-keys.ts:2-6` | FR-154, AS-71 |
| A4 | Responses are typed by hand-written interfaces, not parsed with contract schemas (`packages/contracts` has no source) | `lib/api/catalog.ts:8-52` | FR-153, AS-70 (needs the schemas named in the contracts section; see H) |
| A5 | Absolute base URL `NEXT_PUBLIC_API_URL \|\| 'http://localhost:3000'` and a bearer token from JavaScript reach the discussions and ask calls | `lib/api/client.ts:3-24,48-51`, `sse-reader.ts:51-59` | AS-70 (W01 removes the token; W02 uses relative same-origin URLs only) |
| A6 | No server-only module boundary: `serverApiUrl()` lives in a file imported by client code too | `lib/api/catalog.ts:85` | FR-152 (`server-only` import; `API_URL`, `BFF_URL`, `SITE_URL` read only there) |
| A7 | Stale times are the global default (60 s) for everything; discussions and pickup need their own | `lib/providers.tsx:15-18` | FR-155, Defaults |
| A8 | No static guard against `fetch` in components, `dangerouslySetInnerHTML` outside the sanitiser, array-index keys, new Context or store | `eslint.config.mjs` | AS-70, AS-72, AS-76: add `no-restricted-syntax`/import rules and the architecture test `lib/storefront/architecture.test.ts` |

## B. Home

| # | Gap | Where | Spec |
|---|---|---|---|
| B1 | Trending read as a bare array with `id`, `price` (cents); S35's envelope, `rank`, `priceMinor`, `currency`, `category` are not read | `app/page.tsx:185-209` | FR-002, AS-02 |
| B2 | Prints "Powered by Count-Min Sketch + top-K heap (SD-32)" | `app/page.tsx:234-236` | AS-02 (S35 FR-027 requires removal) |
| B3 | `cache: 'no-store'` on both calls: every home view calls the API twice, nothing is in the static shell | `app/page.tsx:199,205` | FR-002, FR-151, AS-69 (`use cache`, 30 s, tag `trending`) |
| B4 | Fallback is the old search response (`hits`, `size=8`); failures become "No products yet." without distinguishing an outage | `app/page.tsx:205-209,213-215` | FR-003, AS-03 |
| B5 | No category shortcuts and no search box on the home page; the navbar search is a dead button | `app/page.tsx:45-58`, `components/layout/navbar.tsx:76-95` (W07 frame) | FR-001, FR-004, FR-010, AS-01 |
| B6 | The "AI Shopping Assistant" card links to `/search`; highlight cards reuse hrefs | `app/page.tsx:104-111` | FR-005 (every link resolves to the right route; LOCAL) |
| B7 | Cards show a `placehold.co` image, `rating 0`, no price currency | `components/product-card.tsx:26,44-49`, `app/page.tsx:203` | FR-024, AS-72 |

## C. Search page

| # | Gap | Where | Spec |
|---|---|---|---|
| C1 | `'use client'` page, no server-rendered first view, "Loading..." fallback text | `search/page.tsx:1,402-408` | FR-022, AS-10, AS-69 |
| C2 | Wrong API contract: `priceMin`/`priceMax` ×100, `ratingMin`, comma-joined `category`, `sort=relevance` always sent, `size` missing, `facets` not requested; responses read as `hits` | `search/page.tsx:22-52` | FR-020, FR-021 (S32 FR-001 answers `400` for the old names) |
| C3 | Every failure returns an empty result, so errors look like "No results found" | `search/page.tsx:48-51,279-294` | FR-036, AS-24 |
| C4 | Hard-coded categories with invented counts; no brand, price band or rating facets | `search/page.tsx:318-348` | FR-027, AS-14 |
| C5 | Price slider capped at 1000 in major units and a number input per bound with `onBlur` apply; no validation, no currency | `search/page.tsx:350-378` | FR-029, AS-16 |
| C6 | No rating, in-stock or semantic controls, no chips, no clear-all except in the empty state | `search/page.tsx:286-293` | AS-15, AS-17, AS-21 |
| C7 | "Load More" button has no handler; no cursor paging | `search/page.tsx:303-309` | FR-031, AS-18 |
| C8 | Near me switch writes `nearMe=true` and does nothing | `search/page.tsx:381-396`, `tests/search.spec.ts:30-38` (`test.fail`) | FR-040..FR-044, AS-28..AS-31 |
| C9 | Autocomplete: 300 ms debounce, from 2 characters, no abort, no stale guard, `suggestionsFrom` of the old response, popover over a cmdk `Command` (not the combobox pattern: the input is not the combobox, no `aria-activedescendant`, no status line) | `search/page.tsx:54-61,83-92,145-207`, `catalog.ts:47-82` | FR-011..FR-014, AS-05..AS-08 |
| C10 | Clear button has no accessible name; the input has no label (placeholder only); a `form` has no submit button | `search/page.tsx:149-173` | FR-017, FR-187, AS-09 |
| C11 | Nested `<main>` inside the layout's `<main>`; filter column visible from `md` (768 px) rather than 1024 px; filter sheet on the left with no footer actions | `search/page.tsx:217,249,257`, `app/layout.tsx:42` | FR-181, AS-26, AS-27 |
| C12 | Sort is a `Select` that always shows "Relevance"; no "Featured" for browse; `updateSearch` does not drop `cursor` | `search/page.tsx:227-243` | FR-026, AS-13 |
| C13 | Click records (`POST /api/search/clicks`) are never sent; `searchId` is not read | — | FR-035, AS-23 |
| C14 | No `sponsored` label, no sponsored slot, no `robots` rule | — | AS-22, AS-66, FR-025 |
| C15 | Cards: `any` typed items, `key={product.id}` fine, but `ProductCard` shows `shopName` from `brand`, "(0)" reviews, double-announces the title (image alt equals the link text) | `search/page.tsx:298`, `components/product-card.tsx:33-45` | FR-024, AS-10, FR-187 |

## D. Product page

| # | Gap | Where | Spec |
|---|---|---|---|
| D1 | Reads product and recommendations separately, both `no-store`, recommendations `limit=4` and errors become `[]`; the metadata function fetches the product a second time | `products/[slug]/page.tsx:20-34,38` | FR-050, FR-053, AS-34 (one anonymous aggregate read, `use cache` 15 s) |
| D2 | `price` in cents with `formatMoney(price)` (USD default); structured data hard-codes `USD`; JSON-LD is inserted with plain `JSON.stringify` (a `<` in a title ends the script) | `products/[slug]/page.tsx:41-58,77`, `lib/utils.ts:7-17` | FR-052, FR-053, FR-160, AS-32, AS-72 |
| D3 | Shows `quantity` ("In Stock (N available)") which the public view no longer has | `products/[slug]/page.tsx:89-93` | FR-052 (S05 AS-23) |
| D4 | `placehold.co` hero image for every product, no gallery, no thumbnails, no lightbox | `products/[slug]/page.tsx:71-73` | FR-056, AS-36 |
| D5 | No shop line, no brand or tag links, no rating "not rated" state; `Number(product.rating).toFixed(1)` shows "0.0" | `products/[slug]/page.tsx:79-86` | AS-32, AS-35 |
| D6 | Not found = `notFound()` for every failure including `5xx`; the 503/502/429 forms do not exist; no `error.tsx` | `products/[slug]/page.tsx:22-23,39` | FR-051, AS-33, FR-161 |
| D7 | No partial-section handling, no per-section error boundary; one failing call in `Promise.all` is swallowed only for recommendations | `products/[slug]/page.tsx:36-39,121-130` | FR-054, FR-161, AS-34 |
| D8 | Tabs are local state (`defaultValue`), not in the URL; content mounts at once (discussions are requested only when the tab opens: fine) | `products/[slug]/page.tsx:108-119` | FR-059, AS-40 |
| D9 | No trending-in-category rail, no pickup section, no share, no videos, no mobile purchase bar | — | FR-058, FR-070..FR-077, FR-120..FR-125, FR-130, AS-37, AS-39 |
| D10 | `loading.tsx` skeleton is generic; no `tab`-aware layout; `ProductPage` wraps one big Suspense around everything | `products/[slug]/loading.tsx`, `page.tsx:135-143` | FR-061, FR-150 |
| D11 | No `product_view` event; nothing reads `?ref=`; no `/p/[id]` route | — | FR-124, FR-125, FR-141, AS-63, AS-64, AS-67 |
| D12 | `AddToCartButton` takes only `{productId, disabled}` (W03 adds `category`) | `components/add-to-cart-button.tsx:11` | FR-057 (host contract with W03) |

## E. Discussions

| # | Gap | Where | Spec |
|---|---|---|---|
| E1 | Board id `product-<id>`; expects `{posts}`; sends `{targetType, value}` to votes; reads `post.comments` | `product-discussions.tsx:26,38,54,110` | FR-080, AS-45, AS-48 (S25 questions D5) |
| E2 | `bodyHtml` inserted with `dangerouslySetInnerHTML` and no client sanitiser (the comment claims the server did it) | `product-discussions.tsx:107-108` | FR-084, AS-47, AS-72 |
| E3 | No `Idempotency-Key` on post creation; double submit protection is only the disabled button | `product-discussions.tsx:41-51` | FR-083, AS-46 |
| E4 | No sort tabs, no paging, no comments, no replies, no delete, no author label, no degraded notice, no per-error copy (all errors are `apiErrorMessage` toasts) | `product-discussions.tsx:36-57,59-118` | AS-45..AS-52 |
| E5 | Signed-out visitors get `/login` without `returnTo`; vote buttons are `disabled` (not focusable, no reason) | `product-discussions.tsx:68-70,97-103` | FR-088, AS-48, AS-51 |
| E6 | After posting, the list is refetched with `sort=new` hard-coded, so a hot/top view could hide the new post | `product-discussions.tsx:38,48` | FR-083, AS-46 |
| E7 | Dates rendered with `toLocaleDateString()` (locale-dependent, no `<time>`) | `product-discussions.tsx:110` | FR-091 |

## F. Ask this product

| # | Gap | Where | Spec |
|---|---|---|---|
| F1 | Reads only `text`, `done`, `not_found`, `error`/`refusal`; ignores `sources` (now `{mode, items}`) and `grounded`; shows the server `message` of `not_found` | `ask-product.tsx:29-38` | FR-101, FR-102, AS-54, AS-55, AS-57 |
| F2 | Only `429` is distinguished; `404`, `422 input_rejected`, `503 assistant_unavailable`, `400` are one generic message; `429` has no wait text | `ask-product.tsx:39-42` | AS-56, FR-174 |
| F3 | No Stop button, no abort on unmount or tab change; a second press during streaming is only blocked by the disabled button | `ask-product.tsx:21-47,62` | AS-58, FR-104 |
| F4 | `JSON.parse(e.data)` can throw inside the event callback and is not caught per event | `ask-product.tsx:28` | FR-101 |
| F5 | Answer is not a labelled region; no hidden status; testids only | `ask-product.tsx:50-68` | AS-59, FR-105 |
| F6 | Component owns the stream read; the bearer token is added by the helper | `ask-product.tsx:27`, `sse-reader.ts:45-70` | FR-100, AS-70 |

## G. Test tooling

| # | Gap | Where | Spec |
|---|---|---|---|
| G1 | React Testing Library, `@testing-library/user-event`, `@testing-library/jest-dom` are not installed | `package.json` | test-plan (all U-* component rows) |
| G2 | MSW is not installed; no handlers or problem+json fixtures parsed with contract schemas | — | test-plan conventions |
| G3 | Vitest `include` covers only `lib/**/*.test.ts` and `hooks/**/*.test.ts`; components, `app/**` and `*.test.tsx` are not collected; no React plugin, no setup file (jest-dom matchers, MSW server, `matchMedia`, `IntersectionObserver`, geolocation and clipboard stubs) | `vitest.config.ts:5-10` | all U-* rows (`include` must add `components/**/*.test.{ts,tsx}`, `app/**/*.test.{ts,tsx}`; plugin `@vitejs/plugin-react`; `setupFiles`) |
| G4 | No Playwright `mobile` project, no visual folder or screenshot config, no axe | `playwright.config.ts:44-48` | VH, VS, VP, VC (add `@axe-core/playwright`, a 390 × 844 project, `expect.toHaveScreenshot` defaults, `tests/visual/`) |
| G5 | `productId()` helper reads `hits[].source.title`; breaks with S32's `items[].title` | `tests/helpers.ts:46-58` | FR-154 note, Provides (keep the contract, change the parsing) |
| G6 | Existing journeys depend on the old UI: first `getByPlaceholder(/search/i)`, the `combobox` of the sort `Select`, placeholder `Max`, tab name `Discussions`, `getByLabel('Question')` on the page without opening a tab | `tests/search.spec.ts:8-38`, `tests/product-community.spec.ts:8-35` | rewrite per test-plan (JS, JC) |
| G7 | Journeys for autocomplete, facets, paging, pickup, map, rails, share, events do not exist | `tests/` | JS, JD, JL, JE; `fixme` JV, JA |
| G8 | Seeds missing for journeys: a pickup point with stock near a fake location, a recommendation list, a trending dataset, a public knowledge document processed with the scripted embedder and a scripted model provider, a READY product video | `tests/global-setup.ts`, backend `seed:dev` | test-plan Data setup (owners S19, S34, S35, S47, S30; each journey fails fast naming the missing seed) |
| G9 | New dependencies needed: `dompurify` (+ types), `server-only`, a map library and a video player library (both loaded lazily; chosen in `plan.md`), `@axe-core/playwright`, `msw`, testing-library packages | `package.json` | FR-084, FR-075, FR-130 |
| G10 | `packages/contracts` has no source; the schemas of the contracts section do not exist yet | `packages/contracts/` | FR-153 (blocks `lib/api/*` parsing; until then W02 keeps zod schemas in a temporary `lib/api/schemas/` marked for removal) |
| G11 | No architecture test for the W02 rules | — | U-arch (AS-69..AS-72, AS-76) |

## H. Missing backend endpoints, sections and contracts (owner named; constitution IX.7)

| # | Need | Owner | Why |
|---|---|---|---|
| H1 | A **`gallery` section** in `GET /api/bff/product-page/:productId` (S29 `GET /products/:id/gallery`, budget 300 ms, optional, public) | S48 (R2 composition) + S29 | The public product view has no image; composing it in the web tier would break VI.9 |
| H2 | Additive `imageUrl: string \| null` on recommendation and trending items | S34, S35 (image resolved in their hydration step or by a batch media read) | Rails are text-only cards today |
| H3 | Authenticated forwarding of same-origin `/api/*` writes (boards, votes, links, ask) with the BFF session | S48 (W01 C-FWD) | Without it the browser cannot post, vote or share once tokens leave JavaScript |
| H4 | Order creation accepts the attribution code read from `__Host-ref` | S10 (with W03) | S37 attributes links; nothing consumes the referral yet |
| H5 | A test hook to build dataset D (bought-together) and dataset T (trending) on demand in the test deployment | S34, S35 | Journeys cannot wait for a nightly job or a stream window |
| H6 | Seed of a pickup point with stock for a seeded product; a READY public video; a processed public knowledge document; a scripted model provider and embedder in the test deployment | S19, S30, S47 | Journeys JD, JV, JC |
| H7 | Names of the pickup, discussion, gallery and event-batch schemas in `packages/contracts` (assumed names in the spec) | S19, S25, S29, S39, S54 | `lib/api/*` imports them |
| H8 | Confirmation that product `category` is a lowercase slug (`^[a-z0-9-]{1,40}$`) | S05 | S35 counts a category only in that alphabet |
| H9 | Same-origin `POST /api/events` served by the core API (the edge `/collect` is another origin) | S39, W07 (rewrites) | The browser talks only to the same origin |
| H10 | Web-side only: a route handler `app/api/attribution/ref/route.ts` that sets `__Host-ref`; it takes precedence over the `/api/:path*` rewrite (rewrites run after the file system) | W02 | FR-124 |

## I. Order of work

1. Tooling first (G1–G3, G5, G9, G10): install the test libraries, widen Vitest `include`, add the setup file and MSW server; create the contracts schemas or the temporary schema folder; add the architecture test with its first rules failing.
2. Foundations: `lib/routes.ts`, `lib/query-keys.ts`, `lib/api/*` clients with schema parsing, `formatMoney` with a required currency, `newIdempotencyKey`, `lib/safe-html.ts`, `problem-copy`, `useBrowserLocation`, `track`.
3. Rail card and `ProductCard`; Home (B1–B7); `/p/[productId]` redirect; rename `[slug]` to `[productId]`.
4. Search: URL state module, server-rendered first view, results region, filters, facets, paging, errors, then autocomplete (`SearchBox`), then sponsored label and click logging, then pickup mode and semantic mode.
5. Product page: aggregate read and caching, summary, gallery, partial sections, tabs, rails, metadata; then Pickup (list, map), Discussions (list, composer, votes, comments, delete), Ask, Share and the referral endpoint, videos and the sponsored slot, `product_view`.
6. Journeys and visual tests per `test-plan.md`; update `search.spec.ts`, `product-community.spec.ts`, `helpers.ts`; fixme files JV and JA.
7. Coordinate H1–H9 with the owners; remove the temporary schema folder when `packages/contracts` exists.
