# Tasks: W06 — Admin feature-flag console (`packages/web`)

**Input**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted), `plan.md`, `research.md`, `data-model.md`, `contracts/web-modules.md`, `quickstart.md`.
**Paths**: all paths are under `packages/web/` unless they start with `docs/`, `specs/`, `scripts/` or `packages/`. Backend is not changed (R-01); if verification forces a backend edit, migrate any `// S54 T037 audit` site in the touched file and add no direct `sequelize.transaction`.
**Test-first**: for every test-plan row the failing test task precedes its code task. Run only the narrowest test (`npx vitest run <file>`), the full web Vitest suite once at the end (T116). Runtime proofs (journey/visual suites, fresh stack, standalone boot) are deferred to the final checkpoint; no task here runs them.
**Read first (T001)**: `packages/web/AGENTS.md` and the Next.js guides named in `plan.md`.

## Format: `- [ ] [ID] [P?] [Story] Description with file path`

---

## Phase 1: Setup (living spec, guards, test tooling)

- [X] T001 Read `packages/web/AGENTS.md` and the guides in `packages/web/node_modules/next/dist/docs/` (Authentication with Cache Components, Instant navigation, Data security, Forms, `page`/`not-found` conventions) before writing any code.
- [X] T002 Living spec first (cross-spec rule 0): create `docs/spec/capabilities/W06-admin-flags.md` with the rules and behaviours of the console (guard, list, create-dark, editor with `expectedVersion`, kill/restore/archive, history, stale report, error catalogue) using `[proof: ...]` and `[code: ...]` markers that point at files created below; do not create or edit any `*.reviewed.json`; run `python3 scripts/livespec/check.py` at the end (T114).
- [X] T003 [P] Add the W06 rules to `lib/architecture.test.ts` (create the file if absent, shared with W03/W04): over `app/admin`, `components/admin`, `hooks/use-admin-flags.ts`, `lib/api/admin-flags*.ts`, `lib/admin` assert no `fetch`/`axios`/`EventSource` in components or hooks, query keys only from `lib/query-keys.ts`, no `localStorage`/`sessionStorage`/token/`Authorization`/`setAccessToken`/`refreshSession`, no `console.*` of flag bodies, no `dangerouslySetInnerHTML`, no array index as `key`, no `use cache` and no `instant = false` under `app/admin`, no new Context or store, only relative `/api/admin/flags` paths. It must fail first (gaps F7, AS-55, AS-56).
- [X] T004 [P] Add test doubles in `components/admin/flags/test-utils.tsx`: render helper with QueryClient + MSW + `useAuth` stub, `navigator.clipboard` stub, `online`/`offline` event helpers, W01 session-ended stub, problem+json fixture builders parsed by the contracts schemas (gaps F8, F9).
- [X] T005 [P] Add `createFlag(page, key, options?)` (through the UI, lands on the editor, returns key), `flagPath(key, tab?)` and `adminLogin(page)` (wraps `login(page, SEED.admin, SEED.password, '/admin/feature-flags')`) to `tests/helpers.ts` (gaps F5; `login()` already uses `returnTo`).
- [X] T006 Verify the backend shape once (R-01, gaps E1/E4/E5): run `/opt/sdd/repo/scripts/sdd/test-spec.sh flags-admin` then `flags-lifecycle`; read the exception filter / one e2e body to decide where the machine code lives (`code` vs tail of `type`, R-02, gaps E3) and `Retry-After` pass-through of the `/api/:path*` forwarder (R-04, gaps E2); record the answers in `gaps.md` under `## Sibling-spec follow-ups` (S54/W01 for `code`, S48 only if `Retry-After` is dropped). Edit the backend only if a shape test fails.

---

## Phase 2: Foundational (plumbing every story needs)

**⚠️ No story starts before this phase is done.** Each pure module: test file first (red), then the module.

