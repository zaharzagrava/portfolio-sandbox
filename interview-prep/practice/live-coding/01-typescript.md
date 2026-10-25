# TypeScript live-coding drills

50 problems most likely to come up in Full Stack Node.js live-coding rounds. Try each one before opening the solution. Every solution was run against the tests shown.

Difficulty: Easy 21 · Medium 22 · Hard 7

## Index

| # | Problem | Topic | Level |
|---|---|---|---|
| ts-01 | [Safely read an error message from unknown](#ts-01) | any vs unknown vs never | Easy |
| ts-02 | [type vs interface: merging and extending](#ts-02) | type vs interface | Easy |
| ts-03 | [Narrow a union with typeof, instanceof and in](#ts-03) | Union narrowing | Easy |
| ts-04 | [Exhaustive switch over a discriminated union](#ts-04) | Discriminated unions | Easy |
| ts-05 | [getProperty<T, K extends keyof T>](#ts-05) | Generics with constraints | Easy |
| ts-06 | [Derive types from a runtime config object](#ts-06) | keyof / typeof / indexed access | Easy |
| ts-07 | [Implement MyPartial, MyRequired, MyReadonly, MyRecord](#ts-07) | Mapped types | Easy |
| ts-08 | [Implement MyPick and MyOmit (types and runtime)](#ts-08) | Mapped types | Medium |
| ts-09 | [DeepPartial and DeepReadonly](#ts-09) | Recursive types | Medium |
| ts-10 | [MyReturnType and MyParameters with infer](#ts-10) | infer | Medium |
| ts-11 | [MyAwaited and a typed Promise.all for objects](#ts-11) | infer | Medium |
| ts-12 | [Distributive conditional types: Exclude, Extract, IsNever, IsUnion](#ts-12) | Conditional types | Hard |
| ts-13 | [Generate getters with key remapping](#ts-13) | Key remapping + template literals | Medium |
| ts-14 | [Derive a union from a const array (enum alternative)](#ts-14) | as const | Easy |
| ts-15 | [satisfies vs type annotation](#ts-15) | satisfies | Easy |
| ts-16 | [Overloads: one id or many ids](#ts-16) | Function overloads | Medium |
| ts-17 | [Type guard and assertion function](#ts-17) | Type guards | Easy |
| ts-18 | [Branded IDs: UserId vs OrderId](#ts-18) | Branded types | Medium |
| ts-19 | [Result<T, E> instead of throwing](#ts-19) | Result type | Medium |
| ts-20 | [Typed fetch wrapper with an endpoint map](#ts-20) | Typed API client | Medium |
| ts-21 | [Word counts: Record, index signatures and missing keys](#ts-21) | Record vs index signature | Easy |
| ts-22 | [Readonly arrays, tuple types and a useState-like tuple](#ts-22) | Readonly arrays and tuples | Medium |
| ts-23 | [Typed event emitter: on<K extends keyof Events>](#ts-23) | Typed event emitter | Hard |
| ts-24 | [Which lines compile? Structural typing and excess property checks](#ts-24) | Structural typing | Easy |
| ts-25 | [Typed dot-paths: Paths<T> and PathValue<T, P>](#ts-25) | Template literal types | Hard |
| ts-26 | [Type-level snake_case to camelCase keys](#ts-26) | Template literal types | Hard |
| ts-27 | [Counter factory with private state](#ts-27) | Closures | Easy |
| ts-28 | [Implement once()](#ts-28) | Closures | Easy |
| ts-29 | [Output puzzle: closures in a var vs let loop](#ts-29) | Closures | Easy |
| ts-30 | [Output puzzle: this with methods, call, bind and arrows](#ts-30) | this binding | Medium |
| ts-31 | [Implement bind (myBind) with partial application](#ts-31) | this binding | Medium |
| ts-32 | [Output puzzle: ==, ===, NaN and Object.is](#ts-32) | Equality | Easy |
| ts-33 | [Output puzzle: hoisting and the temporal dead zone](#ts-33) | Hoisting and TDZ | Easy |
| ts-34 | [Implement map, filter and reduce](#ts-34) | Array methods | Easy |
| ts-35 | [Typed groupBy](#ts-35) | Array utilities | Easy |
| ts-36 | [Chunk an array](#ts-36) | Array utilities | Easy |
| ts-37 | [Remove duplicates by key](#ts-37) | Array utilities | Easy |
| ts-38 | [Flatten a nested array to a given depth](#ts-38) | Recursion | Medium |
| ts-39 | [Flatten a nested object to dot paths](#ts-39) | Recursion | Medium |
| ts-40 | [Get a value by path with a default (lodash.get)](#ts-40) | Object utilities | Medium |
| ts-41 | [Deep clone (and why JSON cloning breaks)](#ts-41) | Deep clone | Hard |
| ts-42 | [Deep equality check](#ts-42) | Deep equal | Medium |
| ts-43 | [Deep merge config objects safely](#ts-43) | Deep merge | Medium |
| ts-44 | [Diff two objects: added, removed, changed](#ts-44) | Object diff | Medium |
| ts-45 | [Convert API payload keys: snake_case <-> camelCase](#ts-45) | Data transformation | Medium |
| ts-46 | [Parse a query string into an object](#ts-46) | Parsing | Medium |
| ts-47 | [Typed debounce with cancel and flush](#ts-47) | Closures + timers | Medium |
| ts-48 | [Memoize with a cache key](#ts-48) | Memoization | Medium |
| ts-49 | [Typed pipe and compose](#ts-49) | Function composition | Hard |
| ts-50 | [Mini zod: validate unknown JSON into a typed object](#ts-50) | Runtime validation | Hard |

---

<a id="ts-01"></a>
### ts-01. Safely read an error message from unknown

*any vs unknown vs never · Easy*

In a `catch (e)` block, `e` is `unknown` (with `strict`). Write `getErrorMessage(err: unknown): string` without using `any` or type assertions:

- an `Error` instance -> its `message`
- a string -> the string itself
- an object with a string `message` property -> that message
- anything else -> `'Unknown error'`

```ts
getErrorMessage(new Error('boom'))   // 'boom'
getErrorMessage({ message: 'api' })  // 'api'
getErrorMessage(42)                  // 'Unknown error'
```

Also be ready to explain how `any`, `unknown` and `never` differ.

**Starter**

```ts
function getErrorMessage(err: unknown): string {
  // TODO: narrow `err` step by step
}
```

<details>
<summary>Solution</summary>

```ts
function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    typeof err.message === 'string'
  ) {
    return err.message;
  }
  return 'Unknown error';
}
```

**Why it works.** `unknown` is the type-safe top type: you can assign anything to it, but you must narrow it (typeof, instanceof, `in`) before you use it. `any` switches type checking off in both directions, so mistakes spread silently. `never` is the bottom type: no value has it, which is why it shows up in exhaustive checks and in functions that always throw. The trap is `typeof x === 'object'`, which is also true for `null`, so check `x !== null` before using `in`.

**Say it.** I treat the caught value as unknown and narrow it from most specific to least: Error instance, then string, then any object that has a string message, with a safe fallback.

**Follow-up.** Q: Why not just write `catch (e: any)`? A: `any` lets you write `e.message.toUpperCase()` with no checks, and that crashes at runtime if someone throws a string or `null`. `unknown` forces you to handle those cases.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


assert.equal(getErrorMessage(new Error('boom')), 'boom');
assert.equal(getErrorMessage('oops'), 'oops');
assert.equal(getErrorMessage({ message: 'from api' }), 'from api');
assert.equal(getErrorMessage({ message: 42 }), 'Unknown error');
assert.equal(getErrorMessage(null), 'Unknown error');

type cases = [Expect<Equal<ReturnType<typeof getErrorMessage>, string>>];

const u: unknown = 'text';
// @ts-expect-error unknown must be narrowed before you call methods on it
u.toUpperCase();
const a: any = 'text';
a.toUpperCase(); // compiles: any disables checking
```

</details>

</details>

---

<a id="ts-02"></a>
### ts-02. type vs interface: merging and extending

*type vs interface · Easy*

Show the practical differences between `type` and `interface`:

1. Declare `interface User { id: string }`, then add `email: string` to it in a **second** declaration (declaration merging).
2. Declare `interface Admin extends User` with `role: 'admin'`.
3. Write the same shapes with type aliases: `UserT` and `AdminT` (use an intersection).
4. Declare `type Id = string | number` (something an interface cannot express).
5. Implement `makeAdmin(user: User): Admin`.

```ts
makeAdmin({ id: '1', email: 'a@b.c' }) // { id: '1', email: 'a@b.c', role: 'admin' }
```

**Starter**

```ts
interface User {
  id: string;
}
// TODO: merge `email`, then Admin, UserT, AdminT, Id, makeAdmin
```

<details>
<summary>Solution</summary>

```ts
interface User {
  id: string;
}
// Second declaration with the same name merges into the first.
interface User {
  email: string;
}

interface Admin extends User {
  role: 'admin';
}

type UserT = { id: string; email: string };
type AdminT = UserT & { role: 'admin' };

type Id = string | number;

function makeAdmin(user: User): Admin {
  return { ...user, role: 'admin' };
}
```

**Why it works.** Both describe object shapes and are mostly interchangeable. Interfaces can be reopened (declaration merging, used to augment library types like Express `Request`) and use `extends`, which reports conflicting members as errors. Type aliases cannot be reopened but can name any type: unions, tuples, primitives, mapped and conditional types. A common rule: use `interface` for public object contracts you may extend, `type` for unions and computed types. The trap is accidental merging: two interfaces with the same name in one scope silently combine.

**Say it.** Interfaces can be reopened and extended, which is useful for augmenting library types; type aliases are closed but can express unions, tuples and mapped or conditional types.

**Follow-up.** Q: How would you add a `user` property to Express's `Request`? A: Use module augmentation: `declare global { namespace Express { interface Request { user?: User } } }`. This works only because interfaces merge.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type cases = [
  Expect<Equal<keyof User, 'id' | 'email'>>,
  Expect<Equal<Admin['role'], 'admin'>>,
  Expect<Mutual<Admin, AdminT>>,
  Expect<Equal<Id, string | number>>,
];

// @ts-expect-error email was merged into User, so it is required
const incomplete: User = { id: '1' };

assert.deepEqual(makeAdmin({ id: '1', email: 'a@b.c' }), { id: '1', email: 'a@b.c', role: 'admin' });
const t: AdminT = makeAdmin({ id: '2', email: 'x@y.z' });
assert.equal(t.role, 'admin');
```

</details>

</details>

---

<a id="ts-03"></a>
### ts-03. Narrow a union with typeof, instanceof and in

*Union narrowing · Easy*

Implement `describe(input)` where `input` is `string | number | Date | ApiError | { items: unknown[] }`:

- string -> `'string(<length>)'`
- number -> `'number(<value with 2 decimals>)'`
- Date -> `'date(<YYYY-MM-DD>)'` (UTC)
- `ApiError` -> `'error(<status>)'`
- `{ items }` -> `'list(<items.length>)'`

```ts
describe('hey')                         // 'string(3)'
describe(3.14159)                       // 'number(3.14)'
describe(new ApiError('Not found', 404)) // 'error(404)'
describe({ items: [1, 2] })             // 'list(2)'
```

**Starter**

```ts
class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Input = string | number | Date | ApiError | { items: unknown[] };

function describe(input: Input): string {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Input = string | number | Date | ApiError | { items: unknown[] };

function describe(input: Input): string {
  if (typeof input === 'string') return `string(${input.length})`;
  if (typeof input === 'number') return `number(${input.toFixed(2)})`;
  if (input instanceof Date) return `date(${input.toISOString().slice(0, 10)})`;
  if (input instanceof ApiError) return `error(${input.status})`;
  // Only { items } is left here.
  return `list(${input.items.length})`;
}
```

**Why it works.** Use the narrowing tool that fits each member: `typeof` for primitives, `instanceof` for classes, and the `in` operator (or a discriminant field) for plain object shapes, since interfaces do not exist at runtime. After each `return`, TypeScript removes that member from the union, so the last line sees only `{ items: unknown[] }`. The trap: `typeof x === 'object'` cannot tell Date, arrays, class instances and `null` apart.

**Say it.** I narrow primitives with typeof, class instances with instanceof, and whatever is left is the plain object, which TypeScript already knows by elimination.

**Follow-up.** Q: Why can't you use `instanceof` with an interface? A: Interfaces are erased at compile time, so there is nothing to check at runtime. Use `in`, a discriminant property, or a user-defined type guard instead.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


assert.equal(describe('hey'), 'string(3)');
assert.equal(describe(3.14159), 'number(3.14)');
assert.equal(describe(new Date(Date.UTC(2024, 0, 15))), 'date(2024-01-15)');
assert.equal(describe(new ApiError('Not found', 404)), 'error(404)');
assert.equal(describe({ items: [1, 2] }), 'list(2)');

type cases = [Expect<Equal<Parameters<typeof describe>[0], Input>>];

const bad = () => {
  // @ts-expect-error boolean is not part of the union
  describe(true);
};
```

</details>

</details>

---

<a id="ts-04"></a>
### ts-04. Exhaustive switch over a discriminated union

*Discriminated unions · Easy*

Given

```ts
type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'square'; size: number }
  | { kind: 'rect'; width: number; height: number };
```

implement `area(shape: Shape): number` with a `switch` on `kind`. Make it **exhaustive**: if someone adds a new shape to the union and forgets a case, the code must stop compiling. Write a helper `assertNever(x: never): never` that throws at runtime.

```ts
area({ kind: 'square', size: 3 })              // 9
area({ kind: 'rect', width: 2, height: 5 })    // 10
```

**Starter**

```ts
type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'square'; size: number }
  | { kind: 'rect'; width: number; height: number };

function assertNever(x: never): never {
  // TODO
}

function area(shape: Shape): number {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type Shape =
  | { kind: 'circle'; radius: number }
  | { kind: 'square'; size: number }
  | { kind: 'rect'; width: number; height: number };

function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}

function area(shape: Shape): number {
  switch (shape.kind) {
    case 'circle':
      return Math.PI * shape.radius ** 2;
    case 'square':
      return shape.size ** 2;
    case 'rect':
      return shape.width * shape.height;
    default:
      // If a case is missing, `shape` is not `never` here and this line fails to compile.
      return assertNever(shape);
  }
}
```

**Why it works.** A shared literal field (`kind`) lets TypeScript narrow each `case` to one member of the union. After all cases are handled, the remaining type in `default` is `never`; passing it to a function that only accepts `never` turns a forgotten case into a compile error. `assertNever` also throws, which protects you at runtime when bad data arrives from outside (e.g. an API sends a new kind).

**Say it.** I switch on the discriminant so each branch is narrowed, and in the default branch I pass the value to assertNever, so any unhandled variant becomes a compile error.

**Follow-up.** Q: Is there a way to get exhaustiveness without assertNever? A: Yes: give the function an explicit return type and no default; with `strict`, a missing case makes the function possibly return `undefined`, which is an error. assertNever is clearer and also throws at runtime.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


assert.equal(area({ kind: 'square', size: 3 }), 9);
assert.equal(area({ kind: 'rect', width: 2, height: 5 }), 10);
assert.equal(area({ kind: 'circle', radius: 1 }), Math.PI);
assert.throws(() => area({ kind: 'triangle' } as unknown as Shape), /Unhandled case/);

type cases = [Expect<Equal<Extract<Shape, { kind: 'rect' }>['width'], number>>];

function partialArea(shape: Shape): number {
  switch (shape.kind) {
    case 'circle':
      return 1;
    case 'square':
      return 2;
    default:
      // @ts-expect-error 'rect' is not handled, so shape is not never
      return assertNever(shape);
  }
}
assert.equal(partialArea({ kind: 'circle', radius: 1 }), 1);
```

</details>

</details>

---

<a id="ts-05"></a>
### ts-05. getProperty<T, K extends keyof T>

*Generics with constraints · Easy*

Write a type-safe property getter and a `pluck` helper:

- `getProperty(obj, key)` only accepts keys that exist on `obj`, and its return type is the type of that property.
- `pluck(items, key)` returns an array of that property from every item.

```ts
const user = { id: 1, name: 'Ada', admin: true };
getProperty(user, 'name')   // 'Ada'  (type: string)
getProperty(user, 'age')    // compile error
pluck([user, { ...user, id: 2 }], 'id') // [1, 2] (type: number[])
```

**Starter**

```ts
function getProperty(obj, key) {
  // TODO: add generics
}

function pluck(items, key) {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

function pluck<T, K extends keyof T>(items: readonly T[], key: K): T[K][] {
  return items.map((item) => item[key]);
}
```

**Why it works.** `K extends keyof T` restricts the key to the actual keys of the object, and the indexed access type `T[K]` gives the exact type of that property. Because `K` is inferred as a literal (`'name'`, not `string`), the return type is precise. Without the second type parameter you would get `T[keyof T]`, which is the union of all property types.

**Say it.** I make the key its own type parameter constrained to keyof T, so it is inferred as a literal and the return type is the indexed access T[K].

**Follow-up.** Q: What is the return type if the key comes from a variable typed `keyof T`? A: `T[keyof T]`, a union of all property types, because K is no longer a single literal.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


const user = { id: 1, name: 'Ada', admin: true };

const name = getProperty(user, 'name');
const ids = pluck([user, { ...user, id: 2 }], 'id');
type cases = [
  Expect<Equal<typeof name, string>>,
  Expect<Equal<typeof ids, number[]>>,
  Expect<Equal<ReturnType<typeof getProperty<typeof user, 'admin'>>, boolean>>,
];

assert.equal(name, 'Ada');
assert.deepEqual(ids, [1, 2]);
assert.deepEqual(pluck([] as (typeof user)[], 'id'), []);

// @ts-expect-error 'age' is not a key of user
getProperty(user, 'age');
```

</details>

</details>

---

<a id="ts-06"></a>
### ts-06. Derive types from a runtime config object

*keyof / typeof / indexed access · Easy*

Given a runtime object (no hand-written types):

```ts
const config = {
  server: { host: 'localhost', port: 3000 },
  db: { url: 'postgres://localhost/app', poolSize: 10 },
  logLevel: 'info',
};
```

derive these types from it: `Config` (whole object), `ConfigKey` (`'server' | 'db' | 'logLevel'`), `ServerKey` (`'host' | 'port'`) and `Port` (`number`). Then write `getSection(key)` whose return type depends on the key.

```ts
getSection('db').poolSize  // 10, type number
getSection('cache')        // compile error
```

**Starter**

```ts
const config = {
  server: { host: 'localhost', port: 3000 },
  db: { url: 'postgres://localhost/app', poolSize: 10 },
  logLevel: 'info',
};

// TODO: Config, ConfigKey, ServerKey, Port, getSection
```

<details>
<summary>Solution</summary>

```ts
const config = {
  server: { host: 'localhost', port: 3000 },
  db: { url: 'postgres://localhost/app', poolSize: 10 },
  logLevel: 'info',
};

type Config = typeof config;
type ConfigKey = keyof Config;
type ServerKey = keyof Config['server'];
type Port = Config['server']['port'];

function getSection<K extends ConfigKey>(key: K): Config[K] {
  return config[key];
}
```

**Why it works.** `typeof` in a type position turns a value into its type, `keyof` gives the union of a type's keys, and `T['a']['b']` (indexed access) reads a property's type. Deriving types from the single source of truth means they can never drift from the data. Note that `logLevel` is widened to `string`; add `as const` if you need the literal `'info'`.

**Say it.** I take typeof of the object once, then use keyof and indexed access types to derive everything else, so the types always follow the data.

**Follow-up.** Q: Why is `Config['logLevel']` `string` and not `'info'`? A: Object literal properties are widened because they are mutable. `as const` (or `satisfies` with a literal union) keeps the literal type.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


const db = getSection('db');
type cases = [
  Expect<Equal<ConfigKey, 'server' | 'db' | 'logLevel'>>,
  Expect<Equal<ServerKey, 'host' | 'port'>>,
  Expect<Equal<Port, number>>,
  Expect<Equal<Config['logLevel'], string>>,
  Expect<Equal<typeof db, { url: string; poolSize: number }>>,
];

assert.equal(db.poolSize, 10);
assert.equal(getSection('server').port, 3000);
assert.equal(getSection('logLevel'), 'info');

// @ts-expect-error 'cache' is not a config key
getSection('cache');
```

</details>

</details>

---

<a id="ts-07"></a>
### ts-07. Implement MyPartial, MyRequired, MyReadonly, MyRecord

*Mapped types · Easy*

Without using the built-in utility types, implement:

- `MyPartial<T>`: every property optional
- `MyRequired<T>`: every property required
- `MyReadonly<T>`: every property readonly
- `MyRecord<K, V>`: an object type with keys `K` and values `V`

```ts
type Todo = { title: string; done?: boolean };
MyPartial<Todo>    // { title?: string; done?: boolean }
MyRequired<Todo>   // { title: string; done: boolean }
MyRecord<'a' | 'b', number> // { a: number; b: number }
```

**Starter**

```ts
type MyPartial<T> = any; // TODO
type MyRequired<T> = any; // TODO
type MyReadonly<T> = any; // TODO
type MyRecord<K, V> = any; // TODO
```

<details>
<summary>Solution</summary>

```ts
type MyPartial<T> = { [K in keyof T]?: T[K] };
type MyRequired<T> = { [K in keyof T]-?: T[K] };
type MyReadonly<T> = { readonly [K in keyof T]: T[K] };
type MyRecord<K extends PropertyKey, V> = { [P in K]: V };
```

**Why it works.** A mapped type `{ [K in keyof T]: ... }` loops over the keys of `T`. Modifiers can be added (`?`, `readonly`) or removed (`-?`, `-readonly`). Because these are homomorphic (they map over `keyof T`), they keep the original modifiers unless you change them. `MyRecord` maps over an arbitrary key union instead; the constraint `K extends PropertyKey` is needed because only string, number and symbol can be keys.

**Say it.** These are mapped types that iterate over keyof T and add or remove the optional and readonly modifiers; Record maps over a key union instead of keyof T.

**Follow-up.** Q: Is `MyReadonly` deep? A: No. Nested objects stay mutable; you need a recursive type (DeepReadonly) and, at runtime, `Object.freeze` on each level.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


type Todo = { title: string; done?: boolean };

type cases = [
  Expect<Equal<MyPartial<Todo>, { title?: string; done?: boolean }>>,
  Expect<Equal<MyRequired<Todo>, { title: string; done: boolean }>>,
  Expect<Equal<MyReadonly<Todo>, { readonly title: string; readonly done?: boolean }>>,
  Expect<Equal<MyRecord<'a' | 'b', number>, { a: number; b: number }>>,
  Expect<Equal<MyPartial<Todo>, Partial<Todo>>>,
];

const todo: MyReadonly<Todo> = { title: 'Write tests' };
assert.equal(todo.title, 'Write tests');
const draft: MyPartial<Todo> = {};
assert.deepEqual(draft, {});
const scores: MyRecord<'math' | 'art', number> = { math: 5, art: 4 };
assert.equal(scores.math + scores.art, 9);

const mutate = () => {
  // @ts-expect-error title is readonly
  todo.title = 'changed';
};
```

</details>

</details>

---

<a id="ts-08"></a>
### ts-08. Implement MyPick and MyOmit (types and runtime)

*Mapped types · Medium*

Implement the types `MyPick<T, K>` and `MyOmit<T, K>` without using `Pick`, `Omit` or `Exclude`. Then write runtime helpers `pick(obj, keys)` and `omit(obj, keys)` that return correctly typed objects and do not mutate the input.

```ts
type User = { id: number; name: string; password: string };
MyPick<User, 'id' | 'name'>  // { id: number; name: string }
MyOmit<User, 'password'>     // { id: number; name: string }

omit({ id: 1, name: 'Ada', password: 'x' }, ['password']) // { id: 1, name: 'Ada' }
```

**Starter**

```ts
type MyPick<T, K extends keyof T> = any; // TODO
type MyOmit<T, K extends PropertyKey> = any; // TODO

function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): MyPick<T, K> {
  // TODO
}

function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): MyOmit<T, K> {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type MyPick<T, K extends keyof T> = { [P in K]: T[P] };

// Key remapping with `as`: mapping a key to `never` drops it.
type MyOmit<T, K extends PropertyKey> = {
  [P in keyof T as P extends K ? never : P]: T[P];
};

function pick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): MyPick<T, K> {
  const out = {} as MyPick<T, K>;
  for (const key of keys) {
    if (key in obj) out[key] = obj[key];
  }
  return out;
}

function omit<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): MyOmit<T, K> {
  const out = { ...obj } as Record<PropertyKey, unknown>;
  for (const key of keys) delete out[key];
  return out as MyOmit<T, K>;
}
```

**Why it works.** `MyPick` maps over the chosen keys only. `MyOmit` maps over all keys of `T` and uses an `as` clause to remap unwanted keys to `never`, which removes them; this keeps optional and readonly modifiers because the mapping is still over `keyof T`. The built-in `Omit<T, K>` accepts any key (`K extends keyof any`), so typos are not caught; constraining `K extends keyof T` in your own helper is stricter. At runtime, copy first (`{ ...obj }`) so the caller's object is not mutated.

**Say it.** Pick maps over the selected keys; Omit maps over all keys and remaps the excluded ones to never so they disappear. The runtime helpers copy the object, so the input is never mutated.

**Follow-up.** Q: How does the classic `Omit` work without key remapping? A: `Pick<T, Exclude<keyof T, K>>`: `Exclude` removes the keys from the union, then `Pick` keeps the rest.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


type User = { id: number; name: string; password: string; bio?: string };

type cases = [
  Expect<Equal<MyPick<User, 'id' | 'name'>, { id: number; name: string }>>,
  Expect<Equal<MyOmit<User, 'password'>, { id: number; name: string; bio?: string }>>,
  Expect<Equal<MyOmit<User, 'password' | 'bio'>, Omit<User, 'password' | 'bio'>>>,
];

const user: User = { id: 1, name: 'Ada', password: 'secret' };
const safe = omit(user, ['password']);
assert.deepEqual(safe, { id: 1, name: 'Ada' });
assert.equal(user.password, 'secret'); // input not mutated
assert.deepEqual(pick(user, ['id', 'name']), { id: 1, name: 'Ada' });
assert.deepEqual(pick(user, []), {});

// @ts-expect-error 'email' is not a key of User
pick(user, ['email']);
const leak = () => {
  // @ts-expect-error password was omitted
  return safe.password;
};
```

</details>

</details>

---

<a id="ts-09"></a>
### ts-09. DeepPartial and DeepReadonly

*Recursive types · Medium*

Implement two recursive utility types:

- `DeepPartial<T>`: every property at every level is optional (useful for config overrides and test fixtures).
- `DeepReadonly<T>`: every property at every level is readonly, including arrays.

Functions must stay functions. Also write `deepFreeze(obj)` that freezes every level at runtime and returns `DeepReadonly<T>`.

```ts
type Settings = { theme: { colors: { primary: string } }; tags: string[] };
const patch: DeepPartial<Settings> = { theme: { colors: {} } }; // OK
const s = deepFreeze(settings);
s.theme.colors.primary = 'red';  // compile error
```

**Starter**

```ts
type DeepPartial<T> = any; // TODO
type DeepReadonly<T> = any; // TODO

function deepFreeze<T>(obj: T): DeepReadonly<T> {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? DeepPartial<U>[]
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> } // also turns arrays into readonly arrays
    : T;

function deepFreeze<T>(obj: T): DeepReadonly<T> {
  if (typeof obj === 'object' && obj !== null && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const value of Object.values(obj)) deepFreeze(value);
  }
  return obj as DeepReadonly<T>;
}
```

**Why it works.** A conditional type picks a branch per kind of value: functions are returned unchanged (mapping over a function would turn it into `{}`), arrays recurse into their element type, objects become a mapped type that recurses into each property, and primitives stop the recursion. A homomorphic mapped type over an array keeps it an array, which is why `DeepReadonly` produces `readonly string[]`. Types are compile-time only, so you still need `Object.freeze` at runtime; the `isFrozen` check also prevents infinite loops on already-frozen cycles.

**Say it.** It is a recursive conditional type: leave functions and primitives alone, recurse into arrays and object properties, and add the optional or readonly modifier at every level.

**Follow-up.** Q: What happens to a `Date` or `Map` in DeepPartial? A: They are objects, so their methods become optional too, which is usually wrong. Add a branch like `T extends Date | Map<unknown, unknown> ? T : ...` to keep built-ins as they are.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


type Settings = {
  theme: { colors: { primary: string; accent: string } };
  tags: string[];
  onChange: (value: string) => void;
};

type cases = [
  Expect<Equal<DeepPartial<{ a: { b: number } }>, { a?: { b?: number } }>>,
  Expect<Equal<DeepPartial<{ list: { x: number }[] }>, { list?: { x?: number }[] }>>,
  Expect<Equal<DeepReadonly<{ a: { b: number[] } }>, { readonly a: { readonly b: readonly number[] } }>>,
  Expect<Equal<DeepReadonly<Settings>['onChange'], (value: string) => void>>,
];

const patch: DeepPartial<Settings> = { theme: { colors: { primary: 'red' } } };
assert.equal(patch.theme?.colors?.primary, 'red');

const settings = deepFreeze<Settings>({
  theme: { colors: { primary: 'blue', accent: 'pink' } },
  tags: ['a'],
  onChange: () => {},
});
assert.ok(Object.isFrozen(settings.theme.colors));
assert.ok(Object.isFrozen(settings.tags));
assert.throws(() => {
  (settings.theme.colors as { primary: string }).primary = 'red';
}, TypeError);

const mutate = () => {
  // @ts-expect-error nested property is readonly
  settings.theme.colors.primary = 'red';
  // @ts-expect-error readonly array has no push
  settings.tags.push('b');
};
```

</details>

</details>

---

<a id="ts-10"></a>
### ts-10. MyReturnType and MyParameters with infer

*infer · Medium*

Implement `MyReturnType<F>` and `MyParameters<F>` using `infer` (no built-ins). Then use them to type `withLogging(fn)`: a wrapper that records each call's arguments and returns exactly what `fn` returns, with the same parameter types.

```ts
const add = (a: number, b: number) => a + b;
MyReturnType<typeof add>  // number
MyParameters<typeof add>  // [a: number, b: number]

const loggedAdd = withLogging(add, calls);
loggedAdd(2, 3)    // 5, calls -> [[2, 3]]
loggedAdd('2', 3)  // compile error
```

**Starter**

```ts
type MyReturnType<F> = any; // TODO
type MyParameters<F> = any; // TODO

function withLogging(fn, calls: unknown[][]) {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type AnyFn = (...args: any[]) => any;

type MyReturnType<F extends AnyFn> = F extends (...args: any[]) => infer R ? R : never;
type MyParameters<F extends AnyFn> = F extends (...args: infer P) => any ? P : never;

function withLogging<F extends AnyFn>(
  fn: F,
  calls: unknown[][],
): (...args: MyParameters<F>) => MyReturnType<F> {
  return (...args) => {
    calls.push(args);
    return fn(...args);
  };
}
```

**Why it works.** `infer` declares a type variable inside the `extends` clause of a conditional type; if the match succeeds, TypeScript fills it in, so `F extends (...args: infer P) => any` captures the parameter tuple. The parameters come back as a labeled tuple, which you can spread into a new function type. `any` in the constraint is deliberate: with `unknown[]` parameters, a function like `(a: number) => void` would not be assignable because of parameter contravariance.

**Say it.** I pattern-match the function type with a conditional type and use infer to capture the return type or the parameter tuple, then reuse those to type a wrapper with the same signature.

**Follow-up.** Q: How would you get the type of the first argument only? A: `F extends (first: infer A, ...rest: any[]) => any ? A : never`, or `MyParameters<F>[0]`.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


const add = (a: number, b: number) => a + b;
const greet = async (name: string) => `hi ${name}`;

type cases = [
  Expect<Equal<MyReturnType<typeof add>, number>>,
  Expect<Equal<MyParameters<typeof add>, [a: number, b: number]>>,
  Expect<Equal<MyReturnType<typeof greet>, Promise<string>>>,
  Expect<Equal<MyParameters<() => void>, []>>,
];

const calls: unknown[][] = [];
const loggedAdd = withLogging(add, calls);
assert.equal(loggedAdd(2, 3), 5);
assert.equal(loggedAdd(10, -1), 9);
assert.deepEqual(calls, [[2, 3], [10, -1]]);

// @ts-expect-error '2' is not a number
loggedAdd('2', 3);
```

</details>

</details>

---

<a id="ts-11"></a>
### ts-11. MyAwaited and a typed Promise.all for objects

*infer · Medium*

Implement `MyAwaited<T>` that unwraps a promise (or any thenable) recursively, like the built-in `Awaited`. Then write `resolveAll(obj)`: it takes an object whose values may be promises and returns a promise of an object with the same keys and the resolved values, correctly typed.

```ts
MyAwaited<Promise<Promise<number>>>  // number
MyAwaited<string>                    // string

const r = await resolveAll({ user: fetchUser(), count: Promise.resolve(3), flag: true });
// r: { user: User; count: number; flag: boolean }
```

**Starter**

```ts
type MyAwaited<T> = any; // TODO

async function resolveAll<T extends Record<string, unknown>>(obj: T) {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type MyAwaited<T> = T extends PromiseLike<infer U> ? MyAwaited<U> : T;

async function resolveAll<T extends Record<string, unknown>>(
  obj: T,
): Promise<{ [K in keyof T]: MyAwaited<T[K]> }> {
  const entries = await Promise.all(
    Object.entries(obj).map(async ([key, value]) => [key, await value] as const),
  );
  return Object.fromEntries(entries) as { [K in keyof T]: MyAwaited<T[K]> };
}
```

**Why it works.** `T extends PromiseLike<infer U>` matches anything with a `then` method and captures what it resolves to; calling `MyAwaited` again on `U` handles nested promises, and non-promises fall through unchanged. Conditional types distribute over unions, so `Promise<string> | number` becomes `string | number`. At runtime, `Promise.all` runs the values in parallel; `Object.fromEntries` loses key types, so a single cast to the mapped type is needed at that boundary.

**Say it.** MyAwaited is a recursive conditional type that unwraps anything thenable; resolveAll awaits all values in parallel and maps each key's type through MyAwaited.

**Follow-up.** Q: What if one promise rejects? A: `Promise.all` rejects immediately with that error. Use `Promise.allSettled` if you want every result, then map each to `{ status, value | reason }`.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


type cases = [
  Expect<Equal<MyAwaited<Promise<Promise<number>>>, number>>,
  Expect<Equal<MyAwaited<string>, string>>,
  Expect<Equal<MyAwaited<Promise<string> | number>, string | number>>,
  Expect<Equal<MyAwaited<PromiseLike<boolean>>, boolean>>,
];

function sleep<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const result = await resolveAll({
  user: sleep(20, { name: 'Ada' }),
  count: Promise.resolve(3),
  flag: true,
});
type R = typeof result;
type moreCases = [Expect<Equal<R, { user: { name: string }; count: number; flag: boolean }>>];

assert.deepEqual(result, { user: { name: 'Ada' }, count: 3, flag: true });
assert.deepEqual(await resolveAll({}), {});
await assert.rejects(resolveAll({ bad: Promise.reject(new Error('nope')) }), /nope/);
```

</details>

</details>

---

<a id="ts-12"></a>
### ts-12. Distributive conditional types: Exclude, Extract, IsNever, IsUnion

*Conditional types · Hard*

Implement without built-ins:

- `MyExclude<T, U>`, `MyExtract<T, U>`, `MyNonNullable<T>`
- `ToArray<T>` (distributes: `string | number` -> `string[] | number[]`) and `ToArrayNonDist<T>` (`(string | number)[]`)
- `IsNever<T>` (`true` only for `never`)
- `IsUnion<T>` (`true` for `'a' | 'b'`, `false` for `string`)

Also write `compact(arr)` that removes `null`/`undefined` with the right type.

```ts
MyExclude<'a' | 'b' | 'c', 'a'>    // 'b' | 'c'
IsNever<never>                     // true
compact([1, null, 2, undefined])   // [1, 2]: number[]
```

**Starter**

```ts
type MyExclude<T, U> = any; // TODO
type MyExtract<T, U> = any; // TODO
type MyNonNullable<T> = any; // TODO
type ToArray<T> = any; // TODO
type ToArrayNonDist<T> = any; // TODO
type IsNever<T> = any; // TODO
type IsUnion<T> = any; // TODO

function compact<T>(arr: readonly T[]) {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type MyExclude<T, U> = T extends U ? never : T;
type MyExtract<T, U> = T extends U ? T : never;
type MyNonNullable<T> = T extends null | undefined ? never : T;

type ToArray<T> = T extends unknown ? T[] : never;
// Wrapping both sides in a tuple turns distribution off.
type ToArrayNonDist<T> = [T] extends [unknown] ? T[] : never;

type IsNever<T> = [T] extends [never] ? true : false;

// Distribute over T, then compare each member U against the whole union.
type IsUnion<T, Whole = T> = IsNever<T> extends true
  ? false
  : T extends unknown
    ? [Whole] extends [T]
      ? false
      : true
    : never;

function compact<T>(arr: readonly T[]): MyNonNullable<T>[] {
  return arr.filter((x): x is MyNonNullable<T> => x !== null && x !== undefined);
}
```

**Why it works.** A conditional type whose checked type is a naked type parameter is distributive: it runs once per union member and unions the results, which is how `Exclude` and `Extract` filter unions (`never` disappears from a union). Wrapping in `[T]` stops distribution. That matters for `never`: it is the empty union, so a distributive check on it returns `never` instead of `true`, which is why `IsNever` must use the tuple form. `IsUnion` distributes to get each member and checks whether the whole union fits into that single member; it only does when there was one member.

**Say it.** Conditional types over a naked type parameter run once per union member, so I use that to filter unions, and wrap in a tuple when I need to look at the union as a whole, for example to detect never.

**Follow-up.** Q: Why does a naive `type IsNever<T> = T extends never ? true : false` return `never` for `never`? A: `never` is an empty union; distributing over zero members produces nothing, i.e. `never`. Wrapping both sides in tuples fixes it.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


type NaiveIsNever<T> = T extends never ? true : false;

type cases = [
  Expect<Equal<MyExclude<'a' | 'b' | 'c', 'a'>, 'b' | 'c'>>,
  Expect<Equal<MyExtract<string | number | (() => void), Function>, () => void>>,
  Expect<Equal<MyNonNullable<string | null | undefined>, string>>,
  Expect<Equal<ToArray<string | number>, string[] | number[]>>,
  Expect<Equal<ToArrayNonDist<string | number>, (string | number)[]>>,
  Expect<Equal<IsNever<never>, true>>,
  Expect<Equal<IsNever<undefined>, false>>,
  Expect<Equal<NaiveIsNever<never>, never>>,
  Expect<Equal<IsUnion<'a' | 'b'>, true>>,
  Expect<Equal<IsUnion<string>, false>>,
  Expect<Equal<IsUnion<never>, false>>,
];

const values = compact([1, null, 2, undefined, 0]);
type moreCases = [Expect<Equal<typeof values, number[]>>];
assert.deepEqual(values, [1, 2, 0]);
assert.deepEqual(compact([]), []);
assert.deepEqual(compact(['', null]), ['']);
```

</details>

</details>

---

<a id="ts-13"></a>
### ts-13. Generate getters with key remapping

*Key remapping + template literals · Medium*

Write a type `Getters<T>` that turns every string key into a getter method named `get` + capitalized key, returning that property's type. Then implement `createGetters(obj)` that builds such an object at runtime.

```ts
type Person = { name: string; age: number };
Getters<Person>
// { getName: () => string; getAge: () => number }

const g = createGetters({ name: 'Ada', age: 36 });
g.getName()   // 'Ada'
g.getEmail()  // compile error
```

**Starter**

```ts
type Getters<T> = any; // TODO

function createGetters<T extends object>(obj: T): Getters<T> {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type Getters<T> = {
  [K in keyof T & string as `get${Capitalize<K>}`]: () => T[K];
};

function createGetters<T extends object>(obj: T): Getters<T> {
  const out: Record<string, () => unknown> = {};
  for (const key of Object.keys(obj) as (keyof T & string)[]) {
    const name = `get${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    out[name] = () => obj[key];
  }
  return out as Getters<T>;
}
```

**Why it works.** The `as` clause in a mapped type renames each key; template literal types build the new name and the intrinsic `Capitalize` upper-cases the first letter. Intersecting with `string` (`keyof T & string`) drops number and symbol keys, which cannot go inside a template literal. At runtime `Object.keys` returns `string[]`, so one cast is needed to reconnect keys to `T`, and one cast on the result because TypeScript cannot follow string building.

**Say it.** I use a mapped type with an as clause to rename each key into a get-prefixed template literal, and the value type becomes a zero-argument function returning the original property type.

**Follow-up.** Q: How would you type `on<Name>Change` handlers? A: `{ [K in keyof T & string as `on${Capitalize<K>}Change`]: (value: T[K]) => void }`. The same pattern also gives setters.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


type Person = { name: string; age: number; [Symbol.iterator]?: () => void };

type cases = [
  Expect<Equal<Getters<{ name: string; age: number }>, { getName: () => string; getAge: () => number }>>,
  Expect<Equal<keyof Getters<Person>, 'getName' | 'getAge'>>,
  Expect<Equal<Getters<{}>, {}>>,
];

const g = createGetters({ name: 'Ada', age: 36, isAdmin: false });
assert.equal(g.getName(), 'Ada');
assert.equal(g.getAge(), 36);
assert.equal(g.getIsAdmin(), false);
assert.deepEqual(Object.keys(g), ['getName', 'getAge', 'getIsAdmin']);

// @ts-expect-error there is no email property
g.getEmail;
```

</details>

</details>

---

<a id="ts-14"></a>
### ts-14. Derive a union from a const array (enum alternative)

*as const · Easy*

You are not allowed to use `enum`. Define the list of roles once as a runtime array and derive:

- `Role`: `'admin' | 'editor' | 'viewer'` from the array
- `isRole(value: string): value is Role` for validating input (e.g. a query param)
- from `const STATUS = { active: 1, banned: 2 }`, a type `StatusCode` = `1 | 2`

```ts
isRole('editor')  // true
isRole('guest')   // false
const r: Role = 'guest'  // compile error
```

**Starter**

```ts
const ROLES = ['admin', 'editor', 'viewer'];
// TODO: Role, isRole, STATUS, StatusCode
```

<details>
<summary>Solution</summary>

```ts
const ROLES = ['admin', 'editor', 'viewer'] as const;
type Role = (typeof ROLES)[number];

function isRole(value: string): value is Role {
  // includes() on a readonly tuple only accepts Role, so widen the array, not the value.
  return (ROLES as readonly string[]).includes(value);
}

const STATUS = { active: 1, banned: 2 } as const;
type StatusName = keyof typeof STATUS;
type StatusCode = (typeof STATUS)[StatusName];
```

**Why it works.** `as const` makes the array a readonly tuple of literal types instead of `string[]`, and indexing it with `number` gives the union of its elements. The same trick on an object (`(typeof obj)[keyof typeof obj]`) is the usual replacement for `enum`: one runtime value, types derived from it, and no extra emitted code. The trap: `ROLES.includes(value)` does not compile when `value` is `string`, because the tuple's `includes` only accepts `Role`; widen the array to `readonly string[]`.

**Say it.** I declare the values once with as const so they keep their literal types, derive the union with an indexed access by number, and validate untrusted strings with a type guard.

**Follow-up.** Q: Why do many teams avoid `enum`? A: Enums emit runtime code, numeric enums accept any number, and they are not supported by Node's type stripping or `isolatedModules`-style tooling in all forms. A const object or array plus a derived union gives the same safety with plain JavaScript.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


type cases = [
  Expect<Equal<Role, 'admin' | 'editor' | 'viewer'>>,
  Expect<Equal<StatusCode, 1 | 2>>,
  Expect<Equal<StatusName, 'active' | 'banned'>>,
  Expect<Equal<typeof ROLES, readonly ['admin', 'editor', 'viewer']>>,
];

assert.equal(isRole('editor'), true);
assert.equal(isRole('guest'), false);
assert.equal(isRole(''), false);

const input: string = 'admin';
if (isRole(input)) {
  type narrowed = Expect<Equal<typeof input, Role>>;
  assert.equal(input, 'admin');
}

// @ts-expect-error 'guest' is not a Role
const r: Role = 'guest';
```

</details>

</details>

---

<a id="ts-15"></a>
### ts-15. satisfies vs type annotation

*satisfies · Easy*

You have a route table that must match `Record<string, Route>`:

```ts
type Route = { path: string; method: 'GET' | 'POST' };
```

1. Declare `routes` (with keys `home` and `login`) using `satisfies` so it is validated **and** keeps its precise type: `keyof typeof routes` is `'home' | 'login'` and `routes.login.method` is `'POST'`.
2. Declare the same object as `annotated` with a type annotation and explain what is lost.

```ts
routes.home.path      // OK
routes.about          // compile error with satisfies, allowed with annotation
```

**Starter**

```ts
type Route = { path: string; method: 'GET' | 'POST' };

const routes = {
  // TODO
};
```

<details>
<summary>Solution</summary>

```ts
type Route = { path: string; method: 'GET' | 'POST' };

const routes = {
  home: { path: '/', method: 'GET' },
  login: { path: '/login', method: 'POST' },
} satisfies Record<string, Route>;

const annotated: Record<string, Route> = {
  home: { path: '/', method: 'GET' },
  login: { path: '/login', method: 'POST' },
};
```

**Why it works.** A type annotation replaces the inferred type with the declared one, so `annotated` becomes `Record<string, Route>`: any key is allowed and the literal method values are widened. `satisfies` checks the value against the type (including excess property and typo checks) but keeps the inferred, more specific type, so keys and literals are preserved. Use an annotation when you want the wider contract, `satisfies` when you want validation plus precise inference.

**Say it.** satisfies validates the object against the type but keeps the narrower inferred type, while an annotation widens the variable to exactly the declared type.

**Follow-up.** Q: Can you combine `as const` and `satisfies`? A: Yes: `{...} as const satisfies Record<string, Route>` gives readonly literal types and still checks the shape.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


type cases = [
  Expect<Equal<keyof typeof routes, 'home' | 'login'>>,
  Expect<Equal<typeof routes.login.method, 'POST'>>,
  Expect<Equal<keyof typeof annotated, string>>,
  Expect<Equal<typeof annotated.login.method, 'GET' | 'POST'>>,
];

assert.equal(routes.home.path, '/');
assert.equal(routes.login.method, 'POST');
assert.equal(annotated['about'], undefined); // compiles, but is undefined at runtime

const unknownKey = () => {
  // @ts-expect-error with satisfies, unknown keys are caught
  return routes.about;
};

// @ts-expect-error 'PUT' is not an allowed method
const bad = { path: '/x', method: 'PUT' } satisfies Route;
```

</details>

</details>

---

<a id="ts-16"></a>
### ts-16. Overloads: one id or many ids

*Function overloads · Medium*

Implement `getUser` with overloads so the return type depends on the argument:

- `getUser(id: string)` returns `User | undefined`
- `getUser(ids: string[])` returns `User[]` (missing ids are skipped)

Data comes from an in-memory `db: Map<string, User>`.

```ts
getUser('1')         // { id: '1', name: 'Ada' }   type: User | undefined
getUser(['1', '9'])  // [{ id: '1', name: 'Ada' }] type: User[]
getUser(42)          // compile error
```

Be ready to explain why calling it with a value of type `string | string[]` does not compile.

**Starter**

```ts
type User = { id: string; name: string };
const db = new Map<string, User>([['1', { id: '1', name: 'Ada' }], ['2', { id: '2', name: 'Linus' }]]);

// TODO: overload signatures + implementation
```

<details>
<summary>Solution</summary>

```ts
type User = { id: string; name: string };
const db = new Map<string, User>([
  ['1', { id: '1', name: 'Ada' }],
  ['2', { id: '2', name: 'Linus' }],
]);

function getUser(id: string): User | undefined;
function getUser(ids: string[]): User[];
function getUser(idOrIds: string | string[]): User | undefined | User[] {
  if (typeof idOrIds === 'string') return db.get(idOrIds);
  return idOrIds.flatMap((id) => db.get(id) ?? []);
}
```

**Why it works.** Overload signatures are what callers see; the implementation signature is hidden and must be compatible with all of them. TypeScript picks the first overload that matches the call, so put more specific signatures first. Overloads do not combine: an argument of type `string | string[]` matches neither single overload, so you need an extra overload for the union or use a conditional type instead. Prefer a union parameter or generics when the return type does not depend on the input.

**Say it.** I declare one overload per input shape with its own return type, then write a single implementation that accepts the union and branches on typeof.

**Follow-up.** Q: How could you type this with one signature instead of overloads? A: With a generic and a conditional return type: `function getUser<T extends string | string[]>(x: T): T extends string ? User | undefined : User[]`. The implementation then needs a cast, which is why overloads are often simpler.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


const one = getUser('1');
const many = getUser(['1', '9', '2']);
type cases = [
  Expect<Equal<typeof one, User | undefined>>,
  Expect<Equal<typeof many, User[]>>,
];

assert.deepEqual(one, { id: '1', name: 'Ada' });
assert.equal(getUser('9'), undefined);
assert.deepEqual(many.map((u) => u.name), ['Ada', 'Linus']);
assert.deepEqual(getUser([]), []);

const errors = (x: string | string[]) => {
  // @ts-expect-error a number matches no overload
  getUser(42);
  // @ts-expect-error a union does not match any single overload
  getUser(x);
};
```

</details>

</details>

---

<a id="ts-17"></a>
### ts-17. Type guard and assertion function

*Type guards · Easy*

Given `type User = { id: number; email: string }`, write:

1. `isUser(value: unknown): value is User`: a user-defined type guard.
2. `assertIsUser(value: unknown): asserts value is User`: throws `TypeError('Not a User')` otherwise.

Show both in use: filtering an array of unknown values, and narrowing a parsed JSON body.

```ts
[{ id: 1, email: 'a@b.c' }, null, { id: '2' }].filter(isUser) // [{ id: 1, email: 'a@b.c' }]: User[]

const body: unknown = JSON.parse(raw);
assertIsUser(body);
body.email // OK, body is User here
```

**Starter**

```ts
type User = { id: number; email: string };

function isUser(value: unknown): value is User {
  // TODO
}

function assertIsUser(value: unknown): asserts value is User {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type User = { id: number; email: string };

function isUser(value: unknown): value is User {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'email' in value &&
    typeof value.email === 'string'
  );
}

function assertIsUser(value: unknown): asserts value is User {
  if (!isUser(value)) throw new TypeError('Not a User');
}
```

**Why it works.** A type guard returns a boolean and tells the compiler what the value is when it returns `true`; it narrows in `if` statements and in `.filter()`. An assertion function returns nothing and narrows everything after the call, because it throws otherwise; it suits "validate or fail" code like request handlers. The compiler trusts your guard completely, so a wrong check (e.g. forgetting `null`) is a real bug that types will not catch.

**Say it.** The guard returns a boolean predicate that narrows in branches and filters; the assertion function throws on bad input and narrows the rest of the scope.

**Follow-up.** Q: What is a common bug with type guards? A: The predicate lies: it checks less than the type promises (e.g. only `'id' in value`), and the compiler believes it. Keep guards small and test them, or generate them from a schema library like zod.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


const mixed: unknown[] = [{ id: 1, email: 'a@b.c' }, null, { id: '2', email: 'x' }, 'str'];
const users = mixed.filter(isUser);
type cases = [Expect<Equal<typeof users, User[]>>];
assert.deepEqual(users, [{ id: 1, email: 'a@b.c' }]);

const body: unknown = JSON.parse('{"id": 7, "email": "z@z.z"}');
assertIsUser(body);
const email: string = body.email;
assert.equal(email, 'z@z.z');

assert.throws(() => assertIsUser({ id: 1 }), TypeError);
assert.equal(isUser(undefined), false);

const notNarrowed = (v: unknown) => {
  // @ts-expect-error v is still unknown without the guard
  return v.email;
};
```

</details>

</details>

---

<a id="ts-18"></a>
### ts-18. Branded IDs: UserId vs OrderId

*Branded types · Medium*

Both user ids and order ids are strings, so it is easy to pass them in the wrong order. Create **branded** types `UserId` and `OrderId` so that mixing them up (or passing a plain string) is a compile error, with no runtime cost.

Write constructors that validate the format: `toUserId` (must start with `usr_`) and `toOrderId` (must start with `ord_`), throwing on bad input.

```ts
const u = toUserId('usr_42');
const o = toOrderId('ord_7');
getOrderUrl(u, o)        // '/users/usr_42/orders/ord_7'
getOrderUrl(o, u)        // compile error
getOrderUrl('usr_42', o) // compile error
```

**Starter**

```ts
type UserId = string; // TODO: brand it
type OrderId = string; // TODO: brand it

function toUserId(raw: string): UserId {}
function toOrderId(raw: string): OrderId {}

function getOrderUrl(userId: UserId, orderId: OrderId): string {
  return `/users/${userId}/orders/${orderId}`;
}
```

<details>
<summary>Solution</summary>

```ts
declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

type UserId = Brand<string, 'UserId'>;
type OrderId = Brand<string, 'OrderId'>;

function toUserId(raw: string): UserId {
  if (!/^usr_\w+$/.test(raw)) throw new Error(`Invalid user id: ${raw}`);
  return raw as UserId;
}

function toOrderId(raw: string): OrderId {
  if (!/^ord_\w+$/.test(raw)) throw new Error(`Invalid order id: ${raw}`);
  return raw as OrderId;
}

function getOrderUrl(userId: UserId, orderId: OrderId): string {
  return `/users/${userId}/orders/${orderId}`;
}
```

**Why it works.** TypeScript is structural, so two aliases of `string` are interchangeable. Intersecting with a phantom property (`{ [brand]: 'UserId' }`) makes the types nominal: different brand names are incompatible and a plain string lacks the brand. The brand exists only in types; at runtime the value is still a plain string. The only way to create one is a cast, so put the cast inside a validating constructor and treat that function as the single entry point.

**Say it.** I intersect string with a phantom brand property so the two id types are no longer interchangeable, and I only create them through validating constructor functions.

**Follow-up.** Q: Can you still call string methods on a UserId? A: Yes, it is `string & {...}`, so `userId.startsWith('usr_')` works and it can be passed to functions that take `string`. The brand only blocks the other direction.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


const u = toUserId('usr_42');
const o = toOrderId('ord_7');

assert.equal(getOrderUrl(u, o), '/users/usr_42/orders/ord_7');
assert.equal(u.toUpperCase(), 'USR_42');
assert.equal(typeof u, 'string');
assert.throws(() => toUserId('ord_1'), /Invalid user id/);

type cases = [
  Expect<Equal<UserId extends string ? true : false, true>>,
  Expect<Equal<string extends UserId ? true : false, false>>,
  Expect<Equal<UserId extends OrderId ? true : false, false>>,
];

const mistakes = () => {
  // @ts-expect-error arguments are swapped
  getOrderUrl(o, u);
  // @ts-expect-error a plain string is not a UserId
  getOrderUrl('usr_42', o);
};
```

</details>

</details>

---

<a id="ts-19"></a>
### ts-19. Result<T, E> instead of throwing

*Result type · Medium*

Model errors as values. Define `Result<T, E>` as a discriminated union on `ok`, with helpers `ok(value)` and `err(error)`. Then implement:

- `parseAge(input: string): Result<number, 'NOT_A_NUMBER' | 'OUT_OF_RANGE'>` (valid range 0-150, integers only)
- `mapResult(result, fn)`: applies `fn` to the value of an ok result, passes errors through unchanged

```ts
parseAge('42')   // { ok: true, value: 42 }
parseAge('abc')  // { ok: false, error: 'NOT_A_NUMBER' }
parseAge('200')  // { ok: false, error: 'OUT_OF_RANGE' }
mapResult(parseAge('42'), (n) => n + 1) // { ok: true, value: 43 }
```

**Starter**

```ts
type Result<T, E> = unknown; // TODO

function parseAge(input: string): Result<number, 'NOT_A_NUMBER' | 'OUT_OF_RANGE'> {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type Ok<T> = { ok: true; value: T };
type Err<E> = { ok: false; error: E };
type Result<T, E = Error> = Ok<T> | Err<E>;

function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

type AgeError = 'NOT_A_NUMBER' | 'OUT_OF_RANGE';

function parseAge(input: string): Result<number, AgeError> {
  const n = Number(input);
  if (input.trim() === '' || !Number.isInteger(n)) return err('NOT_A_NUMBER');
  if (n < 0 || n > 150) return err('OUT_OF_RANGE');
  return ok(n);
}

function mapResult<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}
```

**Why it works.** A `Result` makes failure part of the return type, so the caller must check `ok` before reading `value`, and the error union lists exactly what can go wrong. `throw` is invisible in TypeScript signatures (there are no checked exceptions), so callers easily forget a `try/catch`. Use Results for expected, recoverable failures (validation, not found) and keep exceptions for bugs and truly exceptional cases. Note `Number('')` is `0`, so empty input needs its own check.

**Say it.** I return a discriminated union of ok and error instead of throwing, so the compiler forces callers to handle the failure case, and the error type documents every failure mode.

**Follow-up.** Q: How do you chain several steps that each return a Result? A: Write `flatMap` (also called `andThen`): `result.ok ? fn(result.value) : result`, where `fn` returns a Result. The error type becomes the union of all steps' errors.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


assert.deepEqual(parseAge('42'), { ok: true, value: 42 });
assert.deepEqual(parseAge('abc'), { ok: false, error: 'NOT_A_NUMBER' });
assert.deepEqual(parseAge(''), { ok: false, error: 'NOT_A_NUMBER' });
assert.deepEqual(parseAge('200'), { ok: false, error: 'OUT_OF_RANGE' });
assert.deepEqual(mapResult(parseAge('42'), (n) => `${n + 1} years`), { ok: true, value: '43 years' });
assert.deepEqual(mapResult(parseAge('x'), (n) => n + 1), { ok: false, error: 'NOT_A_NUMBER' });

const r = parseAge('30');
if (r.ok) {
  type c1 = Expect<Equal<typeof r.value, number>>;
} else {
  type c2 = Expect<Equal<typeof r.error, AgeError>>;
}

const unchecked = () => {
  // @ts-expect-error value is only available after checking ok
  return r.value;
};
```

</details>

</details>

---

<a id="ts-20"></a>
### ts-20. Typed fetch wrapper with an endpoint map

*Typed API client · Medium*

Build a small typed API client. An `Endpoints` interface maps paths to response types. `createClient(baseUrl, fetcher)` returns `get(path)`, where the return type depends on the path and errors are returned, not thrown:

```ts
type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };
```

`fetcher` has the shape of `fetch` (inject it so it can be faked in tests). Non-2xx -> `{ ok: false, status, message: 'HTTP <status>' }`; network error -> status `0` and the error message.

```ts
const res = await api.get('/users/me');  // ApiResponse<User>
if (res.ok) res.data.name;
api.get('/nope')                          // compile error
```

**Starter**

```ts
type User = { id: number; name: string };

interface Endpoints {
  '/users': User[];
  '/users/me': User;
  '/health': { status: 'up' };
}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function createClient(baseUrl: string, fetcher: Fetcher) {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type User = { id: number; name: string };

interface Endpoints {
  '/users': User[];
  '/users/me': User;
  '/health': { status: 'up' };
}

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function createClient(baseUrl: string, fetcher: Fetcher) {
  async function get<P extends keyof Endpoints>(path: P): Promise<ApiResponse<Endpoints[P]>> {
    try {
      const res = await fetcher(baseUrl + path);
      if (!res.ok) return { ok: false, status: res.status, message: `HTTP ${res.status}` };
      // Trust boundary: the server's JSON is assumed to match. Validate it in production.
      const data = (await res.json()) as Endpoints[P];
      return { ok: true, data };
    } catch (e) {
      return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
    }
  }
  return { get };
}
```

**Why it works.** The endpoint map is the single source of truth: `P extends keyof Endpoints` restricts paths and `Endpoints[P]` gives the response type, so callers get autocomplete and precise types without passing generics manually. Returning a discriminated union forces callers to check `ok`. The cast on `res.json()` is the honest weak spot: types describe what you expect, not what the server sends, so validate at the boundary (zod or a hand-written guard). Injecting `fetcher` keeps the client testable without network.

**Say it.** A map from paths to response types drives everything: the path parameter is a key of the map and the result type is an indexed access, wrapped in an ok-or-error union instead of throwing.

**Follow-up.** Q: Why not `fetchJson<T>(url): Promise<T>` where the caller passes T? A: That is a cast in disguise: any caller can claim any type for any URL. Tying the type to the path in one map, plus runtime validation, keeps types and endpoints consistent.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


const responses: Record<string, { status: number; body: unknown }> = {
  'https://api.test/users/me': { status: 200, body: { id: 1, name: 'Ada' } },
  'https://api.test/users': { status: 500, body: null },
};

const fakeFetch: Fetcher = async (url) => {
  if (url.includes('health')) throw new Error('ECONNREFUSED');
  const r = responses[url] ?? { status: 404, body: null };
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
};

const api = createClient('https://api.test', fakeFetch);

const me = await api.get('/users/me');
type cases = [Expect<Equal<typeof me, ApiResponse<User>>>];
assert.deepEqual(me, { ok: true, data: { id: 1, name: 'Ada' } });
if (me.ok) assert.equal(me.data.name, 'Ada');

assert.deepEqual(await api.get('/users'), { ok: false, status: 500, message: 'HTTP 500' });
assert.deepEqual(await api.get('/health'), { ok: false, status: 0, message: 'ECONNREFUSED' });

const wrongPath = () => {
  // @ts-expect-error '/nope' is not a known endpoint
  return api.get('/nope');
};
```

</details>

</details>

---

<a id="ts-21"></a>
### ts-21. Word counts: Record, index signatures and missing keys

*Record vs index signature · Easy*

1. Implement `countWords(text): Record<string, number>` (lowercase words, letters and apostrophes only).
2. Implement `getCount(counts, word): number` that returns `0` for words that are not present.
3. Declare `type Scores` where **both** `math` and `english` keys are required numbers.

```ts
const c = countWords('The cat and the hat');
c                         // { the: 2, cat: 1, and: 1, hat: 1 }
getCount(c, 'dog')        // 0
getCount(c, 'toString')   // 0  (not a function!)
countWords('constructor') // { constructor: 1 }
```

**Starter**

```ts
function countWords(text: string): Record<string, number> {
  // TODO
}

function getCount(counts: Record<string, number>, word: string): number {
  // TODO
}

type Scores = unknown; // TODO
```

<details>
<summary>Solution</summary>

```ts
function countWords(text: string): Record<string, number> {
  // A Map avoids clashes with inherited keys like "constructor" or "__proto__".
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[a-z']+/g) ?? []) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

function getCount(counts: Record<string, number>, word: string): number {
  return Object.hasOwn(counts, word) ? counts[word] : 0;
}

type Scores = Record<'math' | 'english', number>;
```

**Why it works.** `Record<string, number>` is the same as the index signature `{ [key: string]: number }`, and TypeScript assumes every key exists: `counts['dog']` is typed `number` but is `undefined` at runtime. Enable `noUncheckedIndexedAccess` to get `number | undefined` on index access. With a literal key union, `Record<'math' | 'english', number>` requires every key. A plain object also inherits keys like `toString` and `constructor`, so use `Object.hasOwn` or a `Map` when keys come from user input.

**Say it.** Index signatures promise a value for every key, which is a lie for dictionaries, so I check with Object.hasOwn, build counts in a Map, and use a Record with a literal key union when all keys are known.

**Follow-up.** Q: When should you use a `Map` instead of an object as a dictionary? A: When keys are dynamic or user-provided, when you add and remove keys often, or when keys are not strings. Maps have no inherited keys, keep insertion order and have `.size`.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


const c = countWords('The cat and the hat');
assert.deepEqual(c, { the: 2, cat: 1, and: 1, hat: 1 });
assert.equal(getCount(c, 'the'), 2);
assert.equal(getCount(c, 'dog'), 0);
assert.equal(getCount(c, 'toString'), 0);
assert.equal(countWords('constructor constructor')['constructor'], 2);
assert.deepEqual(countWords(''), {});

type cases = [
  Expect<Equal<Scores, { math: number; english: number }>>,
  Expect<Equal<Record<string, number>, { [key: string]: number }>>,
];

const s: Scores = { math: 5, english: 4 };
assert.equal(s.math, 5);
// @ts-expect-error english is required
const missing: Scores = { math: 5 };
```

</details>

</details>

---

<a id="ts-22"></a>
### ts-22. Readonly arrays, tuple types and a useState-like tuple

*Readonly arrays and tuples · Medium*

1. `sum(nums)` must accept both `number[]` and `readonly number[]`.
2. `sortedCopy(arr, compare)` returns a sorted copy and must not mutate the input (the input type should prevent mutation).
3. Types: `Head<T>` (first element type of a tuple, `undefined` if empty) and `Length<T>`.
4. `createState(initial)` returns a readonly tuple `[get, set]` like React's `useState`.

```ts
sum([1, 2, 3] as const)       // 6
Head<[string, number]>        // string
Length<readonly [1, 2, 3]>    // 3
const [get, set] = createState(0); set(5); get() // 5
```

**Starter**

```ts
function sum(nums: number[]): number {}
function sortedCopy<T>(arr: T[], compare: (a: T, b: T) => number): T[] {}
type Head<T> = unknown;
type Length<T> = unknown;
function createState<T>(initial: T) {}
```

<details>
<summary>Solution</summary>

```ts
function sum(nums: readonly number[]): number {
  return nums.reduce((acc, n) => acc + n, 0);
}

function sortedCopy<T>(arr: readonly T[], compare: (a: T, b: T) => number): T[] {
  return [...arr].sort(compare); // or arr.toSorted(compare) on Node 20+
}

type Head<T extends readonly unknown[]> = T extends readonly [infer H, ...unknown[]] ? H : undefined;
type Length<T extends readonly unknown[]> = T['length'];

function createState<T>(initial: T): readonly [get: () => T, set: (value: T) => void] {
  let value = initial;
  return [() => value, (next: T) => { value = next; }] as const;
}
```

**Why it works.** `readonly T[]` has no mutating methods (`push`, `sort`, `splice`), and a mutable array is assignable to it, but not the other way round; so accept `readonly` in parameters you do not mutate. `as const` produces readonly tuples, which are rejected by a `number[]` parameter, a common surprise. Tuples have a literal `length`, which `T['length']` exposes, and `infer` with a variadic pattern extracts elements. Returning a tuple lets callers name the parts when destructuring.

**Say it.** I take readonly arrays in parameters I do not mutate, since that accepts both kinds, copy before sorting, and use tuple types with infer and the length property for the type-level parts.

**Follow-up.** Q: Why does `sort` in a `.map` chain cause bugs? A: `Array.prototype.sort` sorts in place and returns the same array, so sorting props or state mutates shared data. Use `[...arr].sort()` or `toSorted()`.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


const nums = [3, 1, 2];
const frozen = [1, 2, 3] as const;
assert.equal(sum(nums), 6);
assert.equal(sum(frozen), 6);
assert.equal(sum([]), 0);

const sorted = sortedCopy(nums, (a, b) => a - b);
assert.deepEqual(sorted, [1, 2, 3]);
assert.deepEqual(nums, [3, 1, 2]); // input untouched

const [get, set] = createState(0);
set(5);
assert.equal(get(), 5);

type cases = [
  Expect<Equal<Head<[string, number]>, string>>,
  Expect<Equal<Head<[]>, undefined>>,
  Expect<Equal<Length<typeof frozen>, 3>>,
  Expect<Equal<Length<string[]>, number>>,
  Expect<Equal<ReturnType<typeof createState<number>>, readonly [() => number, (value: number) => void]>>,
];

const mutations = (ro: readonly number[]) => {
  // @ts-expect-error readonly arrays have no push
  ro.push(1);
  // @ts-expect-error a readonly tuple is not assignable to number[]
  const m: number[] = frozen;
};
```

</details>

</details>

---

<a id="ts-23"></a>
### ts-23. Typed event emitter: on<K extends keyof Events>

*Typed event emitter · Hard*

Implement `TypedEmitter<Events>` where `Events` maps event names to payload types:

```ts
type AppEvents = {
  login: { userId: string };
  error: Error;
};
const bus = new TypedEmitter<AppEvents>();
const off = bus.on('login', (p) => p.userId); // p is { userId: string }
bus.emit('login', { userId: 'u1' });
bus.emit('login', { id: 1 });   // compile error
bus.on('logout', () => {});     // compile error
off();                           // unsubscribes
```

Methods: `on` (returns an unsubscribe function), `off`, `once`, `emit`, `listenerCount`. A listener that unsubscribes during `emit` must not break the loop.

**Starter**

```ts
type Listener<T> = (payload: T) => void;

class TypedEmitter<Events> {
  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {}
  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {}
  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {}
  emit<K extends keyof Events>(event: K, payload: Events[K]): void {}
  listenerCount(event: keyof Events): number {}
}
```

<details>
<summary>Solution</summary>

```ts
type Listener<T> = (payload: T) => void;

class TypedEmitter<Events> {
  #listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const set = this.#listeners[event] ?? new Set<Listener<Events[K]>>();
    set.add(listener);
    this.#listeners[event] = set;
    return () => this.off(event, listener);
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.#listeners[event]?.delete(listener);
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const unsubscribe = this.on(event, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    // Copy first so listeners that unsubscribe (e.g. once) don't affect this loop.
    for (const listener of [...(this.#listeners[event] ?? [])]) listener(payload);
  }

  listenerCount(event: keyof Events): number {
    return this.#listeners[event]?.size ?? 0;
  }
}
```

**Why it works.** The generic parameter `K extends keyof Events` ties the event name to its payload type `Events[K]`, so both `on` and `emit` are checked and listeners get typed payloads without annotations. Storage is a mapped type of `Set`s, which ignores duplicate registrations and makes removal O(1). Iterate over a copy in `emit`, because a `once` listener removes itself while the set is being iterated. Returning an unsubscribe function makes cleanup easy (e.g. in React effects).

**Say it.** Each method is generic over a key of the events map, so the payload type is the indexed access Events[K]; listeners live in a Set per event, and emit iterates over a copy so unsubscribing during emit is safe.

**Follow-up.** Q: How would you type Node's built-in `EventEmitter` this way? A: Since @types/node 20 you can write `new EventEmitter<{ login: [userId: string] }>()`, where each event maps to a tuple of listener arguments. Otherwise wrap it in a class like this one or use declaration merging on an interface.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


type AppEvents = {
  login: { userId: string };
  error: Error;
};

const bus = new TypedEmitter<AppEvents>();
const seen: string[] = [];

const off = bus.on('login', (p) => {
  type payload = Expect<Equal<typeof p, { userId: string }>>;
  seen.push(p.userId);
});
bus.once('login', (p) => seen.push(`once:${p.userId}`));
bus.on('error', (e) => seen.push(e.message));

bus.emit('login', { userId: 'u1' });
bus.emit('login', { userId: 'u2' });
bus.emit('error', new Error('boom'));
off();
bus.emit('login', { userId: 'u3' });

assert.deepEqual(seen, ['u1', 'once:u1', 'u2', 'boom']);
assert.equal(bus.listenerCount('login'), 0);
assert.equal(bus.listenerCount('error'), 1);

const typeErrors = () => {
  // @ts-expect-error wrong payload shape
  bus.emit('login', { id: 1 });
  // @ts-expect-error unknown event name
  bus.on('logout', () => {});
};
```

</details>

</details>

---

<a id="ts-24"></a>
### ts-24. Which lines compile? Structural typing and excess property checks

*Structural typing · Easy*

Without running the compiler, say which lines **A-F** are compile errors and why.

```ts
type Point = { x: number; y: number };
const printPoint = (p: Point) => `${p.x},${p.y}`;

const p3 = { x: 1, y: 2, z: 3 };
printPoint(p3);                    // A
printPoint({ x: 1, y: 2, z: 3 });  // B
class Vec { x = 5; y = 6; }
printPoint(new Vec());             // C
const partial = { x: 1 };
printPoint(partial);               // D
type Options = { verbose?: boolean; color?: boolean };
const typo = { verbos: true };
const o1: Options = typo;          // E
const o2: Options = {};            // F
```

<details>
<summary>Solution</summary>

```ts
type Point = { x: number; y: number };
const printPoint = (p: Point) => `${p.x},${p.y}`;

const p3 = { x: 1, y: 2, z: 3 };
printPoint(p3); // A: OK - extra properties are fine on a non-fresh object

// @ts-expect-error B: excess property check on a fresh object literal
printPoint({ x: 1, y: 2, z: 3 });

class Vec {
  x = 5;
  y = 6;
}
printPoint(new Vec()); // C: OK - classes are compared structurally too

const partial = { x: 1 };
// @ts-expect-error D: property 'y' is missing
printPoint(partial);

type Options = { verbose?: boolean; color?: boolean };
const typo = { verbos: true };
// @ts-expect-error E: weak type detection - no properties in common with Options
const o1: Options = typo;

const o2: Options = {}; // F: OK - all properties are optional
```

**Why it works.** Errors: B, D and E. TypeScript is structural: any value with at least the required properties fits (A, C), regardless of class or name. Fresh object literals get an extra "excess property check" because extra keys there are almost always typos (B); assigning through a variable (A) skips that check. E is "weak type detection": when every property of the target is optional, a source with no overlapping properties is rejected. F is fine because an empty object satisfies an all-optional type.

**Say it.** Types are compared by shape, so extra properties are allowed, except on fresh object literals where TypeScript flags them as likely typos; all-optional types additionally require at least one shared property.

**Follow-up.** Q: How can you make a function reject objects with extra properties even when passed via a variable? A: There is no exact-types feature; you can use a generic like `<T extends Point>(p: T & Record<Exclude<keyof T, keyof Point>, never>)`, or validate at runtime.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


assert.equal(printPoint(p3), '1,2');
assert.equal(printPoint(new Vec()), '5,6');
assert.equal(printPoint({ x: 1, y: 2, z: 3 } as Point), '1,2');
assert.deepEqual(o2, {});
type cases = [Expect<Equal<Parameters<typeof printPoint>[0], Point>>];
```

</details>

</details>

---

<a id="ts-25"></a>
### ts-25. Typed dot-paths: Paths<T> and PathValue<T, P>

*Template literal types · Hard*

For a nested plain object type (no arrays), write:

- `Paths<T>`: union of all dot-separated paths to every property
- `PathValue<T, P>`: the type at path `P`
- `getByPath(obj, path)`: runtime getter that only accepts valid paths and returns the correct type

```ts
type Config = { db: { host: string; port: number }; debug: boolean };
Paths<Config>              // 'db' | 'db.host' | 'db.port' | 'debug'
PathValue<Config, 'db.port'> // number
getByPath(config, 'db.port') // 5432, typed number
getByPath(config, 'db.user') // compile error
```

**Starter**

```ts
type Paths<T> = string; // TODO
type PathValue<T, P extends string> = unknown; // TODO

function getByPath<T, P extends Paths<T>>(obj: T, path: P): PathValue<T, P> {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type Paths<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends object ? K | `${K}.${Paths<T[K]>}` : K;
    }[keyof T & string]
  : never;

type PathValue<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? PathValue<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

function getByPath<T, P extends Paths<T>>(obj: T, path: P): PathValue<T, P> {
  let current: unknown = obj;
  for (const key of String(path).split('.')) {
    current = (current as Record<string, unknown>)[key];
  }
  return current as PathValue<T, P>;
}
```

**Why it works.** `Paths` maps each key to either the key itself or the key plus `.` plus the paths of the nested object, then indexes the mapped type with `[keyof T & string]` to collect all values into one union. `PathValue` parses the string with template literal inference: `${infer Head}.${infer Rest}` splits at the first dot and recurses. Because the path is a literal type, the return type is exact. The recursion breaks on arrays and very deep or recursive types (TypeScript has depth limits), so libraries add a depth counter.

**Say it.** I build the union of paths recursively with template literal types, then parse a path back with infer on the first dot to compute the value type; the runtime just splits and walks.

**Follow-up.** Q: Where have you seen this in practice? A: Form libraries (react-hook-form `register('address.city')`), i18n keys (`t('home.title')`) and config getters (NestJS `ConfigService.get`) all use this pattern for autocomplete and type safety.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


type Config = { db: { host: string; port: number; pool: { max: number } }; debug: boolean };

type cases = [
  Expect<Equal<Paths<Config>, 'db' | 'db.host' | 'db.port' | 'db.pool' | 'db.pool.max' | 'debug'>>,
  Expect<Equal<PathValue<Config, 'db.port'>, number>>,
  Expect<Equal<PathValue<Config, 'db.pool'>, { max: number }>>,
  Expect<Equal<PathValue<Config, 'nope'>, never>>,
];

const config: Config = { db: { host: 'localhost', port: 5432, pool: { max: 10 } }, debug: false };
const port = getByPath(config, 'db.port');
type portType = Expect<Equal<typeof port, number>>;
assert.equal(port, 5432);
assert.equal(getByPath(config, 'db.pool.max'), 10);
assert.equal(getByPath(config, 'debug'), false);
assert.deepEqual(getByPath(config, 'db.pool'), { max: 10 });

const bad = () => {
  // @ts-expect-error 'db.user' is not a valid path
  getByPath(config, 'db.user');
};
```

</details>

</details>

---

<a id="ts-26"></a>
### ts-26. Type-level snake_case to camelCase keys

*Template literal types · Hard*

An API returns snake_case JSON; your app uses camelCase. Write the types so a converted payload is typed correctly:

- `SnakeToCamel<S>`: `'created_at'` -> `'createdAt'`, `'a_b_c'` -> `'aBC'`
- `CamelKeys<T>`: converts keys deeply, through nested objects and arrays

Also implement the runtime `snakeToCamel(s)` with a return type of `SnakeToCamel<S>`.

```ts
CamelKeys<{ user_id: number; order_items: { item_id: number }[] }>
// { userId: number; orderItems: { itemId: number }[] }
snakeToCamel('created_at') // 'createdAt' (type 'createdAt')
```

**Starter**

```ts
type SnakeToCamel<S extends string> = string; // TODO
type CamelKeys<T> = unknown; // TODO

function snakeToCamel<S extends string>(s: S): SnakeToCamel<S> {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type SnakeToCamel<S extends string> = S extends `${infer Head}_${infer Tail}`
  ? `${Head}${Capitalize<SnakeToCamel<Tail>>}`
  : S;

type CamelKeys<T> = T extends readonly (infer U)[]
  ? CamelKeys<U>[]
  : T extends Date
    ? T
    : T extends object
      ? { [K in keyof T as K extends string ? SnakeToCamel<K> : K]: CamelKeys<T[K]> }
      : T;

function snakeToCamel<S extends string>(s: S): SnakeToCamel<S> {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()) as SnakeToCamel<S>;
}
```

**Why it works.** `${infer Head}_${infer Tail}` splits at the first underscore (inference is non-greedy for the first placeholder), and recursing on `Tail` handles any number of segments; `Capitalize` upper-cases each following segment. `CamelKeys` is a recursive conditional type: arrays recurse into their element type, `Date` stays as is, objects are remapped with an `as` clause, primitives stop. The runtime needs one cast because TypeScript cannot follow `String.replace`.

**Say it.** I split the string type at the first underscore with infer, capitalize the recursively converted rest, and apply that to every key with a key-remapping mapped type that recurses through objects and arrays.

**Follow-up.** Q: What about the opposite direction, camelCase to snake_case? A: Walk the string one character at a time: `S extends `${infer C}${infer R}`` and emit `_${Lowercase<C>}` when `C` is an upper-case letter (`C extends Uppercase<C>` and `C` is not `Lowercase<C>`).

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


type ApiOrder = {
  order_id: number;
  created_at: Date;
  billing_address: { zip_code: string };
  order_items: { item_id: number; unit_price: number }[];
  status: 'paid' | 'open';
};

type cases = [
  Expect<Equal<SnakeToCamel<'created_at'>, 'createdAt'>>,
  Expect<Equal<SnakeToCamel<'a_b_c'>, 'aBC'>>,
  Expect<Equal<SnakeToCamel<'id'>, 'id'>>,
  Expect<Equal<
    CamelKeys<ApiOrder>,
    {
      orderId: number;
      createdAt: Date;
      billingAddress: { zipCode: string };
      orderItems: { itemId: number; unitPrice: number }[];
      status: 'paid' | 'open';
    }
  >>,
];

const key = snakeToCamel('created_at');
type keyType = Expect<Equal<typeof key, 'createdAt'>>;
assert.equal(key, 'createdAt');
assert.equal(snakeToCamel('user_id_2'), 'userId2');
assert.equal(snakeToCamel('name'), 'name');

// @ts-expect-error the converted type is 'createdAt', not 'created_at'
const wrong: 'created_at' = snakeToCamel('created_at');
```

</details>

</details>

---

<a id="ts-27"></a>
### ts-27. Counter factory with private state

*Closures · Easy*

Write `createCounter(start = 0)` that returns an object with `increment()`, `decrement()`, `reset()` (each returns the new value) and a read-only `value` getter. The count must be private: there is no way to change it except through these methods. Two counters must not share state.

```ts
const c = createCounter(5);
c.increment()  // 6
c.increment()  // 7
c.reset()      // 5
c.value        // 5
c.count        // undefined / compile error
```

**Starter**

```ts
function createCounter(start = 0) {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function createCounter(start = 0) {
  let count = start; // private: only the closures below can see it

  return {
    increment: () => ++count,
    decrement: () => --count,
    reset: () => (count = start),
    get value() {
      return count;
    },
  };
}
```

**Why it works.** A closure is a function that keeps access to the variables of the scope it was created in, even after that scope has returned. Each call to `createCounter` creates a new `count` variable, so counters are independent, and nothing outside can reach it. This is the module/encapsulation pattern from before classes had `#private` fields; it is also how hooks, memoization and debouncing keep state.

**Say it.** Each call creates a new local variable, and the returned functions close over it, so the state is private and separate per counter.

**Follow-up.** Q: How would you write this with a class and still keep the count private? A: Use a `#count` private field: `class Counter { #count; constructor(start = 0) { this.#count = start } increment() { return ++this.#count } }`. TypeScript's `private` keyword is compile-time only; `#` is enforced at runtime.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const a = createCounter(5);
const b = createCounter();
assert.equal(a.increment(), 6);
assert.equal(a.increment(), 7);
assert.equal(b.decrement(), -1);
assert.equal(a.value, 7);
assert.equal(a.reset(), 5);
assert.equal(b.value, -1);
assert.equal('count' in a, false);
```

</details>

</details>

---

<a id="ts-28"></a>
### ts-28. Implement once()

*Closures · Easy*

Implement `once(fn)`: the returned function calls `fn` the first time only. Every later call returns the result of the first call without calling `fn` again. Keep the argument and return types of `fn`.

```ts
const init = once((name: string) => { console.log('init'); return `ready:${name}`; });
init('db')   // logs 'init', returns 'ready:db'
init('cache') // returns 'ready:db', logs nothing
```

**Starter**

```ts
function once<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function once<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let called = false;
  let result: R;

  return function (this: unknown, ...args: A): R {
    if (!called) {
      called = true; // set before calling, so a re-entrant or throwing call can't run fn twice
      result = fn.apply(this, args);
    }
    return result;
  };
}
```

**Why it works.** The wrapper closes over a `called` flag and the cached `result`. Use a separate boolean rather than checking `result === undefined`, because `fn` may legitimately return `undefined`. Using a regular `function` with `fn.apply(this, args)` forwards `this`, so `once` also works for methods. Generic `A` and `R` keep the exact signature of the wrapped function.

**Say it.** I keep a called flag and the first result in a closure; the first call runs the function and stores the result, every later call just returns it.

**Follow-up.** Q: What if the first call throws? A: In this version the flag is already set, so later calls return `undefined`. If you want retries, set `called = true` only after `fn` returns successfully.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

let calls = 0;
const init = once((name: string) => {
  calls++;
  return `ready:${name}`;
});
assert.equal(init('db'), 'ready:db');
assert.equal(init('cache'), 'ready:db');
assert.equal(calls, 1);

let undefCalls = 0;
const noResult = once(() => {
  undefCalls++;
});
noResult();
noResult();
assert.equal(undefCalls, 1);

const obj = { base: 10, add: once(function (this: { base: number }, n: number) { return this.base + n; }) };
assert.equal(obj.add(5), 15);
assert.equal(obj.add(100), 15);
```

</details>

</details>

---

<a id="ts-29"></a>
### ts-29. Output puzzle: closures in a var vs let loop

*Closures · Easy*

What does `run()` print? Explain why, and give two ways to fix the first loop.

```ts
function run() {
  const fns: Array<() => number> = [];
  for (var i = 0; i < 3; i++) {
    fns.push(() => i);
  }
  console.log(fns.map((f) => f()).join(','));

  const fns2: Array<() => number> = [];
  for (let j = 0; j < 3; j++) {
    fns2.push(() => j);
  }
  console.log(fns2.map((f) => f()).join(','));

  console.log(typeof i, typeof (globalThis as any).j);
}
```

<details>
<summary>Solution</summary>

```ts
function run() {
  const fns: Array<() => number> = [];
  for (var i = 0; i < 3; i++) {
    fns.push(() => i);
  }
  console.log(fns.map((f) => f()).join(','));

  const fns2: Array<() => number> = [];
  for (let j = 0; j < 3; j++) {
    fns2.push(() => j);
  }
  console.log(fns2.map((f) => f()).join(','));

  console.log(typeof i, typeof (globalThis as any).j);
}
```

**Why it works.** It prints `3,3,3`, then `0,1,2`, then `number undefined`. `var` is function-scoped, so there is one `i` shared by all three closures, and they read it after the loop ended at 3. `let` creates a new binding per iteration, so each closure captures its own `j`. `i` is still visible after the loop (function scope) while `j` is not. Fixes for the first loop: use `let`, or capture the value with an IIFE / extra parameter: `fns.push(((n) => () => n)(i))`.

**Say it.** Closures capture variables, not values; var gives one shared variable for the whole function while let gives a fresh binding on every loop iteration.

**Follow-up.** Q: What does `for (var i = 0; i < 3; i++) setTimeout(() => console.log(i))` print? A: `3 3 3`, for the same reason: the callbacks run after the loop and all read the single shared `i`. With `let` it prints `0 1 2`.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

assert.deepEqual(capture(run), ['3,3,3', '0,1,2', 'number undefined']);
```

</details>

</details>

---

<a id="ts-30"></a>
### ts-30. Output puzzle: this with methods, call, bind and arrows

*this binding · Medium*

The file is an ES module (strict mode). What does `run()` print?

```ts
function run() {
  const user = {
    name: 'Ada',
    greet() { return `hi ${this.name}`; },
    greetLater() { return [1].map(() => this.name)[0]; },
  };
  console.log(user.greet());
  const detached = user.greet;
  try { console.log(detached()); } catch (e) { console.log((e as Error).name); }
  console.log(detached.call({ name: 'Bob' }));
  const bound = user.greet.bind({ name: 'Cy' });
  console.log(bound.call({ name: 'Dee' }));
  console.log(user.greetLater());
}
```

<details>
<summary>Solution</summary>

```ts
function run() {
  const user = {
    name: 'Ada',
    greet() {
      return `hi ${this.name}`;
    },
    greetLater() {
      return [1].map(() => this.name)[0];
    },
  };
  console.log(user.greet());
  const detached = user.greet;
  try {
    console.log(detached());
  } catch (e) {
    console.log((e as Error).name);
  }
  console.log(detached.call({ name: 'Bob' }));
  const bound = user.greet.bind({ name: 'Cy' });
  console.log(bound.call({ name: 'Dee' }));
  console.log(user.greetLater());
}
```

**Why it works.** Output: `hi Ada`, `TypeError`, `hi Bob`, `hi Cy`, `Ada`. `this` is decided by how a function is called: `user.greet()` sets `this` to `user`. A detached call has no receiver, so in strict mode `this` is `undefined` and reading `.name` throws a TypeError (in sloppy mode it would be `globalThis`). `call`/`apply` set `this` explicitly, but a bound function ignores any later `this`, so `bind` wins. Arrow functions have no own `this`; they use the `this` of the enclosing method.

**Say it.** For normal functions this is set by the call site: the object before the dot, or call/apply/bind; bind is permanent, and arrow functions just inherit this from where they were defined.

**Follow-up.** Q: How do you fix a method passed as a callback, e.g. `button.addEventListener('click', obj.handle)`? A: Bind it (`obj.handle.bind(obj)`), wrap it (`() => obj.handle()`), or define it as an arrow-function class field so `this` is captured at construction.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

assert.deepEqual(capture(run), ['hi Ada', 'TypeError', 'hi Bob', 'hi Cy', 'Ada']);
```

</details>

</details>

---

<a id="ts-31"></a>
### ts-31. Implement bind (myBind) with partial application

*this binding · Medium*

Implement `myBind(fn, thisArg, ...boundArgs)` as a standalone function that behaves like `Function.prototype.bind`:

- the result calls `fn` with `this` set to `thisArg`
- `boundArgs` are prepended to the arguments of each call (partial application)
- the result's parameter types are the remaining parameters of `fn`

Use `apply` or `call`, not the built-in `bind`.

```ts
function greet(this: { name: string }, greeting: string, mark: string) {
  return `${greeting}, ${this.name}${mark}`;
}
const hello = myBind(greet, { name: 'Ada' }, 'Hello');
hello('!')  // 'Hello, Ada!'   type: (mark: string) => string
```

**Starter**

```ts
function myBind(fn, thisArg, ...boundArgs) {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function myBind<T, A extends unknown[], B extends unknown[], R>(
  fn: (this: T, ...args: [...A, ...B]) => R,
  thisArg: T,
  ...boundArgs: A
): (...args: B) => R {
  return function (...args: B): R {
    return fn.apply(thisArg, [...boundArgs, ...args]);
  };
}
```

**Why it works.** `bind` is a closure: it remembers `fn`, `thisArg` and the bound arguments, and when called it invokes `fn` with `apply`, which sets `this` and spreads the combined arguments. The types use variadic tuples: `fn` takes `[...A, ...B]`, `A` is inferred from the bound arguments, so the returned function accepts only the rest `B`. Calling `.call(other)` on the result does not change `this`, because the inner function ignores its own `this`.

**Say it.** I return a closure that remembers the target this and the first arguments, and calls the original with apply using the bound this and both argument lists concatenated.

**Follow-up.** Q: What does the real `bind` do when the bound function is called with `new`? A: It ignores `thisArg` and constructs a new instance of `fn`. To support that, check `new.target` (or `this instanceof bound`) and call `new fn(...args)` in that case.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


function greet(this: { name: string }, greeting: string, mark: string) {
  return `${greeting}, ${this.name}${mark}`;
}

const hello = myBind(greet, { name: 'Ada' }, 'Hello');
type cases = [Expect<Equal<Parameters<typeof hello>, [mark: string]>>];
assert.equal(hello('!'), 'Hello, Ada!');
assert.equal(hello.call({ name: 'Bob' } as never, '?'), 'Hello, Ada?');

const full = myBind(greet, { name: 'Lin' });
assert.equal(full('Hi', '.'), 'Hi, Lin.');

const add = (a: number, b: number, c: number) => a + b + c;
assert.equal(myBind(add, null, 1, 2)(3), 6);

// @ts-expect-error mark must be a string
hello(42);
```

</details>

</details>

---

<a id="ts-32"></a>
### ts-32. Output puzzle: ==, ===, NaN and Object.is

*Equality · Easy*

What does `run()` print, line by line? (`loose` and `strict` exist only so TypeScript lets us compare unrelated types.)

```ts
const loose = (a: unknown, b: unknown) => a == b;
const strict = (a: unknown, b: unknown) => a === b;

function run() {
  console.log(loose(0, ''), strict(0, ''));
  console.log(loose(null, undefined), strict(null, undefined));
  console.log(loose('1', 1), loose(null, 0));
  console.log(strict(NaN, NaN), Object.is(NaN, NaN));
  console.log(strict(0, -0), Object.is(0, -0));
  console.log([NaN].includes(NaN), [NaN].indexOf(NaN));
  console.log(strict({}, {}), loose([1, 2], '1,2'));
}
```

<details>
<summary>Solution</summary>

```ts
const loose = (a: unknown, b: unknown) => a == b;
const strict = (a: unknown, b: unknown) => a === b;

function run() {
  console.log(loose(0, ''), strict(0, ''));
  console.log(loose(null, undefined), strict(null, undefined));
  console.log(loose('1', 1), loose(null, 0));
  console.log(strict(NaN, NaN), Object.is(NaN, NaN));
  console.log(strict(0, -0), Object.is(0, -0));
  console.log([NaN].includes(NaN), [NaN].indexOf(NaN));
  console.log(strict({}, {}), loose([1, 2], '1,2'));
}
```

**Why it works.** Prints: `true false` / `true false` / `true false` / `false true` / `true false` / `true -1` / `false true`. `==` coerces types (`''` -> 0, `'1'` -> 1, an array -> its string), but `null` is loosely equal only to `undefined`, never to 0. `===` compares without coercion; `NaN` is never equal to itself and `0 === -0`. `Object.is` is "same value": it fixes both of those cases. `includes` uses SameValueZero (finds NaN), `indexOf` uses `===` (does not). Objects are compared by reference.

**Say it.** Triple equals compares without coercion except for the NaN and minus-zero quirks, which Object.is fixes; double equals coerces, but null only equals undefined.

**Follow-up.** Q: Is there a legitimate use of `==`? A: `x == null` is a common idiom for "null or undefined" in one check. Elsewhere use `===`; most lint configs (eqeqeq with the "null: ignore" option) allow exactly that exception.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

assert.deepEqual(capture(run), [
  'true false',
  'true false',
  'true false',
  'false true',
  'true false',
  'true -1',
  'false true',
]);
```

</details>

</details>

---

<a id="ts-33"></a>
### ts-33. Output puzzle: hoisting and the temporal dead zone

*Hoisting and TDZ · Easy*

What does `run()` print? TypeScript rejects most of these lines at compile time (the solution marks them with `@ts-expect-error`); the question is what JavaScript does at runtime.

```ts
function run() {
  console.log(typeof declared);
  console.log(v);
  try { console.log(l); } catch (e) { console.log((e as Error).name); }
  try { expr(); } catch (e) { console.log((e as Error).name); }
  console.log(typeof notDeclaredAnywhere);
  var v = 1;
  let l = 2;
  function declared() {}
  var expr = function () {};
}
```

<details>
<summary>Solution</summary>

```ts
function run() {
  console.log(typeof declared);
  // @ts-expect-error TS: used before being assigned
  console.log(v);
  try {
    // @ts-expect-error TS catches use before declaration
    console.log(l);
  } catch (e) {
    console.log((e as Error).name);
  }
  try {
    // @ts-expect-error TS: used before being assigned
    expr();
  } catch (e) {
    console.log((e as Error).name);
  }
  // @ts-expect-error TS: cannot find name
  console.log(typeof notDeclaredAnywhere);
  var v = 1;
  let l = 2;
  function declared() {}
  var expr = function () {};
}
```

**Why it works.** Prints: `function`, `undefined`, `ReferenceError`, `TypeError`, `undefined`. Function declarations are hoisted with their body, so they can be called before they appear. `var` is hoisted and initialized to `undefined`. `let`/`const`/`class` are hoisted but uninitialized: reading them before the declaration is a ReferenceError (the temporal dead zone). `expr` is a `var` holding `undefined` at that point, so calling it is a TypeError ("expr is not a function"). `typeof` on a name that was never declared returns `'undefined'` instead of throwing (but `typeof` on a TDZ variable does throw).

**Say it.** Declarations are hoisted to the top of their scope: function declarations fully, var as undefined, and let and const stay uninitialized in the temporal dead zone until their line runs.

**Follow-up.** Q: Why does the TDZ exist? A: It makes `const` meaningful (you cannot observe it before it has its value) and turns use-before-declaration bugs into loud errors instead of silent `undefined`.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

assert.deepEqual(capture(run), ['function', 'undefined', 'ReferenceError', 'TypeError', 'undefined']);
```

</details>

</details>

---

<a id="ts-34"></a>
### ts-34. Implement map, filter and reduce

*Array methods · Easy*

Implement standalone, typed versions of `map`, `filter` and `reduce` without using the built-in ones.

- callbacks receive `(item, index, array)`
- `filter` with a type-guard callback must narrow the result type
- `reduce(arr, fn, initial)` takes a required initial value

```ts
map([1, 2, 3], (n) => n * 2)                 // [2, 4, 6]
filter([1, 'a', 2], (x): x is number => typeof x === 'number') // [1, 2]: number[]
reduce([1, 2, 3], (sum, n) => sum + n, 0)     // 6
```

**Starter**

```ts
function map<T, U>(arr: readonly T[], fn: (item: T, index: number, array: readonly T[]) => U): U[] {}
function filter<T>(arr: readonly T[], pred: (item: T, index: number, array: readonly T[]) => boolean): T[] {}
function reduce<T, U>(arr: readonly T[], fn: (acc: U, item: T, index: number, array: readonly T[]) => U, initial: U): U {}
```

<details>
<summary>Solution</summary>

```ts
type Callback<T, R> = (item: T, index: number, array: readonly T[]) => R;

function map<T, U>(arr: readonly T[], fn: Callback<T, U>): U[] {
  const out: U[] = [];
  for (let i = 0; i < arr.length; i++) out.push(fn(arr[i], i, arr));
  return out;
}

function filter<T, S extends T>(arr: readonly T[], pred: (item: T, index: number, array: readonly T[]) => item is S): S[];
function filter<T>(arr: readonly T[], pred: Callback<T, unknown>): T[];
function filter<T>(arr: readonly T[], pred: Callback<T, unknown>): T[] {
  const out: T[] = [];
  for (let i = 0; i < arr.length; i++) {
    if (pred(arr[i], i, arr)) out.push(arr[i]);
  }
  return out;
}

function reduce<T, U>(
  arr: readonly T[],
  fn: (acc: U, item: T, index: number, array: readonly T[]) => U,
  initial: U,
): U {
  let acc = initial;
  for (let i = 0; i < arr.length; i++) acc = fn(acc, arr[i], i, arr);
  return acc;
}
```

**Why it works.** Each is a simple loop; the interesting part is the types. `map` has a second type parameter for the output, `reduce`'s accumulator type `U` is inferred from the initial value, and `filter` has an overload that accepts a type-guard predicate (`item is S`) so the result narrows, which is exactly how the built-in `Array.prototype.filter` is typed. None of them mutate the input. `reduce` without an initial value uses the first element and throws on an empty array, which is why requiring `initial` is safer.

**Say it.** They are plain loops that build a new array or accumulator; the typing work is a separate output type for map, an accumulator type inferred from the initial value, and a type-guard overload for filter.

**Follow-up.** Q: How would you support `reduce` without an initial value? A: Add an overload `reduce<T>(arr, fn: (acc: T, item: T) => T): T`; start from `arr[0]` and index 1, and throw `TypeError('Reduce of empty array with no initial value')` when the array is empty.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


assert.deepEqual(map([1, 2, 3], (n) => n * 2), [2, 4, 6]);
assert.deepEqual(map(['a', 'b'], (s, i) => `${i}:${s}`), ['0:a', '1:b']);

const mixed: (number | string)[] = [1, 'a', 2];
const nums = filter(mixed, (x): x is number => typeof x === 'number');
type cases = [Expect<Equal<typeof nums, number[]>>];
assert.deepEqual(nums, [1, 2]);
assert.deepEqual(filter([1, 2, 3, 4], (n) => n % 2 === 0), [2, 4]);

assert.equal(reduce([1, 2, 3], (sum, n) => sum + n, 0), 6);
assert.deepEqual(reduce(['a', 'b', 'a'], (acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {} as Record<string, number>), { a: 2, b: 1 });
assert.deepEqual(map([], (x) => x), []);
```

</details>

</details>

---

<a id="ts-35"></a>
### ts-35. Typed groupBy

*Array utilities · Easy*

Implement `groupBy(items, keyFn)` that groups items into an object by the key returned from `keyFn`. The key type should flow through: grouping by a `'paid' | 'open'` field gives an object with those keys. Keep the original order inside each group.

```ts
const orders = [
  { id: 1, status: 'paid' }, { id: 2, status: 'open' }, { id: 3, status: 'paid' },
] as const;
groupBy(orders, (o) => o.status)
// { paid: [{ id: 1, ... }, { id: 3, ... }], open: [{ id: 2, ... }] }
groupBy([1.2, 1.7, 2.3], Math.floor)  // { 1: [1.2, 1.7], 2: [2.3] }
```

**Starter**

```ts
function groupBy<T, K extends PropertyKey>(items: readonly T[], keyFn: (item: T) => K) {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function groupBy<T, K extends PropertyKey>(
  items: readonly T[],
  keyFn: (item: T) => K,
): Partial<Record<K, T[]>> {
  const groups: Partial<Record<K, T[]>> = {};
  for (const item of items) {
    const key = keyFn(item);
    (groups[key] ??= []).push(item);
  }
  return groups;
}
```

**Why it works.** One pass over the items, appending each to the array for its key; `??=` creates the array the first time a key is seen. O(n) time. The return type is `Partial<Record<K, T[]>>` because not every possible key is guaranteed to have items, so callers must handle `undefined`. Node 21+ has the built-in `Object.groupBy(items, fn)` (and `Map.groupBy`), which returns a null-prototype object.

**Say it.** I loop once and push each item into the array for its key, creating the array on first sight; the key type is generic, so the result is typed by the possible keys.

**Follow-up.** Q: When would you return a `Map` instead? A: When keys are not strings (objects, dates) or come from user input; `Map.groupBy` does exactly that and avoids prototype keys like `__proto__`.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


const orders = [
  { id: 1, status: 'paid' },
  { id: 2, status: 'open' },
  { id: 3, status: 'paid' },
] as const;

const byStatus = groupBy(orders, (o) => o.status);
type cases = [Expect<Equal<keyof typeof byStatus, 'paid' | 'open'>>];
assert.deepEqual(byStatus.paid?.map((o) => o.id), [1, 3]);
assert.deepEqual(byStatus.open?.map((o) => o.id), [2]);

assert.deepEqual(groupBy([1.2, 1.7, 2.3], Math.floor), { 1: [1.2, 1.7], 2: [2.3] });
assert.deepEqual(groupBy([], (x: string) => x), {});
assert.deepEqual(groupBy(['apple', 'avocado', 'banana'], (s) => s[0]), { a: ['apple', 'avocado'], b: ['banana'] });
```

</details>

</details>

---

<a id="ts-36"></a>
### ts-36. Chunk an array

*Array utilities · Easy*

Implement `chunk(arr, size)`: split an array into groups of `size`. The last group holds the remaining items. Throw a `RangeError` if `size` is not a positive integer. Do not mutate the input.

```ts
chunk([1, 2, 3, 4, 5], 2)  // [[1, 2], [3, 4], [5]]
chunk(['a', 'b'], 5)       // [['a', 'b']]
chunk([], 3)               // []
chunk([1], 0)              // throws RangeError
```

Typical use: sending database inserts or API calls in batches.

**Starter**

```ts
function chunk<T>(arr: readonly T[], size: number): T[][] {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function chunk<T>(arr: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size <= 0) {
    throw new RangeError(`size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}
```

**Why it works.** Step through the array `size` items at a time and `slice` each window; `slice` clamps the end index, so the last chunk is simply shorter. O(n) time and space. Validate `size`: with 0 the loop would never advance (infinite loop), and a fraction gives odd results.

**Say it.** I step through the array in increments of size and slice each window, after validating size so the loop can't run forever.

**Follow-up.** Q: How would you process 10,000 ids against an API in batches of 100, at most one batch at a time? A: `for (const batch of chunk(ids, 100)) await processBatch(batch);` A sequential `for...of` with `await` keeps one batch in flight; `Promise.all` over the batches would start them all at once.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
assert.deepEqual(chunk(['a', 'b'], 5), [['a', 'b']]);
assert.deepEqual(chunk([1, 2, 3], 1), [[1], [2], [3]]);
assert.deepEqual(chunk([], 3), []);
assert.throws(() => chunk([1], 0), RangeError);
assert.throws(() => chunk([1], 1.5), RangeError);
```

</details>

</details>

---

<a id="ts-37"></a>
### ts-37. Remove duplicates by key

*Array utilities · Easy*

Implement `uniqueBy(items, keyFn)` that keeps the **first** item for each key and preserves order. Also show the one-liner for an array of primitives.

```ts
const users = [
  { id: 1, email: 'a@x.io' },
  { id: 2, email: 'b@x.io' },
  { id: 3, email: 'A@x.io' },
];
uniqueBy(users, (u) => u.email.toLowerCase()).map((u) => u.id)  // [1, 2]
unique([3, 1, 3, 2, 1])  // [3, 1, 2]
```

**Starter**

```ts
function uniqueBy<T, K>(items: readonly T[], keyFn: (item: T) => K): T[] {
  // TODO
}

function unique<T>(items: readonly T[]): T[] {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function uniqueBy<T, K>(items: readonly T[], keyFn: (item: T) => K): T[] {
  const seen = new Set<K>();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
```

**Why it works.** A `Set` gives O(1) membership checks, so the whole pass is O(n) time and O(n) space, versus O(n^2) for `filter` + `findIndex`. Sets keep insertion order, so the first occurrence wins and order is preserved. Sets compare with SameValueZero: primitives by value (NaN equals NaN) but objects by reference, which is why you need a key function for objects.

**Say it.** I track seen keys in a Set and keep an item only the first time its key appears, which is linear time and keeps the original order.

**Follow-up.** Q: What if you want to keep the last occurrence instead? A: Build a `Map` from key to item while iterating (later items overwrite), then return `[...map.values()]`. Note this keeps the position of the first key; to also keep the last position, iterate in reverse and reverse the result.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const users = [
  { id: 1, email: 'a@x.io' },
  { id: 2, email: 'b@x.io' },
  { id: 3, email: 'A@x.io' },
];
assert.deepEqual(uniqueBy(users, (u) => u.email.toLowerCase()).map((u) => u.id), [1, 2]);
assert.deepEqual(uniqueBy(users, (u) => u.id).length, 3);
assert.deepEqual(unique([3, 1, 3, 2, 1]), [3, 1, 2]);
assert.deepEqual(unique([NaN, NaN]), [NaN]);
assert.deepEqual(uniqueBy([], (x: number) => x), []);
```

</details>

</details>

---

<a id="ts-38"></a>
### ts-38. Flatten a nested array to a given depth

*Recursion · Medium*

Implement `flatten(arr, depth = Infinity)` that works like `Array.prototype.flat(depth)` without using `flat`.

```ts
flatten([1, [2, [3, [4]]], 5])     // [1, 2, 3, 4, 5]
flatten([1, [2, [3, [4]]], 5], 1)  // [1, 2, [3, [4]], 5]
flatten([[], [[]]])                // []
```

Then explain how you would avoid a stack overflow on extremely deep input.

**Starter**

```ts
type NestedArray<T> = (T | NestedArray<T>)[];

function flatten<T>(arr: NestedArray<T>, depth = Infinity): (T | NestedArray<T>)[] {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type NestedArray<T> = (T | NestedArray<T>)[];

function flatten<T>(arr: NestedArray<T>, depth = Infinity): (T | NestedArray<T>)[] {
  const out: (T | NestedArray<T>)[] = [];
  for (const item of arr) {
    if (Array.isArray(item) && depth > 0) {
      for (const inner of flatten<T>(item, depth - 1)) out.push(inner);
    } else {
      out.push(item);
    }
  }
  return out;
}

// Iterative version: no recursion, so no call-stack limit (always flattens fully).
function flattenDeep<T>(arr: NestedArray<T>): T[] {
  const stack: (T | NestedArray<T>)[] = [...arr].reverse();
  const out: T[] = [];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (Array.isArray(item)) {
      for (let i = item.length - 1; i >= 0; i--) stack.push(item[i]);
    } else {
      out.push(item);
    }
  }
  return out;
}
```

**Why it works.** Recurse into each element that is an array while depth remains, decrementing depth; anything else is pushed as is. Each element is visited once: O(n) time where n counts all elements at all levels, O(d) extra stack for nesting depth d. Push items in a loop rather than `out.push(...big)`, since spreading a huge array into arguments can itself overflow the stack. For unbounded depth, an explicit stack (reverse-pushed to keep order) removes the recursion limit.

**Say it.** I walk the array and recurse into nested arrays while the depth budget lasts; for arbitrary depth I'd switch to an explicit stack so the call stack can't overflow.

**Follow-up.** Q: How would you type the result exactly, like the built-in `flat`? A: TypeScript's lib uses a recursive conditional type `FlatArray<Arr, Depth>` that counts depth down with a tuple of numbers; in practice `arr.flat(depth)` gives you that for free.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

assert.deepEqual(flatten([1, [2, [3, [4]]], 5]), [1, 2, 3, 4, 5]);
assert.deepEqual(flatten([1, [2, [3, [4]]], 5], 1), [1, 2, [3, [4]], 5]);
assert.deepEqual(flatten([1, [2]], 0), [1, [2]]);
assert.deepEqual(flatten([[], [[]]]), []);
assert.deepEqual(flattenDeep([1, [2, [3, [4]]], 5]), [1, 2, 3, 4, 5]);

let deep: NestedArray<number> = [1];
for (let i = 0; i < 20000; i++) deep = [deep];
assert.deepEqual(flattenDeep(deep), [1]);
```

</details>

</details>

---

<a id="ts-39"></a>
### ts-39. Flatten a nested object to dot paths

*Recursion · Medium*

Implement `flattenObject(obj)` that turns a nested object into a flat one with dot-separated keys. Arrays use their index as a key segment. Empty objects/arrays and non-plain objects (like `Date`) are kept as leaf values.

```ts
flattenObject({ a: { b: { c: 1 } }, d: [10, { e: 2 }], f: {} })
// { 'a.b.c': 1, 'd.0': 10, 'd.1.e': 2, f: {} }
```

Typical use: building `$set` updates for MongoDB, or flattening form errors.

**Starter**

```ts
function flattenObject(obj: Record<string, unknown>): Record<string, unknown> {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const isContainer = Array.isArray(value) || isPlainObject(value);
    if (isContainer && Object.keys(value).length > 0) {
      Object.assign(out, flattenObject(value as Record<string, unknown>, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}
```

**Why it works.** Depth-first recursion carrying the path prefix: containers (plain objects and arrays) with content recurse, everything else is written at the full path. `Object.entries` on an array yields index keys, so arrays work without a special case. Checking the prototype keeps `Date`, `Map` and class instances as leaves; a bare `typeof === 'object'` would turn a Date into an empty result. Keeping empty containers as values avoids silently losing keys. O(total number of nodes) time.

**Say it.** I recurse depth-first, carrying the current path, recursing into non-empty plain objects and arrays and writing every other value at its full dotted path.

**Follow-up.** Q: How would you write `unflatten`? A: For each `path, value`, split on `.` and walk/create nested objects (create an array when the next segment is numeric), then assign the value at the last segment.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

assert.deepEqual(
  flattenObject({ a: { b: { c: 1 } }, d: [10, { e: 2 }], f: {} }),
  { 'a.b.c': 1, 'd.0': 10, 'd.1.e': 2, f: {} },
);
const date = new Date(0);
assert.deepEqual(flattenObject({ user: { createdAt: date, tags: [] } }), { 'user.createdAt': date, 'user.tags': [] });
assert.deepEqual(flattenObject({ x: null, y: undefined }), { x: null, y: undefined });
assert.deepEqual(flattenObject({}), {});
```

</details>

</details>

---

<a id="ts-40"></a>
### ts-40. Get a value by path with a default (lodash.get)

*Object utilities · Medium*

Implement `get(obj, path, defaultValue?)` like lodash's `get`:

- `path` is a string such as `'a.b[0].c'` or an array of keys `['a', 'b', 0, 'c']`
- if any step hits `null`/`undefined`, or the final value is `undefined`, return `defaultValue`
- `null` as a final value is returned as `null` (not the default)

```ts
const data = { a: { b: [{ c: 3 }] }, n: null };
get(data, 'a.b[0].c')          // 3
get(data, ['a', 'b', 0, 'c'])  // 3
get(data, 'a.x.y', 'none')     // 'none'
get(data, 'n', 'none')         // null
```

**Starter**

```ts
function get(obj: unknown, path: string | readonly PropertyKey[], defaultValue?: unknown): unknown {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function toPath(path: string): string[] {
  // 'a.b[0].c' -> ['a', 'b', '0', 'c']
  return path.replace(/\[(\w+)\]/g, '.$1').split('.').filter((part) => part !== '');
}

function get(obj: unknown, path: string | readonly PropertyKey[], defaultValue?: unknown): unknown {
  const keys = typeof path === 'string' ? toPath(path) : path;
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined) return defaultValue;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current === undefined ? defaultValue : current;
}
```

**Why it works.** Normalize the path into a list of keys (brackets become dots), then walk one key at a time, stopping early when the current value is `null` or `undefined`, since indexing those throws. Primitives can still be indexed (`'abc'.length` works), which matches lodash. Only `undefined` triggers the default, so stored `null`, `0` or `''` are returned as they are. This is the same behavior as optional chaining plus `??`, except `??` also replaces `null`.

**Say it.** I normalize the path into an array of keys, walk the object one key at a time, bail out with the default on null or undefined, and return the default only when the final value is undefined.

**Follow-up.** Q: When would you use this instead of `obj?.a?.b?.[0]?.c ?? fallback`? A: When the path is dynamic (from config, a form field name, or a column definition). For static access, optional chaining is clearer and type-checked.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const data = { a: { b: [{ c: 3 }] }, n: null, zero: 0 };
assert.equal(get(data, 'a.b[0].c'), 3);
assert.equal(get(data, ['a', 'b', 0, 'c']), 3);
assert.equal(get(data, 'a.x.y', 'none'), 'none');
assert.equal(get(data, 'n', 'none'), null);
assert.equal(get(data, 'n.deeper', 'none'), 'none');
assert.equal(get(data, 'zero', 5), 0);
assert.deepEqual(get(data, ''), data);
```

</details>

</details>

---

<a id="ts-41"></a>
### ts-41. Deep clone (and why JSON cloning breaks)

*Deep clone · Hard*

Implement `deepClone(value)` that supports plain objects, arrays, `Date`, `RegExp`, `Map`, `Set` and **circular references**. The clone must not share any nested object with the original.

First explain what goes wrong with `JSON.parse(JSON.stringify(x))`.

```ts
const src = { when: new Date(0), tags: new Set(['a']), meta: new Map([['k', { v: 1 }]]) };
const copy = deepClone(src);
copy.when instanceof Date          // true
copy.meta.get('k') !== src.meta.get('k')  // true
const loop: any = { name: 'x' }; loop.self = loop;
const c = deepClone(loop);
c.self === c  // true: cycle preserved, no stack overflow
```

**Starter**

```ts
function deepClone<T>(value: T): T {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function deepClone<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (typeof value !== 'object' || value === null) return value; // primitives and functions
  if (seen.has(value)) return seen.get(value) as T; // circular or shared reference

  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (value instanceof RegExp) return new RegExp(value.source, value.flags) as T;

  if (value instanceof Map) {
    const copy = new Map();
    seen.set(value, copy);
    for (const [k, v] of value) copy.set(deepClone(k, seen), deepClone(v, seen));
    return copy as T;
  }

  if (value instanceof Set) {
    const copy = new Set();
    seen.set(value, copy);
    for (const v of value) copy.add(deepClone(v, seen));
    return copy as T;
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(deepClone(item, seen));
    return copy as T;
  }

  // Plain objects and class instances: keep the prototype, copy own keys (including symbols).
  const copy = Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    copy[key] = deepClone((value as Record<PropertyKey, unknown>)[key], seen);
  }
  return copy;
}
```

**Why it works.** JSON cloning turns Dates into strings, drops `undefined`, functions and symbol keys, turns `Map`/`Set` into `{}`, `NaN`/`Infinity` into `null`, and throws on circular references. The recursive clone handles each built-in explicitly and uses a `WeakMap` from original to copy: register the copy **before** recursing, so a cycle finds the copy in progress instead of recursing forever (this also preserves shared references). O(n) time and space. In real code prefer the built-in `structuredClone`, which handles all of this (but not functions or class prototypes).

**Say it.** I recurse by type, creating a fresh Date, RegExp, Map, Set, array or object, and keep a WeakMap from original to copy, registered before recursing, so cycles and shared references are preserved.

**Follow-up.** Q: What does `structuredClone` not support? A: Functions and DOM nodes (it throws a DataCloneError), and it does not keep class prototypes: a class instance comes back as a plain object. Property getters are read as values.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const src = {
  when: new Date(0),
  re: /ab+c/gi,
  tags: new Set(['a']),
  meta: new Map([['k', { v: 1 }]]),
  list: [{ n: 1 }, [2]],
  missing: undefined,
};
const copy = deepClone(src);
assert.deepEqual(copy, src);
assert.ok(copy.when instanceof Date && copy.when !== src.when);
assert.notEqual(copy.meta.get('k'), src.meta.get('k'));
assert.notEqual(copy.list[0], src.list[0]);
assert.equal(copy.re.flags, 'gi');

type Loop = { name: string; self?: Loop };
const loop: Loop = { name: 'x' };
loop.self = loop;
const loopCopy = deepClone(loop);
assert.equal(loopCopy.self, loopCopy);
assert.notEqual(loopCopy, loop);

const viaJson = JSON.parse(JSON.stringify(src));
assert.equal(typeof viaJson.when, 'string');
assert.deepEqual(viaJson.tags, {});
assert.equal('missing' in viaJson, false);
```

</details>

</details>

---

<a id="ts-42"></a>
### ts-42. Deep equality check

*Deep equal · Medium*

Implement `deepEqual(a, b)` that compares values structurally:

- primitives with `Object.is` semantics (`NaN` equals `NaN`)
- arrays by length and element order
- plain objects by own keys (order does not matter); `{ a: undefined }` is **not** equal to `{}`
- `Date` by time, `Map` and `Set` by contents
- different prototypes are not equal (an array is not equal to `{ 0: 1 }`)

```ts
deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })  // true
deepEqual([1, 2], [2, 1])                               // false
deepEqual(new Date(5), new Date(5))                     // true
```

**Starter**

```ts
function deepEqual(a: unknown, b: unknown): boolean {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();

  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) {
      if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
    }
    return true;
  }

  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const value of a) if (!b.has(value)) return false; // members compared by reference/value
    return true;
  }

  if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  return keysA.every((key) => Object.hasOwn(recB, key) && deepEqual(recA[key], recB[key]));
}
```

**Why it works.** Short-circuit on identical values, reject non-objects, then require the same prototype so arrays, plain objects and Dates cannot be equal to each other. Special-case built-ins whose state is not in own keys (Date, Map, Set), then compare key counts and recurse key by key; `Object.hasOwn` makes `{ a: undefined }` differ from `{ b: undefined }`. Arrays fall through to the key comparison after a length check. O(n) over all nested values; cyclic structures would need a visited map of pairs.

**Say it.** I return early for identical values, require both to be objects with the same prototype, special-case Date, Map and Set, then compare own key counts and recurse into each key.

**Follow-up.** Q: How would you handle circular references? A: Keep a `WeakMap<object, object>` of pairs already being compared; if `a` is already paired with `b`, return true for that branch instead of recursing again.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

assert.equal(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
assert.equal(deepEqual({ x: 1, y: 2 }, { y: 2, x: 1 }), true);
assert.equal(deepEqual([1, 2], [2, 1]), false);
assert.equal(deepEqual(NaN, NaN), true);
assert.equal(deepEqual({ a: undefined }, {}), false);
assert.equal(deepEqual({ a: undefined }, { b: undefined }), false);
assert.equal(deepEqual([1], { 0: 1 }), false);
assert.equal(deepEqual(new Date(5), new Date(5)), true);
assert.equal(deepEqual(new Map([['k', { v: 1 }]]), new Map([['k', { v: 1 }]])), true);
assert.equal(deepEqual(new Set([1, 2]), new Set([2, 3])), false);
assert.equal(deepEqual(null, {}), false);
```

</details>

</details>

---

<a id="ts-43"></a>
### ts-43. Deep merge config objects safely

*Deep merge · Medium*

Implement `deepMerge(defaults, overrides)` that returns a **new** object (typical use: config defaults plus environment overrides). `overrides` is typed as a deep partial of `defaults`.

- nested plain objects are merged recursively
- arrays and all other values from `source` replace those in `target`
- `undefined` values in `source` are ignored
- inputs are not mutated
- must be safe against prototype pollution (`__proto__`, `constructor`, `prototype` keys from untrusted JSON)

```ts
deepMerge({ db: { host: 'localhost', port: 5432 }, tags: ['a'] },
          { db: { port: 6543 }, tags: ['b'] })
// { db: { host: 'localhost', port: 6543 }, tags: ['b'] }
```

**Starter**

```ts
type PlainObject = Record<string, unknown>;
type DeepPartial<T> = { [K in keyof T]?: T[K] extends PlainObject ? DeepPartial<T[K]> : T[K] };

function deepMerge<T extends PlainObject>(target: T, source: DeepPartial<T>): T {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type PlainObject = Record<string, unknown>;
type DeepPartial<T> = { [K in keyof T]?: T[K] extends PlainObject ? DeepPartial<T[K]> : T[K] };

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function deepMerge<T extends PlainObject>(target: T, source: DeepPartial<T>): T {
  const out: PlainObject = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (FORBIDDEN_KEYS.has(key) || value === undefined) continue;
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }
  return out as T;
}
```

**Why it works.** Copy the target, then for each source key either recurse (both sides are plain objects) or overwrite. Recursion always builds new objects, so neither input is mutated, though leaf values like arrays are shared by reference. Prototype pollution: `JSON.parse('{"__proto__": {"isAdmin": true}}')` creates an own `__proto__` key, and a naive merge does `target['__proto__']`, which is `Object.prototype`, then writes into it, affecting every object in the process. Skipping dangerous keys (or merging into `Object.create(null)`) prevents that.

**Say it.** I shallow-copy the target and for each source key either recurse when both sides are plain objects or overwrite, skipping undefined values and the __proto__, constructor and prototype keys to block prototype pollution.

**Follow-up.** Q: Why not type it as `deepMerge<T, S>(target: T, source: S): T & S` like `Object.assign`? A: When a key exists in both with different types, the intersection collapses to `never` (e.g. `boolean & undefined`). Typing the source as `DeepPartial<T>` matches the defaults-plus-overrides use case; merging unrelated shapes needs a recursive mapped type where S's keys win.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const base = { db: { host: 'localhost', port: 5432 }, tags: ['a'], debug: false };
const merged = deepMerge(base, { db: { port: 6543 }, tags: ['b'], debug: undefined });
assert.deepEqual(merged, { db: { host: 'localhost', port: 6543 }, tags: ['b'], debug: false });
assert.equal(base.db.port, 5432); // not mutated
assert.notEqual(merged.db, base.db);

const evil = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}');
const safe = deepMerge({}, evil);
assert.equal(({} as Record<string, unknown>).polluted, undefined);
assert.deepEqual(Object.keys(safe), []);
assert.deepEqual(deepMerge<PlainObject>({ a: { b: 1 } }, { a: 'replaced' }), { a: 'replaced' });
```

</details>

</details>

---

<a id="ts-44"></a>
### ts-44. Diff two objects: added, removed, changed

*Object diff · Medium*

Implement `diff(before, after)` for an audit log. Return:

```ts
type Diff = {
  added: Record<string, unknown>;
  removed: Record<string, unknown>;
  changed: Record<string, { from: unknown; to: unknown }>;
};
```

Recurse into nested plain objects and report keys as dot paths. Compare other values with `Object.is`, except arrays, which are compared by content (`JSON.stringify` is fine here).

```ts
diff({ name: 'Ada', role: 'dev', address: { city: 'London' } },
     { name: 'Ada', address: { city: 'Paris' }, age: 36 })
// { added: { age: 36 }, removed: { role: 'dev' },
//   changed: { 'address.city': { from: 'London', to: 'Paris' } } }
```

**Starter**

```ts
type Diff = {
  added: Record<string, unknown>;
  removed: Record<string, unknown>;
  changed: Record<string, { from: unknown; to: unknown }>;
};

function diff(before: Record<string, unknown>, after: Record<string, unknown>): Diff {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
type Diff = {
  added: Record<string, unknown>;
  removed: Record<string, unknown>;
  changed: Record<string, { from: unknown; to: unknown }>;
};

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return Object.is(a, b);
}

function diff(before: Plain, after: Plain, prefix = '', result?: Diff): Diff {
  const out: Diff = result ?? { added: {}, removed: {}, changed: {} };
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const inBefore = Object.hasOwn(before, key);
    const inAfter = Object.hasOwn(after, key);
    const from = before[key];
    const to = after[key];

    if (!inBefore) out.added[path] = to;
    else if (!inAfter) out.removed[path] = from;
    else if (isPlainObject(from) && isPlainObject(to)) diff(from, to, path, out);
    else if (!sameValue(from, to)) out.changed[path] = { from, to };
  }
  return out;
}
```

**Why it works.** Take the union of keys from both objects and classify each: only in `after` is added, only in `before` is removed, both plain objects means recurse with the extended path, otherwise compare values. Use `Object.hasOwn` rather than `!== undefined` so a key explicitly set to `undefined` still counts as present. One shared result object is passed down the recursion. O(total keys) time.

**Say it.** I take the union of keys, classify each as added, removed or present in both, recurse into nested plain objects with a dotted path, and record a change when the leaf values differ.

**Follow-up.** Q: How would you diff arrays of objects, e.g. order line items? A: Match items by a stable id rather than by index, then report added, removed and changed items per id; index-based diffs produce noise when an item is inserted at the front.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

assert.deepEqual(
  diff({ name: 'Ada', role: 'dev', address: { city: 'London' } }, { name: 'Ada', address: { city: 'Paris' }, age: 36 }),
  { added: { age: 36 }, removed: { role: 'dev' }, changed: { 'address.city': { from: 'London', to: 'Paris' } } },
);
assert.deepEqual(diff({ tags: ['a'] }, { tags: ['a'] }), { added: {}, removed: {}, changed: {} });
assert.deepEqual(diff({ tags: ['a'] }, { tags: ['a', 'b'] }).changed, { tags: { from: ['a'], to: ['a', 'b'] } });
assert.deepEqual(diff({ a: { b: 1 } }, { a: 5 }).changed, { a: { from: { b: 1 }, to: 5 } });
assert.deepEqual(diff({ x: undefined }, {}).removed, { x: undefined });
assert.deepEqual(diff({}, {}), { added: {}, removed: {}, changed: {} });
```

</details>

</details>

---

<a id="ts-45"></a>
### ts-45. Convert API payload keys: snake_case <-> camelCase

*Data transformation · Medium*

Your Postgres/REST layer uses `snake_case`, your TS code uses `camelCase`. Implement:

- `camelizeKeys(value)`: converts every object key deeply (inside arrays too)
- `snakifyKeys(value)`: the reverse
- values (including `Date`s and strings) are not touched; only plain objects get their keys converted

```ts
camelizeKeys({ user_id: 1, order_items: [{ unit_price: 9.5 }], created_at: date })
// { userId: 1, orderItems: [{ unitPrice: 9.5 }], createdAt: date }
snakifyKeys({ userId: 1, isAdmin: true })
// { user_id: 1, is_admin: true }
```

**Starter**

```ts
function camelizeKeys(value: unknown): unknown {
  // TODO
}

function snakifyKeys(value: unknown): unknown {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
const toCamel = (key: string) => key.replace(/_+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const toSnake = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function convertKeys(value: unknown, convert: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => convertKeys(item, convert));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [convert(key), convertKeys(v, convert)]),
    );
  }
  return value; // primitives, Dates, Buffers, class instances stay as they are
}

const camelizeKeys = (value: unknown) => convertKeys(value, toCamel);
const snakifyKeys = (value: unknown) => convertKeys(value, toSnake);
```

**Why it works.** One generic recursive walker takes the key-conversion function as a parameter: arrays map their items, plain objects are rebuilt with converted keys via `Object.fromEntries`, everything else is returned untouched. Checking for a plain prototype matters: treating a `Date` as an object would turn it into `{}`. The regexes: `_x` becomes `X` for camelCase, and an upper-case letter after a lower-case letter or digit gets an underscore for snake_case. Acronyms like `userID` round-trip imperfectly (`user_id` -> `userId`), so pick a convention.

**Say it.** I write one recursive walker that rebuilds plain objects with converted keys and maps over arrays, then pass it either a to-camel or a to-snake string function.

**Follow-up.** Q: Where would you do this conversion in a Node API? A: At the boundary, once: in the database layer (e.g. Knex `postProcessResponse`/`wrapIdentifier`, or a Prisma `@map`) or in one HTTP middleware, not scattered across handlers. The type-level counterpart is a `CamelKeys<T>` mapped type.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

const date = new Date(0);
assert.deepEqual(
  camelizeKeys({ user_id: 1, order_items: [{ unit_price: 9.5 }], created_at: date, note: 'keep_this' }),
  { userId: 1, orderItems: [{ unitPrice: 9.5 }], createdAt: date, note: 'keep_this' },
);
assert.equal((camelizeKeys({ created_at: date }) as { createdAt: Date }).createdAt, date);
assert.deepEqual(snakifyKeys({ userId: 1, isAdmin: true, address2Line: 'x' }), { user_id: 1, is_admin: true, address2_line: 'x' });
assert.deepEqual(snakifyKeys(camelizeKeys({ a_b: { c_d: [1, { e_f: null }] } })), { a_b: { c_d: [1, { e_f: null }] } });
assert.equal(camelizeKeys('plain_string'), 'plain_string');
assert.deepEqual(camelizeKeys([]), []);
```

</details>

</details>

---

<a id="ts-46"></a>
### ts-46. Parse a query string into an object

*Parsing · Medium*

Implement `parseQuery(qs)` without `URLSearchParams`:

- optional leading `?`
- `+` means space, and keys/values are percent-decoded
- repeated keys become an array, in order
- a key without `=` gets the value `''`
- empty segments (`a=1&&b=2`) are skipped

```ts
parseQuery('?a=1&b=2&a=3')        // { a: ['1', '3'], b: '2' }
parseQuery('q=hello+world&x=%26') // { q: 'hello world', x: '&' }
parseQuery('flag&empty=')         // { flag: '', empty: '' }
```

**Starter**

```ts
function parseQuery(qs: string): Record<string, string | string[]> {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function decode(part: string): string {
  return decodeURIComponent(part.replace(/\+/g, ' '));
}

function parseQuery(qs: string): Record<string, string | string[]> {
  const query = qs.startsWith('?') ? qs.slice(1) : qs;
  // A Map avoids clashes with keys like "constructor" or "__proto__".
  const result = new Map<string, string | string[]>();

  for (const segment of query.split('&')) {
    if (segment === '') continue;
    const eq = segment.indexOf('='); // split on the first '=' only: values may contain '='
    const key = decode(eq === -1 ? segment : segment.slice(0, eq));
    const value = eq === -1 ? '' : decode(segment.slice(eq + 1));

    const existing = result.get(key);
    if (existing === undefined) result.set(key, value);
    else if (Array.isArray(existing)) existing.push(value);
    else result.set(key, [existing, value]);
  }
  return Object.fromEntries(result);
}
```

**Why it works.** Split on `&`, then split each pair on the **first** `=` only, because values such as base64 tokens can contain `=`. Replace `+` with a space before `decodeURIComponent`, since `+` means space in form encoding but `decodeURIComponent` leaves it alone. Repeated keys are promoted from a string to an array. Collecting into a `Map` avoids prototype keys like `constructor` being treated as existing values. In production use `new URLSearchParams(qs)` and `getAll`.

**Say it.** I split on ampersands, split each pair on the first equals sign, turn plus into space and percent-decode, and promote a key to an array when it repeats.

**Follow-up.** Q: What happens with malformed input like `%E0%A4%A`? A: `decodeURIComponent` throws a URIError. Wrap the decode in try/catch and fall back to the raw string (or reject the request with 400), so one bad parameter does not crash the handler.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

assert.deepEqual(parseQuery('?a=1&b=2&a=3'), { a: ['1', '3'], b: '2' });
assert.deepEqual(parseQuery('q=hello+world&x=%26'), { q: 'hello world', x: '&' });
assert.deepEqual(parseQuery('flag&empty='), { flag: '', empty: '' });
assert.deepEqual(parseQuery('token=abc==&&a=1'), { token: 'abc==', a: '1' });
assert.deepEqual(parseQuery('constructor=1'), { constructor: '1' });
assert.deepEqual(parseQuery(''), {});
```

</details>

</details>

---

<a id="ts-47"></a>
### ts-47. Typed debounce with cancel and flush

*Closures + timers · Medium*

Implement `debounce(fn, wait)`: the returned function delays calling `fn` until `wait` ms have passed since the **last** call, then calls it once with the latest arguments. It must keep `fn`'s parameter types and also expose:

- `cancel()`: drop the pending call
- `flush()`: run the pending call immediately

```ts
const save = debounce((text: string) => api.save(text), 50);
save('h'); save('he'); save('hel');  // after 50 ms: api.save('hel') once
save(42);                            // compile error
```

**Starter**

```ts
function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number) {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingArgs: A | undefined;

  function invoke() {
    timer = undefined;
    if (pendingArgs === undefined) return;
    const args = pendingArgs;
    pendingArgs = undefined;
    fn(...args);
  }

  function debounced(...args: A): void {
    pendingArgs = args;
    clearTimeout(timer); // restart the wait on every call
    timer = setTimeout(invoke, wait);
  }

  debounced.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    pendingArgs = undefined;
  };

  debounced.flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    invoke();
  };

  return debounced;
}
```

**Why it works.** The closure holds the timer id and the latest arguments; every call clears the previous timer and starts a new one, so `fn` runs only after a quiet period of `wait` ms. Generic `A extends unknown[]` captures the parameter tuple, so callers get type checking. `cancel` and `flush` are attached as properties of the function; TypeScript infers them on a function declaration. `ReturnType<typeof setTimeout>` works in both Node (a `Timeout` object) and browsers (a number). Debounce suits search inputs and autosave; throttle suits scroll or resize (at most once per interval).

**Say it.** Each call stores the latest arguments, clears the existing timer and starts a new one, so the function only fires after the calls stop for wait milliseconds; cancel clears it and flush runs it now.

**Follow-up.** Q: What is the difference between debounce and throttle? A: Debounce waits for a pause and then fires once (the last call wins). Throttle fires at most once per interval during continuous calls, for example the first call and then every 100 ms.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const saved: string[] = [];
const save = debounce((text: string) => saved.push(text), 30);
save('h');
save('he');
save('hel');
assert.deepEqual(saved, []);
await sleep(60);
assert.deepEqual(saved, ['hel']);

save('cancel me');
save.cancel();
await sleep(50);
assert.deepEqual(saved, ['hel']);

save('flushed');
save.flush();
assert.deepEqual(saved, ['hel', 'flushed']);
await sleep(50);
assert.deepEqual(saved, ['hel', 'flushed']); // no second call after flush

type cases = [Expect<Equal<Parameters<typeof save>, [text: string]>>];
const wrong = () => {
  // @ts-expect-error text must be a string
  save(42);
};
```

</details>

</details>

---

<a id="ts-48"></a>
### ts-48. Memoize with a cache key

*Memoization · Medium*

Implement `memoize(fn, keyFn?)`:

- caches results by a key; the default key is `JSON.stringify(args)`
- an optional `keyFn` builds the key from the arguments (e.g. only the user id)
- results that are `undefined` must also be cached
- keeps `fn`'s types and exposes the `cache` (a `Map`) so it can be cleared

```ts
const slowSquare = (n: number) => { calls++; return n * n; };
const fast = memoize(slowSquare);
fast(4); fast(4);   // 16, 16 - slowSquare ran once
const byId = memoize((u: { id: number; name: string }) => u.name.toUpperCase(), (u) => String(u.id));
```

**Starter**

```ts
function memoize<A extends unknown[], R>(fn: (...args: A) => R, keyFn?: (...args: A) => string) {
  // TODO
}
```

<details>
<summary>Solution</summary>

```ts
function memoize<A extends unknown[], R>(
  fn: (...args: A) => R,
  keyFn: (...args: A) => string = (...args) => JSON.stringify(args),
): ((...args: A) => R) & { cache: Map<string, R> } {
  const cache = new Map<string, R>();

  const memoized = (...args: A): R => {
    const key = keyFn(...args);
    if (cache.has(key)) return cache.get(key) as R; // has() so cached undefined still counts
    const result = fn(...args);
    cache.set(key, result);
    return result;
  };

  return Object.assign(memoized, { cache });
}
```

**Why it works.** A closure holds a `Map` from key to result. Check `has` rather than `get(...) !== undefined`, otherwise functions that return `undefined` are recomputed every time. `JSON.stringify(args)` is a reasonable default for primitive arguments, but it is slow for large objects and ignores key order differences, Maps and functions, so a custom `keyFn` is often better. Memoize only pure functions, and remember the cache grows forever unless you add a size limit (LRU) or TTL.

**Say it.** I keep a Map in a closure keyed by a string built from the arguments, return the cached value when the key exists, and otherwise compute, store and return it.

**Follow-up.** Q: How do you memoize an async function safely? A: Cache the promise itself, so concurrent calls share one request, and delete the key if the promise rejects (`p.catch(() => cache.delete(key))`), so a failure is not cached forever.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


let calls = 0;
const fast = memoize((n: number) => {
  calls++;
  return n * n;
});
assert.equal(fast(4), 16);
assert.equal(fast(4), 16);
assert.equal(fast(5), 25);
assert.equal(calls, 2);

let nameCalls = 0;
const byId = memoize(
  (u: { id: number; name: string }) => {
    nameCalls++;
    return u.name.toUpperCase();
  },
  (u) => String(u.id),
);
assert.equal(byId({ id: 1, name: 'ada' }), 'ADA');
assert.equal(byId({ id: 1, name: 'renamed' }), 'ADA'); // same key -> cached
assert.equal(nameCalls, 1);

let undefCalls = 0;
const nothing = memoize((_: string) => {
  undefCalls++;
  return undefined;
});
nothing('a');
nothing('a');
assert.equal(undefCalls, 1);

fast.cache.clear();
fast(4);
assert.equal(calls, 3);

type cases = [Expect<Equal<ReturnType<typeof fast>, number>>];
```

</details>

</details>

---

<a id="ts-49"></a>
### ts-49. Typed pipe and compose

*Function composition · Hard*

Implement `pipe(...fns)`: it returns a function that passes its input through `fns` left to right. The first function may take any arguments; each next function receives the previous result. Types must flow through, and a mismatched chain must not compile. Then implement `compose` (right to left) for single-argument functions.

```ts
const slugify = pipe(
  (s: string) => s.trim(),
  (s) => s.toLowerCase(),
  (s) => s.replace(/\s+/g, '-'),
);
slugify('  Hello World ')   // 'hello-world'   type: (s: string) => string

pipe((n: number) => n * 2, (s: string) => s) // compile error
```

**Starter**

```ts
function pipe(...fns: Array<(arg: any) => any>) {
  // TODO: typed overloads
}
```

<details>
<summary>Solution</summary>

```ts
function pipe<A extends unknown[], B>(f1: (...args: A) => B): (...args: A) => B;
function pipe<A extends unknown[], B, C>(f1: (...args: A) => B, f2: (b: B) => C): (...args: A) => C;
function pipe<A extends unknown[], B, C, D>(
  f1: (...args: A) => B,
  f2: (b: B) => C,
  f3: (c: C) => D,
): (...args: A) => D;
function pipe<A extends unknown[], B, C, D, E>(
  f1: (...args: A) => B,
  f2: (b: B) => C,
  f3: (c: C) => D,
  f4: (d: D) => E,
): (...args: A) => E;
function pipe(
  first: (...args: unknown[]) => unknown,
  ...rest: Array<(arg: unknown) => unknown>
): (...args: unknown[]) => unknown {
  return (...args) => rest.reduce((acc, fn) => fn(acc), first(...args));
}

function compose<T>(...fns: Array<(arg: T) => T>): (arg: T) => T {
  return (arg) => fns.reduceRight((acc, fn) => fn(acc), arg);
}
```

**Why it works.** At runtime pipe is one `reduce`: call the first function with all arguments, then feed each result into the next. The typing is the interview part: each overload introduces one type parameter per step, and TypeScript infers them left to right, so `(s) => s.toLowerCase()` gets `s: string` contextually and a mismatch fails to compile. This is how libraries such as fp-ts, RxJS and lodash type `pipe` (with many overloads). `compose` is `reduceRight`; typing a heterogeneous compose needs the same overloads written in reverse, so here it is limited to `T => T`.

**Say it.** Runtime it is a reduce that threads the value through the functions; for types I write overloads with one generic per step so each function's input is inferred from the previous output.

**Follow-up.** Q: Can you type pipe for any number of functions without overloads? A: Partly: a recursive conditional type can validate a tuple of functions, but inference of untyped lambda parameters (`(s) => ...`) breaks, so overloads remain the practical choice.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


const slugify = pipe(
  (s: string) => s.trim(),
  (s) => s.toLowerCase(),
  (s) => s.replace(/\s+/g, '-'),
);
assert.equal(slugify('  Hello World '), 'hello-world');

const sumThenFormat = pipe(
  (a: number, b: number) => a + b,
  (n) => n * 2,
  (n) => n.toFixed(1),
  (s) => `$${s}`,
);
assert.equal(sumThenFormat(1, 2), '$6.0');

type cases = [
  Expect<Equal<typeof slugify, (s: string) => string>>,
  Expect<Equal<Parameters<typeof sumThenFormat>, [a: number, b: number]>>,
];

const inc = (n: number) => n + 1;
const double = (n: number) => n * 2;
assert.equal(compose(inc, double)(5), 11); // inc(double(5))
assert.equal(pipe(double, inc)(5), 11);
assert.equal(compose<number>()(7), 7);

const bad = () => {
  // @ts-expect-error number result cannot feed a string parameter
  pipe((n: number) => n * 2, (s: string) => s);
};
```

</details>

</details>

---

<a id="ts-50"></a>
### ts-50. Mini zod: validate unknown JSON into a typed object

*Runtime validation · Hard*

Write a tiny schema library (like zod) to validate an `unknown` request body:

- `z.string()`, `z.number()`, `z.boolean()`, `z.array(schema)`, `z.optional(schema)`, `z.object({ ... })`
- `schema.parse(value)` returns `{ success: true, data }` or `{ success: false, errors }`, where errors contain **all** problems with paths, e.g. `'tags[1]: expected string, got number'`
- `Infer<typeof schema>` gives the TypeScript type, so you never write it twice
- unknown object keys are stripped

```ts
const User = z.object({ id: z.number(), email: z.string(), tags: z.array(z.string()) });
type User = Infer<typeof User>; // { id: number; email: string; tags: string[] }
User.parse({ id: 1, email: 2, tags: ['a', 3] })
// { success: false, errors: ['email: expected string, got number', 'tags[1]: expected string, got number'] }
```

**Starter**

```ts
type ParseResult<T> = { success: true; data: T } | { success: false; errors: string[] };
type Schema<T> = { parse(value: unknown, path?: string): ParseResult<T> };
type Infer<S> = unknown; // TODO

const z = {
  // TODO: string, number, boolean, array, optional, object
};
```

<details>
<summary>Solution</summary>

```ts
type ParseResult<T> = { success: true; data: T } | { success: false; errors: string[] };
type Schema<T> = { parse(value: unknown, path?: string): ParseResult<T> };
type Infer<S> = S extends Schema<infer T> ? T : never;

const ok = <T,>(data: T): ParseResult<T> => ({ success: true, data });
const fail = (errors: string[]): { success: false; errors: string[] } => ({ success: false, errors });

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isNaN(value)) return 'NaN';
  return typeof value;
}

function primitive<T>(name: string, check: (v: unknown) => v is T): Schema<T> {
  return {
    parse: (value, path = 'value') =>
      check(value) ? ok(value) : fail([`${path}: expected ${name}, got ${typeName(value)}`]),
  };
}

const z = {
  string: () => primitive('string', (v): v is string => typeof v === 'string'),
  number: () => primitive('number', (v): v is number => typeof v === 'number' && !Number.isNaN(v)),
  boolean: () => primitive('boolean', (v): v is boolean => typeof v === 'boolean'),

  optional<T>(inner: Schema<T>): Schema<T | undefined> {
    return { parse: (value, path) => (value === undefined ? ok(undefined) : inner.parse(value, path)) };
  },

  array<T>(item: Schema<T>): Schema<T[]> {
    return {
      parse(value, path = 'value') {
        if (!Array.isArray(value)) return fail([`${path}: expected array, got ${typeName(value)}`]);
        const data: T[] = [];
        const errors: string[] = [];
        value.forEach((element, i) => {
          const r = item.parse(element, `${path}[${i}]`);
          if (r.success) data.push(r.data);
          else errors.push(...r.errors);
        });
        return errors.length > 0 ? fail(errors) : ok(data);
      },
    };
  },

  object<Shape extends Record<string, Schema<unknown>>>(
    shape: Shape,
  ): Schema<{ [K in keyof Shape]: Infer<Shape[K]> }> {
    type Out = { [K in keyof Shape]: Infer<Shape[K]> };
    return {
      parse(value, path = '') {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          return fail([`${path || 'value'}: expected object, got ${typeName(value)}`]);
        }
        const input = value as Record<string, unknown>;
        const data: Record<string, unknown> = {};
        const errors: string[] = [];
        for (const [key, schema] of Object.entries(shape)) {
          const r = schema.parse(input[key], path ? `${path}.${key}` : key);
          if (r.success) {
            if (r.data !== undefined) data[key] = r.data; // unknown keys are never copied
          } else {
            errors.push(...r.errors);
          }
        }
        return errors.length > 0 ? fail(errors) : ok(data as Out);
      },
    };
  },
};
```

**Why it works.** Each schema is an object with a `parse` method that carries its output type in `Schema<T>`; combinators (`array`, `object`, `optional`) build bigger schemas from smaller ones, and `Infer` extracts `T` with `infer`, so the type and the runtime check come from one definition. `object` maps the shape type through `Infer`. Collecting errors instead of returning on the first one gives useful 400 responses, and passing the path down produces messages like `tags[1]`. Copying only declared keys strips unexpected fields (mass-assignment protection). `typeof NaN === 'number'`, so the number check excludes it.

**Say it.** Every schema is a parse function tagged with its output type; combinators compose them and pass a path down for error messages, and Infer pulls the static type out, so validation and types share one source of truth.

**Follow-up.** Q: Why validate at all if the API has TypeScript types? A: Types are erased at runtime; a request body or third-party response can be anything. Validate once at the boundary (request handler, env vars, external APIs), and inside the app you can trust the types.

<details>
<summary>Tests</summary>

```ts
import assert from 'node:assert/strict';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;


const User = z.object({
  id: z.number(),
  email: z.string(),
  tags: z.array(z.string()),
  nickname: z.optional(z.string()),
  address: z.object({ city: z.string() }),
});
type User = Infer<typeof User>;

type cases = [
  Expect<Equal<User, {
    id: number;
    email: string;
    tags: string[];
    nickname: string | undefined;
    address: { city: string };
  }>>,
];

const good = User.parse({ id: 1, email: 'a@b.c', tags: ['x'], address: { city: 'Kyiv' }, isAdmin: true });
assert.deepEqual(good, { success: true, data: { id: 1, email: 'a@b.c', tags: ['x'], address: { city: 'Kyiv' } } });
if (good.success) {
  const email: string = good.data.email;
  assert.equal(email, 'a@b.c');
}

assert.deepEqual(User.parse({ id: 1, email: 2, tags: ['a', 3], address: {} }), {
  success: false,
  errors: [
    'email: expected string, got number',
    'tags[1]: expected string, got number',
    'address.city: expected string, got undefined',
  ],
});
assert.deepEqual(User.parse(null), { success: false, errors: ['value: expected object, got null'] });
assert.deepEqual(z.number().parse(NaN), { success: false, errors: ['value: expected number, got NaN'] });
assert.deepEqual(z.array(z.boolean()).parse([true, false]), { success: true, data: [true, false] });
```

</details>

</details>

---

