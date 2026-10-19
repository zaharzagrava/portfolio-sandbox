---
id: webhook-signature-signing
title: Webhook signing
kind: term
status: draft
aliases: [signed]
defined_for: J02-seller-to-first-sale
rules_hash: b4cc13f31da2
---
# Webhook signing
## Definition
Webhook signing means every [`order.paid` event](order-paid-event.md) sent to a shop's [endpoint](webhook-endpoint.md) carries a signature. The receiver can then check that the event came from the platform and was not changed in transit. Design intent (not stated in the spec): the signature is computed from the shop's [webhook secret](webhook-secret.md), so only the platform and the shop can produce it. The secret itself never appears in webhook bodies.

## Example
In AS-25 a buyer pays for the shop's product. The receiver `R` gets one signed `order.paid` event that holds only that shop's [lines](delivery-line.md).

## Known gaps
- The spec does not say which [signing algorithm ↗](../sw-external-terms.md#message-authentication-code) is used, which header carries the signature, or how the receiver verifies it.
- Not confirmed in the code: that the signature uses the webhook secret created with the endpoint. No test in this journey checks signature verification.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
