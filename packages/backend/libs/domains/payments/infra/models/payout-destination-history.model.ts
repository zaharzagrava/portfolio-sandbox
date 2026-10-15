import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** Append-only; masked values only: the history never stores a full provider account id. */
@Table({
  modelName: 'PayoutDestinationHistory',
  tableName: 'PayoutDestinationHistory',
  timestamps: false,
})
export default class PayoutDestinationHistory extends Model<
  PayoutDestinationHistory,
  Partial<PayoutDestinationHistory>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare fromMasked: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare toMasked: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare effectiveFrom: Date;

  @Column({ type: DataType.DATE, allowNull: false })
  declare at: Date;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare actor: string;
}
