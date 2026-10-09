import './instrument';
import { NestFactory } from '@nestjs/core';
import { SseGatewayModule } from './sse-gateway.module';
import { Environment } from '@app/common/types';
import { INestApplication } from '@nestjs/common';
import { configureHttpApp } from '@app/infrastructure/platform';
import { ApiConfigService } from '@app/common/config';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

import Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

async function bootstrap() {
  const app: INestApplication = await NestFactory.create(SseGatewayModule, {
    bufferLogs: true,
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

  const isLocalKafka = [Environment.local, Environment.test].includes(
    configService.get('node_env'),
  );

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        brokers: [configService.get('kafka_broker')],
        ...(isLocalKafka
          ? { retry: { retries: 0 } }
          : {
              ssl: true,
              sasl: {
                mechanism: 'plain',
                username: configService.get('kafka_api_key'),
                password: configService.get('kafka_api_secret'),
              },
            }),
      },
      consumer: { groupId: 'realtime-notifier' },
    },
  });

  await app.startAllMicroservices();
  await app.listen(configService.get('port'));
}

bootstrap();
