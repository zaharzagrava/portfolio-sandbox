# Contract: S47 HTTP API

Global prefix `/api`. Errors are problem+json `{type, title, status, code, requestId, …}`; 5xx details are generic. Shared zod schemas live in `packages/contracts/src/assistant/knowledge.ts` (new) and `…/ask.ts` (corrected); web and tests import them, and every e2e parses its responses with them (VII.6).

## Schemas (fields as in `spec.md`, "Cross-capability contracts")

- `knowledgeDocumentSchema` `{id, title, visibility, productId|null, format, status, failureCode|null, chunkCount, createdAt, updatedAt}` — strict; no `storageKey`, `contentHash`, `indexedHash`, `embeddingModel`, `createdBy`, `error`.
- `knowledgeDocumentPageSchema` `{items, nextCursor|null}`.
- `knowledgeCreateRequestSchema` — strict; exactly one of `markdown` (1 byte – 1 MiB, not whitespace-only) or `pdfSha256` (`^[0-9a-f]{64}$`) + `pdfSize` (1 – 20 MiB); `title` 1–200; `visibility` `PUBLIC|SHOP_PRIVATE`; optional `productId` uuid.
- `knowledgeAdminCreateRequestSchema` — same without `visibility` and `productId`.
- `knowledgeCreateResponseSchema` `{document, deduplicated, upload?: {url, headers, expiresAt}}`.
- `knowledgeListQuerySchema` `{status?, limit 1–100 (default 20), cursor?}`; `knowledgeReindexResponseSchema` `{enqueued}`.
- `ragAskRequestSchema` — strict, `question` 3–500 characters, trimmed length ≥ 3; `ragStreamEventSchema` — discriminated by `event`.

## Routes

| Route | Guard / policy | Success | Notes |
|---|---|---|---|
| `POST /shops/:shopId/knowledge/documents` | `ShopScoped('products.write')`, `rag.ingest` | `201` new / `200` deduplicated | PDF form returns `upload`; `422 product_document_must_be_public`, `422 document_limit_reached`; other shop's or unknown product `404`; `409 product_archived` |
| `POST …/documents/:documentId/uploaded` | `products.write`, `rag.ingest` | `200` document | `409 upload_missing`; `409 invalid_transition` from `FAILED`; `404` |
| `POST …/documents/:documentId/retry` | `products.write` | `202` document (`QUEUED`) | only from `FAILED`; `409 invalid_transition` otherwise |
| `GET …/documents`, `GET …/documents/:documentId` | `products.read` | page / document | `400 validation_failed`, `400 invalid_cursor`; order `(createdAt DESC, id DESC)`; `DELETED` and other scopes never listed |
| `DELETE …/documents/:documentId` | `products.write` | `204` | repeat or other shop `404`; of two concurrent deletes exactly one is `204` |
| `POST /shops/:shopId/knowledge/ask` | `ShopScoped('shop.read')`, `rag.ask` | `200 text/event-stream` | allowed in `SUSPENDED` shops |
| `POST /products/:productId/ask` | `Firewall({anonymous: true})`, `rag.ask` | `200 text/event-stream` | `404 not_found` for unknown, `ARCHIVED` or inactive-shop products (identical bodies); invalid token `401` |
| `POST/GET /admin/knowledge/documents`, `DELETE …/:documentId` | administrator | as above (`visibility: "PLATFORM"`) | shop documents on admin routes and platform documents on shop routes → `404` |
| `POST /admin/knowledge/reindex` | administrator | `202 {enqueued}` | idempotent |

## Stream (`text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`)

- `sources {mode: 'hybrid'|'keyword', items: [{n (0-based), chunkId, documentId, title, headingPath (string), page|null}]}`
- `text {t}` · `done {citations: [{text, sources: number[]}], grounded}` · `not_found {message}`
- `refusal {category, source?: 'provider'|'moderation'}` · `error {code: 'PROVIDER_UNAVAILABLE'|'TIMEOUT'|'INTERNAL'}`

Order: `sources` → `text`+ → `done`; or `not_found` alone; or `sources` → `text`* → `refusal` | `error`. No cost, model name or provider message ever appears. The headers are written only after retrieval succeeded, so every pre-stream rejection is plain problem+json.

## Problem codes clients must handle

`validation_failed`, `invalid_cursor` (400) · `unauthenticated` (401) · `permission_denied`, `shop_suspended` (403) · `not_found` (404) · `product_archived`, `invalid_transition`, `upload_missing`, `shop_offboarding` (409) · `input_rejected` (+`category`), `product_document_must_be_public`, `document_limit_reached`, `rate_limit_cost_exceeded` (422) · `rate_limited`, `assistant_busy` (429, `Retry-After`) · `assistant_unavailable`, `rate_limiter_unavailable` (503, `Retry-After`). Limited routes carry `RateLimit` and `RateLimit-Policy` (S50).

## Breaking changes versus today (`questions.md` BREAKING)

Raw rows → DTO; free-text `error` → `failureCode`; array capped at 200 → `{items, nextCursor}`; create `201` always → `201`/`200`; other shop's product `403` → `404`; `uploaded` on any state → conditional; `sources` bare array → `{mode, items}` (`n` from 0, `headingPath` a string); `done` gains `grounded`; in-stream `BUSY` → `429 assistant_busy`; `SHOP_PRIVATE`+product `400` → `422`; inline markdown 20 MiB → 1 MiB. `contracts/src/assistant/ask.ts` (today `n` positive, `headingPath` array) changes accordingly. Consumers: `packages/web/components/product/ask-product.tsx` (W02); no mobile client exists.

## In-process contract

`KnowledgeSearchService.search(scope, question, {k ≤ 20})` → `{mode, items}`; throws `RetrievalUnavailableError` on deadline; never returns passages outside the scope. Exported from `@app/domains/assistant` together with `RetrievalUnavailableError` and `RetrievalScope`.
