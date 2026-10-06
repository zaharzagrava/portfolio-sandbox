# Specification Quality Checklist: S17 — Subscriptions (domain `billing`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — the body describes behaviour; row-lock wording (`FOR UPDATE SKIP LOCKED`, FR-022, AS-38), outbox/inbox and the route and event names appear only where a testable contract needs them, as in sibling specs; no language, framework or library is named
- [x] Focused on user value and business needs (customers subscribe, are charged once per period, pay exactly what a change costs, are chased fairly; finance can recompute every invoice)
- [x] Written for non-technical stakeholders (scenarios use the worked dataset DS-1 and a worked fixture subscription with plain numbers)
- [x] All mandatory sections completed (Scope, User Scenarios, Requirements, Success Criteria, Assumptions, Cross-capability contracts)

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (defaults recorded in `questions.md` and Assumptions)
- [x] Requirements are testable and unambiguous (FR-001–FR-060, each referencing scenarios)
- [x] Success criteria are measurable (SC-001–SC-010)
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined (AS-01–AS-85; every pattern-map row for S17 appears: P0103 → AS-64, AS-70; P0104 → AS-30, AS-63; P0110 → AS-21, AS-23, AS-24; P1110 → AS-64, AS-70)
- [x] Edge cases are identified (Edge Cases index maps concurrency, idempotent replay, illegal transitions, cross-tenant access, limits, timeouts, unknown outcomes, out-of-order and duplicate events, crashes, dependency outages to scenarios)
- [x] Scope is clearly bounded (out-of-scope list names S18, S13, S10, S14, S16, S01, S03, S28, S49, S50, S53, S54)
- [x] Dependencies and assumptions identified (Cross-capability contracts Provides/Requires with exact names and shapes; Assumptions)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (every FR cites at least one AS; every AS has one row in `test-plan.md`: 85 of 85)
- [x] User scenarios cover primary flows (catalog, subscribe, state machine, billing run, charging and dunning, change and proration, cancel and offboarding, reads and events, operations)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Source gap: `docs/showcase/sections/SD-24-subscriptions-billing.md` does not exist in this checkout; design 24 of `10-System-Design/07-commerce-and-transactions.md` and the code were used (recorded at the top of `questions.md`).
- Cross-capability checks done: S03's required event `billing.subscription_plan_changed` is honoured exactly; S13's "billing sends a charge command" is not honoured and is raised as a `[CONTRACT]` question; S18 and S28 specs do not exist yet, so the shapes S17 assumes from and offers to them are stated in the contracts section and in `questions.md`.
- The table-ownership command ran successfully (0 findings for `billing`, none against billing's tables).
- Items marked complete were checked against the spec text in one pass; no iteration was needed.
