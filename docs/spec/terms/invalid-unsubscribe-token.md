---
id: invalid-unsubscribe-token
title: invalid_unsubscribe_token (400)
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# invalid_unsubscribe_token (400)
## Definition
`invalid_unsubscribe_token` is the single error returned for any bad [unsubscribe token](unsubscribe-token.md): [tampered ↗](../sw-external-terms.md#tampered-token), un[signed ↗](../sw-external-terms.md#digital-signature) or unreadable. The answer never says why the token was rejected. Unsubscribe tokens are signed and do not expire, so age alone never causes this error. Design intent (not stated in the spec): one reason-free answer gives an attacker probing tokens nothing to learn.

## Example
```
POST /notifications/unsubscribe?token=abc.tampered   (illustrative token)
-> 400 { "code": "invalid_unsubscribe_token", ... }
```

## Known gaps
- The spec does not say whether [`GET /notifications/unsubscribe`](post-notifications-unsubscribe.md) gives the same error for a bad token, or a page describing the error.
- The spec does not say what happens to a validly signed token whose user or [category](notification-category.md) no longer exists.
- Not confirmed in the code: which secret signs the tokens. [`NOTIFICATION_SECRET`](notification-secret.md) is required in production, but the facts do not link it to unsubscribe tokens.

## Used by
<!-- used-by:start -->
- [notification-category](notification-category.md)
- [unsubscribe-token](unsubscribe-token.md)
<!-- used-by:end -->
