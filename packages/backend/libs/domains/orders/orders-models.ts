import BisOrder from './infra/models/bis-order.model';
import BisOrderItem from './infra/models/bis-order-item.model';
import ShopOrder from './infra/models/shop-order.model';
import StockReservation from './infra/models/stock-reservation.model';
import FlashSale from './infra/models/flash-sale.model';
import FlashSaleHistory from './infra/models/flash-sale-history.model';
import ExportJob from './infra/models/export-job.model';
import ExportJobHistory from './infra/models/export-job-history.model';
import Voucher from './infra/models/voucher.model';

/** The models this domain owns (no model of another owner: IX.4). Registered in every module that uses the tables. */
export const ORDER_MODELS = [
  BisOrder,
  BisOrderItem,
  ShopOrder,
  StockReservation,
  FlashSale,
  FlashSaleHistory,
  ExportJob,
  ExportJobHistory,
  Voucher,
];
