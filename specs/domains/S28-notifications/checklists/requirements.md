# Specification Quality Checklist: S28 — Notification routing (domain `notifications`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — requirements and success criteria name no language, framework, database engine, queue product or provider SDK; stores appear only in Assumptions as the domain map's placement. Endpoint paths, event names, table names and metric names appear because they are cross-capability contracts or ownership boundaries the task requires.
- [x] Focused on user value and business needs — each story states what the user or seller experiences and why it has its priority.
- [x] Written for non-technical stakeholders — stories and success criteria are plain language; scenarios carry exact outcomes for testers.
- [x] All mandatory sections completed — scope, user scenarios, requirements, success criteria, key entities, cross-capability contracts, assumptions.

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain — none were used; every default is in Assumptions and `questions.md`.
- [x] Requirements are testable and unambiguous — 52 FRs, each referenced by at least one of AS-01…AS-87 with exact status codes, counts, delays and states.
- [x] Success criteria are measurable — SC-001…SC-012 give percentiles, counts and zero-violation targets.
- [x] Success criteria are technology-agnostic — phrased as user-visible time, duplicates, delays and violations.
- [x] All acceptance scenarios are defined — 87 scenarios across 8 stories; 87 rows in `test-plan.md` (one per scenario, IDs match).
- [x] Edge cases are identified — the Edge Cases section maps duplicates, ordering, concurrency, cross-user access, limits, timeouts, invalid input, time zones and privacy to scenarios.
- [x] Scope is clearly bounded — Out-of-scope list names the owner of each excluded concern; unconsumed events are listed in `questions.md`.
- [x] Dependencies and assumptions identified — "Requires" lists owner and exact shape per capability; three differences from existing specs are `[CONTRACT]` questions (S10 `userId`, S26 follower page, S41/S43 events).

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria — FR→AS references throughout; the four patterns of the pattern map (P0104, P0419, P0601, P0618) appear as FR-021…FR-024, FR-043…FR-045, FR-001…FR-003 and FR-027, with scenarios AS-30…AS-34, AS-67…AS-75, AS-01…AS-05, AS-40…AS-41.
- [x] User scenarios cover primary flows — routing, preferences, quiet hours and caps, delivery lines, inbox, suppression and callbacks, templates, boundaries.
- [x] Feature meets measurable outcomes defined in Success Criteria — each SC maps to scenarios or to the named k6 ops artifacts in `test-plan.md`.
- [x] No implementation details leak into specification — see the first item; implementation-level choices (stores, mechanisms) are confined to Assumptions.

## Notes

- Iteration 1 of 3: all items pass; no spec change was needed after validation.
- `pnpm check:table-ownership` could not be executed in this unattended session (approval required); `gaps.md` section 3 is built from the code and says so. This does not affect the spec.
- Caveat for reviewers: the S28 spec requires three additions from other capabilities (S10 `userId` on `order.fulfilment_changed`, S26 follower page, S41/S43 events). If any is refused, the corresponding catalog row is dropped (see `questions.md`), and AS-87 shrinks accordingly.
