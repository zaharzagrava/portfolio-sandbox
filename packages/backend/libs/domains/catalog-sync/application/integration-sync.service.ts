import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize, Transaction } from 'sequelize';
import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { SecretBox } from '@app/domains/identity';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { RateLimiterService } from '@app/infrastructure/rate-limit/rate-limiter.service';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { KafkaTopicGroup } from '@app/infrastructure/outbox/outbox.model';
import { Environment } from '@app/common/types';
import { sleep } from '@app/common/core/backoff';
import { CommerceProvider, NormalizedProduct } from '../domain/provider.port';
import { ShopifyProvider } from '../infra/shopify.provider';
import { FakeProvider } from '../infra/fake.provider';

export const SYNC_QUEUE = 'integration-sync';
export const BACKFILL_QUEUE = 'integration-backfill';
/** Re-read the last 5 minutes on every run: provider clocks and eventual consistency make "updated_at > watermark" lossy. */
const OVERLAP_MS = 5 * 60_000;

interface IntegrationRow {
  id: string;
  shopId: string;
  provider: 'shopify' | 'woocommerce' | 'fake';
  externalShop: string;
  credentialsSealed: string;
  status: string;
}

/** Hash of what we sync - equal hash = nothing changed (overlap re-read, or the echo of our own write). */
export const syncHash = (p: Pick<NormalizedProduct, 'title' | 'description' | 'priceMinor' | 'stock' | 'category' | 'brand'>) =>
  createHash('sha256').update(JSON.stringify([p.title, p.description, p.priceMinor, p.stock, p.category, p.brand])).digest('hex');

