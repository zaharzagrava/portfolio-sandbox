# Quickstart: validating S24 — Product chat

Run from `packages/backend` unless noted. Spec runner: `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern> [jest args]` (condensed result plus the full-log path; open the log only when that is not enough). Narrowest file first; the whole capability once at the end, in batches of fresh processes (L-008: a batch without its summary line is a crash, not a flaky test).

## Prerequisites

- Test stack up: Postgres with the real migrations (including the S24 expand and contract migrations, partitions for the current month + 3, `ChatMessageIndex`), Redis, Kafka and ElasticMQ stand-ins from `docker-compose.test.yaml`. Compare tables, keyspaces and queues with the doctor (L-011, L-002): queue `chat-offline-notify` and its DLQ in `elasticmq.conf`.
- The e2e kit freezes and advances the injected clock; faults use switchable wrappers at the system edge (limiter, live bus, hub transport, presence store, coalescing store, outbox appender).

## Scenario runs (each file is one `describe`, see [`test-plan.md`](test-plan.md))

| Step | Command | Expected |
|---|---|---|
| 1 pure rules | `pnpm run test libs/domains/chat/domain` | six specs green (`message-body`, `read-position` with `fast-check`, `moderation-rules`, `escalation-decision`, `history-cursor`, `partition-months`) |
| 2 channels | `test-spec.sh libs/domains/chat/chat-channels.e2e-spec.ts` | AS-01…AS-08 |
| 3 messages | `test-spec.sh libs/domains/chat/chat-messages.e2e-spec.ts` | AS-09…AS-20 (AS-13, AS-14 repeat 20×) |
| 4 sync and partitions | `test-spec.sh libs/domains/chat/chat-sync.e2e-spec.ts` | AS-21…AS-29 |
| 5 read state | `test-spec.sh libs/domains/chat/chat-read-state.e2e-spec.ts` | AS-30…AS-36 |
| 6 presence | `test-spec.sh libs/domains/chat/chat-presence.e2e-spec.ts` | AS-37…AS-41 |
| 7 offline push | `test-spec.sh libs/domains/chat/chat-offline-push.e2e-spec.ts` | AS-42…AS-48 |
| 8 moderation | `test-spec.sh libs/domains/chat/chat-moderation.e2e-spec.ts` | AS-49…AS-55 |
| 9 lifecycle | `test-spec.sh libs/domains/chat/chat-lifecycle.e2e-spec.ts` | AS-56…AS-58 |
| 10 BFF regression | `test-spec.sh libs/composition/bff/bff.e2e-spec.ts` | green; `UPSTREAM_INVALID` absent for the chat section |
| 11 notifications regression | `test-spec.sh libs/domains/notifications/` | green (consumer of `chat.message_escalated` unchanged) |
| 12 catalog regression (mirror removal) | `test-spec.sh libs/domains/catalog/` in batches | green after the `sellerId` mirror is dropped |
| 13 static gates | `pnpm tsc --noEmit -p .`, `pnpm lint`, `pnpm check:boundaries`, `pnpm check:table-ownership --strict`, `pnpm check:module-graph`, `pnpm check:model-registry` (repo root `package.json` scripts where applicable) | clean; chat lines 0 (was 7 identity + 2 product/outbox), `.ownership.baseline` and `.tx.baseline` do not rise |
| 14 leftovers | `grep -rn redis-pubsub packages/backend`; `grep -rn "sequelize.transaction" packages/backend/libs/domains/chat` | both empty |
| 15 living spec | `python3 scripts/livespec/check.py` (repo root) | passes with the new `S24` page |
| 16 contracts | `pnpm run test libs/domains/chat/chat-contracts.spec.ts` | every sample body parses; error codes enum complete |

## Start the real apps (L-004, L-015, L-018, L-019)

`apps/core`, `apps/worker`, `apps/projector` and `apps/sse-gateway` are each started alone by the wiring specs `apps/<app>/src/chat-wiring.e2e-spec.ts` (run with `test-spec.sh apps/core/src/chat-wiring apps/worker/src/chat-wiring apps/projector/src/chat-wiring apps/sse-gateway/src/chat-wiring`; green on 2026-10-14, 6 tests): core maps all sixteen chat routes (a mapped route answers `401` problem+json, an unmapped one `404`); worker declares and schedules the two `chat.*` jobs and carries the `chat-offline-notify` consumer; projector registers the groups `chat-offline-scheduler` and `chat-shop-purge`; sse-gateway knows the `chat:` topic and refuses a stranger and a malformed channel id. These are automated, so there is no row for them in `specs/UNVERIFIED.md`.

## Ops artifacts (criteria no automated test proves)

| Criterion | How to run it | Status |
|---|---|---|
| SC-001 at 1,000 repeated runs of 20 senders (tests repeat 20×) | extend the loop count of AS-14 or run `scripts/load-tests/chat-sync.test.js --scenario send-storm` | not run |
| SC-003 at 1,000 replays (tests: 20 sequential + 20 concurrent) | same loop with `REPEAT=1000` on AS-10/AS-13 | not run |
| SC-004: 50,000 catch-up requests per second, p99 < 100 ms | `pnpm loadtest:chat-sync` (k6, jittered reconnects) | not run |
| SC-009: 25,000 messages per second across all channels | same harness, `--scenario ingest`; watch the `ChatMessageIndex` write amplification (research R-02) | not run |
| SC-005/SC-006 wall-clock timing (tests use the frozen clock; 30 s and 60 s are not slept) | manual: send, wait, observe one push within 60 s; stop heartbeats, observe offline within 60 s | not run |
| Fresh-stack drill (L-012) | `scripts/qa/fresh-run.sh`, then steps 2–9 | not run |
| Migration on a large legacy table (swap lock duration, backfill batch time) | run the expand + backfill + contract on a copy with ≥ 10M `ChatMessage` rows; the swap transaction must hold the lock < 3 s | not run |
| Drop of `ChatMessage_old` (2026-12-15) | the `chat-s24-drop-old` migration after one release without error | not run |

## Implementation notes

- T003 (2026-10-14): `chat-offline-notify` and `chat-offline-notify-dlq` are defined in `infra/docker/elasticmq.conf` (lines 41-42); `infra/stack/main.tf:32` defines the queue too. New tables/partitions are created only by the real migrations (no hand-made test DDL).
