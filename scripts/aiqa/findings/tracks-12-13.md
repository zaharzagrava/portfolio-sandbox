# Findings, tracks 12 (fault injection) and 13 (odd data)

Note (after the first run): the specs were renamed and split into one test per map line: `packages/web/tests/seller/cross-cutting/odd-data.spec.ts` (maps `coverage/odd-data.tsv`; old ids ODD-01..14 became `odd-data.*` line ids) and `packages/web/tests/seller/cross-cutting/fault-injection.spec.ts` (`coverage/fault-injection.tsv`; old FI-01..09 became `fault.<dependency>.<action>`). The text below is the record of the first run and keeps the old ids.

Run on 2026-10-25 against the dev stack (compose project sddqa081903, containers `payment_system_*`), API :8000, web :3000 (dev server).
Nothing in product code was changed; the failing checks stay unskipped.

## How to repeat

- Track 13: `node scripts/aiqa/tracks/odd-data/seed.mjs` (about 4 minutes: new seller + new shop on the Pro plan, 10,000 products through the API, 150 archived, 5,000 order slices by SQL, four products in JPY/KWD/BHD/USD by SQL). It writes `/tmp/fe/odd-data.json`. Then in `packages/web`: `npx playwright test tests/seller/cross-cutting/odd-data.spec.ts --project=desktop` (and `--project=mobile`). The two full-walk specs (ODD-03, ODD-04) take 4 to 7 minutes each.
  The run of 2026-10-25 used the shop `Odd Data Shop mvni1axm`, login `odd-seller-mvni1axm@example.com`, shop id `01a171ef-6c6b-7579-8459-2a880a20da04`.
- Track 12: `node scripts/aiqa/tracks/fault-injection/run.mjs <db|redis|kafka|elasticsearch|minio|scylla|elasticmq|clamav|clickhouse>` (no argument = all). It pauses ONE container (`docker pause`) while `packages/web/tests/seller/cross-cutting/fault-injection.spec.ts` acts, writes the window to `/tmp/fe/fault-window.txt`, unpauses on exit/crash/Ctrl-C. Per-run evidence: `/tmp/fe/fault/<dep>/{observations.json,trace.log,playwright.log}`.

## What passed (so it is not re-checked)

