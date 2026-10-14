import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** The single row (id = 1) holding the ruleset version: locked first in every flag write, bumped only by an applied change. */
@Table({
  modelName: 'FlagRuleset',
  tableName: 'FlagRuleset',
  timestamps: false,
})
export default class FlagRulesetModel extends Model<
  FlagRulesetModel,
  Partial<FlagRulesetModel>
> {
  @PrimaryKey
  @Column({ type: DataType.SMALLINT })
  declare id: number;

  @Column({ type: DataType.BIGINT, allowNull: false })
  declare version: string;
}
