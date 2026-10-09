# Test Plan: W02 — Storefront discovery (`packages/web`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (77 scenarios, AS-01 to AS-77), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. Where a row names two layers, each proves a different part (stated in the cell); no part is proven twice. "Proven by backend spec" names the backend scenario that owns the rule; the UI never re-tests it (VII.7).

## Layers and conventions

- **UI journey (Playwright, happy path only)**: `packages/web/tests/*.spec.ts`, against the real local dev stack (`moon run dev-monolith`, web on 3000) with an isolated user per test, web-first assertions, no fixed sleeps. Each file's top-level `describe` names its feature (VII.8). A journey never asserts a backend rule (ranking, visibility, throttling, moderation) and never forces a failure: failure forms are unit tests with MSW. Geolocation uses the browser context's permission and fake position; the assistant answers through the test deployment's scripted model provider (S47 FR-042); trending and recommendations use seeded datasets (see Data setup).
- **UI unit (Vitest + React Testing Library)**: `*.test.tsx` / `*.test.ts` next to the code. Queries by role and label, `@testing-library/user-event`, MSW at the network boundary (problem+json fixtures parsed with the contracts schemas), `jsdom`, fake timers for debounce, retry and wait text. They cover UI-only logic, states, copy, focus and accessibility. No snapshot of markup.
- **Visual (Playwright screenshot)**: `packages/web/tests/visual/*.spec.ts`. Layout states at mobile (390 × 844, ≤ 640) and desktop (1280 × 800, ≥ 1024) in the `chromium` project plus a `mobile` project. The backend is stubbed with `page.route` (layout only, no behaviour), animations disabled, an axe scan (serious/critical = 0) runs on each state, and screenshots are compared to committed baselines.
- **Static gates** (VII.1; named in the unit column as "static"): `tsc --noEmit`, ESLint, `next build` (Cache Components validation), and the architecture test.
- Fallback and degradation paths (VII.9) each have a forcing test: trending fallback (AS-03), suggestions failure (AS-08), semantic degradation (AS-21), search error forms (AS-24), partial product page (AS-34), pickup errors (AS-43), discussions degraded (AS-52), ask failures (AS-56, AS-57), share errors (AS-62), offline and reconnect (AS-74).

### Test files

