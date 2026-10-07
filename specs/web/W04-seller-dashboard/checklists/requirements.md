# Specification Quality Checklist: W04 — Seller dashboard (overview, live sales numbers, inventory, developer settings, team, orders)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-07
**Feature**: [spec.md](../spec.md)

## Content Quality

- [ ] No implementation details (languages, frameworks, APIs) — **accepted deviation**: the task requires the spec to state constitution VI data-flow rules (query keys, server-side guards, same-origin calls, no browser-held tokens), the exact names other capabilities consume (`Cross-capability contracts`) and the test files. These appear only in the `FR-001` to `FR-010` data-flow requirements, the contracts section, the error catalogue and `test-plan.md`; user stories, scenarios and success criteria are written as visible behaviour.
- [x] Focused on user value and business needs (stories are seller journeys: open a shop, watch sales live, keep stock right, give programs access safely, run the team)
- [x] Written for non-technical stakeholders — stories and acceptance scenarios read as visible behaviour with quoted copy; the technical sections are for engineers by design
- [x] All mandatory sections completed (User Scenarios & Testing, Requirements, Success Criteria, Assumptions; plus Scope, Layout, Cross-capability contracts, Pattern coverage)

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (0; every open choice is a default in Assumptions and a tagged line in `questions.md`)
- [x] Requirements are testable and unambiguous (98 scenarios AS-01 to AS-98, each with one row in `test-plan.md`; copy is quoted; limits cite the backend scenario that owns them)
- [x] Success criteria are measurable (SC-001 to SC-009 carry times, percentages and counts)
- [x] Success criteria are technology-agnostic (stated as seller-visible outcomes; SC-004 speaks of secrets being visible once, not of mechanisms)
- [x] All acceptance scenarios are defined (loading, empty, error, partial data, forbidden, read-only, offline and reconnecting states; every backend problem code the screens can meet is in the error catalogue)
- [x] Edge cases are identified (Edge Cases section maps each class to scenario IDs)
- [x] Scope is clearly bounded (in scope and out of scope with owners named; the ten seller screens other specs assign to W04 are deferred, each as a `[CONTRACT]` line)
- [x] Dependencies and assumptions identified (Assumptions; Requires list with owning capability and exact shapes; missing endpoints in `gaps.md` section E)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (each FR cites its scenarios)
- [x] User scenarios cover primary flows (shop entry, overview and live numbers, inventory, keys, webhooks, version/logs/usage, team and invitation, orders, cross-cutting rules, layout)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [ ] No implementation details leak into specification — same accepted deviation as the first item

## Pattern map coverage

- [x] Every `docs/architecture/pattern-map.md` row whose Specs column names W04 appears as requirements and scenarios: P0406 (FR-020 to FR-024, FR-045; AS-19 to AS-25, AS-27), P0901 (FR-003 to FR-005, FR-010; AS-12, AS-29, AS-30, AS-70, AS-73, AS-92)
- [x] Every contract earlier specs require from W04 is honoured or raised as `[CONTRACT]`: S03 (switcher, team, roles matrix, `/invites/<token>`; SSO and offboarding deferred), S05 (inventory), S10 (seller orders), S32 (shop search), S40 (rank, today, stats, live frames), S42 (keys, version, logs, usage), S43 (webhook screens), S51 (stream handling), W01 (guards, `useAuth`, refresh, problem rendering), W02 (`formatMoney`), W03 (buyer table leaves the dashboard, topic stream); S04, S06, S07, S08, S09, S12, S14, S15, S29, S30, S36, S44, S47 are deferred with a `[CONTRACT]` line and a plug-in point (navigation registry, shop context, reveal dialog)

## Notes

- Validation iterations: 1 (all items other than the two accepted-deviation items pass on first review). Self-checks run: 98 scenarios in `spec.md` and 98 rows in `test-plan.md`; no scenario number above AS-98 is referenced; no placeholder text or clarification marker remains in the four documents.
- The two unchecked items are deliberate: removing the constitution-mandated rules and contract names would violate the task. No further spec change is required before `/speckit-clarify` or `/speckit-plan`.
- Known weaknesses recorded, not hidden: the overview depends on an aggregate that does not exist yet (`gaps.md` E1); several backend list shapes are assumed and raised as `[CONTRACT]` (keys and logs pages, shop-order items, permission names); ten seller screens named by other specs are not part of this release; the test-plan rows for team, orders, and the overview aggregate have no backend scenario to cite until S48 and S03 add them.
