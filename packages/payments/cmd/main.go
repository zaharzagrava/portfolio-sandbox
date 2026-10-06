// Go implementation of the payment processor. Drop-in replacement for
// `nest start payment-processor`: same Kafka topic and consumer group, same
// Postgres tables, same Outbox contract. Run one or the other, not both.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/zaharzagrava/payments/internal/config"
	"github.com/zaharzagrava/payments/internal/consumer"
	"github.com/zaharzagrava/payments/internal/db"
	"github.com/zaharzagrava/payments/internal/outbox"
	"github.com/zaharzagrava/payments/internal/payment"
	"github.com/zaharzagrava/payments/internal/stripe"
	"github.com/zaharzagrava/payments/internal/tracing"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	if err := run(log); err != nil {
		log.Error("payment processor stopped", "error", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	shutdownTracing, err := tracing.Init(ctx, cfg.ServiceName, cfg.OtelEnabled)
	if err != nil {
		return err
	}
	defer func() {
		flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = shutdownTracing(flushCtx)
	}()

	database, err := db.Connect(ctx, cfg.DatabaseURL, cfg.DBMaxConns, cfg.DBSimpleProtocol)
	if err != nil {
		return err
	}
	defer database.Close()

	outboxService := outbox.NewService(database, log)
	stripeClient := stripe.NewClient(stripe.Config{
		SecretKey:  cfg.StripeSecretKey,
		APIVersion: cfg.StripeAPIVersion,
		Timeout:    cfg.StripeTimeout,
		IsLoadTest: cfg.IsLoadTest,
	})
	paymentService := payment.NewService(database, stripeClient, outboxService)

	c, err := consumer.New(cfg, paymentService, outboxService, log)
	if err != nil {
		return err
	}
	defer c.Close()

	log.Info("payment processor started",
		"group", cfg.KafkaGroupID, "workers", cfg.ConsumerWorkers, "load_test", cfg.IsLoadTest)

	return c.Run(ctx)
}
