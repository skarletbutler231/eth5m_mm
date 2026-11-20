// PAIR COST — rules on top of the v4 / v5 quote that use what the window's pairs cost (2026-10-22; README "Pair cost").
// Up + Down merge for $1, so a window makes (1 − pair cost) on every pair plus whatever it still holds at the close. On
// the v5 replay 09-24 → 10-21 (7,686 windows) 95% of the shares bought ended up in pairs, at 102.6¢ a pair: −$2.25 a
// window of the −$2.04 total. These rules are what the paircost research team (agents/paircost) searches; each is off
// until its trigger knob is set, and with all of them off pcCfg() is null and the quote passes through unchanged.
//   cap    completion: while holding, the bid that pairs the held token off is priced so a pair costs at most MM_PC_TARGET
//          against the held average: 20 Up @ 56¢, target 99¢ → the Down bid at ≤ 43¢, resting there when the touch is
//          higher. The cap is hard: the quote carries it (Quote.pcLim) and the order manager never tolerates a working bid
//          past it; with MM_PC_RACE=off a bid held back to the cap rests there outside the queue race. (The order-manager
//          part is from the 2026-10-22 hand study, MM_PAIR_COST_MAX, after Codex found the tolerance kept bids past a soft cap.)
//   stop   once the window has merged MM_PC_MIN_PAIRS pairs at an average of MM_PC_STOP or more, the side that adds to
//          |net| (both when flat) is not quoted for the rest of the window.
//   widen  the side that adds to |net| (both when flat) steps back MM_PC_WIDEN ticks per 1¢ the window's pair cost is over
//          MM_PC_WIDEN_FROM, once MM_PC_MIN_PAIRS pairs are merged; at most MM_PC_WIDEN_MAX ticks.
//   hold   carry: while the held token is the favourite (its centre ≥ MM_PC_HOLD_P) and the window's pair cost is under
//          MM_PC_HOLD_MAX (no pairs yet counts as under), the bid that would pair it off is not quoted, so the position
//          rides to settlement; the hold ends when the favourite falls back to MM_PC_HOLD_EXIT, the pair cost reaches
//          MM_PC_HOLD_MAX or the position is gone. The GSI market maker's favourite hold (PMMM_HOLD_MAX_PAIR_COST);
//          Zang et al. 2026: makers in prediction-market order books earn by carrying the under-priced side.
// Order: the guard first (guard.ts), then hold, cap, stop, widen.
import { CFG } from "./config.js";
import { pcOn, targetStep, type Quote, type Step } from "./quoter.js";

export type PcCfg = (typeof CFG)["pc"];

/** The pair-cost rules' config, or null when every rule is off. */
export function pcCfg(cfg: typeof CFG = CFG): PcCfg | null {
  return pcOn(cfg) ? cfg.pc : null;
}

export interface PcIn {
  /** The quote centre (Up terms). */
  centre: number | null;
  net: number;
  /** Average cost of the held token (Up when net > 0, Down when net < 0). */
  heldAvg: number | null;
  /** Pairs merged in this window so far and what they cost in all (Σ m·(avg Up + avg Down)). */
  pairs: number;
  pairCost: number;
  tick: number;
  minSize: number;
}

type Rule = "cap" | "stop" | "widen" | "hold";
const RULES: Rule[] = ["cap", "stop", "widen", "hold"];
const EPS = 1e-9;
const c = (x: number) => (x * 100).toFixed(1) + "¢";
const r = (v: number) => Math.round(v * 1e4) / 1e4;

/** One window's pair-cost rules: the hold's state, and how often each rule acted. */
export class PairCost {
  private holding: "UP" | "DOWN" | null = null;
  /** Decision steps each rule acted in (the replay reports them per window). */
  readonly active: Record<Rule, number> = { cap: 0, stop: 0, widen: 0, hold: 0 };

  constructor(private readonly cfg: PcCfg) {}

