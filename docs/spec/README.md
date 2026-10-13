# Living specification

What the system **does today**, in business terms, checked against the code and the tests. The folders `specs/domains|web|journeys` are the *work orders* the
build loop consumed ("build this"); this folder is the *current state* ("this is how it behaves"). A change to behavior starts by editing a page here, and
the diff of that page is what a human reviews.

## Layers (a directed graph, in the spirit of `scripts/docs`)

1. **System** ([`system.md`](system.md)): what the product is, the capability map and the review state. Generated overview, never edited by hand.
2. **Capabilities** (`capabilities/<ID>-<slug>.md`): one page per capability: purpose, entry points, rules, behaviors, what it owns, what it depends on.
3. **Concepts** (`concepts/<slug>.md`): one page per idea shared by several capabilities (idempotency key, the outbox and task queue, money, tenant). A concept is
   defined once; every capability that relies on it links to it, and the concept page lists them ("used by", computed). Depth is not fixed: a concept may link to
   finer concepts.
4. **Terms** (`terms/<slug>.md`): one page per word that a rule uses with a meaning of its own ("section", "errors entry", "page deadline", "CSRF token"). The layers are
   **not fixed**: a rule links its words, each term page links the words *its own definition* leans on, and so on, until a definition raises nothing new. Every word is
   defined once; the page ends with computed "used by" backlinks (page and rule ids). Written by `scripts/livespec/terms.py` (below), never by hand in bulk.
5. **Models** (`models/*`): the formal layer for lifecycles and protocols where prose is not precise enough: a state-machine table (checked against the code's
   enum) or a Quint model of a protocol (type-checked and simulated against invariants).

Edges: a capability *depends on* capabilities and *uses* concepts; a concept is *defined by* one capability; a capability *has* models. All edges are written in
front matter or as `{{concept:slug}}` / `{{cap:S13}}` markers, so a script can compute backlinks and find dead links.

## Page format (capability)

```
---
id: S13
title: Payment intents …
kind: capability
status: draft              # draft = generated, not reviewed by a human; reviewed = signed (see .reviewed.json)
generated_at: <commit>     # the commit the page was generated from (draft pages only)
depends_on: [S10, S53]
concepts: [outbox-task-queue, idempotency-key]
models: [payment-status]
scope: [packages/backend/libs/domains/payments/**]   # code and tests the page describes
---
# S13 — title
## Purpose           why it exists, in business words (a few sentences)
## Entry points      HTTP routes, events consumed and produced, queues, jobs, UI routes  (each: `[code: path#Symbol]`)
## Rules             invariants that must always hold:       - **S13.R-01** text. [proof: S13 AS-07] [code: path#Symbol]
## Behaviors         business-level Given/When/Then:         - **S13.B-01** Given … When … Then … [proof: S13 AS-12]
## Lifecycles        links to models/
## Owns              tables, queues, topics, config
## Decisions         why it is this way
## Known gaps        honest list of what is not proven, deferred or unverified
```

Item references (checked by `scripts/livespec/check.py`):
- `[proof: S13 AS-12, …]`: a test whose title carries that scenario id (`it('S13 AS-12: …')`). `[proof: none]` is allowed but counted and shown: it says "no
  automated proof yet" instead of hiding it.
- `[code: path/to/file.ts#Symbol]`: the file exists and the symbol appears in it.
- `{{concept:slug}}`, `{{cap:S13}}`: the page exists.

## Review

Generated pages are `draft`. A human reads a page and signs it (`python3 scripts/livespec/sign.py sign S13`): the content hash of every rule and behavior is
stored in `.reviewed.json` next to the page. Any later change to a signed item is reported until a human signs it again. Agents never sign (the tool is not in
their allow-list, and `check.py --guard` fails a run that touched a sign-off file).

## Scripts (`scripts/livespec/`)

- `terms.py`: `expand <page>` takes the rules and behaviors of a page apart: a model with no tools lists the exact phrases a junior engineer would have to guess (an everyday word with a special meaning, a named thing of this system, engineering jargon), a second call writes one term page for each (Definition, Example, Known gaps), then the new definition is read the same way, recursively, until nothing new comes up or `--max-depth` / `--max-calls` is reached (reported as NOT FINISHED). The model never rewrites a rule: the script inserts `[phrase](../terms/slug.md)` at the first occurrence inside the item. `deepen` reads every existing definition again. `consolidate` merges synonyms; `break-cycles` keeps definitions acyclic; `redo <slug> --note` rewrites one term; `promote` turns a concept that one sentence explains inline into a shared page when a second place needs it; `accept` records that definitions were read again after a rule changed. The build loop runs `expand` for every newly generated living page. A general software word (HttpOnly, CSRF, JWT) gets no page of ours: it is linked with an arrow, `[HttpOnly ↗](sw-external-terms.md#httponly)`, to the single glossary `sw-external-terms.md`, which only marks the word as "not special here, look it up" and points at an authoritative reference (MDN, an RFC, OWASP); the script opens each reference before it writes it. A link without an arrow goes to a term page of ours. `check.py` reports a link to a missing term, a stale "used by" block, and a rule that uses a word that has a term without linking it.
- `generate.py`: one-run generator of the first draft of every page from the code, the tests and the work-order specs. Not part of the loop: a living page is
  authored from then on; regenerating one overwrites only `draft` pages.
- `check.py`: verification of the whole graph (links, proofs, code refs, concepts, models, coupling between code and page, sign-off drift).
- `sign.py`: sign-off and status.
- `models.py` and `run-models.sh`: state-machine tables against the code; Quint models type-checked and simulated.

## Levers (`scripts/livespec/terms.config.json`)

One file holds every setting of the term tooling; change a value and run the command it affects. Environment variables `TERMS_<NAME>` and command-line flags override it.
- `granularity` (strict | normal | loose): how readily a word gets its own page. Too many pages: `strict`, then `terms.py consolidate --apply`. Too few: `loose`, then `terms.py deepen`.
- `merge_synonyms` and `prune_single_use` (off | conservative | aggressive): how eagerly `consolidate` merges two pages and inlines a single-use page.
- `numbers_in_definitions` (forbid | allow), `definition_max_sentences`, `definition_max_words_per_sentence`: the shape of a definition (`check.py` honours the first).
- `find_model`, `define_model`, `consolidate_model`: which model does each job (the finder runs on Sonnet: Opus flagged about a fifth to a third more phrases in a trial, many of them low value such as `all` or `limit`).
- `find_chunk_items`, `define_batch_terms`, `workers`: speed against load. `max_depth`, `max_calls`: stop the recursion.
- `extra_reference_hosts`: further hosts the glossary may link to.
