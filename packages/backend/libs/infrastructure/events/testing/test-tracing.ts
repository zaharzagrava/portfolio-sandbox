import { node, tracing } from '@opentelemetry/sdk-node';
import { context, propagation, trace, Tracer } from '@opentelemetry/api';

/**
 * The OpenTelemetry API keeps its global tracer provider, context manager and propagator on `globalThis`. With one process for all
 * e2e files (Vitest, isolate off) a file that registered a provider and shut it down left a dead global behind: the next file's
 * `register()` was refused, and files that never register anything got spans with new trace ids. So every file starts and ends clean.
 */
function disableGlobals(): void {
  trace.disable();
  context.disable();
  propagation.disable();
}

/**
 * Test code only: registers a real tracer provider (async-local context + W3C propagation) with an in-memory
 * exporter, so specs run code inside an active span and read back finished spans (trace propagation, S53 AS-27).
 */
export function installTestTracing(): {
  tracer: Tracer;
  exporter: InstanceType<typeof tracing.InMemorySpanExporter>;
  shutdown(): Promise<void>;
} {
  const exporter = new tracing.InMemorySpanExporter();
  const provider = new node.NodeTracerProvider({
    spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
  });
  disableGlobals();
  provider.register();
  return {
    tracer: trace.getTracer('s53-test'),
    exporter,
    shutdown: async () => {
      await provider.shutdown();
      disableGlobals();
    },
  };
}
