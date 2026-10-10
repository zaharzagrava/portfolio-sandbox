# Quickstart: validating S51

Run from `packages/backend`. Prerequisite: test Redis and Postgres of `docker-compose.test.yaml` up.

## Automated

Narrowest first, whole suite once at the end:

```bash
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/realtime/topics.spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/realtime/realtime-publisher.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/realtime/realtime-revocation.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/tenancy/member-revocation.e2e-spec.ts   # S03 follow-up
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/infrastructure/realtime                          # whole capability, once
pnpm --dir packages/backend check:boundaries
pnpm --dir packages/backend check:table-ownership --strict   # expect 0 lines for infrastructure/realtime, redis-pubsub
```

Scenario → file mapping: `test-plan.md` (12 e2e files, 5 unit files, AS-01…AS-70). The S03 follow-up (open `shop:<id>:*` streams close on `tenancy.member_removed`) is proven by `member-revocation.e2e-spec.ts` (member removed through the real API → `revoked` frames within 2 s, no later events, other members unaffected, rule still decides re-admission).

Manual smoke: `curl -N -H "Authorization: Bearer <t>" "http://localhost:3000/api/streams?topics=auction:a1"` shows `retry:`, a baseline `id:` and `: ping` heartbeats.

## Ops artifacts (not proven by an automated test; status "not run")

- **SC-001** — 50,000 idle connections, 5,000 events/s; at 5,000 connections × 10 events/s p99 ≤ 500 ms, no loss for healthy viewers: `pnpm loadtest:sse` (k6 + xk6-sse), record p99 and drops.
- **SC-002 (100 repetitions)** — AS-14 proves one reconnect; the 100-repetition rate and the "beyond window → resync 100%" rate run as a loop of the REPLAY scenario against a deployed instance.
- **SC-005 (10,000 cycles)** — AS-42 runs 500 cycles; the memory-returns-to-baseline claim over 10,000 connect/close cycles runs as a k6 cycle case plus heap snapshot comparison.
- **SC-007** — reconnect storm: restart every instance at 5,000 connections each, all viewers reconnected ≤ 10 s, no instance over its limit beyond the drain window (k6 reconnect-storm case to add to `scripts/load-tests/sse.test.js`).
- **SC-008** — publisher latency with the hub down ≤ 1 s extra: AS-32 proves the 1 s single attempt; the p99 under real load is an ops measurement.
