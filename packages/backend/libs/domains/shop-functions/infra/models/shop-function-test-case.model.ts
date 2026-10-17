import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';
import { Sequelize } from 'sequelize';

/** A test case of a function's suite; `version` null is the current editable suite, a number is the frozen copy. */
@Table({
  modelName: 'ShopFunctionTestCase',
  tableName: 'ShopFunctionTestCase',
  timestamps: false,
})
export default class ShopFunctionTestCase extends Model<
  ShopFunctionTestCase,
  Partial<ShopFunctionTestCase>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare functionId: string;

  @Column({ type: DataType.INTEGER, allowNull: true })
  declare version: number | null;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare name: string;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare input: unknown;

  @Column({ type: DataType.JSONB, allowNull: false })
  declare expected: unknown;
}
