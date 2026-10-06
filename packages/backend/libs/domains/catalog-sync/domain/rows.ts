import { z } from 'zod';

/**
 * One catalog row (CSV columns or JSONL keys). Coercion handles CSV strings;
 * price is in MAJOR units in the file ("12.99") - shops' ERPs export it that
 * way - and converted to minor units exactly (no float arithmetic).
 */
export const CatalogRow = z.object({
  sku: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).optional().default(''),
  price: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => /^\d{1,9}(\.\d{1,2})?$/.test(v), 'price must look like 12.99')
    .transform((v) => {
      const [whole, frac = ''] = v.split('.');
      return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
    }),
  stock: z.coerce.number().int().min(0).max(1_000_000),
  category: z.string().trim().min(1).max(60),
  brand: z.string().trim().max(60).optional().default(''),
});
export type CatalogRow = z.infer<typeof CatalogRow>;

/** First bytes decide the parser (never the file extension); binary is refused. */
export function sniff(head: Buffer): 'jsonl' | 'csv' | 'binary' {
  if (head.includes(0)) return 'binary';
  const text = head.toString('utf8').replace(/^﻿/, '').trimStart();
  return text.startsWith('{') ? 'jsonl' : 'csv';
}
