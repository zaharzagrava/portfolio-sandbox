# Bug register: seller dashboard QA (every finding, with its status)

Counts are in `docs/work/qa-bug-scoreboard.md`. This file lists each finding. Statuses: **candidate** (not confirmed), **confirmed** (reproduced), **fixed** (with the commit and the test), **false alarm** (why), **known** (already known before the agents), **wontfix/decision** (needs the owner).
Source: A = AI agent charter, M = monkey tester, F = API fuzzer, T = a test found it (flaky or failing test), O = owner by hand.

| ID | Date | Source | Area | What | Status | Fix / note |
|---|---|---|---|---|---|---|
| B-001 | 2026-10-20 | O | photos | Seller photo upload: the photo vanishes after reload, "Save photos" seems to do nothing | known, cause found by A (B-002) | |
| B-002 | 2026-10-25 | A (seller-photos) | photos / media | READY photo URLs point at `http://localhost:9000/marketplace-media/...` (9000 is ClickHouse), `MEDIA_CDN_URL` in `packages/backend/env/showcase.env.example` line 7; the web page allows images only from `http://localhost:9100` (`lib/config-parse.ts` LOCAL_MINIO_HOST), and the bucket answers 403 on 9100 (not public-read). The picture is blank; the data is saved. The public gallery `GET /api/products/{id}/gallery` returns the same wrong host. | confirmed (explains B-001) | to fix (first fix-agent task) |
| B-003 | 2026-10-25 | A (seller-photos) | web / CSP | About 100 "Applying inline style violates style-src" console errors per page load | candidate (likely dev-server noise) | recheck on a production build |
| B-004 | 2026-10-25 | A (seller-photos) | public product page | `/products/{id}` showed no `img` elements after a photo was saved | candidate (maybe B-002) | recheck after B-002 is fixed |
| B-005 | 2026-10-24 | M | seller pages | Hydration mismatch console errors on about 13 seller pages (the Next error overlay on 11: imports, team, payouts, statements, integrations, inventory) | candidate | recheck on a production build, find the cause |
| B-006 | 2026-10-24 | M | developers/logs | A `<ul>` that holds something other than `<li>` (axe) | candidate (likely real, small) | |
| B-007 | 2026-10-24 | F | API | `launch-events/:eventId/bookings` and `/close` answer 404 problem+json without a `code` field | candidate | |
| B-008 | 2026-10-24 | F | API | `/api/batch/media`, `/api/batch/shops` answer 400 instead of 401 without a login | candidate | |
| B-009 | 2026-10-24 | F | API | `/api/probe/shop/:shopId`, `/api/media/:id`, `/api/shops/by-slug/:slug/sso` answer 404 instead of 401 without a login (may be deliberate) | candidate | |
| B-010 | 2026-10-24 | F | API | `PATCH /api/shops/:shopId/products/search` answers 400 where 404/405 is expected | candidate | |
| B-011 | 2026-10-25 | T | seller overview | The "Last 60 seconds" panel grows by 44 px when its first live update arrives (a visible jump) | confirmed, not fixed | needs a fixed-height placeholder; changes the saved pictures |
| B-012 | 2026-10-25 | T | admin flags | A menu opened right at page start can be rebuilt under the mouse (hydration + list reload) | candidate (guarded in the test) | |
| B-013 | 2026-10-25 | T | chat | "Seen" receipt lost when the buyer leaves within the 500 ms wait | fixed | `lib/chat/read-position.ts`, unit tests |
| B-014 | 2026-10-25 | T | assistant | Reply shown twice after a reload (turnId vs id) | fixed | `use-assistant-chat.ts`, `drive-reply.ts`, 2 unit tests |
| B-015 | 2026-10-25 | T | orders | "Order cancelled" toast lost when the dialog closes first | fixed | `cancel-order-dialog.tsx` |
| B-016 | 2026-10-25 | T | dev seed | The demo seed broke on the free plan's 10-product limit | fixed | `dev-seed.ts` gives the demo shop Pro |
| B-017 | 2026-10-24 | T | migrations | PostgreSQL 18: a migration dropped `Product.shopId NOT NULL` | fixed | new migration, old one corrected |
| B-018 | 2026-10-24 | T | backend | Job worker, job maintenance and the launch-events admitter loops kept running after the app closed | fixed | close hooks |
| B-019 | 2026-10-24 | T | notifications | A stale recipient view could be kept for 5 minutes after quick preference changes | fixed | `recipient-view.service.ts` |
| B-020 | 2026-10-24 | T | trending | The trending consumer's pause-switch read had no time limit | fixed | `trending.consumer.ts` |
| B-021 | 2026-10-25 | T | media | A storage error with a `code` was returned as 500 instead of 503 | fixed | `video-finalize.service.ts` |
| B-022 | 2026-10-25 | T | orders | `voucher.service.ts` imported from `infra/` (architecture rule) | fixed | injects the connection |
