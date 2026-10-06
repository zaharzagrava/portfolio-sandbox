# Specification Quality Checklist: S13 — Payment Intents, Idempotency, Unknown Outcomes, PSP Circuit Breaker, Outbox, Saga with Orders (domain `payments`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). `spec.md` names no database, cache, broker, framework, ORM or test library (searched for Postgres, Redis, Kafka, Sequelize, Nest, supertest, zod, Playwright, DynamoDB, SQS, opossum: 0 matches). Route paths, exported service names, schema names, event, topic, job and metric names, problem codes and policy names appear because the constitution's contract rules (V.2, X.4, IX.7) and the required "Cross-capability contracts" section demand exact names.
- [x] Focused on user value and business needs: eight stories (pay once, outcomes, unknown outcomes, provider outage, competing paths, saga with orders, buyer reads, operability and boundaries).
- [x] Written for non-technical stakeholders: scope and story narratives are plain language; scenarios and contracts are precise on purpose, like the sibling specs S10 and S11.
- [x] All mandatory sections completed (scenarios, requirements, entities, success criteria, assumptions, plus the required contracts section).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (search: 0). Every default is recorded in Assumptions and in `questions.md` (13 BREAKING, 15 CONTRACT, 13 LOCAL lines).
- [x] Requirements are testable and unambiguous: 46 functional requirements, each cites the scenarios that prove it; scenarios give exact statuses, codes, counts and boundaries (66 scenarios, AS-01 to AS-66).
- [x] Success criteria are measurable (counts, percentages, times, repeated runs).
- [x] Success criteria are technology-agnostic (no tool, store or framework named; the provider is called "the provider").
- [x] All acceptance scenarios are defined: 66 Given/When/Then scenarios, mapped one-to-one to the 66 rows of `test-plan.md`.
- [x] Edge cases are identified: concurrency (AS-05, AS-06, AS-40, AS-43, AS-51, AS-56), idempotent replay (AS-03–AS-09), illegal transitions (AS-39, AS-41, AS-52), cross-tenant access (AS-10, AS-57–AS-59), limits (AS-13, AS-14, AS-58, AS-60), timeouts (AS-23–AS-30, AS-36), duplicate and out-of-order events (AS-20, AS-44, AS-49, AS-51, AS-52), forged provider answers (AS-22).
- [x] Scope is clearly bounded: in-scope and out-of-scope lists name owners (S10, S14, S15, S16, S49–S54, S01, W03, S48); cross-domain data uses only IX.7 R1 (status service), R2 (screen composition) and R3 (order copy).
- [x] Dependencies and assumptions identified: "Cross-capability contracts" lists what S13 provides and requires with exact shapes; the one difference from S10's spec (no `getPayableOrder`) is recorded as a CONTRACT question.

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (each FR names its AS ids).
- [x] User scenarios cover primary flows: accept, charge, unknown, outage, race, saga (compensation both ways), reads.
- [x] Feature meets measurable outcomes defined in Success Criteria (SC-001 to SC-010 trace to AS-05/06, AS-37, AS-31–AS-33, AS-23–AS-29, AS-40, AS-50–AS-52, AS-10/57–59, AS-45, AS-15/61, AS-62–AS-64).
- [x] No implementation details leak into specification (see first item).

## Pattern coverage (pattern-map rows naming S13)

- [x] P0311 lost-update prevention (OCC) → AS-39–AS-43.
- [x] P0407 async request-reply (202 + status / push) → AS-01, AS-15, AS-21, AS-61.
- [x] P0414 idempotency keys (replay, in-flight 409, different body 422, TTL) → AS-03–AS-09; provider reference = order ID → AS-15.
- [x] P0611 sagas with compensations → AS-44–AS-56.
- [x] P0617 circuit breakers (per dependency / per endpoint) → AS-31–AS-38.
- [x] Outbox (capability title) → AS-01, AS-45, AS-46.

## Notes

- Validation iteration 1: all items pass. Two wording fixes were made during validation (a stray setting name in AS-65; "zod" replaced by "schema validation" in the contracts section).
- Not done in this session: `pnpm --dir packages/backend check:table-ownership` could not be run (approval unavailable); `gaps.md` section C is a static reading and must be diffed against the real output first.
- Ready for `/speckit-clarify` (optional) or `/speckit-plan`.