- [X] T007 [P] Test `lib/admin/is-admin.test.ts` (role table: ADMIN true; USER, SELLER, MODERATOR, null false) — AS-66.
- [X] T008 Finalise `lib/admin/is-admin.ts`: `isAdmin(user: SessionUser | null): boolean` = `user?.role === 'ADMIN'` (W07 follow-up).
- [X] T009 [P] Test `lib/admin/flags/params.test.ts`: `parseListParams` (status `all|enabled|disabled|killed|archived`, unknown → `all`, cursor), `parseStaleParams` (`days` 1–30, default 14, out-of-range → 14), `parseHistoryParams`, `listHref` (changing status drops cursor; `archived` adds `includeArchived=true`), `isFlagKey` against `FLAG_KEY_PATTERN` (AS-02, AS-04, AS-46, AS-54).
- [X] T010 Implement `lib/admin/flags/params.ts` (one parser per page; the same module builds the links; imports `FLAG_KEY_PATTERN`, `FLAG_STATUSES` from `@marketplace-sandbox/contracts`).
- [X] T011 [P] Test `lib/admin/flags/format-time.test.ts` (`formatUtc('2026-10-18T14:03:00Z')` → `2026-10-18 14:03 UTC`, no locale) then implement `lib/admin/flags/format-time.ts` (slice of `toISOString()`, R-08) (gaps G3, FR-024).
- [X] T012 [P] Test `lib/admin/flags/transitions.test.ts` then implement `lib/admin/flags/transitions.ts`: `availableActions(status)` — `enabled → kill`; `disabled → kill, archive`; `killed → restore, archive`; `archived → none` (FR-031).
- [X] T013 [P] Test `lib/admin/flags/draft.test.ts` first (red): `toDraft(flag)` ↔ `toFlagInput(draft)` round trip; percent (≤ 2 decimals) → integer basis points (5 → 500; 12.5 → 1250); one value per line ↔ array, blank lines ignored; variant type inferred (Boolean/String/Number/JSON); `rollout` xor `variant`; empty `expiresAt` → `null`; empty description omitted; `expectedVersion = basisVersion`; syntax errors "Enter valid JSON." / "Enter a number." returned as `{fieldId, message}[]` before sending; `isDirty` by deep-equal; reducer actions `edit/addVariant/removeVariant (clears references)/addRule/moveRule/addCondition/reset(flag)`; a refetch never touches the draft (AS-19, AS-22, AS-23, AS-30, FR-021).
- [X] T014 Implement `lib/admin/flags/draft.ts` and `lib/admin/flags/to-flag-input.ts` (`toDraft`, `toFlagInput`, `draftReducer`, `isDirty`, `useReducer`-ready; draft-local stable `uid` for variants, rules, conditions, slices; `raw` outcome for rules the editor cannot show) per `data-model.md`.
- [X] T015 [P] Implement `lib/admin/flags/starter.ts`: `STARTER_DEFINITION` — variants `off` = false, `on` = true, default `off`, off `off`, no rules, `bucketBy` `userId`, not client-side, no expiry, status disabled (AS-09, FR-020); covered by the `create-flag-form` test (T039).
- [X] T016 [P] Test `lib/admin/flags/diff.test.ts` table-driven per action (create "Created with" whole definition; update field list "Status: Enabled → Killed", "Rules: 1 rule → 2 rules"; kill; restore; archive; no difference → "No visible changes"; values returned as text) then implement `lib/admin/flags/diff.ts` `diffFlags(before, after)` (AS-41, FR-040).
- [X] T017 [P] Test `lib/admin/flags/problem-paths.test.ts` (`rules[0].rollout` → rule 1 rollout; `variants[2].value` → variant 3; `defaultVariant`; `owner`; `expiresAt`; unknown path → summary only; each `FLAG_DEFINITION_ERROR_CODES` code → catalogue copy; unknown code → "This value isn't valid." with code for `title`; `weights_sum_invalid` sum basis points ÷ 100) then implement `lib/admin/flags/problem-paths.ts` `fieldForPath` (AS-14, FR-050).
- [X] T018 [P] Test `lib/admin/flags/copy.test.ts` then implement `lib/admin/flags/copy.ts` `flagProblemCopy(problem, ctx)`: copy and placement (F/S/A/B/P/N/C/W) keyed by `(status, code)`, never by `detail`/`title`; every row of the spec's error catalogue (400, 401, 403 incl. `csrf_invalid`/`origin_not_allowed`, 404, 409 `version_conflict` edit|create, `flag_killed`, `flag_archived` save|create|action, `invalid_transition`, 413, 422 codes quoting `FLAG_LIMITS` not literals, `flag_limit_reached`, 429, 5xx, network) (AS-12, AS-13, AS-35, AS-38, AS-50, AS-51, AS-53).
- [X] T019 Add `queryKeys.admin.flags.{all,list({status,cursor}),detail(key),history(key,{cursor}),stale({days})}` to `lib/query-keys.ts` with canonicalised params (`status` default `all`, `cursor` undefined dropped) (gaps A2).
- [X] T020 [P] Test `lib/api/admin-flags.test.ts` (MSW): relative `/api/admin/flags…` paths, CSRF header on every non-GET, no `Authorization`, responses parsed with `flagSchema`/`flagPageSchema`/`flagAuditPageSchema`/`staleFlagsSchema`, `status=archived` sends `includeArchived=true`, `readFlagProblem` reads `code` from body else tail of `type` (both pinned), normalises `path`/`field`, reads `currentVersion`, `currentStatus`, `retryAfterSeconds`, `requestId`; a body that is not problem+json yields generic (AS-51, AS-56, R-02, R-03).
- [X] T021 Implement `lib/api/admin-flags.ts` (`listFlags`, `getFlag`, `saveFlag` handling 200/201, `killFlag`, `restoreFlag`, `archiveFlag`, `getFlagHistory`, `getStaleFlags`, `readFlagProblem`) via the shared client; request body from `flagInputSchema`; replaces `lib/api/admin.ts` (gaps A4, A8, FR-005).
- [X] T022 [P] Implement `lib/api/admin-flags.server.ts` (`import 'server-only'`; `getFlagPage`, `getFlagServer`, `getHistoryPage`, `getStale` through `readAsMember('/api/bff/f/admin/flags…', schema)`, returning `ReadResult<T>`, forwarding only the session cookie, never a token) (FR-003, R-04).
- [X] T023 [P] Test `hooks/use-admin-flags.test.tsx`: keys from `queryKeys.admin.flags`; `staleTime: 0` and refetch-on-focus; no retry on 4xx; `useSaveFlag` sets detail from the response and invalidates `all` (list, stale, history refetch); kill/restore/archive refetch detail after `204` and invalidate `all`; history key invalidated by each mutation (AS-26, AS-44, AS-55).
- [X] T024 Implement `hooks/use-admin-flags.ts`: `useFlags`, `useFlag`, `useFlagHistory`, `useStaleFlags`, `useSaveFlag`, `useKillFlag`, `useRestoreFlag`, `useArchiveFlag`, single-flight and `onError` mapped through `readFlagProblem` (gaps A3, A5, FR-003).
- [X] T025 [P] Implement shared presentational pieces: `components/admin/flags/status-badge.tsx` (text "Enabled/Disabled/Killed/Archived", never colour alone, reads `status` not `enabled`), `copy-button.tsx` (clipboard), `flag-problem.tsx` (W01 `<ProblemAlert />` for generic codes + catalogue for flag codes, "Reference: {requestId}" with **Copy**, `Retry-After` countdown via `lib/auth/retry-after.ts`, announced once at start and end) (AS-50, AS-51, B5, B9).
- [X] T026 [P] Session-ended dirty sentence (AS-49, R-07): test then implement `lib/admin/flags/dirty.ts` (`setDraftDirty`/`isDraftDirty`) and wire it into W01's `lib/auth/session-ended.ts` toast description ("Your unsaved edits are lost. Copy them first if you need them.", only while dirty; flow called once); if W01 offers no hook, add a `**W01**` bullet under `## Sibling-spec follow-ups` in `gaps.md`.

