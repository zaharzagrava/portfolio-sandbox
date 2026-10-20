---
id: flash-sale-sold-out-notification
title: shop.flash_sale_sold_out notification
kind: term
status: draft
aliases: [shop.flash_sale_sold_out]
defined_for: J03-launch-day
rules_hash: e3b0c44298fc
---
# shop.flash_sale_sold_out notification
## Definition
`shop.flash_sale_sold_out` is a [notification type](notification-type.md) telling a shop owner that a [flash-sale drop](drop.md) has sold all its [units](auction-unit.md). The owner receives exactly one [inbox item](inbox-item.md). [Shop staff](shop-role.md) receive none. It is derived from the `flash_sale.sold_out` event, so it arrives through the [notification consumers](event-consumer.md) rather than the checkout itself.

## Example
B-10: a drop's last unit is reserved and the sale reaches 0 units. The owner's inbox gains one `shop.flash_sale_sold_out` item, and a staff member's inbox gains nothing.

## Known gaps
- The spec does not say whether units returned by an expired hold, after the sale has sold out, cause a second notice when the sale sells out again.
- The spec does not say whether shop admins, as distinct from owner and staff, receive it.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
