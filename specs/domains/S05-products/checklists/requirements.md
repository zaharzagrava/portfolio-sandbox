# Specification Quality Checklist: S05 — Products (domain `catalog`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). No engine, framework or library is named in `spec.md` (checked by search). Route paths, exported service names, event names and constraint kinds are named because the repository's contract rules (constitution V.2, X.4, IX.7) and the "Cross-capability contracts" section require exact names.
- [x] Focused on user value and business needs. Seven stories: seller, shopper, price freshness, other domains, view counts, shop lifecycle, contracts.
- [x] Written for non-technical stakeholders. The scope, stories and success criteria are plain language; acceptance scenarios and contracts are precise on purpose, like the sibling specs S01–S04.
- [x] All mandatory sections completed (scenarios, requirements, success criteria, assumptions, plus the required contracts section).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (search: 0).
- [x] Requirements are testable and unambiguous: 44 functional requirements, each cites the scenarios that prove it.
- [x] Success criteria are measurable (SC-001–SC-010 carry counts, percentages and seconds).
- [x] Success criteria are technology-agnostic (no engine, framework or tool).
- [x] All acceptance scenarios are defined: 87 scenarios (AS-01–AS-87), each with exact outcomes; test-plan.md has 87 matching rows (counted).
- [x] Edge cases are identified: the notes' failure modes (stampede, avalanche, penetration, hot and big keys, stale-while-revalidate, delete-on-write race, write-behind loss) and the constitution's (concurrency, idempotent replay, illegal transitions, cross-tenant access, limits, timeouts, duplicate and out-of-order events) each have a scenario; the Edge Cases section lists the cross-cutting ones.
- [x] Scope is clearly bounded: in-scope and out-of-scope lists name the owning capability of everything left out.
- [x] Dependencies and assumptions identified: `Requires` lists S03, S32, S49, S50, S52, S53, S54 and the consumers; Assumptions lists the defaults; `questions.md` has every choice tagged.

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (FR → AS references; every AS is in exactly one test-plan row).
- [x] User scenarios cover primary flows (create, edit, archive, list, read, invalidate, stock, import, views, shop events).
- [x] Feature meets measurable outcomes defined in Success Criteria.
- [x] No implementation details leak into specification beyond the contract names noted above.

## Notes

- Iteration 1 of 3: two broken cross-references (AS-66, AS-68) and one dangling sentence in AS-84 were found while validating and fixed. No other failures.
- `pnpm check:table-ownership` could not be run (needs approval); `gaps.md` section C is reconstructed from code search and says so.
- Decisions that change today's behaviour (20 `[BREAKING]`) and those other capabilities must honour (14 `[CONTRACT]`) are at the top of `questions.md` for human review.
- Ready for `/speckit-clarify` (optional) or `/speckit-plan`.
