SPECIFY_FEATURE_DIRECTORY={{DIR}}

Write the specification for web capability {{ID}}: {{TITLE}} (the Next.js app in `packages/web`).

Read first, in this order:
1. `.specify/memory/constitution.md`: VI (frontend boundaries and state), VII.7 (UI journeys = happy paths
   only), V (API contracts the UI consumes).
2. `packages/web/AGENTS.md`. This Next.js version differs from what you know, so read the relevant guide in
   `packages/web/node_modules/next/dist/docs/` before describing rendering, caching, or routing behaviour.
3. `docs/architecture/pattern-map.md`: every row whose **Specs** column contains `{{ID}}` must appear as
   requirements and scenarios here.
4. Sources (backend `spec.md` files define what the API guarantees; Interview-Prep paths are under
   `interview-prep/`): {{SOURCES}}
5. The current pages, components, `lib/api/*` clients, hooks, and `packages/web/tests/*.spec.ts` for this area.
   The code is an imperfect draft.

Rules:
- Specify INTENDED user-facing behaviour, from the user's point of view: every screen and state the user can
  reach (loading, empty, error, partial data, unauthorized, offline/reconnecting where relevant) and every
  action with its exact visible outcome.
- Layout: for each page, state its required structure at mobile (≤ 640 px) and desktop (≥ 1024 px) widths
  (which regions exist, what collapses or moves, what stays reachable). Also cover keyboard and screen-reader
  access (roles, labels, focus order), and the visible form of every error the backend can return (constitution
  V.3 problem+json). Pixel-level styling is out of scope.
- Do NOT re-specify backend rules. Reference the backend spec's requirement IDs and specify only how the UI
  shows and handles them. An edge case the API already proves (constitution VII.7) is not re-tested in the UI.
- Data flow follows constitution VI:
  - Server Components by default;
  - server data in TanStack Query with keys from `lib/query-keys.ts`;
  - shareable view state in the URL;
  - network calls only in `lib/api/*`;
  - no tokens in browser JavaScript.

  Where the current code breaks one of these, the spec states the correct behaviour.
- Decision policy: this codebase is a portfolio showcase with no external clients to keep compatible. For every
  open choice, pick the most production-grade option the Interview-Prep notes and the constitution support:
  correctness, security, observability, and clean domain boundaries win over preserving today's behaviour, and
  over the cheapest change. Prefer the approach a senior reviewer would expect to see. Still tag such choices
  `[BREAKING]` in questions.md, so the implementation knows to update existing tests and callers.
- Cross-capability contracts. Before writing, search the specs already written (`grep -rl` over
  `specs/domains specs/web specs/journeys` for `{{ID}}` and `{{DOMAIN}}`) and honour every contract they
  require from this capability; if you must differ, say so as a `[CONTRACT]` question. In `spec.md`, add a section
  `## Cross-capability contracts` with two lists: **Provides** (each export, event, or endpoint other capabilities
  use: name, payload fields, guarantees) and **Requires** (each thing this capability needs, with the owning
  capability ID and the exact shape it assumes). Later specs read this section, so keep names exact.
- Do NOT ask clarification questions and do NOT leave [NEEDS CLARIFICATION] markers: this runs unattended.
  Record each default you choose under Assumptions, and also in `{{DIR}}/questions.md`, one line each, tagged and
  sorted by impact (BREAKING first):
  `- [BREAKING] question → default → why` changes behaviour or an API/UI contract that exists today;
  `- [CONTRACT] question → default → why` decides something another capability must provide or consume;
  `- [LOCAL] question → default → why` affects only this capability's internals.
  Keep LOCAL lines short; the human reviews BREAKING and CONTRACT lines first.

Also write these two files next to `spec.md`:
- `{{DIR}}/test-plan.md`: one row per acceptance scenario, `Scenario | UI journey (Playwright, happy path) | UI
  unit (Vitest + React Testing Library: UI-only logic, states, a11y) | Visual (Playwright screenshot: layout
  states at mobile/desktop) | Proven by backend spec (ID)`. Every edge case appears exactly once, at the lowest
  layer that proves it. Name the test file each row belongs in (`packages/web/tests/*.spec.ts`, or
  `*.test.tsx` next to the component).
- `{{DIR}}/gaps.md`: what the current pages and components get wrong or lack versus this spec (file:line
  references allowed). Include missing backend endpoints the UI needs (name the backend capability that should
  own each one, constitution IX.7 R2 if it's an aggregate for the BFF) and test-tooling gaps (e.g. React
  Testing Library not installed yet, Vitest `include` not covering components). This is the implementation
  agent's to-do list.

Finish by running the spec quality checklist as the command describes. Don't modify code.
