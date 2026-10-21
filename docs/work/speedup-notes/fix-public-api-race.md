# Two public API tests that failed (AS-54 and AS-40)

## What was wrong
Not a race and not a bug in the product code. A shop on the free plan may have at most 10 live products. Both tests
create many products in one shop (AS-54: 20 rounds of one new product each; AS-40: 20 rounds, each making a product).
From the 11th product the server correctly answered 409 "plan_limit_reached". In AS-54 that left a round with no
fresh 201 (the 11th round); in AS-40 it showed up as 409 where 201 was expected on create.

The HTTP 500 lines in the log were a red herring: they come from other tests in the same file that make the create
fail on purpose ("transient", "boom") to prove that a 500 is not stored.

## Fix (test setup only, no check weakened)
In both spec files the plan answer is replaced by an "no cap" one (the same kind of stand-in the catalog plan-limit spec
uses). The real limit stays proved in libs/domains/catalog/product-plan-limit.e2e-spec.ts.
- libs/domains/developer-platform/public-api-limits.e2e-spec.ts
- libs/domains/developer-platform/public-api-resources.e2e-spec.ts

## Result (shard 5)
limits file: 22 of 22 pass. resources file: 40 of 40 pass. Nothing committed.
