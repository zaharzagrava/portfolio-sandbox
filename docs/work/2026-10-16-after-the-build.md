# After the build: pending work, improvements and fixes

Written 2026-10-16, while the runner was on its last runs (about 45 of 67 capabilities built). Do these once every capability is done and the final checkpoint has run, in this order.

## 1. Fixes found by the runs (real defects)

- Cross-domain table access: `pnpm --dir packages/backend check:table-ownership --strict` reports 17 violations in asset-library, catalog-sync, community, content, launch-events, orders (`order-export.service.ts` reads `Product`), seller-insights and seller-onboarding. Fix in the owning domains.
- `apps/payment-processor` does not boot on its own: AuditService needs RequestContext, then ShopGuard needs ShopAccessService. See "Found by boot-app.sh" in README_ME.md.
- The first scripted buy flow failed with `JournalInvalid` in the charge worker's ledger posting (the payment stays PENDING). Left for the checkpoint repair agent; check that it is gone.
- S04 stopped on CRITICAL analyze issues (`specs/domains/S04-kyc-onboarding/.analyze.log`); confirm a later run cleared it.
- `docs:check` already fails (about 190 generated pages differ) and `pnpm slo:generate` has a module-resolution failure. Both pre-date the runs.

## 2. Deferred runtime checks (`specs/deferred-checks.md`)

Run at the final checkpoint (`!STOP final`, `scripts/sdd/checkpoints/final.sh`): the full Playwright suite, `scripts/qa/fresh-run.sh --here`, `pnpm test:journeys`, Lambda host boot, `boot-app.sh core|projector|worker`. Fix whatever they find; the file lists each deferred item with its command.

## 3. Harness improvements

- Pass timeout is 7200 s, so one hung pass costs 2 hours (S08, J01). Cut it to about 45 minutes.
- Commit the `.implement-N.log` files, so a stall can be diagnosed afterwards. Today I could not tell why passes stall.
- When an implement pass closes no task, the repair step ran three times for the same task (S46, about 1.5 hours). Run it once, then escalate.
- Pre-check generated tasks against the agents' allow-list and environment before building. Runtime proofs must never be tasks (L-019). The phone message for a block should name the missing command.
- Doctor discussion: what it is, why it said "needs human", make it ask less and fix more.
- `claude` often does not exit within 90 s after a complete answer; find out why.
- Test-integrity guard compares with HEAD, so a deletion inside a `wip` commit slips through (note in README_ME).
- Rebuild the runner image with Chromium and ffmpeg baked in: `scripts/vps/build-snapshot.sh --with-web` (needs no runner alive).

## 4. Housekeeping

- Delete the merged remote branches `origin/harness/overnight` and `origin/claude/specs-incremental` (waiting for your OK).
- Review `python3 scripts/sdd/report.py --stdout`, the QA ledger `scripts/qa/findings.tsv` and `docs/work/decisions/` (BREAKING and CONTRACT lines first).
- Spec vocabulary: read the 15 term pages that judge granularity (`upstream`, `idempotency-key`, `event-consumer`, `inbox-table`, `loader`, `outbox-relay`, `published-version`, `search-facets`, `can-advance`, `decode-snapshot`, `replay-false`, `category-tracking`, `host-bff-cookies`, `combined-business-multiplier`, `rate-limit-policy`); sign the living pages (S13, S10, S01 first); optional Opus second opinion on the term finder.
