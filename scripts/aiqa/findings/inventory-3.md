# Inventory findings, pass 3 (ai-tester)

Specs of this pass (packages/web/tests/aiqa/): inventory-stock, inventory-edit, inventory-archive, inventory-roles, inventory-rules (all run in the desktop and mobile projects), with helper inventory-write-support.ts (database reads: Product, ProductStatusHistory, Outbox, SearchShopProduct). Method note: the rows of the stack are shared with other agents, so a heavy parallel run shows load flakes; every failure listed below was repeated alone.

P3F1 [CONFIRMED] low "Update stock" pressed twice within a few milliseconds sends two PATCH requests
Steps: Adjust stock, type a number, double-click "Update stock" (or hold Enter). 
Expected (W04.R-23, map line inventory.stock.double-press): one request.
Actual: the guard is `if (adjust.isPending) return;` on React state, which only flips a moment after the first press. Two presses in the same few milliseconds send two PATCHes (first 200, second 409 version_conflict). The Archive dialog (ref guard in confirm-dialog.tsx) and the Edit form send only one.
Evidence: tests/aiqa/inventory-stock.spec.ts [inventory.stock.double-press] fails desktop and mobile (statuses [200, 409]). Likely harmless for a human double click, real for a held Enter key.

P3F2 [CONFIRMED] medium Archive dialog is a dead end after a version conflict, and "archived elsewhere" is reported as "changed since you opened it"
Steps: open Archive on a row, change or archive the same product elsewhere (second tab, API), press "Archive product".
Expected (W04.B-13/B-14, AS-41, S05.R-07): for a product archived elsewhere the dialog closes and the page says it was archived or restored elsewhere; for a plain conflict a working "Load latest".
Actual: the answer is 409 version_conflict (the version check runs before the state check, product-command.service.ts), the dialog stays open with "This product changed since you opened it." and NO "Load latest" button (the dialog has no handler; ProblemPanel renders no such button). The dialog keeps the old version, so every further press gives the same 409; the list behind it already refreshed ("No products yet."). Only Cancel gets out. The stale text appears only when the row has no version (search row, line inventory.archive.extra-1 passes).
Evidence: inventory-archive.spec.ts [inventory.archive.version-conflict] (fails: no Load latest) and [inventory.archive.stale] (fails: conflict text instead of the stale text), both projects. Same family as register item B-032 (stock popover).

P3F3 [CONFIRMED] low Edit dialog: a product archived elsewhere says "changed since you opened it", not "archived or restored elsewhere"
Steps: open Edit, change a field, archive the product elsewhere, Save.
Expected (map line inventory.edit.archived-meanwhile, W04.B-14): "This product was archived or restored elsewhere. The list has been refreshed."
Actual: 409 version_conflict banner with "Load latest"; "Load latest" then shows the archived product's values without any hint that it is archived; only the next Save gives the stale text (line inventory.edit.extra-1 passes). 
Evidence: inventory-edit.spec.ts [inventory.edit.archived-meanwhile] fails (both projects). Root: version is checked before status in ProductCommandService.update.

P3F4 [CONFIRMED] medium A write refused with 403 shop_suspended throws the typed number away and the explanation lands in the list area, not in the popover
Steps: Adjust stock popover open and number typed; platform admin suspends the shop; press "Update stock".
Expected (map line inventory.stock.other-errors, W04.R-13): problem panel inside the popover, number kept.
Actual: the 403 makes the page refetch the list, the list answers 403 for a SUSPENDED shop (register B-024, P2F8), the rows disappear and the popover unmounts. The text "This shop is suspended..." shows in the Products region with "Try again". With a stubbed 403 on the write only (list fine) the popover behaves as specified (line passes).
Evidence: inventory-stock.spec.ts [inventory.stock.extra-1] fails. Root cause is P2F8 / B-024.

P3F5 [CONFIRMED] medium The suspended-shop list is still unreadable (same root as P2F8, B-024)
list, get and search on a SUSPENDED shop: the live run in inventory-roles.spec.ts [inventory.shop.suspended-reads] expects 200 (W04.R-03) and gets 403; [inventory.shop.suspended] cannot find the rows. A DELETING shop answers 200 everywhere and its banner, disabled Add product and disabled row-menu items with the reason are right (inventory.shop.closing passes). Decision for the map: W04.R-03 (reads work) is taken as the rule, S03.R-05 is the competing text.

P3F6 [CONFIRMED] low A 429 on a write shows the countdown but the control stays pressable
Steps: Edit product, change a field, Save with the answer 429 and Retry-After 4.
Expected (W04.R-14, map line inventory.rules.rate-limit-countdown): "disables the control until it ends".
Actual: "Too many requests. Try again in N s." counts down and ends with "You can try again now.", but "Save changes" stays enabled all the time (ProblemPanel never gets onActiveChange; the dialogs do not use it).
Evidence: inventory-rules.spec.ts [inventory.rules.rate-limit-countdown] fails (both projects).

P3F7 [CONFIRMED] medium Focus is lost after Cancel/Escape of the Archive dialog opened from a row menu (same cause as P2F9, Edit)
Steps: row menu -> Archive, Cancel (or Escape).
Expected (W04.R-24, AS-94): focus on "Actions for X".
Actual: focus is on BODY (the dialog remembers document.activeElement when it opens; the closing menu has not yet returned focus). Edit dialog: same (inventory.edit.cancel-escape fails). The stock popover is fine.
Evidence: inventory-archive.spec.ts [inventory.archive.cancel], inventory-edit.spec.ts [inventory.edit.cancel-escape], both projects.

Notes (not bugs):
- Edit double press (dblclick on "Save changes") sent one PATCH; Archive double press one POST (button disabled and aria-busy); both pass.
- Edit/Archive/Stock all send expectedVersion from the row or the fresh read; a search row reads GET /products/:id once first.
- The outbox row of an update has topic products.events, eventName catalog.product_updated, payload.aggregateVersion = new version, payload.payload.changedFields lists the fields; archive writes catalog.product_archived and one ProductStatusHistory row (ACTIVE -> ARCHIVED, productVersion 2, actorId = the member); a same-number stock update writes nothing. Legacy "Product".price equals priceMinor after an edit.
- inventory.roles.permission-from-shop-answer: the shop answer is fetched on the server (no browser request to stub), so "a missing myPermissions grants nothing" cannot be driven from the browser; a VIEWER and an OWNER share the platform role yet see different controls, which shows the page does not use the platform role. Marked blocked.
- A Playwright click on a second row menu right after the stock popover closed waited for the popover to be gone; a test must wait for the popover to disappear first (not a product bug).
