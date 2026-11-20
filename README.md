# eth5m_mm — Polymarket ETH 5-minute Up/Down market maker

A port of `/home/david-work/btc5m_mm_bot` (v8, 2026-11-18) to the **Ethereum Up or Down – 5 minute** markets
(`eth-updown-5m-<start>`). The strategy, the fair-value model, the paper exchange, the live venue code and the dashboard
are the BTC bot's, unchanged. Only the asset-specific parts are new. For how the strategy works and why each knob has its
value, see the BTC bot's README: section names quoted in code comments ("README …") refer to that file.

Paper by default. `MM_MODE=live` trades real money.

## What changed from the BTC bot

| | BTC bot | this bot |
|---|---|---|
| asset constants | hard-coded strings | `src/asset.ts`, picked by `MM_ASSET` (`eth` default, `btc` preset kept) |
| Gamma slug | `btc-updown-5m-<ts>` | `eth-updown-5m-<ts>` |
| settlement source (RTDS) | Chainlink `btc/usd` | Chainlink `eth/usd` (spot + 60 s TWAP; ETH has no 30 s TWAP stream, and the market settles on 60 s) |
| nowcast / σ / flow-FV inputs | Binance `BTCUSDT` spot + perp, Coinbase `BTC-USD` | `ETHUSDT` spot + perp, `ETH-USD` |
| CryptoStruct perp id | 67824 | looked up by symbol at boot (`CRYPTOSTRUCT_PERP_ID` overrides) |
| ports | 8030 paper / 8031 live / 8034 challenger | 8040 paper / 8041 live / 8044 challenger |
| pm2 apps | `btc5m-mm-bot`, `-mm-live`, `-mm-challenger` | `eth5m-mm-bot`, `eth5m-mm-live`, `eth5m-mm-challenger` |
| paper size | 40 a side, cap 80 | 20 a side, cap 40 (ETH books are thinner) |
| live size | 10–20 by session | 10 a side, cap 20, no session schedule |
| dashboard | "BTC" text, $1 chart padding, whole-dollar axis | asset name filled in by the server (`{{ASSET}}` placeholders), padding and axis decimals scaled to the price |
| `tools/latency-probe.ts` trigger | $8 move in 1 s | 0.9 bp in 1 s (the same move relative to price) |

Everything else in the strategy is in bp or token cents, so it carries over as is.

Checked live on 2026-11-18: Gamma's ETH market config is `eth-5m-twap-60` with a 1¢ tick and a 5-share minimum, as on BTC.
RTDS `eth/usd`, Binance `ETHUSDT` (spot, perp, 1 s klines) and Coinbase `ETH-USD` all deliver.

## ⚠ Before trusting the numbers

1. **The flow-FV model (`models/flowfv-h2.json`) was trained on BTC.** Its strongest inputs carry over: the perp's
   returns in bp and book imbalance. But the book-size and order-flow features (in shares) and σ sit at different levels on ETH.
   It runs (`FLOW_FV=on`, as on BTC) but is out of distribution. Retrain it on ETH with `tools/flowfv/retrain.sh` on the
   Helsinki box (pmqb's L2 recorder, eth-5m, plus CryptoHFTData's Binance books; `tools/flowfv/README.md`), or compare
   with `FLOW_FV=off` on the challenger. The same goes for the pair trade's leg-2 model (`models/l2-h5.json`, off by default).
2. **Thresholds tuned on BTC's record:** `MM_JUMP_BPS=1` (ETH moves more per second, so it fires more often), the race and
   depth-cap rules (`MM_RACE_SHARE`, `MM_JOIN_MAX_REL`), the vol cap, the regime spread `MM_REGIME_BUSY_SPR` and
   `config/hour-regimes.json` (BTC's hours; `MM_HOUR_REGIME` is off). Treat them as starting values for the ETH paper record.
3. **Calibration starts from the priors.** κ, the oracle lag and the Coinbase blend weight are fitted live into
   `DATA_DIR/calib.json`. Give the paper bot about 20 windows (~2 h) before reading its PnL.
4. **Paper fill model:** the venue latency tables (`src/trading/venueLatency.ts`) were measured on the BTC live bot. The venue is the
   same, so they should transfer, but the fills are calibrated on BTC's queue depths.

## Run

```bash
npm ci
npm test                                             # self-test (771 checks)
pm2 start ecosystem.config.cjs --only eth5m-mm-bot   # paper, dashboard http://127.0.0.1:8040
pm2 start ecosystem.config.cjs --only eth5m-mm-challenger   # the live app's knobs on paper, :8044
pm2 logs eth5m-mm-bot
```

Without pm2: `npm start` (reads `.env`; outside pm2 a var already in the shell beats `.env`).

`.env` holds the BTC bot's production knobs of 2026-11-18, with the ETH changes above and **no secrets**.
`.env.example` documents every knob.

## Live

1. Wallet: `POLYMARKET_FUNDER_ADDRESS=0x…` in `.env`, then `npm run vault:init` (the private key, L2 creds and Relayer key
   go into the encrypted `wallet.vault`; live refuses to start with a key in plaintext in `.env`). `npm run live:check`.
2. **If the wallet is the BTC bots' too**, set `LIVE_PEER_STATE` in `ecosystem.config.cjs` (eth5m-mm-live) to their live
   `state.json` files, so the wallet check counts their tokens. Each bot cancels only its own orders by id.
3. `bash tools/start-live.sh` → `eth5m-mm-live`, dashboard :8041, data in `data-live/` (seeded with the paper bot's
   calibration once it has one), then the vault passphrase (`npm run unlock` under pm2). `pm2 stop eth5m-mm-live`
   cancels its orders.

Loss limit `LIVE_MAX_LOSS=20` on settled windows. The dashboard has the size switch, STOP / START, and the OWN | BASE |
CHALLENGER config switch (BASE = eth5m-mm-bot, CHALLENGER = eth5m-mm-challenger).

## Layout

`src/asset.ts` the asset · `src/feeds/` Gamma, RTDS, Binance, Coinbase, Polymarket book · `src/model/` fair value, vol,
calibration, flow FV · `src/quoter.ts` + `guard.ts`, `sweep.ts`, `excess.ts`, `lock.ts`, … the policy · `src/trading/`
paper exchange, live venue, orders, vault · `src/engine.ts` the loop · `src/server.ts` + `public/index.html` the dashboard ·
`tools/` live latency / take tests, signal tap, pair report.

Not ported: the BTC repo's research platforms (`agents/`, `tailguard/`, `inventory/`, `latency/`, `session/`, `sweep/`),
its Python study tools under `tools/*/` (except `tools/flowfv/`, ported for ETH), and its recorded data.
