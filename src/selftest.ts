// Offline checks of the pieces that decide every number on the dashboard. `npm test`.
import "./selftestEnv.js";   // first: the sizes the cases assume, before config.ts loads .env
import { anchoredFv, framePricers } from "./pricers.js";
import type { Exchange } from "./trading/exchange.js";
import { Kick } from "./kick.js";
import { normCdf, normInv } from "./model/math.js";
import { PriceBuffer } from "./model/priceBuffer.js";
import { fairValueAnchored, fairValueVenue, venuePath, blendPath } from "./model/fairValue.js";
import { fitBlend } from "./model/calibration.js";
import { L2Top } from "./feeds/coinbase.js";
import { emptyScore, summarize, type Score } from "./model/scorecard.js";
import { HfVol } from "./model/hfVol.js";
import { PmBookFeed } from "./feeds/pmBook.js";
import { applyGuard, Guard, guardCfg, type GuardCfg, type GuardIn } from "./guard.js";
import { PairCost, pcCfg, type PcCfg, type PcIn } from "./paircost.js";
import { Excess, xsCfg, type XsCfg, type XsIn } from "./excess.js";
import { Lock, lockCfg, lockMinNet, lockTarget, type LockCfg, type LockIn } from "./lock.js";
import { Sweep, swCfg, type SwCfg, type SwIn } from "./sweep.js";
import { applyTake, fastFor, flowFor, isV4, makeQuote, policyFor, quoteCfg, quoteTag, windowName, windowTag, type Quote, type QuoteIn } from "./quoter.js";
import { Gbm } from "./model/gbm.js";
import { FlowFv, type FlowIn } from "./model/flowFv.js";
import { decideTake, takeCfg, type TakeCfg, type TakeIn } from "./taker.js";
import { liveTick, makeQuoteCert, certCfg, type CertCfg, type CertIn } from "./certainty.js";
import { MoveSignal, type MoveMsg, type SigSample } from "./signal.js";
import { PairTrader, type PairCtx } from "./pairTrader.js";
import { FollowTrader, followDecide, type FollowCtx } from "./follow.js";
import type { FillMsg } from "./signal.js";
import { LegTwoModel, l2Features, L2_FEATURES } from "./model/legTwo.js";
import { COLS } from "./engine.js";
import { CFG, ROOT, SWITCH_KEYS, reloadSwitchKnobs } from "./config.js";
import { ASSET, app, slugOf } from "./asset.js";
import { applyPending, knobsOf, profileStatus, requestProfile } from "./profile.js";
import { applyWindow, bootControl, controlStatus, parseSessions, requestSize, setStopped, stopReason } from "./control.js";
import { assetPage, twinOf } from "./server.js";
import { PERP_URL } from "./feeds/binance.js";
import { RtdsFeed } from "./feeds/rtds.js";
import type { BookView, Print } from "./feeds/pmBook.js";
import { PaperExchange, type SweepCfg } from "./trading/paperExchange.js";
import { CALM_CANCEL_MS, COPIES3_NEWBEST_PLACE_MS, SWEPT_CANCEL_MS_1023, TWIN_NEWBEST_PLACE_MS, VenueLatency, liveTakeMs, type LatCfg } from "./trading/venueLatency.js";
import { Account } from "./trading/account.js";
import { OrderManager } from "./trading/orderManager.js";
import type { Fill } from "./trading/types.js";
import { cancelKind } from "./trading/types.js";
import { Trader } from "./trading/trader.js";
import { LiveExchange, ORPHAN_MS } from "./trading/liveExchange.js";
import { l2Key, l2Signature, ownCanceller, postFailure, raceCancels, racePosts, venueTrade, type CancelAnswer, type PostResult, type Venue, type VenueOrderUpdate, type VenueTrade } from "./trading/venue.js";
import { openVault, sealVault, unlockVault, WrongPassphrase } from "./trading/vault.js";
import { Regime, regimeCfg, winStats } from "./regime.js";
import { HourRegime, hourBlocks, hourRegimeFromCfg, parseHourTable } from "./hourRegime.js";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// The checks assume the cap counts the filled net alone, whatever .env sets: the trader checks post quotes bigger than the
// .env cap. The MM_CAP_PENDING checks pass the cap to the order manager themselves (10b1) or turn it on in the config (tag).
CFG.capPending = false;
// The trader checks time their takes on the constant PAPER_TAKE_MS, whatever .env sets (PAPER_TAKE_MS=live draws it).
CFG.paperTakeLive = false;

let fails = 0;
const ok = (name: string, cond: boolean, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!cond) fails++; };
// the tag tests read CFG: no lock (+lock / +lpx) whatever .env says (it is on for every app since 2026-11-11); the lock's
// own tests pass their config explicitly
CFG.lock.pct = null; CFG.lock.pxF = null;

// 1. normal CDF / inverse
ok("Phi(0) = 0.5", Math.abs(normCdf(0) - 0.5) < 1e-7);
ok("Phi(1.96) = 0.975", Math.abs(normCdf(1.96) - 0.9750021) < 2e-7);
let worst = 0;
for (let p = 0.0005; p < 1; p += 0.0005) worst = Math.max(worst, Math.abs(normCdf(normInv(p)) - p));
ok("Phi(Phi^-1(p)) round trip", worst < 1e-6, `max err ${worst.toExponential(2)}`);

// 2. price buffer: step integral
const b = new PriceBuffer(3600_000);
b.push(0, 100); b.push(1000, 110); b.push(3000, 90);
ok("step mean [0,4000]", Math.abs(b.mean(0, 4000)! - (100 * 1 + 110 * 2 + 90 * 1) / 4) < 1e-9, String(b.mean(0, 4000)));
ok("step mean [500,1500]", Math.abs(b.mean(500, 1500)! - 105) < 1e-9);
ok("uncovered start -> null", b.mean(-10, 100) === null);

// 3. both pricers vs Monte Carlo of the exact settlement rule (Asian digital, D = 60, eps 0).
// Deterministic history so each case lands mid-distribution: Chainlink flat at K before the open, then a
// step to K*e^c that holds until now. Binance = Chainlink x 1.00065 (a 6.5 bps basis the anchored pricer
// must ignore), received L = 250 ms earlier; the last Chainlink print is 1.6 s old (relay delay).
function mulberry(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r: () => number) { let u = 0, v = 0; while (u === 0) u = r(); while (v === 0) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function mc(tauLeft: number, zTarget: number, sigma: number, paths: number) {
  const D = 60, dt = 0.1, T0 = 0, Tend = 300_000, K = 100, B = 1.00065, L = 250, RELAY = 1600;
  const now = Tend - tauLeft * 1000;
  const tauEff = tauLeft >= D ? tauLeft - (2 * D) / 3 : tauLeft ** 3 / (3 * D * D);
  const c = zTarget * sigma * Math.sqrt(tauEff);
  const cl = new PriceBuffer(3600_000), bin = new PriceBuffer(3600_000);
  cl.push(T0 - 200_000, K); cl.push(T0 + 1, K * Math.exp(c)); cl.push(now - RELAY, K * Math.exp(c));
  bin.push(T0 - 200_000 - L, K * B); bin.push(T0 + 1 - L, K * Math.exp(c) * B); bin.push(now, K * Math.exp(c) * B);
  const anc = fairValueAnchored({ now, K, endMs: Tend, D, path: venuePath(bin, L), sigma, eps2: 0, cl })!;
  const Kv = bin.mean(T0 - L - D * 1000, T0 - L)!;
  const ven = fairValueVenue(bin, now, Kv, Tend, D, L, sigma, 0)!;
  // exact: Chainlink path known up to stamp now + L, diffusion after
  const a = Tend - D * 1000, from = now + L;
  const Rpast = from > a ? cl.integralSec(a, Math.min(from, now - RELAY))! + (from > now - RELAY ? K * Math.exp(c) * (from - Math.max(a, now - RELAY)) / 1000 : 0) : 0;
  const rng = mulberry(7);
  let up = 0;
  for (let p = 0; p < paths; p++) {
    let y = Math.log(K) + c, integ = Rpast;
    for (let ts = from; ts < Tend - 1e-6; ts += dt * 1000) {
      const prev = Math.exp(y);
      y += sigma * Math.sqrt(dt) * gauss(rng);
      const lo = Math.max(ts, a), hi = Math.min(ts + dt * 1000, Tend);
      if (hi > lo) integ += ((prev + Math.exp(y)) / 2) * (hi - lo) / 1000;
    }
    if (integ / D >= K) up++;
  }
  return { exact: up / paths, anchored: anc.fv, venue: ven.fv };
}

const sig = 0.5e-4;
for (const [tau, zt] of [[200, 0.5], [90, -0.3], [45, 0.4], [20, -0.5], [8, 0.8]] as const) {
  const n = 20_000;
  const r = mc(tau, zt, sig, n);
  const tol = 0.01 + 3 * Math.sqrt(r.exact * (1 - r.exact) / n);
  ok(`anchored FV vs Monte Carlo tau=${tau}s`, Math.abs(r.exact - r.anchored) < tol, `MC ${r.exact.toFixed(4)} anchored ${r.anchored.toFixed(4)} venue ${r.venue.toFixed(4)}`);
  ok(`venue FV vs Monte Carlo tau=${tau}s`, Math.abs(r.exact - r.venue) < tol + 0.005);
}

// 3c. pricers.ts: the frame's model FV as a pure function (MM_DECIDE_FV=fresh reruns it between frames)
{
  const K = 100, Tend = 300_000, D = 60, L = 250, sigma = 1e-4, now = 200_000;
  const cl = new PriceBuffer(3600_000), bin = new PriceBuffer(3600_000);
  cl.push(-200_000, K); cl.push(1, K * 1.001); cl.push(now - 1600, K * 1.001);
  bin.push(-200_000 - L, K * 1.0006); bin.push(1 - L, K * 1.0016); bin.push(now - 5, K * 1.0016);
  const base = { now, Kcl: K, Kv: K * 1.0006, endMs: Tend, D, sigma, eps2: 0, cl, clFresh: true, bin, L, binFresh: true };
  const nc = { path: venuePath(bin, L), src: "binance" };
  const direct = fairValueAnchored({ now, K, endMs: Tend, D, sigma, eps2: 0, cl, path: venuePath(bin, L) })!;
  let r = framePricers({ ...base, nc });
  ok("pricers: anchored on a Binance nowcast = fairValueAnchored, and the Binance-only FV is the same result",
    r.fvr?.src === "anchored" && Math.abs(r.fvr.fv - direct.fv) < 1e-12 && r.fvbr === r.fvr, `${r.fvr?.fv} vs ${direct.fv}`);
  r = framePricers({ ...base, nc: { path: venuePath(bin, L), src: "blend" }, binFresh: false });
  ok("pricers: a blend nowcast with Binance stale has no Binance-only FV", r.fvr?.src === "anchored" && r.fvbr === null);
  r = framePricers({ ...base, nc, Kcl: null });
  ok("pricers: no Chainlink strike → the venue FV, and no Binance-only FV", r.fvr?.src === "venue" && r.fvbr === null);
  r = framePricers({ ...base, nc, clFresh: false, Kv: null });
  ok("pricers: Chainlink stale and no Binance strike → nothing", r.fvr === null && r.fvbr === null);
  ok("pricers: no sigma → nothing", framePricers({ ...base, nc, sigma: null }).fvr === null);
  // a Binance move 30 ms after the frame: the fresh FV at +50 ms sees it, the frame's does not
  const f0 = framePricers({ ...base, nc })!.fvr!.fv;
  bin.push(now + 30, K * 1.0026);
  const f1 = framePricers({ ...base, nc, now: now + 50 }).fvr!.fv;
  const d1 = fairValueAnchored({ now: now + 50, K, endMs: Tend, D, sigma, eps2: 0, cl, path: venuePath(bin, L) })!.fv;
  ok("pricers: rerun 50 ms after a Binance up-move, the FV rises and equals a frame computed then", f1 > f0 + 1e-3 && Math.abs(f1 - d1) < 1e-12, `${f0.toFixed(4)} → ${f1.toFixed(4)}`);
  // the anchored FV without moving the frame's anchor
  const fr = framePricers({ ...base, nc, now: now + 50 }).fvr!;
  const an = { z: normInv(0.55), m: fr.m - 0.001, sd: fr.sd, mid: 0.55 };
  const keep = normCdf((an.z * an.sd + (fr.m - an.m)) / fr.sd);
  ok("pricers: anchored FV, mid unchanged → carried forward by the model's move since the anchor",
    Math.abs(anchoredFv(an, fr, 0.55, true)! - keep) < 1e-12 && keep > 0.55);
  ok("pricers: anchored FV, a good book's mid moved → that mid (the frame would re-anchor there); the anchor is not touched",
    Math.abs(anchoredFv(an, fr, 0.6, true)! - 0.6) < 1e-9 && an.mid === 0.55);
  ok("pricers: anchored FV, a bad book keeps the old anchor; no FV → null; no anchor and a bad book → null",
    Math.abs(anchoredFv(an, fr, 0.6, false)! - keep) < 1e-12 && anchoredFv(an, null, 0.55, true) === null && anchoredFv(null, fr, null, false) === null);
}

// 4. EWMA-blend sigma recovers a constant per-second vol
{
  const rng = mulberry(11), s = 0.6e-4;
  const hv = new HfVol(120, 1800, 0.5);
  let px = 80_000;
  const pts: { sec: number; px: number }[] = [];
  for (let i = 0; i < 3600; i++) { pts.push({ sec: i, px }); px *= Math.exp(s * gauss(rng)); }
  hv.seed(pts);
  for (let i = 3600; i < 4200; i++) { px *= Math.exp(s * gauss(rng)); hv.update(i, px); }
  const est = hv.sigma()!;
  ok("EWMA-blend sigma recovers constant vol", Math.abs(est / s - 1) < 0.1, `true ${(s * 1e4).toFixed(3)} est ${(est * 1e4).toFixed(3)} bps/sqrt s`);
}

// 5. book: snapshot + price_change + mirror tokens
{
  const f = new PmBookFeed(() => {});
  f.setTokens(["U", "D"]);
  f.apply(JSON.stringify([{ event_type: "book", asset_id: "U", bids: [{ price: "0.52", size: "100" }, { price: "0.51", size: "50" }], asks: [{ price: "0.54", size: "70" }], timestamp: "1" },
                          { event_type: "book", asset_id: "D", bids: [{ price: "0.46", size: "70" }], asks: [{ price: "0.48", size: "100" }], timestamp: "1" }]), Date.now());
  f.apply(JSON.stringify({ event_type: "price_change", timestamp: "2", price_changes: [
    { asset_id: "U", price: "0.53", size: "20", side: "BUY" }, { asset_id: "D", price: "0.47", size: "20", side: "SELL" },
    { asset_id: "U", price: "0.52", size: "0", side: "BUY" }] }), Date.now());
  const u = f.view("U"), d = f.view("D");
  ok("book best bid after price_change", u.bestBid === 0.53 && u.bids.length === 2 && u.bids[1][0] === 0.51);
  ok("mirror token best ask", d.bestAsk === 0.47);
}

// 5b. PM_SOCKETS 2: each event from whichever socket delivers it first; copies, late copies and stale snapshots change nothing
{
  const f = new PmBookFeed(() => {}, 2);
  f.setTokens(["U", "D"]);
  let ups = 0, prints = 0;
  f.onBookUpdate(() => ups++);
  f.onPrint(() => prints++);
  const snap = JSON.stringify({ event_type: "book", asset_id: "U", timestamp: "1", hash: "h1", bids: [{ price: "0.52", size: "100" }, { price: "0.51", size: "50" }], asks: [{ price: "0.54", size: "70" }] });
  const pc = (ts: number, price: string, size: string, side: string, hash: string) =>
    JSON.stringify({ event_type: "price_change", timestamp: String(ts), price_changes: [{ asset_id: "U", price, size, side, hash }] });
  f.apply(snap, 10, 0); f.apply(snap, 12, 1);
  ok("2 sockets: a snapshot's copy is no update", f.view("U").bestBid === 0.52 && ups === 1);
  f.apply(pc(2, "0.53", "20", "BUY", "a"), 20, 0); f.apply(pc(3, "0.53", "0", "BUY", "b"), 21, 0);
  f.apply(pc(2, "0.53", "20", "BUY", "a"), 40, 1);
  ok("2 sockets: a late copy of an older update does not bring a level back", f.view("U").bestBid === 0.52 && ups === 3);
  f.apply(pc(4, "0.50", "10", "BUY", "c"), 50, 0);
  f.apply(pc(4, "0.50", "10", "BUY", "c"), 51, 1); f.apply(pc(4, "0.50", "30", "BUY", "d"), 52, 1);
  f.apply(pc(4, "0.50", "30", "BUY", "d"), 60, 0); f.apply(pc(4, "0.50", "10", "BUY", "c"), 61, 1);
  const l50 = () => f.view("U").bids.find((l) => l[0] === 0.5)?.[1];
  ok("2 sockets: same-millisecond updates of one level apply once each, in order", l50() === 30, `0.50 holds ${l50()}`);
  f.apply(pc(6, "0.54", "5", "SELL", "e"), 70, 0);
  f.apply(JSON.stringify({ event_type: "book", asset_id: "U", timestamp: "5", hash: "h5", bids: [{ price: "0.52", size: "100" }, { price: "0.51", size: "50" }],
    asks: [{ price: "0.54", size: "70" }, { price: "0.56", size: "10" }] }), 80, 1);
  const u = f.view("U");
  ok("2 sockets: a snapshot merges level by level (a later update keeps its level)",
    u.asks[0][0] === 0.54 && u.asks[0][1] === 5 && u.asks[1]?.[0] === 0.56 && l50() === undefined, JSON.stringify(u.asks));
  const pr = JSON.stringify({ event_type: "last_trade_price", asset_id: "U", timestamp: "7", price: "0.52", size: "10", side: "SELL", transaction_hash: "t" });
  f.apply(pr, 90, 0); f.apply(pr, 95, 1);
  ok("2 sockets: a print's copy on the other socket is not a second print", prints === 1);
  f.apply(pr, 96, 0); f.apply(pr, 99, 1);
  ok("2 sockets: a print repeated on one socket still counts twice", prints === 2);
  const st = f.stats();
  ok("2 sockets: first copies are credited per socket", st.sockets?.length === 2 && Math.abs(st.sockets[0].first + st.sockets[1].first - 1) < 0.01);
  const fx = f as any;
  fx.socks[0].up = true; fx.socks[1].up = true;
  fx.dropped(fx.socks[0], "test");
  ok("2 sockets: one socket down keeps the books", f.view("U").ready && f.connected);
  fx.dropped(fx.socks[1], "test");
  ok("2 sockets: every socket down clears the books", !f.view("U").ready && !f.connected);
  // back up one by one: the first socket's snapshot makes the book, the second's older subscription snapshot keeps it
  f.apply(JSON.stringify({ event_type: "book", asset_id: "U", timestamp: "20", hash: "h20", bids: [{ price: "0.45", size: "40" }], asks: [{ price: "0.47", size: "30" }] }), 200, 0);
  f.apply(JSON.stringify({ event_type: "book", asset_id: "U", timestamp: "18", hash: "h18", bids: [{ price: "0.44", size: "90" }], asks: [{ price: "0.47", size: "60" }] }), 230, 1);
  const r = f.view("U");
  ok("2 sockets: after a full drop, an older snapshot from the socket that reconnects later changes nothing",
    r.ready && r.bestBid === 0.45 && r.bids.length === 1 && r.asks[0][1] === 30, JSON.stringify([r.bids, r.asks]));
}

// 6. strike lookup: exact, genuine gap second -> next report, our own gap -> unknown
{
  const f = new RtdsFeed(() => {}) as any;
  const note = (sec: number, v: number) => { f.ring[60].set(sec, v); if (sec > f.newest[60]) f.newest[60] = sec; };
  for (const s of [97, 98, 99, 101, 102]) note(s, s);
  ok("report at an exact second", f.reportAt(98, 60)?.value === 98);
  ok("genuine gap second -> next report", f.reportAt(100, 60)?.sec === 101);
  const g = new RtdsFeed(() => {}) as any;
  for (const s of [205, 206]) { g.ring[60].set(s, s); g.newest[60] = s; }
  ok("cold start after the boundary -> unknown, not the +5 s report", g.reportAt(200, 60) === null && g.missedAt(199, 60) === true);
}

// 6b. RTDS watchdog and subscribe history (2026-11-13: the socket answered for up to 105 min while the prices had stopped)
{
  const f = new RtdsFeed(() => {}) as any;
  const T0 = 1_794_538_000_000;
  const upd = (topic: string, tsMs: number, v: number) => JSON.stringify({ topic, type: "update", timestamp: tsMs + 900,
    payload: { symbol: ASSET.chainlink, timestamp: tsMs, value: v, full_accuracy_value: String(BigInt(Math.round(v * 1e6)) * 10n ** 12n) } });
  f.connected = true; f.openAt = T0; f.lastRx = T0;
  ok("rtds watchdog: within STALE_MS of the connect nothing is stale yet", f.staleWhy(T0 + 5_000) === null);
  f.apply(upd("crypto_prices_chainlink", T0, 70000), T0 + 1_000);
  f.apply(upd("crypto_prices_twap_sixty", T0, 70010), T0 + 1_100);
  ok("rtds watchdog: a price update resets the price clock", f.lastPrice === T0 + 1_100 && f.staleWhy(T0 + 9_000) === null && f.spotLatest?.v === 70000);
  // only pings answered and acks from here on: lastRx stays fresh, prices stop
  for (let t = T0 + 5_000; t <= T0 + 20_000; t += 5_000) { f.apply("PONG", t); f.apply(JSON.stringify({ topic: "crypto_prices_twap_thirty", type: "subscribe", payload: {} }), t + 1); }
  const why = f.staleWhy(T0 + 20_002);
  ok("rtds watchdog: pings and acks without prices for > 10 s → stale (the old 30 s any-message check missed this)",
    why != null && /no Chainlink price for 19 s/.test(why) && T0 + 20_002 - f.lastRx < 30_000, String(why));
  f.connected = false;
  ok("rtds watchdog: a closed socket is left to the reconnect", f.staleWhy(T0 + 60_000) === null);

  // the subscribe history fills the TWAP ring's gap: the open's report is found after all
  const g = new RtdsFeed(() => {}) as any;
  const S0 = 1_794_538_200;                                      // a window open, second
  g.apply(upd("crypto_prices_twap_sixty", (S0 - 40) * 1000, 70100), (S0 - 39) * 1000);   // live until 40 s before the open
  ok("rtds history: with the stall the open's report is unknown", g.reportAt(S0, 60) === null);
  const hist = Array.from({ length: 57 }, (_, i) => ({ timestamp: (S0 - 50 + i) * 1000, value: 70000 + i, full_accuracy_value: String(BigInt(70000 + i) * 10n ** 18n) }));
  g.apply(JSON.stringify({ topic: "crypto_prices_twap_sixty", type: "subscribe", payload: { symbol: ASSET.chainlink, data: hist } }), (S0 + 7) * 1000);
  ok("rtds history: the subscribe answer fills the gap, so the open's exact report is found", g.reportAt(S0, 60)?.value === 70050 && g.reportAt(S0, 60)?.sec === S0,
    JSON.stringify(g.reportAt(S0, 60)));
  ok("rtds history: a live value already in the ring stands (40 s before the open stays 70100)", g.reportAt(S0 - 40, 60)?.value === 70100);
  ok("rtds history: it does not count as a live price (the watchdog still wants an update) nor reach the calibration",
    g.lastPrice === (S0 - 39) * 1000 && g.newest[60] === S0 + 6);
}

// 6c. PolyBolt (2026-11-20): auth → subscribe, decimal full_accuracy_value, snapshot history, provider guard
{
  const pbSym = ASSET.chainlink.replace("/", "");   // ethusd (btcusd with MM_ASSET=btc)
  const logs: string[] = [];
  const f = new RtdsFeed((m) => logs.push(m), { apiKey: "k", secret: "s", passphrase: "p" }) as any;
  const sent: string[] = [];
  f.ws = { readyState: 1, send: (s: string) => sent.push(s), terminate: () => {} };
  const S0 = 1_795_139_100;
  f.apply(JSON.stringify({ op: "authed", rid: "a" }), S0 * 1000);
  const sub = JSON.parse(sent[0] ?? "{}");
  ok("polybolt: after authed it subscribes chainlink <asset>usd spot + 60 s TWAP",
    sub.op === "subscribe" && sub.subscriptions?.length === 2 && sub.subscriptions.every((s: any) => s.filter.symbol === pbSym && s.filter.provider === "chainlink")
      && sub.subscriptions[1].channel === "price.crypto.twap" && sub.subscriptions[1].filter.window_seconds === 60, sent[0]);
  const hist = Array.from({ length: 119 }, (_, i) => ({ timestamp: (S0 - 119 + i) * 1000, value: 62000 + i, full_accuracy_value: String(62000 + i) }));
  f.apply(JSON.stringify({ v: 1, channel: "price.crypto.twap", seq: 1, snapshot: true, payload: { symbol: pbSym, source: "chainlink", data: hist } }), S0 * 1000 + 5);
  f.apply(JSON.stringify({ v: 1, channel: "price.crypto", seq: 1, snapshot: true, payload: { symbol: pbSym, source: "chainlink", data: hist } }), S0 * 1000 + 6);
  ok("polybolt: TWAP snapshot fills the ring; an integer full_accuracy_value is dollars, not E18",
    f.reportAt(S0 - 60, 60)?.value === 62059 && f.newest[60] === S0 - 1, JSON.stringify(f.reportAt(S0 - 60, 60)));
  ok("polybolt: spot snapshot fills the spot buffer (not a live price)", f.spot.length === 119 && f.spot.last() === 62118 && f.spotLatest === null && f.lastPrice === 0);
  const upd = (channel: string, sec: number, fa: string, extra = {}) => JSON.stringify({ v: 1, channel, seq: 2, ts: sec * 1000,
    payload: { symbol: pbSym, source: "chainlink", timestamp: sec * 1000, value: Number(fa), full_accuracy_value: fa, ...extra } });
  f.apply(upd("price.crypto", S0, "61916.3947339592"), S0 * 1000 + 900);
  f.apply(upd("price.crypto.twap", S0, "61928.0468585628", { window_seconds: 60 }), S0 * 1000 + 950);
  ok("polybolt: live updates → spot, TWAP ring and the watchdog clock",
    f.spotLatest?.v === 61916.3947339592 && f.reportAt(S0, 60)?.value === 61928.0468585628 && f.lastPrice === S0 * 1000 + 950 && f.spot.length === 120);
  f.apply(JSON.stringify({ op: "subscribed", channel: "price.crypto", rid: "s", provider: "binance" }), S0 * 1000 + 1000);
  ok("polybolt: a subscription served by another provider → RTDS for 10 min", f.fallbackUntil > Date.now() && /binance/.test(f.lastError), f.lastError);
  const g = new RtdsFeed(() => {}, { apiKey: "k", secret: "s", passphrase: "p" }) as any;
  g.ws = { readyState: 1, send: () => {}, terminate: () => {} };
  g.apply(JSON.stringify({ op: "error", code: "chainlink_key_required" }));
  ok("polybolt: chainlink_key_required → RTDS fallback", g.fallbackUntil > Date.now());
  const h = new RtdsFeed(() => {}, { apiKey: "k", secret: "s", passphrase: "p" }) as any;
  h.ws = { readyState: 1, send: () => {}, terminate: () => {} };
  h.apply(upd("price.crypto", S0, "70000", { source: "binance" }), 1);
  ok("polybolt: a binance-sourced price is dropped and falls back", h.spotLatest === null && h.fallbackUntil > Date.now());
}

// 7. quoter: post-only, pull rule, inventory skew, position limit, reduce-only
{
  const cfg = { halfSpread: 0.01, pullMove: 0.005, quoteFromSec: 15, quoteUntilLeftSec: 10, orderSize: 25, maxPosition: 100, skewAtMax: 0.02, reduceOnlyLeftSec: 30 };
  const base: QuoteIn = { center: 0.5, centerSrc: "test", move2s: 0, elapsed: 100, left: 200, tick: 0.01, minSize: 5, bookReady: true, bestBid: null, bestAsk: null, net: 0, fv: null, mid: null };
  const q = (x: Partial<QuoteIn>) => makeQuote({ ...base, ...x }, cfg);
  const a = q({ center: 0.215, move2s: -0.002, bestBid: 0.27, bestAsk: 0.28 });
  ok("quote ask never crosses the best bid", a.ask === 0.28 && a.bid === 0.2, JSON.stringify([a.bid, a.ask]));
  ok("quote: the held side is reported (the move detector's PAIR_MOVE=free leaves it out)", a.held?.ask === true && a.held.bid === false && q({}).held?.ask === false);
  const b = q({ center: 0.40, move2s: 0.009, bestBid: 0.39, bestAsk: 0.40 });
  ok("pull rule removes the ask on an up-move", b.ask === null && b.bid === 0.39 && !!b.off.ask);
  const flat = q({}), long = q({ net: 50 }), short = q({ net: -50 });
  ok("flat quotes 49/51", flat.bid === 0.49 && flat.ask === 0.51, JSON.stringify([flat.bid, flat.ask]));
  ok("long half the max skews 1¢ down", Math.abs(long.skew - 0.01) < 1e-12 && long.bid === 0.48 && long.ask === 0.5, JSON.stringify([long.bid, long.ask]));
  ok("short half the max skews 1¢ up", short.bid === 0.5 && short.ask === 0.52, JSON.stringify([short.bid, short.ask]));
  ok("skew scales with p(1-p)", Math.abs(q({ center: 0.1, net: 50 }).skew - 0.01 * 0.36) < 1e-12);
  const near = q({ net: 90 });
  ok("bid size cut to the room left under the limit", near.bidSize === 10 && near.askSize === 25);
  const max = q({ net: 100 });
  ok("no bid at max position", max.bid === null && max.ask != null && !!max.off.bid);
  const ro = q({ left: 20, net: 12 });
  ok("reduce-only near the close: sell exactly the long", ro.bid === null && ro.ask != null && ro.askSize === 12, JSON.stringify([ro.bid, ro.ask, ro.askSize]));
  const roFlat = q({ left: 20, net: 0 });
  ok("reduce-only and flat: no quote", roFlat.bid === null && roFlat.ask === null);
  ok("no quote without a live book", q({ bookReady: false }).bid === null);
  ok("flat: both sides quote, the ask going out as a Down bid", flat.bid != null && flat.ask != null && flat.steps.some((x) => x.k === "target" && x.v.includes("Down bid 25 @ 49")));
  // per-side flow scales (FLOW_FV_SCALE_RISE / _FALL): centre 52¢ = mid 50¢ + 2 × pred 1¢
  const ks = (kr: number, kf: number, x: Partial<QuoteIn>) => makeQuote({ ...base, ...x }, { ...cfg, flowFvScale: 2, flowFvScaleRise: kr, flowFvScaleFall: kf });
  const k22 = ks(2, 2, { center: 0.52, flowPred: 1 }), kf3 = ks(2, 3, { center: 0.52, flowPred: 1 }), kr1 = ks(1, 2, { center: 0.52, flowPred: 1 });
  ok("flow scales: both = FLOW_FV_SCALE → one centre (51/53)", k22.bid === 0.51 && k22.ask === 0.53 && !k22.steps.some((s) => s.k === "flow scale"), JSON.stringify([k22.bid, k22.ask]));
  ok("flow scales: Up rising, FALL 3 → the Down bid's centre +1¢ (ask 54), Up bid unchanged", kf3.bid === 0.51 && kf3.ask === 0.54, JSON.stringify([kf3.bid, kf3.ask]));
  ok("flow scales: Up rising, RISE 1 → the Up bid's centre −1¢ (bid 50), Down bid unchanged", kr1.bid === 0.5 && kr1.ask === 0.53, JSON.stringify([kr1.bid, kr1.ask]));
  const dn3 = ks(2, 3, { center: 0.48, flowPred: -1 });
  ok("flow scales: Down rising, FALL 3 → the Up bid's centre −1¢ (bid 46), Down bid unchanged (49)", dn3.bid === 0.46 && dn3.ask === 0.49, JSON.stringify([dn3.bid, dn3.ask]));
  const nof = ks(1, 3, { center: 0.52, flowPred: null });
  ok("flow scales: no flow centre (flowPred null) → unchanged", nof.bid === 0.51 && nof.ask === 0.53, JSON.stringify([nof.bid, nof.ask]));
  const fc = { ...CFG, quotePolicy: "v5" as const, flowFv: "on" as const, flowFvScale: 2, pair: { ...CFG.pair, on: false }, follow: { ...CFG.follow, on: false } };
  ok("flow scales: tag +kf250 after +ffv only when FALL differs", windowTag(1_800_000_000, { ...fc, flowFvScaleRise: 2, flowFvScaleFall: 2.5 }).includes("+ffv+kf250") &&
    !/\+k[rf]\d/.test(windowTag(1_800_000_000, { ...fc, flowFvScaleRise: 2, flowFvScaleFall: 2 })));
  const g =(x: Partial<QuoteIn>) => makeQuote({ ...base, ...x }, { ...cfg, minEdge: 0.01, maxMove2s: 0.003 });
  const cheap = g({ fv: 0.52, mid: 0.505 }), rich = g({ fv: 0.49, mid: 0.505 }), fair = g({ fv: 0.508, mid: 0.505 });
  ok("edge filter: FV above the mid → bid only", cheap.bid != null && cheap.ask === null && !!cheap.off.ask);
  ok("edge filter: FV below the mid → ask only", rich.ask != null && rich.bid === null && !!rich.off.bid);
  ok("edge filter: FV within the band → no quote", fair.bid === null && fair.ask === null);
  ok("edge filter: no mid → no quote", g({ fv: 0.52, mid: null }).bid === null);
  const moving = g({ fv: 0.52, mid: 0.505, move2s: 0.004 });
  ok("motion gate: FV moving → no quote at all", moving.bid === null && moving.ask === null && moving.steps.some((x) => x.k === "motion"));

  // v2: entries by the de-biased edge (more of it as |net| grows), exits unless the edge is 2¢+ against them
  const v2c = { ...cfg, minEdge: 0.01, maxMove2s: null, policy: "v2" as const, reduceOnlyLeftSec: 60, v2: { exitBlock: 0.02, entryLam: 0.03, debias: true, edgeKeep: 0.005, pairLockMin: null as number | null, signal: "fast" as "fast" | "lead", leadPull: null as number | null } };
  const h = (x: Partial<QuoteIn>) => makeQuote({ ...base, edgeSlow: 0, ...x }, v2c);
  const biased = h({ fv: 0.53, mid: 0.505, edgeSlow: 0.02 });
  ok("v2: a persistent model bias alone opens nothing (v1 would bid)", biased.bid === null && biased.ask === null && g({ fv: 0.53, mid: 0.505 }).bid != null);
  const fresh = h({ fv: 0.52, mid: 0.505 });
  ok("v2: flat, fast edge +1.5¢ → Up bid only", fresh.bid != null && fresh.ask === null && fresh.policy === "v2");
  const l50 = h({ net: 50, fv: 0.52, mid: 0.505 });
  ok("v2: long 50, edge +1.5¢: adding needs +2.5¢, the Down bid exits", l50.bid === null && l50.ask != null && l50.askSize === 25 && /needs ≥ \+2\.5¢/.test(l50.off.bid ?? ""), JSON.stringify([l50.bid, l50.ask, l50.off.bid]));
  const l12 = h({ net: 12, fv: 0.52, mid: 0.505 });
  ok("v2: an exit is cut to the position (flattens, never flips)", l12.bid != null && l12.ask != null && l12.askSize === 12, JSON.stringify([l12.bidSize, l12.askSize]));
  const hold = h({ net: 50, fv: 0.535, mid: 0.505 });
  ok("v2: exit held while the edge is 2¢+ against it", hold.ask === null && /exit held/.test(hold.off.ask ?? "") && hold.bid != null &&
    hold.steps.some((x) => x.k === "edge" && x.v.includes("Down bid exit held")));
  const strong = h({ net: 50, fv: 0.48, mid: 0.505 });
  ok("v2: a reducing side reads as an exit even when it clears the adding test", strong.ask != null && strong.askSize === 25 &&
    strong.steps.some((x) => x.k === "edge" && x.v.includes("Down bid exit")), strong.steps.find((x) => x.k === "edge")?.v ?? "");
  const s50 = h({ net: -50, fv: 0.49, mid: 0.505 });
  ok("v2: short 50 mirrors: the Up bid exits, no more Down", s50.bid != null && s50.ask === null && s50.bidSize === 25);
  const ro2 = h({ left: 40, net: 20, fv: 0.535, mid: 0.505 });
  ok("v2 reduce-only (from 60 s): the exit needs no edge; v1 still blocks it", ro2.bid === null && ro2.ask != null && ro2.askSize === 20 &&
    g({ left: 20, net: 20, fv: 0.535, mid: 0.505 }).ask === null, JSON.stringify([ro2.bid, ro2.ask, ro2.askSize]));
  const tiny = h({ net: 3, fv: 0.52, mid: 0.505 });
  ok("v2: an exit under the minimum size is dropped", tiny.ask === null && /under the 5 minimum/.test(tiny.off.ask ?? ""), tiny.off.ask ?? "");
  ok("v2 dead band: a working side stays on at +0.7¢, a new one needs +1¢",
    h({ fv: 0.512, mid: 0.505, working: { bid: true, ask: false } }).bid != null && h({ fv: 0.512, mid: 0.505 }).bid === null);
  const touch = makeQuote({ ...base, center: 0.495, bestBid: 0.49, bestAsk: 0.5 }, { ...cfg, halfSpread: 0.005 });
  ok("half spread 0.5¢ joins both bests of a 1¢ book (1¢ sat a tick behind)", touch.bid === 0.49 && touch.ask === 0.5 &&
    q({ center: 0.495, bestBid: 0.49, bestAsk: 0.5 }).bid === 0.48, JSON.stringify([touch.bid, touch.ask]));
  // pair-lock: the other token's bid priced to lock ≥ 5¢ a pair against the held average cost
  const pc = { ...v2c, v2: { ...v2c.v2, pairLockMin: 0.05 } };
  const hp = (x: Partial<QuoteIn>) => makeQuote({ ...base, edgeSlow: 0, ...x }, pc);
  const rest = hp({ net: 25, heldAvg: 0.56, center: 0.555, bestBid: 0.55, bestAsk: 0.56, fv: 0.6, mid: 0.555, move2s: 0.01 });
  ok("pair-lock: 25 Up @ 56¢ rests a Down bid at 39¢ (locks 5¢) despite edge and pull; the Up bid still adds",
    rest.ask === 0.61 && rest.askSize === 25 && rest.bid != null && rest.steps.some((x) => x.k === "pair" && x.v.includes("resting")),
    JSON.stringify([rest.bid, rest.ask, rest.askSize]));
  const run = hp({ net: 25, heldAvg: 0.56, center: 0.745, bestBid: 0.74, bestAsk: 0.75, fv: 0.745, mid: 0.745 });
  ok("pair-lock: Up ran to 75¢ → Down bid 25 @ 25¢ at the best price locks 19¢ (pair 81¢)",
    run.ask === 0.75 && run.askSize === 25 && run.steps.some((x) => x.k === "pair" && x.v.includes("+19.00¢") && x.v.includes("at the best price")),
    run.steps.find((x) => x.k === "pair")?.v ?? "");
  const dnHeld = hp({ net: -30, heldAvg: 0.4, center: 0.505, bestBid: 0.5, bestAsk: 0.51, fv: 0.505, mid: 0.505 });
  ok("pair-lock long Down: 30 Down @ 40¢ → Up bid 30 @ 50¢ locks 10¢", dnHeld.bid === 0.5 && dnHeld.bidSize === 30 && dnHeld.ask === null,
    JSON.stringify([dnHeld.bid, dnHeld.bidSize, dnHeld.ask]));
  const roPair = hp({ left: 40, net: 25, heldAvg: 0.56, center: 0.555, bestBid: 0.55, bestAsk: 0.56, fv: 0.6, mid: 0.555 });
  ok("pair-lock gives way to reduce-only: the last 60 s flatten at the quote target, lock or not", roPair.ask === 0.57 && roPair.askSize === 25 && !roPair.steps.some((x) => x.k === "pair"),
    JSON.stringify([roPair.ask, roPair.askSize]));
  const noPair = h({ net: 25, heldAvg: 0.56, center: 0.555, bestBid: 0.55, bestAsk: 0.56, fv: 0.6, mid: 0.555 });
  ok("MM_PAIR_LOCK_MIN=off keeps the v2 exit rules (exit held)", noPair.ask === null && /exit held/.test(noPair.off.ask ?? ""));
  ok("pair-lock skips a position under the minimum size", !hp({ net: 3, heldAvg: 0.56, bestBid: 0.55, bestAsk: 0.56, fv: 0.6, mid: 0.555 }).steps.some((x) => x.k === "pair"));
  // v3: follow the market, add only when the model moved first (the anchored lead); pull the side a lead runs into
  const v3c = { ...v2c, policy: "v3" as const, v2: { ...v2c.v2, pairLockMin: 0.05, signal: "lead" as const, leadPull: 0.005 } };
  const h3 = (x: Partial<QuoteIn>) => makeQuote({ ...base, edgeSlow: 0, ...x }, v3c);
  const calm = h3({ fv: 0.6, mid: 0.5, lead: 0.003 });
  ok("v3: no lead → nothing added, even with the model 10¢ over the mid", calm.bid === null && calm.ask === null && calm.policy === "v3");
  ok("v3: no lead at all (book not good) → nothing added", h3({ fv: 0.6, mid: 0.5, lead: null }).bid === null);
  const upLead = h3({ fv: 0.5, mid: 0.5, lead: 0.012 });
  ok("v3: lead +1.2¢ → the Up bid adds; the Down bid is pulled by the lead", upLead.bid != null && upLead.ask === null && /moved first/.test(upLead.off.ask ?? ""),
    JSON.stringify([upLead.bid, upLead.ask, upLead.off.ask]));
  const dnLead = h3({ fv: 0.5, mid: 0.5, lead: -0.015 });
  const offAlready = h3({ fv: 0.5, mid: 0.5, lead: 0.03, move2s: 0.01 });
  ok("v3: a big lead with the Down bid already pulled says so (not 'under')", offAlready.steps.some((x) => x.k === "lead pull" && x.v.includes("already off")),
    offAlready.steps.find((x) => x.k === "lead pull")?.v ?? "");
  ok("v3: lead −1.5¢ → the Down bid adds; the Up bid is pulled", dnLead.ask != null && dnLead.bid === null && /moved first/.test(dnLead.off.bid ?? ""));
  const keptThenPulled = h3({ fv: 0.5, mid: 0.5, lead: -0.006, working: { bid: true, ask: false } });
  ok("v3: a lead of 0.6¢ against a working Up bid pulls it", keptThenPulled.bid === null && /moved first/.test(keptThenPulled.off.bid ?? ""));
  const pairV3 = h3({ net: 25, heldAvg: 0.56, center: 0.555, bestBid: 0.55, bestAsk: 0.56, fv: 0.555, mid: 0.555, lead: 0.02 });
  ok("v3: the pair-lock ignores the lead pull (Down bid rests at 39¢)", pairV3.ask === 0.61 && pairV3.askSize === 25, JSON.stringify([pairV3.bid, pairV3.ask]));
  ok("v3: quoteCfg trades the lead with its pull; v2 keeps the fast edge",
    quoteCfg("v3").v2?.signal === "lead" && quoteCfg("v3").v2?.leadPull === CFG.leadPull && quoteCfg("v2").v2?.signal === "fast" && quoteCfg("v2").v2?.leadPull === null);
  ok("v3: tag", quoteTag("v3", { ...CFG, tolerateTicks: 1, stayAtTouch: true, pairLockMin: 0.05 }) === "v3+queue+pair" && policyFor(1791545700, "v3") === "v3");
  ok("A/B: even 5-minute slots run v2, odd v1", policyFor(1791545400, "ab") === "v2" && policyFor(1791545700, "ab") === "v1" && policyFor(1791545700, "v2") === "v2");
  ok("quoteCfg: v1 has no v2 rules, v2 reduce-only from its own knob", quoteCfg("v1").v2 === null && quoteCfg("v2").reduceOnlyLeftSec === CFG.v2ReduceOnlyLeftSec && quoteCfg("v2").v2?.exitBlock === CFG.exitBlock);
}

// 7b. v4 (norm1e69): both tokens bid at the touch, no edge / motion / pull, inventory skew, quotes 5 s → T−30 s
{
  const v4c = quoteCfg("v4", { ...CFG, halfSpread: 0.005, orderSize: 25, maxPosition: 100, skewAtMax: 0.02, v4FromSec: 5, v4QuoteUntilLeftSec: 30 });
  const base4: QuoteIn = { center: 0.505, centerSrc: "test", move2s: 0, elapsed: 100, left: 200, tick: 0.01, minSize: 5, bookReady: true, bestBid: 0.5, bestAsk: 0.51, net: 0, fv: 0.505, mid: 0.505 };
  const q4 = (x: Partial<QuoteIn>) => makeQuote({ ...base4, ...x }, v4c);
  const flat = q4({});
  ok("v4: flat → an Up bid at the best Up bid and a Down bid at the best Down bid", flat.bid === 0.5 && flat.ask === 0.51 && flat.bidSize === 25 && flat.askSize === 25 && flat.policy === "v4",
    JSON.stringify([flat.bid, flat.ask]));
  const moving = q4({ move2s: 0.02, fv: 0.6 });
  ok("v4: no edge filter, motion gate or pull: a 2¢ FV move with FV 10¢ off the mid still quotes both", moving.bid === 0.5 && moving.ask === 0.51, JSON.stringify([moving.bid, moving.ask]));
  const long = q4({ net: 50 }), short = q4({ net: -50 });
  ok("v4: long 50 → the Up bid steps a tick back, the Down bid stays at the touch", long.bid === 0.49 && long.ask === 0.51, JSON.stringify([long.bid, long.ask]));
  ok("v4: short 50 → the Down bid steps back", short.bid === 0.5 && short.ask === 0.52, JSON.stringify([short.bid, short.ask]));
  ok("v4: quotes from 5 s after the open", q4({ elapsed: 4 }).bid === null && q4({ elapsed: 6 }).bid === 0.5);
  const late = q4({ left: 25, net: 20 }), before = q4({ left: 35, net: 20 });
  ok("v4: makers stop 30 s before the close, with no reduce-only phase before it", late.bid === null && late.ask === null && before.bid != null && before.bidSize === 25,
    JSON.stringify([before.bid, before.bidSize]));
  const takes = { v4FlowImb: 0.7, v4RebalNet: 60 };   // both takes on, whatever .env says
  const g0 = { guard: { ...CFG.guard, whipTv: null, gammaPull: null, jumpBps: null, invStopNet: null, capVolTv: null },   // no guard rule and
    xs: { ...CFG.xs, edge: null, jumpBps: null, lateSec: null, stopLoss: null },                                             // no excess take, whatever .env says
    raceInflight: false };                                                                                                  // no +rif unless a case sets it (.env has it on)
  ok("v4: tag", quoteTag("v4", { ...CFG, ...g0, ...takes, tolerateTicks: 1, stayAtTouch: true, raceLevel: 0.5, raceShare: 0.2, raceOutbid: false }) === "v4+queue+take+race" &&
    quoteTag("v4", { ...CFG, ...g0, ...takes, tolerateTicks: 1, stayAtTouch: true, raceLevel: 0.5, raceShare: 0.2, raceOutbid: false, raceInflight: true }) === "v4+queue+take+race+rif" &&
    quoteTag("v4", { ...CFG, ...g0, ...takes, tolerateTicks: 1, stayAtTouch: true, raceLevel: null, raceShare: null, raceOutbid: false, raceInflight: true }) === "v4+queue+take" &&
    quoteTag("v4", { ...CFG, ...g0, ...takes, tolerateTicks: 1, stayAtTouch: true, raceLevel: 0.5, raceShare: 0.2, raceOutbid: true }) === "v4+queue+take+race+outbid" &&
    quoteTag("v4", { ...CFG, ...g0, ...takes, v4RebalNet: null, tolerateTicks: 1, stayAtTouch: true, raceLevel: 0.5, raceShare: 0.2, raceOutbid: true }) === "v4+queue+flow+race+outbid" &&
    quoteTag("v4", { ...CFG, ...g0, tolerateTicks: 1, stayAtTouch: true, v4FlowImb: null, v4RebalNet: null, raceLevel: null, raceShare: null, raceOutbid: false }) === "v4+queue" &&
    quoteTag("v3", { ...CFG, ...g0, tolerateTicks: 1, stayAtTouch: true, pairLockMin: 0.05, raceLevel: 0.5 }) === "v3+queue+pair" && policyFor(1791545700, "v4") === "v4");
  ok("v4: tag +cap<N> when the cap counts orders still cancelling (MM_CAP_PENDING)",
    quoteTag("v4", { ...CFG, ...g0, v4FlowImb: null, v4RebalNet: null, tolerateTicks: 1, stayAtTouch: true, raceLevel: 0.5, raceShare: 0.2, raceOutbid: false, capPending: true, maxPosition: 20 }) === "v4+queue+race+cap20");
}

// 7c. v4 takes: rebalance first, then order flow under the fair-value veto; gates; sizing; the bid a take crosses is pulled
{
  const tc: TakeCfg = { fromSec: 5, untilLeftSec: 60, flowImb: 0.5, flowThin: 150, fvSlack: 0.01, rebalNet: 60, flowCooldownMs: 10_000, orderSize: 50, maxPosition: 100 };
  const tb: TakeIn = { elapsed: 100, left: 200, minSize: 5, good: true, bestBid: 0.5, bestAsk: 0.51, bidSz: 300, askSz: 300, net: 0, center: 0.505, free: 1000, busy: false, sinceFlowMs: null };
  const d = (x: Partial<TakeIn>, c = tc) => decideTake({ ...tb, ...x }, c);
  ok("take: a balanced book takes nothing", d({}).take === null);
  const up = d({ bidSz: 800, askSz: 90 }).take;
  ok("take flow: Up bid 800 over a thin 90-share ask → lift 50 Up at 51¢", up?.token === "UP" && up.price === 0.51 && up.size === 50 && up.kind === "flow", JSON.stringify(up));
  const dn = d({ bidSz: 40, askSz: 700 }).take;
  ok("take flow: mirrored: Up ask 700 over Up bid 40 → lift the 40 Down at 50¢", dn?.token === "DOWN" && dn.price === 0.5 && dn.size === 40, JSON.stringify(dn));
  ok("take flow: an ask of 400 sh is not thin", d({ bidSz: 2000, askSz: 400 }).take === null);
  ok("take flow: FV more than 1¢ under the ask vetoes it, within 1¢ does not",
    d({ bidSz: 800, askSz: 90, center: 0.495 }).take === null && d({ bidSz: 800, askSz: 90, center: 0.5 }).take?.token === "UP");
  ok("take flow: no FV, no take", d({ bidSz: 800, askSz: 90, center: null }).take === null);
  const near = d({ bidSz: 800, askSz: 90, net: 40 }).take, red = d({ bidSz: 40, askSz: 700, net: 40 }).take;
  ok("take flow: an adding take keeps |net| under the rebalance threshold (net +40 → 19 Up)", near?.size === 19, JSON.stringify(near));
  ok("take flow: a reducing take is not cut by it (net +40 → all 40 Down)", red?.token === "DOWN" && red.size === 40, JSON.stringify(red));
  const rb = d({ net: 70, bidSz: 800, askSz: 90 }).take, rbUp = d({ net: -65 }).take;
  ok("take rebalance: net +70 → 70 Down at its 50¢ ask, ahead of the Up flow", rb?.token === "DOWN" && rb.price === 0.5 && rb.size === 70 && rb.kind === "rebalance", JSON.stringify(rb));
  ok("take rebalance: net −65 → 65 Up at 51¢", rbUp?.token === "UP" && rbUp.size === 65 && rbUp.price === 0.51, JSON.stringify(rbUp));
  ok("take gates: none in the first 5 s or the last 60 s", d({ net: 70, elapsed: 4 }).take === null && d({ net: 70, left: 59 }).take === null && d({ net: 70, left: 61 }).take != null);
  ok("take gates: one in flight at a time, rebalance or flow", d({ net: 70, busy: true }).take === null && d({ bidSz: 800, askSz: 90, busy: true }).take === null);
  ok("take flow: 10 s between flow takes; a rebalance does not wait for it",
    d({ bidSz: 800, askSz: 90, sinceFlowMs: 9000 }).take === null && d({ bidSz: 800, askSz: 90, sinceFlowMs: 10_500 }).take?.kind === "flow" && d({ net: 70, sinceFlowMs: 1000 }).take?.kind === "rebalance");
  ok("take gates: no good book, no take", d({ net: 70, good: false }).take === null);
  ok("take: an ask over 95¢ is left alone", d({ bestBid: 0.96, bestAsk: 0.97, bidSz: 800, askSz: 90, center: 0.965 }).take === null);
  ok("take: cut to what the free balance pays, fee included ($10 → 19 at 50¢)", d({ net: 70, free: 10 }).take?.size === 19, JSON.stringify(d({ net: 70, free: 10 }).take));
  ok("take: both kinds off → nothing", d({ net: 70, bidSz: 800, askSz: 90 }, { ...tc, flowImb: null, rebalNet: null }).take === null);
  ok("takeCfg reads the v4 knobs", takeCfg({ ...CFG, v4FlowImb: 0.7 }).flowImb === 0.7 && takeCfg({ ...CFG, v4RebalNet: null }).rebalNet === null);

  const qv = makeQuote({ center: 0.505, centerSrc: "t", move2s: 0, elapsed: 100, left: 200, tick: 0.01, minSize: 5, bookReady: true, bestBid: 0.5, bestAsk: 0.51, net: 0, fv: 0.505, mid: 0.505 }, quoteCfg("v4"));
  const pu = applyTake(qv, "UP", [{ k: "flow", v: "x", s: "ok" }]), last = pu.steps[pu.steps.length - 1];
  ok("applyTake: an Up take pulls our Down bid (the Up ask it lifts) and restates the target", pu.ask === null && pu.askSize === 0 && pu.bid === 0.5 &&
    /our Up take/.test(pu.off.ask ?? "") && last.k === "target" && /no Down bid/.test(last.v) && pu.steps.some((s) => s.k === "flow"), JSON.stringify(last));
  const pd = applyTake(qv, "DOWN", []);
  ok("applyTake: a Down take pulls our Up bid", pd.bid === null && pd.ask === 0.51 && qv.bid === 0.5);
  const pn = applyTake(qv, null, []);
  ok("applyTake: no take leaves the quote as it was", pn.bid === 0.5 && pn.ask === 0.51 && pn.steps.filter((s) => s.k === "target").length === 1);
}

// 7d. the certainty maker (MM_POLICY=cert, "v5" until 2026-10-22): only the near-certain token, at E[V | a sell] − edge, late in the window, sized by the flip budget
{
  const c5: CertCfg = { fromLeftSec: 120, untilLeftSec: 1, minP: 0.99, pCap: 0.999, kappa: 1.5, minEdge: 0.003, improveTicks: 1, pull: 0.002,
    orderSize: 100, maxPos: 200, flipBudget: 0.4 };
  const b5: CertIn = { fv: 0.9995, fva: 0.999, move2s: 0, elapsed: 250, left: 50, tick: 0.001, minSize: 5, bookReady: true, bestBid: 0.99, bestAsk: null, net: 0 };
  const q5 = (x: Partial<CertIn>, c = c5) => makeQuoteCert({ ...b5, ...x }, c);
  const near = (a: number | null, b: number) => a != null && Math.abs(a - b) < 1e-9;
  const up = q5({});
  ok("cert: Up at 99.9¢ (the lower FV) → E[V | sell] 99.75¢, bid capped a tick over the 99¢ best bid: 100 Up @ 99.1¢, no Down bid",
    up.policy === "cert" && near(up.bid, 0.991) && up.bidSize === 100 && up.ask === null && near(up.reservation, 0.9975) && near(up.center, 0.999), JSON.stringify([up.bid, up.bidSize, up.reservation]));
  ok("cert: p is capped at 99.9¢: model 100¢ still prices at E[V | sell] 99.75¢", near(q5({ fv: 1, fva: 1 }).reservation, 0.9975));
  ok("cert: quotes only from 120 s to 1 s before the close", q5({ left: 121 }).bid === null && q5({ left: 119 }).bid != null && q5({ left: 0.5 }).bid === null && q5({ left: 1.5 }).bid != null);
  ok("cert: the two FVs disagree on the favourite → nothing", q5({ fv: 0.6, fva: 0.4 }).bid === null && q5({ fv: 0.6, fva: 0.4 }).ask === null);
  ok("cert: the lower FV under 99¢ → nothing; needs both FVs", q5({ fv: 0.995, fva: 0.985 }).bid === null && q5({ fva: null }).bid === null && q5({ bookReady: false }).bid === null);
  const p99 = q5({ fv: 0.995, fva: 0.99 });
  ok("cert: p 99¢ → E[V | sell] 97.5¢, bid 97.2¢ rests behind the 99¢ book; the flip budget cuts it to 41 sh",
    near(p99.bid, 0.972) && p99.bidSize === 41 && p99.steps.some((s) => s.k === "touch" && s.s === "warn"), JSON.stringify([p99.bid, p99.bidSize]));
  const dn = q5({ fv: 0.0005, fva: 0.001, bestBid: null, bestAsk: 0.01 });
  ok("cert: a Down favourite is the ask in Up terms: a Down bid @ 99.1¢ (Up ask 0.9¢), no Up bid",
    near(dn.ask, 0.009) && dn.askSize === 100 && dn.bid === null && near(dn.reservation, 0.0025) && near(dn.center, 0.001), JSON.stringify([dn.ask, dn.reservation]));
  ok("cert: post-only: a tick under the favourite's best ask", near(q5({ bestAsk: 0.991 }).bid, 0.99) && near(q5({ fv: 0.0005, fva: 0.001, bestBid: 0.009, bestAsk: 0.01 }).ask, 0.01));
  ok("cert: joins when E[V | sell] only reaches the best bid; alone on an empty side it bids E[V | sell] − edge",
    near(q5({ bestBid: 0.994 }).bid, 0.994) && near(q5({ bestBid: null }).bid, 0.994));
  ok("cert: on a 1¢ tick the bid floors to 99¢", near(q5({ tick: 0.01, bestBid: 0.98 }).bid, 0.99));
  ok("cert speed bump: the favourite's FV falling 0.2¢ in 2 s pulls the bid; a rise or a smaller fall does not",
    q5({ move2s: -0.002 }).bid === null && q5({ move2s: -0.0015 }).bid != null && q5({ move2s: 0.01 }).bid != null &&
    q5({ fv: 0.0005, fva: 0.001, bestBid: null, bestAsk: 0.01, move2s: 0.002 }).ask === null && q5({}, { ...c5, pull: null, }).bid != null);
  ok("cert: holding 150 Up → 50 more; 198 → under the minimum, nothing; holding Down does not limit an Up bid",
    q5({ net: 150 }).bidSize === 50 && q5({ net: 198 }).bid === null && q5({ net: -100 }).bidSize === 100);
  ok("liveTick: the feed's tick_size_change, else the listed tick; no price rule",
    liveTick(0.01, { tick: null }) === 0.01 && liveTick(0.01, {}) === 0.01 && liveTick(0.01, { tick: 0.001 }) === 0.001 && liveTick(0.001, { tick: null }) === 0.001);
  {
    const f = new PmBookFeed(() => {});
    f.setTokens(["U", "D"]);
    f.apply(JSON.stringify({ event_type: "book", asset_id: "U", bids: [{ price: "0.99", size: "500" }], asks: [] }), 1);
    const before = f.view("U").tick;
    f.apply(JSON.stringify({ event_type: "tick_size_change", asset_id: "U", old_tick_size: "0.01", new_tick_size: "0.001" }), 2);
    ok("pmBook: tick_size_change sets the token's tick (none before it)", before === null && f.view("U").tick === 0.001 && f.view("D").tick === null);
  }
  ok("cert: tag and config", quoteTag("cert", { ...CFG, tolerateTicks: 1, stayAtTouch: true }) === "cert+queue" && policyFor(1791545700, "cert") === "cert" &&
    certCfg({ ...CFG, certKappa: 2 }).kappa === 2 && certCfg({ ...CFG, certPull: null }).pull === null);

  // the Down bid goes out on the 0.1¢ tick, and a Down taker selling into it fills it via the mirrored tape
  const bk = (bids: [number, number][], asks: [number, number][]): BookView =>
    ({ ready: true, bids, asks, bestBid: bids[0]?.[0] ?? null, bestAsk: asks[0]?.[0] ?? null, ageMs: 0, last: null });
  const ex = new PaperExchange(100, () => {}); ex.setTokens("U", "D");
  const oms = new OrderManager(ex, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  // on the 1¢ grid (no tick_size_change yet) the venue rejects a 99.1¢ bid at its ack
  const exR = new PaperExchange(100, () => {}); exR.setTokens("U", "D");
  const oR = exR.place({ win: 1, token: "DOWN", side: "BUY", price: 0.991, size: 100, reason: "t" }, 0);
  exR.step(150, 1, bk([[0.005, 500]], [[0.01, 800]]), { fv: 0.001, mid: null });
  const oC = exR.place({ win: 1, token: "DOWN", side: "BUY", price: 0.99, size: 100, reason: "t" }, 200);
  exR.step(350, 1, bk([[0.005, 500]], [[0.02, 800]]), { fv: 0.001, mid: null });
  ok("paper exchange: 99.1¢ is off the 1¢ tick → rejected; 99¢ goes live", oR.status === "rejected" && (oC.status === "open"), JSON.stringify([oR.status, oC.status]));
  const a = oms.sync(1, dn, 0, { free: 1000, minSize: 5, tick: 0.001, bestBid: null, bestAsk: null });
  const o = ex.working(1)[0];
  ok("cert → order manager: a Down BUY of 100 @ 99.1¢", a[1].act === "place" && o?.token === "DOWN" && o.tokenSide === "BUY" && o.tokenPrice === 0.991 && o.size === 100, a[1].note);
  const book = { ...bk([[0.005, 500]], [[0.01, 800]]), tick: 0.001 };
  ex.step(150, 1, book, { fv: 0.001, mid: null });
  ex.onPrint({ asset: "D", price: 0.99, size: 40, side: "SELL", rx: 200, ts: 200 });
  const f = ex.step(300, 1, book, { fv: 0.001, mid: null });
  ok("cert fill: a taker selling 40 Down at 99¢ goes through our 99.1¢ Down bid first", f.length === 1 && f[0].token === "DOWN" && f[0].tokenPrice === 0.991 && f[0].size === 40 && f[0].via === "through",
    JSON.stringify(f.map((x) => [x.token, x.tokenPrice, x.size, x.via])));
}

// 10b. order manager queue retention: tolerate a tick inside the reservation, stay at the touch, chase from behind
{
  const B = (bb: number, ba: number): BookView => ({ ready: true, bids: [[bb, 300]], asks: [[ba, 300]], bestBid: bb, bestAsk: ba, ageMs: 0, last: null });
  const m = { fv: 0.5, mid: 0.495 };
  const qt = (bid: number | null, ask: number | null, res: number): Quote =>
    ({ policy: "v2", bid, ask, bidSize: bid == null ? 0 : 25, askSize: ask == null ? 0 : 25, center: res, skew: 0, reservation: res, why: "", off: { bid: bid == null ? "off" : null, ask: ask == null ? "off" : null }, steps: [] });
  const ex = new PaperExchange(100, () => {}); ex.setTokens("U", "D");
  const oms = new OrderManager(ex, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  const c1 = { free: 1000, minSize: 5, tick: 0.01, bestBid: 0.49, bestAsk: 0.5 };
  oms.sync(1, qt(0.49, null, 0.495), 0, c1); ex.step(150, 1, B(0.49, 0.5), m);
  let a = oms.sync(1, qt(0.48, null, 0.4925), 200, c1);
  ok("tolerance: a bid a tick over a lower target, 0.25¢ under the reservation, keeps its spot", a[0].act === "keep", a[0].note);
  a = oms.sync(1, qt(0.48, null, 0.491), 300, c1);
  ok("...and is replaced once the reservation comes within 0.25¢ of it", a[0].act === "replace");
  ex.step(450, 1, B(0.49, 0.5), m);
  a = oms.sync(1, qt(0.49, null, 0.495), 500, c1);
  ok("behind the touch: a better target is held for the queue first", a[0].act === "hold");
  a = oms.sync(1, qt(0.49, null, 0.495), 1500, c1);
  ok("...then chased after MM_REQUOTE_MIN_MS", a[0].act === "replace");
  ex.step(1650, 1, B(0.49, 0.52), m);
  a = oms.sync(1, qt(0.5, null, 0.51), 4000, { ...c1, bestAsk: 0.52 });
  ok("at the best bid: a better target inside the spread is not chased", a[0].act === "keep" && /queue spot/.test(a[0].note), a[0].note);

  const ex2 = new PaperExchange(100, () => {}); ex2.setTokens("U", "D");
  const oms2 = new OrderManager(ex2, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  oms2.sync(1, qt(null, 0.51, 0.505), 0, c1); ex2.step(150, 1, B(0.49, 0.5), m);
  a = oms2.sync(1, qt(null, 0.52, 0.5075), 200, c1);
  ok("tolerance on the Down bid: the Up ask it mirrors a tick under a higher target stays", a[1].act === "keep", a[1].note);
  a = oms2.sync(1, qt(null, 0.52, 0.509), 300, c1);
  ok("...and is replaced once the reservation comes within 0.25¢", a[1].act === "replace");

  // the pair-cost cap (paircost.ts pcLim) is hard: the same tick-over bid inside the reservation is replaced when it is past the cap
  const ex3 = new PaperExchange(100, () => {}); ex3.setTokens("U", "D");
  const oms3 = new OrderManager(ex3, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  oms3.sync(1, qt(0.49, null, 0.495), 0, c1); ex3.step(150, 1, B(0.49, 0.5), m);
  a = oms3.sync(1, { ...qt(0.48, null, 0.4925), pcLim: { bid: 0.48, ask: null, rest: { bid: false, ask: false } } }, 200, c1);
  ok("pc cap: a working Up bid a tick past the pair-cost cap is not tolerated (replaced)", a[0].act === "replace", a[0].note);
}

// 10b1. MM_CAP_PENDING: a replace chain in a sweep — the cancelled bids still fill until their cancels land, so the cap
//       counts them and the new bid gets only the room they leave
{
  const B = (bb: number, ba: number): BookView => ({ ready: true, bids: [[bb, 300]], asks: [[ba, 300]], bestBid: bb, bestAsk: ba, ageMs: 0, last: null });
  const qt = (bid: number): Quote =>
    ({ policy: "v4", bid, ask: null, bidSize: 10, askSize: 0, center: bid + 0.005, skew: 0, reservation: bid + 0.005, why: "", off: { bid: null, ask: "off" }, steps: [] });
  const run = (cap: { net: number; max: number } | null) => {
    const ex = new PaperExchange(100, () => {}); ex.setTokens("U", "D");
    const oms = new OrderManager(ex, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
    const c = { free: 1000, minSize: 5, tick: 0.01, bestBid: 0.49, bestAsk: 0.5, cap };
    oms.sync(1, qt(0.49), 0, c); ex.step(150, 1, B(0.49, 0.5), { fv: 0.5, mid: 0.495 });
    const a1 = oms.sync(1, qt(0.47), 200, c);
    const s1 = ex.working(1).map((o) => o.size - o.filled), why1 = ex.working(1)[1]?.reason ?? "";
    const a2 = oms.sync(1, qt(0.45), 210, c);
    return { a1, a2, s1, why1, s2: ex.working(1).map((o) => o.size - o.filled) };
  };
  const on = run({ net: 35, max: 50 }), off = run(null);
  ok("cap counts cancelling orders: net 35 of 50, a 10 bid replaced while its cancel is in flight → the new one is 5",
    on.a1[0].act === "replace" && JSON.stringify(on.s1) === "[10,5]" && /cut from 10 by the cap \(10 sh still working\)/.test(on.why1), JSON.stringify([on.s1, on.why1]));
  ok("...and the next replace sends nothing (10 + 5 still working fill the 15 of room)",
    on.a2[0].act === "replace" && /nothing \(cap: 15 sh still working/.test(on.a2[0].note) && JSON.stringify(on.s2) === "[10,5]", JSON.stringify([on.s2, on.a2[0].note]));
  ok("...without it (MM_CAP_PENDING off) the chain keeps three 10-share bids working: 30 against 15 of room",
    JSON.stringify(off.s2) === "[10,10,10]", JSON.stringify(off.s2));
}

// 10b2. queue race (v4): a bid that joined an existing level leaves when the level thins or the other side outweighs it
{
  const bk = (bids: [number, number][], asks: [number, number][]): BookView =>
    ({ ready: true, bids, asks, bestBid: bids[0]?.[0] ?? null, bestAsk: asks[0]?.[0] ?? null, ageMs: 0, last: null });
  const m = { fv: 0.5, mid: 0.505 };
  const race = { level: 0.5, share: 0.2, holdMs: 1000 };
  const qb: Quote = { policy: "v4", bid: 0.5, ask: null, bidSize: 25, askSize: 0, center: 0.505, skew: 0, reservation: 0.505, why: "", off: { bid: null, ask: "off" }, steps: [] };
  const ex = new PaperExchange(100, () => {}); ex.setTokens("U", "D");
  const oms = new OrderManager(ex, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  const ctx = (book: BookView) => ({ free: 1000, minSize: 5, tick: 0.01, bestBid: book.bestBid, bestAsk: book.bestAsk, book, race });
  const b0 = bk([[0.5, 300]], [[0.51, 300]]);
  oms.sync(1, qb, 0, ctx(b0)); ex.step(150, 1, b0, m);
  const o = ex.working(1)[0];
  let a = oms.sync(1, qb, 200, ctx(bk([[0.5, 200]], [[0.51, 300]])));
  ok("race: a bid that joined 300 sh stays while the level holds 200 and its side 0.4 of the touch", o.queue0 === 300 && a[0].act === "keep", a[0].note);
  a = oms.sync(1, qb, 300, ctx(bk([[0.5, 140]], [[0.51, 300]])));
  ok("race: the level fell under 50% of 300 → cancelled", a[0].act === "cancel" && /race: the level fell to 140/.test(a[0].note) && o.status === "cancelling", a[0].note);
  ex.step(450, 1, bk([[0.5, 140]], [[0.51, 300]]), m);
  a = oms.sync(1, qb, 900, ctx(bk([[0.5, 140]], [[0.51, 300]])));
  ok("race: no rejoin at 50¢ within the 1 s hold", a[0].act === "idle" && /race hold/.test(a[0].note) && ex.working(1).length === 0, a[0].note);
  a = oms.sync(1, qb, 1400, ctx(bk([[0.5, 140]], [[0.51, 300]])));
  ok("race: after the hold it rejoins (its side holds 0.32 of the touch)", a[0].act === "place", a[0].note);

  const ex2 = new PaperExchange(100, () => {}); ex2.setTokens("U", "D");
  const oms2 = new OrderManager(ex2, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  a = oms2.sync(1, qb, 0, ctx(bk([[0.5, 100]], [[0.51, 600]])));
  ok("race: no new bid joins a level holding 0.14 of the touch", a[0].act === "idle" && /0.14 of the touch/.test(a[0].note), a[0].note);
  const b1 = bk([[0.5, 300]], [[0.51, 300]]);
  oms2.sync(1, qb, 100, ctx(b1)); ex2.step(250, 1, b1, m);
  a = oms2.sync(1, qb, 300, ctx(bk([[0.5, 300]], [[0.51, 1300]])));
  ok("race: the other side swelling to 1,300 against 300 (0.19) cancels it", a[0].act === "cancel" && /0.19 of the touch/.test(a[0].note), a[0].note);

  // depth cap (MM_JOIN_MAX_SH): no joining a level that already holds ≥ the cap; a new best (empty level) still goes
  const capCtx = (book: BookView) => ({ ...ctx(book), race: { ...race, joinMax: 500 } });
  const exd = new PaperExchange(100, () => {}); exd.setTokens("U", "D");
  const omd = new OrderManager(exd, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  a = omd.sync(1, qb, 0, capCtx(bk([[0.5, 600]], [[0.51, 600]])));
  ok("depth cap 500: no new bid joins a 600 sh level", a[0].act === "idle" && /depth: that level holds 600 sh, at or over the 500 cap/.test(a[0].note), a[0].note);
  a = omd.sync(1, qb, 100, capCtx(bk([[0.5, 499]], [[0.51, 600]])));
  ok("depth cap 500: a 499 sh level is joined", a[0].act === "place", a[0].note);
  const exe = new PaperExchange(100, () => {}); exe.setTokens("U", "D");
  const ome = new OrderManager(exe, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  a = ome.sync(1, qb, 0, capCtx(bk([[0.49, 5000]], [[0.51, 600]])));
  ok("depth cap 500: a bid that makes its own level at 50¢ goes in (5,000 sh at 49¢ don't count)", a[0].act === "place", a[0].note);
  // adaptive depth cap (MM_JOIN_MAX_REL 1.5): the cap follows the median best bid size of the last 30 s
  const relCtx = (book: BookView) => ({ ...ctx(book), race: { ...race, joinRel: 1.5, joinRefMs: 30_000 } });
  const exr = new PaperExchange(100, () => {}); exr.setTokens("U", "D");
  const omr = new OrderManager(exr, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  const qOff: Quote = { ...qb, bid: null, bidSize: 0, off: { bid: "off", ask: "off" } };
  omr.sync(1, qOff, 0, relCtx(bk([[0.5, 100]], [[0.51, 600]])));
  omr.sync(1, qOff, 1000, relCtx(bk([[0.5, 120]], [[0.51, 600]])));
  a = omr.sync(1, qb, 2000, relCtx(bk([[0.5, 200]], [[0.51, 600]])));
  ok("adaptive cap 1.5: best bid sizes 100 / 120 / 200 (median 120 → cap 180) → no joining the 200 sh level",
    a[0].act === "idle" && /depth: that level holds 200 sh, at or over 1.5 × the 120 sh median/.test(a[0].note), a[0].note);
  a = omr.sync(1, qb, 40_000, relCtx(bk([[0.5, 200]], [[0.51, 600]])));
  ok("adaptive cap 1.5: 30 s later only the 200 sh sample is left (cap 300) → it joins", a[0].act === "place", a[0].note);
  const exs = new PaperExchange(100, () => {}); exs.setTokens("U", "D");
  const oms5 = new OrderManager(exs, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  const qDn: Quote = { ...qb, bid: null, bidSize: 0, ask: 0.51, askSize: 25, off: { bid: "off", ask: null } };
  oms5.sync(1, qOff, 0, relCtx(bk([[0.5, 2000]], [[0.51, 400]])));
  oms5.sync(1, qOff, 500, relCtx(bk([[0.5, 2000]], [[0.51, 410]])));
  a = oms5.sync(1, qDn, 1000, relCtx(bk([[0.5, 2000]], [[0.51, 900]])));
  ok("adaptive cap: a Down bid (Up ask 51¢) is measured on the Up asks: 400 / 410 / 900 → median 410, cap 615 → no joining 900",
    a[1].act === "idle" && /holds 900 sh, at or over 1.5 × the 410 sh median/.test(a[1].note), JSON.stringify(a));
  a = oms5.sync(1, qDn, 1500, relCtx(bk([[0.5, 2000]], [[0.51, 600]])));
  ok("adaptive cap: ...and joins the level once it is 600 (the 2,000 sh Up bids don't count)", a[1].act === "place", JSON.stringify(a));
  ok("adaptive cap: tag +jrel150 (+w60 off the 30 s default)", quoteTag("v5", { ...CFG, joinRel: 1.5 }).includes("+jrel150") &&
    quoteTag("v5", { ...CFG, joinRel: 1.5, joinRefMs: 60_000 }).includes("+jrel150w60") && (CFG.joinRel != null || !quoteTag("v5", CFG).includes("+jrel")));
  ok("depth cap: tag +jmax500, none by default", quoteTag("v5", { ...CFG, joinMaxSh: 500 }).includes("+jmax500") && (CFG.joinMaxSh != null || !quoteTag("v5", CFG).includes("+jmax")));

  // a bid that made its own level (nothing there when it went live) is left to the quoter
  const ex3 = new PaperExchange(100, () => {}); ex3.setTokens("U", "D");
  const oms3 = new OrderManager(ex3, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  const b2 = bk([[0.49, 300]], [[0.51, 900]]);
  oms3.sync(1, qb, 0, ctx(b2)); ex3.step(150, 1, b2, m);
  a = oms3.sync(1, qb, 200, ctx(b2));
  ok("race: a bid alone at its own 50¢ level is not race-cancelled", ex3.working(1)[0]?.queue0 === 0 && a[0].act === "keep", a[0].note);
  // no race settings (other policies): nothing changes
  const ex4 = new PaperExchange(100, () => {}); ex4.setTokens("U", "D");
  const oms4 = new OrderManager(ex4, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  a = oms4.sync(1, qb, 0, { ...ctx(bk([[0.5, 100]], [[0.51, 600]])), race: null });
  ok("race: off without settings", a[0].act === "place");

  // MM_RACE_ON_BOOK (orderManager.raceOnly): a book update alone, between decisions, runs the same two exits
  const exRob5 = new PaperExchange(100, () => {}); exRob5.setTokens("U", "D");
  const omsRob5 = new OrderManager(exRob5, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  const b5 = bk([[0.5, 300]], [[0.51, 300]]);
  omsRob5.sync(1, qb, 0, ctx(b5));
  ok("race on book: an order still in flight is not raceable (no liveAt yet)", !omsRob5.raceable(1) && omsRob5.raceOnly(1, 50, bk([[0.5, 10]], [[0.51, 300]]), race).length === 0);
  exRob5.step(150, 1, b5, m);
  const oRob5 = exRob5.working(1)[0];
  ok("race on book: a live bid that joined 300 sh is raceable; a book that still holds it cancels nothing",
    omsRob5.raceable(1) && omsRob5.raceOnly(1, 160, bk([[0.5, 200]], [[0.51, 300]]), race).length === 0 && oRob5.status === "open");
  let rRob5 = omsRob5.raceOnly(1, 170, bk([[0.5, 140]], [[0.51, 300]]), race);
  ok("race on book: the level falling to 140 cancels it at once, without a sync, and says so",
    rRob5.length === 1 && rRob5[0].act === "cancel" && rRob5[0].side === "up" && /race: the level fell to 140 .* on a book update/.test(rRob5[0].note) && oRob5.status === "cancelling" && oRob5.cancelAt === 170, rRob5[0]?.note);
  ok("race on book: it places nothing, and the cancelling order is no longer raceable", exRob5.working(1).length === 1 && !omsRob5.raceable(1));
  exRob5.step(400, 1, bk([[0.5, 140]], [[0.51, 300]]), m);
  a = omsRob5.sync(1, qb, 900, ctx(bk([[0.5, 140]], [[0.51, 300]])));
  ok("race on book: the next decision keeps the 1 s rejoin hold it set", a[0].act === "idle" && /race hold/.test(a[0].note), a[0].note);
  const exRob6 = new PaperExchange(100, () => {}); exRob6.setTokens("U", "D");
  const omsRob6 = new OrderManager(exRob6, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  omsRob6.sync(1, qb, 0, ctx(b5)); exRob6.step(150, 1, b5, m);
  rRob5 = omsRob6.raceOnly(1, 200, bk([[0.5, 300]], [[0.51, 1300]]), race);
  ok("race on book: the other side swelling to 1,300 (0.19 of the touch) cancels it too", rRob5.length === 1 && /0.19 of the touch/.test(rRob5[0].note), rRob5[0]?.note);
  ok("race on book: a book not ready decides nothing", omsRob6.raceOnly(1, 210, { ...bk([[0.5, 1]], [[0.51, 300]]), ready: false }, race).length === 0);
  const exRob7 = new PaperExchange(100, () => {}); exRob7.setTokens("U", "D");
  const omsRob7 = new OrderManager(exRob7, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
  omsRob7.sync(1, qb, 0, ctx(b2)); exRob7.step(150, 1, b2, m);
  ok("race on book: a bid alone at its own level is not raceable and is left alone", !omsRob7.raceable(1) && omsRob7.raceOnly(1, 200, bk([[0.49, 10]], [[0.51, 9000]]), race).length === 0);
  ok("race on book: tag +race+rob with MM_RACE_ON_BOOK, plain +race without",
    quoteTag("v4", { ...CFG, raceLevel: 0.5, raceShare: 0.5, raceOutbid: false, raceOnBook: true }).includes("+race+rob") &&
    !quoteTag("v4", { ...CFG, raceLevel: 0.5, raceShare: 0.5, raceOutbid: false, raceOnBook: false }).includes("+rob") &&
    !quoteTag("v4", { ...CFG, raceLevel: null, raceShare: null, raceOutbid: false, raceOnBook: true }).includes("+rob"));

  // MM_RACE_INFLIGHT: the level / share rules also while the post is unanswered (the paper ack here comes at +100 ms)
  {
    const rif = { ...race, inflight: true };
    const fresh = () => { const e = new PaperExchange(100, () => {}); e.setTokens("U", "D"); return { e, m: new OrderManager(e, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true }) }; };
    const c = (book: BookView, r: typeof rif | typeof race = rif) => ({ ...ctx(book), race: r });
    const b = bk([[0.5, 300]], [[0.51, 300]]);
    let x = fresh();
    x.m.sync(1, qb, 0, c(b));
    a = x.m.sync(1, qb, 50, c(b));
    ok("race in flight: an unchanged level keeps the posted bid", a[0].act === "keep" && /in flight/.test(a[0].note), a[0].note);
    a = x.m.sync(1, qb, 60, c(bk([[0.5, 140]], [[0.51, 300]])));
    const o1 = x.e.working(1)[0];
    ok("race in flight: the level falling under 50% of the 300 seen at the post cancels it before its answer",
      a[0].act === "cancel" && /^#\d+ .*race: in flight, the level fell to 140 sh, under 50% of the 300 when it was posted/.test(a[0].note) &&
      o1?.status === "cancelling" && o1.liveAt == null, a[0].note);
    a = x.m.sync(1, qb, 70, c(bk([[0.5, 140]], [[0.51, 300]])));
    ok("race in flight: the race hold applies after it", a[0].act === "idle" && /race hold/.test(a[0].note), a[0].note);
    x = fresh();
    x.m.sync(1, qb, 0, c(b));
    a = x.m.sync(1, qb, 40, c(bk([[0.5, 300]], [[0.51, 1300]])));
    ok("race in flight: the other side swelling to 1,300 (0.19) cancels it", a[0].act === "cancel" && /in flight, its side holds 0.19 of the touch/.test(a[0].note), a[0].note);
    x = fresh();
    x.m.sync(1, qb, 0, c(b, race));
    a = x.m.sync(1, qb, 60, c(bk([[0.5, 140]], [[0.51, 1300]]), race));
    ok("race in flight: off (MM_RACE_INFLIGHT=off) the unanswered bid stays", a[0].act === "keep" && /in flight/.test(a[0].note), a[0].note);
    x = fresh();
    const b2 = bk([[0.49, 300]], [[0.51, 900]]);
    x.m.sync(1, qb, 0, c(b2));
    a = x.m.sync(1, qb, 50, c(bk([[0.5, 10], [0.49, 300]], [[0.51, 900]])));
    ok("race in flight: a bid posted to an empty level stays exempt when others join it", a[0].act === "keep", a[0].note);
    // once answered, the live rule takes over with the queue at the answer
    x = fresh();
    x.m.sync(1, qb, 0, c(b)); x.e.step(150, 1, b, m);
    a = x.m.sync(1, qb, 200, c(bk([[0.5, 200]], [[0.51, 300]])));
    ok("race in flight: after the answer the live rule runs as before", x.e.working(1)[0]?.queue0 === 300 && a[0].act === "keep", a[0].note);
  }

  // outbid: a bid that has been the touch leaves once someone bids over it (level / share rules off here)
  const rob = { level: null, share: null, holdMs: 1000, outbid: true };
  const octx = (book: BookView, r: typeof rob = rob) => ({ ...ctx(book), race: r });
  const mkOm = () => { const e = new PaperExchange(100, () => {}); e.setTokens("U", "D"); return { e, om: new OrderManager(e, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true }) }; };
  const top = bk([[0.5, 300]], [[0.52, 300]]), over = bk([[0.51, 40], [0.5, 300]], [[0.52, 300]]);
  {
    const { e, om } = mkOm();
    om.sync(1, qb, 0, octx(top)); e.step(150, 1, top, m);
    const o1 = e.working(1)[0];
    a = om.sync(1, qb, 200, octx(top));
    ok("outbid: a bid at the best Up bid 50¢ stays", a[0].act === "keep", a[0].note);
    a = om.sync(1, qb, 300, octx(over));
    ok("outbid: someone bids 51¢ over it, the target still 50¢ → cancelled, no rejoin at 50¢ (hold)",
      a[0].act === "cancel" && /outbid: the best Up bid went to 51/.test(a[0].note) && /race hold/.test(a[0].note) && o1.status === "cancelling", a[0].note);
    e.step(450, 1, over, m);
    a = om.sync(1, qb, 900, octx(over));
    ok("outbid: ...and stays out of 50¢ for the 1 s hold", a[0].act === "idle" && /race hold/.test(a[0].note) && e.working(1).length === 0, a[0].note);
    a = om.sync(1, qb, 1400, octx(over));
    ok("outbid: after the hold it may rest at 50¢ behind the touch again", a[0].act === "place", a[0].note);
    e.step(1550, 1, over, m);
    a = om.sync(1, qb, 1600, octx(bk([[0.51, 10], [0.5, 300]], [[0.52, 300]])));
    ok("outbid: a bid that went live behind the touch (never the touch) is left alone", a[0].act === "keep", a[0].note);
  }
  {
    const { e, om } = mkOm();
    om.sync(1, qb, 0, octx(top)); e.step(150, 1, top, m);
    om.sync(1, qb, 200, octx(top));
    a = om.sync(1, { ...qb, bid: 0.51 }, 300, octx(over));
    ok("outbid: the target moved up to 51¢ → replaced there at once (no 1 s requote hold)",
      a[0].act === "replace" && /outbid/.test(a[0].note) && e.working(1).some((x) => Math.abs(x.price - 0.51) < 1e-9 && x.status !== "cancelling"), a[0].note);
  }
  {
    // the Down bid: the Up ask 52¢ (a Down bid at 48¢); a Down bid at 49¢ (the Up ask 51¢) outbids it
    const { e, om } = mkOm();
    const qa: Quote = { ...qb, bid: null, ask: 0.52, bidSize: 0, askSize: 25, off: { bid: "off", ask: null } };
    om.sync(1, qa, 0, octx(top)); e.step(150, 1, top, m);
    om.sync(1, qa, 200, octx(top));
    a = om.sync(1, qa, 300, octx(bk([[0.5, 300]], [[0.51, 40], [0.52, 300]])));
    ok("outbid: the Down bid at 48¢ outbid by a 49¢ Down bid → cancelled", a[1].act === "cancel" && /outbid: the best Down bid went to 49/.test(a[1].note), a[1].note);
  }
  {
    const { e, om } = mkOm();
    const off = { ...rob, outbid: false };
    om.sync(1, qb, 0, octx(top, off)); e.step(150, 1, top, m);
    om.sync(1, qb, 200, octx(top, off));
    a = om.sync(1, qb, 300, octx(over, off));
    ok("outbid: off (MM_RACE_OUTBID=off) → it stays behind the touch", a[0].act === "keep", a[0].note);
  }
}

// 10b3. maker rebate: 20% of the taker fee on every maker fill, none on a take
{
  const acct = new Account(1000, 1000, 0.2);
  const mk = (via: "queue" | "take", token: "UP" | "DOWN", price: number, size: number): Fill => ({
    id: 1, oid: 1, win: 1, t: 0, side: token === "UP" ? "BUY" : "SELL", price, token, tokenSide: "BUY", tokenPrice: token === "UP" ? price : Math.round((1 - price) * 1e4) / 1e4,
    size, via, queue0: 0, restMs: 0, fv: null, mid: null, mk: [null, null, null], settle: null, note: "", inv: "", fee: via === "take" ? 0.07 * price * (1 - price) * size : undefined });
  acct.apply(mk("queue", "UP", 0.5, 100));
  const p = acct.wins.get(1)!;
  ok("rebate: 100 Up at 50¢ as a maker → +$0.35 (0.2 × 0.07 × ¼ × 100)", Math.abs(p.rebate! - 0.35) < 1e-9 && Math.abs(acct.cash - (1000 - 50 + 0.35)) < 1e-9, String(p.rebate));
  acct.apply(mk("queue", "DOWN", 0.7, 50));
  ok("rebate: a Down bid at 30¢ (Up ask 70¢) → +0.2 × 0.07 × 0.21 × 50", Math.abs(p.rebate! - (0.35 + 0.2 * 0.07 * 0.21 * 50)) < 1e-9);
  const before = p.rebate!;
  acct.apply(mk("take", "UP", 0.5, 10));
  ok("rebate: none on a take; the summary carries it", p.rebate === before && acct.summary(p).rebate === before && new Account(1000, 1000).summary(p).rebate === before);
  const a0 = new Account(1000, 1000); a0.apply(mk("queue", "UP", 0.5, 100));
  ok("rebate: off by default in the Account (0 share)", (a0.wins.get(1)!.rebate ?? 0) === 0 && Math.abs(a0.cash - 950) < 1e-9);
  // the cancel-in-flight / no-cancel maker fill counts (Fill.cxl): takes and unflagged fills count in neither
  const a1 = new Account(1000, 1000);
  a1.apply({ ...mk("queue", "UP", 0.5, 10), cxl: true }); a1.apply({ ...mk("queue", "DOWN", 0.6, 10), cxl: true }); a1.apply({ ...mk("queue", "UP", 0.5, 10), cxl: false });
  a1.apply(mk("take", "UP", 0.5, 10)); a1.apply(mk("queue", "UP", 0.5, 10));
  const p1 = a1.wins.get(1)!, s1 = a1.summary(p1);
  ok("fills: cancel in flight 2 · no cancel 1 of 5 fills (a take and an unflagged fill in neither); the summary carries both",
    p1.fills === 5 && p1.fillsCxl === 2 && p1.fillsNoCxl === 1 && s1.fillsCxl === 2 && s1.fillsNoCxl === 1, JSON.stringify([p1.fills, p1.fillsCxl, p1.fillsNoCxl]));
}

// 10b4. matching between frames (PAPER_STEP_MS): with a 65 ms latency a cancel lands before the next 100 ms frame, so a
// run-through of our price while the cancel is in flight only fills us if the exchange also matches between frames
{
  const bk = (bids: [number, number][], asks: [number, number][]): BookView =>
    ({ ready: true, bids, asks, bestBid: bids[0]?.[0] ?? null, bestAsk: asks[0]?.[0] ?? null, ageMs: 0, last: null });
  const m = { fv: 0.5, mid: 0.505 };
  const run = (steps: number[]) => {
    const ex = new PaperExchange(65, () => {}); ex.setTokens("U", "D");
    const o = ex.place({ win: 1, price: 0.5, size: 20, reason: "test" }, 0);
    ex.step(70, 1, bk([[0.5, 300]], [[0.51, 300]]), m);                     // live at 65 ms, 300 ahead
    ex.cancel(o, 100, "race");                                               // lands at 165 ms
    const thru = bk([[0.49, 300]], [[0.5, 120]]);                            // 140 ms: the 50¢ bids are gone, a seller rests at 50¢
    let got = 0;
    for (const t of steps) for (const f of ex.step(t, 1, thru, m)) got += f.size;
    return got;
  };
  ok("between frames: a step at 140 ms fills the bid by the 50¢ seller while its cancel is in flight", run([140, 200]) === 20);
  ok("frames only: the next step at 200 ms comes after the cancel landed (165 ms) → no fill", run([200]) === 0);
}

// 10c. taker orders (the exchange's; the bot sent them only for the pair time-stop, removed 2026-10-10): fill-and-kill after latency + taker delay, walk the book, pay the fee
{
  const bk = (bids: [number, number][], asks: [number, number][]): BookView =>
    ({ ready: true, bids, asks, bestBid: bids[0]?.[0] ?? null, bestAsk: asks[0]?.[0] ?? null, ageMs: 0, last: null });
  const m = { fv: 0.5, mid: 0.505 };
  const ex = new PaperExchange(100, () => {}, 1, 1, undefined, 150); ex.setTokens("U", "D");
  const o = ex.place({ win: 1, side: "BUY", price: 0.52, size: 25, reason: "t", take: true }, 0);
  const B = bk([[0.49, 100]], [[0.5, 10], [0.51, 30], [0.53, 100]]);
  ok("take: nothing before latency + taker delay (250 ms)", ex.step(200, 1, B, m).length === 0 && o.status === "pending");
  const exT = new PaperExchange(35, () => {}, 1, 1, undefined, 150, null, 300); exT.setTokens("U", "D");
  const oT = exT.place({ win: 1, side: "BUY", price: 0.52, size: 25, reason: "t", take: true }, 0);
  ok("take: PAPER_TAKE_MS 300 replaces latency + delay (nothing at 290 ms, filled at 300 ms)",
    exT.step(290, 1, B, m).length === 0 && oT.status === "pending" && exT.step(300, 1, B, m).length > 0 && (oT.status as string) === "filled", JSON.stringify(oT));
  const oM = exT.place({ win: 1, side: "BUY", price: 0.49, size: 5, reason: "t" }, 1000);
  ok("take: a maker order keeps the plain latency (35 ms)", oM.ackDue === 1035);
  const f = ex.step(260, 1, B, m);
  // as live's market BUY: the take spends size × limit ($13 = 25 × 52¢), so it buys 10 at 50¢ and $8 of 51¢ (15.69), more than 25
  ok("take: walks the asks up to its limit, spending size × limit as live's market BUY ($13: 10 at 50¢, then $8 at 51¢)",
    o.usd === 13 && f.length === 2 && f[0].size === 10 && f[0].price === 0.5 && Math.abs(f[1].size - 8 / 0.51) < 1e-5 && f[1].price === 0.51 && o.status === "filled",
    JSON.stringify(f.map((x) => [x.size, x.price, x.via])));
  ok("take: pays 0.07·p(1−p) a share", Math.abs((f[0].fee ?? 0) - 0.07 * 0.25 * 10) < 1e-12 && f.every((x) => x.via === "take"));
  const o2 = ex.place({ win: 1, side: "BUY", price: 0.5, size: 25, reason: "t", take: true }, 1000);
  const f2 = ex.step(1300, 1, B, m);
  ok("take: fill-and-kill: what the book lacks within the limit is cancelled", f2.length === 1 && f2[0].size === 10 && o2.status === "cancelled");
  const o3 = ex.place({ win: 1, token: "DOWN", side: "BUY", price: 0.48, size: 25, reason: "t", take: true }, 2000);
  const f3 = ex.step(2300, 1, bk([[0.53, 40]], [[0.55, 10]]), m);
  ok("take on Down: hits the Up bids (Down asks), Down at 1 − 53¢; its $12 (25 × 48¢) buys 25.53", f3.length === 1 && f3[0].tokenPrice === 0.47 &&
    Math.abs(f3[0].size - 12 / 0.47) < 1e-5 && o3.status === "filled", JSON.stringify(f3.map((x) => [x.size, x.tokenPrice])));
  const oMin = ex.place({ win: 1, side: "BUY", price: 0.19, size: 5, reason: "t", take: true }, 3000);
  ok("take: under the venue's $1 minimum (5 × 19¢ = $0.95) is refused at once, as live", oMin.status === "rejected" && oMin.usd === 0.95 &&
    ex.step(3500, 1, B, m).length === 0, JSON.stringify(oMin));
  const exL = new PaperExchange(35, () => {}, 1, 1, undefined, 150, null, 300, true); exL.setTokens("U", "D");
  const dl = Array.from({ length: 200 }, (_, i) => exL.place({ win: 1, side: "BUY", price: 0.52, size: 25, reason: "t", take: true }, i * 10_000))
    .map((x) => x.ackDue - x.createdAt);
  ok("take: PAPER_TAKE_MS=live draws send → match from the live takes (185 ms–2.8 s, median 348)",
    Math.min(...dl) >= 185 && Math.max(...dl) <= 2842 && new Set(dl).size > 100 && liveTakeMs(0) === 185 && liveTakeMs(0.5) === 348 && liveTakeMs(1) === 2842,
    JSON.stringify([Math.min(...dl), Math.max(...dl)]));
  const acct = new Account(1000, 1000);
  acct.apply({ ...f[0], win: 7 });
  ok("account: a taker fill pays its price and its fee", Math.abs(acct.cash - (1000 - 0.5 * 10 - 0.07 * 0.25 * 10)) < 1e-9 && Math.abs((acct.wins.get(7)!.fees ?? 0) - 0.175) < 1e-12);

}

// 8. paper exchange: latency, queue, ordering, tape mapping, through, cross, post-only, cancel in flight
{
  const book = (bids: [number, number][], asks: [number, number][]): BookView =>
    ({ ready: true, bids, asks, bestBid: bids[0]?.[0] ?? null, bestAsk: asks[0]?.[0] ?? null, ageMs: 0, last: null });
  const pr = (asset: string, price: number, size: number, side: string, rx: number): Print => ({ asset, price, size, side, rx, ts: rx });
  const mk = () => { const evs: string[] = []; const ex = new PaperExchange(100, (e) => evs.push(e.type)); ex.setTokens("U", "D"); return { ex, evs }; };
  const m = { fv: 0.5, mid: 0.51 };
  const B = book([[0.5, 100]], [[0.52, 50]]);

  let { ex } = mk();
  const o = ex.place({ win: 1, side: "BUY", price: 0.5, size: 25, reason: "t" }, 0);
  ex.step(50, 1, B, m);
  ok("order not live before the latency", o.status === "pending" && o.liveAt == null);
  ex.step(100, 1, B, m);
  ok("order joins the back of the level", o.status === "open" && o.queue === 100);
  ex.onPrint(pr("U", 0.5, 60, "SELL", 150));
  let f = ex.step(200, 1, book([[0.5, 40]], [[0.52, 50]]), m);
  ok("prints at our price eat the queue ahead", f.length === 0 && Math.abs(o.queue - 40) < 1e-9, `queue ${o.queue}`);
  ex.onPrint(pr("U", 0.5, 70, "SELL", 250));
  f = ex.step(300, 1, book([], [[0.52, 50]]), m);
  ok("prints past the queue fill us, capped at our size", f.length === 1 && f[0].size === 25 && f[0].via === "queue" && o.status === "filled", JSON.stringify(f.map((x) => [x.size, x.via])));

  // price_change before its print: must not count the same match twice
  ({ ex } = mk());
  const o2 = ex.place({ win: 1, side: "BUY", price: 0.5, size: 25, reason: "t" }, 0);
  ex.step(100, 1, B, m);
  ex.step(200, 1, book([[0.5, 70]], [[0.52, 50]]), m);          // level shrank, print not here yet
  ex.onPrint(pr("U", 0.5, 30, "SELL", 220));
  ex.step(300, 1, book([[0.5, 70]], [[0.52, 50]]), m);
  ex.step(900, 1, book([[0.5, 70]], [[0.52, 50]]), m);
  ok("level drop then its print counts once", Math.abs(o2.queue - 70) < 1e-9, `queue ${o2.queue}`);
  ex.step(1600, 1, book([[0.5, 20]], [[0.52, 50]]), m);
  ex.step(2200, 1, book([[0.5, 20]], [[0.52, 50]]), m);
  ok("a level that stays below our queue pulls us forward", Math.abs(o2.queue - 20) < 1e-9, `queue ${o2.queue}`);

  // taker side and the Down tape
  ({ ex } = mk());
  const o3 = ex.place({ win: 1, side: "BUY", price: 0.5, size: 25, reason: "t" }, 0);
  ex.step(100, 1, B, m);
  ex.onPrint(pr("U", 0.49, 5, "BUY", 150));                      // a taker BUY never fills a bid
  f = ex.step(200, 1, B, m);
  ok("taker BUY prints do not fill a bid", f.length === 0);
  ex.onPrint(pr("D", 0.51, 10, "BUY", 250));                     // Down BUY @ 51 = Up SELL @ 49: through our 50 bid
  f = ex.step(300, 1, B, m);
  ok("Down print mapped to an Up sell through our bid", f.length === 1 && f[0].size === 10 && f[0].via === "through", JSON.stringify(f.map((x) => [x.size, x.via])));
  f = ex.step(400, 1, book([[0.5, 100]], [[0.5, 8], [0.51, 20]]), m);
  ok("an ask resting on our bid fills us once", f.length === 1 && f[0].size === 8 && f[0].via === "cross");
  f = ex.step(500, 1, book([[0.5, 100]], [[0.5, 8], [0.51, 20]]), m);
  ok("the same resting ask is not credited twice", f.length === 0);

  // post-only reject, and a fill while the cancel is in flight
  let evs: string[];
  ({ ex, evs } = mk());
  const o4 = ex.place({ win: 1, side: "BUY", price: 0.52, size: 25, reason: "t" }, 0);
  ex.step(100, 1, book([[0.51, 10]], [[0.52, 50]]), m);
  ok("post-only order that would cross is rejected", o4.status === "rejected" && evs.includes("reject"));
  const o5 = ex.place({ win: 1, side: "SELL", price: 0.53, size: 20, reason: "t" }, 100);
  ex.step(200, 1, B, m);
  ex.cancel(o5, 250, "test");
  ex.onPrint(pr("U", 0.53, 5, "BUY", 300));                      // o5 joined an empty level: first in line
  f = ex.step(300, 1, B, m);
  ex.step(350, 1, B, m);
  ok("a cancel in flight can still be filled", f.length === 1 && f[0].size === 5 && o5.status === "cancelled" && o5.filled === 5, `${o5.status} ${o5.filled}`);

  // a Down bid at 47¢ is the Up ask at 53¢: a taker selling Down at 47¢ (= buying Up at 53¢) fills it
  const exD = new PaperExchange(100, () => {}); exD.setTokens("U", "D");
  const od = exD.place({ win: 1, token: "DOWN", side: "BUY", price: 0.47, size: 20, reason: "t" }, 0);
  exD.step(100, 1, book([[0.5, 100]], [[0.52, 50]]), m);                    // 53¢ is an empty level: first in line
  exD.onPrint(pr("D", 0.47, 8, "SELL", 150));
  f = exD.step(200, 1, book([[0.5, 100]], [[0.52, 50]]), m);
  ok("a Down bid fills from a Down taker sell at its price", od.side === "SELL" && od.price === 0.53 && f.length === 1 && f[0].size === 8 && f[0].token === "DOWN" && f[0].tokenPrice === 0.47, JSON.stringify(f.map((x) => [x.size, x.token, x.tokenPrice])));

  // the venue's own balance check: an uncovered SELL is rejected at the ack
  const exC = new PaperExchange(100, () => {}, 1, 1, () => 10); exC.setTokens("U", "D");
  const oc = exC.place({ win: 1, side: "SELL", price: 0.53, size: 25, reason: "t" }, 0);
  exC.step(100, 1, B, m);
  ok("exchange rejects a SELL for more Up than is held", oc.status === "rejected");

  // exact latency: live from ackDue (not the next frame), nothing credited after the cancel lands
  ({ ex } = mk());
  const o6 = ex.place({ win: 1, side: "BUY", price: 0.5, size: 25, reason: "t" }, 0);   // ackDue 100
  ex.onPrint(pr("U", 0.49, 7, "SELL", 120));                                            // before the next frame
  f = ex.step(150, 1, B, m);
  ok("live from ackDue: a through-print before the next frame fills", o6.liveAt === 100 && f.length === 1 && f[0].size === 7, JSON.stringify(f.map((x) => x.size)));
  ex.cancel(o6, 260, "t");                                                                // cancelDue 360
  ex.onPrint(pr("U", 0.49, 5, "SELL", 380));
  f = ex.step(400, 1, book([[0.5, 100]], [[0.5, 9]]), m);
  ok("nothing is credited after the cancel lands", f.length === 0 && o6.status === "cancelled" && o6.filled === 7, `${o6.status} ${o6.filled}`);
}

// 9. account: Up and Down buys pair up and merge, round trip, settlement and a Gamma correction
{
  let n = 0;
  const fill = (win: number, side: "BUY" | "SELL", price: number, size: number): Fill =>
    ({ id: ++n, oid: n, win, t: 0, side, price, token: "UP", tokenSide: side, tokenPrice: price, size, via: "queue", queue0: 0, restMs: 0, fv: 0.5, mid: 0.5, mk: [null, null, null], settle: null, note: "", inv: "" });
  const down = (win: number, q: number, size: number): Fill => ({ ...fill(win, "SELL", 1 - q, size), token: "DOWN", tokenSide: "BUY", tokenPrice: q });
  const pa = new Account(1000, 1000);
  const n1 = pa.apply(down(9, 0.48, 25)), c1 = pa.cash, n2 = pa.apply(fill(9, "BUY", 0.50, 25)), p9 = pa.wins.get(9)!;
  ok("a Down bid fill buys Down at its own price", n1.startsWith("bought 25 Down @ 48¢") && Math.abs(c1 - 988) < 1e-9, n1);
  ok("Up + Down merge: the pair locks 1 − 98¢", p9.up === 0 && p9.down === 0 && p9.pairs === 25 && Math.abs(p9.pairCost - 24.5) < 1e-9 && Math.abs(p9.realized - 0.5) < 1e-9 && Math.abs(pa.cash - 1000.5) < 1e-9, n2);
  const a = new Account(1000, 1000);
  a.apply(fill(1, "BUY", 0.52, 25)); a.apply(fill(1, "SELL", 0.55, 25));
  const p1 = a.wins.get(1)!;
  ok("round trip books the spread", Math.abs(p1.realized - 0.75) < 1e-9 && Math.abs(a.cash - 1000.75) < 1e-9 && p1.up === 0);
  a.apply(fill(2, "SELL", 0.60, 10));
  const p2 = a.wins.get(2)!;
  ok("(fallback) an uncovered sell books as a Down buy at 1 − p", p2.down === 10 && Math.abs(p2.downCost - 4) < 1e-9 && Math.abs(a.net(2) + 10) < 1e-9);
  a.apply(fill(2, "BUY", 0.55, 10));
  ok("Up + Down merge to $1", p2.up === 0 && p2.down === 0 && Math.abs(p2.realized - 0.5) < 1e-9 && Math.abs(p2.cash - 0.5) < 1e-9, `realized ${p2.realized} cash ${p2.cash}`);
  a.apply(fill(3, "BUY", 0.30, 20));
  a.close(3);
  const s1 = a.settle(3, true, "chainlink");
  ok("settle UP pays the Up held", s1 != null && Math.abs(s1.pnl - 14) < 1e-9 && Math.abs(a.cash - (1000.75 + 0.5 + 14)) < 1e-9);
  const s2 = a.settle(3, false, "gamma");
  ok("a Gamma correction re-settles the difference", s2 != null && s2.corrected && Math.abs(s2.pnl + 6) < 1e-9 && Math.abs(a.cash - (1000.75 + 0.5 - 6)) < 1e-9);
  ok("a confirming label changes nothing", a.settle(3, false, "gamma") === null);
  a.pos(4); a.close(4);
  ok("a window that never traded is done at the close", a.wins.get(4)!.state === "settled" && a.settle(4, true, "chainlink") === null);
  // reset PnL: the start becomes the equity, cash and inventory stay, each open window's PnL restarts at its mark
  a.apply(fill(5, "BUY", 0.40, 10)); a.mark(5, 0.45, null, 0);
  a.apply(fill(6, "BUY", 0.60, 5)); a.mark(6, 0.70, null, 0); a.close(6);
  const cash0 = a.cash, eq0 = a.equity(), p5 = a.wins.get(5)!, p6 = a.wins.get(6)!;
  const rb = a.rebase();
  ok("rebase: equity and cash kept, the start is the equity, PnL 0", Math.abs(a.cash - cash0) < 1e-9 && Math.abs(a.equity() - eq0) < 1e-9 && Math.abs(a.start - eq0) < 1e-9);
  ok("rebase: each open window's PnL 0, inventory and fills kept, its PnL before returned",
    Math.abs(a.pnl(p5)) < 1e-9 && Math.abs(a.pnl(p6)) < 1e-9 && p5.up === 10 && p5.fills === 1 && rb.some((r) => r.win === 6) && Math.abs(rb.find((r) => r.win === 5)!.pnl - 0.5) < 1e-9,
    rb.map((r) => `${r.win}:${r.pnl.toFixed(2)}`).join(" "));
  a.settle(6, true, "chainlink");
  ok("rebase: a later settle books payout − mark (5 Up marked 70¢ pays $5 → +$1.50)", Math.abs(a.pnl(p6) - 1.5) < 1e-9 && Math.abs(a.equity() - a.start - 1.5) < 1e-9);
}

// 10. order manager: place, keep, riskier → replace now, safer → hold for the queue, balance cut
{
  const ex = new PaperExchange(100, () => {});
  const oms = new OrderManager(ex, 1000);
  const tgt = (bid: number | null, ask: number | null, bs = 25, as = 25): Quote =>
    ({ policy: null, bid, ask, bidSize: bid == null ? 0 : bs, askSize: ask == null ? 0 : as, center: 0.5, skew: 0, reservation: 0.5, why: "", off: { bid: bid == null ? "off" : null, ask: ask == null ? "off" : null }, steps: [] });
  const ctx = { free: 1000, minSize: 5 };
  let acts = oms.sync(1, tgt(0.5, 0.53), 0, ctx);
  const dn = ex.working(1).find((o) => o.token === "DOWN");
  ok("places both sides: an Up bid and a Down bid at 1 − ask", acts.map((x) => x.act).join() === "place,place" && ex.working(1).length === 2 && dn?.tokenSide === "BUY" && dn?.tokenPrice === 0.47 && dn?.side === "SELL" && dn?.price === 0.53);
  acts = oms.sync(1, tgt(0.5, 0.53), 50, ctx);
  ok("keeps orders already at the target", acts.map((x) => x.act).join() === "keep,keep");
  acts = oms.sync(1, tgt(0.49, 0.53), 60, ctx);
  ok("bid above a lower target is replaced at once", acts[0].act === "replace" && ex.working(1).filter((o) => o.side === "BUY" && o.status === "pending")[0]?.price === 0.49);
  acts = oms.sync(1, tgt(0.49, 0.54), 70, ctx);
  ok("ask below a higher target is replaced at once", acts[1].act === "replace");
  acts = oms.sync(1, tgt(0.50, 0.54), 80, ctx);
  ok("a safer working bid holds its queue spot", acts[0].act === "hold");
  acts = oms.sync(1, tgt(0.50, 0.54), 1200, ctx);
  ok("...then chases after MM_REQUOTE_MIN_MS", acts[0].act === "replace");
  acts = oms.sync(1, tgt(null, 0.54), 1300, ctx);
  ok("a target turned off cancels", acts[0].act === "cancel" && ex.working(1).filter((o) => o.side === "BUY" && o.status !== "cancelling").length === 0);
  const ex2 = new PaperExchange(100, () => {});
  acts = new OrderManager(ex2, 1000).sync(1, tgt(0.5, null), 0, { free: 5, minSize: 5 });
  ok("balance cuts the size", acts[0].act === "place" && ex2.working(1)[0]?.size === 10, acts[0].note);
  const ex3 = new PaperExchange(100, () => {});
  acts = new OrderManager(ex3, 1000).sync(1, tgt(null, 0.53), 0, { free: 4.7, minSize: 5 });
  ok("a Down bid's size is cut by USDC at the Down price", acts[1].act === "place" && ex3.working(1)[0]?.size === 10 && ex3.working(1)[0]?.token === "DOWN", acts[1].note);
}

// 11. the trader end to end: a Down bid goes out, fills from a Down print, and every record names the token
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mm-selftest-"));
  try {
    let feed: (p: Print) => void = () => {};
    const pm = { onPrint: (cb: (p: Print) => void) => { feed = cb; } } as unknown as ConstructorParameters<typeof Trader>[0];
    const store = { entries: () => [], get: () => undefined } as unknown as ConstructorParameters<typeof Trader>[1];
    const tr = new Trader(pm, store, () => {}, tmp);
    const B: BookView = { ready: true, bids: [[0.5, 100]], asks: [[0.52, 50]], bestBid: 0.5, bestAsk: 0.52, ageMs: 0, last: null };
    const at = (now: number) => ({ now, win: 1000, endTs: 1300, up: "U", down: "D", book: B, fv: 0.45, mid: 0.51 });
    const q: Quote = { policy: null, bid: null, ask: 0.53, bidSize: 0, askSize: 25, center: 0.45, skew: 0, reservation: 0.45, why: "", off: { bid: "off", ask: null }, steps: [] };
    tr.pre(at(0)); tr.post(1000, q, 0, 5);
    tr.pre(at(200)); tr.post(1000, q, 200, 5);                 // acked within the latency: the Down bid is on the book
    feed({ asset: "D", price: 0.47, size: 25, side: "SELL", rx: 650, ts: 650 });   // the taker arrived at 500, well after the bid
    tr.pre(at(700));
    tr.pre(at(800));                                           // the fill is heard PAPER_FILL_HEARD_MS (80) after the venue's match
    const ev = tr.hello(1000).events, place = ev.find((e) => e.type === "place"), fill = ev.find((e) => e.type === "fill");
    ok("trader: the ask target goes out as a Down bid at 47¢", place?.token === "DOWN" && place?.tokenSide === "BUY" && place?.tokenPrice === 0.47, JSON.stringify(place));
    ok("trader: the fill event names the token", fill?.token === "DOWN" && fill?.tokenPrice === 0.47 && /bought 25 Down @ 47¢/.test(fill?.note ?? ""), fill?.note);
    ok("trader: the account holds 25 Down", tr.position(1000).down === 25 && tr.position(1000).net === -25);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  // v4: a take goes out beside the maker bid; the order manager never mistakes it for its working order
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "mm-selftest-"));
  try {
    const pm = { onPrint: () => {} } as unknown as ConstructorParameters<typeof Trader>[0];
    const store = { entries: () => [], get: () => undefined } as unknown as ConstructorParameters<typeof Trader>[1];
    const tr = new Trader(pm, store, () => {}, tmp2);
    const B: BookView = { ready: true, bids: [[0.5, 300]], asks: [[0.51, 90]], bestBid: 0.5, bestAsk: 0.51, ageMs: 0, last: null };
    const at = (now: number) => ({ now, win: 1000, endTs: 1300, up: "U", down: "D", book: B, fv: 0.505, mid: 0.505 });
    const mkt = { tick: 0.01, bestBid: 0.5, bestAsk: 0.51 };
    const qb: Quote = { policy: "v4", bid: 0.5, ask: null, bidSize: 25, askSize: 0, center: 0.505, skew: 0, reservation: 0.505, why: "", off: { bid: null, ask: "pulled" }, steps: [] };
    tr.pre(at(0));
    tr.post(1000, qb, 0, 5, mkt, { token: "UP", price: 0.51, size: 50, kind: "flow", why: "test flow" });
    const a0 = tr.frame(1000, 0, false).actions as { side: string; act: string }[];
    ok("trader v4: the take is sent and the Up maker bid is placed beside it", a0[0]?.act === "take" && a0[1]?.side === "up" && a0[1]?.act === "place" && tr.takeInFlight(1000) === "UP",
      JSON.stringify(a0));
    tr.pre(at(100)); tr.post(1000, qb, 100, 5, mkt);
    const a1 = tr.frame(1000, 100, false).actions as { side: string; act: string }[];
    ok("trader v4: next frame the maker bid is kept and the take is not cancelled as a duplicate", a1[0]?.act === "keep" && tr.takeInFlight(1000) === "UP" && tr.workingSides(1000).bid,
      JSON.stringify(a1));
    tr.pre(at(400));
    const p = tr.position(1000), fee = 50 * 0.07 * 0.51 * 0.49;
    ok("trader v4: after latency + taker delay the take fills 50 Up at 51¢ and pays its fee", p.up === 50 && Math.abs(tr.acct.cash - (1000 - 25.5 - fee)) < 1e-9 && tr.takeInFlight(1000) === null && tr.sinceFlowTake(1000, 400) === 400,
      JSON.stringify([p.up, tr.acct.cash]));
  } finally { fs.rmSync(tmp2, { recursive: true, force: true }); }
}

// 12. nowcast blend: basis cancels, exact integral, the live fit recovers known lags and weight, Coinbase top of book
{
  const rng = mulberry(11);
  const bin = new PriceBuffer(3600_000), cbx = new PriceBuffer(3600_000), cl = new PriceBuffer(3600_000);
  const X: number[] = [];   // latent log price on a 50 ms grid from t = 0
  let x = Math.log(82_000);
  for (let i = 0; i <= 14_000; i++) { x += 0.4e-4 * Math.sqrt(0.05) * gauss(rng); X.push(x); }
  const nB: number[] = X.map(() => 0.3e-4 * gauss(rng)), nC: number[] = X.map(() => 0.3e-4 * gauss(rng));
  for (let i = 0; i < X.length; i++) { bin.push(i * 50, Math.exp(X[i] + nB[i])); cbx.push(i * 50, Math.exp(X[i] + nC[i] - 9e-4)); }
  // Chainlink = B(s − 300)^0.7 · C(s − 500)^0.3 + a little noise, one print a second
  for (let s = 2000; s <= 700_000; s += 1000) cl.push(s, Math.exp(0.7 * Math.log(bin.at(s - 300)!) + 0.3 * Math.log(cbx.at(s - 500)!) + 0.02e-4 * gauss(rng)));
  const f = fitBlend(cl.slice(100_000, 700_000), bin, cbx)!;
  ok("blend fit recovers the weight", f != null && Math.abs(f.w - 0.3) < 0.05, `w ${f?.w} n ${f?.n}`);
  ok("blend fit recovers both lags", f != null && f.lb === 300 && f.lc === 500, `Binance ${f?.lb} ms, Coinbase ${f?.lc} ms`);
  const f0 = fitBlend(cl.slice(100_000, 700_000), bin, cbx, 0)!;
  ok("weight pinned at 0 fits Binance's lag alone", f0.w === 0 && Math.abs(f0.lb - 300) <= 100, `lag ${f0.lb}`);

  // same venue twice (Coinbase = Binance × a constant basis): the blend prices exactly like Binance alone
  const cbSame = new PriceBuffer(3600_000);
  for (let i = 0; i < X.length; i++) cbSame.push(i * 50, bin.at(i * 50)! * 1.0009);
  for (const [now, end, bump] of [[590_020, 660_000, 1.0001], [645_020, 660_000, 1.00001]] as const) {   // before / inside the averaging window
    const probe = fairValueAnchored({ now, K: 1, endMs: end, D: 60, sigma: 0.5e-4, eps2: 0, cl, path: venuePath(bin, 300) })!;
    const base = { now, K: probe.ea * bump, endMs: end, D: 60, sigma: 0.5e-4, eps2: 0, cl };   // strike just above E[A]
    const a1 = fairValueAnchored({ ...base, path: venuePath(bin, 300) })!, a2 = fairValueAnchored({ ...base, path: blendPath(bin, 300, cbSame, 300, 0.3) })!;
    ok(`blend of one venue with itself = that venue, ${a1.branch} (basis cancels)`, a1.fv > 0.03 && a1.fv < 0.97 && Math.abs(a1.fv - a2.fv) < 1e-9 && Math.abs(a1.nowcast - a2.nowcast) < 1e-6, `${a1.fv.toFixed(6)} vs ${a2.fv.toFixed(6)}`);
  }
  const base = { now: 645_020, K: cl.at(643_020)!, endMs: 660_000, D: 60, sigma: 0.5e-4, eps2: 0, cl };
  const a1 = fairValueAnchored({ ...base, path: venuePath(bin, 300) })!;
  const a3 = fairValueAnchored({ ...base, path: blendPath(bin, 300, cbx, 500, 0) })!;
  ok("weight 0 = Binance only", Math.abs(a1.fv - a3.fv) < 1e-12);

  // exact step integral of the blend vs a 1 ms brute-force sum
  const bp = blendPath(bin, 300, cbx, 500, 0.3);
  let brute = 0;
  for (let t = 600_000; t < 603_700; t++) brute += bp.at(t)!;
  const ex = bp.integralSec(600_000, 603_700)!;
  ok("blend integral is exact", Math.abs(ex - brute / 1000) / ex < 1e-12, `${ex.toFixed(4)} vs ${(brute / 1000).toFixed(4)}`);
  ok("blend lead is the longer lag", bp.lead === 500);

  // Coinbase level2: snapshot, a better level, removing the best rescans, a crossed book has no mid
  const t = new L2Top();
  for (const [p, q] of [[100, 1], [99, 2], [98, 1]] as const) t.set("bid", p, q);
  for (const [p, q] of [[101, 1], [102, 2]] as const) t.set("offer", p, q);
  ok("L2 top after the snapshot", t.bid === 100 && t.ask === 101 && t.mid() === 100.5);
  t.set("bid", 100.5, 1); t.set("offer", 101, 0);
  ok("L2 better bid in, best ask out → rescan", t.bid === 100.5 && t.ask === 102);
  t.set("bid", 100.5, 0); t.set("bid", 100, 0);
  ok("L2 removing the two best bids falls to the next", t.bid === 99);
  t.set("bid", 103, 1);
  ok("L2 crossed book has no mid", t.crossed && t.mid() == null);

  // an index entry scored before the Binance-only fields existed still summarises
  const old = JSON.parse(JSON.stringify(emptyScore()));
  delete old.lead.fvb1; delete old.lead.fvb5; delete old.mae.nb; delete old.mae.fvB; delete old.mae.fvb;
  for (const k of ["pn", "pFv", "pFvb", "plFv", "plFvb"]) delete old.settle[k];
  let sm: ReturnType<typeof summarize> | null = null;
  try { sm = summarize(old as Score); } catch { /* */ }
  ok("an archived score from before the blend still summarises", sm != null && sm.lead.fvb1.n === 0 && sm.pair.n === 0 && sm.maePair.fv == null);
}

// ---- leg-2 model (model/legTwo.ts): the shipped model and its features against tools/l2model's Python ----
{
  const m = LegTwoModel.load(CFG.pair.l2ModelFile);
  const V = JSON.parse(fs.readFileSync(CFG.pair.l2ModelFile.replace(/\.json$/, ".vectors.json"), "utf8"));
  let wf = 0, wp = 0, n = 0;
  for (const c of V.cases) {
    const x = l2Features(c.rows, COLS, c.t_sig, c.t_fill, c.sg, c.move, c.tok_ask, c.Kcl);
    if (!x) { wf = Infinity; continue; }
    x.forEach((a, i) => {
      const b = c.x[i] == null ? NaN : c.x[i];
      n++;
      if (Number.isNaN(a) !== Number.isNaN(b)) wf = Infinity; else if (!Number.isNaN(a)) wf = Math.max(wf, Math.abs(a - b));
    });
    wp = Math.max(wp, Math.abs(m.gbm.predict(x) - c.raw));
  }
  ok("leg-2 model: features from the rows = tools/l2model/feat.py", V.features.join() === L2_FEATURES.join() && wf < 1e-9, `${V.cases.length} cases, ${n} values, max |d| ${wf}`);
  ok("leg-2 model: its trees = LightGBM's (log-odds)", wp < 1e-9, `max |d| ${wp.toExponential(1)}`);
}

// ---- flow FV (model/gbm.ts, model/flowFv.ts) ----
{
  // the shipped model against an independent walk of LightGBM's own dump (tools/flowfv)
  const g = Gbm.load(path.join(CFG.flowFvModel));
  const V = JSON.parse(fs.readFileSync(CFG.flowFvModel.replace(/\.json$/, ".vectors.json"), "utf8"));
  let worst = 0;
  for (let i = 0; i < V.x.length; i++) worst = Math.max(worst, Math.abs(g.predict(V.x[i].map((v: number | null) => (v == null ? NaN : v))) - V.y[i]));
  ok("flow FV: model = LightGBM's trees, missing values included", V.features.join() === g.features.join() && worst < 1e-9, `${V.x.length} vectors, max |d| ${worst.toExponential(1)}`);

  // a tiny model: one split on imb1 (missing → right) and one on ur250 (missing → left), to drive FlowFv
  const tiny = new Gbm({ format: "gbm-compact-1", features: ["imb1", "ur250", "tf500", "ofi500", "lastd"], horizon_s: 2, trees: [
    { root: 0, f: [0], t: [0], d: [0], m: [2], l: [-1], r: [-2], v: [-1, 1] },
    { root: 0, f: [1], t: [0.5], d: [1], m: [2], l: [-1], r: [-2], v: [0, 0.5] }] });
  const f = new FlowFv(tiny, 2);
  const spot = new PriceBuffer(60_000), perp = new PriceBuffer(60_000);
  const t0 = 1791158400_000;
  for (let t = t0 - 5000; t <= t0 + 10_000; t += 50) { spot.push(t, 80000); perp.push(t, t < t0 + 9_800 ? 80000 : 80010); }
  const base = (now: number, bids: [number, number][], asks: [number, number][]): FlowIn => ({ now, startTs: 1791158400, up: "U", down: "D", bids, asks,
    fv: 0.5, m: 0, sd: 0.001, tau: 200, nowcast: 80000, cl: 80000, clStamp: now - 1500, sigBase: 0.3e-4, kappa: 1.1, spot, perp });
  // OFI: bid size grows 100 → 300 at the same price (+200), the ask level is taken out (+ its old size 50)
  f.onBook("U", { bb: 0.5, bs: 100, ba: 0.51, as: 50 });
  f.frame(base(t0 + 9_500, [[0.5, 100]], [[0.51, 50]]));
  f.onBook("U", { bb: 0.5, bs: 300, ba: 0.51, as: 50 });
  f.onBook("U", { bb: 0.5, bs: 300, ba: 0.52, as: 80 });
  // tape in Up terms: a Down taker BUY of 30 is an Up taker sell of 30; an Up taker BUY of 10 at 0.51
  f.onPrint("D", 0.49, 30, "BUY", t0 + 9_900); f.onPrint("U", 0.51, 10, "BUY", t0 + 9_950);
  const o = f.frame(base(t0 + 10_000, [[0.5, 300], [0.49, 10]], [[0.52, 80]]));
  const X = Object.fromEntries(tiny.features.map((n, i) => [n, o.x![i]]));
  ok("flow FV: OFI steps once per update (+200 bid, +50 ask gone)", X.ofi500 === 250, `ofi500 ${X.ofi500}`);
  ok("flow FV: tape in Up terms (Down BUY = Up sell)", X.tf500 === -20, `tf500 ${X.tf500}`);
  ok("flow FV: last print vs mid", Math.abs(X.lastd - (0.51 - 0.51) * 100) < 1e-9 && o.mid === 0.51);
  ok("flow FV: perp move feeds its returns", Math.abs(X.ur250 - Math.log(80010 / 80000) * 1e4) < 1e-9);
  ok("flow FV: centre = mid + scale × pred", o.good && o.pred === 1.5 && Math.abs(o.centre! - (0.51 + 2 * 1.5 / 100)) < 1e-12, `pred ${o.pred} centre ${o.centre}`);
  const o2 = f.frame({ ...base(t0 + 10_100, [[0.4, 10]], [[0.6, 10]]), perp: null });
  ok("flow FV: no centre on a wide book; a dead feed is missing, not zero", o2.centre == null && !o2.good && Number.isNaN(o2.x![1]));
  // the A/B: even 5-minute slots quote on the flow FV, v4 only
  const ab = { ...CFG, flowFv: "ab" as const, quotePolicy: "v4" as const, decideStepMs: 0, paperFillModel: "queue" as const };
  ok("flow FV A/B: even slots +ffv, odd anchored", flowFor(1791158400, ab) && !flowFor(1791158700, ab) && windowTag(1791158400, ab).endsWith("+ffv") &&
    !windowTag(1791158700, ab).includes("+ffv") && !flowFor(1791158400, { ...ab, quotePolicy: "cert" }) && !flowFor(1791158400, { ...ab, flowFv: "off" }));
  // peek (decisions between frames, MM_DECIDE_STEP_MS): a peek equals the frame at the same instant, and peeks in between
  // leave every later frame's features and prediction exactly as without them
  {
    const sp = new PriceBuffer(60_000), pp = new PriceBuffer(60_000);
    for (let t = t0 - 31_000; t <= t0 + 6_000; t += 10) { sp.push(t, 80000 + 3 * Math.sin(t / 700)); pp.push(t, 80002 + 4 * Math.sin(t / 500)); }
    const inp = (now: number): FlowIn => {
      const k = Math.floor((now - t0) / 100), b = 0.5 + (k % 7 === 0 ? 0.01 : 0);
      return { now, startTs: 1791158400, up: "U", down: "D", bids: [[b, 100 + 13 * (k % 5)], [b - 0.01, 200]], asks: [[b + 0.01, 90 + 7 * (k % 3)], [b + 0.02, 150]],
        fv: 0.5, m: 2e-5 * Math.sin(k / 9), sd: 0.001, tau: 200, nowcast: 80000, cl: 80000, clStamp: now - 1500, sigBase: 0.3e-4, kappa: 1.1, spot: sp, perp: pp };
    };
    const feed = (ff: FlowFv, t: number) => {
      const k = Math.floor((t - t0) / 10);
      ff.onBook("U", { bb: 0.5, bs: 100 + (k % 11), ba: 0.51, as: 90 + (k % 4) });
      if (k % 9 === 0) ff.onPrint(k % 2 ? "U" : "D", 0.51, 5 + (k % 6), k % 3 ? "BUY" : "SELL", t);
    };
    const fa = new FlowFv(g, 2), fb = new FlowFv(g, 2);
    let same = true, peekEq = true, n = 0;
    for (let t = t0; t <= t0 + 5_000; t += 10) {
      feed(fa, t); feed(fb, t);
      if ((t - t0) % 100 === 0) {
        const pk = fb.peek(inp(t));
        const a = fa.frame(inp(t)), b = fb.frame(inp(t));
        if (a.pred !== b.pred || a.x!.some((v, i) => !Object.is(v, b.x![i]))) same = false;
        if (pk.pred !== b.pred) peekEq = false;
        n++;
      } else fb.peek(inp(t));
    }
    ok("flow FV peek: equals the frame at the same instant", peekEq && n === 51);
    ok("flow FV peek: 9 peeks between frames leave every frame's features and prediction unchanged", same, `${n} frames`);
  }
  // decisions between frames: v4 windows only, tagged with the step
  const fast = { ...CFG, quotePolicy: "v4" as const, flowFv: "on" as const, decideStepMs: 10, paperFillModel: "queue" as const,
    decideEvents: "off" as const, decideFv: "frame" as const };   // no +ev / +fresh unless a case sets it (.env has them on)
  ok("10 ms decisions: v4 tag +10ms, off at 0 and for cert", fastFor(1791158400, fast) && windowTag(1791158400, fast).endsWith("+ffv+10ms") &&
    !fastFor(1791158400, { ...fast, decideStepMs: 0 }) && !windowTag(1791158400, { ...fast, decideStepMs: 0 }).includes("ms") && !fastFor(1791158400, { ...fast, quotePolicy: "cert" }));
  ok("event decisions: tag +10ms+evbook / +evall, none when off, without the 10 ms step or in a pair app",
    windowTag(1791158400, { ...fast, decideEvents: "book" }).endsWith("+ffv+10ms+evbook") && windowTag(1791158400, { ...fast, decideEvents: "all" }).endsWith("+10ms+evall") &&
    !windowTag(1791158400, { ...fast, decideEvents: "off" }).includes("+ev") && !windowTag(1791158400, { ...fast, decideStepMs: 0, decideEvents: "book" }).includes("+ev") &&
    !windowTag(1791158400, { ...fast, decideEvents: "book", pair: { ...CFG.pair, on: true } }).includes("+ev"));
  ok("fresh decide FV: tag +fresh after the step (and its events), none at frame or without the step",
    windowTag(1791158400, { ...fast, decideFv: "fresh" }).endsWith("+ffv+10ms+fresh") && windowTag(1791158400, { ...fast, decideEvents: "book", decideFv: "fresh" }).endsWith("+10ms+evbook+fresh") &&
    !windowTag(1791158400, { ...fast, decideFv: "frame" }).includes("fresh") && !windowTag(1791158400, { ...fast, decideStepMs: 0, decideFv: "fresh" }).includes("fresh"));
  {
    // MM_DECIDE_EVENTS' scheduler: one run for a burst, a kick inside the gap waits for its end, the gap counts from any run
    const runs: number[] = [];
    const k = new Kick(5, () => { runs.push(Date.now()); k.ran(); });
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) k.kick();
    await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
    ok("event kick: 20 kicks in one burst run once, on the next turn of the event loop", runs.length === 1, `${runs.length} runs, ${runs[0] - t0} ms`);
    k.kick(); k.kick();
    ok("event kick: a kick inside the 5 ms gap does not run at once", runs.length === 1 && k.deferred === 1);
    await new Promise((r) => setTimeout(r, 12));
    ok("event kick: ...it runs at the end of the gap, once", runs.length === 2 && runs[1] - runs[0] >= 4, `${runs.length} runs, ${runs[1] - runs[0]} ms apart`);
    k.ran();                                   // a timer step just ran
    ok("event kick: the gap also counts from a timer step", k.tooSoon() && !k.tooSoon(Date.now() + 5));
  }
  // the book feed's update hook: once per message per changed token, and top() without sorting
  const pmf = new PmBookFeed(() => {});
  pmf.setTokens(["U", "D"]);
  const seen: string[] = [];
  pmf.onBookUpdate((a) => seen.push(a));
  pmf.apply(JSON.stringify({ event_type: "book", asset_id: "U", bids: [{ price: "0.5", size: "10" }, { price: "0.49", size: "5" }], asks: [{ price: "0.52", size: "7" }] }), 1);
  pmf.apply(JSON.stringify({ event_type: "price_change", price_changes: [{ asset_id: "U", price: "0.51", size: "3", side: "BUY" }, { asset_id: "U", price: "0.52", size: "0", side: "SELL" }] }), 2);
  const tp = pmf.top("U");
  ok("book feed: one update per message, top of book", seen.join() === "U,U" && tp.bb === 0.51 && tp.bs === 3 && tp.ba == null && tp.as === 0, JSON.stringify(tp));
}



// ---- the sweep fill model (paperExchange.ts, PAPER_FILL_MODEL=sweep) ----
{
  const SW = { placeMs: 50, cancelMs: 70, bookLagMs: 35, feedLagMs: 37 };
  const B: BookView = { ready: true, bids: [[0.5, 20], [0.49, 50]], asks: [[0.52, 50]], bestBid: 0.5, bestAsk: 0.52, ageMs: 0, last: null };
  // an Up bid at 50¢ behind 20 others; a taker sells 40 Up at 13:00.000 (printed at its VWAP, 50¢), seen 37 ms later
  const run = (cancelAt: number | null, book: BookView = B, print = true, why = "pull") => {
    const ex = new PaperExchange(65, () => {}, 1, 1, undefined, 150, SW); ex.setTokens("U", "D");
    const o = ex.place({ win: 1, price: 0.5, size: 10, reason: "t" }, 0);
    const got: Fill[] = [];
    for (let t = 0; t <= 1500; t += 10) {
      if (cancelAt != null && t === cancelAt) ex.cancel(o, t, why);
      if (print && t === 1040) ex.onPrint({ asset: "U", price: 0.5, size: 40, side: "SELL", ts: 1000, rx: 1037 });
      got.push(...ex.step(t, 1, book, { fv: null, mid: null }));
    }
    return { o, got };
  };
  const a = run(null);
  ok("sweep: a 40-share sell walks 20 others + our 10 at 50¢ (and 10 at 49¢): we fill 10, via sweep", a.got.length === 1 && a.got[0].size === 10 && a.got[0].via === "sweep" && a.o.queue0 === 20,
    JSON.stringify(a.got.map((f) => [f.size, f.via])));
  const late = run(900), early = run(700);
  ok("sweep: a cancel sent 50 ms after the taker arrived (850) does not save the order", late.got.length === 1 && late.got[0].size === 10);
  ok("sweep: a cancel that reached the venue before the taker arrived does", early.got.length === 0 && early.o.status === "cancelled");
  // Fill.cxl / cxlWhy on paper (the fill signal's kinds, signal.ts): no cancel → cxl false, a race cancel in flight → "race"
  const race = run(900, B, true, "race: the level fell to 0 sh, under 50% of the 20 when it went live");
  ok("sweep cxlWhy: a resting fill has cxl false and no cxlWhy; a fill with a race cancel in flight is race, any other cancel other",
    a.got[0].cxl === false && a.got[0].cxlWhy === undefined && race.got.length === 1 && race.got[0].cxl === true && race.got[0].cxlWhy === "race" &&
    late.got[0].cxl === true && late.got[0].cxlWhy === "other", JSON.stringify([a, race, late].map((x) => [x.got[0]?.cxl, x.got[0]?.cxlWhy])));
  const crossed: BookView = { ...B, asks: [[0.5, 30]], bestAsk: 0.5 };
  const x = run(null, { ...B }, false);
  const ex2 = new PaperExchange(65, () => {}, 1, 1, undefined, 150, SW); ex2.setTokens("U", "D");
  ex2.place({ win: 1, price: 0.5, size: 10, reason: "t" }, 0);
  const g2: Fill[] = [];
  for (let t = 0; t <= 500; t += 10) g2.push(...ex2.step(t, 1, t < 200 ? B : crossed, { fv: null, mid: null }));
  ok("sweep: no fill from the book alone (no print), not even a crossed one", x.got.length === 0 && g2.length === 0);
  // the print's VWAP pins the walk: a 30-share sell printed at 49¢ cannot have stopped inside the 60 others at 50¢
  const ex3 = new PaperExchange(65, () => {}, 1, 1, undefined, 150, SW); ex3.setTokens("U", "D");
  const thin: BookView = { ...B, bids: [[0.5, 60], [0.49, 50]] };
  const o3 = ex3.place({ win: 1, price: 0.5, size: 10, reason: "t" }, 0);
  const g3: Fill[] = [];
  for (let t = 0; t <= 1500; t += 10) {
    if (t === 1040) ex3.onPrint({ asset: "U", price: 0.49, size: 30, side: "SELL", ts: 1000, rx: 1037 });
    g3.push(...ex3.step(t, 1, thin, { fv: null, mid: null }));
  }
  ok("sweep: the walk is pinned to the print's VWAP (the 60 at 50¢ had left: they were ahead of us, we fill)", g3.length === 1 && g3[0].size === 10 && o3.status === "filled",
    JSON.stringify(g3.map((f) => f.size)));

  // ---- venue times drawn per order (venueLatency.ts, PAPER_SWEEP_LAT) ----
  const LC: LatCfg = { mode: "live", calm: 0.35, move: 0.06, lookbackMs: 200, busyMs: 1000, sweptMs: 500, tauMs: 2000, seed: 7 };
  const seq = (cfg: LatCfg) => { const v = new VenueLatency(cfg); return [0, 300, 900, 5000].map((t) => [v.place(t).ms, v.cancel(t).ms]).flat(); };
  ok("venue times: the same seed draws the same times", seq(LC).join() === seq(LC).join() && seq(LC).join() !== seq({ ...LC, seed: 8 }).join(), seq(LC).join());
  const vl = new VenueLatency(LC);
  const p1 = vl.place(1000), p2 = vl.place(1000);
  vl.noteMove(1000);
  const pb = vl.place(1000);
  ok("venue times: orders sent together get the same quantile; after a move the same moment is busy (the swept table, slower)",
    p1.ms === p2.ms && p1.u === pb.u && !p1.busy && pb.busy && vl.at("place", p1.u, false) === p1.ms && vl.at("place", p1.u, true) === pb.ms &&
    vl.at("place", 0.5, true) > vl.at("place", 0.5, false) && vl.at("cancel", 0.5, true) > vl.at("cancel", 0.5, false), `${p1.ms} ${pb.ms}`);
  ok("venue times: busy lasts PAPER_SWEEP_LAT_BUSY_MS after the move", vl.busy(1999) && !vl.busy(2000) && new VenueLatency({ ...LC, mode: "busy" }).busy(0));
  vl.noteSweep(5000);
  ok("venue times: a sweep that reached our price makes the venue busy from 150 ms before the taker arrived to PAPER_SWEEP_LAT_SWEPT_MS after",
    !vl.busyAt(4849) && vl.busyAt(4850) && vl.busyAt(5500) && !vl.busyAt(5501));
  const vf = new VenueLatency({ ...LC, place: [100, 100], cancel: [40, 40] });
  ok("venue times: flat test tables without calm ones: calm = busy × 0.35, floored at 20 / 15", vf.place(0).ms === 35 && vf.cancel(0).ms === 15);
  // far-apart draws are independent ones from the measured tables: their quantiles come back
  const vb = new VenueLatency({ ...LC, mode: "busy" }), vc = new VenueLatency(LC), ps: number[] = [], cs: number[] = [], pc: number[] = [], cc: number[] = [];
  for (let i = 0; i < 4000; i++) { ps.push(vb.place(i * 60_000).ms); cs.push(vb.cancel(i * 60_000 + 1).ms); pc.push(vc.place(i * 60_000).ms); cc.push(vc.cancel(i * 60_000 + 1).ms); }
  const qq = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(p * a.length)];
  // swept cancel: the live race twins of 2026-11-03 (median 32, p90 77; the 10-23 table was 70 / 137)
  ok("venue times: busy draws reproduce the swept tables (place median 83 / p90 149, cancel 32 / 77), calm the calm ones (29 / 88, 26 / 82)",
    Math.abs(qq(ps, 0.5) - 83) < 8 && Math.abs(qq(ps, 0.9) - 149) < 20 && Math.abs(qq(cs, 0.5) - 32) < 4 && Math.abs(qq(cs, 0.9) - 77) < 15 &&
    Math.abs(qq(pc, 0.5) - 29) < 4 && Math.abs(qq(pc, 0.9) - 88) < 15 && Math.abs(qq(cc, 0.5) - 26) < 4 && Math.abs(qq(cc, 0.9) - 82) < 15,
    `busy place ${qq(ps, 0.5)} / ${qq(ps, 0.9)}, cancel ${qq(cs, 0.5)} / ${qq(cs, 0.9)}; calm place ${qq(pc, 0.5)} / ${qq(pc, 0.9)}, cancel ${qq(cc, 0.5)} / ${qq(cc, 0.9)}`);
  // in the exchange: the race of the sweep tests above (taker arrives 850, our cancel sent at 700 or 900)
  const runLat = (lat: LatCfg, cancelAt: number, move: number | null = null, earlyCancel = false) => {
    const ex = new PaperExchange(65, () => {}, 1, 1, undefined, 150, { ...SW, lat, earlyCancel }); ex.setTokens("U", "D");
    const o = ex.place({ win: 1, price: 0.5, size: 10, reason: "t" }, 0);
    const got: Fill[] = [];
    for (let t = 0; t <= 2500; t += 10) {
      if (move != null && t === move) ex.noteMove(t);
      if (t === cancelAt) ex.cancel(o, t, "pull");
      if (t === 1040) ex.onPrint({ asset: "U", price: 0.5, size: 40, side: "SELL", ts: 1000, rx: 1037 });
      got.push(...ex.step(t, 1, B, { fv: null, mid: null }));
    }
    return { o, got };
  };
  const flat = (place: number, cancel: number, mode: LatCfg["mode"] = "busy"): LatCfg => ({ ...LC, mode, place: [place, place], cancel: [cancel, cancel] });
  ok("venue times: constant tables (50 / 70 ms) race as the constants do", runLat(flat(50, 70), 700).got.length === 0 && runLat(flat(50, 70), 900).got.length === 1);
  const slow = runLat(flat(50, 200), 700);
  ok("venue times: a 200 ms cancel sent at 700 loses to the taker that arrived at 850 (70 ms won)", slow.got.length === 1 && slow.got[0].size === 10, JSON.stringify(slow.got.map((f) => f.size)));
  // the sweep's own orders: a cancel sent within 150 ms of the taker's arrival (850) resolves against the swept table
  const two = (calm: number, swept: number): LatCfg => ({ ...LC, mode: "live", place: [50, 50], cancel: [swept, swept], placeCalm: [50, 50], cancelCalm: [calm, calm] });
  ok("venue times: calm, a 60 ms cancel sent at 660 wins (lands 720 < 850); after a move at 600 the swept 200 ms loses (860)",
    runLat(two(60, 200), 660).got.length === 0 && runLat(two(60, 200), 660, 600).got.length === 1);
  ok("venue times: a cancel sent at 750, within 150 ms of the taker's arrival, is swept (200 ms) and loses; sent at 650 it is calm and wins",
    runLat(two(60, 200), 750).got.length === 1 && runLat(two(60, 200), 650).got.length === 0);

  // ---- the live venue's rules of 2026-10-23: self-cross, off the venue at the cancel answer, fills heard late ----
  const SW2: SweepCfg = { ...SW, heardMs: 0 };
  const mkx = (cfg: SweepCfg = SW2) => { const evs: string[] = []; const ex = new PaperExchange(65, (e) => evs.push(`${e.type}:${e.note}`), 1, 1, undefined, 150, cfg); ex.setTokens("U", "D"); return { ex, evs }; };
  let { ex: xs1, evs: ev1 } = mkx();
  const ub = xs1.place({ win: 1, price: 0.51, size: 10, reason: "t" }, 0);                // Up bid 51¢, a tick over the book's 50¢
  for (let t = 0; t <= 200; t += 10) xs1.step(t, 1, B, { fv: null, mid: null });
  const db = xs1.place({ win: 1, token: "DOWN", price: 0.49, size: 10, reason: "t" }, 200); // Down bid 49¢ = Up ask 51¢: clears the public 50¢ bid, crosses our own
  for (let t = 210; t <= 400; t += 10) xs1.step(t, 1, B, { fv: null, mid: null });
  ok("self-cross: a Down bid whose Up-ask price is at our own resting Up bid is refused, with the venue's reason",
    ub.status === "open" && db.status === "rejected" && ev1.some((e) => /^reject:post-only: would cross our own Up bid #1 at 51¢ \(post_only_would_cross\)/.test(e)), ev1.filter((e) => e.startsWith("reject")).join(" | "));
  ({ ex: xs1, evs: ev1 } = mkx());
  const ub2 = xs1.place({ win: 1, price: 0.51, size: 10, reason: "t" }, 0);
  for (let t = 0; t <= 200; t += 10) xs1.step(t, 1, B, { fv: null, mid: null });
  xs1.cancel(ub2, 200, "pull");                                                              // lands at 270 (cancel 70)
  const db2 = xs1.place({ win: 1, token: "DOWN", price: 0.49, size: 10, reason: "t" }, 230); // at the venue at 280: the bid is gone
  const db3 = xs1.place({ win: 1, token: "DOWN", price: 0.48, size: 10, reason: "t" }, 240); // Up ask 52¢ over the 51¢ bid: fine anyway
  for (let t = 240; t <= 500; t += 10) xs1.step(t, 1, B, { fv: null, mid: null });
  ok("self-cross: not against a bid whose cancel landed before this order reached the venue, nor a price that does not cross",
    db2.status === "open" && db3.status === "open", `${db2.status} ${db3.status}`);
  const { ex: xs2 } = mkx({ ...SW2, selfCross: false });
  xs2.place({ win: 1, price: 0.51, size: 10, reason: "t" }, 0);
  for (let t = 0; t <= 200; t += 10) xs2.step(t, 1, B, { fv: null, mid: null });
  const db4 = xs2.place({ win: 1, token: "DOWN", price: 0.49, size: 10, reason: "t" }, 200);
  for (let t = 210; t <= 400; t += 10) xs2.step(t, 1, B, { fv: null, mid: null });
  ok("self-cross: PAPER_SELF_CROSS=off accepts it (the rule before 2026-10-23)", db4.status === "open");
  // off the venue at the cancel's answer: the order manager's pending cap stops counting the order at cancel + 70 + 10
  const { ex: xs3 } = mkx();
  const oc3 = xs3.place({ win: 1, price: 0.5, size: 10, reason: "t" }, 0);
  for (let t = 0; t <= 200; t += 10) xs3.step(t, 1, B, { fv: null, mid: null });
  xs3.cancel(oc3, 200, "pull");
  xs3.step(300, 1, B, { fv: null, mid: null });
  ok("off the venue: a cancelling order carries offAt = cancel + 70 + 10 and is still working in the exchange past it (fillable until no print can reach it)",
    oc3.offAt === 280 && oc3.status === "cancelling" && xs3.working(1).length === 1, `${oc3.offAt} ${oc3.status}`);
  const { ex: xs4 } = mkx({ ...SW2, pendingUntil: "tail" });
  const oc4 = xs4.place({ win: 1, price: 0.5, size: 10, reason: "t" }, 0);
  for (let t = 0; t <= 200; t += 10) xs4.step(t, 1, B, { fv: null, mid: null });
  xs4.cancel(oc4, 200, "pull");
  ok("off the venue: PAPER_PENDING_UNTIL=tail sets none (the cap counts it to the end, as before)", oc4.offAt == null);
  {
    const Bq = (bb: number, ba: number): BookView => ({ ready: true, bids: [[bb, 300]], asks: [[ba, 300]], bestBid: bb, bestAsk: ba, ageMs: 0, last: null });
    const qt = (bid: number): Quote =>
      ({ policy: "v4", bid, ask: null, bidSize: 10, askSize: 0, center: bid + 0.005, skew: 0, reservation: bid + 0.005, why: "", off: { bid: null, ask: "off" }, steps: [] });
    const exq = new PaperExchange(65, () => {}, 1, 1, undefined, 150, SW2); exq.setTokens("U", "D");
    const oms = new OrderManager(exq, 1000, { ticks: 1, edge: 0.0025, stayAtTouch: true });
    const c = { free: 1000, minSize: 5, tick: 0.01, bestBid: 0.49, bestAsk: 0.5, cap: { net: 35, max: 50 } };
    oms.sync(1, qt(0.49), 0, c); for (let t = 0; t <= 200; t += 10) exq.step(t, 1, Bq(0.49, 0.5), { fv: 0.5, mid: 0.495 });
    oms.sync(1, qt(0.47), 200, c);                                                     // replace: the 49¢ bid's cancel lands at 270, answered 280
    const s1 = exq.working(1).map((o) => o.size - o.filled);
    for (let t = 210; t <= 290; t += 10) exq.step(t, 1, Bq(0.49, 0.5), { fv: 0.5, mid: 0.495 });
    const a2 = oms.sync(1, qt(0.45), 290, c);
    const s2 = exq.working(1).filter((o) => o.status !== "cancelling").map((o) => o.size - o.filled);
    ok("off the venue: the cap counts the replaced bid (new one cut to 5) until its cancel is answered, then not (the next replace gets the full 10)",
      JSON.stringify(s1) === "[10,5]" && a2[0].act === "replace" && JSON.stringify(s2) === "[10]", JSON.stringify([s1, a2[0].note, s2]));
  }
  // fills heard 80 ms after the venue's match: the fill is returned on the first step at or after print time + 80
  const runHeard = (heardMs: number) => {
    const ex = new PaperExchange(65, () => {}, 1, 1, undefined, 150, { ...SW, heardMs }); ex.setTokens("U", "D");
    const o = ex.place({ win: 1, price: 0.5, size: 10, reason: "t" }, 0);
    const at: number[] = [];
    for (let t = 0; t <= 1500; t += 10) {
      if (t === 1040) ex.onPrint({ asset: "U", price: 0.5, size: 40, side: "SELL", ts: 1000, rx: 1037 });
      for (const f of ex.step(t, 1, B, { fv: null, mid: null })) at.push(t + f.size / 1000);
    }
    return { o, at, filledAt: o.doneAt };
  };
  const h0 = runHeard(0), h80 = runHeard(80);
  ok("heard: with PAPER_FILL_HEARD_MS=80 the fill reaches the trader at 1080 (print at 1000 on the venue clock), not at 1040; the order itself filled at the print",
    JSON.stringify(h0.at) === "[1040.01]" && JSON.stringify(h80.at) === "[1080.01]" && h80.filledAt === 1037 && h80.o.status === "filled", JSON.stringify([h0.at, h80.at, h80.filledAt]));
  // as live, a cancel waits for the post's answer (the venue's order id): an 800 ms post cancelled at 500 rests 800 → 870
  const waited = runLat(flat(800, 60), 500), early60 = runLat(flat(50, 60), 500);
  ok("venue times: a cancel waits for the post's answer: an 800 ms post cancelled at 500 is still there for the taker at 850",
    waited.got.length === 1 && waited.o.cancelMs === 800 + 10 - 500 + 60 && early60.got.length === 0, `cancelMs ${waited.o.cancelMs}`);
  // PAPER_EARLY_CANCEL: the cancel goes at once (no wait for the answer); one that lands before the order is placed means
  // the venue refuses the post, so the 800 ms post cancelled at 500 (lands 560) never rests and the taker at 850 finds nothing
  const ec60 = runLat(flat(800, 60), 500, null, true), ec400 = runLat(flat(800, 400), 500, null, true);
  ok("early cancel (paper): the cancel does not wait; landing before the placement, the order never rests (no fill, never live)",
    ec60.o.cancelMs === 60 && ec60.got.length === 0 && ec60.o.status === "cancelled" && ec60.o.liveAt == null, `cancelMs ${ec60.o.cancelMs} ${ec60.o.status} ${ec60.o.liveAt}`);
  ok("early cancel (paper): landing after the taker arrived (500 + 400 > 850) it still fills, as live",
    ec400.o.cancelMs === 400 && ec400.got.length === 1, `cancelMs ${ec400.o.cancelMs} fills ${ec400.got.length}`);
  ok("early cancel (paper): tag +lat+ec+sweep", windowTag(1791158400, { ...CFG, mode: "paper", paperFillModel: "sweep", paperSweep: { ...CFG.paperSweep, lat: LC, earlyCancel: true, hold: true } }).endsWith("+lat+ec+sweep"));
  // earlyCancel off: .env's PAPER_EARLY_CANCEL (on since 2026-11-03) would add +ec; hold on: PAPER_TAKER_HOLD=off would add +nh
  const noEc = { ...CFG.paperSweep, earlyCancel: false, hold: true };
  // PAPER_TAKER_HOLD=off: the taker of the race tests arrives at 850 and prints at 1000. A 200 ms cancel sent at 700 lands at
  // 900: inside the hold, so on it fills and off it escapes. Sent at 900 it lands at 1100, after the print: filled either way.
  const runHold = (hold: boolean, cancelAt: number) => {
    const ex = new PaperExchange(65, () => {}, 1, 1, undefined, 150, { ...SW, cancelMs: 200, hold }); ex.setTokens("U", "D");
    const o = ex.place({ win: 1, price: 0.5, size: 10, reason: "t" }, 0);
    const got: Fill[] = [];
    for (let t = 0; t <= 2500; t += 10) {
      if (t === cancelAt) ex.cancel(o, t, "pull");
      if (t === 1040) ex.onPrint({ asset: "U", price: 0.5, size: 40, side: "SELL", ts: 1000, rx: 1037 });
      got.push(...ex.step(t, 1, B, { fv: null, mid: null }));
    }
    return got.length;
  };
  ok("taker hold: a cancel landing inside the hold (900, taker 850, print 1000) fills with PAPER_TAKER_HOLD on, escapes off",
    runHold(true, 700) === 1 && runHold(false, 700) === 0, `on ${runHold(true, 700)} off ${runHold(false, 700)}`);
  ok("taker hold: a cancel landing after the print (1100) fills either way; no cancel fills either way",
    runHold(true, 900) === 1 && runHold(false, 900) === 1 && runHold(false, -1) === 1);
  // MM_CANCEL_DELAY_MS: hold off, cancel 200 ms, decided at 700. No delay: lands 900, before the print (1000) → escapes.
  // 150 ms delay: sent 850, lands 1050, after the print → filled. Decided at 1000 + no print after: nothing either way.
  const runDelay = (delay: number, cancelAt: number) => {
    const ex = new PaperExchange(65, () => {}, 1, 1, undefined, 150, { ...SW, cancelMs: 200, hold: false }, 215, false, delay); ex.setTokens("U", "D");
    const o = ex.place({ win: 1, price: 0.5, size: 10, reason: "t" }, 0);
    const got: Fill[] = [];
    for (let t = 0; t <= 2500; t += 10) {
      if (t === cancelAt) ex.cancel(o, t, "pull");
      if (t === 1040) ex.onPrint({ asset: "U", price: 0.5, size: 40, side: "SELL", ts: 1000, rx: 1037 });
      got.push(...ex.step(t, 1, B, { fv: null, mid: null }));
    }
    return { n: got.length, o };
  };
  { const d0 = runDelay(0, 700), d150 = runDelay(150, 700);
    ok("cancel delay (paper): a cancel decided at 700 escapes the 1000 print without the delay, is filled with 150 ms",
      d0.n === 0 && d150.n === 1 && d150.o.cancelMs === 350, `no delay ${d0.n} · 150 ms ${d150.n} cancelMs ${d150.o.cancelMs}`);
    ok("cancel delay: tag +cd150 with MM_CANCEL_DELAY_MS=150, none at 0",
      quoteTag("v5", { ...CFG, cancelDelayMs: 150 }).endsWith("+cd150") && !quoteTag("v5", { ...CFG, cancelDelayMs: 0 }).includes("+cd")); }
  ok("taker hold: tag +nh before +sweep when off, none when on",
    windowTag(1791158400, { ...CFG, mode: "paper", paperFillModel: "sweep", paperSweep: { ...CFG.paperSweep, lat: LC, earlyCancel: true, hold: false } }).endsWith("+lat+ec+nh+sweep") &&
    windowTag(1791158400, { ...CFG, mode: "paper", paperFillModel: "sweep", paperSweep: { ...noEc, lat: LC } }).endsWith("+lat+sweep"));
  ok("venue times: tag +lat / +latbusy before +sweep", windowTag(1791158400, { ...CFG, mode: "paper", paperFillModel: "sweep", paperSweep: { ...noEc, lat: LC } }).endsWith("+lat+sweep") &&
    windowTag(1791158400, { ...CFG, mode: "paper", paperFillModel: "sweep", paperSweep: { ...noEc, lat: { ...LC, mode: "busy" } } }).endsWith("+latbusy+sweep") &&
    windowTag(1791158400, { ...CFG, mode: "paper", paperFillModel: "sweep", decideEvents: "off", decideFv: "frame", paperSweep: { ...noEc, lat: null } }).endsWith("ms+sweep"));
  ok("MM_TAG: the window's name is the short tag when set, else the full tag; the full tag is unchanged",
    windowName(1791158400, { ...CFG, tagName: "v6" }) === "v6" && windowName(1791158400, { ...CFG, tagName: "" }) === windowTag(1791158400, CFG) &&
    windowTag(1791158400, { ...CFG, tagName: "v6" }) === windowTag(1791158400, CFG));
  ok("venue times: PAPER_SWEPT_CANCEL=1023 tags +lat+sc1023 and draws the old swept cancel table (median 70)",
    windowTag(1791158400, { ...CFG, mode: "paper", paperFillModel: "sweep", paperSweep: { ...noEc, lat: { ...LC, cancel: SWEPT_CANCEL_MS_1023, cancelCalm: CALM_CANCEL_MS, sweptCancel: "1023" } } }).endsWith("+lat+sc1023+sweep") &&
    new VenueLatency({ ...LC, cancel: SWEPT_CANCEL_MS_1023, cancelCalm: CALM_CANCEL_MS }).at("cancel", 0.5, true) === 70 &&
    new VenueLatency({ ...LC, cancel: SWEPT_CANCEL_MS_1023, cancelCalm: CALM_CANCEL_MS }).at("cancel", 0.5, false) === 26);
  // ---- PAPER_NEWBEST_LAT: a post that sets a new best price draws its place time from the live twins' table ----
  { const NB: LatCfg = { ...LC, newBest: TWIN_NEWBEST_PLACE_MS }, vn = new VenueLatency(NB), v0 = new VenueLatency(LC);
    ok("new best: the twin table (median 288, p90 1,128) busy or calm; other posts and the knob off keep the calm / swept tables",
      vn.at("place", 0.5, false, true) === 288 && vn.at("place", 0.5, true, true) === 288 && vn.at("place", 0.9, false, true) === 1128 &&
      vn.at("place", 0.5, false) === 29 && vn.at("place", 0.5, true) === 83 && vn.at("cancel", 0.5, false, true) === 26 &&
      v0.at("place", 0.5, false, true) === 29 && vn.newBestOn && !v0.newBestOn,
      `${vn.at("place", 0.5, false, true)} ${vn.at("place", 0.5, false)} ${v0.at("place", 0.5, false, true)}`);
    // the book: Up bid 50¢, ask 52¢; the class is judged on the latest book view at the send
    const nbBook = (bids: [number, number][], asks: [number, number][]): BookView =>
      ({ ready: true, bids, asks, bestBid: bids[0]?.[0] ?? null, bestAsk: asks[0]?.[0] ?? null, ageMs: 0, last: null });
    const B = nbBook([[0.5, 100]], [[0.52, 50]]);
    const nbEx = (lat: LatCfg) => { const ex = new PaperExchange(65, () => {}, 1, 1, undefined, 150, { ...SW, lat, earlyCancel: true }); ex.setTokens("U", "D"); return ex; };
    const ex = nbEx(NB);
    const cold = ex.place({ win: 1, price: 0.51, size: 10, reason: "t" }, 0);
    ex.step(10, 1, B, { fv: null, mid: null });
    const imp = ex.place({ win: 1, price: 0.51, size: 10, reason: "t" }, 20), join = ex.place({ win: 1, price: 0.5, size: 10, reason: "t" }, 20),
      dn = ex.place({ win: 1, token: "DOWN", price: 0.49, size: 10, reason: "t" }, 20), dnJoin = ex.place({ win: 1, token: "DOWN", price: 0.48, size: 10, reason: "t" }, 20);
    ok("new best: an Up bid over the best bid and a Down bid under 1 − the best ask are new best; joins are not; no book view yet = not",
      !!imp.placeNewBest && !!dn.placeNewBest && !join.placeNewBest && !dnJoin.placeNewBest && !cold.placeNewBest &&
      imp.placeMs === new VenueLatency(NB).at("place", imp.placeU!, false, true) && join.placeMs! < imp.placeMs!,
      `imp ${imp.placeNewBest} ${imp.placeMs} · join ${join.placeNewBest} ${join.placeMs} · dn ${dn.placeNewBest} · dnJoin ${dnJoin.placeNewBest} · cold ${cold.placeNewBest}`);
    const off = nbEx(LC); off.step(10, 1, B, { fv: null, mid: null });
    ok("new best: PAPER_NEWBEST_LAT=off leaves a new-best post on the calm / swept tables", !off.place({ win: 1, price: 0.51, size: 10, reason: "t" }, 20).placeNewBest);
    // its post-only check runs at the drawn arrival: the ask falls to 51¢ at 200 ms, before a 500 ms new-best post lands
    const arrive = (newBest: number[] | null) => {
      const e = nbEx({ ...LC, place: [30, 30], placeCalm: [30, 30], newBest }); e.step(0, 1, B, { fv: null, mid: null });
      const o = e.place({ win: 1, price: 0.51, size: 10, reason: "t" }, 0);
      for (let t = 10; t <= 800; t += 10) e.step(t, 1, t < 200 ? B : nbBook([[0.5, 100]], [[0.51, 50]]), { fv: null, mid: null });
      return o.status;
    };
    ok("new best: the post-only check runs at the drawn arrival (500 ms: the ask came down to it, refused; 30 ms: on the book)",
      arrive([500, 500]) === "rejected" && arrive(null) === "open", `${arrive([500, 500])} / ${arrive(null)}`);
    const tagOf = (lat: LatCfg) => windowTag(1791158400, { ...CFG, mode: "paper", paperFillModel: "sweep", paperSweep: { ...CFG.paperSweep, lat, earlyCancel: true, hold: false } });
    ok("new best: tag +nb3 (copies3 table) / +nb (twin288) right after +lat",
      tagOf({ ...LC, newBest: COPIES3_NEWBEST_PLACE_MS, newBestName: "copies3" }).endsWith("+lat+nb3+ec+nh+sweep") &&
      tagOf({ ...NB, newBestName: "twin288" }).endsWith("+lat+nb+ec+nh+sweep"));
    ok("new best: the default is the copies3 table (median 97, p90 332; live with 3 copies, 11-09)",
      CFG.paperSweep.lat?.newBestName === "copies3" && new VenueLatency({ ...LC, newBest: CFG.paperSweep.lat!.newBest }).at("place", 0.5, true, true) === 97 &&
      new VenueLatency({ ...LC, newBest: COPIES3_NEWBEST_PLACE_MS }).at("place", 0.9, false, true) === 332, `${CFG.paperSweep.lat?.newBestName}`); }
  // the engine's latency detector: a MoveSignal with nothing filtered fires on every step the move is there
  const ls = new MoveSignal({ ...CFG.signal, minMove: 0.06, lookbackMs: 200, leadOnly: false, minPred: null, top: null, cooldownMs: 0 }, "lat");
  const smp = (now: number, bid: number, ask: number): SigSample => ({ now, win: 1, slug: "s", up: "U", down: "D", elapsed: 10, left: 200, bid, ask, bb: 0.5, ba: 0.52,
    centre: 0.51, centerSrc: "flow FV", pred: null, step: "decide" });
  const fired = [smp(0, 0.5, 0.52), smp(100, 0.53, 0.55), smp(200, 0.565, 0.585), smp(210, 0.565, 0.585), smp(400, 0.565, 0.585)].map((s) => !!ls.sample(s));
  ok("venue times: the latency detector fires at 6¢ in 200 ms on each step it holds, then stops", fired.join() === "false,false,true,true,false", fired.join());
}

// ---- move signal (signal.ts): a big target-quote move within the lookback, side by side, once per direction ----
{
  // the mechanics with every move let through; leadOnly (the default) is checked last
  const cfg = { minMove: 0.03, lookbackMs: 100, cooldownMs: 1000, heartbeatMs: 1000, leadOnly: false, minPred: null, top: null };
  const at = (now: number, bid: number | null, ask: number | null, o: Partial<SigSample> = {}): SigSample => ({
    now, win: 1000, slug: "s", up: "U", down: "D", elapsed: now / 1000, left: 300 - now / 1000, bid, ask,
    bb: 0.5, ba: 0.51, centre: null, centerSrc: "flow FV", pred: 1.5, step: "decide", ...o });
  // decide steps every 10 ms: the target climbs 1¢ a step from 50/52 at 100 ms; it is 3¢ above the target 100 ms back at 130 ms
  const s = new MoveSignal(cfg);
  const fired: (MoveMsg | null)[] = [];
  for (let t = 0; t <= 200; t += 10) { const k = Math.max(0, Math.min(5, (t - 100) / 10)); fired.push(s.sample(at(t, 0.5 + k / 100, 0.52 + k / 100))); }
  const f = fired.filter((x): x is MoveMsg => x != null);
  ok("signal: fires on the first step 3¢ above the target 100 ms back, once (the 1 s cooldown)",
    f.length === 1 && f[0].t === 130 && f[0].dir === "up" && f[0].move === 0.03 && f[0].target.bid0 === 0.5 && f[0].up === "U", JSON.stringify(f.map((x) => [x.t, x.move])));
  ok("signal: the book had not moved, so it leads; the 2 s prediction comes in price units", f[0].lead === true && f[0].book.move === 0 && f[0].pred === 0.015);
  const s0 = new MoveSignal(cfg);
  s0.sample(at(0, 0.5, 0.52));
  ok("signal: 2¢ does not fire", s0.sample(at(100, 0.52, 0.54)) === null);
  // after an up signal: another up move inside the cooldown is quiet, a down move fires at once
  s.sample(at(300, 0.55, 0.57));
  ok("signal: a second up move inside 1 s is held back", s.sample(at(400, 0.59, 0.61)) === null);
  s.sample(at(500, 0.59, 0.61));
  const dn = s.sample(at(600, 0.55, 0.57, { bb: 0.53, ba: 0.54 }));
  ok("signal: a down move fires inside the up cooldown; the book moved too (not a lead)", dn?.dir === "down" && dn.move === -0.04 && dn.lead === false && dn.book.move !== 0, JSON.stringify(dn));
  ok("signal: up again once the cooldown is over", (s.sample(at(1200, 0.55, 0.57)), s.sample(at(1300, 0.6, 0.62)))?.dir === "up");
  // a side compares only with itself: the ask appearing 5¢ above the bid is no move
  const s2 = new MoveSignal(cfg);
  s2.sample(at(0, 0.5, null));
  ok("signal: a side appearing is not a move", s2.sample(at(100, 0.5, 0.55)) === null);
  ok("signal: one side present both times is enough (the bid gone, the ask 3¢ up)", s2.sample(at(200, null, 0.58))?.move === 0.03);
  // a new window starts afresh; a stalled step loop (reference older than twice the lookback) does not fire
  const s3 = new MoveSignal(cfg);
  s3.sample(at(0, 0.5, 0.52));
  ok("signal: no comparison across windows", s3.sample(at(100, 0.6, 0.62, { win: 1300 })) === null);
  ok("signal: no comparison over a stall", s3.sample(at(400, 0.7, 0.72, { win: 1300 })) === null);
  const s4 = new MoveSignal(cfg);
  s4.sample(at(0, 0.5, 0.52));
  ok("signal: a target re-centred on another source is no move", s4.sample(at(100, 0.6, 0.62, { centerSrc: "anchored FV", pred: null })) === null);
  // leadOnly: only a move the book has not made yet, on the flow forecast's side
  const lo = (o: Partial<SigSample>) => {
    const x = new MoveSignal({ ...cfg, leadOnly: true });
    x.sample(at(0, 0.5, 0.52));
    return x.sample(at(100, 0.53, 0.55, o));
  };
  ok("signal leadOnly: the book still, the forecast up → fires", lo({})?.dir === "up");
  ok("signal leadOnly: the book moved with it → nothing (the target only followed)", lo({ bb: 0.52, ba: 0.53 }) === null);
  ok("signal leadOnly: the forecast down or missing → nothing", lo({ pred: -0.4 }) === null && lo({ pred: null }) === null);
  ok("signal leadOnly: a held-back move leaves the cooldown free", (() => {
    const x = new MoveSignal({ ...cfg, leadOnly: true });
    x.sample(at(0, 0.5, 0.52)); x.sample(at(100, 0.53, 0.55, { pred: -1 }));
    x.sample(at(200, 0.53, 0.55)); return x.sample(at(300, 0.56, 0.58))?.dir === "up";
  })());
  ok("signal: leadOnly is the default", CFG.signal.leadOnly === true);
  // leadMode excess (PAIR_LEAD): the book may move the target's way, if the target moved minMove more than its mid
  const ex = (o: Partial<SigSample>) => {
    const x = new MoveSignal({ ...cfg, leadOnly: true, leadMode: "excess" });
    x.sample(at(0, 0.5, 0.52));                         // book 50/51
    return x.sample(at(100, 0.54, 0.56, o));            // the target 4¢ up
  };
  ok("signal excess: the book still → fires, as unmoved does", ex({})?.lead === true);
  ok("signal excess: the book 1¢ up, the target 3¢ ahead of it → fires", (() => { const m = ex({ bb: 0.51, ba: 0.52 }); return m?.dir === "up" && m.lead === true && m.book.move! > 0; })());
  ok("signal excess: the book 2¢ up, the target only 2¢ ahead → nothing", ex({ bb: 0.52, ba: 0.53 }) === null);
  ok("signal excess: the book 1¢ the other way → nothing", ex({ bb: 0.49, ba: 0.5 }) === null);
  ok("signal excess: the forecast against it → nothing", ex({ bb: 0.51, ba: 0.52, pred: -0.4 }) === null);
  // measure free (PAIR_MOVE): a side the post-only rule held a tick off the book is left out of the move
  const fr = (measure: "both" | "free", o: Partial<SigSample>, o0: Partial<SigSample> = {}) => {
    const x = new MoveSignal({ ...cfg, minMove: 0.12, leadOnly: true, leadMode: "excess", measure });
    x.sample(at(0, 0.5, 0.52, { bb: 0.51, ba: 0.52, ...o0 }));
    return x.sample(at(100, 0.29, 0.52, { bb: 0.51, ba: 0.52, pred: -10.6, held: { bid: false, ask: true }, ...o }));
  };
  ok("signal free: the bid 21¢ down, the ask held at the best bid + 1¢ → both reads −10.5¢ (nothing at 12¢), free −21¢ fires",
    fr("both", {}) === null && fr("free", {})?.move === -0.21 && fr("free", {})?.dir === "down", JSON.stringify(fr("free", {})));
  ok("signal free: a side held at the start counts as held", fr("free", { held: { bid: false, ask: false } }, { held: { bid: false, ask: true } })?.move === -0.21);
  ok("signal free: no side held → the average, as both (the arithmetic: −21¢ and −19¢)", fr("free", { ask: 0.33, held: { bid: false, ask: false } })?.move === -0.2);
  ok("signal free: the default measure is both", fr("both", { held: undefined }) === null && new MoveSignal(cfg).cfg.measure === undefined);
  // minPred: the forecast must back the move by at least 3.5¢ (pred comes in ¢)
  const fp = (pred: number | null, up = true) => {
    const x = new MoveSignal({ ...cfg, leadOnly: true, minPred: 0.035 });
    x.sample(at(0, 0.5, 0.52));
    return x.sample(up ? at(100, 0.53, 0.55, { pred }) : at(100, 0.47, 0.49, { pred }));
  };
  ok("signal minPred: a 4¢ forecast fires, 3¢ does not", fp(4)?.dir === "up" && fp(3) === null);
  ok("signal minPred: it counts on the move's side (a −4¢ forecast backs a down move only)", fp(-4, false)?.dir === "down" && fp(-4) === null && fp(null) === null);
  ok("signal: minPred 3.5¢ is the default; the pair trade's detector keeps none", CFG.signal.minPred === 0.035);
  // top: the strongest third by forecast of the moves found lately (floor 0); each move counted once per cooldown
  {
    const x = new MoveSignal({ ...cfg, leadOnly: true, minPred: 0, top: 1 / 3 });
    let t = 0, fired = 0;
    const move = (pred: number) => { x.sample(at(t, 0.5, 0.52)); const m = x.sample(at(t + 100, 0.53, 0.55, { pred })); t += 1200; if (m) fired++; return m; };
    for (let k = 1; k <= 20; k++) move(k / 10);      // forecasts 0.1..2¢: until 20 moves are known, the floor alone decides
    ok("signal top: until 20 moves are known the floor alone decides", fired === 20 && x.state(t).cut === 0.014, `${fired} ${JSON.stringify(x.state(t))}`);
    ok("signal top: then only the strongest third passes (cut 1.4¢: 1¢ no, 1.9¢ yes)", move(1) === null && move(1.9)?.dir === "up", JSON.stringify(x.state(t)));
    const y = new MoveSignal({ ...cfg, leadOnly: true, minPred: 0.035, top: 1 / 3 });
    y.sample(at(0, 0.5, 0.52));
    for (let s = 100; s <= 150; s += 10) y.sample(at(s, 0.53, 0.55, { pred: 1 }));   // one move, six steps over 3¢
    ok("signal top: a move held over several steps is one candidate; the floor still applies", (y as unknown as { cands: number[] }).cands.length === 1 && y.state(150).cut === 0.035);
    ok("signal top: a move is judged once (its forecast growing a step later does not get it out)", y.sample(at(160, 0.53, 0.55, { pred: 6 })) === null);
  }
  const off = new MoveSignal({ ...cfg, minMove: null });
  off.sample(at(0, 0.5, 0.52));
  ok("signal: off never fires and is not armed", off.sample(at(100, 0.6, 0.62)) === null && off.state(100).armed === false && s3.state(400).armed === true);
  // a named detector (/signal-fast) tags its messages and heartbeats; /signal's carry no name, as before
  const nf = new MoveSignal(cfg, "fast");
  nf.sample(at(0, 0.5, 0.52));
  const nm = nf.sample(at(100, 0.53, 0.55));
  ok("signal: a named detector tags its moves and state; an unnamed one does not", nm?.signal === "fast" && nf.state(100).signal === "fast" &&
    f[0].signal === undefined && !("signal" in f[0]) && !("signal" in s.state(0)), JSON.stringify(nm));
  ok("signal: /signal-fast is the pair's detector at 5¢ in 100 ms (lead-only, no forecast threshold)",
    CFG.fastSignal.minMove === 0.05 && CFG.fastSignal.lookbackMs === 100 && CFG.fastSignal.leadOnly && CFG.fastSignal.minPred === null && CFG.fastSignal.top === null);
}

// ---- pair trade (pairTrader.ts): leg 1 on a lead signal, leg 2 two seconds on, on the real trader and paper exchange ----
{
  const mk = (tag: string, o: Partial<typeof CFG.pair> = {}) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mm-selftest-"));
    const pm = { onPrint: () => {} } as unknown as ConstructorParameters<typeof Trader>[0];
    const store = { entries: () => [], get: () => undefined } as unknown as ConstructorParameters<typeof Trader>[1];
    const logs: string[] = [];
    const tr = new Trader(pm, store, () => {}, tmp);
    const pt = new PairTrader(tr, { ...CFG.pair, on: true, leg1: "taker", lookbackMs: 100, minMove: 0.05, slip: 0.01, size: 10, holdMs: 2000, closeEdge: null, stopMove: null, stopMs: 3000, closeSlip: 0.05, untilSec: 240, maxPrice: 0.75, l2Model: "off", ...o }, (m) => logs.push(m));
    return { tmp, tr, pt, logs, tag };
  };
  const book = (bb: number, bs: number, ba: number, as: number): BookView =>
    ({ ready: true, bids: [[bb, bs]], asks: [[ba, as]], bestBid: bb, bestAsk: ba, ageMs: 0, last: null });
  // the window's 100 ms rows the leg-2 model reads (none: it scores nothing)
  let ROWS: (number | null)[][] = [];
  const ctx = (now: number, b: BookView, win = 1000): PairCtx => ({ win, endTs: win + 300, elapsed: 60 + now / 1000, left: 240 - now / 1000, minSize: 5, tick: 0.01, book: b,
    rows: ROWS, cols: COLS, Kcl: null });
  const smp = (now: number, bid: number, ask: number, b: BookView, o: Partial<SigSample> = {}): SigSample => ({
    now, win: 1000, slug: "s", up: "U", down: "D", elapsed: 60 + now / 1000, left: 240 - now / 1000, bid, ask,
    bb: b.bestBid, ba: b.bestAsk, centre: null, centerSrc: "flow FV", pred: 2, step: "decide", ...o });
  // the exchange and the account step on the window's Up book; then the pair trade
  const run = (x: ReturnType<typeof mk>, now: number, b: BookView, win = 1000) => {
    x.tr.pre({ now, win, endTs: win + 300, up: "U", down: "D", book: b, fv: null, mid: null });
    x.pt.step(ctx(now, b, win), now);
  };
  const fee = (p: number) => 0.07 * p * (1 - p);

  // 1. a 5¢ up move, the book unmoved: 10 Up ≤ 47¢; filled at 47¢ (the ask moved up a tick in the hold); 2 s on the Up bid
  //    is 52¢, so 10 Down at 48¢: a pair at 95¢
  const A = mk("paired");
  try {
    const B0 = book(0.45, 100, 0.46, 100);
    run(A, 0, B0); A.pt.sample(smp(0, 0.44, 0.47, B0), ctx(0, B0), 0);
    const sig1 = A.pt.sample(smp(100, 0.49, 0.52, B0), ctx(100, B0), 100);
    const l1 = A.tr.hello(1000).events.find((e) => e.type === "place");
    ok("pair: a 5¢ lead signal sends leg 1, a fill-and-kill 10 Up ≤ 47¢ (ask 46¢ + 1¢)", l1?.token === "UP" && l1.tokenPrice === 0.47 && l1.size === 10 && A.tr.takeInFlight(1000) === "UP",
      JSON.stringify(l1));
    ok("pair: its detector's signal is the /signal-pair message, tagged \"signal\": \"pair\" (the record still says own)",
      sig1?.type === "move" && sig1.signal === "pair" && sig1.dir === "up" && sig1.move === 0.05 && A.pt.records(1000)[0]?.signal === "own", JSON.stringify(sig1));
    const B1 = book(0.46, 100, 0.47, 100);
    run(A, 400, B1);
    ok("pair: leg 1 fills 10 Up at 47¢ and holds", A.tr.position(1000).up === 10 && A.pt.actions(ctx(400, B1), 400)[0].act === "hold", A.logs.join(" | "));
    A.pt.sample(smp(600, 0.55, 0.58, B1), ctx(600, B1), 600);     // another signal while the pair is open
    run(A, 2300, B1);
    ok("pair: nothing else goes out while it holds (a second signal is skipped)", A.tr.hello(1000).events.filter((e) => e.type === "place").length === 1 &&
      A.tr.position(1000).up === 10);
    const B2 = book(0.52, 100, 0.53, 100);
    run(A, 2410, B2);                                              // 2 s after leg 1 (filled at 400): leg 2
    const l2 = A.tr.hello(1000).events.filter((e) => e.type === "place")[1];
    ok("pair: 2 s after leg 1, leg 2: 10 Down ≤ 53¢ (its ask 48¢ + 5¢)", l2?.token === "DOWN" && l2.tokenPrice === 0.53 && l2.size === 10, JSON.stringify(l2));
    run(A, 2800, B2);
    const r = A.pt.records(1000)[0], want = 10 * (1 - 0.47 - 0.48) - 10 * fee(0.47) - 10 * fee(0.48), p = A.tr.position(1000);
    ok("pair: leg 2 fills 10 Down at 48¢; the pair merges at 95¢, +$0.50 less $0.35 of fees",
      r.end === "paired" && Math.abs(r.pnl! - want) < 1e-9 && p.up === 0 && p.down === 0 && Math.abs(A.tr.acct.cash - (1000 + want)) < 1e-9,
      JSON.stringify({ r, want, cash: A.tr.acct.cash }));
    ok("pair: the record has both legs for the archive", r.leg1.qty === 10 && r.leg1.px === 0.47 && r.leg2.qty === 10 && r.leg2.px === 0.48 && r.dir === "up" && r.move === 0.05);
  } finally { fs.rmSync(A.tmp, { recursive: true, force: true }); }

  // 1b. PAIR_SIGNAL=fast: no detector of its own; the /signal-fast detector's signal (handed over by the engine) opens leg 1
  const F = mk("fast", { signal: "fast", lookbackMs: 200, minMove: 0.06 });
  try {
    const B0 = book(0.45, 100, 0.46, 100), fast = new MoveSignal(CFG.fastSignal, "fast");
    run(F, 0, B0);
    F.pt.sample(smp(0, 0.44, 0.47, B0), ctx(0, B0), 0); fast.sample(smp(0, 0.44, 0.47, B0));
    const own = F.pt.sample(smp(100, 0.49, 0.52, B0), ctx(100, B0), 100), m = fast.sample(smp(100, 0.49, 0.52, B0));
    ok("pair fast: its own detector is off (a 5¢ move in 100 ms sends nothing by itself)", F.pt.sig === null && own === null &&
      F.tr.hello(1000).events.filter((e) => e.type === "place").length === 0);
    F.pt.open(m!, ctx(100, B0), 100);
    const l1 = F.tr.hello(1000).events.find((e) => e.type === "place"), r = F.pt.records(1000)[0];
    ok("pair fast: the /signal-fast signal sends leg 1 and is recorded as such", l1?.token === "UP" && l1.tokenPrice === 0.47 && r?.signal === "fast" && r.lookbackMs === 100 &&
      F.pt.signalDesc().includes("in 100 ms") && F.pt.signalDesc().includes("/signal-fast"), JSON.stringify({ l1, r, d: F.pt.signalDesc() }));
  } finally { fs.rmSync(F.tmp, { recursive: true, force: true }); }

  // 2. the makers re-price in the hold: the ask is 49¢ when leg 1 lands, over its 47¢ limit → missed, no leg 2
  const M = mk("missed");
  try {
    const B0 = book(0.45, 100, 0.46, 100);
    run(M, 0, B0); M.pt.sample(smp(0, 0.44, 0.47, B0), ctx(0, B0), 0); M.pt.sample(smp(100, 0.49, 0.52, B0), ctx(100, B0), 100);
    run(M, 400, book(0.48, 100, 0.49, 100)); run(M, 3000, book(0.48, 100, 0.49, 100));
    ok("pair: a leg 1 the market ran away from is missed, nothing held, no leg 2",
      M.pt.records(1000)[0]?.end === "missed" && M.tr.position(1000).up === 0 && M.tr.hello(1000).events.filter((e) => e.type === "place").length === 1);
  } finally { fs.rmSync(M.tmp, { recursive: true, force: true }); }

  // 3. gates: 4¢ is under PAIR_MIN_MOVE; a move the book made too; after PAIR_UNTIL_SEC; a token asking over PAIR_MAX_PRICE; down → Down
  const G = mk("gates");
  try {
    const B0 = book(0.45, 100, 0.46, 100), places = () => G.tr.hello(1000).events.filter((e) => e.type === "place");
    G.pt.sample(smp(0, 0.44, 0.47, B0), ctx(0, B0), 0); G.pt.sample(smp(100, 0.48, 0.51, B0), ctx(100, B0), 100);
    ok("pair gate: a 4¢ move sends nothing", places().length === 0);
    const B1 = book(0.47, 100, 0.48, 100);
    G.pt.sample(smp(1200, 0.44, 0.47, B0), ctx(1200, B0), 1200); G.pt.sample(smp(1300, 0.5, 0.53, B1), ctx(1300, B1), 1300);
    ok("pair gate: a move the book made too sends nothing", places().length === 0);
    const late = (now: number): PairCtx => ({ ...ctx(now, B0), elapsed: 241 });
    G.pt.sample(smp(2500, 0.44, 0.47, B0), late(2500), 2500); G.pt.sample(smp(2600, 0.49, 0.52, B0), late(2600), 2600);
    ok("pair gate: nothing after PAIR_UNTIL_SEC", places().length === 0 && /after 240 s/.test(G.pt.actions(late(2600), 2600)[0].note), G.pt.actions(late(2600), 2600)[0].note);
    const Hi = book(0.79, 100, 0.8, 100);
    G.pt.sample(smp(4000, 0.78, 0.81, Hi), ctx(4000, Hi), 4000); G.pt.sample(smp(4100, 0.83, 0.86, Hi), ctx(4100, Hi), 4100);
    ok("pair gate: no leg 1 on a token asking over PAIR_MAX_PRICE", places().length === 0);
    G.pt.sample(smp(5500, 0.44, 0.47, B0, { pred: -2 }), ctx(5500, B0), 5500); G.pt.sample(smp(5600, 0.39, 0.42, B0, { pred: -2 }), ctx(5600, B0), 5600);
    const dn = places()[0];
    ok("pair: a down move buys Down at its ask (1 − the Up bid 45¢ = 55¢) + 1¢", dn?.token === "DOWN" && dn.tokenPrice === 0.56, JSON.stringify(dn));
  } finally { fs.rmSync(G.tmp, { recursive: true, force: true }); }

  // 4. leg 2 finds only 4 Down at its price: the 6 left go again 100 ms later, on the next book
  const P = mk("partial");
  try {
    const B0 = book(0.45, 100, 0.46, 100);
    run(P, 0, B0); P.pt.sample(smp(0, 0.44, 0.47, B0), ctx(0, B0), 0); P.pt.sample(smp(100, 0.49, 0.52, B0), ctx(100, B0), 100);
    run(P, 400, book(0.46, 100, 0.47, 100)); run(P, 2400, book(0.52, 4, 0.53, 100)); run(P, 2700, book(0.52, 4, 0.53, 100));
    ok("pair: a short leg 2 leaves the pair open", P.tr.position(1000).up === 6 && P.pt.records(1000)[0].end == null);
    // the retry went at 2700 for the 6 left, $2.88 at the 48¢ ask; the book refills there
    const B3 = book(0.52, 100, 0.53, 100);
    run(P, 2810, B3); run(P, 3200, B3);
    const r = P.pt.records(1000)[0];
    ok("pair: the rest goes again and the pair closes: 4 Down at 48¢, then the other 6", r.end === "paired" && Math.abs(r.leg2.qty - 10) < 1e-6 && r.leg2.tries === 2 &&
      Math.abs(r.leg2.px! - 0.48) < 1e-9 && P.tr.position(1000).up === 0, JSON.stringify(r.leg2));
  } finally { fs.rmSync(P.tmp, { recursive: true, force: true }); }

  // 5. under the minimum: leg 1 finds 3 Up → held to the label (the venue refuses a 3-share leg 2); the window closing holds a pair
  const S = mk("small");
  try {
    const B0 = book(0.45, 100, 0.46, 3);
    run(S, 0, B0); S.pt.sample(smp(0, 0.44, 0.47, B0), ctx(0, B0), 0); S.pt.sample(smp(100, 0.49, 0.52, B0), ctx(100, B0), 100);
    run(S, 400, B0);
    ok("pair: a leg 1 under the minimum size is held, not paired", S.pt.records(1000)[0].end === "held" && S.tr.position(1000).up === 3);
    const B1 = book(0.45, 100, 0.46, 100);
    S.pt.sample(smp(1500, 0.44, 0.47, B1), ctx(1500, B1), 1500); S.pt.sample(smp(1600, 0.49, 0.52, B1), ctx(1600, B1), 1600);
    run(S, 1900, B1);
    S.tr.closeWindow(1000, 1950); run(S, 2000, B1, 1300);
    const r = S.pt.records(1000)[1];
    ok("pair: leg 1 spends 10 × its 47¢ limit ($4.70): at the 46¢ ask that buys 10.22 Up, as the venue's market BUY does",
      Math.abs(r.leg1.qty - 4.7 / 0.46) < 1e-3 && r.leg1.px === 0.46, JSON.stringify(r?.leg1));
    ok("pair: the window closing with leg 1 held ends the pair as held", r?.end === "held" && r.leg1.qty > 10 && r.leg2.qty === 0, JSON.stringify(r));
  } finally { fs.rmSync(S.tmp, { recursive: true, force: true }); }

  // 6. PAIR_CLOSE_EDGE 10¢, PAIR_HOLD_MS 10 s: leg 1 fills 10 Up at 47¢; at a Down ask of 45¢ the pair would lock 4.5¢ after
  //    fees (wait); at 38¢, 11.6¢ → leg 2 goes then, 0.6 s after leg 1, not at the 10 s hold
  const E = mk("edge", { holdMs: 10000, closeEdge: 0.1 });
  try {
    const B0 = book(0.45, 100, 0.46, 100), places = () => E.tr.hello(1000).events.filter((e) => e.type === "place");
    run(E, 0, B0); E.pt.sample(smp(0, 0.44, 0.47, B0), ctx(0, B0), 0); E.pt.sample(smp(100, 0.49, 0.52, B0), ctx(100, B0), 100);
    run(E, 400, book(0.46, 100, 0.47, 100));
    const B1 = book(0.55, 100, 0.56, 100);
    run(E, 700, B1);
    ok("pair edge: a 4.5¢ edge at the Down ask 45¢ is under PAIR_CLOSE_EDGE: leg 2 waits", E.tr.position(1000).up === 10 && places().length === 1 &&
      /or at a 10¢ edge \(now 4\.5¢ at the Down ask 45¢\)/.test(E.pt.actions(ctx(700, B1), 700)[0].note), E.pt.actions(ctx(700, B1), 700)[0].note);
    const B2 = book(0.62, 100, 0.63, 100);
    run(E, 1000, B2);
    const l2 = places()[1];
    ok("pair edge: at the Down ask 38¢ the pair locks 11.6¢: leg 2 goes at once, 10 Down ≤ 43¢", l2?.token === "DOWN" && l2.tokenPrice === 0.43 && l2.size === 10 &&
      E.logs.some((m) => /edge 11\.6¢ at the Down ask 38¢, 0\.6 s after leg 1 → leg 2 now/.test(m)), JSON.stringify({ l2, logs: E.logs }));
    run(E, 1400, B2);
    const r = E.pt.records(1000)[0], want = 10 * (1 - 0.47 - 0.38) - 10 * fee(0.47) - 10 * fee(0.38);
    ok("pair edge: leg 2 fills at 38¢, the pair at 85¢; the record says the edge sent it", r.end === "paired" && Math.abs(r.pnl! - want) < 1e-9 &&
      r.leg2.by === "edge" && Math.abs(r.leg2.edge! - 0.1161) < 1e-4, JSON.stringify(r));
  } finally { fs.rmSync(E.tmp, { recursive: true, force: true }); }

  // 6b. the edge sends leg 2 and it comes back short (4 Down at 38¢): the 6 left go again 100 ms on, not at the 10 s hold
  //     (the second take spends 6 × 38¢ = $2.28, which buys 5.999999 Down: a millionth of an Up stays unpaired)
  const ES = mk("edge-short", { holdMs: 10000, closeEdge: 0.1 });
  try {
    const B0 = book(0.45, 100, 0.46, 100);
    run(ES, 0, B0); ES.pt.sample(smp(0, 0.44, 0.47, B0), ctx(0, B0), 0); ES.pt.sample(smp(100, 0.49, 0.52, B0), ctx(100, B0), 100);
    run(ES, 400, book(0.46, 100, 0.47, 100));
    run(ES, 1000, book(0.62, 4, 0.63, 100)); run(ES, 1400, book(0.62, 4, 0.63, 100));
    ok("pair edge: a short edge leg 2 leaves 6 Up open and sends the rest again at once", ES.tr.position(1000).up === 6 &&
      ES.tr.hello(1000).events.filter((e) => e.type === "place").length === 3, ES.logs.join(" | "));
    const B3 = book(0.62, 100, 0.63, 100);
    run(ES, 1510, B3); run(ES, 1900, B3);
    const r = ES.pt.records(1000)[0];
    ok("pair edge: the rest fills and the pair closes 1.5 s after leg 1, not at the hold", r.end === "paired" && r.leg2.tries === 2 && r.leg2.by === "edge" &&
      Math.abs(r.leg2.qty - 10) < 1e-6 && ES.tr.position(1000).up < 1e-4, JSON.stringify({ r, pos: ES.tr.position(1000) }));
  } finally { fs.rmSync(ES.tmp, { recursive: true, force: true }); }

  // 7. the same, the edge never there: leg 2 at the 10 s hold, and the record says so
  const H = mk("edge-hold", { holdMs: 10000, closeEdge: 0.1 });
  try {
    const B0 = book(0.45, 100, 0.46, 100), places = () => H.tr.hello(1000).events.filter((e) => e.type === "place");
    run(H, 0, B0); H.pt.sample(smp(0, 0.44, 0.47, B0), ctx(0, B0), 0); H.pt.sample(smp(100, 0.49, 0.52, B0), ctx(100, B0), 100);
    const B1 = book(0.46, 100, 0.47, 100);
    run(H, 400, B1); run(H, 2400, B1); run(H, 10300, B1);
    ok("pair edge: no edge, no leg 2 before PAIR_HOLD_MS (10 s)", places().length === 1 && H.tr.position(1000).up === 10);
    run(H, 10410, B1); run(H, 10800, B1);
    const r = H.pt.records(1000)[0];
    ok("pair edge: leg 2 at the hold, 10 Down at 54¢; the record says the hold sent it", places()[1]?.token === "DOWN" && r.end === "paired" &&
      r.leg2.px === 0.54 && r.leg2.by === "hold" && r.leg2.edge! < 0, JSON.stringify(r));
  } finally { fs.rmSync(H.tmp, { recursive: true, force: true }); }

  // 8. PAIR_STOP_MOVE 1¢ in PAIR_STOP_MS 3 s, beside the 10¢ edge / 10 s: leg 1 fills 10 Up at 47¢ with the Up mid at 46.5¢;
  //    a half-cent dip waits, a cent sends leg 2 at once (the Down ask 55¢)
  const ST = mk("stop", { holdMs: 10000, closeEdge: 0.1, stopMove: 0.01, stopMs: 3000 });
  try {
    const B0 = book(0.45, 100, 0.46, 100), places = () => ST.tr.hello(1000).events.filter((e) => e.type === "place");
    run(ST, 0, B0); ST.pt.sample(smp(0, 0.44, 0.47, B0), ctx(0, B0), 0); ST.pt.sample(smp(100, 0.49, 0.52, B0), ctx(100, B0), 100);
    run(ST, 400, book(0.46, 100, 0.47, 100));
    const B1 = book(0.45, 100, 0.47, 100);
    run(ST, 700, B1);
    ok("pair stop: the Up mid 46.5¢ → 46¢ (half a cent against) is under PAIR_STOP_MOVE: leg 2 waits", places().length === 1 && ST.tr.position(1000).up === 10 &&
      /on a 1¢ Up mid move against it for 2700 ms \(now -0\.5¢ its way\)/.test(ST.pt.actions(ctx(700, B1), 700)[0].note), ST.pt.actions(ctx(700, B1), 700)[0].note);
    const B2 = book(0.45, 100, 0.46, 100);
    run(ST, 1000, B2);
    const l2 = places()[1];
    ok("pair stop: the mid at 45.5¢ (a cent against) sends leg 2 at once: 10 Down ≤ 60¢ (its ask 55¢)", l2?.token === "DOWN" && l2.tokenPrice === 0.6 &&
      ST.logs.some((m) => /stop: the Up mid 46\.5¢ → 45\.5¢, against the Up leg 1, 0\.6 s after leg 1 → leg 2 now/.test(m)), JSON.stringify({ l2, logs: ST.logs }));
    run(ST, 1400, B2);
    const r = ST.pt.records(1000)[0];
    ok("pair stop: the pair closes at 47¢ + 55¢ and the record says the stop sent it", r.end === "paired" && r.leg2.px === 0.55 && r.leg2.by === "stop", JSON.stringify(r));
  } finally { fs.rmSync(ST.tmp, { recursive: true, force: true }); }

  // 8b. a Down leg 1: the stop is the Up mid rising a cent (45.5¢ → 46.5¢); leg 2 buys Up at its ask 47¢
  const SD = mk("stop-down", { holdMs: 10000, closeEdge: 0.1, stopMove: 0.01, stopMs: 3000 });
  try {
    const B0 = book(0.45, 100, 0.46, 100), places = () => SD.tr.hello(1000).events.filter((e) => e.type === "place");
    run(SD, 0, B0); SD.pt.sample(smp(0, 0.44, 0.47, B0, { pred: -2 }), ctx(0, B0), 0); SD.pt.sample(smp(100, 0.39, 0.42, B0, { pred: -2 }), ctx(100, B0), 100);
    run(SD, 400, B0);
    const B1 = book(0.46, 100, 0.47, 100);
    run(SD, 1000, B1); run(SD, 1400, B1);
    const r = SD.pt.records(1000)[0], l2 = places()[1];
    ok("pair stop: a Down leg 1 stops on the Up mid rising a cent; leg 2 buys Up ≤ 52¢ (its ask 47¢)", r?.token === "DOWN" && l2?.token === "UP" && l2.tokenPrice === 0.52 &&
      r.end === "paired" && r.leg2.by === "stop" && r.leg2.px === 0.47, JSON.stringify({ r, l2 }));
  } finally { fs.rmSync(SD.tmp, { recursive: true, force: true }); }

  // 9. the stop watches PAIR_STOP_MS only: the same cent against at 3.5 s after leg 1 sends nothing; leg 2 at the 10 s hold
  const SL = mk("stop-late", { holdMs: 10000, closeEdge: 0.1, stopMove: 0.01, stopMs: 3000 });
  try {
    const B0 = book(0.45, 100, 0.46, 100), places = () => SL.tr.hello(1000).events.filter((e) => e.type === "place");
    run(SL, 0, B0); SL.pt.sample(smp(0, 0.44, 0.47, B0), ctx(0, B0), 0); SL.pt.sample(smp(100, 0.49, 0.52, B0), ctx(100, B0), 100);
    const B1 = book(0.46, 100, 0.47, 100), B2 = book(0.45, 100, 0.46, 100);
    run(SL, 400, B1); run(SL, 2000, B1); run(SL, 3900, B2); run(SL, 6000, B2);
    ok("pair stop: a move against after PAIR_STOP_MS sends nothing", places().length === 1 && SL.tr.position(1000).up === 10);
    run(SL, 10410, B2); run(SL, 10800, B2);
    const r = SL.pt.records(1000)[0];
    ok("pair stop: leg 2 at the hold instead, recorded as such", r.end === "paired" && r.leg2.by === "hold" && r.leg2.px === 0.55, JSON.stringify(r));
  } finally { fs.rmSync(SL.tmp, { recursive: true, force: true }); }

  // 10. PAIR_L2_MODEL: constant models (log-odds +2 → P(against) 0.8808, −2 → 0.1192) on rows that only need to exist.
  //     Leg 1 fills 10 Up at 47¢ with the Up book 46/47¢: no stop (the mid is where it was), no 10¢ edge (Down asks 54¢)
  const l2File = (lo: number) => {
    const f = path.join(os.tmpdir(), `mm-selftest-l2-${lo}-${process.pid}.json`);
    fs.writeFileSync(f, JSON.stringify({ format: "gbm-compact-1", features: L2_FEATURES, trees: [{ root: -1, f: [], t: [], d: [], m: [], l: [], r: [], v: [lo] }] }));
    return f;
  };
  const hiF = l2File(2), loF = l2File(-2);
  ROWS = [[-1e6, ...Array(COLS.length - 1).fill(null)]];
  const l2run = (tag: string, o: Partial<typeof CFG.pair>, win = 1200) => {
    const X = mk(tag, { holdMs: 10000, closeEdge: 0.1, stopMove: 0.01, stopMs: 3000, l2ModelP: 0.5, ...o });
    const B0 = book(0.45, 100, 0.46, 100), B1 = book(0.46, 100, 0.47, 100);
    const c = (now: number, b: BookView) => ctx(now, b, win);
    const smpW = (now: number, bid: number, ask: number) => ({ ...smp(now, bid, ask, B0), win });
    run(X, 0, B0, win); X.pt.sample(smpW(0, 0.44, 0.47), c(0, B0), 0); X.pt.sample(smpW(100, 0.49, 0.52), c(100, B0), 100);
    run(X, 400, B1, win); run(X, 410, B1, win);
    const placed = X.tr.hello(win).events.filter((e) => e.type === "place");
    run(X, 800, B1, win);
    return { X, placed, r: X.pt.records(win)[0] };
  };
  const H1 = l2run("l2-hi", { l2Model: "on", l2ModelFile: hiF });
  try {
    ok("leg-2 model: P(against) 0.88 at the fill sends leg 2 at the next step: 10 Down ≤ 59¢ (its ask 54¢)",
      H1.placed.length === 2 && H1.placed[1].token === "DOWN" && H1.placed[1].tokenPrice === 0.59 &&
      H1.X.logs.some((m) => /leg 1 filled .* · leg-2 model P\(against\) 0\.88 ≥ 0\.50 → leg 2 now/.test(m)) &&
      H1.X.logs.some((m) => /leg-2 model: P\(against\) 0\.88 at the fill, 0\.0 s after leg 1 → leg 2 now/.test(m)), JSON.stringify({ p: H1.placed, logs: H1.X.logs }));
    ok("leg-2 model: the record says the model sent leg 2, with its P", H1.r.end === "paired" && H1.r.leg2.by === "model" && H1.r.leg2.px === 0.54 &&
      H1.r.l2?.p === 0.8808 && H1.r.l2.armed && H1.r.l2.fired, JSON.stringify(H1.r));
  } finally { fs.rmSync(H1.X.tmp, { recursive: true, force: true }); }
  const L1 = l2run("l2-lo", { l2Model: "on", l2ModelFile: loF });
  try {
    ok("leg-2 model: P(against) 0.12 is under PAIR_L2_MODEL_P: leg 2 waits, the pair stays open, P recorded",
      L1.placed.length === 1 && L1.r.end == null && L1.r.l2?.p === 0.1192 && L1.r.l2.armed && !L1.r.l2.fired, JSON.stringify(L1.r));
  } finally { fs.rmSync(L1.X.tmp, { recursive: true, force: true }); }
  // ab: armed in even 5-minute slots (1200 / 300 = 4), a control in odd ones (1500 / 300 = 5): P recorded, nothing sent
  const A1 = l2run("l2-ab-on", { l2Model: "ab", l2ModelFile: hiF }, 1200), A0 = l2run("l2-ab-off", { l2Model: "ab", l2ModelFile: hiF }, 1500);
  try {
    ok("leg-2 model ab: an even slot acts on P 0.88", A1.placed.length === 2 && A1.r.leg2.by === "model" && A1.r.l2?.armed === true, JSON.stringify(A1.r));
    ok("leg-2 model ab: an odd slot is the control: P 0.88 recorded, leg 2 waits", A0.placed.length === 1 && A0.r.l2?.p === 0.8808 && !A0.r.l2.armed && !A0.r.l2.fired &&
      A0.X.logs.some((m) => /leg-2 model P\(against\) 0\.88 \(control window\)/.test(m)), JSON.stringify({ r: A0.r, logs: A0.X.logs }));
  } finally { for (const x of [A1, A0]) fs.rmSync(x.X.tmp, { recursive: true, force: true }); }
  const N1 = l2run("l2-off", { l2Model: "off", l2ModelFile: hiF });
  try {
    ok("leg-2 model off: no model, no P on the record, leg 2 waits", N1.X.pt.l2 == null && N1.placed.length === 1 && N1.r.l2 === undefined, JSON.stringify(N1.r));
  } finally { fs.rmSync(N1.X.tmp, { recursive: true, force: true }); for (const f of [hiF, loF]) fs.rmSync(f, { force: true }); ROWS = []; }
}

// ---- pair trade, maker leg 1: a post-only bid at the rising token's best bid, cancelled after PAIR_MAKER_MS ----
{
  type O = { id: number; win: number; token: "UP" | "DOWN"; tokenPrice: number; size: number; status: string };
  const mkS = () => {
    let id = 0;
    const bids: O[] = [], takes: O[] = [], cancels: number[] = [], fills = new Map<number, { qty: number; px: number | null; fee: number }>();
    const tr = {
      free: () => 1000,
      bid: (win: number, token: "UP" | "DOWN", price: number, size: number) => { const o = { id: ++id, win, token, tokenPrice: price, size, status: "pending" }; bids.push(o); return o; },
      take: (win: number, token: "UP" | "DOWN", price: number, size: number) => { const o = { id: ++id, win, token, tokenPrice: price, size, status: "pending" }; takes.push(o); return o; },
      cancel: (o: O) => { cancels.push(o.id); if (o.status === "pending" || o.status === "open") o.status = "cancelling"; },
      fillsOf: (_w: number, oid: number) => fills.get(oid) ?? { qty: 0, px: null, fee: 0 },
    };
    const logs: string[] = [];
    const pt = new PairTrader(tr as unknown as Trader, { ...CFG.pair, on: true, leg1: "maker", makerMs: 500, lookbackMs: 200, minMove: 0.05, maxQueue: 300, size: 10, holdMs: 2000, closeEdge: null, stopMove: null, stopMs: 3000, closeSlip: 0.05, untilSec: 240, maxPrice: 0.75, l2Model: "off" }, (m) => logs.push(m));
    return { pt, bids, takes, cancels, fills, logs };
  };
  const bk = (bb: number, ba: number): BookView => ({ ready: true, bids: [[bb, 100]], asks: [[ba, 100]], bestBid: bb, bestAsk: ba, ageMs: 0, last: null });
  const ctx = (now: number, b: BookView): PairCtx => ({ win: 1000, endTs: 1300, elapsed: 60 + now / 1000, left: 240 - now / 1000, minSize: 5, tick: 0.01, book: b, rows: [], cols: COLS, Kcl: null });
  const smp = (now: number, bid: number, ask: number, b: BookView, pred = 2): SigSample => ({
    now, win: 1000, slug: "s", up: "U", down: "D", elapsed: 60 + now / 1000, left: 240 - now / 1000, bid, ask,
    bb: b.bestBid, ba: b.bestAsk, centre: null, centerSrc: "flow FV", pred, step: "decide" });
  const B0 = bk(0.45, 0.46);
  // the target 44/47 → 49/52 over 200 ms, the book unmoved: a bid for 10 Up at the 45¢ best bid
  const signal = (x: ReturnType<typeof mkS>, dn = false) => {
    for (const t of [0, 100]) x.pt.sample(smp(t, 0.44, 0.47, B0, dn ? -2 : 2), ctx(t, B0), t);
    x.pt.sample(smp(200, dn ? 0.39 : 0.49, dn ? 0.42 : 0.52, B0, dn ? -2 : 2), ctx(200, B0), 200);
  };
  {
    const x = mkS();
    x.pt.sample(smp(0, 0.44, 0.47, B0), ctx(0, B0), 0); x.pt.sample(smp(100, 0.49, 0.52, B0), ctx(100, B0), 100);
    ok("pair maker: no signal until the 200 ms lookback has its reference", x.bids.length === 0 && x.takes.length === 0);
  }
  {
    const x = mkS(); signal(x);
    ok("pair maker: a 5¢ move in 200 ms bids 10 Up at its 45¢ best bid, post-only, no take", x.bids.length === 1 && x.bids[0].token === "UP" && x.bids[0].tokenPrice === 0.45 &&
      x.bids[0].size === 10 && x.takes.length === 0 && x.pt.actions(ctx(200, B0), 200)[0].act === "place", JSON.stringify(x.bids));
    x.pt.step(ctx(600, B0), 600);
    ok("pair maker: still working before its 500 ms are up", x.cancels.length === 0);
    x.pt.step(ctx(700, B0), 700); x.pt.step(ctx(710, B0), 710);
    ok("pair maker: cancelled once at 500 ms, and waits for the venue's answer", x.cancels.length === 1 && x.pt.records(1000)[0].end == null);
    x.bids[0].status = "cancelled"; x.pt.step(ctx(760, B0), 760);
    const r = x.pt.records(1000)[0];
    ok("pair maker: unfilled → missed, nothing else sent", r.end === "missed" && r.kind === "maker" && /no fill at 45¢ in 500 ms/.test(r.note) && x.takes.length === 0, r.note);
  }
  {
    const x = mkS(); signal(x, true);
    ok("pair maker: a down move bids Down at 1 − the Up ask (54¢)", x.bids[0]?.token === "DOWN" && x.bids[0].tokenPrice === 0.54, JSON.stringify(x.bids[0]));
  }
  {
    // the queue ahead: 100 sh at the price is fine; 500 is over PAIR_MAX_QUEUE (300): no bid; a Down bid's queue is the Up asks
    const deep = (bbSz: number, baSz: number): BookView => ({ ready: true, bids: [[0.45, bbSz]], asks: [[0.46, baSz]], bestBid: 0.45, bestAsk: 0.46, ageMs: 0, last: null });
    const run = (b: BookView, dn: boolean) => {
      const x = mkS();
      for (const t of [0, 100]) x.pt.sample(smp(t, 0.44, 0.47, b, dn ? -2 : 2), ctx(t, b), t);
      x.pt.sample(smp(200, dn ? 0.39 : 0.49, dn ? 0.42 : 0.52, b, dn ? -2 : 2), ctx(200, b), 200);
      return x;
    };
    const up = run(deep(500, 50), false), upOk = run(deep(300, 5000), false), dn = run(deep(50, 500), true), dnOk = run(deep(5000, 50), true);
    ok("pair maker: 500 sh ahead at the Up bid → no bid, logged; 300 → bid", up.bids.length === 0 && up.logs.some((l) => /no bid, 500 sh already at Up 45¢/.test(l)) &&
      /over 300/.test(up.pt.actions(ctx(200, B0), 200)[0].note) && upOk.bids.length === 1, up.logs.join(" | "));
    ok("pair maker: a Down bid's queue is the Up ask's size (500 → none, 50 → bid)", dn.bids.length === 0 && dnOk.bids.length === 1 && dnOk.bids[0].token === "DOWN");
  }
  {
    const x = mkS(); signal(x);
    x.bids[0].status = "filled"; x.fills.set(x.bids[0].id, { qty: 10, px: 0.45, fee: 0 });
    x.pt.step(ctx(350, B0), 350);
    ok("pair maker: filled → leg 2 two seconds on, not before", x.takes.length === 0 && x.cancels.length === 0 && x.pt.records(1000)[0].leg1.qty === 10);
    const B2 = bk(0.5, 0.51);
    x.pt.step(ctx(2350, B2), 2350);
    ok("pair maker: leg 2 is the usual taker buy of the other token (Down ≤ its 50¢ ask + 5¢)", x.takes.length === 1 && x.takes[0].token === "DOWN" && x.takes[0].tokenPrice === 0.55, JSON.stringify(x.takes));
    x.takes[0].status = "filled"; x.fills.set(x.takes[0].id, { qty: 10, px: 0.5, fee: 10 * 0.07 * 0.25 });
    x.pt.step(ctx(2700, B2), 2700);
    const r = x.pt.records(1000)[0];
    ok("pair maker: paired at 95¢, only leg 2 pays a fee", r.end === "paired" && Math.abs(r.pnl! - (10 * 0.05 - 0.175)) < 1e-9, JSON.stringify(r));
  }
  {
    const x = mkS(); signal(x);
    x.fills.set(x.bids[0].id, { qty: 3, px: 0.45, fee: 0 }); x.bids[0].status = "open";
    x.pt.step(ctx(720, B0), 720); x.bids[0].status = "cancelled"; x.pt.step(ctx(780, B0), 780);
    ok("pair maker: 3 filled before the cancel → held, under the minimum", x.pt.records(1000)[0].end === "held" && x.takes.length === 0);
  }
  {
    const x = mkS(); signal(x);
    x.bids[0].status = "rejected"; x.pt.step(ctx(260, B0), 260);
    ok("pair maker: a refused post-only bid → missed, says why", x.pt.records(1000)[0].end === "missed" && /refused/.test(x.pt.records(1000)[0].note));
  }
}

// ---- live exchange (trading/liveExchange.ts) on a fake venue: no network, no orders ----
{
  const mkVenue = () => {
    const posts: { tokenId: string; price: number; size: number; res: (r: PostResult) => void; onSigned?: (id: string) => void }[] = [];
    const takes: { tokenId: string; usd: number; max: number; res: (r: PostResult) => void }[] = [];
    const cancels: { id: string; res: (r: { ok: boolean; reason: string }) => void }[] = [];
    let cb: (u: VenueOrderUpdate) => void = () => {};
    let tcb: (t: VenueTrade) => void = () => {};
    let rec: { sizeMatched: number; status: string } | "gone" | null = null;
    let trades = new Map<string, number>();
    let link = true;
    const v: Venue = {
      wallet: "0xW", connected: () => link, lastDown: () => 0,
      postBid: (tokenId, price, size, onSigned) => new Promise((res) => posts.push({ tokenId, price, size, res, onSigned })),
      postTake: (tokenId, usd, max) => new Promise((res) => takes.push({ tokenId, usd, max, res })), onTrade: (f) => { tcb = f; }, warm: async () => {},
      cancel: (id) => new Promise((res) => cancels.push({ id, res })),
      cancelMany: async (ids) => ids.length, fetchOrder: async () => rec, balance: async () => 600, tokenBalance: async () => 0,
      matched: async (_m, ids) => new Map([...trades].filter(([k]) => ids.includes(k))), gasless: true,
      merge: async (_c, n) => `0xmerge${n}`, redeem: async () => "0xredeem", onOrder: (f) => { cb = f; }, close: async () => {},
    };
    return { v, posts, takes, cancels, upd: (u: VenueOrderUpdate) => cb(u), trade: (t: VenueTrade) => tcb(t), setRec: (r: typeof rec) => { rec = r; }, setLink: (x: boolean) => { link = x; },
      setTrades: (m: Map<string, number>) => { trades = m; } };
  };
  const flush = () => new Promise((r) => setImmediate(r));
  const B: BookView = { ready: true, bids: [[0.45, 40]], asks: [[0.47, 30]], bestBid: 0.45, bestAsk: 0.47, ageMs: 0, last: null };
  const mark = { fv: 0.46, mid: 0.46 };

  // takes (the pair trade's legs): a market BUY of the USDC budget; booked from the answer, else its trades, else its record
  {
    const V = mkVenue(), evs: string[] = [];
    let clock = 0;
    const ex = new LiveExchange(V.v, (e) => evs.push(`${e.type}:${e.note}`), () => {}, 1, 1, () => clock);
    ex.setTokens("U", "D");
    const tr = (id: string, taker: string, tokenId: string, size: number, cost: number, status = "MATCHED"): VenueTrade =>
      ({ tradeId: id, takerOrderId: taker, taker: true, tokenId, status, size, cost });
    // the real pair of 2026-10-14: 5 Up ≤ 26¢ ($1.30) matched 5.2 at 25¢ against a Down maker at 75¢; its trade beat the answer
    const o = ex.place({ win: 1, token: "UP", price: 0.26, size: 5, reason: "leg 1", take: true }, 0);
    ok("live take: $1.30 (5 × its 26¢ limit) up to 26¢", V.takes[0]?.tokenId === "U" && V.takes[0].usd === 1.3 && V.takes[0].max === 0.26 && o.usd === 1.3);
    ok("live take: never in our resting book, never cancelled", ex.own("U") == null && (ex.cancel(o, 1, "x"), o.status === "pending") && ex.openIds().length === 0);
    V.trade(venueTrade({ id: "t1", takerOrderId: "x1", traderSide: "TAKER", tokenId: "U", size: "5.2", price: "0.25", status: "TRADE_STATUS_MATCHED",
      makerOrders: [{ tokenId: "D", price: "0.75", matchedAmount: "5.2" }] }));
    clock = 210;
    V.takes[0].res({ ok: true, orderId: "x1", status: "matched", making: 1.3, taking: 5.2 }); await flush();
    V.trade(venueTrade({ id: "t1", takerOrderId: "x1", traderSide: "TAKER", tokenId: "U", size: "5.2", price: "0.25", status: "TRADE_STATUS_MINED",
      makerOrders: [{ tokenId: "D", price: "0.75", matchedAmount: "5.2" }] }));
    let f = ex.step(220, 1, B, mark);
    ok("live take: booked once (trade, answer, its MINED repeat): 5.2 Up at 25¢ (1 − the Down maker's 75¢), the fee on top, a take",
      f.length === 1 && Math.abs(f[0].size - 5.2) < 1e-9 && Math.abs(f[0].tokenPrice - 0.25) < 1e-9 && f[0].price === f[0].tokenPrice && f[0].via === "take" &&
      Math.abs(f[0].fee! - 0.07 * 0.25 * 0.75 * 5.2) < 1e-12 && o.status === "filled" && ex.working(1).length === 0, JSON.stringify(f));
    // a Down take that matched part of its budget: the rest was killed
    const d = ex.place({ win: 1, token: "DOWN", price: 0.77, size: 5, reason: "leg 2", take: true, usd: 3.75 }, 300);
    V.takes[1].res({ ok: true, orderId: "x2", status: "matched", making: 1.5, taking: 2 }); await flush();
    f = ex.step(320, 1, B, mark);
    ok("live take: a Down take filled in part books 2 Down at 75¢ (Up terms: a sell at 25¢) and ends cancelled",
      f.length === 1 && f[0].token === "DOWN" && f[0].side === "SELL" && Math.abs(f[0].tokenPrice - 0.75) < 1e-9 && Math.abs(f[0].price - 0.25) < 1e-9 &&
      d.status === "cancelled" && evs.some((e) => /^cancelled:fill-and-kill: 2 sh @ 75\.0¢ for \$1\.50 of \$3\.75/.test(e)), evs.filter((e) => e.startsWith("cancelled")).join(" | "));
    // refused (nothing to match): rejected, nothing booked
    const n = ex.place({ win: 1, token: "UP", price: 0.3, size: 5, reason: "t", take: true }, 400);
    V.takes[2].res({ ok: false, code: "rejected", message: "no orders found to match with FAK order" }); await flush();
    ok("live take: refused → rejected with the venue's reason", n.status === "rejected" && ex.step(420, 1, B, mark).length === 0 && evs.some((e) => /no orders found/.test(e)));
    // "delayed": its trades book it; its record (polled after 3 s) ends it
    const y = ex.place({ win: 1, token: "UP", price: 0.5, size: 10, reason: "t", take: true }, 500);
    V.takes[3].res({ ok: true, orderId: "x4", status: "delayed" }); await flush();
    V.trade(tr("t4", "x4", "U", 6, 2.94));
    f = ex.step(600, 1, B, mark);
    ok("live take: delayed → its trade books 6 at 49¢, still working", f.length === 1 && f[0].size === 6 && Math.abs(f[0].tokenPrice - 0.49) < 1e-9 && y.status === "open");
    V.setRec({ sizeMatched: 6, status: "MATCHED" });
    clock = 3700; ex.step(3700, 1, B, mark); await flush(); await flush();
    ok("live take: ...and its record ends it, with nothing more booked", y.status === "cancelled" && ex.step(3710, 1, B, mark).length === 0);
    // threw on the way: adopted when a taker trade of its token shows
    const z = ex.place({ win: 1, token: "DOWN", price: 0.6, size: 5, reason: "t", take: true }, 4000);
    V.takes[4].res({ ok: false, code: "uncertain", message: "timeout" }); await flush();
    V.trade(tr("t5", "x5", "D", 5, 2.9));
    f = ex.step(4100, 1, B, mark);
    ok("live take: a post that threw is adopted by its trade", f.length === 1 && f[0].token === "DOWN" && f[0].size === 5 && Math.abs(f[0].tokenPrice - 0.58) < 1e-9 && z.status === "open");
  }
  // MM_DECIDE_EVENTS: between a heard fill (or post answer) and the step that books it the exchange says so; event steps wait
  {
    const V = mkVenue();
    const ex = new LiveExchange(V.v, () => {}, () => {});
    ex.setTokens("U", "D");
    const o = ex.place({ win: 1, token: "UP", price: 0.4, size: 10, reason: "t" }, 0);
    ok("live unsynced: nothing heard yet", !ex.unsynced());
    V.posts[0].res({ ok: true, orderId: "u1", status: "live" }); await flush();
    ok("live unsynced: a post answer not yet stepped", ex.unsynced() && o.liveAt != null);
    ex.step(10, 1, B, mark);
    ok("live unsynced: ...until the step takes it in", !ex.unsynced());
    V.upd({ orderId: "u1", type: "UPDATE", sizeMatched: 10, status: "MATCHED" });
    ok("live unsynced: a fill heard on the user channel ends the order at once, unbooked until the next step",
      ex.unsynced() && o.status === "filled" && ex.working(1).length === 0);
    const f = ex.step(20, 1, B, mark);
    ok("live unsynced: ...the step books it and clears it", f.length === 1 && f[0].size === 10 && !ex.unsynced());
    ok("paper exchange: never unsynced (its fills come from step)", (new PaperExchange(35, () => {}) as Exchange).unsynced === undefined);
  }
  // Fill.cxl (the dashboard's cancel-in-flight / no-cancel counts): decided by the cancel, not the status at the step, since a
  // fill that completes the order has set it "filled" before the step books it
  {
    const V = mkVenue();
    const ex = new LiveExchange(V.v, () => {}, () => {});
    ex.setTokens("U", "D");
    const a = ex.place({ win: 1, token: "UP", price: 0.4, size: 10, reason: "t" }, 0), b = ex.place({ win: 1, token: "UP", price: 0.39, size: 10, reason: "t" }, 0);
    V.posts[0].res({ ok: true, orderId: "a1", status: "live" }); V.posts[1].res({ ok: true, orderId: "b1", status: "live" }); await flush();
    ex.step(10, 1, B, mark);
    ex.cancel(a, 20, "race");                                                       // the cancel goes out...
    V.upd({ orderId: "a1", type: "UPDATE", sizeMatched: 10, status: "MATCHED" });   // ...and the taker fills all of it first
    V.upd({ orderId: "b1", type: "UPDATE", sizeMatched: 10, status: "MATCHED" });   // b simply rested
    const f = ex.step(30, 1, B, mark);
    ok("live cxl: a whole fill on an order being cancelled is cancel in flight (status already filled), a resting fill is not",
      f.length === 2 && a.status === "filled" && f.find((x) => x.oid === a.id)?.cxl === true && / cancel was in flight$/.test(f.find((x) => x.oid === a.id)!.note) &&
      f.find((x) => x.oid === b.id)?.cxl === false && !/cancel was in flight/.test(f.find((x) => x.oid === b.id)!.note), JSON.stringify(f.map((x) => [x.oid, x.cxl])));
  }
  // Fill.cxlWhy (the fill signal's "race" kind, signal.ts): the cancel's reason by kind, unset on a resting fill
  {
    const V = mkVenue();
    const ex = new LiveExchange(V.v, () => {}, () => {});
    ex.setTokens("U", "D");
    const a = ex.place({ win: 1, token: "UP", price: 0.4, size: 10, reason: "t" }, 0), b = ex.place({ win: 1, token: "UP", price: 0.39, size: 10, reason: "t" }, 0),
      c = ex.place({ win: 1, token: "UP", price: 0.38, size: 10, reason: "t" }, 0);
    V.posts.forEach((p: any, i: number) => p.res({ ok: true, orderId: "abc"[i] + "1", status: "live" })); await flush();
    ex.step(10, 1, B, mark);
    ex.cancel(a, 20, "race: the level fell to 0 sh, under 50% of the 1.1k when it went live"); ex.cancel(b, 20, "replace: target moved up to 62¢");
    for (const id of ["a1", "b1", "c1"]) V.upd({ orderId: id, type: "UPDATE", sizeMatched: 10, status: "MATCHED" });
    const f = ex.step(30, 1, B, mark), by = (o: { id: number }) => f.find((x) => x.oid === o.id);
    ok("live cxlWhy: race / replace on cancel-in-flight fills, unset on a resting fill",
      by(a)?.cxlWhy === "race" && by(b)?.cxlWhy === "replace" && by(c)?.cxl === false && by(c)?.cxlWhy === undefined, JSON.stringify(f.map((x) => [x.oid, x.cxl, x.cxlWhy])));
    ok("cancelKind: the order manager's reasons by kind",
      cancelKind("race: in flight, its side holds 0.31 of the touch, under 0.4") === "race" && cancelKind("race hold") === "race" && cancelKind("replace: x") === "replace" &&
      cancelKind("market closed") === "other" && cancelKind(undefined) === "other");
  }
  // place → the fill event beats the post's answer → booked once, at our price; a repeated event books nothing
  {
    const V = mkVenue(), evs: string[] = [];
    const ex = new LiveExchange(V.v, (e) => evs.push(e.type), () => {});
    ex.setTokens("U", "D");
    const o = ex.place({ win: 1, token: "DOWN", price: 0.53, size: 10, reason: "t" }, 0);
    ok("live: a Down bid is posted as a BUY of the Down token", V.posts[0]?.tokenId === "D" && V.posts[0]?.price === 0.53 && o.status === "pending" && o.side === "SELL" && o.price === 0.47);
    V.upd({ orderId: "x1", type: "UPDATE", sizeMatched: 4, status: "LIVE" });     // before the HTTP answer
    V.posts[0].res({ ok: true, orderId: "x1", status: "live" }); await flush();
    let f = ex.step(10, 1, B, mark);
    ok("live: an event before the post's answer is held, then booked", f.length === 1 && f[0].size === 4 && f[0].tokenPrice === 0.53 && f[0].token === "DOWN" && f[0].via === "live" && o.status === "open", JSON.stringify(f.map((x) => x.size)));
    ok("live: queue0 = the others at its level, on the step after the ack", o.queue0 === 30 && evs.includes("live"));
    V.upd({ orderId: "x1", type: "UPDATE", sizeMatched: 4, status: "LIVE" });
    ok("live: a repeated event books nothing", ex.step(20, 1, B, mark).length === 0);
    V.upd({ orderId: "x1", type: "UPDATE", sizeMatched: 10, status: "MATCHED" });
    f = ex.step(30, 1, B, mark);
    ok("live: the rest fills, the order is done", f.length === 1 && f[0].size === 6 && o.status === "filled" && ex.working(1).length === 0);
  }
  // cancel while the post is in flight: sent once the id is known; a fill that lands after the cancel is still booked
  {
    const V = mkVenue();
    const ex = new LiveExchange(V.v, () => {}, () => {});
    ex.setTokens("U", "D");
    const o = ex.place({ win: 1, token: "UP", price: 0.45, size: 10, reason: "t" }, 0);
    ex.cancel(o, 5, "pull");
    ok("live: no cancel goes out before the venue id is known", V.cancels.length === 0 && o.status === "cancelling");
    V.posts[0].res({ ok: true, orderId: "x2", status: "live" }); await flush();
    ok("live: ...then it goes", V.cancels[0]?.id === "x2" && o.status === "cancelling");
    V.cancels[0].res({ ok: true, reason: "" }); await flush();
    V.upd({ orderId: "x2", type: "UPDATE", sizeMatched: 3, status: "MATCHED" });
    const f = ex.step(50, 1, B, mark);
    ok("live: cancelled, and the late fill is booked", o.status === "cancelled" && f.length === 1 && f[0].size === 3 && /cancel was in flight/.test(f[0].note), f[0]?.note);
  }
  // LIVE_EARLY_CANCEL: a cancel decided while the post is in flight goes by the id the order was signed with
  // MM_CANCEL_DELAY_MS (live): the cancel goes out after the delay; an answer arriving meanwhile doesn't send it early
  {
    const V = mkVenue(), evs: string[] = [];
    let clock = 0;
    const ex = new LiveExchange(V.v, (e) => evs.push(`${e.type}:${e.note}`), () => {}, 1, 1, () => clock, false, 150);
    ex.setTokens("U", "D");
    const a = ex.place({ win: 1, token: "UP", price: 0.45, size: 10, reason: "t" }, 0);
    ex.cancel(a, 0, "pull");
    clock = 50; V.posts[0].res({ ok: true, orderId: "xA", status: "live" }); await flush();
    ok("cancel delay (live): decided at 0, answered at 50 → nothing sent yet, still cancelling", V.cancels.length === 0 && a.status === "cancelling" &&
      evs.some((e) => /^cancel:pull · sent after the 150 ms cancel delay/.test(e)), evs.join(" | "));
    clock = 160; await new Promise((r) => setTimeout(r, 170));
    ok("cancel delay (live): ...after 150 ms the cancel goes by the venue id", V.cancels.length === 1 && V.cancels[0].id === "xA", `${V.cancels.length}`);
    const V0 = mkVenue(), ex0 = new LiveExchange(V0.v, () => {}, () => {});
    ex0.setTokens("U", "D"); const b = ex0.place({ win: 1, token: "UP", price: 0.45, size: 10, reason: "t" }, 0);
    V0.posts[0].res({ ok: true, orderId: "xB", status: "live" }); await flush(); ex0.cancel(b, 1, "pull");
    ok("cancel delay (live): off by default → sent at once", V0.cancels.length === 1);
  }
  {
    const V0 = mkVenue(), ex0 = new LiveExchange(V0.v, () => {}, () => {});
    ex0.setTokens("U", "D"); ex0.place({ win: 1, token: "UP", price: 0.45, size: 10, reason: "t" }, 0);
    ok("early cancel: off by default (postBid gets no signed-id callback)", V0.posts[0].onSigned === undefined);
    const V = mkVenue(), evs: string[] = [];
    let clock = 0;
    const ex = new LiveExchange(V.v, (e) => evs.push(`${e.type}:${e.note}`), () => {}, 1, 1, () => clock, true);
    ex.setTokens("U", "D");
    // decided while the order is still being signed: it goes the moment the id is known, ahead of the post's answer
    const a = ex.place({ win: 1, token: "UP", price: 0.45, size: 10, reason: "t" }, 0);
    ex.cancel(a, 0, "pull");
    ok("early cancel: still signing (no id) → nothing sent yet", V.cancels.length === 0 && a.status === "cancelling");
    V.posts[0].onSigned!("pA");
    ok("early cancel: ...signed → the cancel goes at once by the signed id", V.cancels[0]?.id === "pA" && a.status === "cancelling");
    ok("early cancel: a pending order's signed id is among the ids a restart cancels", ex.openIds().includes("pA"));
    // placed and part-filled before the cancel: that event beats both answers; the cancel is answered "canceled"
    V.upd({ orderId: "pA", type: "UPDATE", sizeMatched: 2, status: "LIVE" });
    clock = 40; V.cancels[0].res({ ok: true, reason: "" }); await flush();
    let f = ex.step(41, 1, B, mark);
    ok("early cancel: answered canceled → cancelled, and the fill that came before it is booked", a.status === "cancelled" && f.length === 1 && f[0].size === 2 &&
      evs.some((e) => /^cancelled:2\/10 filled · cancelled before its post was answered · cancel took 40 ms/.test(e)), evs.join(" | "));
    clock = 60; V.posts[0].res({ ok: true, orderId: "pA", status: "live" }); await flush();
    ex.step(61, 1, B, mark);
    ok("early cancel: the post's late answer changes nothing (no 'live' event, nothing working)", a.status === "cancelled" && !evs.some((e) => e.startsWith("live:")) && ex.working(1).length === 0);
    clock = 1100; ex.step(1100, 1, B, mark);
    ok("early cancel: its timing line has the answer and the cancel by the signed id", evs.some((e) => /^info:.*answer \+60 .*cancel \+0→\+40 \(by the signed id\)/.test(e)), evs.filter((e) => e.startsWith("info")).join(" | "));
    // the cancel beat the post: "not found" while the post is unanswered, then the post is refused "Already canceled"
    const b = ex.place({ win: 1, token: "DOWN", price: 0.5, size: 10, reason: "t" }, 2000);
    V.posts[1].onSigned!("pB");
    ex.cancel(b, 2001, "pull");
    ok("early cancel: decided after signing → sent at once by the signed id", V.cancels[1]?.id === "pB");
    V.cancels[1].res({ ok: false, reason: "order can't be found - already canceled or matched" }); await flush();
    ok("early cancel: 'not found' with the post unanswered → still cancelling, no second cancel", b.status === "cancelling" && V.cancels.length === 2);
    V.posts[1].res({ ok: false, code: "rejected", message: "RequestRejectedError: order 0xpB is invalid. Already canceled. (https://clob.polymarket.com/order)" }); await flush();
    ok("early cancel: the post refused 'Already canceled' → cancelled (not rejected), never on the book, nothing booked",
      b.status === "cancelled" && evs.some((e) => /^cancelled:the cancel beat the post: the venue refused it \(already canceled\) .* never reached the book/.test(e)) &&
      ex.step(2100, 1, B, mark).length === 0, evs.slice(-2).join(" | "));
    // "not found", but the post was placed after all: it gets its cancel by id at the answer, as without the switch
    const c = ex.place({ win: 1, token: "UP", price: 0.44, size: 10, reason: "t" }, 3000);
    V.posts[2].onSigned!("pC");
    ex.cancel(c, 3001, "pull");
    V.cancels[2].res({ ok: false, reason: "order can't be found - already canceled or matched" }); await flush();
    V.posts[2].res({ ok: true, orderId: "pC", status: "live" }); await flush();
    ok("early cancel: a post placed after a 'not found' gets a cancel by its id at the answer", V.cancels[3]?.id === "pC" && c.status === "cancelling");
    V.cancels[3].res({ ok: true, reason: "" }); await flush();
    ok("early cancel: ...and is cancelled", c.status === "cancelled");
    // the post is answered while the early cancel is still out: no second cancel; the cancel's answer finishes it
    const d = ex.place({ win: 1, token: "UP", price: 0.43, size: 10, reason: "t" }, 4000);
    V.posts[3].onSigned!("pD");
    ex.cancel(d, 4001, "pull");
    V.posts[3].res({ ok: true, orderId: "pD", status: "live" }); await flush();
    ok("early cancel: answered post while its cancel is out → no second cancel", V.cancels.length === 5 && V.cancels[4].id === "pD");
    V.cancels[4].res({ ok: true, reason: "" }); await flush();
    ok("early cancel: ...the cancel's answer finishes it", d.status === "cancelled" && ex.working(1).length === 0);
    ok("early cancel: window tag +live+ec", windowTag(1791158400, { ...CFG, mode: "live", liveEarlyCancel: true }).endsWith("+live+ec") &&
      windowTag(1791158400, { ...CFG, mode: "live", liveEarlyCancel: false }).endsWith("+live"));
  }
  // timing: #1412's shape (2026-10-15): its placement event came before the post's 1132 ms answer, the cancel waited for
  // that answer, the fill beat it; one line once the order has been over a second. A take: its trade beat the answer.
  {
    const V = mkVenue(), evs: string[] = [], logs: string[] = [];
    let clock = 1_000_000;
    const ex = new LiveExchange(V.v, (e) => evs.push(`${e.type}:${e.note}`), (m) => logs.push(m), 1, 1, () => clock);
    ex.setTokens("U", "D");
    const o = ex.place({ win: 1, token: "UP", price: 0.64, size: 5, reason: "leg 1" }, clock);
    clock += 501; ex.cancel(o, clock, "500 ms up");
    clock = 1_000_195; V.upd({ orderId: "x9", type: "PLACEMENT", sizeMatched: 0, status: "LIVE", tokenId: "U", price: 0.64, size: 5, ts: 1_000_180, rx: clock });
    clock = 1_001_132; V.posts[0].res({ ok: true, orderId: "x9", status: "live", signMs: 3 }); await flush();
    clock = 1_001_261; V.upd({ orderId: "x9", type: "UPDATE", sizeMatched: 5, status: "MATCHED", ts: 1_001_240, rx: clock });
    clock = 1_001_270; V.cancels[0].res({ ok: false, reason: "matched" }); await flush();
    ex.step(clock, 1, B, mark);
    const timing = () => evs.filter((e) => e.startsWith("info:timing"));
    ok("live timing: nothing while a fill's event could still trail the order", o.status === "filled" && timing().length === 0);
    clock = 1_002_300; ex.step(clock, 1, B, mark);
    ok("live timing: sign, placement (venue / heard), answer, match, cancel, in ms after the send",
      timing().length === 1 && /: sign 3 · placed v\+180 h\+195 · answer \+1132 · match v\+1240 h\+1261 · cancel \+1132→\+1270 · filled$/.test(timing()[0]) &&
      logs.some((l) => /^\[live\] #1 Up bid @ 64\.0¢ timing/.test(l)), timing().join(" | "));
    ex.step(clock + 100, 1, B, mark);
    ok("live timing: once", timing().length === 1);
    const t = ex.place({ win: 1, token: "DOWN", price: 0.35, size: 5, reason: "leg 2", take: true }, clock);
    clock = 1_002_515; V.trade({ tradeId: "tt", takerOrderId: "x10", taker: true, tokenId: "D", status: "MATCHED", size: 5, cost: 1.75, ts: 1_002_500, rx: clock });
    clock = 1_002_517; V.takes[0].res({ ok: true, orderId: "x10", status: "matched", making: 1.75, taking: 5, signMs: 2 }); await flush();
    ex.step(clock, 1, B, mark); clock += 1000; ex.step(clock, 1, B, mark);
    ok("live timing: a take's line has no placement; its match is its trade", t.status === "filled" && timing().length === 2 &&
      /: sign 2 · answer \+217 · match v\+200 h\+215 · filled$/.test(timing()[1]), timing()[1]);
  }
  // refused post; refused cancel settled from the order's record; an order this run never posted is cancelled
  {
    const V = mkVenue(), evs: string[] = [];
    let clock = 0;
    const ex = new LiveExchange(V.v, (e) => evs.push(`${e.type}:${e.note}`), () => {}, 1, 1, () => clock);
    ex.setTokens("U", "D");
    const r = ex.place({ win: 1, token: "UP", price: 0.47, size: 10, reason: "t" }, 0);
    V.posts[0].res({ ok: false, code: "post_only_would_cross", message: "" }); await flush();
    ok("live: a refused post is rejected with the venue's reason", r.status === "rejected" && evs.some((e) => e.startsWith("reject:venue: post_only_would_cross")));
    const o = ex.place({ win: 1, token: "UP", price: 0.45, size: 10, reason: "t" }, 0);
    V.posts[1].res({ ok: true, orderId: "x3", status: "live" }); await flush();
    ex.cancel(o, 10, "pull");
    V.setRec({ sizeMatched: 10, status: "MATCHED" });
    V.cancels[0].res({ ok: false, reason: "order already matched" }); await flush(); await flush();
    const f = ex.step(20, 1, B, mark);
    ok("live: a refused cancel is settled from the record (matched in full)", o.status === "filled" && f.length === 1 && f[0].size === 10);
    ok("live: a take goes out as a market BUY (postTake), not a bid", ex.place({ win: 1, token: "UP", price: 0.47, size: 10, reason: "t", take: true }, 0).status === "pending" &&
      V.posts.length === 2 && V.takes.length === 1 && V.takes[0].usd === 4.7 && V.takes[0].max === 0.47);
    clock = 100;
    V.upd({ orderId: "stranger", type: "PLACEMENT", sizeMatched: 0, status: "LIVE", tokenId: "U", price: 0.44, size: 50 });
    ex.step(100, 1, B, mark);
    clock = 100 + ORPHAN_MS + 10;
    ex.step(clock, 1, B, mark);
    ok("live: a venue order this run did not post (another bot on the wallet) is left alone", V.cancels.length === 1);
    // a post that threw may still have reached the venue: adopted when its placement shows, else refused
    const lost = ex.place({ win: 1, token: "UP", price: 0.44, size: 10, reason: "t" }, clock);
    V.posts[2].res({ ok: false, code: "uncertain", message: "timeout" }); await flush();
    ok("live: a post that threw stays pending", lost.status === "pending");
    V.upd({ orderId: "found", type: "PLACEMENT", sizeMatched: 0, status: "LIVE", tokenId: "U", price: 0.44, size: 10 });
    ok("live: ...and is adopted when its placement shows on the user channel", lost.status === "open" && ex.openIds().includes("found"));
    const gone = ex.place({ win: 1, token: "UP", price: 0.43, size: 10, reason: "t" }, clock);
    V.posts[3].res({ ok: false, code: "uncertain", message: "timeout" }); await flush();
    clock += ORPHAN_MS + 10;
    ex.step(clock, 1, B, mark);
    ok("live: ...or refused when none shows within ORPHAN_MS", gone.status === "rejected");
  }
  // a fill the user channel never delivered is found by reading the order back
  {
    const V = mkVenue();
    let clock = 0;
    const ex = new LiveExchange(V.v, () => {}, () => {}, 1, 1, () => clock);
    ex.setTokens("U", "D");
    const o = ex.place({ win: 1, token: "UP", price: 0.45, size: 10, reason: "t" }, 0);
    V.posts[0].res({ ok: true, orderId: "p1", status: "live" }); await flush();
    V.setRec({ sizeMatched: 6, status: "LIVE" });
    clock = 1000; ok("live poll: nothing read back before POLL_MS", ex.step(clock, 1, B, mark).length === 0);
    clock = 3100; ex.step(clock, 1, B, mark); await flush(); await flush();
    const f = ex.step(clock + 10, 1, B, mark);
    ok("live poll: an order silent for 3 s is read back and its unseen fill booked", f.length === 1 && f[0].size === 6 && o.status === "open" && o.filled === 6);
  }
  // an order off the book has no record: its fills come from the account's trades, and it is done
  {
    const V = mkVenue();
    let clock = 0;
    const ex = new LiveExchange(V.v, () => {}, () => {}, 1, 1, () => clock);
    ex.setTokens("U", "D", "0xM");
    const o = ex.place({ win: 1, token: "DOWN", price: 0.52, size: 10, reason: "t" }, 0);
    V.posts[0].res({ ok: true, orderId: "g1", status: "live" }); await flush();
    V.setRec("gone"); V.setTrades(new Map([["g1", 7], ["other", 5]]));
    clock = 3100; ex.step(clock, 1, B, mark); for (let i = 0; i < 5; i++) await flush();
    const f = ex.step(clock + 10, 1, B, mark);
    ok("live records: a gone order's fills are summed from the trades, and it is done", f.length === 1 && f[0].size === 7 && o.status === "cancelled" && o.filled === 7,
      `${o.status} ${o.filled}`);
  }
  // a post the venue refused by throwing (HTTP 4xx) is a refusal, not an uncertain post
  {
    const cross = postFailure("RequestRejectedError", "RequestRejectedError: invalid post-only order: order crosses book (https://clob.polymarket.com/order)");
    ok("live: a thrown 'order crosses book' is post_only_would_cross, a timeout is uncertain",
      !cross.ok && cross.code === "post_only_would_cross" && !postFailure("TransportError", "socket hang up").ok && (postFailure("TimeoutError", "x") as { code: string }).code === "uncertain" &&
      (postFailure("RateLimitError", "429") as { code: string }).code === "rate_limited");
  }
  // own orders come out of the book the strategy sees, on both tokens' books
  {
    const V = mkVenue();
    const ex = new LiveExchange(V.v, () => {}, () => {});
    ex.setTokens("U", "D");
    ex.place({ win: 1, token: "UP", price: 0.45, size: 10, reason: "t" }, 0);
    ex.place({ win: 1, token: "DOWN", price: 0.53, size: 30, reason: "t" }, 0);
    V.posts[0].res({ ok: true, orderId: "a", status: "live" }); V.posts[1].res({ ok: true, orderId: "b", status: "live" }); await flush();
    const pmf = new PmBookFeed(() => {});
    pmf.setTokens(["U", "D"]);
    pmf.apply(JSON.stringify({ event_type: "book", asset_id: "U", bids: [{ price: "0.45", size: "25" }, { price: "0.44", size: "50" }], asks: [{ price: "0.47", size: "30" }, { price: "0.48", size: "9" }] }), 1);
    pmf.setOwn((a) => ex.own(a));
    const vU = pmf.view("U"), t = pmf.top("U");
    ok("live: our Up bid is taken out of the Up bids", vU.bids[0][0] === 0.45 && vU.bids[0][1] === 15, JSON.stringify(vU.bids));
    ok("live: our Down bid at 53¢ is taken out of the Up asks at 47¢ (the level goes)", vU.bestAsk === 0.48 && t.ba === 0.48 && t.bb === 0.45 && t.bs === 15, JSON.stringify(vU.asks));
  }
  // the trader in live mode: blind without the user channel, the loss limit, a merge at the close and a redeem on Gamma's label
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mm-selftest-"));
    const cfg = CFG as { mode: string };
    const was = cfg.mode;
    cfg.mode = "live";
    try {
      const V = mkVenue();
      const pm = { onPrint: () => {}, setOwn: () => {} } as unknown as ConstructorParameters<typeof Trader>[0];
      const store = { entries: () => [], get: () => undefined } as unknown as ConstructorParameters<typeof Trader>[1];
      const tr = new Trader(pm, store, () => {}, tmp, V.v, 600);
      const bk: BookView = { ready: true, bids: [[0.5, 100]], asks: [[0.51, 100]], bestBid: 0.5, bestAsk: 0.51, ageMs: 0, last: null };
      const at = (now: number) => ({ now, win: 1000, endTs: 1300, up: "U", down: "D", cond: "0xC", book: bk, fv: 0.5, mid: 0.505 });
      const q: Quote = { policy: "v4", bid: 0.5, ask: 0.51, bidSize: 10, askSize: 10, center: 0.505, skew: 0, reservation: 0.505, why: "", off: { bid: null, ask: null }, steps: [] };
      ok("live trader: a new account starts at the wallet's balance, state under live/", tr.acct.start === 600 && tr.acct.cash === 600);
      V.setLink(false);
      tr.pre(at(0)); tr.post(1000, q, 0, 5);
      ok("live trader: no orders while the user channel is down", V.posts.length === 0 && /user channel is down/.test((tr.frame(1000, 0, false).actions as { note: string }[])[0]?.note ?? ""));
      V.setLink(true);
      tr.post(1000, q, 10, 5);
      ok("live trader: both bids go out once it is back", V.posts.length === 2 && V.posts.map((p) => p.tokenId).sort().join() === "D,U");
      V.posts[0].res({ ok: true, orderId: "u1", status: "live" }); V.posts[1].res({ ok: true, orderId: "d1", status: "live" }); await flush();
      const xU = V.posts[0].tokenId === "U" ? "u1" : "d1", xD = xU === "u1" ? "d1" : "u1";
      V.upd({ orderId: xU, type: "UPDATE", sizeMatched: 10, status: "MATCHED" });
      V.upd({ orderId: xD, type: "UPDATE", sizeMatched: 10, status: "MATCHED" });
      tr.pre(at(20));
      ok("live trader: an Up and a Down fill merge into a pair in the account", tr.position(1000).net === 0 && Math.abs(tr.acct.cash - (600 - 5 - 4.9 + 10) - (tr.acct.wins.get(1000)!.rebate ?? 0)) < 1e-6, String(tr.acct.cash));
      const cc = CFG as { liveChain: boolean }, chainWas = cc.liveChain;
      cc.liveChain = true;
      try {
        tr.closeWindow(1000, 300_000);
        const st = JSON.parse(fs.readFileSync(path.join(tmp, "live", "state.json"), "utf8"));
        ok("live trader, LIVE_CHAIN=on: the close queues the on-chain merge of our 10 pairs (persisted)", st.chain?.length === 1 && st.chain[0].kind === "merge" && st.chain[0].cond === "0xC" && st.chain[0].pairs === 10, JSON.stringify(st.chain));
        tr.settle(1000, true, "chainlink"); tr.settle(1000, true, "gamma");
        const st2 = JSON.parse(fs.readFileSync(path.join(tmp, "live", "state.json"), "utf8"));
        ok("live trader, LIVE_CHAIN=on: the first label replaces the pending merge by a redeem, once", tr.status().live?.chain.map((j: { kind: string }) => j.kind).join() === "redeem" && st2.chain?.length === 1, JSON.stringify(tr.status().live?.chain));
        // LIVE_CHAIN off: a restart drops the saved job, and nothing new is queued
        cc.liveChain = false;
        const trB = new Trader(pm, store, () => {}, tmp, V.v, 600);
        ok("live trader, LIVE_CHAIN=off: a restart drops the saved redeem job", trB.status().live?.chain.length === 0, JSON.stringify(trB.status().live?.chain));
      } finally { cc.liveChain = chainWas; }
      // the loss limit: a window marked far under its cost
      const tr2dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-selftest-"));
      try {
        const V2 = mkVenue();
        const tr2 = new Trader(pm, store, () => {}, tr2dir, V2.v, 600);
        tr2.pre({ ...at(0), win: 2000, endTs: 2300 }); tr2.post(2000, { ...q, ask: null, askSize: 0, bidSize: 200 }, 0, 5);
        V2.posts[0].res({ ok: true, orderId: "big", status: "live" }); await flush();
        V2.upd({ orderId: "big", type: "UPDATE", sizeMatched: 200, status: "MATCHED" });
        tr2.pre({ ...at(10), win: 2000, endTs: 2300, mid: 0.1 });     // 200 Up bought at 50¢, marked at 10¢: −$80
        tr2.post(2000, q, 20, 5);
        ok("live trader: the loss limit stops it and nothing more goes out", /STOPPED/.test(tr2.status().live?.halted ?? "") && V2.posts.length === 1, tr2.status().live?.halted ?? "");
        tr2.resetPnl(2000, 30);
        tr2.pre({ ...at(40), win: 2000, endTs: 2300, mid: 0.1 }); tr2.post(2000, q, 40, 5);
        ok("live trader: a PnL reset lifts the loss-limit stop and orders go out again", tr2.status().live?.halted == null && V2.posts.length > 1, `${tr2.status().live?.halted} · ${V2.posts.length} post(s)`);
      } finally { fs.rmSync(tr2dir, { recursive: true, force: true }); }
      // the wallet check: 30 Up in the wallet that the account never booked, twice running
      const tr3dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-selftest-"));
      try {
        const V3 = mkVenue();
        V3.v.tokenBalance = async (t) => (t === "U" ? 30 : 0);
        const tr3 = new Trader(pm, store, () => {}, tr3dir, V3.v, 600);
        tr3.pre({ ...at(0), win: 3000, endTs: 3300 });
        const wc = () => (tr3 as unknown as { walletCheck(): Promise<void> }).walletCheck();
        await wc();
        const once = tr3.status().live?.halted;
        await wc();
        ok("live trader: the wallet check stops it on the second sighting of unbooked tokens", once == null && /fills went unseen/.test(tr3.status().live?.halted ?? ""), tr3.status().live?.halted ?? "");
        tr3.resetPnl(3000, 50);
        ok("live trader: a PnL reset does not lift a wallet-check stop", /fills went unseen/.test(tr3.status().live?.halted ?? ""), tr3.status().live?.halted ?? "");
      } finally { fs.rmSync(tr3dir, { recursive: true, force: true }); }
      // LIVE_PEER_STATE: the same 30 Up are another bot's (its saved account books them): no stop; a peer mid-fill skips
      const trPdir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-selftest-"));
      const pc = CFG as { livePeerState: string[] }, peerWas = pc.livePeerState;
      try {
        const peerFile = path.join(trPdir, "peer-state.json");
        const writePeer = (extra: object) => fs.writeFileSync(peerFile, JSON.stringify({ wins: [{ win: 3000, state: "open", upTok: "U", downTok: "D", up: 30, down: 0 }], ...extra }));
        writePeer({});
        pc.livePeerState = [peerFile];
        const VP = mkVenue();
        VP.v.tokenBalance = async (t) => (t === "U" ? 30 : 0);
        const trP = new Trader(pm, store, () => {}, path.join(trPdir, "me"), VP.v, 600);
        trP.pre({ ...at(0), win: 3000, endTs: 3300 });
        const wc = () => (trP as unknown as { walletCheck(): Promise<void> }).walletCheck();
        await wc(); await wc(); await wc();
        ok("live trader: tokens a peer bot booked (LIVE_PEER_STATE) do not trip the wallet check", trP.status().live?.halted == null, trP.status().live?.halted ?? "");
        VP.v.tokenBalance = async (t) => (t === "U" ? 60 : 0);    // 30 more than both books
        writePeer({ lastFillAt: Date.now() });
        await wc(); await wc();
        ok("live trader: a peer that just filled makes the wallet check skip", trP.status().live?.halted == null, trP.status().live?.halted ?? "");
        writePeer({});
        await wc(); await wc();
        ok("live trader: tokens beyond its own and the peer's still stop it", /other bot's on the wallet/.test(trP.status().live?.halted ?? ""), trP.status().live?.halted ?? "");
      } finally { pc.livePeerState = peerWas; fs.rmSync(trPdir, { recursive: true, force: true }); }
      // LIVE_LOSS_ON=settled: the same −$80 mark does not stop it; the window's label does
      const tr4dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-selftest-"));
      const lc = CFG as { liveLossOn: string }, lossWas = lc.liveLossOn;
      lc.liveLossOn = "settled";
      try {
        const V4 = mkVenue();
        const tr4 = new Trader(pm, store, () => {}, tr4dir, V4.v, 600);
        tr4.pre({ ...at(0), win: 4000, endTs: 4300 }); tr4.post(4000, { ...q, ask: null, askSize: 0, bidSize: 200 }, 0, 5);
        V4.posts[0].res({ ok: true, orderId: "big4", status: "live" }); await flush();
        V4.upd({ orderId: "big4", type: "UPDATE", sizeMatched: 200, status: "MATCHED" });
        tr4.pre({ ...at(10), win: 4000, endTs: 4300, mid: 0.1 });
        const mid = tr4.status().live?.halted;
        tr4.closeWindow(4000, 300_000); tr4.settle(4000, false, "chainlink");
        tr4.pre({ ...at(300_100), win: 4300, endTs: 4600 });
        ok("live trader, LIVE_LOSS_ON=settled: a −$80 mark inside the window does not stop it, its label (−$100 + the maker rebate) does",
          mid == null && /settled PnL −\$99\.\d\d/.test(tr4.status().live?.halted ?? ""), `${mid} | ${tr4.status().live?.halted}`);
      } finally { lc.liveLossOn = lossWas; fs.rmSync(tr4dir, { recursive: true, force: true }); }
      // sync to wallet: the wallet's extra USDC is booked as a deposit, PnL unchanged; refused right after a fill
      const tr6dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-selftest-"));
      try {
        const V6 = mkVenue();
        V6.v.balance = async () => 936.1;
        const tr6 = new Trader(pm, store, () => {}, tr6dir, V6.v, 600);
        tr6.pre({ ...at(0), win: 6000, endTs: 6300 });
        const pnl0 = tr6.acct.equity() - tr6.acct.start;
        const r = await tr6.syncWallet();
        const pnl1 = tr6.acct.equity() - tr6.acct.start;
        ok("live trader: sync to wallet books the wallet's extra $336.10 as a deposit, PnL unchanged",
          r.ok && Math.abs(tr6.acct.cash - 936.1) < 1e-9 && Math.abs(tr6.acct.start - 936.1) < 1e-9 && Math.abs(pnl1 - pnl0) < 1e-9, JSON.stringify(r));
        tr6.post(6000, { ...q, ask: null, askSize: 0, bidSize: 10 }, 0, 5);
        V6.posts[0].res({ ok: true, orderId: "s6", status: "live" }); await flush();
        V6.upd({ orderId: "s6", type: "UPDATE", sizeMatched: 10, status: "MATCHED" });
        tr6.pre({ ...at(10), win: 6000, endTs: 6300 });
        const r2 = await tr6.syncWallet();
        ok("live trader: sync to wallet is refused within 30 s of a fill (not yet settled on chain)", !r2.ok && /fill in the last 30 s/.test(r2.ok ? "" : r2.error), JSON.stringify(r2));
      } finally { fs.rmSync(tr6dir, { recursive: true, force: true }); }
      // LIVE_CHAIN off: a traded window that just closed queues no job, and the sync waits for Polymarket's own redeem
      const tr7dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-selftest-"));
      try {
        const V7 = mkVenue();
        let upHeld = 10;                                             // the wallet's winning (Up) tokens until the redeem
        V7.v.tokenBalance = async (t) => (t === "U" ? upHeld : 0);
        const tr7 = new Trader(pm, store, () => {}, tr7dir, V7.v, 600);
        const w7 = Math.floor(Date.now() / 1000 / 300) * 300 - 300;     // the window that closed last
        tr7.pre({ ...at(0), win: w7, endTs: w7 + 300 }); tr7.post(w7, { ...q, ask: null, askSize: 0, bidSize: 10 }, 0, 5);
        V7.posts[0].res({ ok: true, orderId: "s7", status: "live" }); await flush();
        V7.upd({ orderId: "s7", type: "UPDATE", sizeMatched: 10, status: "MATCHED" });
        tr7.pre({ ...at(10), win: w7, endTs: w7 + 300 });
        tr7.closeWindow(w7, 300_000);
        const r3 = await tr7.syncWallet();
        ok("live trader, LIVE_CHAIN=off: no job at the close; sync refused while the window has no label", tr7.status().live?.chain.length === 0 && !r3.ok && /has no label yet/.test(r3.ok ? "" : r3.error), JSON.stringify(r3));
        tr7.settle(w7, true, "gamma");
        (tr7 as unknown as { lastFillAt: number }).lastFillAt = 0;      // past the 30 s after the fill
        const r4 = await tr7.syncWallet();
        ok("live trader, LIVE_CHAIN=off: no redeem job at the label; sync refused while the wallet still holds the winning tokens", tr7.status().live?.chain.length === 0 && !r4.ok && /not redeemed it into the wallet yet/.test(r4.ok ? "" : r4.error), JSON.stringify(r4));
        upHeld = 0;
        const r5 = await tr7.syncWallet();
        ok("live trader, LIVE_CHAIN=off: once Polymarket has redeemed the winning side, the sync goes through", r5.ok, JSON.stringify(r5));
      } finally { fs.rmSync(tr7dir, { recursive: true, force: true }); }
      // lock.ts: a stopped window cancels its makers and places nothing but the lock's take
      const tr5dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-selftest-"));
      try {
        const V5 = mkVenue();
        const tr5 = new Trader(pm, store, () => {}, tr5dir, V5.v, 600);
        tr5.pre({ ...at(0), win: 5000, endTs: 5300 }); tr5.post(5000, q, 0, 5);
        V5.posts[0].res({ ok: true, orderId: "m1", status: "live" }); V5.posts[1].res({ ok: true, orderId: "m2", status: "live" }); await flush();
        tr5.stopWindow(5000, "lock: test", 10);
        tr5.post(5000, q, 20, 5);
        const after = V5.posts.length;
        tr5.post(5000, q, 30, 5, undefined, { token: "UP", price: 0.52, size: 10, kind: "lock", why: "lock test", usd: 5.1 });
        ok("lock, live trader: a stopped window cancels both bids, re-quotes nothing, and still sends the lock's take",
          V5.cancels.length === 2 && after === 2 && V5.posts.length === 2 && V5.takes.length === 1, `cancels ${V5.cancels.length} posts ${V5.posts.length} takes ${V5.takes.length}`);
      } finally { fs.rmSync(tr5dir, { recursive: true, force: true }); }
    } finally { cfg.mode = was; fs.rmSync(tmp, { recursive: true, force: true }); }
  }
}

// ---- LIVE_POST_COPIES (venue.ts racePosts): one signed body posted n times; the first accepted copy decides ----
{
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const dup: PostResult = postFailure("RequestRejectedError", "RequestRejectedError: order 0xab is invalid. Duplicated. (https://clob.polymarket.com/order)");
  const tout: PostResult = postFailure("RequestRejectedError", "RequestRejectedError: order timed out (https://clob.polymarket.com/order)");
  const noMatch: PostResult = postFailure("RequestRejectedError", "RequestRejectedError: no orders found to match with FAK order");
  const okR: PostResult = { ok: true, orderId: "0xab", status: "matched", making: 2.5, taking: 5 };
  // copy i answers `plan[i]` after `ms[i]` (a throw for "throw")
  const race = (plan: (PostResult | "throw")[], ms: number[], warns: string[] = []) => {
    let i = 0;
    return racePosts(plan.length, () => { const k = i++; return wait(ms[k]).then(() => { if (plan[k] === "throw") throw new Error("socket hang up"); return plan[k] as PostResult; }); }, (m) => warns.push(m));
  };
  const t0 = Date.now();
  const r1 = await race([dup, okR, dup, dup, dup], [30, 10, 40, 50, 60]);
  ok("copies: the first accepted copy answers at once, not after the slow duplicates", r1.ok && r1.orderId === "0xab" && r1.taking === 5 && Date.now() - t0 < 28 && r1.race?.n === 5,
    `${Date.now() - t0} ms ${JSON.stringify(r1)}`);
  await wait(70);
  ok("copies: the late copies' answers are added to the race record (the timing line)", r1.race?.got.map((g) => g.what).sort().join(",") === "dup,dup,dup,dup,ok");
  const r2 = await race([noMatch, okR, dup], [5, 30, 20]);
  ok("copies: an early refusal does not decide while a copy is still out (it came back accepted)", r2.ok);
  const r3 = await race([dup, noMatch, dup, tout, dup], [5, 15, 10, 20, 25]);
  ok("copies: none accepted, one real refusal → that refusal (a FAK that found nothing: missed)", !r3.ok && r3.code === "rejected" && /no orders found/.test(r3.message), JSON.stringify(r3));
  const r4 = await race([dup, tout, "throw", dup, dup], [5, 10, 15, 20, 25]);
  ok("copies: only duplicates, timeouts and a lost answer → uncertain (one may be placed: the exchange watches for it)",
    !r4.ok && r4.code === "uncertain" && /none of 5 copies/.test(r4.message), JSON.stringify(r4));
  const w: string[] = [];
  const r5 = await race([okR, okR, dup], [5, 10, 15], w);
  await wait(20);
  ok("copies: a second accepted copy (the venue placing it twice) is warned of, the first answer stands", r5.ok && w.length === 1 && /more than one/.test(w[0]), w.join(" | "));
  ok("copies: LIVE_POST_COPIES defaults to 1 (one post)", CFG.livePostCopies === 1);
}

// ---- LIVE_CANCEL_COPIES (venue.ts raceCancels) and LIVE_CANCEL_HTTP=own (ownCanceller): offline, nothing is sent ----
{
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const okC: CancelAnswer = { ok: true, reason: "" };
  const nf: CancelAnswer = { ok: false, reason: "order can't be found - already canceled or matched" };
  const race = (plan: (CancelAnswer | "throw")[], ms: number[]) => {
    let i = 0;
    return raceCancels(plan.length, () => { const k = i++; return wait(ms[k]).then(() => { if (plan[k] === "throw") throw new Error("socket hang up"); return plan[k] as CancelAnswer; }); });
  };
  const t0 = Date.now();
  const c1 = await race([nf, okC], [5, 20]);
  ok("cancel copies: a copy's \"not found\" first does not decide while the other is out (it cancelled)", c1.ok && Date.now() - t0 >= 18, `${Date.now() - t0} ms`);
  const t1 = Date.now();
  const c2 = await race([okC, nf], [5, 40]);
  ok("cancel copies: the first copy that cancelled answers at once, not after the slow one", c2.ok && Date.now() - t1 < 35, `${Date.now() - t1} ms`);
  const c3 = await race([nf, nf], [5, 10]);
  ok("cancel copies: none cancelled → the first answer (the live exchange settles it from the records)", !c3.ok && /can't be found/.test(c3.reason));
  const c4 = await race(["throw", okC], [5, 10]);
  ok("cancel copies: one copy lost on the way, the other cancelled → cancelled", c4.ok);
  const c5 = await race(["throw", nf], [5, 10]);
  ok("cancel copies: one lost, one \"not found\" → that answer, not an error", !c5.ok && /can't be found/.test(c5.reason));
  let threw = "";
  try { await race(["throw", "throw"], [5, 10]); } catch (e) { threw = (e as Error).message; }
  ok("cancel copies: every copy lost → it throws (the live exchange retries, as for one cancel)", threw === "socket hang up", threw);

  // the L2 signature, synchronous, against a vector the SDK itself produced (offline probe, 2026-11-11)
  const SECRET = "c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTEyMzQ=", TS = 1794380753;
  ok("own cancel: l2Signature matches the SDK's POLY_SIGNATURE for the same request",
    l2Signature(l2Key(SECRET), TS, "DELETE", "/order", JSON.stringify({ orderID: "0xabc" })) === "Xx3MGt62HdZ3fJOqf3njT3QpOL-VgWYRFpcjIFtTJ5w=");

  // the own request against the SDK's own cancelOrder request, byte for byte: fetch stubbed, a throwaway key, fake creds
  type Seen = { url: string; method: string; headers: Record<string, string>; body: string | null };
  const capture = async (req: Request, into: Seen[]) => {
    const headers: Record<string, string> = {}; req.headers.forEach((v, k) => { headers[k] = v; });
    into.push({ url: req.url, method: req.method, headers, body: req.body ? await req.text() : null });
  };
  const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
  const realFetch = globalThis.fetch, sdkSeen: Seen[] = [];
  const KEY = "00000000-1111-2222-3333-444444444444", PK = "0x" + "22".repeat(32);
  let sameReq = false, sdkNote = "";
  try {
    (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      await capture(req.clone(), sdkSeen);
      const u = new URL(req.url);
      if (u.pathname === "/auth/api-keys") return json({ apiKeys: [KEY] });
      if (u.pathname === "/order" && req.method === "DELETE") return json({ canceled: ["0xabc"], not_canceled: {} });
      return json({});
    }) as typeof fetch;
    const { createSecureClient } = await import("@polymarket/client");
    const { privateKey } = await import("@polymarket/client/viem");
    const signerAddr = "0x1563915e194D8CfBA1943570603F7606A3115508";       // the address of PK (the SDK checks it)
    const client: any = await createSecureClient({ signer: privateKey(PK), wallet: signerAddr, credentials: { key: KEY, secret: SECRET, passphrase: "pp" } as never });
    sdkSeen.length = 0;
    await client.cancelOrder({ orderId: "0xabc" });
    const sdk = sdkSeen.find((s) => s.method === "DELETE");
    const ownSeen: Seen[] = [];
    const ts = Number(sdk?.headers.poly_timestamp);
    const own = ownCanceller({ key: KEY, secret: SECRET, passphrase: "pp", address: client.account.signer },
      (async (input: RequestInfo | URL, init?: RequestInit) => { await capture(new Request(input, init), ownSeen); return json({ canceled: ["0xabc"], not_canceled: {} }); }) as typeof fetch,
      () => ts * 1000);
    const ans = await own("0xabc");
    const a = ownSeen[0];
    sameReq = !!sdk && !!a && a.url === sdk.url && a.method === sdk.method && a.body === sdk.body && JSON.stringify(a.headers) === JSON.stringify(sdk.headers) && "ok" in ans && ans.ok;
    sdkNote = sameReq ? "" : JSON.stringify({ sdk, own: a });
  } catch (e) { sdkNote = `${(e as Error).name}: ${(e as Error).message}`; }
  finally { (globalThis as { fetch: typeof fetch }).fetch = realFetch; }
  ok("own cancel: the same URL, method, body and headers (POLY_ADDRESS = the signer) as the SDK's cancelOrder", sameReq, sdkNote.slice(0, 400));

  // its answers: 200 cancelled / not cancelled (raw not_canceled), anything else handed back for the SDK fallback
  const ownWith = (status: number, body: unknown) => ownCanceller({ key: KEY, secret: SECRET, passphrase: "pp", address: "0x1" },
    (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch);
  const o1 = await ownWith(200, { canceled: ["0xabc"], not_canceled: {} })("0xabc");
  const o2 = await ownWith(200, { canceled: [], not_canceled: { "0xabc": "order can't be found - already canceled or matched" } })("0xabc");
  const o3 = await ownWith(401, { error: "Unauthorized/Invalid api key" })("0xabc");
  const o4 = await ownWith(200, "<html>bad gateway</html>")("0xabc");
  ok("own cancel: HTTP 200 cancelled → ok; not_canceled → its reason", "ok" in o1 && o1.ok && "ok" in o2 && !o2.ok && /can't be found/.test(o2.reason), JSON.stringify([o1, o2]));
  ok("own cancel: a 401, or a 200 that is not JSON, comes back as { status } for the SDK to send it again",
    "status" in o3 && o3.status === 401 && "status" in o4 && o4.status === 200, JSON.stringify([o3, o4]));
  // a connection that never answers: the request is aborted at its timeout and throws (→ the SDK sends it again)
  const hang = ownCanceller({ key: KEY, secret: SECRET, passphrase: "pp", address: "0x1" },
    ((_: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)))) as typeof fetch,
    Date.now, 40);
  const th = Date.now(); let hung = "";
  try { await hang("0xabc"); hung = "answered"; } catch (e) { hung = (e as Error).name; }
  ok("own cancel: no answer → it throws at its timeout (10 s live, as ky's), not after minutes", hung === "TimeoutError" && Date.now() - th < 1000, `${hung} after ${Date.now() - th} ms`);

  ok("cancel copies / own path: off by default (LIVE_CANCEL_COPIES 1, LIVE_CANCEL_HTTP sdk)", CFG.liveCancelCopies === 1 && CFG.liveCancelHttp === "sdk");
  const lt = (x: Partial<typeof CFG>) => windowTag(1792490700, { ...CFG, mode: "live", liveEarlyCancel: true, ...x } as typeof CFG);
  ok("cancel copies / own path: live tag +live+ec+cc2+own, and +live+ec without them",
    lt({ liveCancelCopies: 2, liveCancelHttp: "own" }).endsWith("+live+ec+cc2+own") && lt({ liveCancelCopies: 1, liveCancelHttp: "sdk" }).endsWith("+live+ec"),
    lt({ liveCancelCopies: 2, liveCancelHttp: "own" }));
}

// ---- tail guard (guard.ts): every rule off by default; each pulls the side it should, the vol cap reaches the order manager ----
{
  const base: GuardCfg = { ...CFG.guard, whipTv: null, gammaPull: null, jumpBps: null, invStopNet: null, capVolTv: null, tvMs: 10_000,
    whipHoldMs: 5000, whipSide: "both", gammaSide: "both", jumpMs: 300, jumpHoldMs: 1000, invStopLoss: 0.05, invStopHoldMs: 10_000, capVolFloor: 0.25, maxPosition: 20 };
  const env = CFG.guard;
  ok("guard: off by default (no rule knob in .env → guardCfg null, no +guard tag)",
    (env.whipTv ?? env.gammaPull ?? env.jumpBps ?? env.invStopNet ?? env.capVolTv) != null || (guardCfg() === null && !windowTag(1792490700).includes("+guard")));
  const q0 = makeQuote({ center: 0.505, centerSrc: "t", move2s: 0, elapsed: 100, left: 200, tick: 0.01, minSize: 5, bookReady: true, bestBid: 0.5, bestAsk: 0.51, net: 0, fv: 0.505, mid: 0.505 }, quoteCfg("v4"));
  ok("guard: applyGuard(q, null) is the quote itself", applyGuard(q0, null, 0, 5) === q0);
  const at = (o: Partial<GuardIn>): GuardIn => ({ now: 0, mid: 0.5, centre: 0.5, left: 200, net: 0, heldAvg: null, perp: null, tick: 0.01, minSize: 5, ...o });
  // whipsaw: 50 → 60 → 50¢ within 10 s is 20¢ of path; flicker inside a tick is none
  const gw = new Guard({ ...base, whipTv: 0.1 });
  let o = gw.observe(at({ now: 0, mid: 0.5 }));
  ok("guard whipsaw: quiet → nothing pulled", o.bid == null && o.ask == null);
  for (const [t, m] of [[1000, 0.505], [1100, 0.5], [1200, 0.505], [1300, 0.5]] as const) o = gw.observe(at({ now: t, mid: m }));
  ok("guard whipsaw: a mid flickering half a tick adds no path", o.bid == null && o.ask == null && gw.active.whip === 0);
  for (const [t, m] of [[2000, 0.55], [3000, 0.6], [4000, 0.55], [5000, 0.5]] as const) o = gw.observe(at({ now: t, mid: m }));
  ok("guard whipsaw: 20¢ of path in 4 s → both bids pulled", o.bid != null && o.ask != null && /whipsaw/.test(o.bid ?? ""), o.bid ?? "");
  o = gw.observe(at({ now: 9000, mid: 0.5 }));
  ok("guard whipsaw: held for MM_WHIP_HOLD_MS after the last trigger", o.bid != null);
  o = gw.observe(at({ now: 16_000, mid: 0.5 }));
  ok("guard whipsaw: released once the path left the lookback and the hold ran out", o.bid == null && o.ask == null);
  const ga = new Guard({ ...base, whipTv: 0.1, whipSide: "adding" });
  for (const [t, m] of [[0, 0.5], [1000, 0.6], [2000, 0.5]] as const) o = ga.observe(at({ now: t, mid: m, net: 15 }));
  ok("guard whipsaw adding: long Up → only the Up bid pulled", o.bid != null && o.ask == null);
  // gamma: 50¢ with 30 s left is 0.40·√10 = 1.26
  const gg = new Guard({ ...base, gammaPull: 1 });
  ok("guard gamma: 50¢ at 30 s left (1.26) → pulled", gg.observe(at({ centre: 0.5, left: 30 })).bid != null);
  ok("guard gamma: 50¢ at 200 s left (0.49) → kept", gg.observe(at({ centre: 0.5, left: 200 })).bid == null);
  ok("guard gamma: 95¢ at 30 s left (0.33) → kept", gg.observe(at({ centre: 0.95, left: 30 })).bid == null);
  // perp jump: +4 bp in 200 ms pulls the Down bid, −4 bp the Up bid
  const pb = new PriceBuffer(60_000);
  pb.push(0, 100_000); pb.push(1000, 100_000); pb.push(1200, 100_040); pb.push(3000, 100_040); pb.push(3100, 100_000);
  const gj = new Guard({ ...base, jumpBps: 3, jumpMs: 300, jumpHoldMs: 1000 });
  o = gj.observe(at({ now: 1100, perp: pb }));
  ok("guard jump: flat perp → nothing", o.bid == null && o.ask == null);
  o = gj.observe(at({ now: 1250, perp: pb }));
  ok("guard jump: perp +4 bp in 300 ms → Down bid pulled, Up bid kept", o.ask != null && o.bid == null, `${o.bid} | ${o.ask}`);
  o = gj.observe(at({ now: 2000, perp: pb }));
  ok("guard jump: held MM_JUMP_HOLD_MS", o.ask != null);
  o = gj.observe(at({ now: 2300, perp: pb }));
  ok("guard jump: released after the hold", o.ask == null);
  o = gj.observe(at({ now: 3150, perp: pb }));
  ok("guard jump: perp −4 bp → Up bid pulled", o.bid != null && o.ask == null);
  // inventory stop: 20 Up at 60¢ with the mid at 50¢ is 10¢ under cost
  const gi = new Guard({ ...base, invStopNet: 15, invStopLoss: 0.05 });
  o = gi.observe(at({ net: 20, heldAvg: 0.6, mid: 0.58 }));
  ok("guard inventory: 2¢ under cost → keeps adding", o.bid == null);
  o = gi.observe(at({ now: 100, net: 20, heldAvg: 0.6, mid: 0.5 }));
  ok("guard inventory: 10¢ under cost on 20 Up → no Up bid, the Down bid (reducing) stays", o.bid != null && o.ask == null);
  o = gi.observe(at({ now: 200, net: -20, heldAvg: 0.6, mid: 0.5 }));
  ok("guard inventory: long Down 10¢ under cost → no Down bid", o.ask != null && o.bid == null);
  // vol cap: 40¢ of path against MM_CAP_VOL_TV 10¢ → cap 20 × 0.25 = 5
  const gc = new Guard({ ...base, capVolTv: 0.1, capVolFloor: 0.25 });
  for (const [t, m] of [[0, 0.5], [500, 0.6], [1000, 0.5], [1500, 0.6], [2000, 0.5]] as const) o = gc.observe(at({ now: t, mid: m }));
  ok("guard cap: 40¢ of path → cap 5", o.cap === 5, String(o.cap));
  const qc = applyGuard(q0, o, 3, 5);
  ok("guard cap: the quote carries it, a side with no room under it goes", qc.cap === 5 && qc.bid == null && qc.ask != null && qc.askSize === 8,
    `${qc.bid}/${qc.bidSize} ${qc.ask}/${qc.askSize}`);
  ok("guard: the restated target is the last step", qc.steps[qc.steps.length - 1].k === "target" && qc.steps.filter((s) => s.k === "target").length === 1);
  const sv = { ...CFG.guard };
  CFG.guard.whipTv = 0.1;
  ok("guard: a rule on → guardCfg set and the window tag ends in +guard before the flow/step parts", guardCfg() !== null && /\+guard/.test(quoteTag("v4")));
  Object.assign(CFG.guard, sv);
}

// ---- pair cost (paircost.ts): every rule off by default; cap, stop, widen and hold move the side they should ----
{
  const base: PcCfg = { target: null, race: true, stop: null, widen: null, widenFrom: 1.0, widenMax: 5, minPairs: 20, holdP: null, holdMax: 1.03, holdExit: 0.5 };
  const env = CFG.pc;
  ok("pc: off by default (no rule knob in .env → pcCfg null, no +pc tag)",
    (env.target ?? env.stop ?? env.widen ?? env.holdP) != null || (pcCfg() === null && !windowTag(1792490700).includes("+pc")));
  // Up bid 50¢, Down bid 49¢ (the Up ask at 51¢), 20 a side
  const qx = (net: number) => makeQuote({ center: 0.505, centerSrc: "t", move2s: 0, elapsed: 100, left: 200, tick: 0.01, minSize: 5, bookReady: true,
    bestBid: 0.5, bestAsk: 0.51, net, fv: 0.505, mid: 0.505 }, { ...quoteCfg("v4"), orderSize: 20, maxPosition: 40, skewAtMax: 0 });
  const at = (o: Partial<PcIn>): PcIn => ({ centre: 0.505, net: 0, heldAvg: null, pairs: 0, pairCost: 0, tick: 0.01, minSize: 5, ...o });
  const q0 = qx(0), q20 = qx(20), qm20 = qx(-20);
  ok("pc: the test quote bids 50¢ Up and 49¢ Down", q0.bid === 0.5 && q0.ask === 0.51 && q20.ask === 0.51 && qm20.bid === 0.5, `${q0.bid}/${q0.ask} ${q20.ask} ${qm20.bid}`);
  // cap: 20 Up at 56¢, target 99¢ → the Down bid at ≤ 43¢ (the Up ask at 57¢); long Down at 56¢ → the Up bid at 43¢
  let o = new PairCost({ ...base, target: 0.99 }).apply(q20, at({ net: 20, heldAvg: 0.56 }));
  ok("pc cap: 20 Up @ 56¢, target 99¢ → the Down bid 49¢ → 43¢, the Up bid untouched", o.ask === 0.57 && o.askSize === q20.askSize && o.bid === q20.bid, `${o.bid} ${o.ask}`);
  ok("pc cap: the quote carries the hard limit for the order manager (the Up ask ≥ 57¢), in the race by default",
    o.pcLim?.ask === 0.57 && o.pcLim.bid === null && !o.pcLim.rest.ask, JSON.stringify(o.pcLim));
  o = new PairCost({ ...base, target: 0.99, race: false }).apply(q20, at({ net: 20, heldAvg: 0.56 }));
  ok("pc cap: MM_PC_RACE=off marks the held-back side as resting outside the race", o.pcLim?.rest.ask === true && !o.pcLim.rest.bid);
  o = new PairCost({ ...base, target: 0.99 }).apply(qm20, at({ net: -20, heldAvg: 0.56 }));
  ok("pc cap: 20 Down @ 56¢ → the Up bid 50¢ → 43¢", o.bid === 0.43 && o.ask === qm20.ask, `${o.bid} ${o.ask}`);
  o = new PairCost({ ...base, target: 0.99 }).apply(q20, at({ net: 20, heldAvg: 0.45 }));
  ok("pc cap: 20 Up @ 45¢ → the 49¢ Down bid already pairs at 94¢, kept; the limit still goes to the order manager", o.ask === q20.ask && o.bid === q20.bid && o.pcLim?.ask === 0.46);
  o = new PairCost({ ...base, target: 0.99 }).apply(q0, at({ net: 3, heldAvg: 0.8 }));
  ok("pc cap: under the minimum size held → nothing capped", o.ask === q0.ask && o.bid === q0.bid);
  o = new PairCost({ ...base, target: 0.99 }).apply(q20, at({ net: 20, heldAvg: 0.985 }));
  ok("pc cap: no price ≥ 1¢ pairs at ≤ 99¢ → the Down bid goes", o.ask == null && o.askSize === 0 && o.bid === q20.bid && /pair/.test(o.off.ask ?? ""), o.off.ask ?? "");
  // stop: 30 pairs at 104¢ ≥ 103¢ → the adding side goes (both when flat); under min pairs or under the stop → nothing
  o = new PairCost({ ...base, stop: 1.03 }).apply(q20, at({ net: 20, heldAvg: 0.5, pairs: 30, pairCost: 31.2 }));
  ok("pc stop: 30 pairs at 104¢, long Up → the Up bid goes, the Down bid stays", o.bid == null && o.ask === q20.ask, `${o.bid} ${o.ask}`);
  o = new PairCost({ ...base, stop: 1.03 }).apply(q0, at({ pairs: 30, pairCost: 31.2 }));
  ok("pc stop: flat → both bids go", o.bid == null && o.ask == null);
  o = new PairCost({ ...base, stop: 1.03 }).apply(q0, at({ pairs: 10, pairCost: 10.4 }));
  ok("pc stop: 10 pairs is under MM_PC_MIN_PAIRS → nothing", o.bid === q0.bid && o.ask === q0.ask);
  o = new PairCost({ ...base, stop: 1.03 }).apply(q0, at({ pairs: 30, pairCost: 30.6 }));
  ok("pc stop: 102¢ is under the stop → nothing", o.bid === q0.bid && o.ask === q0.ask);
  // widen: 1 tick per 1¢ over 100¢, 30 pairs at 103¢ → 3 ticks back on the adding side
  o = new PairCost({ ...base, widen: 1 }).apply(q20, at({ net: 20, heldAvg: 0.5, pairs: 30, pairCost: 30.9 }));
  ok("pc widen: 103¢, long Up → the Up bid 3 ticks back (47¢), the Down bid kept", o.bid === 0.47 && o.ask === q20.ask, `${o.bid} ${o.ask}`);
  o = new PairCost({ ...base, widen: 1 }).apply(q0, at({ pairs: 30, pairCost: 30.9 }));
  ok("pc widen: flat → both 3 ticks back (Up 47¢, Down 46¢)", o.bid === 0.47 && o.ask === 0.54, `${o.bid} ${o.ask}`);
  o = new PairCost({ ...base, widen: 2, widenMax: 4 }).apply(q0, at({ pairs: 30, pairCost: 30.9 }));
  ok("pc widen: capped at MM_PC_WIDEN_MAX ticks", o.bid === 0.46 && o.ask === 0.55, `${o.bid} ${o.ask}`);
  // hold: long Up with Up the favourite (centre 65¢) and no pairs → the Down bid goes; it ends at 50¢ or when the pair cost reaches the cap
  const qh = makeQuote({ center: 0.655, centerSrc: "t", move2s: 0, elapsed: 100, left: 200, tick: 0.01, minSize: 5, bookReady: true,
    bestBid: 0.65, bestAsk: 0.66, net: 20, fv: 0.655, mid: 0.655 }, { ...quoteCfg("v4"), orderSize: 20, maxPosition: 40, skewAtMax: 0 });
  const ph = new PairCost({ ...base, holdP: 0.6 });
  o = ph.apply(qh, at({ centre: 0.655, net: 20, heldAvg: 0.55 }));
  ok("pc hold: 20 Up, Up at 65.5¢ ≥ 60¢, no pairs → the Down bid goes, the Up bid stays", o.ask == null && o.bid === qh.bid && /holding Up/.test(o.off.ask ?? ""), o.off.ask ?? "");
  o = ph.apply(qh, at({ centre: 0.56, net: 20, heldAvg: 0.55 }));
  ok("pc hold: held while the favourite stays over MM_PC_HOLD_EXIT (56¢)", o.ask == null);
  o = ph.apply(qh, at({ centre: 0.5, net: 20, heldAvg: 0.55 }));
  ok("pc hold: ends at 50¢ → the Down bid is back", o.ask === qh.ask);
  o = ph.apply(qh, at({ centre: 0.56, net: 20, heldAvg: 0.55 }));
  ok("pc hold: not taken up again under MM_PC_HOLD_P (56¢)", o.ask === qh.ask);
  o = ph.apply(qh, at({ centre: 0.7, net: 20, heldAvg: 0.55, pairs: 30, pairCost: 31.2 }));
  ok("pc hold: the window's pairs at 104¢ ≥ 103¢ → no hold", o.ask === qh.ask);
  o = new PairCost({ ...base, holdP: 0.6 }).apply(qh, at({ centre: 0.3, net: 20, heldAvg: 0.55 }));
  ok("pc hold: long the underdog → no hold", o.ask === qh.ask);
  ok("pc: the restated target is the last step", o.steps[o.steps.length - 1].k === "target" && o.steps.filter((s) => s.k === "target").length === 1);
  ok("pc: the rule counters count the steps a rule acted in", ph.active.hold === 2 && ph.active.cap === 0, JSON.stringify(ph.active));
  const sv = { ...CFG.pc };
  CFG.pc.target = 0.99;
  const noXs = { ...CFG, xs: { ...CFG.xs, edge: null, jumpBps: null, lateSec: null, stopLoss: null } };   // no +xs after it, whatever .env says
  ok("pc: a rule on → pcCfg set and the tag ends in +pc after +guard", pcCfg() !== null && /\+pc$/.test(quoteTag("v5", noXs)) && !/\+pc/.test(quoteTag("v3")), quoteTag("v5", noXs));
  Object.assign(CFG.pc, sv);
}

// ---- excess (excess.ts): every trigger off by default; edge, jump, stop and late buy the short token, gates and sizes hold ----
{
  const base: XsCfg = { edge: null, jumpBps: null, jumpMs: 300, lateSec: null, stopLoss: null, holdP: null, minNet: 5, keep: 0, maxSh: 20,
    slip: 0, maxPx: 0.95, cooldownMs: 2000, fromSec: 5, untilLeftSec: 10, fast: true };
  const env = CFG.xs;
  ok("xs: off by default (no trigger knob in .env → xsCfg null, no +xs tag)",
    (env.edge ?? env.jumpBps ?? env.lateSec ?? env.stopLoss) != null || (xsCfg() === null && !windowTag(1792490700).includes("+xs")));
  // the Up book 50 / 51¢, so the Down ask is 50¢; the taker fee at 50¢ is 1.75¢
  const at = (o: Partial<XsIn>): XsIn => ({ now: 10_000, elapsed: 100, left: 200, good: true, bestBid: 0.5, bestAsk: 0.51, bidSz: 100, askSz: 100,
    mid: 0.505, centre: 0.505, net: 0, heldAvg: null, perp: null, free: 1000, busy: false, minSize: 5, ...o });
  const xe = new Excess({ ...base, edge: 0.01 });
  let d = xe.decide(at({ net: 20, centre: 0.47 }));
  ok("xs edge: long 20 Up, Down FV 53¢ − its ask 50¢ − fee 1.75¢ = 1.25¢ ≥ 1¢ → buy 20 Down at 50¢",
    d.take?.token === "DOWN" && d.take.price === 0.5 && d.take.size === 20 && d.take.kind === "excess", JSON.stringify(d.take));
  ok("xs edge: cooldown → none 1 s later", xe.decide(at({ now: 11_000, net: 20, centre: 0.47 })).take == null);
  ok("xs edge: after the cooldown → again", xe.decide(at({ now: 12_100, net: 20, centre: 0.47 })).take != null);
  ok("xs edge: Down FV 51¢ does not clear the fee → none", new Excess({ ...base, edge: 0.01 }).decide(at({ net: 20, centre: 0.49 })).take == null);
  ok("xs edge: short Up, Up FV 54¢ − ask 51¢ − fee → buy Up at 51¢",
    new Excess({ ...base, edge: 0.01 }).decide(at({ net: -20, centre: 0.54 })).take?.token === "UP");
  ok("xs edge: |net| 4 under MM_XS_NET 5 → none", new Excess({ ...base, edge: 0.01 }).decide(at({ net: 4, centre: 0.4 })).take == null);
  ok("xs edge: a take in flight → none", new Excess({ ...base, edge: 0.01 }).decide(at({ net: 20, centre: 0.4, busy: true })).take == null);
  ok("xs edge: 5 s left, under MM_XS_UNTIL_LEFT_SEC 10 → none", new Excess({ ...base, edge: 0.01 }).decide(at({ net: 20, centre: 0.4, left: 5 })).take == null);
  ok("xs edge: no good book → none", new Excess({ ...base, edge: 0.01 }).decide(at({ net: 20, centre: 0.4, good: false })).take == null);
  // perp +4 bp in 200 ms: Up is about to be worth more
  const pb = new PriceBuffer(60_000);
  pb.push(0, 100_000); pb.push(9_900, 100_000); pb.push(10_000, 100_040);
  const xj = new Excess({ ...base, jumpBps: 3 });
  d = xj.decide(at({ net: -20, perp: pb }));
  ok("xs jump: short 20 Up, perp +4 bp in 300 ms → buy Up at its ask", d.take?.token === "UP" && d.take.price === 0.51 && d.take.size === 20, JSON.stringify(d.take));
  ok("xs jump: long Up (short Down), the same jump runs the other way → none", new Excess({ ...base, jumpBps: 3 }).decide(at({ net: 20, perp: pb })).take == null);
  // stop: 20 Up at 60¢ average, the mid 50.5¢ is 9.5¢ under it
  d = new Excess({ ...base, stopLoss: 0.05 }).decide(at({ net: 20, heldAvg: 0.6 }));
  ok("xs stop: the held Up 9.5¢ under its cost → buy Down", d.take?.token === "DOWN" && d.take.size === 20, JSON.stringify(d.take));
  ok("xs stop: 3¢ under its cost → none", new Excess({ ...base, stopLoss: 0.05 }).decide(at({ net: 20, heldAvg: 0.535 })).take == null);
  ok("xs stop: the held Up is the favourite (centre ≥ MM_XS_HOLD_P) → kept", new Excess({ ...base, stopLoss: 0.05, holdP: 0.5 }).decide(at({ net: 20, heldAvg: 0.6 })).take == null);
  // late, sizes and the limit
  d = new Excess({ ...base, lateSec: 30, keep: 5 }).decide(at({ net: 20, left: 25 }));
  ok("xs late: 25 s left, keep 5 → buy 15 Down", d.take?.token === "DOWN" && d.take.size === 15, JSON.stringify(d.take));
  ok("xs late: 40 s left → none", new Excess({ ...base, lateSec: 30 }).decide(at({ net: 20, left: 40 })).take == null);
  ok("xs late: the held favourite is carried (hold 0.5, Down centre 0.6)", new Excess({ ...base, lateSec: 30, holdP: 0.5 }).decide(at({ net: -20, left: 25, centre: 0.4 })).take == null);
  d = new Excess({ ...base, lateSec: 30, maxSh: 10, slip: 0.02 }).decide(at({ net: 20, left: 25 }));
  ok("xs: MM_XS_MAX_SH 10 and MM_XS_SLIP 2¢ → 10 Down up to 52¢", d.take?.size === 10 && d.take.price === 0.52, JSON.stringify(d.take));
  ok("xs: it spends 10 × the 50¢ ask ($5.00), not × the limit: the slip only caps the price", d.take?.usd === 5, JSON.stringify(d.take));
  {
    // through the paper exchange: $5 at the 50¢ ask buys exactly 10; with the ask moved to 51¢ (inside the limit) 9.80, not more
    const bk = (bids: [number, number][], asks: [number, number][]): BookView =>
      ({ ready: true, bids, asks, bestBid: bids[0]?.[0] ?? null, bestAsk: asks[0]?.[0] ?? null, ageMs: 0, last: null });
    const ex = new PaperExchange(35, () => {}, 1, 1, undefined, 150, null, 100); ex.setTokens("U", "D");
    const m = { fv: 0.5, mid: 0.5 };
    const req = { win: 1, token: "UP" as const, side: "BUY" as const, price: 0.52, size: 10, reason: "t", take: true, usd: 5 };
    ex.place(req, 0); const fA = ex.step(100, 1, bk([[0.49, 100]], [[0.5, 100]]), m);
    ex.place(req, 1000); const fB = ex.step(1100, 1, bk([[0.49, 100]], [[0.51, 100]]), m);
    ok("xs take, paper: $5 buys 10 at the 50¢ ask, 9.80 at 51¢ (never more than the excess)",
      fA.length === 1 && Math.abs(fA[0].size - 10) < 1e-6 && fB.length === 1 && Math.abs(fB[0].size - 5 / 0.51) < 1e-5, JSON.stringify([fA.map((f) => f.size), fB.map((f) => f.size)]));
  }
  ok("xs: the limit stops at MM_XS_MAX_PX", new Excess({ ...base, lateSec: 30, slip: 0.1, maxPx: 0.55 }).decide(at({ net: 20, left: 25 })).take?.price === 0.55);
  ok("xs: an ask over MM_XS_MAX_PX → none", new Excess({ ...base, lateSec: 30, maxPx: 0.45 }).decide(at({ net: 20, left: 25 })).take == null);
  ok("xs: net 6, keep 2 → 4 sh under the minimum → none", new Excess({ ...base, lateSec: 30, keep: 2 }).decide(at({ net: 6, left: 25 })).take == null);
  ok("xs: the free USDC caps the size", new Excess({ ...base, lateSec: 30 }).decide(at({ net: 20, left: 25, free: 5.2 })).take?.size === 10);
  ok("xs: the counters count the takes each trigger sent", xe.active.edge === 2 && xe.active.jump === 0 && xj.active.jump === 1, JSON.stringify(xe.active));
  // the take pulls the held token's bid while it is out (the Down take lifts the Down ask = our Up bid's level)
  const qx = makeQuote({ center: 0.505, centerSrc: "t", move2s: 0, elapsed: 100, left: 200, tick: 0.01, minSize: 5, bookReady: true, bestBid: 0.5, bestAsk: 0.51, net: 0, fv: 0.505, mid: 0.505 }, quoteCfg("v4"));
  const qt = applyTake(qx, "DOWN", []);
  ok("xs: a Down take pulls the Up bid, the Down bid stays", qt.bid == null && qt.ask === qx.ask, `${qt.bid}/${qt.ask}`);
  const sv = { ...CFG.xs };
  CFG.xs.edge = 0.01;
  ok("xs: a trigger on → xsCfg set and the tag ends in +xs", xsCfg() !== null && /\+xs$/.test(quoteTag("v5")) && !/\+xs/.test(quoteTag("v3")), quoteTag("v5"));
  Object.assign(CFG.xs, sv);
}

// ---- sweep (sweep.ts): off unless a trigger and an action are set; each trigger marks the side the move runs into, each
//      action re-prices only that side, the hold ends, and the limit goes to the order manager ----
{
  const base: SwCfg = { jumpBps: null, jumpMs: 300, move: null, moveMs: 1000, fill: false, tv: null, tvMs: 10_000, holdMs: 2000,
    back: 0, backK: 0, backMax: 5, centre: "off", size: 1, side: "swept", hard: true, halfSpread: 0.005 };
  const env = CFG.sw;
  ok("sw: off by default (no trigger or no action in .env → swCfg null, no +swept tag)",
    ((env.jumpBps ?? env.move ?? env.tv) != null || env.fill) && (env.back > 0 || env.backK > 0 || env.centre === "cons" || env.size < 1) ||
    (swCfg() === null && !windowTag(1792490700).includes("+swept")));
  // Up bid 50¢, Down bid 49¢ (the Up ask at 51¢), 20 a side, no skew
  const q0 = makeQuote({ center: 0.505, centerSrc: "t", move2s: 0, elapsed: 100, left: 200, tick: 0.01, minSize: 5, bookReady: true,
    bestBid: 0.5, bestAsk: 0.51, net: 0, fv: 0.505, mid: 0.505 }, { ...quoteCfg("v4"), orderSize: 20, maxPosition: 40, skewAtMax: 0 });
  ok("sw: the test quote bids 50¢ Up and 49¢ Down, 20 each", q0.bid === 0.5 && q0.ask === 0.51 && q0.bidSize === 20 && q0.askSize === 20, `${q0.bid}/${q0.ask}`);
  const perp = (from: number, to: number) => { const b = new PriceBuffer(60_000); b.push(9_000, from); b.push(10_250, to); return b; };
  const at = (o: Partial<SwIn>): SwIn => ({ now: 10_300, mid: 0.505, alt: 0.505, perp: null, upBought: 0, downBought: 0, tick: 0.01, minSize: 5, ...o });
  // jump: the perp −2 bp in 300 ms sweeps the Up bid
  const sj = new Sweep({ ...base, jumpBps: 1, back: 2 });
  let o = sj.apply(q0, at({ perp: perp(100_000, 99_980) }));
  ok("sw jump: perp −2 bp in 300 ms → the Up bid 50¢ → 48¢, the Down bid kept", o.bid === 0.48 && o.ask === 0.51 && o.bidSize === 20, `${o.bid}/${o.ask}`);
  ok("sw jump: the stepped price goes to the order manager as a hard limit", o.pcLim?.bid === 0.48 && o.pcLim.ask == null && !o.pcLim.rest.bid, JSON.stringify(o.pcLim));
  o = new Sweep({ ...base, jumpBps: 1, back: 2, hard: false }).apply(q0, at({ perp: perp(100_000, 99_980) }));
  ok("sw hard off: the same step-back, but no limit for the order manager (a working bid keeps its queue spot)", o.bid === 0.48 && o.pcLim == null, JSON.stringify(o.pcLim));
  ok("sw: the restated target is the last step", o.steps[o.steps.length - 1].k === "target" && o.steps.filter((x) => x.k === "target").length === 1);
  o = sj.apply(q0, at({ now: 11_300, perp: perp(99_980, 99_980) }));
  ok("sw hold: 1 s later on a flat perp the Up bid is still swept", o.bid === 0.48, String(o.bid));
  o = sj.apply(q0, at({ now: 12_400, perp: perp(99_980, 99_980) }));
  ok("sw hold: past MM_SW_HOLD_MS → back at 50¢, no limit", o.bid === 0.5 && o.pcLim == null, `${o.bid} ${JSON.stringify(o.pcLim)}`);
  o = new Sweep({ ...base, jumpBps: 1, back: 2 }).apply(q0, at({ perp: perp(100_000, 100_020) }));
  ok("sw jump: perp +2 bp → the Down bid 49¢ → 47¢ (the Up ask 51¢ → 53¢), the Up bid kept", o.ask === 0.53 && o.bid === 0.5 && o.pcLim?.ask === 0.53, `${o.bid}/${o.ask}`);
  o = new Sweep({ ...base, jumpBps: 3, back: 2 }).apply(q0, at({ perp: perp(100_000, 99_980) }));
  ok("sw jump: −2 bp under a 3 bp trigger → nothing moves", o.bid === 0.5 && o.ask === 0.51 && o.pcLim == null);
  // move: the mid 53¢ → 50.5¢ in 0.5 s; back k 1 tick per 1¢ → 2 ticks
  const sm = new Sweep({ ...base, move: 0.02, backK: 1 });
  sm.apply(q0, at({ now: 9_800, mid: 0.53 }));
  o = sm.apply(q0, at({ now: 10_300, mid: 0.505 }));
  ok("sw move: the mid −2.5¢ in 0.5 s → the Up bid steps back 2 ticks (k 1 per 1¢) to 48¢", o.bid === 0.48 && o.ask === 0.51, `${o.bid}/${o.ask}`);
  const sm2 = new Sweep({ ...base, move: 0.02, back: 1 });
  for (const [t, m] of [[8_000, 0.53], [8_800, 0.525], [9_200, 0.52], [9_800, 0.51], [10_300, 0.505]]) o = sm2.apply(q0, at({ now: t, mid: m }));
  ok("sw move: the same 2.5¢ spread over 2.3 s (1.5¢ in the last 1 s) is not a 1 s move → nothing", o.bid === 0.5 && sm2.active.move === 0, String(o.bid));
  // fill: 10 Up bought since the last decision
  const sf = new Sweep({ ...base, fill: true, back: 1 });
  o = sf.apply(q0, at({ now: 10_000 }));
  ok("sw fill: the first decision only records what was bought", o.bid === 0.5);
  o = sf.apply(q0, at({ now: 10_010, upBought: 10 }));
  ok("sw fill: the Up bid was filled → it steps back a tick to 49¢", o.bid === 0.49 && o.ask === 0.51, `${o.bid}/${o.ask}`);
  // tv: the mid chops 50 ↔ 53¢ → 12¢ of total variation → both sides
  const st = new Sweep({ ...base, tv: 0.1, back: 1 });
  for (const [t, m] of [[1000, 0.5], [2000, 0.53], [3000, 0.5], [4000, 0.53], [5000, 0.5]]) o = st.apply(q0, at({ now: t, mid: m }));
  ok("sw tv: 12¢ of total variation in 10 s → both bids a tick back", o.bid === 0.49 && o.ask === 0.52, `${o.bid}/${o.ask}`);
  // centre cons: the anchored FV 47¢ under the flow FV's 50.5¢ prices the swept Up bid at 46¢
  o = new Sweep({ ...base, jumpBps: 1, centre: "cons" }).apply(q0, at({ alt: 0.47, perp: perp(100_000, 99_980) }));
  ok("sw centre: anchored FV 47¢ → the swept Up bid 50¢ → 46¢, the Down bid kept", o.bid === 0.46 && o.ask === 0.51, `${o.bid}/${o.ask}`);
  o = new Sweep({ ...base, jumpBps: 1, centre: "cons" }).apply(q0, at({ alt: 0.53, perp: perp(100_000, 99_980) }));
  ok("sw centre: an anchored FV above the centre never raises the Up bid", o.bid === 0.5, String(o.bid));
  o = new Sweep({ ...base, jumpBps: 1, centre: "cons" }).apply(q0, at({ alt: 0.54, perp: perp(100_000, 100_020) }));
  ok("sw centre: anchored FV 54¢ → the swept Down bid 49¢ → 45¢ (Up ask 55¢)", o.ask === 0.55 && o.bid === 0.5, `${o.bid}/${o.ask}`);
  // size, side, the limit already there, under 1¢
  o = new Sweep({ ...base, jumpBps: 1, size: 0.5 }).apply(q0, at({ perp: perp(100_000, 99_980) }));
  ok("sw size: × 0.5 → the swept Up bid 20 → 10 at the same price, the Down bid 20", o.bid === 0.5 && o.bidSize === 10 && o.askSize === 20, `${o.bidSize}/${o.askSize}`);
  o = new Sweep({ ...base, jumpBps: 1, size: 0.1 }).apply(q0, at({ perp: perp(100_000, 99_980) }));
  ok("sw size: × 0.1 → at least the market's minimum 5", o.bidSize === 5, String(o.bidSize));
  o = new Sweep({ ...base, jumpBps: 1, back: 1, side: "both" }).apply(q0, at({ perp: perp(100_000, 99_980) }));
  ok("sw side both: the Up bid swept → both bids a tick back", o.bid === 0.49 && o.ask === 0.52, `${o.bid}/${o.ask}`);
  o = new Sweep({ ...base, jumpBps: 1, back: 2 }).apply({ ...q0, pcLim: { bid: 0.49, ask: 0.6, rest: { bid: true, ask: false } } }, at({ perp: perp(100_000, 99_980) }));
  ok("sw: a limit already on the quote (pair-cost cap) is kept and tightened", o.pcLim?.bid === 0.48 && o.pcLim.ask === 0.6 && o.pcLim.rest.bid, JSON.stringify(o.pcLim));
  o = new Sweep({ ...base, jumpBps: 1, back: 5 }).apply({ ...q0, bid: 0.03 }, at({ perp: perp(100_000, 99_980) }));
  ok("sw back: a bid stepped under 1¢ goes", o.bid == null && o.bidSize === 0 && /under 1¢/.test(o.off.bid ?? ""), o.off.bid ?? "");
  ok("sw: the counters count the steps each trigger and action acted in", sj.active.jump === 1 && sj.active.back === 2 && sm.active.move === 1 && sf.active.fill === 1,
    JSON.stringify([sj.active, sm.active, sf.active]));
  const sv = { ...CFG.sw };
  CFG.sw.jumpBps = 1;
  ok("sw: a trigger without an action → swCfg null", swCfg() === null);
  CFG.sw.back = 1;
  ok("sw: a trigger and an action → swCfg set and the tag ends in +swept", swCfg() !== null && /\+swept$/.test(quoteTag("v5")) && !/\+swept/.test(quoteTag("v3")) && !/\+swept/.test(windowTag(1792490700, { ...CFG, sw: sv })), quoteTag("v5"));
  Object.assign(CFG.sw, sv);
}

// ---- v5 = v4 + the tail guard's adopted rules (2026-10-22); the certainty maker is "cert" now ----
{
  ok("v5: v4's family (quote, takes, race, flow FV, 10 ms), cert and v3 are not", isV4("v4") && isV4("v5") && !isV4("cert") && !isV4("v3"));
  const x = { center: 0.505, centerSrc: "t", move2s: 0, elapsed: 100, left: 200, tick: 0.01, minSize: 5, bookReady: true, bestBid: 0.5, bestAsk: 0.51, net: 4, fv: 0.505, mid: 0.505 };
  const q4 = makeQuote(x, quoteCfg("v4")), q5 = makeQuote(x, quoteCfg("v5"));
  ok("v5: the same quote as v4 before the guard, under its own name", q5.policy === "v5" && q5.bid === q4.bid && q5.ask === q4.ask &&
    q5.bidSize === q4.bidSize && q5.askSize === q4.askSize && /^v5 \(v4 \+ tail guard\)/.test(q5.steps[0].v), `${q5.bid}/${q5.ask} vs ${q4.bid}/${q4.ask}`);
  const c5 = { ...CFG, quotePolicy: "v5" as const, flowFv: "on" as const, decideStepMs: 10, guard: { ...CFG.guard, gammaPull: 0.6, capVolTv: 0.3 },
    xs: { ...CFG.xs, edge: null, jumpBps: null, lateSec: null, stopLoss: null } };   // no +xs between +guard and +ffv, whatever .env says
  ok("v5: tag v5+…+guard+ffv+10ms, flow FV and 10 ms decisions on", /^v5\+.*\+guard\+ffv\+10ms/.test(windowTag(1792490700, c5)) &&
    flowFor(1792490700, c5) && fastFor(1792490700, c5), windowTag(1792490700, c5));
  // the defaults hang on MM_POLICY at boot: read them from a fresh config (an empty knob = unset, so .env can't fill it)
  const boot = (env: Record<string, string>) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), "-e",
      `import(${JSON.stringify(path.join(ROOT, "src/config.ts"))}).then((m) => console.log(JSON.stringify(m.CFG.guard)))`],
      { env: { ...process.env, MM_GAMMA_PULL: "", MM_GAMMA_SIDE: "", MM_CAP_VOL_TV: "", ...env }, encoding: "utf8", timeout: 60_000 });
    try { return JSON.parse(r.stdout.trim().split("\n").pop() ?? "") as typeof CFG.guard; } catch { return null; }
  };
  const d5 = boot({ MM_POLICY: "v5" }), d4 = boot({ MM_POLICY: "v4" }), dOff = boot({ MM_POLICY: "v5", MM_GAMMA_PULL: "off" });
  ok("v5 defaults: vol cap 0.3, gamma pull 0.6 on the adding side; v4 has none; off turns one off",
    d5?.capVolTv === 0.3 && d5.gammaPull === 0.6 && d5.gammaSide === "adding" && d4?.capVolTv === null && d4.gammaPull === null &&
    d4.gammaSide === "both" && dOff?.gammaPull === null && dOff.capVolTv === 0.3, JSON.stringify({ d5, d4, dOff }));
}

// ---- PAPER | LIVE switch (server.ts twinOf): the twin is up only when it answers as the other mode of the same bot ----
{
  const st = (mode: string, pairTrade?: boolean, halted: string | null = null) =>
    ({ ...(pairTrade !== undefined ? { pairTrade } : {}), paper: { mode, equity: 940, start: 1000, ...(mode === "live" ? { live: { halted } } : {}) } });
  const up = twinOf("paper", 8031, false, st("live", false), null, 0);
  ok("twin: a paper market maker's live twin answers → up, its PnL equity − start", up.up && up.mode === "live" && up.pnl === -60 && up.halted === null);
  ok("twin: a stopped live twin is still up, its halt passed on", twinOf("paper", 8031, false, st("live", false, "live STOPPED: …"), null, 0).halted === "live STOPPED: …");
  const wrong = twinOf("paper", 8031, false, st("paper", false), null, 0);
  ok("twin: a paper bot on the twin's port is not the twin", !wrong.up && /MM_MODE=paper, not live/.test(wrong.why ?? ""), wrong.why ?? "");
  const other = twinOf("live", 8032, true, st("paper", false), null, 0);
  ok("twin: the pair trade's twin must be a pair trade", !other.up && /market maker, not the pair trade/.test(other.why ?? ""), other.why ?? "");
  ok("twin: a bot older than pairTrade is taken as the twin", twinOf("live", 8030, false, st("paper"), null, 0).up);
  const down = twinOf("live", 8032, true, null, "nothing answers on :8032: it is stopped", 0);
  ok("twin: no answer → down, with why and the command that starts it", !down.up && down.mode === "paper" && /stopped/.test(down.why ?? "") && down.start === `pm2 start ecosystem.config.cjs --only ${app("pair")}`, down.start);
  ok("twin: a live twin starts with tools/start-live.sh", twinOf("paper", 8033, true, null, "x", 0).start === `bash tools/start-live.sh ${app("pair-live")}`);
  if (CFG.mode === "paper" && !process.env.TWIN_PORT) ok("twin: TWIN_PORT defaults to PORT + 1 for a paper bot", CFG.twinPort === CFG.port + 1, String(CFG.twinPort));
}

// ---- wallet vault (trading/vault.ts): round trip, wrong passphrase, a tampered header or tag, and the key is not in env ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-test-")), f = path.join(dir, "wallet.vault");
  const pk = "0x" + "11".repeat(32), pass = "correct horse battery staple";
  await sealVault({ POLYMARKET_PRIVATE_KEY: pk, POLYMARKET_RELAYER_API_KEY: "rk" }, pass, f);
  const raw = fs.readFileSync(f, "utf8");
  ok("vault: the file is mode 0600 and holds no plaintext key", (fs.statSync(f).mode & 0o777) === 0o600 && !raw.includes("11".repeat(32)) && !raw.includes("rk\""));
  const back = await openVault(pass, f);
  ok("vault: seal → open gives the secrets back", back.POLYMARKET_PRIVATE_KEY === pk && back.POLYMARKET_RELAYER_API_KEY === "rk");
  const fails2 = async (p: string, file: string) => { try { await openVault(p, file); return "opened"; } catch (e) { return e instanceof WrongPassphrase ? "wrong" : (e as Error).message; } };
  ok("vault: a wrong passphrase → WrongPassphrase", (await fails2("not the passphrase", f)) === "wrong");
  const j = JSON.parse(raw), t1 = path.join(dir, "n.vault"), t2 = path.join(dir, "tag.vault");
  fs.writeFileSync(t1, JSON.stringify({ ...j, kdf: { ...j.kdf, N: 2 ** 14 } }));
  ok("vault: a weakened scrypt N in the header fails like a wrong passphrase", (await fails2(pass, t1)) === "wrong");
  fs.writeFileSync(t2, JSON.stringify({ ...j, cipher: { ...j.cipher, tag: Buffer.from(j.cipher.tag, "base64").subarray(0, 12).toString("base64") } }));
  ok("vault: a truncated auth tag is refused", (await fails2(pass, t2)) === "wrong");
  let short = "";
  try { await sealVault({}, "short", path.join(dir, "s.vault")); } catch (e) { short = (e as Error).message; }
  ok("vault: a passphrase under 12 characters is refused", /at least 12/.test(short), short);
  const was = process.env.POLYMARKET_PRIVATE_KEY;
  process.env.POLYMARKET_PRIVATE_KEY = pk;
  let refused = "";
  try { await unlockVault(); } catch (e) { refused = (e as Error).message; }
  ok("vault: unlock refuses while the key is in plaintext in the environment", /still set in plaintext/.test(refused), refused);
  if (was === undefined) delete process.env.POLYMARKET_PRIVATE_KEY; else process.env.POLYMARKET_PRIVATE_KEY = was;
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- lock and stop (lock.ts, MM_LOCK_PCT): lock ≥ pct × order size → buy the short token, stop the window ----
{
  const base: LockCfg = { pct: 0.2, slip: 0.01, maxPx: 0.99, fromSec: 0, untilLeftSec: 10, pxF: null, pxMinNet: 2 };
  ok("lock: off by default (no MM_LOCK_PCT → lockCfg null, no +lock tag)",
    CFG.lock.pct != null || CFG.lock.pxF != null || (lockCfg() === null && !windowTag(1792490700).includes("+lock")));
  ok("lock: target = pct × order size, tag +lock20", lockTarget({ ...CFG, orderSize: 10, lock: base }) === 2 &&
    quoteTag("v5", { ...CFG, lock: base }).endsWith("+lock20"));
  // 10 Down bought at 40¢ (cash −$4). Up book 14 / 15¢: buy 10 Up up to 16¢, fee 0.94¢ → locks −4 − 1.69 + 10 = +$4.31
  const at = (o: Partial<LockIn>): LockIn => ({ now: 10_000, elapsed: 100, left: 200, good: true, bestBid: 0.14, bestAsk: 0.15,
    up: 0, down: 10, cash: -4, upAvg: null, downAvg: 0.4, fills: 1, free: 1000, busy: false, ...o });
  let L = new Lock(base, 2), d = L.decide(at({}));
  ok("lock: 10 Down at 40¢, Up ask 15¢ → buy 10 Up up to 16¢ spending $1.50, window stopped",
    d.take?.token === "UP" && d.take.size === 10 && d.take.price === 0.16 && d.take.usd === 1.5 && d.take.kind === "lock" && /\+\$4\.31/.test(d.stop ?? ""), `${JSON.stringify(d.take)} ${d.stop}`);
  d = L.decide(at({ now: 10_100 }));
  ok("lock: retried no sooner than 300 ms; the window stays stopped", d.take == null && d.stop != null);
  d = new Lock(base, 2).decide(at({ bestBid: 0.5, bestAsk: 0.51 }));
  ok("lock: Up ask 51¢ locks only +$0.63 → no take, still market making", d.take == null && d.stop == null, JSON.stringify(d.steps));
  d = new Lock(base, 2).decide(at({ bestBid: 0.04, bestAsk: 0.05 }));
  ok("lock: Up ask 5¢: 10 sh cost $0.50 < $1 minimum → buys 20 (spends $1.00)", d.take?.size === 20 && d.take.usd === 1, JSON.stringify(d.take));
  {
    const Lb = new Lock(base, 2); Lb.decide(at({ bestBid: 0.04, bestAsk: 0.05 }));
    // filled 20 Up at 5¢: 10 pairs merged, 10 Up over; a Down buy would lock more than the cash, but the Up is kept
    const e1 = Lb.decide(at({ now: 20_000, up: 10, down: 0, cash: 1.5, bestBid: 0.94, bestAsk: 0.95 }));
    ok("lock: the Up the $1 minimum over-bought is never bought back as Down", e1.take == null && e1.stop != null, JSON.stringify(e1.steps));
    const e2 = new Lock(base, 2).decide(at({ up: 10, down: 0, cash: 2.5, bestBid: 0.5, bestAsk: 0.51 }));
    ok("lock: cash +$2.50 with 10 Up held (≥ $2 if Up loses) → stops without a take", e2.take == null && e2.stop != null, JSON.stringify(e2.steps));
  }
  ok("lock: 5 s left (MM_LOCK_UNTIL_LEFT_SEC 10) → none", new Lock(base, 2).decide(at({ left: 5 })).take == null);
  ok("lock: a take in flight → none", new Lock(base, 2).decide(at({ busy: true })).take == null);
  ok("lock: no good book → none", new Lock(base, 2).decide(at({ good: false })).take == null);
  ok("lock: not enough free USDC → none", new Lock(base, 2).decide(at({ free: 1 })).take == null);
  d = new Lock(base, 2).decide(at({ up: 0, down: 0, cash: 2.4 }));
  ok("lock: flat with +$2.40 → stops without a take", d.take == null && d.stop != null);
  d = new Lock(base, 2).decide(at({ up: 0, down: 0, cash: 1.2 }));
  ok("lock: flat with +$1.20 → keeps market making", d.take == null && d.stop == null);
  d = new Lock(base, 2).decide(at({ up: 10, down: 0, cash: -4, bestBid: 0.85, bestAsk: 0.86 }));
  ok("lock: long 10 Up at 40¢, Down ask 15¢ → buys Down", d.take?.token === "DOWN" && d.take.price === 0.16, JSON.stringify(d.take));

  // price lock (MM_LOCK_PX_F): the short ask ≤ (1 − p)(1 − f) while |net| ≥ MM_LOCK_PX_MIN_NET order sizes
  const px: LockCfg = { ...base, pct: null, pxF: 0.3, pxMinNet: 2 }, both: LockCfg = { ...base, pxF: 0.3 };
  ok("price lock: on alone (lockCfg), tags +lpx30n2 / +lock20+lpx30n2, min net = 2 × order size",
    lockCfg({ ...CFG, lock: px }) === px && quoteTag("v5", { ...CFG, lock: px }).endsWith("+lpx30n2") && !quoteTag("v5", { ...CFG, lock: px }).includes("+lock") &&
    quoteTag("v5", { ...CFG, lock: both }).endsWith("+lock20+lpx30n2") && lockMinNet({ ...CFG, orderSize: 10, lock: px }) === 20 &&
    lockCfg({ ...CFG, lock: { ...px, pxF: null } }) === null);
  // long 20 Up at 50¢ avg (cash −$10): the trigger is a Down ask ≤ 50¢ × 0.7 = 35¢ (Up bid ≥ 65¢)
  const lg = (o: Partial<LockIn>) => at({ up: 20, down: 0, cash: -10, upAvg: 0.5, downAvg: null, bestBid: 0.65, bestAsk: 0.66, ...o });
  d = new Lock(px, 0, 20).decide(lg({}));
  ok("price lock: 20 Up at 50¢, Down ask 35¢ → buys 20 Down up to 36¢, window stopped (locks +$2.48, no $ rule)",
    d.take?.token === "DOWN" && d.take.size === 20 && d.take.price === 0.36 && d.take.kind === "lock" && /lock \(price\)/.test(d.stop ?? ""), `${JSON.stringify(d.take)} ${d.stop}`);
  d = new Lock(px, 0, 20).decide(lg({ bestBid: 0.64, bestAsk: 0.65 }));
  ok("price lock: Down ask 36¢ > 35¢ → none, still market making", d.take == null && d.stop == null, JSON.stringify(d.steps));
  d = new Lock(px, 0, 20).decide(lg({ up: 10, cash: -5 }));
  ok("price lock: only 10 Up held (min 20) → none", d.take == null && d.stop == null, JSON.stringify(d.steps));
  d = new Lock(px, 0, 20).decide(lg({ up: 0, cash: 5, upAvg: null }));
  ok("price lock alone: flat with +$5 → keeps market making (no $ target)", d.take == null && d.stop == null);
  d = new Lock(px, 0, 20).decide(lg({ cash: 1, bestBid: 0.5, bestAsk: 0.51 }));
  ok("price lock alone: cash ≥ $0 with Up held → keeps market making (the $ rule's free-option stop is off)", d.take == null && d.stop == null, JSON.stringify(d.steps));
  {
    const Lp = new Lock(px, 0, 20); Lp.decide(lg({}));
    // the FAK filled 15 of 20: 5 Up left, under the minimum; the retry still closes it
    const r = Lp.decide(lg({ now: 10_400, up: 5, cash: -2.5 }));
    ok("price lock: after firing, the 5 Up left (under min net) are still bought out", r.take?.token === "DOWN" && r.take.size === 5, JSON.stringify(r.take));
  }
  d = new Lock(both, 2, 20).decide(at({}));
  ok("$ + price lock: the $ rule still fires on its own (10 Down, Up ask 15¢ locks +$4.31)", d.take?.token === "UP" && /\+\$4\.31 locked/.test(d.stop ?? ""), `${d.stop}`);
  d = new Lock(both, 2, 20).decide(lg({ cash: -12 }));
  ok("$ + price lock: price hit while $ locked < $2 → fires as a price lock", d.take?.token === "DOWN" && /lock \(price\)/.test(d.stop ?? ""), `${d.stop} ${JSON.stringify(d.steps)}`);
}

// ---- follow trade (follow.ts): another bot's maker fills → a taker buy of the same token, on the real trader ----
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mm-selftest-"));
  const pm = { onPrint: () => {} } as unknown as ConstructorParameters<typeof Trader>[0];
  const store = { entries: () => [], get: () => undefined } as unknown as ConstructorParameters<typeof Trader>[1];
  const logs: string[] = [];
  const tr = new Trader(pm, store, () => {}, tmp);
  const W = 1_800_000_000, T0 = (W + 60) * 1000;
  const book = (bb: number, ba: number): BookView => ({ ready: true, bids: [[bb, 500]], asks: [[ba, 500]], bestBid: bb, bestAsk: ba, ageMs: 0, last: null });
  let B = book(0.40, 0.41);
  const cx = (): FollowCtx => ({ win: W, endTs: W + 300, up: "U", down: "D", book: B, tick: 0.01 });
  const fc = { ...CFG.follow, on: true, kinds: { nocancel: true, race: true }, size: 0, maxSh: 20, maxWinSh: null as number | null, slip: 0.02, maxPx: 0.95, maxAgeMs: 1000, fromSec: 0, untilLeftSec: 10 };
  const ft = new FollowTrader(tr, fc, cx, (m) => logs.push(m));
  const msg = (o: Partial<FillMsg> = {}): FillMsg => ({ type: "fill", signal: "fills", seq: 1, t: T0, tFill: T0 - 5, bot: "paper", name: "v6", kind: "race",
    win: W, slug: "s", up: "U", down: "D", dir: "down", token: "D", price: 0.58, upPrice: 0.42, size: 6.17, oid: 77, restMs: 900, queue0: 40,
    book: { bid: 0.40, ask: 0.41, mid: 0.405 }, fv: 0.41, elapsed: 60, left: 240, ...o });
  const places = () => tr.hello(W).events.filter((e) => e.type === "place");
  const r1 = ft.onRaw(JSON.stringify(msg()), T0 + 3);
  const p1 = places()[0];
  ok("follow: a race fill of 6.17 Down → a fill-and-kill 6.17 Down ≤ 62¢ (its ask 1 − 40¢ + 2¢), $3.70",
    r1?.act === "sent" && p1?.token === "DOWN" && p1.tokenPrice === 0.62 && p1.size === 6.17 && r1.usd === 3.7 && tr.takeInFlight(W) === "DOWN", JSON.stringify({ r1, p1 }));
  ok("follow: the same message again → nothing", ft.onRaw(JSON.stringify(msg()), T0 + 10) === null && places().length === 1);
  const rp = ft.onRaw(JSON.stringify(msg({ seq: 2, size: 1.11 })), T0 + 12);
  ok("follow: another piece of the same order at the same fill time (its own seq) → its own take", rp?.act === "sent" && places().length === 2, JSON.stringify(rp));
  ok("follow: a hello with its recent fills is never traded",
    ft.onRaw(JSON.stringify({ type: "hello", cfg: { nocancel: true, race: true }, recent: [msg({ oid: 78 }), msg({ oid: 79 })] }), T0 + 20) === null && places().length === 2);
  ok("follow: heartbeats and junk are ignored", ft.onRaw(JSON.stringify({ type: "hb" }), T0) === null && ft.onRaw("{not json", T0) === null);
  B = book(0.40, 0.41);
  tr.pre({ now: T0 + 5000, win: W, endTs: W + 300, up: "U", down: "D", book: B, fv: null, mid: null });
  const fl = ft.records(W)[0]?.fill;  // the first take's
  // the 1.11 sh piece spends the $1 minimum: 1.67 sh at 60¢, so 6.17 + 1.67 Down
  ok("follow: the takes fill at the Down ask 60¢ and are held (no other order)", Math.abs(tr.position(W).down - 7.83) < 0.02 && fl?.qty > 6 && Math.abs((fl?.px ?? 0) - 0.60) < 1e-9 &&
    tr.position(W).up === 0, JSON.stringify({ fl, pos: tr.position(W) }));
  const r2 = ft.handle(msg({ oid: 80, kind: "nocancel", dir: "up", token: "U", price: 0.40, size: 10 }), T0 + 6000);
  ok("follow: a stale no-cancel fill (sent 6 s ago) → skipped and kept in the record", r2?.act === "skip" && /stale/.test(r2.why) && ft.records(W).length === 3, JSON.stringify(r2));
  const at = (o: Partial<FillMsg>, ctx: FollowCtx | null = cx(), cfg = fc, bought = 0) => followDecide(msg({ t: T0, ...o }), ctx, T0 + 5, bought, cfg);
  const sk = (d: ReturnType<typeof followDecide>) => ("skip" in d ? d.skip : "");
  ok("follow: kind not in FOLLOW_KINDS → skip", /not followed/.test(sk(at({ kind: "nocancel" }, cx(), { ...fc, kinds: { nocancel: false, race: true } }))));
  ok("follow: another window → skip", /not ours/.test(sk(at({ win: W - 300 }))));
  ok("follow: a token not of this window → skip", /not this window/.test(sk(at({ token: "X" }))) && /not this window/.test(sk(at({ dir: "up", token: "D" }))));
  ok("follow: no market yet → skip", /no market/.test(sk(at({}, null))));
  ok("follow: the last 10 s → skip", /closing/.test(sk(at({}, { ...cx(), endTs: W + 65 }))));
  ok("follow: no fresh book → skip", /no fresh book/.test(sk(at({}, { ...cx(), book: { ...B, ageMs: 9000 } }))));
  ok("follow: the token's ask over FOLLOW_MAX_PX → skip", /outside/.test(sk(at({ dir: "up", token: "U" }, { ...cx(), book: book(0.96, 0.97) }))));
  const cheap = at({ dir: "up", token: "U", size: 10 }, { ...cx(), book: book(0.07, 0.08) });
  ok("follow: 10 Up at an 8¢ ask is $0.80 → spends the $1 minimum", "take" in cheap && cheap.take.size === 10 && cheap.take.usd === 1 && cheap.take.limit === 0.1, JSON.stringify(cheap));
  const big = at({ size: 35 });
  ok("follow: a 35 sh fill → 20 sh (FOLLOW_MAX_SH)", "take" in big && big.take.size === 20);
  const fixed = at({ size: 3 }, cx(), { ...fc, size: 5 });
  ok("follow: FOLLOW_SIZE=5 → 5 sh whatever the fill's size", "take" in fixed && fixed.take.size === 5);
  const capped = at({ size: 10 }, cx(), { ...fc, maxWinSh: 25 }, 18);
  ok("follow: FOLLOW_MAX_WIN_SH 25 with 18 bought → 7 sh; with 25 bought → skip", "take" in capped && capped.take.size === 7 &&
    /bought/.test(sk(at({ size: 10 }, cx(), { ...fc, maxWinSh: 25 }, 25))));
  ok("follow: tag \"follow-ncrace\" (no market making), \"follow-race\" with race only",
    windowTag(W, { ...CFG, follow: fc }).startsWith("follow-ncrace") && windowTag(W, { ...CFG, follow: { ...fc, kinds: { nocancel: false, race: true } } }).startsWith("follow-race") &&
    !windowTag(W, { ...CFG, follow: { ...fc, on: true } }).includes("+ev"));
  ok("follow: off by default (only the challenger's ecosystem env turns it on)", process.env.FOLLOW_TRADE ? true : CFG.follow.on === false);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// closing only from 120 s (MM_V4_REDUCE_ONLY_LEFT_SEC, 2026-11-12): v4/v5 quote only the side that reduces |net| from that
// many s before the close, sized to flatten; off = v4/v5 never reduce-only (MM_REDUCE_ONLY_LEFT_SEC is v1's)
{
  const on = quoteCfg("v5", { ...CFG, v4ReduceOnlyLeftSec: 180, v4QuoteUntilLeftSec: 150 }), offc = quoteCfg("v5", { ...CFG, v4ReduceOnlyLeftSec: null });
  ok("closing only: v5 takes MM_V4_REDUCE_ONLY_LEFT_SEC; off → 0 (not v1's MM_REDUCE_ONLY_LEFT_SEC)", on.reduceOnlyLeftSec === 180 && offc.reduceOnlyLeftSec === 0);
  const base: QuoteIn = { center: 0.5, centerSrc: "test", move2s: 0, elapsed: 100, left: 200, tick: 0.01, minSize: 5, bookReady: true,
    bestBid: 0.49, bestAsk: 0.51, net: 0, fv: null, mid: null };
  const q = (x: Partial<QuoteIn>, cfg = on) => makeQuote({ ...base, ...x }, cfg);
  const early = q({ left: 181, elapsed: 119, net: 7 });
  ok("closing only: before 120 s both sides quote", early.bid != null && early.ask != null, JSON.stringify([early.bid, early.ask]));
  const long = q({ left: 179, elapsed: 121, net: 7 }), short = q({ left: 170, elapsed: 130, net: -8 }), flat = q({ left: 170, elapsed: 130, net: 0 });
  ok("closing only: long 7 Up at 121 s → Down bid only, 7 sh", long.bid === null && long.ask != null && long.askSize === 7, JSON.stringify([long.bid, long.ask, long.askSize]));
  ok("closing only: short 8 Up at 130 s → Up bid only, 8 sh", short.ask === null && short.bid != null && short.bidSize === 8, JSON.stringify([short.bid, short.ask, short.bidSize]));
  ok("closing only: flat → nothing quoted", flat.bid === null && flat.ask === null);
  ok("closing only: under the 5 sh minimum → nothing (no flip, no add)", (() => { const t = q({ left: 170, elapsed: 130, net: 3 }); return t.bid === null && t.ask === null; })());
  ok("closing only: off → the adding side still quotes at 130 s", q({ left: 170, elapsed: 130, net: 7 }, offc).bid != null);
  ok("closing only: tag +ro180, none when off", quoteTag("v5", { ...CFG, v4ReduceOnlyLeftSec: 180 }).endsWith("+ro180") &&
    (CFG.v4ReduceOnlyLeftSec != null || !quoteTag("v5", CFG).includes("+ro")));
}

// the live dashboard's OWN | BASE | CHALLENGER switch (profile.ts, 2026-11-13): the knobs of eth5m-mm-bot or
// eth5m-mm-challenger (ecosystem env, then .env) into CFG at the next window, saved in DATA_DIR/profile.json
{
  const pick = () => ({ raceShare: CFG.raceShare, raceInflight: CFG.raceInflight, joinMaxSh: CFG.joinMaxSh, joinRel: CFG.joinRel, joinRefMs: CFG.joinRefMs,
    decideEvents: CFG.decideEvents, decideFv: CFG.decideFv, q: CFG.v4QuoteUntilLeftSec, ro: CFG.v4ReduceOnlyLeftSec, lock: { ...CFG.lock }, tag: CFG.tagName,
    kr: CFG.flowFvScaleRise, kf: CFG.flowFvScaleFall });
  const boot = pick();
  reloadSwitchKnobs();
  ok("switch: reloading the boot env leaves CFG as it was (same parsers and defaults)", JSON.stringify(pick()) === JSON.stringify(boot), JSON.stringify(pick()));
  const eco = createRequire(import.meta.url)(path.join(ROOT, "ecosystem.config.cjs")) as { apps: { name: string; env?: Record<string, string> }[] };
  const envOf = (n: string) => eco.apps.find((a) => a.name === n)?.env ?? {};
  const kb = knobsOf("base"), kc = knobsOf("challenger");
  ok("switch: base / challenger read their apps' ecosystem env (MM_RACE_INFLIGHT, MM_JOIN_MAX_REL)",
    kb.MM_RACE_INFLIGHT === (envOf(app("mm-bot")).MM_RACE_INFLIGHT ?? kb.MM_RACE_INFLIGHT) && kc.MM_RACE_INFLIGHT === (envOf(app("mm-challenger")).MM_RACE_INFLIGHT ?? kc.MM_RACE_INFLIGHT) &&
    kc.MM_JOIN_MAX_REL === (envOf(app("mm-challenger")).MM_JOIN_MAX_REL ?? null), JSON.stringify({ kb, kc }));
  const prevMode = CFG.mode, prevDir = CFG.dataDir, prevEnv = Object.fromEntries(SWITCH_KEYS.map((k) => [k, process.env[k]]));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmprof-"));
  const silent = () => { /* */ };
  try {
    ok("switch: refused outside live", !requestProfile("challenger", silent).ok);
    (CFG as { mode: string }).mode = "live"; CFG.dataDir = tmp;
    ok("switch: an unknown profile is refused", !requestProfile("nope", silent).ok);
    const r = requestProfile("challenger", silent);
    ok("switch: challenger requested → pending, CFG unchanged until the window opens", r.ok && profileStatus().pending?.name === "challenger" && JSON.stringify(pick()) === JSON.stringify(boot));
    ok("switch: the choice is saved", JSON.parse(fs.readFileSync(path.join(tmp, "profile.json"), "utf8")).profile === "challenger");
    ok("switch: applied at the window's open", applyPending(1_800_000_000, silent) && profileStatus().active === "challenger" && profileStatus().pending === null);
    ok("switch: CFG now has the challenger's knobs, MM_TAG gets -chal",
      SWITCH_KEYS.every((k) => (process.env[k] ?? null) === (kc[k] ?? null)) && CFG.raceInflight === (kc.MM_RACE_INFLIGHT === "on") &&
      CFG.joinRel === (kc.MM_JOIN_MAX_REL == null || kc.MM_JOIN_MAX_REL === "off" ? null : Number(kc.MM_JOIN_MAX_REL)) &&
      (boot.tag ? CFG.tagName === boot.tag + "-chal" : CFG.tagName === ""), JSON.stringify(pick()));
    ok("switch: nothing pending → nothing applied", !applyPending(1_800_000_300, silent));
    ok("switch: back to own restores the boot knobs", requestProfile("own", silent).ok && applyPending(1_800_000_600, silent) && JSON.stringify(pick()) === JSON.stringify(boot), JSON.stringify(pick()));
    const before = JSON.stringify(pick());
    process.env.MM_RACE_SHARE = "0.9"; process.env.MM_DECIDE_EVENTS = "x"; let threw = false;
    try { reloadSwitchKnobs(); } catch { threw = true; }
    ok("switch: a bad value throws and sets nothing (all parsed before any is set)", threw && JSON.stringify(pick()) === before);
  } finally {
    for (const k of SWITCH_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
    reloadSwitchKnobs(); (CFG as { mode: string }).mode = prevMode; CFG.dataDir = prevDir; CFG.tagName = boot.tag;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// the dashboard's order size switch (10 | 20 | 40, cap 2×, from the next window), STOP / START and the MM_SESSIONS
// schedule (control.ts, 2026-11-17)
{
  const ps = parseSessions("0-3=20,13-16=20,4-8=stop,*=10")!;
  const at = (h: number) => ps.byHour[h];
  ok("sessions: 0-3 and 13-16 → 20/40, 4-8 → stop, the rest → 10/20 (both ends included)",
    at(0)?.size === 20 && at(3)?.cap === 40 && at(4)?.stop === true && at(8)?.stop === true && at(9)?.size === 10 && at(12)?.cap === 20 && at(13)?.size === 20 && at(16)?.size === 20 && at(17)?.size === 10 && at(23)?.size === 10);
  ok("sessions: off / empty → no schedule", parseSessions("off") === null && parseSessions("") === null && parseSessions(undefined) === null);
  const wrap = parseSessions("22-2=stop, 7=20/30")!;
  ok("sessions: a range wraps midnight; size/cap; no * leaves the other hours unset",
    wrap.byHour[23]?.stop === true && wrap.byHour[0]?.stop === true && wrap.byHour[2]?.stop === true && !wrap.byHour[3] && wrap.byHour[7]?.cap === 30 && !wrap.byHour[21]);
  const bad = (x: string) => { try { parseSessions(x); return false; } catch { return true; } };
  ok("sessions: an hour in two ranges, hour 24, size 0, a cap under the size, junk are refused",
    bad("0-5=20,5-8=stop") && bad("20-24=10") && bad("1=0") && bad("1=20/10") && bad("1=big") && bad("*=10,*=20"));

  const prev = { size: CFG.orderSize, cap: CFG.maxPosition, dir: CFG.dataDir, spec: process.env.MM_SESSIONS, name: process.env.name };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmctl-"));
  const silent = () => { /* */ };
  const D = 1_800_000_000 - (1_800_000_000 % 86_400), H = (h: number, m = 0) => D + h * 3600 + m * 60;
  try {
    CFG.dataDir = tmp; CFG.orderSize = 40; CFG.maxPosition = 80; delete process.env.name; delete process.env.MM_SESSIONS;
    // no schedule: the panel's size is the base, saved
    applyWindow(H(10), silent);
    ok("size: 15 is refused", !requestSize(15, silent).ok);
    ok("size: 20 requested → pending, CFG unchanged until the window opens",
      requestSize(20, silent).ok && controlStatus().pending?.size === 20 && controlStatus().pending?.cap === 40 && CFG.orderSize === 40 && CFG.maxPosition === 80);
    ok("size: applied at the window's open, cap 2× the size", applyWindow(H(10, 5), silent).changed && CFG.orderSize === 20 && CFG.maxPosition === 40 && controlStatus().pending === null);
    ok("size: the choice is saved", JSON.parse(fs.readFileSync(path.join(tmp, "control.json"), "utf8")).size === 20);
    ok("size: nothing pending → nothing changes", !applyWindow(H(10, 10), silent).changed);
    ok("size: the current size again clears a pending one", requestSize(40, silent).ok && requestSize(20, silent).ok && controlStatus().pending === null);
    CFG.orderSize = 40; CFG.maxPosition = 80;
    bootControl(silent);
    ok("size: a restart applies the saved size", CFG.orderSize === 20 && CFG.maxPosition === 40);

    // the schedule, read again at every window
    process.env.MM_SESSIONS = "0-3=20,13-16=20,4-8=stop,*=10";
    let r = applyWindow(H(12, 55), silent);
    ok("schedule: 12:55 → 10/20", r.changed && CFG.orderSize === 10 && CFG.maxPosition === 20 && stopReason() === null && controlStatus().session?.label === "*");
    r = applyWindow(H(13), silent);
    ok("schedule: 13:00 → 20/40", r.changed && CFG.orderSize === 20 && CFG.maxPosition === 40 && controlStatus().session?.label === "13-16");
    requestSize(40, silent); applyWindow(H(13, 5), silent);
    ok("schedule: the panel's 40 overrides the session", CFG.orderSize === 40 && CFG.maxPosition === 80 && controlStatus().session?.sizeOver?.size === 40);
    applyWindow(H(16, 55), silent);
    ok("schedule: ...through the session's last hour", CFG.orderSize === 40);
    applyWindow(H(17), silent);
    ok("schedule: ...and ends with it: 17:00 → 10/20", CFG.orderSize === 10 && CFG.maxPosition === 20 && controlStatus().session?.sizeOver === null);
    ok("schedule: the base size is not the override's", controlStatus().base.size === 20);
    r = applyWindow(H(4), silent);
    ok("schedule: 04:00 → stopped (stop = true at the session's first window)", r.stop && /scheduled stop: session 4-8/.test(stopReason() ?? ""), stopReason() ?? "");
    ok("schedule: ...a later window of it is no new stop", !applyWindow(H(4, 5), silent).stop && stopReason() != null);
    setStopped(false, silent);
    ok("schedule: START trades through the stopped session", stopReason() === null && controlStatus().session?.startOver === true);
    applyWindow(H(8, 55), silent);
    ok("schedule: ...until it ends", stopReason() === null);
    applyWindow(H(9), silent);
    ok("schedule: 09:00 → 10/20, trading", stopReason() === null && CFG.orderSize === 10);
    setStopped(true, silent);
    applyWindow(H(13), silent);
    ok("schedule: the dashboard's STOP holds into a trading session", stopReason()?.startsWith("STOPPED from the dashboard") === true);
    setStopped(false, silent);
    ok("schedule: START lifts it", stopReason() === null && CFG.orderSize === 20);
    applyWindow(H(4, 0) + 86_400, silent);
    ok("schedule: the next day's 04:00 stops again (START was for that session only)", stopReason() != null);
    process.env.MM_SESSIONS = "4-8=stop,1=99999";
    applyWindow(H(4, 5) + 86_400, silent);
    ok("schedule: a bad edit keeps the last good schedule", controlStatus().sessions?.spec === "0-3=20,13-16=20,4-8=stop,*=10" && /1=99999/.test(controlStatus().sessionError ?? ""));
    process.env.MM_SESSIONS = "off";
    applyWindow(H(4, 10) + 86_400, silent);
    ok("schedule: off → the base size, trading", controlStatus().sessions === null && stopReason() === null && CFG.orderSize === 20);

    // STOP: no order goes out (quotes or takes), the working ones are cancelled; START resumes
    const pm = { onPrint: () => {} } as unknown as ConstructorParameters<typeof Trader>[0];
    const store = { entries: () => [], get: () => undefined } as unknown as ConstructorParameters<typeof Trader>[1];
    const tr = new Trader(pm, store, () => {}, tmp);
    const B: BookView = { ready: true, bids: [[0.5, 300]], asks: [[0.52, 90]], bestBid: 0.5, bestAsk: 0.52, ageMs: 0, last: null };
    const at = (now: number) => ({ now, win: 1000, endTs: 1300, up: "U", down: "D", book: B, fv: 0.51, mid: 0.51 });
    const q: Quote = { policy: null, bid: 0.49, ask: 0.53, bidSize: 10, askSize: 10, center: 0.51, skew: 0, reservation: 0.51, why: "", off: { bid: null, ask: null }, steps: [] };
    tr.pre(at(0)); tr.post(1000, q, 0, 5);
    ok("stop: quoting before the stop", tr.status().working === 2, String(tr.status().working));
    setStopped(true, silent); tr.stopOrders(10, stopReason()!);
    tr.pre(at(300)); tr.post(1000, q, 300, 5);
    ok("stop: the working orders are cancelled and none goes out", tr.status().working === 0 && tr.take(1000, "UP", 0.52, 10, "t", 300) === null, String(tr.status().working));
    ok("stop: saved, so a restart boots stopped", JSON.parse(fs.readFileSync(path.join(tmp, "control.json"), "utf8")).stopped === true);
    setStopped(false, silent);
    tr.pre(at(600)); tr.post(1000, q, 600, 5);
    ok("start: quoting resumes", stopReason() === null && tr.status().working === 2, String(tr.status().working));
  } finally {
    setStopped(false, silent);
    if (prev.spec === undefined) delete process.env.MM_SESSIONS; else process.env.MM_SESSIONS = prev.spec;
    if (prev.name !== undefined) process.env.name = prev.name;
    CFG.orderSize = prev.size; CFG.maxPosition = prev.cap; CFG.dataDir = prev.dir;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- market regime refit (regime.ts, MM_REGIME): trailing spread / vol → CALM | BUSY → that regime's cap and size ----
{
  const cols = ["el", "bin", "bb", "ba"];
  // 300 s at 100 ms: spread 1¢ (calm) or 1.5¢ (busy) to 180 s, then 5¢ (after the quote stop: not counted); BTC ±1 bp a second
  const mk = (spr: number) => Array.from({ length: 3000 }, (_, i) => {
    const el = i / 10, s = Math.floor(el);
    return [el, 60000 * Math.exp((s % 2 ? 1 : 0) * 1e-4), 0.5 - (el <= 180 ? spr : 0.05) / 2, 0.5 + (el <= 180 ? spr : 0.05) / 2];
  });
  const calmW = winStats(1000, mk(0.01), cols), busyW = winStats(1300, mk(0.015), cols);
  ok("regime: window spread = mean over its first 180 s", Math.abs(calmW.spr! - 0.01) < 1e-9 && Math.abs(busyW.spr! - 0.015) < 1e-9, `${calmW.spr} ${busyW.spr}`);
  ok("regime: window vol = RMS of 1 s log returns in bp", Math.abs(calmW.vol! - 1) < 0.01, `${calmW.vol}`);
  ok("regime: off by default", CFG.regime.on === false && regimeCfg() === null && !windowTag(1_800_000_000).includes("+rg"));
  ok("regime: +rg in the tag when on", windowTag(1_800_000_000, { ...CFG, regime: { ...CFG.regime, on: true } }).includes("+rg"));
  const rc = { windows: 6, minWindows: 3, busySpr: 0.0116, busyVol: null, calm: { cap: 20, size: null }, busy: { cap: null, size: 25 } };
  const R = new Regime(rc, { cap: 40, size: 20 }), T = 1_800_000_000;
  const at = (k: number, spr: number) => R.push({ startTs: T - k * 300, spr, vol: 0.5 });
  at(1, 0.010); at(2, 0.010);
  const u = R.decide(T);
  ok("regime: under MM_REGIME_MIN_WINDOWS measured → UNKNOWN on the boot cap and size", u.name === "unknown" && u.cap === 40 && u.size === 20 && u.n === 2);
  at(3, 0.011);
  const c = R.decide(T);
  ok("regime: trailing spread under the threshold → CALM: its cap, the base size where unset", c.name === "calm" && c.cap === 20 && c.size === 20 && c.n === 3);
  at(1, 0.016); at(2, 0.016);   // a repeat of a window replaces it
  const b = R.decide(T);
  ok("regime: trailing spread at/over the threshold → BUSY: the base cap where unset, its size", b.name === "busy" && b.cap === 40 && b.size === 25 && b.n === 3, JSON.stringify(b));
  ok("regime: only windows that closed in the lookback count", R.decide(T + 7 * 300).name === "unknown" && R.decide(T - 300).n === 2);
  const V = new Regime({ ...rc, busySpr: null, busyVol: 0.7 }, { cap: 40, size: 20 });
  for (let k = 1; k <= 3; k++) V.push({ startTs: T - k * 300, spr: 0.02, vol: k === 1 ? 1.3 : 0.6 });
  ok("regime: vol trigger alone (spread off): mean vol 0.83 ≥ 0.7 → BUSY", V.decide(T).name === "busy");
}

// ---- hour-of-day regimes (hourRegime.ts, MM_HOUR_REGIME): the window's opening UTC hour → its regime's knobs ----
{
  const all = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const tbl = { version: 1 as const, regimes: [
    { name: "A", hours: [...all(0, 3), ...all(22, 23)], knobs: {} },
    { name: "B", hours: all(4, 8), knobs: { MM_MAX_POSITION: "80", MM_ORDER_SIZE: "5", MM_RACE_SHARE: "off" } },
    { name: "C", hours: all(9, 21), knobs: { MM_HALF_SPREAD: "0.01", MM_V4_FROM_SEC: "300" } },
  ] };
  const bad = (t: unknown) => { try { parseHourTable(t); return false; } catch { return true; } };
  ok("hour regime: a full table parses", !bad(tbl));
  ok("hour regime: an hour in no regime is refused", bad({ ...tbl, regimes: [tbl.regimes[0], tbl.regimes[1]] }));
  ok("hour regime: an hour in two regimes is refused", bad({ ...tbl, regimes: [{ ...tbl.regimes[0], hours: [...tbl.regimes[0].hours, 5] }, tbl.regimes[1], tbl.regimes[2]] }));
  ok("hour regime: a knob outside the list is refused (no loss limit, no wallet)", bad({ ...tbl, regimes: [{ ...tbl.regimes[0], knobs: { LIVE_MAX_LOSS: "100" } }, tbl.regimes[1], tbl.regimes[2]] }));
  ok("hour regime: a bad value is refused", bad({ ...tbl, regimes: [{ ...tbl.regimes[0], knobs: { MM_ORDER_SIZE: "-1" } }, tbl.regimes[1], tbl.regimes[2]] }));
  ok("hour regime: more than 3 regimes are refused", bad({ ...tbl, regimes: [...tbl.regimes, { name: "D", hours: [], knobs: {} }] }));
  ok("hour regime: off by default, no +hr", CFG.hourRegime.mode === "off" && !windowTag(1_800_000_000).includes("+hr"));
  ok("hour regime: on → +hr in the tag, and MM_REGIME's +rg is gone", (() => {
    const t = windowTag(1_800_000_000, { ...CFG, regime: { ...CFG.regime, on: true }, hourRegime: { ...CFG.hourRegime, mode: "on" } });
    return t.includes("+hr") && !t.includes("+rg");
  })());
  const c = { ...CFG, maxPosition: 20, orderSize: 10, halfSpread: 0.005, raceShare: 0.4, v4FromSec: 15 } as typeof CFG;
  const H = new HourRegime(parseHourTable(tbl), "on", { capMax: 40, sizeMax: 20 }, c);
  const at = (h: number) => Date.UTC(2026, 10, 17, h, 5) / 1000;
  const a = H.decide(at(1));
  ok("hour regime: 01:05 UTC → A, no knobs, base config", a.name === "A" && a.hour === 1 && c.maxPosition === 20 && a.applied);
  H.restore();
  const b = H.decide(at(6));
  ok("hour regime: 06:05 UTC → B: its knobs set, the cap clamped to MM_HOUR_REGIME_CAP_MAX", b.name === "B" && c.maxPosition === 40 && c.orderSize === 5 && c.raceShare === null && b.knobs.MM_MAX_POSITION === "40", JSON.stringify(b));
  H.restore();
  ok("hour regime: restore puts the base config back", c.maxPosition === 20 && c.orderSize === 10 && c.raceShare === 0.4);
  const d = H.decide(at(23));
  ok("hour regime: 23:05 UTC wraps to A (the circle)", d.name === "A");
  H.restore(); H.decide(at(12));
  ok("hour regime: C sets the spread and stops quoting (from 300 s)", c.halfSpread === 0.01 && c.v4FromSec === 300 && quoteCfg("v5", c).quoteFromSec === 300);
  H.restore();
  const c2 = { ...CFG, maxPosition: 20 } as typeof CFG;
  const S = new HourRegime(parseHourTable(tbl), "shadow", { capMax: 40, sizeMax: 20 }, c2);
  const s = S.decide(at(6));
  ok("hour regime: shadow records B's knobs and changes nothing", s.name === "B" && !s.applied && s.knobs.MM_ORDER_SIZE === "5" && c2.maxPosition === 20 && c2.orderSize === CFG.orderSize);
  const logs: string[] = [];
  const live = hourRegimeFromCfg((m) => logs.push(m), { ...CFG, mode: "live", hourRegime: { ...CFG.hourRegime, mode: "on", live: false, file: "/nonexistent.json" } } as typeof CFG);
  ok("hour regime: live 'on' without MM_HOUR_REGIME_LIVE runs shadow (a missing table: off, logged)", live === null && logs.some((l) => /refused live/.test(l)) && logs.some((l) => /shadow off/.test(l)));
  let threw = false;
  try { hourRegimeFromCfg(() => {}, { ...CFG, hourRegime: { ...CFG.hourRegime, mode: "on", file: "/nonexistent.json" } } as typeof CFG); } catch { threw = true; }
  ok("hour regime: paper 'on' with a table it can't read refuses to start", threw);
  ok("hour regime: hour blocks for the log", hourBlocks(tbl.regimes[0].hours) === "00–03, 22–23");
}

// the asset (asset.ts, the ETH port of 2026-11-18): every venue symbol, the slug and the app names from MM_ASSET (default eth)
{
  const eth = (process.env.MM_ASSET || "eth").toLowerCase() === "eth";
  ok("asset: MM_ASSET unset = ETH: eth/usd, ETHUSDT, ETH-USD", !eth || (ASSET.name === "ETH" && ASSET.chainlink === "eth/usd" && ASSET.binance === "ETHUSDT" && ASSET.coinbase === "ETH-USD"), JSON.stringify(ASSET));
  ok("asset: a window's slug is <prefix>-<start>", slugOf(1794999900) === `${ASSET.slugPrefix}-1794999900` && (!eth || slugOf(1794999900) === "eth-updown-5m-1794999900"));
  ok("asset: app names carry the asset", app("mm-bot") === `${ASSET.key}5m-mm-bot` && (!eth || app("pair-live") === "eth5m-pair-live"));
  ok("asset: the perp socket is the asset's bookTicker", PERP_URL === `wss://fstream.binance.com/ws/${ASSET.binance.toLowerCase()}@bookTicker`, PERP_URL);
  const html = assetPage("<title>{{ASSET}}5M</title>{{ASSET_LONG}} {{BINANCE}} {{COINBASE}} {{CHAINLINK}} {{APP}}-mm-live {{NOPE}}");
  ok("asset: the dashboard's placeholders filled in, an unknown one left as is",
    html === `<title>${ASSET.name}5M</title>${ASSET.long} ${ASSET.binance} ${ASSET.coinbase} ${ASSET.chainlink.toUpperCase()} ${ASSET.key}5m-mm-live {{NOPE}}`, html);
  const page = assetPage(fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8"));
  ok("asset: no placeholder left on the served page, no BTC in its visible title", !/\{\{[A-Z_]+\}\}/.test(page) && (!eth || !/BTC/.test(page.match(/<title>[^<]*<\/title>/)?.[0] ?? "")));
  // RTDS: a tick of another asset's symbol is ignored (the filter is the asset's chainlink symbol)
  const r = new RtdsFeed(() => {});
  const other = ASSET.chainlink === "btc/usd" ? "eth/usd" : "btc/usd";
  r.apply(JSON.stringify({ topic: "crypto_prices_chainlink", type: "update", payload: { symbol: other, timestamp: 1_000_000, value: 5 } }), 1);
  r.apply(JSON.stringify({ topic: "crypto_prices_chainlink", type: "update", payload: { symbol: ASSET.chainlink, timestamp: 1_000_000, value: 1800.5 } }), 2);
  ok("asset: RTDS keeps its own symbol's ticks only", r.spotLatest?.v === 1800.5, JSON.stringify(r.spotLatest));
}

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
