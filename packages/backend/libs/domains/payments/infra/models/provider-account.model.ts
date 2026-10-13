import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** The payout destination of a shop at the payment provider. `shopId` is a plain id: no foreign key (IX.4). */
@Table({
  modelName: 'ProviderAccount',
  tableName: 'ProviderAccount',
  timestamps: true,
})
export default class ProviderAccount extends Model<
  ProviderAccount,
  Partial<ProviderAccount>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: false, defaultValue: 'stripe' })
  declare provider: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare accountId: string;

  declare createdAt: Date;
  declare updatedAt: Date;
}
