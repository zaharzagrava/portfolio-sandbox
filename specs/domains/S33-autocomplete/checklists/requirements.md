# Specification Quality Checklist: S33 — Search Autocomplete (domain `discovery`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). The spec names no language, framework or product (stores are "analytics store", "object storage", "key-value store", "search engine"). It does name the HTTP route, headers, metrics and port methods, because the capability's contract is those; the sibling specs (S32) do the same. Caveat recorded, not a blocker.
- [x] Focused on user value and business needs (seven stories: suggestions while typing, catalog completions with budgets, typo fallback, hourly safe build, hot swap, operability, search-page behaviour).
- [x] Written for non-technical stakeholders. Stories and success criteria read in plain language; acceptance scenarios and contracts are written for reviewers and the implementation agent, as in the sibling specs.
- [x] All mandatory sections completed (Scope, User Scenarios, Edge Cases, Requirements, Success Criteria, Assumptions, Cross-capability contracts).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (none written; every choice is an Assumption and a tagged line in `questions.md`).
- [x] Requirements are testable and unambiguous: 42 functional requirements, each cites the acceptance scenarios that prove it (FR-042 is proven by AS-55 and AS-56).
- [x] Success criteria are measurable (SC-001 to SC-009 with numbers).
- [x] Success criteria are technology-agnostic (stated as buyer and operator outcomes).
- [x] All acceptance scenarios are defined: 56 scenarios (AS-01 to AS-56) with exact bodies, status codes, counts and persisted effects; each maps to exactly one row of `test-plan.md` (56 rows, verified by count).
- [x] Edge cases are identified (rapid typing, slow or dead sources, limits, hostile text, privacy, duplicate and late rows, concurrent and failing builds, damaged snapshots, rollback, cross-tenant equivalents, idempotent replay), each mapped to a scenario in the Edge Cases section.
- [x] Scope is clearly bounded (in/out lists name S32, S34, S35, S49, S50, S54, W02 as owners of what is excluded; cross-domain data appears only through S32's exported port, same domain, and no table of another domain is read).
- [x] Dependencies and assumptions identified (Requires list with owner IDs and exact shapes; Assumptions; `questions.md` with 11 BREAKING, 8 CONTRACT and 16 LOCAL lines).

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria.
- [x] User scenarios cover primary flows (suggest, blend, degrade, typo, build, swap, rollback, UI).
- [x] Feature meets measurable outcomes defined in Success Criteria (SC-001 and SC-008 are proven by operations artifacts, the others by scenarios).
- [x] No implementation details leak into specification beyond the contract-level names noted above.

## Notes

- Pattern **P1101** (trie with per-node top-K) is covered by FR-004, FR-005, FR-037 and AS-02, AS-11, AS-52, AS-53, AS-54. It is the only pattern-map row naming S33.
- Cross-capability contracts honoured from S32 (`ProductTitleSuggester`, `search.performed` without ordering assumption, no `suggestions` in the search response). Two additions are requested of S32 as `[CONTRACT]` questions: `suggestTitlesFuzzy` and the `surface` column.
- `pnpm check:table-ownership` could not be run unattended (approval required); `gaps.md` section C is from reading the code and says so.
- Iterations: 1. Initial draft passed; scenario IDs were renumbered once to remove a gap.
