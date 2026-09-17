import http from 'node:http';

const tradingBase = process.env.TRADING212_ENVIRONMENT === 'demo'
  ? 'https://demo.trading212.com/api/v0'
  : 'https://live.trading212.com/api/v0';
const wealthfolioBase = (process.env.WEALTHFOLIO_URL || 'http://localhost:8088').replace(/\/$/, '');
const accountId = process.env.WEALTHFOLIO_ACCOUNT_ID;
const apiKey = process.env.TRADING212_API_KEY;
const apiSecret = process.env.TRADING212_API_SECRET;
const intervalMs = Number(process.env.SYNC_INTERVAL_MS || 24 * 60 * 60 * 1000);
const runOnStart = process.env.SYNC_ON_START !== 'false';
const port = Number(process.env.HEALTH_PORT || 8787);
const batchSize = 250;
let running = false;
let lastRun = null;
let lastError = null;

function required(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function providerSymbol(ticker) {
  let symbol = ticker.replace(/_[A-Z]{2,3}_EQ$/, '').replace(/_EQ$/, '');
  symbol = symbol.replace(/^([A-Z]{2,8})[a-z]$/, '$1');
  return symbol.replace(/_/g, '.');
}

function instant(value) {
  return value ? new Date(value).toISOString() : new Date(0).toISOString();
}

function amount(value) {
  return Math.abs(Number(value || 0)).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

async function requestJson(url, options = {}, label = url) {
  const timeout = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
    if (response.status === 429 || response.status >= 500) {
      if (attempt === 4) throw new Error(`${label} returned HTTP ${response.status}`);
      const retryAfter = Number(response.headers.get('retry-after'));
      await new Promise((resolve) => setTimeout(resolve, retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 2000));
      continue;
    }
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${label} returned HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    return response.json();
  }
  throw new Error(`${label} failed after retries`);
}

function tradingHeaders() {
  required('TRADING212_API_KEY', apiKey);
  required('TRADING212_API_SECRET', apiSecret);
  return { authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}` };
}

async function allPages(path) {
  const result = [];
  let next = path;
  const seen = new Set();
  while (next) {
    if (seen.has(next)) throw new Error(`Trading 212 pagination loop detected at ${next}`);
    seen.add(next);
    const page = await requestJson(next.startsWith('http') ? next : `${tradingBase}${next}`, { headers: tradingHeaders() }, `Trading 212 ${path}`);
    result.push(...(page.items || []));
    next = page.nextPagePath || null;
  }
  return result;
}

async function fetchTrading212() {
  const headers = tradingHeaders();
  const summary = await requestJson(`${tradingBase}/equity/account/summary`, { headers }, 'Trading 212 account summary');
  const [positions, orders, dividends, transactions] = await Promise.all([
    allPages('/equity/positions'),
    allPages('/equity/history/orders?limit=50'),
    allPages('/equity/history/dividends?limit=50'),
    allPages('/equity/history/transactions?limit=50'),
  ]);
  return { summary, positions, orders, dividends, transactions };
}

function toActivityImports(data) {
  required('WEALTHFOLIO_ACCOUNT_ID', accountId);
  const rows = [];
  for (const order of data.orders) {
    if (!order.dateExecuted || !order.ticker || !order.filledQuantity) continue;
    const sell = String(order.side ?? order.type).toUpperCase().includes('SELL');
    rows.push({ accountId, activityType: sell ? 'SELL' : 'BUY', date: instant(order.dateExecuted), amount: amount(order.totalCost ?? order.filledValue ?? (order.filledQuantity * (order.averagePrice ?? order.fillPrice ?? 0))), currency: order.currency ?? data.summary.currency, symbol: order.ticker, providerSymbol: providerSymbol(order.ticker), symbolName: order.instrument?.name ?? order.instrument?.shortName, quantity: Math.abs(order.filledQuantity), unitPrice: order.averagePrice ?? order.fillPrice, comment: `Trading 212 order ${order.id}`, isValid: true, isDraft: false });
  }
  for (const dividend of data.dividends) rows.push({ accountId, activityType: 'DIVIDEND', date: instant(dividend.paidOn), amount: amount(dividend.amount), currency: dividend.currency, symbol: dividend.ticker, providerSymbol: providerSymbol(dividend.ticker), symbolName: dividend.instrument?.name ?? dividend.instrument?.shortName, comment: dividend.reference ?? `Trading 212 dividend ${dividend.id}`, isValid: true, isDraft: false });
  for (const tx of data.transactions) {
    const type = String(tx.type ?? '').toUpperCase();
    const activityType = type.includes('DEPOSIT') ? 'DEPOSIT' : type.includes('WITHDRAW') ? 'WITHDRAWAL' : type.includes('FEE') ? 'FEE' : type.includes('INTEREST') ? 'INTEREST' : type.includes('TRANSFER') ? (tx.amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL') : undefined;
    if (activityType) rows.push({ accountId, activityType, date: instant(tx.dateTime ?? tx.date), amount: amount(tx.amount), currency: tx.currency, symbol: '', comment: tx.reference ?? `Trading 212 ${tx.type ?? 'cash transaction'} ${tx.id}`, isValid: true, isDraft: false });
  }
  return rows;
}

function wealthfolioHeaders() {
  const headers = { 'content-type': 'application/json' };
  if (process.env.WEALTHFOLIO_AUTH_TOKEN) headers.authorization = `Bearer ${process.env.WEALTHFOLIO_AUTH_TOKEN}`;
  return headers;
}

async function importRows(rows) {
  let imported = 0; let duplicates = 0; let skipped = 0;
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    const checked = await requestJson(`${wealthfolioBase}/api/v1/activities/import/check`, { method: 'POST', headers: wealthfolioHeaders(), body: JSON.stringify({ activities: batch }) }, 'Wealthfolio import check');
    const importable = checked.filter((row) => !row.duplicateOfId && row.duplicateOfLineNumber === undefined && row.isValid);
    duplicates += checked.length - importable.length;
    skipped += checked.filter((row) => !row.duplicateOfId && row.duplicateOfLineNumber === undefined && !row.isValid).length;
    if (!importable.length) continue;
    const result = await requestJson(`${wealthfolioBase}/api/v1/activities/import`, { method: 'POST', headers: wealthfolioHeaders(), body: JSON.stringify({ activities: importable }) }, 'Wealthfolio import');
    imported += result.summary?.imported || 0;
    duplicates += result.summary?.duplicates || 0;
    skipped += result.summary?.skipped || 0;
  }
  return { imported, duplicates, skipped };
}

export async function runSync() {
  if (running) return { status: 'already-running' };
  running = true; lastError = null;
  const startedAt = new Date().toISOString();
  try {
    const data = await fetchTrading212();
    const result = await importRows(toActivityImports(data));
    lastRun = { startedAt, finishedAt: new Date().toISOString(), positions: data.positions.length, activities: result };
    console.log(JSON.stringify({ event: 'sync-complete', ...lastRun }));
    return lastRun;
  } catch (error) {
    lastError = { startedAt, finishedAt: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) };
    console.error(JSON.stringify({ event: 'sync-failed', ...lastError }));
    throw error;
  } finally { running = false; }
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(lastError ? 503 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: !lastError, running, lastRun, lastError }));
    return;
  }
  response.writeHead(404); response.end('Not found');
});
server.listen(port, '0.0.0.0', () => console.log(`Trading 212 sync worker health: http://localhost:${port}/health`));
setInterval(() => void runSync().catch(() => {}), intervalMs);
if (runOnStart) void runSync().catch(() => {});
