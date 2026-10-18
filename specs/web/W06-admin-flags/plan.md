# Implementation Plan: W06 — Admin feature-flag console (`packages/web`)

**Branch**: `W06-admin-flags` (spec directory only) | **Date**: 2026-10-18 | **Spec**: [spec.md](spec.md)

**Inputs**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted as written; no human edit found), constitution (`.specify/memory/constitution.md`), the follow-ups handed to W06 by S38, W01, W02, W03, W07 (table below). Next.js guides read before code: *Authentication with Cache Components*, *Instant navigation*, *Data security*, *Forms*, and the `page`/`not-found` conventions under `packages/web/node_modules/next/dist/docs/` (AGENTS.md: this Next.js differs from training data).

## Summary

Replace the draft console (`app/admin/layout.tsx` without guard, `feature-flags-client.tsx` = list + create dialog + one-click kill, `lib/api/admin.ts`) with the console of the spec:

1. **Shell + guard** (`/admin/**`): Server Component layout with a static frame; `<AdminGuard>` (`requireServerSession` + `isAdmin`) inside `<Suspense>`; forbidden panel; desktop sidebar / mobile top bar + drawer; navigation registry; offline banner.
2. **List + stale report** (`/admin/feature-flags`): URL state (`status`, `cursor`, `tab`, `days`), first answer prefetched on the server and hydrated, row menu with kill / restore / archive, skeletons, error and empty states.
3. **Create** (`/new`): starts disabled and dark via `PUT expectedVersion: 0`.
4. **Editor** (`/{key}`): full draft (basics, variants, default/off, bucketing, ordered rules with conditions, fixed or percentage outcome), save with `expectedVersion`, conflict / killed / archived handling, unsaved-changes protection, lifecycle dialogs.
5. **History** (`/{key}?tab=history`): newest first, cursor paging, readable before/after diff.
6. **Plumbing**: `lib/api/admin-flags.ts` (+ `.server.ts`) parsing with `@marketplace-sandbox/contracts`, `queryKeys.admin.flags.*`, `hooks/use-admin-flags.ts`, catalogue of problem copy, pure modules under `lib/admin/flags/`.
7. **Delete** what is replaced: `lib/api/admin.ts`, `feature-flags-client.tsx`, the create dialog, `data-testid="flag-row"`, the one-test `tests/admin-flags.spec.ts`.

No backend feature work is needed (verified 2026-10-18, `research.md` R-01): the S38 admin API of the new shape exists (`flags-admin.controller.ts`, its e2e specs) and `packages/contracts/src/experimentation/flags.ts` exports the schemas. Backend touch is limited to verification and to the three `[CONTRACT]` asks that turn out to be real gaps (R-01, R-02), each with a gate-sized task.

## Technical Context

**Language/Version**: TypeScript 5 strict, Node 20+, React 19.2, Next.js 16 (Cache Components on, per-request root layout because of the CSP nonce).
**Primary Dependencies**: `@tanstack/react-query` 5, `zod` 4 + `@marketplace-sandbox/contracts` (already a dependency), `react-hook-form` is **not** used for the editor (R-05: a `useReducer` draft with pure `toDraft`/`toFlagInput`), shadcn primitives in `components/ui` (`dialog`, `dropdown-menu`, `sheet`, `switch`, `select`, `tabs`, `table`, `skeleton`, `sonner`), `lucide-react`. **No new runtime dependency.**
**Storage**: none in the browser (no storage of any kind, AS-56); query cache in memory; the draft is local state. No backend storage change.
**Testing**: Vitest + RTL + user-event + MSW + jest-dom (all installed), Playwright `desktop`/`mobile` projects (exist), `@axe-core/playwright` (installed) through `tests/visual/axe.ts`, backend e2e through `scripts/sdd/test-spec.sh`. Static gates: `tsc --noEmit`, ESLint, `next build`, `lib/architecture.test.ts`.
**Target Platform**: evergreen browsers; Next on Node behind the same-origin BFF forwarder (`/api/:path*` → `/api/bff/f/:path*`, already forwards `/api/admin/flags/**`).
**Project Type**: web application (frontend only).
**Performance Goals**: SC-001/SC-009 timings are real-browser measurements → UNVERIFIED rows; structure (skeleton shell, one hydrated first answer, 1 s countdown tick) is unit/visual tested.
**Constraints**: relative same-origin URLs only; no `Authorization`, no token in JS; no new Context or global store; no `use cache`; no `instant = false`; no storage; no flag body in logs/analytics; no new direct `sequelize.transaction`.
**Scale/Scope**: 5 routes + not-found, ~30 components/modules, 2 `lib/api` modules, 1 hooks module, 8 pure `lib/admin/flags/*` modules, ~22 Vitest files, 2 journey files, 4 visual files.

