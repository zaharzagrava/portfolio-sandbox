---
id: client-secret
title: clientSecret
kind: term
status: draft
aliases: []
defined_for: S13-payment-intents
rules_hash: 5ae1d201cc2a
---
# clientSecret
## Definition
`clientSecret` is a secret the provider returns when a charge needs customer action, so the payment stays [`PENDING`](payment-status.md) with [`requiresAction`](requires-action.md). In common PSPs, a value like this lets the buyer's front end finish the action, such as a card challenge. That comes from general PSP knowledge, not from the spec. It is treated as a secret, like the [payment method token](payment-method-token.md) and the [provider secret](provider-secret.md). It must never appear in logs, [outbox payloads](outbox-append.md), events, [realtime pushes](realtime-publish.md) or error bodies.

## Example
The provider asks for customer action on a charge. The payment stays `PENDING` with `requiresAction`. The `payment.status` push to the owner's topic and the log lines for that `paymentId` must not contain the `clientSecret` value.

## Known gaps
- The spec does not say how the `clientSecret` reaches the buyer, for example whether `GET /payments/:paymentId` returns it to the owner.
- The spec does not say where or for how long the `clientSecret` is stored.

## Used by
<!-- used-by:start -->
- [delete-shop-sso](delete-shop-sso.md)
- [outbox-append](outbox-append.md)
- [payment-method-token](payment-method-token.md)
- [provider-secret](provider-secret.md)
- [realtime-publish](realtime-publish.md)
- [reseal-sso-secrets-job](reseal-sso-secrets-job.md)
<!-- used-by:end -->
