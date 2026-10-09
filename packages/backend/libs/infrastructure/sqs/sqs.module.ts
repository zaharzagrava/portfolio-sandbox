import { Global, Module } from '@nestjs/common';
import { ApiConfigModule } from '@app/common/config';
import { TaskQueue } from './task-queue.port';
import { SqsTaskQueue } from './sqs-task-queue';

@Global()
@Module({
  imports: [ApiConfigModule],
  providers: [{ provide: TaskQueue, useClass: SqsTaskQueue }],
  exports: [TaskQueue],
})
export class SqsModule {}
