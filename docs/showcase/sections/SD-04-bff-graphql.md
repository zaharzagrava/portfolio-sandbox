# SD-04 — Backend-for-Frontend (mobile/web) with GraphQL aggregation

Status: ☑ done (typechecked; spec written, not run) · Phase 5 · Depends on: SD-39 (sessions), SD-38, most read models

## Marketplace adaptation
The product page needs product + shop + rating summary + stock-near-me + discussion count + recommendations + chat unread + flags — today that's 8 calls. A **BFF** aggregates them (web via Next.js later; mobile via GraphQL now).

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **Aggregate endpoint** `GET /bff/product-page/:id` with parallel downstream calls, **per-call timeouts**, **partial responses** for optional widgets (`errors: [{section:'recommendations'}]`) | 04/01 §2.1–2.2, 10/04 #4 |
| **GraphQL** (`@nestjs/graphql` + Apollo/Mercurius) for mobile with **DataLoader** batching (N+1 prevention), query depth/complexity limits, persisted queries | 04/01 §2.6 |
| BFF holds the session: HttpOnly cookie ↔ server-side tokens (token-handler pattern) + CSRF | 05/02 §3 |
| Internal calls via service tokens (SD-39) | 05/02 §8 |
| No business rules in BFF ("no god BFF") — only composition | 10/04 #4 |
| HTTP/2 between BFF and services, keep-alive pools | 04/01 §1.1 |

## Steps
- [x] `apps/bff/` — REST aggregate + GraphQL schema (Product, Shop, Discussion, Recommendation types), DataLoaders per request (request-scoped via CLS, not Nest REQUEST scope — documented why).
- [x] Complexity plugin, persisted queries (hash allowlist).
- [x] e2e: product page with recommendations service timing out → 200 with partial error; GraphQL query for 20 products → 1 batched shop lookup.

## Scale
- Target: 50k RPS product pages.
- Hot path: all downstream reads hit caches/read models; BFF stateless; fan-out bounded (promise pool).
- Proof: k6 product-page; p99 < 150 ms with one dependency slowed to 2 s (timeouts cap it).

## Implementation notes (2026-10-01)
- **New deployable `apps/bff`** (`nest start bff`), with no database connection on purpose: everything comes from core over HTTP (`CoreClient` on the pooled `ResilientHttpClient`, per-call timeouts, the caller's bearer forwarded), so business rules can't leak into the BFF. Deps: `@nestjs/graphql`, `@nestjs/apollo`, `@apollo/server`, `graphql@16` (pinned for Apollo 5), `dataloader`.
- **`GET /api/bff/product-page/:id`:** `product` is required; `shop`, `recommendations` (300 ms), `trending` (200 ms), `flags` (150 ms) and `chatUnread` (200 ms, logged-in only) load in parallel with their own AbortController budgets. Failures/timeouts become `null` plus `errors: [{section, reason}]`.
- **GraphQL (code-first)** at `/api/graphql`:
  - `product(id)` and `products(ids)`; `Product.shop` and `Product.recommendations` are resolved through per-request DataLoaders created in the context factory (not Nest REQUEST scope, which would make the whole provider chain request-scoped).
  - 20 products → 1 product batch + 1 shop batch.
- **Core `BatchReadModule`:** `GET /api/batch/{products,shops}?ids=` (≤ 100, ordered, nulls, public fields only, sandbox shops excluded).
- **Limits:** `costLimit` validation rule (depth ≤ 6, cost ≤ 2000, list fan-out multiplied by `ids` length / `first`) runs before execution.
- **Persisted queries:** Express middleware before Apollo with a hash → document allowlist (`persisted-queries.allowlist.ts`). Enforced in production, open in development; unknown hash → `PersistedQueryNotFound`.
- **Spec** `bff/bff.e2e-spec.ts` (real BFF + Apollo against a stub core server): partial response within budget, no N+1, limits reject before any downstream call, persisted queries.
