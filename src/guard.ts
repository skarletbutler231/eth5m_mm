// GUARD — rules on top of the v4 quote against the big-loss windows (2026-10-20: the 10:05 UTC strike whipsaw lost $92 in
// 20 minutes; README "Tail guard"). They are what the tailguard research agent (tailguard/) searches; each is off until
// its trigger knob is set, and with all of them off guardCfg() is null and the quote passes through unchanged.
//   whipsaw   total variation of the good mid over MM_GUARD_TV_MS, counted in steps of at least one tick (a mid flickering
//             inside a tick adds nothing): at MM_WHIP_TV or more, pull for MM_WHIP_HOLD_MS.
//   gamma     the token's volatility proxy φ(Φ⁻¹(centre))·√(300 s / time left): at MM_GAMMA_PULL or more, pull.
//   jump      the Binance perp moved MM_JUMP_BPS or more within MM_JUMP_MS: pull the bid that move runs into (perp up →
//             the Down bid, perp down → the Up bid) for MM_JUMP_HOLD_MS. It cancels on the perp move itself instead of
//             waiting for the flow FV's re-price to move the bid.
//   inventory |net| ≥ MM_INV_STOP_NET and the held token's mid MM_INV_STOP_LOSS or more under its average cost: no adding
//             for MM_INV_STOP_HOLD_MS.
//   vol cap   once the total variation passes MM_CAP_VOL_TV the cap shrinks to cap × max(MM_CAP_VOL_FLOOR, MM_CAP_VOL_TV / TV);
//             the quote carries it (Quote.cap) to the order manager's pending count.
// "Pull" is MM_*_SIDE: both = no bids at all, adding = only the side that adds to |net| (both when flat).
import { CFG } from "./config.js";
import { normInv } from "./model/math.js";
import type { PriceBuffer } from "./model/priceBuffer.js";
import { guardOn, targetStep, type Quote, type Step } from "./quoter.js";

export type GuardCfg = (typeof CFG)["guard"] & { maxPosition: number };

/** The guard's config, or null when every rule is off. */
export function guardCfg(cfg: typeof CFG = CFG): GuardCfg | null {
  return guardOn(cfg) ? { ...cfg.guard, maxPosition: cfg.maxPosition } : null;
}

export interface GuardIn {
  now: number;
  /** The Up mid on a good book, else null. */
  mid: number | null;
  /** The quote centre (Up terms). */
  centre: number | null;
  /** Seconds to the close. */
  left: number;
  net: number;
  /** Average cost of the held token (Up when net > 0, Down when net < 0). */
  heldAvg: number | null;
  /** Binance perp prices as received; null when the feed is stale. */
  perp: PriceBuffer | null;
  tick: number;
  minSize: number;
}

export interface GuardOut {
  /** Why a side is pulled (null = kept). */
  bid: string | null; ask: string | null;
  /** The cap in force (null = the configured one). */
  cap: number | null;
  steps: Step[];
}

type Rule = "whip" | "gamma" | "jump" | "inv" | "cap";
const RULES: Rule[] = ["whip", "gamma", "jump", "inv", "cap"];
const c = (x: number) => (x * 100).toFixed(1) + "¢";

/** One window's guard: the mid's recent path, the perp, and the rules' holds. */
export class Guard {
  private anchor: number | null = null;
  private steps: { t: number; d: number }[] = [];
  private tvSum = 0;
  private whipUntil = 0;
  private invUntil = 0;
  private jumpUntil = { bid: 0, ask: 0 };
  /** Decision steps each rule acted in (the replay reports them per window). */
  readonly active: Record<Rule, number> = { whip: 0, gamma: 0, jump: 0, inv: 0, cap: 0 };

  constructor(private readonly cfg: GuardCfg) {}

