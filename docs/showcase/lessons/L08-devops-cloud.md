# L08 — DevOps & Cloud → where it's used (no Kubernetes, D10)

| Topic (notes 08/01–04) | Implemented in | Status |
|---|---|---|
| Liveness vs readiness vs startup semantics (mapped to ALB target health + ASG health checks) | F-01, O-03 | planned |
| Deployment strategies: rolling (ASG instance refresh), blue/green (CodeDeploy), canary (Lambda alias, weighted ALB target groups), feature flags | O-02, SD-38 | planned |
| Resources & autoscaling (ASG target tracking, queue-depth scaling, lag scaling) | O-03 | planned |
| Config & secrets | O-03, F-02 | planned |
| Production Dockerfile | O-02 | planned |
| CI pipeline, caching, affected builds | O-02 | planned |
| GitOps (ArgoCD) | K8s-specific → replaced by "deploy from Git via Actions + CodeDeploy" (D10) — documented equivalence | n/a |
| Terraform (modules, state, envs) | O-03 | planned |
| AWS services knowledge (Lambda, SQS, RDS Proxy, DynamoDB, Keyspaces, VPC endpoints, IAM, cost) | O-03, SD-03 | planned |
| Testing strategy: unit / integration (real DBs) / contract / e2e / load / chaos | F-04, D5, k6 per section, existing chaos #1 | planned |
