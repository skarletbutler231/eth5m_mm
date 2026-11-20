// SWEEP — where to quote the side the market is running into (2026-10-25; README "Sweep team"; tag "+swept"). On the champion replay of
// code 73aa107de170 (8,547 windows) the fills made while the Binance perp had moved 1 bp or more against them in the 300 ms
// before were 9% of the fills and 28% of the loss: −5.2¢ a share 1 s later and still −4.65¢ at settlement (no reversion),
// against −0.73¢ for fills on a calm perp. Pulling those bids is trading less (the tail guard's jump pull and 25+ replayed
// rules); these rules move the target instead. They are what the sweep research team (sweep/) searches; each trigger and
// each action is off until its knob is set, and without at least one of each swCfg() is null and the quote passes through.
// A side is SWEPT for MM_SW_HOLD_MS after its last trigger. The Up price falling sweeps the Up bid ("bid"), rising sweeps
// the Down bid ("ask", an Up-terms price).
//   jump   the Binance perp moved MM_SW_JUMP_BPS or more within MM_SW_JUMP_MS (perp down → the Up bid)
//   move   the good mid moved MM_SW_MOVE or more within MM_SW_MOVE_MS (mid down → the Up bid)
//   fill   MM_SW_FILL=on: that side was just filled (the shares bought on it went up since the last decision)
//   tv     the good mid's total variation over MM_SW_TV_MS reached MM_SW_TV (1-tick steps, as the guard counts): both sides
// What a swept side gets (MM_SW_SIDE=both: both sides while either is swept):
//   back   it steps back MM_SW_BACK ticks, plus MM_SW_BACK_K ticks per 1¢ the mid moved into it over MM_SW_MOVE_MS, at most
//          MM_SW_BACK_MAX; a bid stepped under 1¢ goes
//   centre MM_SW_CENTRE=cons: it is priced off the more cautious of the quote's centre (the flow FV) and the anchored FV,
//          the lower for the Up bid and the higher for the Down bid (the 10-20 17:20 burst: the flow FV kept forecasting a
//          rebound while the anchored FV sat under the mid)
//   size   MM_SW_SIZE × its size, at least the market's minimum
// MM_SW_HARD=on (default): the prices are hard limits. The quote carries them in Quote.pcLim (the order manager's limit,
// shared with the pair-cost cap), so a working bid at the old price is replaced instead of tolerated a tick over. off: only
// new placements take them, and a working bid keeps its queue spot under the usual tolerance (the first hand screen,
// 2026-10-25: the hard step-back bought the swept fills 1-1.35c a share and lost 0.3-0.4c on the calm ones, the queue spot).
// Order: the guard, the pair-cost rules, then these.
import { CFG } from "./config.js";
import type { PriceBuffer } from "./model/priceBuffer.js";
import { swOn, targetStep, type Quote, type Step } from "./quoter.js";

export type SwCfg = (typeof CFG)["sw"] & { halfSpread: number };

/** The sweep rules' config, or null when they cannot act. */
export function swCfg(cfg: typeof CFG = CFG): SwCfg | null {
  return swOn(cfg) ? { ...cfg.sw, halfSpread: cfg.halfSpread } : null;
}

export interface SwIn {
  now: number;
  /** The Up mid on a good book, else null. */
  mid: number | null;
  /** The anchored FV (Up terms): the cautious centre's other half. */
  alt: number | null;
  /** Binance perp prices as received; null when the feed is stale. */
  perp: PriceBuffer | null;
  /** Shares bought on each side in this window so far (held + merged). */
  upBought: number;
  downBought: number;
  tick: number;
  minSize: number;
}

type Side = "bid" | "ask";
type Rule = "jump" | "move" | "fill" | "tv" | "back" | "centre" | "size";
const RULES: Rule[] = ["jump", "move", "fill", "tv", "back", "centre", "size"];
const EPS = 1e-9;
const c = (x: number) => (x * 100).toFixed(1) + "¢";
const r = (v: number) => Math.round(v * 1e4) / 1e4;
const name = (s: Side) => (s === "bid" ? "Up bid" : "Down bid");

