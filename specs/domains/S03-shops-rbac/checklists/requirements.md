# Specification Quality Checklist: S03 — Shops as Tenants (domain `tenancy`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — user stories, requirements and success criteria describe behaviour. Exact route, service and event names appear only in `## Cross-capability contracts`, which the task requires so later specs can read them.
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders — stories and success criteria are plain; acceptance scenarios carry exact status codes and error codes because the test plan needs them, as in S01 and S02.
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (0; defaults are in Assumptions and `questions.md`)
- [x] Requirements are testable and unambiguous (83 acceptance scenarios, each with exact outcomes)
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined (every pattern row naming S03 is mapped in Assumptions: P0302, P0310, P0315, P0316, P0319, P0513, P0515, P0516, P0618)
- [x] Edge cases are identified (concurrency AS-23/34/52/65, idempotent replay AS-42/47/66, illegal transitions AS-36/64/65/67, cross-tenant AS-09/15, limits AS-04/31/39, timeouts AS-41/54, duplicate and out-of-order events AS-47/49/72/73)
- [x] Scope is clearly bounded (Scope section lists what other capabilities own)
- [x] Dependencies and assumptions identified (Cross-capability contracts, Assumptions)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (each FR cites its AS numbers)
- [x] User scenarios cover primary flows (10 stories)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Traceability

- [x] `test-plan.md` has exactly one row per acceptance scenario (83 of 83)
- [x] `gaps.md` lists code gaps, open debt rows (D-6, D-7, D-8, D-12) and the cross-domain access lines

## Notes

- `pnpm check:table-ownership` could not be run in this unattended session; `gaps.md` section C is reconstructed by search and must be reconciled with the real report.
- 23 BREAKING and 22 CONTRACT decisions are in `questions.md`; review those first. The most consequential: the invite link no longer reaches the inviter, ADMIN can no longer create owners, the guard enforces shop status, tenancy stops writing identity's `User` table (S01 must add a consumer), and unknown cells fail closed.
- Contracts assumed from specs that do not exist yet (S04 `shop.rejected`, S17 `billing.subscription_plan_changed`) are marked in `questions.md`.
