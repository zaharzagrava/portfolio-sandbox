import {
  Column,
  DataType,
  Model,
  PrimaryKey,
  Table,
} from 'sequelize-typescript';

/** An immutable named or `published` snapshot of a draft (S06). `objectKey` is `versions/<id>` in the object store. */
@Table({
  modelName: 'ListingDraftVersion',
  tableName: 'ListingDraftVersion',
  timestamps: false,
})
export default class ListingDraftVersion extends Model<
  ListingDraftVersion,
  Partial<ListingDraftVersion>
> {
  @PrimaryKey
  @Column({ type: DataType.UUID })
  declare id: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare draftId: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare shopId: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare name: string;

  @Column({ type: DataType.TEXT, allowNull: false })
  declare kind: 'named' | 'published';

  @Column({ type: DataType.TEXT, allowNull: false })
  declare objectKey: string;

  @Column({ type: DataType.UUID, allowNull: false })
  declare createdBy: string;

  @Column({ type: DataType.DATE, allowNull: false })
  declare createdAt: Date;
}
