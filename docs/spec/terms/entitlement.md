---
id: entitlement
title: Entitlement
kind: term
status: draft
aliases: [paid entitlements]
defined_for: J02-seller-to-first-sale
rules_hash: cb0bd122065a
---
# Entitlement
## Definition
An entitlement is something a shop is allowed to do or have because of its plan, such as a product limit. A shop starts with [free-tier](free-tier.md) entitlements, and a [consumer](event-consumer.md) raises them to paid entitlements only after the first charge of a subscription succeeds. Entitlements are updated from [billing events](billing-events-topic.md), not by the subscribe request itself, so they can lag behind a paid invoice. [Replaying](event-replay.md) `billing.events` from the start must not change them.

## Example
The owner of a verified shop subscribes with `pm_test_visa`. The charge job pays the invoice, and entitlements rise above the free tier (AS-12). If the entitlements consumer is paused, the invoice is `PAID` but entitlements stay on the free tier until it resumes (AS-15).

## Known gaps
- The spec does not say which domain owns entitlements or which table stores them.
- The spec does not list the entitlement keys or values for each plan; only [`maxProducts`](max-products.md) is named.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): R-11
- [billing-invoice-payment-failed-event](billing-invoice-payment-failed-event.md)
- [charge-job](charge-job.md)
- [invoice](invoice.md)
- [max-products](max-products.md)
<!-- used-by:end -->
