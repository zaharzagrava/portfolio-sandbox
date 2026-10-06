# Advanced TypeScript

At senior level, interviewers want to see that you use the type system to **make illegal states unrepresentable** and that you understand where static types stop: types are erased at runtime, so you have to validate at the boundaries.

---

## 1. Structural typing and its consequences

TS is **structural**: two types are compatible if their shapes match. Names don't matter.

```ts
type UserId = string;
type OrderId = string;
function getOrder(id: OrderId) {}
const u: UserId = 'u_1';
getOrder(u); // compiles. Bug.
```

### Branded / nominal types: the fix

```ts
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

type UserId = Brand<string, 'UserId'>;
type OrderId = Brand<string, 'OrderId'>;
type Cents = Brand<bigint, 'Cents'>;

const UserId = (s: string) => s as UserId;   // single place to construct/validate
getOrder(UserId('u_1')); // error
```

Use brands for IDs, money, already-sanitized HTML (`SafeHtml`), and validated emails.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`Brand`](../../packages/backend/libs/common/core/brand.ts#L7): `Brand` is the generic branded type that adds a unique symbol to make nominal IDs. _(brand.ts)_
> - [`asBrand`](../../packages/backend/libs/common/core/brand.ts#L10): `asBrand` is the cast helper that creates branded values at trusted boundaries. _(brand.ts)_
<!-- theory-links:end -->

---

## 2. Discriminated unions + exhaustiveness

Model state machines (orders, payments, chat-bot flows) so that impossible combinations can't type-check:

```ts
type Payment =
  | { status: 'pending'; createdAt: Date }
  | { status: 'settled'; settledAt: Date; txId: string }
  | { status: 'failed'; reason: string; retryable: boolean };

function describe(p: Payment): string {
  switch (p.status) {
    case 'pending': return 'waiting';
    case 'settled': return p.txId;             // narrowed
    case 'failed':  return p.reason;
    default: return assertNever(p);            // compile error if a new status is added
  }
}
function assertNever(x: never): never { throw new Error(`Unhandled: ${JSON.stringify(x)}`); }
```

Compare this to `{ status: string; settledAt?: Date; txId?: string; reason?: string }`, which permits 2^n nonsense states.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`OrderStatus`](../../packages/backend/libs/domains/orders/domain/order-state.ts#L12): `OrderStatus` in order-state.ts is a union of the valid order states used as the discriminant. _(order-state.ts)_
> - [`canTransition`](../../packages/backend/libs/domains/orders/domain/order-state.ts#L49): `canTransition` checks whether a command is allowed from the current order status, implementing the state machine. _(order-state.ts)_
> - [Payment status values](../../docs/humans/concepts/domain-payments/payment-status.md): The payment status page lists the six states (PENDING, COMPLETED, FAILED, CANCELLED, REFUNDED, UNKNOWN) as a closed set. [`PaymentStatus`](../../packages/backend/libs/domains/payments/infra/models/payment.model.ts#L33)
<!-- theory-links:end -->

---

## 3. Narrowing toolkit

- `typeof`, `instanceof`, `in`, equality, truthiness, and discriminant checks.
- **User-defined type guards**: `function isFoo(x: unknown): x is Foo`.
- **Assertion functions**: `function assert(cond: unknown, msg?: string): asserts cond`.
- TS 5.5 **infers type predicates**: `arr.filter(x => x !== undefined)` now narrows to `T[]`.
- `unknown` vs `any`: `unknown` makes you narrow before you can use the value. `any` switches checking off and **spreads** through everything it touches. Catch variables are `unknown` under `useUnknownInCatchVariables` (part of `strict`).

---

## 4. Generics done right

```ts
// constraint + keyof + indexed access
function pluck<T, K extends keyof T>(items: T[], key: K): T[K][] {
  return items.map(i => i[key]);
}

// const type parameter (TS 5.0): infer literal types
function routes<const T extends readonly string[]>(r: T) { return r; }
const r = routes(['/a', '/b']); // readonly ['/a', '/b'] not string[]

// NoInfer (TS 5.4): stop inference from a specific position
function createFSM<S extends string>(states: S[], initial: NoInfer<S>) {}
createFSM(['idle', 'run'], 'jump'); // error, without NoInfer 'jump' would widen S
```

Rule of thumb: a type parameter should appear **at least twice**, linking inputs to outputs. If it appears only once, replace it with a concrete type or `unknown`.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`JobHandlerFn`](../../packages/backend/libs/infrastructure/jobs/job-types.ts#L50): `JobHandlerFn<T>` is generic on the job type and links the payload type `JobPayloads[T]` to the handler input. _(job-types.ts)_
<!-- theory-links:end -->

---

## 5. Conditional, mapped and template-literal types

```ts
// Conditional + infer
type Awaited2<T> = T extends PromiseLike<infer U> ? Awaited2<U> : T;
type ElementOf<T> = T extends readonly (infer E)[] ? E : never;

// Distributivity: naked type params distribute over unions
type ToArray<T> = T extends any ? T[] : never;
type A = ToArray<string | number>;           // string[] | number[]
type NoDistrib<T> = [T] extends [any] ? T[] : never;
type B = NoDistrib<string | number>;         // (string | number)[]

// Mapped types with key remapping
type Getters<T> = { [K in keyof T as `get${Capitalize<string & K>}`]: () => T[K] };

// Remove readonly/optional modifiers
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type RequiredDeep<T> = { [K in keyof T]-?: T[K] extends object ? RequiredDeep<T[K]> : T[K] };

// Template literal parsing
type Params<P extends string> =
  P extends `${string}:${infer Param}/${infer Rest}` ? Param | Params<Rest>
  : P extends `${string}:${infer Param}` ? Param : never;
type X = Params<'/users/:userId/orders/:orderId'>; // 'userId' | 'orderId'
```

**Be able to implement the built-in utility types on a whiteboard:**

```ts
type MyPick<T, K extends keyof T> = { [P in K]: T[P] };
type MyOmit<T, K extends PropertyKey> = MyPick<T, Exclude<keyof T, K>>;
type MyExclude<T, U> = T extends U ? never : T;
type MyReturnType<F> = F extends (...args: any[]) => infer R ? R : never;
type MyPartial<T> = { [K in keyof T]?: T[K] };
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`JobType`](../../packages/backend/libs/infrastructure/jobs/job-types.ts#L17): `JobType` is a type derived from the keys of `JobPayloads` with `keyof`, a type-level mapping. _(job-types.ts)_
<!-- theory-links:end -->

---

## 6. Variance

- Function **parameters** are contravariant and **return types** are covariant.
- Under `strictFunctionTypes`, **method** shorthand parameters stay *bivariant* for historical reasons, while function-property syntax is checked contravariantly:
  ```ts
  interface A { m(x: Dog): void }      // bivariant (unsound)
  interface B { m: (x: Dog) => void }  // contravariant (sound)
  ```
- Arrays are covariant, which is unsound: `const animals: Animal[] = dogs; animals.push(cat);` compiles.
- Explicit variance annotations `in`/`out` on type parameters (TS 4.7) help with performance and documentation.

---

## 7. `satisfies`, `as const`, and object literal inference

```ts
const config = {
  port: 3000,
  db: { url: process.env.DB_URL! },
} satisfies AppConfig;         // validates against AppConfig but KEEPS the literal types
// vs `const config: AppConfig = ...` which widens to AppConfig.

const ROLES = ['admin', 'finance', 'viewer'] as const;
type Role = typeof ROLES[number]; // 'admin' | 'finance' | 'viewer'
```

Prefer `as const` objects or union literals over `enum`. Enums emit runtime code, numeric enums accept any number, and enums aren't "erasable syntax" (see below).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SHOP_PERMISSIONS`](../../packages/backend/libs/domains/tenancy/domain/permissions.ts#L8): `SHOP_PERMISSIONS` is a const array of permission strings, used as a literal-union source instead of an enum. _(permissions.ts)_
> - [`WEBHOOK_EVENT_TYPES`](../../packages/backend/libs/domains/developer-platform/domain/webhook-events.ts#L2): `WEBHOOK_EVENT_TYPES` is a const array of allowed webhook events, the `as const` pattern. _(webhook-events.ts)_
<!-- theory-links:end -->

---

## 8. Runtime validation at boundaries

Types disappear at runtime. **Every trust boundary** (HTTP body, queue message, env vars, third-party API response, `JSON.parse`) needs runtime validation:

```ts
import { z } from 'zod';
const CreateInvoice = z.object({
  clientId: z.string().uuid(),
  amountCents: z.coerce.bigint().positive(),
  period: z.object({ from: z.coerce.date(), to: z.coerce.date() })
    .refine(p => p.from < p.to, 'from must be before to'),
});
type CreateInvoice = z.infer<typeof CreateInvoice>;  // single source of truth
```

In NestJS, `class-validator` with `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` plays the same role and also **blocks mass assignment**.

Validate env at startup (`z.object({...}).parse(process.env)`) so the process fails fast instead of crashing at 3 a.m.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`defineEvent`](../../packages/backend/libs/infrastructure/events/define-event.ts#L24): `defineEvent` builds a typed event with a Zod schema that validates the payload at runtime. _(define-event.ts)_
> - [`CatalogRow`](../../packages/backend/libs/domains/catalog-sync/domain/rows.ts#L8): `CatalogRow` is a Zod schema that validates catalog sync rows at the boundary. _(rows.ts)_
> - [`CreateShopDto`](../../packages/backend/libs/domains/tenancy/api/tenancy.dto.ts#L5): `CreateShopDto` is a class-validator DTO that validates the HTTP request body. _(tenancy.dto.ts)_
<!-- theory-links:end -->

---

## 9. Declaration merging and module augmentation

```ts
// Add `user` to Express Request
declare global {
  namespace Express { interface Request { user?: AuthUser; requestId: string } }
}
export {};
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`JobPayloads`](../../packages/backend/libs/infrastructure/jobs/job-types.ts#L11): `JobPayloads` is an interface that domains augment through declaration merging, so there is no central list of jobs. _(job-types.ts)_
<!-- theory-links:end -->

---

## 10. tsconfig flags a senior should have opinions on

| Flag | Why |
|---|---|
| `strict` | baseline, non-negotiable |
| `noUncheckedIndexedAccess` | `arr[i]` and `record[key]` become `T \| undefined`, which catches a lot of real bugs |
| `exactOptionalPropertyTypes` | separates "missing" from "explicitly `undefined`" (matters for PATCH semantics) |
| `noImplicitOverride`, `noFallthroughCasesInSwitch` | safety |
| `verbatimModuleSyntax` | `import type` is explicit, predictable emit for ESM |
| `isolatedModules` / `erasableSyntaxOnly` (5.8) | required by per-file transpilers (esbuild, swc, Node type stripping) |
| `moduleResolution: "nodenext"` / `"bundler"` | correct `exports` resolution |

**Node native TypeScript**: recent Node versions (22.18+/23.6+) **strip types** by default. Only *erasable* syntax works: no `enum`, no `namespace` with values, no parameter properties. That's another reason to avoid enums.

---

## 11. Type-level performance and maintainability

- Deeply recursive conditional types slow the compiler down and produce unreadable errors. Prefer simple types plus runtime validation.
- Use `interface` for object shapes that get extended: interfaces are cached by name and give better error messages. Use `type` for unions and compositions.
- Large monorepos: project references (`composite`, `tsc -b`). The **native TS compiler (TypeScript 7, Go port)** promises roughly 10× faster type checking, so it's worth knowing that it exists.

---

## Interview Q&A

**Q: `interface` vs `type`?**
They're mostly interchangeable. Interfaces support declaration merging, are better for extensible object shapes and public APIs, and give faster checking and nicer errors. Use types for unions, mapped and conditional types, and tuples.

**Q: How do you make sure a `switch` handles all cases?**
Use a discriminated union with a `default` branch that assigns to `never` (`assertNever`). Adding a variant then becomes a compile error at every switch that's missing it.

**Q: The API returns JSON. Is casting it to `User` enough?**
No. `as` is an unchecked assertion. Parse it with a schema (zod, valibot, class-validator), derive the TS type from the schema, and fail loudly at the boundary.

**Q: How would you stop someone from passing a `userId` where an `orderId` is expected?**
Branded types, created through a single constructor or validation function.
