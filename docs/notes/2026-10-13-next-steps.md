# Next steps (written 2026-10-12 for 2026-10-13)

## Where things stand
- The loop built 21 capabilities (backend up to S48, web W01, W02, W03, W07) and the checkpoint `buy-ui` passed on the cloud machine (`c390b4b`).
- Hand-testing the buy flow found two defects that every automated check had missed; both are fixed and the flow now completes locally
  (incident report: `docs/incidents/2026-10-12-payment-stuck-pending.md`; fixes `6886cde`, `77a6f03`, tests `f2b4a7c`).
- The living specification exists as a draft (`docs/spec/`: 21 capability pages, 16 concept pages, 4 models; all `draft`, none reviewed) with its
  verification scripts, wired into the gate and the checkpoint (`cb72c90`). Commands: `README_ME.md`, "Living specification".

## The goal, stated honestly
Remove **routine** manual testing: a person should no longer be the first to find "the payment hangs". A person stays for judgment (is this the right
product, is it pleasant, are the numbers in the spec what we want) and for reading what the automation reports. Manual testing never goes to zero; what goes
to zero is *finding the same class of bug by hand twice*. Trust in the automation is earned by measurement: re-introduce known bugs and see whether it finds them
(see "Acceptance" under the QA agent).

## Tomorrow, in this order
1. **Review the first pages (optional, 30 to 60 min, any time).** `docs/spec/REVIEW.md`; start with S13, S10, S01; sign with `sign.py`. Independent of the rest.
2. **The scripted buy flow (45 to 60 minutes). Do this first.** It is the click-through you did today, written down.
   - `scripts/sdd/checkpoints/buy-ui.sh` (the checkpoint already runs a script of that name if it exists; exit 0 means the flow works). Walk through the API only:
     register a buyer, find a product, add it to the cart, check out, create the payment with the sandbox card, then poll the order for up to 30 s until it is
     `PAID`. Fail with the last order and payment status, the outbox rows of the payment and the queue depth printed.
   - The browser journey `packages/web/tests/cart-checkout.spec.ts` (JC-2) must require "Order confirmed" (today it also accepts "Payment is being processed…").
     Keep "the page never claims success before the order is paid" as a separate test with a forced stuck state.
   - Acceptance (mutation): put back `groupId` in `payment-intent.service.ts`, then delete a queue from `elasticmq.conf`; the script must fail each time, with a
     message that names the stuck step. Then remove both and it passes.
2b. **`scripts/qa/fresh-run.sh` (written, not yet run in this form).** A brand-new dev stack, the API and the whole browser suite once, then removed: what a new machine sees.
   It refuses to run while your dev stack is up. Try it once (about 8 minutes) before relying on it; it is the lesson L-012.
3. **The infrastructure doctor and a loud readiness check (45 to 60 minutes).** A script that lists every queue, topic, table and bucket the code uses and checks
   that the stack defines it; `/health/ready` reports not ready while a consumed queue is missing or an outbox row is parked.
4. **The QA agent (3 to 4 hours; the one uncertain estimate).** A first working version is about 2 hours; the rest is the benchmark and tuning its prompt. Design below. Needs step 2 first (it extends the scripted flow into exploration).
5. **The lessons loop (about 45 minutes).** Design below; `docs/lessons.md` is already seeded with today's failures.
6. **Metrics (60 to 90 minutes).** Design below.
7. **The repair agent for a failed checkpoint and the flake signal (60 to 90 minutes together):** see the runbook, "Follow-ups for the build loop".
Total: about 7 hours of work, plus waiting for runs (the docs, which are the same kind of work, took about an hour). After 2 to 6, stop adding machinery: ship one finished flow and a short write-up with real numbers (`docs/architecture/sdd-runbook.md`, "Harness roadmap").

## Design: the QA agent
**What:** a separate agent with a fresh context that uses the running product like a person and reports defects with evidence. It never edits code.
**When:** at every checkpoint after the sweeps (and optionally nightly), on a fresh stack: `scripts/qa/run.sh <flow-list>`.
**Inputs:**
- the behaviors of the living pages in scope (`B-nn`: Given, when, then) as the things to try, and the rules (`R-nn`) as the things that must never be violated;
- seeded accounts (`docs/spec` README / `dev-seed.ts`), the base URLs, the API log path, read-only database access (`psql`), the queue and outbox views;
- the tools: Playwright (as a library from short scripts it writes in a scratch directory), `curl`, `psql`, `docker logs`, `scripts/sdd/stack-fix.sh smoke`.
**Oracles (how it knows something is wrong), in order of trust:**
1. generic ones that need no spec: a 5xx or an unhandled rejection in the API log, a console error in the browser, a request pending for more than 30 s, a page
   that says "processing" for more than 30 s, a parked outbox row, a non-empty dead-letter queue, `/health/ready` not ready, an empty page where data exists;
2. the living spec: a behavior whose "then" does not happen, a rule that is violated, a route the page names that answers 404;
3. its own judgment, always labelled as such ("suspicious, not confirmed").
**Output:** `specs/.qa/<date>-<checkpoint>.md`, one entry per defect: id, steps to reproduce, expected (with the `B-nn`/`R-nn` or the generic oracle), actual,
evidence (screenshot path, log excerpt, SQL result), severity guess. Deduplicated by signature. Failures go to the repair agent as its task list; the checkpoint
fails if any confirmed defect remains.
**Limits:** time cap 60 minutes, a token cap, a list of flows per run, never against production data, never writes outside its scratch directory.
**Acceptance (the benchmark that earns trust):** in a throwaway branch put back, one at a time, the defects of 2026-10-12: `groupId` on the charge request, a missing
queue, the legacy search-index mapping, the trending cache serving the catalogue, the shared stock running out. For each, the agent must report it within its
budget. On a clean build it must report at most two findings per run, and each must be a real defect or a justified "suspicious". Record hits, misses and
false positives in the metrics (below).

