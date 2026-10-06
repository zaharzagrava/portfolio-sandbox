# Specification Quality Checklist: S34 — "Bought Together" Recommendations (domain `discovery`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). The spec names no language, framework or product (stores are "analytics store", "list store", "basket store"). It does name the HTTP route, headers, metrics and the exported service methods of other capabilities, because those are this capability's contract; sibling specs (S32, S33) do the same. Caveat recorded, not a blocker.
- [x] Focused on user value and business needs (eight stories: the rail, only buyable products, cold start, hub normalisation, exactly-once baskets, safe nightly build, graceful degradation, page rendering).
- [x] Written for non-technical stakeholders. Stories and success criteria read in plain language; scenarios and contracts are written for reviewers and the implementation agent.
- [x] All mandatory sections completed (Scope, User Scenarios, Edge Cases, Requirements, Success Criteria, Assumptions, Cross-capability contracts).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (searched: none). Every default is in Assumptions and `questions.md`.
- [x] Requirements are testable and unambiguous (FR-001 to FR-030, each tied to a scenario with exact numbers; dataset D gives exact scores, e.g. `S → [K 0.2046, P 0.0673 (2 hops)]`).
- [x] Success criteria are measurable (SC-001 to SC-009: 300 ms at p99, 0 invisible products shown, 100% cold-start fill, 0% duplicate effect, 0 half-written lists, 60-minute build, 3 distinct buyers, 36-hour alert).
- [x] Success criteria are technology-agnostic. They speak of buyers, the page, the nightly build and orders.
- [x] All acceptance scenarios are defined (AS-01 to AS-51, each Given/When/Then with exact outcomes; `test-plan.md` maps each to exactly one row).
- [x] Edge cases are identified: duplicate, concurrent, late and out-of-order events, replay, version-guarded redelivery, concurrent builds, failed and empty-source builds, TTL expiry, dependency timeouts, rate limit and fail-open, hidden and unknown products (non-disclosing 404), damaged data, manufactured edges, hub popularity, limits and validation.
- [x] Scope is clearly bounded (Scope lists what is built and what other capabilities own: S05, S03, S10, S32, S33, S35, S36, S48, W02, S49, S50, S54; "also viewed" postponed).
- [x] Dependencies and assumptions identified (Cross-capability contracts: Provides / Requires with exact shapes; Assumptions with the R1 / R2 / R3 mechanism named for each cross-domain read and the accepted staleness).

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (FR → AS references inline).
- [x] User scenarios cover primary flows (read, visibility, cold start, normalisation, capture, build, degradation, UI).
- [x] Feature meets measurable outcomes defined in Success Criteria (each SC is exercised by named scenarios, or by an operations artifact stated in `test-plan.md` for SC-001 and SC-007).
- [x] No implementation details leak into specification (see the first item for the recorded caveat).

## Notes

- Pattern map: the only row naming S34 is **P1111** (BFS with decay, 2-hop); it appears as FR-006 and AS-13 to AS-20.
- The Interview-Prep notes were read from `docs/showcase/sections/X-01-graph-recommendations.md` in this repository. The path `~/workspace/notes/Interview-Prep/` does not exist in this environment, so the in-repo copy was used. Where the notes and code differ (the notes' `?type=bought-together` parameter, 3-day TTL, top-5 seeds, decay 0.5, cosine, 30-product basket cap), the notes were followed.
- `pnpm --dir packages/backend check:table-ownership` was run; its seven `discovery` lines are in `gaps.md` §C (two files belong to S34).
- Not run: any test, build or code change (spec-only task).
- Contract decisions that differ from today's behaviour are `[BREAKING]` in `questions.md` (16 lines) and `[CONTRACT]` (5 lines); no existing spec required anything of S34 that the spec contradicts.
