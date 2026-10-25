# Track "planted-bugs": how many bugs does the whole QA flow really find?

Plain words: five realistic bugs are hidden in a throwaway copy of the code (one wrong rule, one missing permission check, one off-by-one, one lost update, one leaked field). The normal flow runs against that copy and a script counts how many of the five it reported. Example: if only 3 of 5 are found, the flow still misses a kind of bug, and you learn which kind.

## What this finds that the other tracks miss

It measures the flow itself, not the app. All other tracks look for bugs; this one says how good the looking is.

## Prerequisites

- A git worktree `../portfolio-sandbox-planted` (made by `plant.sh`; the main checkout and `../portfolio-sandbox-qa` are never touched). It needs its own stack on other ports or your main stack stopped; node_modules are linked automatically.
- The testers must not see `reveal.md`, `patches/` or `probes/`.

## How to point it at a NEW feature

Add a patch to `patches/` (one file per bug, `<n>-<kind>-<name>.patch`, made with `git diff` against master on the feature's files), add a keyword rule for it to `RULES` in `score.sh` and an entry to `reveal.md`, and a probe assertion to `probes/planted-probe.spec.ts` (it must pass on clean code and fail on planted code). Keep one bug per kind: wrong rule, missing check, bad boundary, lost update, leaked data. Re-plant with the new set.

## Commands

```
scripts/aiqa/tracks/planted-bugs/plant.sh --check      # do the patches apply to master? writes nothing
scripts/aiqa/tracks/planted-bugs/plant.sh              # create the worktree and plant the bugs
scripts/aiqa/tracks/planted-bugs/plant.sh --probe      # clean code: probe passes; planted code: probe fails 5 times
scripts/aiqa/tracks/planted-bugs/plant.sh --reset      # take the bugs out;  --remove deletes the worktree
# run the usual flow against the worktree with findings in a fresh folder, then:
scripts/aiqa/tracks/planted-bugs/score.sh <findings-folder>
```

## How to read the results

`score.sh` prints FOUND (with the matching finding titles) or MISSED per bug, by keywords: a hint, not proof; read the matched findings and confirm. Findings marked `[FALSE]`, `[REJECTED]` or `[NOT-A-BUG]` are ignored; findings written before planting must be moved away.

## How results become map lines, findings and register entries

Not map lines. The score goes into `docs/work/qa-bug-scoreboard.md`. A MISSED bug says which kind of test is missing: add that kind to the testers' prompt (`prompts/tester.md`) or a new track, then run again.

## Known limits

Five bugs is a small sample; keywords can match by chance; run it once per round of improvements, not every day.

## Details (from the first version of this README)

## Track 1: planted bugs

Measure how many known bugs the AI QA flow finds. Five realistic bugs (one per kind) are patched into a throwaway copy of master.

- `./plant.sh` creates the worktree `../portfolio-sandbox-planted` (branch `planted-bugs-sandbox`) and applies `patches/*.patch`. `--check` tests the patches against master only; `--probe` runs `probes/planted-probe.spec.ts` (6 pass on clean code, 5 fail when planted); `--reset` removes the bugs; `--remove` deletes the worktree.
- Run the usual flow (stack, `explore.sh`) against that worktree, with findings going to a fresh folder, then `./score.sh <findings-folder>`.
- `reveal.md` is the secret list. Keep it, `patches/` and `probes/` out of tester prompts.
- The main checkout and `../portfolio-sandbox-qa` are never touched by these scripts.
