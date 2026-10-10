# Quickstart: validating S33

Prerequisites: `docker-compose.test.yaml` services (Redis, MinIO, ClickHouse, Elasticsearch) running; run backend commands from `packages/backend`.

```bash
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/discovery/domain     # unit specs
/opt/sdd/repo/scripts/sdd/test-spec.sh autocomplete-suggest
/opt/sdd/repo/scripts/sdd/test-spec.sh autocomplete-sources
/opt/sdd/repo/scripts/sdd/test-spec.sh autocomplete-snapshot
/opt/sdd/repo/scripts/sdd/test-spec.sh autocomplete-platform
pnpm check:boundaries
pnpm check:table-ownership --strict
pnpm exec tsc --noEmit
```

Smoke: trigger `search.build-autocomplete` once, then `GET /suggest?q=iph` → `200` with `suggestions[].source` and `Cache-Control: public…`; a 101-character `q` → `400 validation_failed`.

## Ops artifacts (no automated test proves these; rows in `specs/UNVERIFIED.md`, status "not run")

- **SC-001**: `loadtest:suggest` at 50,000 rps with a realistic prefix mix and the edge cache in front; p99 ≤ 100 ms.
- **SC-003**: on a deployed worker and node, a query reaching 5 distinct searchers is suggested within 65 minutes (the e2e proves build and hot swap, not the hourly wall clock).
- **SC-007**: 20 single-typo fixture searches against the real engine, at least 18 correct (needs S32's fuzzy method).
- **SC-008**: a 200,000-query index uses ≤ 400 MB per serving node (AS-54 proves a scaled bound only).
- Edge cache honours `Cache-Control`, keys on the full URL and forwards no credentials for `/suggest`.
