// Package consumer is the Go counterpart of PaymentController +
// KafkaConsumerService: consume payments.requests, continue the edge's trace,
// and run each event through the outbox error boundary.
package consumer

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"hash/fnv"
	"log/slog"
	"sync"
	"time"

	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/sasl/plain"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/zaharzagrava/payments/internal/apperr"
	"github.com/zaharzagrava/payments/internal/config"
	"github.com/zaharzagrava/payments/internal/outbox"
	"github.com/zaharzagrava/payments/internal/payment"
	"github.com/zaharzagrava/payments/internal/tracing"
)

const (
	maxRetries          = 3
	redeliveryBaseDelay = 500 * time.Millisecond
	redeliveryMaxDelay  = 30 * time.Second
)

type Consumer struct {
	client  *kgo.Client
	workers int
	payment *payment.Service
	outbox  *outbox.Service
	log     *slog.Logger
}

func New(cfg config.Config, paymentService *payment.Service, outboxService *outbox.Service, log *slog.Logger) (*Consumer, error) {
	opts := []kgo.Opt{
		kgo.SeedBrokers(cfg.KafkaBrokers...),
		kgo.ConsumerGroup(cfg.KafkaGroupID),
		kgo.ConsumeTopics(string(outbox.TopicPaymentsRequests)),
		// Commit only after a whole batch is processed (at-least-once;
		// duplicates are absorbed by the idempotency key).
		kgo.DisableAutoCommit(),
		kgo.BlockRebalanceOnPoll(),
		// kafkajs `fromBeginning: false` equivalent for a brand-new group.
		kgo.ConsumeResetOffset(kgo.NewOffset().AtEnd()),
	}

	if !cfg.IsLocalKafka() {
		opts = append(opts,
			kgo.DialTLSConfig(&tls.Config{MinVersion: tls.VersionTLS12}),
			kgo.SASL(plain.Auth{User: cfg.KafkaAPIKey, Pass: cfg.KafkaAPISecret}.AsMechanism()),
		)
	}

	client, err := kgo.NewClient(opts...)
	if err != nil {
		return nil, err
	}

	return &Consumer{
		client:  client,
		workers: cfg.ConsumerWorkers,
		payment: paymentService,
		outbox:  outboxService,
		log:     log,
	}, nil
}

// Run polls until ctx is cancelled. Each polled batch is sharded by record
// key across `workers` goroutines - the same idempotency key always lands on
// the same goroutine, so per-payment ordering holds while different
// payments proceed in parallel. Offsets are committed only once every
// record in the batch has been handled.
func (c *Consumer) Run(ctx context.Context) error {
	c.log.Info("consuming", "topic", outbox.TopicPaymentsRequests, "workers", c.workers)

	for {
		fetches := c.client.PollFetches(ctx)
		if fetches.IsClientClosed() || ctx.Err() != nil {
			return nil
		}
		fetches.EachError(func(topic string, partition int32, err error) {
			c.log.Error("fetch error", "topic", topic, "partition", partition, "error", err)
		})

		shards := make([][]*kgo.Record, c.workers)
		fetches.EachRecord(func(r *kgo.Record) {
			i := shardFor(r.Key, c.workers)
			shards[i] = append(shards[i], r)
		})

		var wg sync.WaitGroup
		for _, shard := range shards {
			if len(shard) == 0 {
				continue
			}
			wg.Add(1)
			go func(records []*kgo.Record) {
				defer wg.Done()
				for _, r := range records {
					c.handleUntilDone(ctx, r)
				}
			}(shard)
		}
		wg.Wait()

		// Shutting down mid-batch: don't commit - unfinished records will be
		// redelivered to whoever owns the partition next.
		if ctx.Err() != nil {
			return nil
		}

		if err := c.client.CommitUncommittedOffsets(ctx); err != nil {
			c.log.Error("commit offsets", "error", err)
		}
		c.client.AllowRebalance()
	}
}

func (c *Consumer) Close() { c.client.Close() }

// handleUntilDone re-runs a record until the outbox boundary accepts it.
// The boundary only returns an error when it couldn't even write the DLQ
// row (database down) - the equivalent of re-throwing to KafkaJS so the
// message is redelivered instead of lost.
func (c *Consumer) handleUntilDone(ctx context.Context, r *kgo.Record) {
	delay := redeliveryBaseDelay
	for {
		err := c.handle(ctx, r)
		if err == nil || ctx.Err() != nil {
			return
		}

		c.log.Error("event not handled, redelivering", "offset", r.Offset, "delay", delay, "error", err)
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return
		}
		delay = min(delay*2, redeliveryMaxDelay)
	}
}

func (c *Consumer) handle(ctx context.Context, r *kgo.Record) error {
	// Continue the trace the edge worker started (traceparent record header).
	ctx = otel.GetTextMapPropagator().Extract(ctx, recordHeaderCarrier(r.Headers))

	ctx, span := tracing.Tracer().Start(ctx, "PaymentConsumer.handlePayment",
		trace.WithSpanKind(trace.SpanKindConsumer),
		trace.WithAttributes(
			attribute.String("messaging.system", "kafka"),
			attribute.String("messaging.destination", r.Topic),
			attribute.String("messaging.operation", "process"),
			attribute.String("messaging.kafka.idempotency_key", string(r.Key)),
		),
	)
	defer span.End()

	err := c.outbox.WrapInOutbox(ctx, outbox.WrapConfig{
		Payload:    r.Value,
		DLQTopic:   outbox.TopicPaymentsDLQ,
		MaxRetries: maxRetries,
	}, func(ctx context.Context) error {
		var params payment.Params
		if err := json.Unmarshal(r.Value, &params); err != nil {
			return apperr.FatalBadRequest("Malformed payments.requests message: "+err.Error(), err)
		}
		params.Raw = r.Value

		_, err := c.payment.ExecutePayment(ctx, params, outbox.TopicPaymentsResponses)
		return err
	})

	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	return err
}

func shardFor(key []byte, workers int) int {
	if workers == 1 {
		return 0
	}
	h := fnv.New32a()
	_, _ = h.Write(key)
	return int(h.Sum32() % uint32(workers))
}

// recordHeaderCarrier adapts Kafka record headers to otel's TextMapCarrier.
type recordHeaderCarrier []kgo.RecordHeader

func (c recordHeaderCarrier) Get(key string) string {
	for _, h := range c {
		if h.Key == key {
			return string(h.Value)
		}
	}
	return ""
}

func (c recordHeaderCarrier) Set(string, string) {}

func (c recordHeaderCarrier) Keys() []string {
	keys := make([]string, len(c))
	for i, h := range c {
		keys[i] = h.Key
	}
	return keys
}
