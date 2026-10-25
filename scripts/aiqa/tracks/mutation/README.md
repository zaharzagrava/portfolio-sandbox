# Track 2: mutation testing

Plain words: break the code on purpose (change `>` to `>=`, delete a check, swap `&&` for `||`), run the tests, and see if some test fails. A "survivor" is a deliberate mistake that no test noticed: that line is not really guarded.

## Web (Stryker) - done, works

- Run: `cd packages/web && pnpm mutation:web` (about 10 minutes, no services needed).
- Config: `packages/web/stryker.config.json`. The tests used: `packages/web/vitest.mutation.config.ts` (a narrow copy of the normal vitest config: only tests of the seller area, auth, and the dashboard shell; the full suite is slow and one focus test is flaky under load).
- Files mutated: `lib/seller/{money-input,stock,search-params,permissions,nav}.ts`, `lib/api/{seller-products,seller-orders}.ts`, `lib/auth/{return-to,guards}.ts`. Add a file to `mutate` in the config to include it.
- Report: `packages/web/reports/mutation/index.html` (open in a browser) and `mutation.json`; both are git-ignored.
- Two repo-specific settings that were needed:
  - `"tsconfigFile": "tsconfig.stryker-skip.json"` (a file that does not exist): Stryker's TypeScript step crashes with TypeScript 7 in this repo (`ts.parseConfigFileTextToJson is not a function`); vitest does not need it.
  - `concurrency: 3`. With 4 runners the test "W04 AS-94 row menu ... returns focus to the trigger" failed once in the first (clean) run, which makes Stryker refuse to start. That test is timing-sensitive; if Stryker says "failed tests in the initial test run", just run again or lower `concurrency`.
- Stryker 10.1.1 and vitest 3.2.7 work together (`@stryker-mutator/vitest-runner`, `coverageAnalysis: perTest`).

### Result (2026-10-25)

| | mutants | killed | survived | no coverage | score |
|---|---|---|---|---|---|
| first run | 592 | 494 | 85 | 13 | 83.45% (85.32% of covered) |
| after new tests | 592 | 580 | 11 | 1 | 97.97% (98.14% of covered) |

Per file, first run -> after new tests: money-input 83.3 -> 97.2; nav 71.2 -> 99.5; search-params 84.7 -> 96.4; permissions 97.8 -> 100; return-to 95.7 (same); stock 100; guards 100; seller-orders 100; seller-products 95.7 (same).

New tests (beside the old ones, nothing weakened): `lib/seller/money-input.mutation.test.ts`, `search-params.mutation.test.ts`, `permissions.mutation.test.ts`, and `nav.test.ts` (nav had no test file at all: links, labels, current-page logic, shop switcher target, legacy inventory redirect).

What the first run showed that mattered:
- `nav.ts` had no unit test: the sidebar links and labels, the "which page am I on" logic, and the target of the shop switcher were only checked by whole-page tests.
- money-input: "5-3" and "- 5" reasons, many leading zeros, the 16-digit boundary.
- search-params: UUID / day / orders-status / event-id regexes had no anchor tests (a value with junk before or after was accepted by the mutant), the 512 cursor limit, the day-of-month check (2026-02-30), `days` accepting `' 7'`, `'+7'`, `'7e0'`, `'0x7'`.
- permissions: the "shop not available" text.

Survivors that are left, and why they are fine:
- `money-input.ts` L18 (`digits.length > 16` -> `false`): the next line (`isSafeInteger`) gives the same answer; the length check is only a fast path.
- `search-params.ts` L24 (day regex anchors) and L50 (`'ACTIVE'` in the allowed list): the following `Date` check / the fallback give the same result; equivalent.
- `return-to.ts` L14 sub-conditions and L15: the later percent-decoded check gives the same answer for every input; equivalent.
- `nav.ts` L49 (`ROLE_LABEL = {}`): the fallback formula produces the same four labels; equivalent.
- `seller-products.ts` L74 (`productId ?? ''`): only the cache key of a disabled query when no product is chosen; no visible behavior.

## Backend (in-house mutate.py) - written, NOT run in this round

- Run: `scripts/aiqa/tracks/mutation/backend.sh [--max 25] [--min-score 0.6]`. Needs only node and jest (unit specs, no docker, no database), but it runs jest once per mutant, so it takes a while (12 files x 25 mutants ~ 300 jest runs). It was not run now because another agent owns the backend test stack.
- Files: tenancy permissions, role-policy, shop-status, cursor; catalog stock-rule, product-input, product-status; orders money-allocation, stock-operations, order-state; fulfilment stock-rules, search-cursor.
- Not covered yet because no unit spec sits next to them (mutate.py needs one): catalog `product-cursor.ts`, `stock-input.ts`, orders `order-cursor.ts`, and the services (`product-command.service.ts`, `gallery.service.ts`), which are tested only by end-to-end specs. Writing a unit spec for the cursors and stock-input is the cheapest next step.
- Output is also written to `scripts/aiqa/tracks/mutation/backend-<date>.txt`.
- For each survivor: write a test that fails on that mutant, rerun the file.
