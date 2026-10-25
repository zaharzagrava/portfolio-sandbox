# Track 1: planted bugs

Measure how many known bugs the AI QA flow finds. Five realistic bugs (one per kind) are patched into a throwaway copy of master.

- `./plant.sh` creates the worktree `../portfolio-sandbox-planted` (branch `planted-bugs-sandbox`) and applies `patches/*.patch`. `--check` tests the patches against master only; `--probe` runs `probes/planted-probe.spec.ts` (6 pass on clean code, 5 fail when planted); `--reset` removes the bugs; `--remove` deletes the worktree.
- Run the usual flow (stack, `explore.sh`) against that worktree, with findings going to a fresh folder, then `./score.sh <findings-folder>`.
- `reveal.md` is the secret list. Keep it, `patches/` and `probes/` out of tester prompts.
- The main checkout and `../portfolio-sandbox-qa` are never touched by these scripts.