@Injectable()
export class IntegrationSyncService {
  private readonly logger = new Logger(IntegrationSyncService.name);
  /** Fake providers live in memory per integration (local dev + specs only). */
  readonly fakes = new Map<string, FakeProvider>();

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly box: SecretBox,
    private readonly queue: TaskQueue,
    private readonly limiter: RateLimiterService,
    private readonly outbox: OutboxService,
    private readonly config: ApiConfigService,
  ) {}

  async connect(shopId: string, provider: IntegrationRow['provider'], externalShop: string, credentials: Record<string, string>) {
    if (provider === 'fake' && this.config.get('node_env') === Environment.production) throw new ForbiddenException();
    const [row] = await this.sequelize.query<{ id: string }>(
      `INSERT INTO "Integration" ("shopId", provider, "externalShop", "credentialsSealed") VALUES (:shopId, :provider, :externalShop, :sealed)
       ON CONFLICT ("shopId", provider, "externalShop") DO UPDATE SET "credentialsSealed" = EXCLUDED."credentialsSealed", status = 'ACTIVE' RETURNING id`,
      { type: QueryTypes.SELECT, replacements: { shopId, provider, externalShop, sealed: this.box.seal(JSON.stringify(credentials)) } },
    );
    // The first full pull goes to the BACKFILL queue: a 100k-product initial import must not delay other shops' incremental syncs.
    await this.queue.enqueue(BACKFILL_QUEUE, { integrationId: row.id, kind: 'incremental' });
    return { integrationId: row.id };
  }

  /**
   * Incremental pull: watermark − overlap → pages (checkpoint per page, so a
   * crash resumes mid-way) → normalize (ACL) → apply. The watermark only
   * advances after a complete pass, to the max `updatedAt` actually seen.
   */
  async syncIncremental(integrationId: string): Promise<{ applied: number; skipped: number; quarantined: number }> {
    const integration = await this.integration(integrationId);
    const provider = this.provider(integration);
    const [cursor] = await this.sequelize.query<{ watermark: Date | null; pageCursor: string | null }>(`SELECT watermark, "pageCursor" FROM "SyncCursor" WHERE "integrationId" = :id AND entity = 'product'`, {
      type: QueryTypes.SELECT,
      replacements: { id: integrationId },
    });
    const since = cursor?.watermark ? new Date(new Date(cursor.watermark).getTime() - OVERLAP_MS) : null;
    let state = cursor?.pageCursor ? (JSON.parse(cursor.pageCursor) as { c: string | null; m: string | null }) : { c: null, m: null };
    const stats = { applied: 0, skipped: 0, quarantined: 0 };

    do {
      const page = await provider.listUpdatedSince(since, state.c);
      for (const raw of page.items) {
        const outcome = await this.applyInbound(integration, provider, raw);
        stats[outcome.result]++;
        if (outcome.updatedAt && (!state.m || outcome.updatedAt > state.m)) state.m = outcome.updatedAt;
      }
      state = { c: page.nextCursor, m: state.m };
      await this.saveCursor(integrationId, cursor?.watermark ?? null, page.nextCursor ? JSON.stringify(state) : null);
    } while (state.c);

    if (state.m) await this.saveCursor(integrationId, new Date(state.m), null);
    return stats;
  }

  /** Webhook path: provider says "X changed" → fetch the current state (webhooks can arrive out of order) → same apply path. */
  async syncOne(integrationId: string, externalId: string) {
    const integration = await this.integration(integrationId);
    const provider = this.provider(integration);
    const raw = await provider.get(externalId);
    return raw ? this.applyInbound(integration, provider, raw) : { result: 'skipped' as const };
  }

  async applyInbound(integration: IntegrationRow, provider: CommerceProvider, raw: unknown): Promise<{ result: 'applied' | 'skipped' | 'quarantined'; updatedAt?: string }> {
    let p: NormalizedProduct;
    try {
      p = provider.normalize(raw);
    } catch (error) {
      // Schema drift / bad data → quarantine + keep going; one weird product must not stop a 100k sync.
      const reason = error instanceof ZodError ? `schema: ${error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` : (error as Error).message;
      await this.sequelize.query(`INSERT INTO "SyncQuarantine" ("integrationId", entity, "externalId", reason, payload) VALUES (:id, 'product', :externalId, :reason, CAST(:payload AS jsonb))`, {
        replacements: { id: integration.id, externalId: String((raw as { id?: unknown })?.id ?? '') || null, reason: reason.slice(0, 500), payload: JSON.stringify(raw ?? null) },
      });
      return { result: 'quarantined' };
    }

    const hash = syncHash(p);
    return this.sequelize.transaction(async (transaction) => {
      const [link] = await this.sequelize.query<{ localId: string; lastHash: string }>(
        `SELECT "localId", "lastHash" FROM "ExternalLink" WHERE "integrationId" = :id AND entity = 'product' AND "externalId" = :externalId FOR UPDATE`,
        { type: QueryTypes.SELECT, replacements: { id: integration.id, externalId: p.externalId }, transaction },
      );
      if (link?.lastHash === hash) return { result: 'skipped' as const, updatedAt: p.updatedAt }; // overlap re-read or our own echo

      let localId = link?.localId;
      if (localId) {
        await this.sequelize.query(
          `UPDATE "Product" SET title = :title, description = :description, price = :price, quantity = :stock, category = :category, brand = :brand, version = version + 1, "updatedAt" = now() WHERE id = :id`,
          { replacements: { title: p.title, description: p.description, price: p.priceMinor, stock: Math.max(0, p.stock), category: p.category, brand: p.brand, id: localId }, transaction },
        );
      } else {
        [{ id: localId }] = await this.sequelize.query<{ id: string }>(
          `INSERT INTO "Product" (id, "shopId", title, description, price, quantity, category, brand, rating, tags, version, "createdAt", "updatedAt")
           VALUES (uuidv7(), :shopId, :title, :description, :price, :stock, :category, :brand, 0, '{}', 1, now(), now()) RETURNING id`,
          { type: QueryTypes.SELECT, replacements: { shopId: integration.shopId, title: p.title, description: p.description, price: p.priceMinor, stock: Math.max(0, p.stock), category: p.category, brand: p.brand }, transaction },
        );
      }
      await this.sequelize.query(
        `INSERT INTO "ExternalLink" ("integrationId", entity, "externalId", "localId", "lastHash", raw) VALUES (:id, 'product', :externalId, :localId, :hash, CAST(:raw AS jsonb))
         ON CONFLICT ("integrationId", entity, "externalId") DO UPDATE SET "lastHash" = EXCLUDED."lastHash", raw = EXCLUDED.raw, "updatedAt" = now()`,
        { replacements: { id: integration.id, externalId: p.externalId, localId, hash, raw: JSON.stringify(raw) }, transaction },
      );
      await this.outbox.notify({ topic: KafkaTopicGroup.PRODUCTS_EVENTS, payload: { productId: localId }, aggregateId: localId! }, transaction);
      return { result: 'applied' as const, updatedAt: p.updatedAt };
    });
  }

  /**
   * Outbound stock (products.events consumer): push only when the LOCAL state
   * differs from what we last synced. An inbound apply sets lastHash to the
   * provider's state, so its own products.events finds equal hashes and
   * pushes nothing - no ping-pong between the two systems.
   */
  async pushStock(productId: string): Promise<number> {
    const links = await this.sequelize.query<{ integrationId: string; externalId: string; lastHash: string; raw: unknown; quantity: number }>(
      `SELECT l."integrationId", l."externalId", l."lastHash", l.raw, p.quantity FROM "ExternalLink" l JOIN "Product" p ON p.id = l."localId"
       JOIN "Integration" i ON i.id = l."integrationId" AND i.status = 'ACTIVE' WHERE l."localId" = :productId AND l.entity = 'product'`,
      { type: QueryTypes.SELECT, replacements: { productId } },
    );
    let pushed = 0;
    for (const link of links) {
      const integration = await this.integration(link.integrationId);
      const provider = this.provider(integration);
      const remote = provider.normalize(link.raw);
      const desired = { ...remote, stock: link.quantity };
      const hash = syncHash(desired);
      if (hash === link.lastHash) continue;
      await provider.setStock(remote, link.quantity);
      await this.sequelize.query(`UPDATE "ExternalLink" SET "lastHash" = :hash, "lastPushedHash" = :hash WHERE "integrationId" = :i AND entity = 'product' AND "externalId" = :e`, {
        replacements: { hash, i: link.integrationId, e: link.externalId },
      });
      pushed++;
    }
    return pushed;
  }

  /** Nightly drift check: products deleted at the provider are zeroed here and reported; unknown remote ids are re-pulled. */
  async reconcile(integrationId: string) {
    const integration = await this.integration(integrationId);
    const remote = new Set(await this.provider(integration).listAllIds());
    const links = await this.sequelize.query<{ externalId: string; localId: string }>(`SELECT "externalId", "localId" FROM "ExternalLink" WHERE "integrationId" = :id AND entity = 'product'`, {
      type: QueryTypes.SELECT,
      replacements: { id: integrationId },
    });
    const gone = links.filter((l) => !remote.has(l.externalId));
    for (const l of gone) {
      await this.sequelize.transaction(async (transaction: Transaction) => {
        await this.sequelize.query(`UPDATE "Product" SET quantity = 0, version = version + 1 WHERE id = :id`, { replacements: { id: l.localId }, transaction });
        await this.sequelize.query(`INSERT INTO "SyncQuarantine" ("integrationId", entity, "externalId", reason) VALUES (:id, 'product', :externalId, 'deleted at provider')`, {
          replacements: { id: integrationId, externalId: l.externalId },
          transaction,
        });
      });
    }
    const known = new Set(links.map((l) => l.externalId));
    const missingLocally = [...remote].filter((id) => !known.has(id));
    for (const id of missingLocally) await this.queue.enqueue(SYNC_QUEUE, { integrationId, kind: 'one', externalId: id });
    return { deletedAtProvider: gone.length, missingLocally: missingLocally.length };
  }

  async verifyWebhook(integrationId: string, rawBody: Buffer, headers: Record<string, string | undefined>) {
    return this.provider(await this.integration(integrationId)).verifyWebhook(rawBody, headers);
  }

  async activeIds(): Promise<string[]> {
    return (await this.sequelize.query<{ id: string }>(`SELECT id FROM "Integration" WHERE status = 'ACTIVE'`, { type: QueryTypes.SELECT })).map((r) => r.id);
  }

  /** Local dev / specs: the in-memory remote store behind a `fake` integration. */
  async fakeFor(integrationId: string): Promise<FakeProvider> {
    const provider = this.provider(await this.integration(integrationId));
    if (!(provider instanceof FakeProvider)) throw new ForbiddenException('not a fake integration');
    return provider;
  }

  provider(integration: IntegrationRow): CommerceProvider {
    if (integration.provider === 'fake') {
      let fake = this.fakes.get(integration.id);
      if (!fake) this.fakes.set(integration.id, (fake = new FakeProvider(JSON.parse(this.box.open(integration.credentialsSealed)).secret)));
      return fake;
    }
    if (integration.provider === 'shopify') {
      const creds = JSON.parse(this.box.open(integration.credentialsSealed));
      return new ShopifyProvider(integration.externalShop, creds, async () => {
        // Fleet-wide per-credential bucket: wait for a token instead of eating a 429.
        for (let i = 0; i < 20; i++) {
          const d = await this.limiter.check('integrations.shopify', integration.id);
          if (d.allowed) return;
          await sleep(Math.max(d.retryAfterMs, 100));
        }
        throw new Error('shopify rate limit wait exceeded');
      });
    }
    throw new Error(`provider ${integration.provider} not implemented (WooCommerce adapter = same port)`);
  }

  private async saveCursor(integrationId: string, watermark: Date | null, pageCursor: string | null) {
    await this.sequelize.query(
      `INSERT INTO "SyncCursor" ("integrationId", entity, watermark, "pageCursor") VALUES (:id, 'product', :watermark, :pageCursor)
       ON CONFLICT ("integrationId", entity) DO UPDATE SET watermark = EXCLUDED.watermark, "pageCursor" = EXCLUDED."pageCursor", "updatedAt" = now()`,
      { replacements: { id: integrationId, watermark, pageCursor } },
    );
  }

  private async integration(id: string): Promise<IntegrationRow> {
    const [row] = await this.sequelize.query<IntegrationRow>(`SELECT * FROM "Integration" WHERE id = :id`, { type: QueryTypes.SELECT, replacements: { id } });
    if (!row) throw new NotFoundException('Integration not found');
    return row;
  }
}
