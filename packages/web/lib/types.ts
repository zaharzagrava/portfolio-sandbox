/**
 * Shared frontend types for the marketplace.
 * These mirror the backend contracts and will be replaced by
 * `@marketplace-sandbox/contracts` zod schemas once fully wired up.
 */

// ---------- Auth ----------

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  role: "buyer" | "seller" | "admin";
  mfaEnabled: boolean;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

export interface LoginRequest {
  email: string;
  password: string;
  totpCode?: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
}

// ---------- Products ----------

export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string;
  priceCents: number;
  currency: string;
  images: ProductImage[];
  shopId: string;
  shopName: string;
  categoryId: string;
  stockCount: number;
  rating: number;
  reviewCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductImage {
  id: string;
  url: string;
  alt: string;
  width: number;
  height: number;
  order: number;
}

export interface ProductSearchResult {
  products: Product[];
  total: number;
  facets: SearchFacet[];
  suggestions?: string[];
}

export interface SearchFacet {
  field: string;
  label: string;
  values: Array<{
    value: string;
    count: number;
    selected: boolean;
  }>;
}

// ---------- Cart & Checkout ----------

export interface CartItem {
  productId: string;
  product: Product;
  quantity: number;
  priceCents: number;
}

export interface Cart {
  items: CartItem[];
  totalCents: number;
  currency: string;
}

export type PaymentStatus =
  | "PENDING"
  | "PROCESSING"
  | "SUCCESS"
  | "FAILED"
  | "REFUNDED";

export interface Order {
  id: string;
  status: OrderStatus;
  items: OrderItem[];
  totalCents: number;
  currency: string;
  paymentStatus: PaymentStatus;
  createdAt: string;
  updatedAt: string;
}

export type OrderStatus =
  | "CREATED"
  | "PAID"
  | "SHIPPED"
  | "DELIVERED"
  | "CANCELLED";

export interface OrderItem {
  productId: string;
  productName: string;
  quantity: number;
  priceCents: number;
}

// ---------- Chat ----------

export interface ChatChannel {
  id: string;
  name: string;
  productId?: string;
  members: ChatMember[];
  lastMessage?: ChatMessage;
  unreadCount: number;
}

export interface ChatMember {
  userId: string;
  name: string;
  avatarUrl?: string;
  isOnline: boolean;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  seq: number;
  senderId: string;
  senderName: string;
  content: string;
  clientMessageId: string;
  createdAt: string;
}

// ---------- Notifications ----------

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  read: boolean;
  data?: Record<string, unknown>;
  createdAt: string;
}

// ---------- Shops (Seller) ----------

export interface Shop {
  id: string;
  name: string;
  slug: string;
  description: string;
  logoUrl?: string;
  ownerId: string;
  memberCount: number;
  productCount: number;
  createdAt: string;
}

// ---------- SSE Events ----------

export interface SSEEvent<T = unknown> {
  topic: string;
  data: T;
  id: string;
}

// ---------- Pagination ----------

export interface CursorPage<T> {
  items: T[];
  cursor: string | null;
  hasMore: boolean;
}

export interface OffsetPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
