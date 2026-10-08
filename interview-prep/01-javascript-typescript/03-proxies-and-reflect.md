# Proxies and Metaprogramming

Metaprogramming in JavaScript revolves around intercepting and defining custom behavior for fundamental operations (e.g., property lookup, assignment, enumeration, function invocation). The two main APIs for this are `Proxy` and `Reflect`.

---

## 1. The Proxy Object

A `Proxy` wraps an object and intercepts operations performed on it.

```javascript
const proxy = new Proxy(target, handler);
```
- **`target`**: The original object you want to proxy.
- **`handler`**: An object containing "traps" (functions) that intercept operations.

### Common Traps

| Trap | Intercepts | Typical Use Cases |
|---|---|---|
| `get(target, prop, receiver)` | Property reading (`proxy.x`) | Default values, private property hiding, computed properties, method binding. |
| `set(target, prop, value, receiver)` | Property writing (`proxy.x = 1`) | **Validation**, data binding/reactivity (e.g., Vue 3), preventing illegal state. |
| `has(target, prop)` | The `in` operator (`'x' in proxy`) | Hiding properties from existence checks. |
| `deleteProperty(target, prop)` | `delete proxy.x` | Preventing deletion of critical properties. |
| `apply(target, thisArg, argumentsList)` | Function call (`proxy()`) | Wrapping functions, logging, mocking. |

### Example: Type Validation (Schema-less validation)

A very common senior-level question or pattern is enforcing types at runtime without TypeScript, usually based on property names or metadata.

```javascript
function createValidatedObject(obj) {
  // Validate existing properties on creation
  for (const [key, value] of Object.entries(obj)) {
    checkType(key, value);
  }

  return new Proxy(obj, {
    set(target, property, value) {
      // 1. Intercept the write
      checkType(property, value);
      
      // 2. Perform the write
      target[property] = value;
      
      // 3. Return true to indicate success in strict mode
      return true; 
    }
  });
}

function checkType(key, value) {
  if (key.endsWith('_int') && !Number.isInteger(value)) {
    throw new TypeError(`Property ${key} must be an integer.`);
  }
}
```

---

## 2. The Reflect API

`Reflect` is a built-in object that provides methods for interceptable JavaScript operations. Its methods match exactly with the `Proxy` handler traps.

**Why use `Reflect`?**
When you write a Proxy trap, you often want to perform the *default* behavior after doing your custom logic. `Reflect` makes this safe and ergonomic.

```javascript
const proxy = new Proxy(target, {
  set(target, prop, value, receiver) {
    console.log(`Setting ${prop} to ${value}`);
    // Instead of: target[prop] = value;
    // Do this:
    return Reflect.set(target, prop, value, receiver);
  },
  get(target, prop, receiver) {
    // Forward the operation, maintaining the correct 'this' binding
    return Reflect.get(target, prop, receiver);
  }
});
```

### The `receiver` parameter and `this`

The `receiver` parameter in `get`/`set` traps points to the object that *originally received the call* (usually the proxy itself, but could be an object inheriting from the proxy). 

If your target object has getters/setters, using `target[prop]` inside the trap will evaluate the getter with `this` bound to the `target`, bypassing the proxy for any nested calls! 

Using `Reflect.get(target, prop, receiver)` ensures that `this` inside the getter remains bound to the `receiver` (the proxy), so nested property accesses continue to be trapped.

---

## 3. Real-world Use Cases

1. **Reactivity (Vue 3, MobX):** Proxies replaced `Object.defineProperty` to track property access (`get`) to build dependency graphs, and intercept changes (`set`) to trigger re-renders. Proxies can detect new property additions and array index mutations, which `defineProperty` couldn't.
2. **Schema Validation:** ORMs and state libraries use `set` traps to prevent invalid data shapes.
3. **Mocks and Spies:** Testing frameworks (like Jest) use Proxies to record function calls (`apply` trap) or intercept property access on mock objects.
4. **API Clients:** You can build SDKs where calling `api.users.get()` translates dynamically to `GET /users`, by trapping the `get` operation for any arbitrary property name and returning a function.

---

## 4. Interview Q&A

**Q: Why did Vue 3 switch from `Object.defineProperty` to `Proxy`?**
A: `Object.defineProperty` only intercepts existing properties. It cannot detect when new properties are added or when array indices are modified directly. Proxies intercept operations on the object itself, correctly handling property additions, deletions, and all array mutations.

**Q: What is the `Reflect` API used for in Proxies?**
A: `Reflect` provides the default implementation of internal object methods. It ensures correct forwarding of operations (especially preserving the correct `this` context via the `receiver` argument for getters/setters) and returns boolean success flags instead of throwing errors (like `Object.defineProperty` would in strict mode).

**Q: Can you polyfill a Proxy?**
A: No. Proxies hook into the language's internal execution mechanisms (`[[Get]]`, `[[Set]]`). You cannot fully simulate this with older ES5 constructs (you can only fake it partially with `defineProperty` for known keys).
