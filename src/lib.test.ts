import { describe, expect, it, vi } from 'vitest';
import type { HostAPI, NetworkRequest } from '@wealthfolio/addon-sdk';
import { fetchTrading212, importWithDuplicateDetection, toActivityImports, type Summary } from './lib';

function network(responses: Record<string, unknown>[]) {
  let index = 0;
  return { request: vi.fn(async (_request: NetworkRequest) => ({ status: 200, headers: {}, body: JSON.stringify(responses[index++]) })) };
}

const summary: Summary = { id: 123, currency: 'EUR', cash: { availableToTrade: 10 } };

describe('Trading 212 client and importer', () => {
  it('follows nextPagePath for historical endpoints', async () => {
    const requests: NetworkRequest[] = [];
    const net = { request: vi.fn(async (request: NetworkRequest) => {
      requests.push(request);
      const body = request.url.includes('summary') ? { id: 123, currency: 'EUR' } : request.url.includes('orders') && !request.url.includes('cursor=1') ? { items: [{ id: 1, ticker: 'AAPL_US_EQ', filledQuantity: 1, averagePrice: 100, dateExecuted: '2026-01-01T10:00:00Z', type: 'MARKET' }], nextPagePath: '/api/v0/equity/history/orders?cursor=1' } : request.url.includes('cursor=1') ? { items: [{ id: 2, ticker: 'MSFT_US_EQ', filledQuantity: 2, averagePrice: 50, dateExecuted: '2026-01-02T10:00:00Z', type: 'MARKET' }], nextPagePath: null } : { items: [], nextPagePath: null };
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    }) };
    const data = await fetchTrading212(net as never, 'demo');
    expect(data.summary.id).toBe(123);
    expect(data.orders).toHaveLength(2);
    expect(requests).toHaveLength(5);
    expect(requests.some((request) => request.url.includes('/api/v0/equity/history/dividends'))).toBe(true);
  });

  it('maps executed orders, dividends and cash movements to activities', () => {
    const rows = toActivityImports({ summary, orders: [{ id: 1, ticker: 'AAPL_US_EQ', filledQuantity: 2, averagePrice: 10, dateExecuted: '2026-01-01T10:00:00Z', type: 'MARKET' }], dividends: [{ id: 2, ticker: 'AAPL_US_EQ', amount: 1.25, currency: 'EUR', paidOn: '2026-01-02T10:00:00Z' }], transactions: [{ id: 3, type: 'DEPOSIT', amount: 100, currency: 'EUR', date: '2026-01-03T10:00:00Z' }] }, 'wf-account');
    expect(rows.map((row) => row.activityType)).toEqual(['BUY', 'DIVIDEND', 'DEPOSIT']);
    expect(rows[0]).toMatchObject({ accountId: 'wf-account', symbol: 'AAPL_US_EQ', quantity: 2, amount: '20' });
  });

  it('imports only valid, non-duplicate rows after checkImport', async () => {
    const api = { activities: { checkImport: vi.fn(async (rows: any[]) => [{ ...rows[0], isValid: true }, { ...rows[1], duplicateOfId: 'existing', isValid: true }, { ...rows[2], isValid: false }]), import: vi.fn(async () => ({ summary: { imported: 1, duplicates: 0, skipped: 0 } })) } } as unknown as HostAPI;
    const result = await importWithDuplicateDetection(api, [{ accountId: 'a', activityType: 'DEPOSIT', date: '2026-01-01T00:00:00Z', amount: '1', currency: 'EUR', symbol: '', isValid: true, isDraft: false }, { accountId: 'a', activityType: 'DEPOSIT', date: '2026-01-02T00:00:00Z', amount: '2', currency: 'EUR', symbol: '', isValid: true, isDraft: false }, { accountId: 'a', activityType: 'DEPOSIT', date: '2026-01-03T00:00:00Z', amount: '3', currency: 'EUR', symbol: '', isValid: true, isDraft: false }]);
    expect(api.activities.import).toHaveBeenCalledTimes(1);
    expect((api.activities.import as any).mock.calls[0][0]).toHaveLength(1);
    expect(result).toMatchObject({ imported: 1, duplicates: 1 });
  });
});
