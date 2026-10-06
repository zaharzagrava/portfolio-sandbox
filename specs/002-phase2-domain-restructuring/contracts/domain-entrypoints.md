# Contract: Domain Entry Points (batch 1)

Constitution X.4: code outside a domain imports **only** `@app/domains/<domain>`. The files below are
the complete public surface after batch 1. They're generated from actual usage, so every export has
at least one consumer. Adding an export is a deliberate API change in a PR.

Legend: **[T]** marks a transitional export that later debt work removes (D-7 for models, D-8 for
infra internals).

## `@app/domains/identity`

| Export | Source | Kind |
|---|---|---|
| `UserModel` [T], `Role` | `infra/models/user.model` | model, enum |
| `FederatedIdentityModel` [T], `SigningKeyModel` [T] | `infra/models/*` | models |
| `AuthModule`, `AuthApiModule`, `AuthWorkerModule`, `UsersModule`, `UsersDtoModule`, `UserUtilsModule`, `AdminModule` | root | Nest modules |
| `Firewall` | `api/decorators/firewall.decorator` | route decorator (authN/authZ, II.2) |
| `User` | `api/decorators/user.decorator` | param decorator (current principal) |
| `CreateUserDto`, `UserRawDto` | `api/users.dto` | DTOs |
| `AuthService`, `UserUtilsService` | `application/*` | exported services (R1) |
| `SecretBox` [T], `KeyStore` [T], `OidcService` [T] | `infra/*` | infra internals |

## `@app/domains/tenancy`

| Export | Source | Kind |
|---|---|---|
| `ShopModel` [T], `ShopMembershipModel` [T], `ShopInviteModel` [T], `ShopDirectoryModel` [T], `ShopSsoConfigModel` [T] | `infra/models/*` | models |
| `TenancyModule`, `TenancyWorkerModule` | root | Nest modules |
| `ShopScoped` | `api/shop.guard` | route decorator (shop membership + RBAC) |
| `MembershipService` | `application/membership.service` | exported service (R1). It's the intended replacement for direct `ShopMembership` reads (domain map §4). |

## `@app/domains/catalog`

| Export | Source | Kind |
|---|---|---|
| `ProductModel` [T], `PRODUCT_EMBEDDING_DIMS` | `infra/models/product.model` | model, constant |
| `ProductModule`, `ProductWorkerModule`, `ProductDtoModule`, `CollabModule`, `DraftsModule` | root | Nest modules |
| `ProductService` | `application/product.service` | exported service (R1) |
| `ProductDtoService` [T], `ProductSearchProjector` [T], `ProductCacheInvalidator` [T] | `infra/*` | infra internals |

## Rules

- No `export *`. Values use `export { }`; type-only symbols use `export type { }` (`isolatedModules`).
- Default exports are re-exported by name. Models carry the `Model` suffix.
- Barrels are not imported from inside their own domain (internal imports stay relative). This
  keeps barrel cycles out of a domain's own load order.
