import { describe, expect, it, vi } from 'vitest';
import type { HostAPI, NetworkRequest } from '@wealthfolio/addon-sdk';
import { fetchAccountSummary, fetchTrading212, fetchTrading212Incremental, importWithDuplicateDetection, providerSymbol, toActivityImports, type Summary } from './trading212';

function network(responses: Record<string, unknown>[]) {
  let index = 0;
  return { request: vi.fn(async (_request: NetworkRequest) => ({ status: 200, headers: {}, body: JSON.stringify(responses[index++]) })) };
}

const summary: Summary = { id: 123, currency: 'EUR', cash: { availableToTrade: 10 } };

describe('Trading 212 client and importer', () => {
  it('retries transient network failures with a useful endpoint in the final error', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ status: 200, headers: {}, body: JSON.stringify(summary) });
    await expect(fetchAccountSummary({ request } as never, 'live')).resolves.toEqual(summary);
    expect(request).toHaveBeenCalledTimes(2);
    await expect(fetchAccountSummary({ request: vi.fn().mockRejectedValue(new Error('offline')) } as never, 'live')).rejects.toThrow('/equity/account/summary');
  }, 40000);

  it('converts Trading 212 tickers to provider hints without losing the source symbol', () => {
    expect(providerSymbol('ASMLa_EQ')).toBe('ASML');
    expect(providerSymbol('AAPL_US_EQ')).toBe('AAPL');
    expect(providerSymbol('BRK_B_US_EQ')).toBe('BRK.B');
  });

  it('follows nextPagePath for historical endpoints', async () => {
    const requests: NetworkRequest[] = [];
    const net = { request: vi.fn(async (request: NetworkRequest) => {
      requests.push(request);
      const body = request.url.includes('summary') ? { id: 123, currency: 'EUR' } : request.url.includes('/equity/positions') ? { items: [] } : request.url.includes('orders') && !request.url.includes('cursor=1') ? { items: [{ id: 1, ticker: 'AAPL_US_EQ', filledQuantity: 1, averagePrice: 100, dateExecuted: '2026-01-01T10:00:00Z', type: 'MARKET' }], nextPagePath: '/api/v0/equity/history/orders?cursor=1' } : request.url.includes('cursor=1') ? { items: [{ id: 2, ticker: 'MSFT_US_EQ', filledQuantity: 2, averagePrice: 50, dateExecuted: '2026-01-02T10:00:00Z', type: 'MARKET' }], nextPagePath: null } : { items: [], nextPagePath: null };
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    }) };
    const data = await fetchTrading212(net as never, 'demo');
    expect(data.summary.id).toBe(123);
    expect(data.orders).toHaveLength(2);
    expect(requests).toHaveLength(6);
    expect(requests.some((request) => request.url.includes('/api/v0/equity/history/dividends'))).toBe(true);
    expect(requests.some((request) => request.url.includes('/api/v0/equity/history/transactions'))).toBe(true);
    expect(requests.some((request) => request.url.includes('/api/v0/api/v0/'))).toBe(false);
  });

  it('reports each fetched page for sync progress feedback', async () => {
    const progress: string[] = [];
    const net = { request: vi.fn(async (request: NetworkRequest) => {
      const body = request.url.includes('summary') ? { id: 123, currency: 'EUR' } : { items: [], nextPagePath: null };
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    }) };
    await fetchTrading212(net as never, 'demo', (update) => progress.push(`${update.endpoint}:${update.page}:${update.total}`));
    expect(progress).toEqual([
      '/equity/account/summary:1:1',
      '/equity/positions:1:0',
      '/equity/history/orders:1:0',
      '/equity/history/dividends:1:0',
      '/equity/history/transactions:1:0',
    ]);
  });

  it('fetches a recent delta and one bounded history month, preserving cursors', async () => {
    const requests: NetworkRequest[] = [];
    const net = { request: vi.fn(async (request: NetworkRequest) => {
      requests.push(request);
      const url = request.url;
      const body = url.includes('summary') ? summary
        : url.includes('/equity/positions') ? { items: [] }
          : url.includes('cursor=history') ? { items: [{ id: 9, ticker: 'OLD_US_EQ', filledQuantity: 1, averagePrice: 5, dateExecuted: '2025-12-15T00:00:00Z' }], nextPagePath: '/api/v0/equity/history/orders?cursor=older' }
            : url.includes('cursor=older') ? { items: [{ id: 7, ticker: 'OLDER_US_EQ', filledQuantity: 1, averagePrice: 5, dateExecuted: '2025-11-15T00:00:00Z' }], nextPagePath: '/api/v0/equity/history/orders?cursor=oldest' }
            : url.includes('orders') ? { items: [{ id: 8, ticker: 'NEW_US_EQ', filledQuantity: 1, averagePrice: 10, dateExecuted: '2026-01-15T00:00:00Z' }], nextPagePath: null }
              : { items: [], nextPagePath: null };
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    }) };
    const result = await fetchTrading212Incremental(net as never, 'demo', '2026-01-01T00:00:00Z', { orders: '/api/v0/equity/history/orders?cursor=history' }, { orders: '2026-01-01T00:00:00Z' });
    expect(result.data.orders.map((order) => order.id)).toEqual([8, 9]);
    expect(result.nextCursors.orders).toBe('/api/v0/equity/history/orders?cursor=oldest');
    expect(result.nextHistoryBefore.orders).toBe('2025-12-01T00:00:00.000Z');
    expect(requests.some((request) => request.url.includes('cursor=history'))).toBe(true);
  });

  it('maps executed orders, dividends and cash movements to activities', () => {
    const rows = toActivityImports({ summary, positions: [], orders: [{ id: 1, ticker: 'AAPL_US_EQ', filledQuantity: 2, averagePrice: 10, dateExecuted: '2026-01-01T10:00:00Z', type: 'MARKET' }], dividends: [{ id: 2, ticker: 'AAPL_US_EQ', amount: 1.25, currency: 'EUR', paidOn: '2026-01-02T10:00:00Z' }], transactions: [{ id: 3, type: 'DEPOSIT', amount: 100, currency: 'EUR', date: '2026-01-03T10:00:00Z' }] }, 'wf-account');
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
