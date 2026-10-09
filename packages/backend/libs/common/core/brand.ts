/**
 * Nominal ("branded") types on top of TS structural typing: a ShopId can't be
 * passed where an OrderId is expected even though both are strings at runtime.
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Cast helper for trusted boundaries (DB rows, validated DTOs). */
export const asBrand = <B extends Brand<unknown, string>>(
  value: Omit<B, typeof brand>,
): B => value as B;
