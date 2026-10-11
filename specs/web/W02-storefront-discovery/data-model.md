# Data model: W02 — Storefront discovery

W02 adds no database table. This file records the browser-side entities, where each lives (constitution VI.4), their validation rules and the state transitions the tests rely on. Wire shapes are the `packages/contracts` schemas (see `contracts/backend-endpoints.md`); nothing here duplicates them.

## 1. State homes

| State | Home | Never |
|---|---|---|
| Search view (`q`, filters, `sort`, `semantic`, `near`, `radiusKm`, `cursor`) | URL | `useState`, Context |
| Product-page view (`tab`, `sort`, `window`, `post`) | URL | local state |
| Search results, suggestions, rails, pickup lists, discussions, replies, share link, playback, ads | TanStack Query (`lib/query-keys.ts`) | `useState`, Context, store |
| Product aggregate | server `use cache` (15 s, tag `product:{id}`) → props to Server Components | client cache |
| Filter price fields text, composer text, popover open flags, expanded flags, ask session, chosen radius, location | `useState`/`useReducer` in the lowest component | URL, storage |
| Analytics queue and anonymous id | module state in `lib/analytics/track.ts` + first-party cookie | React state, storage |
| Referral code | `__Host-ref` HttpOnly cookie (server) | JavaScript |

## 2. Search view (`lib/search/search-view.ts`)

```text
SearchView {
  q?: string            // trimmed, 1..100 (cut to 100)
  category?: string     // exact facet key, ≤ 100
  brand?: string        // exact facet key, ≤ 100
  minPriceMinor?: int   // ≥ 0
  maxPriceMinor?: int   // ≥ minPriceMinor (else both dropped)
  minRating?: 1..5
  inStock?: true
  sort?: 'price-asc' | 'price-desc' | 'newest'   // 'relevance' only with q, default omitted
  semantic?: true       // requires q
  near?: 1
  radiusKm?: 1|2|10|20|50   // 5 is the default, omitted
  cursor?: string       // opaque ≤ 2048; dropped when anything else changes
}
```

