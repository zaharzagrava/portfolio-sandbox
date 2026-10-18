import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { RateLimitInterceptor } from './rate-limit.interceptor';

/** Two applications of one process (the local monolith) each install the global interceptor. */
describe('RateLimitInterceptor in a process hosting several applications', () => {
  const build = () => {
    const reflector = {
      getAllAndOverride: jest
        .fn()
        .mockReturnValue([{ policy: 'auth.login.ip' }]),
    };
    const interceptor = new RateLimitInterceptor(
      reflector as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { applyDefault: true },
    );
    const internals = interceptor as unknown as {
      admit: jest.Mock;
      run: jest.Mock;
    };
    internals.admit = jest.fn().mockResolvedValue({ taken: [] });
    internals.run = jest.fn().mockReturnValue(of('handled'));
    return { interceptor, internals };
  };

  const contextOf = (req: object): ExecutionContext =>
    ({
      getType: () => 'http',
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({}),
      }),
    }) as unknown as ExecutionContext;

  const next: CallHandler = { handle: () => of('passed through') };

  it('charges a request once, however many interceptors see it', async () => {
    const first = build();
    const second = build();
    const req = { method: 'POST', headers: {} };

    await firstValueFrom(first.interceptor.intercept(contextOf(req), next));
    const result = await firstValueFrom(
      second.interceptor.intercept(contextOf(req), next),
    );

    expect(first.internals.admit).toHaveBeenCalledTimes(1);
    expect(second.internals.admit).not.toHaveBeenCalled();
    expect(result).toBe('passed through');
  });

  it('still charges every distinct request', async () => {
    const { interceptor, internals } = build();
    await firstValueFrom(
      interceptor.intercept(contextOf({ method: 'POST', headers: {} }), next),
    );
    await firstValueFrom(
      interceptor.intercept(contextOf({ method: 'POST', headers: {} }), next),
    );
    expect(internals.admit).toHaveBeenCalledTimes(2);
  });

  describe('local-profile allow-list (J02 S50)', () => {
    const buildWith = (allowIps: string[]) => {
      const reflector = {
        getAllAndOverride: jest
          .fn()
          .mockReturnValue([{ policy: 'auth.register.ip' }]),
      };
      const interceptor = new RateLimitInterceptor(
        reflector as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { applyDefault: true },
        { allowIps } as never,
      );
      const internals = interceptor as unknown as {
        admit: jest.Mock;
        run: jest.Mock;
      };
      internals.admit = jest.fn().mockResolvedValue({ taken: [] });
      internals.run = jest.fn().mockReturnValue(of('handled'));
      return { interceptor, internals };
    };

    it('S50 G-01: an allow-listed address is not charged by any policy', async () => {
      const { interceptor, internals } = buildWith(['203.0.113.7']);
      const result = await firstValueFrom(
        interceptor.intercept(
          contextOf({ method: 'POST', headers: {}, clientIp: '203.0.113.7' }),
          next,
        ),
      );
      expect(result).toBe('passed through');
      expect(internals.admit).not.toHaveBeenCalled();
    });

    it('S50 G-01: any other address is still limited', async () => {
      const { interceptor, internals } = buildWith(['203.0.113.7']);
      await firstValueFrom(
        interceptor.intercept(
          contextOf({ method: 'POST', headers: {}, clientIp: '198.51.100.1' }),
          next,
        ),
      );
      expect(internals.admit).toHaveBeenCalledTimes(1);
    });
  });
});
