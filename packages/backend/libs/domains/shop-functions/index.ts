/**
 * Public entry point of the `shop-functions` domain (constitution X.4). Code outside this domain imports only from
 * `@app/domains/shop-functions`: the two modules, `DiscountEvaluationService` (orders calls it at checkout) and the
 * two DTO types. No model, repository, port token or sandbox class leaves the domain (S45 FR-036).
 */
export { ShopFunctionsModule } from './shop-functions.module';
export { FunctionJudgeModule } from './function-judge.module';
export { DiscountEvaluationModule } from './discount-evaluation.module';
export { DiscountEvaluationService } from './application/discount-evaluation.service';
// The program of the credential-less function-runner deployable (apps/function-runner); a function, not a class of the domain.
export { startRunnerServer } from './runner/main';
export type {
  DiscountCartDto,
  DiscountEvaluationDto,
} from './application/discount-evaluation.dto';
