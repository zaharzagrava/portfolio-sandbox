---
id: transactional-mail-module
title: TransactionalMailModule
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: e3b0c44298fc
---
# TransactionalMailModule
## Definition
`TransactionalMailModule` is the NestJS module in the notifications capability that binds the [`PASSWORD_RESET_MAILER` port](password-reset-mailer-port.md). Code that needs to send a password-reset e-mail depends only on the [port](in-process-port.md), and this module supplies the implementation behind it. The mail sent this way must use the [catalog template](catalog-template.md) and [template redaction](template-redaction.md). Keeping templates and providers out of the caller's code is design intent (not stated in the spec).

## Example
A password reset is requested. The caller hands the reset token to `PASSWORD_RESET_MAILER`, and `TransactionalMailModule` sends a mail that contains this link:
```
<front>/reset-password#token=<token>
```
The token appears only in the message given to the provider. It never appears in logs, the [delivery timeline](delivery-timeline.md) or metrics.

## Known gaps
- The spec does not say whether `TransactionalMailModule` binds any port other than `PASSWORD_RESET_MAILER`.
- The spec does not say whether its mail goes through the [`notify-email` line](notify-email-queue.md), with that line's retries, failover and suppression check, or takes a separate path.
- The spec does not say whether this module also provides `GET /dev/mailbox` outside production. The entry point lists the two together, but neither fact links them.

## Used by
<!-- used-by:start -->
- [catalog-template](catalog-template.md)
- [delivery-timeline](delivery-timeline.md)
- [in-process-port](in-process-port.md)
- [notify-email-queue](notify-email-queue.md)
- [password-reset-mailer-port](password-reset-mailer-port.md)
- [template-redaction](template-redaction.md)
<!-- used-by:end -->
