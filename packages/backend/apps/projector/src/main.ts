import './instrument';
import { NestFactory } from '@nestjs/core';
import { ProjectorModule } from './projector.module';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';

async function bootstrap() {
  // HTTP only for /livez, /readyz and metrics - the work is Kafka consumption.
  const app = await NestFactory.create(ProjectorModule, { bufferLogs: true });
  configureHttpApp(app);
  await app.listen(app.get(ApiConfigService).get('port'));
}

bootstrap();
