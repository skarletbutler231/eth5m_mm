// EXCESS — taker completion of the unpaired excess (2026-10-25; README "Inventory team"). The two bids pair off as Up +
// Down merges for $1; what is left is the excess |net|, held to settlement unless the maker side pairs it off later. These
// rules close it with a fill-and-kill BUY of the short token (the one we are short of), so a take only ever reduces |net|.
// They are what the inventory research team (inventory/) searches together with the maker side's cap, skew, size, guard and
// carry knobs; each trigger is off until its knob is set, and with all of them off xsCfg() is null and nothing changes.
//   edge   the short token's centre (the flow FV, Up terms mirrored) clears the limit price plus the taker fee by MM_XS_EDGE
//   jump   the Binance perp moved MM_XS_JUMP_BPS or more within MM_XS_JUMP_MS the short token's way (perp up → Up), the
//          stale-ask take of the 10-13 sniping study, here only ever toward a smaller |net|
//   late   MM_XS_LATE_SEC or less to the close: close the excess instead of carrying it
//   stop   the held token's mid MM_XS_STOP_LOSS or more under its average cost: close it
// Gates for every trigger: |net| ≥ MM_XS_NET, MM_XS_FROM_SEC after the open to MM_XS_UNTIL_LEFT_SEC before the close, a good
// book, no take in flight (v4's included), MM_XS_COOLDOWN_MS since the last excess take, the limit (ask + MM_XS_SLIP) at most
// MM_XS_MAX_PX. MM_XS_HOLD_P: late and stop keep a held favourite (its centre at or over this) for settlement; edge and jump
// are about the short token's price and ignore it. Size: |net| − MM_XS_KEEP, at most MM_XS_MAX_SH, what the free USDC buys.
// With MM_XS_FAST=on (default) the rules also run on the 10 ms decisions between frames (engine.decide); v4's takes stay on
// the frame. A take pays 0.07·p(1−p) a share; the quote pulls the held token's bid while it is out (quoter.applyTake).
// Known before these were built: v4's plain rebalance (MM_V4_REBAL_NET, no gate) lost 2.8¢ a share after the fee.
import { CFG } from "./config.js";
import type { PriceBuffer } from "./model/priceBuffer.js";
import { xsOn, type Step } from "./quoter.js";
import type { Take } from "./taker.js";
import { takerFee } from "./trading/paperExchange.js";
import type { Token } from "./trading/types.js";

export type XsCfg = (typeof CFG)["xs"];

/** The excess rules' config, or null when every trigger is off. */
export function xsCfg(cfg: typeof CFG = CFG): XsCfg | null {
  return xsOn(cfg) ? cfg.xs : null;
}

export interface XsIn {
  now: number;
  elapsed: number;
  left: number;
  /** A live, fresh book with a spread of at most MAX_GOOD_SPREAD. */
  good: boolean;
  /** The Up book's best bid / ask and the shares there. The Down ask is 1 − the Up bid, with the Up bid's size. */
  bestBid: number | null;
  bestAsk: number | null;
  bidSz: number | null;
  askSz: number | null;
  /** The Up mid on a good book, else null. */
  mid: number | null;
  /** The quote centre (Up terms). */
  centre: number | null;
  /** Net Up shares held in this window: Up − Down. */
  net: number;
  /** Average cost of the held token (Up when net > 0, Down when net < 0). */
  heldAvg: number | null;
  /** Binance perp prices as received; null when the feed is stale. */
  perp: PriceBuffer | null;
  /** USDC not locked by working orders. */
  free: number;
  /** A take is still on its way to the book. */
  busy: boolean;
  minSize: number;
}

type Rule = "edge" | "jump" | "late" | "stop";
const TAKE_MIN_PX = 0.05, EPS = 1e-9;
const c = (x: number) => (x * 100).toFixed(1) + "¢";
const c2 = (x: number) => (x * 100).toFixed(2) + "¢";
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const fl = (v: number) => Math.max(0, Math.floor(v + 1e-9));
const tok = (t: Token) => (t === "UP" ? "Up" : "Down");

/** One window's excess rules: the cooldown, and the takes each trigger sent. */
export class Excess {
  private last: number | null = null;
  /** Takes each trigger sent (the replay reports them per window). */
  readonly active: Record<Rule, number> = { edge: 0, jump: 0, late: 0, stop: 0 };

  constructor(private readonly cfg: XsCfg) {}

