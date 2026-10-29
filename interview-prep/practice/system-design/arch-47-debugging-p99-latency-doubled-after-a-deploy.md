# arch-47. Debugging: p99 latency doubled after a deploy

*Debugging · Easy*

## The question

"After Tuesday's deploy, p99 latency on `GET /projects/:id/summary` in our project management SaaS went from 180 ms to 400 ms. p50 barely moved and the error rate is flat. The deploy had 40 commits, including an ORM upgrade and one migration. Walk me through how you investigate and fix it."

**Then:** "You roll back the deploy and p99 stays at 400 ms."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- One endpoint or all? → assume: mostly this one, slightly others.
- Did traffic change at the same time? → assume: normal Tuesday traffic; verify rather than assume.
- What telemetry exists? → assume: per-endpoint latency histograms, OpenTelemetry traces, `pg_stat_statements` on the database.
- Is it breaching the SLO? → assume: the SLO is p99 < 500 ms, so not an incident yet, but close.
- What did the migration do? → assume: added a column and an index on the `tasks` table.

## Design

**Investigation, in order.**
1. **Scope.** Overlay the deploy marker on p99 per endpoint, per instance, per AZ. All instances → code or data; some → host or AZ. p50 flat and p99 up means a *subset* of requests got slow: specific accounts, a specific code path, cache misses, or queueing.
2. **Mitigate if needed.** The SLO isn't breached, so no rollback yet. If it were, roll back first and investigate after.
3. **Traces.** Pull exemplars from the slowest bucket before and after. Is the extra time in a DB span, an external call, or a **gap** between spans? A gap usually means CPU work or event-loop blocking.
4. **Database.** Diff `pg_stat_statements` (mean, max, calls per query) for the week before and after. An ORM upgrade can change generated SQL: lazy relations become N+1, eager loading pulls whole relations, a `LIMIT` disappears. `EXPLAIN (ANALYZE, BUFFERS)` the new query with a large account's parameters. `auto_explain` with `log_min_duration = 200ms` catches slow plans in production.
5. **Node process.** Event-loop delay (`perf_hooks.monitorEventLoopDelay`) and GC pause metrics; a CPU profile (`--cpu-prof`) on staging with production-sized data. A common culprit: new synchronous work on large payloads (validation, serialization).
6. **Pool.** The `pg` pool's `waitingCount`: did the ORM upgrade change the default pool size or add a query per request? Waiting for a connection shows up as tail latency first.
7. **Bisect.** If still unclear, deploy halves of the 40 commits to a canary, or `git bisect` with a load test on staging with production-sized data.
8. **Fix and guard.** Fix the query or code, confirm p99 under the same load, add a per-endpoint p99 alert and a canary step that compares p99 to the baseline before full rollout.

Typical finding: the ORM upgrade changed eager loading, and `summary` now loads every task of the project, including years of archived ones, to count them. Small projects don't notice; projects with 50k tasks do, which is exactly the p99.

## Deep dives

**1. Why p99 moved and p50 didn't.** The tail is a subset of requests. Find the attribute that separates slow from fast: project size, cold vs warm cache, a feature flag, one instance. Put such attributes on spans (`tasks.count`), not on metrics (high cardinality), and query the traces by them.

**2. Event-loop blocking vs slow I/O.** Slow I/O shows as long DB or HTTP spans. Blocking shows as gaps, and because one Node process serves many concurrent requests, a 50 ms synchronous task delays every request queued behind it. Under load that usually raises p50 too; a pure p99 shift points more toward data-dependent work on large accounts.

**3. Bisecting 40 commits.** Reading diffs is slow and biased toward the change you already suspect. Bisect with a reproducible load test, or ship risky changes behind flags so they can be switched off one by one. Rejected: guessing and adding a cache. It hides the regression and adds invalidation bugs.

## Traps

- Guessing a fix (add a cache, add instances) before measuring.
- Looking at averages: they hide tail regressions.
- Assuming rollback undoes everything: data, migrations, caches and planner statistics don't roll back.
- Profiling locally with a tiny database.
- Ignoring the connection pool: waiting for a connection looks like slow queries in end-to-end latency.

## Say it (60–90 s)

First I scope it: is it every instance or some, one endpoint or all, and does it start exactly at the deploy marker? p50 flat and p99 up tells me a subset of requests got slow, so I look for what's different about them. I pull the slowest traces from before and after and see where the time goes: a database span, an external call, or a gap between spans, which means CPU work or a blocked event loop. Then the database: I compare pg_stat_statements before and after, because an ORM upgrade often changes the generated SQL, for example eager loading a whole relation. I run EXPLAIN ANALYZE with a large account's parameters. I check the connection pool's waiting count and the event-loop delay and GC metrics. If nothing stands out, I bisect the forty commits with a load test on production-sized data. Here the likely answer is that the summary now loads every task of the project, which only hurts big projects, and that's exactly the p99. I fix it, confirm p99 under the same load, and add a canary step that compares p99 against the baseline before a full rollout. If the SLO were breaching, I'd roll back first and investigate after.

## Follow-ups

**Q:** Then: rollback, and p99 stays at 400 ms. What now?
**A:** The cause is something rollback didn't undo. The migration: the new index slowing writes on `tasks`, stale planner statistics after it (run `ANALYZE`), or bloat. A cache: the deploy changed key names and the hit rate is still recovering. Or a change in the same window: an RDS maintenance or minor-version upgrade, a parameter group change, a customer whose integration started polling hard. Check the change log for everything, not just our deploys.

**Q:** How would you catch this before production?
**A:** A canary with automatic comparison of p99 to the stable fleet, and a performance test on production-sized data for the top endpoints, nightly.

**Q:** What if it's GC?
**A:** Compare heap snapshots, reduce allocation (stream or paginate large results), and check `--max-old-space-size` against the container memory limit.

</details>

## Theory in the notes

- [02-nodejs/03-memory-and-performance.md](../../02-nodejs/03-memory-and-performance.md)
- [02-nodejs/01-event-loop-and-runtime.md](../../02-nodejs/01-event-loop-and-runtime.md)
- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [07-observability-reliability/02-logs-metrics-traces.md](../../07-observability-reliability/02-logs-metrics-traces.md)
