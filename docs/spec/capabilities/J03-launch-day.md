---
id: J03
title: Launch day: waiting room and seat booking, flash-sale purchase without overselling, live stream comments, an auction closing with the winner's checkout, and the notifications each triggers
kind: capability
status: draft
generated_at: 210bca49
depends_on: [S03, S10, S11, S13, S21, S22, S23, S28, S49, S51, S53, J01]
concepts: [idempotency-key, outbox-task-queue, projection-and-replay, job-scheduler-lease, realtime-topic-stream, order-reservation, transaction-runner, tenant-shop-rbac]
models: []
scope:
---
# J03 - Launch day journey
## Purpose
A brand runs a launch day: buyers queue for seats and book them, a limited drop sells exactly its units, the brand goes live and the audience chats, and an auction for one unit closes with the winner's checkout. Every step that matters to a buyer or the brand ends in a notification. This page covers only the hand-offs between the domains ({{cap:S22}}, {{cap:S11}}, {{cap:S23}}, {{cap:S21}}, {{cap:S28}}). Each domain's own rules belong to its capability page.

## Entry points
The facts list no routes or pages for this capability, so no route is named in backticks. The work-order specification describes these flows. Only the journey test `launch-day.journey-spec.ts` is confirmed in the facts.
- Seat booking: a buyer joins the queue of a launch event, receives an admission token, holds seats, and confirms the hold. Confirmation emits `launch_events.booking_confirmed` and a voucher command to orders.
- Flash-sale drop: a brand schedules a drop. The job `flash-sale.load` moves stock. Buyers check out. The jobs `orders.expire-reservation`, `flash-sale.end` and `flash-sale.reconcile` return units.
- Live stream: the brand starts and ends a stream. Viewers receive comments, pins and removals through an event stream.
- Auction: the job `auctions.close` closes the auction. The winner's settlement order is paid through the J01 chain. Orders emits `order.paid` or `order.cancelled`, and the auctions consumer reacts.
- Notifications: the consumer group `notification-router` turns events into inbox items.
- Control surface (test and local use): allow-listed jobs, consumer pause, resume and lag, and a read-only event tap. Tests G-40, G-41 and G-42 cover the admin job, topic and consumer endpoints.

