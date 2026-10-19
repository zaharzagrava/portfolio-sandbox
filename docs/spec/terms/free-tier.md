---
id: free-tier
title: Free tier
kind: term
status: draft
aliases: []
defined_for: J02-seller-to-first-sale
rules_hash: c9542b185793
---
# Free tier
## Definition
The free tier is the set of entitlements a shop has before it has a successfully paid plan. A shop keeps the free tier when its first charge is declined, and while the [entitlements consumer](entitlements-consumer.md) has not yet applied a payment. Its limits are enforced when the shop acts. For example, [`maxProducts`](max-products.md) caps product creation and answers [`409 plan_limit_reached`](plan-limit.md) when exceeded.

## Example
The owner subscribes with `pm_test_declined`. The first charge is declined, [the invoice stays unpaid](invoice.md), [`billing.invoice_payment_failed`](billing-invoice-payment-failed-event.md) is appended, and the shop keeps the free tier (AS-14).

## Known gaps
- The spec does not give the free-tier values, including the value of `maxProducts`.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): R-11
- [billing-invoice-paid-event](billing-invoice-paid-event.md)
- [billing-invoice-payment-failed-event](billing-invoice-payment-failed-event.md)
- [charge-job](charge-job.md)
- [entitlement](entitlement.md)
- [entitlements-consumer](entitlements-consumer.md)
- [invoice](invoice.md)
- [max-products](max-products.md)
<!-- used-by:end -->
