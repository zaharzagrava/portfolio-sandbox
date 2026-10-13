---
id: provider-lookup-window
title: Provider lookup window
kind: term
status: draft
aliases: [window]
defined_for: payment-lifecycle
rules_hash: 276ccbad38b8
---
# Provider lookup window
## Definition
The [provider lookup](provider-lookup.md) window is a period of time that starts at a payment's [attempt](checkout-attempt.md). During it, if a provider lookup finds no record of the charge, that does not count as proof that no charge happened. The payment stays [`UNKNOWN`](unknown-payment-outcome.md) and is not failed or cancelled. Design intent (not stated in the spec): the provider may not have recorded the charge yet, so "no record" this early could be wrong. Rule `payment-lifecycle.C-06` sets the window's length.

## Example
An attempt sends a charge at 10:00 and the call times out, so the payment is `UNKNOWN`. A [lookup by our reference](provider-lookup.md) at 10:20 finds no record. That is inside the 60-minute window, so the payment stays `UNKNOWN`. (The times are illustrative; the 60 minutes comes from C-06.)

## Known gaps
- The spec does not say what happens when a lookup still finds no record after the window has ended. For example, it does not say whether the payment then becomes failed or stays `UNKNOWN`.
- The spec does not say where the window starts. It could be when the attempt starts, or when the charge request was sent to the provider.
- The spec does not say whether the window also limits the "[provider unreachable](payment-provider.md)" case. The wording of C-06 can be read both ways.

## Used by
<!-- used-by:start -->
- [S13](../capabilities/S13-payment-intents.md): R-18
- [checkout-attempt](checkout-attempt.md)
- [payment-provider](payment-provider.md)
- [provider-lookup](provider-lookup.md)
- [unknown-payment-resolution](unknown-payment-resolution.md)
<!-- used-by:end -->
