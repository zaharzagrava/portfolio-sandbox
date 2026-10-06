# Specification Quality Checklist: S21 — Limited-Drop Auctions

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — the spec names the fast store only in Assumptions and Cross-capability contracts; scenarios speak of bids, prices, maximums, closes, orders and stock commands. HTTP routes, status codes and problem codes are contract-level (required by "Cross-capability contracts"), not implementation.
- [x] Focused on user value and business needs (seller schedules and cancels, bidder bids with a maximum, nobody wins by sniping, the winner gets an order, the unit is never double-sold)
- [x] Written for non-technical stakeholders (story prose and success criteria; the contracts section is for later specs)
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (0; defaults are in Assumptions and `questions.md`)
- [x] Requirements are testable and unambiguous (FR-001–FR-040, each cites its scenarios)
- [x] Success criteria are measurable (SC-001–SC-011 with counts, times, percentages)
- [x] Success criteria are technology-agnostic
- [x] All acceptance scenarios are defined (AS-01–AS-54; each has a row in `test-plan.md`: 54 of 54)
- [x] Edge cases are identified (concurrency, idempotent replay, illegal transitions, cross-tenant access, limits, timeouts, duplicate and out-of-order events, late payments, lost jobs, fast-store loss, clock boundaries)
- [x] Scope is clearly bounded (In/Out of scope with owners; S10 order command, S05 stock, S03 role, S18 entitlement, S28 notifications named)
- [x] Dependencies and assumptions identified (Cross-capability contracts: Provides and Requires; Assumptions)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows (schedule, bid, concurrency, anti-sniping, close, second chance, shill guard, public view, operability)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Pattern coverage (pattern-map rows naming S21)

- [x] P0110 (discriminated unions + `assertNever` state machines) → FR-006, FR-007; AS-54
- [x] P0311 (lost-update prevention) → FR-007, FR-013, FR-015, FR-025; AS-09, AS-19, AS-20, AS-28, AS-32
- [x] P0318 (table partitioning) → FR-037; AS-46, AS-50
- [x] P0414 (idempotency keys: replay, in-flight 409, different-body 422, TTL) → FR-004, FR-019; AS-04, AS-18
- [x] P0607 (per-key ordering) → FR-015, FR-036; AS-19, AS-48, AS-49
- [x] P0615 (clocks and ordering, server time authority) → FR-016, FR-023; AS-17, AS-24, AS-25

## Notes

- Iteration 1: all items pass after three self-corrections made while validating (the AS-11 and AS-12 arithmetic, a stale "Given" in AS-14, and the open-at-`startsAt` rule so the open job's timing cannot refuse a bid).
- Source gap: `docs/showcase/sections/SD-22-limited-drop-auctions.md` does not exist in the notes tree; the spec rests on note §22 of `07-commerce-and-transactions.md`, the constitution and the current code. The human should confirm no extra rule lives in that missing file.
- Open decisions are all defaulted in `questions.md` (BREAKING 21, CONTRACT 11, LOCAL 16). Read the CONTRACT lines about S10 first: they ask S10 for `createFixedPriceOrder` with `EXTERNALLY_HELD` stock handling, and for stable `order.paid` / `order.cancelled` events.
- Largest BREAKING change: the Redis-Lua-plus-relay bid path is replaced by a durable per-auction-serialized bid step (note §22, III.6, III.9).
