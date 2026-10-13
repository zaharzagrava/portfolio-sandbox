---
id: bounded-label-values
title: Bounded label values
kind: term
status: draft
aliases: [bounded set, unbounded values]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# Bounded label values
## Definition
A [metric label ↗](../sw-external-terms.md#metric-labels) has bounded values when it can only take values from a small, known set. One example is a channel label limited to `email`, `sms` or `push`. The [service contract](service-contract.md) requires every metric label to be bounded in this way. A refactor must not add a label that takes unbounded values, such as a raw e-mail address, a user id or a [delivery id](delivery-id.md). Two reasons apply, both design intent (not stated in the spec). First, each new label value creates another [time series ↗](../sw-external-terms.md#metrics), which raises the cost of the metrics store. Second, the rule keeps [contact data](contact-data.md) out of metrics.

## Example
Good: a label `status` that takes only [timeline statuses](delivery-timeline.md) such as `sent`, `[bounced](delivery-bounced.md)`, `[capped](delivery-capped.md)` or `expired` (S28.R-12).
Not allowed: a label `recipient` = `ana@example.com`. The address is illustrative.

## Known gaps
- The spec does not list the notifications metrics or their labels in the facts available here.
- The spec does not say whether values such as a provider name or a notification type count as bounded.

## Used by
<!-- used-by:start -->
- [contact-data](contact-data.md)
- [delivery-id](delivery-id.md)
- [delivery-timeline](delivery-timeline.md)
- [service-contract](service-contract.md)
<!-- used-by:end -->
