// Package stripe ports the parts of libs/common/src/stripe/stripe.service.ts
// the payment flow uses: create+confirm a PaymentIntent behind a circuit
// breaker, and refund. Talks to the REST API directly - two endpoints don't
// justify the full SDK.
package stripe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/sony/gobreaker/v2"

	"github.com/zaharzagrava/payments/internal/apperr"
)

const apiBase = "https://api.stripe.com/v1"

type PaymentError struct {
	Code    string `json:"code,omitempty"`
	Type    string `json:"type,omitempty"`
	Message string `json:"message,omitempty"`
}

type PaymentIntent struct {
	ID               string        `json:"id"`
	Status           string        `json:"status"`
	Amount           int64         `json:"amount"`
	Currency         string        `json:"currency"`
	PaymentMethod    string        `json:"payment_method,omitempty"`
	LastPaymentError *PaymentError `json:"last_payment_error,omitempty"`
}

type Config struct {
	SecretKey  string
	APIVersion string
	Timeout    time.Duration
	// IsLoadTest short-circuits every call with a successful fake response
	// (same as `is_load_test` in the NestJS StripeService).
	IsLoadTest bool
}

type Client struct {
	cfg     Config
	http    *http.Client
	breaker *gobreaker.CircuitBreaker[*PaymentIntent]
}

// clientError is a 4xx other than a card decline (bad key, bad params):
// deterministic, so it neither trips the breaker nor gets retried.
type clientError struct{ err *apperr.Error }

func (e *clientError) Error() string { return e.err.Error() }
func (e *clientError) Unwrap() error { return e.err }

func NewClient(cfg Config) *Client {
	return &Client{
		cfg:  cfg,
		http: &http.Client{Timeout: cfg.Timeout},
		// Same shape as the opossum config: open at >=50% failures, probe
		// again after 10s.
		breaker: gobreaker.NewCircuitBreaker[*PaymentIntent](gobreaker.Settings{
			Name:        "stripe.createPaymentIntent",
			MaxRequests: 1,
			Interval:    10 * time.Second,
			Timeout:     10 * time.Second,
			ReadyToTrip: func(counts gobreaker.Counts) bool {
				return counts.Requests >= 10 && float64(counts.TotalFailures)/float64(counts.Requests) >= 0.5
			},
			IsSuccessful: func(err error) bool {
				var ce *clientError
				return err == nil || errors.As(err, &ce)
			},
		}),
	}
}

// CreatePaymentIntent charges immediately (confirm=true). A card decline is
// NOT an error: it comes back as a PaymentIntent whose status isn't
// "succeeded" and whose LastPaymentError explains why, so the caller can
// record a FAILED payment. (The Node SDK throws on declines instead - see
// the TODO in stripe.service.ts.)
func (c *Client) CreatePaymentIntent(ctx context.Context, amount int64, paymentMethodID, idempotencyKey string) (*PaymentIntent, error) {
	pi, err := c.breaker.Execute(func() (*PaymentIntent, error) {
		if c.cfg.IsLoadTest {
			return &PaymentIntent{
				ID:            "pi_loadtest_" + idempotencyKey,
				Status:        "succeeded",
				Amount:        amount,
				Currency:      "usd",
				PaymentMethod: paymentMethodID,
			}, nil
		}

		form := url.Values{}
		form.Set("amount", strconv.FormatInt(amount, 10))
		form.Set("currency", "usd")
		form.Set("payment_method", paymentMethodID)
		form.Set("confirm", "true")
		form.Set("automatic_payment_methods[enabled]", "true")
		form.Set("automatic_payment_methods[allow_redirects]", "never")

		return c.postPaymentIntent(ctx, "/payment_intents", form, idempotencyKey)
	})

	if errors.Is(err, gobreaker.ErrOpenState) || errors.Is(err, gobreaker.ErrTooManyRequests) {
		return nil, apperr.DomainCircuitBreakerOpen(err)
	}
	var ce *clientError
	if errors.As(err, &ce) {
		return nil, ce.err
	}
	return pi, err
}

func (c *Client) RefundPaymentIntent(ctx context.Context, paymentIntentID, idempotencyKey string) error {
	if c.cfg.IsLoadTest {
		return nil
	}

	form := url.Values{}
	form.Set("payment_intent", paymentIntentID)

	status, body, err := c.post(ctx, "/refunds", form, "refund:"+idempotencyKey)
	if err != nil {
		return err
	}
	if status >= 300 {
		return fmt.Errorf("stripe refund failed: HTTP %d: %s", status, truncate(body))
	}
	return nil
}

func (c *Client) postPaymentIntent(ctx context.Context, path string, form url.Values, idempotencyKey string) (*PaymentIntent, error) {
	status, body, err := c.post(ctx, path, form, idempotencyKey)
	if err != nil {
		return nil, err // network/timeout - transient, counts against the breaker
	}

	switch {
	case status < 300:
		var pi PaymentIntent
		if err := json.Unmarshal(body, &pi); err != nil {
			return nil, fmt.Errorf("decode payment intent: %w", err)
		}
		return &pi, nil

	case status == http.StatusPaymentRequired:
		// Card declined: the error envelope embeds the failed PaymentIntent.
		var envelope struct {
			Error struct {
				PaymentError
				PaymentIntent *PaymentIntent `json:"payment_intent"`
			} `json:"error"`
		}
		if err := json.Unmarshal(body, &envelope); err != nil {
			return nil, fmt.Errorf("decode stripe decline: %w", err)
		}
		pi := envelope.Error.PaymentIntent
		if pi == nil {
			pi = &PaymentIntent{Status: "requires_payment_method"}
		}
		if pi.LastPaymentError == nil {
			decline := envelope.Error.PaymentError
			pi.LastPaymentError = &decline
		}
		return pi, nil

	case status == http.StatusTooManyRequests || status >= 500:
		return nil, fmt.Errorf("stripe HTTP %d: %s", status, truncate(body))

	default:
		return nil, &clientError{err: apperr.FatalBadRequest(fmt.Sprintf("stripe rejected request: HTTP %d: %s", status, truncate(body)))}
	}
}

func (c *Client) post(ctx context.Context, path string, form url.Values, idempotencyKey string) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiBase+path, strings.NewReader(form.Encode()))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.cfg.SecretKey)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Stripe-Version", c.cfg.APIVersion)
	// Stripe dedupes on this, so a retried/redelivered event never double-charges
	req.Header.Set("Idempotency-Key", idempotencyKey)

	res, err := c.http.Do(req)
	if err != nil {
		return 0, nil, fmt.Errorf("stripe request: %w", err)
	}
	defer res.Body.Close()

	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return 0, nil, fmt.Errorf("read stripe response: %w", err)
	}
	return res.StatusCode, body, nil
}

func truncate(b []byte) string {
	const limit = 500
	if len(b) > limit {
		return string(b[:limit]) + "..."
	}
	return string(b)
}