## Follow-ups from built specs (requirements of this plan)

| Source | Requirement | Plan home / test |
|---|---|---|
| S38 | `expectedVersion` on every `PUT` (0 to create) | `toFlagInput(draft, expectedVersion)` (Phase 2), `useSaveFlag` (Phase 3); AS-09, AS-18, AS-28 units |
| S38 | read `status`, not only `enabled`; badges Enabled/Disabled/Killed/Archived | `StatusBadge` (Phase 4); AS-01 unit |
| S38 | page lists and history with `nextCursor` | `params.ts` + `flag-list`, `flag-history` (Phases 2, 4, 6); AS-04, AS-42 |
| S38 | use `kill`, `restore`, `archive` | `useKillFlag/useRestoreFlag/useArchiveFlag` + `lifecycle-dialogs` (Phase 5); AS-32…AS-39 |
| S38 | `listFlags` reads `.items` until W06 adds paging | `lib/api/admin.ts` is deleted; `listFlags` parses `flagPageSchema` (Phase 2) |
| W01 | `returnTo`, `loginHref`, `requireServerSession`, read-only `useAuth()`; no `Authorization`, no `setAccessToken`/`refreshSession`; admin layout guard | `AdminGuard` (Phase 1), owner prefill + "You" from `useAuth().user` (Phases 5, 6); AR rule "no token" over W06 paths |
| W02 | `formatMoney(minor, currency)` | **Not applicable**: W06 shows no money (verified: no `formatMoney` in `app/admin`). W04 owns the seller dashboard call; recorded in `gaps.md` "Sibling-spec follow-ups" |
| W03 | admin layout needs the server guard (`requireServerSession` + role) | `AdminGuard` (Phase 1); AS-47, AS-48 |
| W07 | provide `isAdmin(user)` at `lib/admin/is-admin.ts`; `/admin` redirect stays in `next.config.ts` | `isAdmin` already exists as a stand-in (`'ADMIN'` check): Phase 1 finalises the type to `SessionUser \| null` and adds `is-admin.test.ts` (AS-66); redirect untouched (G1) |
| gaps.md | every item A–G | "Gap coverage" below |

## Constitution Check

*GATE: passes before research; re-checked after design.*

| Rule | Status | Note |
|---|---|---|
| I/II layering, routing | PASS (n/a) | no backend code added; `/admin` redirect stays in `next.config.ts`; no `proxy.ts` decision (FR-006) |
| III transactions | PASS (n/a) | no backend file is planned to change. If R-01/R-02 verification forces a backend edit, the edited file is grepped for `// S54 T037 audit` and any direct `sequelize.transaction` migrated to `TransactionRunner.run`/`@Transactional`; none is added |
| IV communication | PASS | one HTTP API (S38 via the BFF forwarder); no cross-domain reads |
| V.1–V.4 contracts, errors | PASS (planned) | responses parsed with `flagSchema`, `flagPageSchema`, `flagAuditPageSchema`, `staleFlagsSchema`; request built from `flagInputSchema`; copy by stable `code`/status, never `detail` (R-02 for the `code` source) |
| V.6 idempotency | PASS | a save is naturally idempotent via `expectedVersion` + equal-definition no-op `200` (AS-27); kill/archive are idempotent (`204`); create double-submit guarded (AS-16) |
| V.7 forward compatibility | PASS (planned) | unknown operator/attribute → read-only JSON rule (Edge Cases) |
| VI.1 Server Components first | PASS (planned) | every `page.tsx`/`layout.tsx` is a Server Component with a static shell; `'use client'` only on the listed leaves (data-model.md "Client leaves") |
| VI.2 same origin, no tokens | PASS | relative `/api/admin/flags…`, CSRF header via the shared client, no storage; the draft lives in memory only |
| VI.3 network only in `lib/api/*` | PASS (planned) | `lib/api/admin-flags.ts`, `.server.ts`; AR enforces |
| VI.4 state homes | PASS | server data in TanStack Query under `queryKeys.admin.flags.*`; status/tab/days/cursor in the URL; draft via `useReducer`; **no** Context, **no** store |
| VI.5 authz again | PASS | guard is convenience; every call is authorized by S38; `401`/`403` handled in the UI (AS-48, AS-49) |
| VI.6 stable keys | PASS (planned) | flag key, audit `id`, rule `id`, variant key; AR rejects index keys in W06 files (rule/variant rows use a draft-local stable `uid` for not-yet-saved entries) |
| VI.7 text only | PASS (planned) | all user content rendered as text; no `dangerouslySetInnerHTML`; AS-64 test |
| VI.8 minimal props | PASS | server page hands the first answer through hydration, rows get display fields only |
| VI.9 no business rules in web | PASS | only syntactic checks (AS-10, AS-15, AS-30) and presentation of legal actions; closed sets and limits imported from contracts |
| VII.1 static | gate | `tsc`, ESLint, `next build`, AR |
| VII.2/3 backend e2e | n/a / gate | existing S38 admin e2e specs re-run once (Phase 0) to prove the shape; no new cases unless a gap is found |
| VII.7 UI testing | PASS (planned) | journeys happy path only; every failure form = MSW unit test |
| VII.8 traceability | PASS | `test-plan.md` has one row per AS-01..AS-66 |
| VII.9 green run | gate | fallbacks forced: list failure/refetch failure (AS-07), lost save (AS-27), conflict (AS-28), killed-while-editing (AS-35), rate-limit countdown (AS-50), offline (AS-52) |
| X boundaries | PASS | web imports `@marketplace-sandbox/contracts` only |