**Checkpoint**: pure modules and plumbing green; stories can start.

---

## Phase 3: User Story 7 — Access, shell, failure and layout frame (Priority: P1) 🎯 MVP foundation

**Goal**: `/admin/**` is guarded; shell works at phone and desktop width; offline/forbidden states.
**Independent test**: `components/admin/admin-guard.test.tsx`, `admin-shell.test.tsx`.

- [X] T027 [P] [US7] Test `components/admin/admin-guard.test.tsx`: `adminAccess` decision (anonymous → redirect target `/login?returnTo=<path+query>` via `loginHref`; member → forbidden panel; admin → children), no data request for non-admin, a `403` swaps content for the panel, identical for any key (AS-47, AS-48).
- [X] T028 [US7] Implement `components/admin/admin-guard.tsx` (Server Component: `requireServerSession(returnTo)` then `isAdmin`) and `components/admin/forbidden-panel.tsx` ("You don't have access to this area." + **Back to marketplace**) (gaps C1, C2).
- [X] T029 [P] [US7] Test `components/admin/admin-shell.test.tsx`: drawer opens via "Open menu", closes on choice and Escape, focus returns to the button, `aria-current="page"` on the current entry, no navigation rendered before the guard passes, offline banner "You're offline. Changes can't be saved." on `offline`/`online` events with one refetch on return (AS-52, AS-59, AS-66).
- [X] T030 [P] [US7] Implement `lib/admin/nav.ts` (`AdminNavItem`, `adminNavItems` with one entry `feature-flags`).
- [X] T031 [US7] Implement `components/admin/admin-shell.tsx`, `admin-nav.tsx`, `admin-drawer.tsx` (client), `admin-offline-banner.tsx` (client): header with brand "Marketplace Admin", "Back to marketplace", viewer e-mail; ≥ 1024 px sidebar landmark `nav` named "Admin"; ≤ 1023 px top bar + drawer; focus lands on the new `h1` after route change; no horizontal scroll (gaps D1, D2, D6, AS-59).
- [X] T032 [US7] Rewrite `app/admin/layout.tsx` as a Server Component: static frame outside `<Suspense>`, `<AdminGuard>` inside it, no top-level session `await`, no `instant = false` (gaps C1, C4, FR-002); keep `/admin` redirect in `next.config.ts` untouched (G1).
- [X] T033 [P] [US7] Journey `tests/admin-access.spec.ts` (`Admin console access`): anonymous visitor is sent to sign in and returns to the console; a member who is not an admin sees only the no-access panel (AS-47, AS-48).

