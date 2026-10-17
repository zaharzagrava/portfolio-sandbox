import { vi } from 'vitest';
import { registerStubRestore } from './stub-registry';

/**
 * `navigator.clipboard` for the reveal-secret dialog and copy buttons (test-plan AS-46, AS-47): `granted` resolves,
 * `denied` rejects with a `NotAllowedError` like a browser that blocks the write. Restored after every test by the Vitest
 * setup file. `written` lists every text passed to `writeText`.
 */
export type ClipboardStub = {
  writeText: ReturnType<typeof vi.fn>;
  written: string[];
  /** Switch the answer of later writes. */
  setMode: (mode: 'granted' | 'denied') => void;
};

export function installClipboardStub(mode: 'granted' | 'denied' = 'granted'): ClipboardStub {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  let current = mode;
  const written: string[] = [];
  const writeText = vi.fn((text: string) => {
    if (current === 'denied') return Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
    written.push(text);
    return Promise.resolve();
  });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText, readText: vi.fn(() => Promise.resolve('')) } });
  registerStubRestore(() => {
    if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });
  return { writeText, written, setMode: (next) => void (current = next) };
}
