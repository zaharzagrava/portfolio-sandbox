# Specification Quality Checklist: S30 — Product video and VOD (domain `media`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs). No engine, framework, library, encoder or vendor is named in `spec.md` (checked by search for the encoder, database, object store, queue, broker, cache and CDN names; the only hits are the pattern-map row title quoting `child_process.spawn` and "real encoder" wording). Route paths, exported service names, event names, status names, schema names and delivery path prefixes are present because the "Cross-capability contracts" section and constitution V.2, X.4 and IX.7 require exact names.
- [x] Focused on user value and business needs. Six stories: resumable upload, a pipeline that survives crashes, safe playback, seller management, cleanup and recovery, events and operations.
- [x] Written for non-technical stakeholders. Scope, stories and success criteria are plain language; acceptance scenarios and contracts are precise on purpose, like the sibling specs.
- [x] All mandatory sections completed (scenarios, requirements, success criteria, assumptions, plus the required contracts section).

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (0 found by search in the feature directory). Every default is under Assumptions and in `questions.md`.
- [x] Requirements are testable and unambiguous. 62 acceptance scenarios with exact statuses, codes, counts and boundaries; every FR names the scenarios that prove it.
- [x] Success criteria are measurable (SC-001 to SC-010 carry percentages, times, counts).
- [x] Success criteria are technology-agnostic (watchable within 10 minutes, 0 bytes re-sent, identical segment boundaries, 0 unlisted plays without the token, 150 ms at 1,000 requests per second).
- [x] All acceptance scenarios are defined: concurrency (AS-05, AS-12, AS-22, AS-23, AS-27, AS-44, AS-45, AS-46), idempotent replay (AS-12, AS-22, AS-53–AS-55), illegal state transitions (AS-09, AS-13, AS-27, AS-46), cross-tenant access (AS-03, AS-13, AS-42, AS-48), limits (AS-02, AS-05, AS-06, AS-20, AS-45), timeouts (AS-07, AS-25, AS-51), out-of-order and duplicate events (AS-22, AS-53–AS-55).
- [x] Edge cases are identified (section "Edge Cases" plus the scenarios above).
- [x] Scope is clearly bounded: in/out lists name the owning capability for everything excluded (S29, S05, S03, S01, S23, S39, S28, S51, S49, S50, S53, S54, S48, W02, W04).
- [x] Dependencies and assumptions identified: "Requires" lists S03, S05, S01, S53, S49, S50, S54, infrastructure ports, W04/W02, S39, S48 with exact shapes; Assumptions list every default.

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (each FR cites its AS ids).
- [x] User scenarios cover primary flows: upload, resume, complete, transcode, deliver public and unlisted, manage, retry, delete, expire, purge, react to product/shop events.
- [x] Feature meets measurable outcomes defined in Success Criteria (each SC maps to scenarios: SC-002 → AS-09; SC-003 → AS-18; SC-004 → AS-12, AS-22, AS-23; SC-005 → AS-33, AS-36, AS-48; SC-006 → AS-40; SC-008 → AS-47, AS-52; SC-009 → AS-50, AS-51).
- [x] No implementation details leak into specification.

## Traceability and rules of this run

- [x] Every acceptance scenario maps to exactly one row of `test-plan.md` (62 scenarios, 62 rows, checked by search); each edge case sits at the lowest layer that proves it, with the e2e file named.
- [x] Both pattern-map rows naming S30 appear as requirements and scenarios: P0203 (FR-028, AS-25, AS-62) and P1107 (FR-020–FR-023, AS-16, AS-22).
- [x] Cross-domain data appears only as IX.7 mechanisms: R1 `getProductsByIds` (AS-04, AS-38, AS-45), R2 product page composition (AS-38, S48), R3 consumers `catalog.product_deleted`, `tenancy.shop_deleted`, `tenancy.shop_status_changed` (AS-53–AS-55).
- [x] Earlier specs were searched and honoured (S29 same-domain separation, S27 delivery host, S05, S23); the domain-map conflict is a `[CONTRACT]` question.
- [x] `questions.md` is sorted BREAKING, CONTRACT, LOCAL; `gaps.md` lists code gaps, debt rows D-6, D-7, D-8, D-12 with the replacing mechanism, and the `check:table-ownership` lines for `media`.
- [x] Sources win over code: the notes' thumbnails/sprite, no-upscaling, aligned segments, signed delivery for unlisted video, analytics-based view counts and idempotent tasks are specified even where the code differs.

## Notes

- Validation iteration 1 of 3: all items pass. One internal-consistency pass fixed scenario cross-references (FR-033, AS-34, AS-35) and removed an overlap between AS-26 and AS-62 (shutdown behaviour now lives only in AS-62).
- Departures from the notes are recorded, not hidden: no time-chunk split and no antivirus scan of videos (Assumptions, `questions.md` LOCAL).
- Ready for `/speckit-clarify` (optional) or `/speckit-plan`.
