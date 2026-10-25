# Inventory findings, pass 2 (ai-tester)

Specs of this pass (packages/web/tests/aiqa/): inventory-filters, inventory-add, inventory-menu, inventory-states, inventory-money (all run in the mobile and desktop projects). Method note: the API of this stack lets the loopback address through the rate limiter (RATE_LIMIT_ALLOW_IPS in packages/backend/.env), so a real 429 cannot be provoked from this machine; 429 lines are tested with a stubbed answer and their API layer is marked blocked.

P2F1 [CONFIRMED] low The Stock select inside the phone Filters sheet has no accessible name
Steps: 390 px wide, open the inventory page, press "Filters". Read the accessible name of the Stock select in the sheet.
Expected (W04.AS-97, R-25): the select is labelled "Stock".
Actual: the filters are rendered twice (inline copy hidden, copy in the sheet) with the same id `inventory-stock`; `<label for="inventory-stock">` points at the first element of that id, the hidden inline select, so the sheet's select has 0 labels and an empty accessible name (a screen reader says "combo box" only). Same duplicate id for the label inside the sheet.
Evidence: tests/aiqa/inventory-filters.spec.ts [inventory.filter.phone-sheet-label] fails (mobile), twice; select.labels.length = 0 in the sheet.

P2F2 [CONFIRMED] low A repeated status or stock value in the address is read differently by the server and by the page
Steps: open /dashboard/seller/{shop}/inventory?status=ACTIVE&status=ARCHIVED (also ?inStock=true&inStock=false).
Expected (W04.R-10): invalid values fall back to the defaults (Active, All).
Actual: the server render treats the repeated key as invalid (default Active), the page code reads the LAST value, so after a moment the page switches to the Archived view ("Filters (1 on)", tab Archived selected, "No archived products." on a shop with none). Server and page disagree; reload shows the same switch.
Evidence: tests/aiqa/inventory-filters.spec.ts [inventory.filter.invalid-url-values-repeated] fails desktop and mobile (twice).

P2F3 [CONFIRMED] low At exactly 640 px the filters are inline, not in the Filters sheet
Steps: desktop browser, resize the window to 640 px wide, open the inventory page.
Expected (W04.AS-97 and the code comment in filters-sheet.tsx: "at 640 px and below a Filters button opens them in a sheet", inline "from 641 px up").
Actual: Tailwind `sm:` starts at 640, so at 640 px the inline filters show and there is no Filters button; at 639 px the button shows. One pixel off the stated limit.
Evidence: tests/aiqa/inventory-filters.spec.ts [inventory.filter.desktop-inline-640] fails (desktop).

P2F4 [CONFIRMED] low A title of 200 emoji is cut to 125 emoji without any message
Steps: Add product, type or paste a title of 200 emoji (200 code points, the allowed maximum), fill the rest, Create product.
Expected (S05.R-02, W04.AS-34: 1 to 200 characters counted in code points; the spec text of the line says 200 emoji are saved): the whole title is saved.
Actual: the Title box has maxLength 250, which counts UTF-16 units (an emoji is 2), so the box silently keeps only 125 emoji; the request carries 125 code points and the product is saved with 125 emoji (db length 125). No error is shown.
Evidence: tests/aiqa/inventory-add.spec.ts [inventory.add.unicode-emoji-html-200] fails (desktop, mobile); db: length(title) = 125.

P2F5 [CONFIRMED] low A 4000-character description with spaces around it is refused although it is saved trimmed
Steps: Add product, description = a newline, a space, 4000 letters, a space, a newline; other fields valid; Create product.
Expected (S05.R-02: "saved trimmed"; title, brand and category are counted after trimming): accepted, 4000 characters saved.
Actual: nothing is sent; the description is counted before trimming (4004 characters) and the dialog says "Use at most 4000 characters.".
Evidence: tests/aiqa/inventory-add.spec.ts [inventory.add.field-description-padded] fails (no POST within 15 s); the same text without spaces is accepted.

P2F6 [CONFIRMED] medium plan_limit_reached has no words of its own: "Something didn't work. Check the details and try again."
Steps: free-plan shop with 10 products (the limit), Add product, valid values, Create product.
Expected (S05.R-27, map line inventory.add.plan-limit): a clear message that the plan's product limit is reached.
Actual: API answers 409 plan_limit_reached (nothing written, correct); the dialog shows the generic 4xx text "Something didn't work. Check the details and try again." plus a request reference. problem-copy.ts has no entry for the code. The seller is told to check the details, which are fine.
Evidence: tests/aiqa/inventory-add.spec.ts [inventory.add.plan-limit] fails (both projects); db: no row.

P2F7 [CONFIRMED] low Back online, the open product list is refetched twice, not once
Steps: open the inventory, go offline (banner "You're offline. Changes can't be saved."), go online. Count GET /api/shops/{id}/products.
Expected (W04.B-35, AS-88): "the open queries refetch once".
Actual: two list requests every time (desktop and mobile, 3 runs). Likely the reconnect refetch of the query client plus the page's own invalidate.
Evidence: tests/aiqa/inventory-states.spec.ts [inventory.error.offline] fails.

P2F8 [CONFIRMED] medium Suspended shop: the list is not readable and the row menu is not shown (this is register item B-024, now with a regression test)
Steps: platform admin suspends the shop; the seller opens the inventory.
Expected (W04.R-03, AS-86): banner, Add product disabled with the note, the list readable, row menus disabled with the reason on top.
Actual: banner and the disabled button with the note are right; but GET /products answers 403 for a SUSPENDED shop, so the Products region shows an error and there are no rows and no menus. (A DELETING shop answers 200: its list and button state are right.)
Evidence: tests/aiqa/inventory-menu.spec.ts [inventory.menu.suspended] fails (both projects).

P2F9 [CONFIRMED] medium Focus is lost (goes to the page body) after closing the Edit product dialog opened from a row menu
Steps: keyboard or mouse: row menu "Actions for X" -> Edit; Escape in the dialog.
Expected (W04.R-24, AS-94: focus returns to the control that opened it; the code comment says so): focus on "Actions for X".
Actual: document.activeElement is BODY. The dialog remembers `document.activeElement` at the moment it opens, but the menu has closed already and has not yet given focus back, so there is nothing to return to. (Add product returns focus correctly; Adjust stock popover returns focus to the menu button.) A keyboard user starts again from the top of the page.
Evidence: tests/aiqa/inventory-menu.spec.ts [inventory.menu.edit-item-focus] fails twice in both projects; the long menu test records focus-after-edit-dialog = "BODY:".

Notes (not bugs):
- Create writes the outbox event `catalog.product_created` on topic `products.events` (the map says product.created); no ProductStatusHistory row is written at creation (history rows [] for a new product). Restore writes ARCHIVED -> ACTIVE; Archive writes ACTIVE -> ARCHIVED (checked for Restore here).
- A search cursor used with another search text answers 422 invalid_cursor (not 400).
- Add product sends no Idempotency-Key (confirmed) and no Authorization header; it sends the CSRF header; the path is relative.
- A failed Restore with 403 shows "You don't have access to this page." (the word "page" for a row action).
- The product API accepts NUL and bidi-control characters in the title (a NUL is stored as the two characters backslash and 0). Not part of the form rules; mentioned for the data-quality list.
- "Add product" is disabled without PLATFORM_CURRENCY only if the web server runs without it; the stack always has EUR, so that line is blocked.
