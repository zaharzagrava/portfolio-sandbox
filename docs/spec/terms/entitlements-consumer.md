---
id: entitlements-consumer
title: Entitlements consumer
kind: term
status: draft
aliases: []
defined_for: J02-seller-to-first-sale
rules_hash: 4e03a4e40d6b
---
# Entitlements consumer
## Definition
The entitlements consumer is the [event consumer](event-consumer.md) that turns a paid plan into higher entitlements for a shop. It reads billing facts from the [billing.events](billing-events-topic.md) topic and raises the shop above the free tier only after the first charge succeeds. Billing marks the invoice paid on its own; entitlements change only when this consumer applies the fact. Like every consumer here, it is [idempotent ↗](../sw-external-terms.md#idempotency): replaying billing.events from the start must not change entitlements or plan. If it is down, it loses no fact, its [consumer lag](consumer-lag.md) is visible, and it applies each fact once after it resumes.

## Example
The entitlements consumer is paused. A verified shop subscribes with `pm_test_visa` and the charge job pays the invoice. The invoice shows `PAID`, but the shop stays on the free tier. When the consumer resumes, the shop's entitlements rise above the free tier (AS-15).

## Known gaps
- Not confirmed in the code: which event the consumer reacts to. The journal lists `billing.invoice_paid` among the events it reads, but no rule ties that event to this consumer.
- The spec does not say which domain owns the entitlements consumer or where entitlements are stored.
- The spec does not say how a declined first charge reaches this consumer, or whether the consumer reacts to it at all. The only stated outcome is that the shop keeps the free tier.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
