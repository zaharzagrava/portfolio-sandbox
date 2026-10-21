# Three files that failed in the full 5-part run but passed alone

## ads-serving-clicks ("300 clicks ... all answer 302": 40 valid clicks where 20 expected)
Cause: this spec starts its app with a Redis "fault proxy" in front of Redis. The address of the proxy was written with database 0
fixed (".../0"), while every part of the run has its own Redis database (part 8 uses database 8). So the click counters
(one counter per address per minute) lived in the shared database 0, where every part that runs an ads test counts the same
local address. Another part's "reset" deleted the counters in the middle of our burst, the count started again, and 40 clicks
looked valid instead of 20. The wave size and the test body were not the cause (only the 121-request test was changed today).
Fix: the proxy address now takes the database number from REDIS_URL (same pattern other files already use). The same fixed "/0"
was in 26 other test helpers/specs (ads, share links, media, payments, billing, statements, catalog, community, seller-insights,
checkout, ...): all changed the same way, nothing else touched. Other parts could have been disturbed by these too.
Result: 39 of 39 pass on part 8.

## notifications-delivery (AS-49: status 'queued' instead of 'sent')
Cause: the test sends 20 mails at once through the real send-rate limiter (budget 14 mails per second, real time, kept in Redis
plus a small in-process lease). Earlier tests in the same file empty that budget on purpose (AS-42, AS-48) and the test
reset never refilled it. So how many mails were allowed depended on how fast the file ran: under load the budget was still
empty, the mail was put back on the queue ('queued'). The poll intervals shortened today were not the cause (this test does not poll).
This is the most likely cause; I could not make it fail on part 8 alone (it passes with and without the change).
Fix: the notifications test app's reset() now resets every provider send budget (email, sms, push, also marketing) in Redis
and the lease, so each test starts with a full budget. File: libs/domains/notifications/testing/notifications-app.ts.
Result: 24 of 24 pass.

## order-export-lifecycle (a download is audited once: log line missing)
Not reproduced: 15 of 15 pass alone and together with the 12 files that ran before it in the failing part (417 of 417 pass).
The download log line goes through Nest's global logger; it only reaches the test's capture when the global logger is the
structured one of the last app started. The reset in test/e2e-env.setup.ts already restores that per file. The failure
in the full run happened on a part where other files were also failing with missing metrics/logs
(discussions-resilience, launch-events-operations) and heavy limiter 503s, so a leftover from some earlier file is likely.
No change made for this file; if it comes back, run the whole part with TEST_LOGS=1 and look at which file ran right before it.
