import { z } from 'zod';

/**
 * The OpenAPI description of the public API as the developer-docs page reads it (`GET /api/developers/openapi.json`,
 * W07 FR-031). Only what the page needs is checked; unknown fields pass through. `openapi` must be 3.x and `paths` an object.
 */
const operationSchema = z
  .object({
    summary: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    operationId: z.string().optional(),
    deprecated: z.boolean().optional(),
    security: z.array(z.record(z.string(), z.array(z.string()))).optional(),
    'x-scope': z.string().optional(),
  })
  .loose();

export const openApiDocumentSchema = z
  .object({
    openapi: z.string().regex(/^3\./, 'OpenAPI 3.x expected'),
    info: z.object({ title: z.string(), version: z.string().optional(), description: z.string().optional() }).loose(),
    paths: z.record(z.string(), z.record(z.string(), z.unknown())),
    tags: z.array(z.object({ name: z.string(), description: z.string().optional() }).loose()).optional(),
  })
  .loose();

export type OpenApiDocument = z.infer<typeof openApiDocumentSchema>;
export type OpenApiOperation = z.infer<typeof operationSchema>;
export const openApiOperationSchema = operationSchema;
