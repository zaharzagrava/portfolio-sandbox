import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/**
 * A shop's product linked to a target. `shopId` and `productId` are plain ids: no association to another domain's
 * table and no foreign key (IX.4); shop and product deletion arrive as events.
 */
@Table({
  modelName: 'CompetitorWatch',
  tableName: 'CompetitorWatch',
  timestamps: false,
})
export default class CompetitorWatch extends Model<
  CompetitorWatch,
  Partial<CompetitorWatch>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare productId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare targetId: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'ACTIVE' })
  declare status: 'ACTIVE' | 'PAUSED';

  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare lastEvaluatedObservationNo: number;

  @Column({ type: DataType.BIGINT, allowNull: true })
  declare lastEvaluatedPriceMinor: string | null;
}
