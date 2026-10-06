# React State Management: useState vs useReducer vs Context vs Redux vs Redux Toolkit (+ server state)

> **Covers:** how useReducer, Context and Redux (Toolkit) differ, and when each one fits.

The key insight: **these tools solve different problems.** Some manage *how state updates* (reducers), some handle *how state is delivered* (Context), and some *store state outside React with subscriptions* (Redux and friends). If you separate those three concerns, the comparisons become clear.

---

## 1. The three concerns

| Concern | Question | Tools |
|---|---|---|
| **State container / update logic** | Where does state live, and how does it change? | `useState`, `useReducer`, Redux store, Zustand store |
| **Distribution / transport** | How do deeply nested components get it without prop drilling? | props, **Context**, store subscriptions (`useSelector`) |
| **Server cache** | How do I fetch, cache, dedupe, and invalidate remote data? | TanStack Query, RTK Query, SWR, Apollo |

- **Context is not state management.** It's **dependency injection / transport**. It holds no state and has no update logic. It passes down whatever value you give it (usually state from `useState` or `useReducer`).
- **`useReducer` is not a mini Redux.** It's local component state with reducer-style updates.
- **Redux** = an external store + reducers + a subscription model with selectors + middleware + devtools.
- **Redux Toolkit (RTK)** = the **official, standard way to write Redux** today, which removes the boilerplate and adds best practices and RTK Query.

---

## 2. useState vs useReducer

Both are **local component state**. React actually implements `useState` as a special case of `useReducer` internally.

```tsx
type State = { status: 'idle' | 'loading' | 'error' | 'success'; items: Item[]; error?: string };
type Action =
  | { type: 'fetch' }
  | { type: 'resolved'; items: Item[] }
  | { type: 'rejected'; error: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'fetch':    return { ...state, status: 'loading', error: undefined };
    case 'resolved': return { status: 'success', items: action.items };
    case 'rejected': return { ...state, status: 'error', error: action.error };
  }
}
const [state, dispatch] = useReducer(reducer, { status: 'idle', items: [] });
```

Pick `useReducer` when:
- the next state depends on the previous one in non-trivial ways, or several values change together (no impossible combinations such as `loading && error`),
- you want **event-style updates** ("what happened") rather than setters ("set x to y"),
- you want logic that's **testable as a pure function** outside React,
- you pass `dispatch` deep down: its identity is **stable**, so it doesn't break memoization, unlike inline callbacks.

