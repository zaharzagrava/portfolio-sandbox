# Test suite rules (one suite, front end and backend; binding for scripts/sdd AND scripts/aiqa)

Owner rules, 2026-10-25. Every agent that writes or changes a test follows them.

## 1. One suite
- The SDD flow (specs to code) and the AI QA flow (testing built code) both result in the SAME suite, one per side. Tests an SDD agent writes and tests an AI QA agent writes live side by side, follow the same naming, and share the same time budget. Any new standard, prompt or script for either flow must carry this rule.
- One front-end suite (`npx playwright test` plus the unit tests next to the code) and one backend suite (e2e next to the code, unit tests). No second suite, no parallel folder, no "AI QA suite" on top.
- Before writing a test, look for an existing test of the same behaviour. Reuse it, extend it, or fix it. Never add a duplicate.
- New tests go into the existing feature file, or into one file per feature in the normal place. Not one file per section, not 15 files per page.
- The AI QA map (`scripts/aiqa/coverage/*.tsv`) points to tests that live in the normal suite. It never creates tests by itself.

## 2. Every test is tied to the spec
- The title starts with the capability and scenario id, as the SDD gate requires (`scripts/sdd/check-tests.py`): `it('S13 AS-12: ...')`, web: `test('W04 AS-42: ...')`; `describe('... (AS-01, AS-02)')` may group scenarios.
- A scenario id must never disappear from the suite. Tests may be merged, split, renamed; the scenario must stay carried by some test (or be retired with a reason in `retired-scenarios.md`).
- A new behaviour with no scenario gets a new `AS-nn` row in the capability's test-plan (`specs/<kind>/<spec>/test-plan.md`) and the proof tag in the living spec (`docs/spec/capabilities/<spec>.md`), in the same change as the test. AI QA map lines (`aiqa-lines` annotation) are extra metadata, never the only link.

## 3. Performance budget
- Front-end suite: about 9 to 10 minutes at 3 or 4 workers. Backend suite: about 12 minutes at 6 to 8 shards. A change that pushes either over its budget must be made cheaper or merged before it lands. Measure the suite time before and after any change that adds more than about 20 tests, and report it.
- Cheap tests: log in by API (not the UI) unless the test is about login; create the seller/shop/product once per file or describe (`beforeAll`), not per test; no fixed sleeps; wait on a condition; no waiting for background jobs longer than needed (poll fast); share read-only fixtures; run independent tests in parallel.
- Phone project only for specs about the phone layout (drawer, sheet, cards, sideways scroll). Behaviour, API, database, role and concurrency tests run once, on desktop.
- Slow or special runs are never in the normal run and are gated by an env switch: container pausing (fault injection), the 10,000-row seed, the 12-minute auction, the 49-minute photo purge.
- Never weaken a check, raise a timeout, or add retries to make a test fit the budget.

## 4. Flakes
- A test that fails and then passes is a bug to explain, never to retry. Shared state (one process, shared database, process-wide counters, random ids) is the usual cause: isolate the test.

Where this is enforced: `scripts/sdd/check-tests.py` (scenario ids, no skips), `scripts/sdd/spec-prompt*.md` and the implement prompts (rules 1 to 3), `scripts/aiqa/README.md` and the tester and fixer prompts.
