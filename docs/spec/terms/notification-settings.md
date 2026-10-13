---
id: notification-settings
title: Notification settings
kind: term
status: draft
aliases: [settings]
defined_for: S28-notifications
rules_hash: 86f0e5c44cb7
---
# Notification settings
## Definition
Notification settings are a user's delivery-wide choices that are not tied to one category: [quiet hours](quiet-hours.md), time zone and locale. The caller reads them with `GET` and changes them with `PUT /notifications/settings`. Every answer returns the full preference matrix, `mandatoryChannels` and the user's phone in masked form. A write invalidates the [cached recipient view](recipient-view.md), so routing never uses the old values.

## Example
`PUT /notifications/settings` with this body (values are illustrative):
```json
{ "quietStart": "22:00", "quietEnd": "07:00", "timeZone": "Europe/Kyiv", "locale": "uk" }
```
`quietStart` and `quietEnd` are set or cleared together. The time zone is an [IANA name ↗](../sw-external-terms.md#iana-time-zone) and the locale is `en` or `uk`.

## Known gaps
- The spec does not say the exact JSON field names for time zone and locale. Only `quietStart` and `quietEnd` are named.
- The spec does not say which error a rejected settings write returns, such as an unequal quiet-hours pair or an unknown time zone.
- The spec does not say how the phone is masked.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-16
- [locale](locale.md)
- [masked-phone](masked-phone.md)
- [notification-channel](notification-channel.md)
- [notifications-controller](notifications-controller.md)
- [phone-verification-code](phone-verification-code.md)
- [preference-lookup](preference-lookup.md)
- [quiet-hours](quiet-hours.md)
- [recipient-view](recipient-view.md)
- [sms-stop](sms-stop.md)
<!-- used-by:end -->
