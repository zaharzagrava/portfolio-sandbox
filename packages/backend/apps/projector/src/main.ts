import './instrument';
import { NestFactory } from '@nestjs/core';
import { ProjectorModule } from './projector.module';
import { ApiConfigService } from '@app/common/config';
import { configureHttpApp } from '@app/infrastructure/platform';

async function bootstrap() {
  // HTTP only for /health/live, /health/ready and metrics - the work is Kafka consumption.
  const app = await NestFactory.create(ProjectorModule, { bufferLogs: true });
  configureHttpApp(app);
  await app.listen(app.get(ApiConfigService).get('port'));
}

bootstrap();
