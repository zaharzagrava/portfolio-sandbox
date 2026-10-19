---
id: consumer-lag
title: Consumer lag
kind: term
status: draft
aliases: [lag]
defined_for: J02-seller-to-first-sale
rules_hash: 75c56aa976b5
---
# Consumer lag
## Definition
Consumer lag is how far an [event consumer](event-consumer.md) is behind the events published on its topic. It counts the [facts](fact.md) the consumer has not yet applied. While a consumer is [paused](partition-pause.md) or down, its lag grows and stays visible. After the consumer resumes, it applies every waiting fact once and the lag falls again.

## Example
In AS-05 the [identity promotion consumer](identity-promotion-consumer.md) is paused and a shop is created. The owner's role stays `USER`, and the consumer's lag shows at least 1 until the consumer resumes and applies [`tenancy.shop_created`](shop-created-event.md).

## Known gaps
- The spec does not say where lag is shown, for example which [metric ↗](../sw-external-terms.md#metrics), dashboard or endpoint.
- The spec does not say whether lag is counted in events or in time. The metrics story (AS-32) is P3 and states no rule.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): R-16
- [billing-events-topic](billing-events-topic.md)
- [entitlements-consumer](entitlements-consumer.md)
- [identity-promotion-consumer](identity-promotion-consumer.md)
- [webhook-router](webhook-router.md)
<!-- used-by:end -->
