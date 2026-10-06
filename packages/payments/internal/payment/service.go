// Package payment is a line-for-line port of
// libs/common/src/payment/payment.service.ts (PaymentService#executePayment).
// Comments marked SHUTDOWN keep the original crash-safety reasoning: what
// happens if the process dies (no SIGTERM) at that exact point.
package payment

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/zaharzagrava/payments/internal/apperr"
	"github.com/zaharzagrava/payments/internal/db"
	"github.com/zaharzagrava/payments/internal/ledger"
	"github.com/zaharzagrava/payments/internal/outbox"
	"github.com/zaharzagrava/payments/internal/stripe"
	"github.com/zaharzagrava/payments/internal/tracing"
)

const (
	platformFeeCents       = 50
	platformRevenueAccount = "PLATFORM_FEES"
	placeholderMerchantID  = "some-uuid" // same placeholder as the NestJS service
	stripeSucceededStatus  = "succeeded"
)

type Service struct {
	db     *db.DB
	stripe *stripe.Client
	outbox *outbox.Service
}

func NewService(database *db.DB, stripeClient *stripe.Client, outboxService *outbox.Service) *Service {
	return &Service{db: database, stripe: stripeClient, outbox: outboxService}
}

type finalizeResult struct {
	payment               *Payment
	needsRefund           bool
	stripePaymentIntentID string
}

func (s *Service) ExecutePayment(ctx context.Context, params Params, topic outbox.Topic) (*Payment, error) {
	return tracing.RunInSpan(ctx, "PaymentService.executePayment", func(ctx context.Context, mainSpan trace.Span) (*Payment, error) {
		// 1. Fail-fast validation. Fatal, not domain: the edge always sends a
		// key, so a missing one is a bug on our side.
		if params.IdempotencyKey == "" {
			return nil, apperr.FatalBadRequest("Idempotency key is missing")
		}

		mainSpan.SetAttributes(
			attribute.String("payment.idempotency_key", params.IdempotencyKey),
			attribute.Int64("payment.amount", params.Amount),
		)

		// 2. Create-or-load the PENDING row.
		// SHUTDOWN here: the tx rolls back, the offset isn't committed, the
		// event is redelivered and we start over.
		// See README.md#adr -> "Why implement idempotency keys?"
		payment, err := tracing.RunInSpan(ctx, "Check Existing Payment", func(ctx context.Context, _ trace.Span) (*Payment, error) {
			var found *Payment
			err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
				if err := insertPendingIfAbsent(ctx, tx, params); err != nil {
					return err
				}
				p, err := findByIdempotencyKey(ctx, tx, params.IdempotencyKey)
				if err != nil {
					return fmt.Errorf("load payment: %w", err)
				}
				if p == nil {
					return apperr.FatalNotFound("Payment not found", fmt.Sprintf("Payment %s not found", params.IdempotencyKey))
				}
				found = p
				return nil
			})
			return found, err
		})
		if err != nil {
			return nil, err
		}

		// SHUTDOWN after creation: the row stays PENDING and the redelivered
		// event picks it up from here.

		// Already settled by a previous run - return it as-is.
		if payment.Status != StatusPending {
			return payment, nil
		}

		// 3. Cheap stock pre-check to avoid a charge+refund round trip in the
		// common case. No concurrency guarantee - that's the OCC decrement
		// inside the finalize transaction.
		if params.ProductID != nil {
			quantity, found, err := productStock(ctx, s.db.Pool, *params.ProductID)
			if err != nil {
				return nil, err
			}
			if !found || quantity < params.quantity() {
				err := s.outbox.Notify(ctx, s.db.Pool, outbox.NotifyParams{
					Topic:   topic,
					Payload: params.Raw,
					Extra:   map[string]any{"payment": payment},
					Error:   apperr.DomainInsufficientStock(fmt.Sprintf("Product %s has insufficient stock", *params.ProductID)),
				})
				return payment, err
			}
		}

		// 4. Charge without holding a DB connection.
		// SHUTDOWN here: fine - Stripe's own idempotency key returns the same
		// PaymentIntent when the redelivered event calls again.
		intent, err := tracing.RunInSpan(ctx, "Stripe: Create Payment Intent", func(ctx context.Context, _ trace.Span) (*stripe.PaymentIntent, error) {
			return s.stripe.CreatePaymentIntent(ctx, params.Amount, params.PaymentMethodID, params.IdempotencyKey)
		})
		if err != nil {
			return nil, err
		}

		// 5. Finalize: stock, status, ledger and outbox in one transaction.
		result, err := tracing.RunInSpan(ctx, "Finalize Transaction", func(ctx context.Context, _ trace.Span) (*finalizeResult, error) {
			var res *finalizeResult
			err := s.db.WithTx(ctx, func(tx pgx.Tx) error {
				var err error
				res, err = s.finalize(ctx, tx, params, topic, payment, intent)
				return err
			})
			return res, err
		})
		if err != nil {
			return nil, err
		}

		if result.needsRefund {
			return s.refundLostStockRace(ctx, params, topic, payment, result.stripePaymentIntentID)
		}

		// SHUTDOWN here: the redelivered event finds a COMPLETED/FAILED row in
		// step 2 and returns immediately.
		return result.payment, nil
	})
}

