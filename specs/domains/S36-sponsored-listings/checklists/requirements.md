# Specification Quality Checklist: S36 — Sponsored Listings

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). Requirements and scenarios describe behaviour. Names of topics, headers, and exported services appear only in "Cross-capability contracts" and in the pattern-driven FR-030 – FR-033 (the pattern map requires the transactional, fenced, replay-safe stream behaviour of P0603); no language, framework or library is named.
- [x] Focused on user value and business needs (shops pay only for real, unique clicks; shoppers always land on the product).
- [x] Written for non-technical stakeholders as far as a backend money path allows: each user story opens with a plain-language paragraph; the Given/When/Then lines carry the exact numbers the tests need.
- [x] All mandatory sections completed (User Scenarios, Requirements, Success Criteria, Assumptions; plus Scope and Cross-capability contracts).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (0; every default is in Assumptions and `questions.md`).
- [x] Requirements are testable and unambiguous (every FR names the scenarios that prove it).
- [x] Success criteria are measurable (SC-001 – SC-010 carry numbers).
- [x] Success criteria are technology-agnostic (no store, broker or framework named).
- [x] All acceptance scenarios are defined (AS-01 – AS-83; each maps to one row of `test-plan.md`, 83 = 83).
- [x] Edge cases are identified (concurrency AS-06, 07, 10, 28, 38, 51, 63; idempotent replay AS-27, 51, 58; illegal transitions AS-09; cross-tenant AS-04; limits AS-07, 14, 22, 53; timeouts AS-34, 35; out-of-order and duplicate events AS-44 – AS-47, AS-70, AS-73; late data AS-48, AS-62).
- [x] Scope is clearly bounded (in/out lists name S37, S35, S32, S34, S14, S49, S50, S53, S54, W02, W04 as owners of what is excluded; cross-domain data appears only as R1 (`getProductsByIds`, `postJournal`, `getBalances`) and R3 (product, shop events), named per use).
- [x] Dependencies and assumptions identified (Cross-capability contracts "Requires"; Assumptions).

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria.
- [x] User scenarios cover primary flows (campaign, serve, click, spam, aggregate, bill, reconcile, statement, read models, operations).
- [x] Feature meets measurable outcomes defined in Success Criteria.
- [x] No implementation details leak into specification beyond those noted in the first item.

## Pattern-map coverage (rows listing S36)

- [x] P0603 Idempotent producer, Kafka transactions → FR-030 – FR-039; AS-26 – AS-28, AS-34, AS-37, AS-42 – AS-47.
- [x] P0614 Reconciliation and period close (ad billing) → FR-040 – FR-059; AS-50 – AS-69.

## Command-specific checks

- [x] `## Cross-capability contracts` has **Provides** and **Requires**, with exact names; contracts of S32, S14, S05, S34, S35, S10, S03 honoured or recorded as `[CONTRACT]` questions.
- [x] `questions.md` lines tagged and sorted (BREAKING, CONTRACT, LOCAL).
- [x] `test-plan.md` has one row per scenario with the e2e file named; `gaps.md` lists code gaps, debt rows D-6, D-7, D-8, D-12 with the replacing IX.7 mechanism.

## Notes

- `pnpm check:table-ownership` could not be run in this session (the command was not approved), so the `marketing` lines in `gaps.md` §3 are derived from reading the code; the implementation agent must run it first.
- The notes' source `~/workspace/notes/Interview-Prep` is not present at that path; the copy under `.specify/memory/Interview-Prep` and `docs/showcase/sections/SD-32-trending-sponsored-clicks.md` were used. `10-System-Design/09-data-and-infrastructure.md` §32 was read in full.
- Items needing human review first: the BREAKING lines of `questions.md` (GET click redirect as a V.5 exception; ledger posting outside the shop's transaction; whole-click billing; reconciliation window and period close; permission change from `products.write` to `shop.manage`; secret separation) and the CONTRACT lines for S14 (reference formats), S32 (topic), W02/W04 (no web owner).
