# Quickstart: W04 — Seller dashboard (validation guide)

Prerequisites: local dev stack running (API `http://localhost:8000`, wait for `GET /health/ready` after backend edits), `pnpm install` done, `packages/web/AGENTS.md` and the Next 16 guides read. Playwright starts the web dev server. Run Playwright with `--reporter=line --max-failures=1` and one spec file until the final full run. Backend specs through `scripts/sdd/test-spec.sh <path-or-pattern>`.

References: scenarios `spec.md` AS-01..AS-98; layer per scenario `test-plan.md`; names in `contracts/web-modules.md`; endpoints in `contracts/backend-endpoints.md`; entities `data-model.md`.

## Validation steps (narrowest first)

| Step | Command (from `packages/web` unless noted) | Expected |
|---|---|---|
| Living spec | `python3 scripts/livespec/check.py` (repo root) | `W04-seller-dashboard.md` page present, every `[proof: …]` / `[code: …]` true |
| Contract | `scripts/sdd/test-spec.sh packages/backend/libs/composition/bff/seller` (repo root) | overview e2e green: happy, `400`, `401`, non-member `404`, per-section degrade, shop `503` |
| Contract schema | `pnpm exec vitest run` on the bff contract spec | example bodies parse |
| Foundations | `pnpm exec vitest run lib/seller lib/realtime lib/api/seller` | permissions, money input, problem copy, stream wrapper green |
| Shell | `pnpm exec vitest run components/dashboard components/seller/problem-states.test.tsx` | AS-84..AS-91, AS-98 |
| Overview and live | `pnpm exec vitest run components/seller/overview app/dashboard/seller` | AS-01..AS-27 unit rows |
| Inventory | `pnpm exec vitest run components/seller/inventory lib/seller/money-input.test.ts` | AS-28..AS-43, AS-94, AS-95 |
| Developers | `pnpm exec vitest run components/seller/developers` | AS-44..AS-73 |
| Team and orders | `pnpm exec vitest run components/seller/team components/seller/orders "app/invites"` | AS-74..AS-83 |
| Architecture | `pnpm exec vitest run lib/architecture.test.ts` | AS-92, AS-93: no `fetch`/`axios`/`EventSource` in components or hooks, keys from `lib/query-keys.ts`, no new Context/store, no `use cache` on per-user data, no credential storage, no `window.confirm`, no `dangerouslySetInnerHTML` |
| Static gates | `pnpm exec tsc --noEmit && pnpm lint && pnpm build` | no errors; no runtime-data-outside-Suspense error; the `react-hooks/immutability` error gone |
| Journeys | `pnpm exec playwright test tests/seller-shop.spec.ts` (then `seller-live`, `seller-inventory`, `seller-developers`, `seller-team`) | green on `desktop` and `mobile` |
| Layout and a11y | `pnpm exec playwright test tests/visual/seller-shell.spec.ts` (then `seller-overview`, `seller-inventory`, `seller-developers`, `seller-team`) | baselines match; axe 0 serious/critical at 390 and 1280 px |
| Final | whole web Vitest suite once, then the backend specs of touched domains once | green |

If the same test fails after five attempts, write the blocker, what was tried and the hypothesis into `questions.md` and stop on it.

## Manual smoke (after the journeys, optional)

Register, open a shop, add a product, search with a typo, create a test key, copy it, close, see only the prefix, add a webhook endpoint and send a test event, open the overview in a second tab and pay an order to see the live numbers move.

## Ops artifacts

Success criteria no automated test proves (also rows in `specs/UNVERIFIED.md`; never describe them as verified):

- **SC-001** (new member reaches a working overview in under 60 s of interaction): stopwatch run on a clean profile against the dev stack: register, open a shop, reach the overview; then close and reopen `/dashboard/seller` and count steps. `seller-shop.spec.ts` proves the flow completes and that the later visit is one redirect, not the time.
- **SC-002** (99 % of paid orders reach the live numbers within 2 s, and "Live" is never older than 5 s): script 100 sandbox payments with the Performance panel; compute event-to-render p99. `live-panel.test` proves the 5 s stale rule and `seller-live.spec.ts` one order within 2 s; the percentile is a measurement.
- **SC-003** (add a product and see it in under 90 s; find it again with one typo): stopwatch run; the journey proves the steps work, not the time.
- **SC-008** (a keyboard-only member can open a shop, add a product, create a key and add an endpoint): walk the four flows with the keyboard only and tick each; dialog and menu key behaviour is unit-tested (AS-94) and axe covers semantics, not the whole path.
- **SC-009** (frame immediately, page-shaped skeleton within 1 s, no content shift): record route changes in the Performance panel with network throttling; check Cumulative Layout Shift on the seller routes. Visual specs prove the skeleton layout, not the timing.

Proven by tests (so not listed above): SC-004 (AS-46, `secret-reveal-dialog.test`), SC-005 (AS-17), SC-006 (AS-89 table-driven over the error catalogue), SC-007 (axe in `tests/visual/seller-*`).
