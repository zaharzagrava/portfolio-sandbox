# Specification Quality Checklist: S20 — Same-Day Courier Dispatch (domain `fulfilment`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [ ] No implementation details (languages, frameworks, APIs) — **partial, by project convention**: the scenarios describe behaviour, but Redis GEO, DynamoDB, SQS and Kafka are named in Scope, AS-54 (city as hash tag), the Cross-capability contracts section and Assumptions, because patterns P0323/P0328/P1105 and the domain map fix those stores and the contracts section needs exact names (same convention as S19). No language, framework or class names appear in the scenarios or requirements.
- [x] Focused on user value and business needs
- [ ] Written for non-technical stakeholders — **partial**: user stories are written around courier, shop and buyer outcomes, but the acceptance scenarios and contracts are written for reviewers and implementers (constitution VII.8 traceability).
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous (FR-001–FR-051 each name the scenarios that prove them; every scenario states exact outcomes and codes)
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined (AS-01–AS-58, one row each in `test-plan.md`)
- [x] Edge cases are identified (concurrency AS-21/22/25/33/34/41/42, idempotent replay AS-33/40, illegal transitions AS-28/30, cross-tenant AS-31/39/44/45/46, limits AS-06/38/42, timeouts AS-16/27, out-of-order and duplicate events AS-04/10/55/56)
- [x] Scope is clearly bounded (Scope lists out-of-scope items with owners)
- [x] Dependencies and assumptions identified (Cross-capability contracts, Assumptions, `questions.md`)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (courier shift and ingest, dispatch, state machine, request, tracking, surge, ownership, order integration, observability, isolation)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [ ] No implementation details leak into specification — see the first item: store names remain where a pattern or the contracts require them.

## Notes

- Pattern coverage: P0110 (AS-28, FR-022), P0323 and P0328 (AS-03, AS-07, AS-17, AS-18, AS-49, AS-54), P1105 (AS-52, AS-53, FR-043); all four pattern-map rows naming S20 are covered.
- Cross-capability contracts honoured: S10 (`OrderFulfilmentService`, `order.paid`/`order.cancelled` consumers), S19 (consumer correction), S03, S01; deviations are the `[CONTRACT]` lines in `questions.md`.
- Three items stay unchecked deliberately; they describe the project's spec convention rather than missing content. Re-open them only if the reviewer wants the store names removed from the contracts section.
- The `check:table-ownership` command needs an approval the unattended run lacked; `gaps.md` section C is a manual read and must be confirmed.
