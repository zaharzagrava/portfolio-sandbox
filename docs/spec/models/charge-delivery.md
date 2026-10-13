---
id: charge-delivery
title: Delivery of a payment's charge request
kind: model
status: draft
format: quint
file: docs/spec/models/charge-delivery.qnt
capability: S13
runs: [today:atMostOneCharge:pass, today:completedMeansCharged:pass, today:parkedIsVisible:violation, loud:parkedIsVisible:pass, loud:atMostOneCharge:pass, healthy:atMostOneCharge:pass, healthy:completedMeansCharged:pass]
---
# Delivery of a payment's charge request

The protocol that moves a charge request from the database to the payment provider ([`charge-delivery.qnt`](charge-delivery.qnt), a Quint model):
accepting a payment writes the payment and an outbox row in one transaction; a relay sends the row to a standard queue (at-least-once, so a message can arrive twice);
a worker takes a message and charges the payment only if it is still `PENDING`. Code: {{cap:S13}} `PaymentIntentService.accept`, the outbox relay of {{cap:S53}},
`ChargeCommandWorker`. See the concept {{concept:outbox-task-queue}}.

Re-check it: `python3 scripts/livespec/run_models.py` (needs Node; the first run downloads Quint). The `runs` list in the front matter says which invariant is
checked in which configuration and what the expected result is:

- **`atMostOneCharge`** and **`completedMeansCharged`** (safety): hold in every configuration, even when the queue delivers a message twice. The worker's check
  "charge only while `PENDING`" is what makes this true.
- **`parkedIsVisible`** (visibility): *violated* in `today`, the system as it was on 2026-10-12, where every send was rejected, the row was parked after the
  retries and nothing told an operator. It holds in `loud`, where a parked row is surfaced (a health check turns unready, an alert fires). That the `today` run is
  expected to find the violation documents a known gap: see the incident `docs/ops/incidents/2026-10-12-payment-stuck-pending.md`.

## What to build from it
- A parked outbox row must make the readiness check fail or raise an alert (the `loud` configuration). Today it does neither.
