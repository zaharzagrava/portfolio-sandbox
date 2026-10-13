---
id: health-check-up
title: health_check_up
kind: term
status: draft
aliases: [gauge]
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# health_check_up
## Definition
`health_check_up` is a [gauge metric ↗](../sw-external-terms.md#gauge-metric) with one series for each [health check](health-probes.md), and it shows whether that check is currently up. [Probe response bodies](health-probes.md) list only check names with `up` or `down`, so the [error details are not exposed to callers](error-text-not-exposed.md). The error text goes to the logs, and the up/down state goes to this gauge. [Operators](operator.md) use the gauge to see which check is failing without having to call the probe.

## Example
```
GET /health/ready  →  200
{ "checks": { "database": "down", "cache": "down" } }   // shape illustrative
```
The reason the database failed appears in the log line, and `health_check_up` for that check shows it as down.

## Known gaps
- The spec does not say which labels the gauge has (for example check name or probe) or which numeric values stand for up and down.

## Used by
<!-- used-by:start -->
- [error-text-not-exposed](error-text-not-exposed.md)
- [health-controller](health-controller.md)
- [health-probes](health-probes.md)
- [operator](operator.md)
<!-- used-by:end -->
