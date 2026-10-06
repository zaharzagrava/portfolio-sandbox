import './instrument';
import { NestFactory } from '@nestjs/core';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { CollabAppModule } from './collab-app.module';

async function bootstrap() {
  // HTTP for /livez, /readyz, metrics; WebSocket upgrades on /collab/:draftId.
  const app = await NestFactory.create(CollabAppModule, { bufferLogs: true });
  configureHttpApp(app);
  await app.listen(app.get(ApiConfigService).get('port'));
}

bootstrap();
