// TAKER (v4) — when the bot crosses the spread, and every step of the decision (the dashboard prints the steps
// under the quoter's). These are the two ways norm1e69 takes, from the 2026-10-10 study of its 8,753 BTC-5m taker
// fills (25% of its fills, 57% of its shares):
//
//   rebalance   |net| ≥ MM_V4_REBAL_NET → buy the short token at its best ask, sized to flatten (fill-and-kill at
//               the touch). Once norm1e69's inventory was more than 5% one-sided, 66–77% of its taker buys went to
//               the short side, against 50% when balanced; its windows ended a median 4.5% unpaired.
//   flow        the token about to tick up: its best bid outweighs its best ask, L1 imbalance (bid − ask)/(bid + ask)
//               ≥ MM_V4_FLOW_IMB, and that ask is thin (≤ MM_V4_FLOW_THIN shares) → lift the ask. 59% of norm1e69's
//               taker buys came at an imbalance over 0.5 (33% of all book snapshots), with a median 100 shares at the
//               ask it lifted against 450 when its own bids were filled. They marked out +0.9¢ at 2 s and settled
//               +0.33¢ a share after the fee. It followed no outside price: its takes did not lean with Binance.
//               Fair-value veto: not when the anchored FV puts the token more than MM_V4_FV_SLACK under the ask.
//               Sized to keep |net| under the rebalance threshold, so a flow take never sets off a rebalance.
//               Flow takes are MM_V4_FLOW_COOLDOWN_MS (10 s) apart. On the tracker's 408 recorded windows the signal
//               settled −0.8 to +0.05¢ a share after the fee for every threshold tried (se ~0.5¢): it is about
//               breakeven, so the thresholds (0.7, 100 sh) and the cooldown hold it to norm1e69's ~17 a window. A 2 s
//               cooldown took one every 2 s in the dry run and lost $65 a window, mostly fees.
//   gates       a good book; from MM_V4_FROM_SEC to MM_V4_TAKE_UNTIL_LEFT_SEC (60 s) before the close, where
//               norm1e69's taking stopped as the 60 s settlement average began; one take in flight at a time; asks of
//               5–95¢ only (norm1e69 never took above 95¢).
//
// A take pays 0.07·p(1−p) a share (paperExchange.takerFee). The engine pulls our bid on the other token while a
// take is out (quoter.applyTake): on the mirrored books that bid is the very ask the take lifts.
import { CFG } from "./config.js";
import type { Step, StepState } from "./quoter.js";
import { takerFee } from "./trading/paperExchange.js";
import type { Token } from "./trading/types.js";

/** norm1e69's taker fills: none above 95¢; the low end keeps a take clear of the 1¢ dust. */
const TAKE_MIN_PX = 0.05, TAKE_MAX_PX = 0.95;

export interface TakeIn {
  elapsed: number;
  left: number;
  minSize: number;
  /** A live, fresh book with a spread of at most MAX_GOOD_SPREAD. */
  good: boolean;
  /** The Up book's best bid / ask and the shares resting there. The Down ask is 1 − the Up bid, with the Up bid's size. */
  bestBid: number | null;
  bestAsk: number | null;
  bidSz: number | null;
  askSz: number | null;
  /** Net Up shares held in this window: Up − Down. */
  net: number;
  /** The quoter's centre (anchored FV, else model FV), Up terms. */
  center: number | null;
  /** USDC not locked by working orders. */
  free: number;
  /** A take is still on its way to the book. */
  busy: boolean;
  /** Since the last flow take this window was sent (null = none yet). */
  sinceFlowMs: number | null;
}

export interface TakeCfg {
  fromSec: number; untilLeftSec: number;
  flowImb: number | null; flowThin: number; fvSlack: number;
  rebalNet: number | null; flowCooldownMs: number;
  orderSize: number; maxPosition: number;
}

/** kind "excess": excess.ts's gated completion of the unpaired excess; "lock": lock.ts's lock-and-stop take. */
/** usd: the USDC the fill-and-kill BUY spends (paper and live), when not size × price: the excess take spends size × the ask
 *  it saw, so a fill at that ask buys exactly `size` and one up the book toward the limit (ask + MM_XS_SLIP) buys fewer. */
export interface Take { token: Token; price: number; size: number; kind: "rebalance" | "flow" | "excess" | "lock"; why: string; usd?: number }

export function takeCfg(cfg: typeof CFG = CFG): TakeCfg {
  return {
    fromSec: cfg.v4FromSec, untilLeftSec: cfg.v4TakeUntilLeftSec, flowImb: cfg.v4FlowImb, flowThin: cfg.v4FlowThin,
    fvSlack: cfg.v4FvSlack, rebalNet: cfg.v4RebalNet, flowCooldownMs: cfg.v4FlowCooldownMs, orderSize: cfg.orderSize, maxPosition: cfg.maxPosition,
  };
}

const c = (x: number) => (x * 100).toFixed(1) + "¢";
const c2 = (x: number) => (x * 100).toFixed(2) + "¢";
const sh = (x: number) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x).toFixed(Number.isInteger(x) ? 0 : 1);
const n0 = (x: number) => Math.abs(x).toFixed(Number.isInteger(x) ? 0 : 1);
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const fl = (v: number) => Math.max(0, Math.floor(v + 1e-9));
const tok = (t: Token) => (t === "UP" ? "Up" : "Down");
const EPS = 1e-9;

