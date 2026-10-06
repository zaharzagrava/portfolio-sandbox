import { Test, TestingModule } from '@nestjs/testing';
import { FlashStockService } from './flash-stock.service';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { allocateEvenly } from '@app/common/money/allocate';

jest.mock('@app/common/money/allocate', () => ({
  allocateEvenly: jest.fn(),
}));

describe('FlashStockService', () => {
  let service: FlashStockService;
  let redisService: jest.Mocked<RedisService>;
  let redisClient: any;

  beforeEach(async () => {
    redisClient = {
      set: jest.fn(),
      mget: jest.fn(),
      del: jest.fn(),
      eval: jest.fn(),
      incrby: jest.fn(),
      decrby: jest.fn(),
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlashStockService,
        {
          provide: RedisService,
          useValue: {
            client: redisClient,
          },
        },
      ],
    }).compile();

    service = module.get<FlashStockService>(FlashStockService);
    redisService = module.get(RedisService);
    (allocateEvenly as jest.Mock).mockReturnValue([5, 5]); // Mock 10 units in 2 buckets
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('load', () => {
    it('should split stock into buckets and set an active marker', async () => {
      const sale = {
        saleId: 'sale-1',
        productId: 'prod-1',
        price: 100,
        buckets: 2,
        perUserLimit: 2,
        units: 10,
        endsAt: new Date(Date.now() + 100000).toISOString(),
      };

      await service.load(sale);

      expect(allocateEvenly).toHaveBeenCalledWith(10, 2);
      expect(redisClient.set).toHaveBeenCalledTimes(3); // 2 buckets + 1 active marker
      expect(redisClient.set).toHaveBeenCalledWith('flash:{sale-1:0}:stock', 5, 'PX', expect.any(Number));
      expect(redisClient.set).toHaveBeenCalledWith('flash:{sale-1:1}:stock', 5, 'PX', expect.any(Number));
      expect(redisClient.set).toHaveBeenCalledWith('flash:active:prod-1', expect.any(String), 'PX', expect.any(Number));
    });
  });

  describe('reserve', () => {
    it('should iterate through buckets until it finds stock', async () => {
      // Mock eval to return -1 (no stock) on the first call, and 3 on the second
      redisClient.eval.mockResolvedValueOnce(-1).mockResolvedValueOnce(3);

      const bucket = await service.reserve('sale-1', 2, 2);

      expect(bucket).not.toBeNull();
      expect(redisClient.eval).toHaveBeenCalledTimes(2);
    });

    it('should return null if all buckets are empty', async () => {
      redisClient.eval.mockResolvedValue(-1);

      const bucket = await service.reserve('sale-1', 2, 2);

      expect(bucket).toBeNull();
      expect(redisClient.eval).toHaveBeenCalledTimes(2);
    });
  });

  describe('claimUserQuota', () => {
    it('should return true if under limit', async () => {
      redisClient.eval.mockResolvedValue(2); // Mock returning current count <= limit

      const ok = await service.claimUserQuota('sale-1', 'user-1', 1, 2);

      expect(ok).toBe(true);
      expect(redisClient.eval).toHaveBeenCalledWith(expect.any(String), 1, 'flash:{sale-1}:user:user-1', 1, 2, 7 * 86400000);
    });

    it('should return false if over limit', async () => {
      redisClient.eval.mockResolvedValue(-1); // Mock lua script returning -1 when over limit

      const ok = await service.claimUserQuota('sale-1', 'user-1', 3, 2);

      expect(ok).toBe(false);
    });
  });

  describe('remaining', () => {
    it('should sum up values from all buckets', async () => {
      redisClient.get.mockResolvedValueOnce('5').mockResolvedValueOnce('3');

      const total = await service.remaining('sale-1', 2);

      expect(total).toBe(8);
      expect(redisClient.get).toHaveBeenCalledTimes(2);
      expect(redisClient.get).toHaveBeenCalledWith('flash:{sale-1:0}:stock');
      expect(redisClient.get).toHaveBeenCalledWith('flash:{sale-1:1}:stock');
    });

    it('should ignore negative values', async () => {
      redisClient.get.mockResolvedValueOnce('-2').mockResolvedValueOnce('3');

      const total = await service.remaining('sale-1', 2);

      expect(total).toBe(3);
    });
  });
});