  decide(x: XsIn): { take: Take | null; steps: Step[] } {
    const g = this.cfg, steps: Step[] = [];
    const none = (v: string, s: Step["s"] = "info") => { steps.push({ k: "excess", v, s }); return { take: null, steps }; };
    const n = Math.abs(x.net);
    if (n < Math.max(g.minNet, x.minSize) - EPS) return none(`|net| ${n} under ${Math.max(g.minNet, x.minSize)}`, "ok");
    if (x.elapsed < g.fromSec) return none(`opening: from ${g.fromSec}s`, "off");
    if (x.left < g.untilLeftSec) return none(`closing: none in the last ${g.untilLeftSec}s`, "off");
    if (!x.good || x.bestBid == null || x.bestAsk == null) return none("no good book", "off");
    if (x.busy) return none("a take is on its way to the book");
    if (this.last != null && x.now - this.last < g.cooldownMs) return none(`cooldown: last excess take ${((x.now - this.last) / 1000).toFixed(1)} s ago`);

    // the short token, its ask (Down's is 1 − the Up bid) and the limit the take goes out at
    const t: Token = x.net > 0 ? "DOWN" : "UP";
    const ask = t === "UP" ? x.bestAsk : r4(1 - x.bestBid);
    const lim = r4(Math.min(g.maxPx, ask + g.slip));
    if (ask > g.maxPx + EPS || ask < TAKE_MIN_PX - EPS) return none(`the ${tok(t)} ask ${c(ask)} is outside ${c(TAKE_MIN_PX)}–${c(g.maxPx)}`, "off");
    const fvShort = x.centre == null ? null : t === "UP" ? x.centre : 1 - x.centre;
    const heldMid = x.mid == null ? null : x.net > 0 ? x.mid : 1 - x.mid;
    const held = g.holdP != null && fvShort != null && 1 - fvShort >= g.holdP - EPS;

    let rule: Rule | null = null, why = "";
    if (g.edge != null && fvShort != null) {
      const e = fvShort - lim - takerFee(lim);
      if (e >= g.edge - EPS) { rule = "edge"; why = `${tok(t)} FV ${c(fvShort)} − limit ${c(lim)} − fee = ${c2(e)} ≥ ${c2(g.edge)}`; }
    }
    if (!rule && g.jumpBps != null && x.perp) {
      const p1 = x.perp.at(x.now), p0 = x.perp.at(x.now - g.jumpMs);
      const bps = p1 != null && p0 != null && p0 > 0 ? (p1 / p0 - 1) * 1e4 : null;
      if (bps != null && (t === "UP" ? bps >= g.jumpBps - EPS : bps <= -g.jumpBps + EPS)) {
        rule = "jump"; why = `perp ${bps >= 0 ? "+" : ""}${bps.toFixed(2)} bp in ${g.jumpMs} ms, ${tok(t)}'s way`;
      }
    }
    if (!rule && g.stopLoss != null && heldMid != null && x.heldAvg != null && x.heldAvg - heldMid >= g.stopLoss - EPS && !held) {
      rule = "stop"; why = `the held ${tok(t === "UP" ? "DOWN" : "UP")} mid ${c(heldMid)} is ${c(x.heldAvg - heldMid)} under its cost ${c(x.heldAvg)}`;
    }
    if (!rule && g.lateSec != null && x.left <= g.lateSec + EPS && !held) {
      rule = "late"; why = `${x.left.toFixed(0)} s left (≤ ${g.lateSec})`;
    }
    if (!rule) return none(`net ${x.net} · no trigger${held ? ` (held favourite ≥ ${c(g.holdP!)})` : ""}`);

    const size = fl(Math.min(n - g.keep, g.maxSh, Math.max(0, x.free) / (lim + takerFee(lim))));
    if (size < x.minSize) return none(`${rule}: only ${size} sh to take (net ${x.net}, keep ${g.keep}, free $${x.free.toFixed(2)}; min ${x.minSize})`, "warn");
    this.last = x.now;
    this.active[rule]++;
    const msg = `${rule}: ${why} → buy ${size} ${tok(t)} up to ${c(lim)} (ask ${c(ask)}, fee ${c2(takerFee(lim))}/sh)`;
    steps.push({ k: "excess", v: msg, s: "warn" });
    // spend size × the ask, whole cents (the venue signs a market BUY's amount so): the slip only caps the price, so a fill
    // at the ask buys `size` and one higher buys fewer, never more than the excess (size × the limit overbought by slip/ask)
    const usd = Math.max(0.01, Math.round(size * ask * 100) / 100);
    return { take: { token: t, price: lim, size, kind: "excess", why: `excess ${msg}`, usd }, steps };
  }
}
