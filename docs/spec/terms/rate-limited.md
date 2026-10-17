---
id: rate-limited
title: rate_limited (429)
kind: term
status: draft
aliases: [rate_limited]
defined_for: S35-trending
rules_hash: 1519999032c4
---
# rate_limited (429)
## Definition
`rate_limited` is the error code that `GET /api/trending` returns with status `429` when a caller goes over the `discovery.trending` rate-limit policy. The limit is counted per address. The answer carries `Retry-After`, telling the caller when to try again. Like every trending error, it carries `Cache-Control: no-store`.

## Example
One address sends 300 requests within one minute, and all are answered. The 301st request gets:
```
429 Too Many Requests
Retry-After: <seconds>
Cache-Control: no-store
```

## Known gaps
- The spec does not say the `Retry-After` value for this answer.
- The spec does not say how the "address" is worked out (for example, through forwarding headers from a trusted proxy).

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-03
- [rejected-operation](rejected-operation.md)
<!-- used-by:end -->
