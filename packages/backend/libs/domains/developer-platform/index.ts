/**
 * Public entry point of the `developer-platform` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/developer-platform`: the Nest modules of the deployables, the version service (R1) and the
 * rate-limit policy table. Webhooks (S43) leave this domain as Nest modules only: dashboard, worker, projector and
 * the Lambda host; no service, projector or deliverer class is exported (D-8).
 */
export { DevelopersModule } from './developers.module';
export { PublicApiProjectorModule } from './public-api-projector.module';
export { PublicApiWorkerModule } from './public-api-worker.module';
export { PublicApiModule, publicApiRequestContext } from './public-api.module';
export { ApiVersionService } from './application/api-version.service';
export { developerPlatformRatePolicies } from './rate-limit-policies';
export { WebhooksLambdaModule } from './webhooks-lambda.module';
export { WebhooksProjectorModule } from './webhooks-projector.module';
export { WebhooksWorkerModule } from './webhooks-worker.module';
export { WebhooksModule } from './webhooks.module';
export { WidgetModule } from './widget.module';
export { WidgetProjectorModule } from './widget-projector.module';
export { WidgetSessionService } from './application/widget-session.service';
export type { WidgetPrincipal } from './application/widget-session.service';
export { WidgetSiteChanged } from './application/events/widget-events';
