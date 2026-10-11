const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An order id is a UUID; anything else is never an order and is never sent to the API (W03 AS-35, AS-50). */
export const isOrderId = (value: string): boolean => UUID.test(value);
