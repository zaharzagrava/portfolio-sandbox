# How to run the full suites by hand

Two suites, never at the same time. Backend end-to-end first, then the front end.

## Rules for memory (31 GB machine)

- One heavy command at a time, machine-wide: put `scripts/aiqa/heavy.sh` in front of tsc, eslint, vitest, jest, Playwright, pnpm install/build and `next build`.
- Never run the test stack (`marketplace_test`, backend e2e) and the dev stack (`payment_system_*` / QA stack, front end) together: Scylla and ports clash and RAM runs out. Stop one before starting the other.
- Roughly 5 GB per backend shard and 8 GB per browser slice. Do not start a browser run while shards run.
- Check free memory before each step: `free -g`. Under 8 GB free: wait or stop something.
- Do not run `pnpm install` or a build while a suite runs (the suite reads node_modules).

## A. Backend end-to-end (test stack, 8 shards, about 12 minutes)

1. Make sure no dev stack runs: `docker ps --filter name=payment_system_ -q` prints nothing. If it does: `scripts/qa/stack-down.sh <QA_DIR>` (or stop the developer's own dev stack).
2. Scylla needs a higher aio limit next to other containers: `sudo sysctl fs.aio-max-nr=1048576` (once per boot).
3. Start the test stack: `scripts/infra/stack.sh test setup` (about 2.5 minutes first time; after a reboot always run `setup`, not `up`).
4. Run the suite: `scripts/speedup/run-sharded.sh 8` (use 5 if memory is tight). It resets and prepares the shards itself, then prints time, passed/failed, failing files and the slowest files. Results: `specs/.checkpoints/sharded/`. Expected: about 8,394 passed, 0 failed, 593 files.
5. Rerun only failures by hand through `scripts/infra/shard-run.sh <n> ...` if needed.
6. Stop the test stack before part B: `docker compose -f docker-compose.test.yaml -p marketplace_test stop`.

## B. Front end (dev stack, Playwright)

1. Part A stopped (step A6). No other dev stack running.
2. Regenerate the dev env, so the media address changes apply (media files come from MinIO on port 9100, not 9000): `FORCE=1 bash scripts/infra/make-dev-env.sh`. Without this, photos stay broken in the pages.
3. Start the throwaway dev stack, API, local lambdas, seed data and the dev web server (about 5 minutes): `QA_DIR=/tmp/fe WITH_WEB=1 scripts/qa/stack-up.sh` (create `/tmp/fe` first: `mkdir -p /tmp/fe`). It prints `QA_DIR=/tmp/fe` when ready. Web is on 3000, API on 8000.
4. Derived media files must be public-read. `minio-init` in `docker-compose.yaml` does it on start. If photos still do not show: `docker run --rm --network host --entrypoint /bin/sh minio/mc -c "mc alias set local http://localhost:9100 <user> <password> && mc anonymous set download local/marketplace-media/media/derived"` (user and password are in `packages/backend/.env`), or `docker compose -p <project> run --rm minio-init` (project name is in `/tmp/fe/project`).
5. ffmpeg and ffprobe must be installed, or videos never leave PROCESSING (stack-up warns).
6. Run the seller suite, as the AI QA specs ran: `cd packages/web && ../../scripts/aiqa/heavy.sh npx playwright test tests/seller --project=desktop --project=mobile --output=/tmp/fe/pw-out --reporter=json` with `PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/fe/seller.json` set. The config reuses the web server on 3000 (do not set `CI`), runs 2 workers, and uses the dev server (not `W07_PROD`). Add a spec path or `-g "<title>"` to run less.
   - For the per-line scoreboard use `node scripts/aiqa/run-specs.mjs` and `scripts/aiqa/status.mjs` instead (see `scripts/aiqa/README.md`).
   - Production-build specs only (security headers, widget embed): `W07_PROD=1`, and build first with `scripts/aiqa/tracks/prod-build/prod-server.sh up`.
7. Stop everything when done: `scripts/qa/stack-down.sh /tmp/fe` (removes the containers and volumes of that stack), then `rm -rf /tmp/fe`.

## Order

1. A (backend e2e on the test stack) then stop it.
2. B (front end on the dev stack) then stop it.
3. Type checks, lint and unit tests (`tsc`, `eslint`, `vitest`, `jest`) need no stack: run them before A or after B, each through `heavy.sh`, one at a time.
