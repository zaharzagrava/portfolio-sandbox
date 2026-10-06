# Specification Quality Checklist: S24 — Product chat

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — requirements and scenarios speak of "ephemeral store", "system of record", "live bus"; product names (Kafka key, outbox, CDC) appear only in *Cross-capability contracts* and *Assumptions*, where the task requires exact interface names
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders — user stories in plain language; scenarios are Given/When/Then with exact outcomes (HTTP codes are the product's API behaviour)
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (0; every default is under Assumptions and in `questions.md`)
- [x] Requirements are testable and unambiguous (58 acceptance scenarios; each FR cites its scenarios)
- [x] Success criteria are measurable (SC-001…SC-010)
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined (58 in spec = 58 rows in `test-plan.md`)
- [x] Edge cases are identified (concurrency AS-03/05/13/14/34/38/53/56; idempotent replay AS-10…13; illegal transitions AS-08/49/51/52; cross-tenant AS-07/24/27/33/35/39; limits AS-16/18/23/41; timeouts and outages AS-19/35/40/45/47; duplicate and out-of-order events AS-20/46)
- [x] Scope is clearly bounded (in/out of scope with owners named)
- [x] Dependencies and assumptions identified (Requires list with owning capability and exact shape; Assumptions)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (channels, send, sync, unread/receipts, presence, offline push, moderation, lifecycle)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification (see first item)

## Pattern-map coverage

- [x] P0318 table partitioning (chat, monthly) → FR-024, AS-28, AS-29
- [x] P0607 per-key ordering (chat) → FR-015, AS-20, AS-46

## Cross-capability checks

- [x] Contracts of S01, S03, S05, S23 honoured or differences recorded as `[CONTRACT]` (S01 `UserDirectoryService` not consumed)
- [x] Every BREAKING and CONTRACT decision is in `questions.md`, sorted BREAKING first
- [x] `gaps.md` lists the code gaps, the open debt rows (D-6, D-7, D-8, D-12) and the cross-domain access lines with their IX.7 replacement

## Notes

- Iteration 1: all items pass; no spec change needed after validation.
- `pnpm --dir packages/backend check:table-ownership` could not be executed in this unattended session (approval required); `gaps.md` section 3 is derived from reading the code and tells the implementation agent to run and reconcile it.
