# Sharing one running app between test files (study, 2026-10-21)

Nothing was run and nothing was changed except this note. Numbers come from reading the code and from the old timing file `specs/.checkpoints/local-sweep.timing.jsonl`.

## 1. The short answer

Yes, it can be done, and it can be done in one new small file plus a one-line change in each builder. No spec file needs to change. But the gain is small: about 59 app starts saved out of roughly 593 files, which is about 30 seconds (range 20 to 45 s) in a run of 30+ minutes. Treat it as a "maybe later" item, not a main lever.

Why the gain is small:
- Inside one file the app is already built once (`beforeAll`), not once per test. So the only saving is "file 2 reuses file 1's app".
- Most files do NOT use the plain builder. Of the 38 catalog files only 7 call `createCatalogApp()` with no options. The others bring their own modules, fake objects or settings, so their app is not identical to anyone else's.
- A start-up is not very expensive any more now that module loading is shared (Vitest, one process). The old timing file shows the whole production core app taking 0.53 to 0.60 s in `beforeAll`, and a small app (projector) 0.18 to 0.21 s. The feature test apps sit in between: I estimate 0.3 to 0.8 s each (Postgres pool and 233 models, Redis, DynamoDB client, Nest wiring, listen). The older note in `shared.md` said "1 to 3 s"; that was for the Jest days when imports were loaded every time.

## 2. How the six builders are built and closed

All of them end in `generateTestingModule` (`test/utils/global-modules.ts`): config, Sequelize/Postgres (all models), Redis, rate limiter tables, request context, health, cleanup registry, tenancy, plus what the builder adds. Then `createNestApplication`, `configureHttpApp` (with `processHandlers: false`, so no listeners are put on `process`), and `app.listen(0)`.

| Builder (file) | What it adds | Reset between tests | Close |
|---|---|---|---|
| catalog (`test/utils/catalog-app.ts`) | identity API, seeds, product modules, Redis + Dynamo; option `extraImports`, `prependImports`, `overrides`, `customize`, `structuredLogger`, `redisUrl`, `env` | wipe all stores, clock back to now, key cache cleared | `app.close()` |
| auth (`libs/domains/identity/testing/auth-app.ts`) | `AuthApiModule`, seeds, fake breached-password list, fake clock; options `extraImports`, `manualRateTime`, `overrides` | wipe, clock, rate clock, fake corpus, key cache, service-token cache | `app.close()` |
| tenancy (`libs/domains/tenancy/testing/tenancy-app.ts`) | auth API + a shop probe module; options `extraImports`, `overrides` | wipe, clock, key cache | `app.close()` |
| billing (`libs/domains/billing/testing/billing-app.ts`) | sits on top of the catalog app: billing, worker, consumer, jobs (loops off), fake payment provider, fake usage lines, ClickHouse table creation | catalog reset, fakes reset, fault seam emptied, "stopping" flag, re-inserts the plan seed rows | undoes the stdout spy, closes catalog app |
| realtime (`test/utils/realtime-app.ts`) | stream module, test topics, fake clock; option `config` (limits in ms), `keepStore`, `realRateLimit` | none. It wipes once at start; tests use fresh ids | `app.close()` |
| payments (`libs/domains/payments/testing/payments-app.ts`), the next one with 12 files (delivery also has 12; not studied) | on top of the catalog app: payment modules, fake provider SDK, fake realtime, in-memory queue; sets two env vars at start | undoes `patch()` calls, fakes, queue, circuit breakers, then catalog reset | catalog close |

Nothing in these six starts the outbox poller (that one only lives in `CoreModule`). Billing starts the jobs worker with loops off. So "background pollers" are not a problem for these six. (They would be for the real application wiring specs, which this note leaves alone. Note: the poller allows only ONE running in the process, a static field, so a shared real core app would block any later app that needs its own poller.)

