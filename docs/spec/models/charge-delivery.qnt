// The delivery of a payment's charge request: payment row and outbox row are written together; a relay moves the outbox row to a standard queue
// (at-least-once, so a message may be delivered twice); a worker takes a message and charges the payment through the provider.
// Code: PaymentIntentService.accept (payments), OutboxPublisherService (outbox relay), ChargeCommandWorker (worker).
//
// Safety, which must hold in every configuration:
//   atMostOneCharge        a payment is never charged twice, however often its message is delivered (the worker is idempotent)
//   completedMeansCharged  a payment is only COMPLETED after the provider was called
// Visibility, which a design must give: parkedIsVisible says that a parked outbox row is always surfaced (health check, alert). The `today` instance models
// the system as it was on 2026-10-12 (a deterministic send failure parks the row and nobody is told): the invariant is violated there, on purpose, and holds in `fixed`.
module delivery {
  const MAX_ATTEMPTS: int
  const QUEUE_REJECTS: bool       // every send fails (the groupId on a standard queue, or a queue that does not exist)
  const SURFACES_PARKED: bool     // a parked row is visible to operators
  const PAYMENTS: Set[str]

  var payment: str -> str         // "none" | "PENDING" | "COMPLETED"
  var row: str -> str             // "none" | "pending" | "published" | "parked"
  var attempts: str -> int
  var queue: str -> int           // messages in the queue, per payment
  var charges: str -> int         // provider calls, per payment
  var visible: Set[str]           // parked rows an operator can see

  action init = all {
    payment' = PAYMENTS.mapBy(p => "none"),
    row' = PAYMENTS.mapBy(p => "none"),
    attempts' = PAYMENTS.mapBy(p => 0),
    queue' = PAYMENTS.mapBy(p => 0),
    charges' = PAYMENTS.mapBy(p => 0),
    visible' = Set(),
  }

  // accepting a payment writes the payment and its outbox row in one transaction
  action accept(p) = all {
    payment.get(p) == "none",
    payment' = payment.set(p, "PENDING"),
    row' = row.set(p, "pending"),
    attempts' = attempts, queue' = queue, charges' = charges, visible' = visible,
  }

  action sendOk(p) = all {
    row.get(p) == "pending",
    not(QUEUE_REJECTS),
    row' = row.set(p, "published"),
    queue' = queue.set(p, queue.get(p) + 1),
    payment' = payment, attempts' = attempts, charges' = charges, visible' = visible,
  }

  // a failed send: retry later, park the row after MAX_ATTEMPTS
  action sendFail(p) = all {
    row.get(p) == "pending",
    attempts' = attempts.set(p, attempts.get(p) + 1),
    row' = row.set(p, if (attempts.get(p) + 1 >= MAX_ATTEMPTS) "parked" else "pending"),
    visible' = if (attempts.get(p) + 1 >= MAX_ATTEMPTS and SURFACES_PARKED) visible.union(Set(p)) else visible,
    payment' = payment, queue' = queue, charges' = charges,
  }

  // at-least-once delivery: the queue may hand the same message out again
  action duplicate(p) = all {
    queue.get(p) > 0,
    queue' = queue.set(p, queue.get(p) + 1),
    payment' = payment, row' = row, attempts' = attempts, charges' = charges, visible' = visible,
  }

  // the worker takes a message; it charges only a payment that is still PENDING (a repeat or a stale command does nothing)
  action receive(p) = all {
    queue.get(p) > 0,
    queue' = queue.set(p, queue.get(p) - 1),
    payment' = if (payment.get(p) == "PENDING") payment.set(p, "COMPLETED") else payment,
    charges' = if (payment.get(p) == "PENDING") charges.set(p, charges.get(p) + 1) else charges,
    row' = row, attempts' = attempts, visible' = visible,
  }

  action step = {
    nondet p = PAYMENTS.oneOf()
    any { accept(p), sendOk(p), sendFail(p), duplicate(p), receive(p) }
  }

  val atMostOneCharge = PAYMENTS.forall(p => charges.get(p) <= 1)
  val completedMeansCharged = PAYMENTS.forall(p => payment.get(p) != "COMPLETED" or charges.get(p) == 1)
  val parkedIsVisible = PAYMENTS.forall(p => row.get(p) != "parked" or visible.contains(p))
}

// 2026-10-12: every send is rejected and a parked row is only a database state
module today {
  import delivery(MAX_ATTEMPTS = 3, QUEUE_REJECTS = true, SURFACES_PARKED = false, PAYMENTS = Set("p1", "p2")).*
}

// the same rejection, but a parked row is surfaced (the health check turns unready, an alert fires)
module loud {
  import delivery(MAX_ATTEMPTS = 3, QUEUE_REJECTS = true, SURFACES_PARKED = true, PAYMENTS = Set("p1", "p2")).*
}

// a working queue
module healthy {
  import delivery(MAX_ATTEMPTS = 3, QUEUE_REJECTS = false, SURFACES_PARKED = true, PAYMENTS = Set("p1", "p2")).*
}
