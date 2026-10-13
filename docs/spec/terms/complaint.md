---
id: complaint
title: Complaint
kind: term
status: draft
aliases: [complained]
defined_for: S28-notifications
rules_hash: beccd59e63cb
---
# Complaint
## Definition
A complaint is a [provider callback](provider-callback.md) saying that the recipient marked one of the platform's e-mails as spam. It [suppresses the recipient's e-mail address](address-suppression.md), and when the platform knows which user owns the address, it also turns off that user's [marketing e-mail](marketing-email.md). The delivery's [timeline](delivery-timeline.md) records the status `[complained](delivery-bounced.md)`. [Mandatory types](mandatory-notification-type.md) do not bypass suppression, so after a complaint even mandatory e-mail stops going to that address. Design intent (not stated in the spec): continuing to e-mail someone who reported spam hurts the platform's sending reputation with the provider.

## Example
A user marks a marketing e-mail from `notify-marketing-email` as spam. SES sends a complaint callback to `POST /notifications/webhooks/ses`. The address is suppressed, the user's marketing e-mail preference flips to off, and the delivery's timeline shows `complained`.

## Known gaps
- The spec does not say whether a suppressed address can ever be released. The purpose statement says bad addresses stop receiving mail "for good".
- The spec does not say whether a complaint about a transactional e-mail also turns off marketing e-mail. The rule says it does whenever the user is known.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-46
- [address-suppression](address-suppression.md)
- [delivery-suppression](delivery-suppression.md)
- [delivery-timeline](delivery-timeline.md)
- [mandatory-notification-type](mandatory-notification-type.md)
- [marketing-email](marketing-email.md)
- [provider-callback](provider-callback.md)
<!-- used-by:end -->
