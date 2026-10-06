# Specification Quality Checklist: S06 — Collaborative listing drafts

**Purpose**: Validate specification completeness and quality before proceeding to planning

**Created**: 2026-10-05

**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — the body names behaviour only; wire names (routes, close codes, schema names, y-websocket protocol, event names) appear only where other capabilities need them, in *Cross-capability contracts*
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders — acceptance scenarios are Given/When/Then; protocol codes are confined to scenario outcomes the tests must check
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (0; every default is in Assumptions and `questions.md`)
- [x] Requirements are testable and unambiguous (41 FRs, each cites its scenarios)
- [x] Success criteria are measurable (SC-001–SC-009)
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined (56; `test-plan.md` has exactly 56 rows, one per scenario)
- [x] Edge cases are identified (concurrency, replay, illegal transitions, cross-tenant, limits, timeouts, duplicate and out-of-order updates, store failure, split brain)
- [x] Scope is clearly bounded (Scope section; S05, S03 and W04 boundaries named)
- [x] Dependencies and assumptions identified (Requires list, Assumptions, 16 BREAKING, 11 CONTRACT, 14 LOCAL lines)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (create/connect, co-edit, permissions, publish, versions, routing/durability, operations)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification (the pattern P1105 is covered by AS-45, AS-46, AS-48, AS-49)

## Notes

- Iteration 1 passed all items. `pnpm check:table-ownership` and the test suites were not run (approval not available unattended); `gaps.md` section C is reconstructed and says so.
- The Interview-Prep copy of SD-16 does not exist at the path in `capabilities.tsv`; the repo copy was used (CONTRACT line in `questions.md`).