  /** Total variation of the good mid over the lookback, in price units. */
  private tv(x: GuardIn): number {
    if (x.mid != null) {
      if (this.anchor == null) this.anchor = x.mid;
      else if (Math.abs(x.mid - this.anchor) >= x.tick - 1e-9) {
        const d = Math.abs(x.mid - this.anchor);
        this.steps.push({ t: x.now, d }); this.tvSum += d; this.anchor = x.mid;
      }
    }
    while (this.steps.length && this.steps[0].t < x.now - this.cfg.tvMs) this.tvSum -= this.steps.shift()!.d;
    if (!this.steps.length) this.tvSum = 0;
    return Math.max(0, this.tvSum);
  }

  observe(x: GuardIn): GuardOut {
    const g = this.cfg, steps: Step[] = [];
    const tv = this.tv(x);
    // the side that adds to |net| (both when flat)
    const adding = { bid: x.net >= 0, ask: x.net <= 0 };
    const pull = { bid: null as string | null, ask: null as string | null };
    const hit = new Set<Rule>();
    const pullSides = (rule: Rule, mode: "both" | "adding", why: string) => {
      for (const s of ["bid", "ask"] as const) if ((mode === "both" || adding[s]) && pull[s] == null) { pull[s] = why; hit.add(rule); }
    };

    if (g.whipTv != null) {
      if (tv >= g.whipTv) this.whipUntil = x.now + g.whipHoldMs;
      if (x.now < this.whipUntil) {
        pullSides("whip", g.whipSide, `whipsaw: the mid moved ${c(tv)} in ${g.tvMs / 1000} s (≥ ${c(g.whipTv)})`);
        steps.push({ k: "guard whipsaw", v: `TV ${c(tv)} in ${g.tvMs / 1000} s · ${g.whipSide === "both" ? "both bids" : "adding side"} off for ${((this.whipUntil - x.now) / 1000).toFixed(1)} s`, s: "off" });
      } else steps.push({ k: "guard whipsaw", v: `TV ${c(tv)} in ${g.tvMs / 1000} s, under ${c(g.whipTv)}`, s: "ok" });
    }

    if (g.gammaPull != null && x.centre != null) {
      const p = Math.min(0.99, Math.max(0.01, x.centre)), z = normInv(p);
      const G = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI) * Math.sqrt(300 / Math.max(1, x.left));
      if (G >= g.gammaPull) {
        pullSides("gamma", g.gammaSide, `gamma ${G.toFixed(2)} ≥ ${g.gammaPull}`);
        steps.push({ k: "guard gamma", v: `φ(Φ⁻¹p)·√(300/τ) = ${G.toFixed(2)} ≥ ${g.gammaPull} → ${g.gammaSide === "both" ? "both bids" : "adding side"} off`, s: "off" });
      } else steps.push({ k: "guard gamma", v: `${G.toFixed(2)}, under ${g.gammaPull}`, s: "ok" });
    }

    if (g.jumpBps != null && x.perp) {
      const p1 = x.perp.at(x.now), p0 = x.perp.at(x.now - g.jumpMs);
      const bps = p1 != null && p0 != null && p0 > 0 ? (p1 / p0 - 1) * 1e4 : null;
      // perp up → Up is about to be worth more: sellers of Down hit the Down bid (the "ask"); perp down → the Up bid
      if (bps != null && bps >= g.jumpBps) this.jumpUntil.ask = x.now + g.jumpHoldMs;
      if (bps != null && bps <= -g.jumpBps) this.jumpUntil.bid = x.now + g.jumpHoldMs;
      for (const s of ["bid", "ask"] as const) {
        if (x.now < this.jumpUntil[s] && pull[s] == null) { pull[s] = `perp jump (${s === "ask" ? "up" : "down"} ≥ ${g.jumpBps} bp in ${g.jumpMs} ms)`; hit.add("jump"); }
      }
      steps.push({ k: "guard jump", v: bps == null ? "no perp" : `perp ${bps >= 0 ? "+" : ""}${bps.toFixed(1)} bp in ${g.jumpMs} ms` +
        (x.now < this.jumpUntil.bid ? " · Up bid off" : "") + (x.now < this.jumpUntil.ask ? " · Down bid off" : ""), s: hit.has("jump") ? "off" : "ok" });
    }

