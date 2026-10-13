---
id: callback-deduplication
title: Callback deduplication
kind: term
status: draft
aliases: [deduplicated]
defined_for: S28-notifications
rules_hash: 69d76d28a354
---
# Callback deduplication
## Definition
Callback deduplication ensures that a provider callback has its effect only once, even when the provider sends it more than once. The deduplication key is the [provider's own event id](provider-message-id.md). A repeated callback is still acknowledged, but the worker does not apply it again. Design intent (not stated in the spec): providers deliver callbacks [at least once ↗](../sw-external-terms.md#at-least-once-delivery), so a repeat must not record a second [timeline status](delivery-timeline.md) or repeat a [suppression](address-suppression.md).

## Example
[SES ↗](../sw-external-terms.md#amazon-ses) delivers the same complaint notice twice with the same provider event id (illustrative: `"0100018c-abcd"`). The first copy suppresses the address and turns off the user's [marketing e-mail](marketing-email.md). The second copy is recognised by its event id and changes nothing.

## Known gaps
- The spec does not say how long seen provider event ids are kept. That retention decides how late a duplicate can still be caught.
- Not confirmed in the code: whether deduplication happens at the endpoint, in the worker, or both.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-44
- [address-suppression](address-suppression.md)
- [delivery-timeline](delivery-timeline.md)
- [marketing-email](marketing-email.md)
- [notification-webhooks-controller](notification-webhooks-controller.md)
- [provider-callback](provider-callback.md)
- [provider-message-id](provider-message-id.md)
<!-- used-by:end -->
