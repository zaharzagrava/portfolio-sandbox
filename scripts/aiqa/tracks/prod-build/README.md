# Track "prod-build": the same checks on the production build

Plain words: the dev server (`next dev`) behaves differently from the real thing: it prints many more console errors, it streams pages differently, it adds its own scripts. This track builds the web app the way production does, runs the monkey tester (clicks random things for 10 minutes) and the API fuzzer (sends random bad requests) against it, and re-checks every finding that was only ever seen on the dev server. Example: B-003 (1,468 "inline style" console errors on dev, 0 on production) was closed as dev-only noise; B-026 (not-found pages answer HTTP 200) turned out real on production too.

## What this finds that the other tracks miss

Bugs that only exist in the production build (minified React errors such as #418, headers, caching of pages, build failures such as the type error S-6), and noise that exists only in dev (so nobody wastes a fix on it).

## Prerequisites

- The dev stack for the API (`QA_DIR=/tmp/fe WITH_WEB=1 scripts/qa/stack-up.sh`): API :8000 must answer `/health/ready`; the dev web server on :3000 is the control for the re-check.
- The production server on :3100 (`prod-server.sh up` builds with `pnpm run build:e2e` only when the build is older than the sources; if the real tree does not type-check it builds a throwaway copy without test files). The script stops it again only if it started it.
- Memory and time: the build takes several minutes and a few GB; the monkey and the fuzzer take `--minutes` (default 10) each. Do not run next to the backend test stack or a full Playwright run.
- Pid and log of the production server: `/tmp/aiqa-prod-server`.

## How to point it at a NEW feature

1. Monkey and fuzzer cover the seller pages and seller API through `scripts/qa/monkey-seller.mjs` and `scripts/qa/fuzz-seller-api.mjs`; add the new pages/routes to the page list and route list in those two files.
2. The re-check list (`recheck.mjs`) names the dev-only findings to compare (B-003, B-005, B-026, B-031). For a new dev-only finding add a probe function there: it must open the page on both servers and return the dev and prod numbers.
3. Hand verdicts go to `triage.md` (so a re-run keeps them).

## Commands

```
scripts/aiqa/tracks/prod-build/run.sh [--minutes 10] [--seed N] [--skip-monkey] [--skip-fuzz] [--keep-server]
scripts/aiqa/tracks/prod-build/prod-server.sh up|down|status
node scripts/aiqa/tracks/prod-build/recheck.mjs --dev http://localhost:3000 --prod http://localhost:3100 --api http://localhost:8000 --out result.json
```

## How to read the results

`scripts/aiqa/findings/prod-build.md` (written by `report.mjs`): a table of the re-checked findings with dev numbers next to prod numbers, then the monkey and fuzzer findings. Raw evidence stays in `specs/.checkpoints/qa-prod-build/<time>/`. The monkey's seed replays the same actions (`--seed N`, action log in `specs/.checkpoints/qa-monkey/<time>/actions.jsonl`). Hand verdicts: `triage.md`.

## How results become map lines, findings and register entries

A finding that is real on production goes to the register (B-nnn) and, if a map line is about that behaviour, the line is set to `bug`. A finding that is dev-only is closed in the register as "dev-only noise" with the numbers. Accessibility findings from the monkey go to the `a11y` track.

## Known limits

- The production build here uses the e2e settings (`SITE_URL=https://localhost`), which can create test-only artefacts (the `/orders` over https errors in the first run were not explained).
- The monkey is random: a clean run is not proof; use several seeds.
- Only the seller pages are listed; buyer pages are not part of this run.
