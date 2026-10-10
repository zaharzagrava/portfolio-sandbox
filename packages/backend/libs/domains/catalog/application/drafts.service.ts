import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import * as Y from 'yjs';
import { v7 as uuidv7 } from 'uuid';
import { ApiConfigService } from '@app/common/config';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { ShopAccessService } from '@app/domains/tenancy';
import { ProductCommandService } from './product-command.service';
import { ProductQueryService } from './product-query.service';
import { DraftStore } from '../infra/draft-store';
import { CollabInstanceRegistry } from '../infra/instance-registry';
import { signCollabTicket } from '../infra/collab-ticket';
import { readListing, seedListing } from '../domain/listing-doc';
import { COLLAB_REVOKE_CHANNEL } from './room-manager.service';

export interface DraftRow {
  id: string;
  shopId: string;
  productId: string | null;
  title: string;
  status: string;
}

@Injectable()
export class DraftsService {
  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly store: DraftStore,
    private readonly registry: CollabInstanceRegistry,
    private readonly storage: ObjectStorage,
    private readonly commands: ProductCommandService,
    private readonly productQuery: ProductQueryService,
    private readonly access: ShopAccessService,
    private readonly redis: RedisService,
    private readonly config: ApiConfigService,
  ) {}

  /** New draft, optionally pre-filled from an existing product (seq-0 snapshot). */
  async create(
    shopId: string,
    userId: string,
    title: string,
    productId?: string,
  ) {
    let seed: Y.Doc | null = null;
    if (productId) {
      const p = (
        await this.productQuery.getProductsByIds([productId], { shopId })
      ).get(productId);
      if (!p) throw new NotFoundException('Product not found in this shop');
      seed = seedListing({
        title: p.title,
        description: p.description,
        price: p.priceMinor,
        brand: p.brand,
        category: p.category,
        quantity: p.quantity,
      });
    }
    const [draft] = await this.sequelize.query<DraftRow>(
      `INSERT INTO "ListingDraft" ("shopId", "productId", title, "createdBy") VALUES (:shopId, :productId, :title, :userId) RETURNING id, "shopId", "productId", title, status`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId, productId: productId ?? null, title, userId },
      },
    );
    if (seed) await this.store.seed(draft.id, seed);
    return draft;
  }

  list(shopId: string) {
    return this.sequelize.query<DraftRow>(
      `SELECT id, "shopId", "productId", title, status, "updatedAt" FROM "ListingDraft" WHERE "shopId" = :shopId ORDER BY "updatedAt" DESC LIMIT 100`,
      {
        type: QueryTypes.SELECT,
        replacements: { shopId },
      },
    );
  }

  /** Where to connect + a 60 s ticket bound to this draft and the caller's permission level. */
  async connect(draftId: string, userId: string) {
    const draft = await this.get(draftId);
    const role = await this.access.getRole(draft.shopId, userId);
    if (!role) throw new NotFoundException('Draft not found'); // BOLA-safe: don't reveal other shops' drafts
    const owner = await this.registry.ownerOf(draftId);
    if (!owner)
      throw new BadRequestException('Collaboration service unavailable');
    const canWrite = role !== 'VIEWER' && draft.status === 'DRAFT';
    return {
      url: `${owner.url}/collab/${draftId}`,
      ticket: signCollabTicket(
        { userId, draftId, canWrite },
        this.config.get('jwt_secret'),
      ),
      canWrite,
    };
  }

  /** Called when a member is demoted/removed: open sessions are closed wherever the room lives. */
  async revoke(draftId: string, userId: string) {
    await this.redis.client.publish(
      COLLAB_REVOKE_CHANNEL,
      JSON.stringify({ draftId, userId }),
    );
  }

  async versions(draftId: string) {
    return this.sequelize.query(
      `SELECT id, name, "createdBy", "createdAt" FROM "ListingDraftVersion" WHERE "draftId" = :draftId ORDER BY "createdAt" DESC`,
      {
        type: QueryTypes.SELECT,
        replacements: { draftId },
      },
    );
  }

  /** Named version = full state (snapshot + tail) frozen to S3; at most ~100 ms behind the live room. */
  async createVersion(draftId: string, userId: string, name: string) {
    const { doc } = await this.store.load(draftId);
    const id = uuidv7();
    const objectKey = `drafts/${draftId}/versions/${id}.ybin`;
    await this.storage.put(
      objectKey,
      Buffer.from(Y.encodeStateAsUpdate(doc)),
      'application/octet-stream',
    );
    await this.sequelize.query(
      `INSERT INTO "ListingDraftVersion" (id, "draftId", name, "objectKey", "createdBy") VALUES (:id, :draftId, :name, :objectKey, :userId)`,
      {
        replacements: { id, draftId, name, objectKey, userId },
      },
    );
    return { id, name, content: readListing(doc) };
  }

  /**
   * Publish: materialize the CRDT into a product revision through the catalog's one write path
   * (`ProductCommandService`: create, or update with the current version, one full-state event in the same
   * transaction), freeze a "Published" version, close the draft.
   */
  async publish(draftId: string, userId: string) {
    const draft = await this.get(draftId);
    if (draft.status !== 'DRAFT')
      throw new BadRequestException('Draft already published');
    const { doc } = await this.store.load(draftId);
    const c = readListing(doc);
    if (!c.title || c.price === null || c.price < 1)
      throw new BadRequestException('Title and price are required to publish');
    const specs = Object.entries(c.specs)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');
    const description = specs ? `${c.description}\n\n${specs}` : c.description;

    let productId = draft.productId;
    if (!productId) {
      const created = await this.commands.create(draft.shopId, userId, {
        title: c.title,
        description,
        priceMinor: c.price,
        // A product has a brand (1 to 100 characters); a draft that never set one is published as unbranded.
        brand: c.brand?.trim() || 'Unbranded',
        category: c.category ?? 'uncategorized',
        quantity: c.quantity ?? 0,
      });
      productId = created.id;
    } else {
      const current = await this.commands.getForShop(draft.shopId, productId);
      const updated = await this.commands.update(
        draft.shopId,
        productId,
        {
          expectedVersion: current.version,
          title: c.title,
          description,
          priceMinor: c.price,
          ...(c.brand?.trim() ? { brand: c.brand.trim() } : {}),
          ...(c.category ? { category: c.category } : {}),
          ...(c.quantity !== null ? { quantity: c.quantity } : {}),
        },
        userId,
      );
      productId = updated.id;
    }
    await this.createVersion(
      draftId,
      userId,
      `Published ${new Date().toISOString().slice(0, 16)}`,
    );
    await this.sequelize.query(
      `UPDATE "ListingDraft" SET status = 'PUBLISHED', "productId" = :productId, "publishedAt" = now(), "updatedAt" = now() WHERE id = :draftId`,
      {
        replacements: { productId, draftId },
      },
    );
    return { productId };
  }

  async get(draftId: string): Promise<DraftRow> {
    const [draft] = await this.sequelize.query<DraftRow>(
      `SELECT id, "shopId", "productId", title, status FROM "ListingDraft" WHERE id = :draftId`,
      {
        type: QueryTypes.SELECT,
        replacements: { draftId },
      },
    );
    if (!draft) throw new NotFoundException('Draft not found');
    return draft;
  }

  async assertShop(draftId: string, shopId: string) {
    if ((await this.get(draftId)).shopId !== shopId)
      throw new ForbiddenException();
  }
}
