---
id: password-reset-mailer-port
title: PASSWORD_RESET_MAILER port
kind: term
status: draft
aliases: [password_reset_mailer]
defined_for: S28-notifications
rules_hash: fecf5ed9d7a9
---
# PASSWORD_RESET_MAILER port
## Definition
`PASSWORD_RESET_MAILER` is the [port](in-process-port.md) through which the password-reset e-mail is sent. [`TransactionalMailModule`](transactional-mail-module.md) in notifications binds it, so the code that starts a password reset does not deal with templates or providers itself. The mail must use the [catalog template](catalog-template.md) and [redaction](template-redaction.md), and it must carry the reset link in a fixed format.

## Example
The caller passes a reset token through the port. The recipient receives a link like:
```
<front>/reset-password#token=<token>
```
The token sits in the [URL fragment ↗](../sw-external-terms.md#url-fragment). The token never appears in logs, the [timeline](delivery-timeline.md) or metrics.

## Known gaps
- The spec does not give the method signature of the port or what it returns when sending fails.
- The spec does not say whether this mail goes through the normal `notify-email` line with its retries and failover, or uses its own path.
- The spec does not say which capability calls the port. The identity domain is assumed but not stated.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-14
- [catalog-template](catalog-template.md)
- [delivery-timeline](delivery-timeline.md)
- [get-dev-mailbox](get-dev-mailbox.md)
- [in-memory-mailbox](in-memory-mailbox.md)
- [in-process-port](in-process-port.md)
- [template-redaction](template-redaction.md)
- [transactional-mail-module](transactional-mail-module.md)
<!-- used-by:end -->
