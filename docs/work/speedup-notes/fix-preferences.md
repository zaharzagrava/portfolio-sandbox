# Preferences race (S28 AS-24)

What went wrong: saving one setting is safe (one atomic row per setting). The problem was the saved copy of the user's settings (kept 5 minutes). A reader could read the old data, a write could then clear that copy, and the slow reader would put its old data back. A later read then saw the old value (for example shop/push true again).

Fix: libs/domains/notifications/application/recipient-view.service.ts now counts clears per user. If a clear happened while a read was running, that read throws its copy away, reads again from the database and clears again. API answers are unchanged.

Limit: the count is per process; a clear from another process is still covered only by the normal clear. The count map is one small number per user seen.

Check: could not reproduce before the fix (12 loaded runs all passed, the race is rare). After the fix: 12 loaded runs on shards 1 to 4, all 16 tests passed each time.
