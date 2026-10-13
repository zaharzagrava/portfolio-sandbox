---
id: settings-path
title: Settings path
kind: term
status: draft
aliases: [settings]
defined_for: S28-notifications
rules_hash: 4d3fc0a3319d
---
# Settings path
## Definition
The settings path is the notification-settings route of [`NotificationsController`](notifications-controller.md), written as `PUT /notifications/settings`. Here a user sets [quiet hours](quiet-hours.md), their time zone and their locale. The [phone-verification endpoints](phone-verification-code.md), for requesting and checking a code, also live under this path. They were added together with the [preferences work](preference-matrix.md). Each settings write invalidates the [recipient view](recipient-view.md), just like a preferences write.

## Example
```http
PUT /notifications/settings
{ "quietStart": "22:00", "quietEnd": "07:00", "timeZone": "Europe/Kyiv", "locale": "uk" }
```
`quietStart` and `quietEnd` must be set or cleared together and must differ. The time zone must be an [IANA name ↗](../sw-external-terms.md#iana-time-zone), and the locale must be `en` or `uk`. (The `timeZone` field name and all values here are illustrative.)

## Known gaps
- The spec does not say the exact sub-paths or HTTP methods of the phone request-code and verify-code endpoints.
- The spec does not say which endpoint sets or changes the phone number itself.
- The spec does not say whether `GET /notifications/settings` exists. The entry points list only `PUT` for settings, but rule S28.R-16 mentions `GET` of settings.

## Used by
<!-- used-by:start -->
- [notifications-controller](notifications-controller.md)
- [phone-verification-code](phone-verification-code.md)
- [preference-matrix](preference-matrix.md)
- [quiet-hours](quiet-hours.md)
- [recipient-view](recipient-view.md)
- [verified-phone](verified-phone.md)
<!-- used-by:end -->
