# Specification Quality Checklist: S29 — Product and review photos (domain `media`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). No engine, framework, library or vendor is named in `spec.md` (checked by search for the image library, database, object store, queue, broker, cache and scanner names). Route paths, exported service names, event names, status names and schema names are present because the "Cross-capability contracts" section and constitution V.2, X.4 and IX.7 require exact names.
- [x] Focused on user value and business needs. Seven stories: seller upload to gallery, safe processing, stolen-photo signal, gallery curation, private-until-ready reads, cleanup, delivery and operations.
- [x] Written for non-technical stakeholders. Scope, stories and success criteria are plain language; acceptance scenarios and contracts are precise on purpose, like the sibling specs.
- [x] All mandatory sections completed (scenarios, requirements, success criteria, assumptions, plus the required contracts section).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (searched; 0). Every default is in Assumptions and `questions.md`.
- [x] Requirements are testable and unambiguous. Every FR cites the scenarios that prove it; thresholds are numbers (15 MiB, 50 MP, 200/640/1600, distance 3, 5-minute lease, 5 attempts, 60-minute expiry, 7-day purge).
- [x] Success criteria are measurable (SC-001–SC-009: times, percentages, counts).
- [x] Success criteria are technology-agnostic (user-visible time to ready, metadata absence, refusal rates, replay exactness).
- [x] All acceptance scenarios are defined: 61 scenarios (AS-01–AS-61), each a Given/When/Then with exact outcomes; `test-plan.md` has 61 rows, one per scenario.
- [x] Edge cases are identified: concurrency, idempotent replay, illegal transitions, cross-tenant access, limits, timeouts, out-of-order and duplicate events are each a scenario (list in the Edge Cases section).
- [x] Scope is clearly bounded: in/out lists name the owning capability for everything excluded (S30, S05, S03, S25, S26, S27, S08, S53, S50, S49, S54, W04, J02).
- [x] Dependencies and assumptions identified: the "Requires" list names the owning capability and exact shape; Assumptions list the defaults.

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (FR → AS references; every AS is in `test-plan.md`).
- [x] User scenarios cover primary flows (upload, process, curate, read, clean up) and the pattern-map row P0509 (separate origin, nosniff, no originals, AV scan, magic bytes: AS-16–AS-19, AS-55, AS-60).
- [x] Feature meets measurable outcomes defined in Success Criteria.
- [x] No implementation details leak into specification.

## Cross-checks done beyond the template

- [x] Pattern-map rows whose Specs column contains `S29`: only **P0509**; it appears as FR-011–FR-013, FR-070 and AS-16–AS-19, AS-55, AS-60.
- [x] Earlier specs searched for `S29` and `media` (S05, S25, S07, S27, S08, S21 gaps): contracts honoured or recorded as `[CONTRACT]` in `questions.md`.
- [x] Every BREAKING decision is tagged in `questions.md`; `gaps.md` lists the current-code gaps, debt rows D-6, D-7, D-8, D-12 and the two `check:table-ownership` lines for `media`, each with its IX.7 mechanism.
- [x] Sources disagreeing with the code: the notes won (immutable content-addressed variants, EXIF/GPS strip, presigned POST with policy, state machine, dHash across shops, separate media origin, AV scan, idempotent workers with DLQ).

## Notes

- Validation passed on the first iteration; no spec change was needed after it.
- Open points that need a human: the `ProductMedia` ownership move and the `post` purpose removal (both `[CONTRACT]`/`[BREAKING]` lines at the top of `questions.md`).
