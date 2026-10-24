# Can AI build and fix a slice without bugs? The scoreboard (seller dashboard)

Started 2026-10-25. One question: how many real bugs do independent methods still find in the seller dashboard, and does the number fall to zero?

## What counts as a "new actual bug"

A finding counts only if all four are true:
1. **Confirmed**: someone (or a script) reproduced it, with steps or a replay line, on the production build when it could be dev-mode noise.
2. **Real**: a user or an owner-defined rule is broken (a spec rule, a wrong answer, a crash, data lost, an accessibility failure). A style preference is not a bug.
3. **New**: not on the "already known" list below and not found earlier by a test.
4. **Not a duplicate** of another finding of the same round (one cause counts once).

Other results are counted separately: **candidate** (not confirmed yet), **false alarm** (dev noise, expected behavior, a wrong check in the tool), **duplicate**, **known**.

## Already known before the agents started (not counted as new)

- Seller photos: the upload does not load, disappears on reload, "Save photos" does nothing (found by the owner by hand, 2026-10-20).
- Found by flaky tests on 2026-10-24/25 (real product bugs, all fixed): cancel-order toast lost when the dialog closes; assistant reply shown twice after a reload; chat "Seen" receipt lost when leaving within 500 ms; dev seed broke on the free plan's 10-product limit; PostgreSQL 18 dropped `Product.shopId NOT NULL`; plus the backend ones in the plan file.
- Live panel on the seller overview grows by 44 px when its first live update arrives (a visible jump; not fixed, found by a picture test).

## Rounds

| Round | Date | Method | Scope | Real new bugs | Candidates | False alarms | Duplicates / known | Fixed | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 2026-10-24 | Monkey tester (2 min, dev server) | whole seller area | 0 confirmed yet | ~45 (hydration mismatch on ~13 pages, a11y list on developers/logs; the style-blocking error is probably dev-mode noise) | not triaged | - | 0 | needs a rerun on the production build |
| 0 | 2026-10-24 | API fuzzer (2 min, 3,520 requests) | 228 seller endpoints | 0 confirmed yet | 18 (answers without `code`, 400/404 instead of 401 on some endpoints) | some may be deliberate | - | 0 | no 5xx, no cross-seller leak, no duplicate create |
| 1 | 2026-10-25 | AI agent, charter seller-photos (explore only, 12 min) | photos | 0 new (1 confirmed, but it is the bug the owner already knew: photos blank after upload/Save/reload) | 1 suspicious (CSP inline-style console errors, likely dev-mode noise) | 0 | 1 known | 0 | Root cause found layer by layer: MEDIA_CDN_URL points at port 9000 (ClickHouse) instead of 9100 (MinIO), the page only allows 9100, and the bucket answers 403 on 9100. The data is saved; only the picture is blank. 20+ other cases clean (file kinds, limits, gallery API rules, permissions). Not done: two tabs, network loss, VIEWER role, suspended shop, keyboard reorder, public product page showed no img elements (not investigated). |

## How to read it

- The goal is a column of zeros in "Real new bugs" over several rounds, with fixes in between.
- Every round uses a fresh seller and shop, the same charters, and the monkey and fuzzer with a new seed.
- A bug found by two methods counts once; the table says which method found it first.
- This file is updated by hand after each round (the raw output stays in `specs/.checkpoints/qa-*`, which is not committed).
