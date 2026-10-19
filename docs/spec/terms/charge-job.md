---
id: charge-job
title: Charge job
kind: term
status: draft
aliases: []
defined_for: J02-seller-to-first-sale
rules_hash: 171462b69da7
---
# Charge job
## Definition
The charge job is the [scheduler job](job.md) that charges the shop's payment method for a new plan subscription. Subscribing creates it in the same transaction as the subscription and the first invoice, and the request itself makes no provider call. When the job runs, a successful charge marks the invoice `PAID`. A declined first charge leaves the invoice unpaid, appends [`billing.invoice_payment_failed`](billing-invoice-payment-failed-event.md), and the shop keeps the [free tier](free-tier.md). [Paid entitlements](entitlement.md) are granted only after the first charge succeeds, by the [entitlements consumer](entitlements-consumer.md), not by the job itself.

## Example
A verified shop's owner subscribes with `pm_test_visa`. The charge job pays the invoice, and entitlements rise above the free tier (AS-12).
With `pm_test_declined`, the job's first charge is declined, the invoice stays unpaid and the shop keeps the free tier (AS-14).

## Known gaps
- The spec does not say whether the charge job retries a declined or failed charge, or what happens to the subscription after a decline.
- The spec does not name the charge job's job type or say whether the job appends [`billing.invoice_paid`](billing-invoice-paid-event.md) when the charge succeeds.
- The spec does not say why the charge happens in a job and not in the request. Keeping the subscribe request independent of provider availability is design intent (not stated in the spec).

## Used by
<!-- used-by:start -->
- [billing-invoice-paid-event](billing-invoice-paid-event.md)
- [invoice](invoice.md)
- [local-provider-doubles](local-provider-doubles.md)
<!-- used-by:end -->
