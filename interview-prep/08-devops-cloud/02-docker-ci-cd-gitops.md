# Docker, CI/CD, GitOps (ArgoCD), Terraform

---

## 1. Production Dockerfile for Node (and why each line matters)

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev        # prod deps only, cached

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci                   # incl. dev deps for build
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM gcr.io/distroless/nodejs24-debian12 AS runtime                # or node:24-slim + USER node
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER nonroot
EXPOSE 3000
CMD ["dist/main.js"]                                               # distroless entrypoint is node
```

Points to explain:
- **Multi-stage**: the build tools and dev dependencies don't ship. The final image is smaller, with less attack surface.
- **Layer caching order**: copy the lockfiles → install → copy source. Source changes then don't trigger a reinstall.
- `npm ci`: reproducible, installs strictly from the lockfile, fails if the lockfile and package.json disagree.
- **Non-root user**, and a read-only root filesystem in K8s (`securityContext.readOnlyRootFilesystem: true`, `runAsNonRoot`, drop all capabilities).
- **Exec form CMD** so node receives signals (see the PID 1 notes in the graceful shutdown doc). Use `tini`/`--init` if you spawn child processes.
- **Alpine caveat**: musl libc. Some native modules (sharp, bcrypt, prisma engines) need musl builds, and DNS and performance behave differently. Debian slim is the safer default.
- `.dockerignore`: `node_modules`, `.git`, `.env*`, tests, and local artifacts. Smaller build context, and secrets don't leak in.
- **Never** bake secrets into the image (`ARG`/`ENV` values persist in layers). Use BuildKit `--mount=type=secret` for private registries.
- Pin base images by **digest** for reproducibility, and rebuild regularly for security patches (Renovate/Dependabot).
- Scan images (Trivy, Grype, ECR scanning), produce an SBOM (syft), sign them (cosign).
- **Next.js**: `output: 'standalone'` copies only the needed `node_modules` files into `.next/standalone`, so the image is much smaller.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`scripts/build-lambdas.mjs`](../../packages/backend/scripts/build-lambdas.mjs): build-lambdas.mjs compiles the TypeScript Lambdas and bundles them with esbuild into deployable artifacts, which is the build step that a production image or package builds on.
<!-- theory-links:end -->

---

## 2. CI pipeline design

```
PR opened
 ├─ install (cached) → lint + typecheck + unit tests (parallel)
 ├─ integration tests (Testcontainers: real Postgres/Redis)
 ├─ build image (cache from registry), scan, push with tag = git SHA
 ├─ migration check (run migrations against fresh DB + previous version's schema compatibility)
 ├─ preview environment (optional, ephemeral namespace per PR)
 └─ required checks green → merge
Merge to main
 ├─ build & push image :<sha>
 ├─ update GitOps repo (image tag bump) → ArgoCD syncs staging
 ├─ e2e/smoke tests on staging
 └─ promote to prod (PR to env overlay / Argo Rollouts canary with analysis)
```

Practices:
- **Trunk-based development** with short-lived branches and feature flags for unfinished work.
- **Build once, promote the same artifact** (the image digest) through environments. Don't rebuild per environment.
- Make it fast: dependency caching, test sharding, **affected-only** builds in monorepos (Nx, Turborepo), remote build cache.
- **Cloud auth via OIDC** (GitHub Actions or GitLab to AWS IAM role), no static access keys in CI.
- Keep main **always deployable**, and make rollback a one-step action.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`slo/generate.ts`](../../packages/backend/scripts/slo/generate.ts): scripts/slo/generate.ts generates SLO Prometheus rules and k6 load-test thresholds from YAML, so the SLO checks that a CI pipeline can run come from one definition.
<!-- theory-links:end -->

### Example: shrinking a slow Next.js build
When describing a build or deploy speed-up, be precise about **what** was slow and **why** the change helped. A typical Next.js case:
- The Next.js build was rendering pages with **all localization payloads**: every locale's dictionary serialized into each page's HTML/RSC payload (and possibly pre-rendering every locale × page).
- Fix: load only the namespaces and locale needed per page, keep translations on the server (server components) rather than shipping full dictionaries to the client, and possibly render rarely visited locale pages on demand (ISR) instead of at build time.
- Results: smaller HTML (faster TTFB and LCP for users, lower bandwidth and CDN cost), a faster build (less serialization and fewer pre-rendered bytes), and smaller artifacts to upload and deploy.
- Have numbers ready: HTML size before and after, build-step timings, how you measured them.

---

## 3. GitOps with ArgoCD

- **Git is the source of truth** for desired cluster state. ArgoCD **pulls** and reconciles the cluster to match Git, and **detects drift** (manual `kubectl edit` gets reverted if self-heal is on).
- Benefits: an audit trail (every change is a commit/PR), rollback = `git revert`, no cluster credentials in CI (CI only writes to Git).
- Concepts:
  - `Application` (repo + path + destination cluster/namespace), **App of Apps** or **ApplicationSet** (generate apps per environment or cluster).
  - **Sync waves and hooks**: `argocd.argoproj.io/hook: PreSync` for a **DB migration Job** before the new pods roll out; `sync-wave` annotations for ordering (CRDs → infra → apps).
  - Sync policies: automated, prune, selfHeal.
  - Health checks per resource type, and **Argo Rollouts** for canary/blue-green with analysis.
  - Image tag updates via CI committing to the config repo, or Argo CD Image Updater.
- Environments: Kustomize overlays (`base/`, `overlays/staging`, `overlays/prod`) or Helm values per environment.

```yaml
# Migration job as PreSync hook
apiVersion: batch/v1
kind: Job
metadata:
  name: db-migrate
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: BeforeHookCreation
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: registry/app:<sha>
          command: ["node", "dist/migrate.js"]
```

---

## 4. Terraform

- **Declarative IaC**: plan (diff) → apply. **State** maps resources to real infrastructure.
- **Remote state** (S3, with DynamoDB locking or the newer S3-native locking) and **state locking** to stop concurrent applies. Never commit state (it contains secrets).
- **Modules** for reuse, pinned versions for providers and modules.
- **Plan in the PR** (Atlantis, or Terraform Cloud/Spacelift): reviewers see the exact changes. Apply after merge.
- **Drift detection**: scheduled plans.
- Separate state per environment and per component (smaller blast radius, faster plans).
- `prevent_destroy` lifecycle on databases. Watch for `-/+` (replace) on stateful resources in plans.
- `terraform import` / `import` blocks for existing resources. `moved` blocks for refactoring without destroying.
- CloudFormation: AWS-native, state managed by AWS, stack rollbacks, drift detection, but AWS-only. CDK generates CloudFormation from TypeScript.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [aws](../../docs/humans/concepts/platform-aws/aws.md): The aws platform module provides the AWS API service that the Terraform-managed infrastructure is used through.
<!-- theory-links:end -->

---

## 5. Release safety checklist (good closing answer)

1. Backward-compatible schema and API changes (expand/contract).
2. Migrations as a separate step, with `lock_timeout`, tested on production-sized data.
3. Canary or progressive delivery with automated SLO analysis.
4. Feature flags for risky behavior.
5. Readiness probes plus graceful shutdown, so there's no dropped traffic.
6. Deploy markers in observability, and alerts tied to the SLO.
7. One-click rollback (git revert / Argo rollback), practiced.
8. Small, frequent deploys (DORA metrics: deployment frequency, lead time, change failure rate, MTTR).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`installGracefulShutdown`](../../packages/backend/libs/infrastructure/lifecycle/graceful-shutdown.ts#L28): installGracefulShutdown sets readiness to false on SIGTERM, drains, closes the server and runs hooks, so rollouts drop no traffic. _(graceful-shutdown.ts)_ · [lifecycle](../../docs/humans/concepts/platform-lifecycle/lifecycle.md)
> - [telemetry](../../docs/humans/concepts/common-telemetry/telemetry.md): The telemetry module defines SLOs and generates multi-window, multi-burn-rate Prometheus alerts, which tie alerts to releases.
> - [`clickhouse/migrate.ts`](../../packages/backend/scripts/clickhouse/migrate.ts): migrate.ts applies ClickHouse SQL migrations in order and records them in schema_migrations, so migrations run as a separate, idempotent step.
<!-- theory-links:end -->

---

## Interview Q&A

**Q: How do you run DB migrations in a K8s/GitOps setup?**
As a separate Job, run as an ArgoCD PreSync hook or a pipeline step before the rollout, never in app startup across N replicas. Migrations are backward compatible (expand/contract), so old pods keep working while new ones roll out and an app rollback doesn't need a schema rollback. Set `lock_timeout` and test against production-sized data.

**Q: How do you make Docker builds fast and images small?**
Multi-stage builds, lockfile-first layer ordering, BuildKit cache mounts, registry layer cache in CI, prod-only deps in the final stage, distroless or slim base, `.dockerignore`, and Next.js standalone output.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`clickhouse/migrate.ts`](../../packages/backend/scripts/clickhouse/migrate.ts): migrate.ts runs migrations as a standalone script with applied-file tracking, not in app startup across replicas.
<!-- theory-links:end -->
