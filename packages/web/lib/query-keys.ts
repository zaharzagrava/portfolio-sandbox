export const queryKeys = {
  products: {
    all: ['products'],
    detail: (id: string) => ['products', id],
    search: (query: string) => ['products', 'search', query],
  },
  cart: { all: ['cart'] },
  auth: {
    session: () => ['auth', 'session'] as const,
    mfaStatus: () => ['auth', 'mfa-status'] as const,
    sessions: () => ['auth', 'sessions'] as const,
    identities: () => ['auth', 'identities'] as const,
    oidcProviders: () => ['auth', 'oidc-providers'] as const,
  },
  orders: {
    all: ['orders'],
    detail: (id: string) => ['orders', id],
  },
  chat: {
    channels: ['chat', 'channels'],
    messages: (channelId: string) => ['chat', 'messages', channelId],
  },
  notifications: { all: ['notifications'] },
  seller: {
    dashboard: (shopId: string) => ['seller', shopId, 'dashboard'],
    products: (shopId: string) => ['seller', shopId, 'products'],
  },
};
