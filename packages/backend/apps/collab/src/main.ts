import './instrument';
import { NestFactory } from '@nestjs/core';
import { ApiConfigService } from '@app/common/config';
import { configureHttpApp } from '@app/infrastructure/platform';
import { CollabAppModule } from './collab-app.module';

async function bootstrap() {
  // HTTP for /health/live, /health/ready, metrics; WebSocket upgrades on /collab/:draftId.
  const app = await NestFactory.create(CollabAppModule, { bufferLogs: true });
  configureHttpApp(app);
  await app.listen(app.get(ApiConfigService).get('port'));
}

bootstrap();
