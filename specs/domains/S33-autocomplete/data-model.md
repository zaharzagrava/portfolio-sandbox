# Data Model: S33

No Postgres tables. Types live in `domain/`; wire schemas in `packages/contracts`.

| Entity | Fields | Rules |
|---|---|---|
| SearchLogRow (read-only, S32) | `event_id, query, results, user_hash, surface, ts` | missing `surface` ⇒ `'http'` |
| QueryCandidate | `{query, searchers}` | normalised, ≥ 2 chars, not `[redacted]`/PII/blocklisted, searchers ≥ floor, results > 0 |
| Snapshot envelope | `{format: 1, version, createdAt, params{window,floor,cap,k,depth}, checksum, entries[]}`, gzip JSON at `autocomplete/<version>.json.gz` | immutable; entries sorted `searchers DESC, query ASC`; no user ids (SC-009) |
| Pointer | Redis `autocomplete:current` = version | forward-only compare-and-set; operator may set back |
| SuggestionIndex | `TopKTrie` (K=10, depth 20) + version | replaced by reference in one step |
| Suggestion | `{text, source: 'query'\|'catalog'\|'typo'}` | dedupe on normalised text, first occurrence wins |
| BuildOutcome | `published \| unchanged \| skipped_empty \| superseded` | metric and job result |
| LoadFailureReason | `missing \| checksum \| corrupt \| format \| invalid_entry \| pointer_unreachable` | metric label |
| CircuitState | `closed \| open(until) \| half_open` | 5 consecutive failures → open 10 s → one probe |

Transitions: pointer `V_n → V_m` only if `V_m > V_n`; a node follows the pointer in either direction.
