# Advanced TypeScript

At senior level, interviewers want to see that you use the type system to **make illegal states unrepresentable** and that you understand where static types stop: types are erased at runtime, so you have to validate at the boundaries.

---

## 1. Structural typing and its consequences

TS is **structural**: two types are compatible if their shapes match. Names don't matter. A value with *at least* the required properties fits, and classes are compared by shape too (an instance of `class Vec { x = 5; y = 6 }` is a valid `Point`).

```ts
type UserId = string;
type OrderId = string;
function getOrder(id: OrderId) {}
const u: UserId = 'u_1';
getOrder(u); // compiles. Bug.
```

### Excess property checks and weak types

Two exceptions make TS stricter than pure structural typing:

- **Excess property check**: a *fresh* object literal (written directly where the type is expected) may not have unknown keys, because an extra key there is almost always a typo. The same object passed through a variable is not checked.
- **Weak type detection**: if every property of the target is optional, a source that shares **no** properties with it is rejected (`{ verbos: true }` is not an `Options`). An empty object `{}` is still fine.

```ts
type Point = { x: number; y: number };
const p = { x: 1, y: 2, z: 3 };
const a: Point = p;                    // OK: not fresh
const b: Point = { x: 1, y: 2, z: 3 }; // error: excess property 'z'
```

