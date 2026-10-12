import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/chat')>();
  return { ...actual, chatApi: { byProduct: vi.fn(), join: vi.fn(), create: vi.fn() } };
});

import { chatApi } from '@/lib/api/chat';
import { openProductChat } from './chat-view';

const http = (status: number) => ({ response: { status } });
const channel = (over: object = {}) => ({ id: 'c1', productId: 'p1', title: 'Lamp', myRole: undefined, ...over }) as never;

describe('openProductChat', () => {
  beforeEach(() => vi.resetAllMocks());

  it('joins the existing chat of the product', async () => {
    vi.mocked(chatApi.byProduct).mockResolvedValue(channel());
    vi.mocked(chatApi.join).mockResolvedValue(channel({ myRole: 'MEMBER' }));
    expect((await openProductChat('p1')).myRole).toBe('MEMBER');
    expect(chatApi.create).not.toHaveBeenCalled();
  });

  it('creates the chat when the product has none yet', async () => {
    vi.mocked(chatApi.byProduct).mockRejectedValue(http(404));
    vi.mocked(chatApi.create).mockResolvedValue(channel({ myRole: 'OWNER' }));
    expect((await openProductChat('p1')).myRole).toBe('OWNER');
  });

  it('opens the chat someone else created between the lookup and the create (409), instead of failing', async () => {
    vi.mocked(chatApi.byProduct).mockRejectedValueOnce(http(404)).mockResolvedValueOnce(channel());
    vi.mocked(chatApi.create).mockRejectedValue(http(409));
    vi.mocked(chatApi.join).mockResolvedValue(channel({ myRole: 'MEMBER' }));
    expect((await openProductChat('p1')).myRole).toBe('MEMBER');
    expect(chatApi.join).toHaveBeenCalledWith('c1');
  });

  it('says so when the seller has not opened a chat for the product (403)', async () => {
    vi.mocked(chatApi.byProduct).mockRejectedValue(http(404));
    vi.mocked(chatApi.create).mockRejectedValue(http(403));
    await expect(openProductChat('p1')).rejects.toThrow('The seller has not opened a chat');
  });
});
