# entry, pass 1 (ai-tester, 2026-10-25): findings

Specs: packages/web/tests/aiqa/entry-index.spec.ts and entry-form.spec.ts (run: `npx playwright test tests/aiqa --project=desktop`).
The failing tests below are left failing on purpose: each one is a finding.

P1F1 [CONFIRMED] medium /dashboard/seller?cursor=<refused by the API> shows the generic "Something went wrong" page
- Steps: sign in as a member with 2 shops, open /dashboard/seller?cursor=garbage (also ?cursor=abc).
- Expected (W04 B-36): "That page link is no longer valid." with a "Go to the first page" button.
- Actual: the whole page is replaced by the generic error page ("Something went wrong", Reference: <digest>, Try again, Go to home). `page.tsx` throws Error('shops_unavailable') for every non-401 failure. Also: the API answers 400 `validation_failed` (errors[{field:cursor}]), not `invalid_cursor` as the map and spec say, so even a fixed page would have to read that code. "Try again" re-renders and fails again (same cursor stays in the address).
- Evidence: test "entry.index.invalid-cursor ..." (entry-index.spec.ts) fails at the missing text; GET /api/shops/mine?cursor=garbage -> 400 validation_failed; console "Error: shops_unavailable at SellerIndex".

P1F2 [CONFIRMED] medium Signed-out visit to a section of a shop loses the section and the query in returnTo (same as register B-023)
- Steps: signed out, open /dashboard/seller/<shopId>/inventory?q=mug.
- Expected (W04 B-33): /login?returnTo=%2Fdashboard%2Fseller%2F<id>%2Finventory%3Fq%3Dmug.
- Actual: /login?returnTo=%2Fdashboard%2Fseller%2F<id> (also for /orders?page=2). `shop-frame.tsx#ShopFrame` builds returnTo from the shop root only. `/dashboard/seller?cursor=x` and `/dashboard/seller/inventory` keep their full address (fine).
- Note: the register id B-033 named in the task is a different bug (archived products in the in-stock filter); the returnTo bug is B-023.
- Evidence: test "entry.index.signed-out-redirect: a signed-out visit to a section ..." fails (received URL without /inventory?q=mug).

P1F3 [CONFIRMED] low Accented letters split the handle: "Café Münster" -> "cafe-mu-nster", "Söhne" -> "so-hne"
- Steps: type "Café Münster" in Shop name (handle untouched).
- Expected: accents stripped to the base letter ("cafe-munster"; the map says "accents stripped").
- Actual: `slugify` uses NFKD but never removes the combining marks, so each accent becomes a dash. Non-Latin names (Привіт світ) and emoji give an empty handle (as mapped).
- Evidence: test "entry.form.slugify-edge-cases" fails on the last line.

P1F4 [CONFIRMED] low The first press of "Open shop" is lost when the Handle field had focus and holds a bad value
- Steps: type a name, type "Bad Handle" in Handle (field still focused), click "Open shop".
- Expected (W04 AS-05): the form is checked and focus goes to the first invalid field (Handle).
- Actual: pressing the mouse button blurs the Handle, its error line appears and pushes the button down 24 px, so the click never reaches the button (no submit event). Focus stays on the button; a second press works and focuses the Handle. Same when both fields are bad and the Handle had focus. Nothing is sent either way, so no data harm.
- Evidence: test "entry.form.submit-invalid-focus" fails at the focus check (Playwright click, reproduced in 4 runs by hand: events show `click` without `submit`).

P1F5 [CONFIRMED] low The role refresh after opening a shop never stops early (W04 AS-04)
- Steps: open a first shop; watch POST /api/bff/session/refresh.
- Expected: asks after 1 s, 2 s, 4 s "until the role shows SELLER, then stops".
- Actual: the 2nd answer already says role SELLER, but the 3rd request is still sent every time. `open-shop-form.tsx#refreshUntilSeller` reads `result.session.role`, but the answer is `{ user: { role }, expiresAt }`, so the check never matches.
- Evidence: test "entry.form.submit-happy-path ..." fails at "no third request" (3 refresh calls observed in 3 runs).

P1F6 [SUSPICIOUS] low Handle field accepts 80 typed characters while the API takes 3 to 40
- `maxLength={80}` on the Handle; only the blur/submit check refuses 41 to 80 characters (message "Use 3 to 40 ..." shows). Spec S03 R-13 says 3 to 40. No data harm.

P1F7 [SUSPICIOUS] low A member of one shop who opens /dashboard/seller?cursor=<cursor of another list> sees an empty "Your shops" list
- The cursor decodes to a position past all of their rows, so the page shows the heading, "Choose a shop to open its dashboard." and only a "First page" link: no empty-state text. Reachable only with a stale or foreign link.

## Map corrections made while testing (not bugs)
- Gaps (b) "offline banner missing outside the shop shell": wrong. A site-wide banner "You're offline. Some things may not load or save until you're back online." shows on the form, the picker, the shop pages and public pages; the shop shell adds a second one "You're offline. Changes can't be saved.".
- Gaps (c) "non-UUID shop id answers 400": wrong. GET /api/shops/not-a-uuid answers 404 shop_not_found, same as an unknown id (S03 R-01 holds).
- 429 text: the visible text counts down ("Too many attempts. Try again in 4 s." -> 3 -> ... -> "You can try again now."), one polite announcement at start ("Try again in 4 seconds.") and at the end; verified with an answered 429.
- The real 429 (6th creation in an hour) cannot happen on this stack: RATE_LIMIT_ALLOW_IPS=127.0.0.1 lets 7 creations in a row through (no RateLimit headers). The form's 429 handling was tested with an answered 429.
- The shop-limit message in the form is only reachable when shops are created after the form is open (a member with 10 shops never sees the form): tested that way.
- Dev server only: /dashboard and /dashboard/settings answer HTTP 200 with a meta refresh and NEXT_REDIRECT 308 payload (streamed); the browser ends on the right address.
- The "Open menu" button at 390 px on the no-shop page belongs to the site header, not to a dashboard top bar.
- Form page title is "Your shops" (same as the picker), the h1 is "Open your shop".
- The POST /api/shops from the form carries no Idempotency-Key (gap a, confirmed).
- API: unknown fields 400 unknown_property; name 1 and 81 chars 400 minLength/maxLength; handles 3 and 40 chars, "p--x" accepted; "ab", 41 chars, leading/trailing dash, uppercase 400.
