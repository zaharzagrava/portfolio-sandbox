---
id: S33
title: Search autocomplete: query-log top-K trie, catalog completions, per-source budgets, typo fallback
kind: capability
status: draft
generated_at: e95ce81
depends_on: [S32, S49, S50, S54, S52]
concepts: [search-index, cache-layers, rate-limit-policy, problem-json-errors, job-scheduler-lease, access-token-session]
models: []
scope:
  - packages/backend/libs/domains/discovery/**
  - packages/backend/libs/infrastructure/storage/**
  - packages/contracts/src/search/**
---
# S33 - Search autocomplete: query-log top-K trie, catalog completions, per-source budgets, typo fallback
## Purpose
A buyer who types in the search box needs suggestions after every keystroke. This capability blends popular past queries, visible product titles and typo-corrected titles into one list. An hourly offline build turns the search log into a versioned snapshot. Every serving node holds that snapshot in memory and swaps it without downtime. A slow or failing source never fails the request.

## Entry points
- `GET /suggest` (served under `/api/suggest`): anonymous, per-keystroke call with `q` (required) and `limit` (optional). It returns `{prefix, suggestions, degraded}`. [code: packages/backend/libs/domains/discovery/api/suggest.controller.ts#SuggestController]
- Job `search.build-autocomplete`: runs hourly, once across replicas, with a lease of 10 minutes. It aggregates the search log and publishes a snapshot. [code: packages/backend/libs/domains/discovery/infra/autocomplete-builder.jobs.ts#AutocompleteBuilderJobs]
- Snapshot poll on every serving node: reads the version pointer every 30 seconds and hot-swaps the in-memory index. [code: packages/backend/libs/domains/discovery/application/query-index.service.ts#QueryIndexService]
- Module `AutocompleteModule` (API) and `AutocompleteWorkerModule` (build job). [code: packages/backend/libs/domains/discovery/autocomplete.module.ts#AutocompleteModule]

## Rules
- **S33.R-01** `GET /suggest` MUST be [anonymous](../terms/viewer.md): a missing, valid, invalid or expired [bearer token ↗](../sw-external-terms.md#authorization-bearer) all give `200` with identical bodies. [proof: S33 AS-08] [code: packages/backend/libs/domains/discovery/api/suggest.controller.ts#SuggestController]
- **S33.R-02** The endpoint MUST accept only `q` and `limit`. An unknown parameter, a missing `q`, or a `limit` that is not an integer from 1 to 10 MUST give `400`. [proof: S33 AS-03, S33 AS-06] [code: packages/contracts/src/search/suggest.ts#suggestQuerySchema]
- **S33.R-03** The endpoint MUST reduce `q` as [S32](S32-product-search.md) reduces search text ([compatibility folding](../terms/search-query-sanitisation.md), control characters removed, whitespace collapsed, trimmed, lower-cased). The response [`prefix`](../terms/suggest-prefix.md) MUST show the reduced text. [proof: S33 AS-04]
- **S33.R-04** A reduced `q` longer than 100 characters MUST give `400`. The endpoint MUST NOT truncate it. [proof: S33 AS-06]
- **S33.R-05** An empty reduced prefix MUST give `200 {prefix: "", suggestions: [], degraded: []}` with [`Cache-Control: public, max-age=60, s-maxage=60` ↗](../sw-external-terms.md#cache-control). It MUST NOT consult the [query index](../terms/query-index.md) or [the engine](../terms/search-engine.md). [proof: S33 AS-05]
- **S33.R-06** When `limit` is omitted, the answer MUST hold at most 8 [suggestions](../terms/suggestion.md). [proof: S33 AS-03]
- **S33.R-07** [Query suggestions](../terms/query-suggestion.md) MUST be ordered by [distinct searchers](../terms/distinct-searchers.md) descending, then by text ascending. Two identical calls MUST give byte-identical answers. [proof: S33 AS-02, S33 AS-52, S33 AS-53] [code: packages/backend/libs/domains/discovery/domain/top-k-trie.ts#TopKTrie]
- **S33.R-08** [Wildcard, operator and markup characters](../terms/search-query-sanitisation.md) in `q` MUST be treated as plain text. `iph*` MUST NOT match `iphone 17`. [proof: S33 AS-07]
- **S33.R-09** The [blend](../terms/suggestion-blend.md) MUST remove duplicates on [normalised text](../terms/normalize-email.md). The first occurrence wins in the order query, [catalog](../terms/catalog-suggestion-source.md), [typo](../terms/typo-suggestion-source.md). [proof: S33 AS-14] [code: packages/backend/libs/domains/discovery/domain/suggestion-blend.ts#blendSuggestions]
- **S33.R-10** The blend MUST give queries `⌈0.6 × limit⌉` [slots](../terms/suggestion-blend.md) and the catalog at most 5. [Each source MUST hand unused slots to the other.](../terms/suggestion-blend.md) [proof: S33 AS-15] [code: packages/backend/libs/domains/discovery/domain/suggestion-blend.ts#blendSuggestions]
- **S33.R-11** [Catalog completions](../terms/catalog-completions.md) MUST come only from [visible products](../terms/search-visibility.md), for prefixes of two or more characters, through [S32](S32-product-search.md)'s [`ProductTitleSuggester`](../terms/product-title-suggester.md). [proof: S33 AS-13] [code: packages/backend/libs/domains/discovery/infra/catalog-title-source.adapter.ts#CatalogTitleSourceAdapter]
- **S33.R-12** A [source failure](../terms/suggestion-source.md) MUST NOT fail a valid request. Each missing source MUST be named in [`degraded`](../terms/degraded.md). [proof: S33 AS-16, S33 AS-17, S33 AS-18]
- **S33.R-13** A response with a non-empty `degraded`, and every `400` and `429`, MUST carry [`Cache-Control: no-store` ↗](../sw-external-terms.md#cache-control-no-store). Every other `200` MUST carry [`public, max-age=60, s-maxage=60` ↗](../sw-external-terms.md#cache-control). [proof: S33 AS-05, S33 AS-10, S33 AS-16] [code: packages/backend/libs/domains/discovery/api/suggest.controller.ts#SuggestController]
- **S33.R-14** Five consecutive catalog failures MUST open the [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) for 10 seconds. While it is open, requests MUST skip the catalog and report [`catalog_unavailable` ↗](../sw-external-terms.md#circuit-breaker). After 10 seconds exactly one [probe](../terms/circuit-breaker-probe.md) is admitted. [proof: S33 AS-19, S33 AS-21] [code: packages/backend/libs/domains/discovery/domain/catalog-circuit.ts#CatalogCircuit]
- **S33.R-15** Catalog results MUST be [cached](../terms/cache-entry.md) per [normalised prefix](../terms/reduced-prefix.md) for 60 seconds. A failed or timed-out call MUST NOT be cached. [proof: S33 AS-20]
- **S33.R-16** The endpoint MUST allow 600 requests per minute [per address](../terms/rate-limit-subject.md). The 601st MUST give `429` [problem+json ↗](../sw-external-terms.md#problem-json) [`rate_limited`](../terms/rate-limit.md) with [`Retry-After` ↗](../sw-external-terms.md#retry-after) and `no-store`. [proof: S33 AS-09, S33 AS-10] [code: packages/backend/libs/domains/discovery/rate-limit-policies.ts#discoveryRatePolicies]
- **S33.R-17** The answer MUST depend only on the [reduced prefix](../terms/reduced-prefix.md), `limit`, the [loaded snapshot](../terms/suggest-snapshot.md), the [blocklist](../terms/suggestion-blocklist.md) and the catalog. It MUST NOT set a cookie or [vary on credentials ↗](../sw-external-terms.md#vary-header). [proof: S33 AS-48]
- **S33.R-18** The blocklist MUST apply to every suggestion of every source at [serve time](../terms/serve-time.md), and to the [build input](../terms/suggestion-build.md). A change MUST take effect after a restart or [reload](../terms/suggest-snapshot.md) without a new build. [proof: S33 AS-12, S33 AS-38] [code: packages/backend/libs/domains/discovery/domain/query-eligibility.ts#containsBlocked]
- **S33.R-19** The build MUST count [distinct searchers](../terms/distinct-searchers.md), not searches, and MUST [de-duplicate ↗](../sw-external-terms.md#idempotency) rows by [event id](../terms/event-id.md). The result MUST NOT depend on row order or timestamp order. [proof: S33 AS-28, S33 AS-34]
- **S33.R-20** The build MUST keep at most the [configured number of queries](../terms/suggestion-build.md) (default 200,000), ordered by [searchers descending](../terms/distinct-searchers.md), then text ascending. [proof: S33 AS-35] [code: packages/backend/libs/domains/discovery/application/autocomplete-build.service.ts#AutocompleteBuildService]
- **S33.R-21** The snapshot MUST hold only [`{query, searchers}` pairs](../terms/suggest-snapshot.md) and build parameters. It MUST carry a [checksum ↗](../sw-external-terms.md#checksum), and decoding MUST fail with a typed reason on any damage. [proof: S33 AS-29, S33 AS-40] [code: packages/backend/libs/domains/discovery/domain/snapshot-codec.ts#decodeSnapshot]
- **S33.R-22** The [version pointer](../terms/version-pointer.md) MUST move forward only in the [builder](../terms/suggest-builder.md). A build with a version not greater than the pointer MUST delete its own object and end [`superseded`](../terms/build-end-states.md). [proof: S33 AS-33, S33 AS-39] [code: packages/backend/libs/domains/discovery/domain/snapshot-pointer.ts#canAdvance]
- **S33.R-23** A build with unchanged entries MUST end `unchanged`. A build with zero [eligible queries](../terms/eligible-query.md) MUST end `skipped_empty`. Neither MUST [publish](../terms/suggest-publish.md). [proof: S33 AS-30, S33 AS-31]
- **S33.R-24** A node whose load fails MUST keep serving the [current index](../terms/suggest-index.md) and [count the failure by reason](../terms/load-failure-reason.md). A node MUST follow the pointer backwards when an [operator](../terms/operator.md) sets it back. [proof: S33 AS-42, S33 AS-43, S33 AS-45, S33 AS-47]
- **S33.R-25** A request MUST see one index entirely. [Concurrent refreshes on a node MUST collapse into one download ↗](../sw-external-terms.md#single-flight). [proof: S33 AS-41, S33 AS-46]

## Behaviors
- **S33.B-01** Given a [published log](../terms/query-log.md) and visible iPhone products, when an anonymous client calls `GET /api/suggest?q=IPH`, then it gets `200` with [`prefix: "iph"`](../terms/suggest-prefix.md) and a [blended list](../terms/blended-suggestions.md) of `query` and [`catalog`](../terms/suggest-entry-kinds.md) entries. [proof: S33 AS-01]
- **S33.B-02** Given `iphone case` and `iphone cable` with [equal searchers](../terms/distinct-searchers.md), when `q=iph` is called twice, then the equal counts are [ordered by text ascending](../terms/suggest-ordering.md) and both answers are identical. [proof: S33 AS-02]
- **S33.B-03** Given [`limit=0`](../terms/suggest-limit.md), `11`, `abc` or `2.5`, when the endpoint is called, then it answers `400` [problem+json ↗](../sw-external-terms.md#problem-json). [proof: S33 AS-03, S33 AS-06]
- **S33.B-04** Given `q` of `%20IPh%20%20one`, [fullwidth text ↗](../sw-external-terms.md#fullwidth-forms) or text with a control character, when called, then [the prefix is reduced like S32 reduces it](../terms/search-query-sanitisation.md). [proof: S33 AS-04]
- **S33.B-05** Given a blank `q`, when called, then the answer is empty, [cacheable for 60 seconds ↗](../sw-external-terms.md#cache-control), and [no source is consulted](../terms/suggestion-source.md). [proof: S33 AS-05]
- **S33.B-06** Given a [published](../terms/published-query.md) 46-character query, when [`q`](../terms/autocomplete-q-parameter.md) is a 24-character or 35-character prefix of it, then the query is returned. [proof: S33 AS-11]
- **S33.B-07** Given a published `cheap iphone` and a product `Cheap iPhone Stand`, when `cheap` is added to the [blocklist](../terms/autocomplete-blocklist.md) and [the service reloads it](../terms/blocklist-reload.md), then neither appears. [proof: S33 AS-12]
- **S33.B-08** Given [the engine](../terms/search-engine.md) never answers, when `q=iph` is called, then within 250 ms the answer holds [query suggestions](../terms/query-suggestions.md), [`degraded: ["catalog_timeout"]`](../terms/degraded-response.md) and [`no-store` ↗](../sw-external-terms.md#cache-control-no-store). [proof: S33 AS-16]
- **S33.B-09** Given the engine rejects, when called, then [`degraded: ["catalog_unavailable"]`](../terms/degraded-response.md) and [the error text is not exposed](../terms/error-text-not-exposed.md). [proof: S33 AS-17]
- **S33.B-10** Given [no snapshot](../terms/query-snapshot.md) and a failing engine, when `q=iph` is called, then `200` with no suggestions and `degraded: ["query_index_unavailable", "catalog_unavailable"]`. [proof: S33 AS-18]
- **S33.B-11** Given [five engine failures in a row ↗](../sw-external-terms.md#circuit-breaker), when the sixth request arrives, then the engine is not called and the answer reports `catalog_unavailable`. [proof: S33 AS-19]
- **S33.B-12** Given a healthy engine, when `q=iph` is called three times within 60 seconds (and once as [`q=IPH`](../terms/autocomplete-cache-key.md)), then [the engine is called once](../terms/cache-entry.md). [proof: S33 AS-20]
- **S33.B-13** Given a [search log](../terms/search-log.md) with a single searcher repeating a query 100 times, then the query is not published; [the build](../terms/autocomplete-build.md) keeps a query only with enough [distinct eligible searchers](../terms/eligible-searcher.md). [proof: S33 AS-28]
- **S33.B-14** Given a build succeeds, then the object [`autocomplete/<version>`](../terms/autocomplete-object.md) exists, [the pointer](../terms/autocomplete-pointer.md) equals `<version>`, and [its checksum verifies](../terms/autocomplete-checksum.md). [proof: S33 AS-29]
- **S33.B-15** Given two [overlapping builds](../terms/autocomplete-build.md) where the older finishes last, then [the pointer](../terms/autocomplete-pointer.md) equals the newer version and the older outcome is [`superseded`](../terms/superseded-build.md). [proof: S33 AS-33]
- **S33.B-16** Given a sixth [published version](../terms/published-version.md), then only the latest five remain, [the pointed one](../terms/version-pointer.md) is never deleted, and [unreferenced objects](../terms/unreferenced-object.md) younger than one hour stay. [proof: S33 AS-36]
- **S33.B-17** Given two [worker instances](../terms/worker-instance.md), when the [hourly schedule](../terms/cron-schedule-materialisation.md) fires, then exactly [one build](../terms/query-index-build.md) runs. [proof: S33 AS-37]
- **S33.B-18** Given 200 concurrent calls while the [pointer](../terms/version-pointer.md) moves from `V1` to `V2`, then every call answers `200` and each is consistent with one version. [proof: S33 AS-41]
- **S33.B-19** Given the pointer names a [damaged or missing snapshot](../terms/snapshot.md), then [the node](../terms/node.md) keeps serving the previous version and [counts the failure](../terms/failure-counter.md). [proof: S33 AS-42, S33 AS-43]
- **S33.B-20** Given no pointer at startup, then [the node is ready](../terms/readiness.md) and serves [catalog completions](../terms/catalog-completions.md) with [`degraded: ["query_index_unavailable"]`](../terms/degraded-marker.md) until a pointer appears. [proof: S33 AS-44]

## Lifecycles
The capability has no stored status. A build ends in one outcome: published, `unchanged`, `skipped_empty` or `superseded`. The circuit breaker moves among `closed`, `open` and `half_open`. The catalog circuit moves itself on failures and time. [code: packages/backend/libs/domains/discovery/domain/catalog-circuit.ts#CatalogCircuit]

## Owns
- No Postgres table (FR-040).
- Snapshot objects `autocomplete/<version>` in object storage, and one version pointer.
- Job `search.build-autocomplete`.
- Metrics: `autocomplete_requests_total`, `autocomplete_duration_seconds`, `autocomplete_source_duration_seconds`, `autocomplete_build_total`, `autocomplete_snapshot_age_seconds` and `autocomplete_snapshot_load_failed_total{reason}`.
- Rate-limit policy `discovery.suggest`.
- Configuration: budgets, poll interval, K, depth, popularity floor, window, cap and blocklist (validated at startup).
- It reads the search log store of S32 and S32's `ProductTitleSuggester`.

## Decisions
- Every trie prefix holds its own precomputed top K, so a lookup costs time proportional to the prefix length.
- The answer is identical for every caller, so a shared cache may hold it for 60 seconds.
- Degraded answers and errors are `no-store`, so one engine failure is not pinned at the edge.
- Each external source has its own budget and runs in parallel, so the slowest source bounds the wait.
- A circuit breaker protects the catalog source from repeated failures.
- A single pointer, moved forward only by the builder, lets nodes swap versions atomically and lets an operator roll back.
- The index is built in slices that yield to the event loop, so a 200,000-query rebuild does not stall requests.
- The blocklist applies at serve time, so a change takes effect without a rebuild.

## Known gaps
- Typo fallback (AS-22 to AS-27: fuzzy fallback, minimum 3 characters, catalog precedence, source failures, empty result) has no test carrying a scenario id. The behavior is described in the specification only.
- The 40 ms budgets for catalog and typo sources, and the `typo_fallback_*` degraded reasons, have no scenario-tagged proof beyond AS-16.
- AS-49 (static boundary checks), AS-50 (metrics series and labels) and AS-51 (startup configuration validation) have no scenario-tagged test.
- Rules R-03 (reduction like S32), R-17 (no cookie) and R-19 have only partial proofs through e2e tests. No test cited here checks that logs and metrics omit the raw prefix, which AS-48 requires.
- AS-09 (rate limit) lists a fail-open behavior when the rate-limit store fails; the facts do not show a test result for it.
- AS-55 and AS-56 (UI behavior: debounce 150 ms, cancellation, stale responses) are tagged to the backend e2e file, so the client logic has no proof in the web package.
- AS-45 and AS-44 are proven, but the build lease (10 minutes) and the 30-second poll interval have no direct test of their numeric values.