/** One window's sweep rules: the mid's recent path, the fills seen, each side's hold, and how often each rule acted. */
export class Sweep {
  private mids: { t: number; m: number }[] = [];
  private anchor: number | null = null;
  private steps: { t: number; d: number }[] = [];
  private tvSum = 0;
  private bought: { bid: number; ask: number } | null = null;
  private until = { bid: 0, ask: 0 };
  /** Decision steps each rule acted in (the replay reports them per window). */
  readonly active: Record<Rule, number> = { jump: 0, move: 0, fill: 0, tv: 0, back: 0, centre: 0, size: 0 };

  constructor(private readonly cfg: SwCfg) {}

  /** The good mid's move over moveMs (now − then; null before a second sample). */
  private move(x: SwIn): number | null {
    if (x.mid == null) return null;
    this.mids.push({ t: x.now, m: x.mid });
    while (this.mids.length >= 2 && this.mids[1].t <= x.now - this.cfg.moveMs) this.mids.shift();
    return this.mids.length >= 2 ? x.mid - this.mids[0].m : null;
  }

  /** Total variation of the good mid over tvMs, in price units (the guard's measure). */
  private tv(x: SwIn): number {
    if (x.mid != null) {
      if (this.anchor == null) this.anchor = x.mid;
      else if (Math.abs(x.mid - this.anchor) >= x.tick - EPS) {
        const d = Math.abs(x.mid - this.anchor);
        this.steps.push({ t: x.now, d }); this.tvSum += d; this.anchor = x.mid;
      }
    }
    while (this.steps.length && this.steps[0].t < x.now - this.cfg.tvMs) this.tvSum -= this.steps.shift()!.d;
    if (!this.steps.length) this.tvSum = 0;
    return Math.max(0, this.tvSum);
  }

