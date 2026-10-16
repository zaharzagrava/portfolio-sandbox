# Interfaces: S27 (`content`)

Schemas live in `packages/contracts` (`storyAdminSchema`, `storyListItemSchema`, `storyDraftSchema`, `publicStorySchema`, `storyVersionSchema`, `storyVersionListItemSchema`, `previewTokenSchema`, `pageSchema(…)`, event payload schemas). All errors are `application/problem+json` with a `code`. Full behavior: spec.md AS-nn.

## Staff routes (`/api`, session + `ShopScoped`, rate policy `content.write.shop` on mutations)

| Method and path | Permission | Success | Errors |
|---|---|---|---|
| `POST /shops/:shopId/stories {slug, defaultLocale?}` | write | 201 `storyAdminSchema` | 400 validation_failed, 409 slug_taken, 422 story_limit_reached |
| `GET /shops/:shopId/stories?status&limit&cursor` | read | 200 page of `storyListItemSchema` | 400 |
| `GET …/stories/:storyId` | write | 200 `storyAdminSchema` + `drafts[]` | 404 story_not_found |
| `PUT …/drafts/:locale {title, blocks, seo?, expectedRevision}` | write | 200 `storyDraftSchema` | 409 revision_conflict, 422 invalid_blocks / invalid_title / payload_too_large / locale_limit_reached, 413 |
| `DELETE …/drafts/:locale?expectedRevision` | write | 204 | 404 draft_not_found, 409 revision_conflict / default_locale_required |
| `POST …/publish {expectedVersion, at?}` + `Idempotency-Key` | write | 200 `{status, version, locales, publishedAt, scheduledAt}` | 409 version_conflict / nothing_to_publish / idempotency_in_flight, 422 no_drafts / default_locale_missing / unknown_product_reference / schedule_in_past / schedule_too_far / idempotency_key_*, 503 dependency_unavailable |
| `DELETE …/schedule` | write | 204 | 409 not_scheduled |
| `POST …/archive` | write | 200 `{status}` | 409 invalid_transition |
| `GET …/versions?limit&cursor`, `GET …/versions/:version` | write | 200 | 404 version_not_found |
| `POST …/versions/:version/restore` | write | 200 `storyAdminSchema` | 404 version_not_found |
| `POST …/preview-token {locale}` | write | 200 `{token, expiresAt}` | 404 draft_not_found |

Gate (S03): 401 no session; 404 shop_not_found for non-members; 403 permission_denied; 403 shop_suspended; 409 shop_offboarding. A story of another shop is `404 story_not_found`. A malformed id is `400`.

## Public routes (anonymous)

- `GET|HEAD /api/stories/:shopSlug/:slug/:locale` → `publicStorySchema`; `Cache-Control: public, s-maxage=300, stale-while-revalidate=86400`, `Cache-Tag: story:<id>,shop:<shopId>`, strong `ETag`, `Content-Language`; no `Vary`; 304 per `If-None-Match`; 404 `s-maxage=10`.
- `GET /api/stories/preview` header `X-Preview-Token` → same shape with `preview:true`; `private, no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`; any token failure → identical 404 `no-store`.
- `GET /api/sitemaps/stories.xml`, `GET /api/sitemaps/stories-:page.xml` (`^\d{1,9}$`, else 404) → `application/xml`, `s-maxage=3600`.

## Outbound

- CDN purge: tags `story:<id>`, `shop:<shopId>`, ≤ 30 per call, 5 s timeout, ≤ 3 in-call retries.
- Revalidation `POST <front host>/api/revalidate`, body `{"tags":[…],"eventId":"…"}`, headers `X-Revalidate-Timestamp` (unix s) and `X-Revalidate-Signature` = hex `HMAC-SHA256("<timestamp>.<raw body>", secret)`.

## Events and jobs

See [data-model.md](../data-model.md): events `story.published|archived|schedule_failed` v1; consumed `tenancy.shop_*`; jobs `stories.publish`, `stories.publish-due-sweep`.

## Configuration keys

`STORY_PREVIEW_SECRET`, `REVALIDATE_SECRET`, `REVALIDATE_URL`, `CDN_ZONE`, `CDN_TOKEN`, `FRONT_HOST`, `BACKEND_HOST`; limits (stories per shop, locales, blocks, draft bytes, schedule horizon, sitemap page capacity, preview TTL). Production start-up fails naming a missing key.
