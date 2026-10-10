import { Injectable } from '@nestjs/common';
import {
  DeleteCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ApiConfigService } from '@app/common/config';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import type { CartStore } from '../domain/ports';
import { mergeCarts, type CartLine } from '../domain/cart-merge';
import { CartUnavailableError } from '../domain/order-errors';

const TABLE = 'Carts';
const MAX_ATTEMPTS = 3;
/** DynamoDB allows 100 operations per transaction. */
const MAX_TRANSACTION_OPS = 100;

interface CartState {
  lines: CartLine[];
  /** `META.version`: bumped whenever a line is added, so the 50-line cap holds under concurrent adds. */
  metaVersion: number;
}

const isCanceled = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ['TransactionCanceledException', 'ConditionalCheckFailedException'].includes(
    (error as { name?: string }).name ?? '',
  );

/**
 * The cart in DynamoDB (S10 D-2): one item per line (`PK = CART#<id>`, `SK = ITEM#<productId>`) plus `SK = META` whose
 * `version` is the optimistic lock behind the line cap. Expired lines (`expiresAtEpoch <= now`) are filtered on read:
 * the table's TTL delete is housekeeping only. No relational access.
 */
@Injectable()
export class DynamoCartStore implements CartStore {
  constructor(
    private readonly dynamo: DynamoService,
    private readonly config: ApiConfigService,
  ) {}

  private get table(): string {
    return this.dynamo.table(TABLE);
  }

  private pk = (cartId: string) => `CART#${cartId}`;
  private expiry = (now: Date) =>
    Math.floor(now.getTime() / 1000) +
    this.config.get('orders_cart_line_ttl_days') * 86_400;

