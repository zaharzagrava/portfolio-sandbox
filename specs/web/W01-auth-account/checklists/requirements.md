# Specification Quality Checklist: W01 — Auth and account (`packages/web`)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-06
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs) — see note 1
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders — see note 2
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain (searched `spec.md`, `questions.md`, `test-plan.md`, `gaps.md`: 0)
- [x] Requirements are testable and unambiguous (every FR cites the scenarios that prove it; exact copy is in FR-043/FR-044)
- [x] Success criteria are measurable (SC-001..SC-008 carry a time, a count or 100 %/0 thresholds)
- [x] Success criteria are technology-agnostic (no framework, library or storage name; "address bar" and "browser storage" are user-observable)
- [x] All acceptance scenarios are defined (AS-01..AS-67, each with a test-plan row: 67 of 67)
- [x] Edge cases are identified (Edge Cases section; each names its scenario)
- [x] Scope is clearly bounded (Scope: in/out lists, W07/W03/S-capability hand-offs, Google gated by FR-045)
- [x] Dependencies and assumptions identified (Cross-capability contracts Requires list; Assumptions; 13 `[CONTRACT]` lines in `questions.md`)

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria (FR → AS mapping; the Pattern coverage table maps P0504, P0512, P0903)
- [x] User scenarios cover primary flows (register, sign in, second step, reset, account security, sessions, sign-out, navbar, expiry, CSRF/token rules)
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification — see note 1

## Notes

1. **Scoped exception to "no implementation details".** The task brief requires (a) constitution VI data-flow rules (server data in TanStack Query with keys from `lib/query-keys.ts`, network calls only in `lib/api/*`, Server Components by default, no tokens in browser JavaScript) stated as requirements, (b) a `## Cross-capability contracts` section with exact names, and (c) the observable cookie/header contract (`__Host-bff-csrf`, `X-CSRF-Token`). Those names appear only in *Requirements → Data flow and boundaries*, FR-020..FR-031, and *Cross-capability contracts*. User Stories, Scenarios and Success Criteria describe visible behaviour; where they cite a header, cookie or route it is the externally visible contract.
2. **Audience.** User stories and scenarios are plain language; the Requirements and contracts sections are written for the implementation agent and reviewers, as the SDD runbook defines for web specs.
3. **Validation rounds**: 1 (two corrections made after the first pass: session-ended behaviour on public pages, AS-26/FR-008, and test-plan/questions updated to match).
4. **Items for human review first** (`questions.md`): the BFF forwarding contract (C-FWD), the role-refresh endpoint (C-REFRESH), the OIDC/BFF session unification (C-OIDC), no automatic sign-in after registration (D1), and the reset-link fragment (D2).
