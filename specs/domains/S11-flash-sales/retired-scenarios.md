# Retired scenarios of S11

`packages/backend/libs/domains/orders/flash-sale-legacy.e2e-spec.ts` (S10 T078, three tests of the parked flash jobs) lost its subject, `infra/flash/` and `FlashSaleLegacyModule` (T063, L-017), and was rewritten in place against the S11 route and jobs (titles now carry `S11 AS-20 AS-21`, `AS-22`, `AS-25`). It had no `AS-nn` id before, so no id is retired; the behaviors are also carried by:

- start takes the units out under `orders:flash:<saleId>:load` and a repeat does not take them twice → `flash-sale-lifecycle.e2e-spec.ts`, `S11 AS-20` and `S11 AS-21`
- a sale asking for more units than the stock fails without changing it → `S11 AS-22` (`START_FAILED(insufficient_stock)`, stock unchanged)
- reconcile returns the unsold units under `orders:flash:<saleId>:return`, once → `S11 AS-25`
