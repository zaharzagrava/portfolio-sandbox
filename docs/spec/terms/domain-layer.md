---
id: domain-layer
title: Domain layer
kind: term
status: draft
aliases: [`domain` folder, pure rules]
defined_for: S05-products
rules_hash: cad708ed9695
---
# Domain layer
## Definition
The domain layer is the `domain` folder of a domain. It holds the business rules as small functions, for example input checks, [allowed status transitions](invalid-transition.md), [visibility](is-publicly-visible.md) and [stock bounds](stock-upper-bound.md). The application layer calls these rules and then does the reads and writes. Keeping rules free of HTTP, messaging and storage makes them easy to test on their own. That reason is design intent (not stated in the spec).

## Example
Rules in `packages/backend/libs/domains/catalog/domain/`:
- `product-status.ts#applyTransition`: allows only `ACTIVE ⇄ ARCHIVED`
- `visibility.ts#isPubliclyVisible`: decides whether a product is public
- `stock-rule.ts#applyDelta`: keeps stock between 0 and 1,000,000,000
- `product-input.ts#parseCreateInput`: enforces [strict create bodies](strict-body.md)

## Known gaps
- Not confirmed in the code: that these functions are really pure, with no database, cache or clock access. Only the draft text calls them "pure rules".
- Not confirmed in the code: how a rule reports a refusal, by throwing or by returning a result. It is also unclear where that refusal becomes `409 invalid_transition`.

## Used by
<!-- used-by:start -->
- [application-layer](application-layer.md)
- [invalid-transition](invalid-transition.md)
- [is-publicly-visible](is-publicly-visible.md)
- [parse-statement-line](parse-statement-line.md)
- [resolve-issue](resolve-issue.md)
- [stock-upper-bound](stock-upper-bound.md)
- [strict-body](strict-body.md)
- [use-case](use-case.md)
- [validate-day](validate-day.md)
<!-- used-by:end -->
