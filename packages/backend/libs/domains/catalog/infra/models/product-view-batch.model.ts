import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** Marker of an applied chunk of a view-count flush: a replay of the same batch skips the chunk. */
@Table({
  modelName: 'ProductViewBatch',
  tableName: 'ProductViewBatch',
  timestamps: false,
})
export default class ProductViewBatch extends Model<
  ProductViewBatch,
  Partial<ProductViewBatch>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare batchId: string;

  @PrimaryKey
  @Column({ type: DataType.INTEGER })
  declare chunk: number;

  @Column({ type: DataType.DATE, allowNull: false })
  declare appliedAt: Date;
}
