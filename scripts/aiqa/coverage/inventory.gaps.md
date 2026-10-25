# Inventory: differences between spec and code (mapper pass)

How this map was made: code and spec first, then a live pass with Playwright against http://localhost:3000 as OWNER, ADMIN, STAFF and VIEWER (extra memberships added in the database, removed afterwards) at 1280 and 390 px, shop ACTIVE, SUSPENDED and DELETING, with database checks. Paths are under packages/ unless full.

## Live-pass findings (what code reading alone missed or got wrong)

- SUSPENDED (and DELETING) shop: the list call GET /api/shops/:id/products answers 403, so the page shows the banner plus an error with "Try again" and NO rows, no row menus. W04.R-03 / AS-86 promise "still allow every read". Cause: tenancy/application/shop-access.service.ts WHILE_SUSPENDED lets only shop.read, members.read, shop.export through (S03.R-05) and products.read is not in it. Spec W04 and S03 disagree; the page behaviour does not match W04.
- 150-character search: the page shows "Check this field." with "Try again" (API 400 validation_failed on q). Confirmed live.
- Archive with a stale row version: the dialog stays open with "This product changed since you opened it." and NO "Load latest" button (confirmed live). The stock popover handles conflicts itself and works.
- The stock number is plain text; clicking it opens nothing (popover only through the menu "Adjust stock").
- Archived tab plus Stock filter and no hits says "No archived products." (not the filter message).
- My earlier suspicion that the price edit leaves the legacy `Product.price` stale was wrong: after an edit both `price` and `priceMinor` were 3010.
- Roles confirmed live: OWNER, ADMIN, STAFF see Add product and the menu (Edit, Adjust stock, Photos and video, Edit together, Archive); VIEWER sees the list but no Add product and no menu. No horizontal scroll at 390 or 1280. At 390 the tabs and Stock select move into the "Filters" sheet (Active, Archived, Clear filters, Done) and the shop switcher button is hidden (drawer).
- Worked as specified live: create (one request on double click, DB row with shopId, createdBy, EUR, price=priceMinor=2450, version 1, one outbox row), price/stock messages, 24,5 comma price, stock popover stale version ("Stock changed to 9 while you were editing."), same-value stock keeps version, edit sends only changed fields, edit conflict plus "Load latest", archive writes ProductStatusHistory, restore, cursor paging (20 + next, "First page"), invalid cursor message, cursor reused with another filter refused, bogus URL values fall back, XSS text shown as text, spaces-only search ignored.

## (a) In the code but not in the spec

- Row menu entries "Photos and video" (goes to products/[productId]/media) and "Edit together" (goes to products/[productId]/draft). W04 behaviors B-10..B-15 and rules never mention them; they belong to S29/S30/S06. File: web/components/seller/inventory/inventory-view.tsx#menuFor.
- Outline badge "Active" next to the stock label in search results (only when the list comes from the search). File: inventory-view.tsx (status column).
- Search hint line 2 "Search results can take a few seconds to include new products." (spec B-11 only names "Search covers all products."). File: web/components/seller/inventory/inventory-toolbar.tsx.
- The Stock select ("All / In stock / Out of stock") is also disabled while a search is active, not only the tabs (B-11 names only the tabs). File: inventory-toolbar.tsx.
- "First page" and "Clear filters"/"Clear search" buttons in the empty states, and the "No products on this page." state for an empty page behind a cursor. File: inventory-view.tsx#empty.
- Mobile "Filters" sheet with "(N on)" count, "Clear filters" and "Done". File: web/components/seller/filters-sheet.tsx (W04 AS-97 mentions the sheet; rules do not).
- Restore has no confirmation dialog and no double-press guard (only destructive actions need one by R-23, so this is allowed, but it can send two requests). File: inventory-view.tsx#restoreRow.
- Product API accepts `category` as a list filter and `tags` on create/update; the page offers neither. Files: catalog/domain/product-input.ts#parseListQuery, packages/contracts/src/catalog/index.ts.
- API accepts an optional `Idempotency-Key` on create (24 h); the page never sends one. File: catalog/api/product.controller.ts#create, web/lib/api/seller-products.ts#createProduct.
- Update lists `priceMinor` only in UPDATABLE while create writes both `price` and `priceMinor`; live check showed both equal after an edit (something else keeps them in step). File: catalog/infra/product.repository.ts.
- The page sends `limit=20` fixed; API allows 1..100. Not a bug.

