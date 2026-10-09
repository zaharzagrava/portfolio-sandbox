import './instrument';
import { NestFactory } from '@nestjs/core';
import { CoreModule } from './core.module';
import { Environment } from '@app/common/types';
import { INestApplication } from '@nestjs/common';
import { configureHttpApp } from '@app/infrastructure/platform';
import { ApiConfigService } from '@app/common/config';

import Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

async function bootstrap() {
  const app: INestApplication = await NestFactory.create(CoreModule, {
    bufferLogs: true,
    // SD-19: Stripe webhook signatures are computed over the exact raw bytes.
    rawBody: true,
  });

  const configService: ApiConfigService = app.get(ApiConfigService);

  // F-01: helmet, CORS allowlist, /api prefix (health excluded), validation,
  // structured logs, crash handlers, graceful shutdown (replaces enableShutdownHooks).
  configureHttpApp(app);

  const isLocal = configService.get('node_env') === Environment.local;

  if (!isLocal) {
    Sentry.init({
      dsn: configService.get('sentry_dsn'),
      integrations: [nodeProfilingIntegration()],
      tracesSampleRate: 1.0,
      profilesSampleRate: 1.0,
    });
  }

  await app.listen(configService.get('port'));
}

bootstrap();
