---
id: W02
title: Home, search (autocomplete, filters, facets, sort, URL state), trending and recommendation rails, product page (product, shop, pickup near me, discussions, ask this product, share link)
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S32, S33, S34, S35, S48, W01, W03, W07]
concepts: [search-index, bff-aggregate, cache-layers, problem-json-errors, idempotency-key, rate-limit-policy]
models: []
scope:
  - packages/backend/libs/composition/bff/**
  - packages/backend/libs/domains/media/**
  - packages/contracts/src/marketing/**
  - packages/contracts/src/media/**
  - packages/web/app/dashboard/**
  - packages/web/app/products/**
  - packages/web/app/search/**
  - packages/web/components/home/**
  - packages/web/components/product/**
  - packages/web/components/search/**
  - packages/web/lib/api/**
  - packages/web/lib/home/**
  - packages/web/lib/pickup/**
  - packages/web/lib/product/**
  - packages/web/lib/search/**
  - packages/web/lib/server/**
---
# W02 - Home, search, rails and product page
## Purpose
Visitors and members find products through the Home page, the search box and the search page. They then read the product page, which shows the product, its shop, pickup points, discussions, product questions and a share link. The capability turns the {{cap:S32}} search index, {{cap:S33}} autocomplete, {{cap:S34}} and {{cap:S35}} rails and the {{cap:S48}} product-page aggregate into screens. The URL holds all search view state, so a shopper can share, reload and navigate back to any view.

## Entry points
- `/` shows the hero with the search box, category shortcuts, the "Trending now" rail and the static showcase blocks. [code: packages/web/app/page.tsx#HomePage]
- `/search` shows results, facets, filters, sort, cursor paging, "Match by meaning" and "Available for pickup near me". [code: packages/web/app/search/page.tsx#SearchPage]
- `/products/[productId]` shows the product page with the tabs Details, Pickup near me, Ask about this product and Discussions. /page.tsx#ProductPage]
- `/p/[productId]` redirects with `308` to `/products/[productId]` and keeps the query. /page.tsx#ShortProductLink]
- Search box (variants `hero`, `page`, `navbar`) calls the suggestions endpoint. [code: packages/web/components/search/search-box.tsx#SearchBox]
- Same-origin `/api/events` receives batches of visitor events. [code: packages/web/lib/api/events.ts#sendEvents]
- `GET /products/:productId/gallery` returns the public gallery of ready images by position. [code: packages/backend/libs/domains/media/api/media.controller.ts#MediaController]

## Rules
- **W02.R-01** The first response of `/` MUST contain the static shell (hero with one `h1`, search box, showcase blocks). The category shortcuts and the trending rail MUST stream in behind same-size skeletons. [proof: W02 AS-01] [code: packages/web/app/page.tsx#HomePage]
- **W02.R-02** The "Trending now" rail MUST show at most eight cards in rank order. [proof: W02 AS-02] [code: packages/web/lib/home/rail-source.ts#homeRailSource]
- **W02.R-03** If trending is empty, rate-limited, unavailable, invalid or unreachable, the rail MUST fall back to the first eight products of a browse search, with no error text. [proof: W02 AS-03] [code: packages/web/lib/home/rail-source.ts#homeRailSource]
- **W02.R-04** The search box MUST send at most one suggestion request per 150 ms of typing and MUST ignore answers for a prefix other than the current text. [proof: W02 AS-07] [code: packages/web/hooks/use-suggestions.ts#useSuggestions]
- **W02.R-05** A failed suggestion request (`429`, `400`, `5xx`, invalid body, no connection) MUST leave the list closed and MUST NOT change the typed text or block submitting. [proof: W02 AS-08]
- **W02.R-06** The search box MUST trim the text and MUST accept at most 100 characters. [proof: W02 AS-09] [code: packages/web/lib/search/submit.ts#normaliseQuery]
- **W02.R-07** The combobox MUST follow the ARIA combobox pattern (role `combobox`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, options with role `option`). [proof: W02 AS-06]
- **W02.R-08** The address bar MUST fully describe the search view (query, facets, sort, page); reload, new tab, back and forward MUST restore it. [proof: W02 AS-11] [code: packages/web/lib/search/search-view.ts#parseSearchView]
- **W02.R-09** The page MUST clean unknown, legacy, repeated or out-of-range parameters by replacing the address. [proof: W02 AS-12] [code: packages/web/lib/search/search-view.ts#parseSearchView]
- **W02.R-10** The filter panel MUST show facet counts exactly as the API gave them and MUST NOT compute counts locally. [proof: W02 AS-14] [code: packages/web/lib/search/facet-label.ts#facetLabel]
- **W02.R-11** Price fields MUST take major units and convert to minor units by the currency's decimals. A minimum above the maximum MUST be refused before any request. [proof: W02 AS-16] [code: packages/web/lib/search/price-input.ts#parsePriceInput]
- **W02.R-12** "Clear all filters" MUST keep `q` and `sort`. [proof: W02 AS-15] [code: packages/web/lib/search/search-view.ts#clearFilters]
- **W02.R-13** The page size MUST be 24 and paging MUST use a `cursor` in the address. [proof: W02 AS-18] [code: packages/web/lib/search/search-view.ts#SEARCH_PAGE_SIZE]
- **W02.R-14** Sponsored items MUST carry the visible label "Sponsored" and MUST stay in the position the API gave. [proof: W02 AS-22]
- **W02.R-15** Opening a result MUST send exactly one click record `{searchId, productId, position}` without delaying the navigation. [proof: W02 AS-23] [code: packages/web/lib/api/search.ts#logSearchClick]
- **W02.R-16** A failed search MUST show exactly one alert and MUST NOT show the previous results as current. [proof: W02 AS-24]
- **W02.R-17** Pickup coordinates MUST stay in memory and MUST be rounded to three decimals before sending. [proof: W02 AS-31] [code: packages/web/lib/pickup/coords.ts#roundCoords]
- **W02.R-18** An unavailable product MUST show exactly one full-page state; unknown, archived, sandbox and hidden products MUST show the same not-found page. [proof: W02 AS-33] [code: packages/web/components/product/product-unavailable.tsx#ProductUnavailable]
- **W02.R-19** A missing optional section of the aggregate MUST hide only that section. [proof: W02 AS-34] [code: packages/web/lib/product/parse-page.ts#parseProductPage]
- **W02.R-20** `bodyHtml` MUST pass through the allow-list sanitiser before reaching the DOM. [proof: W02 AS-47] [code: packages/web/lib/safe-html.ts#sanitizeBodyHtml]

## Behaviors
- **W02.B-01** Given trending answers `200` with items, when `/` loads, then the rail "Trending now" shows up to eight cards with rank badges, each linking to `/products/<productId>`. [proof: W02 AS-02]
- **W02.B-02** Given trending fails, when `/` loads, then browse-search products appear under the same heading. [proof: W02 AS-03]
- **W02.B-03** Given a visitor types `iph`, when the answer arrives, then the list shows suggestions in API order. [proof: W02 AS-05]
- **W02.B-04** Given answers arrive out of order for `iph` and `ipho`, then the list shows the suggestions of `ipho`. [proof: W02 AS-07]
- **W02.B-05** Given an empty box on `/search`, when submitted, then `q` is removed and browse results appear; on another page it goes to `/search`. [proof: W02 AS-09]
- **W02.B-06** Given `/search?q=espresso`, then the server returns the results, the `h1` "Results for “espresso”", the count line and the cards. [proof: W02 AS-10]
- **W02.B-07** Given a sort choice, then `sort` is set in the address (omitted for the default) and the first page shows in that order. [proof: W02 AS-13]
- **W02.B-08** Given active filters, then each shows as a removable chip and "Clear all filters" removes them. [proof: W02 AS-15]
- **W02.B-09** Given a result with `nextCursor`, then "Next page" keeps all parameters and sets `cursor`. [proof: W02 AS-18]
- **W02.B-10** Given a search that matches nothing, then the page shows "No products match your search." with no error. [proof: W02 AS-19]
- **W02.B-11** Given `/search` without `q`, then the `h1` is "All products" and no meaning-search switch appears. [proof: W02 AS-20]
- **W02.B-12** Given `q` is present and "Match by meaning" is on, then `semantic=true`, one page shows with "Showing the closest matches" and facet counts are hidden. [proof: W02 AS-21]
- **W02.B-13** Given a filter change, then the previous results stay dimmed with `aria-busy="true"` until the new ones arrive. [proof: W02 AS-25]
- **W02.B-14** Given a visible product, then the page shows breadcrumb, title, brand, rating, price, stock and "Sold by {name}". [proof: W02 AS-32, W02 AS-35]
- **W02.B-15** Given an unknown product, then the page shows "We couldn't find that product." with a "Search products" link. [proof: W02 AS-33]
- **W02.B-16** Given the aggregate returns some sections `null`, then the page renders the rest. [proof: W02 AS-34]
- **W02.B-17** Given a gallery with several images, then thumbnails switch the main image. [proof: W02 AS-36]
- **W02.B-18** Given the product is out of stock, then "Add to cart" is disabled and labelled "Out of stock". [proof: W02 AS-37]
- **W02.B-19** Given recommendations and trending items, then "Frequently bought together" and "Trending in {category}" show. [proof: W02 AS-39]
- **W02.B-20** Given `?tab=discussions`, then the Discussions panel opens. [proof: W02 AS-40]

## Lifecycles
No status of this capability changes over time.

## Owns
- Queue `media-processing` (`MEDIA_QUEUE` in `media.service.ts`) and the gallery route.
- Same-origin endpoint `/api/events` with the `product_view` event.
- Cookie `__Host-ref` (30 days) for attribution.
- Cache tags: `trending` (30 s), `search-facets` (60 s), `product:{id}` (15 s).
- Configuration: `API_URL`, `BFF_URL`, `SITE_URL`, `STOREFRONT_ADS_ENABLED`, `NEXT_PUBLIC_MAP_TILE_URL`.

## Decisions
- The page keeps all search view state in the URL, so views can be shared and restored.
- The first search view is rendered on the server, so results show without a skeleton.
- The product page reads the aggregate without visitor credentials, so one cached read serves every visitor.
- Optional sections fail independently, so one failure does not remove the page.
- Pickup coordinates stay in memory, to keep a shopper's location private.
- Server `detail` and `title` strings are never shown, so error copy stays stable.

## Known gaps
- No test carries these scenario ids: AS-04, AS-38 (focus order), AS-26 and AS-27 only partly, AS-43 to AS-44, AS-48 to AS-50, AS-52 to AS-59, AS-61 to AS-63, AS-66, AS-74, AS-75.
- Pickup near me (AS-28 to AS-31, AS-41, AS-42) has only helper tests (formatting, coordinates, location messages); no test covers the full flow or the map.
- Discussions (AS-45 to AS-47, AS-51) have tests for tabs, sanitiser, idempotency and routes only; voting, comments and delete have none.
- Ask this product (streaming, stop, refusal, errors) has no scenario-tagged test.
- Share link: AS-60 has a test; the signed-out and error cases (AS-61, AS-62) have none.
- The `__Host-ref` attribution cookie (AS-63) has no test.
- Rules R-05, R-07, R-14, R-16 name no `` symbol because the facts do not tie them to one export.
- The accessibility, touch-target and offline rules (AS-73 to AS-75) are not fully covered.

### Claims the generator could not verify (removed from the rules above)
- code ref `packages/web/app/p/[productId` (file not found: packages/web/app/p/[productId)
- code ref `packages/web/app/products/[productId` (file not found: packages/web/app/products/[productId)
