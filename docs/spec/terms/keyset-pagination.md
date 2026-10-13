---
id: keyset-pagination
title: Keyset pagination
kind: term
status: draft
aliases: [keyset page, keyset pages]
defined_for: S14-ledger-reconciliation
rules_hash: 41d03f627a3e
---
# Keyset pagination
## Definition
Keyset pagination is how the ledger pages through long lists. Instead of skipping a number of rows, each page continues from the last row the client received. The position is carried in a [signed cursor](pagination-cursor.md), so a client cannot forge or edit it. The finance lists of [reconciliation runs](reconciliation-run.md) and [issues](reconciliation-issue.md) use it, sorted newest first and filterable. [`listSellerBalances`](list-seller-balances.md) also uses it to page [seller accounts](ledger-account.md).

## Example
[`GET /finance/reconciliation/issues`](finance-reconciliation-api.md) returns the newest issues and a cursor. The admin sends that cursor back to get the next, older page, keeping the same filters.

## Known gaps
- The spec does not say the page size, the filter names or the exact sort key used as the keyset.
- The spec does not say what error is returned for a [tampered cursor ↗](../sw-external-terms.md#tampered-token) or for one that does not match the filters.

## Used by
<!-- used-by:start -->
- [S14](../capabilities/S14-ledger-reconciliation.md): R-38
- [ledger-account](ledger-account.md)
- [pagination-cursor](pagination-cursor.md)
- [reconciliation-issue](reconciliation-issue.md)
- [reconciliation-run](reconciliation-run.md)
<!-- used-by:end -->
