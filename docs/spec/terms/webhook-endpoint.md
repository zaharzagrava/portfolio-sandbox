---
id: webhook-endpoint
title: Webhook endpoint
kind: term
status: draft
aliases: [endpoint]
defined_for: J02-seller-to-first-sale
rules_hash: f2a82cfe8d03
---
# Webhook endpoint
## Definition
A webhook endpoint is a URL that a shop owner registers so the shop's own systems receive events such as `product.created` and `order.paid`. When the owner creates it, the [webhook secret](webhook-secret.md) is shown once. Later reads never return the secret. A [webhook router](webhook-router.md) delivers events to the endpoint, and a [retry job](webhook-retry-job.md) re-sends failed deliveries [without a duplicate effect ↗](../sw-external-terms.md#idempotency). Webhook bodies must never carry document content, [payment method references](payment-method-token.md) or webhook secrets.

## Example
The owner creates an endpoint pointing at the test receiver `R`, and the secret appears only in that response. Later the buyer pays an order and `R` answers `500`. The first attempt fails, and the retry job then delivers one `order.paid`.

## Known gaps
- The spec does not name the route for creating or reading a webhook endpoint.
- The spec does not say how deliveries are signed, nor the retry count or backoff of the retry job.
- The spec does not say what the [receiver allow-list](webhook-receiver-allow-list.md) in the local configuration checks. It is listed only as configuration.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): B-11, B-14
- [payment-method-token](payment-method-token.md)
- [shop-webhook](shop-webhook.md)
- [webhook-receiver-allow-list](webhook-receiver-allow-list.md)
- [webhook-retry-job](webhook-retry-job.md)
- [webhook-router](webhook-router.md)
- [webhook-secret](webhook-secret.md)
- [webhook-signature-signing](webhook-signature-signing.md)
<!-- used-by:end -->
