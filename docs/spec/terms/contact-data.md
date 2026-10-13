---
id: contact-data
title: Contact data
kind: term
status: draft
aliases: []
defined_for: S28-notifications
rules_hash: c9922dcf12fb
---
# Contact data
## Definition
Contact data means the details used to reach a person, such as their e-mail address or phone number. Notifications needs this data to hand a [delivery](delivery.md) to its [provider](mail-provider.md). The service contract says contact data must never appear in the capability's logs. A raw e-mail address is also the standard example of a [metric label value ↗](../sw-external-terms.md#metric-labels) that is not allowed. The API protects it too: settings return a masked phone instead of the full number.

## Example
An SMS goes to [`notify-sms`](notify-sms-queue.md) and is sent with the full phone number. The log line and the metric for that send must not include the number. [`GET /notifications/preferences`](put-notifications-preferences.md) returns only a masked phone. The exact masked form is not given in the facts.

## Known gaps
- The spec does not give a full list of what counts as contact data, for example whether device tokens or display names are included.
- The spec does not say whether contact data may appear in the [delivery timeline](delivery-timeline.md) or [dead-letter records](dead-letter-topic.md). The rule for those (S28.R-13) names [secrets](provider-secret.md) only.

## Used by
<!-- used-by:start -->
- [bounded-label-values](bounded-label-values.md)
- [dead-letter-topic](dead-letter-topic.md)
- [delivery-timeline](delivery-timeline.md)
- [delivery](delivery.md)
- [mail-provider](mail-provider.md)
- [provider-secret](provider-secret.md)
- [service-contract](service-contract.md)
- [structured-logs](structured-logs.md)
<!-- used-by:end -->
