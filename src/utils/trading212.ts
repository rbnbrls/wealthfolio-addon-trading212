import type { ActivityImport, HostAPI, NetworkAPI } from '@wealthfolio/addon-sdk';

export const ADDON_ID = 'wealthfolio-addon-trading212';
export const SECRET_KEY = `${ADDON_ID}.credentials`;
const CONFIG_KEY = `${ADDON_ID}.config`;
export type Environment = 'live' | 'demo';
export type Config = { environment: Environment; accountId: string; brokerAccountId?: string; currency?: string; lastSync?: string; cursor?: string };

export async function readConfig(api: HostAPI): Promise<Config> {
  const raw = await api.storage.get(CONFIG_KEY);
  return raw ? JSON.parse(raw) as Config : { environment: 'live', accountId: '' };
}
export async function saveConfig(api: HostAPI, config: Config) { await api.storage.set(CONFIG_KEY, JSON.stringify(config)); }

type Page<T> = { items?: T[]; nextPagePath?: string | null };
export type Summary = { id: number; currency: string; cash?: { availableToTrade?: number; inPies?: number; reservedForOrders?: number }; totalValue?: number };
export type TOrder = { id: number; ticker: string; quantity?: number; filledQuantity?: number; fillPrice?: number; averagePrice?: number; dateCreated?: string; dateExecuted?: string; type?: string; status?: string; currency?: string; totalCost?: number;};
export type TDividend = { id: number; ticker: string; amount: number; currency: string; paidOn?: string; reference?: string };
export type TTransaction = { id: number; type?: string; amount: number; currency: string; date?: string; reference?: string; ticker?: string };

async function requestJson<T>(net: NetworkAPI, base: string, path: string): Promise<T> {
  const baseUrl = new URL(base);
  const url = path.startsWith('http') ? path : path.startsWith('/api/v0/') ? `${baseUrl.origin}${path}` : `${base}${path}`;
  let response = await net.request({ url, method: 'GET', auth: { type: 'basic', secretKey: SECRET_KEY } });
  for (let attempt = 0; response.status === 429 && attempt < 3; attempt += 1) {
    const retryAfter = Number(response.headers?.['retry-after'] ?? response.headers?.['Retry-After']);
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 5000 * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    response = await net.request({ url, method: 'GET', auth: { type: 'basic', secretKey: SECRET_KEY } });
  }
  if (response.status !== 200) throw new Error(`Trading 212 returned HTTP ${response.status} for ${path}`);
  try { return JSON.parse(response.body) as T; } catch { throw new Error('Trading 212 returned invalid JSON'); }
}
async function allPages<T>(net: NetworkAPI, base: string, path: string): Promise<T[]> {
  const items: T[] = []; let next: string | null | undefined = path; let pages = 0;
  while (next && pages++ < 100) { const page: Page<T> = await requestJson<Page<T>>(net, base, next); items.push(...(page.items ?? [])); next = page.nextPagePath; }
  return items;
}
export async function fetchTrading212(net: NetworkAPI, env: Environment) {
  const base = env === 'demo' ? 'https://demo.trading212.com/api/v0' : 'https://live.trading212.com/api/v0';
  const summary = await fetchAccountSummary(net, env);
  const orders = await allPages<TOrder>(net, base, '/equity/history/orders?limit=50');
  const dividends = await allPages<TDividend>(net, base, '/history/dividends?limit=50');
  const transactions = await allPages<TTransaction>(net, base, '/history/transactions?limit=50');
  return { summary, orders, dividends, transactions };
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
    const isSell = String(order.type).toUpperCase().includes('SELL');
    rows.push({ accountId, activityType: isSell ? 'SELL' : 'BUY', date: instant(order.dateExecuted), amount: amount(order.totalCost ?? (order.filledQuantity * (order.averagePrice ?? order.fillPrice ?? 0))), currency: order.currency ?? data.summary.currency, symbol: order.ticker, quantity: Math.abs(order.filledQuantity), unitPrice: order.averagePrice ?? order.fillPrice, comment: `Trading 212 order ${order.id}`, isValid: true, isDraft: false });
  }
  for (const dividend of data.dividends) rows.push({ accountId, activityType: 'DIVIDEND', date: instant(dividend.paidOn), amount: amount(dividend.amount), currency: dividend.currency, symbol: dividend.ticker, comment: dividend.reference ?? `Trading 212 dividend ${dividend.id}`, isValid: true, isDraft: false });
  for (const tx of data.transactions) {
    const type = String(tx.type ?? '').toUpperCase();
    const activityType = type.includes('DEPOSIT') ? 'DEPOSIT' : type.includes('WITHDRAW') ? 'WITHDRAWAL' : type.includes('FEE') ? 'FEE' : type.includes('INTEREST') ? 'INTEREST' : undefined;
    if (activityType) rows.push({ accountId, activityType, date: instant(tx.date), amount: amount(tx.amount), currency: tx.currency, symbol: '', comment: tx.reference ?? `Trading 212 ${tx.type ?? 'cash transaction'} ${tx.id}`, isValid: true, isDraft: false });
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
