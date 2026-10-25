Read all 2 flags. The 119 ready-made rules (TypeScript, React, Node, OWASP, secrets) found nothing in the four areas. Our own rules found:

- `order-query.service.ts:106` and `:148` (rule "buyer private data in view"): REAL, already known as **B-035**. The seller order list and the single order answer both carry `buyerId`, which the spec (W04 B-32, "no buyer identifier") says should not leave the server. Our rule found it with no help from the earlier agents, which is a good sign for the rule. Severity medium (a user id, no e-mail or name; the same id on all of one buyer's orders lets a seller link them).
- The other three custom rules (a route under `/shops/:shopId` without the shop guard, a route whose method path holds `shops/:shopId` without the guard, a shop id read from a request body) found 0 places. These zeros are meaningful: the rules were first tested on a sample file with bad code (`selftest/`) and fire there, and every seller route in the four areas really goes through `@ShopScoped(...)`.
- The rule against raw HTML (`dangerouslySetInnerHTML`, `innerHTML =`) found 0 places in the web code.

Limit: Semgrep reads patterns, not meaning. It cannot tell that a guard is configured with the wrong permission name. The isolation tests (track 4) cover that.
