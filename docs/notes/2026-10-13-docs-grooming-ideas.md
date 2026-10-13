# Docs grooming ideas (to start once the harness is merged)

Raised on 2026-10-13 in a separate study session; written down here, nothing changed yet.

## 1. Fewer folders under docs/

Wish: `architecture`, `decisions`, `incidents`, `notes`, `runbooks`, `showcase`, `slo`, `spec` and `lessons.md` compressed into one or two folders.

What the study session found (it was not allowed to edit code or scripts, so it only read):
- `slo/` (5 yaml/md files plus per-capability pages): read by `.github/workflows/ci.yml`, `packages/backend/scripts/slo/generate.ts`, `libs/common/telemetry/slo-rules.ts` and `infra/observability/prometheus/rules/*.yml`. The yaml is machine-read.
- `runbooks/` (10): alert annotations in `infra/modules/observability/main.tf` point at these paths.
- `decisions/` (21): used by `scripts/sdd/lib.sh`, `implement-specs.sh` and `scripts/decisions`.
- `architecture/` (8): used by `scripts/sdd/*` and the `scripts/docs` config.
- `lessons.md`: used by `scripts/lessons/*`, `scripts/sdd/*` and CI checks.
- `showcase/` (67): cited from `docker-compose.yaml`, backend config types and many specs.
- `incidents/` (3), `notes/` (2), `superpowers/` (4): lightly referenced. The only outside reference to `notes/` is `scripts/qa/run.sh`.

What can be done without touching scripts: merge only the lightly referenced folders. `notes/` and `superpowers/` could become `docs/archive/` or `docs/work/`, and `incidents/` could move under `runbooks/`. The cross-links between docs files have to be updated. That removes about 3 of the 9 folders. The full 2-folder structure needs path updates in `scripts/sdd`, CI, backend and infra: a separate change, with a one-pass sed script and a link checker.

So a move has to update those references in the same change (and the CI checks have to stay green). Do it as one mechanical pass with a link checker, not by hand.

## 2. Roles of the two generated/living trees

- `docs/humans` is generated from the code.
- `docs/spec` is the living documentation and the source of truth.
- Open question: which one links to which. Leaning: `humans` links to `spec` (the source of truth), and `spec` may stay free of links back.

## 3. Make docs/spec more connected (the main idea)

Today a rule reads well but uses universal words that mean nothing on their own. Example from the BFF page:

- bff-aggregate.C-01: "The page response MUST carry Cache-Control: private, no-store and a Server-Timing header with one entry per section."
  What entry? What section? Both words could mean anything.
- The other rules on that page (C-02 to C-08: optional sections and the errors entry, the 1,000 ms deadline, the circuit breaker, header forwarding, ambiguous credentials and CSRF, GraphQL depth/cost, session store down) have the same issue.

Target: layered, like the `scripts/docs` generator, which takes code apart into more and more basic topics (5, 10, 15 layers, however many it takes) until every page is self-explanatory. Apply that to the spec:
- every domain word ("section", "entry", "breaker", "deadline") links to a small concept page that defines it for this system;
- those concept pages link down to general software-engineering concepts, until nothing is left unexplained;
- a check (script) fails on a rule that uses a term with no link and no definition.

Open: whether to do this by rewriting the spec by hand-with-agents, or by extending `scripts/docs` so it also produces the concept layers for `docs/spec`.

## 4. How the study session proposed to build the connected spec

The `scripts/docs` generator already does this for `docs/humans`: one page per topic, `{{slug}}` markers in the text, parts marked deeper until they are self-explanatory, with depth limits. Give the spec the same idea:
- Term layer, `docs/spec/terms/<slug>.md`: one short page per domain word, defined once (for example `page-section`, `server-timing-entry`, `optional-upstream`, `circuit-breaker`, `deadline-budget`). A term's definition may link to finer terms, with no fixed depth. Each term page ends with computed "used by" backlinks, as the concept pages already have.
- Rules link their words with the existing marker style. C-01 would read: "...a Server-Timing header with one {{term:server-timing-entry}} per {{term:page-section}}."
- Link direction: spec is the source of truth, so `humans` links to spec (term, concept and rule pages). Spec links to `humans` only through the existing `[code: path#Symbol]` references. That keeps spec independent of the generated folder, which render wipes and rewrites.
- Checker limit: `scripts/livespec/check.py` and `generate.py` validate the `{{...}}` markers. `{{term:...}}` is not validated until they are extended. Until then, write terms as ordinary relative markdown links, which any viewer resolves.

Where to start: pilot on one page, the 8 BFF rules (C-01 to C-08), with about 12 to 15 terms, so the style can be judged before scaling. In parallel, write plans for the folder merge and for the generator/checker changes.

Decisions still open (asked by the study session):
1. Folder grooming: only the safe partial merge (notes, superpowers, incidents) plus a plan for the rest, or only the plan?
2. Spec pilot: go ahead with the BFF rules and the terms layer with plain relative links?
