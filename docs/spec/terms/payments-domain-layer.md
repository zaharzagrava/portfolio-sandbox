---
id: payments-domain-layer
title: Payments domain layer
kind: term
status: draft
aliases: [payments domain]
defined_for: S13-payment-intents
rules_hash: e3b0c44298fc
---
# Payments domain layer
## Definition
The payments domain layer holds the business rules of [S13](../capabilities/S13-payment-intents.md) in code. It is the folder `packages/backend/libs/domains/payments/domain/`. It sits beside the `api` folder (the controller), the `application` folder (services such as the [payment intent service](payment-intent.md)) and the `infra` folder (the [`orders.events` consumer](orders-events-consumer.md)). Its functions check money with [`checkPaymentMoney`](check-payment-money.md) and payability with [`checkPayable`](check-payable.md). They also classify provider answers with [`classifyCharge`](classify-charge.md) and [`findMismatch`](find-mismatch.md), and choose status changes with [`decide`](decide-payment-status.md). The layer also defines the payment errors and the [signed payment cursor](pagination-cursor.md). Keeping these rules apart from HTTP, queues and the database is design intent (not stated in the spec).

## Example
A buyer posts `POST /payments/intents` for an order whose [order copy](order-copy.md) has `amountMinor: 0` (illustrative value). `checkPaymentMoney` in `domain/payment-amount.ts` rejects it, so the answer is `422 amount_out_of_range` (S13.R-02).

Later, the processor gets a [provider success](payment-provider.md) whose `orderId` metadata does not match. `findMismatch` in `domain/provider-outcome.ts` flags it, so the payment becomes [`UNKNOWN`](payment-status.md) instead of `COMPLETED` (S13.R-13).

## Known gaps
- The spec does not say whether the domain layer must avoid I/O, such as database reads, provider calls or publishing. It also does not say whether any check enforces that.
- The spec does not say which layers may import from the domain layer, or what the domain layer may import.
- Not confirmed in the code: whether all status changes go through `decide` in `domain/payment-status.ts`. S13.R-20 links that function as the code for the guarded step. The facts do not show who calls it.

## Used by
<!-- used-by:start -->
- [classify-charge](classify-charge.md)
- [find-mismatch](find-mismatch.md)
- [order-copy](order-copy.md)
- [order-reserved-event](order-reserved-event.md)
- [orders-events-consumer](orders-events-consumer.md)
- [pagination-cursor](pagination-cursor.md)
- [payment-intent](payment-intent.md)
- [payment-provider](payment-provider.md)
<!-- used-by:end -->
