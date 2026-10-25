# Human test guide: the four seller pages

For the owner, to click through the app by hand. About 45 minutes. For the "does it feel right" questions (wording, colours, look) use the longer list in `scripts/aiqa/human-pass.md`; this guide says WHERE to go and WHAT to try.

## Before you start

- The app runs at `http://localhost:3000` (web) and `http://localhost:8000` (API). If it is not running, start the dev stack the way you usually do, or ask for the QA stack.
- Rule of thumb: LOOK in the Demo Shop, CHANGE things in your own shop.
  - `seller@marketplace.local` / `Demo-Seed-Pw-7491!`: owner of "Demo Shop", which has many products, orders and photos. Use it to LOOK only (read the inventory, orders and photos pages). Do not edit, archive or change stock there: the automated tests read this shop and could fail for no good reason.
  - Your own new user and shop: register at `/register`, open a shop, and do everything that changes data here (open-shop form, add, edit, stock, archive and restore, photos, roles, suspended shop).
  - `admin@marketplace.local` / `Demo-Seed-Pw-7491!`: platform admin. Use it only to suspend and reinstate YOUR OWN new shop, never the Demo Shop.
  - Orders: your new shop has none. Read orders in the Demo Shop. To make a new order, register a second user as a buyer and buy a product from your own shop.
- Ready-made accounts for you (password `Owner-Test-Pw-2026!` for both, created on the dev stack):
  - `me-seller@example.com`: owner of two empty shops, "My First Shop" and "My Second Shop" (so the picker and the switcher can be tried at once). Add the products yourself.
  - `me-buyer@example.com`: a plain buyer, for placing an order in your shop (use another browser profile).
- To get a shop address: sign in (as the demo seller, or as your own user) and open `http://localhost:3000/dashboard/seller`. With one shop it sends you straight to `/dashboard/seller/<shopId>`. Copy the `<shopId>` from the address bar.
- Check each page once on a laptop and once with the window squeezed to about 390 px wide (browser phone mode).
- Invitation mail does not go to Mailpit. It goes to the API's in-memory mailbox: open `http://localhost:8000/api/dev/mailbox?to=<email>` to read the link (the mailbox keeps the last 50 mails and is emptied when the API restarts).

## Page 1: Open a shop, pick a shop, switch shop, and the page frame

Address: `/dashboard/seller` and everything under `/dashboard/seller/<shopId>`.

1. Register a new user at `/register` and open `/dashboard/seller`. You see "Open your shop" with "Shop name" and "Handle". Type "Café Münster": the handle becomes `cafe-munster`. Try an empty form, a handle that is taken (`demo-shop`), and a reserved one (`admin`). Open the shop: you land on the new shop overview.
2. Go back with the browser Back button after opening: you must land on the overview, not the form again (this was a bug).
3. Two shops for one user (to see the picker and the switcher): the app has NO button for a second shop (the open-shop form shows only to a user without a shop, and the picker has no "new shop" link; that is how the spec is written). Make the second shop through the API. In a terminal, replace the email and password with your user's:

       TOKEN=$(curl -s -X POST localhost:8000/api/auth/login -H 'content-type: application/json' -d '{"email":"YOU@example.com","password":"YOUR-PASSWORD"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['accessToken']['token'])")
       curl -s -X POST localhost:8000/api/shops -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"name":"My Second Shop","slug":"my-second-shop-1"}'

   Then reload `/dashboard/seller`: with two shops you see a picker (name, handle, role, badge). The shop switcher at the top lists the shops; switching keeps you on the same section.
4. Type a wrong shop address (`/dashboard/seller/not-a-shop`): you see "We couldn't find that shop." and nothing about other shops. Note: the page answers HTTP 200 with `noindex`, a decided limit.
5. Sign out and open `/dashboard/seller/<shopId>/inventory?q=mug`: you land on the login page. After login you must come back to the inventory page with the search, not the overview.
6. Menu and banners: the side menu entries match your role. At 390 px the menu is behind "Open seller menu". Turn the network off for a moment: the offline banner appears and goes away when the network is back.

## Page 2: Inventory

Address: `/dashboard/seller/<shopId>/inventory`

