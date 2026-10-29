# arch-27. Travel booking saga: flight, hotel and car

*Distributed Systems · Medium*

## The question

"A customer books a trip package: a flight, a hotel and a car hire, paid with one card, $800-4,000 in total. Each part comes from a different supplier API (an airline through a GDS or NDC aggregator, a hotel wholesaler, a car hire broker). Each call takes 2-30 seconds or times out, and none of them takes part in our transactions. Design the booking so a failure at any step leaves the customer with either the whole trip or nothing charged, and every state is explainable."

**Then:** "The flight is ticketed and the hotel confirmed, but 3 hours later the hotel supplier cancels the room (overbooked). What now?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- All-or-nothing? → assume: yes at booking time. After confirmation, supplier changes are new business events, not a rollback.
- Which steps can be undone, and at what cost? → assume: a flight can be held (a PNR with a ticketing time limit) and released free before ticketing; once ticketed, many airlines allow a void only the same day or within ~24 h, varying by airline and market; after that, fare rules apply. Hotel and car bookings on refundable rates cancel free within a window. So ticketing is the step to do last.
- Payment model? → assume: we are merchant of record for the package and pay suppliers ourselves. Authorize the card first, capture after everything is confirmed. Authorization validity varies by card network and merchant category (often around 7 days for online payments).
- Latency target? → assume: the customer sees "confirming your trip" for up to ~60 s, then an email if it takes longer.
- Volume? → assume: ~5 bookings/s at peak. Not a scale problem; a correctness problem.
- Who owns the flow? → assume: the booking service.

## Design

**Orchestration with a durable state machine in the booking service's Postgres.**
```sql
trip_bookings(
  id uuid PRIMARY KEY, state text, version int,
  payment_auth_id text, pnr text, hotel_ref text, car_ref text,
  deadline_at timestamptz, attempts int, last_error text)
-- created → authorized → flight_held → hotel_booked → car_booked
--   → ticketed → captured → confirmed
-- side exits: compensating → cancelled | needs_review
```
Each step = guarded state change + outbox command in **one transaction**:
```sql
UPDATE trip_bookings SET state = 'flight_held', pnr = $2, version = version + 1
WHERE id = $1 AND state = 'authorized';   -- 0 rows → duplicate or late reply, ignore
INSERT INTO outbox (...) VALUES ('BookHotel', key = 'hotel:' || $1, ...);
```
Workers make the supplier calls outside any transaction and report results as events.

**Step order: reversible first, the pivot late.**
1. Authorize the card (undo = void the authorization, free).
2. Hold the flight: create the PNR, record its ticketing time limit as `deadline_at`.
3. Book the hotel (refundable rate), then the car. Each request carries our booking reference as the supplier's client reference.
4. **Ticket the flight: the pivot.** After it, the flow only moves forward.
5. Capture the payment; send the confirmation.

**Compensations (run in reverse, each idempotent and retried until done)**
| Failure | Compensation |
|---|---|
| Hotel fails | release PNR, void authorization |
| Car fails | offer "continue without car" while the PNR hold lasts; else cancel hotel, release PNR, void |
| Ticketing fails | cancel car and hotel, release PNR, void |
| Capture fails after ticketing | retry forward; then `needs_review` (we owe the airline) |

**Timeouts are "unknown".** Before retrying or compensating, the worker looks the booking up at the supplier by our reference. A timer job scans `deadline_at < now()` for expiring holds and authorizations.

## Deep dives

**1. Orchestration vs choreography vs 2PC.** Chosen: one orchestrator that holds state, deadlines and the answer to "where is this booking?". Choreography (each service reacts to the previous event) works for two steps; with four suppliers, deadlines and compensations, the logic spreads across services and nobody can say why a booking is stuck. Rejected: 2PC. Suppliers don't take part in our transactions, and nobody holds locks for 30-second supplier calls.

**2. Where the pivot goes.** The ticket is the step that is expensive or impossible to undo, so everything before it must be cheap to undo: a card authorization, a held PNR, refundable hotel and car rates. Rejected: ticket first "because seats sell out". The PNR hold already reserves the seat; ticketing first turns every later hotel failure into a void or refund and a customer complaint.

**3. Compensating something you aren't sure exists.** A hotel call times out. If you compensate by "cancel nothing" you may leave a live booking we pay for; if you retry with a new request you may book two rooms. Chosen: every request carries our booking reference; on timeout, retrieve by that reference, then decide. Compensations themselves can fail, so they are commands in the same outbox with retries, and a failed compensation ends in `needs_review` with an alert, never silently.

## Traps

- 2PC or one "distributed transaction" across suppliers.
- Ticketing the flight before the hotel and car are confirmed.
- Treating a timeout as a failure: retrying books twice, compensating may cancel nothing.
- Calling suppliers inside the database transaction.
- No deadlines: PNR holds and card authorizations expire while the saga waits.
- Capturing the card before all parts are confirmed: a later failure becomes a refund instead of a free void.

## Say it (60–90 s)

I'd orchestrate it with a state machine in the booking service's database: one row per trip, with a state, a version and a deadline. Each step is one transaction that does a guarded state update and writes an outbox command; a duplicate or late reply updates zero rows and is ignored. Workers make the supplier calls outside any transaction. The order matters: I start with steps that are cheap to undo. Authorize the card, hold the flight without ticketing, book the hotel and the car on refundable rates, and only then ticket the flight, because a ticket is the step that's expensive to undo. Capture comes last. If something fails before ticketing, compensations run in reverse: cancel the car and hotel, release the flight hold, void the authorization, so no money moved. After ticketing, we only go forward. Every supplier request carries our booking reference, so a timeout is treated as unknown: we look the booking up by that reference before retrying or cancelling. Compensations are retried commands too, and anything that can't finish lands in needs-review with an alert. A timer job watches hold and authorization deadlines.

## Follow-ups

**Q:** Then: the hotel supplier cancels 3 hours after confirmation.
**A:** The booking saga is finished, so this is a new process, not a rollback. `HotelCancelledBySupplier` opens a disruption case: search the same area and dates for an equal or better room and offer it at no extra cost (our contract with the supplier usually decides who pays the difference), or refund the hotel part as a partial refund on the captured payment. If the customer wants to cancel the whole trip, check the flight's void window first; after it, fare rules decide, and the cost goes to the case, not to the customer.

**Q:** Why not Temporal or Step Functions?
**A:** Worth it with many long-running workflows. For one flow, a table, an outbox and a timer job are fewer moving parts. Step Functions Standard workflows can run up to a year, so they also fit if we're already on AWS-native tooling.

**Q:** How do you find stuck bookings?
**A:** A metric of bookings per state older than that state's SLA, an alert on any `needs_review`, and an admin view showing each booking's transition history and supplier references.

</details>

## Theory in the notes

- [06-distributed-systems/02-consistency-sagas-and-data-sync.md](../../06-distributed-systems/02-consistency-sagas-and-data-sync.md)
- [10-system-design/07-commerce-and-transactions.md](../../10-system-design/07-commerce-and-transactions.md)
- [06-distributed-systems/01-messaging-queues-kafka-sqs.md](../../06-distributed-systems/01-messaging-queues-kafka-sqs.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
