---
id: S27
title: Brand stories CMS (versioned multi-locale stories, scheduled publish, preview, cache tags, sitemap)
kind: capability
status: draft
generated_at: 66fe392f
depends_on: [S01, S03, S05, S49, S50, S52, S53, S54]
concepts: [problem-json-errors, outbox-task-queue, tenant-shop-rbac, transaction-runner, rate-limit-policy, idempotency-key, cache-layers]
models: []
scope:
  - packages/backend/libs/domains/content/**
---
# S27 - Brand stories CMS (versioned multi-locale stories, scheduled publish, preview, cache tags, sitemap)

## Purpose
Brand staff write stories, one draft per locale, and publish them. Publishing freezes all locale drafts into one immutable numbered version, now or at a future reveal time. Readers get the published story anonymously through a CDN: the origin answers from a short-lived read model, every response carries cache headers and an entity tag, and a change reaches every cache layer by tag within a minute. Staff can preview a draft with a signed short-lived token, take a story down, read the version history and roll back. Search engines read a streamed sitemap. Rich text is sanitised when it is written. The shop's slug and status come from a copy kept from tenancy events, never from the tenancy tables.

## Entry points
- Staff routes under `/shops/:shopId/stories` (`products.read` for the list, `products.write` for everything else): create, list, detail, save and delete a locale draft, publish or schedule, cancel a schedule, archive, list and read versions, restore a version, mint a preview token.
- Public routes (anonymous): `GET|HEAD /stories/:shopSlug/:slug/:locale`, `GET /stories/preview` (header `X-Preview-Token`), `GET /sitemaps/stories.xml`, `GET /sitemaps/stories-:page.xml`.
- Published events (topic `stories.events`): `story.published`, `story.archived`, `story.schedule_failed`.
- Consumed events: `tenancy.shop_created`, `tenancy.shop_updated`, `tenancy.shop_status_changed`, `tenancy.shop_deleted`, and this capability's own story events (cache invalidation).
- Jobs: `stories.publish`, `stories.publish-due-sweep` (every minute).

## Rules
- **S27.R-01** A story is created with a slug (`^[a-z0-9][a-z0-9-]{1,80}$`) that is unique within the shop and permanent, and a default locale (`xx` or `xx-XX`, default `en`); any other input answers `400 validation_failed`, a taken slug `409 slug_taken` (also under concurrency) and the 5,001st story `422 story_limit_reached`. [proof: S27 AS-01, S27 AS-02, S27 AS-03, S27 AS-04] [code: packages/backend/libs/domains/content/application/stories.service.ts#StoriesService]
- **S27.R-02** A locale draft is saved only with the `expectedRevision` it replaces (0 for a new locale); a stale revision answers `409 revision_conflict`, so two editors never overwrite each other; at most 20 locales per story. [proof: S27 AS-05, S27 AS-09, S27 AS-10] [code: packages/backend/libs/domains/content/application/drafts.service.ts#DraftsService]
- **S27.R-03** Blocks are exactly `heading`, `richText`, `image`, `product`, `quote`, `video`; URLs are `https`; a video host is matched exactly on the parsed host (`www.youtube.com`, `player.vimeo.com`, `stream.marketplace.dev`), and on `stream.marketplace.dev` only a public `/p/<videoId>/master.m3u8` without query or credential is accepted, never an unlisted `/u/` path. Violations answer `422 invalid_blocks`, an empty or over-200-character title `422 invalid_title`, a draft over 256 KiB `422 payload_too_large`, a body over 1 MiB `413`. [proof: S27 AS-08] [code: packages/backend/libs/domains/content/domain/blocks.ts#Block]
- **S27.R-04** Rich text is sanitised on write against a fixed allowlist, idempotently; every other field is stored and returned verbatim and clients render it as text. [proof: S27 AS-06, S27 AS-07] [code: packages/backend/libs/domains/content/domain/blocks.ts#sanitizeRichText]
- **S27.R-05** A draft locale can be deleted with its revision except the default locale (`409 default_locale_required`); the list is keyset paged newest first with an opaque cursor. [proof: S27 AS-11, S27 AS-12] [code: packages/backend/libs/domains/content/infra/story.repository.ts#SequelizeStoryRepository]
- **S27.R-06** Publish freezes every locale draft into one immutable version row set under a gapless version number, records the publisher, a history row and `story.published`, in one transaction; it needs `expectedVersion` and an `Idempotency-Key`. [proof: S27 AS-20, S27 AS-21, S27 AS-23, S27 AS-24] [code: packages/backend/libs/domains/content/application/publish.service.ts#PublishService]
- **S27.R-07** A publish is refused with nothing written when there are no drafts, the default locale draft is missing, nothing changed since the live version, or a `product` block names a product that is not in the same shop (one batch check through S05 before the transaction; S05 failing answers `503 dependency_unavailable`). [proof: S27 AS-22] [code: packages/backend/libs/domains/content/application/publish.service.ts#PublishService]
- **S27.R-08** A schedule is an attribute (`scheduledAt`), never a status: it must be in the future and at most 365 days ahead, it never changes the status, and a scheduled republish never takes the live version offline. [proof: S27 AS-40, S27 AS-43, S27 AS-45] [code: packages/backend/libs/domains/content/domain/schedule-rules.ts#checkSchedule]
- **S27.R-09** One delayed job per schedule publishes only when the story's `scheduledAt` still equals the job's and is due, from the drafts as they are at that moment; a stale, early or duplicated job does nothing, and a sweep every minute publishes any due schedule whose job was lost. [proof: S27 AS-41, S27 AS-42, S27 AS-44, S27 AS-46] [code: packages/backend/libs/domains/content/infra/stories.jobs.ts#StoriesJobs]
- **S27.R-10** A permanent failure at fire time clears the schedule, records `scheduleFailure {at, code}` and `story.schedule_failed`; a transient failure is retried and becomes `publish_failed` once retries are exhausted. [proof: S27 AS-47] [code: packages/backend/libs/domains/content/application/schedule.service.ts#ScheduleService]
- **S27.R-11** The public story is served at `/stories/<shopSlug>/<slug>/<locale>` with `Cache-Control: public, s-maxage=300, stale-while-revalidate=86400`, `Cache-Tag: story:<id>,shop:<shopId>`, a strong `ETag` `"<id>-v<version>-<locale>"`, `Content-Language`, no `Vary`; a matching `If-None-Match` (list, weak, `*`) answers `304` keeping the validators. [proof: S27 AS-25, S27 AS-26] [code: packages/backend/libs/domains/content/application/public-read.service.ts#PublicReadService]
- **S27.R-12** The locale resolves by exact (case-insensitive), then language, then the story default, never from `Accept-Language`; `canonical` names the served locale's URL and `alternates` list every locale plus `x-default`. [proof: S27 AS-27, S27 AS-28, S27 AS-31] [code: packages/backend/libs/domains/content/domain/locale-chain.ts#localeChain]
- **S27.R-13** A draft, archived, unknown, scheduled-not-due or suspended-shop story answers an identical `404 story_not_found` with `s-maxage=10` and no tag. [proof: S27 AS-29] [code: packages/backend/libs/domains/content/application/public-read.service.ts#PublicReadService]
- **S27.R-14** The origin read model holds every locale of the published version for at most 60 seconds, is filled from the durable store with one concurrent fill per story, and an empty or unreachable cache never fails a read. [proof: S27 AS-30] [code: packages/backend/libs/domains/content/infra/story-read-model.ts#CachedStoryReadModel]
- **S27.R-15** Publish, archive and a failed scheduled publish record their event in the same transaction as the change; a rollback leaves no event and a bus outage does not fail the request. [proof: S27 AS-50] [code: packages/backend/libs/domains/content/application/events/story-events.ts#StoryPublished]
- **S27.R-16** The invalidation consumer, per event and idempotent per `eventId`, clears the origin entry, purges the CDN by `story:<id>` and `shop:<shopId>` (at most 30 tags per call, batched and de-duplicated), calls the front end's revalidation endpoint with a body `{tags, eventId}` signed as `HMAC-SHA256("<timestamp>.<raw body>")`, and clears the origin entry once more before the purge. [proof: S27 AS-51, S27 AS-52, S27 AS-53, S27 AS-57] [code: packages/backend/libs/domains/content/infra/invalidation.consumer.ts#StoryInvalidationConsumer]
- **S27.R-17** CDN failures are retried at most 3 times inside the call with full jitter, a CDN `4xx` other than `429` is permanent, an invalid payload or the 8th failed delivery is dead-lettered, and a failure in one target never prevents the other. [proof: S27 AS-54, S27 AS-55, S27 AS-56] [code: packages/backend/libs/domains/content/infra/cdn-purger.ts#HttpCdnPurger]
- **S27.R-18** Outside production a missing CDN or revalidation credential selects logging adapters; production refuses to start naming the missing key. [proof: S27 AS-59] [code: packages/backend/libs/common/config/stories-config.ts#storiesProductionRule]
- **S27.R-19** A shop status change reaches the public story through the shop copy: a suspended shop's stories answer `404` and its cache entries and tag are purged. [proof: S27 AS-58, S27 AS-97] [code: packages/backend/libs/domains/content/infra/shop-copy.consumer.ts#StoryShopCopyConsumer]
- **S27.R-20** A preview token is minted by `products.write`, bound to story, shop and locale, audience `story-preview`, signed HS256 with a dedicated key, valid 30 minutes, read only from the `X-Preview-Token` header; the response is the draft in the public shape with `preview: true`, `private, no-store`, `noindex`, `no-referrer`; every invalid token answers the same uncacheable `404`. [proof: S27 AS-60, S27 AS-61, S27 AS-62] [code: packages/backend/libs/domains/content/infra/preview-signer.ts#HmacPreviewSigner]
- **S27.R-21** The sitemap index lists one child per 2,500-story page; a story's page comes from a position allocated once at its first publish and never changed or reused; a child lists one `<url>` per story and locale with `lastmod` and `hreflang` alternates (escaped), is read in keyset batches of at most 1,000 rows with backpressure, and ends abnormally (never cleanly) when the store fails mid-stream. [proof: S27 AS-70, S27 AS-71, S27 AS-72, S27 AS-73, S27 AS-74, S27 AS-75] [code: packages/backend/libs/domains/content/application/sitemap.service.ts#SitemapService]
- **S27.R-22** Archive (`PUBLISHED` only) takes a story down, clears its schedule and records `story.archived`; illegal moves answer `409 invalid_transition` or `not_scheduled`; publish and archive serialise per story. [proof: S27 AS-80, S27 AS-81, S27 AS-82, S27 AS-83] [code: packages/backend/libs/domains/content/domain/story-status.ts#nextStatus]
- **S27.R-23** Versions are listed newest first and read immutably; restoring a version replaces the drafts with its locales and advances revisions without changing the live version. [proof: S27 AS-84, S27 AS-85] [code: packages/backend/libs/domains/content/application/lifecycle.service.ts#LifecycleService]
- **S27.R-24** Every staff route needs a session and the shop guard; a viewer, a non-member, another shop's ids, a suspended or offboarding shop and the 121st write per minute per shop are refused with problem+json and change nothing. [proof: S27 AS-90, S27 AS-91, S27 AS-92, S27 AS-93, S27 AS-94] [code: packages/backend/libs/domains/content/api/stories.controller.ts#StoriesController]
- **S27.R-25** A store failure during publish answers a generic 5xx problem and leaves no version, pointer, history or event; logs and metrics carry outcomes and never draft content or secrets. [proof: S27 AS-95, S27 AS-96] [code: packages/backend/libs/domains/content/application/story-metrics.ts#storyMetrics]
- **S27.R-26** The shop copy (slug, status, `shopVersion`) is fed by version-guarded, validated, idempotent consumers; `shop_deleted` purges the shop's stories, drafts, versions, history and cache in bounded batches; `content` holds no foreign key to and no read of another owner's tables. [proof: S27 AS-97, S27 AS-98, S27 AS-99] [code: packages/backend/libs/domains/content/application/shop-copy.service.ts#ShopCopyService]

## Behaviors
- **S27.B-01** Given a story with `en` and `uk` drafts, when staff publish with `expectedVersion: 0`, then version 1 exists for both locales, the story is `PUBLISHED`, `story.published` is recorded and the public story answers `200`. [proof: S27 AS-20]
- **S27.B-02** Given version 1 is live, when staff edit a draft, then the public body and ETag stay the same until the next publish creates version 2. [proof: S27 AS-21]
- **S27.B-03** Given a schedule for time T and the clock at T, when the job runs, then version 1 is published once from the drafts as they are then. [proof: S27 AS-41]
- **S27.B-04** Given a lost job, when the sweep runs two minutes after T, then the story is published once even if two sweeps run together. [proof: S27 AS-46]
- **S27.B-05** Given `story.published` is delivered twice, when the consumer handles both, then the CDN and the front end are called once. [proof: S27 AS-53]
- **S27.B-06** Given a suspended shop, when its published story is read, then the answer is the same `404` as for an unknown story. [proof: S27 AS-58]
- **S27.B-07** Given a forged, expired or mis-addressed preview token, when the preview is read, then the answer is a `404` with `no-store`. [proof: S27 AS-62]
- **S27.B-08** Given stories at positions 1 to 5 and page capacity 2, when story 1 is archived and a sixth is published, then the other stories stay on their pages. [proof: S27 AS-72]
- **S27.B-09** Given an archived story, when staff publish it again, then it is live again under the next version with its old sitemap position. [proof: S27 AS-81]
- **S27.B-10** Given version 3 is live, when staff restore version 1 and publish, then version 4 has version 1's content and versions 1 to 3 are unchanged. [proof: S27 AS-85]

## Owns
- Tables: `Story`, `StoryDraft`, `StoryVersion`, `StoryTransition`, `StoryShop`. [code: packages/backend/db/ownership.ts#OWNERSHIP]
- Topic `stories.events`; jobs `stories.publish`, `stories.publish-due-sweep`; rate-limit policy `content.write.shop`.
- Configuration: `STORY_PREVIEW_SECRET`, `REVALIDATE_SECRET`, `REVALIDATE_URL`, `CDN_ZONE`, `CDN_TOKEN`, `FRONT_HOST`, `BACKEND_HOST`, and the limits of stories per shop, locales, blocks, draft bytes, schedule horizon, sitemap page capacity and preview lifetime.

## Decisions
- A schedule is an attribute, so scheduling a republish of a live story never hides it.
- The shop's slug and status live in a copy owned here (`StoryShop`) and fed by events, so public reads never touch tenancy tables.
- Cache content is built from the durable store, never from event payloads; the origin entry is cleared before and after the CDN purge.
- The sitemap position is allocated once from a sequence, so pages stay stable and no query uses an offset or a full count.
- Publish checks product references before opening the transaction, so no network call happens inside it.

## Known gaps
- The pages that render a story, the front end's revalidation route and the staff editor are owned by no web capability yet; this page covers the backend half.
- Origin throughput (2,000 requests per second, p99 below 50 ms) and the CDN hit ratio are not measured by automated tests; they are listed in `specs/UNVERIFIED.md`.
