const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A product id is a UUID; anything else is not a product and is never sent to the API (W02 FR-051). */
export const isProductId = (value: string): boolean => UUID.test(value);
