# arch-50. Debugging: database CPU at 100% and the connection pool exhausted

*Debugging · Medium*

## The question

"Friday 08:00 UTC, a new season of our biggest show goes live on our streaming service. At 08:06 the Postgres primary (RDS, 16 vCPUs) is at 100% CPU, the API logs fill with `timeout exceeded when trying to connect` from the pg pool, and the home screen fails for most users. Traffic is ~3x a normal Friday. Walk me through the first 15 minutes, how you find the cause, and how you stop it happening again."

**Then:** "The team now wants PgBouncer in front of the database 'so this never happens again'. What does it fix, what doesn't it fix, and what might break?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- What does the home screen query? → assume: a "continue watching" row from `watch_progress` (~2B rows), title metadata (cached), and recommendations from another service.
- Pool settings? → assume: node-postgres, `max: 20` per pod; the API autoscaled from 20 to 60 pods, so up to 1,200 connections; `connectionTimeoutMillis: 5000`.
- Telemetry? → assume: Performance Insights / CloudWatch Database Insights, `pg_stat_statements`, OpenTelemetry traces.
- Recent changes? → assume: Thursday's deploy changed the "continue watching" query to cover all profiles on an account; the home-row cache key now includes the newest season ID.
- Can we degrade the home screen? → assume: yes, the row can be hidden or served stale behind a flag.

## Design

**First 15 minutes: confirm, then reduce load; don't add capacity blindly.**
1. **Is the database the bottleneck?** Database load (average active sessions) far above 16 with waits mostly CPU means queries are burning CPU. Mostly `Lock` or `LWLock` waits would mean contention, a different story.
2. **Which query?** Top SQL by load in Performance Insights, or right now:
```sql
SELECT left(query, 80), count(*) FROM pg_stat_activity
WHERE state = 'active' GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
```
`pg_stat_statements` is cumulative, so take two snapshots a minute apart and diff `total_exec_time` and `calls`.
3. **Mitigate.** Flip the flag that hides or serves a stale "continue watching" row. Cancel the running copies of the bad query (`pg_cancel_backend(pid)`). Set `ALTER ROLE api SET statement_timeout = '2s'` (it applies to new sessions only, so pooled connections need recycling). Pin the API autoscaling max: more pods means more connections and more queued queries on the same 16 CPUs. Lower `connectionTimeoutMillis` to ~1 s so requests fail fast with a degraded response instead of piling up and being retried.
4. **Root cause.** `EXPLAIN (ANALYZE, BUFFERS)` the new query with a heavy account's parameters. Typical finding:
```sql
SELECT ... FROM watch_progress WHERE account_id = $1
ORDER BY updated_at DESC LIMIT 20;      -- only index: (profile_id, updated_at)
```
It reads every progress row of the account through another index and sorts them: cheap for new users, thousands of rows for heavy ones. Thursday it was hidden by the home-row cache; the season launch changed the cache key, so every user missed at once, at 3x traffic.
5. **Fix.** `CREATE INDEX CONCURRENTLY ON watch_progress (account_id, updated_at DESC)`; single-flight and stale-while-revalidate on the home-row cache; pre-warm caches before a launch instead of changing keys at launch.
6. **Prevent.** `statement_timeout` per role and `idle_in_transaction_session_timeout`; `pods × pool.max` within a connection budget, with the autoscaling max derived from it; a load test on production-sized data for query changes before big launches; alerts on DB load above vCPU count, on pool `waitingCount`, and on new top queries.

## Deep dives

**1. Pool exhaustion is a symptom.** Connections in use = queries per second × time per query. 3,000 queries/s at 4 ms needs ~12 busy connections. One query going to 300 ms at 1,000 calls/s needs 300, and 16 vCPUs can only run ~16 at once, so every other query queues inside Postgres, every query slows down, and every pool fills. Adding pods or raising `max_connections` adds waiting processes, not CPU, and Postgres gets slower per connection as the number of active backends grows.