1. List: table on the laptop, cards on the phone. Prices with the currency sign, stock words (In stock, Low stock, Out of stock, Archived).
2. Search with a small typo ("ceramc mug"), a very long text (the page tells you 100 characters is the limit), and an emoji (finds nothing, an accepted limit of the search index).
3. Tabs Active / Archived and the Stock filter (on the phone behind "Filters"). Next page / First page. Edit the address by hand (`?status=bogus`): it falls back to the default.
4. "Add product": all fields, price with a comma and with a point, price `0` and `-1` (refused), a very long title (emoji count as one character each), a stock above one billion (refused). Press "Create product" twice quickly: only one product appears.
5. Row menu (three dots): Edit (change the title; open the same product in a second tab, change it there, save in the first: "This product changed since you opened it" with "Load latest"), Adjust stock (set 0, 1, 5, 6: the words change at 0, 1 to 5, 6 and above), Archive (the dialog starts focused on Cancel; archive; the product moves to the Archived tab), Restore.
6. After Cancel or Escape on any dialog, the focus returns to the three-dot button (use Tab to see the outline).
7. Roles: invite a second user as VIEWER from the Team page (`/dashboard/seller/<shopId>/team`), read the link in the dev mailbox, accept it. The viewer sees the list but no "Add product" and no row menu.
8. Suspended shop: as admin, suspend the shop (admin area or `POST /api/admin/shops/<id>/suspend`). The seller still sees the list and orders but every write control is off and a banner says why.

## Page 3: Product photos

Address: from the row menu "Photos and video", or `/dashboard/seller/<shopId>/products/<productId>/media`

1. Add one photo (jpg or png, under 15 MB): the row goes Sending, Waiting to process, Processing, then the picture appears. It should load from `http://localhost:9100` (MinIO).
2. Add a text file, an empty file and a very big picture: each is refused with a sentence. An animated PNG is refused too.
3. Add 5 photos at once and choose more than the free places up to 20: the page says how many were not added.
4. Move up / move down / remove. After a keyboard move the focus stays on a working button and a screen reader announces "Photo moved to position N of M". The first photo is the main image. Nothing is saved until "Save photos"; "Discard changes" puts it back.
5. Open the same product's photos in two tabs, change the order in both, save in both: the second save is refused ("The photos changed since you opened this page"), it never overwrites silently.
6. Open the product page as a buyer (`/products/<productId>`): the main image shows. (Photos saved before the fix may still point at the old wrong address: add a new photo.)
7. Archived product: its photos page shows "This product is archived. Restore it to change its photos." with the controls off. Suspended shop: the photos show, the controls are off.
8. Go offline and press "Save photos": the page says it could not reach the server and sends nothing later by itself.

## Page 4: Orders

Address: `/dashboard/seller/<shopId>/orders`

1. As the demo seller you see orders newest first with a short reference, status, items, subtotal and date. The buyer is not shown anywhere (also not in the page source). Hover the date for the exact time.
2. Status filter: Paid, Cancelled, Pending, Refunded; "Clear filter". Try `?status=BOGUS` by hand: it falls back to "All statuses".
3. Next page / First page: "First page" keeps the status filter.
4. Place an order yourself: sign in as a buyer in another browser profile, add a Demo Shop product to the cart and pay with the sandbox card. The order appears for the seller. An out-of-stock attempt must not leave a cancelled order in the seller's list.
5. Roles: owner, admin and staff and viewer all see the orders. A long shop name wraps and does not make the page scroll sideways at 390 px.
6. Suspended shop: orders stay readable.
7. Times: order dates show in your own time zone after the first paint.

## Decisions and known limits you will meet

- Unknown or foreign shop pages answer HTTP 200 (with the not-found words and `noindex`), not 404. Decided; the spec says so now.
- Emoji search finds nothing (search index limit). Decided: leave.
- The Stock filter on Archived products only looks at the quantity (an archived product with quantity 100 shows under "In stock"). Decided: leave.
- A `PARTIALLY_SHIPPED` or refund state cannot be created by hand in the dev stack; the Refunded filter is checked only with test data.
- Rate limits do not trigger from localhost. To see one, call the API through your LAN address (for example `http://192.168.55.6:8000`).
- Real mail and payments are fakes in dev (in-memory mailbox, sandbox cards).
- Not yet measured: mutation tests of the backend, planted-bugs score, code-coverage read-out. They run after your click-through.

## What to write down

For anything that looks wrong: the page address, what you did, what you expected, what happened. Put it in `docs/work/qa-bug-register.md` as the next `B-nnn` row, or just tell me.
