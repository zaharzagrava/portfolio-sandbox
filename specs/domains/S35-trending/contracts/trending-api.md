# Contract: `GET /api/trending`

Anonymous, identical for every caller. Schemas in `packages/contracts/src/search/trending.ts` (exact names below); a copy of the shapes lives in `spec.md` "Provides".

## Request

`trendingQuerySchema` (strict):

| Parameter | Rule | Default |
|---|---|---|
| `category` | 1–40 characters of `[a-z0-9-]`; never truncated | `all` |
| `limit` | integer 1–20; `0`, `21`, `-1`, `abc`, `2.5`, empty → `400`; never clamped | `20` |
| any other parameter | `400` | — |

## Responses

| Status | Body | Headers |
|---|---|---|
| `200` | `trendingResponseSchema`: `{category, windowMinutes: 60, generatedAt (ISO instant), items: [{rank ≥ 1, productId (uuid), title, priceMinor (integer ≥ 0), currency (3 letters), category, score (integer ≥ 1)}]}`; `items` may be empty, at most `limit` long; order: score desc, `productId` asc; every item visible and (for a category other than `all`) in the requested category at request time | `Cache-Control: public, max-age=30, s-maxage=30`; no `Set-Cookie`, no `Vary: Cookie`/`Authorization` |
| `400` | problem+json `code: "validation_failed"`, `errors: [{field, message}]` | `Cache-Control: no-store` |
| `429` | problem+json `code: "rate_limited"` (policy `discovery.trending`, 300/min per address, fail open) | `Retry-After` (≥ 1 s), `no-store` |
| `503` | problem+json `code: "trending_unavailable"` (aggregate read > 100 ms or failed, product lookup > 100 ms, shop lookup > 50 ms); never a partial or unfiltered list | `Retry-After: 5`, `no-store` |

Problem body fields: `type`, `title`, `status`, `detail`, `instance`, `requestId`, `code`, `errors?`. A `GET` changes no state. An invalid or expired bearer token is ignored (no `401`).

## Consumer obligations (W02, S48, FR-027)

Treat the rail as optional (composition budget 200 ms); render `title` as text and money from `priceMinor` + `currency`; handle empty `items`, `429`, `503` without breaking the page; validate with `trendingResponseSchema`; do not rank or filter again.

## Stream consumed (R3)

Topic `analytics.events`, key `anonymous_id`, group `discovery-trending-topk`, value validated by `storedAnalyticsEventSchema` (S39). Invalid messages → `discovery-trending-topk.dlq`. Events emitted: none.
