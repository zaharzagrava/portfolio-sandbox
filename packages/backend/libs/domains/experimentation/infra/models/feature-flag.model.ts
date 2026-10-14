import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** A flag definition and its status (S38). SQL goes through `SequelizeFlagRepository`; the model registers the table. */
@Table({
  modelName: 'FeatureFlag',
  tableName: 'FeatureFlag',
  timestamps: false,
})
export default class FeatureFlagModel extends Model<
  FeatureFlagModel,
  Partial<FeatureFlagModel>
> {
  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare key: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare description: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare status: string;

  /** Kept for readers of the previous release (contract step later); the application writes `status = 'enabled'` into it. */
  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare enabled: boolean;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare variants: unknown;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare defaultVariant: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare offVariant: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare rules: unknown;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare bucketBy: string;

  @Column({ type: DataType.BOOLEAN, allowNull: false })
  declare clientSide: boolean;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare owner: string;

  @Column({ type: DataType.DATE, allowNull: true })
  declare expiresAt: Date | null;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
