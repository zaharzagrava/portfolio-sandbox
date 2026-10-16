---
id: notification
title: Notification
kind: term
status: draft
aliases: [notice, notices]
defined_for: J01-buy-to-payout
rules_hash: cfbb2b28c3f6
---
# Notification
## Definition
A notice the system sends to a person when a business event happens. In the buy-to-payout journey, the buyer gets notices on [`order.paid`](order-paid-event.md) and [`payments.payment_failed`](payment-failed-event.md). The [owners](shop-role.md) of each shop get notices on `order.paid`, [`payout.paid`](payout-paid-event.md) and [`payout.failed`](payout-failed-event.md). Staff of a shop receive none of these notices.

## Example
A buyer pays an order with products from shops A and B. The buyer holds one `order.confirmed`, and each shop owner holds one `shop.order_received`. When the card is declined instead, the buyer holds one `payment.failed`.

## Known gaps
- The spec does not say through which notification channels these journey notices are sent.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
