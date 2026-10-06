package payment

import (
	"encoding/json"
	"time"
)

type Status string

const (
	StatusPending   Status = "PENDING"
	StatusCompleted Status = "COMPLETED"
	StatusFailed    Status = "FAILED"
	StatusCancelled Status = "CANCELLED"
	StatusRefunded  Status = "REFUNDED"
)

// Params is the payments.requests message the edge worker produces
// (PostPaymentParamsDto). userId is stamped by the edge from the verified JWT.
type Params struct {
	IdempotencyKey  string  `json:"idempotency_key"`
	Amount          int64   `json:"amount"`
	UserID          string  `json:"userId"`
	BisOrderID      string  `json:"bisOrderId"`
	PaymentMethodID string  `json:"paymentMethodId"`
	ProductID       *string `json:"productId,omitempty"`
	Quantity        *int    `json:"quantity,omitempty"`

	// Raw is the original message value, stored verbatim as the outbox
	// payload (the SSE relay reads payload.idempotency_key from it).
	Raw json.RawMessage `json:"-"`
}

func (p Params) quantity() int {
	if p.Quantity == nil {
		return 1
	}
	return *p.Quantity
}

type BisOrder struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Payment serializes like the Sequelize instance NestJS puts in
// outbox.extra.payment (bisOrder included), which the SSE relay reads.
type Payment struct {
	ID             string    `json:"id"`
	IdempotencyKey string    `json:"idempotencyKey"`
	Amount         int64     `json:"amount"`
	Status         Status    `json:"status"`
	UserID         string    `json:"userId"`
	BisOrderID     string    `json:"bisOrderId"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
	BisOrder       *BisOrder `json:"bisOrder,omitempty"`
}
