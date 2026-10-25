# Inventory: differences between spec and code (mapper pass)

How this map was made: from the code and the spec (W04, S05, S03, S32 where they touch the page). The stack answered on http://localhost:3000 (HTTP 200) but I did NOT open the page in a browser in this pass (time budget went into tracing code to API to table). So the "controls found" list comes from the code only; a tester must confirm on the live page at 1280 px and 390 px that nothing extra exists (for example a control added by the shell or a different shop role). Paths are under packages/ unless full.

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
- Update writes `priceMinor` only; create writes both `price` and `priceMinor` (legacy column `Product.price` stays old after a price edit). Files: catalog/infra/product.repository.ts (INSERT vs UPDATABLE list). Possible data bug if anything still reads `Product.price`; a tester must compare the two columns after an edit.
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

- Live browser walk at 390 px and 1280 px (see top).
- Roles: the four roles OWNER/ADMIN/STAFF/VIEWER come from catalog tenancy domain/permissions.ts (STAFF and above hold products.write; VIEWER only reads). Role changes while the page is open were mapped as one line, not traced into the permission cache.
- Where the shell's shop-status banner and offline banner are built (web/components/dashboard/*) was only mapped by name.
