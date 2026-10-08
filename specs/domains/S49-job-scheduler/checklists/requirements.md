# Specification Quality Checklist: S49 — Distributed job scheduler

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-06
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). Note: this is an infrastructure capability whose consumers are other capabilities, so the spec names the exported service surface (`JobsService`, `JobContext`, error classes) because later specs read those names, and names the constitution's pattern titles (skip-locked claim, advisory-lock leader, partial index, HOT updates). No language, framework, ORM or SQL text appears.
- [x] Focused on user value and business needs (domain services, operators, shops)
- [x] Written for non-technical stakeholders (Summary, user stories and success criteria are plain language; scenarios are precise by design)
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (verified by search)
- [x] Requirements are testable and unambiguous (each FR cites its scenarios; each scenario has exact outcomes)
- [x] Success criteria are measurable (SC-001–SC-009)
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined (AS-01–AS-95, one test-plan row each)
- [x] Edge cases are identified (index table under Edge Cases)
- [x] Scope is clearly bounded (Scope lists in/out; operator HTTP routes belong to S01, outbox poller to S53)
- [x] Dependencies and assumptions identified (Cross-capability contracts Provides/Requires; Assumptions)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (enqueue, claim, retry, lease/reaper, state machine, fairness, cron leader, time zones, observability, retention, registry)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification (see first note)

## Pattern coverage

- [x] Every pattern-map row naming S49 (P0104, P0110, P0114, P0217, P0304, P0309, P0312, P0318) maps to requirements and scenarios (spec "Pattern coverage")

## Companion files

- [x] `questions.md`: BREAKING, CONTRACT, LOCAL lines, sorted
- [x] `test-plan.md`: one row per scenario, e2e file named, UI column justified as empty
- [x] `gaps.md`: code gaps with file and line, debt-register and table-ownership findings with the IX.7 mechanism (R1)

## Notes

- Iteration 1: all items pass. Two judgment calls recorded for the reviewer: the `CONTRACT` that S01 must add operator routes, and the deviation from III.7 (no per-transition history table; spec Assumptions).
- `pnpm check:table-ownership` could not be run in this unattended session (approval required); `gaps.md` says so and gives the static findings.
