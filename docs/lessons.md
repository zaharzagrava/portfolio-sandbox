# Lessons from failures

One entry per failure that taught something: what happened, the cause, and the check, test or rule that now prevents it. `prevented` means the prevention
exists and runs; `open` means it does not yet (and is on the roadmap in `docs/architecture/sdd-runbook.md`). The classes: `wiring` (components that do not fit
together), `config` (infrastructure that does not match the code), `test-hollow` (a test that cannot fail), `state-leak` (shared state between tests or runs),
`timing`, `resources`, `process`. A new lesson in a class that already has one is a **repeat**: count them.

Format (read by `scripts/lessons/digest.py` and `scripts/lessons/check.py`, see README_ME.md): the index below has one line per lesson, `- L-nnn date class status`.
Each entry is `## L-nnn title`, then a `**Rule:**` line (one sentence agents read), the symptom and cause, and a `**Prevention:**` (or `**Prevention missing:**`)
with the links that prove it: backticked file paths and commit hashes. For a `prevented` lesson every link must exist.

- L-001 2026-10-12 wiring prevented
- L-002 2026-10-12 config prevented
- L-003 2026-10-12 test-hollow open
- L-004 2026-10-12 wiring prevented
- L-005 2026-10-12 state-leak prevented
- L-006 2026-10-12 state-leak prevented
- L-007 2026-10-12 timing prevented
- L-008 2026-10-12 resources prevented
- L-009 2026-10-12 process open
- L-010 2026-10-12 wiring prevented
- L-011 2026-10-12 config open
- L-012 2026-10-12 process open
- L-013 2026-10-13 process prevented
- L-014 2026-10-13 process open

## L-001 A message option the queue refuses, found only by hand
- **Rule:** A queue option must be validated where the message is created, not discovered when the relay fails (FIFO-only options like `groupId` never go to a standard queue).
- **Symptom:** checkout stuck on "Payment is being processed…" for ever. **Cause:** the charge and refund requests carried a `groupId`, valid only on FIFO queues;
  the relay failed on every attempt and parked the row after ten, with nothing visible.
- **Prevention:** the outbox validates queue options when the task is created (`append-with-executor.ts`, `task-row.spec.ts`); each caller has a test that runs the
  real check (`payment-intent.service.spec.ts`, `refund-command.adapter.spec.ts`), verified to fail with the old mistake. Evidence:
  `docs/incidents/2026-10-12-payment-stuck-pending.md`, `77a6f03`, `f2b4a7c`.

## L-002 A queue the code uses but the local infrastructure does not define
- **Rule:** Every queue the code names must be defined in `elasticmq.conf`, and readiness must fail while a consumed queue is missing.
- **Symptom:** the same stuck payment. **Cause:** `payments-charge`, `orders-refund-requested`, `tenancy-invite-requested` were missing from `elasticmq.conf`; the only
  signal was a repeated log line while `/health/ready` said ready.
- **Fixed by** `6886cde`. **Prevention:** the static check `scripts/infra/doctor.py` (queues: none missing today; tested in `scripts/infra/test_doctor.py`); the live check
  `scripts/infra/doctor-live.sh` (a task waiting for a queue the queue server does not have, parked or stale outbox rows, dead-letter queues, readiness checks that are down)
  runs first and last in the scripted buy flow `scripts/sdd/checkpoints/buy-ui.sh` (a checkpoint step), which was verified to fail with the queue deleted and with `groupId` put back,
  and in every QA agent run (`scripts/qa/run.sh`). Not done: `/health/ready` itself still says ready; readiness is read through the doctor.

## L-003 A test that passes whether or not the feature works
- **Rule:** A test must be able to fail: never assert "A or B" where one branch means the feature does not work; report an environment limit as blocked.
- **Symptom:** the checkout journey was green with a payment that never completed. **Cause:** it accepted "Payment is being processed…" **or** "Order
  confirmed"; the builder met an environment limit and encoded it as acceptable.
- **Prevention missing:** the journey must require "Order confirmed"; a rule and a check against either-or assertions; tests run once against a deliberately
  broken implementation (mutation testing on the money and identity code).

## L-004 A start-up path that no test loads
- **Rule:** Start the real API (not only jest) before trusting a change to imports, event types or start-up hooks.
- **Symptom:** the API crashed at start (extensionless imports in the contracts package; an event type missing a flag the start-up check requires; a legacy hook that
  created the search index with an old mapping before the new bootstrap). **Cause:** the tests load modules through jest, not through the real start-up.
- **Prevention:** the cloud runner starts the real API before the loop and fails if it is not ready; `contracts` uses explicit `.ts` imports; the legacy index creator
  is removed. Evidence: `fda8b67`, `737b0cc`, `ed81d4b`.

## L-005 Tests that consume a shared resource nothing refills
- **Rule:** A test that consumes a shared resource (stock) creates its own (`createIsolatedProduct`) instead of using the seeded one.
- **Symptom:** checkout tests passed on a fresh stack and failed on re-runs (the repair loop re-runs the gate on the same stack). **Cause:** every order reserved stock of
  the same seeded product. **Prevention:** tests that place orders create a product with its own stock (`createIsolatedProduct` in `packages/web/tests/helpers.ts`).
  Evidence: `01807ea`.

