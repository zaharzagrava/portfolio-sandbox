---
id: ses-complaint
title: SES complaint
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: ef6121e58d93
---
# SES complaint
## Definition
An [SES ↗](../sw-external-terms.md#amazon-ses) complaint is a callback from the e-mail provider SES. It reports that a recipient marked a delivered e-mail as spam. It arrives at the SES [provider-callback endpoint](provider-callback.md) and must be signed. A valid complaint [suppresses the address](address-suppression.md) and [switches off marketing e-mail](marketing-email.md) for that user. After that, no later event sends to the address through any provider. [The delivery's timeline](delivery-timeline.md) records the status `complained`.

## Example
```
POST /notifications/webhooks/ses
(signed complaint for a delivered e-mail to buyer@example.com, illustrative)
```
Result: the address is suppressed, marketing e-mail is switched off, and the next order event calls no e-mail provider.

## Known gaps
- The spec does not say how the SES signature is checked, or what an unsigned or badly signed callback gets back.
- The spec does not say whether "marketing e-mail is switched off" means every marketing category or only the category of the e-mail that drew the complaint.
- The spec does not say how a callback is matched to its delivery or address. It also does not say whether the [`notifications-callbacks` queue](notifications-callbacks-queue.md) sits between the endpoint and that processing.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): B-11
- [address-suppression](address-suppression.md)
- [delivery-timeline](delivery-timeline.md)
- [marketing-email](marketing-email.md)
- [notifications-callbacks-queue](notifications-callbacks-queue.md)
- [provider-callback](provider-callback.md)
<!-- used-by:end -->