**Complexity Tracking**: no deviation. (`react-hook-form` deliberately not used: nested arrays with stable ids and a pure `toFlagInput` fit a reducer better; it adds no rule that S38 does not own — R-05.)

**Post-design re-check**: unchanged. Residual risks: (a) Problem body `code` vs `type` (R-02), handled by one normaliser; (b) `flag_definition_invalid` errors use `{path, code}` while W01's `Problem.errors` is `{field, code}` — one adapter reads the raw body (R-03); (c) S48 forwarder streams/headers: `Retry-After` pass-through verified in Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/web/W06-admin-flags/
├── spec.md  test-plan.md  gaps.md  questions.md  checklists/
├── plan.md            # this file
├── research.md        # decisions R-01..R-09 and verified facts
├── data-model.md      # view models, state homes, draft ↔ input mapping, client leaves
├── quickstart.md      # run guide + Ops artifacts
└── contracts/
    └── web-modules.md # routes, exported names, signatures, query keys, copy catalogue keys
```

### Source code (repository root)

```text
packages/web/
├── app/admin/
│   ├── layout.tsx                         # Server: static frame; <Suspense><AdminGuard>…; no top-level session await
│   └── feature-flags/
│       ├── page.tsx                       # Server: heading + tabs frame static; Suspense → list | stale (searchParams awaited inside)
│       ├── loading.tsx? (only if the route needs it; skeletons live in components)
│       ├── new/page.tsx                   # Server: static form frame
│       ├── [key]/{page.tsx,not-found.tsx} # Server: key pattern check → notFound() with no request; prefetch detail/history
│       └── feature-flags-client.tsx       # DELETED
├── components/admin/
│   ├── admin-shell.tsx  admin-nav.tsx  admin-drawer.tsx  admin-offline-banner.tsx  admin-guard.tsx  forbidden-panel.tsx
│   └── flags/
│       ├── flag-tabs.tsx  flag-list.tsx  flag-list-skeleton.tsx  status-badge.tsx  status-tabs.tsx  flag-row-actions.tsx
│       ├── stale-report.tsx  stale-skeleton.tsx
│       ├── create-flag-form.tsx
│       ├── flag-editor.tsx  editor-header.tsx  editor-skeleton.tsx  basics-section.tsx  variants-editor.tsx  bindings-section.tsx
│       ├── rules-editor.tsx  rule-card.tsx  condition-row.tsx  outcome-editor.tsx  help-card.tsx  save-bar.tsx
│       ├── notices.tsx (killed / archived / disabled / client-side banners)  conflict-banner.tsx  unsaved-guard.tsx
│       ├── lifecycle-dialogs.tsx  flag-history.tsx  history-entry.tsx  history-skeleton.tsx  flag-problem.tsx  copy-button.tsx
├── hooks/use-admin-flags.ts               # queries + 3 lifecycle mutations + useSaveFlag
├── lib/
│   ├── query-keys.ts                      # + admin.flags.{all,list,detail,history,stale}
│   ├── providers/query defaults           # admin queries: staleTime 0, refetchOnWindowFocus true (per-query options in the hooks, not global)
│   ├── api/admin-flags.ts  admin-flags.server.ts   # replace lib/api/admin.ts (DELETED)
│   ├── admin/{is-admin.ts,nav.ts}
│   └── admin/flags/{params.ts,starter.ts,draft.ts,to-flag-input.ts,diff.ts,problem-paths.ts,copy.ts,format-time.ts,transitions.ts}
└── tests/{admin-flags.spec.ts (rewritten: 5 journeys),admin-access.spec.ts,helpers.ts (+createFlag,flagPath,adminLogin; login returnTo already moved)}
    tests/visual/admin-{shell,list,editor,history}.spec.ts

