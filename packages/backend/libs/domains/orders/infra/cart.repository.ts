import { Injectable } from '@nestjs/common';
import { BatchWriteCommand, DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';

export interface CartLine {
  productId: string;
  quantity: number;
  addedAt: string;
}

const TABLE = 'Carts';
const TTL_SEC = 30 * 86_400;
export const MAX_LINE_QUANTITY = 20;

/** DynamoDB cart (SD-19): see dynamodb/Carts.json for the key design. */
@Injectable()
export class CartRepository {
  constructor(private readonly dynamo: DynamoService) {}

  async list(cartId: string): Promise<CartLine[]> {
    const { Items = [] } = await this.dynamo.doc.send(
      new QueryCommand({
        TableName: this.dynamo.table(TABLE),
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `CART#${cartId}` },
      }),
    );
    return Items.map((i) => ({ productId: i.productId, quantity: i.quantity, addedAt: i.addedAt }));
  }

  async setLine(cartId: string, productId: string, quantity: number): Promise<void> {
    if (quantity <= 0) {
      await this.dynamo.doc.send(new DeleteCommand({ TableName: this.dynamo.table(TABLE), Key: { PK: `CART#${cartId}`, SK: `ITEM#${productId}` } }));
      return;
    }
    await this.dynamo.doc.send(
      new PutCommand({
        TableName: this.dynamo.table(TABLE),
        Item: {
          PK: `CART#${cartId}`,
          SK: `ITEM#${productId}`,
          productId,
          quantity: Math.min(quantity, MAX_LINE_QUANTITY),
          addedAt: new Date().toISOString(),
          expiresAtEpoch: Math.floor(Date.now() / 1000) + TTL_SEC,
        },
      }),
    );
  }

  /** Guest cart → user cart on login: quantities summed (capped), guest cart deleted. */
  async merge(fromCartId: string, toCartId: string): Promise<CartLine[]> {
    const [guest, user] = await Promise.all([this.list(fromCartId), this.list(toCartId)]);
    const merged = new Map(user.map((l) => [l.productId, l.quantity]));
    for (const line of guest) merged.set(line.productId, Math.min((merged.get(line.productId) ?? 0) + line.quantity, MAX_LINE_QUANTITY));

    const now = new Date().toISOString();
    const expiresAtEpoch = Math.floor(Date.now() / 1000) + TTL_SEC;
    const writes = [
      ...[...merged.entries()].map(([productId, quantity]) => ({
        PutRequest: { Item: { PK: `CART#${toCartId}`, SK: `ITEM#${productId}`, productId, quantity, addedAt: now, expiresAtEpoch } },
      })),
      ...guest.map((l) => ({ DeleteRequest: { Key: { PK: `CART#${fromCartId}`, SK: `ITEM#${l.productId}` } } })),
    ];
    for (let i = 0; i < writes.length; i += 25) {
      await this.dynamo.doc.send(new BatchWriteCommand({ RequestItems: { [this.dynamo.table(TABLE)]: writes.slice(i, i + 25) } }));
    }
    return this.list(toCartId);
  }

  async clear(cartId: string): Promise<void> {
    const lines = await this.list(cartId);
    for (let i = 0; i < lines.length; i += 25) {
      await this.dynamo.doc.send(
        new BatchWriteCommand({
          RequestItems: {
            [this.dynamo.table(TABLE)]: lines.slice(i, i + 25).map((l) => ({ DeleteRequest: { Key: { PK: `CART#${cartId}`, SK: `ITEM#${l.productId}` } } })),
          },
        }),
      );
    }
  }
}
