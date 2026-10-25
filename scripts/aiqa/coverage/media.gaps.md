# media (product photos page): gaps between spec and code

Mapped from code and spec only. The live page was NOT opened in a browser (no sign-in or screenshots at 390 px were done); testers must confirm every line on the real page.

## (a) In the code, not in the spec
- Drag and drop upload, paste, per-photo cover button: none of these exist in code (see media.upload.drag-drop, media.order.drag-drop, media.cover.no-button). They are listed because the task asked; the spec does not promise them either.
- Silent drop of files that exceed free room: `packages/web/components/seller/media/gallery-view.tsx#onFiles` slices the file list with no message.
- "Discard changes" button, "Load latest" button, "Dismiss" on failed upload rows: not named in `specs/web/W04-seller-dashboard/spec.md` (only the F6-1..F6-11 tests in `test-plan.md` / `gallery-view.test.tsx`).
- Poll wording "Waiting to process" / "Processing" and the 1.5 s poll: only in code and tests.
- No wait limit for a stuck upload row (never times out) and no warning when leaving with unsaved changes or running uploads.
- Removing a photo on the page only detaches it from the draft/gallery; it never calls DELETE /api/media/:id, so detached photos stay READY and orphaned (`media.remove.orphans`).
- Media tab links (`media-tabs.tsx`) and the inventory menu entry 'Photos and video' (`inventory-view.tsx:132`) are in code, not as rules in the spec.

## (b) In the spec, not found in code (likely bugs)
- `docs/spec/capabilities/S29-photos.md` Known gaps says the seller screen "does not exist yet", but it exists (stale spec text, not a code bug).
- `specs/web/W04-seller-dashboard/spec.md` line 36 and `questions.md` line 38 say the photo gallery screen is NOT built in this release; `tasks.md` T085/T086 say it is built. Spec text disagrees with itself.
- S29.R-27 DELETE for the uploader or members: no control for it on the page (API only).
- S29.R-18 `failures` list per photo: the page shows one general sentence only (W04 `gaps.md` already admits this).
- S29.R-05 / W04.FR-046 rate-limit countdown for upload rows: the row shows `sellerProblemCopy(...).message` text only, no countdown (check by test: media.upload.limit.rate).
- W07 CSP: `W04 gaps.md` says `connect-src` must allow the storage origin for the photo POST; check `packages/web/lib/security/csp.ts` really does in the stack and in production (media.upload.storage-cors).
- S29.R-17 "gallery holds at most 20 READY photos": client counts draft items, not READY ones; mixed cases (20 saved + 1 new) rely on chooser lock only.

## (c) Spec and code disagree
- W04 spec: "photos ... not built" (spec.md:36) vs code: page exists at `packages/web/app/dashboard/seller/[shopId]/products/[productId]/media/page.tsx`.
- Page text: "Each photo can be up to 15 MB." (`media-copy.ts#photoRefusal`) vs server word for size_invalid: "That file is empty or over 15 MB." (`REJECT.size_invalid`): two different sentences for the same limit.
- Conflict sentence: `problem-copy.ts:74` `version_conflict` = "This product changed since you opened it." but the conflict here is the photo list (S29.R-17 `version_conflict`).
- Page access: `page.tsx` uses page 'inventory' (products.read) for the view; spec S29.R-21 member read = products.read: agrees. The menu entry is hidden for non-writers, but a reader can open by URL (read-only view) - W04 text not explicit.
- Public gallery cache: contract/spec W02 "short window"; code `public, s-maxage=5` (gallery.controller.ts) vs media GET `public, max-age=15` (R-23): intended difference, verify.
- Some spec ids in the .tsv are approximate where the spec has no numbered rule (marked W04.F6, W04.NFR-*, or with a "?"): a tester should replace with `none` if no rule is found.

## Not mapped
- The video page and S30 (out of scope). Infra Terraform (`infra/modules/s3_cloudfront/main.tf`) only listed, not read. Lambda handler `packages/backend/apps/lambdas/src/handlers/media-processing.ts` and duplicate-detection details were not traced line by line.
