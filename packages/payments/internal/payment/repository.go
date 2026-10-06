package payment

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/zaharzagrava/payments/internal/db"
)

// Every parameter is sent as text and cast in SQL ($1::text::uuid, ...), so
// the queries behave the same under pgx's extended protocol and under
// PG_SIMPLE_PROTOCOL (PgBouncer transaction mode).

const selectPaymentWithOrder = `
	SELECT p.id::text, p."idempotencyKey", p.amount, p.status::text, p."userId",
	       p."bisOrderId"::text, p."createdAt", p."updatedAt",
	       b.id::text, b."userId"::text, b."createdAt", b."updatedAt"
	FROM "Payment" p
	JOIN "BisOrder" b ON b.id = p."bisOrderId"`

func scanPaymentWithOrder(row pgx.Row) (*Payment, error) {
	var p Payment
	var b BisOrder
	var status string

	err := row.Scan(
		&p.ID, &p.IdempotencyKey, &p.Amount, &status, &p.UserID,
		&p.BisOrderID, &p.CreatedAt, &p.UpdatedAt,
		&b.ID, &b.UserID, &b.CreatedAt, &b.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}

	p.Status = Status(status)
	p.BisOrder = &b
	return &p, nil
}

// insertPendingIfAbsent is the idempotency gate: a redelivered or duplicate
// event hits ON CONFLICT and falls through to reading the existing row.
func insertPendingIfAbsent(ctx context.Context, q db.DBTX, p Params) error {
	_, err := q.Exec(ctx,
		`INSERT INTO "Payment" (id, "idempotencyKey", amount, status, "bisOrderId", "userId", "createdAt", "updatedAt")
		 VALUES (gen_random_uuid(), $1::text, $2::bigint, 'PENDING', $3::text::uuid, $4::text, NOW(), NOW())
		 ON CONFLICT ("idempotencyKey") DO NOTHING`,
		p.IdempotencyKey, p.Amount, p.BisOrderID, p.UserID,
	)
	if err != nil {
		return fmt.Errorf("insert payment: %w", err)
	}
	return nil
}

// findByIdempotencyKey returns (nil, nil) when missing - including when the
// BisOrder doesn't exist (INNER join, like bisOrderRequired: true).
func findByIdempotencyKey(ctx context.Context, q db.DBTX, idempotencyKey string) (*Payment, error) {
	p, err := scanPaymentWithOrder(q.QueryRow(ctx, selectPaymentWithOrder+` WHERE p."idempotencyKey" = $1::text`, idempotencyKey))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return p, err
}

func findByID(ctx context.Context, q db.DBTX, id string) (*Payment, error) {
	p, err := scanPaymentWithOrder(q.QueryRow(ctx, selectPaymentWithOrder+` WHERE p.id = $1::text::uuid`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return p, err
}

// updateStatusIfPending reports whether this call won the PENDING -> final
// transition; false means another consumer already settled it.
func updateStatusIfPending(ctx context.Context, q db.DBTX, id string, status Status) (bool, error) {
	tag, err := q.Exec(ctx,
		`UPDATE "Payment" SET status = $1::text::"enum_Payment_status", "updatedAt" = NOW()
		 WHERE id = $2::text::uuid AND status = 'PENDING'`,
		string(status), id,
	)
	if err != nil {
		return false, fmt.Errorf("update payment status: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}

func productStock(ctx context.Context, q db.DBTX, productID string) (int, bool, error) {
	var quantity int
	err := q.QueryRow(ctx, `SELECT quantity FROM "Product" WHERE id = $1::text::uuid`, productID).Scan(&quantity)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("read product stock: %w", err)
	}
	return quantity, true, nil
}

// decrementStock is the OCC guard: the WHERE clause re-checks stock at write
// time, so two buyers racing for the last unit can't both succeed.
func decrementStock(ctx context.Context, q db.DBTX, productID string, quantity int) (bool, error) {
	tag, err := q.Exec(ctx,
		`UPDATE "Product" SET quantity = quantity - $1::int, version = version + 1
		 WHERE id = $2::text::uuid AND quantity >= $1::int`,
		quantity, productID,
	)
	if err != nil {
		return false, fmt.Errorf("decrement stock: %w", err)
	}
	return tag.RowsAffected() > 0, nil
}
