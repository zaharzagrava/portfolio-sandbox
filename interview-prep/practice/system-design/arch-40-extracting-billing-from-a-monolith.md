# arch-40. Extracting billing from a monolith

*Migration · Hard*

## The question

"Our clinic management SaaS is a NestJS monolith that owns everything: appointments, patients, clinicians, and billing (invoices, insurance claims, payments, ledger), all in one Postgres. 40 engineers share it, deploys are slow, and every billing change feels risky. The CTO wants billing as a separate service with its own database, with no feature freeze and without losing a cent. How do you do it?"

**Then:** "Halfway through, the operations report needs a join between appointments and invoices, which now live in two databases. What do you do?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Why extract: deploy independence, a separate team, tighter access for audit, or scale? → assume: independence and access control. Scale alone wouldn't justify it.
- What counts as "billing"? → assume: invoices, claims, payments, payment-method tokens and the **ledger** (they must stay in one transaction).
- How many call sites touch billing today? → assume: 20+, including cron jobs, admin endpoints and raw SQL in reports.
- Downtime tolerance? → assume: none for check-out at the front desk; a few seconds of paused billing writes at cutover is fine if requests queue or retry.
- Team? → assume: a billing team of ~6 already exists.
- Same AWS account and VPC? → assume: yes.

## Design

**Phase 0: module boundary inside the monolith (most of the work).**
- A `BillingModule` with one public interface: `BillingApi.createInvoice / getInvoice / listByAppointment / recordPayment / refund`. Every caller uses it.
- A lint rule (dependency-cruiser or Nx boundaries) fails the build if other modules import billing internals or query its tables.
- Remove cross-module joins and foreign keys (`invoices.appointment_id` stays as a plain ID). Where a query joined appointments and invoices, call both APIs or use a read model.
- Billing tables move to a `billing` schema; DB grants make only the module's role able to touch them.
This phase pays off even if extraction stops here.

**Phase 1: new service, same database.** Deploy `billing-service` with the module's code, using the same `billing` schema. In the monolith, `BillingApi` gets a second implementation: an HTTP client. A flag per operation routes calls: reads first, then writes, per clinic cohort. The strangling happens at this interface, not at the load balancer, because most calls are internal function calls.

**Phase 2: move the data.** Create the new database. Postgres logical replication (a publication on the `billing` tables) copies it; lag is seconds. Cutover:
1. Flag: pause billing writes (requests wait or get `503` + `Retry-After`; billing workers stop claiming).
2. Wait for replication lag = 0, compare row counts and per-day checksums.
3. Set sequences above the current max (on Postgres 18 and earlier, logical replication doesn't copy sequence values).
4. Point the service at the new DB, resume. Keep reverse replication to the old schema for a week for rollback.

**Phase 3: everyone else reads through the service or events.** Billing publishes `InvoiceIssued`, `PaymentRecorded`, `ClaimDenied` via its outbox; the monolith keeps local read models it needs (e.g. `patient_balance`). Nobody else connects to the billing DB.

**Phase 4:** drop the old tables after a soak period.

**Throughout:** reconciliation against the PSP, the clearinghouse and ledger balances is the success metric: identical before and after each phase.

## Deep dives

**1. Dual writes.** The tempting path: the monolith keeps writing the old tables and also calls the new service "until we trust it". Every partial failure (one write succeeds, one times out) creates divergence nobody notices until reconciliation. Chosen: exactly one writer at any time; data moves by database replication; the write switch is a single flag flip. For confidence before switching, run the new code in **shadow mode**: it computes results that are compared, but writes nothing.

**2. Data ownership and lost transactions.** Today "complete appointment + create invoice" is one transaction. After the split it's two services. Options: (a) billing asks scheduling synchronously for what it needs at decision time (was the appointment completed?), (b) billing keeps a projection of appointment status fed by events, (c) the multi-step flow becomes a saga with an outbox. Rejected: a database shared by both services: the deployment cost of two services and the coupling of one.

**3. In-flight work at cutover.** Insurance claims stay open for weeks; PSP and clearinghouse callbacks keep arriving. Because the cutover is a moment (not a period with two writers), every callback after it lands in the new service; handlers are idempotent by the provider's event ID, so a callback processed just before and redelivered just after is harmless. The ledger moves *with* billing so "payment recorded + ledger entries" stays one transaction.

## Traps

- A big-bang rewrite of billing as a new service: months without delivery and a cutover nobody can roll back.
- Extracting the service but keeping the shared database: no real ownership; schema changes still need everyone.
- App-level dual writes "for safety": silent divergence.
- Splitting the ledger from payments: balance changes become cross-service and lose atomicity.
- Drawing the network boundary before the module boundary: you discover the hidden coupling in production, as timeouts.
- Forgetting raw SQL in reports and admin scripts that read billing tables directly.

## Say it (60–90 s)

I'd start inside the monolith, not with a new service. First I make billing a real module: one public interface, a lint rule that fails the build if anything else touches its internals or tables, no foreign keys or joins across the boundary, and its tables in their own schema with database grants. That's most of the work, and it's useful even if we stop there. Then I deploy the same module code as a billing service pointing at the same schema, and the monolith's billing interface gets a second implementation, an HTTP client, switched by flags per operation and per clinic cohort, reads first. Then I move the data: logical replication copies the billing tables to a new database. At cutover I pause billing writes for a few seconds, wait for zero lag, compare counts and checksums, fix sequences, switch the connection, and keep reverse replication for a week to roll back. There's only ever one writer, no dual writes. The ledger moves with payments so they keep one transaction. Other modules get billing data through the API or through events from an outbox. I measure success with reconciliation: the ledger, the payment provider and the clearinghouse must agree exactly before and after every phase.

## Follow-ups

**Q:** Then: operations needs an appointments × invoices join. What now?
**A:** Not a cross-database join in application code, and not `postgres_fdw` from one production database into the other (that couples the schemas again and puts reporting load on production). Replicate both databases into a reporting store (a reporting Postgres or a warehouse via CDC) and join there. For an in-app screen, the monolith's read model fed by billing events is enough.

**Q:** How do you know a phase worked?
**A:** Row counts and checksums per day, ledger balances equal, PSP and clearinghouse reconciliation unchanged, error rate and latency per flag, shadow comparison diffs at zero.

**Q:** When would you stop at the modular monolith?
**A:** If the pain was code coupling rather than deploys or access control. The module boundary removes most of the risk; a separate service adds network failure modes and operations work.

</details>

## Theory in the notes

- [10-system-design/11-application-architecture.md](../../10-system-design/11-application-architecture.md)
- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [03-databases/03-schema-migrations-and-scaling.md](../../03-databases/03-schema-migrations-and-scaling.md)
- [08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md](../../08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md)
