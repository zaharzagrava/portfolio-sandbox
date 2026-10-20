---
id: local-provider-doubles
title: Local provider doubles
kind: term
status: draft
aliases: [provider doubles]
defined_for: J02-seller-to-first-sale
rules_hash: c1f659702cb6
---
# Local provider doubles
## Definition
Local provider doubles are stand-ins for external providers that the J02 [journey](main-journeys.md) runs against on the local stack. The journey lists them as part of its configuration, next to the local queue configuration and the [admin bootstrap](admin-bootstrap.md). They let the journey drive outcomes such as a paid or a declined first charge without calling a real provider.

## Example
In [J02 AS-12](acceptance-scenario.md), the owner subscribes with `pm_test_visa`, and the [charge job](charge-job.md) pays the invoice. In J02 AS-14, `pm_test_declined` leaves the invoice unpaid, and [`billing.invoice_payment_failed`](billing-invoice-payment-failed-event.md) is appended.

## Known gaps
- The spec does not say which providers have doubles. Payment is implied by the test payment methods. The spec does not say whether the document extractor or e-mail have doubles.
- Not confirmed in the code: no file for the doubles is listed. The facts also do not show that `pm_test_visa` and `pm_test_declined` are the values the payment double recognises.
- The spec does not say how a double is configured to fail. For example, it does not say how the receiver returns `500` in AS-27.

## Used by
<!-- used-by:start -->
- [acceptance-scenario](acceptance-scenario.md)
- [admin-bootstrap](admin-bootstrap.md)
- [charge-job](charge-job.md)
- [local-queue-configuration](local-queue-configuration.md)
- [main-journeys](main-journeys.md)
- [webhook-receiver-allow-list](webhook-receiver-allow-list.md)
<!-- used-by:end -->
