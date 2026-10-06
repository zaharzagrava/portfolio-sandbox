import { Global, Module } from '@nestjs/common';
import { TransactionRunner } from './transaction-runner.service';

/** Separate from RequestContextModule so apps without Sequelize can still use CLS. */
@Global()
@Module({
  providers: [TransactionRunner],
  exports: [TransactionRunner],
})
export class TransactionModule {}
