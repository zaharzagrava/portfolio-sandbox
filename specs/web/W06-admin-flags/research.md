# Research: W06 — Admin feature-flag console

Verified 2026-10-18 against the working tree. "Phase 0" = verified again by a test before code is written.

## R-01 Backend and contracts exist; E1/E4/E5 of `gaps.md` are closed
- **Decision**: no backend feature work. `packages/backend/libs/domains/experimentation/api/flags-admin.controller.ts` serves `GET admin/flags` (with `includeArchived`), `GET admin/flags/stale`, `GET|PUT admin/flags/:key`, `POST …/kill|restore|archive`, `GET …/history`. `packages/contracts/src/experimentation/flags.ts` exports `flagSchema`, `flagInputSchema`, `flagPageSchema`, `flagAuditPageSchema`, `staleFlagsSchema` and the constants `FLAG_KEY_PATTERN`, `FLAG_ATTRIBUTES`, `FLAG_OPERATORS`, `FLAG_BUCKET_BY`, `FLAG_STATUSES`, `FLAG_LIMITS`, `FLAG_DEFINITION_ERROR_CODES`, `FLAG_PROBLEM_CODES`, re-exported from `packages/contracts/index.ts`; `packages/web` already depends on the package.
- **Rationale**: the spec's "Requires" assumed these were missing; S38/S54 built them after the spec was written. The web imports the SCREAMING_CASE contract names, not the `flagAttributes`-style names in the spec.
- **Phase 0**: run `scripts/sdd/test-spec.sh flags-admin` and `flags-lifecycle` once to prove the shapes (`201`+`Location` / `200`, `409` bodies with `currentVersion` / `currentStatus`, `422 errors[{path,code}]`, history `before`/`after`, `status=archived` with or without `includeArchived`). Edit the backend only if one of those fails; then migrate any `// S54 T037 audit` site in the touched file.
- **Alternatives**: a hand-typed client (rejected: V.2, drift).

## R-02 Where the machine code lives in a problem body
- **Decision**: one reader in `lib/api/admin-flags.ts` takes the stable code from `body.code`, else from the last path segment of `body.type` (`…/flag_killed` → `flag_killed`) and attaches it to the result of `readFlagProblem`. W06 copy keys on that code. W01's `problemFromError` reads `body.code` only; if the backend already sends `code`, the fallback is dead and a unit test pins both.
- **Phase 0**: check the exception filter / one e2e body; record the answer in `gaps.md` under "Sibling-spec follow-ups" (**S54** or **W01** if `problemFromError` should derive the code).
- **Alternatives**: patching `problemFromError` (W01's file, shared) — rejected for this release.

## R-03 Two error-list shapes
- **Decision**: `problemFromError().errors` is `{field, code}` (400 `validation_failed`); a `422 flag_definition_invalid` carries `errors: [{path, code}]` (and the sum for `weights_sum_invalid`). `readFlagProblem(error)` reads the raw response body once and returns `{status, code, requestId, retryAfterSeconds, fieldErrors: {path, code, sum?}[], currentVersion?, currentStatus?}` (`path` or `field` normalised to `path`); `problem-paths.ts` maps `path` → field id.
- **Alternatives**: extending W01's `Problem` (shared) — rejected.

## R-04 Forwarding admin routes
- **Decision**: no change. `next.config.ts` rewrites `/api/:path*` to `${bffUrl}/api/bff/f/:path*` (the S48 forwarder); the server prefetch uses `readAsMember('/api/bff/f/admin/flags…', schema)` as `lib/server/chat.server.ts` does. Phase 0 asserts with an MSW unit test and one journey that problem+json and `Retry-After` pass through; if the forwarder drops `Retry-After`, add a sibling bullet to **S48** and show the generic 429 copy without a countdown.

## R-05 Editor state: reducer, not react-hook-form
- **Decision**: `useReducer` over a `Draft` (data-model.md) with pure `toDraft(flag)` and `toFlagInput(draft)`; the create page is the same editor with the starter and `expectedVersion: 0`. Nested arrays use draft-local stable `uid`s as React keys. Dirty = deep-equal of `toFlagInput(draft)` and `toFlagInput(toDraft(loaded))`.
- **Rationale**: a zod form schema would duplicate S38 rules (G4, VI.9); `react-hook-form` stays for other pages.

## R-06 Unsaved-changes protection without router internals
- **Decision**: `unsaved-guard.tsx` registers `beforeunload` while dirty and a capture-phase `click` handler on the admin content root that intercepts same-origin `<a>` clicks (unmodified) and opens the discard dialog; app-initiated navigation (after create, tab links) goes through `useConfirmLeave()`. In-app Back is not required by AS-25.

## R-07 Session-ended flow and the dirty draft (AS-49)
- **Decision**: W01's `lib/auth/session-ended.ts` runs once on a final `401`. W06 keeps a module-level `isDraftDirty()` flag in `lib/admin/flags/dirty.ts` (set by the editor) and reads it where the toast description is built. Phase 2 reads `session-ended.ts` and wires the smallest option that compiles; a unit test pins "called once; sentence only when dirty". If W01 offers no hook, record a sibling bullet to **W01**.

## R-08 Timestamps
- **Decision**: `formatUtc(iso)` → `YYYY-MM-DD HH:mm UTC` by slicing `Date#toISOString()` (no `Intl`, no locale), inside `<time dateTime={iso}>`: identical on server and client.

## R-09 Not built
Search by key (E7), actor display name (E6), seeds for stale rows (E9; the stale journey asserts report-or-empty), storefront Admin entry (E8, W07; `isAdmin` supplied), `GET /api/flags`, evaluate-preview.
