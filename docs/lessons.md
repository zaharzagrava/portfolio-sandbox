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
- L-025 2026-10-17 config prevented
- L-026 2026-10-17 process prevented
- L-027 2026-10-17 resources prevented
- L-028 2026-10-17 process prevented
- L-029 2026-10-18 state-leak prevented
- L-030 2026-10-18 timing prevented
- L-031 2026-10-19 config prevented
- L-032 2026-10-19 test-hollow prevented

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

Second round of L-022 (2026-10-17, 13:54 UTC): the new time limits blocked W04. A repair agent that hit its 40-minute cap was counted as a FAILED step (only implement passes treated a timeout as "go on"), so the capability went to the doctor, which hit its own 25-minute cap, and W04 was BLOCKED with its work in the tree. **Prevention:** a timeout of a repair, doctor or checkpoint-repair step now means "the loop goes on from what is in the tree": the gate (or the next build) shows whether the edits were enough.

## L-025 The runner did not start the Lambda stand-ins the browser specs depend on
- **Rule:** Everything a browser or journey spec consumes from a queue has a consumer on the runner's stack from the first minute: the document-extractor and media-processing stand-ins (`scripts/sdd/stack-fix.sh standins`).
- **Symptom:** the first web gate on a fresh machine (W04, 2026-10-17, 16:33 UTC) failed 17 specs in 23.8 minutes: J01 AS-29 "shop VERIFIED by the onboarding extraction timed out after 60000ms", seller-photos, others. **Cause:** nothing on the runner started the stand-ins; only the journey gate's preflight (and the QA stack script) did, so a web gate before the first journey gate, or on a machine that had never run a journey, had no consumer for `onboarding-documents` and `media-processing`. Earlier machines worked because an agent had started them by hand.
- **Prevention:** `vm-run.sh` starts them after the API is ready, the web gate calls `stack-fix.sh standins` first (starts only when missing), and the journey preflight restarts both on fresh code.

## L-026 The gate should be iterative: parts, then only the failures, then everything, then small batches
- **Rule:** After a failed gate the next attempt re-runs only what failed. Everything runs again only when the failures are green, and a full run that fails a second time is repeated in small batches (backend `GATE_BATCH_SMALL` 4 spec files per process, web `GATE_WEB_BATCH` 12 files per process).
- **Symptom:** every repair attempt re-ran the whole gate (24 minutes for the web gate of W04, a whole domain of e2e suites for a backend one) although the agent had touched one file.
- **Prevention:** `backend_gate`/`web_gate_full` in `scripts/sdd/implement-specs.sh` keep the stage per capability in `.git/sdd-gate-<id>`; `test_loop_shell.py` walks the four stages with a fake jest. The web stages are checked for syntax only (they need the live stack).

## L-027 The dev API's own type checker ran out of memory and took the API down
- **Rule:** The watch build of the local monolith only transpiles; types are checked by the gates (`tsc --noEmit`). Nothing in the dev stack may restart or stall the API during a test run.
- **Symptom:** W04's gate failed 3 specs (checkout JC-2 and JO-1 on desktop and mobile) with `502 bad_gateway` / `socket hang up`; repair attempts 2 to 5 each took one minute, found an environment fault, changed nothing, and the gate was not re-run on identical code, so five attempts and a doctor were used (2026-10-17, about 18:10 UTC). **Cause:** Nest's webpack builder always adds `ForkTsCheckerWebpackPlugin` with its default 2 GB heap (whatever `typeCheck` says); on a recompile it hit `JavaScript heap out of memory` and the monolith was down while the BFF answered.
- **Prevention:** `apps/local-monolith/webpack.dev.js` (set as `webpackConfigPath` for the project in `nest-cli.json`) drops that plugin from the watch build; the build takes 10 s.