---

## Phase 4: User Story 1 — Find and scan the flags (Priority: P1)

**Goal**: list with status filter, paging, empty/error/skeleton states, row menu.
**Independent test**: `flag-list.test.tsx`, `flag-row-actions.test.tsx`.

- [X] T034 [P] [US1] Test `components/admin/flags/flag-list.test.tsx` (MSW): columns Key (link) / Description / Status / Owner / Client-side / Expires / Updated / Actions, caption "Feature flags", text badges, no counters (AS-01); tab click updates URL and `aria-selected`, tabs "All active, Enabled, Disabled, Killed, Archived" (AS-02); `includeArchived=true` only for Archived and only "Open" action (AS-03); Next page / First page links, cursor dropped on filter change, "Showing {n} flags" (AS-04); two empty states ("No feature flags yet." + **New flag**; "No {status} flags." + **Show all active flags**) (AS-05); failed list → alert + **Try again** (+ "Reference"), background refetch failure keeps rows with "Couldn't refresh. Showing the last loaded list." (AS-07); markup in description/owner rendered literally (AS-64); rerender with a removed row keeps keys by flag key and focus falls to next link (AS-65); table roles/`scope="col"` (AS-58).
- [X] T035 [P] [US1] Test `components/admin/flags/flag-row-actions.test.tsx`: menu button "Actions for {key}", actions per status (Open; Kill for enabled/disabled; Restore for killed; Archive for disabled/killed), Enter/Space and arrow keys, focus returns to the menu button (or the flag link if the row left) (AS-08, AS-57).
- [X] T036 [US1] Implement `components/admin/flags/flag-tabs.tsx`, `status-tabs.tsx`, `flag-list.tsx` (table ≥ 1024 px, cards ≤ 640 px; key `flag.key`; uses `useFlags`), `flag-list-skeleton.tsx` (table/card shaped, no spinner), `flag-row-actions.tsx` (menu calling the lifecycle dialogs of T071) (gaps A6, B5, B8, D3).
- [X] T037 [US1] Rewrite `app/admin/feature-flags/page.tsx` as a Server Component: static heading + tabs frame + skeleton; inside `<Suspense>` await `searchParams`, prefetch first answer via `admin-flags.server.ts` into `queryClient.setQueryData` → `HydrationBoundary` (failed prefetch left out); no `use cache` (gaps A1, AS-06).
- [X] T038 [P] [US1] Visual `tests/visual/admin-list.spec.ts`: list with data, empty list, list skeleton, list error, long key and 500-char description wrapping, mobile + desktop, axe (AS-01, AS-05, AS-06, AS-07, AS-60, AS-63).

---

