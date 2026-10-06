/** Dimension of the product embedding vector in the `products` index (k-NN). */
export const PRODUCT_EMBEDDING_DIMS = 64;

export interface UpsertProductDocument {
  id: string;
  title: string;
  description: string;
  brand: string;
  category: string;
  price: number;
  rating: number;
  tags?: string[];
  embedding?: number[] | null;
  /** Product.version - with `external_gte` versioning ES ignores out-of-order (older) writes (SD-37). */
  version?: number;
  /** SD-37 business boosts. */
  inStock?: boolean;
  popularity?: number;
  createdAt?: string | Date;
}

export interface ProductSearchParams {
  q?: string;
  priceMin?: number;
  priceMax?: number;
  ratingMin?: number;
  category?: string;
  brand?: string;
  facets?: boolean;
  semantic?: boolean;
  sort?: 'relevance' | 'price-asc' | 'price-desc' | 'newest';
  size?: number;
  from?: number;
}

export interface ProductSearchHit {
  id: string;
  score: number;
  source: {
    title: string;
    description: string;
    brand: string;
    category: string;
    price: number;
    rating: number;
    tags?: string[];
  };
}

export interface ProductSearchResult {
  total: number;
  hits: ProductSearchHit[];
  suggestions: string[];
  facets?: {
    categories: { key: string; count: number }[];
    brands: { key: string; count: number }[];
    priceRanges: { key: string; count: number }[];
    avgRating: number | null;
  };
}
