# Specification Quality Checklist: W02 — Storefront discovery (`packages/web`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-06
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — see note 1
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders — see note 2
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (searched `spec.md`, `questions.md`, `test-plan.md`, `gaps.md`: 0)
- [x] Requirements are testable and unambiguous (every FR cites the scenarios that prove it; exact copy is in FR-170..FR-176)
- [x] Success criteria are measurable (SC-001..SC-010 carry a time, a count or 100 %/0 thresholds)
- [x] Success criteria are technology-agnostic (no framework, library or storage name; "address", "browser storage" and "console" are user-observable)
- [x] All acceptance scenarios are defined (AS-01..AS-77, each with a test-plan row: 77 of 77, six cells each)
- [x] Edge cases are identified (Edge Cases section; each names its scenario)
- [x] Scope is clearly bounded (Scope: in/out lists, W01/W03/W05/W07/S-capability hand-offs, video and sponsored slot marked conditional P3)
- [x] Dependencies and assumptions identified (Cross-capability contracts Requires list; Assumptions; 21 `[CONTRACT]` lines in `questions.md`)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (FR → AS mapping; the Pattern coverage table maps P0402, P0901, P0902)
- [x] User scenarios cover primary flows (home, autocomplete, results and facets, pickup search, product page and partial pages, pickup near me and map, discussions, ask, share and referral, optional video and sponsored slot, visitor events, rendering and safety rules)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification — see note 1

## Notes

1. **Implementation names are present on purpose.** The brief and constitution VI require this spec to state the data flow (Server Components, TanStack Query with keys from `lib/query-keys.ts`, URL state, network calls only in `lib/api/*`, no tokens in JavaScript), so the Requirements and Cross-capability sections name those mechanisms, the schemas and the cookie and parameter names other capabilities must match. The user stories, scenarios' outcomes, edge cases and success criteria describe what the shopper sees and measures, not how it is built. The same trade-off was made in W01.
2. **Audience.** User Scenarios, Edge Cases, Success Criteria and Assumptions read for a product owner. Requirements and Cross-capability contracts are written for the implementation agent and for the owners of the neighbouring capabilities, because later specs read them.
3. **Review first**: the BREAKING lines of `questions.md` (search parameter names and facets, cursor paging, one aggregate read for the product page, route and card prop renames, discussions and ask rewrites, tabs in the address) and the CONTRACT lines (S48 `gallery` section, `imageUrl` on rails, `/p/` redirect, referral cookie and order hand-off, analytics ownership, S19's journey file path).
4. **Open points that need a backend owner** are in `gaps.md` section H (nine items); none blocks the spec, each has a named fallback in the spec text.