## Phase 5: User Story 2 — Create a flag that starts dark (Priority: P1)

**Goal**: `/admin/feature-flags/new` creates a disabled flag via `PUT expectedVersion: 0`.
**Independent test**: `create-flag-form.test.tsx`.

- [X] T039 [P] [US2] Test `components/admin/flags/create-flag-form.test.tsx`: starter body sent with `expectedVersion: 0`, navigation to the editor and toast "Flag {key} created. It is disabled." (AS-09); Owner pre-filled with viewer e-mail, Description optional, key hint and `maxLength`/`pattern` from contracts (AS-10); `409 version_conflict` → "A flag with this key already exists." + **Open {key}**, `409 flag_archived` → "This key belonged to an archived flag and can't be reused.", focus on key (AS-12); `422 flag_limit_reached` copy + **Review stale flags** (AS-13); `422 flag_definition_invalid` and `400 validation_failed` summary + per-field + focus; empty Key/Owner stop before sending with "Enter a key." / "Enter an owner." (AS-14, AS-15); double press sends one request, "Creating…", `aria-busy`, read-only form (AS-16).
- [X] T040 [US2] Implement `components/admin/flags/create-flag-form.tsx` (client; built on `toFlagInput`, `useSaveFlag`, `fieldForPath`) and `app/admin/feature-flags/new/page.tsx` (static form frame, centred card max 40 rem) (gaps B1, B11, D4); remove the create dialog from the list page.
- [X] T041 [P] [US2] Implement `app/admin/feature-flags/[key]/not-found.tsx` ("We couldn't find that flag." + **All flags**) and the key-pattern `notFound()` check inside the page's Suspense before any request (gaps G1, G2, AS-31, AS-54).
- [X] T042 [P] [US2] Journey `tests/admin-flags.spec.ts` › `admin creates a dark flag` (form → Create flag → editor with version 1, "Disabled", notice; flag in list as "Disabled") (AS-09, AS-11, AS-01).
- [X] T043 [P] [US2] Visual `tests/visual/admin-editor.spec.ts` › create form, mobile + desktop, axe (AS-09, AS-62).

---

## Phase 6: User Story 3 — Edit targeting and rollout (Priority: P1)

**Goal**: full editor with optimistic concurrency and unsaved protection.
**Independent test**: `flag-editor.test.tsx`, `variants-editor.test.tsx`, `rules-editor.test.tsx`.

