# Track "odd-data": does the page survive strange and huge data?

Plain words: the normal tests use tidy data ("Blue Mug", price 19.99, 3 products). Real shops have Arabic names, emoji, a title that is one 120-letter word, prices like 0.29, and 10,000 products. This track builds ONE throwaway shop full of such data and checks that every list, search and money amount still shows exactly what the server holds.

Files:

- `seed.mjs` builds the data (this folder).
- `packages/web/tests/seller/cross-cutting/odd-data.spec.ts` is the permanent test, one test per map line.
- `scripts/aiqa/coverage/odd-data.tsv` is the map (one line per data shape x page). Line ids look like `odd-data.inventory.long-word-no-spaces`.
- `scripts/aiqa/findings/tracks-12-13.md` holds the first run's findings (B-086, B-087, B-088, B-092 in `docs/work/qa-bug-register.md`).

## What this finds that the other tracks miss

- Layout that breaks with a long word with no spaces (the table grew wider than the screen: B-086).
- Text that depends on the computer's time zone (the server drew the date in its own zone: B-087).
- Search that silently drops some characters (emoji: B-088).
- Money rounding: 0.29 and 1.15 are not exact in floating point; currencies with 0 or 3 decimals.
- Paging bugs that need thousands of rows (a duplicate or missing row at a page border, a cursor that stops early).
- Sorting ties: 480 orders were written at the exact same second, to check the order stays stable.

The map-driven testers use small clean data; the stateful and mutation tracks check rules, not looks. Nothing else uses 10,000 rows or other scripts.

## Before you start

- The dev stack is up: web http://localhost:3000, API http://localhost:8000, Postgres and Redis containers (`QA_DIR=/tmp/fe WITH_WEB=1 scripts/qa/stack-up.sh`, one stack at a time; never next to the backend test stack).
- Memory and time: the seed runs 6 API calls at the same time and takes about 4 minutes. The shop adds about 10,000 products (and their search entries and outbox rows) and 5,000 orders to the dev database. The full spec takes 20 to 40 minutes on one Playwright worker; the two "Next page" walks (493 product pages, 250 order pages) are 4 to 7 minutes each. Use `--workers=1` and do not run it next to other heavy suites; the spec clears the rate limiter counters (as `tests/helpers.ts` does), which other running tests notice.
- Use your own output folder when others run Playwright too (`--output=/tmp/<yours>`): Playwright wipes its output folder at start.

## Commands

```
node scripts/aiqa/tracks/odd-data/seed.mjs                  # builds the shop, writes /tmp/fe/odd-data.json
cd packages/web
npx playwright test tests/seller/cross-cutting/odd-data.spec.ts --project=desktop --workers=1 --output=/tmp/my-odd
npx playwright test tests/seller/cross-cutting/odd-data.spec.ts --project=mobile  --workers=1 --grep-invert paging    # phone width, without the long walks
npx playwright test tests/seller/cross-cutting/odd-data.spec.ts --grep "odd-data.orders.date"                         # a subset
node scripts/aiqa/run-specs.mjs odd-data [--all] [--dry]    # runs the spec when a line is untested and marks the lines from the result
node scripts/aiqa/status.mjs odd-data                       # what is still untested
```

Without `/tmp/fe/odd-data.json` (or the file named in `ODD_DATA_FILE`) every test skips itself with the reason, so the normal suite never needs the seed.

Seed settings (environment variables): `ODD_PRODUCTS` (default 10000), `ODD_ORDERS` (default 5000), `ODD_DATA_FILE`, `API_URL`. Each run makes a NEW seller and shop (`odd-seller-<stamp>@example.com`, "Odd Data Shop <stamp>"); the demo shop is never touched. Old odd shops stay in the database; delete them with the stack's reset if the database grows.

## The data shape catalogue (what the seed puts in)

