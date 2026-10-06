# React Rendering Model and Performance

---

## 1. Render vs commit

- **Render phase**: React calls your components to compute the new element tree. Pure, no side effects. Can be interrupted (concurrent rendering), and StrictMode runs it twice in development.
- **Reconciliation**: diffing the new tree against the previous one (the Fiber tree).
- **Commit phase**: applying DOM mutations, then running `useLayoutEffect` (synchronously, before paint), then `useEffect` (after paint).
- "Re-render" doesn't mean "DOM update". Re-rendering is cheap-ish, but large subtrees re-rendering on every keystroke add up.

## 2. Why a component re-renders
1. Its **state** changed (`setState` with a new value; `Object.is` comparison).
2. Its **parent re-rendered**. That's the default, **regardless of props**!
3. A **context** it consumes changed.
4. (An external store subscription via `useSyncExternalStore` changed.)

Props changing doesn't *cause* a re-render on its own. The parent re-rendering does. `React.memo` makes a component skip the render when its props are shallowly equal.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`Providers`](../../packages/web/lib/providers.tsx#L9): Providers wraps the app in React Query, theme, tooltip and toast providers, so consuming components re-render when that context changes. _(providers.tsx)_
<!-- theory-links:end -->

## 3. Reconciliation rules
- A different element **type** at the same position unmounts the whole subtree and mounts a new one (state is lost).
- **Keys** identify list items. Using the index as key with reordering, insertion, or deletion causes **state bugs** (an input's value sticks to the wrong row) as well as wasted work. Use stable IDs.
- Changing `key` on purpose is a way to **reset** a component's state (`<Form key={userId} />`).

## 4. Memoization tools
- `React.memo(Component)`: skip the render when props are shallow-equal.
- `useMemo(fn, deps)`: cache an expensive computation, or keep a **referentially stable** object/array to pass to memoized children or effect dependencies.
- `useCallback(fn, deps)`: a stable function reference.
- These only help when **combined**: `useCallback` is pointless if the child isn't memoized or doesn't use the function in its deps.
- **React Compiler** (1.0, 2025) auto-memoizes components and hooks at build time, which removes most manual memoization when enabled. You still need to follow the Rules of React (pure render, no mutation of props or state).

Cheaper structural fixes, often better than memo:
- **Move state down** to the component that needs it.
- **Lift content up / children as props**: `<Layout><ExpensiveTree/></Layout>`. When `Layout`'s state changes, `children` is the same element reference, so it doesn't re-render.
- Split components so fast-changing state (input text) is isolated.

## 5. Effects: correct usage
- Effects synchronize with **external systems** (subscriptions, DOM APIs, network). Many effects are unnecessary ("You Might Not Need an Effect"):
  - Derived data → compute during render (or with `useMemo`), not `useEffect` + `setState`.
  - Responding to a user event → do it in the event handler.
  - Resetting state when a prop changes → use `key`.
- **Race conditions in data fetching**:
  ```tsx
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/users/${id}`, { signal: ctrl.signal }).then(r => r.json()).then(setUser).catch(() => {});
    return () => ctrl.abort();             // stale response for previous id can't overwrite new one
  }, [id]);
  ```
  In real apps, use a query library, which handles this along with caching.
- **Stale closures**: an effect or callback captures old state. Fix with correct dependencies, functional updates (`setCount(c => c + 1)`), refs, or `useEffectEvent` (stable in React 19.2+).
- StrictMode mounts, unmounts, and remounts in development to surface missing cleanups.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`OrdersView`](../../packages/web/app/dashboard/orders/view.tsx#L7): OrdersView loads order history through React Query with loading, error and cancel handling, so it doesn't need a hand-written fetch effect. _(view.tsx)_
<!-- theory-links:end -->

## 6. Concurrent features (React 18+)
- **Automatic batching**: multiple `setState` calls in promises, timeouts, and handlers produce one render.
- `useTransition` / `startTransition`: mark updates as **non-urgent** (filtering a big list), so urgent updates like typing stay responsive and React can interrupt the stale render.
- `useDeferredValue`: render with a lagging copy of a value.
- **Suspense**: declarative loading states for lazy components and data (with frameworks or `use(promise)`); streaming SSR with selective hydration.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`ProductLoading`](../../packages/web/app/products/%5Bslug%5D/loading.tsx#L3): ProductLoading renders skeleton placeholders as the Suspense/loading fallback for the product page. _(loading.tsx)_
> - [`ChatPage`](../../packages/web/app/chat/page.tsx#L5): ChatPage wraps ChatView in a Suspense boundary. _(page.tsx)_
> - [`DashboardLayout`](../../packages/web/app/dashboard/layout.tsx#L8): DashboardLayout wraps dashboard content in Suspense with a streaming shell. _(layout.tsx)_
<!-- theory-links:end -->

## 7. Lists and large UIs
- **Virtualization** (TanStack Virtual, react-window) for long lists: render only the visible rows.
- Pagination or infinite scroll with cursors.
- Avoid passing new object or array literals to memoized rows.

## 8. Bundle and loading performance
- Code splitting: `React.lazy` + Suspense, route-based splitting (Next does this automatically).
- Analyze bundles (`@next/bundle-analyzer`), and drop heavy dependencies (moment → date-fns/Temporal, lodash → per-method imports or native).
- Images: proper sizes, modern formats, lazy loading. Fonts: `font-display: swap`, subsetting.
- **Core Web Vitals**: **LCP** < 2.5 s (largest content paint), **INP** < 200 ms (Interaction to Next Paint, which **replaced FID in March 2024**), **CLS** < 0.1 (layout shift; reserve space for images and ads).
- Measure with field data (RUM, CrUX) rather than only Lighthouse.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`metadata`](../../packages/web/app/layout.tsx#L20): The root layout's metadata constant defines the site title and description for Next.js. _(layout.tsx)_
<!-- theory-links:end -->

## 9. Hydration
- The server renders HTML. The client attaches React to it (hydration). If the content differs (`Date.now()`, `Math.random()`, `window` checks, locale formatting), you get **hydration mismatch** errors.
- Fixes: render consistently, `suppressHydrationWarning` for known differences such as timestamps, or client-only rendering for that part (`useEffect` to set it after mount, or `dynamic(..., { ssr: false })`).

## 10. Profiling
- React DevTools Profiler: "why did this render", commit durations, flame graph.
- Chrome Performance panel for long tasks (>50 ms block the main thread and hurt INP).
- `why-did-you-render` in development.

---

## Interview Q&A

**Q: A parent with a text input makes a big list re-render on every keystroke. Fix it.**
Move the input's state into its own component (state down), or pass the list as `children` so it doesn't re-render with the parent. If the list depends on the input (filtering), memoize the list rows, use `useDeferredValue`/`useTransition` for the filter, and virtualize the list. With React Compiler, the memoization part is automatic.

**Q: Why are index keys bad?**
On insert, delete, or reorder, React maps state and DOM to the wrong items (input values and focus stick to positions instead of items), and it does more work. Use stable unique IDs.

**Q: useEffect vs useLayoutEffect?**
`useLayoutEffect` runs synchronously after DOM mutations but before paint, for measuring layout and avoiding flicker. It blocks paint, so use it sparingly. `useEffect` runs after paint and covers most side effects.
