# Specification Quality Checklist: S04 — Seller Onboarding / KYC (domain `seller-onboarding`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — stories, requirements and success criteria describe behaviour. Exact route, service, event, queue and metric names appear only in acceptance scenarios and in `## Cross-capability contracts`, which the task requires so later specs can read them (same convention as S01–S03).
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders — stories and success criteria are plain; acceptance scenarios carry exact status and error codes because the test plan needs them.
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (0; defaults are in Assumptions and `questions.md`)
- [x] Requirements are testable and unambiguous (72 acceptance scenarios, each with exact outcomes)
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined (pattern rows naming S04: P0112 and P0518, mapped in Assumptions together with the design-44 items and the notes-wide patterns)
- [x] Edge cases are identified (concurrency AS-06/14/31/44/51/57, idempotent replay AS-06/15/31/32/60, illegal transitions AS-07/18/45/52/70, cross-tenant AS-08/21/39, limits AS-12/19/20/24, timeouts AS-32/69, duplicate and out-of-order events AS-33/52/60)
- [x] Scope is clearly bounded (Scope section lists what S01, S03, S15, S28, S46, S49, S50, S53–S55 and the web capabilities own)
- [x] Dependencies and assumptions identified (Cross-capability contracts, Assumptions)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (each FR cites its AS numbers)
- [x] User scenarios cover primary flows (9 stories)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Traceability

- [x] `test-plan.md` has exactly one row per acceptance scenario (72 of 72)
- [x] `gaps.md` lists code gaps (A1–A40), the open debt rows (D-6, D-7, D-8, D-12, D-14) and the three `check:table-ownership` lines with the IX.7 mechanism for each

## Notes

- `pnpm --dir packages/backend check:table-ownership` was run; `seller-onboarding` has 3 findings (all `Shop`), reproduced in `gaps.md` section C.
- 20 BREAKING, 15 CONTRACT and 10 LOCAL decisions are in `questions.md`; review the first two groups first. The most consequential: this domain stops writing `Shop` (tenancy applies our events), verification commits inside the approving transaction, the extraction message goes through the outbox, review endpoints become sensitive with a conflict-of-interest rule, and `shop.rejected` plus resubmission rounds exist.
- Contracts assumed from specs that do not exist yet: S46 (LLM port in `libs/infrastructure/llm` with metering by event), S50 policy names, S53 outbox-to-queue commands, S55 dead-letter wiring. All are listed as `[CONTRACT]` lines.
