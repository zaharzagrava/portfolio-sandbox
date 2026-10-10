# Quickstart: validating S52

Run from `packages/backend`. Prerequisite: the test Redis from `docker-compose.test.yaml` is up. Contracts: [contracts/cache-toolkit.md](contracts/cache-toolkit.md); records: [data-model.md](data-model.md).

## Automated validation

```bash
S=/opt/sdd/repo/scripts/sdd/test-spec.sh
# Unit specs (*.spec.ts) use the default jest config; the helper above runs only *.e2e-spec.ts.
pnpm test libs/infrastructure/cache     # cache-key (AS-09), cache-options (AS-10, 39, 41, 63), cache-surface (AS-40),
                                        # xfetch (AS-19, 20), bloom-filter (AS-27), write-behind-counter (AS-53),
                                        # etag-match (AS-65), cache-control (AS-70), entry-codec
$S libs/infrastructure/cache/cache-read-path.e2e-spec.ts       # AS-01–08, 11
$S libs/infrastructure/cache/cache-stampede.e2e-spec.ts        # AS-12–18, 21
$S libs/infrastructure/cache/cache-penetration.e2e-spec.ts     # AS-22–26, 28
$S libs/infrastructure/cache/cache-invalidation.e2e-spec.ts    # AS-29–39
$S libs/infrastructure/cache/cache-degradation.e2e-spec.ts     # AS-42–48
$S libs/infrastructure/cache/write-behind-counter.e2e-spec.ts  # AS-49–52, 54–56
$S libs/infrastructure/cache/distributed-lock.e2e-spec.ts      # AS-57–62
$S libs/infrastructure/cache/http-caching.e2e-spec.ts          # AS-64, 66–69
$S libs/infrastructure/cache/cache-operations.e2e-spec.ts      # AS-71–73
$S libs/infrastructure/cache                                    # whole suite, once at the end
```

Static gates: `pnpm exec tsc --noEmit`, `pnpm exec eslint libs/infrastructure/cache` (including the `Date.now`/`Math.random` ban), `pnpm check:boundaries`. Expected: the whole suite green against real Redis; no open-handle warning; `check:table-ownership` has no line for this lib.

## Ops artifacts

Success criteria that no automated test proves. Each is also a row in `specs/UNVERIFIED.md` with status "not run"; none is verified.

- **SC-004** (10,000 repeated lookups of one unknown key cause 1 source read): the suite proves five reads (AS-22). To run: loop 10,000 `getOrLoad` calls with `negativeTtlMs` against the test Redis and count loader calls.
- **SC-005** (≤ 5 % of 1,000 same-time keys share one expiry second): AS-20 proves the ±10 % range and spread, not the per-second share. To run: store 1,000 keys, read `PTTL` of each, bucket by second.
- **SC-008** (after 1,000,000 distinct reads the in-process structures stay at their limits): AS-05 proves 20,000 keys. To run: a script reading 1,000,000 distinct keys, sampling `cache_l1_entries` and heap.
- **SC-009** (cache layer adds < 5 ms p99 over the store round trip): no latency test. To run: a benchmark against the VPS runner Redis comparing `getOrLoad` hits with a bare `GET`.
