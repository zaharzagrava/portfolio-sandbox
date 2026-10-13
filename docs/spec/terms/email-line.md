---
id: email-line
title: E-mail line
kind: term
status: draft
aliases: [e-mail channel]
defined_for: S28-notifications
rules_hash: da0d2c995ff8
---
# E-mail line
## Definition
The e-mail line is the queue and pool of workers that sends [transactional e-mail](transactional-send.md) through the [e-mail provider chain](provider-chain.md). [Marketing e-mail](marketing-email.md) has its own separate line with lower [worker capacity](worker-capacity.md). Because the lines are separate, a backlog or outage on one never delays the others. Retries after a failure of the whole chain also go back through the line.

## Example
An invitation arrives on the [SQS queue ↗](../sw-external-terms.md#sqs-queue) `tenancy-invite-requested`, addressed to an e-mail address instead of a user. It goes only to the `notify-email` line. It gets no [inbox item](inbox-item.md) and no [preference lookup](preference-lookup.md), but [suppression](suppression.md) is still checked. A marketing e-mail would go to `notify-marketing-email` instead.

## Known gaps
- The spec does not give the worker capacity of either e-mail line. It only says the marketing line has less.
- Not confirmed in the code: the delivery lines have no proof attached (`[[proof: none]](rule-proof.md)`).

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-08
- [inbox-item](inbox-item.md)
- [marketing-email](marketing-email.md)
- [preference-lookup](preference-lookup.md)
- [provider-chain](provider-chain.md)
- [recipient-rule](recipient-rule.md)
- [suppression](suppression.md)
- [tenancy-invite-requested-queue](tenancy-invite-requested-queue.md)
- [transactional-send](transactional-send.md)
- [worker-capacity](worker-capacity.md)
<!-- used-by:end -->
