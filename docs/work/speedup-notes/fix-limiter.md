# Limiter failures under a busy machine

Two separate causes, both only visible when the machine is busy.

1. The rate limiter gives its counter store 200 ms per call. On a busy machine a few calls take longer, the limiter
   switches itself off for a while ("breaker open"), and with the frozen test clock it never switches back on. That gave
   the 503 "rate_limiter_unavailable" in the subscription test and wrong counts in courier/ads tests.
   Fix: test/e2e-env.setup.ts now gives the store 3000 ms in every test (one place). Apps built with a fault proxy in
   front of Redis (the tests that check the short allowance and the fail-open path) are put back to 200 ms in
   test/utils/catalog-app.ts, because their "store hangs" tests depend on giving up fast.
2. Cart writes (120 per minute) and autocomplete (600 per minute) use a sliding one-minute window measured with the
   store's real time. When 120 or 600 calls take close to a minute on a busy machine, the oldest calls slide out of the
   window and the 121st/601st is let through (200 instead of 429). Fix: those two test apps now measure the limiter's time
   with the frozen test clock (new option limiterUsesClock in createCatalogApp/createSearchApp; set in createOrdersApp and
   createAutocompleteApp), the same way the media test app already did. The wave size does not change the count.

Not run under artificial load; checked by reasoning plus passing runs on shard 7.
