---
id: provider-secret
title: Provider secret
kind: term
status: draft
aliases: []
defined_for: S13-payment-intents
rules_hash: ba8aefd976c7
---
# Provider secret
## Definition
The provider secret is the credential the platform uses to call the payment provider. It lets the platform create charges, refunds, cancels and lookups. It must never appear in logs, [outbox payloads](inbox-table.md), events, [realtime pushes](best-effort-push.md) or error bodies. A `5xx` answer carries only a [generic `detail`](problem-detail.md), so a provider error cannot leak it. Design intent (not stated in the spec): anyone holding this secret could act on the platform's provider account. That is why it is treated as the most sensitive payments setting.

## Example
The service starts without the provider key setting. [Startup fails](startup-validation.md), and the error names the missing setting but shows no value. Later, a charge that hits a provider `5xx` makes the payment [`UNKNOWN`](unknown-payment-outcome.md). Neither the logs nor the error body contain the secret.

## Known gaps
- The spec does not say whether the "provider secret" is the same thing as the "provider key" that [startup validation](startup-validation.md) checks.
- The spec does not say the name of the setting that holds it, or how it is rotated.

## Used by
<!-- used-by:start -->
- [best-effort-push](best-effort-push.md)
- [client-secret](client-secret.md)
- [contact-data](contact-data.md)
- [inbox-table](inbox-table.md)
- [log-provider](log-provider.md)
- [payment-method-token](payment-method-token.md)
- [problem-detail](problem-detail.md)
- [startup-validation](startup-validation.md)
<!-- used-by:end -->
