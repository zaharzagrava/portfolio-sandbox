# Quickstart: W06 — Admin feature-flag console

## Prerequisites
Dev stack running (API http://localhost:8000; run `bash scripts/sdd/stack-fix.sh api-ready` after any backend edit); seeded admin `SEED.admin`; Playwright starts the web dev server.

## Run (narrowest first; from `packages/web`)
1. Architecture rules (red before code, green after): `npx vitest run lib/architecture.test.ts`
2. Unit and component tests per phase: `npx vitest run lib/admin components/admin hooks/use-admin-flags.test.tsx lib/api/admin-flags.test.ts`
3. Backend shape proof (once): `/opt/sdd/repo/scripts/sdd/test-spec.sh flags-admin`, then `flags-lifecycle`
4. Journeys: `npx playwright test tests/admin-access.spec.ts --reporter=line --max-failures=1`, then `tests/admin-flags.spec.ts`
5. Visual: `npx playwright test tests/visual/admin-*.spec.ts --reporter=line --max-failures=1`
6. Final: `npx tsc --noEmit`, `npx eslint .`, `npx vitest run`, `next build`, `python3 scripts/livespec/check.py`

## Manual smoke
Sign in as admin → `/admin` → list → **New flag** (key `smoke-1`, owner prefilled) → editor opens, "Disabled", version 1 → add a staff rule with a 5% rollout, turn on **Enabled**, Save → **Kill switch** → History shows the entries newest first → Restore → Archive. As a member: `/admin/feature-flags` shows only the no-access panel.

## Ops artifacts
Success criteria that no automated test proves (each is also a row in `specs/UNVERIFIED.md`, status `not run`; none is described as verified):
- **SC-001** (kill in ≤ 3 interactions, "Killed" visible within 2 s of acceptance, phone and desktop): real-browser timing. How to run: the kill journey on the `mobile` and `desktop` projects against a deployed stack, with a stopwatch.
- **SC-002** (create a disabled flag in under 1 minute with key and owner): timed run by a person.
- **SC-008** ("what changed and by whom" found in under 30 s): usability check with an on-call admin.
- **SC-009** (shell and skeleton immediately, no layout shift): CLS measurement on a production build; the visual specs cover structure only.

SC-003, SC-004, SC-005, SC-006, SC-007 and SC-010 are proven by tests named in `test-plan.md` (SC-006 and SC-007 by axe scans and no-horizontal-scroll assertions in the visual specs).
