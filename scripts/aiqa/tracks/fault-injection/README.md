# Track "fault-injection": what happens when a helper service breaks in the middle of an action?

Plain words: the app talks to a database, a cache (Redis), a message queue (Kafka), a search engine, file storage and more. Tests normally run with all of them healthy. Here the runner freezes ONE of them for about a minute while the spec clicks real buttons, then unfreezes it and checks what the seller saw and what was really saved. Example: the database is frozen, the seller presses "Create product", and the button says "Creating..." for ever with no message; after the database wakes up, the product exists (so the work was done, but the seller was never told). That was register entry B-089.

Files:

- `run.mjs` (this folder): the runner that freezes and unfreezes containers.
- `packages/web/tests/seller/cross-cutting/fault-injection.spec.ts`: the permanent test (skips itself unless the runner started it).
- `scripts/aiqa/coverage/fault-injection.tsv`: the map. Line ids: `fault.<dependency>.<action>`, for example `fault.postgres.create-product`, `fault.redis.inventory-load`, `fault.minio.photo-upload`, `fault.kafka.outbox-published`.
- `scripts/aiqa/findings/tracks-12-13.md`: findings of the first run (B-089, B-090, B-091 in `docs/work/qa-bug-register.md`).

## What this finds that the other tracks miss

Everything else runs with healthy services. This is the only track that checks: an error message instead of a spinner for ever, no fake "saved" message, a retry that does not create a second copy, no half-written data, no lost background message (the "outbox", a table of events waiting to be sent to Kafka) after the service returns, and no raw technical text (SQL, stack) on screen.

## Before you start

- The dev stack is up (`QA_DIR=/tmp/fe WITH_WEB=1 scripts/qa/stack-up.sh`): web :3000, API :8000, the Docker containers `payment_system_*`. Check with `docker ps`.
- The runner needs the `docker` command (it only uses `pause`, `unpause`, `inspect`). `docker pause` freezes a container without using more memory; connections hang instead of being refused.
- Memory: the spec opens two browser contexts and 9 pages (one per action), so plan for about 2 GB extra on top of the dev stack; run ONE dependency at a time (the runner does that).
- Other people use the same stack. Every pause is announced in `/tmp/fe/fault-window.txt` ("FAULT WINDOW OPEN: redis ... for at most 270 s"); read that file before you suspect your own bug, and tell other testers before you start. The pause is never longer than 270 seconds, and the runner unpauses on exit, on Ctrl-C, on a crash, and when the spec writes `abort`. NEVER pause containers by hand and never run the spec with `AIQA_FAULT=1` yourself: only the runner may.
- Run it when nothing else heavy runs; the first minute (set-up while healthy) needs the app to answer quickly.

## Commands

```
node scripts/aiqa/tracks/fault-injection/run.mjs                    # every dependency, one after the other (about 2 to 5 minutes each)
node scripts/aiqa/tracks/fault-injection/run.mjs redis minio        # chosen ones; "postgres" (alias "db"), redis, kafka, elasticsearch, minio, scylla, elasticmq, clamav, clickhouse, serverless-redis
node scripts/aiqa/tracks/fault-injection/run.mjs --mark postgres    # also writes the results into the map with mark.mjs
cat /tmp/fe/fault-window.txt                                        # is something paused right now?
docker ps --filter status=paused                                    # must be empty when you are done
```

Evidence of each run: `/tmp/fe/fault/<dep>/{observations.json,trace.log,playwright.log,report.json}`; the summary of the whole run: `/tmp/fe/fault/summary.json`. `observations.json` has, per action: what the screen showed (success / error / pending), after how many milliseconds, the visible text, and whether raw technical text leaked.

## How a run goes (the flag files)

1. The runner starts Playwright with `AIQA_FAULT=1 FAULT_DEP=<dep> FAULT_DIR=/tmp/fe/fault/<dep>`.
2. The spec registers a seller, makes a shop and four products, opens one page per action and waits until the outbox is empty. It writes `ready`.
3. The runner pauses the container, writes `paused` and announces the window.
4. The spec runs the "during the outage" tests, one per action, at most 25 seconds each. A test that sees neither a success message nor an error message in 25 seconds records `pending`: the finding. Then the `window` test writes `paused-done`.
5. The runner unpauses, writes `resumed`. The spec waits for `/health/ready`, then the "after recovery" tests retry each action (only if it did not already succeed), and read back the saved data.
6. Last test: the outbox. The runner collects the result; with `--mark` it writes pass/bug into the map.

## The outage catalogue: what each outage should do

For EVERY outage and EVERY action the same rules are checked:

