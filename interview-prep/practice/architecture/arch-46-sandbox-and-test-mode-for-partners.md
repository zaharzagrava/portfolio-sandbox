# arch-46. Sandbox and test mode for partners

*Integrations · Medium*

## The question

"About 200 partners (PMS vendors and property managers) want to build against our API without moving real money or touching real tenants. They need test payments that succeed, fail, or get returned days later, leases that exist in a PMS, and our webhooks. Design the sandbox."

**Then:** "A partner says: 'your sandbox behaved differently from production and we shipped a bug.' How do you keep them in sync?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Same API surface and versions as production? → assume: yes, same code and version pinning.
- Do partners need a PMS behind the sandbox? → assume: yes; property managers need leases and tenants to exist, so we provide a simulated PMS.
- Any production data in sandbox? → assume: never (personal and financial data).
- SLA? → assume: best effort, lower rate limits, maintenance allowed.
- Time-based flows (autopay on the 1st, a bank return 4 days later)? → assume: must be testable in minutes, not days.
- Do partners test our *inbound* webhook handling from their PMS? → assume: yes, for PMS vendors.

## Design

**Decision: a separate deployment of the same code**, in a separate AWS account, with its own Postgres, secrets and queues. Base URL `sandbox.api.example.com`; credentials `rpk_test_...` exist only in the sandbox identity store, so a test key can't work against production by construction. Deployed by the same pipeline from the same commit.

**What differs is only the adapters behind the ports:**
1. **Cards**: the PSP's own test mode (test API keys, documented test card numbers for decline, 3DS, dispute).
2. **Bank debits**: a `SimulatedBankRail` adapter, because real debit rails have no general test mode. Behaviour driven by documented magic values:
   | Input | Result |
   |---|---|
   | account `000123456` | settles after 2 simulated business days |
   | account `000000001` | returned "insufficient funds" 2 business days after settlement |
   | account `000000002` | returned "account closed" |
   | amount ending in `.13` | stays `processing` until advanced |
3. **PMS**: a `SimulatorConnector` implementing the same PMS port as real adapters. Partners seed properties, units, leases and tenants via sandbox-only endpoints or fixtures; changes emit events through the normal ingestion pipeline.
4. **Simulated time**: test clocks. `POST /v1/test_clocks { frozenTime }`, attach leases to it, `POST /v1/test_clocks/:id/advance { to }`. The scheduler and settlement simulator read time from the clock of the object they process, so "run the 1st of the month" and "return 4 days later" take seconds.
5. **Webhooks**: the same delivery system sends sandbox events; `POST /v1/test_helpers/events { type, objectId }` fires a specific one on demand.

**Guards:** lower rate limits and object caps per partner; sandbox notifications don't reach real phones or inboxes (captured in a viewer); data purged after 90 days of inactivity; "reset my sandbox" endpoint.

## Deep dives

**1. Separate deployment vs a `livemode` flag in the shared database.** A flag is cheaper (one stack), and some large payment companies do it with heavy tooling. The risk: one query missing `AND livemode = true` leaks test data into production views, or a partner's sandbox load test hits the production database. Chosen: physical separation; the cost is running a second stack, which IaC and one pipeline make routine. Rejected: using our internal staging as the sandbox. We break staging mid-day by design, and partners need stable data.

**2. Time as a dependency.** Autopay, late fees and return windows all read the clock. If domain code calls `new Date()` directly, test clocks are impossible. Inject a `Clock` per operation (resolved from the object's test clock in sandbox, system time in production). The same seam makes our own tests deterministic.

**3. Simulators must behave like the real thing.** A simulator that always succeeds teaches partners nothing. The simulated rail and PMS connector run the **same adapter contract test suite** as the real ones (states, error shapes, idempotency, timing rules), so documented behaviour is enforced in CI.

## Traps

- Using internal staging as the partner sandbox.
- Copying production data into the sandbox, even "anonymized" without review.
- A `livemode` flag with nothing physically preventing cross-mode access.
- A sandbox where every payment succeeds instantly: partners never build return or failure handling.
- No way to test time-based flows short of waiting for real days.
- Test credentials that are accepted by production endpoints.

## Say it (60–90 s)

I'd run the sandbox as a separate deployment of exactly the same code, in its own AWS account with its own database and secrets, deployed by the same pipeline from the same commit. Test credentials only exist there, so they can't touch production. The only differences are adapters behind our ports. Cards use the PSP's own test mode. Bank debits use a simulated rail, because real debit rails have no test mode, driven by documented magic account numbers: one settles, one returns for insufficient funds after two business days, one returns as account closed. The PMS is a simulator connector implementing the same port as real PMS adapters, so partners can create leases and tenants and the normal ingestion pipeline runs. Time-based flows use test clocks: a partner attaches leases to a clock and advances it, and the scheduler and settlement simulator read time from that clock, so a month of autopay and a late return take seconds. Webhooks go through our real delivery system, and there's an endpoint to fire a specific event. Sandbox has lower limits, notifications go to a viewer instead of real phones, and inactive data is purged.

## Follow-ups

**Q:** Then: "sandbox differed from production". How do you prevent drift?
**A:** Same commit deployed to both, sandbox first or together. Simulators pass the same contract test suite as the real adapters. Publish the list of known differences. Turn each reported difference into a simulator scenario and a contract test. Note that PSP test modes themselves differ from live (lower rate limits, mocked latency), so tell partners not to load test against the sandbox.

**Q:** How does a partner go live?
**A:** Change base URL and credentials. Same API version, same webhooks. Nothing created in sandbox is copied to production.

**Q:** How do PMS vendors test sending webhooks to us?
**A:** Their sandbox points at our sandbox ingestion endpoint with sandbox signing secrets; we show received events and processing results in the partner dashboard.

</details>

## Theory in the notes

- [10-system-design/11-application-architecture.md](../../10-system-design/11-application-architecture.md)
- [08-devops-cloud/04-testing-strategy.md](../../08-devops-cloud/04-testing-strategy.md)
- [08-devops-cloud/02-docker-ci-cd-gitops.md](../../08-devops-cloud/02-docker-ci-cd-gitops.md)
- [04-api-design/02-api-versioning-and-deprecation.md](../../04-api-design/02-api-versioning-and-deprecation.md)