| Key | File | Top-level `describe` |
|---|---|---|
| JS | `packages/web/tests/search.spec.ts` | `Catalog & search` |
| JD | `packages/web/tests/storefront-discovery.spec.ts` | `Storefront discovery` (path of S19's journey is `packages/web/e2e/…` in its test plan; this repository's Playwright `testDir` is `tests`, see questions) |
| JC | `packages/web/tests/product-community.spec.ts` | `Product community` |
| JL | `packages/web/tests/share-link.spec.ts` | `Share link` |
| JE | `packages/web/tests/visitor-events.spec.ts` | `Visitor events` |
| JV | `packages/web/tests/product-video.spec.ts` | `Product video` (`test.fixme` until S30's seed video and the player flag exist) |
| JA | `packages/web/tests/sponsored-listing.spec.ts` | `Sponsored listing` (`test.fixme` until `STOREFRONT_ADS_ENABLED` and S36 data exist) |
| VH | `packages/web/tests/visual/home.spec.ts` | `Home layout` |
| VS | `packages/web/tests/visual/search.spec.ts` | `Search layout` |
| VP | `packages/web/tests/visual/product-page.spec.ts` | `Product page layout` |
| VC | `packages/web/tests/visual/product-panels.spec.ts` | `Product panels layout` |
| U-view | `lib/search/search-view.test.ts` | `SearchView` |
| U-price | `lib/search/price-input.test.ts` | `parsePriceInput` |
| U-box | `components/search/search-box.test.tsx` | `SearchBox` |
| U-sugg | `hooks/use-suggestions.test.tsx` | `useSuggestions` |
| U-results | `components/search/search-results.test.tsx` | `SearchResults` |
| U-filters | `components/search/filter-panel.test.tsx` | `FilterPanel` |
| U-sort | `components/search/sort-control.test.tsx` | `SortControl` |
| U-near | `components/search/pickup-mode.test.tsx` | `PickupMode` |
| U-ads | `components/search/sponsored-slot.test.tsx` | `SponsoredSlot` |
| U-sapi | `lib/api/search.test.ts` | `search api` |
| U-card | `components/product/product-card.test.tsx` | `ProductCard` |
| U-home | `lib/home/rail-source.test.ts` | `homeRailSource` |
| U-cats | `lib/home/category-shortcuts.test.ts` | `categoryShortcuts` |
| U-copy | `lib/api/problem-copy.test.ts` | `problem copy catalogue` |
| U-summary | `components/product/product-summary.test.tsx` | `ProductSummary` |
| U-ld | `lib/seo/product-jsonld.test.ts` | `productJsonLd` |
| U-page | `lib/api/product-page.server.test.ts` | `product page read` |
| U-unavail | `components/product/product-unavailable.test.tsx` | `ProductUnavailable` |
| U-sections | `components/product/product-sections.test.tsx` | `Optional sections` |
| U-gallery | `components/product/gallery.test.tsx` | `Gallery` |
| U-buy | `components/product/purchase-area.test.tsx` | `PurchaseArea` |
| U-rails | `components/product/product-rails.test.tsx` | `ProductRails` |
| U-tabs | `components/product/product-tabs.test.tsx` | `ProductTabs` |
| U-loc | `hooks/use-browser-location.test.tsx` | `useBrowserLocation` |
| U-coords | `lib/pickup/coords.test.ts` | `coordinates` |
| U-fmt | `lib/pickup/format.test.ts` | `distance and opening status` |
| U-pickup | `components/product/pickup-panel.test.tsx` | `PickupPanel` |
| U-map | `components/product/pickup-map.test.tsx` | `PickupMap` |
| U-dlist | `components/product/discussions/discussion-list.test.tsx` | `DiscussionList` |
| U-comp | `components/product/discussions/discussion-composer.test.tsx` | `DiscussionComposer` |
| U-html | `lib/safe-html.test.ts` | `sanitizeBodyHtml` |
| U-vote | `components/product/discussions/vote-buttons.test.tsx` | `VoteButtons` |
| U-thread | `components/product/discussions/comment-thread.test.tsx` | `CommentThread` |
| U-del | `components/product/discussions/delete-dialog.test.tsx` | `DeleteDialog` |
| U-dauth | `components/product/discussions/discussions-auth.test.tsx` | `Discussions and sign-in` |
| U-derr | `components/product/discussions/discussions-errors.test.tsx` | `Discussions error forms` |
| U-ask | `components/product/ask-panel.test.tsx` | `AskPanel` |
| U-aapi | `lib/api/ask.test.ts` | `ask stream` |
| U-share | `components/product/share-popover.test.tsx` | `SharePopover` |
| U-ref | `lib/attribution/ref.test.ts` | `referral cookie` |
| U-redir | `app/p/[productId]/route.test.ts` | `/p redirect` |
| U-video | `components/product/video-section.test.tsx` | `VideoSection` |
| U-track | `lib/analytics/track.test.ts` | `track` |
| U-pv | `components/analytics/product-view.test.tsx` | `ProductView` |
| U-money | `lib/utils.test.ts` | `formatMoney` |
| U-keys | `lib/query-keys.test.ts` | `queryKeys` |
| U-arch | `lib/storefront/architecture.test.ts` | `W02 architecture rules` |

## Scenario table

| Scenario | UI journey (Playwright, happy path) | UI unit (Vitest + RTL) | Visual (Playwright screenshot) | Proven by backend spec (ID) |
|---|---|---|---|---|
| AS-01 Home first view, shortcuts | JS › `home lists products` (static hero, search box and at least one product link are visible) | U-cats › `first eight category facets become links; any failure omits the row` | VH › `home: shell with skeleton rail` | S32 AS-15 |
| AS-02 Trending rail content | JS › same test (cards are links to `/products/<id>`, prices formatted) | U-card › `rail variant: rank, title, category, price from minor units and currency, one link, no implementation note` | — | S35 AS-01, AS-41 |
| AS-03 Trending fallback chain | — | U-home › `empty, 429, 503, 400, invalid body, timeout, network → catalogue browse; both fail → "No products yet."; failures not kept longer than 5 s` | — | S35 AS-13, AS-14; S32 AS-04, AS-13 |
| AS-04 Home layout | — | — | VH › `home: desktop and mobile` (order of regions, shortcut row scroll, two/four columns) | — |
| AS-05 Type, suggest, pick | JS › `type iph, pick a suggestion` (five suggestions, URL carries `q=iphone+17`) | — | — | S33 AS-55, AS-02 |
| AS-06 Combobox keyboard and ARIA | — | U-box › `roles and attributes; Down/Up/Enter/Escape/Tab; focus stays in the input; status line` | — | — |
| AS-07 Typing races | — | U-sugg › `debounce 150 ms; out-of-order answers show the latest prefix; superseded request aborted; 60 s cache; no request for blank text` | — | S33 AS-56 |
| AS-08 Suggestions fail quietly | — | U-box › `429, 400, 5xx, invalid body, network, empty 200 → list closed or "No suggestions", no alert, submit still works` | — | S33 AS-09, AS-10, AS-16..AS-19 |
| AS-09 Input limits and submit rules | — | U-box › `trim; blank submit rules; 100-char cut with hint; Clear search keeps focus; suggestion text is text` | — | S32 FR-002 (reduction); S33 AS-05, AS-06 |
| AS-10 Results from the URL | JS › `search finds one` (heading, count, cards) | U-card › `title, brand, rating text or none, price, out of stock, placeholder when imageUrl is null, sponsored label`; U-money › `currency decimals` | VS › `results: desktop and mobile` | S32 AS-01 |
| AS-11 URL is the view state | JS › `filters and sort are in the address; reload and back restore the view` | — | — | — |
| AS-12 Invalid or legacy parameters | — | U-view › `table: unknown, legacy, repeated, out-of-range, over-long q, min above max → cleaned canonical form`; U-results › `cleaned address replaces the entry (no extra history entry)` | — | S32 AS-10 |
| AS-13 Sort | JS › same filter test (sort Price: High to Low → `sort=price-desc`) | U-sort › `Relevance hidden without q; label "Featured"; default omitted from the address` | — | S32 AS-08 |
| AS-14 Facets | JS › same filter test (choose a category facet; siblings stay) | U-filters › `renders counts as given; keys as labels; single choice per group; re-select clears; empty group hidden; avgRating line` | VS › `filters: panel states` | S32 AS-15, AS-16, AS-17 |
| AS-15 Chips and clear all | — | U-filters › `chips with names; remove returns focus to heading; clear all keeps q and sort` | — | — |
| AS-16 Price range input | JS › same filter test (apply 10 to 500 → `minPriceMinor=1000&maxPriceMinor=50000`) | U-price › `major to minor units, decimals, min above max, non-numeric, negative, empty bound, band fills fields` | — | S32 AS-10 (`invalid_price_range` unreachable) |
| AS-17 Rating and stock filters | — | U-filters › `rating choices set and clear minRating; In stock only sets inStock=true` | — | S32 AS-14 |
| AS-18 Paging by cursor | JS › `next page keeps the filters and the browser back button returns` | U-results › `Next page link; Back to first page; cursor dropped on other changes; duplicate id within a page shown once; count line identical on every page` | — | S32 AS-09 |
| AS-19 Empty results | — | U-results › `no match message, hint with q, Clear all filters only when filters are on` | VS › `results: empty` | S32 AS-14, AS-02 |
| AS-20 Browse mode | — | U-results › `heading "All products"; sort label Featured; no meaning switch` | — | S32 AS-04, AS-08 |
| AS-21 Meaning search | — | U-results › `switch sets semantic; one page, no Next page, facet counts hidden with the note; degraded answer shows the notice and keeps the switch` | — | S32 AS-18, AS-19, AS-20 |
| AS-22 Sponsored label | — | U-card › `label announced before the title; position and order untouched` | — | S32 AS-05 |
| AS-23 Click logging | — | U-sapi › `one keepalive record per result per view with the API position; failures ignored; never blocks navigation` | — | S32 AS-70, AS-71 |
| AS-24 Search error forms | — | U-results › `invalid_cursor → first page with notice; 429 with wait and re-enable; 503, 5xx, no body → Try again with reference; offline → retry on online; unreachable 422 codes → cleaned view; box and filters stay usable`; U-copy › `search rows of the catalogue` | — | S32 AS-09, AS-10, AS-12, AS-13, AS-19 |
| AS-25 Loading and transitions | — | U-results › `first view has no skeleton; client change keeps previous results dimmed with aria-busy; cached view shows at once and refreshes` | VS › `results: refreshing` | — |
| AS-26 Search layout | — | — | VS › `search: desktop sidebar, mobile filter sheet, toolbar, chips row` | — |
| AS-27 Search accessibility | — | U-results › `one main (layout), one h1, Filters form landmark, Search results region, count in region, focus after chip removal and page change`; U-filters › `keyboard operation of every control` | VS › axe on every state at both widths | — |
| AS-28 Pickup search happy path | JD › `search near me` (grant location; cards show distance and point; radius changes `radiusKm`) | U-fmt › `distance text` | — | S19 AS-01, AS-05 |
| AS-29 Location unavailable | — | U-loc › `denied, unsupported, insecure, timeout, unavailable → states and exact messages; Try again where it helps; no API call`; (messages reused by AS-43) | — | — |
| AS-30 Pickup mode limits and errors | — | U-near › `filters disabled with values kept; heading; no count; 429, 503, offline forms; empty with radius control` | VS › `search: pickup mode` | S19 AS-08, AS-09 |
| AS-31 Coordinates privacy | — | U-coords › `rounded to three decimals; never exposed by the hook API except in memory`; U-near › `address never contains coordinates; request has cache no-store` (last test of the file) | — | S19 FR-052 |
| AS-32 Product summary and metadata | JS › `home → search → product` (heading, price `$899.99`, "In stock") | U-summary › `breadcrumb, brand and tag links, rating text, no stock count, description as text`; U-ld › `currency from the response, "<" escaped as <, availability` | VP › `product: desktop and mobile` | S05 AS-23 |
| AS-33 Product unavailable states | — | U-page › `404, 503, 502, 429, network map to the page states`; U-unavail › `copy, Try again, reference, noindex marker, link to search` | VP › `product: not found and unavailable` | S48 AS-07..AS-11 |
| AS-34 Partial product page | — | U-sections › `table: each optional section null or invalid → hidden, page and purchase area intact; error codes never rendered; degraded response not kept more than 5 s` | VP › `product: all optional sections missing` | S48 AS-12..AS-15; S34 AS-49; S35 AS-42 |
| AS-35 Shop line | — | U-summary › `"Sold by {name}" as text; omitted when null` | — | S48 FR-001 |
| AS-36 Gallery | — | U-gallery › `thumbnail switching with aria-current; lightbox closes with Escape and restores focus; placeholder without images or on image error; eager first image; https-only URLs` | VP › `product: gallery states` | S29 AS-38 |
| AS-37 Purchase area | — | U-buy › `order of controls; Add to cart disabled and labelled when out of stock; bottom bar only when the main area is out of view and not covering focus` | VP › `product: mobile bottom bar` | — |
| AS-38 Product layout | — | — | VP › `product: desktop two columns and mobile single column; focus order` | — |
| AS-39 Rails on the product page | JD › `product page shows frequently bought together` (S34 dataset D: cards in order, links) | U-rails › `empty items, 404, 429, 503, invalid body → section absent; own product removed from trending; max eight` | — | S34 AS-48, AS-02; S35 AS-42 |
| AS-40 Tabs and URL | JC › `discussions deep link opens the tab` | U-tabs › `ARIA tab pattern keys; only the active panel exposed; invalid tab → details; lazy mount; tab in the address` | — | — |
| AS-41 Pickup near me, happy path | JD › `pickup near me` (allow location; points with distance, quantity and status) | U-fmt › `distance, opening status table: empty hours, open, closed with next opening, other time zone` | — | S19 AS-01, AS-41 |
| AS-42 Pickup map | JD › `map clusters` (open the map, markers with offers visible) | U-map › `request after 300 ms pause with rounded bounds; superseded request aborted; truncated note; list view when no tile source; marker names; Close returns focus` | VC › `pickup map: desktop panel and mobile dialog` | S19 AS-34 |
| AS-43 Pickup panel states | — | U-pickup › `idle makes no request; asking; denied/unsupported/timeout reuse the AS-29 messages; empty; 429; 5xx; offline` | VC › `pickup: states` | S19 AS-08, AS-09, AS-43 |
| AS-44 Radius and paging | — | U-pickup › `radius change refetches from page one; Show 10 more appends without duplicates and moves focus; button absent without a cursor` | — | S19 AS-41 |
| AS-45 Discussion list, sorts, paging | JC › `start a discussion, upvote it, reply, ask the product` (list opens on the tab) | U-dlist › `sort and window in the address; window only with top; show more de-duplicates by postId; empty text; skeleton; author label You or Community member; relative times` | — | S25 AS-33..AS-39 |
| AS-46 Start a discussion | JC › same test (post with markdown, new post first) | U-comp › `counters; Post disabled while pending; idempotency key kept on retry and replaced after success or edit; double click posts once; field errors; focus and status after success` | — | S25 AS-01, AS-03, AS-06, AS-17 |
| AS-47 Safe rendering | JC › same test (bold rendered, no raw tags) | U-html › `table of hostile inputs: script, img, event handlers, javascript links, other schemes, nested quotes, headings demoted; links get rel and target` | — | S25 AS-08, AS-09 |
| AS-48 Voting | JC › same test (upvote → score 1) | U-vote › `optimistic update and rollback; flip and retract send value 1, -1, 0; self vote aria-disabled with text; signed-out prompt; vote_in_progress retried once after Retry-After; failures per catalogue` | — | S25 AS-24..AS-30 |
| AS-49 Comments and replies | JC › same test (reply appears under the post, count rises) | U-thread › `embedded replies and Show more replies; no Reply at depth 8; tombstone texts; mobile indentation cap; de-duplication; expanded post in the address` | — | S25 AS-13..AS-16, AS-20..AS-23 |
| AS-50 Delete | — | U-del › `visible for author and for ADMIN and MODERATOR only; dialog with Cancel focused; 204 removes or tombstones with status; 403, 404, 409 refresh the item` | — | S25 AS-21, AS-22, AS-47 |
| AS-51 Signed out and session ended | — | U-dauth › `signed-out controls and sign-in links with returnTo; vote prompt; 401 on a write runs the W01 flow once and keeps the typed text` | — | S25 AS-04, AS-55; W01 AS-26 |
| AS-52 Discussion errors and degraded | — | U-derr › `table of problem codes → texts beside the control; degraded notice; board_not_found; board_closed; invalid_cursor reload; vanished content removed; list stays on failure`; U-copy › `discussion rows of the catalogue` | — | S25 AS-02, AS-39, AS-52, AS-53 |
| AS-53 Discussions layout and accessibility | — | U-dlist › `article named by title; h2/h3 order; labelled sort controls; focus after show more` | VC › `discussions: desktop column of votes, mobile inline votes; composer; thread` with axe | — |
| AS-54 Ask, happy path | JC › same test (ask a question the seeded document answers; answer and a cited source appear) | U-ask › `status, token-by-token text, cited sources only with heading path and page, plain text, question kept` ; U-aapi › `SSE parsing: sources items by n, text, done` | — | S47 AS-01 |
| AS-55 Not found and refusal | — | U-ask › `not_found shows our copy, not the server message; refusal shows the copy without category; partial text kept with the rest-can't-be-shown line` | — | S47 AS-03, AS-12 |
| AS-56 Ask request errors | — | U-ask › `404 replaces the tab; 422, 429 ×2 with wait and re-enable, 503, 400, offline, 5xx with reference; question kept`; U-copy › `ask rows` | — | S47 AS-04..AS-08, AS-48 |
| AS-57 In-stream errors and ungrounded | — | U-ask › `error codes and an abrupt end keep the text and show Ask again; grounded false notice and empty sources`; U-aapi › `invalid JSON event ends the answer` | — | S47 AS-09..AS-12 |
| AS-58 Stop, leave, double press | — | U-ask › `Stop aborts and keeps text with "Stopped."; unmount aborts; one request on double press; asking again clears first; tab switch keeps streaming` | — | S47 AS-11 |
| AS-59 Ask layout and accessibility | — | U-ask › `region Answer with aria-busy and no live token region; hidden polite status; role alert only for request errors` | VC › `ask: desktop and mobile` | — |
| AS-60 Share, happy path | JL › `share a product, copy the link and open it as a visitor` (popover shows the short link, copy status, lands with `?ref=`) | U-share › `creating state; one request with Idempotency-Key and SITE_URL destination; reopen shows the same link; clipboard fallback; Escape restores focus` | VC › `share: popover and mobile sheet` | S37 AS-01, AS-66 |
| AS-61 Share signed out | — | U-share › `signed-out prompt with returnTo; no request; disabled while the session is loading` | — | S37 (401 on `POST /links`) |
| AS-62 Share errors | — | U-share › `link_limit_reached, destination errors, 429 with wait, 409 in flight retried with the same key at most three times, 503 with reference, 401 flow, offline` | — | S37 AS-02, AS-10, AS-14 |
| AS-63 Referral cookie | JL › same test (after landing, the context holds `__Host-ref` with the code, HttpOnly, 30 days) | U-ref › `code validation table; route answers 204 with the exact Set-Cookie attributes; invalid code or failure changes nothing; last click replaces` | — | S37 AS-24, AS-25 |
| AS-64 `/p/{id}` redirect | — | U-redir › `308 to /products/<id> with every parameter kept; non-UUID renders not found` | — | S36 AS-26; S37 AS-24 |
| AS-65 Product videos | JV › `play a product video` (`test.fixme`) | U-video › `tiles from items; player code loaded on first activation; one video_view per play; 404, 429, 503 texts; absent without items` | — | S30 AS-31, AS-38, AS-39 |
| AS-66 Sponsored slot | JA › `sponsored cards above results` (`test.fixme`) | U-ads › `clickUrl verbatim; rel sponsored nofollow; not prefetched; empty, 429, 503, invalid, offline render nothing; flag off makes no request` | — | S36 AS-26 |
| AS-67 `product_view` once | JE › `a product view reaches ingestion` (request to `/api/events` carries one `product_view` with `product_id` and `category`) | U-pv › `once per page view; Strict Mode double mount and tab changes add none; another product adds one`; U-track › `event shape and props limits` | — | S35 AS-16; S39 AS-02 |
| AS-68 Batching, retry, privacy | — | U-track › `batch of 20, 5 s flush, visibility change uses sendBeacon, retry 1/2/4 s with the same event_id then drop; GPC and DNT create no cookie and no event; anonymous id format` | — | S39 AS-02..AS-09 |
| AS-69 Rendering model | — | static: `next build` succeeds with Cache Components (no runtime-data-outside-Suspense or blocking-route error); U-page › `product read sends no cookie, Authorization or X-Anonymous-Id; cache key is the id; degraded not kept`; U-arch › `no "use cache" function reads cookies or headers` | — | — |
| AS-70 Boundaries and data flow | — | static: U-arch › `no fetch, axios or EventSource in components or hooks; no NEXT_PUBLIC_API_URL; no Authorization or storage access in W02 files; every page and layout is a Server Component; client files are leaves; props passed to client files are plain fields` | — | — |
| AS-71 State homes and keys | — | U-keys › `W02 keys are tuples from the factory, params canonicalised so equal views share a key`; U-arch › `no server data in useState or Context; no new Context or store` | — | — |
| AS-72 Content safety | — | U-arch › `dangerouslySetInnerHTML only in sanitizer output and JSON-LD`; U-card › `non-https imageUrl ignored`; U-share › `non-https shortUrl ignored`; U-ads › `non-https clickUrl ignored`; U-video › `non-https masterUrl ignored` | — | — |
| AS-73 Problem forms | — | U-copy › `table-driven: every (surface, status, code) in the catalogue → exact text; Retry-After wait text; reference for 5xx; unknown 4xx and 5xx fall back; server detail and title never rendered` | — | S32/S33/S34/S35/S19/S25/S47/S37/S48 problem codes (each backend spec owns its code) |
| AS-74 Offline and reconnecting | — | U-results › `offline shows the copy; online event refetches and shows Reconnecting… with aria-busy`; U-comp › `offline write fails at once and keeps the text` | — | — |
| AS-75 Accessibility baseline | — | per-component tests above assert labels, headings, `aria-*`, live regions and focus; U-box, U-tabs, U-gallery, U-del, U-share dialogs: `Escape closes and returns focus` | VH, VS, VP, VC › axe scan (serious/critical = 0) on every state at both widths; 320 px no horizontal scroll; 200 % zoom | — |
| AS-76 Lists and performance | — | U-card › `memoised: same props do not re-render`; U-box › `typing does not re-render the results grid (render counter)`; U-arch › `no array index as key in W02 files` | — | — |
| AS-77 Console hygiene | — | U-copy › `problemFromError keeps only status, code, requestId`; U-ask, U-comp, U-box, U-near › `console and reporter spies receive no question, text or coordinates`; U-track › `no search text, question or coordinates in any event` | — | — |

## Coverage notes

- **Journeys**: five live files (JS, JD, JC, JL, JE) plus two `fixme` files (JV, JA). Each journey has one happy path; none asserts a backend rule. JC owns S25's W02 journey (post with markdown, upvote, reply, new post first) and the S47 happy path; JD owns S19's W02 step list ("pickup near me", "map clusters") and S34 AS-48; JS owns S33 AS-55, S35 AS-41 and the catalogue journey; JL owns S37 AS-66.
- **Pattern-map rows**: P0402 → AS-34, AS-33, AS-69; P0901 → AS-11, AS-12, AS-40, AS-70, AS-71; P0902 → AS-07, AS-25, AS-69, AS-76.
- **Edge cases appear once**: unknown and legacy parameters (AS-12, U-view), inverted price range (AS-16, U-price), forged cursor (AS-24, U-results), out-of-order suggestions (AS-07, U-sugg), denied location (AS-29, U-loc), hostile markup (AS-47, U-html), self vote (AS-48, U-vote), depth limit (AS-49, U-thread), refusal after partial text (AS-55, U-ask), clipboard failure (AS-60, U-share), privacy signals (AS-68, U-track). Layout and accessibility states live only in the visual column; failure forms live only in the unit column; the architecture rules are one static test.
- **Data setup** (journeys never write backend data except through the UI):
  - `seed:dev` supplies the catalogue and the seller shop (existing). **Needed (gaps D-series)**: a pickup point of the seed shop with stock for one product near the fake location (S19 seed), a product with a recommendation list (S34 dataset D built by calling the job), a trending dataset (S35 dataset T through the analytics stream or a test-only merge hook), one READY product video (S30), one public knowledge document for one product processed with the scripted embedder (S47), and a scripted model provider in the test deployment.
  - Journeys that need these (JD pickup, map and rails; JC ask; JV) fail fast in `globalSetup` with a message naming the missing seed instead of timing out.
  - Geolocation: `context.grantPermissions(['geolocation'])` and `context.setGeolocation(...)` through the helper `grantLocation(page, lat, lng)`; denial is a unit test.
  - A second browser context plays the visitor who opens the short link in JL.
- **Tooling prerequisites** are listed in `gaps.md` section G (React Testing Library, user-event, jest-dom, MSW, axe, `@vitejs/plugin-react`, Vitest `include` for components and hooks, a visual project).