- ODD-01 (API): walking all product pages (page size 100 and 20, ACTIVE and ARCHIVED, in-stock/out-of-stock filters): 10,000 products, no duplicate, no gap, counts match (9,850 active + 150 archived).
- ODD-02 (API): walking all order pages: exactly 5,000 slices, none twice, newest first, exact ties in id order, status filters partition the set, every boundary instant (month, year, leap day, DST days, 23:59:59.999Z and 00:00:00.000Z) is stored and returned to the millisecond.
- ODD-03 (screen): following "Next page" through all 493 product pages gives the same rows as the API, none twice, none missing (one earlier run stopped at page 199, see S-1).
- ODD-04 (screen): the same for the 250 order pages.
- ODD-07: the 30 EDGE products (price 1, 29, 115, 1999, 99999999 and the maximum 10,000,000,000 minor; stock 0, 1, 5, 6, 1,000,000,000) show the exact price (`€0.29`, `€1.15`, `€19.99`, `€999,999.99`, `€100,000,000.00`) and the right label (Out of stock / Low stock / In stock) on the screen.
- ODD-10: hostile search text (`%_\`, `<img onerror>`, SQL text, zero-width only, 150 characters, RTL override) gives no error page and shows nothing as markup.
- ODD-11: order subtotals in EUR, USD, JPY, KWD, BHD match the API and the pure function (`formatMoney` 0 and 3 fraction digits are right). The platform books one currency (`PLATFORM_CURRENCY`, EUR); there is no per-shop currency, so the other currencies were tested by changing `BisOrder.currency` / `Product.currency` by SQL.
- ODD-12: editing the brand of EDGE products and retyping their price (0.29, 1.15, 999999.99, 100000000.00) leaves `priceMinor` exactly unchanged.
- Phone width (390 px): ODD-05, 06, 08, 14 pass: no sideways scrolling with the odd names.
- Fault injection with kafka, elasticsearch, scylla, clamav, clickhouse paused: every action succeeded, the retry was not needed, no duplicates, outbox rows all published after recovery.

## Bugs, track 13 (odd data)

### B-13-1 Long unbroken words make the inventory table wider than the screen (desktop)
- Expected (map `inventory.list.row-name` "long names wrap", `inventory.page.phone-layout` "nothing scrolls sideways", W04 R-28): a title of 100+ characters with no spaces wraps or is cut inside the table, the page never scrolls sideways.
- Steps: open `/dashboard/seller/01a171ef-6c6b-7579-8459-2a880a20da04/inventory` at 1280 px wide (project `desktop`). Page 1 holds `A` + 120 times `b` and `Pneumonoultramicroscopic...xxxx` titles.
- Actual: the table grows to the word: the page scrolls sideways, `scrollWidth` 1492 against 1280 (table spans x 288..1492; Stock, Status and Actions columns are off screen). The same on `?status=ARCHIVED` (1477), `?inStock=false` (1340), search `#09991` (1382), `#09987` (1284), `#09994` (1492). The cell has `break-words`, which does not lower the minimum width of a table cell; `overflow-wrap: anywhere` or `table-layout: fixed` / `min-w-0` would.
- Evidence: `tests/seller/cross-cutting/odd-data.spec.ts` (first-run ids ODD-05, ODD-06, ODD-08, ODD-14, desktop). At 390 px the same pages pass (the table becomes cards).

### B-13-2 Order dates are shown in the server's time zone, not the viewer's, on a page load
- Expected (W04 assumptions "Time", `packages/web/lib/seller/format-date.ts`: "a server timestamp in the viewer's zone with the UTC instant beside it"): the date column shows the time in the viewer's zone.
- Steps: open the orders page (or any `?cursor=` page) with the browser in `Pacific/Kiritimati` (UTC+14), `Pacific/Pago_Pago` (UTC-11), `Asia/Kolkata` (UTC+5:30) or `America/St_Johns` (UTC-2:30); look at the order created at `2024-02-29T00:00:00.000Z`.
- Actual: all four zones show `Feb 29, 2024, 1:00 AM`, which is the server's own zone (Central European), not the viewer's. Expected `Feb 29, 2024, 2:00 PM` (Kiritimati), `Feb 28, 2024, 1:00 PM` (Pago Pago), `Feb 29, 2024, 5:30 AM` (Kolkata), `Feb 28, 2024, 8:30 PM` (St. John's). The `datetime` attribute and the tooltip (`2024-02-29 00:00 UTC`) are right, so the screen contradicts its own tooltip by up to 13 hours and shows the wrong calendar day around midnight. The text is rendered on the server (`formatInstant` without a zone) and the browser keeps it.
- Evidence: ODD-13 for the four zones, desktop and mobile.

### B-13-3 Searching for emoji finds nothing
- Expected (map `inventory.search.special-characters`, `inventory.search.box`): a search for text that is in a title finds that product. Many of the 10,000 titles contain `Mug 😀☕`.
- Steps: inventory, search `😀☕` (API: `GET /products/search?q=😀☕`).
- Actual: 0 hits and the message "No products match". Cyrillic, Arabic, Chinese, Japanese words all find their products (ODD-09 passes for them); the accent (`Crème`) and `Straße` cases come after the emoji case and were skipped by the check, so they are untested.
- Note: probably the index analyzer drops emoji; decide whether that is accepted behaviour. Evidence: ODD-09 (emoji case, desktop and mobile).

### Suspicious, not reproduced (S-1)
- During the first screen walk of the product pages (ODD-03) the page at about page 199 showed "We couldn't find that shop." while the API answered 200 for the same shop with the same session. A repeat run of the whole walk passed, and a direct page open a few minutes later worked. Other testers were running suspend/offboarding hardening specs and the dev web server was reloading at the time, so this may be a transient (the shop-access cache or the web server reading a failed shop call as "not found"). Worth a look: `components/dashboard/shop-frame.tsx` turns a 403 or 404 into the not-found page.

## Bugs, track 12 (fault injection)

Honest-error rule used: after the click the screen must show a result (success toast or an error) within 25 seconds. The app sets no client timeout of its own.

### B-12-1 Postgres paused: saving a product, changing stock, archiving, opening a shop show "working" for the whole outage, no error
- Expected (W04 B-36, R-13, AS-31): an error message with "Try again" and a reference, or at least a timeout message.
- Steps: pause `payment_system_db`; in a signed-in shop press Create product / Update stock / Archive product / Open shop.
- Actual: the buttons stay in their busy state ("Creating…", "Opening…", the dialog stays open) for the 25 s observed and, in the 168 s window, until the database came back; no error text. After unpause the writes completed: the product row exists once, the shop exists once (so no duplicate and no half-written row, but the screen said nothing). The Edit dialog never became usable within 30 s (the Brand field could not be filled).
- Good: opening Inventory and Orders while paused gives "Something went wrong. We hit an unexpected problem... Reference: 2674597584, Try again, Go to home" within 5 s, with no stack or SQL text.
- Evidence: `/tmp/fe/fault/db/observations.json` (run 2026-10-25 around 09:20 UTC), `FI-01..09 db`.

### B-12-2 Redis paused: every page and action hangs, nothing is shown, for the whole outage
- Expected: an error state or at least a message within a reasonable time.
- Actual (window 207 s): Inventory and Orders navigation does not finish within 25 s (`page.goto` timeout), Create product / Update stock / Archive product / Open shop / photo upload show no result in 25 s, the Edit dialog is not usable. After unpause the actions turned out to have completed: product created once, stock = 3, product ARCHIVED, shop opened once. So the screens gave no answer while the server later did the work: the seller cannot tell whether it worked and may press again.
- Evidence: `/tmp/fe/fault/redis/observations.json`.

### B-12-3 MinIO paused or ElasticMQ (queue) paused: photo upload shows no result, no error
- Expected: an honest error ("couldn't upload, try again") or progress that ends.
- Actual: after choosing a file the page shows no photo tile and no message for 25 s (MinIO: the upload to storage hangs; ElasticMQ: the "complete" step hangs). After unpause one retry (reopen the photo page, add the photo again, Save photos) produced exactly one photo in the gallery. Everything else (create, edit, stock, archive, inventory, orders, open shop) worked with these two paused.
- Evidence: `/tmp/fe/fault/minio/observations.json`, `/tmp/fe/fault/elasticmq/observations.json`.

### Not a bug, for the record
- No raw stack, SQL or driver text was seen on any screen in any run (leak check on dialogs, toasts and page text).
- No fake success toast was seen: every "success" was backed by the saved row after recovery.
- Outbox: after recovery all outbox rows of the test shops were published within 2 minutes for every dependency (kafka included, which was paused while products were created).

## Limits of this run

- Containers were paused one at a time for 7 to 207 seconds, each inside a window written to `/tmp/fe/fault-window.txt`; no container was left paused (checked after each run).
- `docker pause` freezes the container: connections hang instead of being refused. A refused connection (stop/start) may behave differently; not run.
- Orders were written by SQL (no seller-side API creates them), with millisecond-precision times; sub-millisecond times are not covered.
- A total above 2^53 minor units cannot be written as a JavaScript number, so the money function was not tested there.
