import { useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AddonContext, HostAPI } from '@wealthfolio/addon-sdk';
import { ADDON_ID, fetchAccountSummary, fetchTrading212Incremental, importWithDuplicateDetection, readConfig, saveConfig, SECRET_KEY, toActivityImports, type Config, type FetchProgress } from './utils/trading212';
import './style.css';

let context: AddonContext;

function ThemeSync() {
  useEffect(() => {
    const root = document.documentElement;
    const updateColorScheme = () => {
      const background = getComputedStyle(root).backgroundColor;
      const match = background.match(/rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/);
      if (!match) return;
      const [, red, green, blue] = match.map(Number);
      const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
      root.style.colorScheme = luminance < 0.5 ? 'dark' : 'light';
    };
    updateColorScheme();
    const observer = new MutationObserver(updateColorScheme);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener?.('change', updateColorScheme);
    return () => { observer.disconnect(); media.removeEventListener?.('change', updateColorScheme); root.style.removeProperty('color-scheme'); };
  }, []);
  return null;
}

function Page() { return <QueryClientProvider client={context.api.query.getClient() as QueryClient}><ThemeSync /><TradingPage api={context.api} /></QueryClientProvider>; }

type SyncStage = 'fetching' | 'importing' | 'saving' | 'complete' | 'error';
type SyncProgress = { stage: SyncStage; message: string; percent: number; startedAt: number };

const syncStages: Array<{ id: Exclude<SyncStage, 'complete' | 'error'>; label: string }> = [
  { id: 'fetching', label: 'Fetch history & positions' },
  { id: 'importing', label: 'Import activities' },
  { id: 'saving', label: 'Save sync timestamp' },
];

function SyncProgressPanel({ progress }: { progress: SyncProgress }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(() => Math.max(0, Math.floor((Date.now() - progress.startedAt) / 1000)));
  useEffect(() => { if (progress.stage !== 'fetching' && progress.stage !== 'importing' && progress.stage !== 'saving') return; const timer = window.setInterval(() => setElapsedSeconds(Math.floor((Date.now() - progress.startedAt) / 1000)), 1000); return () => window.clearInterval(timer); }, [progress.stage, progress.startedAt]);
  const isError = progress.stage === 'error';
  const isComplete = progress.stage === 'complete';
  const elapsed = `${Math.floor(elapsedSeconds / 60)}m ${String(elapsedSeconds % 60).padStart(2, '0')}s`;
  return <section className={`sync-progress ${isError ? 'is-error' : ''} ${isComplete ? 'is-complete' : ''}`} aria-live="polite" aria-label="Sync progress">
    <div className="sync-progress-heading"><strong>{isComplete ? 'Sync complete' : isError ? 'Sync failed' : 'Sync in progress'}</strong><span>{progress.percent}% · {elapsed}</span></div>
    <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent} aria-label={progress.message}><span style={{ width: `${progress.percent}%` }} /></div>
    <ol className="sync-stages">{syncStages.map((stage) => { const stageIndex = syncStages.findIndex((item) => item.id === stage.id); const currentIndex = syncStages.findIndex((item) => item.id === progress.stage); const done = isComplete || (!isError && currentIndex > stageIndex); const active = progress.stage === stage.id; return <li className={`${done ? 'done' : ''} ${active ? 'active' : ''}`} key={stage.id}><span className="stage-marker">{done ? '✓' : stageIndex + 1}</span><span>{stage.label}</span></li>; })}</ol>
    <p className="sync-progress-message">{progress.message}</p>{!isComplete && !isError && <p className="sync-progress-hint">The sync is active. Large accounts can take several minutes while history pages are fetched.</p>}
  </section>;
}

