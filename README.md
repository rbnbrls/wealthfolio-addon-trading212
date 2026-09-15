# Trading 212 Sync for Wealthfolio

A community Wealthfolio addon that connects directly to the Trading 212 public API. It imports executed orders, dividends, deposits, withdrawals, fees and interest into a mapped Wealthfolio account.

## Install

Build with `pnpm install && pnpm build`, then install the generated `dist/wealthfolio-addon-trading212.zip` from Wealthfolio → Settings → Addons → Install from file.

Create a **read-only** Trading 212 API key. The addon stores the base64-encoded key/secret only through `ctx.api.secrets`; settings and the sync timestamp use addon storage. Network calls use Wealthfolio’s brokered `network.request` API and the manifest allowlist.

## Important limitation

The addon imports transaction history. It does not place orders. Trading 212’s Pies endpoints are intentionally not used because they are deprecated. Positions/snapshots can be added in a follow-up once the Wealthfolio snapshot mapping is confirmed for the target host version.
