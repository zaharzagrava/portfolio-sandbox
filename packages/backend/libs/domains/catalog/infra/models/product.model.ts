import {
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  ForeignKey,
  Model,
  PrimaryKey,
  Scopes,
  Table,
  UpdatedAt,
} from 'sequelize-typescript';
import { Includeable, Sequelize, WhereOptions } from 'sequelize';
import { UserModel as User } from '@app/domains/identity';

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
   * Nullable for backwards compatibility with rows seeded before sellers
   * existed as a concept; new products are always stamped with the
   * authenticated creator (see ProductService#create).
   */
  @ForeignKey(() => User)
  @Column({ type: DataType.UUID, allowNull: true })
  declare sellerId: string | null;

  @BelongsTo(() => User, { foreignKey: 'sellerId' })
  declare seller: User;

  /** Owning tenant (SD-02). Nullable until the backfill + contract step ran. */
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

  /** Price in cents */
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare price: number;

  @Column({ type: DataType.FLOAT, allowNull: false, defaultValue: 0 })
  declare rating: number;

  @Column({ type: DataType.JSONB, allowNull: false, defaultValue: [] })
  declare tags: string[];

  /** Stock count (single-seller; OCC uses version). */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare quantity: number;

  /** Optimistic concurrency control version (feature #12). */
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare version: number;

  /** Write-behind counter (SD-34): incremented in Redis, flushed in batches by `products.flush-view-counts`. */
  @Column({ type: DataType.BIGINT, allowNull: false, defaultValue: 0 })
  declare viewCount: number;

  /** Stub dense vector for k-NN demos (same dims as ES mapping). */
  @Column({ type: DataType.JSONB, allowNull: true })
  declare embedding: number[] | null;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
