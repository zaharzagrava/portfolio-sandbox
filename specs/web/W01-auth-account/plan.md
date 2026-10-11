# Implementation Plan: W01 — Auth and account (`packages/web` + backend gaps it needs)

**Branch**: `W01-auth-account` (spec directory only) | **Date**: 2026-10-11 | **Spec**: [spec.md](spec.md)

**Inputs**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted as written), constitution (`.specify/memory/constitution.md`), the `/speckit-plan` follow-ups from S02, S48 and W07. Next.js guides read: *Authentication*, *Authentication with Cache Components*, *Backend for Frontend*, *Forms*, *Testing/vitest*, *Testing/playwright*.

## Summary

Replace the in-memory-token session with the S48 token-handler session, and build the screens on it: `/register`, `/login`, `/login/mfa`, `/forgot-password`, `/reset-password`, `/account/security` (three tabs), and the real `AccountSlot` / `MobileAccountEntries` that W07 left as stand-ins. The approach:

1. **Browser side (`packages/web`)**: one `lib/api` layer (relative URLs, `X-CSRF-Token` from `__Host-bff-csrf`, no `Authorization`, no browser refresh), a typed `Problem` model with a copy catalogue, a read-only `useAuth()` over TanStack Query (`queryKeys.auth.session()`), action hooks, `BroadcastChannel('auth')` sync, server-only `getServerSession` / `requireServerSession`, and pages that are Server Components with small client leaves.
2. **Backend (`packages/backend`, schemas in `packages/contracts`)**: what the UI cannot work without and no built capability provides today (verified in code, 2026-10-11): authenticated forwarding of `/api/*` through the BFF session (C-FWD), `POST /api/bff/session/refresh` (C-REFRESH), the `__Host-bff-mfa` cookie `Path=/` fix, S01 password reset and session revocation, S02 recovery-code regeneration and factor disable, and a development-only mailbox read for the reset journey. C-OIDC is **not** built: Google stays gated by `AUTH_OIDC_ENABLED` (default off) and `auth-google.spec.ts` stays `fixme`.
3. **Cross-spec follow-ups** (see "Follow-ups from built specs") are requirements of this plan, each with a task-level home and a test.

## Technical Context

**Language/Version**: TypeScript 5 strict, Node 20+, React 19.2, Next.js 16.3.8 (Cache Components on); backend NestJS (existing)
**Primary Dependencies**: `@tanstack/react-query` 5, `zod` 4 (+ `@marketplace-sandbox/contracts`, new workspace dependency of `packages/web`), `react-hook-form` is **not** used (small controlled forms with plain state; see R-07), radix/shadcn `ui/*`, `sonner`, `lucide-react`. New: `qrcode` (client-side SVG, G6). Already installed by W07: RTL, user-event, jest-dom, msw, `@vitejs/plugin-react`, `@axe-core/playwright`.
**Storage**: browser: none besides the two BFF cookies (session HttpOnly, CSRF readable) and in-memory query cache. Backend: S01/S02 tables already exist; password-reset needs one table (`identity.password_reset_tokens`, digest only) and one migration (data-model.md).
**Testing**: Vitest (jsdom) + RTL + MSW (units, `test-plan.md` rows); Playwright projects `desktop`/`mobile` (journeys against the real dev stack; visual specs with `page.route` stubs); backend e2e through `scripts/sdd/test-spec.sh` for every new endpoint (happy, validation, 401, 403/IDOR, 404, 409, 429 where defined, VII.2/3).
**Target Platform**: evergreen browsers; Next on Node; BFF app behind the same origin (`next.config.ts` rewrites).
**Project Type**: web application (`packages/web`) with backend additions (`packages/backend/libs/composition/bff`, `libs/domains/identity`, `libs/domains/notifications`) and schemas (`packages/contracts`).
**Performance Goals**: no signed-out flash (AS-18); cross-tab update ≤ 1 s (AS-22); forwarding adds one hop, p95 overhead < 15 ms in the dev stack (not automated, UNVERIFIED not needed: no SC).
**Constraints**: `connect-src 'self'`; no token in any browser-reachable place; every non-GET carries CSRF; Server Components by default; no `proxy.ts` auth decision; no new direct `sequelize.transaction` (use `TransactionRunner.run`).
**Scale/Scope**: 6 pages + 1 redirect, ~30 components/modules in `packages/web`, 7 backend endpoints, 1 migration, 5 journey files, 3 visual files, ~38 unit files.

## Follow-ups from built specs (requirements of this plan)

