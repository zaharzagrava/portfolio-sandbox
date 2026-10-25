# SECRET: the five planted bugs (for the scorer only)

Do NOT put this file, the `patches/` folder or `probes/` into a tester's prompt, and tell testers not to read `scripts/aiqa/tracks/`. Testers work in `../portfolio-sandbox-planted` after `plant.sh`.

| # | kind | where | what is wrong | how a tester could notice |
|---|---|---|---|---|
| 1 | wrong rule in a handler | `catalog/application/product-command.service.ts` `activeShop` | a SUSPENDED shop is treated like an active one, so the API still accepts product create, edit, archive, restore (the page only greys the buttons: spec W04 AS-86 "suspended shop: view but not change") | suspend a shop in the database or as admin, then call POST/PATCH on products with curl; expected 409 shop not active, actual 200 |
| 2 | missing permission check | `catalog/api/product.controller.ts` restore route | `@ShopScoped('products.write')` became `'products.read'`: a VIEWER member can restore an archived product (archive still needs write) | sign in as a viewer, POST `/shops/{id}/products/{pid}/restore`; expected 403, actual 200 |
| 3 | off-by-one in paging | `orders/application/order-query.service.ts` `getOrdersForShop` | `found.slice(0, limit)` became `slice(0, limit - 1)`: every page of the seller order list shows one order less than asked, and the cursor points after the last SHOWN row, so the hidden order is never listed | shop with more than 20 orders: page 1 has 19 rows; the 20th order never appears on any page; with `limit=1` the list is empty and has no way forward |
| 4 | lost update | `catalog/application/product-command.service.ts` `update` | the `expectedVersion` comparison was removed and the write uses the freshly read version, so two tabs editing the same product silently overwrite each other (no 409) | open the edit dialog in two tabs, save in tab A, then save in tab B; expected conflict message (409), actual: B wins and A's change is lost; or PATCH twice with the same old `expectedVersion` |
| 5 | leaked data | `catalog/domain/product-view.ts` `toPublicView` | `...p` spread added to the public product view: the public API now also returns `quantity` (exact stock), `status`, `createdBy`, `isSandbox`, `externalSku` | `GET /products/{id}` without sign in; expected only the public fields, actual: exact stock and the seller's user id are in the JSON |

Unit probes that prove each bug changes behaviour: `probes/planted-probe.spec.ts` (run `plant.sh --probe`: 6 pass on clean code, 5 fail on planted code).

Matching rules used by `score.sh` are in that file (keywords per bug); the scorer still reads the matched findings and confirms by hand.
