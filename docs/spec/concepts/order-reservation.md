---
id: order-reservation
title: Orders, reservations and stock
kind: concept
status: draft
defined_by: S10
---
# Orders, reservations and stock
## Definition
An order turns a cart into a hold on stock. Checkout creates one order, splits it into one shop order per seller, and reserves stock for 15 minutes. The reservation is all or nothing. Stock changes only through the catalog stock command. An unpaid hold expires and returns its stock once. Only the payment provider's verified webhook marks an order paid. Capabilities that read order statuses or react to order events can rely on these guarantees.

## Rules
- **order-reservation.C-01** Stock MUST change only through the [catalog stock command](../terms/catalog-stock-command.md), with [operations sorted by ascending product ID](../terms/stock-operation-ordering.md), one per product, with IDs [`orders:<orderId>:reserve:<productId>`](../terms/stock-operation-id.md).
- **order-reservation.C-02** A reservation MUST be [all or nothing](../terms/all-or-nothing-reservation.md): if any line is short, no stock is held, the order is [`CANCELLED(out_of_stock)`](../terms/order-status.md), and the buyer gets [`422 out_of_stock`](../terms/out-of-stock-error.md).
- **order-reservation.C-03** Stock MUST NOT go below 0.
- **order-reservation.C-04** An unpaid [`RESERVED`](../terms/order-status.md) order MUST be cancelled with reason [`hold_expired`](../terms/hold-expired.md) at [`reservedUntil`](../terms/reserved-until.md), 15 minutes after reservation, and [its stock MUST return once](../terms/stock-release.md).
- **order-reservation.C-05** Cancelling MUST move [`HELD`](../terms/reservation-status.md) reservations to [`RELEASE_PENDING`](../terms/reservation-status.md) in the same transaction, and a [retry job](../terms/job-retries.md) MUST release failures.
- **order-reservation.C-06** An order stuck in [`PENDING`](../terms/order-status.md) for more than 60 s MUST be [recovered by repeating the same stock operations](../terms/pending-order-recovery.md).
- **order-reservation.C-07** Only a [verified webhook event](../terms/verified-webhook-event.md) whose payment status, amount and currency match the order MUST mark it [`PAID`](../terms/order-status.md); a mismatch is stored as [`REJECTED`](../terms/rejected-payment-event.md).
- **order-reservation.C-08** The [order statuses](../terms/order-status.md) are `PENDING`, `RESERVED`, `PAID`, `FULFILLING`, `SHIPPED`, `DELIVERED`, `CANCELLED` and `REFUNDED`; the backend moves them and the web app MUST only show them.

## How the capabilities use it
- {{cap:S05}} owns the stock fields and the exported stock command. Other domains change stock only through it. No line in its page links this concept.
- {{cap:S10}} defines the concept: it reserves stock at checkout, expires holds, releases stock, and marks orders paid from the webhook.
- {{cap:S13}} charges a reserved order and reports the result to the buyer and the order system.
- {{cap:W03}} shows the order statuses `PENDING` "Processing", `RESERVED` "Awaiting payment", `PAID` "Paid", `FULFILLING` "Preparing", `SHIPPED` "Shipped", `DELIVERED` "Delivered", `CANCELLED` "Cancelled" and `REFUNDED` "Refunded".

## Known gaps
- The facts for S05 give no line that links this concept, so how S05 applies the stock command to a reservation is not stated.
- The facts for S13 state no rule on how payment results change an order.
- The facts do not say which capability moves orders to `FULFILLING`, `SHIPPED` and `DELIVERED`.

## Used by
<!-- used-by:start -->
- {{cap:J01}} Buyer pays for a multi-shop order; order paid → ledger journals → settlement → seller payout → monthly statement; buyer and sellers notified
- {{cap:S05}} Product CRUD, pricing, stock fields, product cache and invalidation, product views
- {{cap:S10}} Cart (guest + merge), idempotent checkout, stock reservation, multi-shop split, order state machine, payment webhook
- {{cap:S11}} Flash sales (scheduled drops, bucketed fast stock, admission, never oversell, async reconciliation)
- {{cap:S13}} Payment intents, idempotency, unknown outcomes, PSP circuit breaker, outbox, saga with orders
- {{cap:S21}} Limited-drop auctions (proxy bids, anti-sniping, reserve, exactly-once close, second chance, shill guard)
- {{cap:W03}} Cart (guest and merged on login), checkout with idempotent submit and async payment status, success page, order history, notification popover
<!-- used-by:end -->
