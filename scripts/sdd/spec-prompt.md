SPECIFY_FEATURE_DIRECTORY={{DIR}}

Write the specification for capability {{ID}} — {{TITLE}} (domain `{{DOMAIN}}`).

Read first, in this order:
1. `.specify/memory/constitution.md` (binding rules: testing mandate VII, data ownership IX, boundaries X).
2. `docs/architecture/domain-map.md` (what `{{DOMAIN}}` owns and depends on).
3. `docs/architecture/pattern-map.md`: every row whose **Specs** column contains `{{ID}}`. Each of those
   patterns MUST appear as functional requirements and acceptance scenarios in this spec.
4. Sources (Interview-Prep paths are under `interview-prep/`): {{SOURCES}}
5. The current code of the domain (`packages/backend/libs/domains/{{DOMAIN}}/`, or the infrastructure /
   composition lib it names) and its existing tests, to learn what exists. The code is an imperfect draft.

Rules:
- Specify INTENDED behavior. Where the code and the Interview-Prep notes disagree, the notes win.
- Scope is exactly this capability. Cross-domain data appears only as constitution IX.7 mechanisms
  (R1 exported service, R2 BFF composition, R3 read model); name which one.
- Every functional requirement is testable. Every edge case the notes mention (concurrency, idempotent
  replay, illegal state transitions, cross-tenant access, limits, timeouts, out-of-order or duplicate
  events) becomes a Given/When/Then acceptance scenario with exact expected outcomes.
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

Also write these two files next to `spec.md` (spec.md itself stays implementation-free):
- `{{DIR}}/test-plan.md`: the constitution VII.8 table, one row per acceptance scenario:
  `Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only)`. Each edge case
  in exactly one row, at the lowest layer that proves it. Name the e2e spec file each row belongs in.
- `{{DIR}}/gaps.md`: what the current code gets wrong or lacks versus this spec (file:line references
  allowed), plus every open row of `docs/architecture/debt-register.md` that names `{{DOMAIN}}` or `{{ID}}`
  and this domain's lines from `pnpm --dir packages/backend check:table-ownership` (cross-domain SQL and
  model access, debt D-7/D-12): for each, say which IX.7 mechanism replaces it. This is the implementation
  agent's to-do list.

Finish by running the spec quality checklist as the command describes. Don't modify code.