TS has no exact object types. To reject extra keys everywhere, validate at runtime (§13). Drill: [ts-24](../practice/live-coding/01-typescript.md#ts-24).

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

The brand exists only in types: at runtime the value is still a plain string, and a `UserId` can still be passed where a `string` is expected (only the other direction is blocked). The only way to create one is a cast, so put the cast inside a validating constructor and make it the single entry point. Use brands for IDs, money, already-sanitized HTML (`SafeHtml`), and validated emails. Drill: [ts-18](../practice/live-coding/01-typescript.md#ts-18).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`Brand`](../../packages/backend/libs/common/core/brand.ts#L7): `Brand` is the generic branded type that adds a unique symbol to make nominal IDs. _(brand.ts)_
> - [`asBrand`](../../packages/backend/libs/common/core/brand.ts#L10): `asBrand` is the cast helper that creates branded values at trusted boundaries. _(brand.ts)_
<!-- theory-links:end -->

---

## 2. `any`, `unknown`, `never`

One line to remember: **`any` turns checks off, `unknown` forces you to check, `never` means it can't happen.**

- **`unknown`** is the **top type**: anything can be assigned to it, but you can do nothing with it until you narrow it. The declared type is what counts: `let x: unknown = 5; x + 1` is still a compile error ("'x' is of type 'unknown'"), because assigning a number doesn't narrow `unknown`. Ways out: narrowing (`typeof x === 'number'`, §3), a type guard, or an assertion `x as number` (compiles, but unchecked: you take responsibility). `as` never converts anything at runtime. Rule: `as` is allowed when one type fits inside the other (narrowing `string | number` → `number`, widening `number` → `string | number`; from `unknown` or `any` always). Between two known types that don't overlap (`'abc' as number`, a `string` variable `as number`) TS refuses with TS2352 "may be a mistake… convert to 'unknown' first", and the escape hatch `x as unknown as number` (double assertion) is a red flag in review.
- **`any`** turns checking off in **both directions**: you can use it freely, *and* assign it to anything. `const n: number = anyValue` compiles even if the value is a string, and `n.toFixed()` then crashes at runtime. The wrong type spreads silently.
- **`never`** is the **bottom type**, the empty type: no value has it. Three uses:
  1. Return type of a function that never returns normally (always throws, or loops forever). It does not mean "returns an error".
  2. Exhaustiveness: in a `default` branch, `const _x: never = value` (or `assertNever`, §4) fails to compile once a new union member is added, so the compiler points at every switch you forgot to update.
  3. Impossible types: `string & number` is `never`, and in a union it disappears (`string | never` is `string`), which is how conditional and mapped types drop members (§10).

In practice: `catch (e)` is `unknown` under `strict` (`useUnknownInCatchVariables`), because JS can throw anything (a string, `null`, an object without `message`). Narrow it instead of writing `catch (e: any)`; the narrowing code is in §3. Same for `JSON.parse` output and request bodies. Drill: [ts-01](../practice/live-coding/01-typescript.md#ts-01).

---

## 3. Narrowing toolkit

Narrowing means TS shrinks a union inside a branch after a runtime check. Pick the check that fits each member:

- `typeof` for primitives. **Trap**: `typeof null === 'object'`, and `typeof` can't tell plain objects, arrays, `Date` and class instances apart. Check `x !== null` before using `in` on an `object`.
- `instanceof` for classes. It doesn't work with interfaces or type aliases: they are erased, so there is nothing to check at runtime.
- `in` (`'items' in x`) or a discriminant field for plain object shapes. On a union, `in` keeps only the members that have that key. On `unknown` it only works once you've proven "non-null object" (`typeof x === 'object' && x !== null`, else TS18046), and then it adds the key as `unknown` (`x: object & Record<'message', unknown>`, TS 4.9+), so check the value's type too. `in` checks the key exists, not its type.
- Equality, truthiness, and `Array.isArray`.
- **Elimination**: after `if (...) return`, that member is removed, so the last line sees only what's left.

```ts
function getErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && e !== null && 'message' in e && typeof e.message === 'string') return e.message;
  return 'Unknown error';
}
```

### Type guards and assertion functions

A type guard is just a normal function that does runtime checks and returns a boolean, plus a special return type that tells TS what `true` means. It packages a narrowing check under a name so you can reuse it.

```ts
type User = { id: string; name: string };
function isUser(x: unknown): x is User {          // "if I return true, x is a User"
  return typeof x === 'object' && x !== null &&
    'id' in x && typeof x.id === 'string' &&
    'name' in x && typeof x.name === 'string';
}
if (isUser(data)) data.name;   // User here; outside the if, still unknown
```

- **User-defined type guard** `x is User` as the return type: when it returns `true`, the value is narrowed in `if` branches (and in the `else` branch the guarded type is removed from a union), and in `.filter(isUser)`.
- **Assertion function** `function assertIsUser(x: unknown): asserts x is User` returns nothing and throws on failure; everything **after the call** is narrowed. It fits "validate or fail" code. (`asserts cond` without `is` narrows on a boolean condition.)
- The compiler **trusts** the predicate completely. A guard that checks less than it claims (only `'id' in x`, or forgetting `null`) is a real bug the types won't catch. Keep guards small and tested, or derive them from a schema (§13).
- TS 5.5 **infers type predicates**: `arr.filter(x => x !== undefined)` now narrows to `T[]`.

Drills: [ts-03](../practice/live-coding/01-typescript.md#ts-03), [ts-17](../practice/live-coding/01-typescript.md#ts-17).

---

## 4. Discriminated unions + exhaustiveness

A **discriminated union** is a union of object types that share one literal field (the discriminant, e.g. `status` or `kind`). Checking that field narrows to one member. Model state machines (orders, payments, chat-bot flows) so that impossible combinations can't type-check:

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

Once every case is handled, the type left in `default` is `never`, so passing it to `assertNever` compiles. A forgotten case leaves a real type there and becomes a compile error. `assertNever` also throws at runtime, which protects you when outside data brings a new variant. (Without it, an explicit return type plus `strict` also catches a missing case, because the function could fall through and return `undefined`.)

Compare this to `{ status: string; settledAt?: Date; txId?: string; reason?: string }`, which permits 2^n nonsense states. `Extract<Payment, { status: 'failed' }>` picks one member out of the union. Drill: [ts-04](../practice/live-coding/01-typescript.md#ts-04).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`OrderStatus`](../../packages/backend/libs/domains/orders/domain/order-state.ts#L12): `OrderStatus` in order-state.ts is a union of the valid order states used as the discriminant. _(order-state.ts)_
> - [`canTransition`](../../packages/backend/libs/domains/orders/domain/order-state.ts#L49): `canTransition` checks whether a command is allowed from the current order status, implementing the state machine. _(order-state.ts)_
> - [Payment status values](../../docs/humans/concepts/domain-payments/payment-status.md): The payment status page lists the six states (PENDING, COMPLETED, FAILED, CANCELLED, REFUNDED, UNKNOWN) as a closed set. [`PaymentStatus`](../../packages/backend/libs/domains/payments/infra/models/payment.model.ts#L33)
<!-- theory-links:end -->

### Result type: failures in the return type

`throw` doesn't appear in TS signatures (there are no checked exceptions), so callers easily forget a `try/catch`. A `Result` is a discriminated union that puts the failure into the return type:

```ts
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
function parseAge(s: string): Result<number, 'NOT_A_NUMBER' | 'OUT_OF_RANGE'> { /* ... */ }
```

The caller must check `ok` before reading `value`, and `E` lists exactly what can go wrong. To chain steps, write `flatMap`/`andThen`: `r.ok ? fn(r.value) : r`; the error type becomes the union of every step's errors. Use Results for expected, recoverable failures (validation, not found) and keep exceptions for bugs. Drill: [ts-19](../practice/live-coding/01-typescript.md#ts-19).

---

## 5. Deriving types from values: `typeof`, `keyof`, indexed access, `as const`, `satisfies`

Write the runtime value once and derive the types from it, so they can't drift apart:

- `typeof value` (in a type position) gives the type of a value.
- `keyof T` gives the union of `T`'s keys.
- **Indexed access** `T['a']['b']` gives the type of a property; `T[number]` gives the element type of an array or tuple.

```ts
const config = { server: { host: 'localhost', port: 3000 }, logLevel: 'info' };
type Config = typeof config;
type ConfigKey = keyof Config;               // 'server' | 'logLevel'
type Port = Config['server']['port'];        // number
type Level = Config['logLevel'];             // string, not 'info': object properties are widened
```

**Widening**: properties of an object literal are mutable, so `'info'` widens to `string`. `as const` (or `satisfies` with a literal union) keeps the literal.

```ts
const config = {
  port: 3000,
  db: { url: process.env.DB_URL! },
} satisfies AppConfig;         // validates against AppConfig but KEEPS the literal types
// vs `const config: AppConfig = ...` which widens to AppConfig.

const ROLES = ['admin', 'finance', 'viewer'] as const;
type Role = typeof ROLES[number]; // 'admin' | 'finance' | 'viewer'

const STATUS = { active: 1, banned: 2 } as const;
type StatusCode = (typeof STATUS)[keyof typeof STATUS]; // 1 | 2
```

- `as const` makes everything `readonly` and literal; an array becomes a readonly tuple.
- A **type annotation** replaces the inferred type with the declared one (with `Record<string, Route>` any key is allowed and literals are lost). **`satisfies`** checks the value, including excess properties, but keeps the inferred type. Combine them: `{...} as const satisfies Record<string, Route>`.
- **Trap**: `ROLES.includes(value)` doesn't compile when `value: string`, because the tuple's `includes` only accepts `Role`. Widen the array, not the value: `(ROLES as readonly string[]).includes(value)`. That is the body of an `isRole` type guard.

Prefer `as const` objects or union literals over `enum`. Enums emit runtime code, numeric enums accept any number, and enums aren't "erasable syntax" (see §15).

Drills: [ts-06](../practice/live-coding/01-typescript.md#ts-06), [ts-14](../practice/live-coding/01-typescript.md#ts-14), [ts-15](../practice/live-coding/01-typescript.md#ts-15).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`SHOP_PERMISSIONS`](../../packages/backend/libs/domains/tenancy/domain/permissions.ts#L8): `SHOP_PERMISSIONS` is a const array of permission strings, used as a literal-union source instead of an enum. _(permissions.ts)_
> - [`WEBHOOK_EVENT_TYPES`](../../packages/backend/libs/domains/developer-platform/domain/webhook-events.ts#L2): `WEBHOOK_EVENT_TYPES` is a const array of allowed webhook events, the `as const` pattern. _(webhook-events.ts)_
<!-- theory-links:end -->

---

## 6. Generics done right

```ts
// constraint + keyof + indexed access
function pluck<T, K extends keyof T>(items: readonly T[], key: K): T[K][] {
  return items.map(i => i[key]);
}

// const type parameter (TS 5.0): infer literal types
function routes<const T extends readonly string[]>(r: T) { return r; }
const r = routes(['/a', '/b']); // readonly ['/a', '/b'] not string[]

// NoInfer (TS 5.4): stop inference from a specific position
function createFSM<S extends string>(states: S[], initial: NoInfer<S>) {}
createFSM(['idle', 'run'], 'jump'); // error, without NoInfer 'jump' would widen S
```

- `K extends keyof T` limits the key to real keys, and because `K` is its own type parameter it's inferred as a **literal** (`'name'`), so `T[K]` is the exact property type. If the key is only typed `keyof T`, you get `T[keyof T]`, the union of all property types.
- Rule of thumb: a type parameter should appear **at least twice**, linking inputs to outputs. If it appears only once, replace it with a concrete type or `unknown`.

### Pattern: a map type as the single source of truth

Put the "name → type" mapping in one interface and let a constrained generic look it up. This gives autocomplete on the name and a precise type for what goes with it.

```ts
// typed event emitter
on<K extends keyof Events>(event: K, listener: (payload: Events[K]) => void): () => void;
emit<K extends keyof Events>(event: K, payload: Events[K]): void;

// typed API client
get<P extends keyof Endpoints>(path: P): Promise<Endpoints[P]>;
```

- For storage, a mapped type keeps the link per key: `{ [K in keyof Events]?: Set<Listener<Events[K]>> }`.
- `fetchJson<T>(url): Promise<T>`, where the caller picks `T`, is a cast in disguise: any caller can claim any type for any URL. The endpoint map ties types to paths, but `res.json()` is still unchecked, so validate the response at the boundary (§13).
- `@types/node` 20+ types Node's own emitter this way: `new EventEmitter<{ login: [userId: string] }>()`, where each event maps to a tuple of listener arguments.

Drills: [ts-05](../practice/live-coding/01-typescript.md#ts-05), [ts-20](../practice/live-coding/01-typescript.md#ts-20), [ts-23](../practice/live-coding/01-typescript.md#ts-23).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`JobHandlerFn`](../../packages/backend/libs/infrastructure/jobs/job-types.ts#L50): `JobHandlerFn<T>` is generic on the job type and links the payload type `JobPayloads[T]` to the handler input. _(job-types.ts)_
<!-- theory-links:end -->

---

## 7. Function overloads

Overloads let one function have several call signatures, where the return type depends on the argument type:

```ts
function getUser(id: string): User | undefined;
function getUser(ids: string[]): User[];
function getUser(idOrIds: string | string[]): User | undefined | User[] { /* implementation */ }
```

- Callers see only the overload signatures. The implementation signature is hidden and must be compatible with all of them.
- TS picks the **first** overload that matches, so put specific signatures first.
- Overloads don't combine: an argument typed `string | string[]` matches neither of the two above. Add a third overload for the union if callers need it.
- Alternative: one generic signature with a conditional return type (`T extends string ? User | undefined : User[]`). The implementation then needs casts, which is why overloads are often simpler. If the return type doesn't depend on the input, use a plain union parameter instead.
- Libraries type `pipe` (fp-ts, RxJS, lodash) with one overload per arity, each adding a type parameter per step, because TS infers them left to right and contextually types untyped lambdas (`(s) => s.trim()`). A recursive conditional type can validate a tuple of functions but loses that lambda inference.

Drills: [ts-16](../practice/live-coding/01-typescript.md#ts-16), [ts-49](../practice/live-coding/01-typescript.md#ts-49).

---

## 8. Readonly arrays and tuples

- `readonly T[]` (same as `ReadonlyArray<T>`) has no mutating methods (`push`, `sort`, `splice`). A mutable array is assignable to it, but not the other way round, so accept `readonly T[]` in parameters you don't mutate. Common surprise: an `as const` tuple is rejected by a `number[]` parameter.
- `readonly` is compile-time only. `Object.freeze` is the runtime counterpart (shallow).
- A **tuple** is an array with a fixed length and a type per position: `[string, number]`. Elements can be labeled (`[get: () => T, set: (v: T) => void]`), which documents a `useState`-like return value. `T['length']` is a literal (`2`).
- **Variadic tuple types** spread tuples inside tuples: `[...A, ...B]`. With `A extends unknown[]` you can capture a function's whole parameter list and reuse it, which is how you type wrappers (`debounce`, `memoize`, `once`) and partial application:

```ts
type Head<T extends readonly unknown[]> = T extends readonly [infer H, ...unknown[]] ? H : undefined;

function myBind<T, A extends unknown[], B extends unknown[], R>(
  fn: (this: T, ...args: [...A, ...B]) => R, thisArg: T, ...bound: A
): (...args: B) => R;                         // returned function takes only the remaining params
```

Drills: [ts-22](../practice/live-coding/01-typescript.md#ts-22), [ts-31](../practice/live-coding/01-typescript.md#ts-31), [ts-47](../practice/live-coding/01-typescript.md#ts-47).

---

## 9. Dictionaries: `Record`, index signatures, `Map`

- `Record<string, number>` is the same as the **index signature** `{ [key: string]: number }`. TS assumes **every** key exists: `counts['dog']` is typed `number` but is `undefined` at runtime. `noUncheckedIndexedAccess` (§15) makes it `number | undefined`.
- `Record<'math' | 'english', number>` with a literal key union **requires** every key. `Partial<Record<K, V>>` is the honest type when only some keys will be present (e.g. the result of `groupBy`).
- A plain object inherits keys like `toString` and `constructor`, so `key in obj` lies for user-provided keys. Use `Object.hasOwn(obj, key)`, an `Object.create(null)` object, or a `Map`.
- Prefer a `Map` when keys are dynamic or user-provided, when you add and remove often, or when keys aren't strings: no inherited keys, insertion order, `.size`.

Drill: [ts-21](../practice/live-coding/01-typescript.md#ts-21).

---

## 10. Conditional, mapped and template-literal types

### Conditional types and `infer`

`A extends B ? X : Y` is an if/else on types. **`infer`** declares a type variable inside the `extends` pattern; if the match succeeds, TS fills it in.

```ts
type Awaited2<T> = T extends PromiseLike<infer U> ? Awaited2<U> : T;   // recursive: unwraps nested promises
type ElementOf<T> = T extends readonly (infer E)[] ? E : never;
type MyReturnType<F> = F extends (...args: any[]) => infer R ? R : never;
type MyParameters<F> = F extends (...args: infer P) => any ? P : never; // labeled tuple [a: number, b: number]
```

The `any[]` in the function pattern is deliberate: with `unknown[]`, `(a: number) => void` wouldn't match, because parameters are checked contravariantly (§11). `never[]` also works. Drills: [ts-10](../practice/live-coding/01-typescript.md#ts-10), [ts-11](../practice/live-coding/01-typescript.md#ts-11).

### Distributive conditional types

When the checked type is a **naked type parameter**, the conditional runs once per union member and unions the results. That's how `Exclude` and `Extract` filter unions: members mapped to `never` disappear. Wrapping both sides in a tuple `[T]` turns distribution off.

```ts
type ToArray<T> = T extends any ? T[] : never;
type A = ToArray<string | number>;           // string[] | number[]
type NoDistrib<T> = [T] extends [any] ? T[] : never;
type B = NoDistrib<string | number>;         // (string | number)[]

type IsNever<T> = [T] extends [never] ? true : false;
```

**`never` trap**: `never` is the empty union, so a distributive `T extends never ? true : false` runs zero times and returns `never`, not `true`. That's why `IsNever` must use the tuple form. Drill: [ts-12](../practice/live-coding/01-typescript.md#ts-12).

### Mapped types and modifiers

A mapped type `{ [K in keyof T]: ... }` loops over keys. Modifiers can be added (`?`, `readonly`) or removed (`-?`, `-readonly`).

```ts
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MyRecord<K extends PropertyKey, V> = { [P in K]: V };   // only string | number | symbol can be keys
```

A mapped type over `keyof T` is **homomorphic**: it keeps `T`'s existing `?`/`readonly` modifiers, and applied to an array or tuple it produces an array or tuple (`{ readonly [K in keyof T]: T[K] }` on `string[]` gives `readonly string[]`). `Record` maps over an arbitrary key union instead. Drill: [ts-07](../practice/live-coding/01-typescript.md#ts-07).

### Key remapping with `as`

An `as` clause renames each key. Remapping a key to `never` drops it.

```ts
type MyOmit<T, K extends PropertyKey> = { [P in keyof T as P extends K ? never : P]: T[P] };
type Getters<T> = { [K in keyof T & string as `get${Capitalize<K>}`]: () => T[K] };
```

`keyof T & string` drops number and symbol keys, which can't go inside a template literal. The built-in `Omit<T, K>` accepts any key (`K extends keyof any`), so a typo in `K` isn't caught; your own helper can constrain `K extends keyof T`. Drills: [ts-08](../practice/live-coding/01-typescript.md#ts-08), [ts-13](../practice/live-coding/01-typescript.md#ts-13).

### Template literal types

Template literal types build and parse string types. Intrinsics `Capitalize`, `Uncapitalize`, `Uppercase`, `Lowercase` change case. In `` `${infer Head}_${infer Tail}` `` the first placeholder matches as little as possible, so the string is split at the **first** `_`; recursing on `Tail` handles the rest.

```ts
type SnakeToCamel<S extends string> =
  S extends `${infer Head}_${infer Tail}` ? `${Head}${Capitalize<SnakeToCamel<Tail>>}` : S;

type Params<P extends string> =
  P extends `${string}:${infer Param}/${infer Rest}` ? Param | Params<Rest>
  : P extends `${string}:${infer Param}` ? Param : never;
type X = Params<'/users/:userId/orders/:orderId'>; // 'userId' | 'orderId'

// all dot-paths: map each key to its paths, then index with [keyof T & string] to collect them into one union
type Paths<T> = T extends object
  ? { [K in keyof T & string]: T[K] extends object ? K | `${K}.${Paths<T[K]>}` : K }[keyof T & string]
  : never;   // Paths<{ a: { b: number }; c: string }> = 'a' | 'a.b' | 'c'
```

Form libraries (`register('address.city')`), i18n keys and config getters use this for autocomplete. TS can't follow runtime string building (`replace`, concatenation), so the runtime helper needs one cast to the computed type. Drills: [ts-25](../practice/live-coding/01-typescript.md#ts-25), [ts-26](../practice/live-coding/01-typescript.md#ts-26).

### Recursive types

A recursive conditional type chooses a branch per kind of value and calls itself on the parts:

```ts
type DeepReadonly<T> =
  T extends (...args: never[]) => unknown ? T              // keep functions (mapping one gives {})
  : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> }   // arrays become readonly arrays
  : T;                                                     // primitives stop the recursion
type RequiredDeep<T> = { [K in keyof T]-?: T[K] extends object ? RequiredDeep<T[K]> : T[K] };
```

- `Date`, `Map` and class instances are objects too, so their methods get mapped. Add a branch like `T extends Date ? T : ...` to keep them as they are.
- TS has recursion depth limits; very deep or self-referencing types (e.g. `Paths` on a recursive type) hit them, so libraries add a depth counter.
- Types don't exist at runtime: `DeepReadonly` needs a matching `deepFreeze` that calls `Object.freeze` on every level.

Drill: [ts-09](../practice/live-coding/01-typescript.md#ts-09).

### Built-in utility types

**Be able to implement them on a whiteboard:**

```ts
type MyPick<T, K extends keyof T> = { [P in K]: T[P] };
type MyOmit<T, K extends PropertyKey> = MyPick<T, Exclude<keyof T, K>>;
type MyExclude<T, U> = T extends U ? never : T;
type MyExtract<T, U> = T extends U ? T : never;
type MyNonNullable<T> = T extends null | undefined ? never : T;
type MyPartial<T> = { [K in keyof T]?: T[K] };
type MyRequired<T> = { [K in keyof T]-?: T[K] };
type MyReadonly<T> = { readonly [K in keyof T]: T[K] };   // shallow
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`JobType`](../../packages/backend/libs/infrastructure/jobs/job-types.ts#L17): `JobType` is a type derived from the keys of `JobPayloads` with `keyof`, a type-level mapping. _(job-types.ts)_
<!-- theory-links:end -->

---

## 11. Variance

- Function **parameters** are contravariant and **return types** are covariant.
- Under `strictFunctionTypes`, **method** shorthand parameters stay *bivariant* for historical reasons, while function-property syntax is checked contravariantly:
  ```ts
  interface A { m(x: Dog): void }      // bivariant (unsound)
  interface B { m: (x: Dog) => void }  // contravariant (sound)
  ```
- Arrays are covariant, which is unsound: `const animals: Animal[] = dogs; animals.push(cat);` compiles.
- Explicit variance annotations `in`/`out` on type parameters (TS 4.7) help with performance and documentation.

---

## 12. Type tests: `Equal` and `Expect`

Type-level code needs tests too. The common helpers (from type-challenges):

```ts
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type cases = [Expect<Equal<MyPick<User, 'id'>, { id: number }>>];   // compile error if not equal
```

- `Equal` compares two deferred generic conditionals, which TS only treats as identical when `A` and `B` are the same type. A naive "mutually assignable" check (`[A] extends [B]` both ways) says `any` equals `string`; `Equal` doesn't.
- `// @ts-expect-error` on the line above a statement asserts that it **doesn't** compile (and fails if it does). Use it to test that bad calls are rejected.
- Libraries ship these as `expectTypeOf` (Vitest) or `tsd`.

---

## 13. Runtime validation at boundaries

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

**How a schema library works** (you may be asked to build a mini version):
- A schema is an object with `parse(value: unknown)` that returns a typed result. Its output type is carried in the schema type: `type Schema<T> = { parse(v: unknown): Result<T, string[]> }`.
- `type Infer<S> = S extends Schema<infer T> ? T : never` pulls the type back out, so type and check come from one definition.
- **Combinators** (`object`, `array`, `optional`) build big schemas from small ones; `object(shape)` maps the shape through `Infer`: `{ [K in keyof Shape]: Infer<Shape[K]> }`.
- Pass the path down and **collect** errors instead of stopping at the first, which gives useful 400 responses (`tags[1]: expected string, got number`).
- Copy only declared keys into the output. This strips unknown fields (mass-assignment protection).
- Edge cases: `typeof NaN === 'number'`, `typeof null === 'object'`, arrays are objects.

In NestJS, `class-validator` with `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` plays the same role and also **blocks mass assignment**.

Validate env at startup (`z.object({...}).parse(process.env)`) so the process fails fast instead of crashing at 3 a.m.

Drill: [ts-50](../practice/live-coding/01-typescript.md#ts-50).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`defineEvent`](../../packages/backend/libs/infrastructure/events/define-event.ts#L24): `defineEvent` builds a typed event with a Zod schema that validates the payload at runtime. _(define-event.ts)_
> - [`CatalogRow`](../../packages/backend/libs/domains/catalog-sync/domain/rows.ts#L8): `CatalogRow` is a Zod schema that validates catalog sync rows at the boundary. _(rows.ts)_
> - [`CreateShopDto`](../../packages/backend/libs/domains/tenancy/api/tenancy.dto.ts#L5): `CreateShopDto` is a class-validator DTO that validates the HTTP request body. _(tenancy.dto.ts)_
<!-- theory-links:end -->

---

## 14. `type` vs `interface`, declaration merging and module augmentation

- **Type alias**: `type Name = <any type>` gives a name to a type. It creates no new type, just a label (`type Id = string | number`).
- **Intersection** `A & B`: a value must satisfy both, so it has all members of A plus all of B (`type AdminT = UserT & { role: 'admin' }`). It's the opposite of a union `A | B`, which is "one or the other".

Both describe object shapes and are mostly interchangeable. The differences:

| | `interface` | `type` alias |
|---|---|---|
| Can name | object shapes (and function/class shapes) | any type: unions, tuples, primitives, mapped and conditional types |
| Reopen / merge | **yes**: two declarations with the same name merge | no: a duplicate name is an error |
| Extend | `extends`; a conflicting member is an **error** | `&` intersection; a conflicting member silently becomes `never` |

**Declaration merging**: declaring `interface User` twice in one scope combines the members. That's how you augment library types (below). The risk is the same feature: two unrelated interfaces with one name merge silently.

```ts
// Module augmentation: add `user` to Express Request
declare global {
  namespace Express { interface Request { user?: AuthUser; requestId: string } }
}
export {};
```

Common rule: `interface` for public object contracts that may be extended; `type` for unions and computed types. Drill: [ts-02](../practice/live-coding/01-typescript.md#ts-02).

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`JobPayloads`](../../packages/backend/libs/infrastructure/jobs/job-types.ts#L11): `JobPayloads` is an interface that domains augment through declaration merging, so there is no central list of jobs. _(job-types.ts)_
<!-- theory-links:end -->

---

## 15. tsconfig flags a senior should have opinions on

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

## 16. Type-level performance and maintainability

- Deeply recursive conditional types slow the compiler down and produce unreadable errors. Prefer simple types plus runtime validation.
- Use `interface` for object shapes that get extended: interfaces are cached by name and give better error messages. Use `type` for unions and compositions.
- Large monorepos: project references (`composite`, `tsc -b`). The **native TS compiler (TypeScript 7, Go port)** promises roughly 10× faster type checking, so it's worth knowing that it exists.

---

## Interview Q&A

**Q: `interface` vs `type`?**
They're mostly interchangeable. Interfaces support declaration merging, are better for extensible object shapes and public APIs, and give faster checking and nicer errors. Use types for unions, mapped and conditional types, and tuples.

**Q: `any` vs `unknown` vs `never`?**
`unknown` accepts any value but forces you to narrow before use. `any` turns checking off and spreads. `never` has no values: it's the type of functions that always throw, of the leftover after exhaustive narrowing, and the way to drop members in conditional and mapped types.

**Q: How do you make sure a `switch` handles all cases?**
Use a discriminated union with a `default` branch that assigns to `never` (`assertNever`). Adding a variant then becomes a compile error at every switch that's missing it.

**Q: The API returns JSON. Is casting it to `User` enough?**
No. `as` is an unchecked assertion. Parse it with a schema (zod, valibot, class-validator), derive the TS type from the schema, and fail loudly at the boundary.

**Q: How would you stop someone from passing a `userId` where an `orderId` is expected?**
Branded types, created through a single constructor or validation function.

**Q: Type guard vs assertion function?**
A guard returns a boolean (`x is T`) and narrows inside `if` and `.filter`. An assertion function (`asserts x is T`) throws on failure and narrows everything after the call. The compiler trusts both blindly, so the check must really match the type.

**Q: `satisfies` vs a type annotation?**
An annotation replaces the inferred type with the declared one, widening literals and keys. `satisfies` checks the value against the type but keeps the precise inferred type.

**Q: Why does an object literal with an extra key fail, but the same object from a variable passes?**
Excess property checks apply only to fresh object literals, where extra keys are usually typos. Otherwise TS is structural: having more properties than required is fine.

**Q: Why does `T extends never ? true : false` return `never` for `never`?**
A conditional on a naked type parameter distributes over unions, and `never` is the empty union, so it runs zero times. Wrap both sides in a tuple: `[T] extends [never]`.

**Q: When do you use overloads?**
When the return type depends on which argument type was passed. Put specific signatures first, and remember a union argument matches no single overload. If the return type doesn't depend on the input, use a union parameter.

**Q: Why return a `Result` instead of throwing?**
Exceptions are invisible in TS signatures, so callers forget to handle them. A `Result` union makes the caller check `ok` and lists the possible errors. Use it for expected failures; keep exceptions for bugs.

**Q: What's wrong with `Record<string, number>` for counts?**
TS assumes every key exists, so a missing key is typed `number` but is `undefined`. Turn on `noUncheckedIndexedAccess`, and use `Object.hasOwn` or a `Map` for user-provided keys.
