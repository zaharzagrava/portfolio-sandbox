import {
  Column,
  CreatedAt,
  DataType,
  Model,
  PrimaryKey,
  Scopes,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Includeable, Sequelize, WhereOptions } from 'sequelize';

export enum ProductScope {
  WithAll = 'WithAll',
}

export interface ProductWithAllFilters {
  id?: string | string[];
  title?: string | string[];
  brand?: string | string[];
  category?: string | string[];
  attributes?: string[];
  limit?: number;
}

@Scopes(() => ({
  [ProductScope.WithAll]: ({
    id,
    title,
    brand,
    category,
    attributes,
    limit,
  }: ProductWithAllFilters = {}) => {
    const findOptions: {
      where: WhereOptions;
      include?: Includeable[];
      attributes?: string[];
      limit?: number;
    } = {
      where: {
        ...(id && { id }),
        ...(title && { title }),
        ...(brand && { brand }),
        ...(category && { category }),
      },
      include: [],
      attributes,
      limit,
    };

    return findOptions;
  },
}))
@Table({
  modelName: 'Product',
  tableName: 'Product',
  timestamps: true,
})
export default class Product extends Model<Product, Partial<Product>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  /**
   * Legacy column: a plain id (no foreign key, IX.4), never serialised. The creator is `createdBy`; writers of other
   * capabilities that have not converted yet still set this one (specs/domains/S05-products/gaps.md section C).
   */
  @Column({ type: DataType.UUID, allowNull: true })
  declare sellerId: string | null;

  /** User who created the product; a plain id. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare createdBy: string | null;

  /** Owning shop for life; a plain id (no foreign key). `NOT NULL` after the backfill and the contract migration. */
  @Column({ type: DataType.UUID, allowNull: true })
  declare shopId: string | null;

  @Column({ type: DataType.STRING, allowNull: false })
  declare title: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare description: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare brand: string;

  @Column({ type: DataType.STRING, allowNull: false })
  declare category: string;

  /** Legacy name of `priceMinor`; a trigger keeps the two equal until the last reader of `price` has moved. */
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare price: number;

  /** Price in minor units, `1…10,000,000,000`. Optional in the model only: the database fills it for legacy writers. */
  @Column({ type: DataType.BIGINT, allowNull: true })
  declare priceMinor: number;

  /** ISO 4217 code of the platform currency. */
  @Column({ type: DataType.STRING(3), allowNull: false, defaultValue: 'USD' })
  declare currency: string;

  @Column({
    type: DataType.STRING(16),
    allowNull: false,
    defaultValue: 'ACTIVE',
  })
  declare status: 'ACTIVE' | 'ARCHIVED';

  /** Stamped at creation from the shop; sandbox products are never public. */
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare isSandbox: boolean;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare externalSku: string | null;

  @Column({ type: DataType.FLOAT, allowNull: false, defaultValue: 0 })
  declare rating: number;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare tags: string[];

  /** Stock count: `0…1,000,000,000`, changed only by the catalog's commands. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare quantity: number;

  /** Optimistic concurrency version: starts at 1, +1 on every committed change except a view flush. */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare version: number;

  /** Write-behind counter (SD-34): incremented in Redis, flushed in batches by `products.flush-view-counts`. */
  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare viewCount: number;

  /**
   * TRANSITIONAL: still mapped only because discovery's `search-reindex.service.ts` reads it through this model (S32
   * owns the decision). No catalog view, event or cache entry carries it; `searchVector` is not mapped at all.
   */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare embedding: number[] | null;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