- [X] T044 [P] [US3] Test `components/admin/flags/variants-editor.test.tsx`: typed rows (Boolean/String/Number/JSON), inferred types, "Remove variant {key}", removing a referenced variant clears the choice and marks "Choose a variant.", selects list exactly current variants in order (AS-19, AS-20), no request and messages "Enter valid JSON." / "Enter a number." with focus on first (AS-30).
- [X] T045 [P] [US3] Test `components/admin/flags/rules-editor.test.tsx`: ordered list named "Targeting rules, checked top to bottom; the first match wins"; Add rule / Remove rule {n} / Move rule {n} up|down (disabled at ends, focus stays, "Rule {id} moved to position {n}" via `role="status"`), empty text "No rules. Everyone gets the default variant."; unknown-feature rule read-only JSON with notice (AS-21); condition inputs per operator, Add condition / Remove condition {n} of rule {id}, operator change keeps what applies (AS-22); slices in percent, "Total: {x}%", **Make the last slice the remainder** (never below 0), fixed ↔ rollout swap, help text (AS-23); disclosure `aria-expanded` named "Rule {n}: {summary}", expanded by default when ≤ 3 rules (AS-61); keyboard paths; `fieldset`/`legend` groups, `ol` (AS-57, AS-58).
- [X] T046 [P] [US3] Test `components/admin/flags/flag-editor.test.tsx` (part 1, open and edit): header key `h1`, badge, "Version {n}", Created/Updated, sections in order, help card text (AS-17); body carries loaded `expectedVersion`, "Saved." `role="status"`, header shows new version (AS-18); **Enabled** switch role/label/description, applies only on Save (AS-24); Save/Discard disabled when clean, "Unsaved changes" when dirty, discard dialog (**Keep editing** focused), link interception, `beforeunload` (AS-25); form reset from the server answer (AS-26); client-side notice with `aria-describedby` (AS-29); Expires help text (Edge Cases).
- [X] T047 [P] [US3] Test `components/admin/flags/flag-editor.test.tsx` (part 2, failures): lost response keeps draft, "Couldn't reach the server. Your changes haven't been confirmed. Check your connection and try again.", **Try again** re-sends identical body and version, no-op `200` shows "Saved." (AS-27); `409 version_conflict` banner `role="alert"`, **Load latest** (after discard confirmation) / **Keep editing**, Save disabled "Load the latest version before saving.", refetch updates header not draft (AS-28); 404 on open → panel, 404 on save → alert with draft kept (AS-31); 401 → W01 flow once, dirty sentence (AS-49); 429 countdown with fake timers, disabled/re-enabled, draft kept, announcements (AS-50); 5xx generic + reference + Copy, non-problem body (AS-51); `csrf_invalid` → **Reload** (AS-53); `422` summary/focus (AS-14); `413` copy.
- [X] T048 [US3] Implement `components/admin/flags/editor-header.tsx`, `editor-skeleton.tsx`, `basics-section.tsx`, `variants-editor.tsx`, `bindings-section.tsx` (default/off selects, **Bucket by**), `help-card.tsx`, `notices.tsx` (disabled / client-side / expiry / killed / archived), `save-bar.tsx` (docked at bottom), `conflict-banner.tsx` (gaps B2).
- [X] T049 [US3] Implement `components/admin/flags/rules-editor.tsx`, `rule-card.tsx`, `condition-row.tsx`, `outcome-editor.tsx` (attributes/operators/bucket units imported from contracts constants; labels "is one of", "is not one of", "equals", "does not equal", "at least", "at most", "is set"; `uid` keys; raw read-only rule).
- [X] T050 [US3] Implement `components/admin/flags/flag-editor.tsx` (client; `useReducer(draftReducer, flag, toDraft)`, basis version, single-flight, read-only + `aria-busy` while writing, problem placement via `flag-problem.tsx`, `setDraftDirty`) and `components/admin/flags/unsaved-guard.tsx` (`beforeunload` + capture-phase click interception + `useConfirmLeave`, R-06) (gaps B12, AS-25).
- [X] T051 [US3] Implement `app/admin/feature-flags/[key]/page.tsx` (Server Component: awaits `params`/`searchParams` inside Suspense, key pattern check → `notFound()`, prefetch detail, tab frame Definition/History; focus on `h1`).
- [X] T052 [P] [US3] Journey `tests/admin-flags.spec.ts` › `admin ramps a flag` (editor shows header/basics/variants/rules; edit description + Client-side; staff rule with 5% rollout; turn **Enabled** on; Save → "Saved."; reload shows values) (AS-17, AS-18, AS-21, AS-23, AS-24).
- [X] T053 [P] [US3] Visual `tests/visual/admin-editor.spec.ts` › editor with data, editor skeleton, conflict banner, editor with 20 variants and 50 rules (docked save bar, no horizontal scroll), mobile + desktop, axe (AS-17, AS-28, AS-61, AS-63).

---

## Phase 7: User Story 4 — Kill, restore, archive (Priority: P1)

**Goal**: deliberate lifecycle actions with dialogs and visible outcomes.
**Independent test**: `lifecycle-dialogs.test.tsx`, parts of `flag-editor.test.tsx`.

