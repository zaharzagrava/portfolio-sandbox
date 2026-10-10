import {
  boardPostsPageSchema,
  type BoardPostsPage,
} from '@marketplace-sandbox/contracts';
import { Endpoint, enc } from './endpoint';

/** S25 `GET /api/boards/:productId/posts?sort=hot&limit=3`. */
export const hotPosts = (productId: string): Endpoint<BoardPostsPage> => ({
  name: 'discussions',
  upstream: 'boards',
  method: 'GET',
  path: `/api/boards/${enc(productId)}/posts`,
  query: { sort: 'hot', limit: '3' },
  schema: boardPostsPageSchema,
  identity: 'none',
  sharedCache: true,
  breaker: true,
});