export function decideTake(x: TakeIn, cfg: TakeCfg): { take: Take | null; steps: Step[] } {
  const steps: Step[] = [];
  const add = (k: string, v: string, s: StepState = "info") => { steps.push({ k, v, s }); };
  const none = () => ({ take: null, steps });

  if (cfg.flowImb == null && cfg.rebalNet == null) { add("takes", "off (MM_V4_FLOW_IMB and MM_V4_REBAL_NET are off)", "off"); return none(); }
  if (x.elapsed < cfg.fromSec) { add("takes", `opening: takes from ${cfg.fromSec}s`, "off"); return none(); }
  if (x.left < cfg.untilLeftSec) { add("takes", `closing: none in the last ${cfg.untilLeftSec}s (the settlement average is running)`, "off"); return none(); }
  if (!x.good || x.bestBid == null || x.bestAsk == null || x.bidSz == null || x.askSz == null) { add("takes", "no good book", "off"); return none(); }
  if (x.busy) { add("takes", "a take is on its way to the book", "info"); return none(); }

  // the ask each token is bought at, and the shares there (Down's ask is the Up bid, mirrored)
  const askOf = (t: Token) => (t === "UP" ? x.bestAsk! : r4(1 - x.bestBid!));
  const depthOf = (t: Token) => (t === "UP" ? x.askSz! : x.bidSz!);
  const inRange = (p: number) => p >= TAKE_MIN_PX - EPS && p <= TAKE_MAX_PX + EPS;
  const afford = (p: number) => fl(Math.max(0, x.free) / (p + takerFee(p)));

  // ---- rebalance: the short token at its ask, sized to flatten ----
  if (cfg.rebalNet == null) add("rebalance", "off (MM_V4_REBAL_NET=off)", "info");
  else if (Math.abs(x.net) < cfg.rebalNet - EPS) add("rebalance", `net ${sh(x.net)} sh, under ±${cfg.rebalNet}`, "ok");
  else {
    const t: Token = x.net > 0 ? "DOWN" : "UP", p = askOf(t), held = `net ${sh(x.net)} sh ≥ ±${cfg.rebalNet}`;
    const size = fl(Math.min(Math.abs(x.net), afford(p)));
    if (!inRange(p)) add("rebalance", `${held}, but the ${tok(t)} ask ${c(p)} is outside ${c(TAKE_MIN_PX)}–${c(TAKE_MAX_PX)}: held`, "warn");
    else if (size < x.minSize) add("rebalance", `${held}, but the free $${x.free.toFixed(2)} buys only ${size} ${tok(t)} at ${c(p)} (min ${x.minSize})`, "warn");
    else {
      const why = `rebalance: ${held} → buy ${size} ${tok(t)} at its ask ${c(p)} (fee ${c2(takerFee(p))}/sh)`;
      add("rebalance", why, "warn");
      return { take: { token: t, price: p, size, kind: "rebalance", why }, steps };
    }
  }

  // ---- flow: lift the thin ask of the token whose best bid outweighs it ----
  if (cfg.flowImb == null) { add("flow", "off (MM_V4_FLOW_IMB=off)", "info"); return none(); }
  if (x.sinceFlowMs != null && x.sinceFlowMs < cfg.flowCooldownMs) {
    add("flow", `cooldown: last flow take ${(x.sinceFlowMs / 1000).toFixed(1)} s ago (${(cfg.flowCooldownMs / 1000).toFixed(0)} s between them)`, "info");
    return none();
  }
  const tot = x.bidSz + x.askSz, imb = tot > 0 ? (x.bidSz - x.askSz) / tot : 0;
  const book = `L1 Up bid ${n0(x.bidSz)} / ask ${n0(x.askSz)}: imbalance ${imb >= 0 ? "+" : "−"}${Math.abs(imb).toFixed(2)}`;
  const t: Token | null = imb >= cfg.flowImb - EPS ? "UP" : imb <= -cfg.flowImb + EPS ? "DOWN" : null;
  if (!t) { add("flow", `${book}, inside ±${cfg.flowImb}`, "info"); return none(); }
  const p = askOf(t), depth = depthOf(t);
  const head = `${book} → the ${tok(t)} ask ${c(p)}`;
  if (depth > cfg.flowThin + EPS) { add("flow", `${head} holds ${n0(depth)} sh, over ${cfg.flowThin}: not thin`, "info"); return none(); }
  if (!inRange(p)) { add("flow", `${head} is outside ${c(TAKE_MIN_PX)}–${c(TAKE_MAX_PX)}`, "off"); return none(); }
  if (x.center == null) { add("flow", `${head}: no fair value to check it against`, "off"); return none(); }
  const fv = t === "UP" ? x.center : 1 - x.center;
  if (fv < p - cfg.fvSlack - EPS) { add("flow", `${head}, but FV ${c(fv)} is more than ${c(cfg.fvSlack)} under it: vetoed`, "off"); return none(); }
  // |net| stays under the rebalance threshold (and inside the position cap) after the take
  const d = t === "UP" ? 1 : -1;
  const cap = cfg.rebalNet != null ? Math.min(cfg.maxPosition, cfg.rebalNet - 1) : cfg.maxPosition;
  const size = fl(Math.min(cfg.orderSize, depth, cap - d * x.net, afford(p)));
  if (size < x.minSize) { add("flow", `${head}: only ${size} sh fit (${n0(depth)} there, net ${sh(x.net)} vs ±${cap}, free $${x.free.toFixed(2)}; min ${x.minSize})`, "info"); return none(); }
  const why = `flow: ${book} ≥ ±${cfg.flowImb}, ${n0(depth)} sh at the ${tok(t)} ask ${c(p)} → take ${size} · FV ${c(fv)} (fee ${c2(takerFee(p))}/sh)`;
  add("flow", why, "ok");
  return { take: { token: t, price: p, size, kind: "flow", why }, steps };
}
