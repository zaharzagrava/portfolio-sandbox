import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** One row per export status transition, written in the transition's transaction (S12 FR-002). No foreign key. */
@Table({
  modelName: 'ExportJobHistory',
  tableName: 'ExportJobHistory',
  timestamps: false,
})
export default class ExportJobHistory extends Model<
  ExportJobHistory,
  Partial<ExportJobHistory>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare exportId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare fromStatus: string | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare toStatus: string;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare reason: string | null;

  @Column({ type: DataType.UUID, allowNull: true })
  declare actor: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare at: Date;
}
