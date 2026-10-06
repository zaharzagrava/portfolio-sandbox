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
import { ProductModel as Product } from '@app/domains/catalog';
import { UserModel as User } from '@app/domains/identity';

export enum ChatChannelScope {
  WithAll = 'WithAll',
}

export interface ChatChannelWithAllFilters {
  id?: string | string[];
  productId?: string | string[];
  sellerId?: string | string[];
  isArchived?: boolean;
  attributes?: string[];
  limit?: number;
}

@Scopes(() => ({
  [ChatChannelScope.WithAll]: ({
    id,
    productId,
    sellerId,
    isArchived,
    attributes,
    limit,
  }: ChatChannelWithAllFilters = {}) => {
    const findOptions: {
      where: WhereOptions;
      include?: Includeable[];
      attributes?: string[];
      limit?: number;
    } = {
      where: {
        ...(id && { id }),
        ...(productId && { productId }),
        ...(sellerId && { sellerId }),
        ...(isArchived !== undefined && { isArchived }),
      },
      include: [],
      attributes,
      limit,
    };

    return findOptions;
  },
}))
@Table({
  modelName: 'ChatChannel',
  tableName: 'ChatChannel',
  timestamps: true,
})
export default class ChatChannel extends Model<
  ChatChannel,
  Partial<ChatChannel>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  /** One channel per product for v1 - enforced via a unique index. */
  @ForeignKey(() => Product)
  @Column({ type: DataType.UUID, allowNull: false, unique: true })
  declare productId: string;

  @BelongsTo(() => Product, { foreignKey: 'productId' })
  declare product: Product;

  /**
   * Denormalized copy of Product.sellerId at creation time, so the hot
   * authorization path (both here and in the Rust gateway) never has to
   * join through Product to know who owns the channel.
   */
  @ForeignKey(() => User)
  @Column({ type: DataType.UUID, allowNull: false })
  declare sellerId: string;

  @BelongsTo(() => User, { foreignKey: 'sellerId' })
  declare seller: User;

  @Column({ type: DataType.STRING, allowNull: false })
  declare title: string;

  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare isArchived: boolean;

  @Column({ type: DataType.DATE, allowNull: true })
  declare archivedAt: Date | null;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