docs/spec/capabilities/W06-admin-flags.md  # living spec page, written first (cross-spec rule 0)
```

**Structure Decision**: follow W01/W03/W05 layout (server modules `*.server.ts` with `import 'server-only'` reusing `readAsMember`; pure logic in `lib/admin/flags/*` with table-driven tests next to the code; client leaves named by UI role). The spec names `lib/api/admin-flags.server.ts`; W05 used `lib/server/`. This plan follows the spec's name and imports the shared `readAsMember`.

## Decision tables

**Rendering and cache** (FR-002): no `use cache`; no `instant = false`. Layout: static frame outside `<Suspense>`; the guard is a component inside it (reads cookies). Pages: heading + tabs frame + skeleton static; `searchParams`/`params` awaited inside the boundary (`params` of `[key]` is a Promise; the pattern check runs there and calls `notFound()` before any fetch). First answer: `getFlagPage/getFlag/…` via `readAsMember` into `queryClient.setQueryData(queryKeys.admin.flags.*, data)` → `HydrationBoundary`; a failed prefetch is left out and the client reads again (AS-07). Responses are per-user: never cached by the server.

**Query defaults** (FR-003, A3): every admin hook passes `staleTime: 0`, `refetchOnWindowFocus: true`, `retry` limited (no retry on 4xx). The global 60 s default is left alone (other capabilities).

**Draft** (FR-021): `useReducer(draftReducer, flag, toDraft)`; actions: `edit`, `addVariant`, `removeVariant`, `addRule`, `moveRule`, `addCondition`, … `reset(flag)` (after save / Load latest), `rebase(version)` only through `reset`. The reducer holds `basisVersion`; `toFlagInput(draft)` is pure and converts percent → basis points, lines → arrays, JSON text → value, and emits `rollout` xor `variant`. A background refetch never touches the draft; it only updates header and badges (Edge Cases).

**Unsaved protection** (FR-023): `beforeunload` listener while dirty + a click-capture guard on same-origin `<a>` inside the admin shell that opens the discard dialog (no router API is experimental; `router.push` calls made by the app itself go through `confirmLeave()`).

**Errors** (FR-050): `lib/admin/flags/copy.ts` maps `(status, code)` → copy/placement; `problem-paths.ts` maps `{path, code}` of a `422` to a form field id; `flag-problem.tsx` renders W01's `<ProblemAlert />` for generic codes and the catalogue for flag codes; `Retry-After` countdown reuses `lib/auth/retry-after.ts`.

**Session ended** (AS-49): `401` is handled by the shared client's W01 interceptor (runs the session-ended flow once); W06 adds only the dirty-draft sentence through a draft-dirty flag read by the flow's toast description (R-07).

## Phases (dependency order; each ends green on its narrowest test)

| Phase | Content | Proof |
|---|---|---|
| 0 | Re-read AGENTS.md + guides; **living spec first**: create `docs/spec/capabilities/W06-admin-flags.md` (rules with `[proof]`/`[code]` that stay true; no `*.reviewed.json`); verify backend shape (R-01): run the S38 admin e2e specs once through `test-spec.sh`, check problem body `code`, `status=archived` ± `includeArchived`, `Retry-After` through the forwarder; extend `lib/architecture.test.ts` with the W06 rules **failing first** (no `fetch`/`axios`/`EventSource` in `components/admin`, `hooks/use-admin-flags.ts`; keys only from `query-keys.ts`; no storage/token/`console.*` of bodies; no `dangerouslySetInnerHTML`; no index keys; no `use cache`/`instant = false` under `app/admin`; no Context/store) | `vitest run lib/architecture.test.ts` (red then green), `python3 scripts/livespec/check.py` |
| 1 | Shell + access: `lib/admin/{is-admin,nav}.ts`, `admin-guard`, `forbidden-panel`, `admin-shell` (sidebar / top bar / drawer / `aria-current` / offline banner), `app/admin/layout.tsx` rewritten, route focus on `h1`; `tests/admin-access.spec.ts` | `is-admin.test.ts`, `admin-guard.test.tsx`, `admin-shell.test.tsx`; `playwright test admin-access` |
| 2 | Plumbing: `query-keys.ts` (`admin.flags`), `lib/api/admin-flags.ts` + `.server.ts` (schema-parsed, CSRF through shared client, problem raw-body reader), `params.ts`, `format-time.ts`, `transitions.ts`, `starter.ts`, `draft.ts`, `to-flag-input.ts`, `diff.ts`, `problem-paths.ts`, `copy.ts`; `hooks/use-admin-flags.ts` | `params.test`, `draft.test`, `diff.test`, `problem-paths.test`, `admin-flags.test.ts`, `use-admin-flags.test.tsx` |
| 3 | List page: server page + prefetch + hydration, `flag-list`, status tabs (URL), paging links, skeleton, empty/error states, `status-badge`, `flag-row-actions` (menu; actions call the Phase 5 dialogs via a shared hook — built in the same pass) | `flag-list.test`, `flag-row-actions.test` |
| 4 | Create page + form (starter, owner prefill, field/summary errors, double-submit) and not-found for `[key]` | `create-flag-form.test` |
| 5 | Editor: header, notices, basics, variants, bindings, rules/conditions/outcomes, save bar, conflict/killed/archived/lost-response, unsaved guard, lifecycle dialogs (kill/restore/archive/discard) | `flag-editor.test`, `variants-editor.test`, `rules-editor.test`, `lifecycle-dialogs.test` |
| 6 | History tab + stale report + tab frame | `flag-history.test`, `stale-report.test` |
| 7 | Layout polish + a11y (mobile frame, docked save bar, 44 px targets, live regions) | visual specs |
| 8 | Delete old code: `lib/api/admin.ts`, `feature-flags-client.tsx`, `data-testid="flag-row"`; lint clean; grep proves no importer of `adminApi`/`booleanFlag` | `tsc`, ESLint, AR |
| 9 | Journeys (`admin-flags.spec.ts`, `admin-access.spec.ts`), visual baselines, `UNVERIFIED.md` rows, `## Sibling-spec follow-ups` and `## Spec changes` in `gaps.md`, whole web Vitest suite once, `next build` | `playwright test admin-flags admin-access`, `vitest run`, `next build` |

## Test tooling (gaps F)

F1–F3 are **already satisfied** (RTL, user-event, jest-dom, MSW installed; Vitest `include` covers `components/ app/ lib/ hooks/` `.ts(x)`; React plugin + setup file present). F4: `mobile` project, `tests/visual/` and axe helper exist. Remaining: F5 `createFlag`, `flagPath`, `adminLogin` in `tests/helpers.ts` (`login()` already uses `returnTo`); F6 rewrite of the journeys; F7 W06 rules in `lib/architecture.test.ts`; F8 clipboard / online-offline / session-ended test doubles in `vitest.setup.ts` or per-test helpers under `components/admin/flags/test-utils.tsx`; F9 visual fixtures parsed by the contracts schemas.

## Gap coverage (gaps.md → phase)

| Gaps | Phase | Gaps | Phase |
|---|---|---|---|
| A1–A3 | 2, 3 | D1–D2 | 1 |
| A4–A5 | 2 | D3–D5 | 3, 4, 5, 7 |
| A6 | 2, 3 | D6 | 1 (route focus), 5 |
| A7–A8 | 2, 4, 6 | E1, E5 | satisfied (R-01); E2 satisfied (R-04) |
| B1, B9–B11 | 4 | E3 | 0 (R-02) |
| B2, B12 | 5 | E4 | 0 (R-03: contracts export exists) |
| B3–B5 | 3, 5 | E6, E7, E9 | recorded (`gaps.md` Sibling-spec follow-ups; no code) |
| B6–B7 | 6 | E8 | W07 (sibling bullet) |
| B8 | 3 | F1–F9 | "Test tooling" above |
| C1–C4 | 1 | G1–G2 | 4, 5 |
| G3 | 2 (`format-time.ts`) | G4 | 2, 5 (reducer, R-05) |
