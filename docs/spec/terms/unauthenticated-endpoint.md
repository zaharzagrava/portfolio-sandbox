---
id: unauthenticated-endpoint
title: Unauthenticated endpoints (unsubscribe, callbacks)
kind: term
status: draft
aliases: [callbacks, unsubscribe]
defined_for: S28-notifications
rules_hash: 1892bccb2d48
---
# Unauthenticated endpoints (unsubscribe, callbacks)
## Definition
These are the only notifications endpoints that accept requests without a session: [one-click unsubscribe ↗](../sw-external-terms.md#list-unsubscribe-one-click) and the [provider callbacks](provider-callback.md). They have no [principal](principal.md), so they cannot be [scoped to the caller](caller-scoping.md). Unsubscribe trusts a [signed, non-expiring token](unsubscribe-token.md) that names the [category](notification-category.md) instead. Design intent (not stated in the spec): a mail recipient clicks from a mail client without signing in, and SES or Twilio call the server directly.

## Example
```
GET  /notifications/unsubscribe?token=<signed token>   -> describes the action only
POST /notifications/unsubscribe?token=<signed token>   -> switches off e-mail for that category
POST /notifications/unsubscribe?token=tampered          -> 400 [invalid_unsubscribe_token](invalid-unsubscribe-token.md) (no reason)
POST /notifications/webhooks/ses                        -> provider callback
```

## Known gaps
- The spec does not say how `POST /notifications/webhooks/ses` and `/twilio` prove a request really came from the provider.
- The spec does not say whether these endpoints still use `[application/problem+json ↗](../sw-external-terms.md#problem-json)` errors and the domain's [rate-limit policies](rate-limit-policy.md). The rule's wording leaves this unclear.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-53
- [caller-scoping](caller-scoping.md)
- [notification-category](notification-category.md)
- [post-notifications-unsubscribe](post-notifications-unsubscribe.md)
- [post-notifications-webhooks-twilio](post-notifications-webhooks-twilio.md)
- [principal](principal.md)
- [provider-callback](provider-callback.md)
- [rate-limit-policy](rate-limit-policy.md)
- [unsubscribe-token](unsubscribe-token.md)
<!-- used-by:end -->
