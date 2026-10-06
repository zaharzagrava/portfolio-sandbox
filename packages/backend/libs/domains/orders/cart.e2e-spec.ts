import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID as v4 } from 'crypto';
import { generateTestingModule } from '@app/test/utils/global-modules';
import { SeedsModule } from '@app/test/seeds/seeds.module';
import { OrdersModule } from './orders.module';
import { RateLimitModule } from '@app/infrastructure/rate-limit/rate-limit.module';
import { CacheModule } from '@app/infrastructure/cache/cache.module';
import { AuthService, UserModel as User } from '@app/domains/identity';
import { SeedsService } from '@app/test/seeds/seeds.service';
import { getModelToken } from '@nestjs/sequelize';
import { CartRepository } from './infra/cart.repository';
import { CartIdentity } from './api/cart-identity';

describe('Cart (e2e)', () => {
  let app: INestApplication;
  let seedsService: SeedsService;
  let authService: AuthService;
  let carts: CartRepository;
  let userModel: typeof User;

  beforeAll(async () => {
    const moduleRef = await generateTestingModule([OrdersModule, RateLimitModule, CacheModule, SeedsModule], { stores: ['redis', 'dynamo'] });
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api');
    await app.init();
    seedsService = app.get(SeedsService);
    authService = app.get(AuthService);
    carts = app.get(CartRepository);
    userModel = app.get(getModelToken(User));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedsService.clean();
  });

  it('allows a guest to add items and retrieves them via cookie', async () => {
    const productId = v4();

    // Add item to cart
    const putRes = await request(app.getHttpServer())
      .put(`/api/cart/items/${productId}`)
      .send({ quantity: 2 })
      .expect(200);

    expect(putRes.body.lines).toHaveLength(1);
    expect(putRes.body.lines[0]).toMatchObject({ productId, quantity: 2 });

    const cookies = putRes.headers['set-cookie'];
    expect(cookies).toBeDefined();

    // Fetch cart using cookie
    const getRes = await request(app.getHttpServer())
      .get('/api/cart')
      .set('Cookie', cookies)
      .expect(200);

    expect(getRes.body.lines).toHaveLength(1);
    expect(getRes.body.lines[0]).toMatchObject({ productId, quantity: 2 });
  });

  it('allows an authenticated user to add items to their cart', async () => {
    const user = await userModel.create({ email: `test-${v4()}@mail.com` });
    const token = authService.issueTokensFor(user).accessToken.token;
    const productId = v4();

    const putRes = await request(app.getHttpServer())
      .put(`/api/cart/items/${productId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ quantity: 5 })
      .expect(200);

    expect(putRes.body.lines).toHaveLength(1);
    expect(putRes.body.lines[0]).toMatchObject({ productId, quantity: 5 });

    // Verify it was stored in the user's cart in dynamo
    const storedLines = await carts.list(CartIdentity.userCartId(user.id));
    expect(storedLines).toHaveLength(1);
    expect(storedLines[0].quantity).toBe(5);
  });

  it('merges guest cart into user cart on login', async () => {
    const user = await userModel.create({ email: `test-${v4()}@mail.com` });
    const token = authService.issueTokensFor(user).accessToken.token;
    
    const prodGuest = v4();
    const prodUser = v4();

    // Add item to user cart directly via repo
    await carts.setLine(CartIdentity.userCartId(user.id), prodUser, 1);

    // Create guest cart
    const putGuestRes = await request(app.getHttpServer())
      .put(`/api/cart/items/${prodGuest}`)
      .send({ quantity: 3 })
      .expect(200);
      
    const setCookie = putGuestRes.headers['set-cookie'] as unknown as string[] | undefined;
    const cookies = (setCookie ?? []).map((c) => c.split(';')[0]).join('; ');

    // Merge carts
    const mergeRes = await request(app.getHttpServer())
      .post('/api/cart/merge')
      .set('Authorization', `Bearer ${token}`)
      .set('Cookie', cookies)
      .expect(201);

    expect(mergeRes.body.lines).toHaveLength(2);
    expect(mergeRes.body.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: prodGuest, quantity: 3 }),
        expect.objectContaining({ productId: prodUser, quantity: 1 }),
      ])
    );
  });
});
