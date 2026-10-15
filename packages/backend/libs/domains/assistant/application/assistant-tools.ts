import { Injectable, Logger } from '@nestjs/common';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { ApiConfigService } from '@app/common/config';
import { ProductQueryService } from '@app/domains/catalog';
import { ProductSearchService } from '@app/domains/discovery';
import { PickupSearchService } from '@app/domains/fulfilment';
import type {
  ToolCatalog,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../domain/assistant-ports';
import { logIds } from './turn-log';

const nullableNumber = { type: ['number', 'null'] } as const;
const nullableString = { type: ['string', 'null'] } as const;

/**
 * Read-only tools only (S46 FR-016): nothing here can buy, message, or change state, so a prompt injection hidden in
 * seller-written product text can at worst steer an answer, never act for the user. Strict schemas plus eager input
 * streaming; inputs are still validated with zod because eagerly streamed inputs are not server-validated.
 *
 * Declared once and in a fixed order: the tool list is part of the cached prefix and of the prefix thinking blocks are
 * bound to. Prices are integer minor units with a currency code.
 */
export const ASSISTANT_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'search_products',
    description:
      'Search the marketplace catalogue. Use for any request to find, compare or recommend products. `max_price` is in minor units (cents) of the product currency. Returns at most `limit` hits with id, title, brand, category, priceMinor (minor units), currency, rating.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Free-text query, e.g. "phone good camera"',
        },
        max_price: {
          ...nullableNumber,
          description: 'Upper price bound in minor units (cents), or null',
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
      'Full details for one product id returned by search_products: description, priceMinor (minor units) with currency, rating, stock.',
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
      "Products in stock at pickup points near the user's current location (shared by the app). Prices are priceMinor in minor units with currency. Fails if the user has not shared a location - then ask them to enable it.",
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

export const ASSISTANT_TOOL_NAMES = ASSISTANT_TOOLS.map((t) => t.name);

const SearchInput = z
  .object({
    query: z.string().min(1).max(200),
    max_price: z.number().int().nonnegative().nullable(),
    category: z.string().max(100).nullable(),
    limit: z.number().int().min(1).max(10).nullable(),
  })
  .strict();
const DetailsInput = z.object({ product_id: z.string().uuid() }).strict();
const NearInput = z
  .object({
    query: z.string().min(1).max(200),
    radius_km: z.number().min(1).max(50).nullable(),
  })
  .strict();

/** Long seller descriptions are cut: they cost tokens on every later request of the conversation. */
const clip = (s: unknown, n = 600) =>
  typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s;

const failed: ToolResult = {
  ok: false,
  error: 'The tool failed; tell the user search is temporarily unavailable.',
};
const ok = (content: unknown): ToolResult => ({ ok: true, content });

/** Names the fields that failed validation, never their values (a value may be seller text). */
const invalid = (error: z.ZodError): ToolResult => ({
  ok: false,
  error: `Invalid input: ${[
    ...new Set(
      error.issues.flatMap((i) =>
        i.code === 'unrecognized_keys' ? i.keys : [i.path.join('.') || 'input'],
      ),
    ),
  ].join(', ')}.`,
});

/** The closed set of tools, each reached through the exported R1 service of the owning domain (S32, S05, S19). */
@Injectable()
export class AssistantToolCatalog implements ToolCatalog {
  private readonly logger = new Logger(AssistantToolCatalog.name);

  constructor(
    private readonly search: ProductSearchService,
    private readonly products: ProductQueryService,
    private readonly pickup: PickupSearchService,
    private readonly config: ApiConfigService,
  ) {}

  definitions(): ToolDefinition[] {
    return ASSISTANT_TOOLS.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.input_schema as Record<string, unknown>,
    }));
  }

  async execute(
    name: string,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    // Validation first: an invalid call or an unknown tool never reaches a service.
    const call = this.prepare(name, input, context);
    if ('error' in call) return call;
    const deadlineMs = this.config.get('assistant_tool_timeout_ms');
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        call.run(),
        new Promise<ToolResult>((resolve) => {
          timer = setTimeout(() => {
            this.logger.warn(`tool ${name} timed out ${this.ids(context)}`);
            resolve(failed);
          }, deadlineMs);
        }),
      ]);
    } catch {
      // The model sees a generic failure (no internals); the log has the tool name and the correlation id only.
      this.logger.warn(`tool ${name} failed ${this.ids(context)}`);
      return failed;
    } finally {
      clearTimeout(timer);
    }
  }

  private ids(context: ToolContext): string {
    return logIds({
      requestId: context.requestId,
      conversationId: context.conversationId,
      messageId: context.messageId,
      callId: context.callId,
    });
  }

  private prepare(
    name: string,
    input: unknown,
    context: ToolContext,
  ): { run: () => Promise<ToolResult> } | Extract<ToolResult, { ok: false }> {
    switch (name) {
      case 'search_products': {
        const args = SearchInput.safeParse(input);
        if (!args.success) return invalid(args.error) as never;
        return { run: () => this.searchProducts(args.data, context) };
      }
      case 'product_details': {
        const args = DetailsInput.safeParse(input);
        if (!args.success) return invalid(args.error) as never;
        return { run: () => this.productDetails(args.data.product_id) };
      }
      case 'pickup_near_me': {
        const args = NearInput.safeParse(input);
        if (!args.success) return invalid(args.error) as never;
        return { run: () => this.pickupNearMe(args.data, context) };
      }
      default:
        return { ok: false, error: 'Unknown tool.' } as never;
    }
  }

  private async searchProducts(
    args: z.infer<typeof SearchInput>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const res = await this.search.search({
      surface: 'internal',
      subject: context.userId,
      query: {
        q: args.query,
        ...(args.max_price !== null && { maxPriceMinor: args.max_price }),
        ...(args.category !== null && { category: args.category }),
        limit: args.limit ?? 5,
      },
    });
    return ok({
      total: res.total.value,
      hits: res.items.map((h) => ({
        id: h.id,
        title: h.title,
        brand: h.brand,
        category: h.category,
        priceMinor: h.priceMinor,
        currency: h.currency,
        rating: h.rating,
      })),
    });
  }

  private async productDetails(productId: string): Promise<ToolResult> {
    const found = await this.products.getProductsByIds([productId]);
    const p = found.get(productId) ?? found.get(productId.toLowerCase());
    // Archived, sandbox and unknown products are indistinguishable.
    if (!p || p.status !== 'ACTIVE' || p.isSandbox)
      return { ok: false, error: 'No product with that id.' };
    return ok({
      id: p.id,
      title: p.title,
      brand: p.brand,
      category: p.category,
      priceMinor: p.priceMinor,
      currency: p.currency,
      rating: p.rating,
      inStock: p.inStock,
      description: clip(p.description),
    });
  }

  private async pickupNearMe(
    args: z.infer<typeof NearInput>,
    context: ToolContext,
  ): Promise<ToolResult> {
    // The coordinates come from the request only; the model cannot supply them.
    if (!context.location)
      return { ok: false, error: 'The user has not shared a location.' };
    const { items } = await this.pickup.searchNear({
      q: args.query.trim().slice(0, 100) || undefined,
      lat: context.location.lat,
      lng: context.location.lng,
      radiusKm: args.radius_km ?? 10,
      limit: 5,
    });
    return ok({ hits: items });
  }
}
