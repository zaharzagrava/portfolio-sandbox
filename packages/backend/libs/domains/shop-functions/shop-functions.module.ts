import {
  Body,
  Controller,
  Global,
  Injectable,
  Module,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiProperty, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  Length,
} from 'class-validator';
import { AuthModule, User, UserRawDto } from '@app/domains/identity';
import { SqsModule } from '@app/infrastructure/sqs/sqs.module';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { ShopScoped } from '@app/domains/tenancy';
import { CheckoutDiscounts } from '@app/domains/orders';
import {
  ShopFunctionsService,
  TEST_RUN_QUEUE,
} from './application/shop-functions.service';
import type { FunctionInput } from './domain/contract';

export class CreateFunctionDto {
  @ApiProperty() @IsString() @Length(1, 60) name: string;
  @ApiProperty({
    description: '[{ name, input: FunctionInput, expected: FunctionOutput }]',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  tests: { name: string; input: FunctionInput; expected: unknown }[];
}

export class SubmitDto {
  @ApiProperty({ example: 'function run(input) { return { discounts: [] }; }' })
  @IsString()
  @Length(1, 20_000)
  source: string;
}

@ApiTags('shop-functions')
@Controller('shops/:shopId/functions')
export class ShopFunctionsController {
  constructor(private readonly functions: ShopFunctionsService) {}

  @ShopScoped('shop.manage')
  @Post()
  create(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Body() body: CreateFunctionDto,
  ) {
    return this.functions.create(shopId, body.name, body.tests);
  }

  @ShopScoped('shop.manage')
  @Post(':functionId/versions')
  submit(
    @Param('shopId', ParseUUIDPipe) shopId: string,
    @Param('functionId', ParseUUIDPipe) functionId: string,
    @User() user: UserRawDto,
    @Body() body: SubmitDto,
  ) {
    return this.functions.submit(shopId, functionId, user.id, body.source);
  }
}

/**
 * SD-40 (core). Global so the orders module's CheckoutService receives the
 * CheckoutDiscounts implementation without depending on this module.
 */
@Global()
@Module({
  imports: [AuthModule, SqsModule],
  providers: [
    ShopFunctionsService,
    { provide: CheckoutDiscounts, useExisting: ShopFunctionsService },
  ],
  exports: [ShopFunctionsService, CheckoutDiscounts],
  controllers: [ShopFunctionsController],
})
export class ShopFunctionsModule {}

/**
 * The judge worker. In production this is its own deployable (apps/function-runner
 * image): separate container, no network egress, read-only root FS, non-root
 * user, seccomp default profile - the process wall behind the isolate wall.
 */
@Injectable()
class FunctionJudgeWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private stop?: () => Promise<void>;

  constructor(
    private readonly queue: TaskQueue,
    private readonly functions: ShopFunctionsService,
  ) {}

  onApplicationBootstrap() {
    this.stop = this.queue.consume<{ functionId: string; version: number }>(
      TEST_RUN_QUEUE,
      async ({ body }) =>
        void (await this.functions.judge(body.functionId, body.version)),
      { concurrency: 4 },
    );
  }

  async onModuleDestroy() {
    await this.stop?.();
  }
}

@Module({
  imports: [SqsModule],
  providers: [ShopFunctionsService, FunctionJudgeWorker],
})
export class FunctionJudgeModule {}
