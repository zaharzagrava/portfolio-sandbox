---
id: shop-webhook
title: Shop webhook
kind: term
status: draft
aliases: [webhook]
defined_for: J02-seller-to-first-sale
rules_hash: a41c827c0522
---
# Shop webhook
## Definition
A shop webhook is an HTTP call from the platform to an [endpoint](webhook-endpoint.md) that the shop owner registered. It tells the shop's own systems about events such as [`product.created`](product-created-event.md) and [`order.paid`](order-paid-event.md). When the owner creates the endpoint, the [webhook secret](webhook-secret.md) is shown once and is never returned by later reads. If delivery fails, a [retry job](job-retries.md) delivers the event later without a duplicate effect. A cancelled, declined or expired order never creates a webhook.

## Example
In AS-27 the receiver `R` answers `500` to the first `order.paid` attempt. The retry job delivers the event later, and the shop sees only one effect. In AS-28 the webhook router is paused, so `R` gets nothing until the router resumes and then gets exactly one `order.paid`.

## Known gaps
- The spec does not list every event type that is sent as a webhook, nor the retry schedule or the attempt limit.
- The spec does not name the route for creating a webhook endpoint.
- The spec does not prove that webhook bodies carry no document content, payment references or secrets: R-20 has `[proof: none]`.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): R-18
- [job-retries](job-retries.md)
- [webhook-endpoint](webhook-endpoint.md)
- [webhook-secret](webhook-secret.md)
<!-- used-by:end -->
