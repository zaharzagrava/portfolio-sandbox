SPECIFY_FEATURE_DIRECTORY={{DIR}}

Write the specification for cross-domain journey {{ID}}: {{TITLE}}.

A journey proves the hand-offs between domains end to end:
- synchronous calls (constitution IX.7 R1/R2);
- events through the outbox, Kafka, and projectors (R3);
- SQS tasks and scheduled jobs.

The per-capability specs already prove each domain's own rules, so this spec covers only what happens
*between* them.

Read first:
1. `.specify/memory/constitution.md`: IV (communication: outbox, idempotent consumers, ordering), IX.7 (the only
   approved cross-domain data paths), VII (testing mandate).
2. `docs/architecture/domain-map.md` (who owns what, who emits which event) and
   `docs/architecture/debt-register.md` (known coupling, e.g. D-11 orders ↔ payments).
3. The capability specs this journey spans: {{SOURCES}} (Interview-Prep paths are under
   `interview-prep/`).
4. The current code of the domains involved, to find the real events, topics, queues, and jobs.

Rules:
- One user story per business outcome of the journey. Each acceptance scenario follows the chain step by
  step, and for each step names: the trigger (API call, event, task, job), the domain that reacts, and the
  observable result through a public API. Use no direct database reads, because a journey is a black box.
- Specify the eventual-consistency contract for every asynchronous hop: the maximum time to visibility under
  the local stack, and how a client observes progress (polling an endpoint, an SSE topic). Tests wait on that
  contract, never on fixed sleeps.
- Cover the cross-domain failure modes the notes name:
  - duplicate and out-of-order events (idempotent consumers);
  - a consumer that is down and catches up;
  - a compensation path (saga), where one exists;
  - a retried request with the same idempotency key.
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
- `{{DIR}}/test-plan.md`: one row per scenario, `Scenario | Journey test
  (packages/backend/test/journeys/{{SLUG}}.journey-spec.ts) | Already proven by capability (ID)`. A rule
  already proven inside one capability is referenced, not re-tested.
- `{{DIR}}/gaps.md`: every missing or broken hand-off in the current code. Examples: an event that's
  published but has no consumer, a consumer that isn't idempotent, a missing outbox write, no way to observe
  progress. For each, name the domain that must fix it. This is the implementation agent's to-do list.

Finish by running the spec quality checklist as the command describes. Don't modify code.
