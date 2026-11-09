/**
 * OpenTelemetry Distributed Tracing Configuration
 * 
 * Provides distributed tracing across the Fanjin API using OpenTelemetry.
 * Automatically instruments HTTP requests, database queries, and custom operations.
 * 
 * Features:
 * - Automatic instrumentation for Express, HTTP, and popular libraries
 * - Custom span creation for business logic
 * - Trace context propagation across service boundaries
 * - Export to OTLP-compatible backends (Jaeger, Tempo, etc.)
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "./nodeAutoInstrumentations";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME, SEMRESATTRS_SERVICE_VERSION, SEMRESATTRS_DEPLOYMENT_ENVIRONMENT } from "@opentelemetry/semantic-conventions";
import { trace, context, SpanStatusCode, Span } from "@opentelemetry/api";

let sdk: NodeSDK | null = null;

/**
 * Initialize OpenTelemetry SDK
 * 
 * Should be called once at application startup, before importing any instrumented libraries.
 */
export function initializeTracing() {
  // Skip if already initialized or tracing is disabled
  if (sdk !== null || process.env.OTEL_SDK_DISABLED === "true") {
    return;
  }

  const serviceName = process.env.OTEL_SERVICE_NAME || "fanjin-api";
  const serviceVersion = process.env.npm_package_version || "unknown";
  const environment = process.env.NODE_ENV || "development";

  // OTLP endpoint configuration
  const traceEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces";
  const metricsEndpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/metrics";

  // Resource attributes
  const resource = resourceFromAttributes({
    [SEMRESATTRS_SERVICE_NAME]: serviceName,
    [SEMRESATTRS_SERVICE_VERSION]: serviceVersion,
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: environment,
  });

  // Trace exporter
  const traceExporter = new OTLPTraceExporter({
    url: traceEndpoint,
    headers: process.env.OTEL_EXPORTER_OTLP_HEADERS ? JSON.parse(process.env.OTEL_EXPORTER_OTLP_HEADERS) : {},
  });

  // Metrics exporter
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: metricsEndpoint,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS ? JSON.parse(process.env.OTEL_EXPORTER_OTLP_HEADERS) : {},
    }),
    exportIntervalMillis: 60000, // Export every 60 seconds
  });

  // Initialize SDK with auto-instrumentations
  sdk = new NodeSDK({
    resource,
    traceExporter,
    metricReader,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Customize auto-instrumentations
        "@opentelemetry/instrumentation-fs": {
          enabled: false, // Disable file system instrumentation (too noisy)
        },
        "@opentelemetry/instrumentation-http": {
          enabled: true,
          ignoreIncomingRequestHook: (request) => {
            // Ignore health check endpoints to reduce noise
            const url = request.url || "";
            return url.includes("/health") || url.includes("/ready") || url.includes("/metrics");
          },
          ignoreOutgoingRequestHook: (options) => {
            // Ignore internal health checks
            const hostname = typeof options === "string" ? options : options.hostname;
            return hostname === "localhost" || hostname === "127.0.0.1";
          },
        },
        "@opentelemetry/instrumentation-express": {
          enabled: true,
        },
        "@opentelemetry/instrumentation-pg": {
          enabled: false, // We use better-sqlite3, not PostgreSQL
        },
      }),
    ],
  });

  sdk.start();
  console.log("OpenTelemetry tracing initialized:", { serviceName, serviceVersion, environment, traceEndpoint });

  // Graceful shutdown
  process.on("SIGTERM", () => {
    sdk?.shutdown()
      .then(() => console.log("OpenTelemetry SDK shut down successfully"))
      .catch((error) => console.error("Error shutting down OpenTelemetry SDK", error))
      .finally(() => process.exit(0));
  });
}

/**
 * Get the current tracer instance
 */
export function getTracer() {
  const serviceName = process.env.OTEL_SERVICE_NAME || "fanjin-api";
  return trace.getTracer(serviceName);
}

/**
 * Create a new span for a custom operation
 * 
 * Example:
 * ```typescript
 * await withSpan("process-video", { videoId: "123" }, async (span) => {
 *   // Your business logic here
 *   span.setAttribute("frames", 120);
 *   return result;
 * });
 * ```
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, async (span) => {
    try {
      // Add custom attributes
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }
      
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Add attributes to the current active span
 */
export function addSpanAttributes(attributes: Record<string, string | number | boolean>) {
  const span = trace.getActiveSpan();
  if (span) {
    for (const [key, value] of Object.entries(attributes)) {
      span.setAttribute(key, value);
    }
  }
}

/**
 * Add an event to the current active span
 */
export function addSpanEvent(name: string, attributes?: Record<string, string | number | boolean>) {
  const span = trace.getActiveSpan();
  if (span) {
    span.addEvent(name, attributes);
  }
}

/**
 * Record an exception in the current active span
 */
export function recordSpanException(error: Error | unknown) {
  const span = trace.getActiveSpan();
  if (span) {
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.setStatus({ code: SpanStatusCode.ERROR });
  }
}

/**
 * Get trace context for propagation (e.g., to downstream services)
 */
export function getTraceContext(): Record<string, string> {
  const ctx = context.active();
  const span = trace.getSpan(ctx);
  if (!span) {
    return {};
  }

  const spanContext = span.spanContext();
  return {
    "traceparent": `00-${spanContext.traceId}-${spanContext.spanId}-0${spanContext.traceFlags}`,
    "tracestate": spanContext.traceState?.serialize() || "",
  };
}

/**
 * Express middleware to add trace ID to response headers
 */
export function traceContextMiddleware() {
  return (req: any, res: any, next: any) => {
    const span = trace.getActiveSpan();
    if (span) {
      const spanContext = span.spanContext();
      res.setHeader("X-Trace-Id", spanContext.traceId);
      res.setHeader("X-Span-Id", spanContext.spanId);
    }
    next();
  };
}