**What `useReducer` is *not***: it's not global. Each component that calls it gets its **own** state. There's no middleware, no devtools, no selectors, and no access from outside React.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`DeliveryStatus`](../../packages/backend/libs/domains/fulfilment/domain/delivery-state.ts#L1): DeliveryStatus is a closed union of states, and the fulfilment domain updates it through explicit commands, which is the event-style (reducer-like) approach to state. _(delivery-state.ts)_
> - [`DeliveryCommand`](../../packages/backend/libs/domains/fulfilment/domain/delivery-state.ts#L3): DeliveryCommand is a discriminated union of commands (offer, accept, pickUp, deliver, cancel) that drive transitions, matching the 'what happened' action style of useReducer. _(delivery-state.ts)_
<!-- theory-links:end -->

---

## 3. Context: how it actually behaves

```tsx
const CartContext = createContext<CartContextValue | null>(null);

function CartProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(cartReducer, initialCart);
  const value = useMemo(() => ({ state, dispatch }), [state]);    // memoize or every render re-renders consumers
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
```

Rendering behavior, the crucial part:
- When the Provider's `value` changes (by reference), **every component that consumes that context re-renders**, even if it only uses a part of the value that didn't change.
- There are **no selectors**. `useContext(CartContext).state.itemCount` still re-renders on *any* cart change.
- `React.memo` on intermediate components doesn't stop context consumers from updating (context goes around memo).

Mitigations:
- **Split contexts**: a separate `StateContext` and `DispatchContext`. Components that only dispatch never re-render on state changes, since dispatch is stable.
- Split by domain (theme, auth, cart) and by update frequency.
- Push the Provider down as close to the consumers as possible.
- `use-context-selector` (a library) or moving to an external store when you need fine-grained subscriptions.

Context is **perfect** for: low-frequency global values (theme, locale, current user, feature flags), dependency injection (an API client, a service instance), and **scoped** state for a subtree (a multi-step form/wizard, a compound component like `<Tabs>`), where you might even want *several independent instances*.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`AuthProvider`](../../packages/web/hooks/use-auth.tsx#L34): AuthProvider is a React Context provider that exposes the session, login, logout and MFA, which is rarely-changing global state delivered through Context. _(use-auth.tsx)_
> - [`useAuth`](../../packages/web/hooks/use-auth.tsx#L118): useAuth wraps useContext and throws when used outside AuthProvider, the standard way to consume a Context. _(use-auth.tsx)_
<!-- theory-links:end -->

---

## 4. Context + useReducer ("the poor man's Redux")

The combination gives you a shared state with reducer-based updates, available to a subtree. The difference from Redux is in the details:

| Aspect | Context + useReducer | Redux (via RTK) |
|---|---|---|
| Where state lives | inside a React component (Provider) | **external store** outside React tree |
| Re-render granularity | **all consumers** re-render on any change (no selectors) | **only components whose selected slice changed** (`useSelector` with reference equality; implemented via `useSyncExternalStore`) |
| Middleware / side effects | none; effects live in components or custom hooks | thunks, **listener middleware**, sagas/observables; centralized side-effect handling |
| DevTools | React DevTools only | **Redux DevTools**: action log, state diffs, time-travel, action replay |
| Access outside React | no (only via hooks in components) | yes: `store.getState()`, `store.dispatch()` from any module (e.g., websocket handler, auth interceptor) |
| Multiple instances | **yes**, each Provider = own state (great for scoped/reusable widgets) | typically one global store (singleton) |
| Server-side data caching | DIY | **RTK Query** built-in |
| Serializable / persistence | DIY | conventions + redux-persist |
| Boilerplate | low for small cases; grows with features you hand-roll | low with RTK (`createSlice`) |
| Immutable updates | manual spreading | **Immer** (write "mutating" code safely) |
| Dev safety checks | none | RTK dev checks: accidental mutation, non-serializable values |
| Bundle | 0 KB extra | RTK + react-redux (~ 15 KB gz) |
| Testing | reducer pure function testable | same, plus store-level tests |

**One-sentence answer:**
> "Context plus useReducer is fine for state scoped to a subtree or updated rarely, but every consumer re-renders on every change and there's no middleware, devtools, or access outside React. Redux, written with Redux Toolkit, keeps state in an external store where components subscribe through selectors and re-render only when their slice changes. It also gives you middleware for side effects, time-travel debugging, and RTK Query for server data."

---

## 5. Redux core concepts (precisely)

- **Single store**: a tree of state. **Actions**: plain serializable objects describing *what happened*. **Reducers**: pure `(state, action) => newState`. **Dispatch** sends an action through the middleware chain to the root reducer, then notifies subscribers.
- **Selectors**: functions that derive data from state. `useSelector(selectCartCount)` re-runs on every store update, but the component re-renders **only if the return value changed** (`===`). Returning new objects or arrays from a selector causes a re-render every time, so use **memoized selectors** (`createSelector` from Reselect, included in RTK).
- **Middleware**: `store => next => action => ...` intercepts actions for async logic, logging, analytics.
- Unidirectional data flow → predictable state, easy debugging.

---

## 6. Redux Toolkit: what it adds over "classic" Redux

The legacy `createStore` is deprecated in favor of RTK's `configureStore`. Classic Redux (hand-written action types, action creators, switch reducers, manual immutable spreads) is what people complain about. RTK fixes that:

```ts
// cartSlice.ts
import { createSlice, PayloadAction, createSelector } from '@reduxjs/toolkit';

type CartState = { items: Record<string, { id: string; qty: number; priceCents: number }> };

const cartSlice = createSlice({
  name: 'cart',
  initialState: { items: {} } as CartState,
  reducers: {
    added(state, action: PayloadAction<{ id: string; priceCents: number }>) {
      const item = state.items[action.payload.id];
      if (item) item.qty += 1;                                 // "mutation" → Immer produces immutable update
      else state.items[action.payload.id] = { ...action.payload, qty: 1 };
    },
    removed(state, action: PayloadAction<string>) { delete state.items[action.payload]; },
  },
});
export const { added, removed } = cartSlice.actions;            // action creators generated
export default cartSlice.reducer;

export const selectItems = (s: RootState) => s.cart.items;
export const selectTotalCents = createSelector([selectItems],  // memoized derived data
  (items) => Object.values(items).reduce((sum, i) => sum + i.qty * i.priceCents, 0));
```

```ts
// store.ts
export const store = configureStore({
  reducer: { cart: cartReducer, [api.reducerPath]: api.reducer },
  middleware: (gDM) => gDM().concat(api.middleware),           // thunk + dev checks included by default
});                                                             // Redux DevTools wired automatically
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
```

```tsx
// component: re-renders ONLY when total changes
const total = useSelector(selectTotalCents);
const dispatch = useDispatch<AppDispatch>();
<button onClick={() => dispatch(added({ id, priceCents }))}>Add</button>
```

RTK features to name:
- `configureStore`: sensible defaults, devtools, thunk, **immutability and serializability checks** in development.
- `createSlice`: actions plus reducer in one place, with **Immer**.
- `createAsyncThunk`: dispatches pending/fulfilled/rejected lifecycle actions automatically.
- `createEntityAdapter`: **normalized** state (`ids` + `entities`) with CRUD reducers and selectors.
- `createListenerMiddleware`: reacts to actions with side effects (a lighter alternative to sagas).
- **RTK Query**: a data fetching and caching layer (next section).
- `combineSlices` with lazy loading of slices for code-splitting.

---

## 7. Server state vs client state (the modern framing)

Most of what people historically put into Redux was **server cache**: lists of invoices, user profiles. That data has different needs: caching, dedupe, background refetch, staleness, invalidation after mutations, pagination, optimistic updates.

| Tool | Notes |
|---|---|
| **TanStack Query** | framework-agnostic server-state cache: `useQuery({ queryKey, queryFn, staleTime })`, `useMutation` + `invalidateQueries`, optimistic updates, infinite queries, request dedupe |
| **RTK Query** | same idea integrated into Redux store; endpoints defined centrally; **tag-based invalidation** (`providesTags`/`invalidatesTags`); auto-generated hooks; good if you already use Redux |
| SWR | lighter, stale-while-revalidate |
| Apollo/urql | GraphQL normalized caches |

```ts
// RTK Query
export const api = createApi({
  baseQuery: fetchBaseQuery({ baseUrl: '/api' }),
  tagTypes: ['Invoice'],
  endpoints: (b) => ({
    getInvoices: b.query<Invoice[], void>({ query: () => 'invoices', providesTags: ['Invoice'] }),
    approveInvoice: b.mutation<void, string>({
      query: (id) => ({ url: `invoices/${id}/approve`, method: 'POST' }),
      invalidatesTags: ['Invoice'],                       // refetch list automatically
    }),
  }),
});
export const { useGetInvoicesQuery, useApproveInvoiceMutation } = api;
```

Once server state lives in a query cache, what's left as **client state** is usually small: UI state (modals, filters), form state (React Hook Form), and **URL state** (filters and pagination in query params, which makes them shareable and survives reloads). Often local state and Context are enough for that.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`useOrders`](../../packages/web/lib/api/orders.ts#L31): useOrders is a React Query hook that fetches GET /api/orders, so order data is held as server cache instead of in a client store. _(orders.ts)_
> - [`useCancelOrder`](../../packages/web/lib/api/orders.ts#L38): useCancelOrder is a React Query mutation that posts the cancel and then invalidates the orders cache. _(orders.ts)_
> - [`ORDERS_QUERY_KEY`](../../packages/web/lib/api/orders.ts#L16): ORDERS_QUERY_KEY is the query key constant that the orders cache and its invalidation use. _(orders.ts)_
<!-- theory-links:end -->

---

## 8. Other stores worth knowing

- **Zustand**: a minimal external store with selector-based subscriptions (`useStore(s => s.count)`), no Provider needed, tiny. Re-render granularity like Redux with almost no boilerplate. A popular choice in 2024–2026.
- **Jotai / Recoil**: atomic state; components subscribe to individual atoms, with derived atoms.
- **MobX**: observable, mutable state with automatic dependency tracking.
- **XState**: explicit state machines and statecharts for complex flows (checkout, multi-step assessments).
- **Signals** (Preact signals, the TC39 proposal): fine-grained reactivity.

---

## 9. Decision guide

| Situation | Choice |
|---|---|
| State used by one component or its children | `useState` / `useReducer` + props |
| Complex local transitions (form wizard, state machine) | `useReducer` (or XState) |
| Rarely-changing global values (theme, locale, auth user, flags) | **Context** |
| Shared state for one subtree, a few consumers, moderate update frequency | **Context + useReducer** (split state/dispatch contexts) |
| Remote data (lists, entities) | **TanStack Query** or **RTK Query**, not hand-rolled global state |
| Large app, lots of shared client state updated frequently, many devs, need devtools/middleware/predictability | **Redux Toolkit** (or Zustand for lighter needs) |
| Filters, pagination, selected tab that should be shareable | **URL search params** |

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`Providers`](../../packages/web/lib/providers.tsx#L9): Providers wires up the React Query, theme, tooltip and toast providers, which puts the decision guide's choices into practice: Context for global values and a query client for server state. _(providers.tsx)_
> - [`AuthProvider`](../../packages/web/hooks/use-auth.tsx#L34): AuthProvider uses Context for the auth user, an example of the guide's 'rarely-changing global values' row. _(use-auth.tsx)_
<!-- theory-links:end -->

---

## 10. React 19 notes

- `use(Context)` can be called conditionally, and `<Context>` can be used directly as a provider (`<ThemeContext value="dark">`).
- **Actions**: `useActionState`, `useFormStatus`, and `useOptimistic` for form submissions and optimistic UI, which cut down hand-written loading/error state.
- **React Compiler** (stable since late 2025) memoizes automatically, so less manual `useMemo`/`useCallback`. It doesn't change Context's "all consumers re-render" semantics, though it reduces the cost of cascading re-renders.

---

## Interview Q&A

**Q: Is Context + useReducer a replacement for Redux?**
For small apps or scoped state, yes. In general, no, because they differ in kind. Context is a transport mechanism with no selectors, so every consumer re-renders on every change. useReducer is local state, and the pair gives you no middleware, devtools, or out-of-React access. Redux (with RTK) is an external store with selector subscriptions, so only affected components re-render, plus middleware, time-travel devtools, normalized entities, and RTK Query for server caching. I'd use Context for low-frequency global values or subtree-scoped state, a query library for server data, and RTK or Zustand when there's a lot of frequently changing shared client state.

**Q: Difference between useReducer and Redux reducers?**
They're the same concept, a pure function `(state, action) => state`. The difference is where the state lives and how it's shared. useReducer state is local to the component instance. A Redux reducer manages a global external store that any component can subscribe to through selectors, with actions passing through middleware.

**Q: Why does Redux Toolkit exist?**
Classic Redux needed lots of boilerplate (action types, creators, immutable spreads, store setup) and made it easy to mutate state by accident. RTK is the official standard: `configureStore` with good defaults and dev checks, `createSlice` with Immer, `createAsyncThunk`, entity adapters, listener middleware, and RTK Query.

**Q: How do you prevent unnecessary re-renders with Context?**
Memoize the provider value, split contexts by concern and update frequency (state vs dispatch), keep providers close to the consumers, and move to a selector-based store when consumers need different slices of frequently changing data.
