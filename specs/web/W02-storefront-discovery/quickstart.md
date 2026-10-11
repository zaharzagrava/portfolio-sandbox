# W02 — Quickstart (validation guide)

## Prerequisites

Dev stack running (API `http://localhost:8000`; after backend edits wait for `GET /health/ready` = 200). `pnpm install` in the repo root. Web env: `MEDIA_HOST` (the local MinIO host in dev), `VIDEO_HOST` and `MAP_TILE_HOST` (optional; see `packages/web/.env.example`), `SITE_URL` (equals S37's storefront origin), `NEXT_PUBLIC_MAP_TILE_URL` (optional; without it only the list view exists), `STOREFRONT_ADS_ENABLED` (optional, leave unset). Journey seeds (B-6): a pickup point with stock near the fake location, a recommendation list, a trending dataset, a processed public knowledge document with the scripted model provider; `globalSetup` names any that is missing. Playwright starts the web dev server.

## Scenarios

| Goal | Command | Expected |
|---|---|---|
| Backend: public gallery | `scripts/sdd/test-spec.sh media-gallery-public` | green |
| Backend: BFF gallery section | `scripts/sdd/test-spec.sh bff` | green, `gallery` present and degrades to `null` |
| Backend: delete post, replies | `scripts/sdd/test-spec.sh "discussions-delete-post\|discussions-replies"` | green |
| Contracts | `cd packages/contracts && pnpm test` | each new schema parses a real response |
| Web units and components | `cd packages/web && pnpm exec vitest run <file>` per phase; `pnpm test` at the end | all W02 `U-*` files green |
| Architecture rules | `pnpm exec vitest run lib/storefront/architecture.test.ts` | green |
| Static gates | `pnpm exec tsc --noEmit && pnpm lint && pnpm build` | no errors; 0 `no-restricted-globals` warnings in W02 files; no runtime-data-outside-Suspense error |
| Catalogue & search journey | `pnpm exec playwright test tests/search.spec.ts` | green (home, suggest, filters, paging, product) |
| Storefront discovery (near me, pickup, map, rails) | `pnpm exec playwright test tests/storefront-discovery.spec.ts` | green |
| Product page / rails / trending | `pnpm exec playwright test tests/product-page.spec.ts tests/product-recommendations.spec.ts tests/home-trending.spec.ts` | green |
| Community and ask | `pnpm exec playwright test tests/product-community.spec.ts` | green |
| Share and referral | `pnpm exec playwright test tests/share-link.spec.ts` | green (`__Host-ref` set after landing) |
| Visitor events | `pnpm exec playwright test tests/visitor-events.spec.ts` | green |
| Video, sponsored | `tests/product-video.spec.ts`, `tests/sponsored-listing.spec.ts` | `fixme` until S30 seed / S36 controller exist |
| Layout and a11y | `pnpm exec playwright test tests/visual` | baselines match, axe 0 serious/critical at 390 and 1280 px |
| Final | whole web suite once, then the capability's backend specs once | green |

## Ops artifacts

Criteria no automated test proves (also rows in `specs/UNVERIFIED.md`; never describe them as verified):

- **SC-001** (home to a product page in ≤ 3 interactions and 15 s, no instruction): hand-run with five first-time users or a stopwatch on a clean profile, by search, category shortcut and trending card; record times.
- **SC-002** (suggestions visible within 400 ms of a pause for 95 % of pauses): record a Performance trace of 100 keystroke pauses on broadband against the dev/prod build; compute the 95th percentile of pause-to-visible. The unit test proves only the 150 ms debounce and abort rules.
- **SC-003** (LCP ≤ 2.5 s for 75 %, INP ≤ 200 ms, CLS ≤ 0.1 on a mid-range phone): Lighthouse/field run on Home and a product page with mobile throttling; record the p75 values. The visual tests prove only that image boxes reserve space.
- **SC-004** (new results within 1 s for 95 % of filter/sort/page changes, scroll kept): script 100 changes with the browser Performance panel and record the 95th percentile; keeping the previous results and the scroll position is covered by U-results.
- **SC-008 (keyboard part)** (every journey completable by keyboard alone): walk each journey of `test-plan.md` with the keyboard only and tick it off; the axe scans and per-component key tests cover the rest.
- **SC-009** (post, vote or comment visible within 1 s; first answer words as soon as sent): measure with the browser Performance panel against the dev stack; the optimistic update and token-by-token rendering are covered by U-vote, U-comp, U-ask.
