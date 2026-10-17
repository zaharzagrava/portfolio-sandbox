const restores = new Set<() => void>();

/** A stub registers how to undo itself; `restoreAllStubs()` (the Vitest setup, after every test) runs them all once. */
export function registerStubRestore(restore: () => void): void {
  restores.add(restore);
}

export function restoreAllStubs(): void {
  for (const restore of [...restores]) restore();
  restores.clear();
}
