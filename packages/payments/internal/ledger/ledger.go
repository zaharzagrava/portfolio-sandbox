// Package ledger ports libs/common/src/ledger/ledger.service.ts - double-entry
// bookkeeping where every sale's entries must sum to exactly zero.
package ledger

import (
	"context"
	"fmt"

	"github.com/zaharzagrava/payments/internal/apperr"
	"github.com/zaharzagrava/payments/internal/db"
)

type MarketplaceSale struct {
	PaymentID                string
	BuyerAccountID           string
	MerchantAccountID        string
	PlatformRevenueAccountID string
	TotalAmount              int64
	FeeAmount                int64
}

func MerchantAccountID(merchantID string) string { return "MERCHANT_" + merchantID }

// RecordMarketplaceSale must run inside the payment's finalize transaction:
// if it fails, the status update and outbox row roll back with it.
func RecordMarketplaceSale(ctx context.Context, tx db.DBTX, sale MarketplaceSale) error {
	// NestJS throws an HttpException here, which its outbox wrapper
	// misclassifies as TRANSIENT (3 pointless retries). It's deterministic,
	// so it's FATAL here.
	if sale.TotalAmount < sale.FeeAmount {
		return apperr.FatalInternal("CRITICAL: Total amount is less than fee amount.")
	}

	buyerDebit := -abs(sale.TotalAmount)
	merchantCredit := abs(sale.TotalAmount - sale.FeeAmount)
	platformCredit := abs(sale.FeeAmount)

	if buyerDebit+merchantCredit+platformCredit != 0 {
		return apperr.FatalInternal("CRITICAL: Ledger entry mathematically invalid. Amounts do not sum to zero.")
	}

	_, err := tx.Exec(ctx,
		`INSERT INTO "LedgerEntry" ("paymentId", "accountId", amount, "createdAt")
		 VALUES ($1::text::uuid, $2, $3, NOW()),
		        ($1::text::uuid, $4, $5, NOW()),
		        ($1::text::uuid, $6, $7, NOW())`,
		sale.PaymentID,
		sale.BuyerAccountID, buyerDebit,
		sale.MerchantAccountID, merchantCredit,
		sale.PlatformRevenueAccountID, platformCredit,
	)
	if err != nil {
		return fmt.Errorf("insert ledger entries: %w", err)
	}
	return nil
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}
