---
id: in-memory-mailbox
title: In-memory mailbox
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: f841cedcc09c
---
# In-memory mailbox
## Definition
The in-memory mailbox is where the dev and test [e-mail provider](mail-provider.md) keeps outgoing mail. That provider holds each message in process memory and never sends it. The [notifications module's public entry point](entry-point.md) exports the mailbox, but not the [router service](notification-router.md), [projector](search-projector.md), formatter or models. Code outside the module can therefore inspect "sent" mail without reaching into its internals. Design intent (not stated in the spec): tests can check a mail's content without a real provider.

## Example
A test triggers a password reset through the [`PASSWORD_RESET_MAILER` port](password-reset-mailer-port.md). It then reads the in-memory mailbox and finds a mail containing `<front>/reset-password#token=<token>`. The [stand-in provider](provider-stand-in.md) reports `provider: "log"`, and the mail's [timeline](delivery-timeline.md) never reaches `[delivered](delivery-status.md)`.

## Known gaps
- The spec does not say whether [`GET /dev/mailbox`](get-dev-mailbox.md) (`DevMailboxController`) reads from this mailbox.
- The spec does not say whether the mailbox is bounded or cleared, or whether it is shared across processes. Memory is per process, so another process would not see the mail.
- The spec does not say how the mailbox treats secrets. It holds the full message handed to the provider, so it contains [reset and invite tokens](password-reset-token.md).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-52
- [delivery-timeline](delivery-timeline.md)
- [entry-point](entry-point.md)
- [get-dev-mailbox](get-dev-mailbox.md)
- [mail-provider](mail-provider.md)
- [notification-router](notification-router.md)
- [password-reset-mailer-port](password-reset-mailer-port.md)
- [password-reset-token](password-reset-token.md)
- [provider-stand-in](provider-stand-in.md)
- [search-projector](search-projector.md)
<!-- used-by:end -->
