import Payment from './infra/models/payment.model';
import PaymentHistory from './infra/models/payment-history.model';
import PayableOrder from './infra/models/payable-order.model';

/** The payment-intent models this domain owns (no model of another owner: IX.4). */
export const PAYMENT_MODELS = [Payment, PaymentHistory, PayableOrder];
