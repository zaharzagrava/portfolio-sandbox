# Feature Specification: W06 — Admin feature-flag console: list, edit targeting and rollout, kill switch, audit trail (`packages/web`)

**Capability**: W06 · **Area**: web (`packages/web`, Next.js 16, App Router, Cache Components on) · **Spec directory**: `specs/web/W06-admin-flags`

**Feature Branch**: `W06-admin-flags` (spec directory only; no branch was created)

**Created**: 2026-10-07

**Status**: Draft

**Input**: "Admin feature-flag console: list, edit targeting and rollout, kill switch, audit trail (the Next.js app in `packages/web`)". Sources: constitution V, VI, VII.7; `packages/web/AGENTS.md` and the Next.js guides *Authentication with Cache Components*, *Instant navigation* (`instant`), *Data security*, and the `page`, `forbidden` file conventions; `docs/architecture/pattern-map.md` (rows naming W06: P0515, P0901); the backend spec `specs/domains/S38-feature-flags/spec.md` (the admin API this console consumes); the specs already written for W01, W02, W04 (shared helpers, copy conventions); the current draft in `app/admin`, `lib/api/admin.ts`, `tests/admin-flags.spec.ts`. The Interview-Prep notes are not present in this checkout (`.specify/memory/Interview-Prep` does not exist); S38 records the notes it read (`09-data-and-infrastructure.md` §38, SD-38: "admin UI and audit log"), and this spec relies on that record.