func (s *Service) finalize(ctx context.Context, tx pgx.Tx, params Params, topic outbox.Topic, payment *Payment, intent *stripe.PaymentIntent) (*finalizeResult, error) {
	isSuccess := intent.Status == stripeSucceededStatus

	if isSuccess && params.ProductID != nil {
		// See README.md#adr -> "Why use Optimistic Concurrency Control (OCC) instead of pessimistic locks?"
		won, err := decrementStock(ctx, tx, *params.ProductID, params.quantity())
		if err != nil {
			return nil, err
		}
		if !won {
			// Lost the stock race after Stripe charged. Leave Payment PENDING;
			// the refund happens outside this transaction.
			return &finalizeResult{payment: payment, needsRefund: true, stripePaymentIntentID: intent.ID}, nil
		}
	}

	newStatus := StatusFailed
	if isSuccess {
		newStatus = StatusCompleted
	}

	updated, err := updateStatusIfPending(ctx, tx, payment.ID, newStatus)
	if err != nil {
		return nil, err
	}
	if !updated {
		// Another consumer settled it first - return its state.
		existing, err := findByID(ctx, tx, payment.ID)
		if err != nil {
			return nil, err
		}
		if existing == nil {
			return nil, apperr.FatalInternal("Payment is not found")
		}
		return &finalizeResult{payment: existing}, nil
	}

	payment.Status = newStatus

	if isSuccess {
		// See README.md#adr -> "Why use double-entry bookkeeping?"
		err := ledger.RecordMarketplaceSale(ctx, tx, ledger.MarketplaceSale{
			PaymentID:                payment.ID,
			BuyerAccountID:           ledger.MerchantAccountID(payment.BisOrder.UserID),
			MerchantAccountID:        ledger.MerchantAccountID(placeholderMerchantID),
			PlatformRevenueAccountID: platformRevenueAccount,
			TotalAmount:              params.Amount,
			FeeAmount:                platformFeeCents,
		})
		if err != nil {
			return nil, err
		}

		// See README.md#adr -> "Why do you use the Outbox pattern alongside Kafka?"
		// Same tx as the status update: the response event can never be lost.
		err = s.outbox.Notify(ctx, tx, outbox.NotifyParams{
			Topic:   topic,
			Payload: params.Raw,
			Extra:   map[string]any{"payment": payment},
		})
		return &finalizeResult{payment: payment}, err
	}

	if intent.LastPaymentError == nil {
		return nil, apperr.FatalInternal("Stripe did not provide with last payment error")
	}

	message := intent.LastPaymentError.Message
	if message == "" {
		message = "Unknown error"
	}

	// Domain errors are recorded and sent to the client, never to the DLQ.
	err = s.outbox.Notify(ctx, tx, outbox.NotifyParams{
		Topic:   topic,
		Payload: params.Raw,
		Extra:   map[string]any{"payment": payment, "stripeResponse": intent},
		Error:   apperr.DomainStripePaymentFailed(message),
	})
	return &finalizeResult{payment: payment}, err
}

// refundLostStockRace is the compensating step of the saga.
// See README.md#adr -> "Why use a Distributed Saga instead of 2-Phase Commits?"
func (s *Service) refundLostStockRace(ctx context.Context, params Params, topic outbox.Topic, payment *Payment, paymentIntentID string) (*Payment, error) {
	_, err := tracing.RunInSpan(ctx, "Refund: Insufficient Stock", func(ctx context.Context, _ trace.Span) (struct{}, error) {
		return struct{}{}, s.stripe.RefundPaymentIntent(ctx, paymentIntentID, params.IdempotencyKey)
	})
	if err != nil {
		return nil, err
	}

	refunded := *payment
	refunded.Status = StatusRefunded

	err = s.db.WithTx(ctx, func(tx pgx.Tx) error {
		updated, err := updateStatusIfPending(ctx, tx, payment.ID, StatusRefunded)
		if err != nil {
			return err
		}
		if !updated {
			return apperr.FatalNotFound("Payment is not updated", "Payment is not updated")
		}

		return s.outbox.Notify(ctx, tx, outbox.NotifyParams{
			Topic:   topic,
			Payload: params.Raw,
			Extra:   map[string]any{"payment": refunded},
			Error: apperr.DomainInsufficientStock(
				fmt.Sprintf("Stock ran out for product %s after payment succeeded — refunded", *params.ProductID),
			),
		})
	})
	if err != nil {
		return nil, err
	}

	return &refunded, nil
}
