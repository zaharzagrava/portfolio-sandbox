# Front-end visual tests: notes

## Chat "not-sent" picture (both phone and desktop)
- The test replaces the live connection with a fake one that ends right away. The page then says "Reconnecting..." three seconds later.
- So a picture taken in the first three seconds has no banner, and one taken later has it. The old saved picture was taken on a slow run and had the banner by accident. Desktop "muted" was the same.
- Fix: the one long test ("a conversation") now uses a small local server that keeps the connection open for good, so the banner never shows, however slow the run is.
- The saved pictures not-sent (phone, desktop) and muted (desktop) were regenerated after looking at them: the only change is that the banner is gone.

## Notifications panel "dialog not found"
- Not a product bug. The web server on port 3000 vanishes whenever another helper's Playwright run that started it ends. Then every test fails at once ("connection refused" or the panel not found).
- With a server that stays up, all 22 chat + notification tests pass (also twice in a row). Nothing was changed in those tests.