Companion files: [`questions.md`](questions.md) (decisions taken unattended, tagged, BREAKING first), [`test-plan.md`](test-plan.md) (one row per scenario), [`gaps.md`](gaps.md) (what today's code lacks, missing backend pieces, test tooling), [`checklists/requirements.md`](checklists/requirements.md).

## Scope

A platform administrator ships a feature dark, ramps it up, and pulls it back, all from one console: sees every flag and its state, creates a flag, edits its variants, targeting rules and percentage rollout without silently overwriting a colleague, switches a misbehaving flag off everywhere with the kill switch, restores or archives it deliberately, reads who changed what and when, and finds flags that should be deleted. Every screen works at phone and desktop width, from the keyboard and with a screen reader, and in every state an admin can reach (loading, empty, error, partial, unauthorized, forbidden, conflict, rate limited, offline).

In scope (every screen and state):

- **The admin shell** (`/admin/**`): header, navigation, mobile menu, the guard and the forbidden panel.
- **Flag list** (`/admin/feature-flags`): status filter, keyset paging, row actions (open, kill, restore, archive), empty and error states.
- **Create** (`/admin/feature-flags/new`): a new flag that starts disabled and dark.
- **Flag editor** (`/admin/feature-flags/{key}`): definition (description, owner, client-side, expiry, enabled switch), variants, default and off variant, bucketing unit, ordered targeting rules with conditions, fixed-variant or percentage-rollout outcome, save with optimistic concurrency, conflict handling.
- **Lifecycle actions**: kill switch, restore, archive, with confirmation and the visible outcome of each.
- **Audit trail** (`/admin/feature-flags/{key}?tab=history`): newest-first history with before and after of every change, paging.
- **Stale-flag report** (`/admin/feature-flags?tab=stale`): expired and unused flags.
- The visible form of every error these screens can meet (constitution V.3), layout at mobile (≤ 640 px) and desktop (≥ 1024 px), keyboard and screen-reader access, and the rendering and state rules of constitution VI.

Out of scope (owners named):

- Every flag rule: definition validation and limits, lifecycle legality, evaluation, bucketing, optimistic concurrency, kill-wins-races, audit atomicity, propagation → **S38**. W06 shows and handles each outcome and never re-implements it (VI.9).
- Sign-in, sessions, the session-ended flow, `requireServerSession`, `<ProblemAlert />` → **W01**. The BFF session and the forwarding of `/api/admin/flags/**` → **S48**. The navbar, footer, skip link, global error and not-found pages → **W07**.
- The browser-facing `GET /api/flags` (pre-evaluated client flags) and exposure logging → used by other web capabilities and S39; W06 does not call it. A "preview evaluation for a context" tool is not part of this release (`questions.md`).
- Experiments, assignment and results → **S39**. Looking up a shop's plan → **S18**. Resolving an admin's e-mail from `actorId` → **S01** (the audit shows the id; `gaps.md`).
- Search by key, bulk edit, import and export of flags, hard delete (S38 has none: archive is soft and the key stays reserved).
- Other admin screens. The shell is built so a later capability adds an entry to the navigation registry (Provides).

## Screens and routes

Rendering: every page is a Server Component whose static shell (heading, tabs frame, skeleton) is sent immediately; the session read and the data stream in behind a Suspense boundary; interactive parts are client components below it (FR-002).

| Route | Screen | Needs | URL state |
|---|---|---|---|
| `/admin` | redirect to `/admin/feature-flags` (today's temporary `redirects()` entry in `next.config.ts` stays: a page that calls `redirect()` cannot be prerendered, and a temporary redirect keeps `/admin` free for an overview later) | — | — |
| `/admin/feature-flags` | Flag list (tab **Flags**) | admin | `status` (`all` default, `enabled`, `disabled`, `killed`, `archived`), `cursor` |
| `/admin/feature-flags?tab=stale` | Stale-flag report (tab **Stale**) | admin | `tab=stale`, `days` (1–30, default 14) |
| `/admin/feature-flags/new` | Create flag | admin | — |
| `/admin/feature-flags/{key}` | Flag editor (tab **Definition**) | admin | — |
| `/admin/feature-flags/{key}?tab=history` | Audit trail (tab **History**) | admin | `tab=history`, `cursor` |

A `{key}` that does not match S38 FR-001's pattern, and a key the API does not know, are the same not-found page (AS-31, AS-54). Retired draft behaviour: the create **dialog** on the list page and the `data-testid="flag-row"` hook leave (`questions.md`).

## Layout, keyboard and screen-reader access

Common frame (W07 provides the skip link and the root `<main>` rules; W06 provides the rest):

- **Desktop (≥ 1024 px)**: a header row (brand link "Marketplace Admin" → `/admin`, a link "Back to marketplace" → `/`, and the viewer's e-mail as plain text) above a persistent left sidebar (landmark `nav`, name "Admin") listing the navigation registry (today one entry: **Feature flags**), and a content area with one `h1`, then the page body.
- **Mobile (≤ 640 px)**: no sidebar. A top bar holds the button "Open menu", the brand link and the page name; the menu opens a drawer with exactly the sidebar's content, closes on choosing an entry or on Escape, and returns focus to "Open menu". Between 641 and 1023 px the mobile frame is used (today the sidebar disappears at 768 px and nothing replaces it, so the navigation is unreachable on a phone; `gaps.md`).
- **Focus order** is reading order: skip link → (menu button | sidebar) → `h1` → page actions → tabs → filters → table, cards or form → pagination. After a route change focus lands on the new `h1`. The current navigation entry and the current tab carry `aria-current="page"` (entry) / `aria-selected="true"` (tab, `role="tablist"`).
- Every page has exactly one `h1`; sections use `h2`.

| Page | Desktop (≥ 1024 px) | Mobile (≤ 640 px) | Always reachable |
|---|---|---|---|
| Flag list | heading row with the primary button **New flag** at the right; tabs (Flags, Stale); status tabs and the table on one card; actions in the last column | heading, then **New flag** full width; tabs and status filter scroll horizontally inside their own strip; each row is a card (key as its heading; status, owner, client-side, expiry, updated as labelled pairs; a menu button at the card's end) | **New flag**, status filter, row menu, pagination links |
| Stale report | heading, window select at the right, table | window select under the heading; rows as cards | window select, each row's link to its flag |
| Create | centred form card, max 40 rem, sections stacked | full-width stacked form | **Create flag**, **Cancel** |
| Editor | page header (key, status badge, version, then **Kill switch** and the lifecycle menu at the right); a notice area; two columns: left the definition form (basics, variants, default and off), right a sticky help card ("How a flag is evaluated"); targeting rules full width below; the save bar docked at the bottom of the content with **Save changes** and **Discard** | header stacked; **Kill switch** is a full-width button directly under the header; one column in the order basics, variants, default and off, rules, help; each rule is a card with its own disclosure; the save bar is docked to the bottom of the screen and stays visible | **Kill switch**, **Save changes**, **Discard**, tabs |
| History | tab strip, then a list of entries; the entry's details open inline | the same list, one column; details open inline | tabs, **Older** / **Newest** links |

Dialogs are centred cards on desktop and full-height sheets on mobile; their buttons are in the same order (cancel, then primary) and stay visible without scrolling the page.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Find and scan the flags (Priority: P1)

An admin opens the console and sees every active flag with its state, owner, whether browsers can see it, when it expires and when it changed. They narrow by status, page through long lists and open or act on a flag from its row.

**Why this priority**: every other action starts here; a console that hides a killed flag or mislabels a state is dangerous.

**Independent Test**: seed flags in each status, open the list, change the filter, follow the paging links.

**Acceptance Scenarios**:

- **AS-01** (The list shows every active flag at a glance) — **Given** an admin and flags in several statuses, **When** they open `/admin/feature-flags`, **Then** the heading is "Feature flags", a table (captioned "Feature flags") lists the non-archived flags in ascending key order with the columns **Key** (a link to the editor), **Description**, **Status**, **Owner**, **Client-side** ("Yes" or "No"), **Expires** (a UTC date or "—"), **Updated** (UTC), and an **Actions** column; the status shows as a text badge ("Enabled", "Disabled", "Killed", "Archived") and never by colour alone; the list fetch asked for the default page size and the admin sees no evaluation counters (S38 FR-015; AS-56).
- **AS-02** (The status filter lives in the URL) — **Given** the list, **When** the admin chooses the **Killed** status tab, **Then** the URL becomes `/admin/feature-flags?status=killed`, only killed flags are listed, the tab is `aria-selected`, reloading or sharing the URL shows the same list, and the browser's Back button returns to the previous filter; an unknown `status` value in the URL is treated as `all` (S38 AS-56).
- **AS-03** (Archived flags are hidden until asked for) — **Given** archived flags exist, **When** the admin opens the list with no filter, **Then** no archived flag appears and the status tabs read **All active**, **Enabled**, **Disabled**, **Killed**, **Archived**; **When** they choose **Archived**, **Then** the URL is `?status=archived`, the request carries `includeArchived=true`, archived flags are listed with the badge "Archived" and no row actions other than "Open" (S38 AS-56, AS-36).
- **AS-04** (Long lists page forward by cursor) — **Given** more flags than one page holds, **Then** the page shows a link **Next page** (carrying the opaque `nextCursor` in `?cursor=`) only when `nextCursor` is not null, and a link **First page** whenever a cursor is in the URL; following links never repeats or skips a flag; changing the status filter drops the cursor; the paging text reads "Showing {n} flags" (the count of rows on the page, never a total, because the API returns none) (S38 AS-56, FR-015).
- **AS-05** (Empty states say what to do) — **Given** no flag exists at all, **Then** the table is replaced by "No feature flags yet." with the button **New flag**; **Given** flags exist but none has the chosen status, **Then** it reads "No {status} flags." with a link **Show all active flags**; the two states are never the same message.
- **AS-06** (The list loads without layout shift) — **Given** the list is loading or streaming, **Then** the shell and heading are already visible and the card shows skeleton rows shaped like the table (cards on mobile), not a spinner and not the word "Loading..."; nothing shifts when data arrives.
- **AS-07** (A failed list is a recoverable state) — **Given** the list request fails with a `5xx`, a network error or `503`, **Then** the card shows the alert of the error catalogue with a **Try again** button (for `5xx`, with "Reference: {requestId}") instead of the table; **Given** data is already on screen and a background refetch fails, **Then** the data stays and a status line "Couldn't refresh. Showing the last loaded list." with **Try again** appears above the table.
- **AS-08** (Every row is operable) — **Given** a row, **Then** its **Actions** cell is a menu button named "Actions for {key}" offering **Open**, **Kill switch** (only for `enabled` and `disabled` flags), **Restore** (only for `killed`), **Archive** (only for `disabled` and `killed`); each action behaves exactly as on the editor (Stories 3 and 4) including its confirmation dialog; the menu opens with Enter or Space and moves with the arrow keys; focus returns to the menu button when it closes.

---

### User Story 2 — Create a flag that starts dark (Priority: P1)

An admin defines a new flag while the code is already deployed. It starts disabled, so nothing changes for anyone until they deliberately enable and ramp it.

**Why this priority**: separating deploy from release is the reason flags exist; a create that switches a feature on for everyone is a production incident.

**Independent Test**: create a flag through the form and read it back in the editor.

**Acceptance Scenarios**:

- **AS-09** (A new flag starts disabled, with the simplest useful definition) — **Given** the admin presses **New flag**, **When** `/admin/feature-flags/new` opens, **Then** the form shows **Key**, **Description**, **Owner** and the starter definition "On/off flag": variants `off` = false and `on` = true, default variant `off`, off variant `off`, no rules, bucketing unit `userId`, not client-side, no expiry, status **Disabled**; **When** they enter a key and press **Create flag**, **Then** one `PUT` with `expectedVersion: 0` is sent, the browser goes to `/admin/feature-flags/{key}` and a status toast reads "Flag {key} created. It is disabled." (S38 AS-01, FR-011).
- **AS-10** (Owner starts as the viewer, description is optional) — **Given** a signed-in admin, **Then** **Owner** is pre-filled with the viewer's e-mail (editable, required), and **Description** may stay empty; today's "Description is required" rule and "at least 2 characters" key rule are gone; the key field has the hint "Lowercase letters, digits and hyphens. It cannot be changed later." and its `maxLength` and `pattern` hint are those the contracts schema exports, and the server remains the judge (S38 FR-001).
- **AS-11** (The new flag opens in the editor, ready to ramp) — **Given** the create succeeded (`201` with `Location`), **Then** the editor shows version 1, the status badge "Disabled", and the notice "This flag is disabled: everyone gets the off variant. Turn on **Enabled** and save to start serving rules." (S38 FR-020).
- **AS-12** (A key that exists or is reserved is refused at the key field) — **Given** the key already exists (`409 version_conflict` on create) **Then** the message under **Key** reads "A flag with this key already exists." with a link **Open {key}**; **Given** the key belonged to an archived flag (`409 flag_archived`), **Then** "This key belonged to an archived flag and can't be reused."; focus moves to the key field in both cases; nothing else is lost (S38 AS-07, FR-013).
- **AS-13** (The flag limit is explained) — **Given** `422 flag_limit_reached`, **Then** the form alert reads "The limit of 500 active flags is reached. Archive a flag you no longer need, then try again." with a link **Review stale flags** to `?tab=stale` (S38 AS-12, FR-006).
- **AS-14** (Semantic problems appear all at once, at their fields) — **Given** `422 flag_definition_invalid` with `errors: [{path, code}]`, **Then** the form shows an alert summary (`role="alert"`) listing every problem as a link to its field, each field with a problem gets its message and `aria-invalid="true"` / `aria-describedby`, problems whose path has no field on the form are listed in the summary only, and focus moves to the first problem; codes map to the copy of the error catalogue (S38 AS-10, AS-11, FR-005).
- **AS-15** (Request-shape problems are shown per field) — **Given** `400 validation_failed` with an `errors` list, **Then** each entry appears under the field it names (the others in the summary) and focus moves to the first; the UI never produces the shape errors of S38 AS-09 by itself except by a missing required value, which it stops before sending (**Owner** and **Key** are required and show "Enter a key." / "Enter an owner." under the field) (S38 AS-09).
- **AS-16** (Pressing the button twice creates one flag) — **When** the admin presses **Create flag** twice quickly, **Then** one request is sent, the button shows "Creating…" with a spinner, is disabled and `aria-busy`, and the form does not accept edits while the request is in flight.

---

### User Story 3 — Edit targeting and rollout without overwriting a colleague (Priority: P1)

An admin opens a flag, adds a staff rule, sets a 5% rollout, widens it later, and saves. If someone else saved in between, the console says so and does not overwrite their work.

**Why this priority**: this is how a feature is released safely; silent overwrite is the failure the API's `expectedVersion` exists to stop.

**Independent Test**: open a flag, change basics and a rollout, save, reload; then two sessions edit the same flag.

**Acceptance Scenarios**:

- **AS-17** (Opening a flag shows its whole definition and state) — **Given** an existing flag, **When** the admin opens `/admin/feature-flags/{key}`, **Then** the header shows the key as `h1`, the status badge, "Version {n}", "Created {UTC}" and "Updated {UTC}"; the **Definition** tab shows, in order, **Basics** (Description, Owner, Client-side, Expires, **Enabled** switch), **Variants**, **Default and off variants** (two selects, plus **Bucket by** with `userId`/`shopId`), and **Targeting rules** as an ordered list; the help card states the evaluation order of S38 FR-020 in plain words ("Killed or disabled: everyone gets the off variant. Otherwise the first rule that matches decides. If no rule matches, the default variant is served.").
- **AS-18** (Editing the basics and saving works end to end) — **Given** an `enabled` or `disabled` flag, **When** the admin changes **Description**, ticks **Client-side** and presses **Save changes**, **Then** one `PUT` with `expectedVersion` = the version they loaded is sent with the whole definition, the form shows "Saved." (status line, `role="status"`), the header shows the new version from the response, and a reload shows the saved values (S38 AS-02, FR-011).
- **AS-19** (Variants are typed and editable) — **Given** the **Variants** section, **Then** each variant is a row with **Key**, **Type** (Boolean, String, Number, JSON) and **Value** (a true/false select, a text field, a number field, a monospace text area), a **Remove** button named "Remove variant {key}" and the section has **Add variant**; an existing variant's type is inferred from its stored value; removing a variant that is still chosen as default, off or a rule outcome clears that choice and marks it "Choose a variant." (never a silent reassignment); variant values of a client-side flag are visible to every visitor (AS-29).
- **AS-20** (Default, off and rule outcomes choose from the variants) — **Given** the default variant, off variant and every rule outcome, **Then** each is a select listing exactly the current variants by key, in the order shown in **Variants**, and a variant added or renamed is available at once.
- **AS-21** (Targeting rules: add, edit, reorder, remove) — **Given** the **Targeting rules** list, **Then** it is an ordered list named "Targeting rules, checked top to bottom; the first match wins"; each rule shows its position, an **Id**, up to its conditions, and an outcome; **Add rule** appends a rule with no conditions and a fixed outcome; **Remove rule {n}** removes it; **Move rule {n} up** and **Move rule {n} down** reorder it (disabled at the ends), focus stays on the pressed button after the move and the change is announced ("Rule {id} moved to position {n}"); an empty list reads "No rules. Everyone gets the default variant." (S38 FR-003, FR-020).
- **AS-22** (Condition inputs follow the operator) — **Given** a rule's conditions, **Then** each is **Attribute** (select of the closed set from the contracts: `userId`, `shopId`, `role`, `email_domain`, `country`, `platform`, `plan`), **Operator** (`in`, `not_in`, `eq`, `neq`, `gte`, `lte`, `exists`, shown as "is one of", "is not one of", "equals", "does not equal", "at least", "at most", "is set") and **Values**: `in`/`not_in` take a list (one value per line in a text area, blank lines ignored), `eq`/`neq` one text field, `gte`/`lte` one number field, `exists` none; changing the operator keeps what still applies and drops what does not; **Add condition** and **Remove condition {n} of rule {id}** exist (S38 FR-004, FR-021).
- **AS-23** (Rollout slices are in percent with a live total) — **Given** a rule whose outcome is **Percentage rollout**, **Then** it lists slices, each a variant select and a **Weight (%)** field accepting up to two decimals; the field shows percent while the request carries integer basis points (5 → 500; 12.5 → 1250); a line "Total: {x}%" updates as weights change and a button **Make the last slice the remainder** sets the last slice to 100 minus the others (never below 0); the total is information only: a total other than 100% is sent as typed and the backend's `weights_sum_invalid` answer is shown at the rule (AS-14); help text: "Raising a percentage only adds visitors; nobody who already has the variant loses it." (S38 AS-03, FR-022); switching a rule between **Fixed variant** and **Percentage rollout** swaps the outcome and never sends both (S38 FR-003).
- **AS-24** (Enable and disable are one switch) — **Given** an `enabled` or `disabled` flag, **Then** **Enabled** is a switch (role `switch`, label "Enabled", description "When off, everyone gets the off variant.") bound to the draft, and takes effect only on **Save changes**; on the list and the header the badge reads "Enabled" / "Disabled" accordingly (S38 FR-010).
- **AS-25** (Save is available only when there is something to save, and unsaved work is protected) — **Given** the editor with no changes, **Then** **Save changes** and **Discard** are disabled; **Given** edits, **Then** they are enabled and a line "Unsaved changes" shows; **When** the admin follows any link on the page (shell navigation, tabs, **Back to flags**, a row link) or closes the tab, **Then** the browser or a dialog "Discard unsaved changes?" with **Keep editing** (focused) and **Discard changes** intervenes; **Discard** restores the loaded definition after the same confirmation.
- **AS-26** (A successful save replaces the draft with the server's answer) — **Given** `200` or `201`, **Then** the form is reset to the returned flag (so the version, status and any normalisation shown are the server's), **Save changes** is disabled again, and the detail and list data are refreshed under their keys (FR-003).
- **AS-27** (A lost response is safe to retry) — **Given** the save request fails without a response (offline, timeout), **Then** the draft is kept untouched, the alert reads "Couldn't reach the server. Your changes haven't been confirmed. Check your connection and try again." with **Try again**, and **Try again** re-sends the same body and the same `expectedVersion`; if the first attempt had been applied, the server answers the equal definition with a no-op `200` and the screen shows "Saved." exactly as for a first success (S38 AS-04).
- **AS-28** (Two admins: the later save is refused, not merged and not lost) — **Given** another admin saved while this one was editing, **When** the save answers `409 version_conflict` with `currentVersion`, **Then** a warning banner (`role="alert"`) reads "{key} was changed by someone else (now version {currentVersion}). Your changes haven't been saved." with **Load latest** (replaces the form with the server's current definition after the "Discard unsaved changes?" confirmation) and **Keep editing** (dismisses the banner; the draft stays so values can be copied); until the latest is loaded **Save changes** is disabled with the description "Load the latest version before saving."; nothing is overwritten (S38 AS-05, AS-06).
- **AS-29** (Client-side flags say who can read them) — **Given** **Client-side** is ticked, **Then** a notice under it reads "Browsers can read this flag's name, variant and value. Never put secrets in a client-side flag." and the notice is associated to the checkbox (`aria-describedby`) (S38 FR-002, FR-040).
- **AS-30** (Syntax the UI cannot send is caught before sending) — **Given** a JSON variant whose text does not parse, or a number variant that is not a number, **When** the admin presses **Save changes**, **Then** no request is sent, the field shows "Enter valid JSON." / "Enter a number.", the summary alert lists them and focus goes to the first; this is the only validation the editor performs itself (every other rule comes from the API, VI.9).
- **AS-31** (An unknown flag is a not-found page) — **Given** a key the API does not know (`404 flag_not_found` on open), **Then** the page shows "We couldn't find that flag." with a link **All flags**; **Given** the flag disappears between open and save (`404 flag_not_found` on `PUT`), **Then** the same message appears as the form alert and the draft is kept; a key that does not match the key pattern gives the same page without any request (AS-54) (S38 AS-08).

---

### User Story 4 — Pull the kill switch, restore, archive (Priority: P1)

When the new checkout fails or assistant costs spike, an admin turns the flag off everywhere with one deliberate action, regardless of its targeting. Nobody can switch it back on by saving the form; restoring is a separate, deliberate step, and archiving retires it.

**Why this priority**: the kill switch is the safety net of every release.

**Independent Test**: kill a flag with rules and rollouts; try to enable it; restore it; archive it.

**Acceptance Scenarios**:

- **AS-32** (Kill needs one confirmation and shows its outcome) — **Given** an `enabled` or `disabled` flag, **When** the admin presses **Kill switch** (editor header or row menu), **Then** an alert dialog "Kill {key}?" opens with the text "Every evaluation will serve the off variant ({offVariant}) regardless of targeting. Rules and rollouts are kept. The change reaches services within seconds and browsers on their next fetch. Restoring is a separate step." and focus on **Cancel**; **When** they press **Kill flag**, **Then** one `POST …/kill` is sent, the button shows "Killing…", and on `204` the dialog closes, the status badge reads "Killed", a status toast reads "Flag {key} killed.", the editor shows the killed notice (AS-34), and the history gains a `kill` entry on the next view (S38 AS-30).
- **AS-33** (The kill switch is always within reach) — **Given** the editor at any width, **Then** **Kill switch** is visible without scrolling (the header at ≥ 1024 px, a full-width button directly under the header at ≤ 640 px), it is available while the draft has unsaved changes (a kill never needs a save first, and the draft is left untouched), and on the list it is in the row menu.
- **AS-34** (A killed flag is visibly dead and cannot be enabled by editing) — **Given** a `killed` flag, **Then** the editor shows a banner (`role="status"`) "This flag is killed. Everyone gets the off variant until it is restored. Restoring makes it disabled; enabling it is a separate, deliberate save."; the **Enabled** switch is off and disabled with the description "A killed flag can't be enabled. Restore it first."; other fields stay editable and savable (they are saved with `enabled: false`); **Restore** and **Archive** are offered, **Kill switch** is not (S38 FR-012, AS-34).
- **AS-35** (A save that would enable a killed flag is refused) — **Given** the flag was killed by someone else after this admin loaded it enabled, **When** their save answers `409 flag_killed`, **Then** the alert reads "{key} was killed while you were editing. It can't be enabled until it is restored." the page refetches the flag (so the killed banner and badge appear), the draft is kept, and **Save changes** is disabled until the draft's **Enabled** is off or the flag is restored (S38 AS-33).
- **AS-36** (Restore returns the flag to disabled, never to enabled) — **Given** a `killed` flag, **When** the admin presses **Restore** and confirms the dialog "Restore {key}? It becomes disabled: still off for everyone. You can enable it afterwards by saving.", **Then** one `POST …/restore` is sent, on `204` the badge reads "Disabled", the **Enabled** switch becomes usable and a status toast reads "Flag {key} restored. It is disabled." (S38 AS-35).
- **AS-37** (Archive retires a flag and makes it read-only) — **Given** a `disabled` or `killed` flag, **When** the admin presses **Archive** and confirms "Archive {key}? It leaves the active list and stops evaluating (services get their fallback). Its key can never be reused. Its history stays readable.", **Then** one `POST …/archive` is sent, on `204` the editor becomes read-only with the banner "This flag is archived. It can't be edited, killed or restored.", every form control is disabled, the lifecycle buttons disappear, the **History** tab stays usable, and a status toast reads "Flag {key} archived."; **Archive** is not offered for an `enabled` flag (the row menu and header omit it) (S38 AS-36, FR-013).
- **AS-38** (Races and illegal moves have plain explanations) — **Given** a lifecycle call answers `409 invalid_transition` with `currentStatus`, **Then** the alert reads "{key} is now {currentStatus}, so that isn't possible. The page has been refreshed." and the flag refetches; `409 flag_archived` on any action or save reads "{key} was archived and can't be changed." and the page refetches into the read-only state; **Given** kill is pressed on a flag that is already killed, the API answers `204` and the UI shows the same success as a first kill (S38 AS-31, AS-32, AS-35, AS-36).
- **AS-39** (Lifecycle buttons are single-flight and honest about progress) — **Given** a lifecycle request is in flight, **Then** every lifecycle button and **Save changes** is disabled, the pressed button shows its progress label and `aria-busy`, and a second press sends nothing; if the request fails the dialog stays open with the alert of the error catalogue and the buttons are usable again.

---

### User Story 5 — Read the audit trail (Priority: P2)

An admin sees who changed what, when and from which request, with the before and after of each change, including kills.

**Why this priority**: a flag change is a production change; reconstructing "what happened at 14:03" must not need a database.

**Independent Test**: create, update, kill a flag; open the history tab.

**Acceptance Scenarios**:

- **AS-40** (The history lists every applied change, newest first) — **Given** a flag created, updated and killed, **When** the admin opens the **History** tab, **Then** `?tab=history` is in the URL and a list (named "Change history") shows entries newest first `[Killed, Updated, Created]`, each with the action label ("Created", "Updated", "Killed", "Restored", "Archived"), the time (UTC, in a `<time datetime>` element), the actor ("You" when `actorId` is the viewer's id, otherwise the actor id in monospace with a **Copy** button) and the request id with a **Copy** button (S38 AS-43, FR-050).
- **AS-41** (Each entry opens to a readable before and after) — **Given** an entry, **When** the admin presses **Show changes**, **Then** it expands (button `aria-expanded`) to a list of the fields that differ ("Status: Enabled → Killed", "Description: … → …", "Rules: 1 rule → 2 rules" with the full before/after rule and variant text on demand) computed from the `before` and `after` of the entry; a `create` entry says "Created with" and lists the whole definition; a no-field-difference entry (cannot occur from a no-op save, S38 FR-014) is shown as "No visible changes"; all values render as text (VI.7).
- **AS-42** (History pages by cursor and survives a bad cursor) — **Given** more entries than one page, **Then** an **Older** link carries `nextCursor` as `?cursor=` and a **Newest** link appears while a cursor is in the URL; the order never repeats or skips an entry; **Given** `400 invalid_cursor`, **Then** the panel reads "That page link is no longer valid." with a link **Go to the newest changes** (S38 AS-44).
- **AS-43** (An archived flag's history stays readable) — **Given** an archived flag, **Then** the **History** tab loads with all entries including the `archive` entry; **Given** an unknown key, **Then** the not-found page of AS-31 (S38 AS-46).
- **AS-44** (A change appears in the trail without reloading the page) — **Given** the admin saved, killed, restored or archived a flag, **When** they open or are on **History**, **Then** the new entry is there (the history data for that flag is refetched after every successful change; opening the tab always refetches) (FR-003).

---

### User Story 6 — Find flags that should be deleted (Priority: P2)

Flags are tech debt. An admin sees expired flags and flags nobody has evaluated for a while and goes straight to them to archive.

**Why this priority**: the notes name stale-flag cleanup explicitly; the report is useless unless it leads to action.

**Independent Test**: seed an expired flag and an unused flag; open the report.

**Acceptance Scenarios**:

- **AS-45** (The stale tab lists expired and unused flags) — **Given** an admin, **When** they open the **Stale** tab, **Then** `?tab=stale` is in the URL and a table (captioned "Stale flags") lists the report's items (already sorted by key) with **Key** (a link to the editor), **Owner**, **Status**, **Reason** ("Expired" or "Not evaluated in the last {days} days"), **Expires**, **Created** and **Evaluations** (the window's total); a note under the heading says counts are approximate and that expiry never changes how a flag evaluates; archived flags never appear (S38 AS-48, AS-50, FR-053).
- **AS-46** (The window is a choice in the URL, and an empty report is good news) — **Given** the window select (7, 14, 21, 30 days), **When** the admin changes it, **Then** the URL is `?tab=stale&days=7` and the report is refetched; an unknown or out-of-range `days` in the URL behaves as the default 14 and the select shows 14; **Given** an empty `items`, **Then** the table is replaced by "No stale flags. Nothing has expired and every flag has been evaluated in the last {days} days." (S38 AS-49).

---

### User Story 7 — Only admins get in; every screen behaves under failure and on every device (Priority: P1)

Anonymous visitors are sent to sign in and come back; non-admins see nothing of the flags; expired sessions, rate limits, server errors, offline, keyboard and phone screens all behave.

**Why this priority**: a flag write is a production write; the console must fail safely and be usable by everyone on duty, including on a phone at night.

**Independent Test**: the scenarios below, run on each page.

**Acceptance Scenarios**:

- **AS-47** (Anonymous visitors are sent to sign in and come back) — **Given** a signed-out visitor, **When** they open any `/admin/**` URL, **Then** the server redirects to `/login?returnTo=<that path and query>` before any flag data is requested or sent, and after sign-in they land on it (W01).
- **AS-48** (A non-admin learns nothing about flags) — **Given** a signed-in member who is not an admin, **When** they open any `/admin/**` URL, **Then** the page shows only the panel "You don't have access to this area." with a link **Back to marketplace**, no flag data is requested, and the shell shows no admin navigation; **Given** a request still answers `403` (role changed, or a stale page), **Then** the same panel replaces the content, identical for an existing and an unknown key (S38 AS-54, FR-060); no admin link appears in the storefront navbar for non-admins (AS-66).
- **AS-49** (An expired session ends politely, once) — **Given** the session ended, **When** any console request answers `401`, **Then** W01's session-ended flow runs exactly once (toast "Your session ended. Sign in again to continue." with **Sign in** to `/login?returnTo=<current URL>&notice=session_expired`), open dialogs close, the guard redirects, and the page says before it goes that unsaved edits cannot be recovered ("Your unsaved edits are lost. Copy them first if you need them." shown in the toast description only while the draft is dirty) (W01 AS-26, S38 AS-53).
- **AS-50** (Rate limits show a countdown) — **Given** `429` with `Retry-After` on a write (S38 FR-061: 30 per minute) or a read, **Then** the alert says "Too many requests. Try again in {wait}." (wait text rules of W01 FR-041), the control that caused it is disabled and re-enables when the countdown reaches 0 (updating once per second without announcing every tick; the start and the end are announced once each); the draft is kept (S38 AS-55).
- **AS-51** (Server errors are generic but traceable) — **Given** a `5xx` problem+json, **Then** the alert shows the stable generic copy "Something went wrong on our side." and "Reference: {requestId}" with a **Copy** button, never `detail` text beyond what the catalogue allows, a stack, SQL or upstream text; a body that is not problem+json shows the same generic copy without a reference (V.3; S38 AS-45, FR-062).
- **AS-52** (Offline is visible and recoverable) — **Given** the browser goes offline, **Then** a status banner "You're offline. Changes can't be saved." shows on every console page and write buttons stay enabled only for drafting (a write attempt shows the alert "Couldn't reach the server. Check your connection and try again."); **When** it comes back online, **Then** the banner clears and open queries refetch once.
- **AS-53** (A rejected CSRF or origin check says reload) — **Given** a write answers `403 csrf_invalid` or `403 origin_not_allowed`, **Then** the alert reads "We couldn't verify this request. Reload the page and try again." with a **Reload** button (W01 AS-11); the draft is not auto-discarded (the browser's unload prompt of AS-25 still protects it on reload).
- **AS-54** (A malformed key is a not-found page without a request) — **Given** `/admin/feature-flags/Bad_Key!` (not matching S38 FR-001's pattern), **Then** the not-found page of AS-31 is shown and no API request is made.
- **AS-55** (Server data, URL state and local state each have one home) — **Given** the console source, **Then** server data is read through TanStack Query with keys from `lib/query-keys.ts` (`queryKeys.admin.flags.*`) and is never copied into `useState`, Context or a store (a form draft initialised from a query result and reset from each server answer is local UI state and the one allowed copy); the status filter, tab, window, cursor are in the URL; dialogs, the draft and the expanded history entries are local state; no `fetch`, `axios` or `EventSource` appears in a component or hook; list rows use stable keys (flag key, audit `id`, rule `id`, variant key) and never the array index; no new Context or global store is added (`useAuth()` is the only Context read); the per-user pages never use `use cache` and responses are never put in a shared cache; after sign-out the query cache holds no flag data (W01).
- **AS-56** (No credential or definition leaves the page by the wrong door) — **Given** the console source and a recorded session, **Then** every request is a relative same-origin `/api/admin/flags…` path, every non-GET carries W01's CSRF header, nothing reads or writes `localStorage`, `sessionStorage` or a non-HttpOnly cookie, no token is referenced, no request or response body of a flag (definitions, variant values) is written to `console.*`, analytics or error reports (page names use the route pattern `/admin/feature-flags/:key`), and the unsaved draft is never persisted outside memory.
- **AS-57** (Everything works from the keyboard, dialogs included) — **Given** any dialog (kill, restore, archive, discard), **Then** opening it moves focus inside (to **Cancel** for the destructive ones, to **Keep editing** for discard), Tab stays inside, Escape closes it unless a request is in flight, and on close focus returns to the control that opened it (to the row's menu button for row actions, or to the flag link if the row left the list); row menus and the mobile drawer behave as in AS-08 and the common frame; every pointer action (add, remove, move rule, add condition) has a keyboard path.
- **AS-58** (Tables, forms and live regions make sense to a screen reader) — **Given** every table, **Then** it has a caption, `scope="col"` headers, no layout tables, and status never relies on colour alone; **Given** the editor, **Then** every field has a visible label, groups are `fieldset`/`legend` ("Variant {key}", "Rule {n}", "Condition {n}"), the rules list is an `ol`, errors are linked by `aria-describedby`, **Saved.**, toasts and the "Rule moved" line use `role="status"`, conflicts and errors use `role="alert"`, the countdown follows AS-50, and the **Enabled** switch exposes its state.
- **AS-59** (The shell at 390 px and 1280 px) — **Given** any console page, **Then** at ≥ 1024 px a persistent left sidebar shows the navigation registry and the header shows the brand, "Back to marketplace" and the viewer's e-mail; at ≤ 640 px a top bar shows the button "Open menu", the brand and the page name, the same entries open in a drawer that closes after a choice and returns focus to the button; the current entry has `aria-current="page"`; there is no horizontal page scroll.
- **AS-60** (The list at 390 px and 1280 px) — **Given** the list and the stale report, **Then** at ≥ 1024 px each is a table inside the content area with actions in the last column; at ≤ 640 px each row becomes a card (the key as its heading, the other columns as labelled pairs, actions in a menu button at the card's end), tabs and the status filter scroll inside their own strip, and nothing requires horizontal scrolling; a 64-character key or a 500-character description wraps inside its cell.
- **AS-61** (The editor at 390 px and 1280 px) — **Given** the editor, **Then** the regions and their order are those of the Layout table; the save bar is docked and visible at both widths while the draft is dirty; rule cards are collapsible disclosures (button `aria-expanded`, named "Rule {n}: {summary}") that start expanded when the flag has at most three rules and collapsed otherwise at ≤ 640 px; nothing requires horizontal scrolling.
- **AS-62** (History and create at 390 px and 1280 px) — **Given** the history list and the create form, **Then** each is a single column at ≤ 640 px with full-width controls and at ≥ 1024 px the form card is centred with a maximum width; a history entry's details wrap and never widen the page.
- **AS-63** (Every page has a loading state that matches its layout) — **Given** any console page loads or streams, **Then** the shell is already visible and the content area shows skeletons shaped like the final layout (list rows, editor sections, history entries, stale rows), not a spinner and not "Loading...", and nothing shifts when data arrives.
- **AS-64** (User content is text) — **Given** a flag description, owner, variant string, a JSON value or an audit value containing markup (`<img onerror=…>`), **Then** it is shown literally as text everywhere (list, editor, dialogs, history) and nothing executes (VI.7).
- **AS-65** (A hidden or reordered list never mixes rows) — **Given** the list changes between two fetches (a flag is killed, another created), **Then** each row keeps its identity by flag key: an open row menu or focus stays with the same flag and a removed row's focus falls to the next row's link (VI.6).
- **AS-66** (Admin entry points are for admins) — **Given** the signed-in viewer's role, **Then** the storefront account menu shows the entry **Admin** (to `/admin`) only when `useAuth().user.role === 'ADMIN'` (presentation only; AS-47 and AS-48 are the enforcement), and the console's own shell never renders navigation before the guard has passed (W07 owns the menu; W06 owns the contract) (constitution VI.5, pattern P0515).

### Edge Cases

- Two admins save at once: the loser sees AS-28; the winner's definition is stored (S38 AS-06). A kill racing a save: the flag ends killed and the saver sees AS-35 (S38 AS-33).
- A replayed save (lost response): AS-27. A repeated kill: AS-38.
- A flag changes under an open editor (someone else saves): the editor does not poll; the next save, refocus-refetch or tab change reveals it through AS-28 or the refetched header; an unsaved draft is never replaced silently (the refetch updates only the header and badges, the draft keeps its basis version).
- A flag with 20 variants and 50 rules: the editor stays usable (rule cards collapse, AS-61); limits are reported by the API with `too_many_*` codes (AS-14).
- A variant removed while referenced: AS-19. An unknown attribute or operator cannot be chosen from the selects; if the API returns one the UI cannot display, the rule is shown as raw JSON in a read-only block with the notice "This rule uses a feature this editor can't show yet. Edit is disabled for it." and the rest stays editable (forward compatibility, V.7).
- A client-side flag in a killed state: the notice of AS-29 stays; the killed banner of AS-34 explains the off variant.
- An expired flag keeps evaluating: the editor shows the **Expires** field with the help text "Expiry is a reminder only. An expired flag keeps working until you change or archive it." and the stale report shows "Expired" (S38 AS-50).
- A very long description or owner: wraps in cells and cards (AS-60); the 500/100 character limits are announced by the API (`description_too_long`, `owner_too_long`), and the inputs carry the `maxLength` the contracts export so typing past it is impossible.
- The viewer's role becomes non-admin mid-session: the next response is `403`, AS-48.
- The shop-targeting values (`shopId`, `userId`) are free text: the console never validates them (S38 owns it) and never looks a shop or user up.

## Requirements *(mandatory)*

### Functional Requirements

**Rendering, data flow and state (constitution VI)**

- **FR-001**: Routes, URL parameters and not-found handling are those of "Screens and routes". Parameters are read from the URL on the server (`searchParams` is awaited inside the Suspense boundary) and parsed with one function per page that falls back to the defaults for unknown values; the same function builds the links (filter tabs, paging, window).
- **FR-002**: Every page is a Server Component. A page renders the heading and the skeleton as its static shell and reads the session, the parameters and the data inside a `<Suspense>` boundary (Cache Components forbids reading `cookies()` or `searchParams` outside one). The admin layout does not `await` the session at its top level; the guard is a component inside a boundary. No page or layout exports `instant = false` (today none of `app/admin` does, and none is added). `'use client'` appears only on the list's filter and menu controls, the editor and its sub-forms, the history disclosure, the dialogs, the offline banner and the mobile drawer. No `use cache` wraps anything that depends on the session; responses are never stored in a shared cache.
- **FR-003**: Server data lives in TanStack Query under keys from `lib/query-keys.ts`: `queryKeys.admin.flags.list({status, cursor})`, `.detail(key)`, `.history(key, {cursor})`, `.stale({days})`, with the prefix `queryKeys.admin.flags.all` for invalidation. A Server Component prefetches the first answer through a server-only data module (`lib/api/admin-flags.server.ts`, which forwards only the session cookie, never returns a token) and hands it to the client through dehydrated state, so the first paint has data and the client query starts hydrated. Admin queries use `staleTime: 0` and refetch on window focus (an admin console is not a place for 60-second-old kill states). Mutations are hooks in `hooks/use-admin-flags.ts` (`useSaveFlag`, `useKillFlag`, `useRestoreFlag`, `useArchiveFlag`): on success the detail query is set from the `PUT` response (or refetched after `204`) and `queryKeys.admin.flags.all` is invalidated, which refetches the list, the stale report and the history.
- **FR-004**: View state that can be shared is in the URL (status, tab, window, cursor); the editor draft, dialog state, expanded history entries and menu state are local (`useReducer`/`useState` in the lowest component). No Context is added; no global store.
- **FR-005**: All network calls are in `lib/api/admin-flags.ts` (client-callable, typed, response bodies parsed with the `packages/contracts` schemas `flagSchema`, `flagPageSchema`, `flagAuditPageSchema`, `staleFlagsSchema`; the request body built from `flagInputSchema`) and `lib/api/admin-flags.server.ts` (server-only). Paths are relative `/api/admin/flags…`; the BFF attaches the session's bearer server-side (W01 C-FWD); the shared client adds the CSRF header on non-`GET`; no token is read in browser code. Today's `lib/api/admin.ts` (`adminApi`, `booleanFlag`, hand-typed `FeatureFlag`) is replaced.
- **FR-006**: Authorization is enforced again below the UI (VI.5): the guard (`requireServerSession(returnTo)` then an `ADMIN` role check on the server) only redirects or shows the panel for convenience; every API call is authorized by S38 (`401`/`403`, FR-060) and the UI follows AS-48/AS-49 on those answers. There is no `proxy.ts` decision. The role comes from the session read, never from a token in browser code; `useAuth()` (read-only) is used only to show the viewer's e-mail and id.
- **FR-007**: The UI holds no business rule of S38. The only checks it performs are the syntactic ones of AS-10, AS-15 and AS-30 (required fields, JSON and number syntax), the presentation conversions (percent ↔ basis points, one value per line ↔ array), and the presentation of legal actions per status (AS-08, AS-34, AS-37) which S38 re-checks (`409 invalid_transition`). Closed sets (attributes, operators, bucketing units, statuses) and field limits (`maxLength`) are imported from the contracts package, so a backend change is a compile error here, not a silent drift.

**Flag list and stale report**

- **FR-010**: The list requests `GET /api/admin/flags` with `limit` omitted (default 50), the `status` filter when it is not `all`, `includeArchived=true` only for `status=archived`, and the cursor; items are shown exactly as returned (key order); the UI never sorts, filters or searches client-side.
- **FR-011**: Row actions use the same hooks and dialogs as the editor (AS-08); after an action succeeds the list refetches and the row's new state is shown without a full page reload; focus handling follows AS-57.
- **FR-012**: The stale report requests `GET /api/admin/flags/stale?days=` with the window from the URL; items are shown in the order returned; rows link to the editor; the report has no actions of its own.

**Create and edit**

- **FR-020**: Create sends `PUT /api/admin/flags/{key}` with `expectedVersion: 0`; the starter definition of AS-09 is a constant in `lib/admin/flags/starter.ts`; the body is built by the same function as a save (`toFlagInput(draft, expectedVersion)`), which converts percent to integer basis points and the one-per-line text to arrays, and sends `rollout` or `variant` per rule, never both.
- **FR-021**: The editor's draft is initialised from the flag read, reset from every successful save response and from **Load latest**, and carries the `version` it was based on; **Save changes** sends that version as `expectedVersion`; it is never silently advanced (AS-28).
- **FR-022**: While a request that writes is in flight, the form is read-only and `aria-busy`; a failed request leaves the draft as typed.
- **FR-023**: Unsaved-changes protection (AS-25) uses the browser's `beforeunload` prompt for unload and the "Discard unsaved changes?" dialog for in-app links; the mechanism is not specified, the outcome is.
- **FR-024**: Timestamps are shown in UTC as "YYYY-MM-DD HH:mm UTC" inside `<time datetime=…>`; the console never shows viewer-local time (audit and expiry are compared across admins and services; this also avoids a server/client rendering difference).

**Lifecycle**

- **FR-030**: Kill, restore and archive send `POST /api/admin/flags/{key}/kill|restore|archive` with no body and no `expectedVersion` (S38 FR-012, FR-013); they are never combined with a save and never optimistic: the UI changes state only from the server's answer (`204` then refetch).
- **FR-031**: Which lifecycle actions are offered per status is presentation: `enabled` → Kill; `disabled` → Kill, Archive; `killed` → Restore, Archive; `archived` → none. Every other combination is still answered by S38 (`invalid_transition`, `flag_archived`) and shown by AS-38.

**Audit**

- **FR-040**: History requests `GET /api/admin/flags/{key}/history` with the cursor from the URL (default limit); entries render from `id`, `action`, `actorId`, `at`, `requestId`, `before`, `after`; the field-level difference of AS-41 is computed in the browser from `before` and `after` by a pure function (`lib/admin/flags/diff.ts`) over the flag response shape; it never fetches anything else.
- **FR-041**: The viewer's own `actorId` is shown as "You" by comparing it with the session user's id; no other actor is resolved (S01 offers no admin lookup here; `gaps.md`).

**Errors**

- **FR-050**: Every failed call is converted by W01's `problemFromError` and shown by W01's `<ProblemAlert />` (FR-040..FR-043 of W01); W06 adds only the catalogue below (copy keyed by stable code and status, never by `detail`/`title` text, except per-field messages of `validation_failed`). A `422 flag_definition_invalid` entry `{path, code}` is mapped to a field by `path` (`rules[0].rollout` → rule 1's rollout; `variants[2].value` → variant 3; `defaultVariant`; `owner`; `expiresAt`; …) by one function (`lib/admin/flags/problem-paths.ts`), and its `code` to the copy below; unknown codes show "This value isn't valid." under the field (or in the summary when no field matches) and the code in a `title` attribute for the on-call.
- **FR-051**: Problem `code` is the stable machine code. S38 FR-062 places it in `type`; W01's `Problem.code` is derived from whichever the backend provides (`questions.md`, CONTRACT).

**Layout, accessibility, observability**

- **FR-060**: Layout rules are those of "Layout, keyboard and screen-reader access"; the breakpoints are ≤ 640 px (mobile frame), 641–1023 px (mobile frame with the editor's two columns collapsed), ≥ 1024 px (desktop frame).
- **FR-061**: Focus and announcements are those of AS-25, AS-28, AS-50, AS-57, AS-58; after a successful create the editor's `h1` takes focus; after a failed submit the first invalid field or the summary takes focus.
- **FR-062**: Observability from the browser: nothing in a flag (definition, variant values, description) is sent to logs, analytics or error reports (AS-56); an error report may carry the route pattern, the problem `code`, `status` and `requestId` (the key the admin was working on is not included). `requestId` is always shown for `5xx` so an on-call engineer can find the backend log line (S38 FR-062, AS-58).

### Error catalogue (visible form of every problem+json code these screens can meet)

Every error body is `application/problem+json` (V.3). Forms: **F** = message under the field; **S** = alert summary above the form; **A** = alert in the open dialog or above the form; **B** = banner; **P** = page-level panel with **Try again**; **T** = toast; **N** = not-found page; **C** = countdown; **W** = session-ended flow.

| Status · code | Raised by | Form and copy |
|---|---|---|
| 400 `validation_failed` | save, create, list/stale/history parameters | **F** per field named in `errors[].field` (others in **S**); first invalid field focused. The UI cannot produce invalid parameters itself; a `400` on a list is the generic copy with a reference |
| 400 `invalid_cursor` | list, history | **P** "That page link is no longer valid." + link to the first page ("Go to the first page" / "Go to the newest changes") (AS-42) |
| 401 `unauthenticated`, `invalid_token`, `session_expired` | any | **W** (AS-49) |
| 403 `permission_denied` / role not admin | any (S38 FR-060) | forbidden panel "You don't have access to this area." (AS-48); an action while the page is open: the panel replaces the content |
| 403 `csrf_invalid`, `origin_not_allowed` | writes | **A** "We couldn't verify this request. Reload the page and try again." + **Reload** (AS-53) |
| 404 `flag_not_found` | open, save, kill, restore, archive, history | **N** "We couldn't find that flag." + **All flags** (AS-31); in an action: **A** same sentence |
| 409 `version_conflict` | save | edit: **B** of AS-28 with `currentVersion`; create: **F** "A flag with this key already exists." + **Open {key}** (AS-12) |
| 409 `flag_killed` | save | **A** "{key} was killed while you were editing. It can't be enabled until it is restored." + refetch (AS-35) |
| 409 `flag_archived` | save, create, kill, restore, archive | save/actions: **A** "{key} was archived and can't be changed." + refetch; create: **F** "This key belonged to an archived flag and can't be reused." (AS-12, AS-38) |
| 409 `invalid_transition` | restore, archive | **A** "{key} is now {currentStatus}, so that isn't possible. The page has been refreshed." + refetch (AS-38) |
| 413 (body above 256 KiB) | save | **A** "This flag is too large to save. Remove variants, rules or long values." |
| 422 `flag_definition_invalid` | save, create | **S** + **F** per `{path, code}` (AS-14); codes: `weights_sum_invalid` "Weights must add up to 100%. They add up to {sum}%." (sum from the error, basis points ÷ 100), `too_many_variants` "A flag can have at most 20 variants.", `too_many_rules` "A flag can have at most 50 rules.", `too_many_conditions` "A rule can have at most 10 conditions.", `too_many_values` "A condition can list at most 100 values.", `value_too_large` "This value is too large (4 KiB at most).", `description_too_long` "Description can be at most 500 characters.", `owner_too_long` "Owner can be at most 100 characters.", any other code → "This value isn't valid." |
| 422 `flag_limit_reached` | create | **A** of AS-13 |
| 429 `rate_limited` | any | **C** (AS-50) |
| 502/503/504 and other 5xx | any | list/stale/history/detail: **P** with **Try again**; action: **A** "Something went wrong on our side." with "Reference: {requestId}"; `Retry-After` shown as a countdown when present |
| network failure (no response) | any | AS-52 for reads/offline; AS-27 for a save; actions: **A** "Couldn't reach the server. Check your connection and try again." |

### Key Entities *(UI view models; fields as the API returns them)*

- **Flag** (`flagSchema`): `key`, `description`, `owner`, `status` (`enabled`/`disabled`/`killed`/`archived`), `enabled` (derived by S38; the console reads `status` only), `variants` `[{key, value}]`, `defaultVariant`, `offVariant`, `rules` `[{id, conditions: [{attribute, op, values}], variant | rollout: [{variant, weight}]}]`, `bucketBy`, `clientSide`, `expiresAt | null`, `version`, `createdAt`, `updatedAt`.
- **Draft**: the editable copy of a flag plus the `version` it is based on and view-only fields (percent text, values text, JSON text, variant types).
- **Audit entry** (`flagAuditPageSchema.items`): `id`, `action` (`create`, `update`, `kill`, `restore`, `archive`), `actorId`, `at`, `requestId`, `before | null`, `after`.
- **Stale item** (`staleFlagsSchema.items`): `key`, `owner`, `status`, `expiresAt`, `createdAt`, `evaluations`, `expired`, `reason` (`expired` | `unused`).
- **Problem** (W01): `{status, code, errors, retryAfterSeconds, requestId}`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An admin can switch a misbehaving flag off from the list or the flag page in at most 3 interactions (open, confirm, done) and sees the new "Killed" state within 2 seconds of the service accepting the request, at phone and desktop width.
- **SC-002**: An admin can create a new, safely disabled flag in under 1 minute with only a key and an owner, and 0% of newly created flags are live for anyone until the admin enables them.
- **SC-003**: 100% of save conflicts (two admins) end with the admin informed and the other admin's change intact; 0 silent overwrites.
- **SC-004**: 100% of refusals the service can send (validation, limit, conflict, killed, archived, access, rate limit, server fault, offline) show a plain-language message that says what to do next; none shows raw JSON, a stack or an internal identifier other than the request reference.
- **SC-005**: A person who is not an administrator sees 0 flag names, definitions or history, on every route and in every response state.
- **SC-006**: Every action in the console (create, edit, reorder rules, kill, restore, archive, read history, filter) can be completed using only the keyboard, and every page passes an automated accessibility scan with no serious or critical findings at 390 px and 1280 px.
- **SC-007**: At 390 px width no console page needs horizontal scrolling and the kill switch and save controls are visible without scrolling.
- **SC-008**: Every applied change appears in the flag's history with who, when and before/after, and an admin can find "what changed on this flag and by whom" in under 30 seconds.
- **SC-009**: The first view of any console page shows its shell and a content skeleton immediately, and the data appears without the layout moving.
- **SC-010**: Unsaved edits are never lost without a warning, except when the session itself ends (AS-49).

## Assumptions

- Business rules, limits, status machine, error codes and rate limits are those of S38 (`FR-001..FR-061`, `AS-01..AS-58`); W06 quotes limits only in copy that names them (500 active flags, 20 variants, 50 rules, 10 conditions, 100 values, 4 KiB, 500/100 characters), taken from S38 FR-006.
- Only role `ADMIN` manages flags (S38 assumption); the console shows the role-based panel to everyone else. Flags are platform-wide; the console has no tenant or shop picker.
- The browser session is the S48 token handler (W01): every `/api/admin/flags/**` call goes same-origin and the BFF attaches the bearer; W06 never handles a token. Until S48 forwards the admin routes, the console cannot work in production (`gaps.md`, Requires).
- Decisions marked `[BREAKING]` / `[CONTRACT]` / `[LOCAL]` are listed one per line in `questions.md`; this spec adopts each default stated there.
- The audit shows `actorId` only (S38 returns no e-mail); "You" marks the viewer's own entries.
- Times are UTC in the console, copy is English only, no localisation layer exists.
- The console does not poll. A second admin's change shows up on refocus, tab change or at the next save (AS-28); live collaboration is not a goal.
- Flags created through the console always start disabled and off (AS-09); the "On/off flag" starter is the only starter; a JSON-import of a definition is not offered.
- The editor offers every attribute and operator of S38 FR-004 from the contracts package; a rule the editor cannot display (a future operator) is shown read-only as JSON (Edge Cases).
- The Interview-Prep notes (S38's sources, "admin UI and audit log") are not in this checkout; where they would be consulted, the constitution and S38's own record decide.
- Page size is S38's default (50); there is no page-size control.

## Cross-capability contracts

Earlier specs searched (`grep -rl` over `specs/domains`, `specs/web` for `W06` and `web`; `specs/journeys` does not exist): **S38** (domains) and **W01** (web) name W06; **W02** names it only in the `formatMoney` caller note (W06 shows no money, so nothing is required). Every obligation placed on W06 is honoured below: S38 — consume the admin API with `expectedVersion`, `status`, restore, archive, history pages and the stale report, and the `flagSchema` / `flagInputSchema` contracts (S38 `questions.md`, CONTRACT; spec "Provides"); W01 — adopt `returnTo`, read-only `useAuth()`, `loginHref`, `requireServerSession`, add the guard the admin layout lacks (W01 `questions.md`, CONTRACT; W01 gaps F2). Differences are `[CONTRACT]` lines in `questions.md` (error `code` source, `errors` shapes, `status=archived` + `includeArchived`, admin forwarding, nav link).

### Provides

Exact names; modules are in `packages/web`.

- **Routes** other capabilities link to: `/admin` (redirects) · `/admin/feature-flags` (parameters `status`, `cursor`, `tab=stale`, `days`) · `/admin/feature-flags/new` · `/admin/feature-flags/{key}` (parameters `tab=history`, `cursor`). Removed: the create dialog on the list page.
- **`queryKeys.admin.flags`** (`lib/query-keys.ts`): `all`, `list({status, cursor})`, `detail(key)`, `history(key, {cursor})`, `stale({days})`.
- **Navigation registry** (`lib/admin/nav.ts`): `AdminNavItem = { id: string; label: string; href: string; icon: LucideIcon }` and `adminNavItems: AdminNavItem[]` (today one item, `feature-flags`). A later admin capability adds one item to appear in the sidebar and the drawer; the shell renders the list and nothing else.
- **Admin guard** (`components/admin/admin-guard.tsx`, Server Component, used inside a Suspense boundary by the admin layout): `requireServerSession(returnTo)` then the role check, rendering the forbidden panel for a non-admin; the shell and guard are reusable by any later `/admin/**` page.
- **`isAdmin(user: SessionUser | null): boolean`** (`lib/admin/is-admin.ts`, pure): `user?.role === 'ADMIN'`, presentation only; used by the storefront navbar (W07) to show the **Admin** entry (AS-66).
- **Hooks** (`hooks/use-admin-flags.ts`, client): `useFlags({status, cursor})`, `useFlag(key)`, `useFlagHistory(key, {cursor})`, `useStaleFlags({days})`, `useSaveFlag()`, `useKillFlag()`, `useRestoreFlag()`, `useArchiveFlag()`.
- **`lib/api/admin-flags.ts`** (client-callable) and **`lib/api/admin-flags.server.ts`** (`server-only`): `listFlags`, `getFlag`, `saveFlag(key, input)`, `killFlag(key)`, `restoreFlag(key)`, `archiveFlag(key)`, `getFlagHistory(key, {cursor})`, `getStaleFlags({days})`. Replaces `lib/api/admin.ts` (`adminApi`, `booleanFlag`, `FeatureFlag`).
- **Playwright helpers** (`tests/helpers.ts`): `createFlag(page, key, options?)` (through the UI, returns the key; lands on the editor), `flagPath(key, tab?)`; `adminLogin(page)` (wraps `login(page, SEED.admin, SEED.password, '/admin/feature-flags')`).
- **Behavioural guarantees**: no W06 request carries a token from JavaScript; every write sends the shared CSRF header; a flag definition never enters a URL, storage, log or analytics event; a save always sends the `expectedVersion` the draft was based on and never advances it silently; the console never enables a killed flag and never sends kill together with an edit; every list uses stable keys; no per-user data is placed in a shared cache; a `401` runs W01's session-ended flow once.

### Requires

- **S38** (`experimentation`) — exact shapes assumed (from its spec "Provides"):
  - `GET /api/admin/flags?status&includeArchived&limit&cursor` → `flagPageSchema` = `{items: flagSchema[], nextCursor: string | null}` ordered by `key` ascending; `limit` 1–200, default 50 (`400 validation_failed` otherwise; `400 invalid_cursor`).
  - `GET /api/admin/flags/{key}` → `flagSchema` | `404 flag_not_found`.
  - `PUT /api/admin/flags/{key}` (body `flagInputSchema` incl. `expectedVersion`) → `201` with `Location` or `200` `flagSchema`; `409 version_conflict {currentVersion}`, `409 flag_killed`, `409 flag_archived`, `404 flag_not_found`, `422 flag_definition_invalid {errors: [{path, code}]}`, `422 flag_limit_reached`, `400 validation_failed {errors}`, `413`.
  - `POST /api/admin/flags/{key}/kill|restore|archive` → `204` (kill and archive idempotent); `409 invalid_transition {currentStatus}`, `409 flag_archived`, `404 flag_not_found`.
  - `GET /api/admin/flags/{key}/history?limit&cursor` → `flagAuditPageSchema` = `{items: [{id, action, actorId, at, requestId, before, after}], nextCursor}`.
  - `GET /api/admin/flags/stale?days` → `staleFlagsSchema` = `{days, items: [{key, owner, status, expiresAt, createdAt, evaluations, expired, reason}]}`.
  - Errors: `401`, `403` (identical for existing and unknown keys), `429` with `Retry-After` (writes 30/min per admin), problem+json with `type`, `title`, `status`, `detail`, `instance`, `requestId`. `[CONTRACT]` additions asked of S38: the full list of `flag_definition_invalid` `path` and `code` values (the spec names only the limit codes and `weights_sum_invalid`), the exact `flagInputSchema` field names, the `status=archived` + `includeArchived` behaviour (the UI always sends both), and that the problem body exposes the machine code as `code` in addition to `type` (FR-051).
- **S48 (BFF)** — W01 C-FWD extended to `GET|PUT|POST /api/admin/flags/**` (same-origin, bearer attached server-side, `Cookie` stripped, CSRF and origin checks on non-`GET`, status, headers (`Retry-After`) and problem+json passed through unchanged, no shared caching). The server-side data module of FR-003 reaches the same routes with the session. Owner S48 (`[CONTRACT]`).
- **W01**: `requireServerSession(returnTo)`, `loginHref(returnTo)`, read-only `useAuth()` (`SessionUser = {id, email, role}`), `problemFromError`, `<ProblemAlert />`, `csrfHeaders()` through the shared client, the session-ended flow (AS-26), `notice=session_expired`, W01 copy for `csrf_invalid` (AS-11) and the wait-text rule (FR-041).
- **W07**: the root layout, skip link, `<main>`, global error and not-found pages; the storefront account menu shows **Admin** when `isAdmin(user)`; `Referrer-Policy` and header policy unchanged by W06.
- **W04**: the same offline-banner copy and countdown behaviour (W04 AS-88, AS-90) are reused as copy; no code is imported from W04 (`[LOCAL]`: if a shared `<OfflineBanner />` is published later, W06 adopts it).
- **`packages/contracts`**: `flagSchema`, `flagInputSchema`, `flagPageSchema`, `flagAuditPageSchema`, `staleFlagsSchema`, `problemSchema`, plus exported constants the UI needs (`flagAttributes`, `flagOperators`, `flagBucketUnits`, `flagStatuses`, `flagLimits = {description: 500, owner: 100, variants: 20, rules: 50, conditions: 10, values: 100}`, `flagKeyPattern`) (the package has no source today and `packages/web` does not depend on it; `gaps.md`).
- **Configuration**: `API_URL`, `BFF_URL` (server only, existing in `next.config.ts`).

## Pattern coverage (pattern-map rows whose Specs column names W06)

| Pattern | Requirements | Scenarios |
|---|---|---|
| P0515 RBAC / ABAC / permission matrix | FR-006, FR-007, FR-031, Provides `isAdmin`, admin guard | AS-47, AS-48, AS-49, AS-66 (role-based access with enforcement below the UI; the console presents actions per status and the backend re-checks every one: AS-38) |
| P0901 Server vs client state; Context vs reducer vs store; URL state | FR-001, FR-002, FR-003, FR-004, FR-005 | AS-02, AS-04, AS-42, AS-46, AS-55, AS-56 (TanStack Query for server data, URL for status/tab/window/cursor, local reducer for the draft, no new Context or store) |

## Review & Acceptance Checklist reference

The spec quality checklist is `checklists/requirements.md`; the test plan is `test-plan.md`; the implementation to-do list is `gaps.md`; every default chosen is in `questions.md`.
