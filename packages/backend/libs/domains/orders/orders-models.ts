import BisOrder from './infra/models/bis-order.model';
import BisOrderItem from './infra/models/bis-order-item.model';
import ShopOrder from './infra/models/shop-order.model';
import StockReservation from './infra/models/stock-reservation.model';
import FlashSale from './infra/models/flash-sale.model';

/** The models this domain owns (no model of another owner: IX.4). Registered in every module that uses the tables. */
export const ORDER_MODELS = [
  BisOrder,
  BisOrderItem,
  ShopOrder,
  StockReservation,
  FlashSale,
];
