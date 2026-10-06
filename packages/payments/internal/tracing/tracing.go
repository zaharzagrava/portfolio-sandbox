// Package tracing sets up OTLP/HTTP export to the same Jaeger collector the
// NestJS apps use (apps/core/src/tracing.ts), plus a RunInSpan helper that
// mirrors payment/tracing.utils.ts.
package tracing

import (
	"context"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

var tracer = otel.Tracer("payment-service")

// Init installs the global tracer provider and W3C propagator. The OTLP
// endpoint comes from OTEL_EXPORTER_OTLP_ENDPOINT (default localhost:4318).
// Returns a shutdown func that flushes pending spans.
func Init(ctx context.Context, serviceName string, enabled bool) (func(context.Context) error, error) {
	otel.SetTextMapPropagator(propagation.TraceContext{})

	if !enabled {
		return func(context.Context) error { return nil }, nil
	}

	exporter, err := otlptracehttp.New(ctx)
	if err != nil {
		return nil, err
	}

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(resource.NewSchemaless(attribute.String("service.name", serviceName))),
	)
	otel.SetTracerProvider(tp)
	tracer = tp.Tracer("payment-service")

	return tp.Shutdown, nil
}

func Tracer() trace.Tracer { return tracer }

// RunInSpan runs fn inside a child span of ctx, recording a returned error.
func RunInSpan[T any](ctx context.Context, name string, fn func(ctx context.Context, span trace.Span) (T, error)) (T, error) {
	ctx, span := tracer.Start(ctx, name)
	defer span.End()

	result, err := fn(ctx, span)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	return result, err
}
