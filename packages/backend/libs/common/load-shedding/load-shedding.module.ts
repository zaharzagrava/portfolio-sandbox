import { Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { EventLoopMonitor } from './event-loop-monitor.service';
import { LoadSheddingMiddleware } from './load-shedding.middleware';

@Global()
@Module({
  providers: [EventLoopMonitor],
  exports: [EventLoopMonitor],
})
export class LoadSheddingModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Express 5 / path-to-regexp v8: a named wildcard; '{*path}' also matches the bare prefix.
    consumer.apply(LoadSheddingMiddleware).forRoutes('{*path}');
  }
}
