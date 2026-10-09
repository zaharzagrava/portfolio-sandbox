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
import Price from './price.model';

export type SubscriptionStatus =
  'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'UNPAID' | 'CANCELED';

@Table({
  modelName: 'Subscription',
  tableName: 'Subscription',
  timestamps: true,
})
export default class Subscription extends Model<
  Subscription,
  Partial<Subscription>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID, defaultValue: Sequelize.literal('uuidv7()') })
  declare id: string;
  @Column({ type: DataType.TEXT, allowNull: false }) declare subjectType:
    'USER' | 'SHOP';
  @Column({ type: DataType.UUID, allowNull: false }) declare subjectId: string;
  @ForeignKey(() => Price)
  @Column({ type: DataType.UUID, allowNull: false })
  declare priceId: string;
  @BelongsTo(() => Price) declare price: Price;
  @Column({ type: DataType.TEXT, allowNull: false })
  declare status: SubscriptionStatus;
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 1 })
  declare quantity: number;
  @Column({ type: DataType.INTEGER, allowNull: false })
  declare billingAnchorDay: number;
  @Column({ type: DataType.DATE, allowNull: false })
  declare currentPeriodStart: Date;
  @Column({ type: DataType.DATE, allowNull: false })
  declare currentPeriodEnd: Date;
  @Column({ type: DataType.DATE, allowNull: true })
  declare trialEndsAt: Date | null;
  @Column({ type: DataType.BOOLEAN, allowNull: false, defaultValue: false })
  declare cancelAtPeriodEnd: boolean;
  @Column({ type: DataType.TEXT, allowNull: true }) declare paymentMethodRef:
    string | null;
  @Column({ type: DataType.INTEGER, allowNull: false, defaultValue: 0 })
  declare version: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}
