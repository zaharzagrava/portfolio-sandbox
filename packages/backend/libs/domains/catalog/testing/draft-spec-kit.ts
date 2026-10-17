import type { INestApplication } from '@nestjs/common';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v7 as uuidv7 } from 'uuid';
import * as Y from 'yjs';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { YClient, type YClientOptions } from '@app/test/fakes/y-client';
import { waitFor } from '@app/test/utils/async-helpers';
import { addMember } from '@app/test/utils/tenancy-fixtures';
import type { TestUser } from '@app/test/utils/catalog-app';
import {
  DOC_STORE,
  RING_REGISTRY,
  SNAPSHOT_STORE,
  type DocStore,
  type RingRegistry,
  type SnapshotStore,
} from '../domain/draft-ports';
import { seedListing, type ListingContent } from '../domain/listing-doc';
import type { CatalogTestApp } from './catalog-app';

/**
 * Shared helpers of the draft e2e files (S06 WP-11). Seeding writes the draft tables directly (test code may touch every
 * table, IX.6) so a spec arranges a state without going through the API under test.
 */
export interface SeededDraft {
  id: string;
  shopId: string;
}

export interface DraftSeed {
  title?: string;
  status?: 'DRAFT' | 'PUBLISHING' | 'PUBLISHED' | 'ARCHIVED';
  productId?: string | null;
  baseProductVersion?: number | null;
  leaseId?: string | null;
  leaseExpiresAt?: Date | null;
  updatedAt?: Date;
}

export async function seedDraft(
  app: INestApplication,
  shopId: string,
  createdBy: string,
  seed: DraftSeed & { id?: string } = {},
): Promise<SeededDraft> {
  const id = seed.id ?? uuidv7();
  const at = seed.updatedAt ?? new Date();
  await app.get(Sequelize).query(
    `INSERT INTO "ListingDraft" ("id","shopId","productId","baseProductVersion","title","status","createdBy",
        "publishLeaseId","publishLeaseExpiresAt","snapshotSeq","createdAt","updatedAt")
     VALUES (:id,:shopId,:productId,:base,:title,:status,:createdBy,:leaseId,:leaseExpiresAt,0,:at,:at)`,
    {
      replacements: {
        id,
        shopId,
        productId: seed.productId ?? null,
        base: seed.baseProductVersion ?? null,
        title: seed.title ?? `Draft ${id.slice(-6)}`,
        status: seed.status ?? 'DRAFT',
        createdBy,
        leaseId: seed.leaseId ?? null,
        leaseExpiresAt: seed.leaseExpiresAt ?? null,
        at,
      },
    },
  );
  return { id, shopId };
}

/** `count` drafts in one statement; `updatedAt` steps back one second per `group` rows (so ties exist). */
export async function seedDrafts(
  app: INestApplication,
  shopId: string,
  createdBy: string,
  count: number,
  options: { status?: DraftSeed['status']; group?: number; from?: Date } = {},
): Promise<void> {
  await app.get(Sequelize).query(
    `INSERT INTO "ListingDraft" ("id","shopId","title","status","createdBy","snapshotSeq","createdAt","updatedAt")
     SELECT uuidv7(), :shopId, 'Seeded ' || g, :status, :createdBy, 0, :from::timestamptz,
            :from::timestamptz - ((g / :group) * interval '1 second')
       FROM generate_series(1, :count) g`,
    {
      replacements: {
        shopId,
        createdBy,
        count,
        status: options.status ?? 'DRAFT',
        group: options.group ?? 1,
        from: options.from ?? new Date(),
      },
    },
  );
}

export async function draftRow<T extends Record<string, unknown>>(
  app: INestApplication,
  id: string,
): Promise<T | undefined> {
  const [found] = await app
    .get(Sequelize)
    .query<T>(`SELECT * FROM "ListingDraft" WHERE "id" = :id`, {
      type: QueryTypes.SELECT,
      replacements: { id },
    });
  return found;
}

export async function draftCount(
  app: INestApplication,
  where = 'TRUE',
  replacements: Record<string, unknown> = {},
): Promise<number> {
  const [found] = await app
    .get(Sequelize)
    .query<{ n: string }>(
      `SELECT count(*) AS n FROM "ListingDraft" WHERE ${where}`,
      { type: QueryTypes.SELECT, replacements },
    );
  return Number(found.n);
}

/**
 * Puts listing content into a draft's stored document (one log entry), as if an editor had typed it earlier. No room is
 * loaded for the draft, so a publish reads this stored state.
 */
export async function writeContent(
  app: INestApplication,
  draft: SeededDraft,
  content: Partial<ListingContent>,
  fromSeq = 1,
): Promise<void> {
  const doc = seedListing(content);
  await app
    .get<DocStore>(DOC_STORE, { strict: false })
    .append(draft.id, fromSeq, Y.encodeStateAsUpdate(doc));
  doc.destroy();
}

/** Changes a draft's stored document as an editor would (the diff goes to the log); `fn` edits the loaded document. */
export async function editStored(
  app: INestApplication,
  draft: SeededDraft,
  fn: (doc: Y.Doc) => void,
): Promise<void> {
  const store = app.get<DocStore>(DOC_STORE, { strict: false });
  const { doc, seq } = await store.load(draft.shopId, draft.id);
  const before = Y.encodeStateVector(doc);
  fn(doc);
  await store.append(draft.id, seq + 1, Y.encodeStateAsUpdate(doc, before));
  doc.destroy();
}

