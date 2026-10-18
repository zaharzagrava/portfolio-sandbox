import { vi } from 'vitest';

/**
 * A controllable `IntersectionObserver` for jsdom (W05 T051): the test says which elements are in the visible part of the list.
 * `install()` replaces the global for the test and returns the control; the stub from `vitest.setup.ts` is restored by `restore()`.
 * An element counts as seen when its bottom edge is inside the visible area (`intersectionRect.bottom === boundingClientRect.bottom`).
 */
export type IntersectionControl = {
  /** The element is in the visible area, at least its bottom edge. */
  show: (element: Element) => void;
  /** Only the top of the element is visible (its bottom edge is below the fold). */
  showTopOnly: (element: Element) => void;
  hide: (element: Element) => void;
  observed: () => Element[];
  restore: () => void;
};

export function installIntersectionObserver(): IntersectionControl {
  const original = globalThis.IntersectionObserver;
  const instances: FakeObserver[] = [];

  class FakeObserver {
    targets = new Set<Element>();
    constructor(public callback: IntersectionObserverCallback) {
      instances.push(this);
    }
    observe = (element: Element) => void this.targets.add(element);
    unobserve = (element: Element) => void this.targets.delete(element);
    disconnect = () => this.targets.clear();
    takeRecords = () => [];
  }

  const notify = (element: Element, state: { isIntersecting: boolean; rectBottom: number; visibleBottom: number }) => {
    for (const instance of instances) {
      if (!instance.targets.has(element)) continue;
      const entry = {
        target: element,
        isIntersecting: state.isIntersecting,
        boundingClientRect: { bottom: state.rectBottom },
        intersectionRect: { bottom: state.visibleBottom },
      } as unknown as IntersectionObserverEntry;
      instance.callback([entry], instance as unknown as IntersectionObserver);
    }
  };

  globalThis.IntersectionObserver = vi.fn((callback: IntersectionObserverCallback) => new FakeObserver(callback)) as unknown as typeof IntersectionObserver;

  return {
    show: (element) => notify(element, { isIntersecting: true, rectBottom: 100, visibleBottom: 100 }),
    showTopOnly: (element) => notify(element, { isIntersecting: true, rectBottom: 300, visibleBottom: 120 }),
    hide: (element) => notify(element, { isIntersecting: false, rectBottom: 300, visibleBottom: 0 }),
    observed: () => instances.flatMap((instance) => [...instance.targets]),
    restore: () => {
      globalThis.IntersectionObserver = original;
    },
  };
}
