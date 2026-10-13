---
id: domain-boundary-rules
title: Domain boundary rules
kind: term
status: draft
aliases: [domain boundary]
defined_for: S10-cart-checkout
rules_hash: ea4dc300a22b
---
# Domain boundary rules
## Definition
Domain boundary rules are the rules that keep each [domain](domain.md) separate from the others. Under them, a domain exports no model and has no association or import into another domain. A domain also never calls [`sequelize.transaction`](transaction-runner.md) directly. A model exported from a TRANSITIONAL block is a known, temporary exception to these rules. Design intent (not stated in the spec): each domain owns its tables and controls changes to its data, so other domains depend only on its [exported commands](exported-command.md) and [events](event-payload.md).

## Example
The orders domain does not write catalog stock itself. Under S10.R-20, stock changes only through the [catalog stock command](catalog-stock-command.md). The command uses [operation IDs](stock-operation-id.md) like `orders:<orderId>:reserve:<productId>`. Orders calls catalog's command and does not touch a catalog model.

## Known gaps
- The spec does not say why direct `sequelize.transaction` calls are banned, or which transaction mechanism must be used instead.
- The spec does not say how the rules are enforced, for example by a lint rule, a CI check or manual review.

## Used by
<!-- used-by:start -->
- [boundary-finding](boundary-finding.md)
- [boundary-review](boundary-review.md)
- [catalog-stock-command](catalog-stock-command.md)
- [check-boundaries](check-boundaries.md)
- [domain](domain.md)
- [event-payload](event-payload.md)
- [export-join](export-join.md)
- [exported-command](exported-command.md)
- [stock-operation-id](stock-operation-id.md)
- [transitional-block](transitional-block.md)
<!-- used-by:end -->
