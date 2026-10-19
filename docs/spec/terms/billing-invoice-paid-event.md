---
id: billing-invoice-paid-event
title: billing.invoice_paid event
kind: term
status: draft
aliases: [billing.invoice_paid]
defined_for: J02-seller-to-first-sale
rules_hash: e3b0c44298fc
---
# billing.invoice_paid event
## Definition
`billing.invoice_paid` is the event [the billing domain](domain.md) uses to announce that an invoice has been paid. In this journey it is the hand-off between billing and entitlements. The [entitlements consumer](entitlements-consumer.md) applies it to lift the shop above the [free tier](free-tier.md). A declined first charge produces [`billing.invoice_payment_failed`](billing-invoice-payment-failed-event.md) instead, and the shop keeps the free tier. Like every consumer, the entitlements consumer is [idempotent ↗](../sw-external-terms.md#idempotency), so replaying this event does not change entitlements or plan.

## Example
In B-08 the owner subscribes with `pm_test_visa`, and the [charge job](charge-job.md) pays the first invoice. The invoice becomes [`PAID`](invoice.md) and entitlements rise above the free tier. In B-10 the entitlements consumer is paused, so the invoice is already `PAID` but entitlements stay on the free tier. They rise only after the consumer resumes and applies the event.

## Known gaps
- The spec does not say what the [event payload](event-payload.md) contains. For example, it does not say whether the event carries the plan, the invoice id or the amount.
- The spec does not say which component appends the event. That it comes from the charge job in the same transaction as the invoice update is inferred from B-08 and the journey's "decisions travel as events" decision.
- The spec does not say directly that this event travels on [`billing.events`](billing-events-topic.md). It only lists `billing.events` among the topics whose replay must not change entitlements or plan.

## Used by
<!-- used-by:start -->
- [charge-job](charge-job.md)
- [domain](domain.md)
- [entitlements-consumer](entitlements-consumer.md)
- [event-payload](event-payload.md)
- [free-tier](free-tier.md)
<!-- used-by:end -->
