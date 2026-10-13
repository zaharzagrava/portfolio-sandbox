---
id: realtime-policy-unavailable
title: realtime_policy_unavailable (503)
kind: term
status: draft
aliases: [realtime_policy_unavailable]
defined_for: S51-realtime-push
rules_hash: e3b0c44298fc
---
# realtime_policy_unavailable (503)
## Definition
`realtime_policy_unavailable` is the [problem+json ↗](../sw-external-terms.md#problem-json) refusal the [stream endpoint](stream-connection.md) returns with status `503` when a [topic access rule](realtime-topic-access-rule.md) cannot give an answer. This happens when the rule throws or runs past the [rule time limit](realtime-topic-access-rule.md). [Admission is all-or-nothing](connection-admission.md), so the whole connection is refused and nothing is subscribed. Design intent (not stated in the spec): [the hub fails closed ↗](../sw-external-terms.md#fail-open-fail-closed), because a broken rule must never grant access.

## Example
A shop's rule for `shop:X:*` calls a dependency that hangs. The client gets:
```
HTTP/1.1 503
Content-Type: application/problem+json

{ "code": "realtime_policy_unavailable", ... }
```
(Body members other than the code are illustrative.)

## Known gaps
- The spec does not say whether this response carries a `Retry-After` header.
- The spec does not say whether the rule is cancelled when it times out or left to run in the background.

## Used by
<!-- used-by:start -->
- [connection-admission](connection-admission.md)
- [realtime-topic-access-rule](realtime-topic-access-rule.md)
- [stream-connection](stream-connection.md)
<!-- used-by:end -->
