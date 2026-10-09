/**
 * Light seam between the OpenTelemetry bootstrap (which must be the first import of `main.ts` and is heavy) and the
 * shutdown sequence: `telemetry.ts` registers how to flush, the `ShutdownRegistry` runs it as its last task (order 95),
 * so spans written while earlier shutdown tasks run are not lost. No process signal handler lives here (S54 FR-047).
 */
let flush: (() => Promise<void>) | undefined;

export function setTelemetryFlush(fn: () => Promise<void>): void {
  flush = fn;
}

/** No-op when telemetry never started (tests, local without OTel). */
export async function flushTelemetry(): Promise<void> {
  await flush?.();
}
