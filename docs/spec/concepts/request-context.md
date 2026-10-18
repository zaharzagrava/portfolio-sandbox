---
id: request-context
title: Request context and tracing
kind: concept
status: draft
defined_by: S54
---
# Request context and tracing
## Definition
Request context is one isolated store of values for each HTTP request, consumer message and job run. It holds the request ID, the `shopId` and the trace ID. Capabilities read these values without passing them as arguments. The guarantee: concurrent runs never see each other's values, and the request ID and trace ID follow the work into logs, error bodies and events.

## Rules
- **request-context.C-01** Each HTTP request, consumer message and job run MUST get its own context, and concurrent requests MUST NOT see each other's context values.
- **request-context.C-02** An inbound [`X-Request-Id`](../terms/request-id.md) MUST be kept only when it has 8 to 128 characters of letters, digits, `.`, `_`, `-` and appears once; otherwise a [UUIDv7 ↗](../sw-external-terms.md#uuidv7) replaces it.
- **request-context.C-03** The [request ID](../terms/request-id.md) MUST appear in the response header, the logs, the context and every [error body](../terms/problem-detail.md).
- **request-context.C-04** Once [`shopId`](../terms/identity-headers.md) is set in a context, setting a different value MUST fail as a programmer error.
- **request-context.C-05** Reading the context outside a run MUST return `undefined` and MUST NOT throw.
- **request-context.C-06** An error body MUST include [`traceId`](../terms/trace-id.md) when a trace is active.
- **request-context.C-07** A [consumer span ↗](../sw-external-terms.md#distributed-trace) MUST have the same trace ID as the active span at [`append`](../terms/outbox-append.md) when the event is [relayed](../terms/outbox-relay.md) and consumed.

## How the capabilities use it
- {{cap:S53}} relies on the trace ID surviving from `append` through the relay to the consumer's span (S53.B-20).
- {{cap:S54}} defines the context, resolves the request ID and puts `requestId` and `traceId` into problem+json errors.

## Known gaps
- S03, S48, S49 and S50 list this concept, but no line in their pages links it. Their use of it is not stated.
- The facts give no definition of how the trace ID is created or passed to consumers and jobs. They give no list of the values a context holds beyond the request ID, `shopId` and trace ID.

## Used by
<!-- used-by:start -->
- {{cap:S03}} Shops as tenants: memberships, roles and permissions, invites, per-shop SSO, cells, offboarding
- {{cap:S04}} Staged onboarding questionnaire, KYC document intake, LLM extraction, human review, shop verification
- {{cap:S42}} Seller public API: API keys, scopes, sandbox, date-pinned versions, deprecation headers, batch and bulk stock, request logs, usage metering
- {{cap:S44}} Embeddable storefront widget: site keys bound to origins, per-site framing policy, identity hand-off, kill switch
- {{cap:S48}} BFF composition: product-page aggregate with budgets and partial errors, GraphQL with DataLoaders and limits, session handling
- {{cap:S49}} Distributed job scheduler: SKIP LOCKED leases, retries, cron leader, fairness, tz-aware cron
- {{cap:S50}} Rate limiting: token bucket, sliding window, concurrency limits, fail modes, headers
- {{cap:S53}} Domain events, outbox/CDC → Kafka, idempotent versioned projections, replay, read-your-writes
- {{cap:S54}} Platform toolkit: problem+json errors, request context and transactions, health probes, graceful shutdown, load shedding, resilient HTTP
- {{cap:S55}} Lambda workers: partial batch failure, idempotent effects, manifest, dead letters, local runner, bundles
- {{cap:W06}} Admin feature-flag console (guard and shell, flag list, create, editor with targeting and rollout, kill switch, restore, archive, audit trail, stale report)
<!-- used-by:end -->
