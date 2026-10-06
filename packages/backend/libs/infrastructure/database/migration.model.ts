import {
  Column,
  Model,
  Table,
  CreatedAt,
  PrimaryKey,
  UpdatedAt,
} from 'sequelize-typescript';

export enum MigrationEnum {}

@Table({
  timestamps: true,
  tableName: 'Migration',
})
export default class Migration extends Model<Migration, Partial<Migration>> {
  @PrimaryKey
  @Column
  declare id: string;

  @CreatedAt
  declare createdAt: Date;

  @UpdatedAt
  declare updatedAt: Date;
}
