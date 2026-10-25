# media, pass 1 (tester ai-tester, 2026-10-25)

Method: exploration by hand, then the permanent specs `packages/web/tests/seller/media/page.spec.ts` and `packages/web/tests/seller/media/upload.spec.ts` (+ `media-support.ts`). The failing tests below are left failing on purpose. Run: `cd packages/web && npx playwright test tests/seller/media/page.spec.ts tests/seller/media/upload.spec.ts --project=desktop`.

P1F1 [CONFIRMED] medium Sign-in redirect forgets the page: returnTo is the shop home, not the photos page
Steps: signed out, open /dashboard/seller/{shop}/products/{product}/media (same for /inventory and /orders?x=1).
Expected (W04 AS-84, media.page.not-signed-in): redirect to /login?returnTo=<that path and query>, and after sign-in the person lands on it.
Actual: /login?returnTo=%2Fdashboard%2Fseller%2F{shopId}; after sign-in the person lands on the shop home.
Evidence: spec test "media.page.not-signed-in" (fails); hand script run on 3 URLs; the layout (ShopFrame) redirects before the page's own requireSellerSession.

P1F2 [CONFIRMED] low Not-found pages of the seller area answer HTTP 200
Steps: signed in, open the photos page of an unknown shop id / another seller's shop / a non-uuid product id.
Expected (W04 FR-001): "a non-member gets a real not-found response".
Actual: the page text is "We couldn't find that shop." but the HTTP status is 200 (streamed under Suspense).
Evidence: spec test "media.page.unknown-shop" (fails, status 200 vs 404); hand run for 3 ids.

P1F3 [CONFIRMED] medium Photos of an ARCHIVED product: page invites edits, then the refusal sentence is wrong and nothing is refreshed
Steps: archive a product that has 2 photos, open its photos page by address, remove photo 2, press Save photos.
Expected (S29.R-19, 409 product_archived): a clear sentence (the API detail says "An archived product cannot be edited; restore it first."), no stale draft.
Actual: chooser and Remove stay enabled; PUT answers 409; the page shows "This product was archived or restored elsewhere. The list has been refreshed." but no second gallery GET is made and the draft (1 of 20) stays with Save/Discard. Database unchanged (2 ProductMedia rows) so the data is safe.
Evidence: spec test "media.page.entry.archived-product" (fails at the promised refresh); PUT 409 in the network log.

P1F4 [CONFIRMED] high (= register B-002) Photo addresses point at port 9000 (ClickHouse) instead of the storage on 9100
Steps: upload any photo, look at the img src.
Expected: the picture address is on the storage origin that took the upload (http://localhost:9100) and loads.
Actual: src is http://localhost:9000/marketplace-media/media/derived/<hash>.webp (curl: 400 from ClickHouse); the browser blocks it by the page's img-src (console: "Loading the image ... violates ... img-src"); even on 9100 the bucket answers 403 (curl). The picture box stays empty. MEDIA_CDN_URL in packages/backend/env/showcase.env.example line 7.
Evidence: spec test "media.upload.single-happy: the picture of a READY photo is served from the storage" (fails: origin 9000 vs 9100); GET /api/media/:id urls.*.

P1F5 [CONFIRMED] medium An animated PNG is accepted as a photo
Steps: upload a 4-frame PNG (acTL/fdAT chunks, 50x50) as image/png.
Expected (S29.R-09 "one frame"): REJECTED multi_frame, as the animated WebP is.
Actual: Media READY (first frame used). Reproduced 3 times (hand UI, hand API, spec). Cause: image-pipeline.ts only checks `meta.pages > 1`, which the PNG loader does not report for APNG.
Evidence: spec test "media.upload.limit.type-svg-gif" (animated WebP part passes, PNG part fails).

P1F6 [CONFIRMED] low Files that do not fit are dropped without a word
Steps: product with 18 photos, choose 5 files.
Expected (S29.R-17 intent / good UX): the person learns that 3 files were not added.
Actual: 2 uploads are sent, 3 files vanish, no message (GalleryView#onFiles slice). Gap (a) of media.gaps.md confirmed in the browser.
Evidence: spec test "media.upload.many-files.over-room" (fails at the message).

P1F7 [SUSPICIOUS] low Wording: a bad product id says "We couldn't find that shop."; an unknown or foreign product shows "This product no longer exists." with a "Try again" button (a 404 cannot succeed on retry). Seen in the hand run and in spec tests "media.page.bad-product-id", "media.page.unknown-product".

P1F8 [SUSPICIOUS] info Chrome logs the browser's POST to the storage as net::ERR_ABORTED although the storage answered 204 and the upload works (every upload). Probably the empty 204 body with credentials omitted; no user impact seen.

Notes (not bugs): step 1 answers 201 (map said 200); the signed form fields contain the storage key (needed by S3 POST), the response has no top-level key property. A suspended shop answers 403 shop_suspended to the gallery read, so the page is the suspended error panel (no chooser at all), not "chooser disabled" as the map said. A VIEWER sees "The gallery holds up to 20 photos." when the gallery is full although it cannot add. Two photos of identical content share one derived file (content hash), duplicate detection never blocked. The invitation mail goes to the dev mailbox (GET /api/dev/mailbox), not Mailpit.
