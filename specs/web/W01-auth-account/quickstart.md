# W01 — Quickstart (validation guide)

## Prerequisites

Dev stack running (API `http://localhost:8000`; after backend edits wait for `GET /health/ready` = 200). In `packages/backend` env for the dev stack: `EMAIL_PROVIDER=memory`, `DEV_MAILBOX_ENABLED=true`. `pnpm install` in `packages/web`. Playwright starts the web dev server.

## Scenarios

| Goal | Command | Expected |
|---|---|---|
| Backend: forwarder | `scripts/sdd/test-spec.sh bff-forward` | green |
| Backend: session refresh and MFA cookie path | `scripts/sdd/test-spec.sh bff-session` | green, MFA cookie `Path=/` |
| Backend: reset, session revoke, MFA lifecycle, mailbox | `scripts/sdd/test-spec.sh "password-reset\|sessions-revoke\|mfa-lifecycle\|dev-mailbox"` | green |
| Web units and components | `cd packages/web && pnpm test` | all W01 files green |
| Static gates | `pnpm exec tsc --noEmit && pnpm lint && pnpm build` | no errors; no runtime-data-outside-Suspense error |
| Sign up, sign in, sign out | `pnpm exec playwright test tests/auth.spec.ts` | green |
| BFF session cookies and CSRF | `pnpm exec playwright test tests/bff-session.spec.ts` | green |
| Two-step journey | `pnpm exec playwright test tests/auth-mfa.spec.ts` | green |
| Password reset journey | `pnpm exec playwright test tests/auth-password-reset.spec.ts` | green (reads the link from the dev mailbox) |
| Devices | `pnpm exec playwright test tests/auth-sessions.spec.ts` | green |
| Layout and a11y | `pnpm exec playwright test tests/visual` | baselines match, axe 0 serious |
| Google | `tests/auth-google.spec.ts` | `fixme` until C-OIDC |
| Final | whole web suite once, then the capability's backend specs once | green |

## Ops artifacts

Criteria no automated test proves (also rows in `specs/UNVERIFIED.md`; never describe them as verified):

- **SC-001** (new visitor signed in within 60 s, keyboard only): run the sign-up and sign-in flow by hand with a stopwatch on a clean profile, keyboard only; record the time.
- **SC-002** (100 % of open tabs correct within 1 s across many tabs and changes): open 5 tabs, sign in/out in one, observe the others over 20 cycles; the automated test covers two tabs only.
- **SC-006** (two-step setup with saved recovery codes in under 2 minutes): time the flow with a real authenticator app on a clean account.
