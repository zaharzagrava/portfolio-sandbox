# Specification Quality Checklist: W03 — Cart, checkout, pay step, success page, orders, notification popover

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-07
**Feature**: [spec.md](../spec.md)

## Content Quality

- [ ] No implementation details (languages, frameworks, APIs) — **accepted deviation**: the task requires the spec to state constitution VI data-flow rules (query cache keys, server-side order function, same-origin calls, no browser-stored tokens) and a `Cross-capability contracts` section with exact endpoint and component names. These appear only in `FR-0xx` data-flow requirements, FR-081 and that section; user stories, scenarios and success criteria are written without them.
- [x] Focused on user value and business needs (stories are buyer journeys: keep a cart, order once, pay and watch it settle, truthful confirmation, find and manage orders, notifications)
- [x] Written for non-technical stakeholders — the user stories and acceptance scenarios read as visible behaviour with quoted copy; the technical sections (FR data flow, contracts, problem catalogue) are for engineers by design
- [x] All mandatory sections completed (User Scenarios & Testing, Requirements, Success Criteria, Assumptions; plus Scope, Cross-capability contracts, Pattern coverage)

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (0; every open choice is a default in Assumptions and a tagged line in `questions.md`)
- [x] Requirements are testable and unambiguous (75 scenarios AS-01 to AS-75, each with one row in `test-plan.md`; copy is quoted)
- [x] Success criteria are measurable (SC-001 to SC-010 carry counts, times and percentages)
- [x] Success criteria are technology-agnostic (stated as buyer-visible outcomes; SC-010 speaks of credentials and card data, not mechanisms)
- [x] All acceptance scenarios are defined (loading, empty, error, partial, unauthorized, offline and reconnecting states for every page; every backend problem code in FR-081)
- [x] Edge cases are identified (Edge Cases section maps each class to scenario IDs)
- [x] Scope is clearly bounded (in scope and out of scope with owners named; deferred items in `questions.md`)
- [x] Dependencies and assumptions identified (Assumptions; Requires list with owning capability and exact shapes; missing endpoints in `gaps.md` section H)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (each FR cites its scenarios)
- [x] User scenarios cover primary flows (cart, checkout, pay, success, history, popover, cross-cutting rules)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [ ] No implementation details leak into specification — same accepted deviation as the first item

## Pattern map coverage

- [x] Every `docs/architecture/pattern-map.md` row whose Specs column names W03 appears as requirements and scenarios: P0414 (FR-011, FR-020–FR-022, FR-054; AS-17 to AS-22, AS-31, AS-38, AS-47), P0901 (FR-001, FR-050–FR-057; AS-04, AS-39, AS-53, AS-58, AS-70, AS-71)
- [x] Every contract earlier specs require from W03 is honoured or raised as `[CONTRACT]`: S10 (screens, problem codes, polling or push), S13 (pay step, 3-D Secure, payment history composition), S28 (`/orders/<id>` link, popover and bell), S35/S39 (`add_to_cart`, `checkout_step`), S51 (stream handling), W01 (merge call, guards, session-ended flow), W02 (`AddToCartButton`, `track`, `newIdempotencyKey`, `getRefCode`), S11 and S31 questions

## Notes

- Validation iterations: 1 (all items other than the two accepted-deviation items pass on first review).
- The two unchecked items are deliberate: removing the constitution-mandated rules and contract names would violate the task. No further spec change is required before `/speckit-clarify` or `/speckit-plan`.
- Known weakness recorded, not hidden: the review screen shows a catalogue-price estimate until S10 offers a priced preview (`gaps.md` H6).