  /** The quote with the rules folded in; their steps go in before the restated target. */
  apply(q: Quote, x: PcIn): Quote {
    const g = this.cfg, tick = x.tick;
    const steps: Step[] = q.steps.filter((s) => s.k !== "target");
    const out: Quote = { ...q, off: { ...q.off }, steps };
    const why: string[] = [];
    const hit = new Set<Rule>();
    const pc = x.pairs > EPS ? x.pairCost / x.pairs : null;
    const ripe = pc != null && x.pairs >= g.minPairs - EPS;
    const pcTxt = pc == null ? "no pairs yet" : `${x.pairs.toFixed(0)} pairs at ${c(pc)}`;
    // the side that adds to |net| (both when flat), and the one that pairs the held token off
    const adding = { bid: x.net >= 0, ask: x.net <= 0 };
    const held: "UP" | "DOWN" | null = Math.abs(x.net) >= x.minSize ? (x.net > 0 ? "UP" : "DOWN") : null;
    const reduce: "bid" | "ask" | null = held === "UP" ? "ask" : held === "DOWN" ? "bid" : null;
    const name = (s: "bid" | "ask") => (s === "bid" ? "Up bid" : "Down bid");
    const drop = (s: "bid" | "ask", reason: string) => {
      if (out[s] == null) return;
      out[s] = null;
      if (s === "bid") out.bidSize = 0; else out.askSize = 0;
      out.off[s] = `${name(s)} off: ${reason}`;
      why.push(out.off[s]!);
    };

    if (g.holdP != null) {
      const fav = (t: "UP" | "DOWN") => (x.centre == null ? null : t === "UP" ? x.centre : 1 - x.centre);
      if (this.holding && (held !== this.holding || (fav(this.holding) ?? 1) <= g.holdExit + EPS || (pc != null && pc >= g.holdMax - EPS))) this.holding = null;
      if (!this.holding && held && (fav(held) ?? 0) >= g.holdP - EPS && (pc == null || pc < g.holdMax - EPS)) this.holding = held;
      if (this.holding && reduce) {
        drop(reduce, `holding ${this.holding === "UP" ? "Up" : "Down"} to settlement (pair cost ${pcTxt})`);
        hit.add("hold");
        steps.push({ k: "pc hold", v: `${Math.abs(x.net)} ${this.holding === "UP" ? "Up" : "Down"} at ${c(fav(this.holding) ?? NaN)} ≥ ${c(g.holdP)} · ${pcTxt} under ${c(g.holdMax)} → ${name(reduce)} off`, s: "off" });
      } else steps.push({ k: "pc hold", v: held ? `${held === "UP" ? "Up" : "Down"} at ${c(fav(held) ?? NaN)}, under ${c(g.holdP)} or ${pcTxt}` : "nothing held", s: "ok" });
    }

    if (g.target != null) {
      if (reduce && x.heldAvg != null) {
        // the completing token's highest bid for a pair ≤ target; the ask is an Up price (the Down bid at 1 − ask)
        const lim = r(Math.floor((g.target - x.heldAvg) / tick + EPS) * tick);
        out.pcLim = { bid: reduce === "bid" ? lim : null, ask: reduce === "ask" ? r(1 - lim) : null, rest: { bid: false, ask: false } };
      }
      if (reduce && x.heldAvg != null && out[reduce] != null) {
        const lim = r(Math.floor((g.target - x.heldAvg) / tick + EPS) * tick);
        const px = reduce === "bid" ? out.bid! : r(1 - out.ask!);
        if (lim < tick - EPS) {
          drop(reduce, `a pair against the ${c(x.heldAvg)} average can't cost ≤ ${c(g.target)}`);
          hit.add("cap");
          steps.push({ k: "pc cap", v: `held at ${c(x.heldAvg)} → ${name(reduce)} off (no price ≥ 1¢ pairs at ≤ ${c(g.target)})`, s: "off" });
        } else if (px > lim + EPS) {
          if (reduce === "bid") out.bid = lim; else out.ask = r(1 - lim);
          if (!g.race) out.pcLim!.rest[reduce] = true;
          hit.add("cap");
          steps.push({ k: "pc cap", v: `held at ${c(x.heldAvg)} → ${name(reduce)} ${c(px)} → ${c(lim)}: a pair at ≤ ${c(g.target)}`, s: "warn" });
        } else steps.push({ k: "pc cap", v: `${name(reduce)} ${c(px)} pairs at ${c(x.heldAvg + px)} ≤ ${c(g.target)}`, s: "ok" });
      } else steps.push({ k: "pc cap", v: reduce ? `${name(reduce)} not quoted` : "nothing held", s: "info" });
    }

    if (g.stop != null) {
      if (ripe && pc! >= g.stop - EPS) {
        for (const s of ["bid", "ask"] as const) if (adding[s]) drop(s, `the window's pairs cost ${c(pc!)} ≥ ${c(g.stop)}`);
        hit.add("stop");
        steps.push({ k: "pc stop", v: `${pcTxt} ≥ ${c(g.stop)} → ${x.net === 0 ? "both bids" : "adding side"} off for the window`, s: "off" });
      } else steps.push({ k: "pc stop", v: `${pcTxt}${ripe ? `, under ${c(g.stop)}` : ` (acts from ${g.minPairs} pairs)`}`, s: "ok" });
    }

    if (g.widen != null) {
      const k = ripe && pc! > g.widenFrom + EPS ? Math.min(g.widenMax, Math.floor(g.widen * (pc! - g.widenFrom) / 0.01 + EPS)) : 0;
      if (k > 0) {
        const moved: string[] = [];
        if (adding.bid && out.bid != null) {
          const b = r(out.bid - k * tick);
          if (b < tick - EPS) drop("bid", `stepped back ${k} ticks under 1¢`); else { moved.push(`Up bid ${c(out.bid)} → ${c(b)}`); out.bid = b; }
        }
        if (adding.ask && out.ask != null) {
          const a = r(out.ask + k * tick);
          if (a > 1 - tick + EPS) drop("ask", `stepped back ${k} ticks under 1¢`); else { moved.push(`Down bid ${c(1 - out.ask)} → ${c(r(1 - a))}`); out.ask = a; }
        }
        hit.add("widen");
        steps.push({ k: "pc widen", v: `${pcTxt}, ${c(pc! - g.widenFrom)} over ${c(g.widenFrom)} → ${k} tick${k === 1 ? "" : "s"} back${moved.length ? ": " + moved.join(" · ") : ""}`, s: "warn" });
      } else steps.push({ k: "pc widen", v: `${pcTxt}${ripe ? `, not over ${c(g.widenFrom)}` : ` (acts from ${g.minPairs} pairs)`}`, s: "ok" });
    }

    for (const rule of RULES) if (hit.has(rule)) this.active[rule]++;
    if (why.length) out.why = out.why === "quoting both sides" ? why.join(" · ") : `${out.why} · ${why.join(" · ")}`;
    steps.push(targetStep(out.bid, out.bidSize, out.ask, out.askSize));
    return out;
  }
}
