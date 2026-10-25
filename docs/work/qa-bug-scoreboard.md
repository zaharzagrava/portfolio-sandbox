# Can AI build and fix a slice without bugs? The scoreboard (seller dashboard)

Started 2026-10-25. One question: how many real bugs do independent methods still find in the seller dashboard, and does the number fall to zero?

Every single finding, with its status and where it was fixed, is in `docs/work/qa-bug-register.md` (B-001 and up). This file keeps the counts.

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
| 2a | 2026-10-25 | AI agent, charter seller-shop-setup (explore only, 12 min) | shop setup / sign-in / suspended shop | 2 (B-023 verified by hand, B-024 by the agent) | 2 (B-025, B-026) | 0 | 0 | 0 | 12 clean areas listed (open form validation, double click, XSS text, picker/switcher, offline banner...) |
| 2b | 2026-10-25 | AI agent, charter seller-products (explore only, 15 min) | products | 0 | 5 (B-027 invitation mail never arrives, B-028 to B-031) | 0 | 0 | 0 | Blocked: VIEWER/STAFF checks (no invitation mail) |
| 2c | 2026-10-25 | AI agent, charter seller-inventory-stock (explore only, 4 min: ran out of its own time) | inventory / stock | 1 (B-032) | 2 (B-033, B-034) | 0 | CSP noise seen again | 0 | Not done: buy-the-last-unit race, VIEWER role, empty shop, double click |
| 2d | 2026-10-25 | AI agent, charter seller-orders (explore only, 6 min) | orders | 2 (B-035 buyerId exposure, verified by hand; B-036 reference column nearly identical on every row) | 0 | 0 | CSP noise seen again | 0 | Clean: money totals, paging, statuses, export, permissions |
| 3a | 2026-10-25 | Map-driven pass 1, entry area (40 of 182 lines, as permanent Playwright specs) | entry | 5 new (B-037 to B-040 confirmed; B-023 re-confirmed, known) | 2 (B-041, B-042) | 3 wrong claims in the mapper's gap list | B-023 | 0 | 29 pass, 7 bug, 3 blocked, 8 new lines added |
| 3b | 2026-10-25 | Map-driven pass 1, media area (40 of 163 lines + 4 new, permanent specs) | photos | 3 new (B-043, B-044, B-045); B-002 and B-023 re-confirmed (known); B-026 confirmed on dev | 2 (B-046, B-047) | 0 | B-002, B-023, B-026 | 0 | 31 pass, 6 bug, 1 n/a |
| 3c | 2026-10-25 | Map-driven pass 1, orders area (40 of 131 lines, permanent specs) | orders | 5 new (B-048 to B-051 confirmed, B-049 medium); B-035, B-036, B-023 re-confirmed | 1 (B-052) | 0 | B-023, B-035, B-036 | 0 | 31 pass, 7 bug, 2 blocked (unreachable) |
| 3d | 2026-10-25 | Map-driven pass 1, inventory area (40 of 174 lines, permanent specs; also triage of the cache builder's 9 failing lines) | inventory | 2 new (B-053, B-054); B-030 and B-023 confirmed | 1 (B-055) | 5 test mistakes fixed | B-023, B-030 | 0 | 35 pass, 4 bug, 1 n/a; 40 pass / 8 fail (4 real bugs on desktop and mobile) |
| 4 | 2026-10-25 | Tracks: production build (monkey 10 min, fuzzer 10 min, recheck of dev-only findings) and security scanners (Semgrep, gitleaks, audit, Schemathesis, ZAP) | whole seller area + dependencies | 8 (B-056 to B-061, B-063; B-005 and B-026 now real on production) | 1 (B-062) | 1 (B-003 dev-only) | B-035 found again by Semgrep | 0 | Critical dependency holes: Next.js, DOMPurify, multer |
| 5a | 2026-10-25 | Map-driven pass 2, entry area (70 lines, permanent specs, desktop and mobile) | entry | 1 new (B-065); B-023 and B-026 re-confirmed; flake `submit-happy-path` explained by B-040 | 0 | 0 | B-023, B-026, B-040 | 0 | 63 pass, 5 bug, 2 unreachable; all four roles checked on 18 menu entries |
| 5b | 2026-10-25 | Map-driven pass 2, inventory area (70 lines, 5 new permanent specs, desktop and mobile) | inventory | 7 new (B-066 to B-072); B-024, B-030, B-051 re-confirmed | 0 | 0 | B-024, B-030, B-051 | 0 | 54 pass, 13 bug, 3 blocked |
| 5c | 2026-10-25 | Map-driven pass 2, media area (71 lines, 4 new permanent specs, desktop and mobile) | photos | 3 new (B-073, B-074 confirmed; B-077 info); B-002, B-043 re-confirmed | 2 (B-075, B-076) | 0 | B-002, B-043 | 0 | 55 pass, 12 bug, 4 blocked |
| 5d | 2026-10-25 | Map-driven pass 3, entry area (72 lines, 7 new permanent specs, desktop and mobile) | entry | 8 new (B-078 to B-082, B-083, B-085; B-084 candidate); B-023, B-071 re-confirmed | 1 (B-084) | 0 | B-023, B-071 | 0 | entry map complete: 159 pass, 24 bug, 6 blocked, 0 untested |
| 5e | 2026-10-25 | Map-driven pass 2, orders area (91 lines, 9 new permanent specs, desktop and mobile) | orders | 2 new (B-093 medium, B-035 now with failing test); B-054, B-078, B-024, B-049 re-confirmed | 2 (B-095, B-096) | 1 test mistake (phone menu click) | B-024, B-035, B-049, B-054, B-078 | 0 | orders map complete: 106 pass, 19 bug, 6 blocked, 0 untested |
| 5f | 2026-10-25 | Map-driven pass 3, inventory area (63 lines + 4 new, 5 new permanent specs) | inventory | 2 new (B-097, B-098); B-032, B-028, B-024, B-072 confirmed | 0 | 0 | B-024, B-028, B-032, B-072 | 0 | inventory map complete: 151 pass, 24 bug, 2 blocked, 0 untested; real 429 via LAN address unblocked 2 lines |
| 5g | 2026-10-25 | Map-driven pass 3, media area (52 lines, 7 new permanent specs) | photos | 2 new (B-099 medium, B-100 high lost update); B-002 re-confirmed | 0 | 0 | B-002 | 0 | media map complete: 111 pass, 19 bug, 17 blocked, 0 untested (20 n/a) |
| 6 | 2026-10-25 | Tracks: odd and large data (10,000 products, 5,000 orders), fault injection (7 services paused in turn) | orders, inventory, photos, all writes | 6 (B-086, B-087, B-089, B-090, B-091 confirmed; B-088 candidate) | 2 (B-088, B-092) | 0 | B-078 family | 0 | The app copes with Kafka, search, Scylla, scanner, ClickHouse outages; silent screens when the database, Redis, storage or queue freeze |

## How to read it

- The goal is a column of zeros in "Real new bugs" over several rounds, with fixes in between.
- Every round uses a fresh seller and shop, the same charters, and the monkey and fuzzer with a new seed.
- A bug found by two methods counts once; the table says which method found it first.
- This file is updated by hand after each round (the raw output stays in `specs/.checkpoints/qa-*`, which is not committed).