- [X] T054 [P] [US4] Test `components/admin/flags/lifecycle-dialogs.test.tsx`: kill dialog "Kill {key}?" with off variant in text, focus on **Cancel**, one `POST …/kill`, "Killing…" (AS-32); restore copy and toast "Flag {key} restored. It is disabled." (AS-36); archive copy, not offered for enabled (AS-37); `invalid_transition` "{key} is now {currentStatus}, so that isn't possible. The page has been refreshed." and refetch, `flag_archived` copy, repeated kill shows success (AS-38); all lifecycle buttons and Save disabled while pending, error keeps dialog open (AS-39); focus in, Tab trap, Escape closes unless in flight, focus returns to opener (AS-57).
- [X] T055 [P] [US4] Test `components/admin/flags/flag-editor.test.tsx` (part 3, lifecycle): Kill available with a dirty draft and draft untouched (AS-33); killed flag banner `role="status"`, switch off and disabled with "A killed flag can't be enabled. Restore it first.", other fields savable with `enabled: false`, Restore/Archive offered, Kill not (AS-34); `409 flag_killed` → alert, refetch, Save disabled while draft enabled (AS-35); archived flag every control disabled, lifecycle buttons gone, History usable, banner (AS-37).
- [X] T056 [US4] Implement `components/admin/flags/lifecycle-dialogs.tsx` (kill/restore/archive/discard alert dialogs, centred on desktop, full-height sheet on mobile, shared by editor header and row menu; toasts "Flag {key} killed." / "restored. It is disabled." / "archived.") and wire `useKillFlag/useRestoreFlag/useArchiveFlag`; kill is full-width under the header at ≤ 640 px (gaps B3, B4).
- [X] T057 [P] [US4] Journey `tests/admin-flags.spec.ts` › `admin kills, restores and archives a flag` (kill from row menu, badge "Killed", killed banner, Restore → "Disabled", Archive → read-only) (AS-08, AS-32, AS-34, AS-36, AS-37).
- [X] T058 [P] [US4] Visual `tests/visual/admin-editor.spec.ts` › kill dialog, kill switch visible without scrolling, killed flag, archived flag, mobile + desktop, axe (AS-32, AS-33, AS-34, AS-37).

---

## Phase 8: User Story 5 — Audit trail (Priority: P2)

**Independent test**: `flag-history.test.tsx`.

- [X] T059 [P] [US5] Test `components/admin/flags/flag-history.test.tsx`: list "Change history" newest first with labels, `<time datetime>`, "You" vs monospace actor id + **Copy**, request id + **Copy** (AS-40); **Show changes** `aria-expanded` with diff text, markup rendered literally (AS-41, AS-64); **Older** / **Newest** links, `invalid_cursor` panel "That page link is no longer valid." + **Go to the newest changes** (AS-42); archived flag history readable, unknown key → not-found (AS-43).
- [X] T060 [US5] Implement `components/admin/flags/flag-history.tsx`, `history-entry.tsx`, `history-skeleton.tsx` and the `?tab=history` branch of `[key]/page.tsx` (refetch on open; uses `diffFlags`; "You" by comparing with `useAuth().user.id`) (gaps B6, FR-040, FR-041, AS-44).
- [X] T061 [P] [US5] Journey `tests/admin-flags.spec.ts` › `admin reads the audit trail` (create, save, kill, History: three entries newest first, actor "You") (AS-40, AS-44).
- [X] T062 [P] [US5] Visual `tests/visual/admin-history.spec.ts`: history, expanded entry, history skeleton, mobile + desktop, axe (AS-40, AS-62, AS-63).

---

## Phase 9: User Story 6 — Stale-flag report (Priority: P2)

**Independent test**: `stale-report.test.tsx`.

- [X] T063 [P] [US6] Test `components/admin/flags/stale-report.test.tsx`: table "Stale flags" with Key (link), Owner, Status, Reason ("Expired" / "Not evaluated in the last {days} days"), Expires, Created, Evaluations; approximate-counts note (AS-45); window select 7/14/21/30 updates URL, invalid `days` shows 14, empty text "No stale flags. Nothing has expired and every flag has been evaluated in the last {days} days." (AS-46).
- [X] T064 [US6] Implement `components/admin/flags/stale-report.tsx`, `stale-skeleton.tsx` and the `?tab=stale` branch of `app/admin/feature-flags/page.tsx` (rows as cards ≤ 640 px) (gaps B7).
- [X] T065 [P] [US6] Journey `tests/admin-flags.spec.ts` › `admin opens the stale report` (tab reachable, report or empty message shown) (AS-45).
- [X] T066 [P] [US6] Visual `tests/visual/admin-list.spec.ts` › stale report and stale skeleton, mobile + desktop (AS-45, AS-63).

---

## Phase 10: Shell visuals and delete old code

- [X] T067 [P] Visual `tests/visual/admin-shell.spec.ts`: shell with drawer closed/open, no-access panel, mobile + desktop, axe (AS-48, AS-59).
- [X] T068 Delete `lib/api/admin.ts` (`adminApi`, `booleanFlag`, `FeatureFlag`), `app/admin/feature-flags/feature-flags-client.tsx`, `data-testid="flag-row"`; grep proves no importer remains and no `formatMoney` in `app/admin` (W02 follow-up: not applicable, W06 shows no money; the seller dashboard call belongs to W04) (S38 `listFlags` `.items` follow-up closed by `listFlags` parsing `flagPageSchema`).
- [X] T069 Make the T003 architecture test green: fix any W06 path that breaks a rule (token/storage references, index keys, `console.*` of bodies) and confirm `app/admin` has no `use cache`/`instant = false`.

