import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { Sequelize } from 'sequelize-typescript';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  VideoStore,
  type RunVideoTx,
  type TaskRepository,
  type VideoRepository,
} from '../domain/video-ports';
import { sequelizeRunner } from './media-store';
import { PgVideoRepository } from './pg-video-repository';
import { PgVideoTaskRepository } from './pg-video-task-repository';

/**
 * The `VideoStore` over Sequelize. Inside `TransactionRunner.run` the CLS namespace makes every statement join the
 * active transaction (S54), so the same repositories serve single statements and units of work. `tx` is the only way
 * the application opens a transaction: no direct Sequelize transaction call lives in this domain any more.
 */
@Injectable()
export class SequelizeVideoStore extends VideoStore {
  readonly video: VideoRepository;
  readonly tasks: TaskRepository;
  readonly tx: RunVideoTx;

  constructor(
    @InjectConnection() sequelize: Sequelize,
    runner: TransactionRunner,
  ) {
    super();
    const sql = sequelizeRunner(sequelize);
    this.video = new PgVideoRepository(sql);
    this.tasks = new PgVideoTaskRepository(sql);
    this.tx = (fn) =>
      runner.run(() =>
        fn({
          video: new PgVideoRepository(sql),
          tasks: new PgVideoTaskRepository(sql),
        }),
      );
  }
}
