---
id: masked-phone
title: Masked phone
kind: term
status: draft
aliases: [masked]
defined_for: S28-notifications
rules_hash: 22253bca26ff
---
# Masked phone
## Definition
The masked phone is the user's phone number with part of it hidden. It is returned in the `GET` and `PUT` responses for [preferences and settings](notification-settings.md). It lets the user recognise their number without the API exposing it in full. Design intent (not stated in the spec): privacy, so the full number is not exposed. The phone matters because [enabling SMS requires a verified phone](verified-phone.md), and changing the phone clears that verification.

## Example
Illustrative only (the masking format is invented):
```json
{ "phone": "+38*******67" }
```

## Known gaps
- The spec does not give the masking format or the response field name.
- The spec does not say whether the response also reports if the phone is verified.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-16
- [notification-settings](notification-settings.md)
- [put-notifications-preferences](put-notifications-preferences.md)
- [verified-phone](verified-phone.md)
<!-- used-by:end -->
