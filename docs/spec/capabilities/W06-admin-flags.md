---
id: W06
title: Admin feature-flag console (guard and shell, flag list, create, editor with targeting and rollout, kill switch, restore, archive, audit trail, stale report)
kind: capability
status: draft
generated_at: 40426575
depends_on: [S38, S48, W01, W07]
concepts: [problem-json-errors, rate-limit-policy, request-context]
models: []
scope:
  - packages/web/app/admin/**
  - packages/web/components/admin/**
  - packages/web/hooks/use-admin-flags.ts
  - packages/web/lib/admin/**
  - packages/web/lib/api/admin-flags.ts
  - packages/web/lib/api/admin-flags.server.ts
---
# W06 - Admin feature-flag console

## Purpose
A platform administrator ships a feature dark, ramps it up and pulls it back from one console: sees every flag and its state, creates a flag, edits its variants, targeting rules and percentage rollout without silently overwriting a colleague, switches a misbehaving flag off everywhere with the kill switch, restores or archives it deliberately, reads who changed what and when, and finds flags that should be deleted. Every screen works at phone and desktop width, from the keyboard and with a screen reader, and in every state an admin can reach. The rules of a flag (validation, limits, lifecycle, evaluation, concurrency, audit) belong to {{cap:S38}}; this capability shows and handles each outcome and never re-implements one.

## Entry points
- `/admin` redirects to `/admin/feature-flags` (the `redirects()` entry of `next.config.ts` stays).
- `/admin/feature-flags`: the list (`?status=`, `?cursor=`) and the stale report (`?tab=stale&days=`).
- `/admin/feature-flags/new`: create a flag.
- `/admin/feature-flags/{key}`: the editor; `?tab=history&cursor=` the audit trail.

## Rules
- **W06.R-01** Every `/admin/**` page MUST be a Server Component whose request-time reads (session, `params`, `searchParams`, the first answer) happen inside `<Suspense>`, with no `use cache` and no `instant = false`. [proof: W06 AS-55] [code: packages/web/app/admin/layout.tsx#AdminLayout]
- **W06.R-02** A signed-out visitor MUST be redirected to `/login?returnTo=<path and query>` and a signed-in member who is not an admin MUST see only the no-access panel, before any flag data is requested. [proof: W06 AS-48] [code: packages/web/components/admin/admin-guard.tsx#requireAdminPage]
- **W06.R-03** The admin role MUST be read in one pure function and the console MUST NOT hold a token: requests are relative `/api/admin/flags…` paths, non-GET calls carry the CSRF header, and nothing is stored in the browser. [proof: W06 AS-56] [code: packages/web/lib/admin/is-admin.ts#isAdmin]
- **W06.R-04** Server data MUST live in TanStack Query under `queryKeys.admin.flags.*`, admin queries MUST be never stale and refetch on focus, and every successful write MUST invalidate the whole `admin.flags` prefix. [proof: W06 AS-55] [code: packages/web/hooks/use-admin-flags.ts#useSaveFlag]
- **W06.R-05** Every response MUST be parsed with the contracts schemas and every request body built from `flagInputSchema`; closed sets and limits MUST come from the contracts package. [proof: W06 AS-56] [code: packages/web/lib/api/admin-flags.ts#saveFlag]
- **W06.R-06** Create MUST send `expectedVersion: 0` with the starter definition (disabled, default and off variant `off`, no rules) and a save MUST send the version the draft was loaded from, never silently advanced. [proof: W06 AS-09] [code: packages/web/lib/admin/flags/starter.ts#starterDraft]
- **W06.R-07** Percent MUST be sent as integer basis points, one value per line as an array, and a rule MUST send `rollout` or `variant`, never both. [proof: W06 AS-23] [code: packages/web/lib/admin/flags/to-flag-input.ts#toFlagInput]
- **W06.R-08** The draft MUST change only through the reducer, be reset only by a save answer, Load latest or Discard, and never by a refetch. [proof: W06 AS-26] [code: packages/web/lib/admin/flags/draft.ts#draftReducer]
- **W06.R-09** Syntax that cannot be sent (JSON, number, percentage) MUST be caught before sending and every other rule MUST come from the API. [proof: W06 AS-30] [code: packages/web/lib/admin/flags/to-flag-input.ts#toFlagInput]
- **W06.R-10** Kill, restore and archive MUST be separate confirmed actions that never combine with a save and never change the page before the server answers. [proof: W06 AS-32] [code: packages/web/components/admin/flags/lifecycle-dialogs.tsx#LifecycleDialog]
- **W06.R-11** Which lifecycle actions are offered MUST follow the status, and the API MUST still decide. [proof: W06 AS-08] [code: packages/web/lib/admin/flags/transitions.ts#availableActions]
- **W06.R-12** Failure copy MUST be chosen by status and stable problem `code` and never from the server's `title` or `detail`; a `5xx` MUST show the generic sentence with the request id. [proof: W06 AS-51] [code: packages/web/lib/admin/flags/copy.ts#flagProblemCopy]
- **W06.R-13** A `422` entry `{path, code}` MUST be mapped to the control that holds it and its code to fixed copy that quotes the contract limits. [proof: W06 AS-14] [code: packages/web/lib/admin/flags/problem-paths.ts#fieldForPath]
- **W06.R-14** Timestamps MUST be shown in UTC as `YYYY-MM-DD HH:mm UTC` inside `<time>`. [proof: W06 AS-01] [code: packages/web/lib/admin/flags/format-time.ts#formatUtc]
- **W06.R-15** User content (description, owner, variant values, audit values) MUST be rendered as text, and lists MUST be keyed by flag key, audit id or draft uid, never by index. [proof: W06 AS-64]
- **W06.R-16** Unsaved edits MUST be protected by the browser's unload prompt and a discard dialog for in-app links. [proof: W06 AS-25] [code: packages/web/components/admin/flags/unsaved-guard.tsx#UnsavedGuard]

## Behaviors
- **W06.B-01** Given an admin opens the list, then the non-archived flags show in key order with a text status badge, and the status filter, cursor and tab live in the URL. [proof: W06 AS-02]
- **W06.B-02** Given no flag exists, or none has the chosen status, then two different empty messages show. [proof: W06 AS-05]
- **W06.B-03** Given the list fails, then an alert with Try again shows; given a refresh fails behind shown rows, then the rows stay with a status line. [proof: W06 AS-07]
- **W06.B-04** Given an admin creates a flag, then it starts disabled and the editor opens at version 1; an existing or reserved key is explained under the key. [proof: W06 AS-12]
- **W06.B-05** Given the admin edits and saves, then the form resets to the server's answer and "Saved." shows. [proof: W06 AS-18]
- **W06.B-06** Given a save answers `409 version_conflict`, then a banner offers Load latest and Keep editing and Save stays disabled until the latest is loaded. [proof: W06 AS-28]
- **W06.B-07** Given a save gets no answer, then the draft is kept and Try again re-sends the same body and version. [proof: W06 AS-27]
- **W06.B-08** Given a flag is killed, then its switch is off and disabled, Restore and Archive are offered, and a save refused as killed keeps Save disabled while the draft is enabled. [proof: W06 AS-34]
- **W06.B-09** Given a flag is archived, then every control is disabled, the lifecycle buttons are gone and History stays readable. [proof: W06 AS-37]
- **W06.B-10** Given an admin opens History, then entries show newest first with "You" or the actor id, request ids with Copy, and a readable before and after. [proof: W06 AS-40]
- **W06.B-11** Given a rate limit, then a countdown disables the control that caused it and the draft is kept. [proof: W06 AS-50]
- **W06.B-12** Given the browser goes offline, then a banner shows and the console queries refetch once on return. [proof: W06 AS-52]
- **W06.B-13** Given the stale report is empty, then it says so and names the window. [proof: W06 AS-46]

## Lifecycles
No model is listed. A flag's states (`enabled`, `disabled`, `killed`, `archived`) and moves are {{cap:S38}}'s; the console only offers the moves a status allows.

## Owns
- Query keys `admin.flags` in `lib/query-keys.ts`; the modules listed in `scope`.
- `isAdmin(user)` at `lib/admin/is-admin.ts` (used by the storefront account menu of {{cap:W07}}).
- Owns no database table, queue or topic.

## Decisions
- The editor's draft is a plain-text mirror in a reducer, not a form library: nested lists with stable ids, one pure conversion to the request.
- The layout guard shows the shell or the no-access panel; each page redirects an anonymous visitor itself because only the page knows its address.
- Failure forms are chosen by problem `code` ({{concept:problem-json-errors}}); the 429 countdown follows {{concept:rate-limit-policy}}.

## Known gaps
- Browser and visual proofs (`tests/admin-access.spec.ts`, `tests/admin-flags.spec.ts`, `tests/visual/admin-*.spec.ts`) ran on the dev stack once during the build; the success criteria that need timing or a person are listed in `specs/UNVERIFIED.md`.
- A rule with an attribute or operator outside the contracts' closed sets is shown read-only, but the response schemas are strict, so such a body is refused before it reaches the editor.
