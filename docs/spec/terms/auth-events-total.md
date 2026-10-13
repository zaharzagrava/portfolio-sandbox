---
id: auth-events-total
title: auth_events_total
kind: term
status: draft
aliases: []
defined_for: S01-auth-sessions
rules_hash: e3b0c44298fc
---
# auth_events_total
## Definition
`auth_events_total` is a [metric ↗](../sw-external-terms.md#metrics) that counts S01 [security events](security-events.md). These events include login failures, session creation, revocation, [refresh-token reuse](refresh-token-rotation.md), [key rotation](signing-key.md), reset request and completion, and duplicate registration. Each event increases the counter once and also writes one [audit log line](audit-log.md). The [labels ↗](../sw-external-terms.md#metric-labels) are limited to `endpoint`, `result` and `reason`. Keeping labels bounded stops the metric from growing without limit, which is design intent (not stated in the spec).

## Example
A failed login on `POST /auth/login` increases the counter once:
```
auth_events_total{endpoint="login", result="failure", reason="invalid_credentials"}
```
(The label values are illustrative.)

## Known gaps
- The spec does not list the allowed values for `endpoint`, `result` or `reason`.
- The spec does not say how each event in the list maps to label values, for example refresh reuse versus revocation.

## Used by
<!-- used-by:start -->
- [audit-log](audit-log.md)
- [refresh-token-rotation](refresh-token-rotation.md)
- [security-events](security-events.md)
- [signing-key](signing-key.md)
<!-- used-by:end -->
