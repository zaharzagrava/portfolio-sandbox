# Quickstart: validating S04

Run from `packages/backend`. Test stack per `docker-compose.test.yaml` (Postgres, Redis, object storage fake, ElasticMQ). Run `pnpm run db:jest:migrate:up` after pulling the S04 migrations. Shapes: [contracts/](contracts/); tables: [data-model.md](data-model.md); decisions: [research.md](research.md). `SO` = `libs/domains/seller-onboarding`.

## Fast loop

```bash
# pure units (no DB)
pnpm jest libs/domains/seller-onboarding/domain
# one e2e file at a time (condensed output, full log path printed)
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/seller-onboarding/onboarding-questionnaire.e2e-spec.ts
# the whole capability once at the end
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/seller-onboarding
# static gates
pnpm tsc --noEmit -p . && pnpm lint && pnpm check:boundaries && pnpm check:table-ownership --strict && pnpm check:model-registry
```

## Scenario map

| Scenarios | File | Expected |
|---|---|---|
| AS-01–09, 56, 57 | `SO/onboarding-questionnaire.e2e-spec.ts` | draft key and TTL, validation classes, submit rows and one outbox event, concurrency ×5, 401/404/403 matrix, rounds |
| AS-10–21 | `SO/onboarding-documents.e2e-spec.ts` | grants, dedupe race, outbox command, supersede and cancel, caps, rate limits |
| AS-22, 24–27, 29–33, 35, 36 | `SO/onboarding-extraction.e2e-spec.ts` | scripted model, escalation, hostile output table, lease and redelivery, routing to review |
| AS-32 (dead letter), 34, 62 (Lambda boots alone) | `apps/lambdas/src/handlers/document-extractor.e2e-spec.ts` | Lambda batch items, DLQ handler, the Lambda's own app without ClickHouse or billing |
| AS-60 (registration) | `apps/projector/src/onboarding-wiring.e2e-spec.ts` | the `shop_deleted` consumer registers in the projector framework |
| AS-23, 28, 69–72 | `SO/domain/*.spec.ts` | rules, file type, config, status machines, validators, questionnaire |
| AS-37–48 | `SO/onboarding-review.e2e-spec.ts` | keyset paging over 120 tasks, resolve matrix, one winner, conflict of interest, audit |
| AS-49–55 | `SO/onboarding-verification.e2e-spec.ts` | verification in the approving transaction, race, trigger-failed outbox, event contracts, seller view |
| AS-58–61 | `SO/onboarding-retention.e2e-spec.ts` | purge, erase, `shop_deleted` consumer, frozen clock |
| AS-62–68 | `SO/onboarding-boundaries.e2e-spec.ts` | FK catalog probe, one R1 call, no open tx, problem+json table, metrics, logs, contract parse |

## Runtime proofs (L-004, L-015, L-018, L-019)

1. Start the real API (`pnpm start:dev` or the repo's boot script) and confirm it boots with the new `OnboardingModule` imports and the outbox/jobs hooks.
2. Boot the Lambda bundle `document-extractor` and `document-extractor-dlq` on their own (module compile with only `OnboardingExtractionModule`; no ClickHouse, Kafka producer or billing imports).
3. Confirm `onboarding-documents` and its DLQ exist in `elasticmq.conf` and readiness fails when missing (L-002); reload the queue server (L-020).
4. Run the capability suite once on an empty stack (`scripts/qa/fresh-run.sh`, L-006, L-012).

## Ops artifacts (criteria no automated test proves)

| Criterion | How to run it | Status |
|---|---|---|
| SC-002 at full size (100 rounds × 10 simultaneous submits) | loop `onboarding-questionnaire.e2e-spec.ts` AS-06 scenario 100× against a warm stack; the suite itself runs 20 repetitions | not run |
| SC-006 platform told within 60 s of the last approval | run the relay on a real stack, approve the last document, measure the `shop.verified` event arrival at tenancy | not run |
| SC-007 verified within 5 min / parked documents in review within 15 min | staging run with the real queue and provider budget | not run |
| SC-008 reviewer resolves in at most 3 interactions | moderator console journey (`packages/web/tests/seller-onboarding.spec.ts`, screens not built yet) | not run |
