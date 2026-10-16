/**
 * Public entry point of the `content` domain (constitution X.4). Code outside this domain imports only from
 * `@app/domains/content`. The barrel exports the three Nest modules the apps host and nothing else: no model,
 * service, repository, consumer or port implementation. `content` is a leaf: it provides no R1 export.
 */
export {
  StoriesModule,
  StoriesWorkerModule,
  StoriesProjectorModule,
} from './stories.module';
