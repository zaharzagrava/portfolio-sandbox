import { node, tracing } from '@opentelemetry/sdk-node';
import { trace, Tracer } from '@opentelemetry/api';

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
  provider.register();
  return {
    tracer: trace.getTracer('s53-test'),
    exporter,
    shutdown: () => provider.shutdown(),
  };
}
