# Data Model: Phase 3

No schema change and no ownership-registry entry change.

**Model registration (D-9).** `ALL_MODELS` is gone. Every app's Sequelize model set is now the union of the
`SequelizeModule.forFeature` calls made by the domain modules it loads (`autoLoadModels`).
`pnpm check:model-registry` builds a Sequelize instance offline from each app's set, which wires all
associations the same way boot does.

| App | Models | App | Models |
|---|---|---|---|
| bff | 0 (composition, no DB) | public-api | 24 |
| collab | 18 | sse-gateway | 29 |
| core | 29 | worker | 29 |
| local-monolith | 29 | projector | 29 |
| payment-processor | 18 | e2e harness | 29 (+ `Migration` from the seeds module) |

**Batch-read endpoints (D-4).** These are unchanged reads of tables their new owners own: tenancy reads
`Shop`, catalog reads `Product`.

**Realtime topic policies (D-3).** Each policy now reads only its owner's table: `ChatChannelMember`,
`Delivery`, `ImportJob`, `ExportJob`, `ShopMembership`.
