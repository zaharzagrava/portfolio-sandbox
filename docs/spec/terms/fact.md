---
id: fact
title: Fact
kind: term
status: draft
aliases: [facts]
defined_for: J02-seller-to-first-sale
rules_hash: c0e1dc63979f
---
# Fact
## Definition
A fact is a business decision that has already happened and is recorded as an event, such as a shop being created or an invoice being paid. The deciding [domain](domain.md) [appends the event in the same transaction](outbox-append.md) as its own write, so a crash cannot lose it. [Consumers](event-consumer.md) in other domains apply facts to update their own data. A consumer that is down must lose no fact, and it applies each fact [exactly once](consumer-deduplication-mode.md) after it resumes.

## Example
[`tenancy.shop_created`](shop-created-event.md), [`shop.verified`](shop-verified-event.md), [`billing.invoice_paid`](billing-invoice-paid-event.md) and [`order.paid`](order-paid-event.md) are facts in this journey. In B-10 the [entitlements consumer](entitlements-consumer.md) is paused, so `billing.invoice_paid` waits. Entitlements change only after the consumer resumes.

## Known gaps
- The spec does not define "fact" formally. In this journey it is used as another word for an event appended by the deciding domain.

## Used by
<!-- used-by:start -->
- [J02](../capabilities/J02-seller-to-first-sale.md): R-16
- [consumer-lag](consumer-lag.md)
- [webhook-router](webhook-router.md)
<!-- used-by:end -->
