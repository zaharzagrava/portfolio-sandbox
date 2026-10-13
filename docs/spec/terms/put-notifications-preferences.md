---
id: put-notifications-preferences
title: PUT /notifications/preferences
kind: term
status: draft
aliases: [/notifications/preferences]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# PUT /notifications/preferences
## Definition
`PUT /notifications/preferences` lets the signed-in caller write their [preference matrix](preference-matrix.md): one on/off switch per category and channel. The answer is always the full matrix, along with [`mandatoryChannels`](mandatory-channels.md) and the [masked phone](masked-phone.md). The call is [idempotent ↗](../sw-external-terms.md#idempotency), so sending the same body again changes nothing. Turning on SMS for any category is refused with [`phone_not_verified`](phone-not-verified.md) unless the caller has a [verified phone](verified-phone.md). Each write invalidates the caller's [recipient view](recipient-view.md), so [routing](notification-routing.md) never keeps using the old values.

## Example
```http
PUT /notifications/preferences
{ "orders": { "sms": true } }        ← body shape illustrative
→ 422 phone_not_verified             (phone not verified yet)
→ 200 { full matrix, "mandatoryChannels": [...], phone: "+38*******67" }  (after verification; values illustrative)
```

## Known gaps
- The spec does not say the request body shape, or whether the body replaces the whole matrix or only changes the cells it names.
- The spec does not say how a caller removes an [explicit override](explicit-override.md) and goes back to the default value.

## Used by
<!-- used-by:start -->
- [explicit-override](explicit-override.md)
- [masked-phone](masked-phone.md)
- [notification-routing](notification-routing.md)
- [preference-matrix](preference-matrix.md)
- [recipient-view](recipient-view.md)
- [verified-phone](verified-phone.md)
<!-- used-by:end -->
