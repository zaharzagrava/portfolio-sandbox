# Release safety checklist (O-02)

Before merging to master (which deploys to demo automatically) and before dispatching a prod deploy:

**Schema & data**
- [ ] Migrations are **expand/contract**: this release only adds (columns nullable or defaulted, new tables, `CREATE INDEX CONCURRENTLY` in its own migration). Drops/renames ship one release *after* no running code uses the old shape.
- [ ] Every migration sets `SET LOCAL lock_timeout = '5s'`; backfills run as jobs (SD-29), not inside the migration.
- [ ] Kafka/SQS payload changes are backward compatible: consumers accept the old **and** new version (event `version` + upcasters, F-05).

**Rollout**
- [ ] Risky behaviour is behind a flag (SD-38), default off, with a kill switch; rollout plan written in the PR.
- [ ] Error budget of the affected journeys is > 0 (`docs/slo/README.md` policy); if 0-50%, the PR names the rollback plan.
- [ ] Prod: deploy outside the launch-event / flash-sale calendar; on-call aware.

**Verification**
- [ ] CI green: typecheck, lint, unit, API e2e, generated SLO rules up to date, observability configs valid, Trivy gate.
- [ ] After deploy: Grafana *API — RED* and the journey's SLO panel stable for 15 min; no new error log signatures in Loki.

**Rollback (automatic first)**
- APIs: CodeDeploy blue/green rolls back on deployment failure or alarms; manual: stop the deployment with rollback, or redeploy the previous SHA via `deploy.yml`.
- Workers: instance refresh `AutoRollback` on the error alarm.
- Lambdas: the canary alias shift rolls back on function alarms.
- Schema: never roll back a migration in prod - ship a forward fix (that's why changes are additive).
