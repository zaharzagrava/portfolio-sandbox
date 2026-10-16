# Implementation Plan: S04 Seller Onboarding / KYC (`seller-onboarding`)

**Branch**: `S04-kyc-onboarding` | **Date**: 2026-10-16 | **Spec**: [spec.md](spec.md)

**Input**: `spec.md`, `test-plan.md`, `gaps.md` (A1–A40, debt D-6/7/8/12/14), `questions.md` (defaults accepted), constitution, plus the follow-ups from S01, S03, S28 and S46 listed in `gaps.md`.

## Summary

The domain exists (15 files, 12 e2e tests) but violates the spec in 39 places: it writes and reads tenancy's `Shop`, verifies in a separate transaction, enqueues after commit, lets two workers claim one document, has no dead-letter path, validates loosely and has no rounds. The plan brings it to spec in eight ordered groups (A–H below): contracts and pure domain first, then migration and repository ports, then the boundary changes (no `Shop` access, outbox events on topic `shops.events`, verification in the approving transaction), documents, extraction, review, retention, and the e2e rewrite. Decisions are in [research.md](research.md), tables in [data-model.md](data-model.md), shapes in [contracts/](contracts/), validation in [quickstart.md](quickstart.md).

## Technical Context

**Language/Version**: TypeScript (strict), NestJS 10+, Node LTS; zod for contracts and drafts

**Primary Dependencies**: Sequelize (Postgres), ioredis (drafts), `@app/infrastructure/{outbox,jobs,inbox,llm,storage,rate-limit,platform,context}`, tenancy and identity public barrels

**Storage**: Postgres (`ShopOnboarding`, `ShopDocument`, `DocumentExtraction`, `ReviewTask`, new `OnboardingStatusHistory`), Redis hash for drafts, object storage for raw files, SQS (`onboarding-documents` + DLQ)

**Testing**: Jest e2e against the compose test stack through `scripts/sdd/test-spec.sh`; table-driven unit specs under `domain/`; `ScriptedLlmProvider`; Playwright journeys owned by web capabilities (not built here)

**Target Platform**: Linux server (API monolith) plus AWS Lambda (`document-extractor`, new `document-extractor-dlq`)

**Project Type**: backend domain module with a worker/Lambda entry

**Performance Goals**: verified within 5 min of the last upload at normal load; parked documents in review within 15 min; queue page ≤ 100 items with one R1 batch call

**Constraints**: no network call inside a transaction; 45 s model timeout, 5 min lease, ≤ 2 model calls per document; no sensitive value in logs, metrics, seller or reviewer responses

**Scale/Scope**: one application per shop, ≤ 15 live documents per round, review queue in the thousands of rows (keyset)

## Constitution Check

| Gate | Result |
|---|---|
| I layering (ports in `domain/`, adapters in `infra/`, thin controller) | Planned (group B, R-10); pays D-6 |
| II pipeline/routing placement | Guards via `ShopScoped`/`Firewall`; no inline auth |
| III data/transactions (conditional updates, history, `TransactionRunner`, no I/O in tx, keyset, `lock_timeout`) | Planned (R-02, R-03, R-05, R-11); the 3 direct `sequelize.transaction` sites are migrated and their audit comments deleted |
| IV messaging (outbox, no dual write, one producer per topic, DLQ) | Planned (R-01, R-04, R-06) |
| V contracts and errors (contract DTOs, problem+json, stable codes, no foreign internals) | Planned (R-13) |
| VII testing (scenario per AS, deep layer, `expectContract`, consumer pair) | `test-plan.md`; seven e2e files plus unit specs |
| VIII operational safety (limits, config validation, metrics, audit) | Planned (R-13, R-14, AS-69) |
| IX database isolation (no foreign table access, no cross-domain FK, `check:table-ownership --strict`) | Planned (A1–A3, A33); pays D-7, D-12 |
| X monorepo (barrel, boundaries, LLM port location) | Planned (A30, A32); pays D-8, D-14 |

**Violations**: none that need justification. **Resolved**: the topic stays `shops.events` (R-01), so tenancy keeps reading it; S28's constant is the sibling follow-up. Re-check after design: unchanged.

## Project Structure

