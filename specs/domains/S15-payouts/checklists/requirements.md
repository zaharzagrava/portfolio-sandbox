# Specification Quality Checklist: S15 — Seller Payouts

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — the body states behaviour in domain terms; HTTP paths, event names and exported call shapes appear only where the task requires exact names (acceptance scenarios and "Cross-capability contracts"), as in S13/S14
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders — each story opens with the business problem; scenarios use money amounts and plain outcomes
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (0; every default is in Assumptions and `questions.md`)
- [x] Requirements are testable and unambiguous (FR-001–FR-052, each tied to an AS-NN)
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined (AS-01–AS-55; 55 rows in `test-plan.md`)
- [x] Edge cases are identified (concurrency, replay, illegal transitions, cross-tenant, limits, timeouts, duplicate and out-of-order outcomes)
- [x] Scope is clearly bounded (out-of-scope list names the owning capability)
- [x] Dependencies and assumptions identified (Cross-capability contracts, Assumptions, `questions.md`)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (weekly run, transfer, seller view, operator control, audit)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification (see first item)

## Traceability and contracts

- [x] Pattern-map row for S15 (P0414, idempotency keys: replay, in-flight 409, different-body 422, TTL; transfers keyed by payout ID) appears as FR-014, FR-036, AS-17–AS-19, AS-41
- [x] Every cross-domain data path names its IX.7 mechanism (R1 `ShopQueryService`, R1 `LedgerService`, R1 `ShopScoped`, R3 `payouts.events`)
- [x] Contracts from S03, S04, S14 honoured; differences recorded as `[CONTRACT]` lines in `questions.md`
- [x] `test-plan.md` has one row per scenario; `gaps.md` lists code gaps, open debt rows (D-6, D-7, D-8, D-11, D-12, D-15, D-17) and ownership findings

## Notes

- Validation passed on the first iteration.
- `pnpm check:table-ownership` could not be run unattended (approval required); `gaps.md` section D is derived from reading the code and tells the implementation agent to run it first.
- The Interview-Prep note files were read from `~/workspace/notes/Interview-Prep/10-System-Design/02-worked-examples.md` and the SD-20 section in the repo; no other note source was required for this capability.
