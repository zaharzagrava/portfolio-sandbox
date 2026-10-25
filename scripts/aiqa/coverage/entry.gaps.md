# entry: gaps between spec and code (found while mapping, 2026-10-25)

Note: the browser extension did not answer (8 s timeout), so this map comes from code and spec only. Every line is `untested`; the testers must also compare the live page with the map and add lines for anything the code reading missed.

## (a) In the code, not in the spec
- "Start selling" sidebar for a member with no shop: `packages/web/app/dashboard/seller/start-selling-nav.tsx` (spec AS-01 mentions it, no Rule/Behavior).
- Shop status badge text mapping (Suspended / Closing / Closed) in `shop-picker.tsx` and `shop-switcher.tsx` (B-04 says "status badge" only).
- "All your shops" link at the bottom of the switcher (`shop-switcher.tsx`), and "Current" marker.
- Page label in the phone top bar falls back to "Overview" for any unknown path, including account pages (`lib/seller/nav.ts#currentPageLabel`).
- Always-visible "Account" group with "Your orders" and "Account security" for every role (`seller-nav.tsx`, `lib/seller/nav.ts#accountNavLinks`); "API documentation" entry shown to every role (no permission).
- Content skeleton on any sidebar click, 15 s give-up timer (`components/dashboard/navigation-pending.tsx`); spec has only AS-91 for loading.
- Fallback when `GET /shops/mine` fails but the shop loads: shell shows only the current shop (`shop-frame.tsx`).
- Current shop is prepended to the switcher when not in the first page (`shop-frame.tsx`).
- Legacy `/dashboard/seller/inventory` redirect page (`app/dashboard/seller/inventory/page.tsx`); spec lists only `/dashboard` and `/dashboard/settings` redirects.
- `PATCH /shops/:shopId` rename and `GET /shops/:id` extras exist in the API, with no screen in this area.
- Form has no `Idempotency-Key` although the API accepts one (`shop.controller.ts` `@Idempotent({required:false})`).
- Typing limit of 80 characters in the Handle field while the API accepts only 3 to 40 (`open-shop-form.tsx`).

## (b) In the spec, not found in the code (likely bugs)
- W04.B-36 "400 invalid_cursor -> 'That page link is no longer valid.' with 'Go to the first page'": for `/dashboard/seller?cursor=garbage` the page throws `Error('shops_unavailable')` for every non-401 failure (`app/dashboard/seller/page.tsx`), so the user sees the generic error page, not the cursor message. Same for the picker "Next page" link when its cursor ages out.
- W04.B-35 offline banner: it is in `components/dashboard/banners.tsx`, used only inside the shop shell; the open-shop form and picker pages (`/dashboard/seller`) have no offline banner.
- W04.B-33 "redirect to /login?returnTo= that path and query": the layout guard (`shop-frame.tsx#ShopFrame`) builds returnTo from `/dashboard/seller/<shopId>` only, with no sub-path or query. It is correct only if every page also guards itself first; verify for each sub-page.
- W04.R-24 "a row menu trigger MUST be named after its row": row menus are outside this area; not checked here.
- W04.R-32 spec says the switcher keeps "the current section"; code drops the query string and any detail id (by design in `switchShopHref`); spec does not state this.
- W04.B-02 "session role refreshed up to 3 times": code stops early once the role is SELLER; spec does not mention the early stop.
- W04.B-34 (401 -> session-ended flow once): `/dashboard/seller` server page redirects to login on 401 instead of running the client flow; spec wording covers client requests only.

## (c) Spec and code disagree (quote both)
- Spec W04.B-03: "given 409 slug_taken or 422 slug_reserved, then the message appears under 'Handle'; given 409 shop_limit_reached or 429, then an alert appears above the button". Code (`open-shop-form.tsx`): matches, but `429` shows a countdown box ("Too many attempts. Try again in N s.") and disables the button, and the 5xx / network errors also use the above-button panel; the spec does not describe those.
- Spec S03.R-13: slug 3 to 40 characters. Code: field `maxLength={80}` so an 80-char handle can be typed and is only refused by the client check on blur or submit (`open-shop-form.tsx`).
- Spec W04.R-04: "a shop id that is not a UUID MUST NOT reach the API". Code checks `isUuid` in `lib/server/seller.server.ts#readShop` (matches). But `readMyShops` and the `/dashboard/seller/inventory` redirect do not need an id; ok. The API itself uses `ParseUUIDPipe`, so a direct call with a non-UUID id answers 400, not the 404 `shop_not_found` of S03.R-01 ("a malformed identifier ... MUST all answer the same 404"): `packages/backend/libs/domains/tenancy/api/shop.controller.ts` `@Param('shopId', ParseUUIDPipe)`. Test this on the API.
- Spec S03.B-04 / W04 picker: web asks `limit=50`; spec W04.R-32 says "first 50" for the switcher; the picker page also uses 50 per page, spec B-04 gives no page size.
- Spec W04.AS-85 says the not-found page is "identical in all three cases"; code makes 401 a redirect and 403 and 404 both not-found (`shop-frame.tsx`), so a 403 permission failure on the shop read hides as not-found (consistent, but spec S03.R-04 order says 403 exists for members lacking `shop.read`; every role has it, so unreachable).
- `error.tsx` boundaries are typed with a `retry` prop (`[shopId]/error.tsx`, `app/error.tsx`); verify at runtime that "Try again" really re-renders (not mapped to Next's `reset`).
- `app/dashboard/seller/` has no `error.tsx` of its own: a failure of `/dashboard/seller` itself falls to `app/error.tsx` (full page), unlike the shop pages that keep the shell.
