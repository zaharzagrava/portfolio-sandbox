import { Injectable } from '@nestjs/common';
import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { createHash, randomBytes } from 'node:crypto';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import type {
  RotateOutcome,
  SessionMeta,
  SessionRecord,
  SessionRepository,
} from '../../domain/ports';
import {
  epochSec,
  refreshExpiry,
  SESSION_ABSOLUTE_SEC,
} from '../../domain/session-policy';

const TABLE = 'Auth';
const TRANSACTION_RETRIES = 4;

export const digestOf = (token: string): string =>
  createHash('sha256').update(token).digest('base64url');

const sessionKey = (sid: string) => ({ PK: `SESSION#${sid}`, SK: 'META' });
const tokenKey = (digest: string) => ({ PK: `RT#${digest}`, SK: 'META' });

/**
 * Sessions and rotating refresh tokens in DynamoDB (single table, `dynamodb/Auth.json`). Only the SHA-256 of a refresh
 * token is stored. A refresh is one `TransactWriteItems`: spend the presented digest (conditional), assert the session
 * is live and touch it, store the successor. The TTL attribute is cleanup only; expiry is checked at use.
 */
@Injectable()
export class DynamoSessionRepository implements SessionRepository {
  constructor(private readonly dynamo: DynamoService) {}

  async create(input: {
    sid: string;
    userId: string;
    amr: string[];
    meta: SessionMeta;
    now: Date;
  }): Promise<{ session: SessionRecord; refreshToken: string }> {
    const { sid, userId, amr, meta, now } = input;
    const createdAt = now.toISOString();
    const absoluteExpiry = epochSec(now) + SESSION_ABSOLUTE_SEC;
    const familyId = sid; // one family per session: the whole session is the unit of revocation
    const refreshToken = randomBytes(32).toString('base64url');
    const session: SessionRecord = {
      sid,
      userId,
      familyId,
      ...(meta.device && { device: meta.device }),
      ...(meta.ip && { ip: meta.ip }),
      amr,
      createdAt,
      lastUsedAt: createdAt,
      absoluteExpiry,
    };
    await this.dynamo.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.dynamo.table(TABLE),
              Item: {
                ...sessionKey(sid),
                GSI1PK: `USER#${userId}`,
                GSI1SK: `SESSION#${createdAt}#${sid}`,
                ...session,
                expiresAtEpoch: absoluteExpiry,
              },
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          {
            Put: {
              TableName: this.dynamo.table(TABLE),
              Item: this.tokenItem(
                refreshToken,
                sid,
                userId,
                familyId,
                refreshExpiry(now, absoluteExpiry),
              ),
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
        ],
      }),
    );
    return { session, refreshToken };
  }

  async rotate(refreshToken: string, now: Date): Promise<RotateOutcome> {
    const nowEpoch = epochSec(now);
    const key = tokenKey(digestOf(refreshToken));

    for (let attempt = 0; attempt < TRANSACTION_RETRIES; attempt++) {
      const { Item: token } = await this.dynamo.doc.send(
        new GetCommand({
          TableName: this.dynamo.table(TABLE),
          Key: key,
          ConsistentRead: true,
        }),
      );
      if (!token) return { ok: false, reason: 'unknown' };
      const ids = { sid: token.sid as string, userId: token.userId as string };
      if ((token.expiresAtEpoch as number) <= nowEpoch)
        return { ok: false, reason: 'expired', ...ids };
      if (token.usedAt) return { ok: false, reason: 'reuse', ...ids };

      const session = await this.get(ids.sid);
      if (!session || session.revokedAt)
        return { ok: false, reason: 'revoked', ...ids };
      if (session.absoluteExpiry <= nowEpoch)
        return { ok: false, reason: 'expired', ...ids };

      const next = randomBytes(32).toString('base64url');
      const stamp = now.toISOString();
      try {
        await this.dynamo.doc.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: this.dynamo.table(TABLE),
                  Key: key,
                  UpdateExpression: 'SET usedAt = :now',
                  ConditionExpression:
                    'attribute_exists(PK) AND attribute_not_exists(usedAt) AND expiresAtEpoch > :epoch',
                  ExpressionAttributeValues: {
                    ':now': stamp,
                    ':epoch': nowEpoch,
                  },
                },
              },
              {
                Update: {
                  TableName: this.dynamo.table(TABLE),
                  Key: sessionKey(ids.sid),
                  UpdateExpression: 'SET lastUsedAt = :now',
                  ConditionExpression:
                    'attribute_exists(PK) AND attribute_not_exists(revokedAt)',
                  ExpressionAttributeValues: { ':now': stamp },
                },
              },
              {
                Put: {
                  TableName: this.dynamo.table(TABLE),
                  Item: this.tokenItem(
                    next,
                    ids.sid,
                    ids.userId,
                    token.familyId as string,
                    refreshExpiry(now, session.absoluteExpiry),
                  ),
                  ConditionExpression: 'attribute_not_exists(PK)',
                },
              },
            ],
          }),
        );
        return {
          ok: true,
          session: { ...session, lastUsedAt: stamp },
          refreshToken: next,
        };
      } catch (error) {
        if (!(error instanceof TransactionCanceledException)) throw error;
        // A concurrent transaction on the same item cancels us without deciding anything: look again. On the next
        // pass the winner's `usedAt` is visible and the answer is "reuse".
        await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
      }
    }
    return { ok: false, reason: 'unknown' };
  }

  async get(sid: string): Promise<SessionRecord | undefined> {
    const { Item } = await this.dynamo.doc.send(
      new GetCommand({
        TableName: this.dynamo.table(TABLE),
        Key: sessionKey(sid),
        ConsistentRead: true,
      }),
    );
    return Item as SessionRecord | undefined;
  }

  async listForUser(userId: string): Promise<SessionRecord[]> {
    const { Items = [] } = await this.dynamo.doc.send(
      new QueryCommand({
        TableName: this.dynamo.table(TABLE),
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :prefix)',
        ExpressionAttributeValues: {
          ':pk': `USER#${userId}`,
          ':prefix': 'SESSION#',
        },
        ScanIndexForward: false,
      }),
    );
    return Items as SessionRecord[];
  }

  async revoke(sid: string, reason: string, now: Date): Promise<void> {
    try {
      await this.dynamo.doc.send(
        new UpdateCommand({
          TableName: this.dynamo.table(TABLE),
          Key: sessionKey(sid),
          UpdateExpression:
            'SET revokedAt = if_not_exists(revokedAt, :now), revokeReason = if_not_exists(revokeReason, :reason)',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeValues: {
            ':now': now.toISOString(),
            ':reason': reason,
          },
        }),
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    }
  }

  private tokenItem(
    token: string,
    sid: string,
    userId: string,
    familyId: string,
    expiresAtEpoch: number,
  ) {
    return {
      ...tokenKey(digestOf(token)),
      sid,
      userId,
      familyId,
      expiresAtEpoch,
    };
  }
}
