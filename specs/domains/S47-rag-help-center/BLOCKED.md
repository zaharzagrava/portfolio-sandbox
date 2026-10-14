# S47 is blocked

- when: 2026-10-14T07:57:13Z
- why: needs a human: DOCTOR: needs human: T066 needs the web app and a browser started (Playwright) and T071 needs approval to rebuild the shared stack with `scripts/qa/fresh-run.sh`, and the sandbox refuses both without approval.
- repair agent time used in this run: 3 of 60 minutes

## What to do
Fix the cause (for example decide the open question in questions.md), delete this file, and run the loop again: it resumes this
capability. Until then the loop skips it and everything that depends on it.

## End of the last log (.doctor-1.log)
```
I couldn't run the Playwright journey: this sandbox refuses to start the web server and browser without approval. That is the same restriction that blocked S36 T061. S47 has no code or artifact defect for me to fix.

- **State of the tasks:** Only T066 and T071 are unchecked. In `tasks.md`, T066 is already marked blocked and T071 is already marked not run, each with its reason. The other 72 tasks are checked, including T070 (the real apps boot) and T072 (the whole capability suite).
- **T066:** `packages/web/tests/knowledge.spec.ts` is written and type-checked but has not been run. It needs the web app on :3000, which is down (the API on :8000 answers). The Playwright config starts the dev server itself, so `cd packages/web && PW_EXPECT_TIMEOUT_MS=15000 npx playwright test tests/knowledge.spec.ts --workers=2` is all that's needed once someone approves it. Until then, `components/product/ask-product.test.tsx` covers the question box.
- **T071:** `scripts/qa/fresh-run.sh` rebuilds the whole shared stack, so it needs a human decision first. Running it could disrupt other work on that stack. I did not run it.
- **Changes:** I changed no files.

The loop will keep stalling at pass 2 on these two tasks. Either run those two commands, or tell the loop to accept S47 with T066 and T071 recorded as not run.

DOCTOR: needs human: T066 needs the web app and a browser started (Playwright) and T071 needs approval to rebuild the shared stack with `scripts/qa/fresh-run.sh`, and the sandbox refuses both without approval.
```
