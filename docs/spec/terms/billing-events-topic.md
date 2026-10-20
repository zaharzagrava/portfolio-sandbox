---
id: billing-events-topic
title: billing.events topic
kind: term
status: draft
aliases: [billing.events]
defined_for: J02-seller-to-first-sale
rules_hash: 11397c48d8cf
---
# billing.events topic
## Definition
`billing.events` is the [event topic](event-backbone.md) that carries billing facts to other domains' [consumer](event-consumer.md)s. Every consumer of it must be [idempotent ↗](../sw-external-terms.md#idempotency) and [version-guarded](version-guard.md). [Replaying the topic from the start](event-replay.md) must not change entitlements, plan, rank, revenue, stock or search. If a consumer is down, it must lose no fact: after it resumes, each fact is applied once and its [lag](consumer-lag.md) is visible.

## Example
An operator replays `billing.events` from the beginning. The entitlements consumer sees `billing.invoice_paid` again for a shop it has already upgraded. The consumer discards the duplicate, and the shop's entitlements stay the same (AS-29).

## Known gaps
- The spec does not list which events travel on `billing.events`; that `billing.invoice_paid` and `billing.invoice_payment_failed` travel on it is likely but not stated.
- The spec does not name the consumers of this topic or their [consumer groups](consumer-group.md).
- Not confirmed in the code: the facts give no code excerpt for AS-29 beyond the scenario text.

## Used by
<!-- used-by:start -->
- [consumer-group](consumer-group.md)
- [consumer-lag](consumer-lag.md)
- [entitlement](entitlement.md)
- [entitlements-consumer](entitlements-consumer.md)
- [event-backbone](event-backbone.md)
- [event-consumer](event-consumer.md)
- [event-replay](event-replay.md)
- [version-guard](version-guard.md)
<!-- used-by:end -->
