# Quickstart: validating S43 — Webhook delivery to shops

Run backend commands from `packages/backend`. Scenario ids are those of `spec.md`; contracts are in `contracts/`, tables in `data-model.md`.

## Prerequisites

- Test stack up (`docker-compose.test.yaml`: Postgres, Redis, DynamoDB local, ElasticMQ/SQS stand-in, event bus) with migrations applied. The FIFO queue `webhook-deliveries.fifo` and its DLQ are defined in `elasticmq.conf` (L-002); after adding a queue reload the queue server with the repo's reload command (L-020).
- The doctor lists every table, keyspace and bucket the code needs (L-011): `WebhookEndpoint`, `WebhookEndpointHistory`, `WebhookShopCounter`, `WebhookAttempts`.

## Run the scenarios (narrowest first)

1. Unit (pure logic): `/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/developer-platform/domain/ --testPathPattern 'signature|webhook-url|endpoint-status|retry-schedule|breaker|stock-low|webhook-event-mapper|webhook-settings'` (AS-17, AS-19, AS-28, AS-41, AS-48, AS-71, mapper tables).
2. Endpoint API: `…/test-spec.sh webhook-endpoints` then `webhooks.e2e-spec` (AS-01–AS-22).
3. Routing: `…/test-spec.sh webhook-routing` (AS-23–AS-34, AS-66).
4. Delivery and guard: `…/test-spec.sh webhook-delivery`, `webhook-ssrf` (AS-35–AS-54).
5. Lifecycle, log, replay, contract: `webhook-lifecycle`, `webhook-replay-log`, `webhook-contract` (AS-55–AS-69, AS-67).
6. Whole capability once, in batches of fresh processes (L-008; a batch without its summary line is a crash): `…/test-spec.sh webhook-`.
7. Static gates (AS-70): `pnpm tsc --noEmit`, ESLint, `pnpm check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict`, `pnpm check:module-graph`, `pnpm check:model-registry`; `python3 scripts/livespec/check.py` for the S43 page.

Expected: every e2e passes; no `ShopMembership`, `ShopOrder`, `Product`, `Shop` or `notifications` reference in webhook files; direct `sequelize.transaction` count in the domain does not rise.

## Start the real applications (L-004, L-015, L-018)

`scripts/infra/boot-app.sh core`, `… worker`, `… projector`, and the Lambda host (`WebhooksLambdaModule` booted as `apps/lambdas` does); each must start on its own and the consumers must appear in the readiness output. Then the empty-stack run: `scripts/qa/fresh-run.sh` (L-012).

Run 2026-10-15: `scripts/infra/reload-queues.sh` OK (queue server reloaded, so `maxReceiveCount = 5` is live); `boot-app.sh core` UP (webhook routes mapped); `boot-app.sh worker` UP (jobs `webhooks.disable-failing-endpoints`, `webhooks.purge-history`, `webhooks.retry` registered; `webhook-delivery-consumer` present); `boot-app.sh projector` UP (`webhook-*` consumers started). Not run: the Lambda host boot (no script) and `scripts/qa/fresh-run.sh`.

## Manual smoke (after boot)

Create an endpoint with a local receiver, `POST …/ping`, read `…/attempts`, `…/rotate-secret`, verify a delivery with the reference verifier from `contracts/outbound.md`.

## Ops artifacts

Criteria no automated test proves; each is also a row in `specs/UNVERIFIED.md` with status `not run`. Never describe them as verified.

- **SC-001**: 95 % of events reach a healthy endpoint within 5 s. Run: k6 `scripts/load-tests/webhooks-flood.test.js` (new) at steady load, read `webhook_routing_lag_seconds` plus receiver timestamps. (AS-35 proves a single delivery only.)
- **SC-002 at scale**: p99 < 2 s for healthy endpoints while 10 % hang. Same k6 script with slow receivers. (AS-37 proves 20 events on two endpoints.)
- **SC-011**: 5,000 deliveries/s across 500,000 endpoints. Same script, production-sized stack.
- **SC-007 timing in real time**: sweep disables within 15 minutes of the threshold on a real scheduler. Run: set `failingSince` to now − 3 d on a test endpoint in a staging stack, wait for the cron. (Tests prove the rule with a frozen clock and a direct sweep call.)
- **SC-008**: 3-day retry coverage and 30-day replayability in real time. Run: staging receiver that fails for 3 days, then replay at day 29. (Tests prove the schedule with an advanced clock.)
- **Application start and empty-stack run** (L-004, L-015, L-018, L-012): commands above. **Status 2026-10-15: not run.** In the unattended session `scripts/infra/boot-app.sh core|worker|projector`, `scripts/infra/reload-queues.sh` and `scripts/qa/fresh-run.sh --here` were each refused ("requires approval"); the Lambda host has no boot script. Run them where they are allowed. What did run: `apps/worker/src/webhooks-wiring.e2e-spec.ts`, `apps/projector/src/webhooks-wiring.e2e-spec.ts` and `libs/domains/developer-platform/webhooks-wiring.e2e-spec.ts` (real module wiring in jest, 9 tests green) and `apps/lambdas/src/handlers/webhook-delivery.spec.ts`; they do not replace the boots. The running queue server may still carry `maxReceiveCount = 8` for `webhook-deliveries.fifo` until `reload-queues.sh` is run (T003).
- **Load script** (SC-001, SC-002 at scale, SC-011): `packages/backend/scripts/load-tests/webhooks-flood.test.js` (`pnpm --dir packages/backend loadtest:webhooks`; k6 flood of product updates to a seeded fleet of 500,000 endpoints, 10 % slow receivers; the header lists the receiver and the seeding). Written, never run.