### Documentation

```text
specs/domains/S04-kyc-onboarding/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/ (http.md, events.md, services.md)
├── spec.md  test-plan.md  gaps.md  questions.md
└── tasks.md          # /speckit-tasks (not created here)
```

### Source code

```text
packages/backend/libs/domains/seller-onboarding/
├── api/            onboarding.controller.ts, review.controller.ts   (thin; contract schemas)
├── application/    onboarding-session, onboarding-documents, extraction, review, verification-policy, retention services; events/onboarding-events.ts
├── domain/         ports.ts, application-status.ts, document-status.ts, status-machines.spec.ts, questionnaire.ts(+spec), extraction-rules.ts(+spec), file-type.ts(+spec), extraction-config.ts(+spec), extraction-schema.ts (strict), validators.ts(+spec), errors.ts
├── infra/          *.repository.ts (Sequelize adapters), draft.store.ts (Redis), onboarding.jobs.ts, shop-deleted.consumer.ts
├── onboarding.module.ts, index.ts
└── onboarding-{questionnaire,documents,extraction,review,verification,retention,boundaries}.e2e-spec.ts
packages/contracts/src/onboarding/      strict zod schemas
packages/backend/migrations/            S04 expand migration, S04 contract migration (drop FKs)
packages/backend/apps/lambdas/src/handlers/document-extractor.ts, document-extractor-dlq.ts
```

**Structure Decision**: keep the existing domain folder, split the controller into shop and admin controllers, move pure logic to `domain/`, add repository adapters under `infra/`. Seeds for tests go through `test/seeds`.

## Execution groups (input to /speckit-tasks; maps to gaps.md section D)

| Group | Content | Gaps | Proof |
|---|---|---|---|
| A | Contract schemas, error classes and codes, config schema, pure domain modules (rules, file type, status machines, questionnaire, validators incl. NL VAT and mod-97 property) | A13, A15, A16, A36, A38 | unit specs (AS-23, 28, 69–72) |
| B | Expand migration, repository ports and adapters, `TransactionRunner` everywhere, status history, barrel cleanup, module exports nothing | A18, A29, A31, A32, A34, A35 | questionnaire e2e smoke, tsc, boundaries |
| C | Stop reading and writing `Shop`; events on `shops.events` with `submissionNo`, `shop.rejected`, `shop.onboarding_document_rejected`; verification policy inside the approving transaction; `ShopQueryService`/`ShopAccessService` | A1–A4, A27 | verification e2e (AS-49–54), boundaries (AS-62, 63), `check:table-ownership --strict` |
| D | Questionnaire rounds and view, document rules (kinds, gates, caps, rounds, dedupe codes), confirm with size check, outbox command, supersede incl. `EXTRACTING` and task cancel, rate limits, contract migration dropping FKs | A5, A8, A17, A19–A21, A33, A39 | questionnaire and documents e2e |
| E | Extraction: lease claim, conditional finish, strict output, sealing context, timeouts, port switch to `@app/infrastructure/llm`, drop billing/ClickHouse/Kafka imports, dead-letter Lambda, missing-file path | A6, A7, A9–A12, A14, A30 | extraction e2e (AS-22–36) |
| F | Review: keyset page, strict resolve (reason, corrections, key fields, REJECT_APPLICATION), conflict of interest, sensitive routes, audit, seven metrics | A22–A26 | review e2e (AS-37–48), boundaries (AS-65–68) |
| G | Retention: purge per round (injected clock, per-file), rejection trigger, `shop_deleted` consumer, erase job | A28 | retention e2e (AS-58–61) |
| H | Replace `onboarding.e2e-spec.ts` by the seven files (scenarios preserved, L-017), remove `console.log`, seed via `test/seeds`; runtime proofs (API boot, Lambda standalone boot, queue defined, empty stack) | A37, A40 (web: out of scope) | whole suite once; quickstart runtime proofs |

Ordering constraints: A before everything; B before C–G; C before D–F (outbox/events/verification shared); the FK-dropping contract migration waits for D. L-001/L-002/L-020 apply to group D (queue and options); L-015/L-018 apply to E and H; L-017 to H.

## Complexity Tracking

No constitution violations to justify.
