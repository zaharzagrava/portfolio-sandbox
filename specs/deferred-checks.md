# Checks that a doctor deferred to the final checkpoint (lesson L-019)

One line per task: capability, task id, the command that proves it. `scripts/sdd/checkpoints/final.sh` prints this file after it has run the proofs.

- S39-analytics-ab T064: `scripts/qa/fresh-run.sh` (empty stack), then the three manual steps of `specs/domains/S39-analytics-ab/quickstart.md`
- S11-flash-sales T069: `scripts/infra/boot-app.sh core` and `scripts/infra/boot-app.sh worker` (routes `/api/shops/:shopId/flash-sales` and `/api/flash-sales` mapped, five `flash-sale.*` handlers and the two schedules registered, no `UnknownJobTypeError`)
- S11-flash-sales T026: apply `migrate:up` on a throwaway database seeded with legacy `FlashSale` rows (a `LIVE` row, a `NULL`-shop `SCHEDULED` row, an overlapping pair) as in `specs/domains/S11-flash-sales/data-model.md`, check the result, then `migrate:down` on that database only
- S44-storefront-widget T056: `scripts/qa/fresh-run.sh` (empty stack), then `scripts/infra/boot-app.sh core` and `scripts/infra/boot-app.sh projector`; `GET /api/widget/v1/config?key=pk_live_abcdefghijklmnopqrstuvwx` must answer `404 widget_site_not_found` (not 503) and the projector lists the three widget consumers
