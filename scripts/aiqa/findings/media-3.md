# media, pass 3 (tester ai-tester, 2026-10-25)

Method: executable specs per group in `packages/web/tests/aiqa/`: `media-roles`, `media-leave`, `media-public`, `media-backend-3`, `media-ui-closure`, plus two long specs that wait for the hourly jobs (`media-purge`, `media-cleanup`). Run: `cd packages/web && npx playwright test tests/aiqa/media-roles.spec.ts tests/aiqa/media-leave.spec.ts tests/aiqa/media-public.spec.ts tests/aiqa/media-backend-3.spec.ts tests/aiqa/media-ui-closure.spec.ts --project=desktop --project=mobile --output=/tmp/<own folder>`. Failing tests below are left failing on purpose. Roles were made through the real invitation flow (ADMIN, STAFF, VIEWER).

P3F1 [CONFIRMED] medium A SUSPENDED or DELETING shop shows no photos at all
Steps: owner with a product that has 2 saved photos; platform suspends the shop (or the owner starts offboarding); open the photos page.
Expected (W04 FR-012 "view data but not make changes"; map media.shop.suspended / media.shop.deleting "photos visible, controls disabled"): the 2 photos and "2 of 20 photos" are shown, write controls off.
Actual: the page shows only the shop-closed sentence; no gallery read is sent (0 GETs), no photos, no counter. Write controls are absent and the API refuses writes correctly (PUT 403 shop_suspended / 409 shop_offboarding, database unchanged). Same on desktop and mobile, 3 runs.
Evidence: spec `media-roles.spec.ts` "media.shop.suspended, media.shop.deleting" (soft checks fail: gallery read [] instead of [200]; counter not visible). Earlier notes said the API answers 403 on the read of a suspended shop; here no read is made at all.

P3F2 [SUSPICIOUS] info Map is wrong about the unsaved draft: it is KEPT when the person leaves and comes back inside the app
Steps: move a photo (draft), click "Back to inventory", press browser Back; or click the Video tab and then Photos.
Expected (map media.leave.unsaved-link / tab-video / browser-back): draft lost silently.
Actual: the draft is still there (order changed, Save enabled, Discard available), nothing was written. It is lost only on reload or when the tab closes. Via the sidebar (Orders) and Back the draft was gone. No warning in any case, no beforeunload prompt (a tab close with a draft closes without asking). Not harmful; the map text should be corrected. Evidence: `media-leave.spec.ts`.

P3F3 [CONFIRMED] medium A background re-read keeps the draft on screen but Save then overwrites another editor's change (no 409)
Steps: open photos page (version 1), move a photo (draft); another editor saves a different order (version 2); the page re-reads in the background (browser comes back online after the read went stale); press Save photos.
Expected (map media.leave.draft-survives-refetch "draft wins until Save -> 409"; S29.R-17 optimistic version): PUT with the version the draft was made on answers 409 version_conflict and "Load latest" is offered.
Actual: the page takes the new version number from the re-read and sends the draft with it: PUT 200, the other editor's order is silently replaced (db order = the draft). Desktop and mobile, 3 runs.
Evidence: `media-leave.spec.ts` "media.leave.draft-survives-refetch" (fails at PUT status 409 vs 200). The 409 path itself works when the page did not re-read (media.save.conflict).

P3F4 [CONFIRMED] high (= P1F4 / B-002) Derived picture files answer 403 for anyone without keys, and the API's picture addresses do not load
Steps: upload a photo; GET http://localhost:9100/marketplace-media/<derived key>, and GET urls.thumb from the API.
Expected (S29.R-38): derived files readable through the media address.
Actual: 403 from the storage on 9100; the API address is on port 9000 and answers 400. Evidence: `media-backend-3.spec.ts` "media.be.minio-bucket" (fails desktop and mobile). Public-page lines that need a picture on screen stay blocked.

Notes (not bugs)
- Public gallery on screen (media.public.main-image, thumbs, lightbox, image-error, mobile, order-after-save, card-image): blocked. Product page output is rendered by the server and only accepts https addresses; the dev stack serves http (B-002). The no-photo block, the http-refused block, the not-found page of a hidden product, and the whole public API are tested and pass.
- Every built-in role holds products.read, so "member without products.read" (media.role.no-products-read) cannot exist: n/a.
- The old fixme test "media.upload.limit.malware" in media-backend.spec.ts reads `payload.rejectCode` of the media.rejected event; the real key is `payload.code` (seen in the outbox for processing_failed). Fix it when that test is unblocked.
- No `media_*` metric is exposed on any listening port of the dev stack (probed all ports for /metrics; only HTTP metrics at 9464): media.be.metrics blocked.
- Blocked by the stack, same as before: scanner (disabled), real rate limits (127.0.0.1 allowed), worker time limits and partial storage failure (no fault hook), Terraform lifecycle rules (no cloud).
- INCIDENT (mine): to try the product page with https picture addresses I started a second `next dev -p 3300` inside packages/web with its own dist folder. Tailwind on the main server (3000) then scanned that folder and produced broken CSS, so the main dev server answered 500 for about 5 minutes (about 09:50 to 09:57). Recovered by stopping my server, deleting `packages/web/.next-aiqa3`, removing the two lines the second server added to `packages/web/tsconfig.json` (file is back as before) and touching `app/globals.css`. Nothing else changed. Do not run a second dev server inside the package folder.
- The purge job (media.be.job.purge) and shop deletion cleanup (media.shop.deleted-cleanup, media.product.deleted-cleanup) wait for the hourly jobs (:00 and :05); see the end of this file for their results.
