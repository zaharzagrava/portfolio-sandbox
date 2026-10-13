---
id: post-notifications-unsubscribe
title: POST /notifications/unsubscribe
kind: term
status: draft
aliases: [/notifications/unsubscribe]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# POST /notifications/unsubscribe
## Definition
`POST /notifications/unsubscribe` is the [anonymous endpoint](unauthenticated-endpoint.md) that carries out a [one-click unsubscribe ↗](../sw-external-terms.md#list-unsubscribe-one-click). It reads the [unsubscribe token](unsubscribe-token.md) from the `token` query parameter. It then switches off the e-mail channel for the [notification category](notification-category.md) named in that token. Every bad token gets `invalid_unsubscribe_token`, and the answer never says why the token was rejected. Its partner `GET /notifications/unsubscribe` only describes the action and changes nothing.

Only the e-mail channel of that one category is turned off. The switch is stored as an [explicit override](explicit-override.md) in the [preference matrix](preference-matrix.md). A [mandatory type](mandatory-type.md) ignores this opt-out (S28.R-17), so those e-mails still go out.

Design intent (not stated in the spec): the endpoint is split into a `GET` that changes nothing and a `POST` that acts. This lets a [link scanner](mail-scanner.md) open the URL without unsubscribing anyone, while mail clients use the one-click headers to send the `POST`.

## Example
A non-mandatory e-mail carries the signed unsubscribe URL. Clicking through, or the mail client's one-click action, sends:
```
POST /notifications/unsubscribe?token=<token>
```
If the token names an illustrative category such as `marketing`, that category's e-mail cell becomes `false`. A tampered token gets `400 invalid_unsubscribe_token`.

## Known gaps
- The spec does not say what a successful `POST` returns (status code or body).
- The spec does not say whether a repeated `POST` with the same token gives the same answer, although switching an already-off channel off again changes nothing.
- The spec does not say whether this endpoint has its own rate limit, even though it is anonymous and the token never expires.

## Used by
<!-- used-by:start -->
- [explicit-override](explicit-override.md)
- [mail-scanner](mail-scanner.md)
- [mandatory-type](mandatory-type.md)
- [notification-category](notification-category.md)
- [preference-matrix](preference-matrix.md)
- [unauthenticated-endpoint](unauthenticated-endpoint.md)
- [unsubscribe-token](unsubscribe-token.md)
<!-- used-by:end -->
