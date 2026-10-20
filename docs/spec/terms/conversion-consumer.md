---
id: conversion-consumer
title: Conversion consumer
kind: term
status: draft
aliases: []
defined_for: J05-engagement-loop
rules_hash: 7aca2c0a5126
---
# Conversion consumer
## Definition
The conversion consumer is the [event consumer](event-consumer.md) that turns attributed orders into [conversions](conversion.md) for the [share-link owner](link-owner.md). It reads [`order.paid`](order-paid-event.md) and [`order.refunded`](order-refunded-event.md) from the [`orders.events` topic](orders-events-topic.md). Each attributed paid order yields a single conversion, even when `order.paid` arrives twice or late. A full refund reverses the conversion, and a declined or cancelled order never creates one. Like every consumer here, it is [idempotent ↗](../sw-external-terms.md#idempotency) and [discards events older than the state it has already applied](order-tolerant.md).

## Example
F buys through B's link and pays, so B has one conversion. The order is then fully refunded. When the conversion consumer processes `order.refunded`, B's conversion shows the reversal (J05 B-14).

## Known gaps
- Not confirmed in the code: that this consumer is the [`marketing-affiliate-conversions` consumer group](consumer-group.md). The journey lists that group, but the facts do not name it as the conversion consumer.
- The spec does not say whether this consumer emits `link.converted`. It only says that event must not expose the buyer's identity.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