Second part of L-027: even without the out-of-memory, the watch-mode API restarts after every edit of backend code, and a spec that starts in that window sees 502/503. **Prevention:** `scripts/sdd/stack-fix.sh api-ready` waits until the API has answered ready five times in a row and its log has been quiet for 6 s; the gate runs it before browser and journey stages and before every Playwright batch, and the agents' rules tell them to run it after editing backend code.

## L-028 "Needs a human" for something an agent could do itself
- **Rule:** A restart of the dev API, a held port, a changed start script: the agent does it (`scripts/sdd/stack-fix.sh api-restart`) and never answers "needs human". A gate stage must not depend on a service it does not use.
- **Symptom:** W04 was BLOCKED (2026-10-17, 19:51 UTC): repair attempts 2 to 5 each failed in seconds and the doctor wrote "needs human: the running dev API must be restarted so it serves metrics on :9464; I'm not permitted to restart it". **Cause:** an agent had put `stack-fix.sh journey` into the WEB gate to start the Lambda stand-ins; that action also checks the metrics port, which only the backend journeys (J01 AS-30) read; after a watch-mode restart :9464 was unavailable for a while (the new process waits for the old one), so the web gate failed on a check it had no use for, and agents may not run `kill`.
- **Prevention:** the web gate uses `stack-fix.sh standins` only; the journey preflight waits up to a minute for the metrics port and then says how to restart; `stack-fix.sh api-restart` restarts the dev API from the current script and waits for a stable answer; the agents' rules name it.

## L-029 A spec that moves the shared clock must not run next to other specs
- **Rule:** Anything that changes global state of the dev stack (the API clock, feature flags that every user sees, key rotation) runs ALONE, after the parallel suite. `packages/web/playwright.config.ts` leaves `CLOCK_SPECS` out of a normal run; `PW_CLOCK=1 playwright test --workers=1` runs them; the SDD gate, the checkpoint sweep and `fresh-run.sh` do both.
- **Symptom:** W04 was BLOCKED and W05 failed its gate all night (2026-10-17/18) on one spec, cart checkout JC-2 ("Order confirmed" never appeared), on desktop and mobile, in every full run; alone it passed in 24 s. The repair agents called it a load flake and changed nothing, which cost about 12 hours and every repair budget. **Cause:** the J01 UI journey (`buy-to-payout.spec.ts`) calls `control.advance(49 * 3600)` to run the weekly payout; while the API clock is moved, every other session gets `401 invalid_token`, and with two workers it ran next to JC-2. The API log showed about 2,200 `invalid_token` responses per run and rows dated two days ahead. Found by running the same batch of spec files on the stopped runner: 2 failures with the old config, 64 passes and 0 `invalid_token` with the new one; the clock was back at offset 0.
- **Prevention:** the config split above; also: a failure that appears only in the full run and not alone is an interaction between specs, not "load". Compare the API log of the full run with the log of the single run.

## L-030 About 450 browser tests on a loaded machine always flake once
- **Rule:** The gate runs Playwright with one retry (`PW_RETRIES=1`, set by `vm-run.sh`). A test that fails and then passes is a flake: it passes the gate and is written to `specs/<capability>/flaky-specs.md`; a test that is really broken fails twice.
- **Symptom:** W04's web gate failed in a different place every cycle (seller-import, seller-inventory, two layout screenshots, live numbers, five seller layout screenshots), each time one to five of about 450 tests, and each failure cost a repair round plus a 25-minute full run (about 40 minutes per cycle, six hours in total on 2026-10-18); repair agents "fixed" a different timing issue each time or loosened a wait.
- **Prevention:** the retry plus the flaky list. Look at the lists when a spec starts failing for real, and when it appears in them twice, make it deterministic.

