---
id: J01
title: Buyer pays for a multi-shop order; order paid → ledger journals → settlement → seller payout → monthly statement; buyer and sellers notified
kind: capability
status: draft
generated_at: ae229449
depends_on: [S10, S13, S14, S15, S16, S28, S49, S53]
concepts: [idempotency-key, outbox-task-queue, order-reservation, payment-lifecycle, projection-and-replay, job-scheduler-lease, tenant-shop-rbac]
models: []
scope:
---
# J01 - Buyer pays for a multi-shop order and each seller is paid

## Purpose
This journey proves the hand-offs between eight domains. A buyer fills a cart with products of two shops, checks out and pays. Each seller later receives a payout and sees the sale in a monthly statement. Buyer and sellers receive notices. Rules inside one domain belong to that domain's own page and are not re-tested here.

## Entry points
The facts list no routes or pages for this journey. The journey drives other capabilities through their public APIs and an operator control surface. The code files listed for it are infrastructure only.
- Checkout, payment intent, webhook, payout run, statement and notification calls: owned by {{cap:S10}}, {{cap:S13}}, {{cap:S15}}, {{cap:S16}} and {{cap:S28}}. This page owns none of them.
- Event chain `order.reserved` → `payments.payment_succeeded` / `ledger.journal_posted` → `order.paid` → `payout.paid` / `payout.failed`: carried by {{cap:S53}} through the {{concept:outbox-task-queue}}. [code: infra/debezium/outbox-connector.json]
- Operator control surface (consumer pause, resume and replay; allow-listed jobs; controllable clock): used by the tests to drive the chain. The tests G-26, G-30, G-31 and G-32 cover it.

