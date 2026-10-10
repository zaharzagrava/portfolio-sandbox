import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** The single synonym set row (`id = 1`) with the claim columns of an edit in flight. */
@Table({
  modelName: 'SearchSynonymSet',
  tableName: 'SearchSynonymSet',
  timestamps: false,
})
export default class SearchSynonymSet extends Model<
  SearchSynonymSet,
  Partial<SearchSynonymSet>
> {
  @PrimaryKey
  @Column({ type: DataType.SMALLINT })
  declare id: number;

  @Column({ type: DataType.INTEGER, allowNull: false })
  declare version: number;

  @Column({ type: DataType.ARRAY(DataType.TEXT), allowNull: false })
  declare rules: string[];

  @Column({ type: DataType.UUID, allowNull: true })
  declare updatedBy: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare updatedAt: Date;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare pendingVersion: number | null;

  @Column({ type: DataType.ARRAY(DataType.TEXT), allowNull: true })
  declare pendingRules: string[] | null;

  @Column({ type: DataType.DATE, allowNull: true })
  declare pendingAt: Date | null;
}
