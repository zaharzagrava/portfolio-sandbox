# arch-29. Multi-tenant SaaS: tenant data isolation

*Security · Medium*

## The question

"We sell a helpdesk SaaS to 3,000 companies, from 5 to 20,000 seats each. All their tickets, contacts and attachments are in one Postgres database (a multi-tenant schema) with a `tenant_id` column. Last month a missing WHERE clause in a report export showed one company's support tickets to another. How do you make cross-company leaks structurally impossible? Compare row-level security, schema per customer and database per customer."

**Then:** "Our biggest customer now demands their data in a separate database in the EU, and our support staff still need to search across all companies."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Naming? → assume: **tenant** = one customer company (an org), keyed by `tenant_id`; their end users = **contacts**. Say it out loud so "customer" isn't ambiguous.
- Growth? → assume: 3,000 → 10,000 orgs in 2 years, most of them small.
- Contracts requiring physical separation or a region? → assume: a handful of enterprise customers, EU residency for some.
- Cross-org queries? → assume: yes: our support tooling, billing, analytics.
- Pooling? → assume: RDS Proxy or PgBouncer in transaction mode.
- Background workers touch many orgs? → assume: yes (SLA timers, email ingestion); they must set org context per job.

## Design

1. **Keep shared tables; add RLS as the guard.** App code still filters by `tenant_id` (clearer, and the planner uses the index); RLS catches whatever the code forgets.
```sql
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets FORCE ROW LEVEL SECURITY;      -- the table owner is not exempt
CREATE POLICY tenant_isolation ON tickets
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true))::uuid)
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true))::uuid);
```
2. **Connection role.** The app connects as `app_user`: not owner, not superuser, no `BYPASSRLS`.
3. **Per-request context.** Each request runs in a transaction that starts with `SELECT set_config('app.tenant_id', $1, true)`. The `true` makes it transaction-local, so it can't leak to the next client on a pooled connection. If unset, `current_setting(..., true)` is NULL and the policy returns zero rows: fail closed.
4. **One entry point.** Auth middleware puts the tenant into AsyncLocalStorage; `withTenant(tx => ...)` is the only way to get a DB handle; a lint rule bans the raw pool.
5. **Composite keys.** Indexes lead with `tenant_id` (`(tenant_id, status, updated_at)`). Foreign keys include it: `FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id)`, so a row can't point at another tenant's row.
6. **Cross-org access.** A separate `support_reader` role with `BYPASSRLS`, used only by the admin service, every query audited.
7. **Tests.** A CI check that every table with `tenant_id` has RLS enabled and forced (`pg_class.relrowsecurity`, `relforcerowsecurity`), and a test that tenant A's context never returns tenant B's rows.
8. **Silo option.** A `tenants(id, db_cluster, region)` catalog; a connection router picks the pool per tenant. Same schema and migrations everywhere; RLS stays on in silos too.

## Deep dives

**1. RLS gotchas.**
Problem: RLS is silently skipped in several cases.
Approach: know them. Superusers and `BYPASSRLS` roles skip it; the table owner skips it unless `FORCE`; views run with the view owner's rights unless created with `security_invoker = true` (Postgres 15+); `SECURITY DEFINER` functions run as their owner. Wrap `current_setting` in a sub-select so it's evaluated once per query, not per row. Unique constraints are checked across all orgs, so a global `UNIQUE (email)` on contacts tells org A that an address exists at org B: scope uniques with `tenant_id`.

**2. Schema per tenant.**
Problem: 3,000-10,000 schemas, one per tenant.
Approach: rejected at this count. Every migration runs N times and can fail halfway across schemas; the catalog grows with orgs × tables × indexes, slowing `pg_dump`, autovacuum scheduling and per-connection catalog caches; pooling with a per-org `search_path` is error-prone. Reasonable for tens to low hundreds of orgs.

**3. Database per tenant, and the twist.**
Problem: one customer wants physical separation in the EU.
Approach: hybrid (the pool/silo model). Pooled multi-tenant by default; a single-tenant silo for tenants that pay for it. Moving a tenant: logical replication of its rows (Postgres 15+ publications support row filters, `WHERE (tenant_id = ...)`), a short write freeze for that org, flip the catalog entry. Attachments move to an EU bucket the same way. Support search across all orgs goes to a search index or warehouse fed from every database, never to N live databases; the EU customer's documents live in an EU index if residency covers support tooling too.
Rejected: database per tenant for everyone: thousands of RDS databases, migrations fanned out N times, and cross-org reporting needs a warehouse from day one.

## Traps

- **Relying only on ORM default scopes**: one raw query or background job bypasses them.
- **Session-level `SET app.tenant_id` behind a pooler**: the next request on that connection inherits the wrong org.
- **The app connecting as the table owner or a superuser**: RLS is silently off.
- **Schema per tenant for thousands of small tenants.**
- **Global unique constraints** that reveal another org's data.
- **Workers processing many tenants without setting tenant context per job**: with RLS they see nothing; with a bypass role they see everything.

## Say it (60–90 s)

First, naming: a tenant is one customer company, an org, and their end users are contacts. I'd keep shared multi-tenant tables with a tenant_id and add Postgres row-level security as the safety net, because last month's bug was a forgotten WHERE clause and RLS makes the database enforce it. Every table gets RLS enabled and forced, with a policy comparing tenant_id to a setting. The app connects as a role that isn't the owner and can't bypass RLS. Each request runs in a transaction that sets the tenant id with set_config local to the transaction, so it can't leak across pooled connections, and if it's missing the policy returns nothing. Code still filters by tenant_id for the indexes, and foreign keys include tenant_id so rows can't reference another tenant. CI checks that every table has RLS on. I'd reject schema per tenant at three thousand tenants and growing, because migrations and the catalog grow with every tenant. Database per tenant is the strongest isolation, so I'd offer it as a silo to tenants who need it, with a catalog that routes each tenant to its database and region. Support's cross-tenant search goes to a search index or warehouse, through an audited admin service.

## Follow-ups

**Q:** What does RLS cost in performance?
**A:** Usually little for an equality on an indexed `tenant_id`; the policy is ANDed into the query. Check `EXPLAIN` on hot queries, keep policy functions cheap and evaluated once per query.

**Q:** How do background jobs work with RLS?
**A:** Each job carries `tenant_id` and runs inside `withTenant` the same way a request does. Truly cross-tenant jobs (billing) use a dedicated, audited role.

**Q:** What about S3 attachments and Redis caches?
**A:** No database policy protects them. S3 keys start with `tenant/{tenant_id}/` and downloads go through an API that checks the tenant before issuing a short presigned URL; Redis keys include `tenant_id`, enforced by one cache helper, with a test that fails on keys without it.

</details>

## Theory in the notes

- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [03-databases/03-schema-migrations-and-scaling.md](../../03-databases/03-schema-migrations-and-scaling.md)
- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [10-system-design/09-data-and-infrastructure.md](../../10-system-design/09-data-and-infrastructure.md)
