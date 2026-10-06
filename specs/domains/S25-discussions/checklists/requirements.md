# Specification Quality Checklist: S25 — Product discussions

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — the spec names no store, cache or framework; routes, header names and exported service names appear only because the Cross-capability contracts section requires exact names
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders — stories and success criteria are plain-language; the contract section is for other specs
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (0; every default is in Assumptions and `questions.md`)
- [x] Requirements are testable and unambiguous — each FR cites the scenario(s) that prove it
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined — 55 scenarios (AS-01 … AS-55), 55 rows in `test-plan.md`
- [x] Edge cases are identified — index table in the spec maps concurrency, idempotent replay, illegal transitions, cross-user access, limits, timeouts and duplicate events to scenarios
- [x] Scope is clearly bounded — Scope lists in/out with owners (S26, S28, S29, S32, S47, W02, S48, S01, S50)
- [x] Dependencies and assumptions identified — Cross-capability contracts (Provides / Requires) and Assumptions

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (post, comment, vote, browse, best comments, abuse controls, safe content, failure)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Pattern coverage (`docs/architecture/pattern-map.md`, Specs column contains S25)

- [x] P0320 time-based IDs → FR-003; AS-01, AS-19, AS-55
- [x] P0323 ranking structures (sorted sets, hashes) as derived, expiring, rebuildable state → FR-024, FR-030, FR-035, FR-036; AS-38, AS-43, AS-49, AS-50, AS-51
- [x] P0501 XSS output encoding and sanitised markdown → FR-040 to FR-043; AS-08 to AS-12
- [x] P1108 hot and Wilson ranking → FR-032, FR-033; AS-33, AS-34, AS-42

## Notes

- Iteration 1 of 3: all items pass. A spec-wording pass fixed an ambiguous control-character range (AS-03), a hot-ranking example that needed an explicit age gap (AS-33), and a "bounded read" scenario that now names its observation point (AS-18).
- `pnpm check:table-ownership` could not be run unattended (approval required); `gaps.md` §3 derives the community lines from the source and says so. Re-run before implementation.
- The Interview-Prep `SD-11` section lives in the repository at `docs/showcase/sections/SD-11-product-discussions.md`, not under `~/workspace/notes/Interview-Prep/docs/…`; the other two notes were read from `~/workspace/notes/Interview-Prep/`.
