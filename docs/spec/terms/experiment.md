---
id: experiment
title: Experiment
kind: term
status: draft
aliases: [experiments]
defined_for: J05-engagement-loop
rules_hash: 8615a59c511a
---
# Experiment
## Definition
An experiment is an [A/B test ↗](../sw-external-terms.md#ab-test) owned by the analytics events and experiments capability (S39). It records which [variant](experiment-variant.md) each buyer was [exposed](experiment-exposure.md) to and counts purchases as [conversions](conversion.md) per variant. Purchases reach it from [`order.paid`](order-paid-event.md) on [`orders.events`](orders-events-topic.md) through the [consumer group](consumer-group.md) `experimentation-purchases`. A signed-in purchase counts only after that buyer's exposure, and at most once. Replaying events must leave its per-variant counts unchanged.

## Example
Buyer B, signed in, is exposed to an experiment on the product page for P, then buys P. When `order.paid` arrives, the `experimentation-purchases` consumer records one conversion for B's variant. A duplicate `order.paid` or a replay of `orders.events` adds nothing.

## Known gaps
- The spec does not say how an experiment is defined, started or stopped, or which surfaces it tests.
- The spec does not say whether a refund (`order.refunded`) reverses an experiment conversion. Only share-link conversions are stated to reverse.
- Not confirmed in the code: the detail of AS-32 (replay) and AS-33 (anonymous exposure) is only partly given in the facts.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
