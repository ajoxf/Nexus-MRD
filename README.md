# Nexus RAMP - Risk and Margin Platform

Margin, risk and P&L tracker for multi-broker commodity trading (Orient futures spreads, MT5 accounts).

- React 18 + Vite, data in Supabase (shared workspace)
- `src/lib/positions.js`: FIFO / average-price / MT5-ticket matching engine
- `src/lib/csv.js`: Orient (TT) and MT5 CSV import, spread-leg detection, duplicate handling
- `src/lib/scenario.js`: per-product stress scenarios and lot capacity
- `src/App.jsx`: UI (Positions, Scenarios, Fills, Closed, Funds, Settings)

Deploys automatically on Vercel from the `main` branch (framework: Vite, build `vite build`, output `dist`).
