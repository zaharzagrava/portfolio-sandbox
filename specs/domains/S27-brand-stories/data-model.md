# Data model: S27 (`content`)

All tables are owned by `domain:content` in `db/ownership.ts`. No foreign key leaves the domain. Every statement carries `shopId`.

## Tables

| Table | Columns (new in *italics*) | Keys / indexes |
|---|---|---|
| `Story` | `id uuid`, `shopId uuid` (**no FK**), `slug`, `defaultLocale`, `status` ∈ `DRAFT\|PUBLISHED\|ARCHIVED` (check drops `SCHEDULED` in contract step), `publishedVersion int null`, `publishedAt`, `scheduledAt timestamptz null`, *`scheduledBy uuid null`*, *`scheduleFailure jsonb null` `{at, code}`*, *`sitemapPosition bigint null` from sequence `story_sitemap_position_seq`*, `createdAt`, `updatedAt` | PK `id`; unique `(shopId, slug)`; unique `sitemapPosition` where not null; index `(shopId, createdAt desc, id desc)` for the list; partial index `(scheduledAt, id)` where `scheduledAt is not null` for the sweep; index `(sitemapPosition)` where `status='PUBLISHED'` |
| `StoryDraft` | `storyId`, `locale`, `title`, `blocks jsonb`, `seo jsonb`, *`revision int`*, `updatedAt`; (shopId carried for predicate and shop purge) | PK `(storyId, locale)`; index `(shopId, storyId)` |
| `StoryVersion` | `storyId`, `version int`, `locale`, `title`, `blocks`, `seo`, *`publishedAt`*, *`publishedBy uuid`*, `shopId` | PK `(storyId, version, locale)`; index `(shopId, storyId, version desc)`; immutable (no UPDATE path in code) |
| `StoryTransition` (new) | `id`, `shopId`, `storyId`, `from`, `to`, `action` ∈ `create\|publish\|schedule\|cancel_schedule\|fire\|fire_failed\|archive`, `actor uuid null`, `occurredAt` | PK `id`; index `(shopId, storyId, occurredAt)` |
| `StoryShop` (new, R3 copy) | `shopId` PK, `slug`, `status` ∈ `ACTIVE\|SUSPENDED\|DELETING\|DELETED`, `shopVersion bigint` | unique `slug` where status ≠ `DELETED`; written only by the shop-copy consumer |

Redis (derived): `story:pub:<shopSlug>:<slug>` → `{storyId, shopId, shopSlug, slug, version, defaultLocale, publishedAt, locales:{[locale]:{title,blocks,seo}}}`, TTL 60 s. Idempotency records and inbox rows belong to S54/S53 tables.

## State model

`DRAFT → PUBLISHED` (publish); `PUBLISHED → PUBLISHED` (republish, version+1); `PUBLISHED → ARCHIVED` (archive); `ARCHIVED → PUBLISHED` (publish). A schedule never changes `status`. Every transition is a conditional `UPDATE` affecting one row plus a `StoryTransition` row in the same transaction. Illegal moves: `409 invalid_transition` / `not_scheduled`.

## Domain value types (pure, in `domain/`)

`Block` = `heading{level 2|3,text}` | `richText{html}` | `image{url,alt,width,height}` | `product{productId}` | `quote{text,cite?}` | `video{url}`; `Seo{description?,ogImage?}`; `Locale` (`xx` or `xx-XX`); `Slug` (`^[a-z0-9][a-z0-9-]{1,80}$`); `Cursor` (opaque, signed-free base64 of `(createdAt,id)` validated on parse).

## Ports (tokens in `domain/ports.ts`)

`STORY_REPOSITORY`, `DRAFT_REPOSITORY`, `VERSION_REPOSITORY`, `TRANSITION_REPOSITORY`, `SHOP_COPY_REPOSITORY`, `SITEMAP_READER`, `READ_MODEL` (get/put/del), `CDN_PURGER`, `REVALIDATION_CLIENT`, `PRODUCT_REFERENCE_CHECKER` (wraps S05), `SHOP_LOOKUP` (wraps S03 R1), `CLOCK`, `PREVIEW_SIGNER`.

## Events (topic `stories.events`, key `storyId`)

`story.published` v1 `{storyId, shopId, shopSlug, slug, version, locales}`; `story.archived` v1 `{storyId, shopId, shopSlug, slug, version}`; `story.schedule_failed` v1 `{storyId, shopId, scheduledAt, code}`. Consumed: `tenancy.shop_created|updated|status_changed|deleted`.

## Jobs

`stories.publish` `{storyId, scheduledAt}` key `story-publish:<storyId>:<scheduledAt>`, concurrency 5; `stories.publish-due-sweep` cron `* * * * *` single-run. Both declared with `declareJobType` next to the `JobPayloads` augmentation.
