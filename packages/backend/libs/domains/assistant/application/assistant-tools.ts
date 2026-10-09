import { Injectable, Logger } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ProductService } from '@app/domains/catalog';
import { AvailabilityIndex } from '@app/domains/fulfilment';

export interface ToolContext {
  /** From the request (device location), never from the model - it can't invent where the user is. */
  location: { lat: number; lng: number } | null;
}

const nullableNumber = { type: ['number', 'null'] } as const;
const nullableString = { type: ['string', 'null'] } as const;

/**
 * Read-only tools only (10/10 #44): nothing here can buy, message, or change
 * state, so a prompt injection hidden in seller-written product text can at
 * worst steer an answer - never act for the user. Strict schemas (valid
 * arguments guaranteed) + eager input streaming; inputs are still validated
 * with zod because eagerly streamed inputs are not server-validated.
 *
 * Declared once and in a fixed order: the tool list is part of the cached
 * prefix and of the prefix thinking blocks are bound to.
 */
export const ASSISTANT_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'search_products',
    description:
      'Search the marketplace catalogue. Use for any request to find, compare or recommend products. Prices are integer minor units (cents, EUR). Returns at most `limit` hits with id, title, brand, category, price, rating.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text query, e.g. "phone good camera"',
        },
        max_price: {
          ...nullableNumber,
          description: 'Upper price bound in cents, or null',
        },
        category: {
          ...nullableString,
          description: 'Exact category name, or null',
        },
        limit: { ...nullableNumber, description: '1-10, default 5' },
      },
      required: ['query', 'max_price', 'category', 'limit'],
      additionalProperties: false,
    },
    strict: true,
    eager_input_streaming: true,
  },
  {
    name: 'product_details',
    description:
      'Full details for one product id returned by search_products: description, price, rating, stock.',
    input_schema: {
      type: 'object',
      properties: { product_id: { type: 'string' } },
      required: ['product_id'],
      additionalProperties: false,
    },
    strict: true,
    eager_input_streaming: true,
  },
  {
    name: 'pickup_near_me',
    description:
      "Products in stock at pickup points near the user's current location (shared by the app). Fails if the user has not shared a location - then ask them to enable it.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        radius_km: { ...nullableNumber, description: '1-50, default 10' },
      },
      required: ['query', 'radius_km'],
      additionalProperties: false,
    },
    strict: true,
    eager_input_streaming: true,
  },
];

const SearchInput = z.object({
  query: z.string().min(1).max(200),
  max_price: z.number().nonnegative().nullable(),
  category: z.string().max(100).nullable(),
  limit: z.number().int().min(1).max(10).nullable(),
});
const DetailsInput = z.object({ product_id: z.string().uuid() });
const NearInput = z.object({
  query: z.string().min(1).max(200),
  radius_km: z.number().min(1).max(50).nullable(),
});

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

/** Long seller descriptions are cut: they cost tokens on every later request of the conversation. */
const clip = (s: unknown, n = 600) =>
  typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s;

@Injectable()
export class AssistantToolExecutor {
  private readonly logger = new Logger(AssistantToolExecutor.name);

  constructor(
    private readonly products: ProductService,
    private readonly availability: AvailabilityIndex,
  ) {}

  async run(
    name: string,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    try {
      switch (name) {
        case 'search_products': {
          const args = SearchInput.safeParse(input);
          if (!args.success) return invalid(input);
          const res = await this.products.search({
            q: args.data.query,
            priceMax: args.data.max_price ?? undefined,
            category: args.data.category ?? undefined,
            size: args.data.limit ?? 5,
          });
          const hits = res.hits.map((h) => ({
            id: h.id,
            title: h.source.title,
            brand: h.source.brand,
            category: h.source.category,
            price: h.source.price,
            rating: h.source.rating,
          }));
          return ok({ total: res.total, hits });
        }
        case 'product_details': {
          const args = DetailsInput.safeParse(input);
          if (!args.success) return invalid(input);
          const p = await this.products.findById(args.data.product_id);
          if (!p) return { content: 'No product with that id.', isError: true };
          return ok({
            id: p.id,
            title: p.title,
            brand: p.brand,
            category: p.category,
            price: p.price,
            rating: p.rating,
            inStock: p.inStock,
            description: clip(p.description),
          });
        }
        case 'pickup_near_me': {
          const args = NearInput.safeParse(input);
          if (!args.success) return invalid(input);
          if (!ctx.location)
            return {
              content: 'The user has not shared a location.',
              isError: true,
            };
          const hits = await this.availability.searchNear({
            q: args.data.query,
            lat: ctx.location.lat,
            lng: ctx.location.lng,
            radiusKm: args.data.radius_km ?? 10,
            size: 5,
          });
          return ok({ hits });
        }
        default:
          return { content: `Unknown tool ${name}`, isError: true };
      }
    } catch (error) {
      // The model sees a generic failure (no internals); the log keeps the cause.
      this.logger.warn(`tool ${name} failed: ${(error as Error).message}`);
      return {
        content:
          'The tool failed; tell the user search is temporarily unavailable.',
        isError: true,
      };
    }
  }
}

const ok = (value: unknown): ToolOutcome => ({
  content: JSON.stringify(value),
  isError: false,
});
const invalid = (input: unknown): ToolOutcome => ({
  content: JSON.stringify({ INVALID_INPUT: JSON.stringify(input) }),
  isError: true,
});
