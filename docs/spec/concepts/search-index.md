---
id: search-index
title: The product search index
kind: concept
status: draft
defined_by: S32
---
# The product search index
## Definition
The product search index is a read model for text search over products. It is built only from catalog events; the catalog's table is never read. It gives every capability one guarantee: search answers hide archived, sandbox and deleted products and products of suspended shops, and each answer follows one total order. Events carry versions, so late or repeated events cannot overwrite newer data.

## Rules
- **search-index.C-01** The index MUST be built only from [catalog events](../terms/event-definition.md), and MUST NOT read the catalog's table.
- **search-index.C-02** The index MUST apply an incoming [product event](../terms/event-definition.md) when its [version](../terms/aggregate-version.md) is at least the stored version, and MUST ignore and count it when lower.
- **search-index.C-03** A deleted product MUST [stay hidden](../terms/search-visibility.md) when [late events](../terms/aggregate-version.md) arrive with a version at or below the delete version.
- **search-index.C-04** Archived, [sandbox](../terms/sandbox-product.md) and deleted products, and products of [`SUSPENDED`](../terms/shop-status.md), `DELETING` or `DELETED` shops, MUST NOT appear in items, totals, [facets](../terms/search-facets.md) or [semantic results](../terms/semantic-search.md).
- **search-index.C-05** A suspended or [offboarding shop](../terms/shop-status.md) MUST [hide all its products](../terms/search-visibility.md), including products created later.
- **search-index.C-06** The index MUST [dead-letter ↗](../sw-external-terms.md#dead-letter-queue) invalid or [unsupported-version messages](../terms/event-envelope.md) and MUST NOT change the index for them.
- **search-index.C-07** At most one [reindex run](../terms/zero-downtime-reindexing.md) MUST be active; a second start or [rollback](../terms/reindex-rollback.md) MUST answer [`409 reindex_in_progress`](../terms/reindex-in-progress.md).
- **search-index.C-08** A reindex run MUST fail with [`verification_failed`](../terms/verification-failed.md) when the new index holds fewer documents than [the history](../terms/event-replay.md) requires, and the live index MUST stay untouched.

## How the capabilities use it
- {{cap:S32}} defines the index, projects catalog events into it, and serves buyer and seller search over it, including paging, ranking, filters and reindex runs.
- {{cap:S33}} is listed as using the index, but no line in the facts links it. Its role is not stated.
- {{cap:W02}} turns the index into the search screens. The facts give no further detail on what it reads.

## Known gaps
- The facts for {{cap:S33}} and {{cap:W02}} name the concept but state no rule or dependency on it. Their use needs review.
- The facts give no detail on the reindex run state machine beyond the `invalid_transition` code, and none on the cutover to a new index.
- {{concept:projection-and-replay}} holds the event projection rules. Its page was not given.

## Used by
<!-- used-by:start -->
- {{cap:S19}} Pickup points, local stock, available near me, map clustering
- {{cap:S32}} Product search: index sync with external versioning, zero-downtime reindex, relevance boosts, synonyms, facets, k-NN
- {{cap:S33}} Search autocomplete: query-log top-K trie, catalog completions, per-source budgets, typo fallback
- {{cap:W02}} Home, search (autocomplete, filters, facets, sort, URL state), trending and recommendation rails, product page (product, shop, pickup near me, discussions, ask this product, share link)
<!-- used-by:end -->
