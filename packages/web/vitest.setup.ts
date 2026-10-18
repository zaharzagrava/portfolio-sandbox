import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { restoreAllStubs } from './lib/test/stub-registry';

// W05 (research R-10): jsdom has no layout, so the virtualised message list renders nothing there. Every test file gets a double
// that renders all rows through the same components; the real scroll behaviour is covered by the visual and journey tests.
vi.mock('react-virtuoso', async () => await import('./tests/support/virtuoso-double'));

/** Shared MSW server: tests add handlers with `server.use(...)`; any unhandled request fails the test. */
export const server = setupServer();

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup();
  restoreAllStubs();
  server.resetHandlers();
});
afterAll(() => server.close());

if (typeof window !== 'undefined') {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;

  class StubObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  globalThis.IntersectionObserver ??= StubObserver as unknown as typeof IntersectionObserver;
  globalThis.ResizeObserver ??= StubObserver as unknown as typeof ResizeObserver;
  globalThis.BroadcastChannel ??= class {
    name: string;
    onmessage = null;
    constructor(name: string) {
      this.name = name;
    }
    postMessage() {}
    close() {}
    addEventListener() {}
    removeEventListener() {}
    dispatchEvent() {
      return false;
    }
  } as unknown as typeof BroadcastChannel;
  // W02: tests replace these per case (`vi.mocked(navigator.geolocation.getCurrentPosition).mockImplementation(...)`).
  if (!('geolocation' in navigator)) {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: vi.fn(), watchPosition: vi.fn(() => 0), clearWatch: vi.fn() },
    });
  }
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.resolve()), readText: vi.fn(() => Promise.resolve('')) },
    });
  }
  Element.prototype.scrollIntoView ??= () => {};  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
}
