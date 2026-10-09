import { z } from 'zod';
import { declareJobType } from '@app/infrastructure/jobs/job-type-registry';

// Kept apart from the handlers (infra/order.jobs.ts) so an app that only enqueues (checkout, the orders controller,
// auctions) loads the declarations without the worker code.
declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'orders.expire-reservation': { orderId: string };
    'flash-sale.start': { saleId: string };
    'flash-sale.end': { saleId: string };
    'flash-sale.reconcile': { saleId: string };
  }
}

declareJobType({
  name: 'orders.expire-reservation',
  contract: z.object({ orderId: z.string() }),
});
declareJobType({
  name: 'flash-sale.start',
  contract: z.object({ saleId: z.string() }),
});
declareJobType({
  name: 'flash-sale.end',
  contract: z.object({ saleId: z.string() }),
});
declareJobType({
  name: 'flash-sale.reconcile',
  contract: z.object({ saleId: z.string() }),
});
