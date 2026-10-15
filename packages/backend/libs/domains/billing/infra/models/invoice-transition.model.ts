import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** Append-only history of an invoice's status moves (S17 FR-030); the store rejects UPDATE and DELETE. */
@Table({
  modelName: 'InvoiceTransition',
  tableName: 'InvoiceTransition',
  timestamps: false,
})
export default class InvoiceTransition extends Model<
  InvoiceTransition,
  Partial<InvoiceTransition>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;
  @Column({ type: DataType.UUID, allowNull: false }) declare invoiceId: string;
  @Column({ type: DataType.TEXT, allowNull: false }) declare fromStatus: string;
  @Column({ type: DataType.TEXT, allowNull: false }) declare toStatus: string;
  @Column({ type: DataType.TEXT, allowNull: false }) declare reason: string;
  @Column({ type: DataType.DATE, allowNull: false }) declare at: Date;
}
