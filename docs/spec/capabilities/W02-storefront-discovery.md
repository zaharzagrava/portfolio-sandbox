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
- `/p/[productId]` redirects with `308` to `/products/[productId]` and keeps the query. /route.ts#redirectToProduct]
- Search box (variants `hero`, `page`, `navbar`) calls the suggestions endpoint. [code: packages/web/components/search/search-box.tsx#SearchBox]
- Same-origin `/api/events` receives batches of visitor events. [code: packages/web/lib/api/events.ts#sendEvents]
- `GET /products/:productId/gallery` returns the public gallery of ready images by position. [code: packages/backend/libs/domains/media/api/gallery.controller.ts#GalleryController]

## Rules
- **W02.R-01** The first response of `/` MUST contain the [static shell](../terms/static-shell.md) (hero with one `h1`, search box, showcase blocks). The [category shortcuts](../terms/category-shortcuts.md) and the [trending rail](../terms/recommendation-rail.md) MUST [stream in](../terms/streaming-section.md) behind [same-size skeletons](../terms/skeleton.md). [proof: W02 AS-01] [code: packages/web/app/page.tsx#HomePage]
- **W02.R-02** The "Trending now" rail MUST show at most eight cards in [rank order](../terms/trending-ranking-cache.md). [proof: W02 AS-02] [code: packages/web/lib/home/rail-source.ts#homeRailSource]
- **W02.R-03** If trending is empty, [rate-limited](../terms/rate-limited.md), unavailable, invalid or unreachable, the rail MUST fall back to the first eight products of a [browse search](../terms/browse-mode.md), with no error text. [proof: W02 AS-03] [code: packages/web/lib/home/rail-source.ts#homeRailSource]
- **W02.R-04** The search box MUST send at most one [suggestion request](../terms/get-suggest.md) per 150 ms of typing and MUST ignore answers for a [prefix](../terms/suggest-prefix.md) other than the current text. [proof: W02 AS-07] [code: packages/web/hooks/use-suggestions.ts#useSuggestions]
- **W02.R-05** A failed suggestion request (`429`, `400`, `5xx`, [invalid body](../terms/invalid-payload.md), no connection) MUST leave the list closed and MUST NOT change the typed text or block submitting. [proof: W02 AS-08]
- **W02.R-06** The search box MUST trim the text and MUST accept at most 100 characters. [proof: W02 AS-09] [code: packages/web/lib/search/submit.ts#normaliseQuery]
- **W02.R-07** The combobox MUST follow the [ARIA combobox pattern ↗](../sw-external-terms.md#aria-combobox) (role `combobox`, [`aria-expanded` ↗](../sw-external-terms.md#aria-expanded), [`aria-controls` ↗](../sw-external-terms.md#aria-controls), [`aria-activedescendant` ↗](../sw-external-terms.md#aria-activedescendant), options with role `option`). [proof: W02 AS-06]
- **W02.R-08** The [address bar](../terms/search-view-url-state.md) MUST fully describe the search view (query, [facets](../terms/search-facets.md), sort, page); reload, new tab, back and forward MUST restore it. [proof: W02 AS-11] [code: packages/web/lib/search/search-view.ts#parseSearchView]
- **W02.R-09** The page MUST clean unknown, [legacy](../terms/legacy-url-parameter.md), repeated or out-of-range parameters by [replacing the address ↗](../sw-external-terms.md#history-replace). [proof: W02 AS-12] [code: packages/web/lib/search/search-view.ts#parseSearchView]
- **W02.R-10** The filter panel MUST show [facet counts](../terms/search-facets.md) exactly as the API gave them and MUST NOT compute counts locally. [proof: W02 AS-14] [code: packages/web/lib/search/facet-label.ts#facetLabel]
- **W02.R-11** Price fields MUST take [major units](../terms/major-units.md) and convert to [minor units](../terms/minor-units.md) by the currency's decimals. A minimum above the maximum MUST be refused before any request. [proof: W02 AS-16] [code: packages/web/lib/search/price-input.ts#parsePriceInput]
- **W02.R-12** "Clear all filters" MUST keep [`q`](../terms/autocomplete-q-parameter.md) and [`sort`](../terms/search-sort-order.md). [proof: W02 AS-15] [code: packages/web/lib/search/search-view.ts#clearFilters]
- **W02.R-13** The page size MUST be 24 and paging MUST use a [`cursor`](../terms/pagination-cursor.md) in the address. [proof: W02 AS-18] [code: packages/web/lib/search/search-view.ts#SEARCH_PAGE_SIZE]
- **W02.R-14** [Sponsored items](../terms/sponsorship-event.md) MUST carry the visible label "Sponsored" and MUST stay in the position the API gave. [proof: W02 AS-22]
- **W02.R-15** Opening a result MUST send exactly one [click record](../terms/click-log.md) `{[searchId](../terms/search-id.md), [productId](../terms/product-id.md), [position](../terms/line-position.md)}` without delaying the navigation. [proof: W02 AS-23] [code: packages/web/lib/api/search.ts#logSearchClick]
- **W02.R-16** A failed search MUST show exactly one alert and MUST NOT show the previous results as current. [proof: W02 AS-24]
- **W02.R-17** [Pickup coordinates](../terms/pickup-coordinates.md) MUST stay in memory and MUST be rounded to three decimals before sending. [proof: W02 AS-31] [code: packages/web/lib/pickup/coords.ts#roundCoords]
- **W02.R-18** An unavailable product MUST show exactly one full-page state; unknown, [archived](../terms/product-archive.md), [sandbox](../terms/sandbox-product.md) and [hidden](../terms/search-visibility.md) products MUST show the same not-found page. [proof: W02 AS-33] [code: packages/web/components/product/product-unavailable.tsx#ProductUnavailable]
- **W02.R-19** A missing [optional section](../terms/required-section.md) of the [aggregate](../terms/page-aggregate.md) MUST hide only that section. [proof: W02 AS-34] [code: packages/web/lib/product/parse-page.ts#parseProductPage]
- **W02.R-20** [`bodyHtml`](../terms/body-html.md) MUST pass through the [allow-list sanitiser](../terms/html-allow-list-sanitiser.md) before reaching the DOM. [proof: W02 AS-47] [code: packages/web/lib/safe-html.ts#sanitizeBodyHtml]

## Behaviors
- **W02.B-01** Given [trending](../terms/get-trending.md) answers `200` with items, when `/` loads, then the [rail](../terms/recommendation-rail.md) "Trending now" shows up to eight cards with [rank badges](../terms/rank-badge.md), each linking to `/products/<productId>`. [proof: W02 AS-02]
- **W02.B-02** Given trending fails, when `/` loads, then [browse-search](../terms/browse-mode.md) products appear under the same heading. [proof: W02 AS-03]
- **W02.B-03** Given a visitor types `iph`, when the answer arrives, then the list shows [suggestions](../terms/query-suggestions.md) in [API order](../terms/suggest-ordering.md). [proof: W02 AS-05]
- **W02.B-04** Given answers arrive [out of order](../terms/stale-response-discard.md) for `iph` and `ipho`, then the list shows the suggestions of `ipho`. [proof: W02 AS-07]
- **W02.B-05** Given an empty box on `/search`, when submitted, then [`q`](../terms/autocomplete-q-parameter.md) is removed and [browse results](../terms/browse-mode.md) appear; on another page it goes to `/search`. [proof: W02 AS-09]
- **W02.B-06** Given `/search?q=espresso`, then [the server returns the results](../terms/server-rendered-search.md), the `h1` "Results for “espresso”", the [count line](../terms/search-totals.md) and the cards. [proof: W02 AS-10]
- **W02.B-07** Given a sort choice, then [`sort`](../terms/search-sort-order.md) is set in the address (omitted for [the default](../terms/search-sort-order.md)) and the first page shows in that order. [proof: W02 AS-13]
- **W02.B-08** Given [active filters](../terms/search-filters.md), then each shows as a removable [chip](../terms/filter-chip.md) and "Clear all filters" removes them. [proof: W02 AS-15]
- **W02.B-09** Given a result with [`nextCursor`](../terms/pagination-cursor.md), then "Next page" keeps all parameters and sets [`cursor`](../terms/pagination-cursor.md). [proof: W02 AS-18]
- **W02.B-10** Given a search that matches nothing, then the page shows "No products match your search." with no error. [proof: W02 AS-19]
- **W02.B-11** Given [`/search`](../terms/search-page.md) without [`q`](../terms/autocomplete-q-parameter.md), then the `h1` is "All products" and no [meaning-search switch](../terms/semantic-search.md) appears. [proof: W02 AS-20]
- **W02.B-12** Given `q` is present and ["Match by meaning"](../terms/semantic-search.md) is on, then [`semantic=true`](../terms/semantic-search.md), one page shows with "Showing the closest matches" and [facet counts](../terms/search-facets.md) are hidden. [proof: W02 AS-21]
- **W02.B-13** Given a filter change, then the previous results stay dimmed with [`aria-busy="true"` ↗](../sw-external-terms.md#aria-busy) until the new ones arrive. [proof: W02 AS-25]
- **W02.B-14** Given a visible product, then the page shows breadcrumb, title, brand, rating, price, stock and "[Sold by {name}](../terms/shop-tenant.md)". [proof: W02 AS-32, W02 AS-35]
- **W02.B-15** Given an unknown product, then the page shows "We couldn't find that product." with a "Search products" link. [proof: W02 AS-33]
- **W02.B-16** Given the [aggregate](../terms/page-aggregate.md) returns some [sections](../terms/section.md) [`null`](../terms/null-section.md), then the page renders the rest. [proof: W02 AS-34]
- **W02.B-17** Given a [gallery](../terms/product-gallery.md) with several images, then thumbnails switch the main image. [proof: W02 AS-36]
- **W02.B-18** Given the product is out of stock, then "Add to cart" is disabled and labelled "Out of stock". [proof: W02 AS-37]
- **W02.B-19** Given [recommendations](../terms/recommendation-rail.md) and [trending items](../terms/trending-score.md), then "[Frequently bought together](../terms/bought-together.md)" and "Trending in {category}" show. [proof: W02 AS-39]
- **W02.B-20** Given [`?tab=discussions`](../terms/product-page-tabs.md), then the [Discussions panel](../terms/anonymous-chat-section.md) opens. [proof: W02 AS-40]
- **W02.B-21** Given the [Discussions panel](../terms/product-discussions.md), then it shows the first 20 posts of the product's board, sorted Hot (default), Top (with a time window) or New, with `sort` and `window` in the address, and "Show more discussions" appends the next page without repeating a post. [proof: W02 AS-45] [code: packages/web/components/product/discussions/discussion-list.tsx#DiscussionList]
- **W02.B-22** Given a signed-in member who posts a discussion, then one `Idempotency-Key` is used per attempt and kept for retries of the unchanged form, a double click posts once, the list switches to New and the new post is first with focus on its title. [proof: W02 AS-46] [code: packages/web/components/product/discussions/discussion-composer.tsx#DiscussionComposer]
- **W02.B-23** Given an Upvote or Downvote press, then the score and pressed state change at once, the request sends `{value}` (1, -1 or 0 to retract), at most one request per post or comment is in flight, `409 vote_in_progress` is retried once after `Retry-After`, and any failure puts the previous state back. [proof: W02 AS-48] [code: packages/web/components/product/discussions/vote-buttons.tsx#VoteButtons]
- **W02.B-24** Given an opened post, then its comments load up to 25 at a time with at most five replies each, "Show more replies" loads the rest by cursor without repeating a comment, no Reply control exists at depth 8, and a deleted comment shows its tombstone text with its replies kept. [proof: W02 AS-49] [code: packages/web/components/product/discussions/comment-thread.tsx#CommentThread]
- **W02.B-25** Given the author of a post or comment, or an `ADMIN` or `MODERATOR`, then Delete asks for confirmation with Cancel focused, and `204` removes the post or turns the comment into a tombstone. [proof: W02 AS-50] [code: packages/web/components/product/discussions/delete-dialog.tsx#DeleteDialog]
- **W02.B-26** Given a visitor who is not signed in, then the list and threads are readable, "Log in to discuss" replaces the form with a sign-in link that returns to the same view, and a vote press shows "Sign in to vote."; given a `401` to a write while signed in, then the session-ended flow runs once and the typed text stays. [proof: W02 AS-51] [code: packages/web/components/product/discussions/discussions-panel.tsx#DiscussionsPanel]
- **W02.B-27** Given a discussions request that fails or a degraded answer, then the problem is shown beside the control that caused it with the catalogue text, the posts already loaded stay, `invalid_cursor` reloads the first page, and content that vanished is removed. [proof: W02 AS-52] [code: packages/web/lib/api/discussions.ts#listPosts]
- **W02.B-28** Given a question of 3 to 500 characters on the Ask about this product tab, when the shopper asks, then the answer is written as it arrives as plain text, the status reads "Searching the product documents…", and on completion only the cited sources are listed as "[n] {title} › {heading path} (page {page})" with the question still in the field. [proof: W02 AS-54] [code: packages/web/components/product/ask-panel.tsx#AskPanel]
- **W02.B-29** Given a stream that ends with `not_found`, a refusal, an `error` event, an event that is not valid JSON, or no `done`, then the panel shows its own text (never the server's message or the refusal category), keeps the text already received, and offers Ask again when the answer could not be completed; given `done` with `grounded: false`, then a notice says the answer is not backed by the product documents and no source is listed. [proof: W02 AS-55, W02 AS-57] [code: packages/web/lib/api/ask.ts#askProduct]
- **W02.B-30** Given a request refused before a stream opens, then one alert shows the catalogue text for its status and code and keeps the question; `404` replaces the tab content, and a `429` keeps Ask off until its wait has passed. [proof: W02 AS-56] [code: packages/web/lib/api/problem-copy.ts#problemCopy]
- **W02.B-31** Given an answer being written, then Stop (not Ask) is shown, Stop or leaving the page aborts the request and keeps the partial text with "Stopped.", a double press of Ask sends one request, and asking again clears the previous answer first; the answer is a region named "Answer" with `aria-busy` that is not a live region, and a hidden polite status announces each state. [proof: W02 AS-58, W02 AS-59] [code: packages/web/components/product/ask-panel.tsx#AskPanel]
- **W02.B-32** Given a signed-in member who presses Share, then the popover "Share this product" shows "Creating your link…", sends one link request for `{site address}/products/{id}` with one `Idempotency-Key` that is kept for repeats, shows the returned `https` short link in a read-only field with Copy link ("Link copied.", or the text selected with "Press Ctrl+C to copy." when the clipboard refuses), shows the same link when reopened during the page visit, and returns focus to Share on Escape; a short link that is not `https` is ignored. [proof: W02 AS-60, W02 AS-72] [code: packages/web/components/product/share-popover.tsx#SharePopover] [code: packages/web/lib/api/share.ts#createShortLink]
- **W02.B-33** Given a visitor who is not signed in, then Share shows "Sign in to create a share link." with a sign-in link that returns to the same page and sends no request, and the button is disabled while the session loads; given a failed link request, then one alert shows the catalogue text (the limit, "can't be shared right now", the wait, the reference of a `5xx`, the offline text) with Try again except for the limit and destination errors, `409 idempotency_in_flight` keeps "Creating your link…" and repeats the request with the same key after one second at most three times, and a `401` runs the session-ended flow. [proof: W02 AS-61, W02 AS-62] [code: packages/web/lib/api/share.ts#createShortLinkPatiently]
- **W02.B-34** Given a product page opened with `?ref=<code>` where the code is 1 to 64 characters of `A-Z a-z 0-9 _ -`, then the page sends the code once per page view to `POST /api/attribution/ref`, which answers `204` and sets the `HttpOnly`, `Secure`, `SameSite=Lax` cookie `__Host-ref` for 30 days (the last click replaces it); an invalid code, a foreign origin or a failing call changes nothing and shows nothing, and the server reads the code through `getRefCode()`. [proof: W02 AS-63] [code: packages/web/app/api/attribution/ref/route.ts#POST] [code: packages/web/lib/attribution/ref.server.ts#getRefCode] [code: packages/web/components/analytics/ref-capture.tsx#RefCapture]
- **W02.B-35** Given a visitor opens a product page, then exactly one `product_view` event with `props.product_id` and `props.category` is queued for that page view (tab changes, re-renders and the development double mount add none; another product adds one), the category being lower-cased and reduced to `[a-z0-9-]{1,40}` or left out; events go out in batches of at most 20 every 5 seconds or when the page is hidden, and nothing is queued, and no anonymous-id cookie is created, under Global Privacy Control or Do Not Track. [proof: W02 AS-67, W02 AS-68] [code: packages/web/components/analytics/product-view.tsx#ProductView] [code: packages/web/lib/analytics/track.ts#track]
- **W02.B-36** Given the aggregate's `videos` section has items, then the Details tab shows a "Videos" group of poster tiles (title as text, duration "2:05"), nothing is requested until a tile is activated, then the playback answer is fetched, the player code is loaded for the first time and the video plays with native controls, and one `video_view` event with `props.video_id` is queued per play start (not per resume); `404` reads "This video isn't available.", `429` names the wait, any `5xx` reads "Video is temporarily unavailable. Try again."; with no items nothing is shown, and a playback answer whose `masterUrl` is not `https` is refused while a `posterUrl` that is not `https` is ignored. [proof: W02 AS-65, W02 AS-72] [code: packages/web/components/product/video-section.tsx#VideoSection] [code: packages/web/lib/api/videos.ts#fetchPlayback]
- **W02.B-37** Given the deploy sets `STOREFRONT_ADS_ENABLED=true` and `/search` is on its first page outside pickup mode, then up to three cards labelled "Sponsored" appear above the results, requested for the selected category, with the visitor's anonymous id (none under Global Privacy Control or Do Not Track); each card is a plain link to `clickUrl` exactly as given (never rewritten, prefetched or kept) with `rel="sponsored nofollow"`, an item whose `clickUrl` is not `https` or a same-origin path is dropped, and empty items, `429`, `503`, an invalid body or no network show nothing; with the flag off (the default) no request is made. [proof: W02 AS-66, W02 AS-72] [code: packages/web/components/search/sponsored-slot.tsx#SponsoredSlot] [code: packages/web/lib/api/ads.ts#fetchSponsored]

## Lifecycles
No status of this capability changes over time.

## Owns
- Queue `media-processing` (`MEDIA_QUEUE` in `media.constants.ts`) and the gallery route.
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
- No test carries these scenario ids: AS-04, AS-38 (focus order), AS-26 and AS-27 only partly, AS-43 to AS-44, AS-48 to AS-50, AS-52 to AS-53, AS-61 to AS-63, AS-74, AS-75.
- Pickup near me (AS-28 to AS-31, AS-41, AS-42) has only helper tests (formatting, coordinates, location messages); no test covers the full flow or the map.
- Discussions (AS-45 to AS-53) are covered by component tests and the layout and journey specs; the long-running cases (a post deep in the board for a deep link, a thread past 25 comments) have no live-stack test.
- Ask this product (AS-54 to AS-59) is covered by component, stream-reader and layout tests; the live journey proves the stream and the answer region, but not a cited source, because the dev stack's scripted model provider cannot be scripted to cite (the uncited answer shows the "not backed by the product documents" notice).
- Share link and the referral cookie (AS-60 to AS-63) are covered by component, route and journey tests; the short domain is not reachable from the dev stack, so the journey follows the origin redirect of the same code instead of the short address, and the order that reads `__Host-ref` (W03, S10) is not proved here.
- Product videos and the sponsored slot (AS-65, AS-66) are covered by component tests only: both journeys are `test.fixme` until the dev stack seeds a ready public video and serves `GET /api/ads/sponsored` (S36 has no controller), and unlisted videos (share token, credentialed segment requests) are implemented in the player but not offered by the product page.
- Visitor events (AS-67, AS-68): the journey proves the signed-out path only; events queued at unload by a signed-in member can be refused by the CSRF check of the forwarder (see gaps, S48).
- Rules R-05, R-07, R-14, R-16 name no `` symbol because the facts do not tie them to one export.
- The accessibility, touch-target and offline rules (AS-73 to AS-75) are not fully covered.

### Claims the generator could not verify (removed from the rules above)
- code ref `packages/web/app/p/[productId` (file not found: packages/web/app/p/[productId)
- code ref `packages/web/app/products/[productId` (file not found: packages/web/app/products/[productId)
