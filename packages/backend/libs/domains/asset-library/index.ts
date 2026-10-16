/**
 * Public entry point of the `asset-library` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/asset-library`. The barrel exports the four modules the apps host and nothing else: no model,
 * repository, job class or port implementation.
 */
export {
  AssetsModule,
  AssetsWorkerModule,
  AssetsProjectorModule,
} from './assets.module';
export { AssetTopicsModule } from './realtime-topics.module';
