# What is left hanging (2026-10-20)

Written after the build loop finished its last capability run. 66 of 67 capabilities are built; J05's gate is open and the final checkpoint was
running on the VM when this was written. The longer, older list is `docs/work/2026-10-16-after-the-build.md`; this page is the one to read first.

## 1. Not finished

- J05 (engagement loop): all tasks implemented, journey gate at 35 of 36 tests. AS-01 waits 20 s for a `feed.item_published` event on `feed.events`
  and times out. Probable cause: every event-tap read (`GET /api/admin/topics/:topic/messages`) creates a new Kafka consumer group, about 5 s per read
  (`libs/infrastructure/kafka/topic-tap.service.ts`). The relay schedule was lowered from 5 s to 2 s by a repair; that is not the remedy. No
  `.implemented` marker exists for J05.
- The final checkpoint (`!STOP final` at the end of `scripts/sdd/orders/by-flow.txt`): regression sweep of all backend suites and the browser suite, the
  scripted buy flow, the QA agent, checkpoint repair. It started on the VM on 2026-10-20 and its result is not in this page.

## 2. Known real defects

- Table ownership: `pnpm --dir packages/backend check:table-ownership --strict` reports 17 cross-domain table accesses (asset-library, catalog-sync,
  community, content, launch-events, orders (`order-export.service.ts` reads `Product`), seller-insights, seller-onboarding).
- `apps/payment-processor` does not boot on its own (AuditService needs RequestContext, then ShopGuard needs ShopAccessService). See "Found by
  boot-app.sh" in `README_ME.md`.
- `JournalInvalid` in the charge worker's ledger posting during the first scripted buy flow (the payment stays PENDING). Check that it is gone.
- `docs:check` fails (about 190 generated pages differ) and `pnpm slo:generate` has a module-resolution failure. Both pre-date the runs.
- The API log prints `MaxListenersExceededWarning: 11 finish listeners added to [ServerResponse]` about 9,000 times per full browser run: some
  middleware adds a finish listener per request.

## 3. Weakened or fragile tests

- W04 AS-19 was loosened by the doctor: `packages/web/tests/seller-live.spec.ts` waits up to 20 s for the Orders counter (spec: 2 s). The living page
  `docs/spec/capabilities/W04-*.md` (B-07) still says "within 2 seconds" and cites this test as its proof. Either restore 2 s or change the page.
- Log-check journeys (J01 AS-30, J03 AS-39) read the API log by byte offset and require every JSON line to carry a request id. KafkaJS logs through its
  own logger (partitioner warning, rebalance lines) with no id. J03 now takes a mark at its start (J01 already did), but a rebalance line inside a run still carries no id. Decide: route
  kafkajs through the app logger, or skip `logger: kafkajs` lines explicitly in the check.
- Flaky browser tests are recorded per capability in `specs/<capability>/flaky-specs.md` (the gate retries a failing browser test once).
- J02 AS-27 (a webhook receiver that fails then recovers must get the event once) timed out waiting 20 s for the event; never diagnosed.

## 4. Unverified claims

- `specs/deferred-checks.md`: 27 runtime proofs that were deferred to the final checkpoint (fresh-stack runs, standalone boots, full browser suites).
- `specs/UNVERIFIED.md`: 313 lines of things marked "not run".
- The shopping assistant (S46, W05) was only ever run with the scripted provider (`LLM_PROVIDER=scripted`): it answers `echo: <question>`. The
  Anthropic adapter (`AnthropicLlmProvider`) exists but has not run against a real model. Quotas, fallback model, tools and moderation are not exercised
  with real answers.

## 5. How far to trust docs/spec

- 66 capability pages (all but J05), 16 concept pages, 5 model pages, 1,747 term pages. `python3 scripts/livespec/check.py`: 0 errors, 1,959 warnings.
- All 66 capability pages have `status: draft`: none was read and signed by a human (`docs/spec/REVIEW.md` says how; start with S13, S10, S01).
- The scripts prove that links, terms and proof pointers exist (2,877 rules cite a test, 44 are marked `[proof: none]`). They do not prove that a
  cited test checks the sentence, nor that the test passes. The W04 AS-19 case above is an example of a page and its proof drifting apart.
- 183 "used by" blocks are stale (`check.py --fix-backlinks`), 173 terms have a rule or definition that changed since they were written.
- Treat the pages as the best map of what was built and why; check a number or a limit in the code before relying on it.

## 6. Decisions and housekeeping

- 60 files in `docs/work/decisions/`: read the BREAKING and CONTRACT lines first. `python3 scripts/decisions/triage.py status` shows what is open.
- The 15 term pages that judge granularity (`upstream`, `idempotency-key`, `event-consumer`, `inbox-table`, `loader`, `outbox-relay`,
  `published-version`, `search-facets`, `can-advance`, `decode-snapshot`, `replay-false`, `category-tracking`, `host-bff-cookies`,
  `combined-business-multiplier`, `rate-limit-policy`).
- Delete the merged remote branches `origin/harness/overnight` and `origin/claude/specs-incremental` (waiting for your OK).
- Rebuild the runner image with Chromium and ffmpeg and a clean database: `scripts/vps/build-snapshot.sh --with-web` (needs no runner alive). The
  image's database holds rows dated 2026-10-19/20 from journeys that moved the clock.
- Your `interview-prep/` edits are untouched and uncommitted.

## 7. Quick manual check on your machine (each in its own terminal; nothing detached)

- Once: `pnpm install`, `FORCE=1 bash scripts/infra/make-dev-env.sh` (rewrites `packages/backend/.env`).
- `moon run infra-setup`, then `moon run dev-monolith` (API :8000), then once `pnpm --filter api seed:dev`.
- `pnpm --filter api run start:lambda-local document-extractor media-processing` (shop verification, photos).
- `moon run dev-web` (http://localhost:3000). Logins: `admin@marketplace.local` and `seller@marketplace.local`, password `Demo-Seed-Pw-7491!`.
- Stop: Ctrl+C in each terminal, then `moon run infra-down`.

## 8. Found by hand (2026-10-20, manual check on the laptop)

- Seller product photos (`/dashboard/seller/<shopId>/products/<productId>/media`): after an upload the photo is "not properly loaded", disappears on reload,
  and "Save photos" does nothing. The browser test `seller-photos.spec.ts` passed on the VM, so this is a gap between the scripted test and a real
  session (the media stand-in was not running at first, see L-034; with it running the symptoms above remained). No charter of the QA agent covers
  seller product media, which is exactly what an exploratory pass is for. Not diagnosed.
