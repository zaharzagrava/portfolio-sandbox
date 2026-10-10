import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** Append-only record of every shop status change (FR-007); kept after purge, holds no personal data. */
@Table({
  modelName: 'ShopStatusHistory',
  tableName: 'ShopStatusHistory',
  timestamps: false,
})
export default class ShopStatusHistory extends Model<
  ShopStatusHistory,
  Partial<ShopStatusHistory>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare from: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare to: string;

  /** A user id or `system`. */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare actor: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare reason: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare at: Date;
}
