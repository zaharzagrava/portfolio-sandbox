import '@app/core/instrument';
import { NestFactory } from '@nestjs/core';
import { LocalMonolithModule } from './local-monolith.module';
import { ApiConfigService } from '@app/common/config/api-config.service';
import { configureHttpApp } from '@app/infrastructure/platform/bootstrap-http';
import { Environment } from '@app/common/types';
import Sentry from '@sentry/nestjs';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

async function bootstrap() {
  console.log('🚀 Bootstrapping Local Monolith (All apps in ONE Node process and ONE port)...');

  const app = await NestFactory.create(LocalMonolithModule, { bufferLogs: true, rawBody: true });
  configureHttpApp(app);
  
  const config = app.get(ApiConfigService);
  if (config.get('node_env') !== Environment.local) {
    Sentry.init({
      dsn: config.get('sentry_dsn'),
      integrations: [nodeProfilingIntegration()],
      tracesSampleRate: 1.0,
      profilesSampleRate: 1.0,
    });
  }

  const port = config.get('port') || 8000;
  await app.listen(port);
  console.log(`✅ Local Monolith listening on ${port}`);
}

bootstrap();
