# tools/flowfv — retraining the flow FV model on ETH

`models/flowfv-h2.json` is the LightGBM model of the Up mid's move over the next 2 s that `src/model/flowFv.ts` runs
(`FLOW_FV=on`). The shipped one was trained on BTC (`h2_prod`). This directory retrains it on ETH windows, on the Helsinki
box, where the inputs are. It is the BTC repo's `tools/flowfv/` pipeline (same features, same targets, same LightGBM
settings), with the ETH inputs below.

## One command

```bash
pip install -r tools/flowfv/requirements.txt          # numpy pandas scipy pyarrow numba lightgbm (a venv is fine: PY=.venv/bin/python)
npm ci                                                # for the self-test at the end
tools/flowfv/retrain.sh 2026-10-20 2026-11-19         # FIRST_DAY LAST_DAY (a finished UTC day)
```

It runs the steps below, then installs the model into `models/` (the previous one is kept in `data/before-<time>/`), runs
`npm test` (the TS evaluator against LightGBM's own predictions; on failure the previous model goes back), and prints
the next steps. `INSTALL=0` stops after the export (`data/flowfv-h2.json`). Then commit
`models/flowfv-h2.json` + `models/flowfv-h2.vectors.json`, pull on the bot's box and restart the apps near a window
boundary. The model's tag (`h2_eth_<date>`) shows in the `[flow-fv] model …` boot log line.

Reruns are incremental: Binance days, Gamma labels and panel days already built are kept (`FRESH=1` rebuilds the panel,
e.g. after changing `LAT_*`, `LX` or the Chainlink source). The working data goes to `tools/flowfv/data/` (git-ignored,
`FLOWFV_DATA` moves it), about 1–2 GB a day.

## Inputs on the Helsinki box

| input | default | what is read |
|---|---|---|
| L2 recorder (`L2_ROOT`) | `/work/david/PolyMarket/database/l2_events/eth-5m/<day>/*-<start>.parquet` | the Up book and the tape event by event, in the recorder's receive clock (the BTC layout) |
| Binance books (`CHD_ROOT`) | `/work/david/PolyMarket/database/chd/<day>/{binance_spot,binance_futures}/<HH>/ETHUSDT_orderbook.parquet` | CryptoHFTData hourly depth: a snapshot at the hour, then diff updates. `chd_book.py` rebuilds the touch → spot and perp mids |
| Chainlink ETH/USD prints | the tracker DB `/work/alex_work/Bot_work/database/polymarket_5m_multi.db` (`CL_DB`) | a table with `observed_at_ms, received_at_ms, price` that is ETH (name has "eth", or a symbol/asset column). Else `CL_SQL` (a query returning obs_ms, rcv_ms, price) or `CL_FILE` (csv/parquet with those columns) |
| labels, strikes | Gamma API | `eventMetadata.priceToBeat` and the payout per window, as `src/feeds/gamma.ts` reads them |

`preflight.py` (step 0) checks all of it and stops with what is missing: modules, L2 days and schema, Binance hours per
venue, the Chainlink table, Gamma, disk. A day with missing Binance hours is used; windows in those hours are skipped.

## Steps

```bash
D=tools/flowfv/data   # = FLOWFV_DATA
python3 -I tools/flowfv/preflight.py   F L
python3 -I tools/flowfv/chd_book.py    F L         # 1. books -> $D/bin_spot, $D/bin_um (one npz a day: t, mid)
python3 -I tools/flowfv/meta.py        F L         # 2. Gamma -> $D/meta.json (out, K) for every recorded window
python3 -I tools/flowfv/cl.py          F L         # 3. prints -> $D/cl.npz; K_rec checked against Gamma's K
python3 -I tools/flowfv/prep_global.py             # 4. per-second sigma (the bot's HfVol) -> $D/global.npz
python3 -I tools/flowfv/l2panel.py $D/l2 F L       # 5. 100 ms panel: features + targets, one npz a day
python3 -I tools/flowfv/train_ffv.py 2             # 6. val fit + prod fit, report, self-test vectors
python3 -I tools/flowfv/export_model.py $D/ffv_h2_prod.json $D/flowfv-h2.json   # 7. compact model for the bot
```

`train_ffv.py` splits by day: the last ~20% of the days are test, the ~15% before them val (early stop), the rest train
(`FLOWFV_TRAIN_END` / `FLOWFV_VAL_END` set the dates). The prod fit uses every day with the val fit's rounds × 1.2.
`data/ffv_h2_report.json` has the val fit's out-of-sample R² **and the model in use scored on the same test frames**,
so you can see whether the ETH model beats the BTC one before deploying. A month of days is a sensible minimum: BTC's
model was trained on 18 days, 09-24 → 10-11.

## What differs from BTC's pipeline

- **Binance prices are book mids, not aggTrades.** The bot's spot and perp inputs are bookTicker mids, so this is closer
  to live. The taker-flow features (`bf*`, `uf*`) become zero; the model drops them anyway, as BTC's did.
- **Delays fitted on the ETH bot.** `LAT_B` 50 ms (spot) and `LAT_U` 100 ms (perp): with these shifts the rebuilt mids
  equal the ETH paper bot's recorded mids (`bmid`, `umid` in `data/windows/`) in 95% and 96% of frames on 36 windows,
  2026-11-18..20, the best of 0–300 ms. BTC used 135 for both (Helsinki, aggTrades). `LX` 400 ms and the pricer's eps
  0.34 bp (`FLOWFV_EPS_BPS`) are the ETH paper bot's fitted medians (`data/index.jsonl` `lagMs`, `epsBps`); BTC used 650 and 0.085.
- **Labels and strikes from Gamma**, not the tracker DB / `market.db` (no ETH windows there).
- **κ from the L2 panel itself.** The bot's rule (median implied/base ratio 90–290 s before the close, rolling 20
  windows, prior 1.10) on the panel's whole-second frames, instead of the tracker's 1 Hz panel (`panel.py`,
  `assemble.py` not ported).
- `gbm.py` evaluates a compact model in numpy by `gbm.ts`'s rules (equal to LightGBM's predictions on the shipped
  vectors), for the comparison with the model in use.

## Checked (2026-11-20, on this box)

An end-to-end run on 3 CryptoHFTData hours (11-18 14h, 11-19 12h, 11-20 12h, downloaded from the vendor) with stand-in
L2 files built from the ETH bot's recorded windows (top of book only) and their Chainlink column: every step ran;
Gamma labelled 36/36 windows; K_rec matched Gamma's strike (median 0.005 bp) and the rebuilt label agreed 33/33; the
exported model passed `npm test` (350 vectors, max |d| 0). That run's R² is meaningless (no depth, no tape): the real
L2 recorder files and the tracker's Chainlink table are only on Helsinki, and the preflight is the check for them.
