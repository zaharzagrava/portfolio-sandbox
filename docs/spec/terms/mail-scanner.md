---
id: mail-scanner
title: Mail scanner
kind: term
status: draft
aliases: [link previewers]
defined_for: S28-notifications
rules_hash: 5bc099e7ced3
---
# Mail scanner
## Definition
A mail scanner is software outside this system that opens links in incoming e-mails automatically. Examples include corporate security gateways that check links for [phishing ↗](../sw-external-terms.md#phishing), and link previewers. These tools fetch a link before the recipient ever clicks it. This matters here because such a fetch must not count as the recipient's decision. That is why `GET /notifications/unsubscribe` only describes the action, and only a [`POST` ↗](../sw-external-terms.md#http-post) switches off the e-mail channel. Design intent (not stated in the spec).

## Example
A security gateway receives a [non-mandatory](mandatory-notification-type.md) e-mail and fetches its unsubscribe link before the user sees it (illustrative):
```
GET  /notifications/unsubscribe?token=abc123   -> scanner sees a description; preferences unchanged
POST /notifications/unsubscribe?token=abc123   -> sent only when the recipient confirms; e-mail off for that category
```

## Known gaps
- The spec does not say anything about mail scanners. The link between scanners and the split between `GET` and `POST` is general engineering knowledge, not a stated requirement.
- The spec does not say what the [one-click headers ↗](../sw-external-terms.md#list-unsubscribe-one-click) contain. So it is not confirmed whether an automated client that acts on those headers can switch off a category without a human.
- The spec does not say whether opens of the `GET` page are logged or counted. If they are, scanner traffic would inflate those numbers.

## Used by
<!-- used-by:start -->
- [mandatory-notification-type](mandatory-notification-type.md)
- [post-notifications-unsubscribe](post-notifications-unsubscribe.md)
- [unsubscribe-link](unsubscribe-link.md)
<!-- used-by:end -->
