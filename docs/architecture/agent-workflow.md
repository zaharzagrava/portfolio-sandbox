# 🤖 Agent Workflow

Rules for AI agents working in this repo. Complements [Testing Strategy](Testing%20Strategy.md).

## Repo layout facts
- `.claude/` is a real directory. Only `.claude/skills` is a symlink to `../.agents/skills`.
- **Edit skills in `.agents/skills/`.** Never create or edit files under `.claude/skills/`, since they are the same files.

## Environment rules
- **Never run `docker compose` / `docker start|stop|rm`.** The user manages infra with moon (`infra-up`), which is usually already running. If infra is down, ask the user to start it.
- Dev infra DB: `localhost:5300` (`postgres`/`postgres`). Test infra DB: `localhost:5400`, db `marketplace_test`, defined in `docker-compose.test.yaml` and `packages/backend/.env.test`. If the test stack is down, ask the user.
- If backend e2e fails with `relation "X" does not exist`, the test DB schema is empty or stale. Run `pnpm --filter api db:jest:migrate:up` (touches only the test DB).
- `dev-monolith` and `dev-web` (moon tasks) may already be running. Check before starting them, and do not start duplicates.
- RAM is limited: do not run the dev apps and the backend e2e suite at the same time.

## Autonomous verification loop
1. Write or update the feature spec.
2. Write failing tests first (BE e2e, FE Playwright, unit tests for complex logic). Run each **individual file**, never the whole suite, and use a timeout (e.g. `timeout 120 ...`).
3. Fix the code until those files pass.
4. **Live check**: start `dev-monolith` and `dev-web` (if not running) and reproduce the original user scenario against `http://localhost:3000` (Playwright specs against the dev servers, or `curl` against the API). Confirm the behaviour, not only green tests.
5. Stop only the dev servers you started, update the spec/test docs and walkthrough, and report what was verified and what was not (known gaps, `test.fail` cases).

## Commands
| Step | Command |
| --- | --- |
| Test DB schema | `pnpm --filter api db:jest:migrate:up` |
| BE e2e, one file | `timeout 120 pnpm --filter api test:e2e <name>` |
| BE unit, one file | `timeout 120 pnpm --filter api test <name>` |
| FE unit, one file | `timeout 120 pnpm --filter web test <name>` |
| FE Playwright, one spec (needs dev-monolith + dev-web running) | `timeout 180 pnpm --filter web test:e2e <spec>` |
