# media, pass 2 (tester ai-tester, 2026-10-25)

Method: executable specs per group in `packages/web/tests/aiqa/` (`media-gallery-edit`, `media-gallery-save`, `media-upload-states`, `media-backend`, helpers in `media-edit-support.ts`). Run: `cd packages/web && npx playwright test tests/aiqa/media-gallery-edit.spec.ts tests/aiqa/media-gallery-save.spec.ts tests/aiqa/media-upload-states.spec.ts tests/aiqa/media-backend.spec.ts --project=desktop --project=mobile --output=/tmp/<own folder>`. Failing tests below are left failing on purpose.

Predecessor check: `media-page.spec.ts` + `media-upload.spec.ts` re-run on desktop AND mobile: 42 passed, 12 failed; the 12 are exactly the 6 known findings P1F1 (not-signed-in), P1F2 (unknown-shop 200), P1F3 (archived-product), P1F4 (storage address on port 9000), P1F5 (animated PNG), P1F6 (files dropped silently), each on both projects. No new failure, nothing flaky.

P2F1 [CONFIRMED] medium Keyboard: after a photo is moved to the top (or bottom) the focus is thrown to the page
Steps: Tab to "Move photo 3 up", Enter, then Space on the same (now "Move photo 2 up") button so the photo reaches place 1.
Expected (W04.NFR-a11y): the focus stays on a control of that card; a keyboard user does not have to Tab from the top again.
Actual: the pressed button becomes disabled (photo is first) and `document.activeElement` is BODY. Same when the last photo is moved down.
Evidence: spec `media-gallery-edit.spec.ts` "media.order.keyboard" (desktop and mobile, 4 runs). Moving and removing themselves work with Enter and Space.

P2F2 [CONFIRMED] medium The "refresh" hint of refused saves is ignored on the photos page (same cause as P1F3)
Steps: open the photos page, make a change, suspend the shop (admin API), press "Save photos".
Expected (problem-copy `shop_suspended` has `refetch: true`; map line media.save.suspended "page refreshes"): after the 403 the page reads the shop/gallery again and turns "Save photos" and the chooser off.
Actual: PUT answers 403 shop_suspended, the right sentence shows in the alert, but no GET follows (0 reads in 5 s) and Save photos, the chooser and the move/remove buttons stay enabled, so every further press gets another 403. The gallery view's `onSave` catch only sets the problem; `refetch` is never acted on (also why P1F3 shows "The list has been refreshed" with no refresh).
Evidence: spec `media-gallery-save.spec.ts` "media.save.suspended, media.save.offboarding" (soft checks: reads after refusal = 0; Save still enabled). Database unchanged (version 1).

P2F3 [CONFIRMED] low Pressing "Save photos" while offline is parked silently and goes out by itself at reconnect
Steps: edit the draft, go offline (the page shows "You're offline. Changes can't be saved."), press Save photos, wait, go back online.
Expected (W04.FR-045, map media.save.offline): an offline sentence or a refusal; a changed mind must be possible.
Actual: no request leaves, no sentence, the button turns disabled for good (the query library keeps the press waiting); at reconnect the PUT goes out unasked (version 1 -> 2, toast "Photos saved"). A person who closes the tab while offline loses the edit with no word; one who changes the draft meanwhile saves the changed draft.
Evidence: spec "media.save.500, media.save.offline, media.save.error-clear" (soft check "after the press offline the person can still see what to do" fails; the reconnect part passes). Hand probe: 0 PUTs offline, 1 PUT after reconnect, version 2.

P2F4 [SUSPICIOUS] low Wording: the photo conflict says "This product changed since you opened it."
Steps: two tabs, both open at version 1, A saves, B saves.
Actual: 409 version_conflict; B's alert reads "This product changed since you opened it." with "Load latest" (which works: draft dropped, A's order shown after the refetch). The thing that changed is the photo list.
Evidence: spec "media.save.conflict, ...conflict-copy".

P2F5 [SUSPICIOUS] low A move of a photo is silent for screen readers (no live region)
The shell has an empty live region; nothing around the photo list is `aria-live`, and a move only changes captions "Photo N". Map line media.order.live-announce (W04.NFR-a11y). Evidence: spec "media.order.drag-drop, media.order.live-announce" (passes only while the page stays silent).

Not bugs, notes for the next reader
- Cover: the product page main image cannot show on this stack (placeholder), same root as P1F4/B-002: the dev `MEDIA_CDN_URL` is `http://localhost:9000/...` and `Gallery` accepts `https` only (`safeHttpsUrl`). The public gallery API order is right (position 0 is the first photo). Spec "media.cover.first-is-main" fails for this reason.
- Malware scan (media.upload.limit.malware): blocked on this stack. `MEDIA_SCANNER_DISABLED=true` in `packages/backend/.env` and the ClamAV container port is not published; an EICAR text appended to a real JPEG becomes READY. The bare EICAR file is refused as `not_an_image` (correct, S29 AS-16). Test is `test.fixme`.
- Real rate limits (media.upload.limit.rate, media.save.rate): blocked, `RATE_LIMIT_ALLOW_IPS=127.0.0.1` lets this machine through (same as entry-1). The page's handling of an answered 429 with Retry-After is covered. media.save.rate-store-down: blocked, it needs the shared cache stopped, which other agents' runs depend on.
- A shop turned DELETING by changing the row directly is gated only after the member's access cache (up to 15 s) expires; after that presign and PUT answer 409 shop_offboarding as the spec says, and a page opened then shows the banner and has all controls off.
- A reject code the page's contract does not know makes the whole read invalid, so the row shows "Something went wrong on our side."; the generic words of `rejectCopy` ("That photo couldn't be used...") are unreachable from this page.
- Maintenance jobs verified on the real stack: lost message re-sent within about 1 to 2 minutes (UPLOADED older than 2 min -> READY), unused slot older than 60 min -> EXPIRED and its original deleted (run every 5 min), purge: a DELETED row 8 days old was purged within the hour, a DELETED row of today, a READY orphan 8 days old and a fresh READY orphan were kept.
- The public view of a READY photo does carry `shopId` (S29 AS-41 lists it). A copy of a picture uploaded by another shop is flagged privately; a re-upload by the same shop is not.
