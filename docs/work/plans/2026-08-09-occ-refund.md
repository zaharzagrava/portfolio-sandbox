# OCC + Refund-on-Conflict Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Deviation from the usual template, per explicit user instruction: no TDD/test-writing steps, no build/run verification steps. Implementation only.**

**Goal:** Add optimistic-concurrency stock control to payment processing — a payment can optionally target a `Product`, the stock decrement is version-checked inside the existing payment transaction, and a losing race gets a real Stripe refund instead of overselling.

**Architecture:** Everything lands inside the existing `PaymentService.executePayment`'s second transaction block (`libs/common/src/payment/payment.service.ts`, the `wrapInTransaction` under `runInSpan('Finalize Transaction', ...)`) — that block already runs after Stripe succeeds, which is exactly where a stock decrement belongs. A cheap pre-check avoids the common-case Stripe call; the version-checked `UPDATE` is the actual correctness guarantee; a conflict leaves `Payment` at `PENDING`, issues a Stripe refund outside any open transaction, then a short follow-up transaction marks `REFUNDED`.

**Tech Stack:** NestJS, Sequelize (raw SQL via `sequelizeInstance.query` for the version-checked update, matching the existing idempotent-insert pattern in this same file), Stripe SDK (`stripe.refunds.create`).

## Global Constraints

