# Gaps: current code vs W06 spec

Files in scope (under `packages/web`): `app/admin/layout.tsx`, `app/admin/feature-flags/{page,feature-flags-client}.tsx`, `lib/api/admin.ts`, `lib/api/{client,errors}.ts`, `lib/{query-keys,providers}.tsx`, `hooks/use-auth.tsx`, `tests/{admin-flags.spec,helpers}.ts`, `vitest.config.ts`, `playwright.config.ts`, `next.config.ts`, `package.json`. This is the implementation agent's to-do list; spec IDs name what each item serves.

## A. Data flow and constitution VI

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | The page is a thin Server Component that renders one big client component; all data loads in the browser behind a spinner (no prefetch, no hydration) | `app/admin/feature-flags/page.tsx:1-5`, `feature-flags-client.tsx:1,39-42,150-152` | FR-002, FR-003, AS-63 |
| A2 | Query key is the literal `['admin','feature-flags']`; `queryKeys` has no `admin` group | `feature-flags-client.tsx:40,47,56`, `lib/query-keys.ts` | FR-003, AS-55, Provides `queryKeys.admin.flags` |
| A3 | Admin queries inherit the global 60 s `staleTime` and `refetchOnWindowFocus: false`; a kill state can be a minute old | `lib/providers.tsx:14-17` | FR-003 |
| A4 | Network calls live in a hand-typed `adminApi` object; responses are not parsed with contract schemas; `booleanFlag` builds the whole definition in the client | `lib/api/admin.ts:1-47` | FR-005, FR-020, AS-56 |
| A5 | The component calls API functions directly inside `useMutation`/`useQuery` bodies; no hooks module; a failed create/kill has no `onError` | `feature-flags-client.tsx:44-58` | FR-003, FR-050, AS-39 |
| A6 | The list expects a bare array; S38 returns `{items, nextCursor}`; no status filter, no paging, no view state in the URL | `lib/api/admin.ts:33-35`, `feature-flags-client.tsx:39-42` | FR-001, FR-010, AS-02, AS-04 |
| A7 | `useAuth()` from the writable context supplies the owner (`user?.email ?? "admin"`); W01 makes it read-only and a role-aware server read is needed for the guard | `feature-flags-client.tsx:6,36,45` | AS-10, FR-006 |
| A8 | The shared API client puts a bearer from JavaScript memory on every call and refreshes tokens in the browser | `lib/api/client.ts:15-18,42-47,66-82` | FR-005, AS-56 (W01 removes it; W06 must not depend on `setAccessToken`) |

## B. Behaviour versus spec

| # | Gap | Where | Spec |
|---|---|---|---|
| B1 | Create dialog makes an `enabled` flag with default variant `on`: live for everyone the moment it is saved; no `expectedVersion`; dialog form asks for description (required) and key (2+ chars) only | `lib/api/admin.ts:17-31,37-39`, `feature-flags-client.tsx:27-30,82-130` | AS-09, AS-10, AS-11, AS-12 |
| B2 | No editor at all: no variants, rules, conditions, rollout, bucketing, client-side, expiry, enabled switch, save, conflict handling | `feature-flags-client.tsx` (absent) | AS-17 – AS-31 |
| B3 | Kill fires on one click with no confirmation, is disabled unless `enabled`, and surfaces no result or error | `feature-flags-client.tsx:185-196` | AS-32, AS-33, AS-38, AS-39 |
| B4 | No restore, no archive, no read-only archived state | — | AS-36, AS-37 |
| B5 | State badge shows "Enabled" / "Off" from the `enabled` boolean; killed, disabled and archived look identical and are red | `feature-flags-client.tsx:180-184` | AS-01, AS-34 |
| B6 | No audit history view | — | AS-40 – AS-44 |
| B7 | No stale-flag report | — | AS-45, AS-46 |
| B8 | List states: one sentence for errors ("Failed to load feature flags."), a non-distinguished empty row, a spinner instead of skeletons; no retry | `feature-flags-client.tsx:150-173` | AS-05, AS-06, AS-07 |
| B9 | No problem+json handling anywhere (no 401/403/409/422/429/5xx/offline copy, no request reference) | `feature-flags-client.tsx`, `lib/api/errors.ts` (only a generic helper) | FR-050, Error catalogue, AS-47 – AS-53 |
| B10 | Row identity uses `flag.key` correctly, but the row test hook is `data-testid="flag-row"` | `feature-flags-client.tsx:176` | AS-65, questions (BREAKING) |
| B11 | The create form has no pending lock on fields, no double-submit guard beyond a disabled button, and no error display | `feature-flags-client.tsx:128-133` | AS-16 |
| B12 | The unsaved-changes protection, conflict banner, rate-limit countdown and offline banner do not exist | — | AS-25, AS-28, AS-50, AS-52 |

