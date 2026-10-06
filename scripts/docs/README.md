# docs generator

Builds `docs/humans/`: a navigable map of the codebase for people onboarding. It is a pipeline, not a prompt:

```
 code ──► extract ──► graph ──► summarise bottom-up (cached) ──► render markdown
          (static,    units,     file → capmap → concept (DAG)   README, system, units/,
          no LLM)     imports,     ╲        ↘ unit ─► system     concepts/, flows/, catalog/
                      events,       flow (event/job chains) ─►
                      jobs, routes
```

**Structure comes from static analysis; the LLM only writes the words.** Units, import edges, routes, domain events, background jobs and async flows are extracted deterministically, so they cannot be hallucinated and cost nothing. The model then summarises each node of that graph from its source and its children's summaries.

## Quick start

Needs Node >= 22.18 (runs the `.ts` files directly, no install, no dependencies).

```sh
pnpm docs:extract                 # what did static analysis find? (instant, free)
pnpm docs:plan                    # how much would generating cost? (no LLM calls)

# try one unit first
pnpm docs:generate --unit domain/payments

# everything
pnpm docs:generate
```

LLM access, in order of preference (`--provider auto` picks the first available):

| Provider | Needs | Notes |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | Direct API, parallel, fastest. |
| `claude-cli` | a logged-in `claude` CLI | One headless `claude -p` per node, tool-less, run outside the repo. Slower, no key. Set `DOCS_CLAUDE_CONFIG_DIR` to run it under a separate Claude Code profile. |
| `mock` | nothing | Deterministic placeholder text, for testing the pipeline. |

Open `docs/humans/README.md` (works in GitHub, Obsidian, any markdown viewer; diagrams are Mermaid).

## Commands

| Command | What it does | LLM |
|---|---|---|
| `extract [--json f]` | Prints units, flows and counts found in the code | no |
| `plan` | Per-level count of stale summaries and a rough token estimate | no |
| `generate` | Writes stale summaries, then renders | yes |
| `theory` | Only the theory level, then refreshes the link blocks in the notes (see below) | yes |
| `render` | Renders markdown from cached summaries only (and refreshes the notes' link blocks) | no |
| `check [--strict]` | CI gate: stale/missing summaries, or markdown out of sync with the cache | no |

Options: `--unit <name|group/name>` (repeatable), `--level file,capmap,concept,unit,flow,system`, `--provider`, `--model <id>` (one model for everything, e.g. a cheap one for a trial), `--concurrency n`, `--max-calls n` (hard budget), `--force`.

## The levels

| Level | Input | Output |
|---|---|---|
| **file** | source + extracted export list | purpose, details, per-symbol one-liners (names and line numbers verified against the code) |
| **module** | its files' summaries | no LLM: a grouping of files (a single-file module reuses the file's purpose) |
| **capmap** | one per unit: file summaries + routes, events, jobs, `contextFiles` | the unit's top-level topics ("Weekly seller payouts"), each with the files it owns |
| **concept** | one per topic: the **source** of its files, its facts, and a list of existing topics it may link | a friendly page: what it is and how it works in plain words, where to look, its *parts*, what data it touches, gotchas. Parts that are not self-explanatory become pages of their own (below) |
| **unit** | its concept summaries + routes, events, jobs, dependency edges | purpose, how the topics fit together, key terms, gotchas, start-here files |
| **flow** | one connected chain of event/job hops + its files' summaries | title, narrative per hop, failure/ordering notes |
| **theory** | one per hand-written note: its sections (every heading, any depth), BM25-shortlisted topics and files per section, and the matching rows of `pattern-map.md` | for each section that the code really implements: up to 3 refs with a one-sentence "how this project applies it", plus substantial sections with no counterpart |
| **system** | all unit and flow summaries + the unit dependency graph | overview, architecture bullets, reading order |

### The topic graph

Every topic has exactly **one page**, and everything that relies on it links to that same page. The depth is not fixed: a page lists its *parts* and marks each one `deeper` when it has logic or a meaning that is not obvious from its name (a rule, an algorithm, a data shape, an amount like "Total amount the buyer pays"). Those become pages of their own, whose parts may do the same, until every piece is self-explanatory or the limits are hit (`maxConceptDepth`, `maxConceptsPerUnit`). Before creating a piece the model is shown the topics that already exist and may `reuse` one, so shared logic ends up as one page with several parents; a piece with the same slug in the same unit is merged. Edges to parts only ever go deeper, so the graph is acyclic by construction. Pages that are small (little source) go to the cheaper `leaf` model.

Cross-unit links: the model also sees the top-level topics of other units that this one's files import (barrels followed) and says which it really relies on ("Also relies on"). Each page ends with computed **Used by** backlinks and a "Part of" breadcrumb. Flow, event and job pages link their files to the owning topics.

Page text uses `{{slug}}` markers that become links; unknown markers fall back to plain text. A render-time pass puts identifiers, topics, events and jobs in code spans and links known symbols and unique topic titles. Neither needs a regeneration when improved.

### Theory notes (`interview-prep/`)

`pnpm docs:theory` links every section of the hand-written notes to where the code implements it. It reads `theory.dir` (default `interview-prep/`, minus `theory.exclude`: `my-practice` and the index `README.md`) and writes into each linked section an **In this codebase** block:

