---
id: structured-logs
title: Structured logs
kind: term
status: draft
aliases: [structured logging]
defined_for: S28-notifications
rules_hash: 33209e0eec5e
---
# Structured logs
## Definition
Structured logs are log records written as named fields rather than free-form sentences. The service contract requires that the logs that go with a [capability's metrics](capability.md) be structured. Those logs must not carry [contact data](contact-data.md), a token or a message body. In notifications, this sits next to the rule that secrets appear only in the message handed to the [provider](mail-provider.md) and never in logs. Fields make logs easy to filter, and they make a forbidden value easier to spot and keep out. This is design intent (not stated in the spec).

## Example
A [worker](worker-instance.md) logs the outcome of one e-mail delivery as fields. It does not log a sentence that contains the address. Field names and ids are illustrative:
```json
{ "event": "delivery_sent", "deliveryId": "d_123", "channel": "email", "status": "sent" }
```
The log must not include the recipient's address, the reset token or the rendered mail body.

## Known gaps
- The spec does not say which fields a log record must have, or what format it uses.
- The spec does not say how the ban on contact data, tokens and bodies is enforced, for example by a [redacting logger](template-redaction.md) or by review only.

## Used by
<!-- used-by:start -->
- [capability](capability.md)
- [contact-data](contact-data.md)
- [mail-provider](mail-provider.md)
- [service-contract](service-contract.md)
- [template-redaction](template-redaction.md)
- [worker-instance](worker-instance.md)
<!-- used-by:end -->
