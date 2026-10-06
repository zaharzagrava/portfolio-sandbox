import { Column, DataType, HasMany, Model, PrimaryKey, Table } from 'sequelize-typescript';
import { Sequelize } from 'sequelize';
import InvoiceLine from './invoice-line.model';

export type InvoiceStatus = 'OPEN' | 'PAID' | 'VOID' | 'UNCOLLECTIBLE';

@Table({ modelName: 'Invoice', tableName: 'Invoice', timestamps: true })
export default class Invoice extends Model<Invoice, Partial<Invoice>> {
  @PrimaryKey @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') }) declare id: string;
  @Column({ type: DataType.UUID, allowNull: false }) declare subscriptionId: string;
  @Column({ type: DataType.DATE, allowNull: false }) declare periodStart: Date;
  @Column({ type: DataType.DATE, allowNull: false }) declare periodEnd: Date;
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'RENEWAL' }) declare kind: 'RENEWAL' | 'PRORATION';
  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'OPEN' }) declare status: InvoiceStatus;
  @Column({ type: DataType.BIGINT, allowNull: false }) declare total: number;
  @Column({ type: DataType.TEXT, allowNull: false }) declare currency: string;
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 }) declare attempts: number;
  @Column({ type: DataType.DATE, allowNull: true }) declare nextAttemptAt: Date | null;
  @Column({ type: DataType.DATE, allowNull: true }) declare usageMeasuredAt: Date | null;
  @HasMany(() => InvoiceLine, { foreignKey: 'invoiceId' }) declare lines: InvoiceLine[];
  declare createdAt: Date;
  declare updatedAt: Date;
}
