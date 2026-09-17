# Trading 212 Sync for Wealthfolio

A community Wealthfolio addon that connects directly to the Trading 212 public API. It imports executed orders, dividends, deposits, withdrawals, fees and interest into a mapped Wealthfolio account, and checks current open positions during each sync.

## Install

Build with `pnpm install && pnpm build`, then install the generated `dist/wealthfolio-addon-trading212.zip` from Wealthfolio → Settings → Addons → Install from file.

Create a **read-only** Trading 212 API key. The addon stores the base64-encoded key/secret only through `ctx.api.secrets`; settings and the sync timestamp use addon storage. Network calls use Wealthfolio’s brokered `network.request` API and the manifest allowlist.

## Sync ranges and limitations

The addon syncs in bounded increments. Each run checks the current summary and positions, fetches the delta since the previous successful run, and then processes at most one month of older history per endpoint. API cursors and the historical month boundary are persisted after a successful import, so later runs resume where the previous run stopped. This keeps a large first import split across multiple short runs instead of one long request. Trading 212 only exposes a documented date filter for transactions; orders and dividends are bounded by cursor pages and local event dates. It does not place orders. Trading 212’s Pies endpoints are intentionally not used because they are deprecated. Current positions are fetched for validation; they are not written as holdings snapshots because the wizard creates transaction-tracked accounts.

## Automatic sync

Choose `Manual only`, `Every 15 minutes`, `Every hour`, or `Once per day`. The setting is stored in addon settings and defaults to `Manual only`; overlapping syncs are ignored.

The intervals run while the addon page is open. The current Wealthfolio addon SDK does not expose a background scheduler, so this is not a guaranteed background service when the addon page is closed.

## Dependency-free server-side sync

For a sync that continues when Wealthfolio’s GUI is closed, run the included standalone worker. It uses only Node.js built-ins and calls Trading 212 directly, then imports through Wealthfolio’s server API (`/api/v1/activities/import/check` and `/api/v1/activities/import`). Credentials never enter addon storage or the browser.

1. Copy `.env.worker.example` to `.env.worker`, fill in the Trading 212 read-only credentials and the mapped Wealthfolio account id, then run `chmod 600 .env.worker`.
2. Start it next to the Wealthfolio container:

```bash
docker compose --env-file .env.worker -f docker-compose.worker.yml up -d --build
```

The worker runs once at startup and once per day by default. For acceptance testing, set `SYNC_INTERVAL_MS=3600000` (hourly) or invoke `node worker/sync-worker.mjs` once. Check `http://localhost:8787/health` for the last run and any error. The worker is protected by binding its health port to loopback; do not expose it publicly.

When Wealthfolio authentication is enabled, set `WEALTHFOLIO_AUTH_TOKEN` to a server-issued bearer token. If Wealthfolio and the worker are on separate hosts, change `WEALTHFOLIO_URL` to a private HTTPS address and use your deployment’s secret manager instead of a checked-in env file. On Linux, replace `host.docker.internal` with the private hostname or add the appropriate host-gateway mapping.

The worker deliberately imports through the same duplicate-check flow as the addon, so reruns are safe. It does not write positions snapshots; it fetches them as a validation count, matching the addon behavior.

## Test the GUI locally

The addon development server is a runtime API, not a standalone web page, so opening its root URL (`/`) returns `Cannot GET /` by design. Use it as the addon source for a Wealthfolio development host:

```bash
# Terminal 1: from this addon directory
pnpm dev:server

# Terminal 2: from the Wealthfolio source repository
VITE_ENABLE_ADDON_DEV_MODE=true pnpm tauri dev
```

Wealthfolio discovers addon servers on ports `3001`, `3002`, and `3003`. If this addon is running on port `3002`, open the Trading 212 item in the Wealthfolio sidebar; the route is `/addons/wealthfolio-addon-trading212`. The server diagnostics are available at `http://localhost:3002/test` and `http://localhost:3002/status`, but neither endpoint renders the addon GUI.
