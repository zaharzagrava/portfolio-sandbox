import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** Append-only record of a payment's status moves (S13 data-model.md). No association: `paymentId` is a plain column. */
@Table({
  modelName: 'PaymentHistory',
  tableName: 'PaymentHistory',
  timestamps: false,
})
export default class PaymentHistory extends Model<
  PaymentHistory,
  Partial<PaymentHistory>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare paymentId: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare fromStatus: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare toStatus: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare reason: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare actor: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare at: Date;
}
