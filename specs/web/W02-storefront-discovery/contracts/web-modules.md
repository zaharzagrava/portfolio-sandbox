# Contract — web modules and URLs (`packages/web`)

Names are the public surface other capabilities import. W07 stand-ins keep their names and props; W02 replaces the bodies.

## URLs

`/` · `/search?q&category&brand&minPriceMinor&maxPriceMinor&minRating&inStock&sort&semantic&near&radiusKm&cursor` · `/products/{productId}?tab&sort&window&post&ref&ad` · `/p/{productId}` (308 to `/products/{productId}`, query kept) · `POST /api/attribution/ref`. `/products/{non-uuid}` renders not-found. Legacy search names are dropped (cleaned by `replaceState`), never echoed.

## Modules

| Module | Exports |
|---|---|
| `lib/routes.ts` | `productHref(productId)`, `searchHref(view: Partial<SearchView>)` |
| `lib/search/search-view.ts` | `SearchView`, `parseSearchView(raw)`, `toSearchParams(view)`, `searchRequestParams(view)`, `canonicalKeyPart(view)` |
| `lib/query-keys.ts` | adds `search.{results,near}`, `suggest.prefix`, `rails.{trending,recommendations}`, `product.page`, `pickup.{near,clusters}`, `discussions.{board,thread,replies}`, `share.link`, `video.playback`, `ads.sponsored`; removes `products.search` |
| `lib/api/{search,suggest,pickup,discussions,ask,share,videos,ads,events}.ts` | typed functions (`fetchSearch(view, {signal})`, `logSearchClick(record)`, `fetchSuggestions(prefix, {signal})`, `fetchPickupNearSearch(...)`, `fetchPickupPoints(...)`, `fetchPickupClusters(...)`, `listPosts/createPost/listComments/listReplies/createComment/putVote/deletePost/deleteComment`, `askProduct(question, {signal, onEvent})`, `createShortLink(destination, key)`, `fetchPlayback(videoId)`, `fetchSponsored(category)`, `sendEvents(batch, {beacon})`), each parsing with the contract schema; no component calls them with raw URLs |
| `lib/api/idempotency.ts` | `newIdempotencyKey(): string` |
| `lib/api/problem-copy.ts` | `problemCopy(surface, problem): { text: string; reference?: string; retryable: boolean }`, `Surface` |
| `lib/server/*.server.ts` | `getTrending()`, `getCategoryShortcuts()`, `getProductPage(id)`, `getSearchFirstView(view)` (`server-only`, the only readers of `API_URL`, `BFF_URL`, `SITE_URL`) |
| `lib/analytics/track.ts` | `track(event)` as in the spec's Provides; `__resetTrackForTests()` |
| `lib/attribution/ref.server.ts` | `getRefCode(): Promise<string \| null>` |
| `lib/safe-html.ts` | `sanitizeBodyHtml(html)` |
| `lib/utils.ts` | `formatMoney(minor, currency, locale?)` (currency required) |
| `hooks/use-browser-location.ts` | `useBrowserLocation()` |
| `hooks/use-suggestions.ts` | `useSuggestions(text)` → `{ items, status, announce }` |
| `components/search/search-box.tsx` | `SearchBox({ variant: 'hero' \| 'page' \| 'navbar' })` (renders nothing for `navbar` on `/` and `/search`) |
| `components/product/product-card.tsx` | `ProductCard(props)` per the spec's Provides (memoised; server-renderable); `components/product-card.tsx` re-exports until W03 callers move |
| `components/product/purchase-area.tsx` | hosts W03's `<AddToCartButton productId category disabled />` |

## Behavioural guarantees

No W02 request carries a token from JavaScript; no W02 page requests a third-party host by default; every list uses stable keys; every write sends the CSRF header and, where required, `Idempotency-Key`; a `401` from a W02 write while signed in runs W01's session-ended flow once; nothing sensitive (question, search text, discussion text, coordinates) reaches the URL, console, reporter or an analytics event.
