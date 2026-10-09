import {
  BelongsTo,
  Column,
  DataType,
  ForeignKey,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';
import Plan from './plan.model';

/** Immutable once used: a price change is a NEW Price row. */
@Table({
  modelName: 'Price',
  tableName: 'Price',
  timestamps: true,
  updatedAt: false,
})
export default class Price extends Model<Price, Partial<Price>> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;
  @ForeignKey(() => Plan)
  @Column({ type: DataType.UUID, allowNull: false })
  declare planId: string;
  @BelongsTo(() => Plan) declare plan: Plan;
  @Column({ type: DataType.TEXT, allowNull: false }) declare interval:
    'MONTH' | 'YEAR';
  @Column({ type: DataType.BIGINT, allowNull: false })
  declare unitAmount: number;
  @Column({ type: DataType.TEXT, allowNull: false }) declare currency: string;
  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare perSeat: boolean;
  @Column({ type: DataType.JSONB, allowNull: false })
  declare includedUsage: Record<string, number>;
  @Column({ type: DataType.JSONB, allowNull: false })
  declare overagePer1000: Record<string, number>;
  @Column({ type: DataType.BOOLEAN, allowNull: false }) declare active: boolean;
  declare createdAt: Date;
}
