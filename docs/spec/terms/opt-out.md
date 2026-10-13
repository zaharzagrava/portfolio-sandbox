---
id: opt-out
title: Opt-out
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: d49fd18f905d
---
# Opt-out
## Definition
An opt-out is a `false` the user has stored in the [preference matrix](preference-matrix.md) for one category and channel. A stored value is an [explicit override](explicit-override.md) of the default. Some pairs start opted out, for example [marketing on external channels](marketing-external-channels.md) and SMS. The [one-click unsubscribe link](unsubscribe-link.md) also creates an opt-out, for the e-mail channel of one category. [Mandatory types](mandatory-type.md) ignore opt-outs.

## Example
A user turns off push for marketing with `PUT /notifications/preferences`. They still get the inbox item for a marketing notice, but no push. A push already delayed for [quiet hours](quiet-hours.md) is checked again when it wakes, so it is dropped as well.

## Known gaps
- The spec does not say whether an opt-out can be cleared back to "use the default" or only flipped to an explicit `true`.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-17
- [explicit-override](explicit-override.md)
- [mandatory-channels](mandatory-channels.md)
- [mandatory-type](mandatory-type.md)
- [marketing-email](marketing-email.md)
- [marketing-external-channels](marketing-external-channels.md)
- [preference-matrix](preference-matrix.md)
- [quiet-hours](quiet-hours.md)
- [unsubscribe-link](unsubscribe-link.md)
<!-- used-by:end -->
