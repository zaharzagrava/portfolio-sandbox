import { Injectable } from '@nestjs/common';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import {
  DependencyUnavailableError,
  type CreateOutcome,
  type LinkRepository,
  type ListCursorKey,
  type StoredLink,
  type UpdateOutcome,
} from '../domain/ports';
import { purgeAtEpoch } from '../domain/link-state';

const TABLE = 'Links';
const OWNER_INDEX = 'byOwnerV2';
const READ_TIMEOUT_MS = 500;
const WRITE_TIMEOUT_MS = 1_000;
const BATCH_RETRIES = 3;
const GENERATED_SHAPE = /^[0-9A-Za-z]{7}$/;

const ownerCounterKey = (ownerId: string) => `#owner#${ownerId}`;
const sortKey = (link: { createdAt: string; code: string }) =>
  `${link.createdAt}#${link.code}`;

type Row = Record<string, any>;

/**
 * DynamoDB `Links` (data-model.md): one item per link, one counter item per owner (`#owner#<id>`). Invariants are
 * conditional writes: `attribute_not_exists(code)` claims a code, `activeCount < :max` reserves a place,
 * `status = ACTIVE` guards change and disable. A store that does not answer within the timeout is
 * `DependencyUnavailableError`, never "not found".
 */
@Injectable()
export class DynamoLinkRepository implements LinkRepository {
  constructor(private readonly dynamo: DynamoService) {}

  private get table(): string {
    return this.dynamo.table(TABLE);
  }

