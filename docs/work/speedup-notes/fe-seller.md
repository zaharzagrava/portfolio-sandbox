# Browser tests, seller and admin files: speed-up notes

Nothing was run (no whole app available). All edits are reading-based. No test lost a scenario or an assertion; no limit was widened.

## New file: packages/web/tests/seller-setup.ts
Two small helpers (kept out of helpers.ts because that file belongs to someone else):
- openShopByApi(member): opens a shop with the same call the "Open shop" form makes, instead of typing into the form. Same result as openShop.
- adminLoginByApi(page): signs the seeded admin in with the same two calls the sign-in form makes, then opens the flag list. PW_UI_LOGIN=1 still forces the real form.
Suggestion for the owner: move both into helpers.ts later.

## Per file
- seller-developers, seller-import, seller-inventory, seller-photos, seller-video, listing-editor, ad-campaign: shop is now opened by API (shop opening was only set-up here). Saving: about 2 to 3 s per test, so about 4 to 6 s per file (two projects). Could break: if the API call needs a field the form fills automatically (the handle); I send name and a unique handle, same as seller-shop's existing second-shop call. If the page cached "no shop yet" state, the later goto fixes it.
- seller-shop: tests "returning owner" (AS-08) and "two shops" (AS-09) open their first shop by API. The first test (opening from "Start selling") still uses the form, as it is the thing under test. Saving: about 5 s over both projects.
- seller-live: seller shop by API. Saving about 2 to 3 s per project. The buyer and the live-number waits stay (they are real signals, not sleeps).
- seller-team: the invitee and the owner now sign up at the same time (Promise.all) and the shop is made by API. Saving about 3 to 5 s per project. Could break: both sign-ups reset the rate limits at the same moment; harmless, they only clear counters.
- admin-flags (all 5 tests) and admin-access (the "admin sees shell" test): admin sign-in by API instead of the form. Saving about 2 s per test, about 10 tests-runs x 2 = roughly 20 to 40 s. The anonymous-visitor test in admin-access keeps the form login (return-to behaviour is what it checks). Could break: if the BFF refuses a login without the page having visited a page first (registerByApi does the same, so unlikely).
- seller.spec: unchanged, it tests the form on purpose.

## Read, no improvement found
- sponsored-listing.spec: only a test.fixme, never runs.
- No fixed waits (waitForTimeout), no networkidle, no screenshots, no serial describes in my files. fullyParallel is already true in the config, so adding parallel mode in a file would change nothing.
- Remaining waits are real signals with big limits (import Done 60 s, photo ready 60 s, video processing 60 s, webhook ping 45 s, collaboration connect 30 s); they are limits, not sleeps, and are left alone.
- admin-flags: four tests still create the flag through the form and the cleanup archives it through the page (goto plus two clicks, after every test). An API for create/archive would save about 3 to 4 s per test, but I did not find a safe API route name without running; worth a look by the owner.

## Slowest tests by reading
1. seller-video (uploads 8 MB, one part retried, 60 s wait for processing).
2. seller-live (two members, a full checkout and sandbox payment, waits for the order projection).
3. seller-photos (waits for the media worker to make the photo READY).
4. seller-import, seller-developers (webhook ping can take up to 45 s), listing-editor, seller-inventory (search index retry loop up to 45 s).
