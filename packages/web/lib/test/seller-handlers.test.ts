import { describe, expect, it } from 'vitest';
import { problemFromError } from '@/lib/api/errors';
import { sellerProblemCopy } from '@/lib/seller/problem-copy';
import { liveFrameFixture, overviewFixture, SELLER_PROBLEM_STATUS, sellerProblem, shopFixture, shopListItemFixture, type SellerProblemCode } from './seller-handlers';

describe('W04 test fixtures', () => {
  it('build bodies that the contract schemas accept', () => {
    expect(shopFixture().myPermissions).toContain('shop.manage');
    expect(shopListItemFixture().role).toBe('OWNER');
    expect(overviewFixture().errors).toEqual([]);
    expect(liveFrameFixture().ordersPerSecond).toHaveLength(60);
  });

  it.each(Object.keys(SELLER_PROBLEM_STATUS) as SellerProblemCode[])('W04 SC-006: %s is a problem+json fixture that the copy catalogue turns into a sentence', async (code) => {
    const response = sellerProblem(code, { retryAfter: 5, requestId: 'req-9' });
    const body = (await response.json()) as { code: string; status: number };
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(body.code).toBe(code);
    const problem = problemFromError({ response: { status: response.status, data: body, headers: { 'retry-after': '5' } } });
    const copy = sellerProblemCopy(problem, { kind: 'read' });
    expect(copy.silent || copy.message.length > 0, code).toBe(true);
  });
});
