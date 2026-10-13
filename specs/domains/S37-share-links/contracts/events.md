# Contract: event `link.clicked` (topic `links.events`, key = code)

Defined with `defineEvent('link.clicked', 'links', 1, …)` in `packages/contracts/src/marketing/share-links.ts` (`linkClickedEventSchema`); the domain re-exports it from `domain/link-events.ts`. The edge worker writes the same envelope by hand; a parity test in `edge-be` compares its output to the schema's sample.

| Field | Rule |
|---|---|
| `eventId` | = `clickId`, time-ordered UUID (uuidv7) |
| `type` | `link.clicked` |
| `version` | `1` (today's value `0` is a bug, G15; the consumer accepts only `1`, others are dead-lettered) |
| `occurredAt` | the click instant (injected clock at the origin; the worker's clock at the edge) |
| `aggregateType` / `aggregateId` | `links` / `<code>` |
| `payload.clickId` | UUID |
| `payload.code` | code format (7 chars base-62, or alias format) |
| `payload.ts` | ISO-8601 instant, equal to `occurredAt`; more than 5 minutes ahead of the consumer's now → dead letter |
| `payload.country` | `A–Z×2` upper case, never `XX` or `T1`, else `""` |
| `payload.referer` | origin (scheme, host, port) of the `Referer`, ≤ 300 chars, else `""`; never path, query or credentials |
| `payload.viaEdge` | boolean |

**Guarantees**: one event per served `302` (origin or edge); none for `404`, `410`, `405`, `HEAD`, `5xx`; at most once (best effort, loss counted by `link_click_publish_failed_total`); no address, user agent, cookie, user id, destination, path or query.

**Consumers**: `link-clicks` (this capability; group name `link-clicks`; idempotency `natural` on `click_id`; invalid → dead letter with reason). The analytics capability (S39) may subscribe; none does yet.

**Not emitted**: link create, change and disable (no consumer; `updatedAt`/`disabledAt` on the item are the history, `questions.md` LOCAL).
