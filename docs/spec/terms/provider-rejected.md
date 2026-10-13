---
id: provider-rejected
title: provider_rejected
kind: term
status: draft
aliases: []
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# provider_rejected
## Definition
`provider_rejected` is the reason stored when the [payment provider](payment-provider.md) refuses the charge request itself (`400` or `401`), rather than [declining the card](definite-decline.md). The payment becomes `FAILED(provider_rejected)`. A rejected request does not count as a [circuit-breaker failure ↗](../sw-external-terms.md#circuit-breaker), because only timeouts, connection errors, `5xx`, `429` and slow calls count. The likely reason for treating it as final is that sending the same malformed or unauthorised request again would not change the answer. That reasoning is design intent (not stated in the spec).

## Example
The provider answers a charge with `401` (illustrative cause: the configured provider key is wrong). The payment is set to `FAILED(provider_rejected)` and the charge is not retried.

## Known gaps
- The spec does not say whether a `FAILED(provider_rejected)` payment emits the same [`payment_failed` event](payment-failed-event.md) as a card decline.
- The spec does not say whether a `401` from the provider alerts operators. A bad provider key would fail every payment this way.
- Not confirmed in the code: which provider status codes other than `400` and `401` map to `provider_rejected`. [`classifyCharge`](classify-charge.md) is cited, but its contents were not checked.

## Used by
<!-- used-by:start -->
- [definite-decline](definite-decline.md)
- [payment-failed-event](payment-failed-event.md)
- [payment-provider](payment-provider.md)
<!-- used-by:end -->
