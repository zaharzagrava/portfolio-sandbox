---
id: log-provider
title: Log provider
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# Log provider
## Definition
`log` is the provider name a [provider stand-in](provider-stand-in.md) reports for a [delivery](delivery.md). If you see `provider: "log"` on a delivery, the message never left the system. A delivery with this provider never reaches [`delivered`](delivery-status.md). Design intent (not stated in the spec): `delivered` normally comes from real [provider callbacks](provider-callback.md), and a stand-in has none.

## Example
An illustrative delivery result from a test environment (the field layout and the status value are invented):
```json
{ "channel": "sms", "provider": "log", "status": "sent" }
```

## Known gaps
- The spec does not say what the log provider actually writes to the application log. [The secrets rule](provider-secret.md) forbids secrets in logs, so it cannot print reset links, invite links or one-time codes as they are.
- The spec does not say where `provider: "log"` appears: in the [delivery timeline](delivery-timeline.md), in metrics or in both.

## Used by
<!-- used-by:start -->
- [delivery-timeline](delivery-timeline.md)
- [delivery](delivery.md)
- [provider-callback](provider-callback.md)
- [provider-secret](provider-secret.md)
- [provider-stand-in](provider-stand-in.md)
<!-- used-by:end -->