## Rules
- **J03.R-01** Confirming a [hold](../terms/booking-hold.md) MUST write the bookings, [`launch_events.booking_confirmed`](../terms/launch-events-booking-confirmed-event.md) and the [voucher command](../terms/voucher-command.md) in one [transaction ↗](../sw-external-terms.md#database-transaction), with no network call inside it. [proof: J03 AS-02, J03 AS-07]
- **J03.R-02** A [hold](../terms/booking-hold.md) confirmed several times, with the [same key](../terms/idempotency-key.md) or with different keys at once, MUST return the same booking ids and create one [booking set](../terms/booking-set.md). [proof: J03 AS-03]
- **J03.R-03** The last seat MUST move the event from [`ON_SALE`](../terms/launch-event-status.md) to [`SOLD_OUT`](../terms/launch-event-status.md) exactly once. [proof: J03 AS-04]
- **J03.R-04** An [unconfirmed hold](../terms/booking-hold.md) MUST free its seats at expiry. Confirming it afterwards MUST answer [`409 HOLD_EXPIRED`](../terms/booking-hold-expired.md) and produce no booking, event, [notice](../terms/notification.md) or [voucher](../terms/voucher-command.md). [proof: J03 AS-05]
- **J03.R-05** The [admission token](../terms/admission-token.md) MUST bind to one event and one buyer. The hold route MUST answer [`403 ADMISSION_REQUIRED`](../terms/admission-token.md) for an [ordinary access token](../terms/access-token.md), another event's token or another buyer's token. [proof: J03 AS-09]
- **J03.R-06** Scheduling a [drop](../terms/drop.md) MUST NOT move stock. [Loading](../terms/drop-load.md) MUST lower product stock exactly once. End and [reconcile](../terms/drop-reconcile.md) MUST return only the unsold units, once. [proof: J03 AS-10, J03 AS-15]
- **J03.R-07** A drop MUST sell exactly its [loaded units](../terms/drop-load.md). A refused buyer MUST create no order and receive [`422 out_of_stock`](../terms/out-of-stock-error.md). [proof: J03 AS-11]
- **J03.R-08** A [lapsed drop hold](../terms/drop-hold.md) MUST release its units once and notify the buyer. [Paid units](../terms/drop-load.md) MUST stay sold. [proof: J03 AS-12, J03 AS-14]
- **J03.R-09** A [failed drop load](../terms/drop-load.md) MUST leave catalog stock untouched and end the sale as [`START_FAILED(insufficient_stock)`](../terms/start-failed.md). [proof: J03 AS-17]
- **J03.R-10** Closing an auction MUST be one [conditional transition](../terms/conditional-transition.md), safe under [duplicate triggers](../terms/duplicate-triggers.md), producing one [`auction.closed`](../terms/auction-closed-event.md), one [winner order](../terms/winner-order.md) and one [`auction.won`](../terms/auction-won-notice.md) notice. [proof: J03 AS-31, J03 AS-32]
- **J03.R-11** An auction with a leader below the [reserve](../terms/auction-reserve.md) MUST end as [`UNSOLD(reserve_not_met)`](../terms/auction-unsold.md) with no order, no [award notice](../terms/award-notice.md) and [the unit returned](../terms/stock-release.md). [proof: J03 AS-35]
- **J03.R-12** [A member of the selling shop](../terms/shop-member.md) MUST NOT bid ([`403 shill_bid_forbidden`](../terms/shill-bid-forbidden.md)), and MUST NOT receive the award. [proof: J03 AS-29]
- **J03.R-13** An auction MUST reach [`SOLD`](../terms/auction-sold.md) only on a matching [`order.paid`](../terms/order-paid-event.md). An unpaid winner order leads to [`SECOND_CHANCE`](../terms/second-chance.md) or [`UNSOLD`](../terms/auction-unsold.md), and the second chance is offered at most once. [proof: J03 AS-33, J03 AS-34, J03 AS-36]
- **J03.R-14** Every [consumer](../terms/event-consumer.md) MUST be [idempotent ↗](../sw-external-terms.md#idempotency). [Replaying a topic](../terms/event-replay.md) MUST leave [inboxes](../terms/inbox-item.md), [unread counts](../terms/unread-count.md) and [vouchers](../terms/voucher.md) unchanged. [proof: J03 AS-08, J03 AS-36]
- **J03.R-15** A [paused consumer](../terms/partition-pause.md) MUST lose nothing. [Source data](../terms/source-of-truth.md) exists at once, [lag](../terms/consumer-lag.md) is visible, and after resume [each fact applies once](../terms/fact.md). [proof: J03 AS-06, J03 AS-07, J03 AS-18, J03 AS-25, J03 AS-36]
- **J03.R-16** [Facts](../terms/fact.md) with no notification by decision (stream start and end, comments, [holds and expiries](../terms/reservation-hold.md), unsold auctions, [a refused leader](../terms/refused-leader.md)) MUST produce no [inbox item](../terms/inbox-item.md). [proof: J03 AS-05, J03 AS-26, J03 AS-29, J03 AS-35]
- **J03.R-17** A retried [checkout](../terms/post-checkout.md) with the [same key](../terms/idempotency-key.md) MUST create exactly one order. [proof: J03 AS-13]
- **J03.R-18** A comment retried with the same [`clientId`](../terms/comment-client-id.md) and text MUST create one comment. A different text with that `clientId` MUST answer [`422 client_id_reused`](../terms/client-id-reused.md). [proof: J03 AS-21]
- **J03.R-19** A [removed or moderated comment](../terms/comment-moderation.md) MUST NOT appear in [recent comments](../terms/recent-comments.md) or history, whatever the order of post and removal. [proof: J03 AS-23, J03 AS-24, J03 AS-25]
- **J03.R-20** [Concurrent flows on one stack](../terms/flow-isolation.md) MUST NOT cross: [seats](../terms/seat.md), [units](../terms/auction-unit.md), comments and bids of one flow never alter another. [proof: J03 AS-38]

## Behaviors
- **J03.B-01** Given 12 buyers [in the queue](../terms/buyer-queue.md) and sales open, when the [admitter](../terms/admitter.md) runs, then buyers receive tickets, [hold](../terms/seat-hold.md) seats with the [admission token](../terms/admission-token.md) and confirm. [proof: J03 AS-01]
- **J03.B-02** Given a confirmed booking, when the event reaches notifications and orders, then the buyer has one [`booking.confirmed`](../terms/booking-confirmed-notification.md) [item](../terms/inbox-item.md) and one [voucher](../terms/voucher.md). [proof: J03 AS-02]
- **J03.B-03** Given a buyer confirms five times at once with [one key](../terms/idempotency-key.md) and ten more times with other keys, then every answer carries the same `bookingId`s. [proof: J03 AS-03]
- **J03.B-04** Given one seat left and five simultaneous confirms, then the event is [`SOLD_OUT`](../terms/sold-out.md) once. [proof: J03 AS-04]
- **J03.B-05** Given a [hold](../terms/seat-hold.md) unconfirmed for 10 minutes, then the seat is free again and the confirm answers [`409 HOLD_EXPIRED`](../terms/seat-hold-expired.md). [proof: J03 AS-05]
- **J03.B-06** Given the notification or [voucher](../terms/voucher.md) [consumer](../terms/event-consumer.md) is paused, when a buyer confirms, then the booking exists at once and the notice or voucher arrives after resume. [proof: J03 AS-06, J03 AS-07]
- **J03.B-07** Given a [drop](../terms/drop.md) of 20 units and 60 simultaneous checkouts, then exactly 20 answer [`202 RESERVED`](../terms/reserved-answer.md) with total 2500 and 40 answer [`422 out_of_stock`](../terms/out-of-stock-error.md). [proof: J03 AS-11]
- **J03.B-08** Given paid [drop orders](../terms/drop.md), then each payer has one [`order.confirmed`](../terms/order-confirmed-notification.md) item and the [owner](../terms/shop-role.md) has one [`shop.order_received`](../terms/shop-order-received-notification.md) item. [proof: J03 AS-12]
- **J03.B-09** Given 15 unpaid [drop orders](../terms/drop.md), when 15 minutes pass, then they become [`CANCELLED(hold_expired)`](../terms/hold-expired.md), units return and buyers are told. [proof: J03 AS-14]
- **J03.B-10** Given a sale reaching 0 units, then the [owner](../terms/shop-role.md) has one [`shop.flash_sale_sold_out`](../terms/flash-sale-sold-out-notification.md) item and [staff](../terms/shop-role.md) have none. [proof: J03 AS-16]
- **J03.B-11** Given a [drop](../terms/drop.md) whose product stock fell below its units after scheduling, when the [load job](../terms/load-job.md) runs, then the sale is [`START_FAILED(insufficient_stock)`](../terms/insufficient-stock.md). [proof: J03 AS-17]
- **J03.B-12** Given bids of 10000, 5000 and 12000, then the price follows [proxy bidding](../terms/proxy-bidding.md) and the [outbid leader](../terms/outbid-event.md) is told once. [proof: J03 AS-28]
- **J03.B-13** Given a bid inside the [anti-sniping window](../terms/anti-sniping-window.md), then [`endsAt`](../terms/ends-at.md) moves later and the original [close job](../terms/close-job.md) does nothing. [proof: J03 AS-30]
- **J03.B-14** Given a leader at or above the [reserve](../terms/auction-reserve.md), when the end passes, then the auction is [`CLOSED`](../terms/auction-status.md), the winner has one order and one [`auction.won`](../terms/auction-won-event.md) notice. [proof: J03 AS-31]
- **J03.B-15** Given the winner pays, then the auction becomes [`SOLD`](../terms/auction-status.md) and the owner and winner are told. [proof: J03 AS-33]
- **J03.B-16** Given a winner who does not pay within 48 hours, then the order is [`CANCELLED(hold_expired)`](../terms/hold-expired.md) and the [runner-up](../terms/runner-up-offer.md) at or above the reserve gets one chance. [proof: J03 AS-34]
- **J03.B-17** Given a buyer who [books seats](../terms/seat.md), buys a drop unit and wins and pays an auction, then the [inbox](../terms/inbox-item.md) holds exactly the expected items once each. [proof: J03 AS-37]
- **J03.B-18** Given a posted comment, then viewers receive it, [late joiners](../terms/replay-buffer.md) see it and [history](../terms/chat-history.md) stores it. [proof: J03 AS-20]
- **J03.B-19** Given a [stream](../terms/live-stream.md) start, [pin](../terms/stream-pin.md) and end, then viewers receive the matching events and the connection closes at the end. [proof: J03 AS-19, J03 AS-22, J03 AS-26]

## Lifecycles
- Launch event: `SCHEDULED`, `ON_SALE`, `SOLD_OUT` or `CLOSED`. The sales-time job, the last booking and the organizer move it.
- Drop: `SCHEDULED`, loaded, ended or reconciled, or `START_FAILED`. Jobs move it.
- Auction: `CLOSED`, then `SOLD`, `SECOND_CHANCE` or `UNSOLD`. The close job and the order events move it.

## Owns
This journey owns no table, queue or event. It reads the events `launch_events.booking_confirmed`, `order.paid`, `order.cancelled`, `auction.closed` and `flash_sale.sold_out`. It also reads the topics `launch-events.events`, `orders.events` and `live.events`. Consumer groups: `notification-router`, `orders-booking-voucher`, `live-comments-history`, `auctions-order-results`. The facts list one file: `infra/docker/elasticmq/elasticmq.conf`.

## Decisions
- The journey proves only hand-offs. Each domain's own rules stay with its capability page.
- Notifications derive only from events, so a consumer outage delays a notice but never blocks a booking, purchase or award.
- Events are appended in the transaction of the state change, so no fact exists without its event.
- Time comes only from the injected platform clock, so tests make holds, windows and auctions due.
- Every scarce or creating request carries a key, so retries are safe.

## Known gaps
- Proofs for rules R-01 to R-20 name the single journey test file. Statements from the full scenario texts are cut off in the facts, so some details are unconfirmed.
- AS-39 (metrics counters) and AS-40 (static gates) are P3 and have no rule here.
- The facts list no routes, so route names and status codes beyond those quoted are not confirmed.
- The facts list no code symbols, so no `` link appears.
- Hop time limits (FR-025) and the privacy rules of FR-029 and FR-030 (no admission token, e-mail or maximum in events) have no rule here.
- Tests G-04, G-05, G-26, G-43 and G-44 carry ids, but their statements are not in the facts.

### Claims the generator could not verify (removed from the rules above)
- code ref `...` (file not found: ...)
