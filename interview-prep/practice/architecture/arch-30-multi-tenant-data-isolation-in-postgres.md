# arch-30. Multi-tenant data isolation in Postgres

*Security · Medium*

## The question

Our customers are property-management companies: 3,000 of them, from 10 to 80,000 units each. All data is in one Postgres database with an `org_id` column, and last month a missing WHERE clause showed one company's residents to another. How do you make cross-company leaks structurally impossible? Compare row-level security, schema per customer and database per customer.

**Then:** Your biggest customer demands their data in a separate database, and support staff need to search across all companies.

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Naming: "tenant" means two things here. → assume: SaaS tenant = **org** (the PM company); renters = **residents**. Say it out loud to avoid confusion.
- Growth? → assume: 3,000 → 10,000 orgs in 2 years.
- Contracts requiring physical separation or a region? → assume: a handful of enterprise customers, possibly EU residency later.
- Cross-org queries? → assume: yes: our ops tooling, billing, analytics.
- Pooling? → assume: RDS Proxy or PgBouncer in transaction mode.
- Background workers touch many orgs? → assume: yes; they must set org context per job.

## Design

1. **Keep the shared tables; add RLS as the guard.** App code still filters by `org_id` (clearer, and the planner uses the index); RLS catches whatever the code forgets.
```sql
ALTER TABLE leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE leases FORCE ROW LEVEL SECURITY;      -- the table owner is not exempt
CREATE POLICY org_isolation ON leases
  USING      (org_id = (SELECT current_setting('app.org_id', true))::uuid)
  WITH CHECK (org_id = (SELECT current_setting('app.org_id', true))::uuid);
```
2. **Connection role.** The app connects as `app_user`: not owner, not superuser, no `BYPASSRLS`.
3. **Per-request context.** Each request runs in a transaction that starts with `SELECT set_config('app.org_id', $1, true)`. The `true` makes it transaction-local, so it can't leak to the next client on a pooled connection. If unset, `current_setting(..., true)` is NULL and the policy returns zero rows: fail closed.
4. **One entry point.** Auth middleware resolves the org into AsyncLocalStorage; `withOrg(tx => ...)` is the only way to get a DB handle; a lint rule bans the raw pool.
5. **Composite keys.** Indexes lead with `org_id` (`(org_id, status, due_date)`). Foreign keys include it: `FOREIGN KEY (org_id, lease_id) REFERENCES leases (org_id, id)`, so a row can't point at another org's row.
6. **Cross-org access.** A separate `ops_reader` role with `BYPASSRLS`, used only by the admin service, every query audited.
7. **Tests.** A CI check that every table with `org_id` has RLS enabled and forced (`pg_class.relrowsecurity`, `relforcerowsecurity`), plus a test that org A's context never returns org B's rows.
8. **Silo option.** `orgs(id, db_cluster)` catalog; a connection router picks the pool per org. Same schema and migrations everywhere; RLS stays on in silos too.

## Deep dives

**1. RLS gotchas.**
Problem: RLS is silently skipped in several cases.
Approach: know them: superusers and `BYPASSRLS` roles skip it; the table owner skips it unless `FORCE`; views run with the view owner's rights unless created with `security_invoker = true` (Postgres 15+); `SECURITY DEFINER` functions run as their owner. Wrap `current_setting` in a sub-select so it's evaluated once per query, not per row. Unique constraints are checked across all orgs, so a global `UNIQUE (email)` tells org A that an address exists at org B: scope uniques with `org_id`.

**2. Schema per org.**
Problem: 3,000-10,000 schemas.
Approach: rejected at this count. Every migration runs N times and can fail halfway across schemas; catalog size grows with orgs × tables × indexes, slowing `pg_dump`, autovacuum scheduling and per-connection catalog caches; pooling with per-org `search_path` is error-prone. Reasonable for tens to low hundreds of orgs.

**3. Database per org, and the twist.**
Problem: one customer wants physical separation.
Approach: hybrid. Pooled by default; a silo for orgs that pay for it. Move an org: logical replication of its rows (Postgres 15+ publications support row filters on `org_id`), short write freeze for that org, flip the catalog entry. Support search across all orgs goes to a search index or warehouse fed from every database, not to N live databases.
Rejected: database per org for everyone: thousands of RDS databases or instances, migrations fanned out N times, cross-org reporting needs a warehouse from day one.

## Traps

- **Relying only on ORM default scopes**: one raw query or background job bypasses them.
- **Session-level `SET app.org_id` with a pooler**: the next request on that connection inherits the wrong org.
- **App connecting as the table owner or a superuser**: RLS is silently off.
- **Schema per org for thousands of small orgs.**
- **Global unique constraints** that reveal another org's data.
- **Workers processing many orgs without setting context per job**: with RLS they see nothing; with a bypass role they see everything.

## Say it (60–90 s)

First, to avoid confusion: our SaaS tenant is the property-management company, the org, and residents are their renters. I'd keep shared tables with an org_id and add Postgres row-level security as the safety net, because the bug last month was a forgotten WHERE clause and RLS makes the database enforce it. Every table gets RLS enabled and forced, with a policy comparing org_id to a setting. The app connects as a role that isn't the owner and can't bypass RLS. Each request runs in a transaction that sets the org id with set_config local to the transaction, so it can't leak across pooled connections, and if it's missing the policy returns nothing. Code still filters by org_id for the indexes, and foreign keys include org_id so rows can't reference another org. CI checks that every table has RLS on. I'd reject schema per org at three thousand plus orgs because migrations and the catalog grow with every org. Database per org is the strongest isolation, so I'd offer it only to customers who need it, with a catalog that routes each org to its database. Support's cross-org search goes to a search index or warehouse, through an audited admin service.

## Follow-ups

**Q:** What does RLS cost in performance?
**A:** Usually little for an equality on an indexed `org_id`; the policy is ANDed into the query. Check `EXPLAIN` on hot queries and keep functions in policies cheap and evaluated once.

**Q:** How do background jobs work with RLS?
**A:** Each job carries `org_id` and runs `withOrg` like a request. Cross-org jobs (billing) use a dedicated audited role.

**Q:** And the Mongo data?
**A:** No database-side equivalent, so a repository wrapper that injects `org_id` into every filter, plus tests that fail when a query lacks it.

</details>

## Theory in the notes

- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [03-databases/03-schema-migrations-and-scaling.md](../../03-databases/03-schema-migrations-and-scaling.md)
- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
