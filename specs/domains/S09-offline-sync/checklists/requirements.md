# Specification Quality Checklist: S09 — Offline-First Inventory Sync (domain `catalog-sync`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). No engine, framework or library is named in `spec.md` (searched for Postgres, Sequelize, Nest, Kafka, Redis, SQL, zod, supertest, Playwright: none; the words "trigger" appear only in the Assumptions' description of today's code and in the IX.4 database-level-reference rule of AS-53). Route paths, exported service names, schema names, event and topic names and problem codes appear because the constitution's contract rules (V.2, X.4, IX.7) and the required "Cross-capability contracts" section demand exact names.
- [x] Focused on user value and business needs: seven stories (converging stock, per-field edits, pull, queue that never stalls, conflict review, access, lifecycle).
- [x] Written for non-technical stakeholders: scope and stories are plain language; scenarios and contracts are precise on purpose, like the sibling specs.
- [x] All mandatory sections completed (scenarios, requirements, success criteria, assumptions, plus the required contracts section).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (search: 0). Defaults are in Assumptions and `questions.md`.
- [x] Requirements are testable and unambiguous: 40 functional requirements, each cites the scenarios that prove it (checked: 40 of 40 name an AS after one fix round: FR-035 and FR-039 gained references).
- [x] Success criteria are measurable (SC-001–SC-008 carry counts, percentages, seconds, request rates).
- [x] Success criteria are technology-agnostic.
- [x] All acceptance scenarios are defined: 55 scenarios (AS-01–AS-55, sequential), each with exact outcomes; `test-plan.md` has 55 matching rows.
- [x] Edge cases are identified: concurrency (AS-03, AS-08, AS-18, AS-26, AS-40), idempotent replay (AS-02–AS-05, AS-34), illegal transitions (AS-40 dismiss twice, AS-46 shop status), cross-tenant (AS-05, AS-11, AS-44, AS-45), limits (AS-35, AS-36, AS-10), timeouts and failures (AS-13, AS-14, AS-37, AS-38), out-of-order and duplicate events (AS-27, AS-28), clocks (AS-17, AS-19–AS-21, AS-23), resync (AS-32, AS-55); the Edge Cases list adds the rest.
- [x] Scope is clearly bounded: in/out lists name S05, S07, S08, S03, S49, S50, S53, S54, W04 and the device app as owners of what is excluded; cross-domain data appears only as R1 calls to S05, R3 consumption of S05 and S03 events, and the guard from S03.
- [x] Dependencies and assumptions identified: the Requires list, the Assumptions section and `questions.md` (17 BREAKING, 14 CONTRACT, 14 LOCAL lines).

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria.
- [x] User scenarios cover primary flows (push, pull, conflicts) and the secondary ones (access, lifecycle).
- [x] Feature meets measurable outcomes defined in Success Criteria (SC-001 → AS-02/AS-03, SC-002 → AS-54, SC-003 → load test outside e2e, SC-004 → AS-08/AS-09, SC-005 → AS-33, SC-006 → AS-26, SC-007 → AS-44, SC-008 → AS-32).
- [x] No implementation details leak into specification.

## Notes

- **Cross-capability contracts honoured**: S05 (stock only through `applyStockDelta`, products only through its commands, no own product events, clocks stay here), S08 (every stock writer uses `applyStockDelta`; J04 hand-off), S07 (shared topic `catalog-sync.events`), S03 (purge on `tenancy.shop_deleted`). One deliberate difference, recorded as a `[CONTRACT]` line: S05 lists `upsertFromExternal(…, 'offline')` for S09; this spec uses `ProductCommandService.update` instead.
- **Not run**: `pnpm --dir packages/backend check:table-ownership` needs approval an unattended session cannot get; `gaps.md` section C is reconstructed from code searches. Source note: `~/workspace/notes/Interview-Prep` is outside the session's allowed directories, so the notes were read from their copies under `.specify/memory/Interview-Prep/` and `docs/showcase/sections/SD-06-offline-inventory-sync.md`.
- **UI journey**: none by design (device app is phase 2; the conflict screen belongs to W04); the test plan's UI column is `—` for all rows.
- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`: none.
