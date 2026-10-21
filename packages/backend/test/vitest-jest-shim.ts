// Lets the existing e2e specs (written for Jest) run under Vitest: `jest.spyOn`, `jest.fn`, `jest.restoreAllMocks`, `jest.setTimeout` ...
import { vi } from 'vitest';
(globalThis as any).jest = Object.assign(Object.create(vi), {
  setTimeout: (ms: number) => vi.setConfig({ testTimeout: ms, hookTimeout: ms }),
  requireActual: (m: string) => require(m),
});
