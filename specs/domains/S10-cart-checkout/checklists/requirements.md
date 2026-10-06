# Specification Quality Checklist: S10 — Cart, Checkout, Stock Reservation, Order State Machine, Payment Webhook (domain `orders`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). `spec.md` names no database, cache, queue, framework or test library (searched for Postgres, Dynamo, Redis, Sequelize, Nest, Kafka, supertest, zod, Playwright: 0 matches). Route paths, exported service names, schema names, event, topic and job names, problem codes and policy names appear because the constitution's contract rules (V.2, X.4, IX.7) and the required "Cross-capability contracts" section demand exact names; the payment provider's name appears only in the webhook route and signature header.
- [x] Focused on user value and business needs: seven stories (cart and merge, retry-safe checkout, never oversold, signed payment webhook, legal state moves, reads and tenant isolation, events and boundaries).
- [x] Written for non-technical stakeholders: scope and story narratives are plain language; scenarios and contracts are precise on purpose, like the sibling specs.
- [x] All mandatory sections completed (scenarios, requirements, entities, success criteria, assumptions, plus the required contracts section).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (search: 0). Defaults are in Assumptions and `questions.md`.
- [x] Requirements are testable and unambiguous: 59 functional requirements, each names the scenarios that prove it (59 of 59 cite at least one AS).
- [x] Success criteria are measurable (SC-001–SC-010 carry counts, percentages, seconds and run counts).
- [x] Success criteria are technology-agnostic.
- [x] All acceptance scenarios are defined: 68 scenarios (AS-01–AS-68, sequential) with exact outcomes; `test-plan.md` has 68 matching rows (checked: same ID set).
- [x] Edge cases are identified: concurrency (AS-06, AS-17, AS-27, AS-32, AS-34, AS-51, AS-56), idempotent replay (AS-15–AS-20), illegal transitions (AS-54, AS-55, AS-57), cross-tenant (AS-02, AS-40, AS-58, AS-61, AS-63), limits (AS-03, AS-07, AS-10, AS-26, AS-52, AS-59), timeouts and partial failure (AS-29, AS-30, AS-38, AS-39, AS-44, AS-64), duplicate and out-of-order events (AS-43, AS-47, AS-49, AS-50), forged input (AS-04, AS-42), expiry (AS-09, AS-36, AS-37), late payment (AS-47).
- [x] Scope is clearly bounded: in/out lists name S11, S12, S13, S14, S45, S05, S03, S01, S28, S51, S53, S49, S50, S54, S19, S20, S21, W03 and S48 as owners of what is excluded; cross-domain data appears only as R1 calls (S05, S03, S13, S45), R2 composition by the BFF for display data, and R3 consumption by others of this domain's events.
- [x] Dependencies and assumptions identified: the Requires list, the Assumptions section and `questions.md` (25 BREAKING, 15 CONTRACT, 14 LOCAL lines).

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria.
- [x] User scenarios cover primary flows (cart, checkout, reserve, pay) and the secondary ones (cancel and expiry, reads, events).
- [x] Feature meets measurable outcomes defined in Success Criteria (SC-001 → AS-32, SC-002 → AS-15–AS-17, SC-003/SC-004 → load runs outside e2e plus AS-01, SC-005 → AS-41–AS-43, SC-006 → AS-36–AS-38, SC-007 → AS-25, SC-008 → AS-58, AS-61, SC-009 → AS-47, SC-010 → AS-68).
- [x] No implementation details leak into specification.

## Notes

- **Cross-capability contracts honoured**: S05 (stock only through `applyStockDelta` with `<service>:<aggregate-id>:<step>` operation IDs, titles and prices snapshotted, no product association), S03 (`orders.read`, status gate), S01 (user ID as plain ID), S08 (stock reaches providers without this capability), S07 (order export out). Differences are recorded as `[CONTRACT]` lines: shop status lookup through S03 (S05's DTO has none), S45's discount shape, S13's status service and `payments.events`.
- **Source note**: the three Interview-Prep notes were read from `~/workspace/notes/Interview-Prep/` and `docs/showcase/sections/SD-19-checkout-inventory.md`. Where the code and the notes disagree the notes won: `202` for checkout, `409` for an in-flight duplicate, `422` for key reuse, 2xx after enqueue for the webhook, refund compensation for late payments.
- **Checks run**: `pnpm --dir packages/backend check:table-ownership` ran (87 findings, 12 for `orders`); the output is reflected in `gaps.md` section C. No tests were run and no code was changed.
- **UI journey**: one W03 happy path (guest cart → login merge → checkout → paid order page); all edge cases are API-level.
- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`: none.