## Design: the lessons loop
**What:** a failure is written down once, in a form the agents and the checks can use, and the same class of failure is measured when it comes back.
**File:** `docs/lessons.md`. One entry per lesson: `L-nnn`, date, class (`wiring`, `config`, `test-hollow`, `state-leak`, `timing`, `resources`, `process`),
symptom, root cause, **prevention** (the test, check, rule or script that now prevents it, as a link), status (`prevented` when the prevention exists and runs,
`open` when it does not), evidence (incident, commit).
**Writers:** the repair agent (a repair that needed more than one attempt appends a draft lesson), the postmortem (every incident ends with lessons), a person.
**Readers:** `scripts/lessons/digest.py` prints the classes and one-line rules (at most 40 lines) that the builder, repair and QA prompts include ("known failure
classes: check these first"). `scripts/lessons/check.py`: every `prevented` lesson links to a prevention that exists; `open` lessons older than 14 days are
listed; a new lesson in a class that already has one counts as a **repeat** (the number to watch).
**Acceptance:** the digest appears in the agents' prompts; deleting a prevention that a lesson links makes the check fail; the metrics show repeats per class.

## Design: metrics
**What:** numbers about the loop, per run and per capability, so that a change to a prompt or a rule can be judged.
**Collect:** the loop appends one JSON line per step to `.sdd-metrics/steps.jsonl` (capability, step, start, end, result, attempt number, the exit reason); the
runner adds the run (machine type, hours, peak memory); a person tags interventions (`scripts/sdd/note-intervention.sh "found by hand: ..."`).
**Report:** `scripts/sdd/report.py` writes `docs/reports/<date>.md`: per capability: passes, tasks closed per pass, repairs, gate failures, **gates that passed
after a repair that changed no code** (flakes), checkpoint failures, defects found by hand versus by the QA agent, elapsed time and usage-limit waits; and the
trend over runs. Read the report at the start of each session.
**Acceptance:** the report for the run of 2026-10-12 reproduces facts we know (W03 needed several gate repairs and one checkpoint rerun; two defects were found
by hand); changing the gate-repair limit shows up as a visible step in the trend.

## Order of work and why
The scripted flow first, because it is small and proven necessary today; the doctor next, because the missing queue was found by hand; then the QA agent, which
builds on both; the lessons loop and the metrics make the whole thing improve and prove that it does.

## What a QA agent is, and is not
Three levels, easy to confuse:
1. **Scripted test** (what exists): Playwright code written in advance. Fast, free, repeatable; it checks only what someone thought of. It cannot find a bug nobody imagined.
2. **AI-assisted script**: the AI works out the clicks from a sentence once and saves them, then replays them without AI until the page changes (the "e2e" tool seen on
   LinkedIn). Cheaper to write, still a fixed path.
3. **Exploratory agent (the QA agent):** the model drives a real browser step by step. It reads the page (accessibility tree, optionally a screenshot), decides the next
   action, acts, and checks the result. It has a **charter** (a goal and a time budget): "buy a product as a new customer", "try to break the cart with odd quantities",
   "sign in, sign out, go back". Its tools are the ones a human tester looks at: the browser, the API log, the database, the queue and the outbox.

It is not a random clicker and it is not a fixed path. What makes it useful is the **oracles** (how it knows something is wrong): the generic ones that need no spec
(a page that says "processing" for more than 30 s, a console error, a 5xx in the API log, a parked outbox row, a not-ready health check) and the rules and behaviors of
the living pages. Every action it takes is recorded as a Playwright script, so each bug it finds becomes a repeatable test.

How it would have found the stuck payment: it follows the buy charter, presses Pay, sees "Payment is being processed…", waits; after 30 s the generic oracle fires. It then
investigates as you did: asks the API for the payment (PENDING), looks at the outbox (a parked row), reads the log (the error), and reports with that evidence.
No one had to tell it about queues.

Limits: slower than scripts, costs model usage per step, can get stuck or raise false alarms, weaker at "does this look right" unless it uses screenshots. It is trusted
only as far as the benchmark shows (see Acceptance in its design).

## The estimate, and why it is not three days
About **7 hours of work in total** (the per-item numbers are in the list above). The living-spec scripts took about an hour because they were pure local scripts with
feedback in half a second and one 5-minute batch generation. Items 1 to 5 (scripted buy flow, doctor, lessons loop, metrics, checkpoint repair agent plus flake signal) are
the same kind of work: about 4 hours. The **QA agent** is the exception: each check needs a running stack and a model-driven run of 10 to 15 minutes, and the work
that takes time is tuning it until it finds all five of the 2026-10-12 bugs without false alarms. If it needs a second tuning session, the total is two days, not three.
An earlier estimate of 25 to 35 hours was padding and is withdrawn.

## An option for tomorrow: an exploratory session before building anything
In a Claude Code session with the browser tools, the assistant can drive Chrome on the running local app (`localhost:3000`): buy something, try odd inputs, and report
what it sees. This is the QA agent done by hand once, and shows what the automated version would do before it is built. It acts in your real browser (your logins,
your tabs), so it only happens when you say so.
