# Human pass: things only a person can judge

For the owner, at the end of a round (Track 7). Click through each page yourself, once on a laptop and once with the window squeezed to phone width (about 390 px wide, or the browser's phone mode). The robots already check that things work and are reachable; this list is about whether they feel right. Tick a box when it is fine; write a short note next to anything that is not.

Made from the maps in `scripts/aiqa/coverage/` (entry, inventory, media, orders) and their `.gaps.md` files. About 40 items.

How to read the marks: [ ] not looked at yet, [x] fine, [!] not fine (write why).

## Open your shop (first visit, no shop yet)

- [ ] The page says clearly what happens: "Open your shop", and that you become the owner. Does the sentence sound friendly and right?
- [ ] Type a shop name: the handle fills in by itself. Does the handle look like something you would be happy to have in a web address?
- [ ] Press "Open shop" with empty fields. Are the error sentences kind and clear, and is the cursor put in the right box?
- [ ] Type a handle that is already taken. Is the message under the right box and easy to understand?
- [ ] Open the shop. Does the short "Your shop is open" message show long enough to read, and does the overview feel like arriving somewhere?
- [ ] On the phone width: is the "Start selling" side part stacked sensibly above the form, and nothing cut off?

## Your shops (picker) and the shop switcher

- [ ] With two shops: the list shows name, role and a status badge. Are the words (Owner, Suspended, Closing) the ones you would use?
- [ ] The switcher: is it obvious which shop is the current one? Is "All your shops" easy to find?
- [ ] Switching shops keeps you in the same section (for example Inventory). Does that feel natural, or surprising?
- [ ] Type a wrong shop address by hand. Does the "We couldn't find that shop." page feel helpful, and does it show nothing about other shops?

## Page frame (menu, banners, phone drawer)

- [ ] The side menu: are the names and their order sensible for a seller (Overview, Inventory, Orders, Team ...)? Anything missing or confusing?
- [ ] On the phone: the top bar shows the shop and the page name. Does the "Open menu" button feel easy to hit with a thumb?
- [ ] The drawer opens and closes smoothly, and pressing outside it closes it. Does it feel solid, not jumpy?
- [ ] Clicking a menu entry shows a grey loading shape. Does the wait feel short enough, and is the shape close to the real page?
- [ ] Suspended shop banner: is the wording calm and clear about what you can and cannot do?
- [ ] Turn the network off for a moment: does the "You're offline" banner appear, and disappear when it is back, without scaring you?
- [ ] Colors and size: is the text easy to read in light mode and in dark mode? Anything too pale?

## Inventory (the product list)

- [ ] First look at an empty shop: "No products yet." with an "Add product" button. Is it inviting?
- [ ] With some products: table on a laptop, cards on the phone. Are the columns in a useful order, is the long product name handled well (not breaking the page)?
- [ ] Money: do prices show the way you expect (currency sign, two decimals, your comma or dot habit)?
- [ ] Stock words: "In stock", "Low stock", "Out of stock", "Archived". Are the colors of the badges telling you the right thing at a glance?
- [ ] The three-dot menu on each row: are the entries in a good order (Edit, Adjust stock, Photos and video, Edit together, Archive)? Is "Edit together" a name you understand?
- [ ] Search: type with a small typo. Is the result quick enough, and do the two grey hint lines ("Search covers all products", "can take a few seconds") help or annoy?
- [ ] Filters: Active/Archived tabs and the Stock choice. On the phone they hide behind a "Filters" button. Is that easy to find and to close?
- [ ] "No products match ..." and "No archived products." messages: is each one clear about why the list is empty and what to do?
- [ ] Next page and First page buttons: easy to find, and does going forward and back feel normal?

## Add and edit a product (dialogs)

- [ ] The "Add product" window: is the order of the fields natural, and is "Price (EUR)" clear about the money unit?
- [ ] Press "Create product" with mistakes. Is the red box at the top plus the notes under the fields helpful, or too loud?
- [ ] After saving: "Product created" message and the new product on top. Does it feel finished?
- [ ] The edit window says "Only the fields you change are saved". Does the "Save changes" button greying out until you change something feel right?
- [ ] On the phone the dialog fills the screen. Can you reach the buttons with the keyboard open?

## Stock, archive and restore

- [ ] "Adjust stock" small window: does it sit next to the right number, and is "New stock" / "Update stock" clear?
- [ ] Two people changing the same product: the sentence "Stock changed to N while you were editing" or "This product changed since you opened it". Would a shop owner understand it and know what to do next?
- [ ] Archive question: is the explanation ("It disappears from the storefront and search. You can restore it.") calm and enough? Is it clear that Cancel is the safe button?
- [ ] Restore: it happens at once without asking. Does that feel right, and is the "Product restored" message clear?

## Product photos

- [ ] Opening "Photos and video" from the row menu: do you know where you are and how to get back ("Back to inventory")?
- [ ] The explanation line ("The first photo is the main image. Changes apply when you save."): clear? Would you expect a cover button?
- [ ] Add a photo: does the waiting text ("Sending", "Waiting to process", "Processing") feel honest and not stuck? How long did it really take?
- [ ] Try a wrong file (a text file, a very big picture). Are the refusal sentences clear, and are the two different "15 MB" sentences confusing?
- [ ] Move up / move down / remove buttons: easy to hit on the phone, and is it clear which photo each belongs to?
- [ ] Leave the page with unsaved photo changes. Does it feel OK that nothing warns you?
- [ ] "Save photos" and "Discard changes": is it obvious that nothing is saved until you press save?
- [ ] Do the photos look sharp and in the right shape (square thumbnails) and load fast enough?

## Orders

- [ ] Empty shop: "No orders yet." Is it friendly, or does it feel like a dead end?
- [ ] A shop with orders: is the short order code (first 8 characters) something a seller could use to talk to a buyer? Would you want the buyer name or a longer number?
- [ ] "Items" counts lines, not pieces. Does the column name match what you expect?
- [ ] Status colors and words (Pending, Paid, Cancelled, Refunded): clear? The seller cannot see shipping steps here; is that a gap you care about?
- [ ] Date and time: right time zone, readable, and hovering shows the exact time?
- [ ] Status filter and "No orders match this status." with "Clear filter": easy to use, also on the phone?
- [ ] The loading shape of this page looks like a product list (it has a search box). Does it look wrong for orders?
- [ ] Would you expect new orders to show up live on this page, like on the overview?

## Whole-app feel (do this on every page above)

- [ ] Keyboard only: Tab through the page. Can you see where you are (a clear outline), and can you reach everything and leave every window with Escape?
- [ ] Zoom the browser to 200%: is anything cut off or on top of something else?
- [ ] Read all messages out loud once: any word that sounds technical, rude, or unclear? Write the exact text.
- [ ] Different browsers: look at the inventory and photos pages once in Safari or Firefox if you can. Anything looks odd?
