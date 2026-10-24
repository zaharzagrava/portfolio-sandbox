# Browser tests, buyer side: speed-up notes

## What changed
Nothing. I read the files and found no change that is safe without running the tests.

## Already fine
- playwright.config.ts already has fullyParallel on, so tests inside one file already run side by side. No file uses serial mode (only buy-to-payout and seller-live mention configure; buy-to-payout is the clock-moving one and must stay alone).
- Sign-up already goes through the API (register). None of my files use the form path.
- No screenshots or traces are taken needlessly (trace is only on first retry).

## Waits I looked at and left alone (each is a real signal or a "nothing happens" check)
- visitor-events.spec.ts: 6.5 s wait in the privacy-signal test. It proves no event is sent after the 5 s flush timer. Shortening it would weaken the check. Possible later: fake the browser clock (page.clock) to jump 5 s. Saving about 6.5 s x2 projects, but it needs a test run to trust.
- app-shell.spec.ts AS-01: seven 1 s waits (about 7 s x2). They give hydration errors time to show up (a "nothing bad appears" check). Same idea: could use the fake clock, needs a run to verify.
- home-trending.spec.ts: 1 s poll for the trending API, only when empty. A real wait.
- notifications.spec.ts JN-1: reload then networkidle then read the bell. The networkidle is what makes sure the count has loaded; replacing it risks flakes.
- developer-docs.spec.ts and app-shell.prod.spec.ts: networkidle is the thing being tested (scripts loaded, prefetch finished).
- visual/search.spec.ts and visual/stubs.ts: the delays are deliberate slow-server simulations.
- Large setTimeout values (120-180 s) in product-community, home-trending, share-link, notifications, app-shell are ceilings, not sleeps; they cost nothing when the test is quick.

## Files read, no improvement found
All files in my list.

## Biggest real saving left (outside my files)
The suite is about 6 s per test mostly from page loads on the dev server (pages compile on demand). Running against the production build, or warming pages once in global-setup, would help far more than any edit in these specs.