  private async guarded<T>(
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      return await run(AbortSignal.timeout(timeoutMs));
    } catch (error) {
      if (
        error instanceof ConditionalCheckFailedException ||
        error instanceof TransactionCanceledException
      )
        throw error;
      throw new DependencyUnavailableError('link-store', error);
    }
  }

  async create(
    link: StoredLink,
    limit: number,
    nowIso: string,
  ): Promise<CreateOutcome> {
    const first = await this.tryCreate(link, limit);
    if (first !== 'limit_reached') return first;
    // The counter counts links that may have expired since; recount the live ones once before refusing.
    const live = await this.recount(link.ownerId, nowIso, limit);
    if (live >= limit) return 'limit_reached';
    return this.tryCreate(link, limit);
  }

  private async tryCreate(
    link: StoredLink,
    limit: number,
  ): Promise<CreateOutcome> {
    const purge = purgeAtEpoch(link);
    // No `expiresAt` attribute at all for an open-ended link: a stored NULL would fail the "not expired" condition.
    const { expiresAt, ...rest } = link;
    const item: Row = {
      ...rest,
      ...(expiresAt && { expiresAt }),
      sk: sortKey(link),
      ...(purge !== undefined && { purgeAtEpoch: purge }),
    };
    try {
      await this.guarded(WRITE_TIMEOUT_MS, (abortSignal) =>
        this.dynamo.transactWrite(
          [
            {
              Put: {
                TableName: this.table,
                Item: item,
                ConditionExpression: 'attribute_not_exists(code)',
              },
            },
            {
              Update: {
                TableName: this.table,
                Key: { code: ownerCounterKey(link.ownerId) },
                UpdateExpression: 'ADD activeCount :one',
                ConditionExpression:
                  'attribute_not_exists(activeCount) OR activeCount < :max',
                ExpressionAttributeValues: { ':one': 1, ':max': limit },
              },
            },
          ],
          { abortSignal },
        ),
      );
      return 'created';
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        const reasons = error.CancellationReasons ?? [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed') return 'code_taken';
        if (reasons[1]?.Code === 'ConditionalCheckFailed')
          return 'limit_reached';
      }
      if (error instanceof ConditionalCheckFailedException) return 'code_taken';
      throw error;
    }
  }

  /** Writes the true number of live links as the counter (conditional on nobody else having moved it). */
  private async recount(
    ownerId: string,
    nowIso: string,
    limit: number,
  ): Promise<number> {
    const counter = await this.guarded(READ_TIMEOUT_MS, (abortSignal) =>
      this.dynamo.doc.send(
        new GetCommand({
          TableName: this.table,
          Key: { code: ownerCounterKey(ownerId) },
          ConsistentRead: true,
        }),
        { abortSignal },
      ),
    );
    const recorded: number | undefined = counter.Item?.activeCount;
    let live = 0;
    let startKey: Row | undefined;
    do {
      const page = await this.guarded(READ_TIMEOUT_MS, (abortSignal) =>
        this.dynamo.doc.send(
          new QueryCommand({
            TableName: this.table,
            IndexName: OWNER_INDEX,
            KeyConditionExpression: 'ownerId = :o',
            ExpressionAttributeValues: { ':o': ownerId },
            ExclusiveStartKey: startKey,
          }),
          { abortSignal },
        ),
      );
      for (const row of (page.Items ?? []) as Row[]) {
        const link = this.read(row);
        if (
          link.status === 'ACTIVE' &&
          (!link.expiresAt || link.expiresAt > nowIso)
        )
          live++;
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey && live < limit);
    if (recorded !== live) {
      await this.guarded(WRITE_TIMEOUT_MS, (abortSignal) =>
        this.dynamo.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { code: ownerCounterKey(ownerId) },
            UpdateExpression: 'SET activeCount = :live',
            ConditionExpression:
              recorded === undefined
                ? 'attribute_not_exists(activeCount)'
                : 'activeCount = :old',
            ExpressionAttributeValues: {
              ':live': live,
              ...(recorded !== undefined && { ':old': recorded }),
            },
          }),
          { abortSignal },
        ),
      ).catch((error) => {
        // somebody else moved it first; the next create recounts again
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      });
    }
    return live;
  }

  async get(code: string): Promise<StoredLink | null> {
    const res = await this.guarded(READ_TIMEOUT_MS, (abortSignal) =>
      this.dynamo.doc.send(
        new GetCommand({ TableName: this.table, Key: { code } }),
        { abortSignal },
      ),
    );
    return res.Item ? this.read(res.Item as Row) : null;
  }

  async getOwned(ownerId: string, code: string): Promise<StoredLink | null> {
    const link = await this.get(code);
    return link && link.ownerId === ownerId ? link : null;
  }

  private activeCondition =
    'ownerId = :o AND (attribute_not_exists(#st) OR #st = :active) AND (attribute_not_exists(expiresAt) OR expiresAt > :now) AND (attribute_not_exists(expiresAtEpoch) OR expiresAtEpoch > :nowEpoch)';

  private activeValues(ownerId: string, nowIso: string) {
    return {
      ':o': ownerId,
      ':active': 'ACTIVE',
      ':now': nowIso,
      ':nowEpoch': Math.floor(Date.parse(nowIso) / 1000),
    };
  }

  async updateDestination(
    ownerId: string,
    code: string,
    destination: string,
    nowIso: string,
  ): Promise<UpdateOutcome> {
    try {
      const res = await this.guarded(WRITE_TIMEOUT_MS, (abortSignal) =>
        this.dynamo.doc.send(
          new UpdateCommand({
            TableName: this.table,
            Key: { code },
            UpdateExpression: 'SET destination = :d, updatedAt = :now',
            ConditionExpression: this.activeCondition,
            ExpressionAttributeNames: { '#st': 'status' },
            ExpressionAttributeValues: {
              ...this.activeValues(ownerId, nowIso),
              ':d': destination,
            },
            ReturnValues: 'ALL_NEW',
          }),
          { abortSignal },
        ),
      );
      return { kind: 'updated', link: this.read(res.Attributes as Row) };
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException)
        return this.classifyFailure(ownerId, code);
      throw error;
    }
  }

  async disable(
    ownerId: string,
    code: string,
    nowIso: string,
  ): Promise<UpdateOutcome> {
    const purge = purgeAtEpoch({ expiresAt: null, disabledAt: nowIso });
    const linkUpdate = {
      TableName: this.table,
      Key: { code },
      UpdateExpression:
        'SET #st = :disabled, disabledAt = :now, updatedAt = :now, purgeAtEpoch = :purge',
      ConditionExpression: this.activeCondition,
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ...this.activeValues(ownerId, nowIso),
        ':disabled': 'DISABLED',
        ':purge': purge,
      },
    };
    try {
      await this.guarded(WRITE_TIMEOUT_MS, (abortSignal) =>
        this.dynamo.transactWrite(
          [
            { Update: linkUpdate },
            {
              Update: {
                TableName: this.table,
                Key: { code: ownerCounterKey(ownerId) },
                UpdateExpression: 'ADD activeCount :minus',
                ConditionExpression:
                  'attribute_exists(activeCount) AND activeCount > :zero',
                ExpressionAttributeValues: { ':minus': -1, ':zero': 0 },
              },
            },
          ],
          { abortSignal },
        ),
      );
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        const reasons = error.CancellationReasons ?? [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed')
          return this.classifyFailure(ownerId, code);
        // only the counter condition failed (drift): the disable itself still has to happen
        return this.disableWithoutCounter(ownerId, code, linkUpdate);
      }
      if (error instanceof ConditionalCheckFailedException)
        return this.classifyFailure(ownerId, code);
      throw error;
    }
    const link = await this.get(code);
    return link ? { kind: 'updated', link } : { kind: 'not_found' };
  }

  private async disableWithoutCounter(
    ownerId: string,
    code: string,
    update: ConstructorParameters<typeof UpdateCommand>[0],
  ): Promise<UpdateOutcome> {
    try {
      await this.guarded(WRITE_TIMEOUT_MS, (abortSignal) =>
        this.dynamo.doc.send(new UpdateCommand(update), { abortSignal }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException)
        return this.classifyFailure(ownerId, code);
      throw error;
    }
    const link = await this.get(code);
    return link ? { kind: 'updated', link } : { kind: 'not_found' };
  }

  /** A failed condition means "not yours or not there" (404) or "not active any more" (409). */
  private async classifyFailure(
    ownerId: string,
    code: string,
  ): Promise<UpdateOutcome> {
    const link = await this.getOwned(ownerId, code);
    return link ? { kind: 'not_active' } : { kind: 'not_found' };
  }

  async listByOwner(
    ownerId: string,
    limit: number,
    after?: ListCursorKey,
  ): Promise<StoredLink[]> {
    const res = await this.guarded(READ_TIMEOUT_MS, (abortSignal) =>
      this.dynamo.doc.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: OWNER_INDEX,
          KeyConditionExpression: after
            ? 'ownerId = :o AND sk < :after'
            : 'ownerId = :o',
          ExpressionAttributeValues: {
            ':o': ownerId,
            ...(after && { ':after': sortKey(after) }),
          },
          ScanIndexForward: false,
          Limit: limit,
        }),
        { abortSignal },
      ),
    );
    return ((res.Items ?? []) as Row[]).map((row) => this.read(row));
  }

  async batchGet(codes: string[]): Promise<StoredLink[]> {
    const unique = [...new Set(codes)];
    if (unique.length === 0) return [];
    const found: StoredLink[] = [];
    let keys: Row[] = unique.map((code) => ({ code }));
    for (let attempt = 0; keys.length > 0; attempt++) {
      if (attempt > BATCH_RETRIES)
        throw new DependencyUnavailableError('link-store');
      const res = await this.guarded(READ_TIMEOUT_MS, (abortSignal) =>
        this.dynamo.doc.send(
          new BatchGetCommand({
            RequestItems: { [this.table]: { Keys: keys } },
          }),
          { abortSignal },
        ),
      );
      for (const row of (res.Responses?.[this.table] ?? []) as Row[])
        found.push(this.read(row));
      keys = (res.UnprocessedKeys?.[this.table]?.Keys ?? []) as Row[];
    }
    return found;
  }

  async scanCodes(
    pageSize: number,
    startKey?: unknown,
  ): Promise<{ codes: string[]; next?: unknown }> {
    const res = await this.guarded(WRITE_TIMEOUT_MS, (abortSignal) =>
      this.dynamo.doc.send(
        new ScanCommand({
          TableName: this.table,
          Limit: pageSize,
          ExclusiveStartKey: startKey as Row | undefined,
        }),
        { abortSignal },
      ),
    );
    const rows = ((res.Items ?? []) as Row[]).filter(
      (row) => !String(row.code).startsWith('#'),
    );
    await Promise.all(
      rows
        .filter((row) => row.sk === undefined)
        .map((row) => this.backfill(row)),
    );
    return {
      codes: rows.map((row) => String(row.code)),
      next: res.LastEvaluatedKey,
    };
  }

  /** Rows written before S37 get the attributes the new reads rely on (idempotent: conditional on no `sk`). */
  private async backfill(row: Row): Promise<void> {
    const link = this.read(row);
    const expiresAt = link.expiresAt;
    const purge = purgeAtEpoch(link);
    await this.guarded(WRITE_TIMEOUT_MS, (abortSignal) =>
      this.dynamo.doc.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { code: link.code },
          UpdateExpression:
            'SET sk = :sk, #st = :st, kind = :kind, updatedAt = :updated' +
            (expiresAt ? ', expiresAt = :exp' : '') +
            (purge !== undefined ? ', purgeAtEpoch = :purge' : ''),
          ConditionExpression: 'attribute_not_exists(sk)',
          ExpressionAttributeNames: { '#st': 'status' },
          ExpressionAttributeValues: {
            ':sk': sortKey(link),
            ':st': link.status,
            ':kind': link.kind,
            ':updated': link.updatedAt,
            ...(expiresAt && { ':exp': expiresAt }),
            ...(purge !== undefined && { ':purge': purge }),
          },
        }),
        { abortSignal },
      ),
    ).catch((error) => {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
    });
  }

  /** Reads tolerate rows from before S37: missing `status`/`kind`/`updatedAt`, `expiresAtEpoch` instead of `expiresAt`. */
  private read(row: Row): StoredLink {
    const expiresAt: string | null =
      row.expiresAt ??
      (typeof row.expiresAtEpoch === 'number'
        ? new Date(row.expiresAtEpoch * 1000).toISOString()
        : null);
    return {
      code: row.code,
      kind:
        row.kind ?? (GENERATED_SHAPE.test(row.code) ? 'generated' : 'custom'),
      ownerId: row.ownerId,
      destination: row.destination,
      status: row.status ?? 'ACTIVE',
      createdAt: row.createdAt,
      updatedAt: row.updatedAt ?? row.createdAt,
      expiresAt,
      ...(row.disabledAt && { disabledAt: row.disabledAt }),
    };
  }
}
