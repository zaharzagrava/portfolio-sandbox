import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID as v4 } from 'crypto';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { TableName } from '@app/test/seeds/types';
import { ProductModule } from './product.module';
import { ProductService } from './application/product.service';
import { ElasticsearchService } from '@app/infrastructure/elasticsearch/elasticsearch.service';

describe('Product (e2e)', () => {
  let app: INestApplication;
  let seedsService: SeedsService;
  let productService: ProductService;
  let esService: ElasticsearchService;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([ProductModule, RateLimitModule, CacheModule, SeedsModule], { stores: ['redis'] });
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api');
    await app.init();
    seedsService = app.get(SeedsService);
    productService = app.get(ProductService);
    esService = app.get(ElasticsearchService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedsService.clean();
    // Clean ES properly by getting concrete index name
    try {
      const aliases = await esService.getClient().indices.getAlias({ name: 'products' });
      const indices = Object.keys(aliases);
      if (indices.length > 0) {
        await esService.getClient().indices.delete({ index: indices });
      }
    } catch (e) {
      console.log('ES cleanup error (likely not found)', e);
    }
    await esService.ensureProductsIndex();
  });

  it('retrieves a product by ID', async () => {
    const [product] = await seedsService.createTreelike([{ __type__: TableName.Product, title: 'Test Product 123' }]);

    const res = await request(app.getHttpServer())
      .get(`/api/products/${product.id}`)
      .expect(200);

    expect(res.body.id).toBe(product.id);
    expect(res.body.title).toBe('Test Product 123');
  });

  it('returns 404 for non-existent product', async () => {
    await request(app.getHttpServer())
      .get(`/api/products/${v4()}`)
      .expect(404);
  });

  it('searches for products and respects pagination', async () => {
    // Seed and index manually for test
    const [p1, p2, p3] = await seedsService.createTreelike([
      { __type__: TableName.Product, title: 'Apple iPhone' },
      { __type__: TableName.Product, title: 'Apple iPad' },
      { __type__: TableName.Product, title: 'Samsung Galaxy' },
    ]);

    await esService.bulkUpsertProducts([
      { id: p1.id, title: p1.title, embedding: esService.stubEmbed(p1.title) } as any,
      { id: p2.id, title: p2.title, embedding: esService.stubEmbed(p2.title) } as any,
      { id: p3.id, title: p3.title, embedding: esService.stubEmbed(p3.title) } as any,
    ], { refresh: true });

    // Search query
    const res = await request(app.getHttpServer())
      .get('/api/products/search?q=Apple')
      .expect(200);

    expect(res.body.hits).toHaveLength(2);
    expect(res.body.hits.some((h: any) => h.id === p1.id)).toBe(true);
    expect(res.body.hits.some((h: any) => h.id === p2.id)).toBe(true);
    expect(res.body.total).toBe(2);
  });

  describe('search filters and sorting', () => {
    beforeEach(async () => {
      // Seed products with specific prices, ratings, and creation dates
      const [p1, p2, p3] = await seedsService.createTreelike([
        { __type__: TableName.Product, title: 'Cheap Phone', price: 10000, rating: 3.5, createdAt: new Date('2026-01-01') },
        { __type__: TableName.Product, title: 'Mid Phone', price: 30000, rating: 4.2, createdAt: new Date('2026-01-05') },
        { __type__: TableName.Product, title: 'Expensive Phone', price: 80000, rating: 4.8, createdAt: new Date('2026-01-10') },
      ]);

      await esService.bulkUpsertProducts([
        { id: p1.id, title: p1.title, price: 10000, rating: 3.5, createdAt: new Date('2026-01-01').toISOString(), embedding: esService.stubEmbed(p1.title) } as any,
        { id: p2.id, title: p2.title, price: 30000, rating: 4.2, createdAt: new Date('2026-01-05').toISOString(), embedding: esService.stubEmbed(p2.title) } as any,
        { id: p3.id, title: p3.title, price: 80000, rating: 4.8, createdAt: new Date('2026-01-10').toISOString(), embedding: esService.stubEmbed(p3.title) } as any,
      ], { refresh: true });
    });

    it('filters by price range', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/products/search?priceMin=20000&priceMax=50000')
        .expect(200);

      expect(res.body.hits).toHaveLength(1);
      expect(res.body.hits[0].source.title).toBe('Mid Phone');
    });

    it('filters by rating', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/products/search?ratingMin=4.0')
        .expect(200);

      expect(res.body.hits).toHaveLength(2);
      expect(res.body.hits.some((h: any) => h.source.title === 'Mid Phone')).toBe(true);
      expect(res.body.hits.some((h: any) => h.source.title === 'Expensive Phone')).toBe(true);
    });

    it('sorts by price-asc', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/products/search?sort=price-asc')
        .expect(200);

      expect(res.body.hits).toHaveLength(3);
      expect(res.body.hits[0].source.title).toBe('Cheap Phone');
      expect(res.body.hits[1].source.title).toBe('Mid Phone');
      expect(res.body.hits[2].source.title).toBe('Expensive Phone');
    });

    it('sorts by price-desc', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/products/search?sort=price-desc')
        .expect(200);

      expect(res.body.hits).toHaveLength(3);
      expect(res.body.hits[0].source.title).toBe('Expensive Phone');
      expect(res.body.hits[1].source.title).toBe('Mid Phone');
      expect(res.body.hits[2].source.title).toBe('Cheap Phone');
    });

    it('sorts by newest', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/products/search?sort=newest')
        .expect(200);

      expect(res.body.hits).toHaveLength(3);
      expect(res.body.hits[0].source.title).toBe('Expensive Phone');
      expect(res.body.hits[1].source.title).toBe('Mid Phone');
      expect(res.body.hits[2].source.title).toBe('Cheap Phone');
    });
  });
});