```md
<!-- theory-links:start -->
> [!TIP] In this codebase
> - [Circuit breaker around Stripe](../docs/humans/concepts/...md): trips after N failures in a window ... [`stripe-breaker.ts`](../packages/.../stripe-breaker.ts#L21)
<!-- theory-links:end -->
```

- Every heading is a section, at any depth, so `###` and `####` subsections get their own links. The block sits at the end of the section's own text (before a trailing `---`).
- Links are relative, so Ctrl+click opens the file in the editor (see the Obsidian notes in the root README). **Code is always linked, at function level** (`file.ts#L21`, from the exported symbols in the file summaries). When a topic page owns that file it is linked next to the code link; when it does not exist yet the code link stands alone, so the topic pages are optional. Topic pages themselves can also be linked when the whole topic is the point.
- **Only the marked block is ever written.** Hand-written text is untouched, and deleting the blocks restores a note byte for byte (`stripBlocks`). `my-practice/` is never read.
- Candidates come from BM25 over the exported functions/classes (file summaries, `--level file` is enough) and, if generated, the topic pages. The model must pick from the shortlist and every id is checked; sections without a genuine counterpart get no block. `pattern-map.md` rows for the note (including "skipped") are passed as ground truth.
- Backlinks: each topic page gets a **Theory** section linking to the sections that point at it, and `docs/humans/theory-coverage.md` lists theory with no code counterpart and code with no theory note.
- The cache key covers the note's text and its candidate list, so editing a note regenerates only that note. `check` also reports notes whose blocks are out of date.

A *unit* is a directory that owns code: a domain (`libs/domains/*`), a platform lib, an app, a package. A *module* is a sub-directory of a unit (`api/`, `application/`, `infra/`...). Both are defined by `units` in `docs.config.json`. Barrels and tiny files get a deterministic summary without an LLM call.

Deterministic pages with no LLM involved: route tables, event catalog, job catalog, unit dependency diagrams, flow diagrams.

## Keeping it fresh (and cheap)

Every node's cache entry stores a fingerprint: `hash(prompt version + its own source/facts + the outputs of everything below it)`.

- Edit one file: that file is re-summarised. If its summary text comes out unchanged, nothing above it re-runs (early cutoff); otherwise only the topics that contain it (and, if their text changes, whatever is built on them), then the unit, flows and system re-run.
- Cache files live in `docs/humans/.cache/*.json`, one entry per line with sorted keys, so they diff and merge cleanly. **Commit them**: a fresh clone then regenerates only what changed.
- Entries for deleted code are pruned on a full `generate`.
- Change a prompt or output shape: bump that level in `PROMPT_VERSION` (`src/nodes.ts`) and everything at that level regenerates.
- Model output is untrusted: JSON is validated, symbols and file paths the model invents are dropped and reported, and an invalid reply is retried once before the node is marked failed (the old summary is kept, flagged stale).

The output folder is owned by the generator: `render` rewrites it and deletes any `.md` file it does not produce. Keep hand-written docs elsewhere (e.g. `docs/architecture/`).

## Suggested CI

PRs: `pnpm docs:check` (non-strict prints a warning; add `--strict` to block). Refresh on a schedule, with a PR for review:

```yaml
name: docs
on:
  schedule: [{ cron: '0 5 * * 1' }]
  workflow_dispatch:
permissions: { contents: write, pull-requests: write }
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: node scripts/docs/cli.ts generate --provider anthropic
        env: { ANTHROPIC_API_KEY: '${{ secrets.ANTHROPIC_API_KEY }}' }
      - uses: peter-evans/create-pull-request@v7
        with:
          branch: docs/refresh
          title: 'docs: refresh generated codebase map'
          commit-message: 'docs: refresh generated codebase map'
```

## Configuration (`docs.config.json`)

- `maxConceptDepth` (default 4) and `maxConceptsPerUnit` (default 40) bound the recursive split; `models.leaf` is used for small pages.
- `units`: ordered rules; first match wins. `match` is a path where `*` is one segment; `moduleDepth` sets how many directories below the unit root form a module.
- `ignore`: globs excluded entirely (tests, migrations, vendored UI kits...).
- `models`: model per level. Defaults: Haiku for files, Sonnet above. Raise the unit/system level if prose quality matters more than cost.
- `contextFiles`: hand-written docs; paragraphs that mention a unit's name are fed into that unit's prompt, so the "why" in your architecture notes reaches the summary.
- `conventions`: names of your event-definition helper, job decorator and enqueue/schedule methods, so flow extraction follows your framework.

## Known limits

- Extraction is regex-based (comment-aware), not a full AST. It is tuned to NestJS/TypeScript conventions in this repo; Rust and Go files only get exported-symbol detection and no import edges.
- Flows are found only through `defineEvent` / `@JobHandler` / `enqueue(...)` links. Plain HTTP calls between services, Kafka topics used by string name, and SQS queues are not followed yet. "Likely entry points" on a flow page are a 2-hop import heuristic, not a trace.
- Calls are made one node at a time. The Anthropic Batch API (about half price, asynchronous) would suit the file level for a first full run but is not wired in.
- Summaries describe what the code does, not why it was built that way. The `contextFiles` hook is the lever for that; ADRs and specs are the real source.

## Tests

`pnpm docs:test` covers the extractor, import resolution, the cache/early-cutoff behaviour, hallucination filtering and rendering (mock provider, throwaway git repo).
