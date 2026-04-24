/**
 * OpenTelemetry SDK setup. Imported FIRST in main.ts so the global
 * TracerProvider, ContextManager, and Propagator are registered before
 * the JetStream module instantiates.
 *
 * Spans are exported to the console so you can read them inline. Replace
 * the ConsoleSpanExporter with your real exporter for production
 * (OTLPTraceExporter for Jaeger / Tempo / Datadog Agent / etc.):
 *
 *   import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
 *   const exporter = new OTLPTraceExporter({ url: 'http://localhost:4318/v1/traces' });
 */
import { ConsoleSpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  serviceName: 'distributed-tracing-example',
  spanProcessors: [new SimpleSpanProcessor(new ConsoleSpanExporter())],
});

sdk.start();

// Flush pending spans on graceful shutdown so nothing is lost at exit.
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  try {
    await sdk.shutdown();
  } catch (err) {
    console.error('OTel SDK shutdown failed:', err);
  } finally {
    process.exit(signal === 'SIGINT' ? 130 : 143);
  }
};

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