## L-006 Tests that depend on what ran before them
- **Rule:** A test that needs a known state creates its own data and never relies on what ran before it; run the browser suite once on an empty stack.
- **Symptom:** product-page layout failed after other tests had recorded trending events; search pagination and suggestions failed on a fresh stack. **Cause:** shared
  state (a ranking rebuilt from a store a test cannot clear, a catalogue smaller than a page, a search history). **Prevention:** a test needing a known state creates its own
  data; the whole browser suite is run on an empty stack before a checkpoint. Evidence: `d600ba3`, `docs/architecture/sdd-runbook.md`.

## L-007 Assertions timed out on a loaded machine
- **Rule:** Use the runner timeouts (`PW_EXPECT_TIMEOUT_MS`, 2 workers) and never wait on a load that a redirect aborts; a loaded machine is slower than a laptop.
- **Symptom:** four browser tests failed on the cloud machine only. **Cause:** two stacks and a dev server compiling pages on demand; the 5 s default is too short.
  **Prevention:** `PW_EXPECT_TIMEOUT_MS` (20 s) and 2 workers on the runner; the AS-14 redirect no longer waits for a load the redirect aborts. Evidence: `0eadaa3`, `989f3ed`.

## L-008 The regression sweep died of memory and looked like flaky tests
- **Rule:** Run big suites in batches of fresh processes; a batch without its summary line is a crash, not a flaky test.
- **Symptom:** two backend suites failed with 503s, dropped connections and a negative timer; the sweep had run 67 of 201 suites. **Cause:** one Node process for all suites
  hit its 4 GB heap. **Prevention:** the sweep runs in batches of 12 suites, each in a fresh process; a batch without its summary fails the checkpoint
  (`checkpoint.sh`, `sweep-verdict.py`). **Open question:** why memory grows (roadmap).

## L-009 A failed checkpoint has no repair path
- **Rule:** A failed checkpoint must go to a repair agent with the failing test names and page snapshots, not straight to a person.
- **Symptom:** every checkpoint failure came to a person. **Cause:** the repair agent covers failures inside a capability's gate, not the checkpoint sweep.
  **Prevention missing:** hand the sweep's failures and the page snapshots to the repair agent (roadmap: follow-up 1).

## L-010 A race on first use
- **Rule:** Creating a resource on first use must be idempotent: answer 409 and open the existing one (React runs effects twice in development).
- **Symptom:** the chat page was empty the first time a chat was opened (fresh stacks only). **Cause:** in development React runs the page's effect twice; both asked to
  create the product's chat, and the second got a 400 "already exists". **Prevention:** the API answers 409 and the page opens the existing chat
  (`openProductChat`, `chat-view.test.ts`); the test uses its own product. Evidence: `65d02c3`.

## L-011 Missing database tables in the test stack
- **Rule:** Every table, keyspace and bucket the code needs must exist in the test stack; compare them with the doctor.
- **Symptom:** assistant and notification suites failed with "unconfigured table". **Cause:** the test-stack migration created Postgres and Dynamo, not the Cassandra
  schema. **Fixed by** `6266d1f`. **Prevention missing:** the doctor lists the tables the code needs and compares them with the migration files (`scripts/infra/doctor.py`),
  but not with what a test stack actually applied, and it is not run by the gate yet.

## L-012 A fix verified on a warm environment
- **Rule:** Verify a fix on a fresh stack (`scripts/qa/fresh-run.sh`), not on a warm one: the failing environment starts empty.
- **Symptom:** I debugged against a warm local stack for hours while the cloud machine, which starts fresh, kept failing. **Cause:** the reproduction did not match the
  environment where it failed. **Prevention missing:** a one-command "fresh stack, whole suite once" (`scripts/qa/fresh-run.sh`, the script used on 2026-10-12 lives
  only in the session scratch directory); make it a repository script.

## L-013 A benchmark that measured its own leftovers
- **Rule:** A test that damages the system on purpose must clean up what it damaged before the next measurement, or the next run reports the old damage as a new finding.
- **Symptom:** the "clean build" run of the QA benchmark reported a parked payment and an unhealthy stack. **Cause:** the earlier mutations (a deleted queue, a bad message option) left
  parked and stale outbox rows behind. The agent was right; the benchmark was wrong. Also, benchmark runs wrote their findings into the ledger of real findings.
- **Prevention:** `scripts/qa/benchmark.sh` deletes unpublished outbox rows after each mutation and checks `scripts/infra/doctor-live.sh` before the clean run; benchmark runs (`--out` elsewhere) never write the ledger (`scripts/qa/run.sh`).

## L-014 Hundreds of recorded defaults that nobody reads
- **Rule:** A list that agents write and a person is meant to read must be short and ranked; anything longer is not read, so it is not a control.
- **Symptom:** every build left a `questions.md` (about 2900 lines in 67 files); none was ever read. **Cause:** the output grew with the number of specs, the reader did not.
- **Prevention missing:** `scripts/decisions/triage.py` reduces them to at most 8 ranked decisions per capability in `docs/decisions` (151 open for 21 capabilities); it counts only if the
  decisions get answered (`triage.py status`). Mark this lesson prevented when the open count has gone down in a real morning routine.