/** A listing that passes every publish check. */
export const VALID_LISTING: Partial<ListingContent> = {
  title: 'AirPods Pro 3',
  description: 'Adaptive audio.',
  priceMinor: 24_900,
  brand: 'Apple',
  category: 'audio',
  quantity: 5,
};

/** The sequence numbers of the log entries stored for a draft (the update log, not the snapshot pointer). */
export async function logSeqs(
  app: INestApplication,
  draftId: string,
): Promise<number[]> {
  const dynamo = app.get(DynamoService, { strict: false });
  const out = await dynamo.doc.send(
    new QueryCommand({
      TableName: dynamo.table('DocUpdates'),
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `DOC#${draftId}` },
      ProjectionExpression: 'SK',
      ConsistentRead: true,
    }),
  );
  return (out.Items ?? []).map((i) => Number(i.SK));
}

export async function versionRows<T extends Record<string, unknown>>(
  app: INestApplication,
  draftId: string,
): Promise<T[]> {
  return app
    .get(Sequelize)
    .query<T>(
      `SELECT * FROM "ListingDraftVersion" WHERE "draftId" = :draftId ORDER BY "createdAt", "id"`,
      { type: QueryTypes.SELECT, replacements: { draftId } },
    );
}

export async function seedVersion(
  app: INestApplication,
  draft: SeededDraft,
  createdBy: string,
  seed: {
    name?: string;
    kind?: 'named' | 'published';
    createdAt?: Date;
    /** The content of the stored snapshot (default: an empty document); `false` stores no object at all. */
    content?: Y.Doc | false;
  } = {},
): Promise<string> {
  const id = uuidv7();
  if (seed.content !== false)
    await app
      .get<SnapshotStore>(SNAPSHOT_STORE, { strict: false })
      .put(
        `versions/${id}`,
        Y.encodeStateAsUpdate(seed.content ?? new Y.Doc()),
      );
  await app.get(Sequelize).query(
    `INSERT INTO "ListingDraftVersion" ("id","draftId","shopId","name","kind","objectKey","createdBy","createdAt")
     VALUES (:id,:draftId,:shopId,:name,:kind,:key,:createdBy,:at)`,
    {
      replacements: {
        id,
        draftId: draft.id,
        shopId: draft.shopId,
        name: seed.name ?? `Version ${id.slice(-6)}`,
        kind: seed.kind ?? 'named',
        key: `versions/${id}`,
        createdBy,
        at: seed.createdAt ?? new Date(),
      },
    },
  );
  return id;
}

/**
 * Waits until the editing instance of this app is registered, then announces it again: `reset()` flushes Redis, including
 * the ring entry, and the next heartbeat is seconds away.
 */
export async function announceRing(app: INestApplication): Promise<void> {
  const ring = app.get<RingRegistry>(RING_REGISTRY, { strict: false });
  await waitFor(() => Promise.resolve(ring.registered()), {
    description: 'the editing instance registered',
  });
  await ring.heartbeatNow();
  await waitFor(async () => (await ring.ownerOf(uuidv7())) !== null, {
    description: 'an editing instance in the ring',
  });
}

/** After several instances announced themselves, each process reads the ring again so all of them see all. */
export async function settleRing(...apps: INestApplication[]): Promise<void> {
  for (const app of apps)
    await app.get<RingRegistry>(RING_REGISTRY, { strict: false }).refreshNow();
}

export interface Connection {
  url: string;
  ticket: string;
  canWrite: boolean;
  expiresAt: string;
}

/** Calls the connect route as `user` and returns the parsed answer. */
export async function connectTo(
  t: CatalogTestApp,
  user: TestUser,
  shopId: string,
  draftId: string,
): Promise<Connection> {
  const res = await t
    .as(user)
    .post(`/api/shops/${shopId}/drafts/${draftId}/connect`)
    .expect(200);
  return res.body as Connection;
}

/** Connects with the ticket of a fresh connect call and opens the editing socket. */
export async function openEditor(
  t: CatalogTestApp,
  user: TestUser,
  shopId: string,
  draftId: string,
  options: YClientOptions = {},
): Promise<YClient> {
  const c = await connectTo(t, user, shopId, draftId);
  return new YClient(`${c.url}?ticket=${c.ticket}`, options);
}

/** Captures what the structured logger writes to stdout (the spec reads the lines; nothing reaches the terminal). */
export function captureStdout() {
  const chunks: string[] = [];
  const spy = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
  return {
    text: (from = 0) => chunks.join('').slice(from),
    length: () => chunks.join('').length,
    /** The JSON log lines written after `from` characters. */
    lines: (from = 0) =>
      chunks
        .join('')
        .slice(from)
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return {};
          }
        }),
    restore: () => spy.mockRestore(),
  };
}

/** Members of the shop with the role, one new user each (a room takes 5 connections per user). */
export async function addUsers(
  t: CatalogTestApp,
  shopId: string,
  count: number,
  role: 'STAFF' | 'VIEWER' = 'STAFF',
): Promise<TestUser[]> {
  const users: TestUser[] = [];
  for (let i = 0; i < count; i++) {
    const user = await t.newUser();
    await addMember(t.app, shopId, user.id, role);
    users.push(user);
  }
  return users;
}
