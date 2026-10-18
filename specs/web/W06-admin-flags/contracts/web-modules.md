# Contract: W06 modules, routes and copy keys (packages/web)

## Routes
`/admin` (redirect kept in `next.config.ts`) · `/admin/feature-flags[?status&cursor | tab=stale&days]` · `/admin/feature-flags/new` · `/admin/feature-flags/{key}[?tab=history&cursor]`. Removed: the create dialog and `data-testid="flag-row"`.

## HTTP consumed (relative, same origin; shapes from `@marketplace-sandbox/contracts`)

| Call | Request | Success | Parsed with |
|---|---|---|---|
| `listFlags` | `GET /api/admin/flags?status&includeArchived&cursor` | 200 | `flagPageSchema` |
| `getFlag(key)` | `GET /api/admin/flags/{key}` | 200 | `flagSchema` |
| `saveFlag(key, input)` | `PUT …/{key}`, body `flagInputSchema` (`expectedVersion`) | 201 (+`Location`) / 200 | `flagSchema` |
| `killFlag` / `restoreFlag` / `archiveFlag` | `POST …/{key}/kill\|restore\|archive`, no body | 204 | — |
| `getFlagHistory(key, {cursor})` | `GET …/{key}/history?cursor` | 200 | `flagAuditPageSchema` |
| `getStaleFlags({days})` | `GET …/stale?days` | 200 | `staleFlagsSchema` |

Non-GET calls carry the shared CSRF header; none carries `Authorization`. The server module `admin-flags.server.ts` (`server-only`) exports `getFlagPage`, `getFlagServer`, `getHistoryPage`, `getStale` through `readAsMember`, each returning `ReadResult<T>`.

## Modules (exact names)
- `lib/query-keys.ts`: `queryKeys.admin.flags.{all,list,detail,history,stale}`.
- `lib/admin/is-admin.ts`: `isAdmin(user: SessionUser | null): boolean`. `lib/admin/nav.ts`: `AdminNavItem`, `adminNavItems`.
- `lib/admin/flags/`: `parseListParams`, `parseStaleParams`, `parseHistoryParams`, `listHref`, `isFlagKey`, `STARTER_DEFINITION`, `toDraft`, `toFlagInput`, `draftReducer`, `isDirty`, `diffFlags(before, after)`, `fieldForPath(path)`, `flagProblemCopy(problem, ctx)`, `availableActions(status)`, `formatUtc`.
- `lib/api/admin-flags.ts`: `listFlags`, `getFlag`, `saveFlag`, `killFlag`, `restoreFlag`, `archiveFlag`, `getFlagHistory`, `getStaleFlags`, `readFlagProblem`.
- `hooks/use-admin-flags.ts`: `useFlags`, `useFlag`, `useFlagHistory`, `useStaleFlags`, `useSaveFlag`, `useKillFlag`, `useRestoreFlag`, `useArchiveFlag`.
- `components/admin/admin-guard.tsx` (Server): `<AdminGuard returnTo>` runs `requireServerSession(returnTo)` then `isAdmin`, else renders `<ForbiddenPanel />`.
- `tests/helpers.ts`: `createFlag(page, key, options?)`, `flagPath(key, tab?)`, `adminLogin(page)`.

## Copy catalogue keys (`lib/admin/flags/copy.ts`, keyed by `(status, code)`; text from the spec's error catalogue)
`validation_failed`, `invalid_cursor`, `unauthenticated` (session flow), `permission_denied` (forbidden panel), `csrf_invalid` / `origin_not_allowed`, `flag_not_found`, `version_conflict` (edit | create), `flag_killed`, `flag_archived` (save | create | action), `invalid_transition`, `payload_too_large` / 413, `flag_definition_invalid` plus each `FLAG_DEFINITION_ERROR_CODES` entry (limit messages quote `FLAG_LIMITS`, never literals), `flag_limit_reached`, `rate_limited`, 5xx, network.

## Guarantees
No token; no storage; no flag body in `console.*` or analytics; every write sends the draft's `basisVersion`; kill, restore and archive are never combined with a save; lists are keyed by flag key, audit `id` or `uid`.
