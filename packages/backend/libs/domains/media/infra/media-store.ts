import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes } from 'sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  GalleryRepository,
  MediaRepository,
  MediaStore,
  SqlRunner,
  Tx,
} from '../domain/ports';
import { PgGalleryRepository } from './pg-gallery-repository';
import { PgMediaRepository } from './pg-media-repository';

/**
 * A `SqlRunner` over Sequelize. Inside `TransactionRunner.run` the CLS namespace makes every statement join the
 * active transaction, so the same repositories serve single statements and transactions.
 */
export const sequelizeRunner =
  (sequelize: Sequelize): SqlRunner =>
  <T>(text: string, params: unknown[] = []) =>
    sequelize.query(text, {
      bind: params as never,
      type: QueryTypes.SELECT,
    }) as Promise<T[]>;

@Injectable()
export class SequelizeMediaStore extends MediaStore {
  readonly media: MediaRepository;
  readonly gallery: GalleryRepository;
  readonly tx: Tx;

  constructor(
    @InjectConnection() sequelize: Sequelize,
    runner: TransactionRunner,
  ) {
    super();
    const sql = sequelizeRunner(sequelize);
    this.media = new PgMediaRepository(sql);
    this.gallery = new PgGalleryRepository(sql);
    this.tx = (fn) =>
      runner.run(() =>
        fn({
          media: new PgMediaRepository(sql),
          gallery: new PgGalleryRepository(sql),
        }),
      );
  }
}