  /** One call with the store timeout; any failure or timeout is a retryable 503 for the caller. */
  private async send<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.get('orders_cart_store_timeout_ms'),
    );
    try {
      return await run(controller.signal);
    } catch (error) {
      if (isCanceled(error)) throw error;
      throw new CartUnavailableError();
    } finally {
      clearTimeout(timer);
    }
  }

  private async read(cartId: string, now: Date): Promise<CartState> {
    const nowSec = Math.floor(now.getTime() / 1000);
    const lines: CartLine[] = [];
    let metaVersion = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const page = await this.send((signal) =>
        this.dynamo.doc.send(
          new QueryCommand({
            TableName: this.table,
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: { ':pk': this.pk(cartId) },
            ConsistentRead: true,
            ExclusiveStartKey: startKey,
          }),
          { abortSignal: signal },
        ),
      );
      for (const item of page.Items ?? []) {
        if (item.SK === 'META') metaVersion = Number(item.version ?? 0);
        else if (Number(item.expiresAtEpoch) > nowSec)
          lines.push({
            productId: item.productId,
            quantity: item.quantity,
            addedAt: item.addedAt,
          });
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    lines.sort(
      (a, b) =>
        a.addedAt.localeCompare(b.addedAt) ||
        a.productId.localeCompare(b.productId),
    );
    return { lines, metaVersion };
  }

  async list(cartId: string, now: Date): Promise<CartLine[]> {
    return (await this.read(cartId, now)).lines;
  }

  private metaUpdate(cartId: string, observed: number) {
    return {
      Update: {
        TableName: this.table,
        Key: { PK: this.pk(cartId), SK: 'META' },
        UpdateExpression: 'SET #v = :next',
        ConditionExpression:
          observed === 0 ? 'attribute_not_exists(#v)' : '#v = :observed',
        ExpressionAttributeNames: { '#v': 'version' },
        ExpressionAttributeValues: {
          ':next': observed + 1,
          ...(observed === 0 ? {} : { ':observed': observed }),
        },
      },
    };
  }

  async setLine(
    cartId: string,
    productId: string,
    quantity: number,
    now: Date,
  ): Promise<'ok' | 'line_limit'> {
    const key = { PK: this.pk(cartId), SK: `ITEM#${productId}` };
    if (quantity <= 0) {
      await this.send((signal) =>
        this.dynamo.doc.send(
          new DeleteCommand({ TableName: this.table, Key: key }),
          { abortSignal: signal },
        ),
      );
      return 'ok';
    }
    const expiresAtEpoch = this.expiry(now);
    const nowSec = Math.floor(now.getTime() / 1000);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const state = await this.read(cartId, now);
      try {
        if (state.lines.some((l) => l.productId === productId)) {
          // An existing live line keeps its addedAt; the quantity and the deadline are replaced.
          await this.send((signal) =>
            this.dynamo.doc.send(
              new UpdateCommand({
                TableName: this.table,
                Key: key,
                UpdateExpression: 'SET quantity = :q, expiresAtEpoch = :exp',
                ConditionExpression:
                  'attribute_exists(PK) AND expiresAtEpoch > :nowSec',
                ExpressionAttributeValues: {
                  ':q': quantity,
                  ':exp': expiresAtEpoch,
                  ':nowSec': nowSec,
                },
              }),
              { abortSignal: signal },
            ),
          );
          return 'ok';
        }
        if (state.lines.length >= this.config.get('orders_cart_max_lines'))
          return 'line_limit';
        await this.send((signal) =>
          this.dynamo.doc.send(
            new TransactWriteCommand({
              TransactItems: [
                {
                  Put: {
                    TableName: this.table,
                    Item: {
                      ...key,
                      productId,
                      quantity,
                      addedAt: now.toISOString(),
                      expiresAtEpoch,
                    },
                  },
                },
                this.metaUpdate(cartId, state.metaVersion),
              ],
            }),
            { abortSignal: signal },
          ),
        );
        return 'ok';
      } catch (error) {
        if (!isCanceled(error)) throw error;
        // lost a race with another writer of this cart: read again
      }
    }
    throw new CartUnavailableError();
  }

  async merge(
    guestCartId: string,
    userCartId: string,
    now: Date,
  ): Promise<{ lines: CartLine[]; droppedLines: number }> {
    const expiresAtEpoch = this.expiry(now);
    const nowSec = Math.floor(now.getTime() / 1000);
    const limits = {
      maxLines: this.config.get('orders_cart_max_lines'),
      maxQuantity: this.config.get('orders_cart_max_quantity'),
    };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const [guest, user] = await Promise.all([
        this.read(guestCartId, now),
        this.read(userCartId, now),
      ]);
      if (guest.lines.length === 0)
        return { lines: user.lines, droppedLines: 0 };

      const merged = mergeCarts(user.lines, guest.lines, limits);
      const userBefore = new Map(user.lines.map((l) => [l.productId, l]));
      const items: unknown[] = [];
      let adds = 0;
      for (const line of merged.lines) {
        const before = userBefore.get(line.productId);
        if (before && before.quantity === line.quantity) continue;
        if (!before) adds += 1;
        items.push({
          Put: {
            TableName: this.table,
            Item: {
              PK: this.pk(userCartId),
              SK: `ITEM#${line.productId}`,
              productId: line.productId,
              quantity: line.quantity,
              addedAt: line.addedAt,
              expiresAtEpoch,
            },
            ...(before
              ? {
                  ConditionExpression: 'quantity = :read',
                  ExpressionAttributeValues: { ':read': before.quantity },
                }
              : {
                  ConditionExpression:
                    'attribute_not_exists(PK) OR expiresAtEpoch <= :nowSec',
                  ExpressionAttributeValues: { ':nowSec': nowSec },
                }),
          },
        });
      }
      for (const line of guest.lines)
        items.push({
          Delete: {
            TableName: this.table,
            Key: { PK: this.pk(guestCartId), SK: `ITEM#${line.productId}` },
            ConditionExpression: 'quantity = :read',
            ExpressionAttributeValues: { ':read': line.quantity },
          },
        });
      // The line cap is guarded by the user cart's version; the one corner where 50 puts and 50 deletes already fill
      // the transaction goes without it (a concurrent add in that very instant is the only thing it would catch).
      if (adds > 0 && items.length < MAX_TRANSACTION_OPS)
        items.push(this.metaUpdate(userCartId, user.metaVersion));

      try {
        await this.send((signal) =>
          this.dynamo.doc.send(
            new TransactWriteCommand({
              TransactItems: items as never,
            }),
            { abortSignal: signal },
          ),
        );
        return { lines: merged.lines, droppedLines: merged.droppedLines };
      } catch (error) {
        if (!isCanceled(error)) throw error;
        // another merge or write won: read both carts again (a finished merge leaves the guest cart empty)
      }
    }
    throw new CartUnavailableError();
  }

  async removeConsumed(
    cartId: string,
    consumed: Array<{ productId: string; quantity: number }>,
  ): Promise<void> {
    await Promise.all(
      consumed.map(async ({ productId, quantity }) => {
        try {
          await this.send((signal) =>
            this.dynamo.doc.send(
              new DeleteCommand({
                TableName: this.table,
                Key: { PK: this.pk(cartId), SK: `ITEM#${productId}` },
                ConditionExpression: 'quantity = :read',
                ExpressionAttributeValues: { ':read': quantity },
              }),
              { abortSignal: signal },
            ),
          );
        } catch (error) {
          // the line changed since checkout read it: it stays (the buyer edited the cart meanwhile)
          if (!isCanceled(error)) throw error;
        }
      }),
    );
  }
}
