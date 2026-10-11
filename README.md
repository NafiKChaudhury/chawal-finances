# Chawal Finances

Personal finance, debt, investment and dividend dashboard deployed on Netlify.

## Market data

The Holdings form can look up any CAD or USD stock or ETF available through Yahoo Finance. Lookups happen on demand through `netlify/functions/market-data.js`; symbols do not need to be added to `data/tickers.json` first.

- U.S. examples: `AAPL`, `MSFT`, `APLY`, `SCHD`
- Toronto Stock Exchange examples: `RY.TO`, `VDY.TO`, `VFV.TO`
- TSX Venture examples use `.V`
- Cboe Canada/NEO examples generally use `.NE`

Yahoo Finance prices can be delayed. Dividend payment dates returned by the app are estimates based on historical distribution timing and must be reviewed before saving.

`data/tickers.json` controls only the small daily fallback cache refreshed by GitHub Actions. Financial Modeling Prep remains an optional final fallback when `FMP_API_KEY` is configured in Netlify.

## Dividend projections

Past months remain saved actuals. The current and future months are estimated from shares, dividend per share, frequency, withholding tax, currency conversion and dated buy/sell transactions. Weekly, biweekly, monthly, every-two-months, quarterly, twice-yearly and yearly schedules are supported.

DRIP is configured per portfolio owner and account for RRSP, TFSA and FHSA. When enabled, future net dividend estimates are reinvested at the holding's saved share price and compound later estimated payments. Historical actuals and saved share counts are not rewritten.
