import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** History of committed synonym sets, pruned to 20 versions / 90 days (never below the current one). */
@Table({
  modelName: 'SearchSynonymVersion',
  tableName: 'SearchSynonymVersion',
  timestamps: false,
})
export default class SearchSynonymVersion extends Model<
  SearchSynonymVersion,
  Partial<SearchSynonymVersion>
> {
  @PrimaryKey
  @Column({ type: DataType.INTEGER })
  declare version: number;

  @Column({ type: DataType.ARRAY(DataType.TEXT), allowNull: false })
  declare rules: string[];

  @Column({ type: DataType.UUID, allowNull: true })
  declare updatedBy: string | null;

  @Column({ type: DataType.DATE, allowNull: false })
  declare createdAt: Date;
}
