# Flags test: the "Kill switch" menu item that would not hold still

What happened: once in 10 runs the test found the menu item but waited 90 s for it to stand still.

What I checked: the table rows have steady keys, so an open row is not rebuilt when the list refreshes. The menu
has no polling. The only refresh is "reload when the window gets focus". I could not reproduce it: 24 of 24 passed
with 3 workers in parallel, then 80 of 80 for the whole file. So I found no product bug I can prove.

Most likely cause: the page is drawn on the server, then comes alive (hydration) and reloads the list. A menu opened
in that short moment can be rebuilt under the mouse.

Fix (test only, no check weakened): the test opens the menu again and clicks the item, retrying for up to 20 s, with
each try short (3 s). Same idea as the Share button test.
