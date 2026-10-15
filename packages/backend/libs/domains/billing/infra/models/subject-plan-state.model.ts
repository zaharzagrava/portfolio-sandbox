import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** The per-shop plan-tier counter (S17 FR-020): `planVersion` never repeats or decreases across subscriptions. */
@Table({
  modelName: 'SubjectPlanState',
  tableName: 'SubjectPlanState',
  timestamps: true,
  createdAt: false,
})
export default class SubjectPlanState extends Model<
  SubjectPlanState,
  Partial<SubjectPlanState>
> {
  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare subjectType: 'USER' | 'SHOP';
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare subjectId: string;
  @Column({ type: DataType.TEXT, allowNull: false })
  declare tier: 'STARTER' | 'PRO' | 'ENTERPRISE';
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare planVersion: number;
  declare updatedAt: Date;
}
