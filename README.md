# Trading 212 Sync for Wealthfolio

A community Wealthfolio addon that connects directly to the Trading 212 public API. It imports executed orders, dividends, deposits, withdrawals, fees and interest into a mapped Wealthfolio account, and checks current open positions during each sync.

## Install

Build with `pnpm install && pnpm build`, then install the generated `dist/wealthfolio-addon-trading212.zip` from Wealthfolio → Settings → Addons → Install from file.

Create a **read-only** Trading 212 API key. The addon stores the base64-encoded key/secret only through `ctx.api.secrets`; settings and the sync timestamp use addon storage. Network calls use Wealthfolio’s brokered `network.request` API and the manifest allowlist.

## Sync ranges and limitations

The addon imports all available transaction history. It does not place orders. Trading 212’s Pies endpoints are intentionally not used because they are deprecated. Current positions are fetched for validation; they are not written as holdings snapshots because the wizard creates transaction-tracked accounts.

## Automatic sync

Choose `Manual only`, `Every 15 minutes`, `Every hour`, or `Once per day`. The setting is stored in addon settings and defaults to `Manual only`; overlapping syncs are ignored.

The intervals run while the addon page is open. The current Wealthfolio addon SDK does not expose a background scheduler, so this is not a guaranteed background service when the addon page is closed.
