---
id: check-payable
title: checkPayable
kind: term
status: draft
aliases: []
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# checkPayable
## Definition
`checkPayable` is the domain function that decides whether a buyer may pay an order right now. It reads the order copy, not the orders domain's tables. An order is payable only if it belongs to the caller, has status `RESERVED`, and the current time is still before `reservedUntil`. If the time is exactly `reservedUntil`, the hold counts as expired. When the order is not payable, the answer is `order_not_payable` with a reason: `order_cancelled`, `order_paid` or `hold_expired`.

## Example
An order is `RESERVED` with `reservedUntil` = `12:00:00` (illustrative). The buyer posts to `POST /payments/intents` at exactly `12:00:00`:
```
409 order_not_payable   reason: hold_expired
```

## Known gaps
- Not confirmed in the code: whether `checkPayable` also produces the `404 order_not_found` for foreign and unknown orders (S13.R-04), or whether another layer does that.
- Not confirmed in the code: whether the payment processor calls `checkPayable` when it re-checks the order before calling the provider (S13.R-12).

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
