# arch-38. Trace one payment across services

*Observability · Easy*

## The question

"A tenant payment goes: web app → API → payments service → PSP call → PSP webhook (minutes to days later) → ledger → payout service, with SQS between services. Support asks 'where is payment pay_123?', and on-call asks 'is rent collection healthy right now?'. How do you instrument this so both get answers, and what do you alert on?"

**Then:** "The tracing bill tripled, and someone proposes sampling 1% of traces. What breaks?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Current tooling? → assume: Node services on ECS, OpenTelemetry SDK, an OTel-compatible backend, CloudWatch for AWS metrics.
- Async hops? → assume: SQS between services, transactional outbox in each service.
- Who is on call? → assume: a small team; pages must be rare and actionable.
- Personal data in telemetry? → assume: forbidden. No names, emails or bank numbers in logs, spans or metric labels.
- Retention? → assume: logs ~30 days hot; the payment history itself lives in the database, not in logs.

## Design

**1. Support's question is answered by the database, not by telemetry.** A `payment_events` table records every state transition (`created → processing → succeeded → paid_out`) with time, actor and provider reference. The admin shows it as a timeline. Logs and traces expire and are sampled; the payment record must not be.

**2. Traces for "where did the time go".**
- OpenTelemetry auto-instrumentation for `http`, `pg`, `aws-sdk`.
- W3C `traceparent` propagates over HTTP automatically; over SQS it goes in message attributes.
- The outbox row stores the `traceparent` of the transaction that wrote it, so the relay continues the same trace.
- The PSP webhook arrives later with no trace context. It starts a new trace; we add `payment.id` as an attribute and a span link to the original trace when we have its context stored.

**3. Logs.** Structured JSON (pino) with `trace_id`, `span_id`, `payment_id`, `service`. A redaction list for known sensitive fields. Error logs always kept; success logs at info, sampled if volume demands.

**4. Metrics (low-cardinality labels only: provider, method, status).**
- RED per endpoint: rate, errors, duration.
- Business: payments created/succeeded/failed per provider and method; PSP latency and error rate.
- Pipeline health: SQS `ApproximateAgeOfOldestMessage`, DLQ depth, webhook lag (`received_at - event created_at`), payments in `processing` older than their expected window (card: minutes; bank debit: business days).
- Reconciliation mismatches from the daily job.

**5. Alerts.**
| Page | Ticket |
|---|---|
| Checkout success SLO burning fast (multi-window burn rate) | CPU, memory, disk |
| Payments stuck in `processing` beyond the window, count > 0 | single 5xx spikes |
| Payments DLQ depth > 0 | slow queries |
| No PSP webhooks for 15 min while payments are processing | reconciliation diff (next business day) |

## Deep dives

**1. Keeping one trace across async hops.** HTTP propagation is automatic; queues and the outbox are not. Chosen: store `traceparent` in the outbox row and in SQS message attributes, and have the consumer start its span as a child of it. The PSP webhook can't carry our context, so we join on `payment.id` and a span link. Rejected: a custom correlation header only: it works for logs but the tracing backend can't build the tree from it.

**2. Symptoms, not causes.** "Payment success rate dropped" catches a PSP outage, a bad deploy, an expired credential and a bug. "CPU 90%" catches none of them reliably and pages people for nothing. Alert on SLO burn rate with two windows (e.g. the Google SRE Workbook pairing: 1 h window at 14.4x burn, confirmed by a 5 min window), plus a minimum event count, because at 03:00 one failure out of five is 20%.

**3. Cardinality.** `payment_id` as a metric label creates one time series per payment, and the metrics bill or the backend falls over. IDs go on spans and logs, which are indexed per event; metrics get only bounded labels.

## Traps

- Using logs as the payment audit trail: they're sampled, redacted and expire.
- `payment_id` or `tenant_id` as a metric label: cardinality explosion.
- Paging on CPU and memory instead of user-facing symptoms.
- Losing trace context at the queue: you get disconnected half-traces exactly where the bugs are.
- Logging full PSP request/response bodies: personal and bank data in a system with wide access.
- No alert on *absence* (no webhooks, empty queue that should not be empty): silent failures look like quiet periods.

## Say it (60–90 s)

I'd separate the two questions. "Where is payment 123" is a business question, so it's answered by a payment events table that records every state transition with timestamps, shown as a timeline in the admin. Telemetry is sampled and expires, so it can't be the record. "Is rent collection healthy" is answered by telemetry. I'd use OpenTelemetry in every service: HTTP propagates trace context automatically, and for async hops I store the traceparent in the outbox row and in SQS message attributes, so one payment is one trace from the API to the ledger. The PSP webhook comes later without our context, so I link it by payment ID. Logs are structured JSON with trace ID and payment ID and no personal data. Metrics have low-cardinality labels: rate, errors and latency per endpoint, payment success rate per provider and method, queue age, DLQ depth, webhook lag and payments stuck in processing too long. I page on symptoms: the checkout success SLO burning fast, stuck payments, a payments DLQ that isn't empty, or no webhooks arriving while payments are pending. CPU and disk create tickets, not pages. And payment IDs never go into metric labels.

## Follow-ups

**Q:** Then: 1% sampling, what breaks?
**A:** Head sampling decides before the outcome is known, so the rare failed payment is almost never kept. Use tail-based sampling in the OTel Collector: keep 100% of errors, slow traces and failed payments, ~5% of successes. All spans of a trace must reach the same collector instance (load-balance by trace ID). Support is unaffected because the timeline is in the DB.

**Q:** How do you connect a frontend error to the backend?
**A:** Browser instrumentation sends `traceparent`; at minimum the API returns a `Request-Id` that the error screen shows, so support can search by it.

**Q:** What usually costs most?
**A:** Often logs, not traces. Drop debug in production, sample success logs, keep every error.

</details>

## Theory in the notes

- [07-observability-reliability/02-logs-metrics-traces.md](../../07-observability-reliability/02-logs-metrics-traces.md)
- [07-observability-reliability/01-sli-slo-error-budgets-alerting-runbooks.md](../../07-observability-reliability/01-sli-slo-error-budgets-alerting-runbooks.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