| Shape | Why it breaks things | Examples in the seed | Map lines |
|---|---|---|---|
| Other scripts | wrong font, wrong width, search that only knows Latin | Cyrillic `Чайник керамічний «Київ»`, Arabic `قهوة عربية`, Chinese `手工陶瓷茶杯`, Japanese `コーヒーミル`, Hebrew `שעון יד מהודר` | `inventory.first-page-odd-names-and-labels`, `inventory.search-cyrillic/arabic/chinese/japanese` |
| Emoji | multi-part characters, search index drops them | `Mug 😀☕`, family emoji `👨‍👩‍👧‍👦` | `inventory.search-emoji` |
| Right to left | text direction flips the row, an override character reverses what follows | `‮RTL override`, Arabic and Hebrew titles | `inventory.rtl-override-names` |
| Combining marks ("Zalgo") | the line gets very tall | `Z̵̡a̷l̸g̴o̶` | `inventory.combining-marks-names` |
| Zero-width characters | invisible, so two titles look the same; the search sees them | `Cafe​​Latte‍` | `inventory.search-hostile-zero-width-only` |
| Accents and case rules | `Straße` vs `STRASSE`, `İstanbul`, composed vs decomposed `é` | `ééé Crème brûlée`, `Straße Ärger Œuvre Ǆ`, `İstanbul ı̇` | `inventory.search-accent`, `inventory.search-german-sharp-s` |
| Very long words | one word with no space cannot wrap | `A` + 120 `b`; `Pneumonoultramicroscopicsilicovolcanoconiosis` + 60 `x`; a 150-letter search | `inventory.long-word-no-spaces`, `inventory.long-title-edit-dialog`, `layout.*` |
| Markup and quotes | text must stay text | brand `O'Brien "Quoted" <b>`; searches `<img onerror>`, SQL text, `%_\` | `inventory.search-hostile-*` |
| Prices that round badly | 0.29 x 100 = 28.999999999999996 in floating point | minor units 1, 29, 115, 1999, 99999999, 10,000,000,000 (EUR 0.01 ... 100,000,000.00) | `inventory.edge-price-*`, `inventory.edit-price-*` |
| Currencies by number of decimals | 0 decimals (JPY), 2 (EUR, USD), 3 (KWD, BHD) | 4 products and about a quarter of the orders in JPY / KWD / BHD / USD (set by SQL: the platform itself books one currency) | `inventory.price-currency-*`, `orders.subtotal-currency-*` |
| Stock at the borders | labels change at 0 / 1-5 / 6+ | stock 0, 1, 5, 6, 1,000,000,000 combined with every price (30 "EDGE" products) | `inventory.edge-stock-*` |
| Volume | paging and counts | 10,000 products (150 archived), 5,000 order slices | `inventory.paging-10000`, `orders.paging-5000` |
| Times near midnight | the day changes with the viewer's time zone | 16 instants: leap day 2024-02-29 00:00Z, year ends, month ends, 2025-03-30 01:00Z (EU clocks jump), 2025-10-26 01:00Z, `23:59:59.999Z`, `00:00:00.000Z`, each +/- 1 ms and with exact ties | `orders.date-timezone-*` |
| Viewer time zones far from the server | text drawn on the server shows the server's zone | Pacific/Kiritimati (UTC+14), Pacific/Pago_Pago (UTC-11), Asia/Kolkata (+5:30), America/St_Johns (-2:30) | `orders.date-timezone-*` |
| Phone width | cards instead of a table | every list also at 390 px (project `mobile`) | `layout.*` |

Not done yet (open map lines, status untested): sums above 2^53, viewer zones with a daylight-saving jump, microsecond times, odd brand/description in the edit dialog, JPY/KWD products in the edit dialog, 100,000 products, odd photo file names.

## How to point it at a NEW feature

1. In `seed.mjs`: add the new entity to the data. Use the real API where one exists (so the outbox, search index and projections run as in production); use SQL only for things no API can create (here: orders, other currencies). Put the odd values into the lists at the top (`NAMES`, `BRANDS`, `CATS`, `EDGE_PRICES`, `EDGE_STOCK`, `BOUNDARIES`, `CURRENCIES`, `STATUSES`). Add the new ids to the manifest `/tmp/fe/odd-data.json` (the spec reads it).
2. Pick the shapes from the catalogue above that fit the new fields: every text field gets scripts, emoji, a long word, markup; every number gets 0, 1, the border values and the maximum; every money field gets the three decimal sizes and the rounding prices; every date gets the midnight instants and the far time zones; every list gets the volume.
3. In the map (`odd-data.tsv`): one line per shape x page, id `odd-data.<area>.<shape>`, `spec` = the spec rule ids, `code` = the page file > API route > service > table, status `untested`.
4. In `odd-data.spec.ts`: one test per line. Title starts with the line id in brackets; the first statement is `lines('<id>')` (the `aiqa-lines` annotation). Read every list twice (API = the saved truth, screen = what a person sees) and compare. Reuse `walk` (cached cursor walk), `readInventoryRows`/`readOrderRows`, `expectedMoney` (whole-number arithmetic, no floats), `expectNoSidewaysOverflow`.
5. `node scripts/aiqa/fingerprint.mjs odd-data`, then `node scripts/aiqa/run-specs.mjs odd-data`.

## How to read the results

- A passing test = the line is `pass` (the runner writes it with `mark.mjs`).
- A failing test = a finding. Keep the test failing and unskipped. The soft checks name the exact element ("the page scrolls sideways (1492 > 1280)", "the shown date of 2024-02-29T00:00:00.000Z in Pacific/Kiritimati").
- A test can fail on one project only: B-086 (long word) fails on `desktop` (a table) and passes on `mobile` (cards). The runner marks a line `bug` when any project fails.
- Skips mean no manifest file. Skipped lines are never marked.

## How results become map lines, findings and register entries

`run-specs.mjs` marks each line (`pass` or `bug` with bug id `spec-fail`). For every `bug`: write the steps, expected (spec id), actual and evidence in `scripts/aiqa/findings/<name>.md`, then add a row to `docs/work/qa-bug-register.md` (B-nnn) and put the B-nnn into the `bugs` column of the line by hand through `mark.mjs ... bug ui,api,db B-nnn "<note>"`. Counts go to `docs/work/qa-bug-scoreboard.md`.

## Known limits

- The platform books one currency, so other currencies exist only because the seed changed rows by SQL; the search index still holds the old titles of those rows, so those products are found through the list, not the search.
- Orders have no seller-side create call; they are written by SQL with millisecond times. Microseconds are not covered.
- A JavaScript number holds integers exactly only up to 2^53; a total above that cannot be written by the seed (open line `odd-data.money.sum-above-2-53`).
- The dev web server (not a production build) was used; timings are slower than production.
- The "Next page" walks test 20 rows per page only.
