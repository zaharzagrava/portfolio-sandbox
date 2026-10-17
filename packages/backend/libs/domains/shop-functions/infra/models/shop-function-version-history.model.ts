import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** Append-only status history of a version; `actorId` null means the system (judge, recovery). */
@Table({
  modelName: 'ShopFunctionVersionHistory',
  tableName: 'ShopFunctionVersionHistory',
  timestamps: false,
})
export default class ShopFunctionVersionHistory extends Model<
  ShopFunctionVersionHistory,
  Partial<ShopFunctionVersionHistory>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare functionId: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare fromStatus: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare toStatus: string;

  @Column({ type: DataType.UUID, allowNull: true })
  declare actorId: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare reason: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare at: Date;
}