## C. Access control (P0515)

| # | Gap | Where | Spec |
|---|---|---|---|
| C1 | The admin layout has no guard: anonymous visitors and non-admins load the page, call the API and see "Failed to load feature flags." | `app/admin/layout.tsx:1-33` | FR-006, AS-47, AS-48 |
| C2 | No server session helper to read the role (`requireServerSession` / `getServerSession` come from W01) | — | FR-006, Requires W01 |
| C3 | No storefront entry point for admins (W07 navbar) and no `isAdmin` helper | — | AS-66, Provides `isAdmin` |
| C4 | The guard must sit inside a Suspense boundary and the layout must not await the session at the top (Cache Components) | `app/admin/layout.tsx` | FR-002 |

## D. Layout and accessibility

| # | Gap | Where | Spec |
|---|---|---|---|
| D1 | Sidebar is `hidden md:flex`, with no replacement below 768 px: no navigation on a phone; no top bar, drawer or "Open menu" | `app/admin/layout.tsx:15` | AS-59 |
| D2 | Header lacks "Back to marketplace" and the viewer; navigation has one hard-coded link with a permanent "active" style and no `aria-current` | `app/admin/layout.tsx:8-22` | AS-59, Provides navigation registry |
| D3 | Table has no caption, no mobile card layout, no row menu; the kill button is a bare "Kill Switch" with no row context in its name | `feature-flags-client.tsx:158-199` | AS-08, AS-58, AS-60 |
| D4 | Dialog form has no error summary, no focus to first invalid field, no `aria-describedby` wiring for server errors | `feature-flags-client.tsx:93-137` | AS-14, AS-15, AS-58 |
| D5 | No skeletons, no offline status region, no live regions for save, move or countdown | — | AS-52, AS-58, AS-63 |
| D6 | The root layout for admin has no `h1` ownership rule or focus-on-route-change | `app/admin/layout.tsx`, `feature-flags-client.tsx:72` | Layout section |

## E. Missing backend pieces (names the owning capability)

| # | Need | Owner | Notes |
|---|---|---|---|
| E1 | The whole S38 admin API of the new shape: `PUT` with `expectedVersion` and `201`/`200`, `status`, `restore`, `archive`, history pages, stale report, `{items, nextCursor}` list | **S38** | Exists only as a spec; the draft backend answers a bare array and has no `expectedVersion` (S38 `gaps.md` G24 names this file) |
| E2 | Forward `GET|PUT|POST /api/admin/flags/**` through the BFF session with bearer attached server-side, CSRF/origin checks, `Retry-After` and problem+json passed through | **S48** | W01 C-FWD extension (`questions.md` CONTRACT) |
| E3 | Problem body exposes the machine code as `code` (S38 FR-062 puts it in `type`) | **S38** / **S54** (exception filter) / **W01** (`problemFromError`) | `questions.md` CONTRACT |
| E4 | Full catalogue of `flag_definition_invalid` `path` patterns and `code` values, exported from contracts | **S38** | W06's copy table is exhaustive only then |
| E5 | `packages/contracts` has no source: `flagSchema`, `flagInputSchema`, `flagPageSchema`, `flagAuditPageSchema`, `staleFlagsSchema`, `problemSchema` and the constants `flagAttributes`, `flagOperators`, `flagBucketUnits`, `flagStatuses`, `flagLimits`, `flagKeyPattern` do not exist; `packages/web` has no dependency on the package | **S54** (contracts) / **S38** (flag schemas) | Blocks AS-14, AS-22, FR-007 |
| E6 | Resolve `actorId` to a display name or e-mail for the history (batch lookup of admins) | **S01** (export) composed by **S48** `libs/composition/bff` (IX.7 R2 aggregate, e.g. `GET /api/bff/admin/flags/{key}/history` returning `actor: {id, email} | null`) | Optional for this release; `questions.md` CONTRACT |
| E7 | A key-prefix filter `q` on `GET /api/admin/flags` (the console has no search; client-side filtering over one page would be wrong) | **S38** | Not required by the spec; recorded so it is not built in the browser |
| E8 | A storefront **Admin** menu entry for admins | **W07** | Consumes `isAdmin` |
| E9 | A dev-stack way to seed a flag with an expiry in the past and a flag with no evaluations, so the stale report journey shows rows | **S38** (seed) | Without it the journey asserts the report or the empty message only |

