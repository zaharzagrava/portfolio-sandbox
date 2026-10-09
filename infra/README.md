# Infrastructure (O-03) - AWS without Kubernetes

Terraform for the whole marketplace: EC2 Auto Scaling groups (one app per group), managed data stores, SQS + Lambda workers, Confluent Kafka, and Cloudflare at the edge. **Nothing here has ever been planned or applied by automation.** Run `deploy-demo.sh` yourself.

## Layout
```
infra/
  bootstrap/            one-time remote-state bucket (S3 native locking, use_lockfile)
  stack/                the whole environment, composed from modules (envs differ only in sizing)
  envs/demo, envs/prod  backend + providers + sizing → module "stack"
  modules/
    network             VPC, 2 AZ, public/private/data subnets, NAT (1 or per-AZ), S3/DynamoDB gateway endpoints, interface endpoints (prod)
    alb                 HTTPS ALB, target group per HTTP service, path routing, /health/ready health checks, Cloudflare-only ingress (prod)
    asg_service         launch template (AL2023 arm64, IMDSv2, encrypted gp3), mixed On-Demand/Spot ASG, user-data (Docker,
                        CodeDeploy agent, ADOT), drain lifecycle hook, instance refresh, target tracking, CodeDeploy blue/green group
    rds                 Postgres 17 (PostGIS/pgvector), managed master secret, Multi-AZ / replica / RDS Proxy toggles, deletion protection (prod)
    elasticache         Valkey/Redis, noeviction, Multi-AZ failover when replicas > 0, TLS
    dynamodb            tables generated from packages/backend/dynamodb/*.json (same files local dev uses)
    keyspaces           keyspace + access; tables come from packages/backend/cql/*.cql via `pnpm cql:migrate`
    sqs                 every queue + DLQ + redrive allow policy (mirrors infra/docker/elasticmq/elasticmq.conf)
    lambda_sqs_worker   functions from the build's manifest.json, `live` alias, event source mapping (batch failures,
                        max concurrency), error alarms, CodeDeploy canary (prod: 10% for 5 min)
    s3_cloudfront       media + artifacts buckets, OAC, signed-cookie HLS behavior, lifecycle rules (imports, KYC safety net)
    search_analytics    demo: one EC2 running Elasticsearch + ClickHouse; prod: OpenSearch Service + ClickHouse EC2
    db_migrate          CodeBuild project in the VPC running the `migrator` image (Postgres + CQL) per release
    observability       deployment-gating alarms (5xx ratio, p99, worker status), DLQ alarms, AMP + rule upload, pager SNS
    budgets             monthly budget (forecast 80%, actual 100%) + NAT data budget
    github_oidc         OIDC provider, build role (ECR push, artifacts), deploy role (only from the GitHub environment)
    confluent           Kafka cluster (Basic for demo, Standard multi-zone for prod), service account, API key, all topics
    edge                Cloudflare DNS (proxied API, CDN CNAME), Worker routes for packages/edge-be, Upstash Redis
  codedeploy/           appspec + hooks (pull, drain-aware stop, start, /health/ready validation)
  docker/node/          the app Dockerfile (O-02)
  observability/        local Prometheus/Alertmanager/Loki/Alloy/Grafana/Collector configs (SD-33)
```

## Principles
- **One source per schema:** DynamoDB tables from the JSON files, Keyspaces tables from the CQL files, SQS queues mirrored in ElasticMQ, Lambda specs from the build manifest, Prometheus rules generated from `docs/slo`.
- **No secrets in tfvars or state:** secret *containers* only (`marketplace/<env>/app`); RDS manages its own master password; Keyspaces credentials and API keys are put out-of-band. Provider credentials come from env vars.
- **Least privilege:** instance roles per app (HTTP apps produce to SQS, workers consume); the deploy role only works from the protected GitHub environment of its env; IMDSv2 only; SSM Session Manager instead of SSH.
- **Network tiers:** ALB in public subnets; apps in private subnets (egress through NAT / endpoints); data stores in data subnets with no internet route; security groups by tier.
- **Delete-safety:** `prevent_destroy` can't depend on a variable, so prod uses the real per-resource switches: RDS/DynamoDB deletion protection, RDS final snapshot, no `force_destroy` on prod buckets; `destroy.sh` refuses prod.
- **Cost allocation:** every resource tagged `project`, `env`, `managed_by` (provider default_tags + module tags).

## First apply (demo)
1. `cd infra/bootstrap && terraform init && terraform apply` (once per account).
2. `pnpm --filter api build:lambdas` (Terraform reads `dist/lambda-bundles/manifest.json`).
3. `cp envs/demo/terraform.tfvars.example envs/demo/terraform.tfvars` and fill it.
4. Export `AWS_PROFILE`, `CONFLUENT_CLOUD_API_KEY/SECRET`, `CLOUDFLARE_API_TOKEN`, `UPSTASH_EMAIL/UPSTASH_API_KEY`.
5. `./deploy-demo.sh` (plan → confirm → apply).
6. Put `terraform output app_config` + real secrets into `marketplace/demo/app`; set `terraform output github_vars` as GitHub environment variables.
7. Push to master: build.yml → deploy.yml (demo).

## Monthly cost (approximate, eu-central-1 list prices; verify with the AWS Pricing Calculator)
| Item | demo | prod (baseline, before autoscaling) |
|---|---|---|
| EC2 app fleets | ~$65 (8 × t4g.small/medium, mostly Spot) | ~$1,150 (18 instances m7g/c7g.large-xlarge, Spot above base for workers) |
| ALB | ~$22 | ~$60 |
| NAT + VPC endpoints | ~$45 (1 NAT) | ~$260 (2 NAT + 14 interface ENIs) |
| RDS Postgres | ~$33 (db.t4g.small, single-AZ) | ~$2,350 (r7g.2xlarge Multi-AZ + replica + Proxy) |
| ElastiCache | ~$13 (t4g.micro) | ~$550 (3 × r7g.large) |
| Search + analytics | ~$40 (one shared t4g.medium) | ~$1,000 (OpenSearch 3 data + 3 masters, ClickHouse r7g.xlarge) |
| Kafka (Confluent) | ~$10 (Basic, usage) | ~$1,200 (Standard multi-zone) |
| DynamoDB, SQS, Lambda, Keyspaces, S3, CloudFront | ~$15 | ~$500 (traffic-dependent) |
| Observability (CloudWatch, X-Ray, AMP) | ~$15 | ~$300 |
| Secrets, KMS, ECR | ~$10 | ~$30 |
| **Total** | **~$270** (budget alert $350) | **~$7,400** (budget alert $15,000 incl. peaks) |

LLM tokens (Anthropic, Voyage) are billed outside AWS and tracked in ClickHouse `llm_daily` (SD-42).

## Next steps (documented, not built)
- **Cell-per-region:** a new `envs/prod-us` with the same stack; Cloudflare geo-steering in front. Data residency is per cell.
- **Tail-sampling gateway tier** for traces (SD-33): agents' `loadbalancing` exporter → a gateway ASG.
- **Valkey cluster mode** once one primary's memory or ops/s is not enough (keys are already hash-tagged).
- **ClickHouse Cloud / a replicated ClickHouse cluster** when one node's ingest (~200k rows/s) is the limit.
