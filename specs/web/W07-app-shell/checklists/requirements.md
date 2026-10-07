# Specification Quality Checklist: W07 — App shell and cross-cutting UI

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-07
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — *Note: this is a web-capability spec in a repo whose specs cite exact component, module and header names as cross-capability contracts (W01–W06 do the same); those appear only in Provides/Requires, FR names and questions, while the scenarios describe visible behaviour.*
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders — *scenarios and success criteria are plain-language; contracts and FRs are for reviewers*
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined (AS-01..AS-41; each has a row in test-plan.md)
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified (Cross-capability contracts, Assumptions A-01..A-14, questions.md)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (each FR names its scenarios)
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification beyond the named contracts above

## Notes

- Pattern-map rows P0502, P0902, P0903 are covered in the final section of spec.md.
- Open differences with other specs are listed as `[CONTRACT]` in questions.md (Q1–Q6), not as clarification markers.
- Success criteria SC-002, SC-003 and SC-007 mention headers, policy violations and bytes of code; they stay measurable from outside the implementation.
