# Lessons from failures

One entry per failure that taught something: what happened, the cause, and the check, test or rule that now prevents it. `prevented` means the prevention
exists and runs; `open` means it does not yet (and is on the roadmap in `docs/architecture/sdd-runbook.md`). The classes: `wiring` (components that do not fit
together), `config` (infrastructure that does not match the code), `test-hollow` (a test that cannot fail), `state-leak` (shared state between tests or runs),
`timing`, `resources`, `process`. A new lesson in a class that already has one is a **repeat**: count them.

| id | date | class | status |
|---|---|---|---|
| L-001 | 2026-10-12 | wiring | prevented |
| L-002 | 2026-10-12 | config | open |
| L-003 | 2026-10-12 | test-hollow | open |
| L-004 | 2026-10-12 | wiring | prevented |
| L-005 | 2026-10-12 | state-leak | prevented |
| L-006 | 2026-10-12 | state-leak | prevented |
| L-007 | 2026-10-12 | timing | prevented |
| L-008 | 2026-10-12 | resources | prevented |
| L-009 | 2026-10-12 | process | open |
| L-010 | 2026-10-12 | wiring | prevented |
| L-011 | 2026-10-12 | config | open |
| L-012 | 2026-10-12 | process | open |

## L-001 A message option the queue refuses, found only by hand
- **Symptom:** checkout stuck on "Payment is being processed…" for ever. **Cause:** the charge and refund requests carried a `groupId`, valid only on FIFO queues;
  the relay failed on every attempt and parked the row after ten, with nothing visible.
- **Prevention:** the outbox validates queue options when the task is created (`append-with-executor.ts`, `task-row.spec.ts`); each caller has a test that runs the
  real check (`payment-intent.service.spec.ts`, `refund-command.adapter.spec.ts`), verified to fail with the old mistake. Evidence:
  `docs/incidents/2026-10-12-payment-stuck-pending.md`, `77a6f03`, `f2b4a7c`.

## L-002 A queue the code uses but the local infrastructure does not define
- **Symptom:** the same stuck payment. **Cause:** `payments-charge`, `orders-refund-requested`, `tenancy-invite-requested` were missing from `elasticmq.conf`; the only
  signal was a repeated log line while `/health/ready` said ready.
- **Fixed by** `6886cde`. **Prevention missing:** a check that every queue the code names is defined in the infrastructure file, and a readiness check that fails
  while a consumed queue is missing (roadmap: "the infrastructure doctor").

## L-003 A test that passes whether or not the feature works
- **Symptom:** the checkout journey was green with a payment that never completed. **Cause:** it accepted "Payment is being processed…" **or** "Order
  confirmed"; the builder met an environment limit and encoded it as acceptable.
- **Prevention missing:** the journey must require "Order confirmed"; a rule and a check against either-or assertions; tests run once against a deliberately
  broken implementation (mutation testing on the money and identity code).

## L-004 A start-up path that no test loads
- **Symptom:** the API crashed at start (extensionless imports in the contracts package; an event type missing a flag the start-up check requires; a legacy hook that
  created the search index with an old mapping before the new bootstrap). **Cause:** the tests load modules through jest, not through the real start-up.
- **Prevention:** the cloud runner starts the real API before the loop and fails if it is not ready; `contracts` uses explicit `.ts` imports; the legacy index creator
  is removed. Evidence: `fda8b67`, `737b0cc`, `ed81d4b`.

## L-005 Tests that consume a shared resource nothing refills
- **Symptom:** checkout tests passed on a fresh stack and failed on re-runs (the repair loop re-runs the gate on the same stack). **Cause:** every order reserved stock of
  the same seeded product. **Prevention:** tests that place orders create a product with its own stock (`createIsolatedProduct` in `packages/web/tests/helpers.ts`).
  Evidence: `01807ea`.

## L-006 Tests that depend on what ran before them
- **Symptom:** product-page layout failed after other tests had recorded trending events; search pagination and suggestions failed on a fresh stack. **Cause:** shared
  state (a ranking rebuilt from a store a test cannot clear, a catalogue smaller than a page, a search history). **Prevention:** a test needing a known state creates its own
  data; the whole browser suite is run on an empty stack before a checkpoint. Evidence: `d600ba3`, `docs/architecture/sdd-runbook.md`.

## L-007 Assertions timed out on a loaded machine
- **Symptom:** four browser tests failed on the cloud machine only. **Cause:** two stacks and a dev server compiling pages on demand; the 5 s default is too short.
  **Prevention:** `PW_EXPECT_TIMEOUT_MS` (20 s) and 2 workers on the runner; the AS-14 redirect no longer waits for a load the redirect aborts. Evidence: `0eadaa3`, `989f3ed`.

## L-008 The regression sweep died of memory and looked like flaky tests
- **Symptom:** two backend suites failed with 503s, dropped connections and a negative timer; the sweep had run 67 of 201 suites. **Cause:** one Node process for all suites
  hit its 4 GB heap. **Prevention:** the sweep runs in batches of 12 suites, each in a fresh process; a batch without its summary fails the checkpoint
  (`checkpoint.sh`, `sweep-verdict.py`). **Open question:** why memory grows (roadmap).

## L-009 A failed checkpoint has no repair path
- **Symptom:** every checkpoint failure came to a person. **Cause:** the repair agent covers failures inside a capability's gate, not the checkpoint sweep.
  **Prevention missing:** hand the sweep's failures and the page snapshots to the repair agent (roadmap: follow-up 1).

## L-010 A race on first use
- **Symptom:** the chat page was empty the first time a chat was opened (fresh stacks only). **Cause:** in development React runs the page's effect twice; both asked to
  create the product's chat, and the second got a 400 "already exists". **Prevention:** the API answers 409 and the page opens the existing chat
  (`openProductChat`, `chat-view.test.ts`); the test uses its own product. Evidence: `65d02c3`.

## L-011 Missing database tables in the test stack
- **Symptom:** assistant and notification suites failed with "unconfigured table". **Cause:** the test-stack migration created Postgres and Dynamo, not the Cassandra
  schema. **Fixed by** `6266d1f`. **Prevention missing:** the doctor (L-002) should list the tables and keyspaces the code needs and compare.

## L-012 A fix verified on a warm environment
- **Symptom:** I debugged against a warm local stack for hours while the cloud machine, which starts fresh, kept failing. **Cause:** the reproduction did not match the
  environment where it failed. **Prevention missing:** a one-command "fresh stack, whole suite once" (`scripts/qa/fresh-run.sh`, the script used on 2026-10-12 lives
  only in the session scratch directory); make it a repository script.
