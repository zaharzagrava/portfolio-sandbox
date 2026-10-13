# PostgresConnectionsHigh / DbPoolWaiting

**Severity:** page / ticket · **Owner:** platform · **Dashboards:** *Flash sales & checkout* → Postgres connections; RDS Performance Insights

## What it means
Connections > 80% of `max_connections`. New connections will be refused, and every API instance then fails at once. `DbPoolWaiting` means app pools are queueing: latency rises before errors appear.

## Triage (≤ 5 min)
1. Who holds them? `SELECT usename, application_name, state, count(*) FROM pg_stat_activity GROUP BY 1,2,3 ORDER BY 4 DESC;`
2. Long or idle-in-transaction sessions: `SELECT pid, now()-xact_start AS age, state, left(query,120) FROM pg_stat_activity WHERE state <> 'idle' ORDER BY age DESC LIMIT 20;`
3. Lock pile-up? `SELECT * FROM pg_locks WHERE NOT granted;` (a migration without `lock_timeout`?)
4. Did instance count jump (ASG scale-out × pool size > max_connections)?

## Mitigate
- **Idle in transaction / runaway query:** `SELECT pg_terminate_backend(<pid>);` (safe: the transaction rolls back).
- **Scale-out exhausted the DB:** route through RDS Proxy / PgBouncer (transaction pooling) and cap the ASG max until it is in place; lower the per-instance pool (`DB_POOL_MAX`).
- **Blocking migration:** cancel it (`pg_cancel_backend`); migrations must use `SET LOCAL lock_timeout = '5s'` (conventions).
- **Read-heavy spike:** move reads to the replica (`DB_READ_HOST`) - statements, exports, eval scripts already support it.

## Verify
`sum(pg_stat_activity_count) / max(pg_settings_max_connections)` < 0.6 for 15 min; `db_client_connection_pending_requests` back to 0.