| Source | Requirement | Plan home |
|---|---|---|
| S02 / S48 C2 | all items of gap C2: share one origin; `POST …/start` then navigate to `authorizationUrl`; `/login?error=<code>`, `/login/mfa`, `?linked=google`; switch on `code`; `recoveryCodesRemaining: 0` prompt | Phases 3, 5, 7. Google paths are built and unit-tested behind `AUTH_OIDC_ENABLED` (R-09); the `recoveryCodesRemaining: 0` prompt is AS-45 |
| S48 | `lib/api/session.ts` returns typed `code`s; screens switch on `code`; `X-CSRF-Token` on cookie-authenticated POSTs | Phase 2 (`session.ts` becomes the base of the new module, keeps `sessionApi` names or migrates callers in the same change) |
| S48 / S02 | MFA pending cookie `Path=/api/bff/session` is rejected by browsers for a `__Host-` name | Phase 1 backend task B-3: `MFA_PATH` → `/` in `session-cookies.ts`; update the S48 contract test that asserts the literal path; sibling bullet recorded in `gaps.md` |
| S48 | `bff-session.spec.ts` and `product-page.spec.ts` journeys | `bff-session.spec.ts` is added by this plan (sign-in via the BFF, cookies, CSRF, logout). `product-page.spec.ts` is W02's (sibling bullet) |
| W07 | reword AS-62 to "the shell streams first" (no build-time HTML shell) | Phase 9: reword AS-62 in `test-plan.md` only (this spec's own artifact) and assert via the `next build` gate + U-arch; see R-02 |
| W07 | own `lib/api/client.ts`: remove in-memory token and absolute `NEXT_PUBLIC_API_URL` | Phase 2 |
| W07 | replace `components/auth/account-slot.tsx` body (keep names/props); render Admin via W06's `isAdmin`; provide `problemFromError` | Phases 4 and 6 (`lib/problem.ts` stand-in is replaced by `lib/api/errors.ts`; `lib/problem.ts` re-exports so W07 imports keep working) |
| W07 | seed password: use `SEED.password`, never a literal | Phase 9 helpers and every journey |
| S01 / W01 | `app/api/auth/*` relays are a stand-in; remove them and `lib/api/auth-relay.ts` | Phase 2 (delete after the BFF session is wired; `tests/` that referenced them move to the BFF) |
| gaps.md | every item A–H, code fixes and constitution debt | Phase map below ("Gap coverage") |

## Constitution Check

*GATE: passes before research; re-checked after design (below).*

| Rule | Status | Note |
|---|---|---|
| I/II layering, routing | PASS | forwarding lives in `libs/composition/bff` (X.8.3: forwards unchanged to one owning endpoint, no aggregate); identity endpoints in `libs/domains/identity`; controllers thin, logic in services |
| III transactions | PASS (planned) | password-reset confirm (consume token + set password + revoke sessions) uses `TransactionRunner.run`/`@Transactional`; no new `sequelize.transaction`. Any touched file with a `// S54 T037 audit` site is migrated and the comment removed (task B-10 greps the touched files) |
| IV communication | PASS | reset request writes an outbox event consumed by notifications (S28); no cross-domain table access; BFF calls identity over its client |
| V.1–V.4 contracts, errors | PASS (planned) | every new body has a schema in `packages/contracts`; problem codes stable; reset request/registration anti-enumeration (uniform `202`, V.4); `errors[]` shape corrected to the wire shape (R-04) |
| VI.1 Server Components first | PASS (planned) | `page.tsx`/`layout.tsx` have no `"use client"` (U-arch); client leaves listed in data-model.md |
| VI.2 same origin, no tokens | PASS (planned) | removal of memory token/refresh; CSRF on every non-GET incl. login/logout (login is covered by the BFF `OriginGuard`; logout by `CsrfGuard`) |
| VI.3 network only in `lib/api` | PASS (planned) | ESLint `no-restricted-*` rules (gap A8) plus U-arch test |
| VI.4 state homes | PASS | session + security data in TanStack Query; `notice/error/tab/returnTo/linked` in URL; dialogs local state; **no** global store; BroadcastChannel is a transport, not a store |
| VI.5 authz not only in proxy | PASS | guards only redirect; BFF and APIs re-authorize |
| VI.6 stable keys | PASS | session ids/identity ids as keys |
| VI.7 text only | PASS | no `dangerouslySetInnerHTML`; QR rendered as SVG element tree from `qrcode` data, not injected HTML (R-08) |
| VI.8 minimal props | PASS | client leaves get only rendered fields (`SessionUser` subset) |
| VII.1 static gates | gate | `tsc`, ESLint, `next build`, U-arch |
| VII.2/3 backend e2e | PASS (planned) | one e2e spec per new endpoint group with happy + validation + 401 + 403/IDOR + 404/409 + 429 |
| VII.7 UI testing | PASS (planned) | per `test-plan.md`; journeys never stub the backend |
| VII.8 traceability | PASS | `test-plan.md` has one row per AS-01..AS-67 |
| VII.9 green run | gate | recorded at close-out |
| IX DB isolation | PASS | `password_reset_tokens` lives in the identity schema; no foreign reads |
| X module boundaries | PASS | web imports `@marketplace-sandbox/contracts` only (no backend lib); BFF imports identity only through its client |
| PR gate 6 contracts | PASS | schemas added to `packages/contracts` |

**Justified deviations (Complexity Tracking)**

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Backend work for S01/S02 P2/P3 stories inside a web plan | the screens (reset, device revocation, regenerate, disable) cannot exist without them and no other spec is scheduled to deliver them first | shipping the UI against `404`s is a fake; waiting blocks P2 stories. Scope kept to exactly the endpoints in `contracts/backend-endpoints.md`, following the S01/S02 contracts |
| A generic forwarder in the BFF (C-FWD) | removing the memory token breaks every authenticated call otherwise | per-endpoint BFF routes would be dozens of aggregates (violates IX.7 R2 intent); the forwarder adds no logic beyond identity attach |
| `BroadcastChannel` + `localStorage`-free sync | AS-22 needs cross-tab propagation | `storage` events would put state in `localStorage` (forbidden by VI.2 spirit) |
| `qrcode` dependency | QR must be rendered in the browser (secret never leaves the page) | hand-rolled QR encoder is more risk than a small audited library |

## Project Structure

### Documentation (this feature)

```text
specs/web/W01-auth-account/
├── spec.md  test-plan.md  gaps.md  questions.md  checklists/
├── plan.md            # this file
├── research.md        # decisions R-01..R-12
├── data-model.md      # browser entities, state transitions, one table
├── quickstart.md      # run guide + Ops artifacts
└── contracts/
    ├── backend-endpoints.md   # C-FWD, C-REFRESH, S01/S02 additions, dev mailbox
    └── web-modules.md         # exported names, signatures, URL contract
```

### Source code (repository root)

```text
packages/web/
├── app/
│   ├── (auth)/layout.tsx                  # shell (FR-050), Server Component
│   ├── (auth)/login/{page.tsx,login-form.tsx,auth-banner.tsx,google-button.tsx}
│   ├── (auth)/login/mfa/{page.tsx,mfa-form.tsx}
│   ├── (auth)/register/{page.tsx,register-form.tsx}
│   ├── (auth)/forgot-password/{page.tsx,forgot-password-form.tsx}
│   ├── (auth)/reset-password/{page.tsx,reset-password-form.tsx}
│   ├── account/security/{page.tsx,layout.tsx?,security-tabs.tsx,two-step-panel.tsx,recovery-codes-dialog.tsx,
│   │                     sessions-panel.tsx,sign-in-methods-panel.tsx}
│   ├── (auth)/mfa/**                      # DELETED (route removed)
│   └── api/auth/**                        # DELETED (relays)
├── components/auth/{account-slot.tsx,account-menu.tsx,problem-alert.tsx,password-input.tsx,code-input.tsx}
├── hooks/{use-auth.tsx,use-auth-actions.ts}
├── lib/api/{client.ts,csrf.ts,session.ts,errors.ts,auth.ts,account.ts,graphql.ts,sse-reader.ts}  # auth-relay.ts DELETED
├── lib/auth/{return-to.ts,guards.ts,session.server.ts,session-sync.ts,retry-after.ts,copy.ts,notices.ts}
├── lib/{query-keys.ts,providers.tsx,problem.ts,types.ts}   # safe-return-url.ts DELETED
├── next.config.ts                         # generic /api/:path* → BFF forwarder; /reset-password no-referrer rule
├── eslint.config.mjs                      # token / fetch restrictions
└── tests/{auth,auth-mfa,auth-password-reset,auth-sessions,auth-google,bff-session}.spec.ts, tests/visual/*, helpers.ts

packages/backend/libs/composition/bff/forward/       # ForwardController, route table, streaming pass-through (+ e2e spec)
packages/backend/libs/composition/bff/session/       # refresh endpoint, MFA cookie path
packages/backend/libs/domains/identity/              # password reset, session revoke, mfa regenerate/disable (+ e2e specs, migration)
packages/backend/libs/domains/notifications/         # reset e-mail template (fragment link); dev mailbox read
packages/contracts/src/{auth,bff}/                   # new schemas
```

**Structure Decision**: keep W07's layout. Server-only code sits in `*.server.ts` with `import 'server-only'`; client leaves are named after their UI role; one folder per route as today.

## Phases (dependency order; each ends green on its narrowest test)

| Phase | Content | Proof |
|---|---|---|
| 0 | `qrcode` + `@marketplace-sandbox/contracts` dependency, Vitest/Playwright config checks (tooling is mostly present from W07), ESLint restrictions, `lib/auth/copy.ts` skeleton | `pnpm test`, `tsc`, `eslint` |
| 1 | **Backend**: B-1 forwarder (C-FWD), B-2 refresh (C-REFRESH), B-3 MFA cookie path, B-4 reset request/confirm + e-mail, B-5 session revoke, B-6 MFA regenerate/disable, B-7 dev mailbox, B-8 schemas, B-9 `errors[].message` decision (R-04), B-10 `T037` audit of touched files | `scripts/sdd/test-spec.sh` per spec; wait `GET /health/ready` |
| 2 | `lib/api` rewrite (client, csrf, session, errors, auth, account, graphql, sse-reader); delete `auth-relay.ts`, `app/api/auth/**`, token functions | U-client, U-csrf, U-api, U-err, U-gql, U-sse |
| 3 | Session state: query keys, `useAuth`, action hooks, `session-sync`, `return-to`, `guards`, `session.server.ts`; adapt callers (dashboard, checkout, chat, seller view, assistant, admin) to the new API without changing their behaviour | U-auth, U-acts, U-ret, U-guard, U-sync |
| 4 | Shared UI: `ProblemAlert`, `PasswordInput`, `CodeInput`, `AuthBanner`, copy catalogue, auth shell layout | U-prob, U-pw, U-code, U-banner |
| 5 | Pages: register, login (+Google behind flag), MFA, forgot, reset; signed-in redirects; titles; `/reset-password` header rule; remove `/mfa` | U-reg, U-login, U-mfa, U-forgot, U-reset; `auth.spec.ts` |
| 6 | `AccountSlot`, `AccountMenu`, `MobileAccountEntries` (replace stand-in bodies) | U-menu, U-slot; VN |
| 7 | `/account/security`: tabs, sessions, two-step + dialogs, methods | U-tabs, U-sess, U-two, U-codes, U-meth; JM, JS |
| 8 | Other capabilities' callers use `returnTo`/`loginHref`/read-only `useAuth` (files only that must change to compile) | affected existing unit tests |
| 9 | Journeys (JA, JM, JR, JS, JG fixme, `bff-session.spec.ts`), visual baselines (VP, VN, VA), helpers (`register`, `login`, `signOut`, `totp`, `getResetLink`, `SEED.password`), reword AS-62 in test-plan, full suites, UNVERIFIED rows | whole web suite + backend capability suite once |

### Gap coverage (gaps.md → phase)

A1–A6, A8, B11–B12 → 2 · A7 (rewrites), D1–D3 → 1 and 2 · A9–A12, B13–B15 → 3 · B7–B8, B12 → 4 · B1–B5, B9–B10, F1, F3–F5 → 5 · C1–C5 → 6 · B6 → 7 · D4 → gated, not built · D5–D6, D8–D9 → 1 · E1 (contracts now exist, missing schemas added) E2 → 1/2 · F2 → 8 · G1–G3, G5 → done by W07, verified in phase 0; G4 (mobile project) verified in phase 0; G6 → 0 · G7–G10 → 9.

### Corrections to gaps.md assumptions (code is newer than the file)

`packages/contracts` has source now (`src/auth`, `src/bff`); W07 installed the test tooling and the `desktop`/`mobile` projects; S48 built the session endpoints; the three `lib/api/session.ts`/`account-slot.tsx`/`problem.ts` stand-ins exist. Still missing as stated: C-FWD, C-REFRESH, reset, session revoke, regenerate/disable, mailbox. Detail in `research.md` R-01.

## Post-design Constitution re-check

Unchanged from the table above; design artifacts add no store, no Server Action, no direct `sequelize.transaction`, no browser token, no cross-domain access. The only item to watch at review: the forwarder (R-03) must stay a pass-through with an allowlisted route table.
