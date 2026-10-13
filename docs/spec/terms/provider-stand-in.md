---
id: provider-stand-in
title: Provider stand-in
kind: term
status: draft
aliases: [stand-in]
defined_for: S28-notifications
rules_hash: 7ed7a23c52b7
---
# Provider stand-in
## Definition
A provider stand-in is a fake e-mail, SMS or push provider used outside production. It replaces a real provider so that local and test environments work without credentials. It reports itself as `provider: "log"` and never marks a [delivery](delivery.md) [`delivered`](delivery-status.md), so its results cannot be mistaken for real delivery. In production, stand-ins are not allowed: a channel without credentials stops startup.

## Example
On a developer machine without SES or Twilio credentials, an order notification goes through [routing](notification-routing.md) as normal. The e-mail delivery is handed to the stand-in, and its [timeline](delivery-timeline.md) shows provider `log` instead of a real provider.

## Known gaps
- The spec does not say whether the e-mail stand-in feeds the [`GET /dev/mailbox`](in-memory-mailbox.md) endpoint.
- The spec does not say which timeline status a stand-in delivery ends in. It only says the status is never `delivered`.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-37
- [delivery-timeline](delivery-timeline.md)
- [delivery](delivery.md)
- [get-dev-mailbox](get-dev-mailbox.md)
- [in-memory-mailbox](in-memory-mailbox.md)
- [log-provider](log-provider.md)
- [mail-provider](mail-provider.md)
- [notification-routing](notification-routing.md)
<!-- used-by:end -->
