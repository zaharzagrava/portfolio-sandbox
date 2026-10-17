# Lessons from failures

One entry per failure that taught something: what happened, the cause, and the check, test or rule that now prevents it. `prevented` means the prevention
exists and runs; `open` means it does not yet (and is on the roadmap in `docs/work/architecture/sdd-runbook.md`). The classes: `wiring` (components that do not fit
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
- L-015 2026-10-13 wiring prevented
- L-016 2026-10-13 config prevented
- L-017 2026-10-13 process prevented
- L-018 2026-10-14 wiring prevented
- L-019 2026-10-14 process prevented
- L-020 2026-10-14 config prevented
- L-021 2026-10-14 config prevented
- L-022 2026-10-16 process prevented
- L-023 2026-10-17 resources prevented
- L-024 2026-10-17 process prevented

## L-001 A message option the queue refuses, found only by hand
- **Rule:** A queue option must be validated where the message is created, not discovered when the relay fails (FIFO-only options like `groupId` never go to a standard queue).
- **Symptom:** checkout stuck on "Payment is being processed…" for ever. **Cause:** the charge and refund requests carried a `groupId`, valid only on FIFO queues;
  the relay failed on every attempt and parked the row after ten, with nothing visible.
- **Prevention:** the outbox validates queue options when the task is created (`append-with-executor.ts`, `task-row.spec.ts`); each caller has a test that runs the
  real check (`payment-intent.service.spec.ts`, `refund-command.adapter.spec.ts`), verified to fail with the old mistake. Evidence:
  `docs/ops/incidents/2026-10-12-payment-stuck-pending.md`, `77a6f03`, `f2b4a7c`.

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
  data; the whole browser suite is run on an empty stack before a checkpoint. Evidence: `d600ba3`, `docs/work/architecture/sdd-runbook.md`.

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
  environment where it failed. **Prevention:** `scripts/qa/fresh-run.sh` (fresh throwaway stack, whole suite once) is a repository script. On the cloud runner use `scripts/qa/fresh-run.sh --here`: the runner's own
  dev stack started empty when the machine booted, a second stack cannot start next to it, and the `payment_system_*` containers must never be stopped there. A task that asks for
  "the real `apps/projector` / `apps/core` / `apps/worker` boot" is closed with `scripts/infra/boot-app.sh <app>` (starts that one app on its own port, shows its consumer and job log lines, stops it); an
  agent cannot approve a command, so every command a task needs is on the allow-list in `implement-specs.sh` (S36, S39, S47 were blocked a night for lack of it). A task that asks for
  an "empty-stack run" is closed with `--here` plus the checks it lists (S19 T072 was blocked for a night waiting for a person to stop the stack, 2026-10-13).

## L-013 A benchmark that measured its own leftovers
- **Rule:** A test that damages the system on purpose must clean up what it damaged before the next measurement, or the next run reports the old damage as a new finding.
- **Symptom:** the "clean build" run of the QA benchmark reported a parked payment and an unhealthy stack. **Cause:** the earlier mutations (a deleted queue, a bad message option) left
  parked and stale outbox rows behind. The agent was right; the benchmark was wrong. Also, benchmark runs wrote their findings into the ledger of real findings.
- **Prevention:** `scripts/qa/benchmark.sh` deletes unpublished outbox rows after each mutation and checks `scripts/infra/doctor-live.sh` before the clean run; benchmark runs (`--out` elsewhere) never write the ledger (`scripts/qa/run.sh`).

## L-014 Hundreds of recorded defaults that nobody reads
- **Rule:** A list that agents write and a person is meant to read must be short and ranked; anything longer is not read, so it is not a control.
- **Symptom:** every build left a `questions.md` (about 2900 lines in 67 files); none was ever read. **Cause:** the output grew with the number of specs, the reader did not.
- **Prevention missing:** `scripts/decisions/triage.py` reduces them to at most 8 ranked decisions per capability in `docs/work/decisions` (151 open for 21 capabilities); it counts only if the
  decisions get answered (`triage.py status`). Mark this lesson prevented when the open count has gone down in a real morning routine.

## L-015 Every gate passed and the whole application could not start
- **Rule:** A change is not done until the application that contains it starts. A test that builds its own small module cannot see a missing import in the real one.
- **Symptom:** the second cloud run of 2026-10-13 stopped 10 minutes after it began: the API never became ready. **Cause:** two modules built overnight were wired wrongly: the ledger's balance projector and the notification consumers inject providers (`BALANCE_HOT_STORE`, `EventRoutingService`) that the module hosting them in `ProjectionsModule` did not import (`UnknownDependenciesException`). Each capability's gate and e2e suite passed, because they build their own test modules; only the monolith composes them.
- **Prevention:** the two modules re-export what their classes inject; `scripts/infra/boot-check.sh` judges whether the monolith is ready and prints the Nest error that stopped it. It runs in the gate of every backend capability when an API runs under watch mode (`API_LOG` or `BOOT_CHECK=1`), at the start of every checkpoint, and the runner stops at once with the cause in its message instead of waiting ten minutes. Not covered: runs on the `be` image (test stack only, no API).

## L-016 The failure the gate caught ended the whole run instead of starting the repair
- **Rule:** The code that handles a failure must itself survive that failure. A helper that the repair path calls may not exit non-zero on the very condition the gate reports.
- **Symptom:** the third cloud run of 2026-10-13 ended with exit code 123, 16 minutes in, right after the gate of S34 said "test file deleted"; no repair agent started and no message said why. **Cause:** `code_fingerprint` (the flake signal, which the repair path calls) hashes every tracked file; a deleted one makes `sha1sum` fail, `xargs` exit 123, and `set -e -o pipefail` ended the script. A second, silent one: backticks inside the double-quoted prompt of `extra_context` ran `[proof: ...]` as a command, so that instruction never reached any agent.
- **Prevention:** `code_fingerprint` ignores a failing `sha1sum`; the backticks are escaped; `scripts/sdd/test_loop_shell.py` covers both (it fails on the old code). A gate repair attempt now sends a phone message ("repair attempt N of 5"), and the `info` priority is 3 (the old 2 is hidden in many ntfy clients).

## L-017 "Never delete a test" is the wrong rule: never lose a scenario
- **Rule:** Tests are replaced, split, merged and renamed all the time. The thing that must not disappear is a scenario (the behavior a test proves), not a file.
- **Symptom:** S34 (recommendations) replaced its old journey test `recommendations.e2e-spec.ts` by five focused files that carry the same scenario ids; the gate still failed with "test file deleted", and the repair prompt told the agent to never delete a test. **Cause:** the integrity guard counted files and `it(`/`expect(` calls, and the prompts said "never delete a test".
- **Prevention:** `scripts/sdd/check-tests.py integrity` now fails a deleted or shrunk test file only when a scenario id it carried (`S34 AS-12`) is in no test any more and is not retired in `specs/<capability>/retired-scenarios.md`; a deleted file that carried no scenario id is still a finding. The three repair prompts say "never lose a scenario" instead. Tests in `scripts/sdd/test_check_tests.py`.

## L-018 The monolith booted, the applications it is made of did not
- **Rule:** Every deployable app must boot on its own, not only inside the monolith that hosts them all. The monolith supplies modules and settings that a standalone app lacks.
- **Symptom:** three capabilities (S36, S39, S47) stopped on a task "the real `apps/projector`, `apps/core`, `apps/worker` boot" that the unattended agent could not run; when it was run (2026-10-14), `apps/projector` aborted at start (Nest cannot find `RouteTable`; the `try/catch` around the lookup cannot stop Nest's abort), `apps/payment-processor` still does not boot (missing imports), and the dev `.env` lacked five settings that capabilities had made required. **Cause:** the gates and the boot check start only the monolith or small test modules.
- **Prevention:** `scripts/infra/boot-app.sh` boots one real app on its own port and shows its consumers and jobs; it is on the agents' allow-list; `projector` and the dev `.env` are fixed. Not covered yet: `payment-processor`; boot-app is not part of the gate (only the monolith boot check is).

## L-019 A proof that only the end of the run can give must not be a task
- **Rule:** Runtime proofs (the real apps boot on their own, an empty-stack run, the browser suite) are done by the final checkpoint, with scripts. A builder or converge pass must NOT add a task that asks for one, and a task that still asks for one is ticked with "deferred to the final checkpoint: <command>".
- **Symptom:** S36 and S47 had every test green and were BLOCKED for a night and a morning on tasks like "T061 HIGH: prove the real apps boot on an empty stack". **Cause:** lessons L-012, L-015 and L-018 say "verify on a fresh stack / the real apps must boot"; the converge step turns that into a task after each pass. The runner's stack is empty only in the first minutes of a run (it is created once when the machine boots, then warms up), so no task can be met in the middle of a run, and the doctor rightly refused to fake it.
- **Prevention:** this rule is in the digest every agent reads; the doctor prompt tells it to defer such tasks and answer fixed instead of blocking a finished capability; `scripts/sdd/checkpoints/final.sh` runs `boot-app.sh core|projector|worker`, `fresh-run.sh --here` and the scripted buy flow, and prints the deferred notes (`specs/deferred-checks.md`).

## L-020 A new queue is not a new queue until the queue server restarts
- **Rule:** A capability that adds a queue must also reload the queue server, and an unattended agent must have a command for it.
- **Symptom:** S42 (seller public API) was code-complete and the gate failed four times on readiness (`"queue:public-api-bulk-chunk":"down"`); each repair agent correctly edited `infra/docker/elasticmq/elasticmq.conf` and then could not restart the queue server (`docker restart` was not on its allow-list), so the same failure came back. **Cause:** ElasticMQ reads its config only at start.
- **Prevention:** `scripts/infra/reload-queues.sh` restarts only the dev stack's queue server and waits for readiness; it is on the allow-list. Fixed live on the runner at 17:50 local by restarting the container.

## L-021 The operating system restarted the build service in the middle of a pass
- **Rule:** A disposable build machine runs nothing that changes it behind the loop's back, and a restart of the runner must keep the work in the tree.
- **Symptom:** twice in one day (08:42 and 19:00 UTC) the journal shows `Stopped sdd-run.service` and `Started sdd-run.service` with no one at the keyboard; the first time the loop recovered, the second time the run failed ("cannot check out origin/sdd/wip": local changes would be overwritten). **Cause:** Ubuntu's nightly `apt-daily-upgrade` / `unattended-upgrades` job (with `needrestart`) restarts services that use upgraded libraries, including our transient service; the restart then started the script over a dirty working tree.
- **Prevention:** `scripts/vps/vm-run.sh` stops and masks the upgrade timers and sets needrestart to list-only before anything else, and a restart commits the working tree (`wip(sdd): work in progress when the runner restarted`) and lets it take part in the choice of the start; `scripts/vps/bootstrap.sh` does the same for the image.

## L-022 An agent that ends its turn to wait for a background job has quit
- **Rule:** In an unattended run nobody answers and no notification arrives. An agent never starts a background command and stops; it polls in the foreground (`sleep 240`, then read the output file) or runs a narrower check. A gate that took more than ten minutes is not run again on byte-identical code.
- **Symptom:** J01 sat in its gate for four hours (2026-10-16, 05:57 to 09:40 UTC): five repair attempts and a doctor, each "answer was complete but claude did not exit", while the gate (the 25-minute journey suite) was run again every time. The repair log of each attempt ends "the journey run is still in progress, I'll pick it up when it finishes". **Cause:** the agent ran `pnpm test:journeys` as a background task and ended its turn; `claude -p` never delivers the completion, so every attempt was blind, and the loop reran the same long suite on the same code. Underneath was a real fault the first run found: the document-extractor stand-in was not running on the runner's stack, and crashed at start-up outside the monolith (`OnboardingExtractionModule` lacked its S04 ports), so no shop was ever verified and the tests timed out one by one.
- **Prevention:** every agent prompt carries the unattended rules (`UNATTENDED_RULES` in `scripts/sdd/implement-specs.sh`); `scripts/sdd/stack-fix.sh journey` rebuilds and starts the stand-in and checks the metrics port in seconds, and the journey gate runs it first; a failing gate that took 10 minutes or more is not rerun until the code changed; a capability's gate repairs stop after 120 minutes; pass timeout 50 minutes (was 120), repair agents 40, exit grace 30 s (was 90), two doctor tries per capability (was 3).

Second round of L-022 (same day, 10:30 UTC): the next run went round a different circle. Converge distrusts a task ticked "deferred" ("their [X] is not evidence") and adds "record the runtime proofs" as a new task after every pass; the agent cannot run `fresh-run.sh --here` or the app boots on the build machine, so the pass closes nothing, the doctor defers the task, converge adds another. **Prevention:** `scripts/sdd/defer-runtime.py` runs after every converge and ticks any open task that only asks to run, record or prove a runtime check as deferred (writing `specs/deferred-checks.md`); the converge prompt says a deferred tick is done and forbids adding such tasks.

## L-023 One test process for a whole domain runs out of memory late in the run
- **Rule:** The backend gate runs the e2e suites of a domain in fresh jest processes (`GATE_BATCH`, default 12, 6 GB heap each), never all in one.
- **Symptom:** S06 was BLOCKED after three rounds of five repairs (2026-10-17, about 03:00 to 06:20 UTC) and S55 started down the same road. The gate showed dozens of unrelated failures: 503s, timeouts, rate-limit counts. **Cause:** one jest process for the whole domain hit its 4 GB heap limit (`JavaScript heap out of memory`); the suites after it saw GC pauses. Each suite passed alone. The repair agents found this and edited `scripts/sdd/implement-specs.sh` on the runner, but the running loop had already read the old script, so every attempt reran the old gate.
- **Prevention:** the batched gate is merged (`gate()` in `scripts/sdd/implement-specs.sh`, same remedy as `checkpoint.sh`). Because a loop never sees an edit to its own script, an agent that changes `scripts/sdd/` must say so, and the next restart picks it up.

## L-024 A reader that closes a pipe can end the whole run
- **Rule:** In the loop's shell, a Python helper piped into `head` must survive a closed pipe, and a crash of the script itself is retried by the runner.
- **Symptom:** the 14-hour run of 2026-10-17 ended after 28 minutes ("loop ended with exit code 120") although S06's gate had just passed. **Cause:** a gate that passes after a repair that changed no code is recorded as a flake; that runs `failures.py names <log> | head -3`; on a big log (1.2 MB) python gets a broken pipe and exits 120, and `set -e -o pipefail` ended the script. The machine then sat idle.
- **Prevention:** `failures.py` treats a closed pipe as success; `flake_record` cannot fail; `scripts/vps/vm-run.sh` starts the loop again (at most 3 times) when it exits with a code that is not one of its own.
