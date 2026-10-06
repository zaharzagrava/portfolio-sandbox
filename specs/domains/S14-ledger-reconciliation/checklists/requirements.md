# Specification Quality Checklist: S14 — Double-Entry Ledger, Balanced Journals, Hot-Account Sharding, Balance Read Model, Daily PSP Reconciliation (domain `payments`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). `spec.md` names no database, cache, broker, framework, ORM or test library (searched for Postgres, Redis, Kafka, Sequelize, Nest, supertest, zod, Dynamo, SQS, Playwright: 0 matches; the one engine-specific error code was removed). Route paths, exported service and method names, schema, event, topic, job, policy and metric names, and problem codes appear because the constitution's contract rules (V.2, X.4, IX.7) and the required "Cross-capability contracts" section demand exact names.
- [x] Focused on user value and business needs: eight stories (balanced immutable journals, sale/refund/settlement, hot accounts, balances, daily reconciliation, operators, housekeeping and migration, safety and boundaries).
- [x] Written for non-technical stakeholders: scope and story narratives are plain language; scenarios and contracts are precise on purpose, like sibling specs S10, S11 and S13.
- [x] All mandatory sections completed (scenarios, requirements, entities, success criteria, assumptions, plus the required contracts section).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (search: 0). Every default is recorded in Assumptions and in `questions.md`, tagged BREAKING (17), CONTRACT (13) and LOCAL (18).
- [x] Requirements are testable and unambiguous: 50 functional requirements, each cited by at least one scenario with exact inputs and outputs.
- [x] Success criteria are measurable (SC-001–SC-011: counts, percentages, seconds, sizes).
- [x] Success criteria are technology-agnostic (they speak of postings, balances, statements, days, issues).
- [x] All acceptance scenarios are defined: 69 (AS-01–AS-69); the test plan has 69 rows, one per scenario (verified by count).
- [x] Edge cases are identified: concurrency (AS-08, AS-10, AS-21, AS-22, AS-24, AS-25, AS-42, AS-58), idempotent replay (AS-07, AS-12, AS-16, AS-18, AS-41, AS-57), illegal state transitions (AS-50, AS-56), cross-tenant access (AS-34, AS-52), limits (AS-04, AS-28, AS-29, AS-55, AS-59), timeouts (AS-26, AS-45, AS-69), out-of-order and duplicate events (AS-18–AS-21, AS-30, AS-31).
- [x] Scope is clearly bounded: out-of-scope list names the owning capability (S13, S15, S16, S36, S17, S10, S03, S01, S49, S50, S53, S54, W04, J01).
- [x] Dependencies and assumptions identified: "Cross-capability contracts" (Provides and Requires with owners and exact shapes) and "Assumptions".

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (each FR names its AS-IDs).
- [x] User scenarios cover primary flows: post, capture, refund, settle, shard, read balance, reconcile, resolve, maintain, migrate.
- [x] Feature meets measurable outcomes defined in Success Criteria.
- [x] No implementation details leak into specification.

## Pattern-map coverage (rows whose Specs column contains S14)

- [x] P0102 async iteration over paged sources → FR-029, AS-44, AS-46
- [x] P0313 sorted lock order → FR-020, AS-25
- [x] P0315 expand/contract + batched backfill → FR-045, AS-64
- [x] P0318 table partitioning → FR-042, AS-60, AS-61
- [x] P0614 reconciliation and period close → FR-028–FR-037, AS-38–AS-50, AS-54
- [x] Hot-account sharding, balance read model, invariant checker (SD-20 / 10/02 Ex1 / 03/02 §8) → FR-018–FR-026, FR-043, AS-22–AS-37, AS-62

## Cross-capability contracts honoured

- [x] S13: `recordPaymentCaptured` / `recordPaymentRefunded` kept, additive fields flagged as `[CONTRACT]` in `questions.md`.
- [x] S10: `order.paid` fields `totalMinor`, `shopOrders[].subtotalMinor` used as written in S10's spec.
- [x] S01: S14 drops the user-existence read the S01 spec assigned to ledger (no user data needed); S03: `ShopScoped('payouts.read')` and the `404` rule for non-members; S03's provider-account-id move is assigned to S15.
- [x] S15, S36, S16, S28 consumers of this capability's exports are named under "Provides".

## Notes

- Iteration 1: all items pass; no spec update needed after validation.
- `check:table-ownership` was run and its `payments` lines are in `gaps.md` section C.
- Items for human review first: the BREAKING lines of `questions.md` (sharding despite SD-20 "not needed", running balances, event v2, buyer account removal, fee rule, refund journal, reconciliation redefinition) and the CONTRACT lines for S13, S10, S15 and S36.
