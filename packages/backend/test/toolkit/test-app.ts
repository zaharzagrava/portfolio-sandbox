import { INestApplication, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { ApiConfigModule } from '@app/common/config/api-config.module';
import { ErrorUtilsModule } from '@app/common/errors/error-utils/error-utils.module';
import { AllExceptionsFilter } from '@app/common/exceptions-filter/exceptions-filter';
import { HealthModule } from '@app/infrastructure/health/health.module';
import { RequestContextModule } from '@app/infrastructure/context/request-context.module';
import { ClockModule } from '@app/infrastructure/platform/clock.module';
import { ToolkitTestControllerModule } from './test-controller.module';

@Module({
  imports: [
    ApiConfigModule,
    ClockModule,
    RequestContextModule,
    ErrorUtilsModule,
    HealthModule,
    ToolkitTestControllerModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class ToolkitTestAppModule {}

/**
 * Boots a Nest app from the real toolkit modules plus the test controller module.
 * `customize` lets a spec swap a provider (e.g. CLOCK → FakeClock) before the app is compiled.
 * Bootstrap options (pipeline order, pipes) come from `configureApp`, which defaults to a plain init.
 */
export async function createToolkitApp(
  options: {
    customize?: (b: TestingModuleBuilder) => TestingModuleBuilder;
    configureApp?: (app: INestApplication) => void | Promise<void>;
  } = {},
): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [ToolkitTestAppModule] });
  if (options.customize) builder = options.customize(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ bufferLogs: false });
  await options.configureApp?.(app);
  await app.init();
  return app;
}