export function TradingPage({ api }: { api: HostAPI }) {
  const [config, setConfig] = useState<Config>({ environment: 'live', accountId: '', syncFrequency: 'manual' });
  const [key, setKey] = useState(''); const [secret, setSecret] = useState(''); const [hasCredentials, setHasCredentials] = useState(false); const [accounts, setAccounts] = useState<any[]>([]);
  const [newAccountName, setNewAccountName] = useState('Trading 212'); const [status, setStatus] = useState(''); const [busy, setBusy] = useState(false); const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null); const busyRef = useRef(false);

  useEffect(() => { const frequency = config.syncFrequency ?? 'manual'; const delays = { '15m': 15 * 60 * 1000, hourly: 60 * 60 * 1000, daily: 24 * 60 * 60 * 1000 }; if (frequency === 'manual' || !config.accountId) return; const timer = window.setInterval(() => { void sync(); }, delays[frequency]); return () => window.clearInterval(timer); }, [config.accountId, config.syncFrequency]);
  useEffect(() => { Promise.all([readConfig(api), api.accounts.getAll(), api.secrets.get(SECRET_KEY)]).then(([c, a, credential]) => { setConfig(c); setAccounts(a); if (credential) { setHasCredentials(true); setStatus('Credentials saved securely.'); } }).catch((e) => setStatus(e instanceof Error ? e.message : 'Could not load addon settings.')); }, [api]);

  async function connect() { if ((!key.trim() || !secret.trim()) && !hasCredentials) return setStatus('Enter both API key and API secret.'); setBusy(true); setStatus('Testing credentials…'); try { if (key.trim() && secret.trim()) { await api.secrets.set(SECRET_KEY, btoa(`${key.trim()}:${secret.trim()}`)); setHasCredentials(true); } const data = await fetchAccountSummary(api.network, config.environment); const next = { ...config, brokerAccountId: String(data.id), currency: data.currency }; setConfig(next); await saveConfig(api, next); setStatus(`Connected to account ${data.id} (${data.currency}).`); } catch (e) { setStatus(e instanceof Error ? e.message : 'Connection failed.'); } finally { setBusy(false); } }
  async function sync() { if (busyRef.current) return; if (!config.accountId) return setStatus('Connect and select a Wealthfolio account first.'); busyRef.current = true; setBusy(true); const startedAt = Date.now(); setSyncProgress({ stage: 'fetching', percent: 10, startedAt, message: 'Checking the latest Trading 212 data…' }); try { const syncResult = await fetchTrading212Incremental(api.network, config.environment, config.lastSync, config.syncCursors, config.syncHistoryBefore, (progress: FetchProgress) => { const endpointLabel = progress.endpoint.replace('/equity/', '').replaceAll('/', ' › '); const percent = Math.min(50, 10 + progress.page * 2); setSyncProgress({ stage: 'fetching', percent, startedAt, message: `Fetched ${endpointLabel} page ${progress.page} (${progress.total} records).` }); }); const data = syncResult.data; setSyncProgress({ stage: 'importing', percent: 60, startedAt, message: `Checking and importing this sync batch for ${config.accountId}…` }); const result = await importWithDuplicateDetection(api, toActivityImports(data, config.accountId)); setSyncProgress({ stage: 'saving', percent: 85, startedAt, message: syncResult.historyComplete ? 'Saving the latest sync timestamp…' : 'Saving progress; older history remains for the next sync…' }); const next = { ...config, lastSync: new Date().toISOString(), syncCursors: syncResult.nextCursors, syncHistoryBefore: syncResult.nextHistoryBefore }; setConfig(next); await saveConfig(api, next); const completeMessage = `Sync complete: ${result.imported} imported, ${result.duplicates} duplicates, ${result.skipped} skipped; ${data.positions.length} open positions checked${syncResult.historyComplete ? '.' : '; one month of older history queued for the next run.'}`; setSyncProgress({ stage: 'complete', percent: 100, startedAt, message: completeMessage }); setStatus(completeMessage); } catch (e) { api.logger.error(`[${ADDON_ID}] sync failed: ${String(e)}`); const errorMessage = e instanceof Error ? e.message : 'Sync failed.'; setSyncProgress({ stage: 'error', percent: 100, startedAt, message: errorMessage }); setStatus(errorMessage); } finally { busyRef.current = false; setBusy(false); } }
  async function createAccount() { if (!newAccountName.trim()) return setStatus('Enter a name for the new Wealthfolio account.'); setBusy(true); try { const summary = config.brokerAccountId && config.currency ? { id: Number(config.brokerAccountId), currency: config.currency } : await fetchAccountSummary(api.network, config.environment); const created = await api.accounts.create({ name: newAccountName.trim(), accountType: 'SECURITIES', currency: summary.currency, isDefault: false, isActive: true, trackingMode: 'TRANSACTIONS', provider: 'Trading 212', providerAccountId: String(summary.id) }); const next = { ...config, accountId: created.id, brokerAccountId: String(summary.id), currency: summary.currency }; setAccounts((current) => [...current, created]); setConfig(next); await saveConfig(api, next); setStatus(`Created and mapped ${created.name} (${summary.currency}).`); } catch (e) { api.logger.error(`[${ADDON_ID}] account creation failed: ${String(e)}`); setStatus(e instanceof Error ? e.message : 'Account creation failed.'); } finally { setBusy(false); } }

  return <main className="page"><header><div><div className="eyebrow">BROKER CONNECTION</div><h1>Trading 212</h1><p>Import orders, dividends and cash movements directly from your Trading 212 account.</p></div><button className="primary" onClick={sync} disabled={busy || !config.accountId}>↻ Sync now</button></header>{syncProgress && <SyncProgressPanel progress={syncProgress} />}<section className="card"><h2>Connection</h2><p className="muted">Your credentials are stored in Wealthfolio’s secure keyring and never persisted in addon settings.</p><div className="grid"><label>Environment<select value={config.environment} onChange={(e) => setConfig({ ...config, environment: e.target.value as Config['environment'] })}><option value="live">Live</option><option value="demo">Demo</option></select></label><label>API key<input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Trading 212 API key" /></label><label>API secret<input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Trading 212 API secret" /></label><label>Sync frequency<select value={config.syncFrequency ?? 'manual'} onChange={async (e) => { const next = { ...config, syncFrequency: e.target.value as Config['syncFrequency'] }; setConfig(next); await saveConfig(api, next); }}><option value="manual">Manual only</option><option value="15m">Every 15 minutes</option><option value="hourly">Every hour</option><option value="daily">Once per day</option></select></label></div><button onClick={connect} disabled={busy}>{busy ? 'Working…' : 'Save & test connection'}</button></section><section className="card"><h2>Wealthfolio account</h2><p className="muted">All imported activities will be added to this account.</p>{accounts.length > 0 && <select value={config.accountId} onChange={async (e) => { const next = { ...config, accountId: e.target.value }; setConfig(next); await saveConfig(api, next); }}><option value="">Select an account…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}</select>}<div className="wizard"><strong>{accounts.length ? 'Create another account' : 'Create your Wealthfolio account'}</strong><span className="muted">Creates a transaction-tracked securities account and maps it to this Trading 212 account.</span><input value={newAccountName} onChange={(e) => setNewAccountName(e.target.value)} placeholder="Account name" /><button onClick={createAccount} disabled={busy || !newAccountName.trim()}>Create and map account</button></div></section><section className="notice">{status || (config.lastSync ? `Last sync: ${new Date(config.lastSync).toLocaleString()}` : 'Connect Trading 212 to begin.')}</section><footer><a href="https://helpcentre.trading212.com/hc/en-us/articles/14584770928157-Trading-212-API-key" target="_blank">How to create an API key ↗</a><span>Trading 212 API is read-only for this addon.</span></footer></main>;
}
export default function enable(ctx: AddonContext) { context = ctx; ctx.router.add({ id: ADDON_ID, path: `/addons/${ADDON_ID}`, component: Page }); ctx.onDisable(() => { context = undefined!; }); }