## F. Test tooling

| # | Gap | Where | Spec / test-plan |
|---|---|---|---|
| F1 | React Testing Library, `@testing-library/user-event`, `@testing-library/jest-dom` and MSW are not installed | `package.json` (devDependencies) | every `*.test.tsx` row |
| F2 | Vitest `include` covers only `lib/**/*.test.ts` and `hooks/**/*.test.ts`: no `.tsx`, nothing under `components/` or `app/` | `vitest.config.ts:7` | all component rows |
| F3 | Vitest has no React plugin / JSX transform config, no setup file (jest-dom matchers, MSW server, `cleanup`), and `jsdom` is the only environment | `vitest.config.ts` | all component rows |
| F4 | Playwright has one project (`chromium`); no `mobile` (390 × 844) project and no `tests/visual/` folder; no axe dependency (`@axe-core/playwright`) | `playwright.config.ts:37-45`, `package.json` | visual rows, AS-58 |
| F5 | `tests/helpers.ts` `login()` uses `returnUrl`; W01 moves to `returnTo`; no `createFlag`, `flagPath`, `adminLogin` | `tests/helpers.ts:29-35` | journeys |
| F6 | `tests/admin-flags.spec.ts` is one test using the removed dialog and `data-testid="flag-row"`; needs a rewrite into five journeys and a new `admin-access.spec.ts` | `tests/admin-flags.spec.ts:1-24` | journeys |
| F7 | The architecture test `lib/architecture.test.ts` (shared with W03/W04) does not exist yet; it must cover `app/admin`, `components/admin`, `hooks/use-admin-flags.ts`, `lib/api/admin-flags*.ts` | — | AS-55, AS-56 |
| F8 | A test double for `navigator.clipboard`, fake `online`/`offline` events, and a stub for the W01 session-ended flow are needed | — | AS-40, AS-50, AS-52 |
| F9 | The visual tests stub the backend with `page.route`; fixtures must be parsed by the contracts schemas once E5 exists | `tests/visual/*` | visual rows |

## G. Other

| # | Gap | Where | Spec |
|---|---|---|---|
| G1 | `/admin` redirect is a `redirects()` entry (kept); the new `/admin/feature-flags/new` and `/admin/feature-flags/[key]` routes do not exist, and `[key]` must treat a non-matching key as not-found without a request | `next.config.ts:46-49`, `app/admin/feature-flags/` | AS-31, AS-54 |
| G2 | No `not-found.tsx` under `app/admin/feature-flags/[key]` with the copy "We couldn't find that flag." | — | AS-31 |
| G3 | No shared timestamp formatter for "YYYY-MM-DD HH:mm UTC" in `<time>` | `lib/utils.ts` | FR-024 |
| G4 | Dependencies imply a form lib already present (`react-hook-form`, `@hookform/resolvers`, `zod`); the editor's nested arrays (variants, rules, conditions, slices) need a reducer or `useFieldArray`; either fits, but the form schema must not duplicate S38's rules | `package.json` | FR-007 |
