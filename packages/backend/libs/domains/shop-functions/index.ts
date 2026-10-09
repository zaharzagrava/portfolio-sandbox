/**
 * Public entry point of the `shop-functions` domain (constitution X.4). Code outside this domain imports only
 * from `@app/domains/shop-functions`. Generated from actual cross-domain usage in Phase 2 (later batches append); extend
 * it by hand when a new export is needed. Models exported here are transitional (IX.4 debt): other
 * domains must stop injecting them.
 */
export {
  FunctionJudgeModule,
  ShopFunctionsModule,
} from './shop-functions.module';