Second part of L-030: a journey's gate runs only its own spec file (`pnpm test:journeys <file>`). J02's gate re-ran J01 as well (10+ minutes) and failed on J01 AS-30 (a log-offset check that depends on the stack's history) although J01 had passed at its own gate; the whole journey suite runs at the final checkpoint. Also: the runner config's `PASS_TIMEOUT_S=7200` overrode the 50-minute default and let J02's first implement pass run for two hours; it is now 3000.

## L-031 A refused command stalls a pass until its timeout and ends as "needs human"
- **Rule:** Every command an unattended agent may need is on the allow-list in a form that does not depend on its working directory, and a refusal is announced in the loop log (`PERMISSION:`), not discovered after three passes.
- **Symptom:** J03 (2026-10-18/19): three implement passes of 50 minutes each closed no task (22 tasks open), then the doctor wrote "needs human: the unattended shell refuses `python3 scripts/livespec/check.py`, `git`, jest and pnpm" and J03 was BLOCKED; J04 lost passes the same way. **Cause:** the allow-list matches command prefixes: `python3 scripts/livespec/check.py` only in that exact form, no `git diff` at all. A journey capability works inside `packages/backend/test/journeys`, so an agent that has `cd`'d there runs `python3 ../../scripts/...` or `git diff`, which "requires approval" in an unattended run. The first task (T008) needed `check.py`, so nothing after it could start.
- **Prevention:** `python3`, `bash scripts`, read-only git (`diff`, `status`, `show`, `ls-files`, `rev-parse`, `blame`) and the usual file tools are allowed; `step()` writes a `PERMISSION:` line naming the refusal; `scripts/vps/watch-runner.sh` reports it.

Third part of L-022 (2026-10-19, J03): the rule "poll with sleep 240" cannot be followed: this Claude Code version refuses a `sleep` used to wait ("use a monitor") even when `sleep` is on the allow-list, and a monitor ends the agent's turn. J03's first pass ended after one run with "sleep is refused ... I'm waiting with a monitor loop" and 21 tasks open. **Prevention:** agents wait with `bash scripts/sdd/wait-for.sh <file> <regex> [seconds]`, which blocks inside the script (no `sleep` in the command text) and says FOUND or NOT YET; the rules name it and forbid writing `sleep`.

Fourth part of L-022 (2026-10-19): the first fix for the `sleep` rule broke the shell quoting of `UNATTENDED_RULES` (single quotes inside a single-quoted string), so bash ran a word of the rule text as a command and the loop never started (`bash -n` passed: the syntax was valid). **Prevention:** `test_loop_shell.py` evaluates the assignment and checks the text is whole (it must end with the last sentence and print nothing on stderr). Never put a single quote in that string.

Second part of L-031 (2026-10-19, same day): after `python3:*` and read-only git were allowed, J03's agents were still refused `stack-fix.sh`, `wait-for.sh` and `test-spec.sh` ("requires approval", then "a 25-minute full run wasn't possible"). **Cause:** a rule matches a command only up to a word boundary, so `Bash(bash scripts:*)` does not match `bash scripts/sdd/stack-fix.sh`; only a rule that names the script does, and only in the path form it spells (the agents in `packages/backend` write `../../scripts/...`). **Prevention:** `IMPL_TOOLS` is generated for every helper script in every path form (`scripts`, `./scripts`, `../scripts`, `../../scripts`, `/opt/sdd/repo/scripts`), with and without `bash`/`python3`; `test_loop_shell.py` checks it.

## L-032 A log check that reads the whole log fails on whatever happened before the test
- **Rule:** A journey that checks the API log reads the lines of its own run: take `logMark(apiLogPath())` before the first request (in `beforeAll`) and read `logLinesSince(log, mark)`. Never `logLinesSince(log, 0)`.
- **Symptom:** J03 AS-39 ("every JSON log line carries an id") failed in four gates in a row (2026-10-19) with KafkaJS startup warnings and consumer-rebalance lines from before the journey and from API restarts; the repairs removed the warning at its source (an explicit partitioner) and the doctor routed kafkajs lines through the app logger, and the gate still failed because the old lines stayed in the log. The gate loop also stopped after two attempts: `GATE_WALL_MIN` (120) is too short for a journey gate of 20 minutes plus repairs of up to 40; now 200.
- **Prevention:** J03 takes its mark; the permission detector also recognises "the harness refused ...".
