# Specification Quality Checklist: W05 — Product chat and the streamed shopping assistant sheet

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-07
**Feature**: [spec.md](../spec.md)

## Content Quality

- [ ] No implementation details (languages, frameworks, APIs) — **accepted deviation**: the task requires the spec to state constitution VI data-flow rules (query cache keys, same-origin calls, no browser-stored tokens, Server Component guard) and a `Cross-capability contracts` section with exact endpoint, hook and component names. These appear only in the `FR-0xx` data-flow requirements, AS-67–AS-70 and that section; user stories, the other scenarios and the success criteria are written as visible behaviour.
- [x] Focused on user value and business needs (stories are shopper journeys: open a chat, see unread, read and send, stay connected, see receipts, ask the assistant, resume or stop an answer, understand every refusal)
- [x] Written for non-technical stakeholders — scenarios read as visible behaviour with quoted copy; technical sections (FR data flow, contracts) are for engineers by design
- [x] All mandatory sections completed (User Scenarios & Testing, Requirements, Success Criteria, Assumptions; plus Scope, Cross-capability contracts, Pattern coverage)

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (0; every open choice is an Assumption and a tagged line in `questions.md`)
- [x] Requirements are testable and unambiguous (70 scenarios, each with exact copy, thresholds and roles; every one has a row in `test-plan.md`)
- [x] Success criteria are measurable (SC-001–SC-010 give times, percentages, counts)
- [ ] Success criteria are technology-agnostic — **partly**: SC-001–SC-009 are user-facing; SC-010 names browser storage and the console (a security outcome that cannot be stated without them)
- [x] All acceptance scenarios are defined (AS-01–AS-70 across 12 stories; every screen state: loading, empty, error, partial, unauthorized, offline/reconnecting)
- [x] Edge cases are identified (Edge Cases section plus the edge-case index in `test-plan.md`)
- [x] Scope is clearly bounded (Scope lists moderation screens, product-page link, navbar, bell, S47 Ask, gateway as out of scope)
- [x] Dependencies and assumptions identified (Cross-capability contracts Provides/Requires; Assumptions; 15 BREAKING, 12 CONTRACT, 14 LOCAL lines in `questions.md`)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (each FR names its scenarios)
- [x] User scenarios cover primary flows (open from product page, inbox/unread, send/read/delete/reply, live and reconnect, receipts/presence, layout and access, assistant ask/stream, resume/stop, errors, conversations, sheet layout, data-flow rules)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [ ] No implementation details leak into specification — **same accepted deviation as the first item** (required by the task for data flow and contracts)

## Layout, access and errors (task-specific)

- [x] Mobile (≤ 640 px) and desktop (≥ 1024 px) structure stated for `/chat` (AS-37, AS-38) and the sheet (AS-65); the 641–1023 px behaviour is stated (single pane)
- [x] Keyboard and screen-reader behaviour stated (AS-39, AS-66): roles, labels, focus order, announcements
- [x] Visible form of every backend error stated: S24 codes (AS-05, AS-18, AS-19, AS-35, AS-36), S46 problem codes (AS-56, AS-59), S46 stream errors and refusals (AS-57, AS-58), S51 stream failures (AS-24–AS-28), generic fallback (FR-062)
- [x] Every pattern-map row naming W05 (P0209, P0406) appears as requirements and scenarios
- [x] Backend rules are cited by ID, not re-specified; edge cases the API already proves are not re-tested in the UI (`test-plan.md` last column)

## Notes

- Two items stay unchecked by design: the spec deliberately names data-flow rules and exact contract names because the command requires them; they are confined to the FR data-flow list, AS-67–AS-70, SC-010 and *Cross-capability contracts*.
- Iteration 1 found and fixed: FR numbering collision (the chat "unavailable state" requirement was numbered inside the assistant block; renumbered FR-015 and all references updated).
- Cross-capability asks that need an owner decision are `[CONTRACT]` lines in `questions.md`; `gaps.md` section G lists the missing backend endpoints with their owning capability.
