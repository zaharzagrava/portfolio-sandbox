# Specification Quality Checklist: S02 — TOTP MFA, Google OIDC (PKCE), Account Linking (identity)

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-05
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

Validation run 1 (of max 3): all items pass. Evidence and deliberate exceptions:

- **Implementation details**: a scan of `spec.md` for storage, framework and library names (Redis, Postgres, Sequelize, DynamoDB, Kafka, Nest, JSONB, otplib, openid-client) finds none (the only textual hit is the word "rediscovers"). What remains is deliberate: security standards the notes and constitution mandate as behaviour (TOTP/RFC 6238, PKCE S256, `state`, `nonce`, `__Host-` cookies, HttpOnly/SameSite), and, inside **Cross-capability contracts** only, exact export, endpoint, event and policy names that later specs must reference. Technology choices (where the replay step, flows and challenge state live; table versus columns) are left to the plan and `gaps.md`.
- **Non-technical readers**: the subject is security infrastructure, so the primary reader is the engineering reviewer; every user story opens with a plain-language description of what the person experiences and why it matters.
- **Testability**: all 66 acceptance scenarios (AS-01…AS-66) have concrete inputs and exact outcomes (status, code, headers, cookies, persisted state, events). Every FR is referenced by at least one scenario. `test-plan.md` maps all 66 scenarios to exactly one row each (66 rows, identical IDs) and adds the VII.3 per-endpoint coverage table.
- **Notes coverage**: P0513 (Authorization Code + PKCE, `state`, `nonce`, exact redirect URI, ID-token validation, ID token never an API credential) → FR-040–FR-048, AS-29–AS-42; 05/02 §5 (TOTP, hashed single-use recovery codes, rate limit per account and per IP, re-authenticate for sensitive actions) → FR-001–FR-025, AS-01–AS-27; §4 (link by e-mail only when verified) → FR-060–FR-066; §8 and §9 (tenant trust, SSRF through issuer URLs, envelope-encrypted secrets) → FR-003, FR-066, FR-070, FR-071. Deliberately not built, with reasons in Assumptions/`questions.md`: passkeys, SMS, device trust, native-app OIDC.
- **Clarification markers**: 0. Every open choice is recorded as a default in the Assumptions section and as a tagged line in `questions.md` (BREAKING 16, CONTRACT 9, LOCAL 12; BREAKING lines first).
- **Cross-capability contracts**: S01's requirements on S02 (`isSecondFactorEnrolled`, `/auth/mfa/*`, `/auth/oidc/*`, sessions only through `SessionIssuer.issue`, e-mail linking only when verified, wipe of password and sessions for unproven accounts) are all honoured; the one deviation, S02's need for a first factor and single-use in the challenge helpers, is raised as a `[CONTRACT]` line.
- **Success criteria** are expressed as user and operator outcomes (percentages, counts, time limits); none names a technology.