    if (g.invStopNet != null) {
      const held = x.net > 0 ? x.mid : x.net < 0 && x.mid != null ? 1 - x.mid : null;
      const loss = held != null && x.heldAvg != null ? x.heldAvg - held : null;
      if (Math.abs(x.net) >= g.invStopNet && loss != null && loss >= g.invStopLoss) this.invUntil = x.now + g.invStopHoldMs;
      if (x.now < this.invUntil && x.net !== 0) {
        const s = x.net > 0 ? "bid" : "ask";
        if (pull[s] == null) { pull[s] = `inventory stop: ${Math.abs(x.net)} sh held at a loss`; hit.add("inv"); }
        steps.push({ k: "guard inventory", v: `net ${x.net} · ${loss != null ? c(loss) + " under cost" : "—"} → no adding for ${((this.invUntil - x.now) / 1000).toFixed(1)} s`, s: "off" });
      } else steps.push({ k: "guard inventory", v: `net ${x.net}${loss != null ? ` · ${c(loss)} under cost` : ""}`, s: "ok" });
    }

    let cap: number | null = null;
    if (g.capVolTv != null && tv > g.capVolTv) {
      const scale = Math.max(g.capVolFloor, g.capVolTv / tv);
      cap = Math.max(x.minSize, Math.floor(g.maxPosition * scale + 1e-9));
      hit.add("cap");
      steps.push({ k: "guard cap", v: `TV ${c(tv)} > ${c(g.capVolTv)} → cap ±${cap} (×${scale.toFixed(2)})`, s: "warn" });
    }

    for (const r of RULES) if (hit.has(r)) this.active[r]++;
    return { bid: pull.bid, ask: pull.ask, cap, steps };
  }
}

/** Fold the guard into the quote, as applyTake does a take: pulled sides go, sizes are cut to the guard's cap (the quote
 *  carries it on for the order manager), and the guard's steps go in before the restated target. */
export function applyGuard(q: Quote, g: GuardOut | null, net: number, minSize: number): Quote {
  if (!g) return q;
  const steps = q.steps.filter((s) => s.k !== "target");
  steps.push(...g.steps);
  const out: Quote = { ...q, off: { ...q.off }, steps };
  const why: string[] = [];
  for (const s of ["bid", "ask"] as const) {
    const r = g[s];
    if (r && out[s] != null) {
      out[s] = null;
      if (s === "bid") out.bidSize = 0; else out.askSize = 0;
      out.off[s] = `${s === "bid" ? "Up" : "Down"} bid pulled: ${r}`;
      why.push(out.off[s]!);
    }
  }
  if (g.cap != null) {
    out.cap = g.cap;
    const fl = (v: number) => Math.max(0, Math.floor(v + 1e-9));
    if (out.bid != null && out.bidSize > g.cap - net) out.bidSize = fl(g.cap - net);
    if (out.ask != null && out.askSize > g.cap + net) out.askSize = fl(g.cap + net);
    if (out.bid != null && out.bidSize < minSize) { out.bid = null; out.bidSize = 0; out.off.bid = `Up bid off: under the guard's cap ±${g.cap}`; why.push(out.off.bid); }
    if (out.ask != null && out.askSize < minSize) { out.ask = null; out.askSize = 0; out.off.ask = `Down bid off: under the guard's cap ±${g.cap}`; why.push(out.off.ask); }
  }
  if (why.length) out.why = out.why === "quoting both sides" ? why.join(" · ") : `${out.why} · ${why.join(" · ")}`;
  steps.push(targetStep(out.bid, out.bidSize, out.ask, out.askSize));
  return out;
}
