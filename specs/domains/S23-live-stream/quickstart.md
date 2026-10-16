# Quickstart: validating S23

Run backend commands from `packages/backend`. E2E specs go through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern> [jest args]`; pure unit specs with `node --experimental-vm-modules node_modules/jest/bin/jest.js <path>`.

1. Static: `tsc --noEmit`, lint, `pnpm check:boundaries`, `pnpm check:table-ownership --strict` (no line for `launch-events`, AS-54), `pnpm check:module-graph`, `pnpm check:model-registry`; from the repo root `python3 scripts/livespec/check.py`.
2. Pure unit specs: `libs/domains/launch-events/domain` (`reservoir`, `moderation`, `comment-text`, `live-state`, `window-composer`, `author-handle`) and the contracts `live-reducer.spec.ts` (ts-jest ESM config kept outside the repo).
3. E2E narrowest first (`-t "AS-34"`), one file at a time: `live-{streams,comments,reactions,delivery,history,operations}.e2e-spec.ts`; the whole capability once at the end.
4. Boot check (done by the final checkpoint, not by a task): core, worker, projector and sse-gateway each start on their own (L-015, L-018).

Expected: all 54 scenarios of [test-plan.md](test-plan.md) pass; concurrency scenarios (AS-07, AS-22, AS-24, AS-27, AS-34, AS-38, AS-39) repeat 20 times; no fixed sleep remains in any live spec.

## Ops artifacts

Criteria no automated test proves (also rows in `specs/UNVERIFIED.md`, status "not run"):

- **SC-003**: a posted comment reaches 99% of connected viewers' batches within 1 s at 5,000 comments/s. Run `pnpm --dir packages/backend loadtest:live-stream` (`packages/backend/scripts/load-tests/live-stream.test.js`: 5,000 SSE connections plus a comment flood; needs `STREAM_ID` of a running stream and a `TOKENS_FILE` of access tokens). Status: not run. E2E proves the window cadence and ordering, not fleet-scale lag.
- **SC-014**: one gateway instance carries 50,000 concurrent viewers per stream with one upstream subscription. Same k6 script with the connection count raised on a deployed gateway; e2e proves the cap and the single subscription with a small configured cap.

Capacity note (not a criterion): history writes share one DynamoDB partition per stream-minute (`STREAM#<id>#<minute>`); watch throttling in the k6 run.

## Result of the capability suite (T072)

Run from `packages/backend`, one file at a time through `test-spec.sh`, then the unit specs and the static gates. All green:

| Suite | Tests |
|---|---|
| `live-streams.e2e-spec.ts` (AS-33…AS-42) | 42 |
| `live-comments.e2e-spec.ts` (AS-15…AS-25) | 43 |
| `live-reactions.e2e-spec.ts` (AS-14, AS-26…AS-32) | 21 |
| `live-delivery.e2e-spec.ts` (AS-01…AS-08, AS-10…AS-13) | 17 |
| `live-history.e2e-spec.ts` (AS-43…AS-48) | 22 |
| `live-operations.e2e-spec.ts` (AS-49…AS-54) | 18 |
| unit specs in `libs/domains/launch-events/domain` | 157 (13 files, the S22 ones included) |
| `packages/contracts/src/live/live-reducer.spec.ts` (AS-09) | 8 |

Static: `tsc --noEmit`, ESLint on the touched folders, `check:boundaries`, `check:table-ownership --strict` (0 findings), `check:module-graph`, `check:model-registry`, `check:no-wallclock`, `check:no-request-scope`, `check:technical-tables`, `python3 scripts/livespec/check.py` (0 errors). The existing wiring specs that start the real `SseGatewayModule`, `ProjectorModule`, worker and core (`chat-wiring.e2e-spec.ts` in each app, `statements-wiring` in the projector) pass with the live modules mounted; the standalone boots, the fresh-stack run and the journeys are the final checkpoint's, not claimed here.

The contracts spec runs outside the repository's jest config (ESM `.ts` imports): `node --experimental-vm-modules node_modules/jest/bin/jest.js --config <a config with roots packages/contracts/src/live, ts-jest isolatedModules and a moduleNameMapper that strips ".ts">`.
