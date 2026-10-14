import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** An experiment definition and its lifecycle (S39). SQL goes through `SequelizeExperimentRepository`; the model registers the table. */
@Table({
  modelName: 'Experiment',
  tableName: 'Experiment',
  timestamps: false,
})
export default class ExperimentModel extends Model<
  ExperimentModel,
  Partial<ExperimentModel>
> {
  @PrimaryKey
  @Column({ type: DataType.TEXT })
  declare key: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare description: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare owner: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare unit: string;

  /** `DRAFT`, `RUNNING` or `STOPPED` in the table; the API shows them in lower case. */
  @Column({ type: DataType.TEXT, allowNull: false })
  declare status: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare variants: unknown;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare layer: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare layerFrom: number;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare layerTo: number;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare metric: string;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  @Column({ type: DataType.DATE, allowNull: true })
  declare startedAt: Date | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare stoppedAt: Date | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare startedBy: string | null;

  @Column({ type: DataType.TEXT, allowNull: true })
  declare stoppedBy: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare createdAt: Date;

  @Column({ type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;
}
