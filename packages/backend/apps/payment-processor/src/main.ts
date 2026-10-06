import './instrument';
import { NestFactory } from '@nestjs/core';
import { PaymentProcessorModule } from './payment-processor.module';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { Environment } from '@app/common/types';
import { installCrashHandlers, installGracefulShutdown } from '@app/infrastructure/lifecycle/graceful-shutdown';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(PaymentProcessorModule, {
    bufferLogs: true,
  });

  const configService = app.get(ApiConfigService);

  const isLocalKafka = [Environment.local, Environment.test].includes(
    configService.get('node_env'),
  );

  const microservice = await NestFactory.createMicroservice<MicroserviceOptions>(
    PaymentProcessorModule,
    {
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
        consumer: {
          groupId: 'payment-processor',
        },
      },
    },
  );

  // F-01: ordered shutdown (stop consuming → flush → close pools).
  installCrashHandlers();
  installGracefulShutdown(microservice);
  await microservice.listen();
}

bootstrap();
