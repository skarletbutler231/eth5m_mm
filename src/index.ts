// eth5m-mm-bot — Polymarket ETH 5-minute Up/Down market maker (ported from btc5m-mm-bot; the asset is src/asset.ts): fair value, inventory-aware quotes, paper
// order management against the live book. MM_MODE=live sends REAL orders from the wallet whose key is in the encrypted
// wallet vault (trading/vault.ts; the passphrase is typed at startup, or `npm run unlock` under pm2) — trading/venue.ts.
import { CFG } from "./config.js";
import { ASSET, app } from "./asset.js";
import { BinanceFeed, PERP_URL, type CsSource } from "./feeds/binance.js";
import { CoinbaseFeed } from "./feeds/coinbase.js";
import { RtdsFeed } from "./feeds/rtds.js";
import { PmBookFeed } from "./feeds/pmBook.js";
import { Calibrator } from "./model/calibration.js";
import { FlowFv } from "./model/flowFv.js";
import { Gbm } from "./model/gbm.js";
import { Store } from "./store.js";
import { Engine } from "./engine.js";
import { bootProfile } from "./profile.js";
import { bootControl } from "./control.js";
import { Trader } from "./trading/trader.js";
import type { Venue } from "./trading/venue.js";
import { startServer } from "./server.js";
import { plaintextSecrets, unlockVault } from "./trading/vault.js";
import fs from "node:fs";
import path from "node:path";

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${m}`);

process.on("unhandledRejection", (e) => log(`[process] unhandled rejection: ${(e as Error)?.stack ?? e}`));
process.on("uncaughtException", (e) => log(`[process] uncaught exception: ${e.stack}`));

/** The Chainlink feed: PolyBolt with CL_FEED=auto and a key set (or CL_FEED=polybolt), else RTDS. */
function chainlinkFeed(): RtdsFeed {
  const p = CFG.polybolt, keyed = !!(p.apiKey && p.secret && p.passphrase);
  if (CFG.clFeed === "polybolt" && !keyed) log("[boot] CL_FEED=polybolt but POLYBOLT_API_KEY / _SECRET / _PASSPHRASE are not all set: RTDS");
  const pb = CFG.clFeed !== "rtds" && keyed;
  if (pb) log(`[boot] Chainlink over PolyBolt${p.chainlinkKey ? " (Chainlink API key set)" : " (no CHAINLINK_API_KEY: refused from 2026-11-30 → RTDS)"}`);
  return new RtdsFeed(log, pb ? p : null);
}

async function main(): Promise<void> {
  log(`[boot] ${process.env.name ?? app("mm-bot")}: ${ASSET.name} 5m (${ASSET.slugPrefix}, Chainlink ${ASSET.chainlink}, Binance ${ASSET.binance}), data in ${CFG.dataDir}`);
  // live: the wallet vault first, before any feed connects, so a long locked wait holds nothing open and the last run's
  // orders are cancelled the moment it unlocks. Paper and shadow never touch the key.
  if (CFG.mode === "live") {
    let left = 0;
    try { left = (JSON.parse(fs.readFileSync(path.join(CFG.dataDir, "live", "state.json"), "utf8")).open ?? []).length; } catch { /* first run */ }
    await unlockVault({ sockDir: CFG.dataDir, onLocked: (m) => log(`[live] ${m}` +
      (left ? ` · ⚠ the last run's ${left} saved order(s) stay on the book until it is unlocked` : "")) });
    log("[live] wallet vault unlocked");
  } else if (plaintextSecrets().length) {
    log(`[boot] ⚠ ${plaintextSecrets().join(", ")} in plaintext in .env: move them into the wallet vault (npm run vault:init) and delete the lines; live refuses to start with them there`);
  }
  // live: the dashboard's OWN | BASE | CHALLENGER choice saved by the last run (profile.ts), before anything trades
  bootProfile(log);
  // paper or live: the dashboard's order size and stop saved by the last run (control.ts)
  bootControl(log);
  const store = new Store(CFG.dataDir);
  const calib = new Calibrator(log);
  // CryptoStruct relay for the Binance feeds that CRYPTOSTRUCT_FEEDS names (the direct sockets are the fallback)
  const csFor = (on: boolean, market: CsSource["market"], port: number, id: number | null): CsSource | null => {
    if (!on) return null;
    if (!CFG.cs.key) { log(`[boot] CRYPTOSTRUCT_FEEDS names ${market} but CRYPTOSTRUCT_REALTIME_API_KEY is empty: direct Binance`); return null; }
    return { host: CFG.cs.host, port, market, key: CFG.cs.key, id,
      login: [`${ASSET.key}5m`, app("mm-bot"), "1.0.0", `${CFG.tagName || CFG.mode}-${process.pid}`] };
  };
  const bin = new BinanceFeed(log, undefined, "binance", true, csFor(CFG.cs.spot, "binance_spot", 14003, CFG.cs.spotId || null));
  const cb = CFG.cbFeed ? new CoinbaseFeed(log) : null;
  const rtds = chainlinkFeed();
  const pm = new PmBookFeed(log, CFG.pmSockets);
  const perp = CFG.perpFeed ? new BinanceFeed(log, PERP_URL, "binance-perp", false, csFor(CFG.cs.perp, "binance_swap", 14004, (CFG.cs.perpId ?? ASSET.csPerpId) || null)) : null;
  let ffv: FlowFv | null = null;
  try {
    const g = Gbm.load(CFG.flowFvModel);
    ffv = new FlowFv(g, CFG.flowFvScale);
    log(`[flow-fv] model ${g.tag ?? "?"}: ${g.nTrees} trees, ${g.features.length} features, ${g.horizonS ?? "?"} s horizon, scale ${CFG.flowFvScale}; ` +
      `centre ${CFG.flowFv === "on" ? "every window" : CFG.flowFv === "ab" ? "even 5-minute slots (+ffv), odd = anchored FV" : "off (recorded only)"}`);
  } catch (e) {
    log(`[flow-fv] no model (${(e as Error).message}): quotes stay on the anchored FV`);
  }
  rtds.onTwap((w, sec, v) => calib.noteTwap(w, sec, v, bin.mids, rtds.spot));

  await bin.start();
  await perp?.start();
  cb?.start();
  rtds.start();
  pm.start();

  // live: connect the wallet and read its balance (the Trader cancels the orders the last run left on the book)
  let venue: Venue | null = null, bal: number | null = null;
  if (CFG.mode === "live") {
    const { connectVenue } = await import("./trading/venue.js");   // paper and shadow never load the SDK
    venue = await connectVenue(log, CFG.livePostCopies, { copies: CFG.liveCancelCopies, own: CFG.liveCancelHttp === "own" });
    bal = await venue.balance();
    log(`[live] ⚠ LIVE TRADING: wallet ${venue.wallet}, $${bal.toFixed(2)} collateral · ` +
      (CFG.pair.on ? `PAIR TRADE: ${CFG.pair.size} sh a leg on ${CFG.pair.signal === "fast" ? `≥ ${Math.round((CFG.fastSignal.minMove ?? NaN) * 100)}¢ signals in ${CFG.fastSignal.lookbackMs} ms (/signal-fast)` : `≥ ${Math.round(CFG.pair.minMove * 100)}¢ signals${CFG.pair.move === "free" ? " (free side)" : ""} in ${CFG.pair.lookbackMs} ms`}, leg 1 ${CFG.pair.leg1 === "maker" ? "a post-only bid" : "fill-and-kill"}, leg 2 fill-and-kill`
        : `${CFG.orderSize} sh a side, cap ${CFG.maxPosition} net`) + `, loss limit −$${CFG.liveMaxLoss}` +
      (CFG.livePostCopies > 1 ? ` · each order signed once and posted ${CFG.livePostCopies}× at once (LIVE_POST_COPIES)` : "") +
      (CFG.liveEarlyCancel ? " · cancels go by the signed id before the post's answer (LIVE_EARLY_CANCEL)" : ""));
    if (!CFG.pair.on && (CFG.v4FlowImb != null || CFG.v4RebalNet != null)) log("[live] ⚠ MM_V4_FLOW_IMB / MM_V4_REBAL_NET are on: their takes go out live, fill-and-kill, paying the taker fee");
  }

  const trader = new Trader(pm, store, log, CFG.dataDir, venue, bal);
  const engine = new Engine(bin, cb, rtds, pm, calib, store, trader, log, perp, ffv);
  engine.start();
  setInterval(() => engine.calibrate(), 60_000).unref();
  setTimeout(() => engine.calibrate(), 15_000).unref();
  startServer(engine, log);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log("[boot] stopping");
    await trader.stop();
    try { engine.flush(); } catch (e) { log(`[boot] flush failed: ${(e as Error).message}`); }
    calib.save();
    await venue?.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((e) => { log(`[boot] fatal: ${(e as Error).stack}`); process.exit(1); });