---

## Phase 11: Polish and cross-cutting

- [X] T070 [P] Accessibility pass over all admin components: 44 px targets, `aria-describedby` for server errors, live regions (`role="status"` Saved/toasts/"Rule moved", `role="alert"` conflicts/errors), focus to first invalid field/summary, `h1` focus after route change, one `h1` per page (AS-58, FR-061).
- [X] T071 [P] Layout pass: breakpoints ≤ 640 / 641–1023 / ≥ 1024 per the Layout table, docked save bar, rule disclosures collapsed by default when > 3 rules at ≤ 640 px, dialogs as sheets on mobile (FR-060, AS-60, AS-61, AS-62).
- [X] T072 [P] Add `## Spec changes` (none signed by a human changed; living spec page `W06-admin-flags.md` created) and complete `## Sibling-spec follow-ups` in `gaps.md`: **W07** Admin menu entry via `isAdmin`; **S38** `q` filter, stale seed rows, optional actor e-mail; **W01/S54** machine `code`; **S48** only if `Retry-After` is dropped; **W04** `formatMoney` literal `'USD'` remains its own follow-up.
- [X] T073 [P] Confirm `quickstart.md` "Ops artifacts" lists SC-001, SC-002, SC-008, SC-009 and that `specs/UNVERIFIED.md` has the four W06 rows with status `not run` (they exist; add any missing, never mark verified).
- [X] T074 Run `python3 scripts/livespec/check.py` and make every `[proof: ...]` / `[code: ...]` in `docs/spec/capabilities/W06-admin-flags.md` true (update paths to the final file names).
- [X] T075 Narrow final checks of code written here: `npx tsc --noEmit`, `npx eslint app/admin components/admin hooks lib`, `npx vitest run lib/admin components/admin hooks/use-admin-flags.test.tsx lib/api/admin-flags.test.ts lib/architecture.test.ts`, then the whole web Vitest suite once (`npx vitest run`).

---

## Dependencies and order

- Phase 1 → Phase 2 → stories. Phase 3 (US7 shell/guard) before others render; US1 list before US4 row menu wiring (T036 uses T056 dialogs — implement T056 first or stub the menu callbacks then wire).
- US2 and US3 both need `draft.ts`, `to-flag-input.ts`, `flag-problem.tsx` (Phase 2). US4 dialogs feed US1 and US3. US5 and US6 are independent of each other after Phase 2.
- Within every story: test tasks (red) → implementation → journey/visual tasks.
- Parallel: all `[P]` tasks touch different files; the pure-module tests T007–T018 can run together, as can T034/T035, T044/T045/T046/T047, T059, T063.

## Implementation strategy

MVP = Phases 1–2, US7 (guard + shell), US1 (list), US2 (create). Then US3 (editor) and US4 (lifecycle) together (the safety net), then US5, US6, polish. Stop at each checkpoint with the narrow Vitest file green.

## Gap and follow-up coverage

A1 T037 · A2 T019 · A3 T024 · A4 T021 · A5 T024 · A6 T010/T036 · A7 T040/T031 · A8 T021/T069 · B1 T040 · B2 T048–T050 · B3–B4 T056 · B5 T025 · B6 T060 · B7 T064 · B8 T036 · B9 T018/T025 · B10 T068 · B11 T040 · B12 T050 · C1–C2 T028 · C3 T008/T072 · C4 T032 · D1–D2 T031 · D3 T036 · D4 T040 · D5 T025/T031 · D6 T031 · E1/E4/E5 T006 · E2/E3 T006 · E6–E9 T072 · F5 T005 · F6 T033/T042/T052/T057/T061/T065 · F7 T003/T069 · F8 T004 · F9 T004 · G1 T032/T041 · G2 T041 · G3 T011 · G4 T013/T014. Follow-ups: S38 (`expectedVersion`, `status`, paging, lifecycle, `.items`) T014/T021/T024/T036/T056 · W01 (`returnTo`, guard, no Authorization) T028/T021/T069 · W02 T068 · W03 T028 · W07 T008.