1. Honest within 25 seconds: the screen shows a success message, or an error message (words like "went wrong", "try again", "unavailable"). A busy button or spinner that never ends fails.
2. No fake success: a success message must be backed by the saved row after recovery; an error must not leave a row behind.
3. Retry once: after recovery the same action by the seller works and creates exactly one product, one shop, one photo, changes the stock once (the `version` of the row goes up by exactly 1).
4. Data consistent: no duplicate titles, no half-written product.
5. No raw technical text (SQL, stack, `ECONNREFUSED`, `kafkajs`, ...).
6. Outbox published: every event row of the shop reaches `published` within 2 minutes after recovery.

| Dependency (container) | What it backs | What is expected while it is frozen |
|---|---|---|
| `postgres` (`payment_system_db`) | all saved data | reads and writes cannot work: an honest error page (inventory/orders showed one in 5 s) and an error message on every save, never a spinner for ever. Seen: B-089 |
| `redis` (`payment_system_redis`) | rate limiter, caches, sessions | the app must not hang on it: pages open or show an error. Seen: B-090 |
| `kafka` (`payment_system_kafka`) | events from the outbox | seller actions still work; events wait in the outbox and are published after recovery. Passed |
| `elasticsearch` | shop product search | create/edit/archive still work; the search box would show a "search unavailable" message (open line `fault.elasticsearch.inventory-search`). Passed for the actions |
| `minio` (file storage) | photo bytes | everything but photo upload works; the upload must show an error. Seen: B-091 |
| `elasticmq` (queue) | the "photo uploaded" step | same as storage. Seen: B-091 |
| `scylla` | chat/long-lived data | seller pages do not depend on it. Passed |
| `clamav` | virus scan of uploads | upload still works or says why. Passed |
| `clickhouse` | analytics | seller pages do not depend on it. Passed |
| `serverless-redis` | web-side Redis gateway | known to the runner, left out of the default run; line untested |

The actions per outage (map columns `create-product`, `edit-product`, `stock-change`, `archive-product`, `photo-upload`, `shop-open`, `inventory-load`, `orders-load`, `outbox-published`): Create product, Save changes in the edit dialog, Update stock, Archive product, add a photo, Open shop (new member form), open the Inventory page, open the Orders page, outbox check.

Each line has two tests with the same id (during the outage, after recovery). The line is `pass` only if both pass. One pause serves all actions, so a long outage hits them one after the other.

## How to point it at a NEW feature

1. Add the new action as one more entry in the spec: a page opened and warmed while healthy (in `beforeAll`, with the other pages), one "during the outage" test using `settle(page, '<action>', startedAt)` after the click (or `observeLoad(...)` for a page open), and one "after recovery" test that reads the saved data back through the API and retries once if nothing was saved. Use a new product or shop per action so actions do not disturb each other.
2. Add the action name to `LINE_IDS` for every dependency (the list at the top of the spec; the same ids go into the map) and add the lines to `fault-injection.tsv`: `fault.<dependency>.<action>`, spec ids, code trace (page > route > service > table > events).
3. Decide which dependencies the feature really uses (the code trace tells): an action that never touches Kafka still gets a Kafka line, because "it still works" is a result worth recording; but a new dependency (for example a payment gateway container) must be added to `CONTAINERS` in `run.mjs` (key and container name) and to `LINE_IDS` and the map.
4. If the feature sends mail or webhooks, add an outbox/queue check like `outbox-published`.
5. Check the new test on the healthy stack for its set-up only by reading the code; then run `run.mjs --mark <dependency>` for the dependencies the feature uses.

Settings you can change: `LIMIT_MS` (25 s honest limit) and the success/error wording `SUCCESS`, `ERROR`, `LEAK` at the top of the spec; `WINDOW_MS` (270 s) in `run.mjs`.

## How results become map lines, findings and register entries

`--mark` runs `scripts/aiqa/mark.mjs fault-injection <line> pass|bug ui,api,db ...` for every line from the Playwright JSON report. A `bug` line gets bug id `spec-fail` and the first error line; replace it with the register id after you wrote the register entry (`mark.mjs ... bug ui,api,db B-nnn "<note>"`). Write each finding in `scripts/aiqa/findings/` (steps, expected with spec id, actual, the `observations.json` numbers) and then in `docs/work/qa-bug-register.md`. Keep a failing test failing until the product is fixed.

## Known limits

- `docker pause` freezes; it does not refuse connections. A stopped service (connection refused at once) may behave differently: open lines `fault.postgres.stop-start-refused-connections` and the same for Redis and MinIO.
- Slow answers (3 to 10 seconds), the API process being killed during a write, and a very large outbox backlog are open lines too.
- The search box under an Elasticsearch outage is not in the spec yet.
- The 25-second limit is our choice: the app sets no client timeout of its own (that is what B-089 to B-091 are about).
- Run on the dev server (not a production build).
