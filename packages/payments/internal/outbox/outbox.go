// Package outbox ports libs/common/src/outbox/outbox.service.ts.
//
// This service never talks to Kafka for its responses: it only INSERTs
// Outbox rows (in the same transaction as the state change), and the
// mailman in the NestJS core app (OutboxPublisherService) publishes them.
// That's what makes swapping the NestJS processor for this one invisible to
// the rest of the system.
package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"time"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"

	"github.com/zaharzagrava/payments/internal/apperr"
	"github.com/zaharzagrava/payments/internal/db"
)

type Topic string

const (
	TopicPaymentsRequests  Topic = "payments.requests"
	TopicPaymentsResponses Topic = "payments.responses"
	TopicPaymentsDLQ       Topic = "payments.dlq"
)

type NotifyParams struct {
	Topic   Topic
	Payload json.RawMessage
	Extra   any
	// Stored with AppError#toJSON() (no debug data) - what the client sees.
	Error *apperr.Error
}

type Service struct {
	db  *db.DB
	log *slog.Logger
}

func NewService(database *db.DB, log *slog.Logger) *Service {
	return &Service{db: database, log: log}
}

// Notify inserts one Outbox row using q, which is either the caller's
// transaction (atomic with its state change) or the pool.
func (s *Service) Notify(ctx context.Context, q db.DBTX, p NotifyParams) error {
	var extra, errJSON *string

	if p.Extra != nil {
		b, err := json.Marshal(p.Extra)
		if err != nil {
			return apperr.FatalInternal("marshal outbox extra", err)
		}
		v := string(b)
		extra = &v
	}
	if p.Error != nil {
		b, err := json.Marshal(p.Error.JSON(false))
		if err != nil {
			return apperr.FatalInternal("marshal outbox error", err)
		}
		v := string(b)
		errJSON = &v
	}

	_, err := q.Exec(ctx,
		`INSERT INTO "Outbox" (topic, payload, extra, error, "createdAt")
		 VALUES ($1::text::"enum_Outbox_topic", $2::text::jsonb, $3::text::jsonb, $4::text::jsonb, NOW())`,
		string(p.Topic), string(safePayload(p.Payload)), extra, errJSON,
	)
	if err != nil {
		return fmt.Errorf("insert outbox row: %w", err)
	}
	return nil
}

type WrapConfig struct {
	Payload    json.RawMessage
	DLQTopic   Topic
	MaxRetries int
}

// WrapInOutbox is the consumer-side error boundary (OutboxService#wrapInOutbox):
//
//   - TRANSIENT errors are retried with exponential backoff (1s, 2s, 4s).
//   - FATAL errors, exhausted retries, and DOMAIN errors that leaked out of
//     the handler are written to the DLQ topic and swallowed, so the Kafka
//     offset is committed and one poison message can't block the partition.
//
// A non-nil return means the DLQ write itself failed; the caller must NOT
// commit the offset.
func (s *Service) WrapInOutbox(ctx context.Context, cfg WrapConfig, fn func(ctx context.Context) error) error {
	maxAttempts := cfg.MaxRetries + 1

	for attempt := 1; attempt <= maxAttempts; attempt++ {
		err := runRecovering(ctx, fn)
		if err == nil {
			return nil
		}

		appErr := classify(err)

		if appErr.Area == apperr.AreaTransient && attempt < maxAttempts {
			delay := time.Duration(math.Pow(2, float64(attempt-1))) * time.Second
			s.log.Warn("transient failure, retrying",
				"attempt", attempt, "max_attempts", maxAttempts, "delay", delay, "reason", appErr.Detail)

			select {
			case <-time.After(delay):
				continue
			case <-ctx.Done():
				return ctx.Err()
			}
		}

		if appErr.Area == apperr.AreaTransient {
			s.log.Error("transient failure, retries exhausted - routing to DLQ", "max_retries", cfg.MaxRetries)
			detail := fmt.Sprintf("Retries Exhausted after %d attempts", cfg.MaxRetries)
			appErr = apperr.FatalRetriesExhausted(detail, appErr)
		}

		if span := trace.SpanFromContext(ctx); span.IsRecording() {
			span.RecordError(appErr)
			span.SetStatus(codes.Error, fmt.Sprintf("Fatal error routed to DLQ topic [%s]: %s", cfg.DLQTopic, appErr.Detail))
		}

		if err := s.writeDLQ(ctx, cfg, appErr); err != nil {
			return err
		}

		s.log.Error("fatal event written to DLQ, acking offset", "topic", cfg.DLQTopic, "error", appErr.Detail)
		return nil
	}

	return nil
}

func (s *Service) writeDLQ(ctx context.Context, cfg WrapConfig, appErr *apperr.Error) error {
	errJSON, err := json.Marshal(appErr.JSON(true))
	if err != nil {
		errJSON = []byte(fmt.Sprintf(`{"detail":%q}`, appErr.Detail))
	}

	return s.db.WithTx(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO "Outbox" (topic, payload, error, "createdAt")
			 VALUES ($1::text::"enum_Outbox_topic", $2::text::jsonb, $3::text::jsonb, NOW())`,
			string(cfg.DLQTopic), string(safePayload(cfg.Payload)), string(errJSON),
		)
		return err
	})
}

// classify maps any error onto an AppError area, like the IIFE at the top
// of wrapInOutbox's catch block.
func classify(err error) *apperr.Error {
	if appErr, ok := apperr.As(err); ok {
		if appErr.Area == apperr.AreaDomain {
			return apperr.FatalDomainErrorIsThrown(appErr)
		}
		return appErr
	}

	var panicErr *recoveredPanic
	if errors.As(err, &panicErr) {
		// Go's equivalent of the TS TypeError/ReferenceError "code bug" check
		return &apperr.Error{
			Name: "AppError", Title: "Fatal Code Bug", Detail: panicErr.Error(),
			Status: 500, Area: apperr.AreaFatal, Causes: []error{err},
		}
	}

	return &apperr.Error{
		Name: "AppError", Title: "Unexpected infrastructure failure", Detail: err.Error(),
		Status: 500, Area: apperr.AreaTransient, Causes: []error{err},
	}
}

type recoveredPanic struct{ value any }

func (p *recoveredPanic) Error() string { return fmt.Sprintf("panic: %v", p.value) }

func runRecovering(ctx context.Context, fn func(ctx context.Context) error) (err error) {
	defer func() {
		if p := recover(); p != nil {
			err = &recoveredPanic{value: p}
		}
	}()
	return fn(ctx)
}

// safePayload guarantees valid JSON for the jsonb column - a malformed Kafka
// message is stored as a JSON string instead of failing the DLQ insert
// (which would otherwise retry forever).
func safePayload(raw json.RawMessage) json.RawMessage {
	if len(raw) > 0 && json.Valid(raw) {
		return raw
	}
	quoted, _ := json.Marshal(string(raw))
	return quoted
}
