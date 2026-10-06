# SD-05 — Brand Stories CMS & Edge-Cached Content (Jamstack/ISR backend half)

Status: ☑ done (backend half; typechecked; spec written, not run) · Phase 5 · Depends on: SD-02, SD-29, edge-be

## Marketplace adaptation
Brands publish **launch pages and editorial stories** ("Inside the iPhone 18 design") in multiple locales, scheduled to go live at reveal time. Pages must be served from the edge at millions of views; edits go live within a minute.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Content model: `Story` with versions (draft/published), blocks JSONB (validated), locales, scheduled publish (SD-29) | 10/04 #5 |
| **Tag-based cache invalidation**: publish → signed revalidation webhook to Next.js (`revalidateTag`, FE phase 2) **and** Cloudflare purge by cache-tag | 10/04 #5 |
| `Cache-Control: s-maxage=300, stale-while-revalidate=86400`, `Cache-Tag: story:123, shop:9` headers | 03/04, 10/04 #5 |
| Preview mode: signed preview tokens bypass caches | 10/04 #5 |
| i18n: locale in path, fallback chain, `hreflang` data in API | 10/04 #5 |
| Sitemap index generation streamed for millions of URLs | 02/02 |
| HTML sanitisation of rich text blocks; strict CSP guidance for rendered pages | 05/01 §1–2 |

## Steps
- [x] `Story`, `StoryVersion` models; CRUD for shop staff; scheduled publish job.
- [x] Public read API with cache headers + ETag.
- [x] Revalidation publisher (outbox event → worker → Next webhook + Cloudflare purge API adapter).
- [x] Sitemap stream endpoint.
- [x] e2e: scheduled publish at T → after job run, public endpoint serves new version; purge adapter called with tags.

## Scale
- Target: 200k RPS story views → ~99% CDN hit; origin ≤ 2k RPS served from Redis read model.
- Proof: k6 origin-miss scenario p99 < 50 ms.

## Implementation notes (2026-10-01)
- **Schema:** migration `20261001350000-stories` adds `Story` (status, published version pointer, schedule), `StoryDraft` per locale, and `StoryVersion` (immutable snapshot of all locales per publish).
- **`blocks.ts`:** zod discriminated union (heading, richText, image, product, quote, video with a host allowlist), https-only URLs, and rich text sanitized with `sanitize-html` at write time. `localeChain` falls back exact → language → story default.
- **`StoriesService`:**
  - Drafts are validated and sanitized.
  - Publish: now, or scheduled via an SD-29 job; a reschedule makes the stale job a no-op by comparing `scheduledAt`.
  - `publishNow` freezes drafts into version N, flips the pointer, records `story.published` (outbox) and drops the Redis read model.
  - The public read model is a Redis hash per story with all locales of the published version (DB only on a miss).
  - Preview: a signed 30-minute JWT, served `private, no-store`.
- **Public endpoint** `GET /api/stories/:shopSlug/:slug?locale=`: `s-maxage=300, stale-while-revalidate=86400`, `Cache-Tag: story:<id>,shop:<id>`, ETag (id-version-locale) → 304, `Content-Language`, hreflang `alternates`.
- **`StoryCacheInvalidator`** (projector): on publish it purges by tag (`CdnPurger` port: Cloudflare purge_cache API, ≤ 30 tags per call, logging fake without credentials) and calls the Next.js `/api/revalidate` webhook with an HMAC signature (`revalidateTag`, FE phase 2).
- **Sitemaps:** `GET /api/sitemaps/stories.xml` (index, 50k URLs per child) and `stories-<n>.xml`, streamed in keyset batches of 1,000 with `res.write` backpressure and hreflang alternates.
- **Spec** `stories/stories.e2e-spec.ts` covers: sanitization + invisible drafts + ETag/tags, locale fallback, scheduling with a stale-job no-op, republish + purge tags, preview + sitemap.
