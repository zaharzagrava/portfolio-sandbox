---
id: webhook-receiver-allow-list
title: Webhook receiver allow-list
kind: term
status: draft
aliases: [receiver allow-list]
defined_for: J02-seller-to-first-sale
rules_hash: e3b0c44298fc
---
# Webhook receiver allow-list
## Definition
The webhook receiver allow-list is a piece of local-stack configuration that the J02 journey lists among the things it relies on. It sits next to the [local queue configuration](local-queue-configuration.md), the [local provider doubles](local-provider-doubles.md) and the [admin bootstrap](admin-bootstrap.md). Design intent (not stated in the spec): it controls which receiver addresses [webhook deliveries](webhook-redelivery.md) may go to, so the local stack can reach the test receiver `R`.

## Example
J02's configuration contains `infra/docker/elasticmq/elasticmq.conf`, the local provider doubles, the admin bootstrap and the receiver allow-list. The journey test registers `R` as the shop's [webhook endpoint](webhook-endpoint.md) and expects it to receive `[order.paid](order-paid-event.md)`.

## Known gaps
- The spec does not say what the allow-list checks, where it lives, or what happens to a delivery to an address that is not on it.
- Not confirmed in the code: no file for the allow-list is listed, and the facts do not show that `R` is on it.

## Used by
<!-- used-by:start -->
- [admin-bootstrap](admin-bootstrap.md)
- [local-provider-doubles](local-provider-doubles.md)
- [local-queue-configuration](local-queue-configuration.md)
- [webhook-endpoint](webhook-endpoint.md)
- [webhook-redelivery](webhook-redelivery.md)
<!-- used-by:end -->
