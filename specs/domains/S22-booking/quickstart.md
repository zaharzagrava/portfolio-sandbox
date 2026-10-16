# Quickstart: validating S22

Run backend commands from `packages/backend`. E2E specs go through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern> [jest args]`.

1. Static: `tsc --noEmit`, lint, `pnpm check:boundaries`, `pnpm check:table-ownership --strict`, `pnpm check:module-graph`, `pnpm check:model-registry`; from the repo root `python3 scripts/livespec/check.py`.
2. Pure unit specs: `test-spec.sh libs/domains/launch-events/domain` and the contracts `seat-map-reducer.spec.ts`.
3. E2E narrowest first (`-t "AS-16"`), one file at a time: `launch-events-{queue,holds,confirm,seatmap,organizer,operations}.e2e-spec.ts`; then the whole capability once at the end.
4. After each e2e run, the duplicate-confirmed-seat query returns 0 rows (SC-001).

Expected: all 62 scenarios of [test-plan.md](test-plan.md) pass; concurrency scenarios repeat 20 times.

## Ops artifacts

Criteria no automated test proves (also rows in `specs/UNVERIFIED.md`, status "not run"):

- **SC-004**: a spike of 20,000 concurrent buyers (join p99 < 100 ms, hold p99 < 150 ms, seat map p99 < 50 ms, no relational queue, hold or seat-map traffic). Run `pnpm loadtest:launch-event` (`scripts/load-tests/launch-event.test.js`, updated per G-44).
- **SC-009**: displayed wait within a factor of 1.5 of the actual wait for 90% of buyers. Steady-rate k6 run comparing `etaSeconds` with the real admission time. E2E proves only the ±16 position bound and the ETA formula.