  /** The quote with the rules folded in; their steps go in before the restated target. */
  apply(q: Quote, x: SwIn): Quote {
    const g = this.cfg, tick = x.tick, now = x.now;
    const hit = new Set<Rule>();
    const trig: string[] = [];
    const mark = (s: Side, rule: Rule, why: string) => { this.until[s] = now + g.holdMs; hit.add(rule); trig.push(`${name(s)}: ${why}`); };

    // ---- triggers ----
    const mv = this.move(x);
    if (g.jumpBps != null && x.perp) {
      const p1 = x.perp.at(now), p0 = x.perp.at(now - g.jumpMs);
      const bps = p1 != null && p0 != null && p0 > 0 ? (p1 / p0 - 1) * 1e4 : null;
      if (bps != null && bps <= -g.jumpBps) mark("bid", "jump", `perp ${bps.toFixed(1)} bp in ${g.jumpMs} ms`);
      if (bps != null && bps >= g.jumpBps) mark("ask", "jump", `perp +${bps.toFixed(1)} bp in ${g.jumpMs} ms`);
    }
    if (g.move != null && mv != null) {
      if (mv <= -g.move + EPS) mark("bid", "move", `mid ${c(mv)} in ${g.moveMs / 1000} s`);
      if (mv >= g.move - EPS) mark("ask", "move", `mid +${c(mv)} in ${g.moveMs / 1000} s`);
    }
    const now2 = { bid: x.upBought, ask: x.downBought };
    if (g.fill && this.bought) {
      for (const s of ["bid", "ask"] as const) if (now2[s] > this.bought[s] + EPS) mark(s, "fill", `filled ${(now2[s] - this.bought[s]).toFixed(0)} sh`);
    }
    this.bought = now2;
    if (g.tv != null) {
      const tv = this.tv(x);
      if (tv >= g.tv - EPS) { mark("bid", "tv", `TV ${c(tv)} in ${g.tvMs / 1000} s`); this.until.ask = this.until.bid; trig.push(`Down bid: the same`); }
    }
    const swept = { bid: now < this.until.bid, ask: now < this.until.ask };
    const act = g.side === "both" && (swept.bid || swept.ask) ? { bid: true, ask: true } : swept;

    const steps: Step[] = q.steps.filter((st) => st.k !== "target");
    if (!act.bid && !act.ask) {
      steps.push({ k: "sweep", v: "no side swept", s: "ok" });
      steps.push(targetStep(q.bid, q.bidSize, q.ask, q.askSize));
      for (const rule of RULES) if (hit.has(rule)) this.active[rule]++;
      return { ...q, steps };
    }

    // ---- actions on each swept side ----
    const out: Quote = { ...q, off: { ...q.off }, steps };
    const why: string[] = [];
    const lim = { bid: q.pcLim?.bid ?? null, ask: q.pcLim?.ask ?? null };
    const hs = g.halfSpread, skew = q.skew;
    const moved: string[] = [];
    for (const s of ["bid", "ask"] as const) {
      if (!act[s] || out[s] == null) continue;
      const was = out[s]!;
      let px = was;
      if (g.centre === "cons" && x.alt != null && q.center != null) {
        if (s === "bid") px = Math.min(px, r(Math.floor((Math.min(q.center, x.alt) - skew - hs) / tick + EPS) * tick));
        else px = Math.max(px, r(Math.ceil((Math.max(q.center, x.alt) - skew + hs) / tick - EPS) * tick));
        if (Math.abs(px - was) > EPS) hit.add("centre");
      }
      const into = mv == null ? 0 : Math.max(0, s === "bid" ? -mv : mv);
      const n = Math.min(g.backMax, Math.floor(g.back + g.backK * into / 0.01 + EPS));
      if (n > 0) { px = r(s === "bid" ? px - n * tick : px + n * tick); hit.add("back"); }
      if (s === "bid" ? px < tick - EPS : px > 1 - tick + EPS) {
        out[s] = null;
        if (s === "bid") out.bidSize = 0; else out.askSize = 0;
        out.off[s] = `${name(s)} off: stepped back under 1¢ while swept`;
        why.push(out.off[s]!);
        continue;
      }
      out[s] = px;
      lim[s] = s === "bid" ? Math.min(lim.bid ?? Infinity, px) : Math.max(lim.ask ?? -Infinity, px);
      const sz0 = s === "bid" ? out.bidSize : out.askSize;
      if (g.size < 1 - EPS) {
        const sz = Math.min(sz0, Math.max(x.minSize, Math.floor(sz0 * g.size + EPS)));
        if (sz < sz0 - EPS) { if (s === "bid") out.bidSize = sz; else out.askSize = sz; hit.add("size"); }
      }
      const tp = (v: number) => c(s === "bid" ? v : 1 - v);
      const sz1 = s === "bid" ? out.bidSize : out.askSize;
      if (Math.abs(px - was) > EPS || sz1 !== sz0) moved.push(`${name(s)} ${tp(was)} → ${tp(px)}${sz1 !== sz0 ? ` × ${sz1}` : ""}`);
    }
    if (g.hard && (lim.bid != null || lim.ask != null)) out.pcLim = { bid: lim.bid, ask: lim.ask, rest: q.pcLim?.rest ?? { bid: false, ask: false } };
    steps.push({ k: "sweep", v: `${trig.length ? trig.join(" · ") : `${swept.bid ? "Up" : "Down"} bid still swept`}` +
      ` → ${moved.length ? moved.join(" · ") : "nothing to move"}`, s: moved.length ? "warn" : "info" });
    for (const rule of RULES) if (hit.has(rule)) this.active[rule]++;
    if (why.length) out.why = out.why === "quoting both sides" ? why.join(" · ") : `${out.why} · ${why.join(" · ")}`;
    steps.push(targetStep(out.bid, out.bidSize, out.ask, out.askSize));
    return out;
  }
}
