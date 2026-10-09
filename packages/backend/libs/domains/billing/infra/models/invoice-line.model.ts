import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

@Table({
  modelName: 'InvoiceLine',
  tableName: 'InvoiceLine',
  timestamps: false,
})
export default class InvoiceLine extends Model<
  InvoiceLine,
  Partial<InvoiceLine>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;
  @Column({ type: DataType.UUID, allowNull: false }) declare invoiceId: string;
  @Column({ type: DataType.TEXT, allowNull: false }) declare kind: string;
  @Column({ type: DataType.TEXT, allowNull: false })
  declare description: string;
  @Column({ type: DataType.BIGINT, allowNull: false }) declare quantity: number;
  @Column({ type: DataType.BIGINT, allowNull: false }) declare amount: number;
}