## Rules
- **J01.R-01** [Checkout](../terms/post-checkout.md) MUST return `202` with an order in status [`RESERVED`](../terms/order-status.md) that [holds the stock](../terms/all-or-nothing-reservation.md). [proof: J01 AS-01]
- **J01.R-02** Payments MUST build [its own copy of the order](../terms/order-copy.md) from [order events](../terms/orders-events-topic.md); a missing copy answers [`404 order_not_found`](../terms/order-not-found.md) after at most 2 s. [proof: J01 AS-04]
- **J01.R-03** An order MUST become [`PAID`](../terms/order-status.md) only when payments reports the payment [`COMPLETED`](../terms/payment-status.md), by event or by [provider webhook](../terms/verified-webhook-event.md). [proof: J01 AS-01, J01 AS-02, J01 AS-03]
- **J01.R-04** An order MUST become `PAID` [exactly once](../terms/paid-mark.md), whatever the order of the two signals, and a [repeated webhook](../terms/webhook-redelivery.md) MUST answer `200` with no change. [proof: J01 AS-02, J01 AS-03]
- **J01.R-05** A late [`payment_intent.payment_failed`](../terms/payment-failed-event.md) signal for a paid order MUST answer `200` and MUST NOT cancel, [restock](../terms/stock-release.md) or notify. [proof: J01 AS-26]
- **J01.R-06** Payment success MUST post the [sale journal](../terms/journal-kind.md) in [the payment's own transaction](../terms/active-transaction.md), together with the [outbox events](../terms/event-row.md). [proof: J01 AS-05]
- **J01.R-07** The [ledger credit](../terms/ledger-posting.md) of each shop MUST equal the net of the [statement](../terms/provider-statement.md) for that shop. [proof: J01 AS-07, J01 AS-15]
- **J01.R-08** [Settlement](../terms/order-settlement.md) MUST NOT credit a shop for a [declined](../terms/definite-decline.md) or [hold-expired](../terms/hold-expired.md) order. [proof: J01 AS-06]
- **J01.R-09** The [payout run](../terms/payout-journal.md) MUST create at most one payout per shop and week, and a re-run or [overlapping run](../terms/cron-overlap-policy.md) MUST change nothing. [proof: J01 AS-20, J01 AS-21]
- **J01.R-10** A shop below the [minimum payout](../terms/payout-journal.md) MUST receive no payout and keep its balance, with [`blockedReason: "below_minimum"`](../terms/payout-journal.md). [proof: J01 AS-22]
- **J01.R-11** A rejected transfer MUST end the payout [`FAILED`](../terms/payout-status.md) with a [`failureCode`](../terms/failure-code.md) and MUST [reverse it in the books](../terms/reversing-journal.md). [proof: J01 AS-23]
- **J01.R-12** [Notices](../terms/notification.md) MUST go only to the buyer on [`order.paid`](../terms/order-paid-event.md) and [`payments.payment_failed`](../terms/payment-failed-event.md), to the [owners](../terms/shop-role.md) of each shop on `order.paid`, and to owners on [`payout.paid`](../terms/payout-paid-event.md) and [`payout.failed`](../terms/payout-failed-event.md). [proof: J01 AS-08, J01 AS-09, J01 AS-10]
- **J01.R-13** A declined payment, a [hold expiry](../terms/hold-expired.md) and a cancel during the charge MUST each end with the order [`CANCELLED`](../terms/order-status.md) and [the stock restored once](../terms/stock-release.md). [proof: J01 AS-17, J01 AS-18, J01 AS-19]
- **J01.R-14** Checkout and [payment intents](../terms/payment-intent.md) sent several times with [one key](../terms/idempotency-key.md) MUST create one order and one payment and return the same answer. [proof: J01 AS-24]
- **J01.R-15** [Replaying the topics](../terms/event-replay.md) MUST leave orders, payments, [balances](../terms/authoritative-balance.md), payouts and [statements](../terms/provider-statement.md) unchanged. [proof: J01 AS-25]
- **J01.R-16** A [paused consumer](../terms/partition-pause.md) MUST delay only its own effect; the order stays [`PAID`](../terms/order-status.md), and the effect appears once after resume. [proof: J01 AS-27, J01 AS-28]
- **J01.R-17** A month with [incomplete facts](../terms/code-facts.md) MUST NOT [close](../terms/ledger-period.md); a closed month MUST show [findings](../terms/boundary-finding.md) with no [`net_mismatch`](../terms/reconciliation-issue-kind.md), [`fee_mismatch`](../terms/reconciliation-issue-kind.md), [`missing_in_ledger`](../terms/reconciliation-issue-kind.md) or [`missing_in_statement`](../terms/reconciliation-issue-kind.md) for the journey. [proof: J01 AS-14, J01 AS-15]

## Behaviors
- **J01.B-01** Given a cart `{A: 2, B: 1}` of two shops, when the buyer calls [checkout](../terms/post-checkout.md) with a key, then the answer is `202`, the order is [`RESERVED`](../terms/order-status.md), [the total is 2500](../terms/order-total.md) and two [shop orders](../terms/shop-order.md) exist. [proof: J01 AS-01]
- **J01.B-02** Given the buyer pays, when the payment is [`COMPLETED`](../terms/payment-status.md), then the order becomes `PAID` and one [sale journal](../terms/journal-kind.md) exists. [proof: J01 AS-01, J01 AS-05]
- **J01.B-03** Given a paid order, when the provider's [signed success webhook ↗](../sw-external-terms.md#webhook-signature) arrives once or [ten times at once](../terms/webhook-redelivery.md), then every answer is `200` and the order is unchanged. [proof: J01 AS-02]
- **J01.B-04** Given a slow payment, when the [webhook ↗](../sw-external-terms.md#webhook-event) arrives before completion, then orders retries until payments reports [`COMPLETED`](../terms/payment-status.md) and then marks the order paid. [proof: J01 AS-03]
- **J01.B-05** Given the [payments consumer](../terms/payments-events-consumer.md) is paused, when the buyer posts an [intent](../terms/payment-intent.md), then the answer is [`404 order_not_found`](../terms/order-not-found.md); after [catch-up](../terms/cron-catch-up.md) the [same key](../terms/idempotency-key.md) succeeds. [proof: J01 AS-04]
- **J01.B-06** Given a paid order, when [settlement](../terms/order-settlement.md) runs, then the [shop balance](../terms/get-shop-balance.md) shows the credit and the [statement](../terms/provider-statement.md) [`own.netMinor`](../terms/minor-units.md) equals it. [proof: J01 AS-05, J01 AS-07]
- **J01.B-07** Given a paid order, when notices are [routed](../terms/notification-routing.md), then the buyer holds one [`order.confirmed`](../terms/notification-type.md), each [shop owner](../terms/shop-role.md) one [`shop.order_received`](../terms/notification-type.md), and [staff](../terms/shop-role.md) none. [proof: J01 AS-08]
- **J01.B-08** Given a declined card, when payment fails, then the order is [`CANCELLED`](../terms/order-status.md) with reason [`payment_failed`](../terms/payment-failed-event.md), the buyer holds one [`payment.failed`](../terms/notification-type.md) and no seller is [credited](../terms/ledger-posting.md). [proof: J01 AS-17, J01 AS-09, J01 AS-06]
- **J01.B-09** Given a cancel while a [slow charge](../terms/payment-capture.md) runs, when the [provider](../terms/payment-provider.md) answers later, then the order stays cancelled and the [stock returns once](../terms/stock-release.md). [proof: J01 AS-18]
- **J01.B-10** Given a [reserved order](../terms/all-or-nothing-reservation.md) and a clock advanced by 16 minutes, when the [expiry job](../terms/hold-expired.md) runs, then the order is `CANCELLED` with reason [`hold_expired`](../terms/hold-expired.md) and a new intent answers [`409 order_not_payable`](../terms/order-not-payable.md). [proof: J01 AS-19]
- **J01.B-11** Given a [balance](../terms/authoritative-balance.md) above the [minimum](../terms/payout-minimum.md), a [destination](../terms/payout-destination.md) set and 49 hours elapsed, when the [operator](../terms/operator.md) runs [`payouts.run-weekly`](../terms/payouts-run-weekly-job.md), then one [payout](../terms/payout-journal.md) is paid and the owner holds one [`payout.paid`](../terms/notification-type.md) notice. [proof: J01 AS-20, J01 AS-10]
- **J01.B-12** Given the run is requested again or twice at once, then each job ends [`SUCCEEDED`](../terms/job-status.md) with no second payout, [transfer](../terms/payout-transfer.md) or notice. [proof: J01 AS-21]
- **J01.B-13** Given a destination the provider rejects, when the [run and send job](../terms/payouts-run-weekly-job.md) execute, then the payout is [`FAILED`](../terms/job-status.md), the [books are reversed](../terms/reversing-journal.md) and the owner holds one [`payout.failed`](../terms/notification-type.md). [proof: J01 AS-23, J01 AS-10]
- **J01.B-14** Given a paid order, when the owner reads the current month, then the statement is [`OPEN`](../terms/ledger-period.md) with [`source: live`](../terms/balance-source.md), [`own.grossMinor = 2000`](../terms/minor-units.md) and [`own.lineCount = 1`](../terms/delivery-line.md). [proof: J01 AS-13]
- **J01.B-15** Given the clock passes 02:00 UTC on the 2nd, when [the operator](../terms/operator.md) [closes the month](../terms/ledger-period.md), then the period closes once and [the findings tie out](../terms/boundary-finding.md). [proof: J01 AS-14, J01 AS-15]
- **J01.B-16** Given [the settlement consumer](../terms/settlement-consumer.md) is paused, when a purchase runs to [`PAID`](../terms/order-status.md), then [the seller balance](../terms/authoritative-balance.md) shows no credit and [the consumer lag](../terms/ledger-lag-metric.md) is at least 1 until resume. [proof: J01 AS-27]

## Lifecycles
This journey owns no status. It observes order (`RESERVED`, `PAID`, `CANCELLED`), payment (`COMPLETED`, `FAILED`), payout (`PAID`, `FAILED`) and statement period (`OPEN`, closed) statuses. The owning capabilities move them. See {{concept:payment-lifecycle}} and {{concept:order-reservation}}.

## Owns
- No tables, queues or topics of its own.
- Infrastructure files: the Debezium outbox connector (`infra/debezium/outbox-connector.json`) and the ElasticMQ configuration (`infra/docker/elasticmq/elasticmq.conf`).
- Reads configuration for the local stack: the controllable clock (enabled only by configuration, refused in production) and the provider doubles.

## Decisions
- The journey tests only the hand-offs; each domain's inner rules stay in its own spec, to avoid duplicate proof.
- Payments uses its own copy of the order built from events, not a synchronous call into orders, so the domains stay decoupled.
- The sale journal posts in the payment's own transaction, so a payment never exists without its books.
- Two paths (event and webhook) mark an order paid, and the result is the same in any order.
- Every consumer is idempotent and discards older versions, so replays and retries are safe ({{concept:idempotency-key}}, {{concept:projection-and-replay}}).
- Operators can pause, resume and replay consumers and run allow-listed jobs on demand ({{concept:job-scheduler-lease}}).

## Known gaps
- The facts list no test files for the code of the chain, and the "Facts read from the code" section is empty. No rule is tied to a code symbol.
- AS-29 (UI journey, P3) has a test in `buy-to-payout.spec.ts` but this page does not describe its steps.
- AS-30 (metrics and consumer lag 0, P3) and AS-31 (static gates, P3) have tests, but this page states no rule for them.
- Requirements FR-018 (maximum time per hop), FR-024 (visibility per user and shop) and FR-025 (no sensitive data in events and logs) have no scenario proof here.
- FR-016 (automatic refund of a payment completed for a non-payable order) is described by AS-18, but this page does not verify that the refund task runs.
- FR-008 (balance freshness `asOf`) and FR-011 (`dataAsOf` watermark) have no named assertion in the facts.
- The `statements-facts` pause case of AS-28 is truncated in the facts; its exact outcome is unverified here.