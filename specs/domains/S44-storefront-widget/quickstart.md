# Quickstart: validating S44 — Embeddable storefront widget

Run from `packages/backend` unless noted. Spec runner: `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern> [jest args]` (condensed result plus the full-log path; open the log only when that is not enough). Narrowest file first; the whole capability once at the end, in batches of fresh processes (L-008).

## Prerequisites

- Test stack up (`docker-compose.test.yaml`): Postgres with the real migrations (expand + contract), Redis, Kafka and ElasticMQ stand-ins; compare tables and keyspaces with the doctor (L-011, L-002).
- Config in the test environment: `widget_token_key` set (the boot-failure test unsets it on purpose), `WIDGET_APP_BUNDLE_URL` default.
- Kit `testing/widget-kit.ts`: frozen/advanceable clock, `signWidgetHandoff`, switchable faults (product lookup, single-use store, limiter store), restored in `afterEach` (L-013). Every test creates its own shop, site and products (L-005, L-006).

## Scenario runs (see [`test-plan.md`](test-plan.md))

| Step | Command | Expected |
|---|---|---|
| 1 pure rules | `pnpm run test libs/domains/developer-platform/domain` | `origin`, `theme`, `handoff-claims`, `frame-policy`, `shop-copy` specs green |
| 2 dashboard | `test-spec.sh libs/domains/developer-platform/widget-sites.e2e-spec.ts` | AS-01…AS-13 (AS-05, AS-07, AS-11 repeated 20×) |
| 3 config and CORS | `test-spec.sh libs/domains/developer-platform/widget-config.e2e-spec.ts` | AS-14…AS-22 |
| 4 identity | `test-spec.sh libs/domains/developer-platform/widget-identity.e2e-spec.ts` | AS-23…AS-33 |
| 5 embed | `test-spec.sh libs/domains/developer-platform/widget-embed.e2e-spec.ts` | AS-34…AS-38 |
| 6 kill and lifecycle | `test-spec.sh libs/domains/developer-platform/widget-kill-lifecycle.e2e-spec.ts` | AS-39…AS-46 (AS-40 repeated 20×; duplicate and invalid payload per consumer) |
| 7 contract | `test-spec.sh libs/domains/developer-platform/widget-contract.e2e-spec.ts` | AS-51…AS-53 |
| 8 loader (from repo root) | `pnpm --dir packages/edge-be test widget-loader` | AS-47…AS-49 |
| 9 static gates | `pnpm check:boundaries`, `pnpm check:table-ownership --strict`, `pnpm check:module-graph`, `pnpm check:model-registry`, `pnpm check:no-wallclock`, `tsc --noEmit` (backend, edge-be, contracts), ESLint, `python3 scripts/livespec/check.py` | clean for this capability's files (AS-54); `.tx.baseline` count not raised |
| 10 real apps boot (L-004, L-015, L-018) | start `apps/core` and `apps/projector` on their own with the scripts the checkpoint uses | both start; `GET /api/widget/v1/config?key=pk_live_<24 chars>` answers `404 widget_site_not_found`; projector lists the three widget consumers. **Ran 2026-10-14:** `scripts/infra/boot-app.sh core` UP (widget routes mapped) and `boot-app.sh projector` UP (`widget-shop-updated`, `widget-shop-status`, `widget-shop-deleted` started). The `404 widget_site_not_found` over HTTP is **not run**: the API on :8000 is a stale process that answers `503 service_unavailable`, and the unattended session may not start or restart a server; re-run after restarting the API (see specs/UNVERIFIED.md) |
| 11 full capability suite, once | steps 1–8 in batches of fresh processes | every batch ends with its summary line |

UI journeys (W07 `widget.spec.ts`, W04 `developers.spec.ts`) are owned by those capabilities (AS-50 is W07's).

## Ops artifacts (success criteria no automated test proves — status "not run")

- **SC-002 (intermediary part)**: copies held by intermediaries stop being served within 60 s after a switch-off. Run: purge-less CDN stand-in test, `max-age`/`s-maxage` observation after a kill. The application-side "next request on every instance" part is proven by AS-20/AS-39.
- **SC-004**: in a real browser a page on an unregistered origin cannot display the embed document, a registered one can, 20 pairs. Run: Playwright matrix against a staging stack (W07 owns only the happy path).
- **SC-005**: a shop owner registers a site and sees a working button in under 5 minutes, unaided. Run: moderated usability session with the W04 screens.
- **SC-007**: `k6 run scripts/load-tests/widget-config.test.js` — 50,000 config requests/s over 10,000 sites behind a CDN stand-in, ≥ 99% served by intermediaries.
- **SC-008**: rename/suspension reflected within 60 s in 99% of cases. Run: staging soak with tenancy event generator, measuring event-to-decision lag percentile.

Each of the five is also a row in `specs/UNVERIFIED.md` (status `not run`). SC-001, SC-003, SC-006 and SC-009 are proven by AS-15/AS-16, AS-24–AS-26, AS-47–AS-49 and AS-52 respectively; none of the five above may be described as verified.
