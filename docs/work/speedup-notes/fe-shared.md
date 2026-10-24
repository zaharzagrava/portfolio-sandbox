# Browser tests: shared-layer speed-ups (nothing run, only read and edited)

## What changed
1. tests/global-setup.ts
   - Warm-up: before any test starts, the setup fetches 12 public pages (home, login, register, forgot/reset password, mfa, search, cart, chat, terms, privacy, developer docs), 3 at a time, in parallel with the other setup work. The dev server compiles a page the first time someone asks for it; now that cost is paid here and not inside the first test of each worker. Answers are ignored, so the warm-up cannot fail the run.
   - The demo-data script (`seed:dev`, a whole Node program started fresh) is skipped when the demo data is already there (seller and admin can sign in, the demo product is found by search). `PW_FORCE_SEED=1` forces it as before.
   - Redis connection is closed after the clean-up so the setup process does not hang.
2. tests/helpers.ts: `resetRateLimits` kept one new Redis connection per call (open, scan, close), and nearly every journey calls it. Now one connection per worker is opened once and reused (rebuilt if it breaks). Same scan and delete, same effect. New small export `closeSharedRedis`.
3. Auth specs (auth, auth-mfa, auth-password-reset, auth-sessions, auth-google): I found no fixed waits or repeated UI set-up to remove. They are one long test each, already use the API shortcut for registering where the form is not the point, and every wait is a real condition. Left untouched.

## Expected saving (estimates, not measured)
- Warm-up: roughly 20 to 60 s of compile time moves out of the tests; it mostly removes slow/flaky first tests rather than total time.
- Skipping seed: maybe 10 to 30 s per run.
- Redis connection: a few tens of ms per registration, a few seconds over 460 tests.
Honest total: about 1 to 2 minutes of 22 to 25. The big wins are elsewhere (worker count, mobile project, see below).

## What could break
- If the demo data is half-there (e.g. a new seed was added to `seed:dev` since the last run) the skip hides it. `checkSeeds` still runs and names missing ones; use `PW_FORCE_SEED=1` after changing the seed script.
- The skip check logs in the demo accounts twice; if the login limiter were tight this could use two attempts (the limiter is cleared just before).
- Warm-up adds load at the start; it is 3 requests at a time.

## Report only (not changed)
- Config: retries, trace (`on-first-retry`), no video or screenshots by default: already cheap. The `html` reporter adds little. `fullyParallel: true` is already on. Production build only starts for a full run (needsProdServer): that build (`build:e2e`) is a large part of the start-up of a full run; it is needed only by security-headers, widget-embed and app-shell.prod specs, which could run as a separate later step so the main run does not wait for it (the prod server starts in parallel with tests only if Playwright allowed it; it does not, it waits). Suggest: run those 3 specs in a second command.
- Workers (2): Most tests use a unique e-mail per test (`uniqueEmail`), unique shop names, unique flag keys, isolated products, so per-test data is separate. Shared things that make more workers risky: (a) the seeded seller and admin accounts are used by admin-access, admin-flags, chat, knowledge, bff-session, app-shell (shared shops/flags/sessions); (b) the API rate limiters are per machine IP (register 10/hour etc.): `resetRateLimits` wipes them for everybody, which is safe for more workers but means one worker's reset can interrupt another's rate-limit test if any test asserts a 429; (c) the shared trending/ranking store (comment in helpers); (d) the clock specs are already split out. Two files use serial mode (buy-to-payout, seller-live). 3 workers looks plausible; try it with `--workers=3` and look for failures in the files in (a). RAM was the stated reason for 2.
- Mobile project skip candidates (non-visual server behaviour, same result at any width): security-headers.spec.ts (8 tests, almost all `request` calls), bff-session.spec.ts, widget-embed.spec.ts (bundle checks, partly), developer-docs.spec.ts (4 tests, 9 `request` uses, check), visitor-events.spec.ts (events sent by the page; viewport-independent), share-link.spec.ts, product-recommendations / home-trending (API-driven content). Those marked with `request`-heavy usage are strongest: security-headers, bff-session, visitor-events. Together perhaps 15 tests, ~3 percent of the suite. A way to do it without dropping a test: `test.skip(({ isMobile }) => isMobile, 'same on desktop')` is dropping; better to keep and decide with the owner.
