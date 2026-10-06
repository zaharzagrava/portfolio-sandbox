# O-02 — Production Dockerfiles & CI/CD (GitHub Actions → ECR → CodeDeploy / Lambda)

Status: ☑ done (written; nothing built, pushed or triggered) · Phase 8 · Depends on: — · Lessons 08/02, 08/01 (deployment strategies), 08/04

## Deliverables
- Multi-stage Dockerfiles per Nest app (`apps/*`): pnpm fetch/offline install layer caching, `nest build <app>`, prune dev deps (`pnpm deploy --prod`), distroless/alpine runtime, non-root, `tini` as PID 1 (signal forwarding — 02/04 PID 1 problem), `HEALTHCHECK`-less (ALB checks), `NODE_OPTIONS=--max-old-space-size` tied to container memory.
- `.dockerignore`.
- GitHub Actions:
  - `ci.yml`: install (pnpm cache), lint, typecheck, unit tests, e2e job with docker-compose.test services (service containers), moon affected-project detection, contract snapshot check.
  - `build.yml`: build + push images to ECR via **OIDC role** (no static keys), SBOM + Trivy scan, tag by git SHA.
  - `deploy.yml`: CodeDeploy **blue/green** to ASG for API, **rolling/instance refresh** for workers, Lambda deploy with alias + **canary 10% for 5 min** (CodeDeploy Lambda), DB migrations as a pre-deploy job (expand/contract compatible), manual approval for prod, automatic rollback on alarm.
- Release safety checklist doc.

## Steps
- [x] Dockerfiles + `.dockerignore`.
- [x] Workflows (never triggered by Claude).
- [x] `appspec.yml` + lifecycle hook scripts (drain: deregister → wait → SIGTERM — ties to F-01 graceful shutdown).

## Scale
Images < 200 MB, cold start of a new ASG instance < 90 s (pre-pulled base AMI layers) so autoscaling keeps up with flash-sale ramps; CI < 10 min via caching + affected-only builds.

## Implementation notes (2026-10-02)
- **`infra/docker/node/Dockerfile`:** one file for every Nest app (`--build-arg APP=`).
  - **Stages:** `pnpm fetch` from the lockfile alone (cached until the lockfile changes) → offline install of `api...` → `nest build $APP` → a separate offline `--prod` install.
  - **Copy:** the runtime copies the pnpm symlink farm whole (root + package `node_modules`), so links resolve without `pnpm deploy`, whose flags changed across pnpm 10-12.
  - **Runtime image:** `node:24 bookworm-slim`, non-root `node`, **tini as PID 1** (signal forwarding to the F-01 graceful shutdown, reaps ffmpeg children). ffmpeg only in the worker image. No `HEALTHCHECK` (ALB probes `/readyz`).
  - **Entrypoint:** sets `--max-old-space-size` to 75% of the cgroup memory limit.
  - **`migrator` target:** the build stage + pinned `sequelize-cli`, run once per release before any new instance starts. `sequelize-cli` wasn't a dependency, so the runtime image can't run migrations hermetically.
- **`.dockerignore`:** keeps `creds/`, `.env*`, other packages and docs out of the context.
- **`pnpm-workspace.yaml`:** `allowBuilds` placeholders (`set this to true or false`) set to `true` for argon2, isolated-vm, @apollo/protobufjs, so native binaries are built in images (Q76).
- **`ci.yml`:**
  - Path filter (affected-only).
  - **checks job:** typecheck, lint without autofix, unit tests, `slo:generate` + `git diff --exit-code`, then `promtool` (config + rules), `amtool`, `otelcol validate` and hadolint.
  - **e2e job:** `docker compose -f docker-compose.test.yaml up --wait` → Postgres/CQL/Dynamo migrations → `test:e2e`, with compose logs uploaded on failure (Q77).
- **`build.yml`:** matrix of 8 apps + migrator.
  - OIDC role (no static keys), buildx with a per-app GHA cache, tag = commit SHA.
  - Syft SBOM artifact; **Trivy gate** (fixable CRITICAL/HIGH fail); image size budget.
  - Lambda bundles (`pnpm build:lambdas`) + `manifest.json` go to S3 per SHA.
- **`deploy.yml`:** demo runs automatically after a green build; prod is manual dispatch through the `prod` GitHub environment (required reviewers = approval). Concurrency per env, never cancelled mid-deploy. Order:
  1. Migrations via a CodeBuild project in the VPC running the migrator image.
  2. APIs: **CodeDeploy blue/green** per app (revision = appspec + hooks + `release.env`). Then the SSM `image_tag` parameter is updated so scale-outs boot the same version.
  3. Workers: **instance refresh** (90% min healthy, AutoRollback on the error alarm).
  4. Lambdas: new version → **CodeDeploy canary 10% for 5 min** on the `live` alias, rolled back by function alarms.
- **`infra/codedeploy/`:** `appspec.yml` + hooks.
  - `pull.sh`: ECR login + pull before the old container stops.
  - `stop.sh`: runs after CodeDeploy deregistered the instance and waited out the deregistration delay; `docker stop --time 35` → SIGTERM → F-01 shutdown.
  - `start.sh`: memory capped at 85% of the host, awslogs driver, config from Secrets Manager inside the app, uniform `METRICS_PORT=9464`.
  - `validate.sh`: `/readyz` must turn 200 within 3 min, or the deployment fails and blue keeps serving.
- **Release checklist:** `docs/runbooks/RELEASE_CHECKLIST.md` (expand/contract, flags, error budget, rollback paths).
