import { BalanceProjector } from './infra/balance.projector';

/** The projectors of this domain, for `ProjectionsModule.forProjectors` in `apps/projector`. */
export const paymentsProjectors = [BalanceProjector];
