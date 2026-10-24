# Two explorers that need no AI: the monkey and the fuzzer

Why: the QA agents (charters) are themselves AI. If we want to know whether AI can build a slice without bugs, we also need ways of
finding bugs that do not depend on an AI's eyes. These two tools find bugs by brute force and by fixed rules.

## The monkey (`scripts/qa/monkey-seller.mjs`)
A fresh seller (made through the API, like the Playwright tests do) gets a shop and one product. A hidden Chrome then walks the
seller dashboard: it first opens every seller page it can find (the page folders plus the links and the sidebar), then for N minutes does
random things: click a button or link, type odd text into a field (empty, 10,000 letters, emoji, right-to-left text, `<script>`,
SQL words, minus numbers, huge numbers), send a form, upload small good and bad files, press Escape/Enter/Tab, go back, forward, reload,
make the window bigger or smaller.
After each step it looks for: a JavaScript error on the page, a red console message, a server error (500 and up), a page that fails to
load (404 and so on), "Application error" or the Next.js red overlay, words like `undefined` or `NaN` shown on a page, a page wider than
the window, an error answer that shows a stack trace, SQL or a file path, typed script text that actually ran, and basic accessibility
problems (axe, serious and critical only, once per page and window size).
It never clicks anything called log out, delete account and the like, and the browser refuses those requests anyway.

    node scripts/qa/monkey-seller.mjs --minutes 5 --seed 42 --viewport phone     # or desktop (the default)

Output: `specs/.checkpoints/qa-monkey/<time>/findings.tsv` (kind, url, action, detail, seed, step, screenshot, how often),
`actions.jsonl` (every step), `shots/`. The same `--seed` makes the same random choices; because the page itself may differ between runs
(time, other users) the replay is "very close", not exact. The action log says what was done at which step.
Same finding seen twice (same kind, page and message) is counted, not repeated.

## The fuzzer (`scripts/qa/fuzz-seller-api.mjs`)
The API does not publish a list of its seller endpoints (only the public developer API has one), so the tool reads the controller
files in `packages/backend` and builds the list itself (about 230 endpoints: shop, products, media, videos, imports, members and invites,
developer keys and webhooks, payouts, insights...). With two fresh sellers, A (the one signed in) and B (the "other" seller), it sends:
a normal call; a call with no login and with a rubbish token (must be 401); A's login on B's shop or B's product (must be 403/404 and show
nothing of B); calls with the wrong method; then for the rest of the time bodies with fields removed, set to null, to the wrong type,
huge, unicode, negative, enormous, extra admin-looking fields, broken JSON, a wrong content type, odd query strings (`limit=-1`) and odd
ids in the path; and one product create sent 7 times (some at the same moment) with one `Idempotency-Key`.
Rules it checks: no 500s; every 4xx is `application/problem+json` with a stable `code`; no stack trace, SQL or file path in an answer;
nothing of seller B in an answer to seller A; repeats with one key make one product.

    node scripts/qa/fuzz-seller-api.mjs --minutes 5 --seed 42

Output: `specs/.checkpoints/qa-fuzz/<time>/findings.tsv` (endpoint, mutation, status, why, curl line, how often), `replay.sh` (the same
lines, readable), `login.sh` (sets `TOKEN` for them), `requests.log` (everything sent). It echoing the asked address back inside the error
(`instance`) is not counted as a leak.
Limit: valid bodies are only known for a few endpoints; the others start from `{}`, so deep logic behind a validation wall is reached
less often. Add an entry to `VALID` in the script to open another endpoint up.

## In the run script
`scripts/qa/seller-run.sh --monkey [MIN] --fuzz [MIN]` runs them (default 5 min each, off unless asked) before the charters and prints a
short summary into the run log. Both are safe to run again and again: each run makes new sellers with new emails and shops and writes into a
new time-stamped folder. They add some products and webhooks to those throw-away shops, nothing else.