- No test files, no TDD steps, no build/lint/run verification steps in this plan — implementation only, per explicit user instruction overriding this skill's usual template.
- Commits happen per task, on `master`, no worktree — matches how Plan 1 was executed.
- `AppError`/`ErrorArea.DOMAIN` for all new error types (matches `Domain_StripePaymentFailed`, `Domain_CircuitBreakerOpenError` already in `libs/common/src/payment/types.ts`).
- `productId` is optional everywhere — non-product payment flows (e.g. `StripeService.createIdentitySession`'s verification payment) must keep working unchanged when it's absent.
- Never hold a DB transaction open across a Stripe call (existing principle already followed in this file for the initial charge — the refund call must follow the same rule).

---

## Task 1: Migration — Payment gains `productId` + `quantity`

**Files:**
- Create: `backend/migrations/20260809150000-payment-product-occ-fields.js`

**Interfaces:**
- Produces: `Payment.productId: string | null`, `Payment.quantity: number` (default 1) — columns only; Task 2 adds the model fields.

- [ ] **Step 1: Write the migration**

```js
'use strict';

/**
 * Payment optionally targets a Product purchase — productId/quantity let the
 * payment transaction do a version-checked stock decrement in the same tx as
 * the ledger write, instead of a separate saga step.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      const paymentDesc = await queryInterface.describeTable('Payment');

      if (!paymentDesc.productId) {
        await queryInterface.addColumn(
          'Payment',
          'productId',
          {
            type: Sequelize.UUID,
            allowNull: true,
            references: { model: 'Product', key: 'id' },
          },
          { transaction },
        );
      }

      if (!paymentDesc.quantity) {
        await queryInterface.addColumn(
          'Payment',
          'quantity',
          {
            type: Sequelize.INTEGER,
            allowNull: false,
            defaultValue: 1,
          },
          { transaction },
        );
      }
    });
  },

  async down(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      const paymentDesc = await queryInterface.describeTable('Payment');

      if (paymentDesc.quantity) {
        await queryInterface.removeColumn('Payment', 'quantity', { transaction });
      }
      if (paymentDesc.productId) {
        await queryInterface.removeColumn('Payment', 'productId', { transaction });
      }
    });
  },
};
```

- [ ] **Step 2: Stage only this file and commit.** Move to Task 2.

---

## Task 2: `Payment` model gains the two fields

**Files:**
- Modify: `backend/libs/common/src/models/payment.model.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Payment.productId: string | null`, `Payment.quantity: number` — Task 5's OCC logic reads/writes these.

- [ ] **Step 1: Add the two columns**, right after the existing `bisOrderId` column (`payment.model.ts:102-103`):

```typescript
  @Column({ type: DataType.UUID, allowNull: true })
  declare productId: string | null;

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare quantity: number;
```

- [ ] **Step 2: Stage only this file and commit.** Move to Task 3.

---

## Task 3: Request schema + new domain errors

**Files:**
- Modify: `backend/libs/common/src/payment/types.ts`

**Interfaces:**
- Produces: `PostPaymentParamsDto.productId?: string`, `PostPaymentParamsDto.quantity?: number`; `Domain_InsufficientStockError` (`ErrorArea.DOMAIN`).

- [ ] **Step 1: Add `productId`/`quantity` to `PostPaymentParamsDto`**

```typescript
  @ApiProperty({ required: false })
  @IsOptional()
  @IsUUID()
  productId?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  quantity?: number;
```

Add `IsOptional` to the existing `class-validator` import line (`import { IsEnum, IsNumber, IsString, IsUUID } from 'class-validator';` → add `IsOptional`).

- [ ] **Step 2: Add `Domain_InsufficientStockError`**, after `Domain_CircuitBreakerOpenError`:

```typescript
export class Domain_InsufficientStockError extends AppError {
  constructor(params?: ConfiguredErrorParams) {
    super({
      status: HttpStatus.CONFLICT,
      detail: 'Not enough stock for this purchase',
      title: 'Insufficient stock',
      area: ErrorArea.DOMAIN,
      ...params,
    });
  }
}
```

- [ ] **Step 3: Stage only this file and commit.** Move to Task 4.

---

## Task 4: Stripe refund method

**Files:**
- Modify: `backend/libs/common/src/stripe/stripe.service.ts`

**Interfaces:**
- Produces: `StripeService.refundPaymentIntent({ paymentIntentId: string, idempotencyKey: string }): Promise<void>`.

- [ ] **Step 1: Add the method**, after `createPaymentIntentUnprotected`:

```typescript
  public async refundPaymentIntent({
    paymentIntentId,
    idempotencyKey,
  }: {
    paymentIntentId: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (this.configService.get('is_load_test')) {
      return;
    }

    await this.stripe.refunds.create(
      { payment_intent: paymentIntentId },
      { idempotencyKey: `refund:${idempotencyKey}` },
    );
  }
```

Not wrapped in the circuit breaker: a refund is a compensating action for money already taken — it must keep retrying (via Kafka redelivery, per the spec's crash-safety note) rather than fail fast, so it shouldn't share the breaker's "give up early" behavior with the initial charge.

- [ ] **Step 2: Stage only this file and commit.** Move to Task 5.

---

## Task 5: Wire the pre-check, OCC decrement, and refund-on-conflict into `executePayment`

**Files:**
- Modify: `backend/libs/common/src/payment/payment.service.ts`

**Interfaces:**
- Consumes: `Domain_InsufficientStockError` (Task 3), `StripeService.refundPaymentIntent` (Task 4), `Payment.productId`/`quantity` (Task 2).
- Produces: `executePayment` now performs, when `params.productId` is present: pre-check → (unchanged Stripe call) → OCC decrement inside the existing Finalize Transaction → on conflict, refund outside any transaction, then a follow-up transaction marking `REFUNDED`.

- [ ] **Step 1: Add the pre-check.** In the `async (mainSpan) => { ... }` callback, right after the existing `if (payment.status !== PaymentStatus.PENDING) { return { payment: payment }; }` check (`payment.service.ts:122-124`) and before the `Stripe: Create Payment Intent` span (`payment.service.ts:131`), insert:

```typescript
        const { productId, quantity = 1 } = params;

        if (productId) {
          const [[stockRow]] = await this.sequelizeInstance.query(
            `SELECT quantity FROM "Product" WHERE id = :productId`,
            { replacements: { productId } },
          );

          if (!stockRow || (stockRow as any).quantity < quantity) {
            await this.outboxService.notify(
              {
                topic,
                payload: params,
                extra: { payment },
                error: new Domain_InsufficientStockError({
                  detail: `Product ${productId} has insufficient stock`,
                }),
              },
            );

            return { payment };
          }
        }
```

Import `Domain_InsufficientStockError` at the top of the file alongside the existing `Domain_StripePaymentFailed` import from `@app/common/payment/types`.

This pre-check deliberately runs *before* Stripe is called (fail-fast, no charge attempted) and is a plain uncached read — no transaction, no lock. It provides no concurrency guarantee by itself (see Task 5 Step 2); it only avoids the common-case Stripe round-trip when stock is obviously already gone.

- [ ] **Step 2: Add the OCC decrement inside the Finalize Transaction block.** Currently (`payment.service.ts:142-237`), the `if (isSuccess) { ... }` branch does: record ledger sale → set `payment.status = COMPLETED` → `outboxService.notify(...)`. Insert the version-checked decrement as the *first* thing inside that `if (isSuccess)` branch, before the existing `recordMarketplaceSale` call, and make the rest of the branch conditional on it succeeding:

```typescript
            if (isSuccess) {
              let stockConflict = false;

              if (productId) {
                const [, occResult] = await this.sequelizeInstance.query(
                  `UPDATE "Product" SET quantity = quantity - :quantity, version = version + 1
                   WHERE id = :productId AND quantity >= :quantity
                   RETURNING id`,
                  {
                    replacements: { productId, quantity },
                    transaction: tx,
                  },
                );

                stockConflict = !(occResult as any)?.rowCount || (occResult as any).rowCount === 0;
              }

              if (stockConflict) {
                // Leave payment.status at PENDING deliberately — see Step 3.
                return { payment, needsRefund: true, stripePaymentIntentId: stripeResponse.id };
              }

              await this.ledgerService.recordMarketplaceSale({
                paymentId: payment.id,
                buyerAccountId: this.bisUtilsService.getMerchantAccountId(
                  payment.bisOrder.userId,
                ),
                merchantAccountId:
                  this.bisUtilsService.getMerchantAccountId('some-uuid'),
                platformRevenueAccountId: 'PLATFORM_FEES',
                totalAmount: amount,
                feeAmount: 50,
                tx,
              });

              payment.status = PaymentStatus.COMPLETED;

              if (productId) {
                await this.outboxService.notify(
                  {
                    topic: topic,
                    payload: params,
                    extra: { payment, productId, quantity },
                  },
                  tx,
                );
              } else {
                await this.outboxService.notify(
                  {
                    topic: topic,
                    payload: params,
                    extra: { payment },
                  },
                  tx,
                );
              }
            } else {
```

The `UPDATE ... WHERE id = :productId AND quantity >= :quantity` (no explicit `version =` check in the `WHERE`) is the correct compare-and-swap here: since `quantity` itself is the value being checked and decremented atomically in one statement, checking `quantity >= :quantity` in the `WHERE` clause *is* the optimistic check — a concurrent transaction's earlier decrement already changed the row (or it didn't commit yet and this statement blocks on the row lock until it does, then re-evaluates the `WHERE` against the now-committed value). The `version` column still gets incremented for auditability and for future callers that need explicit version-based conflict detection (e.g. a future `PATCH /products/:id`), but this specific decrement doesn't need to read-then-compare a version number itself.

Return the existing single `{ payment }` on the non-conflict path exactly as before (no change needed there — only the `if (isSuccess)` branch's *internals* changed, per the diff above; the `else` branch for Stripe failure is untouched).

- [ ] **Step 3: Handle the `needsRefund` signal outside the transaction, in `executePayment`'s own return.** Currently `executePayment` ends with:

```typescript
        return await runInSpan('Finalize Transaction', async () => {
          return await this.dbUtilsService.wrapInTransaction(async (tx) => {
            /* ... Step 2's block ... */
          });
        });
```

Wrap that whole `runInSpan('Finalize Transaction', ...)` call and handle the signal it can now return:

```typescript
        const finalizeResult = await runInSpan('Finalize Transaction', async () => {
          return await this.dbUtilsService.wrapInTransaction(async (tx) => {
            /* ... Step 2's block, unchanged ... */
          });
        });

        if ('needsRefund' in finalizeResult && finalizeResult.needsRefund) {
          await runInSpan('Refund: Insufficient Stock', async () => {
            await this.stripeService.refundPaymentIntent({
              paymentIntentId: finalizeResult.stripePaymentIntentId,
              idempotencyKey: idempotency_key,
            });
          });

          return await this.dbUtilsService.wrapInTransaction(async (tx) => {
            await this.paymentDtoService.update({
              where: { id: payment.id, status: PaymentStatus.PENDING },
              params: { status: PaymentStatus.REFUNDED },
              tx,
            });

            await this.outboxService.notify(
              {
                topic,
                payload: params,
                extra: { payment: { ...payment, status: PaymentStatus.REFUNDED } },
                error: new Domain_InsufficientStockError({
                  detail: `Stock ran out for product ${productId} after payment succeeded — refunded`,
                }),
              },
              tx,
            );

            return { payment: { ...payment, status: PaymentStatus.REFUNDED } };
          });
        }

        return finalizeResult;
```

This mirrors the file's own existing principle (comment at the original `Stripe: Create Payment Intent` call, "we call Stripe without holding a DB connection captive") — the refund call sits between two separate transactions, never inside one. If the process crashes between detecting the conflict and completing the refund, `Payment` is still `PENDING` (Step 2 never flipped it), so Kafka redelivery re-enters `executePayment` from the top, re-calls Stripe (idempotent, returns the cached succeeded intent), re-hits the same OCC conflict, and re-attempts the refund — idempotent via the `refund:${idempotencyKey}` key from Task 4. No new crash-safety machinery beyond what already exists for the charge.

- [ ] **Step 4: Stage only this file and commit.** This is the last task in this plan — all of spec §5 is now implemented (pre-check, OCC decrement, refund-on-conflict, crash-safety via existing idempotency discipline).

---

## Self-Review Notes

**Spec coverage:** §5a (request schema) → Task 3. §5b (circuit breaker) → already done in Plan 1's Task 7. §5c (pre-check) → Task 5 Step 1. §5d (OCC decrement) → Task 5 Step 2. §5e (refund-on-conflict, crash-safety) → Task 5 Step 3. Migration → Task 1. Model → Task 2.

**Not covered by this plan** (per the spec's own scope): §2/§3 (edge proxy, rate limiting, schema registry), §6 (product create endpoint), §7 (search-indexer consumer) — those are Plan 3/4, not this one.

**Type consistency check:** `Domain_InsufficientStockError` used consistently across Task 3 (definition) and Task 5 (two call sites — pre-check rejection and post-refund notification). `stripeService.refundPaymentIntent({ paymentIntentId, idempotencyKey })` signature matches between Task 4 (definition) and Task 5 Step 3 (call site). `finalizeResult.needsRefund`/`finalizeResult.stripePaymentIntentId` are read in Step 3 exactly as returned in Step 2 — both live in the same function, no cross-task drift risk.
