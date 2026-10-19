---
id: billing-invoice-payment-failed-event
title: billing.invoice_payment_failed event
kind: term
status: draft
aliases: [billing.invoice_payment_failed]
defined_for: J02-seller-to-first-sale
rules_hash: 171462b69da7
---
# billing.invoice_payment_failed event
## Definition
`billing.invoice_payment_failed` is the billing event appended when a charge for an invoice is declined. For the first charge of a subscription, it goes with keeping the shop on the [free tier](free-tier.md): no [paid entitlements](entitlement.md) are granted. Like other decisions in this journey, it is [appended in the transaction](outbox-append.md) that records the decision, so a crash cannot lose it. It must not carry a [payment method reference](payment-method-token.md).

## Example
The owner subscribes with `pm_test_declined`. The charge job's first charge is declined, the invoice stays unpaid, and `billing.invoice_payment_failed` is appended (AS-14).

## Known gaps
- The spec does not give the event's payload members.
- The spec does not say which topic carries this event; [`billing.events`](billing-events-topic.md) is likely but not stated.
- Not confirmed in the code: no test proves that this event carries no payment method reference (R-20 has `[proof: none]`).

## Used by
<!-- used-by:start -->
- [invoice](invoice.md)
<!-- used-by:end -->
