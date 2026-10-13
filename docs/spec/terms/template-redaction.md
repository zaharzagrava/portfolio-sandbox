---
id: template-redaction
title: Template redaction
kind: term
status: draft
aliases: [redaction]
defined_for: S28-notifications
rules_hash: 46199f38c778
---
# Template redaction
## Definition
Template redaction keeps secrets out of everything except the message handed to the provider. Secrets here are [reset](password-reset-token.md) and [invite tokens](invite-token.md), one-time codes and [unsubscribe tokens](unsubscribe-token.md). Logs, the [delivery timeline](delivery-timeline.md), metrics, [dead-letter records](dead-letter-topic.md) and [inbox items](inbox-item.md) get a version with the secret removed. The password-reset mail is explicitly required to use it.

## Example
A reset mail is sent with the link `<front>/reset-password#token=<token>`. The provider receives the full link. The timeline entry and any log line about that send show the link without the token value.

## Known gaps
- The spec does not say how secret fields are marked in a template or what replaces them, such as a placeholder or an omitted field.
- Not confirmed in the code: that redaction applies to every template with a secret, beyond the password-reset mail named in the rule.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-14
- [dead-letter-topic](dead-letter-topic.md)
- [delivery-timeline](delivery-timeline.md)
- [inbox-item](inbox-item.md)
- [invite-token](invite-token.md)
- [notification-rendering](notification-rendering.md)
- [password-reset-mailer-port](password-reset-mailer-port.md)
- [password-reset-token](password-reset-token.md)
- [structured-logs](structured-logs.md)
- [transactional-mail-module](transactional-mail-module.md)
- [unsubscribe-token](unsubscribe-token.md)
<!-- used-by:end -->
