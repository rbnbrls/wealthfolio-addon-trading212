import type { ActivityImport, HostAPI, NetworkAPI } from '@wealthfolio/addon-sdk';

export const ADDON_ID = 'wealthfolio-addon-trading212';
export const SECRET_KEY = `${ADDON_ID}.credentials`;
const CONFIG_KEY = `${ADDON_ID}.config`;
export type Environment = 'live' | 'demo';
export type SyncFrequency = 'manual' | '15m' | 'hourly' | 'daily';
export type HistoryEndpoint = 'orders' | 'dividends' | 'transactions';
export type SyncCursors = Partial<Record<HistoryEndpoint, string>>;
export type SyncHistoryBefore = Partial<Record<HistoryEndpoint, string>>;
export type Config = { environment: Environment; accountId: string; brokerAccountId?: string; currency?: string; lastSync?: string; cursor?: string; syncCursors?: SyncCursors; syncHistoryBefore?: SyncHistoryBefore; syncFrequency?: SyncFrequency };

export async function readConfig(api: HostAPI): Promise<Config> {
  const raw = await api.storage.get(CONFIG_KEY);
  return raw ? JSON.parse(raw) as Config : { environment: 'live', accountId: '' };
}
export async function saveConfig(api: HostAPI, config: Config) { await api.storage.set(CONFIG_KEY, JSON.stringify(config)); }

type Page<T> = { items?: T[]; nextPagePath?: string | null };
export type FetchProgress = { endpoint: string; page: number; items: number; total: number };
export type Summary = { id: number; currency: string; cash?: { availableToTrade?: number; inPies?: number; reservedForOrders?: number }; totalValue?: number };
export type TOrder = { id: number; ticker: string; quantity?: number; filledQuantity?: number; fillPrice?: number; averagePrice?: number; dateCreated?: string; dateExecuted?: string; type?: string; side?: string; status?: string; currency?: string; totalCost?: number; filledValue?: number; instrument?: { name?: string; shortName?: string } };
export type TDividend = { id: number; ticker: string; amount: number; currency: string; paidOn?: string; reference?: string; instrument?: { name?: string; shortName?: string } };
export type TTransaction = { id: number; type?: string; amount: number; currency: string; date?: string; dateTime?: string; reference?: string; ticker?: string };
export type TPosition = { ticker: string; quantity: number; averagePricePaid?: number; currentPrice?: number; currency?: string; instrument?: { ticker?: string; name?: string; currency?: string; }; };

/** Convert a Trading 212 venue-specific code to a provider-friendly hint. */
export function providerSymbol(ticker: string): string {
  let symbol = ticker.replace(/_[A-Z]{2,3}_EQ$/, '').replace(/_EQ$/, '');
  symbol = symbol.replace(/^([A-Z]{2,8})[a-z]$/, '$1');
  return symbol.replace(/_/g, '.');
}

