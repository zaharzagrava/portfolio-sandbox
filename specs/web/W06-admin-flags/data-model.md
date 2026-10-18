# Data model: W06 (UI view models; the API owns the data)

## Server data (TanStack Query, keys from `lib/query-keys.ts`)

| Entity | Schema (contracts) | Key | Options |
|---|---|---|---|
| Flag page | `flagPageSchema` | `queryKeys.admin.flags.list({status, cursor})` | `staleTime 0`, refetch on focus |
| Flag | `flagSchema` | `…flags.detail(key)` | same; set from the `PUT` response |
| Audit page | `flagAuditPageSchema` | `…flags.history(key, {cursor})` | same; refetched on tab open |
| Stale report | `staleFlagsSchema` | `…flags.stale({days})` | same |
| prefix | — | `…flags.all` | invalidated by every successful write |

Key builders canonicalise params (`status` default `all`, `cursor` `undefined` dropped) like the existing `canonical` helper.

## URL state (`lib/admin/flags/params.ts`: one parser per page, the same module builds links)
`status ∈ all|enabled|disabled|killed|archived` (unknown → `all`), `cursor` (opaque), `tab ∈ stale|history`, `days ∈ 1..30` default 14 (select offers 7/14/21/30; out of range → 14). Flag key checked with `FLAG_KEY_PATTERN`; a non-match is not-found with no request. `status=archived` sends `status=archived&includeArchived=true`.

## Local state
- **Draft** (`lib/admin/flags/draft.ts`): `{ basisVersion, status, key, description, owner, enabled, clientSide, expiresAt (UTC text), bucketBy, defaultVariant, offVariant, variants: DraftVariant[], rules: DraftRule[] }`.
  - `DraftVariant = { uid, key, type: 'boolean'|'string'|'number'|'json', text }` (type inferred from the stored value).
  - `DraftRule = { uid, id, conditions: DraftCondition[], outcome: {kind:'variant', variant} | {kind:'rollout', slices: {uid, variant, percentText}[]} | {kind:'raw', json}, expanded }` (`raw` = a rule with a feature the editor cannot show, read-only).
  - `DraftCondition = { uid, attribute, op, valuesText }` (`in`/`not_in`: one value per line; `eq`/`neq`/`gte`/`lte`: one line; `exists`: empty).
- **Mapping**: `toFlagInput(draft)` → `FlagInput` with `expectedVersion = draft.basisVersion`; percent (≤ 2 decimals) → integer basis points; `rollout` xor `variant`; empty `expiresAt` → `null`; empty description omitted. Syntax errors ("Enter valid JSON.", "Enter a number.") come back as `{fieldId, message}[]` before sending (AS-30). `toDraft(flag)` is the inverse.
- **Editor status**: `idle | saving | killing | restoring | archiving` (single-flight); `banner: none | conflict{currentVersion} | killedWhileEditing | archived | gone`; last `FlagProblem`.
- Dialog open state, expanded history entries, row menu and countdown are component state.

## Presentation of legal actions (S38 re-checks)
`availableActions(status)` in `lib/admin/flags/transitions.ts`: `enabled → kill`; `disabled → kill, archive`; `killed → restore, archive`; `archived → none`. A killed flag: switch off and disabled; an archived flag: read-only; `409 flag_killed` → refetch, Save disabled while `draft.enabled`.

## Client leaves (`'use client'`)
`flag-tabs`, `status-tabs`, `flag-list`, `flag-row-actions`, `stale-report`, `create-flag-form`, `flag-editor` and sub-forms, `lifecycle-dialogs`, `flag-history`, `history-entry`, `admin-drawer`, `admin-offline-banner`, `copy-button`, `unsaved-guard`. Server: both layouts, every `page.tsx`, `not-found.tsx`, `admin-guard`, `forbidden-panel`, skeletons.

## Storage
None (AS-56). The draft never leaves memory.
