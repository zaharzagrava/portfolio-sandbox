---
id: failure-code
title: failureCode
kind: term
status: draft
aliases: []
defined_for: J01-buy-to-payout
rules_hash: 98fe3eb8625b
---
# failureCode
## Definition
A field set on a [payout](payout-transfer.md) that ends `FAILED`, recording why the transfer was rejected. The rule requires it every time a [rejected transfer](provider-rejected.md) fails a payout. It is set together with the [reversal of the payout](reversing-journal.md) in the books.

## Example
A shop's [payout destination](payout-destination.md) is rejected by the provider during the run and send job:
```json
{ "status": "FAILED", "failureCode": "destination_rejected" }
```
(`destination_rejected` is an illustrative value.)

## Known gaps
- The spec does not say which values `failureCode` can take, or whether they form a closed set.
- The spec does not say whether `failureCode` is shown to the shop owner, for example in the [`payout.failed` notice](payout-failed-event.md).

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
