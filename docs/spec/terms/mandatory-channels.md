---
id: mandatory-channels
title: mandatoryChannels
kind: term
status: draft
aliases: [mandatory channels]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# mandatoryChannels
## Definition
`mandatoryChannels` is a field in the responses of `GET` and `PUT` for preferences and settings. It tells the client which [channels](notification-channel.md) are forced for [mandatory types](mandatory-notification-type.md), whatever the user's [opt-outs](opt-out.md) are. Mandatory types ignore category and channel opt-outs and [quiet hours](quiet-hours.md), but not [suppression](suppression.md). A client can use it to show those cells as locked instead of letting the user switch them off.

## Example
Illustrative response fragment (the shape and values are invented):
```json
{ "mandatoryChannels": ["email"] }
```

## Known gaps
- The spec does not give the type or shape of `mandatoryChannels`, for example a list of channels versus a map per category or per type.
- The spec does not say what happens when a `PUT` tries to switch off a mandatory channel: whether it is rejected, ignored, or stored with no effect.

## Used by
<!-- used-by:start -->
- [mandatory-notification-type](mandatory-notification-type.md)
- [notification-channel](notification-channel.md)
- [opt-out](opt-out.md)
- [quiet-hours](quiet-hours.md)
- [suppression](suppression.md)
<!-- used-by:end -->