## (b) In the spec but not found in the code (likely bugs)

- S05.R-27 / plan limit: `409 plan_limit_reached` has no copy in web/lib/seller/problem-copy.ts (grep for "plan_limit" in packages/web/lib finds nothing), so the seller would see the generic "Something didn't work. Check the details and try again." instead of a limit message. Spec: S05.R-27, W04.R-13 (visible form chosen by code).
- W04.B-13 / AS-37 ("Load latest") exists only inside the edit dialog. Archive (archive-dialog.tsx), Restore (inventory-view.tsx#restoreRow) and the stock popover can also get `version_conflict`; problem-copy marks it `action: 'load-latest'` but web/components/seller/problem-states.tsx#ProblemPanel renders no such button (it only knows `first-page` and `onRetry`). The archive dialog and the page alert for restore therefore show "This product changed since you opened it." with no way forward except closing and reopening. (The stock popover handles the conflict itself.)
- W04.R-22 and R-07 have no proof in the spec; R-07 ("no screen may default to a currency") is partly met: formatMoney(minor, currency) takes the row's currency, but web/lib/utils.ts#formatMoney divides with floating point (Number(minor) / 10 ** digits); fine up to the product maximum, but not "string work only".
- Spec W04.B-14 says the list refetches on `product_archived`/`invalid_transition`; the code does it through the mutation's onSettled invalidation, so this is expected to pass. Listed so a tester checks the order (alert shown, list updated).

## (c) Spec and code disagree

- Search text length. Spec/page: `readInventoryParams` keeps up to 200 characters (web/lib/seller/search-params.ts `text(raw.q, 200)`). Backend: the shop search refuses text over 100 normalised characters with 400 (discovery/domain/query-text.ts MAX_QUERY_LENGTH, shop-product-search.service.ts `exceedsQueryLimit`). So a 101..200 character search gives an API error; the spec text for B-11 names no limit.
- Status tabs on search. W04.B-11: "the status tabs are disabled". Code also disables the Stock select. (Minor, listed in (a).)
- W04.B-12: "the product is the first row". The first row is only guaranteed on the Active tab with no search and no filters; with the In stock filter a new product with stock 0 is not shown, and in search it appears only after the index catches up. Code follows the sort (createdAt desc), so test the sentence with the default view only.
- W04.R-29 ("each write sends expectedVersion from the version the seller saw") vs code: from a search row (no version) the page reads the product first and uses that version, i.e. the version seen at click time, not the one shown in the list. Spec AS-36 allows this ("reload the member view first").
- W04 test-plan AS-30 says search lag is shown; code adds only a static hint, no retry or live refresh; staleTime 0 re-reads only when the search is asked again.
- Stock label thresholds match (R-08): 0 out, 1..5 low, 6+ in, archived overrides. Backend `inStock=false` means quantity = 0 and `true` means quantity > 0, consistent with the labels.
- Product.quantity is INTEGER in the database (max 2,147,483,647) while the contract limit is 1,000,000,000: consistent, no gap.

## Not mapped / open

- Not done live: search paging past 20 hits, plan_limit_reached (needs hosted billing), rate limit 429, role lowered while the page is open, offline banner.
- Roles: the four roles OWNER/ADMIN/STAFF/VIEWER come from catalog tenancy domain/permissions.ts (STAFF and above hold products.write; VIEWER only reads). Role changes while the page is open were mapped as one line, not traced into the permission cache.
- Where the shell's shop-status banner and offline banner are built (web/components/dashboard/*) was only mapped by name.
