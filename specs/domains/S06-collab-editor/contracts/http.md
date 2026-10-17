# HTTP contract: S06 drafts

Prefix `/api`. All routes: `ShopScoped(permission)`, order of checks `401` → `404 shop_not_found` → `403 permission_denied` → `403 shop_suspended` / `409 shop_offboarding`. Errors are `application/problem+json` with `code`. Schemas live in `packages/contracts/src/catalog/drafts.ts` and are exported from the contracts index; e2e specs parse every response with them. Cross-tenant ids (`:draftId`, `:versionId` of another shop or draft) answer the same `404` as unknown ids.

| Route | Permission | Request | Success | Errors (code) |
|---|---|---|---|---|
| `POST /shops/:shopId/drafts` | products.write | `draftCreateRequestSchema` `{title 1–120, productId?: uuid}` strict | `201 draftSchema` | `validation_failed`, `product_not_found`, `product_archived`, `draft_limit_reached`, 429 (`catalog.draft-write.shop`) |
| `GET /shops/:shopId/drafts?status&limit&cursor` | products.read | query: `status` ∈ draft statuses, `limit` 1–100 (20), `cursor` | `200 draftPageSchema` `{items, nextCursor}` | `validation_failed`, `invalid_cursor` |
| `POST …/drafts/:draftId/connect` | products.read | — | `200 draftConnectSchema` `{url, ticket, canWrite, expiresAt}` | `draft_not_found`, `collab_unavailable` (503, `Retry-After: 5`), 429 `Retry-After` (`catalog.draft-connect.user` 30/min, fail closed → 503 when store down) |
| `POST …/drafts/:draftId/archive` | products.write | — | `200 draftSchema` | `draft_not_found`, `invalid_transition` (+`currentStatus`), `publish_in_progress` |
| `GET …/drafts/:draftId/versions?limit&cursor` | products.read | | `200 draftVersionPageSchema` | `invalid_cursor`, `validation_failed` |
| `GET …/drafts/:draftId/versions/:versionId` | products.read | | `200 draftVersionDetailSchema` | `version_not_found`, `version_unavailable` (503, `Retry-After`) |
| `POST …/drafts/:draftId/versions` | products.write | `draftVersionCreateRequestSchema` `{name 1–80, no control chars}` | `201 draftVersionSchema` | `validation_failed`, `version_limit_reached`, `invalid_transition` |
| `POST …/drafts/:draftId/publish` | products.write | header `Idempotency-Key` (1–128), body `draftPublishRequestSchema` `{acknowledgeProductVersion?: int}` strict | `200 draftPublishResultSchema` `{productId, productVersion, versionId}` | `idempotency_key_required` / `_invalid` / `_reuse` (422), `request_in_flight` (409), `invalid_transition`, `publish_in_progress`, `product_version_conflict` (+`currentVersion`), `product_archived`, `product_not_found`, `listing_invalid` (422, `errors:[{field,code}]`), `collab_unavailable` (503), 500 generic |

`draftSchema`: `{id, shopId, productId|null, title, status, baseProductVersion|null, createdBy, createdAt, updatedAt, publishedAt|null}`. `draftVersionSchema`: `{id, name, kind: 'named'|'published', createdBy, createdAt}`; detail adds `content: {title, description, priceMinor, brand, category, quantity, specs}`.

Publish limit policy `catalog.draft-publish.shop` 10/min per shop (fail closed). The `shopId`, creator and publisher always come from the request context.

Idempotency note: the idempotency facility's own codes are mapped to the names above by an adapter (`idempotency_key_reuse` is the spec name; the facility's internal error class is translated in the controller layer filter, not in the facility).
