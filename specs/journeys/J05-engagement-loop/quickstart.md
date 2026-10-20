# Quickstart: J05 — Engagement loop

## Prerequisites
Local stack up (`API_URL=http://localhost:8000`); after backend edits run `bash scripts/sdd/stack-fix.sh api-ready`. The journey owns the stack clock and consumer pauses while it runs: do not run other journeys in parallel.

## Run
- Narrow: `cd packages/backend && pnpm test:journeys -t "Journey J05: engagement loop US3"` (one user story at a time).
- Domain proofs: `scripts/sdd/test-spec.sh packages/backend/libs/domains/orders/checkout-attribution` and `.../marketing/affiliate-conversions`, `.../infrastructure/projections/consumer-groups`.
- Gates: `tsc --noEmit`, ESLint, `check:boundaries`, `check:table-ownership --strict`, `check:module-graph`, `check:model-registry`; `python3 scripts/livespec/check.py`.

## Expected
Each story passes in order US1 → US7; hop deadlines of `spec.md` hold; a paid referred order yields one `CONFIRMED` conversion, one `link.converted` in the tap, `conversions: 1` in stats; replays change nothing; `afterAll` leaves clock and consumers restored.

## Ops artifacts (no automated test proves them; rows in `specs/UNVERIFIED.md`, status "not run")
- **AS-34 / UI follow → feed**: pending a web owner. How to run once built: `pnpm --filter web exec playwright test tests/engagement-loop.spec.ts`.
- **SC-010** (clean stack to green under 12 minutes): run `scripts/qa/fresh-run.sh` then `pnpm test:journeys` and time it.
- **SC-001/SC-004/SC-006/SC-007/SC-008 percentile parts** (99 % of runs): repeat the journey 20 times on a fresh stack and count; one run proves only the exactness parts.