**2. Finding the query when everything is slow.** During saturation, every query looks slow, so "slowest query" misleads. Rank by **total** time (calls × mean) over a short window, and compare with last Friday's top list: the new entry, or the one whose calls jumped, is the cause. Another common cause of a sudden CPU jump: a prepared statement switching to a generic plan. After 5 executions Postgres may cache a generic plan that ignores the actual parameter, which is terrible for skewed data (a heavy account). `EXPLAIN` shows `$1` in the plan; `plan_cache_mode = force_custom_plan` for that role is the quick mitigation.

**3. PgBouncer (twist).** It fixes connection count and churn: thousands of client connections share e.g. 64 server connections, so Postgres runs about as many active backends as it has cores and the waiting happens in PgBouncer, where it's cheap. It doesn't fix an expensive query: CPU stays at 100% and requests now wait in PgBouncer's queue (bound it with `query_wait_timeout`). What breaks in transaction mode: session state (`SET` without `LOCAL`, session advisory locks, `LISTEN`, temp tables, `WITH HOLD` cursors), and named prepared statements unless PgBouncer is 1.21+ with `max_prepared_statements` set. PgBouncer is single-threaded, so one process uses one core: run several (`so_reuseport`) or use RDS Proxy, which pins a client to a connection when it sees session state.

## Traps

- Scaling the API out during the incident: more connections, same CPUs, worse queueing.
- Raising `max_connections` or the pool size to "fix" pool timeouts.
- Hunting for the "slowest" query during saturation instead of the biggest total time.
- `ALTER ROLE ... SET statement_timeout` and expecting existing pooled connections to pick it up.
- Treating PgBouncer as a fix for an expensive query.
- Changing cache keys at the moment of a launch: every user misses at once.

## Say it (60–90 s)

Pool timeouts are a symptom: connections in use equal queries per second times query time, so when one query gets slow, every pool fills. First I confirm the database is the bottleneck: database load far above the sixteen vCPUs, with CPU as the wait. Then I find the query by total time, not by slowest, because during saturation everything is slow: Performance Insights top SQL, or active queries grouped in pg_stat_activity, and a diff of pg_stat_statements against last Friday. To mitigate I reduce load instead of adding capacity: hide or serve stale the continue-watching row with a flag, cancel the running copies of the bad query, set a statement timeout for the API role, pin autoscaling so we stop adding connections, and fail fast on pool waits. The likely cause is Thursday's query, which sorts all of an account's progress rows because no index matches it, and the launch changed the cache key, so every user missed at once at three times traffic. The fix is the right index built concurrently, single-flight and stale-while-revalidate on the cache, and no key changes at launch. To prevent it, statement timeouts per role, a connection budget that caps autoscaling, load tests on production-sized data, and alerts on database load and pool waiting.

## Follow-ups

**Q:** Then: PgBouncer "so this never happens again"?
**A:** It fixes connection count: thousands of client connections share a few dozen server connections, so Postgres never runs hundreds of competing backends. It doesn't fix an expensive query; CPU would still be at 100%, with requests waiting in PgBouncer. In transaction mode it breaks session state (`SET`, session advisory locks, `LISTEN`, temp tables) and, before 1.21, named prepared statements. Worth adding together with the query fix and statement timeouts, not instead of them.

**Q:** Why not just move the query to a read replica?
**A:** It moves the CPU to the replica and adds lag; the query still reads thousands of rows per call. Fix the query, then decide where it runs. A replica is right for this row once it's cheap, since progress can be a few seconds stale.

**Q:** What alert would have caught it Thursday?
**A:** A new statement entering the top 10 by total time with a mean far above the endpoint's budget, checked against a load test on production-sized data before release; Thursday's traffic was too low and too cached to show it.

</details>

## Theory in the notes

- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [03-databases/03-schema-migrations-and-scaling.md](../../03-databases/03-schema-migrations-and-scaling.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [07-observability-reliability/02-logs-metrics-traces.md](../../07-observability-reliability/02-logs-metrics-traces.md)