Every one of the specs for these builders follows the same shape: `beforeAll` builds, `beforeEach` calls `reset()`, `afterAll` calls `close()`. That is what makes sharing easy: "close" can simply mean "give it back".

## 3. What can leak from one file into the next

Things the shared app would keep, and how each one is handled today:

- **Settings.** Config is read once at boot (copied from the environment). The six builders' specs do not call `config.set` on the app (only specs of other builders do). Leak risk: low.
- **Env vars.** Some specs set an env var BEFORE the app boots and put it back after (EMAIL_PROVIDER in 2 auth files, CLOCK_CONTROL in clock-admin, EVENT_TAP in topics-admin, shop-cells env, shop-sso redirect base, payments' cursor secret). The value is frozen in the app at boot. A shared app would carry the first file's value. So: any file that passes `env`, `redisUrl` or sets env itself must not share. The builder can detect the first two; the others must be marked by hand (4 auth files, 2 tenancy files).
- **Fake clock.** Reset sets it back to "now" in every `reset()`. Fine as long as reset runs at handout.
- **Spies.** Specs spy on class prototypes (`Logger.prototype`, `PasswordHasher.prototype`, `CacheService.prototype`) and on single services (`app.get(ApiConfigService)`, `redis.get`). They restore them in `afterEach`/`afterAll` with `restoreAllMocks`. The danger is a file that forgets. The handout can call `restoreAllMocks()` as a safety net. A spy on one service object (e.g. billing-ops sets `lifecycle['stopping']`) lives inside the app, so it would also leak if not undone. Billing's reset already undoes the known one.
- **Registered cleaners** (Redis, Scylla, Dynamo wipe functions). They are registered once when the app builds and are the same for every file, so sharing is fine. This is actually the same thing `reset()` uses.
- **Module overrides.** An override is baked into the app. Two files with overrides that look alike are not the same app (each file creates its own fake object, e.g. `PROVIDER_NETWORK` in all the catalog-sync integration files). So: overrides and `customize` mean "no sharing".
- **Background pollers and loops.** None for the six (see above). The ScheduleModule cron is idle in tests.
- **Open connections.** The shared app keeps a Postgres pool (Sequelize default up to 5), Redis, Dynamo and so on open between files. One app alive is nothing. Many idle apps could eat the Postgres connection limit, which I could not check (the test Postgres `max_connections` is not in what I read). So keep at most one to three alive.
- **Listeners on `process`.** `processHandlers: false` means none are added by the app. No spec in these six uses `process.on`. Fine.
- **Process-wide leftovers that exist already** (not caused by sharing): `Logger` static override and stdout spies (the setup file already resets them per file), and the realtime builder rewrites a module-level rate limit object at every build (`realtimeRatePolicies`), which would also change a shared app's limit when a later file builds its own. This is a reason to keep realtime for last.
- **A test that closes things for real.** Specs that break Postgres or Redis through a fault proxy always pass `env` or `redisUrl`, so they are already excluded. The earlier "trending-stream" sharing attempt failed because a test in the middle closed the app: the same would happen if a spec closes `t.app` itself. In the six builders no spec calls `t.app.close()` except one realtime test (`realtime-limits`, a private app it builds with `realRateLimit`; not shared).
- **Two apps in one test.** Some files build the plain app twice (`product-cache` builds `a` and `b` with identical options for the two-instance tests; realtime too). A cache must hand out the cached app only when nobody holds it; the second request builds a fresh one.

## 4. How many files customize the builder

Counts from the `grep` of the call sites (first call of the file counted; a file can have more calls).

| Builder | Files | Plain `createX()` or an empty object | With options | Of those, files that could share anyway (same options as another file, nothing that is file-specific) |
|---|---|---|---|---|
| catalog | 38 | 7 (`product`, `product-import`, `product-query-stock`, `product-boundary`, and the first describes of `product-cache`, `product-read`, `product-events`) | 31 | 5 offline-sync files with the same three modules (phase 2, they start workers and projectors) |
| auth | 27 | 14 (`bootstrap-admin`, `auth-sessions`, `mfa-migration`, `mfa-enrollment`, `auth-jwks-keys`, `auth-register`, `purpose-tokens`, `mfa-management`, `auth-cookies-csrf`, `mfa-lifecycle`, `auth`, `sessions-revoke`, `auth-login`, `user-directory`) | 13 | `auth-jobs-admin` + `admin-jobs` (same `IdentityOpsModule`), `auth-refresh` + `auth-tokens` (same `AuthProbeModule`). `clock-admin`, `topics-admin` set an env var before boot: no. `password-reset`, `auth-password-reset`, `auth-observability` set EMAIL_PROVIDER: no. |
| tenancy | 20 | 14, minus `shop-cells` (sets env before boot) = 13 | 7 | none worth it (each has its own probe module) |
| billing | 16 | 8 (`billing-run`, `subscribe`, `billing`, `subscription-change`, `billing-reads-events`, `subscription-lifecycle`, `invoice-charging`, `plans-catalog`) | 8 | 4 with `realUsage: true` only (`usage-migration`, `entitlements-cache`, `usage-invoice-lines`, `usage-ingestion`). The 3 `structuredLogger` ones spy on stdout: no. |
| realtime | 13 | 7 (`realtime-registry`, `realtime-subscriber`, `realtime-observability`, `realtime-revocation`, `topic-replay`, `topic-stream` in libs and in `apps/sse-gateway`) | 6 (own limits and timeouts) | none |
| payments | 12 | 11 (all but `payment-events`) | 1 | none needed |

## 5. A safe design

One new file, `test/utils/shared-app.ts`, about 80 lines.

1. **A per-process cache.** A module-level `Map` keyed by `builderName + stable text of the options`. Works because `isolate: false` keeps the module alive between files. Under Jest or `VITEST_ISOLATE=1` the cache would die with each file, so sharing must be switched OFF there (see 4 below), otherwise "close" would never really close.
2. **Only plain options are keyed.** Allowed in a key: nothing, booleans, strings, and `extraImports` (module classes, keyed by class name). Anything else (an `overrides` list, `customize`, `env`, `redisUrl`, `structuredLogger`, `config` objects) means "build my own, do not share". Billing's `structuredLogger`, the proxies, the fake objects all fall out for free.
3. **Hand out and give back.** `acquire(key, build)` returns the cached app if it exists and nobody currently holds it, otherwise builds it. The object that comes back has `close()` replaced by "give back". Because every spec already calls `t.close()` in `afterAll`, no spec changes. A second request while it is held builds a fresh, unshared app (the `a`/`b` two-instance specs keep working).
4. **Switch.** `E2E_SHARE_APPS=1` turns it on; the Vitest config sets it, Jest never does. `E2E_SHARE_APPS=0` (or unset) = every call builds a fresh app exactly as today. Start with it off by default, run the suite twice (normal and reversed order), then turn it on.
5. **Escape hatch.** A new option `own: true` (removed before building) for a file that must have its own app. Used by the four auth files that set EMAIL_PROVIDER, CLOCK_CONTROL or EVENT_TAP and by `shop-cells`; it also lets someone quickly opt out when a file turns out to be sensitive.
6. **Clean on handout.** When a cached app is handed out the second time, run `restoreAllMocks()` and then the builder's own `reset()` first (wipe, clock, caches, fakes). Cost: one extra wipe of about 0.1 s, which takes some of the gain; it can be skipped only for files known to reset in `beforeEach` first thing. Keeping it is the safe default (`product-boundary` and `tenancy-startup` never call `reset()`).
7. **How many stay alive, and file order.** Keep one app alive (close the old one when another key is asked for) or at most three (least recently used). One caveat: Vitest by default orders files by past duration/size, not by folder, so files with the same builder are not next to each other and a cache of one would almost never hit. Two ways: a tiny custom sequencer that sorts by path (files of one folder then run together, `libs/domains/identity/*`, `tenancy/*`, `payments/*`), or a cache of three. The sequencer is the cleaner answer.
8. **End of the process.** The last cached app is never closed by a spec. Vitest kills the single fork when it is done, but I could not check if it waits for open Postgres/Redis handles ("close timed out" messages). Needs one trial. A fallback is closing the cached apps from the setup file's `afterAll` only when the next file is of another folder, or a `process.on('beforeExit')` hook.
9. **A safety check.** At handout, compare `process.env` and the listener counts on `process` with what they were at build time; if different, close and rebuild. Cheap and catches the sneaky cases.

## 6. Estimate

Files that could share and boots saved (a group of N identical files saves N minus 1 boots):

| Builder | Files that can share | Boots saved |
|---|---|---|
| auth | 14 plain + 2 + 2 | 13 + 1 + 1 = 15 |
| tenancy | 13 | 12 |
| payments | 11 | 10 |
| billing | 8 + 4 | 7 + 3 = 10 |
| catalog | 7 (+5 offline-sync later) | 6 (+4) |
| realtime | 7 | 6 |
| Total | about 70 files | about 59 (+4) |

At 0.3 to 0.8 s per start (and close) this is 18 to 47 seconds, call it half a minute, minus about 6 s for the extra wipe at handout. On a total near 30 minutes it is about 1 to 1.5 percent. The 4 builders after payments and the 39 others bring a few more but each with fewer files.

## 7. Recommendation, ranked

1. **Not now.** The saving is about 0.5 minute against the 17 minutes already won by Vitest. Fix the order-dependent `order-export-lifecycle` problem and finish the full Vitest sweep first. Risk of doing it too early: low, but each leak shows up as a failure that depends on file order, which is the thing you are trying to remove.
2. **If done, do it for auth, then tenancy, then payments** (14, 13 and 11 plain files: highest share of identical files, small builders, a full `reset()`, no pollers). Risk: low. Then billing (needs the fake provider state to reset properly; the reset exists), risk low to medium.
3. **Catalog** is the biggest builder by files (38) but a poor first target: only 7 files are plain. Medium for the offline-sync group (starts workers and projectors). Do it for the 7 plain files only, risk low.
4. **Realtime last.** No `reset()`, open stream connections, a rate-limit object changed in the module at every build, and many files with their own limits. Risk medium to high for 6 boots saved.
5. Leave out: real application wiring specs (`apps/*`, 59 files; poller allowed once per process), toolkit apps (already cheap), child-process specs.

## 8. Which files to change (if you go ahead with the top, clearly safe case)

For the catalog alone, the safe part is small but gives little (6 boots, about 3 s). The same change in the auth builder is the same size and gives 15 boots:

- New: `packages/backend/test/utils/shared-app.ts` (cache, handout, `own`, env switch, handout checks).
- Edit one function per builder: rename `createCatalogApp` to a private `buildCatalogApp` and export `createCatalogApp = (o) => shareApp('catalog', o, () => buildCatalogApp(o))`. For auth: `libs/domains/identity/testing/auth-app.ts`; tenancy: `libs/domains/tenancy/testing/tenancy-app.ts`; payments: `libs/domains/payments/testing/payments-app.ts` (it calls the catalog builder with overrides, which is automatically not shared inside, so share only the outer payments object).
- Edit: `packages/backend/vitest.e2e.config.ts` (set `E2E_SHARE_APPS=1` through `test.env`, add the path-sorting sequencer).
- Mark `own: true` in: `identity/clock-admin`, `identity/topics-admin`, `identity/password-reset`, `identity/auth-password-reset`, `identity/auth-observability`, `tenancy/shop-cells`. (The key rule already excludes them if they pass `env`, but they set `process.env` themselves, so the builder cannot see it.)

No spec file needs to change for the plain files: they all use `beforeAll` build, `beforeEach` reset, `afterAll` close.