Rules (FR-020): parsing is total (never throws); first value of a repeated parameter wins; unknown and legacy names (`priceMin`, `priceMax`, `rating`, `nearMe`, `size`, `from`) are dropped; `semantic` without `q` is dropped; with `near=1` the request carries only `q`, `radiusKm`, `cursor` (plus coordinates), while the other filter values stay in the address and in the disabled controls so they return when the mode is turned off (AS-30). Canonical form: fixed parameter order `q, category, brand, minPriceMinor, maxPriceMinor, minRating, inStock, sort, semantic, near, radiusKm, cursor`, defaults omitted. `parseSearchView(raw) → { view, changed }`; `toSearchParams(view)`; `searchRequestParams(view)` (the API's names, adds `limit=24`, `facets=true` unless semantic); `canonicalKeyPart(view)` for query keys.

Transitions: any change except `cursor` removes `cursor`; toggling `semantic` or `near` removes `cursor`; **Clear all filters** keeps `q`, `sort`; **Back to first page** removes `cursor`.

## 3. Product-page view (`lib/product/page-view.ts`)

`{ tab: 'details'|'pickup'|'ask'|'discussions' (default details omitted), sort: 'hot'|'top'|'new' (default hot omitted), window?: 'day'|'week'|'month'|'year' (only with top; 'all' is default and omitted), post?: uuid, ref?: code, ad?: '1' }`. Invalid values are dropped. Tab change pushes a history entry; `sort/window/post` changes push; cleaning replaces.

## 4. Product page (parsed aggregate, `lib/product/parse-page.ts`)

`ProductPage { product: ProductPublic; shop: ShopSummary|null; gallery: GalleryItem[]|null; recommendations: RailItem[]|null; trending: RailItem[]|null; videos: VideoTile[]|null; degraded: boolean }`.
- `product` is required; an invalid `product` is `502`.
- Every other section is parsed by itself; invalid → `null`; `degraded` is true when `errors.length > 0` or a section failed to parse (cached 5 s instead of 15 s).
- `recommendations`/`trending` empty `items` → `null` (section hidden); trending drops the product's own id and is cut to 8.
- Unused sections (`flags`, `chatUnread`, `discussions`, `pickup`, `flashSale`, `auction`) are never read.

State mapping (AS-33): `404 not_found` | malformed id → `not-found` (noindex); `503`, `502`, other `5xx`, parse failure of `product` → `unavailable` (with `requestId`); `429` → `rate-limited` (with wait); network → `offline`.

## 5. Card model (`lib/product/cards.ts`)

`CardModel { id, title, brand?, priceMinor, currency, rating?, imageUrl? (https only), inStock?, sponsored?, rank?, category?, href }`.
Sources: search item → card (position order kept); trending item → rail card with `rank`; recommendation item → rail card; sponsored item → card with `sponsored: true` and `href = clickUrl` (verbatim, `rel="sponsored nofollow"`). `rating` 0 → absent ("Not rated yet" appears only on the product page). `href` defaults to `productHref(id)`.

## 6. Pickup

`BrowserLocation { status: idle|asking|granted|denied|unsupported|timeout|unavailable; coords: {lat, lng}|null }` — transitions: `idle → asking` (user action only) → `granted | denied | timeout | unavailable`; `unsupported` is decided without asking; `denied/timeout/unavailable → asking` by **Try again**. Coordinates rounded to 3 decimals on write, memory only.
`PickupListState`: infinite query keyed by `(productId, radiusKm, coords3dp)`; page size 10; items merged and de-duplicated by `id`; radius change resets to page one.
`OpeningStatus` (`lib/pickup/format.ts`): `{kind: 'unknown'} | {kind: 'open', closesAt: 'HH:mm'} | {kind: 'closed', opensAt?: {day, time}}`, a pure function of `(openingHours, now, timeZone)`.
`Cluster cells`: `{cellId, offers, pickupPoints, lat, lng, pickupPointId?}`, `truncated: boolean`; bbox rounded to 4 decimals, zoom to an integer 0–20.

## 7. Discussions

- `PostView`, `CommentView/CommentNode`, `VoteResult` as in contracts. The list is an infinite query keyed by `(productId, {sort, window})`; pages are merged and de-duplicated by `postId`; comments by `commentId`.
- **Author label**: `authorId === useAuth().user?.id ? 'You' : 'Community member'`; a tombstone has `authorId: null`.
- **Vote** (optimistic): `target = (kind, id)`; `next = pressed === value ? 0 : value`; snapshot → apply `{score, myVote}` delta → request `PUT {value: next}` → replace with server `{ups, downs, score, myVote}` or restore snapshot. At most one request per target in flight; a second press while pending replaces the queued final value. `409 vote_in_progress` → wait `Retry-After`, retry once.
- **Composer**: `{title, body, idempotencyKey}`; key is created lazily on first submit, kept while `title/body` are unchanged and the previous attempt failed, replaced after success or edit; `title` 3–300 code points trimmed, `body` ≤ 40,000.
- **Thread**: top-level page 25, each node ≤ 5 embedded replies, `hasMoreReplies` → `replies` query; depth 0–8, reply control up to depth 7; indentation capped after depth 3 at ≤ 640 px.
- **Delete**: visible when `authorId === me` or role in `ADMIN|MODERATOR`; `204` removes a post from cached lists, a comment becomes a tombstone (`deleted: true`, `deletedBy`).

## 8. Ask session (`components/product/ask-panel.tsx`, local `useReducer`)

States: `idle → asking → streaming → answered | not_found | refused | stopped | failed`, plus `blocked` (404 on request). Data: `question`, `answer` (string), `sources: Map<n, SourceItem>`, `cited: number[]`, `grounded`, `notice`. Events (validated by `ragStreamEventSchema`): `sources` stores `items` by `n`; `text` appends; `done` finishes (cited sources = `citations[].sources` unique, ordered by `n`); `not_found`/`refusal` end; `error {code}` or a premature end → `failed`; invalid JSON → `failed`; unknown event ignored. Abort: **Stop**, unmount (page leave). Question length 3–500 code points; never persisted or sent anywhere but the ask request.

## 9. Share and referral

`ShareState: signed-out | loading-session | creating | ready(shortUrl) | error(kind)`; one `Idempotency-Key` per open attempt (`newIdempotencyKey()`), retried with the same key on `409 idempotency_in_flight` (1 s, ≤ 3). `shortUrl` ignored unless absolute `https`. `ref` code: `^[A-Za-z0-9_-]{1,64}$`; cookie `__Host-ref`, 30 days, last click wins.

## 10. Visitor event (`lib/analytics/track.ts`)

`{ event_id: uuid, name, anonymous_id (22 chars [A-Za-z0-9_-]), ts: epoch ms, page?: path without query/fragment, props?: flat record (≤ 30 entries; key [A-Za-z0-9_.-]{1,64}; value string ≤ 500 | number | boolean) }`. Queue → batch ≤ 20 → every 5 s / at 20 / on hide (`sendBeacon`, `text/plain`) → retry after 1, 2, 4 s with the same `event_id`, then drop. GPC or DNT (`navigator.globalPrivacyControl === true`, `doNotTrack === '1'`) → no queue, no cookie.

## 11. Short-lived UI machines (tested at the lowest layer)

| Machine | States | Test |
|---|---|---|
| Suggestions | closed → loading → open/empty/closed-on-error; active option index | U-box, U-sugg |
| Results region | first (hydrated) → refreshing (dimmed, busy) → settled; error forms (one alert) | U-results |
| Price filter | text → valid/invalid(min>max | format) → applied | U-price, U-filters |
| Gallery | index, lightbox open | U-gallery |
| Tabs | selected (URL), mounted-set (first-open, then kept) | U-tabs |
| Delete dialog | closed → open (Cancel focused) → pending → closed | U-del |
