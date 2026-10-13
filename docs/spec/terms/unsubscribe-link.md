---
id: unsubscribe-link
title: Unsubscribe link
kind: term
status: draft
aliases: [unsubscribe]
defined_for: S28-notifications
rules_hash: 81ef71d5e7ad
---
# Unsubscribe link
## Definition
The unsubscribe link is a [signed URL ↗](../sw-external-terms.md#message-authentication-code) in every e-mail of a [non-mandatory type](mandatory-notification-type.md). It lets the recipient switch off e-mail for one [category](notification-category.md) without signing in. Opening it with `GET` only describes the action and changes nothing. A `POST` with the same token switches off the [e-mail channel](notification-channel.md) for the category named in the token. Mandatory types carry no link and no [one-click headers ↗](../sw-external-terms.md#list-unsubscribe-one-click).

`GET` probably changes nothing because [mail scanners](mail-scanner.md) and link previewers open links automatically. That is design intent (not stated in the spec).

## Example
```
GET  /notifications/unsubscribe?token=abc123   -> describes "stop marketing e-mails" (illustrative)
POST /notifications/unsubscribe?token=abc123   -> e-mail off for that category only
POST /notifications/unsubscribe?token=bad      -> 400 [invalid_unsubscribe_token](invalid-unsubscribe-token.md)
```

## Known gaps
- The spec does not say which key signs the token. [`NOTIFICATION_SECRET`](notification-secret.md) is a likely candidate, but this is not confirmed in the code.
- The spec does not say how to invalidate a leaked link. The token never expires, so it stays usable forever.
- The spec does not say what the one-click headers contain.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-12
- [mail-scanner](mail-scanner.md)
- [mandatory-notification-type](mandatory-notification-type.md)
- [marketing-email](marketing-email.md)
- [notification-category](notification-category.md)
- [notification-channel](notification-channel.md)
- [opt-out](opt-out.md)
<!-- used-by:end -->
