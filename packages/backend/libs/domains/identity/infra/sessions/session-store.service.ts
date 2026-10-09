import { Injectable } from '@nestjs/common';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { createHash, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';

export interface SessionInfo {
  sid: string;
  userId: string;
  familyId: string;
  device?: string;
  ip?: string;
  createdAt: string;
  revokedAt?: string;
}

export type RotateResult =
  | { ok: true; session: SessionInfo; refreshToken: string }
  | { ok: false; reason: 'unknown' | 'expired' | 'revoked' | 'reuse_detected' };

const TABLE = 'Auth';
const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('base64url');

/**
 * Sessions + rotating refresh tokens in DynamoDB (single-table, see
 * dynamodb/Auth.json). Refresh tokens are opaque random values; only their
 * SHA-256 is stored. Each refresh atomically marks the presented token used
 * and issues a new one in the same "family". Presenting an already-used token
 * means it was stolen (or replayed): the whole session is revoked
 * (OAuth 2.0 Security BCP refresh-token rotation, lesson 05/02 §1).
 */
@Injectable()
export class SessionStore {
  constructor(
    private readonly dynamo: DynamoService,
    private readonly redis: RedisService,
  ) {}

  async create(
    userId: string,
    ttlDays: number,
    meta: { device?: string; ip?: string } = {},
  ) {
    const sid = uuidv7();
    const familyId = uuidv7();
    const createdAt = new Date().toISOString();
    const expiresAtEpoch = Math.floor(Date.now() / 1000) + ttlDays * 86_400;
    const refreshToken = randomBytes(32).toString('base64url');

    await this.dynamo.doc.send(
      new BatchWriteCommand({
        RequestItems: {
          [this.dynamo.table(TABLE)]: [
            {
              PutRequest: {
                Item: {
                  PK: `SESSION#${sid}`,
                  SK: 'META',
                  GSI1PK: `USER#${userId}`,
                  GSI1SK: `SESSION#${createdAt}#${sid}`,
                  sid,
                  userId,
                  familyId,
                  createdAt,
                  expiresAtEpoch,
                  ...meta,
                },
              },
            },
            {
              PutRequest: {
                Item: this.tokenItem(
                  refreshToken,
                  sid,
                  userId,
                  familyId,
                  expiresAtEpoch,
                ),
              },
            },
          ],
        },
      }),
    );

    return {
      session: { sid, userId, familyId, createdAt, ...meta } as SessionInfo,
      refreshToken,
    };
  }

  /**
   * One-time-use rotation with reuse detection. `reuseGraceMs`: re-presenting a token that was rotated only
   * moments ago is a benign race (two tabs, a response the browser dropped mid-navigation) - it gets another
   * successor instead of revoking. Outside that window a reused token means theft: the session is revoked.
   */
  async rotate(
    refreshToken: string,
    ttlDays: number,
    reuseGraceMs = 0,
  ): Promise<RotateResult> {
    const key = { PK: `RT#${hashToken(refreshToken)}`, SK: 'META' };
    const { Item: token } = await this.dynamo.doc.send(
      new GetCommand({ TableName: this.dynamo.table(TABLE), Key: key }),
    );
    if (!token) return { ok: false, reason: 'unknown' };
    if (token.expiresAtEpoch < Date.now() / 1000)
      return { ok: false, reason: 'expired' };

    const session = await this.get(token.sid);
    if (!session || session.revokedAt) return { ok: false, reason: 'revoked' };

    try {
      await this.dynamo.doc.send(
        new UpdateCommand({
          TableName: this.dynamo.table(TABLE),
          Key: key,
          UpdateExpression: 'SET usedAt = :now',
          ConditionExpression: 'attribute_not_exists(usedAt)',
          ExpressionAttributeValues: { ':now': new Date().toISOString() },
        }),
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      const { Item: used } = await this.dynamo.doc.send(
        new GetCommand({ TableName: this.dynamo.table(TABLE), Key: key }),
      );
      const usedAgoMs = used?.usedAt
        ? Date.now() - Date.parse(used.usedAt)
        : Infinity;
      if (usedAgoMs > reuseGraceMs) {
        await this.revoke(token.sid, 'refresh_token_reuse');
        return { ok: false, reason: 'reuse_detected' };
      }
    }

    const next = randomBytes(32).toString('base64url');
    const expiresAtEpoch = Math.floor(Date.now() / 1000) + ttlDays * 86_400;
    await this.dynamo.doc.send(
      new PutCommand({
        TableName: this.dynamo.table(TABLE),
        Item: this.tokenItem(
          next,
          token.sid,
          token.userId,
          token.familyId,
          expiresAtEpoch,
        ),
      }),
    );
    return { ok: true, session, refreshToken: next };
  }

  async get(sid: string): Promise<SessionInfo | undefined> {
    const { Item } = await this.dynamo.doc.send(
      new GetCommand({
        TableName: this.dynamo.table(TABLE),
        Key: { PK: `SESSION#${sid}`, SK: 'META' },
      }),
    );
    return Item as SessionInfo | undefined;
  }

  async listForUser(userId: string): Promise<SessionInfo[]> {
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
    return Items as SessionInfo[];
  }

  /**
   * Durable revocation in Dynamo + a Redis marker that lives as long as the
   * longest access token could, so `@Sensitive()` endpoints reject the
   * session's still-valid access tokens immediately.
   */
  async revoke(
    sid: string,
    reason: string,
    accessTokenTtlSec = 3_600,
  ): Promise<void> {
    await this.dynamo.doc.send(
      new UpdateCommand({
        TableName: this.dynamo.table(TABLE),
        Key: { PK: `SESSION#${sid}`, SK: 'META' },
        UpdateExpression:
          'SET revokedAt = if_not_exists(revokedAt, :now), revokeReason = :reason',
        ExpressionAttributeValues: {
          ':now': new Date().toISOString(),
          ':reason': reason,
        },
      }),
    );
    await this.redis.client.set(
      `auth:revoked:${sid}`,
      reason,
      'EX',
      accessTokenTtlSec,
    );
  }

  async revokeAllForUser(
    userId: string,
    reason: string,
    accessTokenTtlSec?: number,
  ): Promise<number> {
    const sessions = (await this.listForUser(userId)).filter(
      (s) => !s.revokedAt,
    );
    await Promise.all(
      sessions.map((s) => this.revoke(s.sid, reason, accessTokenTtlSec)),
    );
    return sessions.length;
  }

  async isRevoked(sid: string): Promise<boolean> {
    return (await this.redis.client.exists(`auth:revoked:${sid}`)) === 1;
  }

  private tokenItem(
    token: string,
    sid: string,
    userId: string,
    familyId: string,
    expiresAtEpoch: number,
  ) {
    return {
      PK: `RT#${hashToken(token)}`,
      SK: 'META',
      sid,
      userId,
      familyId,
      expiresAtEpoch,
    };
  }
}
