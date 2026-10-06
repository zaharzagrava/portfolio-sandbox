# O-03 — Terraform AWS Infrastructure (no Kubernetes)

Status: ☑ done (written + statically checked; never planned or applied) · Phase 8 · Depends on: D10–D16 · Lessons 08/02 §4, 08/03

## Layout
`infra/modules/`: `network` (VPC, 2 AZ, NAT instance|gateway by env, VPC endpoints for S3/DynamoDB/SQS/ECR/Secrets to cut NAT cost), `alb`, `asg_service` (launch template, user-data pulling image, instance refresh, lifecycle hooks, target-group health checks = readiness), `rds` (Postgres w/ postgis+pgvector params, Multi-AZ toggle, read replica toggle, RDS Proxy toggle), `elasticache`, `msk` = **not used** (Confluent provider kept, D12), `keyspaces` (tables), `dynamodb` (tables from `packages/backend/dynamodb/*.json`), `sqs` (queues + DLQs + FIFO), `lambda_sqs_worker`, `s3_cloudfront` (OAC, signed URLs key group), `opensearch` (prod) / shared `search_analytics_ec2` (demo: ES + ClickHouse on one t4g.medium), `clickhouse_ec2` (prod), `secrets`, `observability` (CloudWatch alarms, AMP/ADOT), `budgets`, `github_oidc`, `cloudflare` (DNS, proxied records, worker routes).
`infra/envs/demo/` and `infra/envs/prod/` with `env` variable (D16), remote state S3 + DynamoDB lock.
Scripts: `deploy-demo.sh`, `destroy.sh` (never run by Claude).

## Patterns
IAM least privilege per service role; security groups by tier; no public DB; secrets never in tfvars; tagging for cost allocation; `prevent_destroy` on prod data stores.

## Steps
- [x] Restructure existing `infra/main.tf` into modules (keep Confluent + Cloudflare + Upstash resources).
- [x] Modules above; `terraform fmt`-style formatting by hand (no terraform runs).
- [x] Cost table per env in `infra/README.md`.

## Scale
`prod` sizing derived from section capacity models (D25): ASG max sizes, RDS class + replicas, ElastiCache shards, Keyspaces/Dynamo on-demand, SQS/Lambda reserved concurrency. `demo` = smallest viable (D16). Next step documented: cell-per-region stacks (same modules, new env).

## Implementation notes (2026-10-02)
- **Structure:**
  - **Modules:** 19 under `infra/modules/`.
  - **Stack:** `infra/stack` composes the whole environment once; `envs/demo` and `envs/prod` pass only sizing (D16).
  - **Bootstrap:** `infra/bootstrap` creates the state bucket. Locking uses S3 `use_lockfile` instead of a DynamoDB table (Q80).
  - **Old flat `infra/main.tf`:** removed. Its Confluent/Upstash/Cloudflare/RDS resources live in `confluent`, `edge` and `rds`; its ECS service (placeholder task ARN) was dropped, since ECS contradicts the EC2/ASG decision.
- **Single sources:**
  - DynamoDB tables are `jsondecode`d from `packages/backend/dynamodb/*.json`.
  - Keyspaces tables come from the same `cql/*.cql` via `pnpm cql:migrate` in the release migration step (CodeBuild, `migrator` image, secrets via CodeBuild `SECRETS_MANAGER` env vars).
  - SQS queues = the ElasticMQ list. While doing this, two unused placeholder queues were removed locally (`document-extraction`, `knowledge-ingestion`, duplicates of `onboarding-documents` / `knowledge-ingest`).
  - Lambdas are read from the build's `manifest.json`.
  - AMP rule groups upload `infra/observability/prometheus/rules/*.yml` unchanged.
- **Compute (`asg_service`):** arm64 AL2023, IMDSv2 (hop limit 2 for the container), mixed On-Demand/Spot with price-capacity-optimized.
  - **User-data:** Docker, the CodeDeploy agent, and an ADOT agent (OTLP → X-Ray with head sampling, scrape `:9464` → AMP). It boots the version in SSM `/marketplace/<env>/<app>/image_tag` using the same hooks CodeDeploy runs, so scale-outs match the deployed release.
  - **Scale-in:** a drain lifecycle hook plus a termination watcher (stop container → complete lifecycle action).
  - **Deploy:** HTTP apps get a CodeDeploy blue/green group (AllAtOnce green validation, auto-rollback on failure and alarms, blue kept 15 min); workers use instance refresh.
  - **Scaling:** CPU target tracking (SSE/collab scale earlier at 40%); the projector scales on consumer lag.
- **Edge & TLS:**
  - The ACM certificate is validated through Cloudflare DNS records.
  - In prod the ALB only accepts Cloudflare IP ranges.
  - The CDN CNAME is not proxied, so signed cookies keep working.
  - CloudFront can only read `media/derived/*` and HLS `videos/*.m3u8|*.ts`; originals, video sources, KYC files, imports and exports are unreachable through it. `videos/*` requires signed cookies (Q79).
- **Build arch:** arm64 everywhere, so `build.yml` was switched to `ubuntu-24.04-arm` runners (native modules must match the target).
- **Verification without Terraform:**
  - All 31 `.tf` files parse with an HCL2 parser.
  - A cross-check script confirmed every module call passes only declared variables and all required ones, every `module.x.y` reference is a declared output, and every `var.`/`local.` reference resolves (0 problems).
  - `terraform fmt` / `validate` / `plan` were not run (D2, D16).
