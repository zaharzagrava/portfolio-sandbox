---
id: get-dev-mailbox
title: GET /dev/mailbox
kind: term
status: draft
aliases: [/dev/mailbox, devmailboxcontroller]
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# GET /dev/mailbox
## Definition
`GET /dev/mailbox` is an HTTP route served by `DevMailboxController` in the notifications domain. It exists only outside production. It sits next to the [`PASSWORD_RESET_MAILER` port](password-reset-mailer-port.md) bound by [`TransactionalMailModule`](transactional-mail-module.md), on the transactional mail side of the system. Design intent (not stated in the spec): outside production a [provider stand-in](provider-stand-in.md) never sends real mail, so this route lets a developer see mail that would have gone out.

## Example
A developer runs the platform locally and requests a password reset. They then call `GET /dev/mailbox` to find the reset mail, which carries the link `<front>/reset-password#token=<token>`. This is an illustrative example, and it assumes the route lists captured mail. The stand-in reports [`provider: "log"`](log-provider.md), and the mail's [delivery timeline](delivery-timeline.md) never reaches [`delivered`](delivery-status.md).

## Known gaps
- The spec does not say what the route returns: the response shape, any filters, or whether it reads from the [in-memory mailbox](in-memory-mailbox.md).
- The spec does not say how "outside production" is enforced. The route might not be registered in production, or it might be registered but refuse requests. The spec also does not say whether the route needs [authentication ↗](../sw-external-terms.md#http-authentication).
- The spec does not say how the route fits with the rule that [secrets appear only in the message handed to the provider](secret-fields.md). If the route returns full messages, it exposes reset and invite tokens.

## Used by
<!-- used-by:start -->
- [delivery-timeline](delivery-timeline.md)
- [in-memory-mailbox](in-memory-mailbox.md)
- [password-reset-mailer-port](password-reset-mailer-port.md)
- [provider-stand-in](provider-stand-in.md)
- [secret-fields](secret-fields.md)
<!-- used-by:end -->
