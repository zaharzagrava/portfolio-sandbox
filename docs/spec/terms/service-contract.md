---
id: service-contract
title: Service contract
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: fdc0f5b0dfa0
---
# Service contract
## Definition
The service contract is the part of a [capability's specification](capability.md) that lists its observable promises to operators. One of these is the set of [metrics ↗](../sw-external-terms.md#metrics) it emits. Each listed metric must exist under its fixed name, with [labels ↗](../sw-external-terms.md#metric-labels) drawn from a bounded set. Dashboards and alerts can then rely on those names not changing. Logs that go with it must be [structured](structured-logs.md) and must carry no [contact data](contact-data.md), token or message body.

## Example
An on-call engineer builds an alert on a notifications metric named in the service contract. A later refactor may not rename that metric or add a label that [takes unbounded values](bounded-label-values.md), such as a raw e-mail address. Labels such as `channel` = `email` / `sms` / `push` are illustrative.

## Known gaps
- The spec does not list the notifications metrics or their labels in the facts available here.
- The spec does not say what else the service contract contains beyond metrics and logging.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-54
- [bounded-label-values](bounded-label-values.md)
- [capability](capability.md)
- [contact-data](contact-data.md)
- [structured-logs](structured-logs.md)
- [user-hash](user-hash.md)
<!-- used-by:end -->
