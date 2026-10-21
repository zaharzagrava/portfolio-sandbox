# Fix for the S05 AS-80 test (Product.shopId was allowed to be empty)

What was wrong: the database column Product.shopId was nullable although the rule (S05) says it must be required.
It was a real bug, not an outdated test. No later migration relaxed it on purpose.

Cause: migration 20261012110100 sets the column to NOT NULL and then removes an "old S03 check" named
Product_shopId_not_null. On PostgreSQL 18 (the version used here) the NOT NULL rule itself has exactly that
name, so the cleanup line silently removed the rule that was just added.

Changes (nothing committed):
- migrations/20261012110100-catalog-s05-contract-shop-not-null.js: the cleanup now removes that name only if it is
  an old check, never the NOT NULL rule.
- migrations/20261019000200-catalog-s05-restore-shop-not-null.js (new): puts NOT NULL back on databases that
  already ran the old version. Does nothing where it is already required; refuses to run if products without a shop exist.
- The test and the model were not changed.

Checked on shard 6: the template database was dropped and re-created, the whole file product-shop-lifecycle.e2e-spec.ts
passes (14 of 14). Other shards clone the same template, so they will also pick it up after the same template drop.
The default test database marketplace_test was not touched (it needs the new migration run once).