async function requestJson<T>(net: NetworkAPI, base: string, path: string): Promise<T> {
  const baseUrl = new URL(base);
  const url = path.startsWith('http') ? path : path.startsWith('/api/v0/') ? `${baseUrl.origin}${path}` : `${base}${path}`;
  // The host broker can take several seconds to recover from an upstream
  // connection reset. Keep retrying the same cursor so one transient failure
  // does not discard an otherwise complete full-history sync.
  const maxAttempts = 15;
  let response: Awaited<ReturnType<NetworkAPI['request']>> | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      response = await net.request({ url, method: 'GET', auth: { type: 'basic', secretKey: SECRET_KEY } });
    } catch (error) {
      if (attempt === maxAttempts - 1) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Trading 212 request failed for ${path}: ${detail}`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, 250 * 2 ** attempt)));
      continue;
    }
    if (response.status !== 429 || attempt === maxAttempts - 1) break;
    const retryAfter = Number(response.headers?.['retry-after'] ?? response.headers?.['Retry-After']);
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  if (!response) throw new Error(`Trading 212 request failed for ${path}: no response`);
  if (response.status !== 200) throw new Error(`Trading 212 returned HTTP ${response.status} for ${path}`);
  try { return JSON.parse(response.body) as T; } catch { throw new Error('Trading 212 returned invalid JSON'); }
}
async function allPages<T>(net: NetworkAPI, base: string, path: string, onPage?: (progress: FetchProgress) => void): Promise<T[]> {
  const items: T[] = []; let next: string | null | undefined = path; const seen = new Set<string>();
  let pageNumber = 0;
  while (next) {
    if (seen.has(next)) throw new Error(`Trading 212 pagination loop detected for ${next}`);
    seen.add(next);
    pageNumber += 1;
    const page: Page<T> = await requestJson<Page<T>>(net, base, next); const pageItems = page.items ?? [];
    items.push(...pageItems);
    onPage?.({ endpoint: path.split('?')[0], page: pageNumber, items: pageItems.length, total: items.length });
    next = page.nextPagePath;
  }
  return items;
}
export async function fetchTrading212(net: NetworkAPI, env: Environment, onProgress?: (progress: FetchProgress) => void) {
  const base = env === 'demo' ? 'https://demo.trading212.com/api/v0' : 'https://live.trading212.com/api/v0';
  const summary = await fetchAccountSummary(net, env);
  onProgress?.({ endpoint: '/equity/account/summary', page: 1, items: 1, total: 1 });
  const positions = await allPages<TPosition>(net, base, '/equity/positions', onProgress);
  const orders = await allPages<TOrder>(net, base, '/equity/history/orders?limit=50', onProgress);
  // Trading 212's historical-events API is under /equity/history. Keeping
  // the full API path here also makes cursor links returned by the API safe
  // to resolve without accidentally duplicating /api/v0.
  const dividends = await allPages<TDividend>(net, base, '/equity/history/dividends?limit=50', onProgress);
  // Some live accounts return HTTP 400 for the documented `time` query
  // parameter. Fetch cursor pages consistently and apply the date range
  // locally, preserving the same result without account-specific failures.
  const transactionsPath = '/equity/history/transactions?limit=50';
  const transactions = await allPages<TTransaction>(net, base, transactionsPath, onProgress);
  return { summary, positions, orders, dividends, transactions };
}

type IncrementalData = { summary: Summary; positions: TPosition[]; orders: TOrder[]; dividends: TDividend[]; transactions: TTransaction[] };
export type IncrementalSync = { data: IncrementalData; nextCursors: SyncCursors; nextHistoryBefore: SyncHistoryBefore; historyComplete: boolean };

const endpointPaths: Record<HistoryEndpoint, string> = {
  orders: '/equity/history/orders?limit=50',
  dividends: '/equity/history/dividends?limit=50',
  transactions: '/equity/history/transactions?limit=50',
};
const itemDate = (endpoint: HistoryEndpoint, item: TOrder | TDividend | TTransaction) => {
  if (endpoint === 'orders') return (item as TOrder).dateExecuted ?? (item as TOrder).dateCreated;
  if (endpoint === 'dividends') return (item as TDividend).paidOn;
  return (item as TTransaction).dateTime ?? (item as TTransaction).date;
};
const monthBefore = (value: string) => { const date = new Date(value); date.setUTCMonth(date.getUTCMonth() - 1); return date.toISOString(); };

async function fetchHistoryRange<T extends TOrder | TDividend | TTransaction>(net: NetworkAPI, base: string, endpoint: HistoryEndpoint, from: string | undefined, to: string, cursor: string | undefined, onProgress?: (progress: FetchProgress) => void): Promise<{ items: T[]; nextCursor?: string; reachedBoundary: boolean }> {
  const items: T[] = []; let next: string | null | undefined = cursor || endpointPaths[endpoint]; const seen = new Set<string>(); let pageNumber = 0; let reachedBoundary = false;
  while (next) {
    if (seen.has(next)) throw new Error(`Trading 212 pagination loop detected for ${next}`);
    seen.add(next); pageNumber += 1;
    const page: Page<T> = await requestJson<Page<T>>(net, base, next); const pageItems = page.items ?? [];
    items.push(...pageItems.filter((item) => { const date = itemDate(endpoint, item); return date && (!from || date > from) && date <= to; }));
    onProgress?.({ endpoint: `/equity/history/${endpoint}`, page: pageNumber, items: pageItems.length, total: items.length });
    const dates = pageItems.map((item) => itemDate(endpoint, item)).filter(Boolean).map((date) => new Date(date!).getTime());
    reachedBoundary = !from || dates.some((date) => date <= new Date(from).getTime());
    next = page.nextPagePath;
    if (reachedBoundary) break;
  }
  return { items, nextCursor: next ?? undefined, reachedBoundary };
}

/** Fetches only the recent delta plus one month of older history per run. */
export async function fetchTrading212Incremental(net: NetworkAPI, env: Environment, lastSync?: string, cursors: SyncCursors = {}, historyBefore: SyncHistoryBefore = {}, onProgress?: (progress: FetchProgress) => void): Promise<IncrementalSync> {
  const base = env === 'demo' ? 'https://demo.trading212.com/api/v0' : 'https://live.trading212.com/api/v0';
  const summary = await fetchAccountSummary(net, env); onProgress?.({ endpoint: '/equity/account/summary', page: 1, items: 1, total: 1 });
  const positions = await allPages<TPosition>(net, base, '/equity/positions', onProgress);
  const now = new Date().toISOString();
  const data: IncrementalData = { summary, positions, orders: [], dividends: [], transactions: [] };
  const nextCursors: SyncCursors = { ...cursors }; const nextHistoryBefore: SyncHistoryBefore = { ...historyBefore };
  let historyComplete = true;
  for (const endpoint of ['orders', 'dividends', 'transactions'] as HistoryEndpoint[]) {
    if (lastSync) {
      const delta = await fetchHistoryRange(net, base, endpoint, lastSync, now, undefined, onProgress);
      data[endpoint] = delta.items as never;
    }
    const before = historyBefore[endpoint] ?? lastSync ?? now; const from = monthBefore(before);
    const history = await fetchHistoryRange(net, base, endpoint, from, before, cursors[endpoint], onProgress);
    data[endpoint].push(...history.items as never[]);
    if (history.nextCursor) { nextCursors[endpoint] = history.nextCursor; nextHistoryBefore[endpoint] = from; historyComplete = false; }
    else { delete nextCursors[endpoint]; delete nextHistoryBefore[endpoint]; }
  }
  return { data, nextCursors, nextHistoryBefore, historyComplete };
}

export async function fetchAccountSummary(net: NetworkAPI, env: Environment): Promise<Summary> {
  const base = env === 'demo' ? 'https://demo.trading212.com/api/v0' : 'https://live.trading212.com/api/v0';
  return requestJson<Summary>(net, base, '/equity/account/summary');
}

const instant = (value?: string) => value ? new Date(value).toISOString() : new Date(0).toISOString();
const amount = (n: number) => Math.abs(n).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';
export function toActivityImports(data: Awaited<ReturnType<typeof fetchTrading212>>, accountId: string): ActivityImport[] {
  const rows: ActivityImport[] = [];
  for (const order of data.orders) {
    if (!order.dateExecuted || !order.ticker || !order.filledQuantity) continue;
    const isSell = String(order.side ?? order.type).toUpperCase().includes('SELL');
    rows.push({ accountId, activityType: isSell ? 'SELL' : 'BUY', date: instant(order.dateExecuted), amount: amount(order.totalCost ?? order.filledValue ?? (order.filledQuantity * (order.averagePrice ?? order.fillPrice ?? 0))), currency: order.currency ?? data.summary.currency, symbol: order.ticker, providerSymbol: providerSymbol(order.ticker), symbolName: order.instrument?.name ?? order.instrument?.shortName, quantity: Math.abs(order.filledQuantity), unitPrice: order.averagePrice ?? order.fillPrice, comment: `Trading 212 order ${order.id}`, isValid: true, isDraft: false });
  }
  for (const dividend of data.dividends) rows.push({ accountId, activityType: 'DIVIDEND', date: instant(dividend.paidOn), amount: amount(dividend.amount), currency: dividend.currency, symbol: dividend.ticker, providerSymbol: providerSymbol(dividend.ticker), symbolName: dividend.instrument?.name ?? dividend.instrument?.shortName, comment: dividend.reference ?? `Trading 212 dividend ${dividend.id}`, isValid: true, isDraft: false });
  for (const tx of data.transactions) {
    const type = String(tx.type ?? '').toUpperCase();
    const activityType = type.includes('DEPOSIT') ? 'DEPOSIT' : type.includes('WITHDRAW') ? 'WITHDRAWAL' : type.includes('FEE') ? 'FEE' : type.includes('INTEREST') ? 'INTEREST' : type.includes('TRANSFER') ? (tx.amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL') : undefined;
    if (activityType) rows.push({ accountId, activityType, date: instant(tx.dateTime ?? tx.date), amount: amount(tx.amount), currency: tx.currency, symbol: '', comment: tx.reference ?? `Trading 212 ${tx.type ?? 'cash transaction'} ${tx.id}`, isValid: true, isDraft: false });
  }
  return rows;
}

export async function importWithDuplicateDetection(api: HostAPI, rows: ActivityImport[]) {
  if (!rows.length) return { imported: 0, duplicates: 0, skipped: 0 };
  const checked = await api.activities.checkImport(rows);
  const duplicates = checked.filter((r) => r.duplicateOfId || r.duplicateOfLineNumber !== undefined).length;
  const importable = checked.filter((r) => !r.duplicateOfId && r.duplicateOfLineNumber === undefined && r.isValid);
  if (!importable.length) return { imported: 0, duplicates, skipped: checked.length - duplicates };
  const result = await api.activities.import(importable);
  return { imported: result.summary.imported, duplicates: duplicates + result.summary.duplicates, skipped: result.summary.skipped };
}
