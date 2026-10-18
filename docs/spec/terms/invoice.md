---
id: invoice
title: Invoice
kind: term
status: draft
aliases: []
defined_for: J02-seller-to-first-sale
rules_hash: e3b0c44298fc
---
# Invoice
## Definition
An invoice is the billing record of an amount a shop owes for its plan. The first invoice is created when the owner subscribes, in the [same transaction ↗](../sw-external-terms.md#database-transaction) as the subscription and [the charge job](charge-job.md). The subscribe request makes no provider call; the charge job charges later and marks the invoice paid if the charge succeeds. A declined first charge leaves the invoice unpaid, appends [billing.invoice_payment_failed](billing-invoice-payment-failed-event.md), and the shop keeps [the free tier](free-tier.md). A `PAID` invoice does not grant [paid entitlements](entitlement.md) by itself; [the entitlements consumer](entitlements-consumer.md) does that once it applies the payment.

## Example
The owner subscribes with `pm_test_declined`. The charge job's first charge is declined, so the invoice stays unpaid, `billing.invoice_payment_failed` is appended, and the shop keeps the free tier (AS-14). With `pm_test_visa`, the charge job pays the invoice instead (AS-12).

## Known gaps
- The spec does not list the invoice statuses other than `PAID`. It also does not name the status of an unpaid invoice.
- The spec does not say whether a declined charge is retried, or what happens to the subscription after a decline.
- The spec does not give invoice amounts, currency, or any invoice fields, so nothing beyond paid or unpaid should be relied on.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
